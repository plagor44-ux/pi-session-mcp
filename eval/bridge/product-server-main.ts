import { stdoutGuard } from "../../src/stdout-guard-install.js";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "../../src/config.js";
import { EventSpoolError, TurnEventSpool } from "../../src/event-spool.js";
import { createServer } from "../../src/server.js";
import { SessionRegistry } from "../../src/session-registry.js";
import { shutdownAndTerminate } from "../../src/shutdown.js";
import { EVENTS_DIR_ENV, eventsRoot } from "../../src/turn-events.js";
import { ScriptedAdapter, type PromptPlan, type ScriptedSessionPlan } from "./scripted-adapter.js";

// Evaluation-only stdio server for the product acceptance probe (ADR 0011). It is the wiring of src/main.ts with one
// substitution: a ScriptedAdapter instead of SdkPiSessionAdapter. The configuration (PI_SESSION_MCP_CONFIG), the product
// TurnEventSpool, createServer(..., config.eventDelivery) and the shutdown order are the product's. src/main.ts exports
// nothing and runs at import time, so its small amount of glue (spool directory choice, shutdown) is replicated here.
// Scripts (completion delays) come from the JSON file named by PRODUCT_PROBE_SCRIPT; counters go to the file it names.
interface ScriptFile { counterFile?: string; sessions: Array<{ prompts?: PromptPlan[]; steps?: PromptPlan; abortHangs?: boolean }> }
function loadScript(): ScriptFile {
  const path = process.env.PRODUCT_PROBE_SCRIPT;
  if (!path) throw new Error("script_missing");
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ScriptFile>;
  if (!Array.isArray(raw.sessions)) throw new Error("script_invalid");
  return raw as ScriptFile;
}

/**
 * As src/main.ts in 0.11.0: an explicit absolute directory wins; otherwise the runtime directory decides.
 * The probe always sets one; the product instead keeps delivery inactive without either (#113).
 */
function eventSpoolDirectory(env: NodeJS.ProcessEnv): string {
  const explicit = env[EVENTS_DIR_ENV];
  const dir = explicit !== undefined && explicit.length > 0 ? explicit : eventsRoot(env);
  if (dir === undefined || dir.includes("\0") || !isAbsolute(dir)) throw new EventSpoolError();
  return dir;
}

const script = loadScript();
const counters = {
  tools: {} as Record<string, number>, pi_turn_get: { running: 0, terminal: 0, error: 0 },
  spool_failures: 0, delivery: "off" as string, xdg_runtime_dir_set: process.env.XDG_RUNTIME_DIR !== undefined && process.env.XDG_RUNTIME_DIR !== "",
  events_dir_env_set: process.env[EVENTS_DIR_ENV] !== undefined, spool_opened: false, shutdown: "none" as string,
};
let spool: TurnEventSpool | undefined;
function flushCounters(): void {
  if (!script.counterFile) return;
  counters.spool_failures = spool?.failures ?? 0;
  const temp = `${script.counterFile}.tmp-${process.pid}`;
  try { writeFileSync(temp, JSON.stringify(counters), { mode: 0o600 }); renameSync(temp, script.counterFile); } catch { /* counters are best effort */ }
}

let registry: SessionRegistry | undefined;
let handle: ReturnType<typeof serveStdio> | undefined;
try {
  const config = await loadConfig();
  counters.delivery = config.eventDelivery;
  if (config.eventDelivery === "spool") { spool = TurnEventSpool.open(eventSpoolDirectory(process.env), { diagnostic: () => undefined }); counters.spool_opened = true; }
  const events = spool;
  const adapter = new ScriptedAdapter();
  for (const plan of script.sessions) {
    const scripted: ScriptedSessionPlan = { prompts: plan.prompts ?? (plan.steps ? [plan.steps] : []), ...(plan.abortHangs ? { abortHangs: true } : {}) };
    adapter.plans.push(scripted);
  }
  registry = new SessionRegistry(adapter, config.workspaces, {
    ...(events === undefined ? {} : {
      onTurnTerminal: (event) => events.write({ kind: "turn_terminal", session: event.sessionId, turn: event.turnId, state: event.state, via: event.via }),
    }),
  });

  // Tool counters through a transport wrapper, like eval/bridge/server-main.ts: every tools/call by name; pi_turn_get split by result.
  type Frame = { id?: string | number; method?: string; params?: { name?: unknown }; result?: { structuredContent?: { ok?: unknown; turn?: { state?: unknown } } } };
  const pendingCalls = new Map<string | number, string>();
  const transport = new StdioServerTransport(process.stdin, stdoutGuard.transportStdout);
  let incoming = transport.onmessage;
  Object.defineProperty(transport, "onmessage", {
    configurable: true,
    get: () => incoming && ((message: Parameters<NonNullable<typeof incoming>>[0], extra?: unknown) => {
      const frame = message as Frame;
      if (frame.method === "tools/call" && frame.id !== undefined && typeof frame.params?.name === "string") {
        counters.tools[frame.params.name] = (counters.tools[frame.params.name] ?? 0) + 1;
        pendingCalls.set(frame.id, frame.params.name);
        flushCounters();
      }
      (incoming as (m: unknown, e?: unknown) => void)(message, extra);
    }),
    set: (value) => { incoming = value; },
  });
  const send = transport.send.bind(transport);
  transport.send = async (message) => {
    const frame = message as Frame;
    const name = frame.id !== undefined && frame.method === undefined ? pendingCalls.get(frame.id) : undefined;
    if (name !== undefined && frame.id !== undefined) {
      pendingCalls.delete(frame.id);
      if (name === "pi_turn_get") {
        const structured = frame.result?.structuredContent;
        if (structured?.ok === true) counters.pi_turn_get[structured.turn?.state === "running" ? "running" : "terminal"] += 1; else counters.pi_turn_get.error += 1;
      }
    }
    try { await send(message); } finally { if (name !== undefined) flushCounters(); }
  };

  handle = serveStdio(
    () => createServer(registry!, config.workspaces, config.executionProfiles, config.defaultExecutionProfile, config.configuration, config.workspaceModes, config.eventDelivery),
    { transport, onerror: () => undefined },
  );
  flushCounters();
} catch {
  spool?.close("shutdown");
  process.stderr.write(`${JSON.stringify({ level: "error", event: "startup_failed", stage: "startup" })}\n`);
  process.exitCode = 1;
}

if (handle !== undefined && registry !== undefined) {
  let stopping = false;
  // The same order as src/main.ts: the registry shuts down first, so that the terminals which `close` generates
  // precede `instance_ended`; the spool closes after it (and before exit if the deadline wins).
  const shutdown = async (exitCode: number, reason: "eof" | "signal"): Promise<void> => {
    if (stopping) return;
    stopping = true;
    const registryShutdown = async (): Promise<void> => {
      try { await registry!.shutdown(); } finally { spool?.close(reason); }
    };
    await shutdownAndTerminate(registryShutdown, () => handle!.close(), exitCode, {
      report: (outcome) => {
        counters.shutdown = outcome;
        if (outcome === "timed_out") spool?.close("shutdown");
        flushCounters();
      },
      terminate: (code) => { spool?.close(reason); flushCounters(); process.exit(code); },
    });
  };
  process.once("SIGINT", () => { void shutdown(130, "signal"); });
  process.once("SIGTERM", () => { void shutdown(143, "signal"); });
  const endOfInput = (): void => { void shutdown(0, "eof"); };
  process.stdin.once("end", endOfInput);
  process.stdin.once("close", endOfInput);
  if (process.stdin.readableEnded || process.stdin.destroyed) endOfInput();
}

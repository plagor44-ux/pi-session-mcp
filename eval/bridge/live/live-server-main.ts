import { stdoutGuard } from "../../../src/stdout-guard-install.js";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "../../../src/config.js";
import { startupFailureDiagnostic } from "../../../src/process-diagnostics.js";
import { SdkPiSessionAdapter } from "../../../src/sdk-pi-adapter.js";
import { createServer } from "../../../src/server.js";
import { shutdownAndTerminate } from "../../../src/shutdown.js";
import type { PiSessionAdapter } from "../../../src/pi-adapter.js";
import { BridgedRegistry, EventBridge, SpoolSink } from "../bridge.js";
import { ScriptedAdapter } from "../scripted-adapter.js";
import { parseLiveServerConfig } from "./server-config.js";

// Evaluation-only stdio server for the live measurement: the product's eight tools over a BridgedRegistry, plus a spool
// for the host waiter, a counters file and a harness-only receipt capture. No eval_* tools. Stdout carries MCP frames only.
// Diagnostics are structured, content-free lines on stderr.
const diagnostic = (event: string, code: string): void => { process.stderr.write(`${JSON.stringify({ level: "error", event, code })}\n`); };

interface Counters {
  instanceId: string; tools: Record<string, number>; pi_turn_get: { running: number; terminal: number; error: number };
  open_sessions: number; closes: number; spool_failures: number;
}
type Frame = { id?: string | number; method?: string; params?: { name?: unknown }; result?: { structuredContent?: { ok?: unknown; turn?: { state?: unknown } } } };

async function main(): Promise<void> {
  const rawPath = process.env.BRIDGE_LIVE_CONFIG;
  if (!rawPath) throw new Error("config_missing");
  const live = parseLiveServerConfig(JSON.parse(readFileSync(rawPath, "utf8")) as unknown);
  const config = await loadConfig(live.piConfigPath);
  const instanceId = `inst-${randomBytes(4).toString("hex")}`;
  mkdirSync(live.receiptDir, { recursive: true, mode: 0o700 });

  let adapter: PiSessionAdapter;
  if (live.mode === "sdk") adapter = new SdkPiSessionAdapter({ diagnosticSink: (d) => { process.stderr.write(`${JSON.stringify(d)}\n`); } });
  else {
    const scripted = new ScriptedAdapter();
    for (const plan of live.scripts ?? []) scripted.plans.push({ prompts: plan.prompts });
    adapter = scripted;
  }
  const bridge = new EventBridge(instanceId);
  const registry = new BridgedRegistry(adapter, config.workspaces, {}, bridge);
  const spool = new SpoolSink(join(live.spoolBase, instanceId)); spool.attach(bridge);
  // Harness-only receipt capture: the completed text of a turn, read in the same synchronous step that emits its terminal event.
  bridge.subscribe((event) => {
    if (event.kind !== "turn_terminal" || event.state !== "completed") return;
    try {
      const turn = registry.getTurn(event.sessionId, event.turnId);
      if (turn.state === "completed" && typeof turn.assistantText === "string") writeFileSync(join(live.receiptDir, `${event.turnId}.txt`), turn.assistantText, { mode: 0o600 });
    } catch { /* receipt capture is best effort; the oracle reports a missing receipt */ }
  });

  const counters: Counters = { instanceId, tools: {}, pi_turn_get: { running: 0, terminal: 0, error: 0 }, open_sessions: 0, closes: 0, spool_failures: 0 };
  const pendingCalls = new Map<string | number, string>();
  const flushCounters = (): void => {
    counters.spool_failures = spool.failures;
    counters.open_sessions = registry.list().length;
    const temp = `${live.counterFile}.tmp-${process.pid}`;
    try { writeFileSync(temp, JSON.stringify(counters), { mode: 0o600 }); renameSync(temp, live.counterFile); } catch { /* counters are best effort */ }
  };

  const transport = new StdioServerTransport(process.stdin, stdoutGuard.transportStdout);
  let incoming = transport.onmessage;
  Object.defineProperty(transport, "onmessage", {
    configurable: true,
    get: () => incoming && ((message: Parameters<NonNullable<typeof incoming>>[0]) => {
      const frame = message as Frame;
      if (frame.method === "tools/call" && frame.id !== undefined && typeof frame.params?.name === "string") {
        counters.tools[frame.params.name] = (counters.tools[frame.params.name] ?? 0) + 1;
        pendingCalls.set(frame.id, frame.params.name);
        flushCounters();
      }
      incoming!(message);
    }),
    set: (value) => { incoming = value; },
  });
  const send = transport.send.bind(transport);
  transport.send = async (message) => {
    const frame = message as Frame;
    const name = frame.id !== undefined && frame.method === undefined ? pendingCalls.get(frame.id) : undefined;
    if (name !== undefined && frame.id !== undefined) {
      pendingCalls.delete(frame.id);
      const structured = frame.result?.structuredContent;
      if (name === "pi_turn_get") {
        if (structured?.ok === true) counters.pi_turn_get[structured.turn?.state === "running" ? "running" : "terminal"] += 1; else counters.pi_turn_get.error += 1;
      }
      if (name === "pi_session_close" && structured?.ok === true) counters.closes += 1;
      flushCounters(); // before the response leaves, so a client that sees it also sees the counters
    }
    await send(message);
  };

  const handle = serveStdio(
    () => createServer(registry, config.workspaces, config.executionProfiles, config.defaultExecutionProfile, config.configuration, config.workspaceModes),
    { transport, onerror: () => diagnostic("mcp_transport_error", "mcp_transport_error") },
  );
  flushCounters();

  let stopping = false;
  const shutdown = async (exitCode: number, reason: "eof" | "server_exit"): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await shutdownAndTerminate(() => registry.shutdown(reason), () => handle.close(), exitCode, {
      report: (outcome) => { if (outcome !== "completed") diagnostic("shutdown_failed", outcome === "timed_out" ? "shutdown_timeout" : "shutdown_failed"); },
      terminate: (code) => { flushCounters(); process.exit(code); },
    });
  };
  process.once("SIGINT", () => { void shutdown(130, "server_exit"); });
  process.once("SIGTERM", () => { void shutdown(143, "server_exit"); });
  const endOfInput = (): void => { void shutdown(0, "eof"); };
  process.stdin.once("end", endOfInput);
  process.stdin.once("close", endOfInput);
  if (process.stdin.readableEnded || process.stdin.destroyed) endOfInput();
}

try { await main(); } catch (error) {
  process.stderr.write(`${JSON.stringify(startupFailureDiagnostic(error))}\n`);
  process.exitCode = 1;
}

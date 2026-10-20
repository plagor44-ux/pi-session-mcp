import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../src/config.js";
import { isEntryPoint } from "../../src/entry-point.js";
import { createServer } from "../../src/server.js";
import { SessionRegistry } from "../../src/session-registry.js";
import { decodeKey, macOf, sha256Hex } from "./output-mac.js";
import { profileIdSchema, type ProfileId } from "./schemas.js";
import { createCapturingAdapter } from "./seams.js";
import { UsageCollector, type RunUsage } from "./usage.js";

const POLL_INTERVAL_MS = 250;

export interface RunOutput {
  runId: string;
  terminal: "completed" | "failed" | "aborted" | "timeout" | "start_failed";
  startErrorCode: string | null;
  usage: RunUsage;
  /** Interval from prompt acceptance to the terminal observation; 0 when no prompt was accepted (session never started or prompt rejected). */
  durationMs: number;
  sessionsLeft: number;
  /** File name of the assistant text inside `privateDir`; the text itself is never part of the output. */
  assistantTextRef: string | null;
  /** The turn's `truncated` flag: the stored text was cut at the product's turn text cap. */
  assistantTextTruncated: boolean;
  /** SHA-256 (hex) of the stored assistant text; null when no text was stored. */
  assistantTextSha256: string | null;
  /** HMAC-SHA256 (hex) over the canonical JSON of this output without `mac`, keyed by the supervisor's per-run key; null without a key (unit tests). */
  mac: string | null;
  /** A harness failure code (never a message or path); the terminal is then `failed`. Null otherwise. */
  harnessError: string | null;
}

export const RUN_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** The run id names the private text file, so it must not be able to form a path. */
export function assertRunId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !RUN_ID_PATTERN.test(value)) {
    throw Object.assign(new Error("invalid_run_id"), { code: "invalid_run_id" });
  }
}

export const runOneInputSchema = z.object({
  runId: z.string().regex(RUN_ID_PATTERN),
  configPath: z.string().min(1), workspaceAlias: z.literal("clone"), profile: profileIdSchema,
  promptText: z.string().min(1).max(100_000), turnTimeoutMs: z.number().int().positive(), privateDir: z.string().min(1),
}).strict();
export type RunOneInput = z.infer<typeof runOneInputSchema> & { profile: ProfileId };

interface ToolBody { ok: boolean; error?: { code?: string }; [key: string]: unknown }
interface TurnBody { state: string; turnId?: string; assistantText?: string; truncated?: boolean }
const TERMINAL_STATES = new Set(["completed", "failed", "aborted"]);

/** A failure of the harness itself, carrying only a fixed code. */
class HarnessFailure extends Error {
  constructor(readonly harnessCode: string) { super(harnessCode); }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const unexpected = (): never => { throw new HarnessFailure("unexpected_tool_result"); };

export async function runOne(input: RunOneInput, deps: { adapterOptions?: Parameters<typeof createCapturingAdapter>[1]; macKey?: Uint8Array } = {}): Promise<RunOutput> {
  assertRunId(input.runId);
  const runId = input.runId;
  const config = await loadConfig(input.configPath);
  const collector = new UsageCollector();
  let captured: AgentSession | undefined;
  const detachers: Array<() => void> = [];
  const adapter = createCapturingAdapter((session) => { captured = session; detachers.push(collector.attach(session)); }, deps.adapterOptions);
  const registry = new SessionRegistry(adapter, config.workspaces);
  const server = createServer(registry, config.workspaces, config.executionProfiles, config.defaultExecutionProfile, config.configuration, config.workspaceModes);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "extension-ablation-run-one", version: "1.0.0" }, { capabilities: {} });
  const call = async (name: string, args: Record<string, unknown>): Promise<ToolBody> => {
    let structured: unknown;
    try { structured = (await client.callTool({ name, arguments: args })).structuredContent; }
    catch { throw new HarnessFailure("tool_call_failed"); }
    if (!isRecord(structured) || typeof structured.ok !== "boolean") return unexpected();
    return structured as ToolBody;
  };

  let terminal: RunOutput["terminal"] = "start_failed";
  let startErrorCode: string | null = null;
  let durationMs = 0;
  let sessionsLeft = 0;
  let assistantTextRef: string | null = null;
  let assistantTextSha256: string | null = null;
  let assistantTextTruncated = false;
  let harnessError: string | null = null;
  let sessionId: string | undefined;
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const started = await call("pi_session_start", { workspace: input.workspaceAlias, executionProfile: input.profile });
    if (!started.ok) {
      startErrorCode = typeof started.error?.code === "string" ? started.error.code : "internal_error";
    } else {
      const startedSession = started.session;
      if (!isRecord(startedSession) || typeof startedSession.id !== "string") unexpected();
      sessionId = (startedSession as { id: string }).id;
      const begun = Date.now();
      const accepted = await call("pi_session_prompt", { sessionId, prompt: input.promptText });
      if (!accepted.ok) {
        terminal = "failed";
      } else {
        const asTurn = (value: unknown): TurnBody => {
          if (!isRecord(value) || typeof value.state !== "string") return unexpected();
          return value as unknown as TurnBody;
        };
        let turn = asTurn(accepted.turn);
        const turnId = turn.turnId;
        if (typeof turnId !== "string") unexpected();
        const deadline = begun + input.turnTimeoutMs;
        for (;;) {
          const got = await call("pi_turn_get", { sessionId, turnId });
          if (!got.ok) { terminal = "failed"; break; }
          turn = asTurn(got.turn);
          if (turn.state === "running") {
            if (Date.now() >= deadline) {
              await call("pi_session_abort", { sessionId });
              terminal = "timeout";
              break;
            }
            await sleep(POLL_INTERVAL_MS);
            continue;
          }
          if (!TERMINAL_STATES.has(turn.state)) unexpected();
          terminal = turn.state as RunOutput["terminal"];
          break;
        }
        durationMs = Date.now() - begun;
        if (terminal === "completed" && typeof turn.assistantText === "string") {
          assistantTextTruncated = turn.truncated === true;
          try {
            await mkdir(input.privateDir, { recursive: true, mode: 0o700 });
            await writeFile(join(input.privateDir, `${runId}.txt`), turn.assistantText, { mode: 0o600, flag: "wx" });
            assistantTextRef = `${runId}.txt`;
            assistantTextSha256 = sha256Hex(turn.assistantText);
          } catch {
            throw new HarnessFailure("private_write_failed");
          }
        }
      }
    }
  } catch (error) {
    harnessError = error instanceof HarnessFailure ? error.harnessCode : "unexpected_tool_result";
  } finally {
    if (sessionId !== undefined) await call("pi_session_close", { sessionId }).catch(() => undefined);
    const listed = await call("pi_session_list", {}).catch(() => undefined);
    sessionsLeft = listed?.ok === true && Array.isArray(listed.sessions) ? listed.sessions.length : registry.list().length;
    await Promise.allSettled([client.close(), server.close(), registry.shutdown()]);
  }
  // Measured usage is never dropped: if the SDK stats cannot be read, the assistant sum still stands.
  let usage: RunUsage;
  try { usage = collector.finish(captured); } catch {
    usage = collector.finish(undefined);
    harnessError ??= "session_stats_failed";
  }
  for (const detach of detachers) detach();
  if (harnessError !== null) terminal = "failed";
  const output: RunOutput = { runId, terminal, startErrorCode, usage, durationMs, sessionsLeft, assistantTextRef, assistantTextTruncated, assistantTextSha256, mac: null, harnessError };
  return deps.macKey === undefined ? output : { ...output, mac: macOf({ ...output }, deps.macKey) };
}

async function readStdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) text += chunk.toString("utf8");
  return text;
}

/**
 * `node run-one.js <input.json>` reads the supervisor's per-run key from stdin before anything else (R35), writes a MAC'd
 * `run-output.json` next to the input and exits 0 once an output exists. The key never appears in argv, env or a file.
 */
async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error("input_path_required");
  const macKey = decodeKey(await readStdin());
  const raw: unknown = JSON.parse(await readFile(inputPath, "utf8"));
  assertRunId(isRecord(raw) ? raw.runId : undefined);
  const input = runOneInputSchema.parse(raw);
  const output = await runOne(input, { macKey });
  await writeFile(join(dirname(inputPath), "run-output.json"), JSON.stringify(output, null, 2) + "\n");
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  await main().catch((error: unknown) => {
    const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "run_one_failed";
    process.stderr.write(JSON.stringify({ event: "run_one_stopped", code }) + "\n");
    process.exitCode = 1;
  });
}

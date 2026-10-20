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
import { profileIdSchema, type ProfileId } from "./schemas.js";
import { createCapturingAdapter } from "./seams.js";
import { UsageCollector, type RunUsage } from "./usage.js";

const POLL_INTERVAL_MS = 250;

export interface RunOutput {
  runId: string;
  terminal: "completed" | "failed" | "aborted" | "timeout" | "start_failed";
  startErrorCode: string | null;
  usage: RunUsage;
  /** Interval from prompt acceptance to the terminal observation; 0 when the session never started. */
  durationMs: number;
  sessionsLeft: number;
  /** File name of the assistant text inside `privateDir`; the text itself is never part of the output. */
  assistantTextRef: string | null;
}

export const RUN_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export const runOneInputSchema = z.object({
  runId: z.string().regex(RUN_ID_PATTERN),
  configPath: z.string().min(1), workspaceAlias: z.literal("clone"), profile: profileIdSchema,
  promptText: z.string().min(1).max(100_000), turnTimeoutMs: z.number().int().positive(), privateDir: z.string().min(1),
}).strict();
export type RunOneInput = z.infer<typeof runOneInputSchema> & { profile: ProfileId };

interface ToolBody { ok: boolean; error?: { code?: string }; [key: string]: unknown }

export async function runOne(input: RunOneInput, deps: { adapterOptions?: Parameters<typeof createCapturingAdapter>[1] } = {}): Promise<RunOutput> {
  // The run id names the private text file, so it must not be able to form a path.
  if (!RUN_ID_PATTERN.test(input.runId)) {
    throw Object.assign(new Error("invalid_run_id"), { code: "invalid_run_id" });
  }
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
    const result = await client.callTool({ name, arguments: args });
    return (result.structuredContent ?? { ok: false, error: { code: "internal_error" } }) as ToolBody;
  };

  let terminal: RunOutput["terminal"] = "start_failed";
  let startErrorCode: string | null = null;
  let durationMs = 0;
  let sessionsLeft = 0;
  let assistantTextRef: string | null = null;
  let sessionId: string | undefined;
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const started = await call("pi_session_start", { workspace: input.workspaceAlias, executionProfile: input.profile });
    if (!started.ok) {
      startErrorCode = started.error?.code ?? "internal_error";
    } else {
      sessionId = (started.session as { id: string }).id;
      const begun = Date.now();
      const accepted = await call("pi_session_prompt", { sessionId, prompt: input.promptText });
      if (!accepted.ok) {
        terminal = "failed";
      } else {
        const turnId = (accepted.turn as { turnId: string }).turnId;
        const deadline = begun + input.turnTimeoutMs;
        let turn = accepted.turn as { state: string; assistantText?: string };
        for (;;) {
          const got = await call("pi_turn_get", { sessionId, turnId });
          if (!got.ok) { terminal = "failed"; break; }
          turn = got.turn as typeof turn;
          if (turn.state !== "running") { terminal = turn.state as RunOutput["terminal"]; break; }
          if (Date.now() >= deadline) {
            await call("pi_session_abort", { sessionId });
            terminal = "timeout";
            break;
          }
          await sleep(POLL_INTERVAL_MS);
        }
        durationMs = Date.now() - begun;
        if (terminal === "completed" && typeof turn.assistantText === "string") {
          await mkdir(input.privateDir, { recursive: true, mode: 0o700 });
          assistantTextRef = `${runId}.txt`;
          await writeFile(join(input.privateDir, assistantTextRef), turn.assistantText, { mode: 0o600 });
        }
      }
    }
  } finally {
    if (sessionId !== undefined) await call("pi_session_close", { sessionId }).catch(() => undefined);
    const listed = await call("pi_session_list", {}).catch(() => undefined);
    sessionsLeft = listed?.ok === true ? (listed.sessions as unknown[]).length : registry.list().length;
    await Promise.allSettled([client.close(), server.close(), registry.shutdown()]);
  }
  const usage = collector.finish(captured);
  for (const detach of detachers) detach();
  return { runId, terminal, startErrorCode, usage, durationMs, sessionsLeft, assistantTextRef };
}

/** `node run-one.js <input.json>` writes `run-output.json` next to the input and exits 0 once an output exists. */
async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error("input_path_required");
  const input = runOneInputSchema.parse(JSON.parse(await readFile(inputPath, "utf8")));
  const output = await runOne(input);
  await writeFile(join(dirname(inputPath), "run-output.json"), JSON.stringify(output, null, 2) + "\n");
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  await main().catch((error: unknown) => {
    const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "run_one_failed";
    process.stderr.write(JSON.stringify({ event: "run_one_stopped", code }) + "\n");
    process.exitCode = 1;
  });
}

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { ModelRuntime, type AgentSession } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../src/config.js";
import { isEntryPoint } from "../../src/entry-point.js";
import { createServer } from "../../src/server.js";
import { SessionRegistry } from "../../src/session-registry.js";
import type { DryLoadOutput } from "./dry-load.js";
import { decodeKey, macOf } from "./output-mac.js";
import { profileIdSchema } from "./schemas.js";
import { createCapturingAdapter } from "./seams.js";

/**
 * The dry-load entry (R5): starts one session of one profile through the same in-process stack as `run-one`, with the real extension
 * resolver and tool composition, but on a model runtime that holds one provider of its own and refuses every model call. It never sends a
 * prompt. The profile's real provider and model are replaced in the config the supervisor writes (the one deviation from a run); the
 * runtime registers exactly the provider and model that config names.
 */
const dryLoadInputSchema = z.object({
  runId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/), configPath: z.string().min(1), workspaceAlias: z.literal("clone"), profile: profileIdSchema,
}).strict();
export type DryLoadInput = z.infer<typeof dryLoadInputSchema>;

/** Public model-call methods of the runtime; the probe of the pi-lens registration gate guards the same set. */
const MODEL_CALLS = ["stream", "streamSimple", "complete", "completeSimple", "streamDeferred", "fetchDeferred", "cancelDeferred", "generateImages", "classify"] as const;

class HarnessFailure extends Error {
  constructor(readonly harnessCode: string) { super(harnessCode); }
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

async function dryLoadOne(input: DryLoadInput, deps: { agentDir?: string; macKey?: Uint8Array } = {}): Promise<DryLoadOutput> {
  const agentDir = deps.agentDir ?? process.env.PI_CODING_AGENT_DIR;
  if (!agentDir) throw Object.assign(new Error("agent_dir_missing"), { code: "agent_dir_missing" });
  const config = await loadConfig(input.configPath);
  const selected = config.executionProfiles.get(input.profile);
  if (selected === undefined) throw Object.assign(new Error("profile_missing"), { code: "profile_missing" });
  let providerCalls = 0;
  let captured: AgentSession | undefined;
  const adapter = createCapturingAdapter((session) => { captured = session; }, {
    modelRuntimeFactory: async () => {
      const runtime = await ModelRuntime.create({
        refreshOnCreate: false, allowModelNetwork: false, modelsPath: null,
        authPath: join(agentDir, "auth.json"), modelsStorePath: join(agentDir, "models-store.json"),
      });
      const refuse = (): never => { providerCalls += 1; throw new Error("provider_call_forbidden"); };
      runtime.registerProvider(selected.provider, {
        name: "Dry load", baseUrl: "http://127.0.0.1:9", apiKey: "dry-load-placeholder", api: "dry-load-api",
        models: [{ id: selected.model, name: "Dry load", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
        streamSimple: refuse,
      });
      for (const key of MODEL_CALLS) (runtime as unknown as Record<string, unknown>)[key] = refuse;
      return runtime;
    },
  });
  const registry = new SessionRegistry(adapter, config.workspaces);
  const server = createServer(registry, config.workspaces, config.executionProfiles, config.defaultExecutionProfile, config.configuration, config.workspaceModes);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "extension-ablation-dry-load", version: "1.0.0" }, { capabilities: {} });
  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    let structured: unknown;
    try { structured = (await client.callTool({ name, arguments: args })).structuredContent; } catch { throw new HarnessFailure("tool_call_failed"); }
    if (!isRecord(structured) || typeof structured.ok !== "boolean") throw new HarnessFailure("unexpected_tool_result");
    return structured;
  };

  let started = false;
  let startErrorCode: string | null = null;
  let activeTools: string[] = [];
  let sessionsLeft = 0;
  let harnessError: string | null = null;
  let sessionId: string | undefined;
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await call("pi_session_start", { workspace: input.workspaceAlias, executionProfile: input.profile });
    if (!result.ok) {
      startErrorCode = isRecord(result.error) && typeof result.error.code === "string" ? result.error.code : "internal_error";
    } else {
      if (!isRecord(result.session) || typeof result.session.id !== "string") throw new HarnessFailure("unexpected_tool_result");
      sessionId = result.session.id;
      started = true;
      if (captured === undefined) throw new HarnessFailure("session_not_captured");
      activeTools = [...captured.getActiveToolNames()].sort();
    }
  } catch (error) {
    harnessError = error instanceof HarnessFailure ? error.harnessCode : "unexpected_tool_result";
  } finally {
    if (sessionId !== undefined) await call("pi_session_close", { sessionId }).catch(() => undefined);
    const listed = await call("pi_session_list", {}).catch(() => undefined);
    sessionsLeft = listed?.ok === true && Array.isArray(listed.sessions) ? listed.sessions.length : registry.list().length;
    await Promise.allSettled([client.close(), server.close(), registry.shutdown()]);
  }
  const output: DryLoadOutput = { runId: input.runId, started, startErrorCode, activeTools, providerCalls, sessionsLeft, harnessError, mac: null };
  return deps.macKey === undefined ? output : { ...output, mac: macOf({ ...output }, deps.macKey) };
}

async function readStdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) text += chunk.toString("utf8");
  return text;
}

/** Like `run-one`: the supervisor's per-run key arrives on stdin first (R35); the MAC'd `dry-load-output.json` is written next to the input. */
async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error("input_path_required");
  const macKey = decodeKey(await readStdin());
  const input = dryLoadInputSchema.parse(JSON.parse(await readFile(inputPath, "utf8")));
  const output = await dryLoadOne(input, { macKey });
  await writeFile(join(dirname(inputPath), "dry-load-output.json"), JSON.stringify(output, null, 2) + "\n");
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  // Exit explicitly once the output is written, so a handle an extension leaves open cannot keep the process alive.
  const code = await main().then(() => 0, (error: unknown) => {
    const failure = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "dry_load_failed";
    process.stderr.write(JSON.stringify({ event: "dry_load_stopped", code: failure }) + "\n");
    return 1;
  });
  process.exit(code);
}

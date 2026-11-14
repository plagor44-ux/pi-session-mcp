/**
 * End-to-end proof for ADR 0019: a real Pi session on the faux provider (real tools, real session
 * entries) runs through the real registry, MCP server, recorder and store, and no sentinel secret
 * reaches the bytes of the history file or its WAL companions.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createGrepToolDefinition, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runHistoryCli } from "../src/history/cli.js";
import { PATH_RULE_MARKER } from "../src/history/constants.js";
import { compilePathRule } from "../src/history/path-rule.js";
import { procStartOf } from "../src/history/reconcile.js";
import { createHistoryRecorder } from "../src/history/recorder.js";
import { knownValuesFromEnv, Redactor } from "../src/history/redact.js";
import { historyLocation, openHistoryStore } from "../src/history/store.js";
import { SdkPiSessionAdapter } from "../src/sdk-pi-adapter.js";
import { createServer } from "../src/server.js";
import { SessionRegistry } from "../src/session-registry.js";
import { SECRET_PARTS, SENTINELS } from "./history-sentinels.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

/** Matches no credential pattern; only the path rule keeps it out. */
const DOTENV_ONLY = "dotenv only sentinel c41d7e9a";
let savedAgentDir: string | undefined;
beforeEach(() => { savedAgentDir = process.env.PI_CODING_AGENT_DIR; });
afterEach(() => {
  vi.restoreAllMocks();
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});
afterAll(removeTemporaryRoots);
// Where rg is not installed, as on the macOS runners, the SDK downloads it on first use. Do that here,
// so a slow download cannot use up the time limit of the test that greps.
beforeAll(async () => {
  const directory = await temporaryRoot("history-e2e-rg-");
  await writeFile(join(directory, "a.txt"), "needle\n");
  await createGrepToolDefinition(directory).execute("warm", { pattern: "needle" }, undefined, undefined, undefined as never);
}, 300_000);

type FauxResponses = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0];

/**
 * Runs one prompt on the faux provider through the real registry, MCP server, recorder and store,
 * with `files` written into the workspace first. Returns the history home and the public session id.
 */
async function recordSession(files: Record<string, string>, responses: FauxResponses, prompt: string): Promise<{ home: string; sessionId: string }> {
  const root = await temporaryRoot("history-e2e-");
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  await mkdir(home); await mkdir(workspace);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  await mkdir(process.env.PI_CODING_AGENT_DIR);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(workspace, path)), { recursive: true });
    await writeFile(join(workspace, path), content);
  }

  const stdout = vi.spyOn(process.stdout, "write");
  const stderrLines: string[] = [];
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { stderrLines.push(String(chunk)); return true; });

  const faux = fauxProvider();
  faux.setResponses(responses);
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  const model = faux.getModel();

  const store = await openHistoryStore({ home });
  const knownValues = knownValuesFromEnv({ MY_API_KEY: SENTINELS.known });
  const recorder = createHistoryRecorder({
    store, redactorFor: () => new Redactor({ knownValues, pathRule: compilePathRule([]) }),
    configurationFingerprint: `sha256:${"0".repeat(64)}`, packageVersion: "0.0.0-test",
    instance: { pid: process.pid, procStart: procStartOf(process.pid) },
    diagnostic: (code) => process.stderr.write(`${JSON.stringify({ level: "warn", event: "history_gap_unrecorded", stage: "history", code })}\n`),
  });
  const workspaces = new Map([["repo", workspace]]);
  const registry = new SessionRegistry(new SdkPiSessionAdapter({ modelRuntimeFactory: async () => runtime }), workspaces, { history: recorder });
  const profiles = new Map([["faux", { alias: "faux", default: true, permissionProfile: "read-only" as const, provider: model.provider, model: model.id, thinkingLevel: "off" as const }]]);
  const server = createServer(registry, workspaces, profiles, "faux", { fingerprint: `sha256:${"0".repeat(64)}`, reloadPolicy: "restart-required" }, undefined, "off", false, { history: { enabled: true } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "history-e2e", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  let sessionId: string;
  try {
    const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })).structuredContent as Record<string, any>;
    expect(await call("pi_capabilities_get", {})).toMatchObject({ history: { enabled: true }, routing: { mode: "off" } });
    const started = await call("pi_session_start", { workspace: "repo", task: "#215" });
    expect(started).toMatchObject({ ok: true });
    sessionId = started.session.id as string;
    const prompted = await call("pi_session_prompt", { sessionId, prompt });
    expect(prompted).toMatchObject({ ok: true });
    await vi.waitFor(async () => expect((await call("pi_turn_get", { sessionId, turnId: prompted.turn.turnId })).turn.state).toBe("completed"), { timeout: 15_000, interval: 50 });
    expect(await call("pi_session_close", { sessionId })).toMatchObject({ ok: true });
  } finally {
    await client.close(); await server.close();
    await registry.shutdown();
    store.close();
  }
  stderr.mockRestore();
  expect(stdout).not.toHaveBeenCalled();
  for (const line of stderrLines.join("").split("\n").filter(Boolean)) expect(() => JSON.parse(line), line).not.toThrow();
  return { home, sessionId };
}

/** Asserts that none of `secrets` is in the bytes of the history file or its WAL companions. */
function expectAbsentFromFiles(home: string, secrets: readonly string[]): void {
  const { file } = historyLocation(home);
  const files = [file, `${file}-wal`, `${file}-shm`].filter((path) => existsSync(path));
  expect(files).toContain(file);
  for (const path of files) {
    const bytes = readFileSync(path);
    for (const secret of secrets) expect(bytes.includes(Buffer.from(secret)), `${secret} in ${path.slice(file.length) || "main file"}`).toBe(false);
  }
}

async function historyCli(home: string, argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "", stderr = "";
  const code = await runHistoryCli(argv, { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; }, home });
  return { code, stdout, stderr };
}

describe("session history sentinel end to end", () => {
  it("stores redacted entries and no sentinel in history.sqlite, -wal or -shm", async () => {
    const { home } = await recordSession({ ".env": `${DOTENV_ONLY}\n` }, [
      fauxAssistantMessage([fauxToolCall("read", { path: ".env" })], { stopReason: "toolUse" }),
      fauxAssistantMessage(`done ${Object.values(SENTINELS).join(" ")}`),
    ], `Read .env, then report. ${SENTINELS.github_token}`);

    // Sanity: the session really was recorded, with the path rule applied.
    const check = await openHistoryStore({ home, readOnly: true });
    const entries = check.db.prepare("SELECT entry_type, role, tool_name, redacted_json, redactions, dropped_by_path FROM entries ORDER BY position").all() as Array<Record<string, unknown>>;
    const session = check.db.prepare("SELECT task, completeness, final_state FROM sessions").get();
    check.close();
    expect(session).toEqual({ task: "#215", completeness: "complete", final_state: "closed" });
    expect(entries.filter((entry) => entry.entry_type === "message").map((entry) => entry.role).filter((role) => role !== "system")).toEqual(["user", "assistant", "toolResult", "assistant"]);
    const toolResult = entries.find((entry) => entry.role === "toolResult")!;
    expect(toolResult).toMatchObject({ tool_name: "read", dropped_by_path: 1 });
    expect(String(toolResult.redacted_json)).toContain(PATH_RULE_MARKER);
    expect(Object.keys(JSON.parse(String(entries.at(-1)!.redactions)) as object).length).toBeGreaterThan(5);

    expectAbsentFromFiles(home, [...SECRET_PARTS, DOTENV_ONLY]);
  }, 30_000);

  it("keeps secrets in object keys out of the history file, show --full and export", async () => {
    // Without a `path` argument the timeline renders the whole argument object, keys included.
    const { home, sessionId } = await recordSession({ "notes/plain.txt": "plain\n" }, [
      fauxAssistantMessage([fauxToolCall("ls", { [SENTINELS.github_token]: { [SENTINELS.known]: "value under secret keys" } })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ], "List the workspace.");

    const check = await openHistoryStore({ home, readOnly: true });
    const assistant = check.db.prepare("SELECT redacted_json, redactions FROM entries WHERE role = 'assistant' ORDER BY position LIMIT 1").get() as Record<string, unknown>;
    check.close();
    const toolCall = (JSON.parse(String(assistant.redacted_json)) as { message: { content: Array<Record<string, unknown>> } }).message.content.find((block) => block.type === "toolCall");
    expect(toolCall?.arguments).toEqual({ "[REDACTED:github_token]": { "[REDACTED:known_value]": "value under secret keys" } });
    expect(JSON.parse(String(assistant.redactions))).toMatchObject({ github_token: 1, known_value: 1 });

    const secrets = [SENTINELS.github_token, SENTINELS.known];
    expectAbsentFromFiles(home, secrets);
    for (const argv of [["show", sessionId, "--full"], ["export", sessionId, "--format", "jsonl"]]) {
      const output = await historyCli(home, argv);
      expect(output.code, argv[0]).toBe(0);
      expect(output.stdout, argv[0]).toContain("[REDACTED:github_token]");
      for (const secret of secrets) expect(`${output.stdout}${output.stderr}`, `${argv[0]}: ${secret}`).not.toContain(secret);
    }
  }, 30_000);

  it.each([
    ["holds a line feed", "secrets/part\nvisible.txt", "secrets/part"],
    // Pi prints the backslash as a slash: the last line of the path reads `prod/:1: …`, which no rule protects alone.
    ["ends in a backslash after a line feed", "kubeconfig\nprod\\", "kubeconfig"],
  ])("keeps grep content of a protected file whose name %s out of the history file, show --full and export", async (_case, file, kept) => {
    const secret = "line feed grep sentinel 7d3a";
    const { home, sessionId } = await recordSession({ [file]: `needle ${secret}\n`, "notes/plain.txt": "needle plain-kept\n" }, [
      fauxAssistantMessage([fauxToolCall("grep", { pattern: "needle", path: "." })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("grep", { pattern: "needle", path: "notes" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ], "Search the workspace.");

    const check = await openHistoryStore({ home, readOnly: true });
    const results = check.db.prepare("SELECT redacted_json, dropped_by_path FROM entries WHERE role = 'toolResult' ORDER BY position").all() as Array<Record<string, unknown>>;
    check.close();
    expect(results).toHaveLength(2);
    // rg found the file: the first piece of its path holds no separator and stays.
    expect(results[0]).toMatchObject({ dropped_by_path: 1 });
    expect(String(results[0]!.redacted_json)).toContain(kept);
    expect(results[1]).toMatchObject({ dropped_by_path: 0 });
    expect(String(results[1]!.redacted_json)).toContain("plain.txt:1: needle plain-kept");

    expectAbsentFromFiles(home, [secret]);
    for (const argv of [["show", sessionId, "--full"], ["export", sessionId, "--format", "jsonl"]]) {
      const output = await historyCli(home, argv);
      expect(output.code, argv[0]).toBe(0);
      expect(`${output.stdout}${output.stderr}`, argv[0]).not.toContain(secret);
      if (argv[0] === "export") expect(output.stdout).toContain("plain-kept");
    }
  }, 30_000);
});

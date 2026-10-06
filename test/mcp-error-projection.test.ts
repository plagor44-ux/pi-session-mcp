/**
 * The pinned, public Pi SDK executes granted tools over an actual
 * child stdio MCP connection. Only the model runtime is scripted. These are
 * provider-free transport/SDK checks, not live model or client acceptance.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createAgentSession, type AgentSessionEvent, type ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, it } from "vitest";
import { readFixtureLog } from "./fixture-log.js";
import type { ResolvedExecutionProfile } from "../src/execution-profile.js";
import type { McpServers } from "../src/mcp-config.js";
import { connectSessionMcpTools } from "../src/mcp-session-tools.js";
import { createStdioMcpConnection } from "../src/mcp-stdio-client.js";
import { SdkPiSessionAdapter } from "../src/sdk-pi-adapter.js";
import { SessionRegistry } from "../src/session-registry.js";
import { declaredTools, type DeclaringMessage } from "./model-context.js";

const SERVER = fileURLToPath(new URL("./fixtures/mcp-stdio-server.mjs", import.meta.url));
const TOOL = "mcp_knowledge_source";
const FOREIGN_MARKER = "MCP_ERROR_FIXTURE_LEAK_MARKER";
const LARGE_MARKER = "MCP_LARGE_RESULT_LEAK_MARKER";
const RESULT_LIMIT = 262144;
const RESULT_LIMIT_MESSAGE = "External MCP result exceeds the bridge limit of 262144 bytes; request less data.";
const GENERIC = "External MCP operation failed";
const PROJECTED = JSON.stringify({
  code: "SOURCE_TOO_LARGE", message: "Requested source exceeds the response limit; increase maxBytes.",
});
const IS_PROBE = process.env.PI_SESSION_MCP_ERROR_OUTPUT_PROBE === "1";
const cleanup: Array<() => Promise<unknown>> = [];
const fixtureLogs: string[] = [];
const temporaries: string[] = [];
const hostVariables: string[] = [];

interface Recorded {
  event: string; pid?: number; name?: string; args?: Record<string, unknown>;
  result?: unknown; kind?: string; stderrBytes?: number; released?: boolean;
}
interface Message extends DeclaringMessage {
  role?: string; toolName?: string; isError?: boolean; content?: Array<{ type: string; text?: string }>;
}
interface Context { messages?: Message[] }

async function records(logPath: string): Promise<Recorded[]> {
  return readFixtureLog<Recorded>(logPath);
}

async function recordWithin(logPath: string, event: string, milliseconds = 10_000): Promise<Recorded> {
  const deadline = Date.now() + milliseconds;
  do {
    const record = (await records(logPath)).find((candidate) => candidate.event === event);
    if (record) return record;
    await pause(10);
  } while (Date.now() < deadline);
  throw new Error(`Fixture did not record ${event} within its deadline`);
}

async function processGone(pid: number, milliseconds = 5_000): Promise<void> {
  const deadline = Date.now() + milliseconds;
  do {
    try { process.kill(pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await pause(10);
  } while (Date.now() < deadline);
  assert.fail("Owned child process survived its bounded cleanup");
}

async function within<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  const cancellation = new AbortController();
  const deadline = pause(milliseconds, undefined, { signal: cancellation.signal }).then(() => {
    throw new Error("Operation exceeded its test deadline");
  });
  try { return await Promise.race([operation, deadline]); }
  finally { cancellation.abort(); }
}

afterEach(async () => {
  try {
    while (cleanup.length) await cleanup.pop()!();
  } finally {
    // Even a failed assertion or killed controller probe must leave no owned child.
    for (const logPath of fixtureLogs.splice(0)) {
      for (const pid of new Set((await records(logPath)).flatMap((record) => record.pid === undefined ? [] : [record.pid]))) {
        try { process.kill(pid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        await processGone(pid);
      }
    }
    for (const name of hostVariables.splice(0)) delete process.env[name];
    while (temporaries.length) await rm(temporaries.pop()!, { recursive: true, force: true });
  }
});

async function fixture(errorResult: unknown, held = false, existingDirectory?: string, largeReply?: "success" | "error") {
  const directory = existingDirectory ?? await mkdtemp(join(tmpdir(), "pi-session-mcp-error-"));
  if (existingDirectory === undefined) temporaries.push(directory);
  const logPath = join(directory, "calls.jsonl");
  fixtureLogs.push(logPath);
  const release = join(directory, "release-source");
  const envFrom: Record<string, string> = {};
  for (const [target, value] of [
    ["MCP_FIXTURE_LOG", logPath], ["MCP_FIXTURE_SOURCE_ERROR", JSON.stringify(errorResult)],
    ...(largeReply === undefined ? [] : [["MCP_FIXTURE_SOURCE_LARGE_RESULT", largeReply]]),
    ...(held ? [["MCP_FIXTURE_HOLD_RELEASE_FILE", release]] : []),
  ] as Array<[string, string]>) {
    const host = `PI_SESSION_MCP_ERROR_${target}`;
    hostVariables.push(host);
    process.env[host] = value;
    envFrom[target] = host;
  }
  const servers: McpServers = { knowledge: {
    command: process.execPath, args: [SERVER], envFrom,
    tools: { source: { name: "source_excerpt", readOnly: true } },
  } };
  return { directory, logPath, release, servers };
}

function profile(servers: McpServers): ResolvedExecutionProfile {
  return { alias: "verify", permissionProfile: "read-only", provider: "scripted", model: "scripted", thinkingLevel: "off", mcpServers: servers };
}

function scriptedRuntime(decide: (call: number, context: Context) => { maxBytes: number } | { text: string }) {
  const contexts: Context[] = [];
  const model = { provider: "scripted", id: "scripted", input: ["text"] };
  const runtime = {
    getProvider: () => ({ id: "scripted" }), getModel: () => model,
    checkAuth: async () => true, getAuth: async () => ({ token: "synthetic" }),
    getAvailable: async () => [model], getAvailableSnapshot: () => [model], hasConfiguredAuth: () => true,
    streamSimple: async (_model: unknown, context: Context, options?: { signal?: AbortSignal }) => {
      // Snapshot the actual model boundary; later SDK transcript mutations must
      // never make an earlier context appear to have received a later result.
      contexts.push(structuredClone(context));
      const call = contexts.length - 1;
      assert.ok(call < 8, "scripted model must have a finite request budget");
      // A real provider honors request cancellation. Without this terminal
      // completion, a scripted toolUse reply can loop forever after SDK abort.
      const aborted = options?.signal?.aborted === true;
      const next = aborted ? { text: "" } : decide(call, context);
      const message = {
        role: "assistant", api: "scripted", provider: "scripted", model: "scripted",
        content: "maxBytes" in next
          ? [{ type: "toolCall", id: `source_${call}`, name: TOOL, arguments: { maxBytes: next.maxBytes } }]
          : [{ type: "text", text: next.text }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 1 },
        stopReason: aborted ? "aborted" : "maxBytes" in next ? "toolUse" : "stop", timestamp: Date.now(),
      };
      return {
        async *[Symbol.asyncIterator]() { yield { type: "start", partial: message }; },
        async result() { return message; },
      };
    },
  } as unknown as ModelRuntime;
  return { runtime, contexts };
}

function toolResult(context: Context | undefined): Message | undefined {
  return context?.messages?.findLast((message) => message.role === "toolResult" && message.toolName === TOOL);
}

type ToolEnd = Extract<AgentSessionEvent, { type: "tool_execution_end" }>;

function registryFor(runtime: ModelRuntime, directory: string, toolEnds: ToolEnd[] = []): SessionRegistry {
  const adapter = new SdkPiSessionAdapter({
    modelRuntimeFactory: async () => runtime, mcpConnectionFactory: createStdioMcpConnection,
    createSession: async (options) => {
      const created = await createAgentSession(options);
      created.session.subscribe((event) => {
        if (event.type === "tool_execution_end") toolEnds.push(structuredClone(event));
      });
      return created;
    },
  });
  const registry = new SessionRegistry(adapter, new Map([["repo", directory]]));
  cleanup.push(() => registry.shutdown());
  return registry;
}

async function terminalWithin(registry: SessionRegistry, sessionId: string, turnId: string) {
  const deadline = Date.now() + 10_000;
  do {
    const turn = registry.getTurn(sessionId, turnId);
    if (turn.state !== "running") return turn;
    await pause(10);
  } while (Date.now() < deadline);
  assert.fail("Real SDK turn did not settle within its deadline");
}

async function correctedWorkflow(errorResult: unknown, expected: string, existingDirectory?: string, largeReply?: "success" | "error") {
  const f = await fixture(errorResult, false, existingDirectory, largeReply);
  const initialMaxBytes = largeReply === undefined ? 1 : 4096;
  const { runtime, contexts } = scriptedRuntime((call, context) => {
    if (call === 0) return { maxBytes: initialMaxBytes };
    const result = toolResult(context);
    if (call === 1) {
      assert.equal(result?.isError, true, "the real Pi SDK must expose a failed tool execution");
      assert.deepEqual(result.content, [{ type: "text", text: expected }]);
      if (expected === PROJECTED) assert.equal(JSON.parse(result.content![0]!.text!).code, "SOURCE_TOO_LARGE");
      // The corrected request follows the error actually offered to the model.
      return { maxBytes: 128 };
    }
    assert.equal(result?.isError, false);
    assert.deepEqual(result.content, [{ type: "text", text: "synthetic-source-oracle" }]);
    return { text: "verified" };
  });
  const toolEnds: ToolEnd[] = [];
  const registry = registryFor(runtime, f.directory, toolEnds);
  const session = await within(registry.start("repo", profile(f.servers)), 15_000);
  const pid = (await recordWithin(f.logPath, "connected")).pid;
  assert.ok(pid);
  const accepted = await within(registry.prompt(session.id, "Read the synthetic source."), 10_000);
  const terminal = await terminalWithin(registry, session.id, accepted.turn.turnId);
  assert.equal(toolResult(contexts[1])?.isError, true);
  assert.deepEqual(toolResult(contexts[1])?.content, [{ type: "text", text: expected }]);
  assert.equal(terminal.state, "completed");
  assert.equal(terminal.assistantText, "verified");
  assert.equal(contexts.length, 3, "error, correction and oracle must belong to the same SDK session");
  assert.equal(toolResult(contexts[2])?.isError, false);
  assert.deepEqual(toolEnds.map((event) => ({ name: event.toolName, isError: event.isError })), [
    { name: TOOL, isError: true }, { name: TOOL, isError: false },
  ], "the public SDK completion event marks the failure before the corrected success");
  assert.deepEqual(toolEnds[0]!.result.content, [{ type: "text", text: expected }]);
  assert.equal(JSON.stringify(toolEnds).includes(FOREIGN_MARKER), false);
  assert.equal(JSON.stringify(toolEnds).includes(LARGE_MARKER), false);
  for (const context of contexts) {
    assert.ok(declaredTools(context.messages).includes(TOOL), "the same granted tool stays active");
    assert.equal(JSON.stringify(context).includes(FOREIGN_MARKER), false, "foreign fields/text must not reach the model");
    assert.equal(JSON.stringify(context).includes(LARGE_MARKER), false, "oversized payload must not reach the model");
  }
  const childRecords = await records(f.logPath);
  assert.deepEqual(childRecords.filter((record) => record.event === "tools/call").map(({ name, args }) => ({ name, args })), [
    { name: "source_excerpt", args: { maxBytes: initialMaxBytes } }, { name: "source_excerpt", args: { maxBytes: 128 } },
  ], "both Pi-validated requests cross the real child boundary to the same tool");
  const returned = childRecords.find((record) => record.event === "source-result" && record.result !== undefined);
  assert.ok(returned);
  if (largeReply === undefined) assert.deepEqual(returned.result, errorResult, "the child actually produced the tested envelope");
  else {
    const result = returned.result as { isError: boolean };
    const serialized = JSON.stringify(result);
    assert.equal(result.isError, largeReply === "error", "the actual remote success/error flag crossed stdio");
    assert.ok(serialized.includes(LARGE_MARKER), "the child produced the oversized marker payload");
    assert.ok(Buffer.byteLength(serialized, "utf8") > RESULT_LIMIT, "the actual serialized result exceeds the UTF-8 envelope cap");
    if (largeReply === "success") assert.ok(serialized.length < RESULT_LIMIT, "UTF-16 length alone would miss this oversized result");
  }
  assert.ok((returned.stderrBytes ?? 0) > 0, "the child wrote its foreign envelope to real stderr");
  const closed = await within(registry.close(session.id), 10_000);
  assert.equal(closed.state, "closed");
  await processGone(pid);
  const publicViews = JSON.stringify([session, accepted, terminal, closed, registry.list()]);
  assert.equal(publicViews.includes(FOREIGN_MARKER), false);
  assert.equal(publicViews.includes(LARGE_MARKER), false);
  assert.equal(publicViews.includes(RESULT_LIMIT_MESSAGE), false, "local tool failures add no public turn/session error field");
  assert.equal(publicViews.includes("SOURCE_TOO_LARGE"), false, "internal recoverable code adds no public turn/session field");
  assert.deepEqual(Object.keys(terminal).sort(), ["assistantText", "completedAt", "sessionId", "startedAt", "state", "truncated", "turnId", "updatedAt"]);
  return { contexts, publicViews };
}

const foreign = { code: "SOURCE_TOO_LARGE", message: FOREIGN_MARKER };
const textError = (value: unknown) => ({ isError: true, content: [{ type: "text", text: JSON.stringify(value) }] });
const structuredError = (value: unknown) => ({ isError: true, content: [], structuredContent: value });
const acceptedRepresentations = [
  { label: "one JSON text block", result: textError(foreign) },
  { label: "decoded structured content", result: structuredError(foreign) },
  { label: "matching text and structured content", result: { ...textError(foreign), structuredContent: foreign } },
  { label: "one-character message", result: textError({ ...foreign, message: "x" }) },
  { label: "200-character message", result: textError({ ...foreign, message: "x".repeat(200) }) },
  { label: "200 Unicode codepoints in the bounded structured envelope", result: structuredError({ ...foreign, message: "😀".repeat(200) }) },
];

const rejectedRepresentations: Array<{ label: string; result: unknown }> = [
  { label: "unknown code", result: textError({ code: FOREIGN_MARKER, message: "Retry." }) },
  { label: "malformed string isError flag", result: { ...textError(foreign), isError: "true" } },
  { label: "malformed numeric isError flag", result: { ...textError(foreign), isError: 1 } },
  { label: "malformed null isError flag", result: { ...textError(foreign), isError: null } },
  { label: "extra credential field", result: textError({ ...foreign, token: FOREIGN_MARKER }) },
  { label: "structured extra field", result: structuredError({ ...foreign, path: FOREIGN_MARKER }) },
  { label: "missing message", result: textError({ code: "SOURCE_TOO_LARGE" }) },
  { label: "non-string code", result: textError({ code: 7, message: FOREIGN_MARKER }) },
  { label: "non-string message", result: structuredError({ code: "SOURCE_TOO_LARGE", message: { token: FOREIGN_MARKER } }) },
  { label: "empty message", result: textError({ code: "SOURCE_TOO_LARGE", message: "" }) },
  { label: "message beyond 200 characters", result: textError({ ...foreign, message: `${FOREIGN_MARKER}${"x".repeat(201)}` }) },
  { label: "Unix path", result: textError({ ...foreign, message: `/private/${FOREIGN_MARKER}/source.txt` }) },
  { label: "Windows path", result: structuredError({ ...foreign, message: `C:\\private\\${FOREIGN_MARKER}\\source.txt` }) },
  { label: "URL", result: textError({ ...foreign, message: `https://example.invalid/${FOREIGN_MARKER}` }) },
  { label: "control character", result: textError({ ...foreign, message: `${FOREIGN_MARKER}\nRetry.` }) },
  { label: "Unicode format character", result: textError({ ...foreign, message: `${FOREIGN_MARKER}\u200d` }) },
  { label: "oversize envelope", result: { ...textError(foreign), _meta: { foreign: FOREIGN_MARKER.repeat(100) } } },
  { label: "conflicting representations", result: { ...textError(foreign), structuredContent: { ...foreign, message: "Different advice." } } },
  { label: "duplicate raw JSON key", result: { isError: true, content: [{ type: "text", text: `{"code":"SOURCE_TOO_LARGE","message":"${FOREIGN_MARKER}","message":"Retry."}` }] } },
  { label: "escaped duplicate raw JSON key", result: { isError: true, content: [{ type: "text", text: `{"code":"SOURCE_TOO_LARGE","message":"${FOREIGN_MARKER}","mess\\u0061ge":"Retry."}` }] } },
  { label: "malformed JSON", result: { isError: true, content: [{ type: "text", text: `{${FOREIGN_MARKER}` }] } },
  { label: "non-JSON text", result: { isError: true, content: [{ type: "text", text: FOREIGN_MARKER }] } },
  { label: "multiple content blocks", result: { isError: true, content: [...textError(foreign).content, { type: "text", text: FOREIGN_MARKER }] } },
  { label: "extra text-block field", result: { isError: true, content: [{ ...textError(foreign).content[0], annotations: { marker: FOREIGN_MARKER } }] } },
  { label: "structured array", result: structuredError([foreign]) },
  { label: "structured null", result: structuredError(null) },
  { label: "both representations absent", result: { isError: true, content: [] } },
];

const heldReplyScenarios: Array<{ label: string; largeReply?: "success" }> = [
  { label: "permitted-code error" }, { label: "oversized success", largeReply: "success" },
];

describe.skipIf(IS_PROBE)("MCP error projection through the real SDK and stdio", () => {
  it.each(acceptedRepresentations)("preserves SOURCE_TOO_LARGE via $label and permits correction", async ({ result }) => {
    await correctedWorkflow(result, PROJECTED);
  }, 30_000);

  it.each(rejectedRepresentations)("uses a redacted generic failure for $label then succeeds", async ({ result }) => {
    await correctedWorkflow(result, GENERIC);
  }, 30_000);

  it("reports an oversized remote success precisely and succeeds with a smaller request", async () => {
    await correctedWorkflow(textError(foreign), RESULT_LIMIT_MESSAGE, undefined, "success");
  }, 30_000);

  it("keeps an oversized remote isError result generic and permits a smaller request", async () => {
    await correctedWorkflow(textError(foreign), GENERIC, undefined, "error");
  }, 30_000);

  it("keeps a timed-out late allowed-code reply generic and admits a corrected call", async () => {
    const f = await fixture(textError(foreign), true);
    const session = await connectSessionMcpTools(f.servers, "read-only", f.directory, createStdioMcpConnection, { callMs: 250 });
    cleanup.push(() => session.close());
    const pid = (await recordWithin(f.logPath, "connected")).pid;
    assert.ok(pid);
    const tool = session.tools[0]!;
    const pending = call(tool, 1);
    const rejected = assert.rejects(pending, { message: GENERIC });
    await recordWithin(f.logPath, "source-held");
    await within(rejected, 5_000);
    await writeFile(f.release, "released\n");
    assert.equal((await recordWithin(f.logPath, "source-released")).released, true);
    const late = await recordWithin(f.logPath, "source-result");
    assert.deepEqual(late.result, textError(foreign), "the actual late reply held the permitted code");
    const corrected = await within(call(tool, 128), 5_000);
    assert.deepEqual(corrected.content, [{ type: "text", text: "synthetic-source-oracle" }]);
    await session.close();
    await processGone(pid);
  }, 30_000);

  it("keeps a timed-out oversized success generic and permits a smaller later result", async () => {
    const f = await fixture(textError(foreign), true, undefined, "success");
    const session = await connectSessionMcpTools(f.servers, "read-only", f.directory, createStdioMcpConnection, { callMs: 250 });
    cleanup.push(() => session.close());
    const pid = (await recordWithin(f.logPath, "connected")).pid;
    assert.ok(pid);
    const tool = session.tools[0]!;
    const rejected = assert.rejects(call(tool, 4096), { message: GENERIC });
    await recordWithin(f.logPath, "source-held");
    await within(rejected, 5_000);
    await writeFile(f.release, "released\n");
    const late = await recordWithin(f.logPath, "source-result");
    assert.equal((late.result as { isError: boolean }).isError, false);
    assert.ok(Buffer.byteLength(JSON.stringify(late.result), "utf8") > RESULT_LIMIT);
    assert.ok(JSON.stringify(late.result).includes(LARGE_MARKER), "the actual large success arrived after the timeout");
    const corrected = await within(call(tool, 128), 5_000);
    assert.deepEqual(corrected.content, [{ type: "text", text: "synthetic-source-oracle" }]);
    assert.deepEqual((await records(f.logPath)).filter((record) => record.event === "tools/call").map(({ name, args }) => ({ name, args })), [
      { name: "source_excerpt", args: { maxBytes: 4096 } }, { name: "source_excerpt", args: { maxBytes: 128 } },
    ]);
    await session.close();
    await processGone(pid);
  }, 30_000);

  it.each(heldReplyScenarios)("keeps abort authoritative over a late $label without reviving the turn", async ({ largeReply }) => {
    const f = await fixture(structuredError(foreign), true, undefined, largeReply);
    const initialMaxBytes = largeReply === undefined ? 1 : 4096;
    const { runtime, contexts } = scriptedRuntime((call, context) => {
      if (call === 0) return { maxBytes: initialMaxBytes };
      if (toolResult(context)?.content?.[0]?.text === "synthetic-source-oracle") return { text: "verified" };
      return { maxBytes: 128 };
    });
    const registry = registryFor(runtime, f.directory);
    const session = await registry.start("repo", profile(f.servers));
    const pid = (await recordWithin(f.logPath, "connected")).pid;
    assert.ok(pid);
    const accepted = await registry.prompt(session.id, "Read the held source.");
    await recordWithin(f.logPath, "source-held");
    await within(registry.abort(session.id), 10_000);
    const aborted = registry.getTurn(session.id, accepted.turn.turnId);
    assert.equal(aborted.state, "aborted");
    await writeFile(f.release, "released\n");
    const late = await recordWithin(f.logPath, "source-result");
    if (largeReply === undefined) assert.deepEqual(late.result, structuredError(foreign));
    else {
      assert.equal((late.result as { isError: boolean }).isError, false);
      assert.ok(Buffer.byteLength(JSON.stringify(late.result), "utf8") > RESULT_LIMIT);
      assert.ok(JSON.stringify(late.result).includes(LARGE_MARKER));
    }
    assert.deepEqual(registry.getTurn(session.id, accepted.turn.turnId), aborted, "late reply cannot change terminal state or stamps");
    const next = await registry.prompt(session.id, "Read with a corrected response limit.");
    const terminal = await terminalWithin(registry, session.id, next.turn.turnId);
    assert.equal(terminal.state, "completed");
    assert.equal(terminal.assistantText, "verified");
    assert.equal(JSON.stringify(contexts).includes("SOURCE_TOO_LARGE"), false, "an aborted late reply never reaches the model");
    assert.equal(JSON.stringify(contexts).includes(FOREIGN_MARKER), false);
    assert.equal(JSON.stringify(contexts).includes(LARGE_MARKER), false);
    assert.equal(JSON.stringify(contexts).includes(RESULT_LIMIT_MESSAGE), false, "the local size failure cannot replace abort");
    assert.equal(JSON.stringify([aborted, terminal]).includes(FOREIGN_MARKER), false);
    assert.equal(JSON.stringify([aborted, terminal]).includes(LARGE_MARKER), false);
    const calls = (await records(f.logPath)).filter((record) => record.event === "tools/call");
    assert.deepEqual(calls.map((record) => record.args), [{ maxBytes: initialMaxBytes }, { maxBytes: 128 }]);
    await registry.close(session.id);
    await processGone(pid);
  }, 30_000);

  it.each(heldReplyScenarios)("closes with a $label held and never resurrects its child or registry entry", async ({ largeReply }) => {
    const f = await fixture(textError(foreign), true, undefined, largeReply);
    const { runtime, contexts } = scriptedRuntime(() => ({ maxBytes: largeReply === undefined ? 1 : 4096 }));
    const registry = registryFor(runtime, f.directory);
    const session = await registry.start("repo", profile(f.servers));
    const pid = (await recordWithin(f.logPath, "connected")).pid;
    assert.ok(pid);
    await registry.prompt(session.id, "Read the held source.");
    await recordWithin(f.logPath, "source-held");
    const closed = await within(registry.close(session.id), 10_000);
    assert.equal(closed.state, "closed");
    await processGone(pid);
    await writeFile(f.release, "too late\n");
    assert.deepEqual(await registry.close(session.id), closed);
    assert.deepEqual(registry.list(), []);
    await assert.rejects(registry.prompt(session.id, "late correction"), { code: "unknown_session" });
    assert.ok(contexts.length <= 2, "closure permits at most the SDK's cancelled model completion");
    assert.equal(JSON.stringify(contexts).includes("SOURCE_TOO_LARGE"), false);
    assert.equal(JSON.stringify(contexts).includes(FOREIGN_MARKER), false);
    assert.equal(JSON.stringify(contexts).includes(LARGE_MARKER), false);
    assert.equal(JSON.stringify(contexts).includes(RESULT_LIMIT_MESSAGE), false);
    assert.equal((await records(f.logPath)).some((record) => record.event === "source-result"), false,
      "the real child exited before its held foreign reply");
  }, 30_000);

  it("captures the controller's real stdout and stderr during redaction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-session-mcp-error-output-"));
    temporaries.push(directory);
    fixtureLogs.push(join(directory, "calls.jsonl"));
    fixtureLogs.push(join(directory, "fallback", "calls.jsonl"));
    fixtureLogs.push(join(directory, "large-success", "calls.jsonl"));
    fixtureLogs.push(join(directory, "large-error", "calls.jsonl"));
    const output: string[] = [];
    const vitest = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
    const child = spawn(process.execPath, [vitest, "run", "test/mcp-error-projection.test.ts", "-t", "isolated controller output probe", "--maxWorkers=1", "--no-file-parallelism"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PI_SESSION_MCP_ERROR_OUTPUT_PROBE: "1", PI_SESSION_MCP_ERROR_OUTPUT_DIRECTORY: directory,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --unhandled-rejections=strict` },
    });
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
    // `exit` can precede the final stdout/stderr chunks. `close` establishes
    // both process termination and drained output before the leak assertions.
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject); child.once("close", resolve);
    });
    try {
      assert.equal(await within(closed, 30_000), 0, `Isolated controller probe failed: ${output.join("")}`);
      const emitted = (await records(join(directory, "calls.jsonl"))).find((record) => record.event === "source-result" && record.kind === "error");
      assert.ok(JSON.stringify(emitted?.result).includes(FOREIGN_MARKER), "the child really returned foreign text");
      assert.ok((emitted?.stderrBytes ?? 0) > 0, "the child really wrote that foreign text to fd 2");
      const fallback = (await records(join(directory, "fallback", "calls.jsonl"))).find((record) => record.event === "source-result" && record.kind === "error");
      assert.ok(JSON.stringify(fallback?.result).includes(FOREIGN_MARKER));
      assert.ok((fallback?.stderrBytes ?? 0) > 0, "the generic-fallback child wrote foreign text to fd 2 too");
      for (const kind of ["success", "error"] as const) {
        const large = (await records(join(directory, `large-${kind}`, "calls.jsonl"))).find((record) => record.event === "source-result" && record.result !== undefined);
        assert.equal((large?.result as { isError: boolean }).isError, kind === "error");
        assert.ok(JSON.stringify(large?.result).includes(LARGE_MARKER));
        assert.ok(Buffer.byteLength(JSON.stringify(large?.result), "utf8") > RESULT_LIMIT);
        assert.ok((large?.stderrBytes ?? 0) > RESULT_LIMIT, "the oversized reply also reached the child's real fd 2");
      }
      assert.equal(output.join("").includes(FOREIGN_MARKER), false, "neither controller fd 1 nor fd 2 may relay foreign text");
      assert.equal(output.join("").includes(LARGE_MARKER), false, "controller output must not relay an oversized payload");
      assert.equal(output.join("").includes("MCP_FIXTURE_STDERR_MARKER"), false, "stdio transport must drain child diagnostics");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await within(closed, 5_000);
    }
  }, 40_000);
});

function call(tool: ToolDefinition, maxBytes: number) {
  return tool.execute("lifecycle-source", { maxBytes } as never, undefined, undefined, undefined as never);
}

it.runIf(IS_PROBE)("isolated controller output probe", async () => {
  const directory = process.env.PI_SESSION_MCP_ERROR_OUTPUT_DIRECTORY;
  assert.ok(directory);
  await correctedWorkflow(textError(foreign), PROJECTED, directory);
  const fallbackDirectory = join(directory, "fallback");
  await mkdir(fallbackDirectory);
  await correctedWorkflow(textError({ ...foreign, token: FOREIGN_MARKER }), GENERIC, fallbackDirectory);
  for (const kind of ["success", "error"] as const) {
    const largeDirectory = join(directory, `large-${kind}`);
    await mkdir(largeDirectory);
    await correctedWorkflow(textError(foreign), kind === "success" ? RESULT_LIMIT_MESSAGE : GENERIC, largeDirectory, kind);
  }
}, 25_000);

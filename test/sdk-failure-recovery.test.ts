/**
 * Provider-free failure-cause evidence: interim vs terminal failures.
 *
 * Every case runs the real `createAgentSession` from the pinned public
 * `@earendil-works/pi-coding-agent` 0.84.4 and only scripts the model provider
 * (`ModelRuntime.streamSimple`). No credential, no network, and no fabricated
 * `prompt()` rejection is involved: transport, JSON-Schema argument validation, tool
 * execution, compaction and auto-retry stay production paths, and where the external
 * MCP bridge is used that is the real stdio child process too.
 *
 * Cause decision (no runtime change; rationale in `docs/tool-contracts.md`): the pinned
 * SDK exposes no closed, structured *terminal* discriminator that separates a provider
 * rejection from a context overflow or from a failed compaction. A context overflow that
 * recovers disappears entirely (the turn completes), an overflow whose recovery fails is
 * only distinguishable inside transient `compaction_end` events, and Pi Session MCP projects
 * solely the final assistant outcome. `turn_failed` therefore stays the only terminal
 * failure projection, and these tests pin that contract and the evidence behind it.
 *
 * Deliberately not duplicated here:
 * - preflight rejection/timeout and late settlement: `test/lifecycle-hardening.test.ts`,
 *   `test/registry.test.ts`, `test/mcp-contract.test.ts`
 * - abort deadline, abort coalescing and close during a running turn:
 *   `test/lifecycle-hardening.test.ts`, `test/mcp-contract.test.ts`
 * - real stdio bridge transport, sanitizing, cancellation and child reaping:
 *   `test/mcp-stdio-e2e.test.ts`
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as waitFor } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "vitest";
import {
  createAgentSession,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { ConfigurationMetadata } from "../src/config.js";
import type { ConfiguredExecutionProfile, ResolvedExecutionProfile } from "../src/execution-profile.js";
import { createStdioMcpConnection } from "../src/mcp-stdio-client.js";
import { SdkPiSessionAdapter } from "../src/sdk-pi-adapter.js";
import { createServer } from "../src/server.js";
import { SessionRegistry, type TurnView } from "../src/session-registry.js";
import type { McpServers } from "../src/mcp-config.js";
import { declaredTools, type DeclaringMessage } from "./model-context.js";

const SERVER = fileURLToPath(new URL("./fixtures/mcp-stdio-server.mjs", import.meta.url));
const NODE = process.execPath;
const LOG_HOST_VARIABLE = "PI_SESSION_MCP_TEST_MCP_LOG";
/** Synthetic causes; they must never appear in a projected MCP response. */
const TERMINAL_ERROR_MARKER = "PI_SESSION_MCP_TEST_TERMINAL_ERROR_MARKER";
const RETRYABLE_ERROR_MARKER = "PI_SESSION_MCP_TEST_RETRYABLE_ERROR_MARKER";
const OVERFLOW_ERROR_MARKER = "PI_SESSION_MCP_TEST_OVERFLOW_ERROR_MARKER";
const SUMMARY_MARKER = "PI_SESSION_MCP_TEST_SUMMARY_MARKER";
const SUMMARIZER_FAILURE_MARKER = "PI_SESSION_MCP_TEST_SUMMARIZER_FAILURE_MARKER";
const TERMINAL_ERROR_MESSAGE = `invalid_request_error: unsupported parameter combination (${TERMINAL_ERROR_MARKER})`;
const RETRYABLE_ERROR_MESSAGE = `overloaded_error: provider returned error (${RETRYABLE_ERROR_MARKER})`;
const OVERFLOW_ERROR_MESSAGE = `prompt is too long: 41000 tokens exceed the configured context size (${OVERFLOW_ERROR_MARKER})`;
const SUMMARIZER_FAILURE_MESSAGE = `summarizer unavailable (${SUMMARIZER_FAILURE_MARKER})`;
const TEST_CONFIGURATION: ConfigurationMetadata = Object.freeze({
  fingerprint: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  reloadPolicy: "restart-required",
});
/** One truncated `read` result is 51,200 bytes; two of them make a real compaction possible. */
const LARGE_READ_CHARS = 51_200;

const temporaries: string[] = [];
const fixtureLogs: string[] = [];
const activeClosers: Array<() => Promise<void>> = [];

afterEach(async () => {
  // A failing assertion must not leave an MCP child or an MCP pair running for the rest of the job.
  while (activeClosers.length > 0) {
    const close = activeClosers.pop()!;
    try { await close(); } catch { /* best effort */ }
  }
  for (const logPath of fixtureLogs.splice(0)) {
    for (const record of await records(logPath)) {
      if (record.pid === undefined) continue;
      try { process.kill(record.pid, 0); process.kill(record.pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
  delete process.env[LOG_HOST_VARIABLE];
  for (const key of Object.keys(process.env)) if (key.startsWith("PI_SESSION_MCP_TEST_MCP_FIXTURE_")) delete process.env[key];
  while (temporaries.length > 0) await rm(temporaries.pop()!, { recursive: true, force: true });
});

interface Recorded { event: string; name?: string; pid?: number }

async function temporaryDirectory(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temporaries.push(dir);
  return dir;
}

async function records(logPath: string): Promise<Recorded[]> {
  const text = await readFile(logPath, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Recorded);
}

async function toolCalls(logPath: string): Promise<Recorded[]> {
  return (await records(logPath)).filter((record) => record.event === "tools/call");
}

/**
 * The fixture cannot see `process.env` directly: `envFrom` forwards one named host
 * variable. The log path is therefore handed over through a host variable.
 */
async function scratchFixture(tools: Record<string, { name: string; readOnly: boolean }>): Promise<{ log: string; logPath: string; servers: McpServers }> {
  const log = await temporaryDirectory("pi-session-mcp-sdk-failure-");
  const logPath = join(log, "calls.jsonl");
  fixtureLogs.push(logPath);
  process.env[LOG_HOST_VARIABLE] = logPath;
  return {
    log,
    logPath,
    servers: { knowledge: { command: NODE, args: [SERVER], envFrom: { MCP_FIXTURE_LOG: LOG_HOST_VARIABLE }, tools } },
  };
}

/** A read-only profile with no external server unless a test grants one. */
function profile(mcpServers: McpServers): ResolvedExecutionProfile {
  return { alias: "verify", permissionProfile: "read-only", provider: "scripted", model: "scripted", thinkingLevel: "off", mcpServers };
}

/** Writes two files whose `read` output is truncated at the SDK's 51,200-byte output cap. */
async function largeWorkspace(): Promise<string> {
  const cwd = await temporaryDirectory("pi-session-mcp-sdk-overflow-");
  const lines = Array.from({ length: 1_400 }, (_, index) => `${String(index).padStart(4, "0")} ${"x".repeat(60)}`).join("\n");
  await writeFile(join(cwd, "big-a.txt"), `${lines}\n`);
  await writeFile(join(cwd, "big-b.txt"), `${lines}\n`);
  return cwd;
}

const SCRIPTED_MODEL = Object.freeze({
  provider: "scripted", id: "scripted", name: "scripted",
  input: ["text"] as const, contextWindow: 200_000, maxTokens: 4_096,
});

function assistantMessage(content: unknown[], stopReason: string, extra: { errorMessage?: string } = {}): unknown {
  return {
    role: "assistant", content, api: "scripted", provider: "scripted", model: "scripted",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    stopReason, timestamp: Date.now(), ...extra,
  };
}

/** Emit the pinned public stream protocol's terminal event, not just a final result fallback. */
function streamOf(final: unknown): unknown {
  const message = final as { stopReason: "stop" | "toolUse" | "error" };
  let phase = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<unknown>> {
          if (phase++ === 0) return { value: { type: "start", partial: final }, done: false };
          if (phase === 2) {
            return { value: message.stopReason === "error"
              ? { type: "error", reason: "error", error: final }
              : { type: "done", reason: message.stopReason, message: final }, done: false };
          }
          return { value: undefined, done: true };
        },
      };
    },
    async result(): Promise<unknown> { return final; },
  };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => typeof block === "object" && block !== null
      && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
    .map((block) => block.text)
    .join("");
}

interface ScriptedStep { tool?: { name: string; arguments: Record<string, unknown> }; text?: string; error?: string }
interface ScriptedCall {
  /** True for the compaction summarization call: it is the only model call with an empty tool inventory. */
  readonly summarization: boolean;
  readonly offeredTools: readonly string[];
  readonly toolResults: readonly { toolName: string; isError: boolean; bytes: number; text: string }[];
}

/**
 * Scripted provider replaying one step per model call. Records the tool inventory, every
 * tool result the SDK handed back to the model, and their real serialized size, so a test
 * can prove context growth and model-visible tool failures without raw payload dumps.
 */
function scriptedRuntime(steps: readonly ScriptedStep[]): { runtime: ModelRuntime; calls: ScriptedCall[] } {
  const calls: ScriptedCall[] = [];
  let index = 0;
  const runtime = {
    getProvider: () => ({ id: "scripted" }),
    getModel: () => SCRIPTED_MODEL,
    checkAuth: async () => true,
    getAuth: async () => ({ token: "synthetic" }),
    getAvailable: async () => [SCRIPTED_MODEL],
    getAvailableSnapshot: () => [SCRIPTED_MODEL],
    hasConfiguredAuth: () => true,
    streamSimple: async (_model: unknown, context: {
      messages?: Array<DeclaringMessage & { role: string; toolName?: string; isError?: boolean; content?: unknown }>;
    }) => {
      const call = index++;
      const offeredTools = declaredTools(context.messages);
      const toolResults = (context.messages ?? [])
        .filter((message) => message.role === "toolResult")
        .map((message) => ({
          toolName: message.toolName ?? "",
          isError: message.isError === true,
          bytes: Buffer.byteLength(JSON.stringify(message.content ?? ""), "utf8"),
          text: textOf(message.content),
        }));
      calls.push({ summarization: offeredTools.length === 0, offeredTools, toolResults });
      const step = steps[call] ?? { text: "scripted default" };
      if (step.tool) {
        const invocation = { type: "toolCall", id: `call_${call + 1}`, name: step.tool.name, arguments: step.tool.arguments };
        return streamOf(assistantMessage([invocation], "toolUse"));
      }
      if (step.error !== undefined) return streamOf(assistantMessage([], "error", { errorMessage: step.error }));
      return streamOf(assistantMessage([{ type: "text", text: step.text ?? "done" }], "stop"));
    },
  } as unknown as ModelRuntime;
  return { runtime, calls };
}

interface JournalEntry {
  readonly type: string;
  readonly stopReason?: string;
  readonly errorMessage?: string;
  readonly toolName?: string;
  readonly isError?: boolean;
  readonly reason?: string;
  readonly willRetry?: boolean;
  readonly hasResult?: boolean;
  readonly success?: boolean;
}

/** Assistant message ends only: interim user message events carry no failure signal. */
function journalEntry(event: AgentSessionEvent): JournalEntry | undefined {
  switch (event.type) {
    case "message_end": {
      const message = event.message as { role?: string; stopReason?: unknown; errorMessage?: unknown };
      if (message.role !== "assistant") return undefined;
      return {
        type: event.type,
        stopReason: typeof message.stopReason === "string" ? message.stopReason : "unspecified",
        ...(typeof message.errorMessage === "string" ? { errorMessage: message.errorMessage } : {}),
      };
    }
    case "tool_execution_end":
      return { type: event.type, toolName: event.toolName, isError: event.isError };
    case "compaction_start":
      return { type: event.type, reason: event.reason };
    case "compaction_end":
      return {
        type: event.type, reason: event.reason, willRetry: event.willRetry, hasResult: event.result !== undefined,
        ...(event.errorMessage === undefined ? {} : { errorMessage: event.errorMessage }),
      };
    case "auto_retry_end":
      return { type: event.type, success: event.success };
    case "agent_end":
      return { type: event.type, willRetry: event.willRetry };
    default:
      return { type: event.type };
  }
}

function only(journal: readonly JournalEntry[], type: string): JournalEntry[] {
  return journal.filter((entry) => entry.type === type);
}

/**
 * The production adapter plus an observer on the real `AgentSession` it creates, so one
 * run yields both layers: the SDK event sequence and the controller/MCP projection.
 */
function observingAdapter(runtime: ModelRuntime, journal: JournalEntry[]): SdkPiSessionAdapter {
  const createSession = async (options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
    const result = await createAgentSession(options);
    const session: AgentSession = result.session;
    session.subscribe((event: AgentSessionEvent) => {
      const entry = journalEntry(event);
      if (entry) journal.push(entry);
    });
    return result;
  };
  return new SdkPiSessionAdapter({
    modelRuntimeFactory: async () => runtime,
    mcpConnectionFactory: createStdioMcpConnection,
    createSession,
  });
}

/** Bounded polling of the projected turn; the registry owns the terminal transition. */
async function terminalTurn(registry: SessionRegistry, sessionId: string, turnId: string): Promise<TurnView> {
  const deadline = Date.now() + 30_000;
  let turn = registry.getTurn(sessionId, turnId);
  while (turn.state === "running" && Date.now() < deadline) {
    await waitFor(2);
    turn = registry.getTurn(sessionId, turnId);
  }
  return turn;
}

async function projectedTurn(client: Client, sessionId: string, turnId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const response = await client.callTool({ name: "pi_turn_get", arguments: { sessionId, turnId } });
    const turn = (response.structuredContent as { turn: Record<string, unknown> }).turn;
    if (turn.state !== "running" || Date.now() >= deadline) return turn;
    await waitFor(2);
  }
}

describe("terminal model errors in a real embedded session", () => {
  it("keeps a real non-retryable error terminal: accepted preflight, resolved prompt, no retry, no compaction", async () => {
    const cwd = await temporaryDirectory("pi-session-mcp-sdk-terminal-");
    const { runtime, calls } = scriptedRuntime([{ error: TERMINAL_ERROR_MESSAGE }]);
    const journal: JournalEntry[] = [];
    const handle = await observingAdapter(runtime, journal).create({ cwd, executionProfile: profile({}) });
    try {
      const preflight: boolean[] = [];
      const outcome = await handle.prompt("trigger a terminal provider error", (accepted) => preflight.push(accepted));
      // Preflight acceptance proves this is a real turn failure, not a rejected prompt.
      assert.deepEqual(preflight, [true]);
      assert.deepEqual(outcome, { status: "failed" });
      assert.equal(calls.length, 1, "a non-retryable provider error must not be retried");
      const assistantEnds = only(journal, "message_end");
      assert.deepEqual(assistantEnds.map((entry) => entry.stopReason), ["error"]);
      // The SDK layer does carry the raw cause on the final assistant message; the projection must not copy it.
      assert.ok(assistantEnds[0]?.errorMessage?.includes(TERMINAL_ERROR_MARKER));
      assert.deepEqual(only(journal, "auto_retry_start"), []);
      assert.deepEqual(only(journal, "compaction_start"), []);
      assert.deepEqual(only(journal, "compaction_end"), []);
      const ends = only(journal, "agent_end");
      assert.equal(ends.length, 1);
      assert.equal(ends[0]?.willRetry, false);
    } finally {
      await handle.dispose();
    }
  }, 60_000);

  it("projects a real terminal model error at the MCP surface as the generic sanitized turn_failed contract", async () => {
    const cwd = await temporaryDirectory("pi-session-mcp-sdk-mcp-error-");
    const { runtime } = scriptedRuntime([{ error: TERMINAL_ERROR_MESSAGE }]);
    const journal: JournalEntry[] = [];
    const registry = new SessionRegistry(observingAdapter(runtime, journal), new Map([["repo", cwd]]));
    const profiles = new Map<string, ConfiguredExecutionProfile>([
      ["safe", { alias: "safe", default: true, permissionProfile: "read-only", provider: "scripted", model: "scripted", thinkingLevel: "off" }],
    ]);
    const server = createServer(registry, new Map([["repo", cwd]]), profiles, "safe", TEST_CONFIGURATION);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "sdk-failure-recovery-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    activeClosers.push(async () => { await client.close(); await server.close(); await registry.shutdown(); });

    const started = await client.callTool({ name: "pi_session_start", arguments: { workspace: "repo" } });
    const sessionId = (started.structuredContent as { session: { id: string } }).session.id;
    const prompted = await client.callTool({ name: "pi_session_prompt", arguments: { sessionId, prompt: "terminal provider error" } });
    assert.notEqual(prompted.isError, true, "preflight accepted the prompt, so it is not a prompt rejection");
    const turnId = (prompted.structuredContent as { turn: { turnId: string } }).turn.turnId;

    const turn = await projectedTurn(client, sessionId, turnId);
    assert.equal(turn.state, "failed");
    assert.deepEqual(turn.error, { code: "turn_failed", message: "Pi turn failed" });
    assert.deepEqual(Object.keys(turn).sort(), ["completedAt", "error", "sessionId", "startedAt", "state", "turnId", "updatedAt"]);
    assert.equal(JSON.stringify(turn).includes(TERMINAL_ERROR_MARKER), false, "the raw provider message must not be projected");

    const session = await client.callTool({ name: "pi_session_get", arguments: { sessionId } });
    const sessionView = (session.structuredContent as { session: { state: string; lastError?: string } }).session;
    assert.equal(sessionView.state, "failed");
    assert.equal(sessionView.lastError, "Pi turn failed");

    // Both layers observed the same single run: the SDK event carried the cause, the MCP response did not.
    assert.ok(only(journal, "message_end")[0]?.errorMessage?.includes(TERMINAL_ERROR_MARKER));
    assert.deepEqual(only(journal, "auto_retry_start"), []);
  }, 60_000);

  it("treats a retryable provider error as an interim step and completes the turn", async () => {
    const cwd = await temporaryDirectory("pi-session-mcp-sdk-retry-");
    const { runtime, calls } = scriptedRuntime([
      { error: RETRYABLE_ERROR_MESSAGE },
      { text: "recovered after retry" },
    ]);
    const journal: JournalEntry[] = [];
    const registry = new SessionRegistry(observingAdapter(runtime, journal), new Map([["repo", cwd]]));
    const session = await registry.start("repo", profile({}));
    try {
      const accepted = await registry.prompt(session.id, "transient provider error");
      const turn = await terminalTurn(registry, session.id, accepted.turn.turnId);
      assert.equal(turn.state, "completed", "an error-classified assistant message is not necessarily terminal");
      assert.equal(turn.assistantText, "recovered after retry");
      assert.equal(turn.error, undefined);
      assert.equal(calls.length, 2, "the real SDK retried once");
      assert.equal(only(journal, "auto_retry_start").length, 1);
      assert.deepEqual(only(journal, "auto_retry_end").map((entry) => entry.success), [true]);
      const errorEnd = journal.findIndex((entry) => entry.type === "message_end" && entry.stopReason === "error");
      const retryStart = journal.findIndex((entry) => entry.type === "auto_retry_start");
      const recoveredEnd = journal.findIndex((entry) => entry.type === "message_end" && entry.stopReason === "stop");
      const retryEnd = journal.findIndex((entry) => entry.type === "auto_retry_end");
      assert.ok(errorEnd >= 0 && errorEnd < retryStart && retryStart < recoveredEnd && recoveredEnd < retryEnd,
        "the initial assistant error precedes retry, whose success is reported after the second assistant message");
      assert.equal(JSON.stringify(turn).includes(RETRYABLE_ERROR_MARKER), false);
    } finally {
      await registry.close(session.id);
    }
  }, 60_000);

  it("does not report a context cause when an overflow error cannot be compacted", async () => {
    const cwd = await temporaryDirectory("pi-session-mcp-sdk-no-compaction-");
    const { runtime, calls } = scriptedRuntime([{ error: OVERFLOW_ERROR_MESSAGE }]);
    const journal: JournalEntry[] = [];
    const registry = new SessionRegistry(observingAdapter(runtime, journal), new Map([["repo", cwd]]));
    const session = await registry.start("repo", profile({}));
    try {
      const accepted = await registry.prompt(session.id, "overflow without compactable history");
      const turn = await terminalTurn(registry, session.id, accepted.turn.turnId);
      assert.equal(turn.state, "failed");
      assert.deepEqual(turn.error, { code: "turn_failed", message: "Pi turn failed" });
      assert.equal(calls.length, 1, "a context-overflow error is not retried; compaction handles it");
      assert.deepEqual(only(journal, "compaction_start"), [], "nothing was compactable, so no compaction happened");
      assert.deepEqual(only(journal, "compaction_end"), []);
      assert.deepEqual(only(journal, "auto_retry_start"), []);
      assert.equal(JSON.stringify(turn).includes(OVERFLOW_ERROR_MARKER), false);
    } finally {
      await registry.close(session.id);
    }
  }, 60_000);
});

describe("interim tool failures inside the real stdio MCP bridge", () => {
  it("returns a real schema rejection to the model without reaching the stdio server, then completes", async () => {
    const { log, logPath, servers } = await scratchFixture({ inspect: { name: "artifact_inspect", readOnly: true } });
    const { runtime, calls } = scriptedRuntime([
      { tool: { name: "mcp_knowledge_inspect", arguments: { artifact: "not-an-object" } } },
      { text: "recovered after rejection" },
    ]);
    const journal: JournalEntry[] = [];
    const registry = new SessionRegistry(observingAdapter(runtime, journal), new Map([["repo", log]]));
    const session = await registry.start("repo", profile(servers));
    try {
      const accepted = await registry.prompt(session.id, "send schema-invalid arguments");
      const turn = await terminalTurn(registry, session.id, accepted.turn.turnId);
      assert.equal(turn.state, "completed");
      assert.equal(turn.assistantText, "recovered after rejection");
      assert.equal(JSON.stringify(turn).includes("not-an-object"), false);
      // Independent observation across the real process boundary: the invalid call never left Pi.
      assert.deepEqual(await toolCalls(logPath), []);

      const rejected = calls[1]?.toolResults ?? [];
      assert.equal(rejected.length, 1);
      assert.equal(rejected[0]?.toolName, "mcp_knowledge_inspect");
      assert.equal(rejected[0]?.isError, true);
      assert.deepEqual(only(journal, "tool_execution_end").map((entry) => entry.isError), [true]);
      assert.ok(calls[1]?.offeredTools.includes("mcp_knowledge_inspect"), "the rejected tool stays available");
    } finally {
      await registry.close(session.id);
    }
  }, 60_000);

  it("reports a real server JSON-RPC error to the model as a sanitized failed result, then completes", async () => {
    const { log, logPath, servers } = await scratchFixture({ broken: { name: "error_note", readOnly: true } });
    const { runtime, calls } = scriptedRuntime([
      { tool: { name: "mcp_knowledge_broken", arguments: { note: "x" } } },
      { text: "recovered after server error" },
    ]);
    const journal: JournalEntry[] = [];
    const registry = new SessionRegistry(observingAdapter(runtime, journal), new Map([["repo", log]]));
    const session = await registry.start("repo", profile(servers));
    try {
      const accepted = await registry.prompt(session.id, "call a failing server tool");
      const turn = await terminalTurn(registry, session.id, accepted.turn.turnId);
      assert.equal(turn.state, "completed");
      assert.equal(turn.assistantText, "recovered after server error");
      assert.equal(JSON.stringify(turn).includes("SYNTHETIC_SERVER_ERROR_MARKER"), false);
      // This call really crossed the process boundary before the server failed it.
      assert.deepEqual((await toolCalls(logPath)).map((call) => call.name), ["error_note"]);

      const failed = calls[1]?.toolResults ?? [];
      assert.equal(failed.length, 1);
      assert.equal(failed[0]?.isError, true);
      assert.ok(failed[0]?.text.includes("External MCP operation failed"));
      assert.equal(failed[0]?.text.includes("SYNTHETIC_SERVER_ERROR_MARKER"), false, "the raw server error must not reach the model");
      assert.deepEqual(only(journal, "tool_execution_end").map((entry) => entry.isError), [true]);
    } finally {
      await registry.close(session.id);
    }
  }, 60_000);
});

describe("controlled context overflow through the public session API", () => {
  it("recovers a real overflow signal through compaction and one retry without projecting the cause", async () => {
    const cwd = await largeWorkspace();
    const { runtime, calls } = scriptedRuntime([
      { tool: { name: "read", arguments: { path: "big-a.txt" } } },
      { tool: { name: "read", arguments: { path: "big-b.txt" } } },
      { text: "first turn complete" },
      { error: OVERFLOW_ERROR_MESSAGE },
      { text: `${SUMMARY_MARKER} structured checkpoint` },
      { text: "recovered after compaction" },
    ]);
    const journal: JournalEntry[] = [];
    const registry = new SessionRegistry(observingAdapter(runtime, journal), new Map([["repo", cwd]]));
    const session = await registry.start("repo", profile({}));
    try {
      const first = await registry.prompt(session.id, "grow the context with two large reads");
      const firstTurn = await terminalTurn(registry, session.id, first.turn.turnId);
      assert.equal(firstTurn.state, "completed");
      const observedReads = calls[2]?.toolResults ?? [];
      assert.equal(observedReads.length, 2, "both real read results stayed model-visible");
      assert.ok(
        observedReads.every((result) => result.toolName === "read" && !result.isError && result.bytes >= LARGE_READ_CHARS),
        "the reads really grew the provider context",
      );

      const second = await registry.prompt(session.id, "overflow the context");
      const turn = await terminalTurn(registry, session.id, second.turn.turnId);
      assert.equal(turn.state, "completed", "a recoverable overflow is not a failed turn");
      assert.equal(turn.assistantText, "recovered after compaction");
      assert.equal(turn.error, undefined);
      assert.deepEqual(Object.keys(turn).sort(),
        ["assistantText", "completedAt", "sessionId", "startedAt", "state", "truncated", "turnId", "updatedAt"]);

      const starts = only(journal, "compaction_start");
      const ends = only(journal, "compaction_end");
      assert.deepEqual(starts.map((entry) => entry.reason), ["overflow"]);
      assert.equal(ends.length, 1);
      assert.deepEqual(ends[0], { type: "compaction_end", reason: "overflow", willRetry: true, hasResult: true });
      assert.ok(journal.findIndex((entry) => entry.type === "compaction_start") < journal.findIndex((entry) => entry.type === "compaction_end"));
      assert.equal(calls.filter((call) => call.summarization).length, 1, "exactly one summarization call");

      assert.equal(JSON.stringify(turn).includes(OVERFLOW_ERROR_MARKER), false);
      assert.equal(JSON.stringify(turn).includes(SUMMARY_MARKER), false, "the compaction summary is not projected");
      assert.equal(registry.get(session.id).state, "idle");
    } finally {
      await registry.close(session.id);
    }
  }, 90_000);

  it("keeps a failed overflow recovery terminal and indistinguishable from any other failure at the MCP layer", async () => {
    const cwd = await largeWorkspace();
    const { runtime, calls } = scriptedRuntime([
      { tool: { name: "read", arguments: { path: "big-a.txt" } } },
      { tool: { name: "read", arguments: { path: "big-b.txt" } } },
      { text: "first turn complete" },
      { error: OVERFLOW_ERROR_MESSAGE },
      { error: SUMMARIZER_FAILURE_MESSAGE },
    ]);
    const journal: JournalEntry[] = [];
    const registry = new SessionRegistry(observingAdapter(runtime, journal), new Map([["repo", cwd]]));
    const session = await registry.start("repo", profile({}));
    try {
      const first = await registry.prompt(session.id, "grow the context with two large reads");
      assert.equal((await terminalTurn(registry, session.id, first.turn.turnId)).state, "completed");

      const second = await registry.prompt(session.id, "overflow with a failing recovery");
      const turn = await terminalTurn(registry, session.id, second.turn.turnId);
      assert.equal(turn.state, "failed");
      // Identical to the terminal provider error contract: no cause, no context, no summary.
      assert.deepEqual(turn.error, { code: "turn_failed", message: "Pi turn failed" });
      assert.deepEqual(Object.keys(turn).sort(), ["completedAt", "error", "sessionId", "startedAt", "state", "turnId", "updatedAt"]);
      assert.equal(JSON.stringify(turn).includes(OVERFLOW_ERROR_MARKER), false);
      assert.equal(JSON.stringify(turn).includes(SUMMARIZER_FAILURE_MARKER), false);
      assert.equal(JSON.stringify(turn).includes("summar"), false);
      assert.equal(JSON.stringify(turn).includes("overflow"), false);
      assert.equal(registry.get(session.id).lastError, "Pi turn failed");

      // Only the SDK layer carries the cause, and only in a transient event.
      const ends = only(journal, "compaction_end");
      assert.equal(ends.length, 1);
      assert.equal(ends[0]?.reason, "overflow");
      assert.equal(ends[0]?.willRetry, false);
      assert.equal(ends[0]?.hasResult, false);
      assert.ok(ends[0]?.errorMessage?.includes(SUMMARIZER_FAILURE_MARKER));
      const overflowError = journal.findLastIndex((entry) => entry.type === "message_end" && entry.stopReason === "error");
      const overflowTurnEnd = journal.findLastIndex((entry) => entry.type === "turn_end");
      const compactionStart = journal.findIndex((entry) => entry.type === "compaction_start");
      const compactionEnd = journal.findIndex((entry) => entry.type === "compaction_end");
      assert.ok(overflowError >= 0 && overflowError < overflowTurnEnd
        && overflowTurnEnd < compactionStart && compactionStart < compactionEnd,
        "the overflow step ended before post-run compaction; failed compaction emitted no later turn_end");
      assert.equal(calls.filter((call) => call.summarization).length, 1, "the summarizer failed on its single attempt");
      assert.equal(calls.length, 5, "a failed recovery must not continue the turn");
    } finally {
      await registry.close(session.id);
    }
  }, 90_000);
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { AgentSession, CreateAgentSessionOptions, CreateAgentSessionResult, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createServer } from "../../src/server.js";
import { SdkPiSessionAdapter } from "../../src/sdk-pi-adapter.js";
import { SessionRegistry } from "../../src/session-registry.js";
import type { ConfiguredExecutionProfile } from "../../src/execution-profile.js";
import type { ConfigurationMetadata } from "../../src/config.js";

export type FilterCase = "private_blocks" | "mixed_final" | "intermediate" | "streaming" | "late_and_sessions" | "unknown_block" | "provider_failure" | "ordinary_echo" | "unicode_boundary" | "sdk_length";
export interface FilterMeasurement {
  readonly case: FilterCase;
  readonly repetition: number;
  readonly outputUtf8Bytes: number;
  readonly thinkingMarker: boolean;
  readonly toolMarker: boolean;
  readonly unknownMarker: boolean;
  readonly echoMarker: boolean;
  readonly streamMarker: boolean;
  readonly toolResultMarker: boolean;
  readonly cleanupPassed: boolean;
  readonly truncated: boolean;
  readonly state: "completed" | "failed";
  readonly independentlyPassed: boolean;
  readonly providerErrorMarker: boolean;
  readonly failure: "none" | "case-error";
}

const profile: ConfiguredExecutionProfile = { alias: "calibration", default: true, permissionProfile: "read-only", provider: "scripted", model: "scripted", thinkingLevel: "off" };
const THINK = "CAL_THINK_7f31";
const TOOL = "CAL_TOOL_9a24";
const TOOL_RESULT = "CAL_TOOL_RESULT_4b10";
const UNKNOWN = "CAL_UNKNOWN_51bc";
const ECHO = "CAL_ECHO_3de2";
const failure = "CAL_PROVIDER_FAILURE_PRIVATE";
const config: ConfigurationMetadata = { fingerprint: `sha256:${"0".repeat(64)}`, reloadPolicy: "restart-required" };
type ContentBlock = { type: "text"; text: string } | { type: "thinking"; thinking: string } | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> } | { type: string; [key: string]: unknown };
interface Script { readonly content: ContentBlock[]; readonly reason: "stop" | "length" | "error"; readonly fail?: boolean; readonly stream?: boolean; }

function assistant(content: ContentBlock[], stopReason: Script["reason"]): Record<string, unknown> {
  return { role: "assistant", content, stopReason, api: "scripted", provider: "scripted", model: "scripted", timestamp: Date.now(), usage: { input: 1, output: 1, total: 2 } };
}
function runtimeFor(script: Script): ModelRuntime {
  const model = { provider: "scripted", id: "scripted", input: ["text"] };
  return {
    getProvider: () => ({ id: "scripted" }), getModel: () => model,
    hasConfiguredAuth: () => true, checkAuth: async () => true,
    getAuth: async () => ({ token: "synthetic" }), isUsingOAuth: () => false,
    getAvailable: async () => [model], getAvailableSnapshot: () => [model],
    streamSimple: async () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "start", partial: assistant([], "stop") };
        if (script.stream) yield { type: "text_delta", contentIndex: 0, delta: "CAL_STREAM_ONLY" };
        if (script.fail) throw new Error(failure);
        yield { type: "done", reason: script.reason, message: assistant(script.content, script.reason) };
      },
      async result() { return assistant(script.content, script.reason); },
    }),
  } as unknown as ModelRuntime;
}
const scripts: Record<FilterCase, Script> = {
  private_blocks: { reason: "stop", content: [{ type: "thinking", thinking: THINK }, { type: "toolCall", id: "x", name: "read", arguments: { path: TOOL } }, { type: "text", text: "safe final" }] },
  mixed_final: { reason: "stop", content: [{ type: "text", text: "first" }, { type: "thinking", thinking: THINK }, { type: "text", text: "second" }] },
  intermediate: { reason: "stop", content: [{ type: "text", text: "settled final" }] },
  streaming: { reason: "stop", stream: true, content: [{ type: "text", text: "settled final" }] },
  late_and_sessions: { reason: "stop", content: [{ type: "text", text: "session answer" }] },
  unknown_block: { reason: "stop", content: [{ type: "unknown_custom", payload: UNKNOWN }, { type: "text", text: "known" }] },
  provider_failure: { reason: "error", fail: true, content: [] },
  ordinary_echo: { reason: "stop", content: [{ type: "text", text: `${ECHO} ${TOOL} <think>${THINK}</think>` }] },
  unicode_boundary: { reason: "stop", content: [{ type: "text", text: "😀".repeat(16_385) }] },
  sdk_length: { reason: "length", content: [{ type: "text", text: "length stopped answer" }] },
};

/**
 * Runs deterministic measurements through the real adapter, registry, server and MCP Client.
 * The adapter's public `createSession` seam returns a scripted AgentSession stub: this calibrates
 * the projection path and event filters, not Pi's real agent loop. Returned fields are allowlisted.
 */
export async function calibrateFilters(repetitions = 5): Promise<FilterMeasurement[]> {
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20) throw new RangeError("repetitions must be between 1 and 20");
  const rows: FilterMeasurement[] = [];
  const cases = Object.keys(scripts) as FilterCase[];
  for (const caseName of cases) for (let repetition = 1; repetition <= repetitions; repetition++) {
    const script = scripts[caseName];
    const cwd = await mkdtemp(join(tmpdir(), "pi-filter-calibration-"));
    const workspaces = new Map([["repo", cwd]]);
    const runtime = runtimeFor(script);
    const allListeners = new Set<(event: { type: string; message?: unknown; result?: unknown }) => void>();
    const savedListeners: Array<(event: { type: string; message?: unknown; result?: unknown }) => void> = [];
    let sessionOrdinal = 0;
    let activeSubscriptions = 0;
    const disposalCounts: number[] = [];
    const createSession = async (_options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
      const thisSession = ++sessionOrdinal;
      disposalCounts.push(0);
      if (caseName === "late_and_sessions") savedListeners.push(...allListeners);
      const listeners = new Set<(event: { type: string; message?: unknown; result?: unknown }) => void>();
      const session = {
        sessionId: "scripted-sdk-session", model: { provider: "scripted", id: "scripted" }, thinkingLevel: "off",
        resourceLoader: { getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }) },
        subscribe(listener: (event: { type: string; message?: unknown; result?: unknown }) => void) { listeners.add(listener); allListeners.add(listener); activeSubscriptions++; return () => { if (listeners.delete(listener)) activeSubscriptions--; }; },
        async prompt(_prompt: string, options: { preflightResult?: (value: "started") => void }) {
          options.preflightResult?.("started");
          if (caseName === "late_and_sessions" && savedListeners.length > 0) {
            for (const stale of savedListeners) stale({ type: "message_end", message: assistant([{ type: "text", text: "stale wrong session" }], "stop") });
          }
          if (script.stream) for (const listener of listeners) listener({ type: "message_update", message: assistant([{ type: "text", text: "CAL_STREAM_ONLY" }], "stop") });
          if (caseName === "intermediate") for (const listener of listeners) listener({ type: "message_end", message: assistant([{ type: "text", text: THINK }], "stop") });
          if (caseName === "private_blocks") for (const listener of listeners) listener({ type: "tool_execution_end", result: { content: TOOL_RESULT } });
          if (script.fail) throw new Error(failure);
          const content = caseName === "late_and_sessions"
            ? [{ type: "text", text: thisSession === 1 ? "first session answer" : "second session answer" } as ContentBlock]
            : script.content;
          const final = assistant(content, script.reason);
          for (const listener of listeners) listener({ type: "message_end", message: final });
        },
        async abort() {}, async dispose() { disposalCounts[thisSession - 1]!++; },
      } as unknown as AgentSession;
      return { session } as unknown as CreateAgentSessionResult;
    };
    const adapter = new SdkPiSessionAdapter({ modelRuntimeFactory: async () => runtime, createSession });
    const registry = new SessionRegistry(adapter, workspaces);
    const server = createServer(registry, workspaces, new Map([["calibration", profile]]), "calibration", config);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "token-filter-calibration", version: "1.0.0" }, { capabilities: {} });
    const sessionIds: string[] = [];
    let markers = { thinkingMarker: false, toolMarker: false, unknownMarker: false, echoMarker: false, streamMarker: false, toolResultMarker: false, providerErrorMarker: false };
    const invoke = client.callTool.bind(client);
    client.callTool = async (...args: Parameters<typeof client.callTool>) => {
      const result = await invoke(...args), publicOutput = JSON.stringify(result);
      const sentinels = { thinkingMarker: THINK, toolMarker: TOOL, unknownMarker: UNKNOWN, echoMarker: ECHO, streamMarker: "CAL_STREAM_ONLY", toolResultMarker: TOOL_RESULT, providerErrorMarker: failure };
      for (const key of Object.keys(sentinels) as Array<keyof typeof sentinels>) markers[key] ||= publicOutput.includes(sentinels[key]);
      return result;
    };
    let output = ""; let state: FilterMeasurement["state"] = "failed"; let truncated = false; let independentlyPassed = false; let cleanupPassed = false;
    let failureCode: FilterMeasurement["failure"] = "none";
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const started = await client.callTool({ name: "pi_session_start", arguments: { workspace: "repo" } });
      let sid = (started.structuredContent as { session: { id: string } }).session.id;
      sessionIds.push(sid);
      let firstTurnText = "";
      let firstSid = "";
      let firstTurnId = "";
      if (caseName === "late_and_sessions") {
        firstSid = sid;
        const firstAccepted = await client.callTool({ name: "pi_session_prompt", arguments: { sessionId: sid, prompt: "first synthetic session" } });
        firstTurnId = (firstAccepted.structuredContent as { turn: { turnId: string } }).turn.turnId;
        const firstResult = await client.callTool({ name: "pi_turn_get", arguments: { sessionId: sid, turnId: firstTurnId } });
        firstTurnText = String((firstResult.structuredContent as { turn: { assistantText?: string } }).turn.assistantText);
        const secondStarted = await client.callTool({ name: "pi_session_start", arguments: { workspace: "repo" } });
        sid = (secondStarted.structuredContent as { session: { id: string } }).session.id;
        sessionIds.push(sid);
      }
      const accepted = await client.callTool({ name: "pi_session_prompt", arguments: { sessionId: sid, prompt: "synthetic calibration" } });
      const tid = (accepted.structuredContent as { turn: { turnId: string } }).turn.turnId;
      let turn: Record<string, unknown> | undefined;
      for (let i = 0; i < 2_000; i++) {
        const got = await client.callTool({ name: "pi_turn_get", arguments: { sessionId: sid, turnId: tid } });
        turn = (got.structuredContent as { turn: Record<string, unknown> }).turn;
        if (turn.state !== "running") break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      state = turn?.state === "completed" ? "completed" : "failed";
      output = typeof turn?.assistantText === "string" ? turn.assistantText : JSON.stringify(turn ?? {});
      truncated = turn?.truncated === true;
      const expectedState = caseName === "provider_failure" ? "failed" : "completed";
      const text = typeof turn?.assistantText === "string" ? turn.assistantText : "";
      let firstTurnAfterLateEvent = firstTurnText;
      if (caseName === "late_and_sessions") {
        const firstAfter = await client.callTool({ name: "pi_turn_get", arguments: { sessionId: firstSid, turnId: firstTurnId } });
        firstTurnAfterLateEvent = String((firstAfter.structuredContent as { turn: { assistantText?: string } }).turn.assistantText);
      }
      independentlyPassed = turn?.state === expectedState
        && (caseName === "private_blocks" ? text === "safe final" : true)
        && (caseName === "streaming" ? text === "settled final" : true)
        && (caseName === "intermediate" ? text === "settled final" : true)
        && (caseName === "mixed_final" ? text === "firstsecond" : true)
        && (caseName === "unknown_block" ? text === "known" : true)
        && (caseName === "ordinary_echo" ? text.includes(ECHO) && text.includes("<think>") : true)
        && (caseName === "unicode_boundary" ? Buffer.byteLength(text, "utf8") === 65_536 && truncated : true)
        && (caseName === "sdk_length" ? text === "length stopped answer" : true)
        && (caseName === "late_and_sessions" ? text === "second session answer" && firstTurnText === "first session answer" && firstTurnAfterLateEvent === firstTurnText : true)
        && !JSON.stringify(turn).includes(failure);
      if (caseName !== "ordinary_echo") independentlyPassed &&= !markers.thinkingMarker && !markers.toolMarker && !markers.toolResultMarker && !markers.unknownMarker && !markers.streamMarker;
    } catch { failureCode = "case-error"; independentlyPassed = false;
    } finally {
      let sessionsClosed = true;
      for (const id of sessionIds) {
        try {
          const r = await client.callTool({ name: "pi_session_close", arguments: { sessionId: id } }, { timeout: 2000 });
          sessionsClosed &&= (r.structuredContent as { ok?: boolean } | undefined)?.ok === true;
        } catch { sessionsClosed = false; }
      }
      const closed = await Promise.allSettled([client.close(), server.close(), registry.shutdown()]);
      cleanupPassed = sessionsClosed && registry.list().length === 0 && disposalCounts.every(n => n === 1) && activeSubscriptions === 0 && closed.every(({ status }) => status === "fulfilled");
      await rm(cwd, { recursive: true, force: true });
    }
    const finalMarkersPassed = !markers.providerErrorMarker && (caseName === "ordinary_echo" || (!markers.thinkingMarker && !markers.toolMarker && !markers.toolResultMarker && !markers.unknownMarker && !markers.streamMarker));
    rows.push({ case: caseName, repetition, outputUtf8Bytes: Buffer.byteLength(output, "utf8"), ...markers, cleanupPassed, truncated, state, failure: failureCode, independentlyPassed: independentlyPassed && cleanupPassed && finalMarkersPassed });
  }
  return rows;
}

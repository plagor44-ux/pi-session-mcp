/**
 * Running-turn activity against the real Pi SDK (issue #47).
 *
 * `updatedAt` must reflect the public SDK stream of a turn (assistant message start, update and
 * end; tool execution start, update and end), not only completed messages and tools. The Pi SDK
 * runs for real (`createAgentSession`, the agent loop, tools) with only the model runtime
 * scripted, so the file is provider-free. Every pause is a promise the test resolves: no sleeps
 * decide a positive outcome. Only `Date` is faked, so stamps can differ without waiting while
 * every timer and the SDK's own scheduling stay real.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { createAgentSession, type AgentSession, type AgentSessionEvent, type CreateAgentSessionOptions, type CreateAgentSessionResult, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ResolvedExecutionProfile } from "../src/execution-profile.js";
import { SdkPiSessionAdapter, type SdkPiAdapterDiagnostic } from "../src/sdk-pi-adapter.js";
import { SessionRegistry, type SessionView, type TurnView } from "../src/session-registry.js";

const temporaries: string[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  while (temporaries.length > 0) await rm(temporaries.pop()!, { recursive: true, force: true });
});

const at = (seconds: number): Date => new Date(Date.UTC(2026, 9, 12, 0, 0, seconds));
const iso = (seconds: number): string => at(seconds).toISOString();

const THINKING_SENTINEL = "SENTINEL_THINKING_DELTA_7f3a";
const ARGUMENT_SENTINEL = "SENTINEL_TOOLCALL_ARGUMENT_91c2";
const TEXT_DELTA = "STREAMED_TEXT_DELTA";

interface Deferred<T = void> { promise: Promise<T>; resolve: (value: T) => void; }
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

type Block = { type: "text"; text: string } | { type: "thinking"; thinking: string } | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
type StopReason = "stop" | "toolUse" | "error" | "aborted";

function assistantMessage(content: Block[], stopReason: StopReason): Record<string, unknown> {
  return {
    role: "assistant", content, api: "scripted", provider: "scripted", model: "scripted",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 1 }, stopReason, timestamp: at(0).getTime(),
  };
}
const textMessage = (text: string, stopReason: StopReason = "stop"): Record<string, unknown> => assistantMessage([{ type: "text", text }], stopReason);
const doneEvent = (message: Record<string, unknown>): unknown => ({ type: "done", reason: message.stopReason, message });

/** A model stream the test drives one event at a time; `send` resolves once Pi has handled the event. */
class ControlledStream {
  final: Record<string, unknown> = textMessage("done");
  private pending: ((result: IteratorResult<unknown>) => void) | undefined;
  private pullWaiters: Array<() => void> = [];
  private ended = false;

  constructor(signal?: AbortSignal) {
    // A provider stream ends when its request is aborted; Pi's abort waits for the loop to end.
    signal?.addEventListener("abort", () => {
      this.final = textMessage("", "aborted");
      this.push({ type: "error", reason: "aborted", error: this.final });
    }, { once: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: (): Promise<IteratorResult<unknown>> => new Promise((resolve) => {
        if (this.ended) { resolve({ value: undefined, done: true }); return; }
        this.pending = resolve;
        const waiters = this.pullWaiters;
        this.pullWaiters = [];
        for (const waiter of waiters) waiter();
      }),
    };
  }
  async result(): Promise<unknown> { return this.final; }

  private push(event: unknown): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.({ value: event, done: false });
  }
  private untilPulled(): Promise<void> {
    return this.pending ? Promise.resolve() : new Promise<void>((resolve) => { this.pullWaiters.push(resolve); });
  }
  /** Emits one event and returns after Pi pulled the next one, so its listeners have run. */
  async send(event: unknown): Promise<void> {
    await this.untilPulled();
    const next = new Promise<void>((resolve) => { this.pullWaiters.push(resolve); });
    this.push(event);
    await next;
  }
  /** Ends the response; Pi does not pull again after a terminal event. */
  async finish(message: Record<string, unknown>): Promise<void> {
    this.final = message;
    await this.untilPulled();
    this.ended = true;
    this.push(doneEvent(message));
  }
}

/** Streams a fixed event list, then ends with `final`. */
function playback(events: unknown[], final: Record<string, unknown>): unknown {
  let index = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<unknown>> {
          if (index < events.length) return { value: events[index++], done: false };
          if (index === events.length) { index++; return { value: doneEvent(final), done: false }; }
          return { value: undefined, done: true };
        },
      };
    },
    async result(): Promise<unknown> { return final; },
  };
}

const startEvent = (partial: unknown = assistantMessage([], "stop")): unknown => ({ type: "start", partial });
const textDelta = (delta: string): unknown => ({ type: "text_delta", contentIndex: 0, delta, partial: assistantMessage([{ type: "text", text: delta }], "stop") });
const thinkingDelta = (delta: string): unknown => ({ type: "thinking_delta", contentIndex: 0, delta, partial: assistantMessage([{ type: "thinking", thinking: delta }], "stop") });
const toolcallDelta = (delta: string): unknown => ({
  type: "toolcall_delta", contentIndex: 0, delta,
  partial: assistantMessage([{ type: "toolCall", id: "call_stream", name: "read", arguments: { path: delta } }], "toolUse"),
});

/** One scripted model request: what the stream does once Pi asks for a response. */
interface Plan {
  /** Resolves when Pi reached the model for this request. */
  readonly entered: Deferred;
  /** The model blocks here before returning any stream; resolve it to continue. */
  readonly gate?: Deferred;
  readonly stream: (signal: AbortSignal | undefined) => unknown;
}
function plan(stream: Plan["stream"], gate?: Deferred): Plan {
  return gate ? { entered: deferred(), gate, stream } : { entered: deferred(), stream };
}
function controlled(): { plan: Plan; stream: () => ControlledStream } {
  let created: ControlledStream | undefined;
  const result = plan((signal) => (created = new ControlledStream(signal)));
  return { plan: result, stream: () => created ?? assert.fail("the model stream was not created yet") };
}

function scriptedRuntime(plans: Plan[]): ModelRuntime {
  const model = { provider: "scripted", id: "scripted", input: ["text"] };
  let call = 0;
  return {
    getProvider: () => ({ id: "scripted" }),
    getModel: () => model,
    hasConfiguredAuth: () => true,
    checkAuth: async () => true,
    getAuth: async () => ({ token: "synthetic" }),
    isUsingOAuth: () => false,
    getAvailable: async () => [model],
    getAvailableSnapshot: () => [model],
    streamSimple: async (_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) => {
      const current = plans[call++] ?? assert.fail("the model was requested more often than scripted");
      // A gated plan is "entered" before it blocks; any other plan once its stream exists.
      if (current.gate) { current.entered.resolve(); await current.gate.promise; }
      const stream = current.stream(options?.signal);
      current.entered.resolve();
      return stream;
    },
  } as unknown as ModelRuntime;
}

type Listener = (event: AgentSessionEvent) => void;
interface Harness {
  readonly registry: SessionRegistry;
  readonly cwd: string;
  /** Every listener the adapter registered, in order; late-event tests replay events through them. */
  readonly listeners: Listener[];
  /** Listeners that are subscribed right now. */
  readonly active: Set<Listener>;
  readonly diagnostics: SdkPiAdapterDiagnostic[];
  readonly adapter: SdkPiSessionAdapter;
  /** Optional wrapper around every event delivery to the adapter's listeners. */
  readonly tap: { current?: (event: AgentSessionEvent, deliver: () => void) => void };
}

const profile: ResolvedExecutionProfile = { alias: "activity", permissionProfile: "read-only", provider: "scripted", model: "scripted", thinkingLevel: "off" };

/** Wraps the real `createAgentSession` so the test sees the adapter's subscriptions. */
async function harness(plans: Plan[]): Promise<Harness> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-session-mcp-sdk-activity-"));
  temporaries.push(cwd);
  const listeners: Listener[] = [];
  const active = new Set<Listener>();
  const diagnostics: SdkPiAdapterDiagnostic[] = [];
  const tap: Harness["tap"] = {};
  const createSession = async (options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
    const result = await createAgentSession(options);
    const session: AgentSession = result.session;
    const subscribe = session.subscribe.bind(session);
    session.subscribe = (listener: Listener) => {
      listeners.push(listener);
      active.add(listener);
      const unsubscribe = subscribe((event) => (tap.current ? tap.current(event, () => listener(event)) : listener(event)));
      return () => { active.delete(listener); unsubscribe(); };
    };
    return result;
  };
  const runtime = scriptedRuntime(plans);
  const adapter = new SdkPiSessionAdapter({ modelRuntimeFactory: async () => runtime, createSession, diagnosticSink: (diagnostic) => diagnostics.push(diagnostic) });
  return { registry: new SessionRegistry(adapter, new Map([["repo", cwd]])), cwd, listeners, active, diagnostics, adapter, tap };
}

/** Bounded wait on a condition that must become true; the iteration cap fails a stuck test. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 4_000; attempt++) {
    if (condition()) return;
    await yieldToEventLoop();
  }
  assert.fail(`timed out waiting for ${what}`);
}
async function terminal(registry: SessionRegistry, sessionId: string, turnId: string): Promise<TurnView> {
  await until(() => registry.getTurn(sessionId, turnId).state !== "running", "the turn to reach a terminal state");
  return registry.getTurn(sessionId, turnId);
}
/** Lets already-queued SDK work run so that a missing stamp is not just a slow one. */
async function quiesce(): Promise<void> { for (let turn = 0; turn < 25; turn++) await yieldToEventLoop(); }

const lateEvents: AgentSessionEvent[] = [
  { type: "message_start", message: { role: "assistant", content: [] } },
  { type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "late", partial: {} } },
  { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "LATE_ANSWER" }], stopReason: "stop" } },
  { type: "tool_execution_start", toolCallId: "late_call", toolName: "read", args: { path: "late" } },
  { type: "tool_execution_update", toolCallId: "late_call", toolName: "read", args: {}, partialResult: "late" },
  { type: "tool_execution_end", toolCallId: "late_call", toolName: "read", result: {}, isError: false },
] as unknown as AgentSessionEvent[];

describe("running-turn activity from the public SDK stream", () => {
  it("raises updatedAt on streamed deltas while the turn is still running", async () => {
    const model = controlled();
    const { registry, active } = await harness([model.plan]);
    vi.setSystemTime(at(0));
    const session = await registry.start("repo", profile);
    const accepted = await registry.prompt(session.id, "stream slowly");
    assert.equal(accepted.turn.startedAt, iso(0));
    await model.plan.entered.promise;
    try {
      // Pi reached the model but nothing was streamed yet: still the start stamp.
      assert.equal(registry.getTurn(session.id, accepted.turn.turnId).updatedAt, iso(0));

      vi.setSystemTime(at(1));
      await model.stream().send(startEvent());
      let running = registry.getTurn(session.id, accepted.turn.turnId);
      assert.equal(running.state, "running");
      assert.equal(running.updatedAt, iso(1), "the assistant message start is activity");

      vi.setSystemTime(at(2));
      await model.stream().send(textDelta(TEXT_DELTA));
      vi.setSystemTime(at(3));
      await model.stream().send(thinkingDelta("thinking"));
      running = registry.getTurn(session.id, accepted.turn.turnId);
      assert.equal(running.state, "running", "the turn is still running while it streams");
      assert.ok(Date.parse(running.updatedAt) > Date.parse(running.startedAt), "streaming moved updatedAt past startedAt");
      assert.equal(running.updatedAt, iso(3));
      assert.equal(running.assistantText, undefined, "a streaming delta is not an answer");
      assert.equal(registry.get(session.id).updatedAt, accepted.session.updatedAt, "the session stamp moves only at the terminal transition");

      vi.setSystemTime(at(4));
      await model.stream().finish(textMessage("final answer"));
      const done = await terminal(registry, session.id, accepted.turn.turnId);
      assert.equal(done.state, "completed");
      assert.equal(done.assistantText, "final answer");
      assert.equal(done.updatedAt, done.completedAt);
      assert.ok(Date.parse(done.updatedAt) >= Date.parse(iso(4)));
    } finally {
      await registry.close(session.id);
    }
    assert.equal(active.size, 0);
  }, 30_000);

  it("does not stamp internal work that produced no public event", async () => {
    const gate = deferred();
    const silent = plan(() => playback([startEvent(), textDelta("x")], textMessage("late answer")), gate);
    const { registry } = await harness([silent]);
    vi.setSystemTime(at(0));
    const session = await registry.start("repo", profile);
    const accepted = await registry.prompt(session.id, "think silently");
    await silent.entered.promise;
    try {
      vi.setSystemTime(at(7));
      await quiesce();
      const blocked = registry.getTurn(session.id, accepted.turn.turnId);
      assert.equal(blocked.state, "running");
      assert.equal(blocked.updatedAt, blocked.startedAt, "the prompt's own user message and Pi's internal steps are not activity");
      assert.equal(registry.get(session.id).updatedAt, accepted.session.updatedAt);

      vi.setSystemTime(at(8));
      gate.resolve();
      const done = await terminal(registry, session.id, accepted.turn.turnId);
      assert.equal(done.state, "completed");
      assert.equal(done.assistantText, "late answer");
    } finally {
      gate.resolve();
      await registry.close(session.id);
    }
  }, 30_000);

  it("keeps activity of one session out of another session's turn and view", async () => {
    const first = controlled();
    const second = controlled();
    const { registry } = await harness([first.plan, second.plan]);
    vi.setSystemTime(at(0));
    const a = await registry.start("repo", profile);
    const b = await registry.start("repo", profile);
    const turnA = await registry.prompt(a.id, "session a");
    await first.plan.entered.promise;
    const turnB = await registry.prompt(b.id, "session b");
    await second.plan.entered.promise;
    try {
      const before = { turnB: registry.getTurn(b.id, turnB.turn.turnId), sessionB: registry.get(b.id) };

      vi.setSystemTime(at(1));
      await first.stream().send(startEvent());
      await first.stream().send(textDelta(TEXT_DELTA));
      assert.equal(registry.getTurn(a.id, turnA.turn.turnId).updatedAt, iso(1));
      assert.deepEqual(registry.getTurn(b.id, turnB.turn.turnId), before.turnB, "session B's turn is untouched by session A");
      assert.deepEqual(registry.get(b.id), before.sessionB, "session B's view is untouched by session A");

      vi.setSystemTime(at(2));
      await second.stream().send(startEvent());
      assert.equal(registry.getTurn(b.id, turnB.turn.turnId).updatedAt, iso(2));
      assert.equal(registry.getTurn(a.id, turnA.turn.turnId).updatedAt, iso(1), "session B's activity does not move session A's turn");

      await first.stream().finish(textMessage("answer a"));
      await second.stream().finish(textMessage("answer b"));
      assert.equal((await terminal(registry, a.id, turnA.turn.turnId)).assistantText, "answer a");
      assert.equal((await terminal(registry, b.id, turnB.turn.turnId)).assistantText, "answer b");
    } finally {
      await registry.close(a.id);
      await registry.close(b.id);
    }
  }, 30_000);

  describe("late events", () => {
    /** Replays public events through every listener the adapter ever registered. */
    async function replayLate(h: Harness, seconds: number): Promise<void> {
      vi.setSystemTime(at(seconds));
      for (const listener of h.listeners) for (const event of lateEvents) listener(event);
      await quiesce();
    }
    const snapshot = (registry: SessionRegistry, sessionId: string, turnId: string): { turn: TurnView; session: SessionView; list: SessionView[] } =>
      ({ turn: registry.getTurn(sessionId, turnId), session: registry.get(sessionId), list: registry.list() });

    it("ignores events delivered after the turn completed", async () => {
      const first = controlled();
      const h = await harness([first.plan]);
      vi.setSystemTime(at(0));
      const session = await h.registry.start("repo", profile);
      const accepted = await h.registry.prompt(session.id, "finish");
      await first.plan.entered.promise;
      try {
        vi.setSystemTime(at(1));
        await first.stream().send(startEvent());
        await first.stream().finish(textMessage("complete"));
        const done = await terminal(h.registry, session.id, accepted.turn.turnId);
        assert.equal(done.state, "completed");
        const before = snapshot(h.registry, session.id, accepted.turn.turnId);
        assert.equal(h.active.size, 0, "the adapter unsubscribed after completion");

        await replayLate(h, 30);
        assert.deepEqual(snapshot(h.registry, session.id, accepted.turn.turnId), before, "late events change neither the turn, the session nor the list");
        assert.equal(h.registry.getTurn(session.id, accepted.turn.turnId).assistantText, "complete", "a late assistant message_end is not an answer");
      } finally {
        await h.registry.close(session.id);
      }
    }, 30_000);

    it("ignores events from a finished turn while the next turn runs", async () => {
      const first = controlled();
      const second = controlled();
      const h = await harness([first.plan, second.plan]);
      vi.setSystemTime(at(0));
      const session = await h.registry.start("repo", profile);
      const one = await h.registry.prompt(session.id, "one");
      await first.plan.entered.promise;
      await first.stream().finish(textMessage("first"));
      await terminal(h.registry, session.id, one.turn.turnId);
      vi.setSystemTime(at(2));
      const two = await h.registry.prompt(session.id, "two");
      await second.plan.entered.promise;
      try {
        const listenersOfFirstTurn = h.listeners.slice(0, 1);
        vi.setSystemTime(at(40));
        for (const listener of listenersOfFirstTurn) for (const event of lateEvents) listener(event);
        await quiesce();
        const running = h.registry.getTurn(session.id, two.turn.turnId);
        assert.equal(running.state, "running");
        assert.equal(running.updatedAt, running.startedAt, "a finished turn's late events never stamp the next turn");
        await second.stream().finish(textMessage("second"));
        assert.equal((await terminal(h.registry, session.id, two.turn.turnId)).assistantText, "second");
      } finally {
        await h.registry.close(session.id);
      }
    }, 30_000);

    it("ignores events delivered after an abort", async () => {
      const first = controlled();
      const h = await harness([first.plan]);
      vi.setSystemTime(at(0));
      const session = await h.registry.start("repo", profile);
      const accepted = await h.registry.prompt(session.id, "abort me");
      await first.plan.entered.promise;
      try {
        vi.setSystemTime(at(1));
        await first.stream().send(startEvent());
        vi.setSystemTime(at(2));
        const aborted = await h.registry.abort(session.id);
        assert.equal(aborted.state, "idle");
        const turn = h.registry.getTurn(session.id, accepted.turn.turnId);
        assert.equal(turn.state, "aborted");
        const before = snapshot(h.registry, session.id, accepted.turn.turnId);
        assert.equal(h.active.size, 0, "the adapter unsubscribed after the abort");

        await replayLate(h, 30);
        assert.deepEqual(snapshot(h.registry, session.id, accepted.turn.turnId), before, "late events do not revive or restamp an aborted turn");
      } finally {
        await h.registry.close(session.id);
      }
    }, 30_000);

    it("ignores events delivered after close", async () => {
      const first = controlled();
      const h = await harness([first.plan]);
      vi.setSystemTime(at(0));
      const session = await h.registry.start("repo", profile);
      const accepted = await h.registry.prompt(session.id, "close me");
      await first.plan.entered.promise;
      vi.setSystemTime(at(1));
      await first.stream().send(startEvent());
      vi.setSystemTime(at(2));
      const closed = await h.registry.close(session.id);
      assert.equal(closed.state, "closed");
      assert.equal(h.active.size, 0, "closing the session removed the subscription");

      await replayLate(h, 30);
      assert.deepEqual(h.registry.list(), [], "late events do not revive or publish a closed session");
      assert.throws(() => h.registry.getTurn(session.id, accepted.turn.turnId), { code: "unknown_session" });
      assert.deepEqual(await h.registry.close(session.id), closed, "the closed tombstone is unchanged");
    }, 30_000);
  });

  it("keeps thinking and tool-call argument content out of every projection", async () => {
    // Sentinels exist only in thinking deltas, tool-call argument deltas and the partial messages
    // that carry them. The streamed tool call is never part of the final message.
    const stream = controlled();
    const h = await harness([stream.plan]);
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write);
    vi.setSystemTime(at(0));
    const session = await h.registry.start("repo", profile);
    const accepted = await h.registry.prompt(session.id, "stream private reasoning");
    await stream.plan.entered.promise;
    try {
      vi.setSystemTime(at(1));
      await stream.stream().send(startEvent());
      await stream.stream().send({ type: "thinking_start", contentIndex: 0, partial: assistantMessage([{ type: "thinking", thinking: "" }], "stop") });
      await stream.stream().send(thinkingDelta(THINKING_SENTINEL));
      await stream.stream().send({ type: "toolcall_start", contentIndex: 1, partial: assistantMessage([{ type: "toolCall", id: "call_stream", name: "read", arguments: {} }], "toolUse") });
      vi.setSystemTime(at(2));
      await stream.stream().send(toolcallDelta(`{"path":"${ARGUMENT_SENTINEL}`));

      const projections = (): string => JSON.stringify([
        h.registry.getTurn(session.id, accepted.turn.turnId), h.registry.get(session.id), h.registry.list(), h.diagnostics, stderr,
      ]);
      assert.equal(h.registry.getTurn(session.id, accepted.turn.turnId).updatedAt, iso(2), "the sentinel-bearing deltas were activity");
      assert.ok(!projections().includes("SENTINEL_"), "no projection of the running turn carries streamed private content");

      await stream.stream().finish(textMessage("public answer"));
      const done = await terminal(h.registry, session.id, accepted.turn.turnId);
      assert.equal(done.assistantText, "public answer");
      assert.ok(!projections().includes("SENTINEL_"), "no projection of the finished turn carries streamed private content");
    } finally {
      await h.registry.close(session.id);
    }
    assert.ok(!JSON.stringify([h.diagnostics, stderr]).includes("SENTINEL_"));
  }, 30_000);

  it("reports activity for exactly the public assistant and tool events of a real tool turn", async () => {
    // A real `read` tool call: the SDK emits tool_execution_start and _end around it. The
    // sentinel exists only in the tool arguments, which the adapter must never read.
    const toolMessage = assistantMessage([{ type: "toolCall", id: "call_1", name: "read", arguments: { path: `${ARGUMENT_SENTINEL}.txt` } }], "toolUse");
    const h = await harness([
      plan(() => playback([startEvent(), toolcallDelta(ARGUMENT_SENTINEL)], toolMessage)),
      plan(() => playback([startEvent(), textDelta(TEXT_DELTA)], textMessage("after the tool"))),
    ]);
    const handle = await h.adapter.create({ cwd: h.cwd, executionProfile: profile });
    const delivered: Array<{ type: string; role: string | undefined; activity: number }> = [];
    let activity = 0;
    h.tap.current = (event, deliver) => {
      const before = activity;
      deliver();
      const message = (event as { message?: { role?: string } }).message;
      delivered.push({ type: event.type, role: message?.role, activity: activity - before });
    };
    try {
      const outcome = await handle.prompt("use the tool", () => undefined, () => { activity++; });
      assert.deepEqual(outcome, { status: "completed", assistantText: "after the tool" });
    } finally {
      await handle.dispose();
    }

    const stream = new Set(["message_start", "message_update", "message_end"]);
    const tool = new Set(["tool_execution_start", "tool_execution_update", "tool_execution_end"]);
    for (const entry of delivered) {
      const expected = tool.has(entry.type) || (stream.has(entry.type) && entry.role === "assistant");
      assert.equal(entry.activity > 0, expected, `${entry.type}${entry.role ? ` (${entry.role})` : ""} activity`);
      assert.ok(entry.activity <= 1, "at most one content-free signal per event");
    }
    const seen = (type: string, role?: string): boolean => delivered.some((entry) => entry.type === type && (role === undefined || entry.role === role));
    for (const type of ["message_start", "message_update", "message_end"]) assert.ok(seen(type, "assistant"), `${type} of an assistant message was delivered`);
    assert.ok(seen("tool_execution_start") && seen("tool_execution_end"), "the real tool execution was delivered");
    assert.ok(seen("message_start", "user"), "the prompt's own user message was delivered and is not activity");
  }, 30_000);

  it("takes the answer only from the final assistant message_end and removes the subscription", async () => {
    const chatter = [startEvent(), textDelta("STREAMED_ONLY_TEXT")];
    const h = await harness([
      plan(() => playback(chatter, textMessage("settled answer"))),
      plan(() => playback(chatter, textMessage("provider failed", "error"))),
      plan(() => new ControlledStream(undefined)),
    ]);
    const session = await h.registry.start("repo", profile);
    try {
      const completed = await h.registry.prompt(session.id, "complete");
      const done = await terminal(h.registry, session.id, completed.turn.turnId);
      assert.deepEqual([done.state, done.assistantText], ["completed", "settled answer"], "streamed text never replaces the final answer");
      assert.equal(h.active.size, 0, "the subscription is removed after completion");

      const failing = await h.registry.prompt(session.id, "fail");
      const failed = await terminal(h.registry, session.id, failing.turn.turnId);
      assert.equal(failed.state, "failed");
      assert.equal(failed.assistantText, undefined);
      assert.equal(h.active.size, 0, "the subscription is removed after a failed turn");
      assert.equal(h.listeners.length, 2, "one subscription per prompt");
    } finally {
      await h.registry.close(session.id);
    }
  }, 30_000);

  it("removes the subscription when the session is disposed mid-turn", async () => {
    const stream = controlled();
    const h = await harness([stream.plan]);
    const session = await h.registry.start("repo", profile);
    await h.registry.prompt(session.id, "dispose me");
    await stream.plan.entered.promise;
    await stream.stream().send(startEvent());
    assert.equal(h.active.size, 1, "the running prompt holds exactly one subscription");
    await h.registry.close(session.id);
    assert.equal(h.active.size, 0, "dispose removed the subscription");
  }, 30_000);
});

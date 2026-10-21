import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_EVENT_KEYS, BridgedRegistry, EventBridge, SpoolSink, readSpool, type BridgeEvent } from "../eval/bridge/bridge.js";
import { QuestionBroker } from "../eval/bridge/questions.js";
import { ScriptedAdapter, type ScriptedHandle, type ScriptedSessionPlan } from "../eval/bridge/scripted-adapter.js";
import { RegistryError, type SessionRegistryOptions } from "../src/session-registry.js";
import { FakeAdapter } from "./fake-adapter.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

const profile = { alias: "safe", permissionProfile: "read-only" as const, provider: "fake-provider", model: "fake-model", thinkingLevel: "off" as const };
const CANARIES = ["CANARY_PROMPT_7f3a", "CANARY_ANSWER_91bc", "CANARY_TEXT_c0de", "CANARY_QUESTION_55aa"];
const workspaces = () => new Map([["repo", "/safe/repo"]]);
const flush = async (): Promise<void> => { for (let i = 0; i < 3; i += 1) await new Promise<void>((resolve) => setImmediate(resolve)); };
async function until(condition: () => boolean, label = "condition", ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) { if (Date.now() > end) throw new Error(`timeout waiting for ${label}`); await new Promise<void>((resolve) => setTimeout(resolve, 1)); }
}
const terminals = (events: BridgeEvent[]) => events.filter((e): e is Extract<BridgeEvent, { kind: "turn_terminal" }> => e.kind === "turn_terminal");
const opened = (events: BridgeEvent[]) => events.filter((e): e is Extract<BridgeEvent, { kind: "question_opened" }> => e.kind === "question_opened");
const hang: ScriptedSessionPlan = { prompts: [[{ hang: true }]] };
const completedBy = (text: string) => ({ status: "completed" as const, assistantText: text });

const live: BridgedRegistry[] = [];
function setup(options: SessionRegistryOptions = {}, brokerOptions: { maxOpenPerSession?: number; maxOpenPerInstance?: number } = {}) {
  const bridge = new EventBridge("inst-A"), events: BridgeEvent[] = []; bridge.subscribe((event) => events.push(event));
  const adapter = new ScriptedAdapter(), registry = new BridgedRegistry(adapter, workspaces(), options, bridge); live.push(registry);
  const broker = new QuestionBroker({ instanceId: "inst-A", bridge, ...brokerOptions }); broker.attach();
  adapter.asker = async ({ handle, spec, deadlineMs, signal }) => broker.ask({ ...(await registry.correlation(handle)), attemptId: "att-1" }, spec, { deadlineMs, signal });
  const start = async (plan: ScriptedSessionPlan = hang): Promise<string> => { adapter.plans.push(plan); return (await registry.start("repo", profile)).id; };
  const handle = (index: number): ScriptedHandle => adapter.handles[index]!;
  return { bridge, events, adapter, registry, broker, start, handle };
}
afterEach(async () => { vi.useRealTimers(); await Promise.all(live.splice(0).map((registry) => registry.shutdown())); });
afterAll(removeTemporaryRoots);

describe("turn_terminal from the read model", () => {
  it("emits exactly one correctly attributed event per concurrent turn, in settlement order", async () => {
    const { registry, events, start, handle } = setup();
    const ids = [await start(), await start(), await start()];
    const turns = [];
    for (const id of ids) turns.push((await registry.prompt(id, "CANARY_PROMPT_7f3a")).turn.turnId);
    handle(1).release(completedBy("CANARY_TEXT_c0de")); await flush();
    handle(2).release({ status: "failed" }); await flush();
    handle(0).release(completedBy("CANARY_TEXT_c0de")); await flush();
    expect(terminals(events).map((e) => [e.sessionId, e.turnId, e.state, e.via])).toEqual([
      [ids[1], turns[1], "completed", "bridge"], [ids[2], turns[2], "failed", "bridge"], [ids[0], turns[0], "completed", "bridge"],
    ]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    await flush(); expect(events).toHaveLength(3);
  });

  it("reports failed and aborted turns with their real state", async () => {
    const { registry, events, start } = setup();
    const failing = await start({ prompts: [[{ fail: true }]] }), aborting = await start();
    const f = await registry.prompt(failing, "x"), a = await registry.prompt(aborting, "x"); await flush();
    await registry.abort(aborting); await flush();
    expect(terminals(events).map((e) => [e.turnId, e.state])).toEqual([[f.turn.turnId, "failed"], [a.turn.turnId, "aborted"]]);
  });

  it("emits nothing on abort_timeout and then exactly one event with the real final state", async () => {
    const { registry, events, start, handle } = setup({ abortDeadlineMs: 20 });
    const id = await start({ prompts: [[{ hang: true }]], abortHangs: true }); const { turn } = await registry.prompt(id, "x");
    await expect(registry.abort(id)).rejects.toMatchObject({ code: "abort_timeout" }); await flush();
    expect(events).toEqual([]); expect(registry.getTurn(id, turn.turnId).state).toBe("running");
    handle(0).release(completedBy("CANARY_TEXT_c0de")); await flush();
    expect(terminals(events).map((e) => [e.turnId, e.state])).toEqual([[turn.turnId, "completed"]]);
    await flush(); expect(events).toHaveLength(1);
  });

  it("reports aborted once an abort_timeout turn finally ends through the aborted path", async () => {
    const { registry, events, start, handle } = setup({ abortDeadlineMs: 20 });
    const id = await start({ prompts: [[{ hang: true }]], abortHangs: true }); const { turn } = await registry.prompt(id, "x");
    await expect(registry.abort(id)).rejects.toBeInstanceOf(RegistryError); await flush(); expect(events).toEqual([]);
    handle(0).release(); await flush();
    expect(terminals(events).map((e) => [e.turnId, e.state])).toEqual([[turn.turnId, "aborted"]]);
  });

  it("emits nothing for a silent running turn however long it runs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { registry, events, start } = setup();
    const id = await start(); await registry.prompt(id, "x");
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000); await flush();
    expect(events).toEqual([]);
    vi.useRealTimers();
  });

  it("emits instance_ended once on shutdown and aborted via close for a running turn exactly once", async () => {
    const { registry, events, start } = setup();
    const running = await start(), idle = await start({}); const { turn } = await registry.prompt(running, "x"); await registry.prompt(idle, "x"); await flush();
    expect(terminals(events)).toHaveLength(1); // the idle session's scripted turn completed on its own
    await registry.close(running); await registry.close(running); await flush();
    expect(terminals(events).filter((e) => e.turnId === turn.turnId).map((e) => [e.state, e.via])).toEqual([["aborted", "close"]]);
    await registry.shutdown(); await registry.shutdown();
    expect(events.filter((e) => e.kind === "instance_ended").map((e) => e.kind === "instance_ended" && e.reason)).toEqual(["server_exit"]);
    expect(events.at(-1)?.kind).toBe("instance_ended");
  });

  it("aborts running turns through close during shutdown before instance_ended", async () => {
    const { registry, events, start } = setup();
    const id = await start(); const { turn } = await registry.prompt(id, "x");
    await registry.shutdown();
    expect(events.map((e) => e.kind)).toEqual(["turn_terminal", "instance_ended"]);
    expect(terminals(events)[0]).toMatchObject({ turnId: turn.turnId, state: "aborted", via: "close" });
  });

  it("gives a follow-up turn in the same session its own single event", async () => {
    const { registry, events, start, handle } = setup();
    const id = await start({ prompts: [[{ hang: true }], [{ hang: true }]] });
    const first = await registry.prompt(id, "one"); handle(0).release(completedBy("CANARY_TEXT_c0de")); await flush();
    const second = await registry.prompt(id, "two"); expect(second.turn.turnId).not.toBe(first.turn.turnId);
    await flush(); expect(terminals(events)).toHaveLength(1);
    handle(0).release(completedBy("CANARY_TEXT_c0de")); await flush();
    expect(terminals(events).map((e) => [e.turnId, e.state])).toEqual([[first.turn.turnId, "completed"], [second.turn.turnId, "completed"]]);
  });

  it("ignores duplicate and late settlements after a terminal event and after close", async () => {
    const { registry, events, start, handle } = setup();
    const done = await start(), closed = await start();
    await registry.prompt(done, "x"); await registry.prompt(closed, "x");
    handle(0).release(completedBy("CANARY_TEXT_c0de")); handle(0).release({ status: "failed" }); await flush();
    await registry.close(closed); await flush();
    handle(1).release(completedBy("CANARY_TEXT_c0de")); handle(1).release({ status: "failed" }); await flush();
    expect(terminals(events).map((e) => [e.sessionId, e.state, e.via])).toEqual([[done, "completed", "bridge"], [closed, "aborted", "close"]]);
    await registry.close(done); await flush(); expect(terminals(events)).toHaveLength(2);
  });

  it("keeps completed when close follows the completion, flushed or not", async () => {
    const { registry, events, start, handle } = setup();
    const flushed = await start(), racing = await start();
    await registry.prompt(flushed, "x"); await registry.prompt(racing, "x");
    handle(0).release(completedBy("CANARY_TEXT_c0de")); await flush(); await registry.close(flushed);
    handle(1).release(completedBy("CANARY_TEXT_c0de")); await registry.close(racing); await flush();
    expect(terminals(events).map((e) => [e.sessionId, e.state])).toEqual([[flushed, "completed"], [racing, "completed"]]);
  });

  it("does not turn activity, including many agent_end analogs, into an early event (scripted and fake adapter)", async () => {
    const { registry, events, start, handle } = setup();
    const id = await start({ prompts: [[{ activity: 200 }, { sleepMs: 1 }, { activity: 200 }, { hang: true }]] }); await registry.prompt(id, "x");
    await flush(); await new Promise<void>((resolve) => setTimeout(resolve, 10)); expect(events).toEqual([]);
    handle(0).release(completedBy("CANARY_TEXT_c0de")); await flush(); expect(terminals(events)).toHaveLength(1);

    const bridge = new EventBridge("inst-F"), fakeEvents: BridgeEvent[] = []; bridge.subscribe((event) => fakeEvents.push(event));
    const fake = new FakeAdapter(), fakeRegistry = new BridgedRegistry(fake, workspaces(), {}, bridge); live.push(fakeRegistry);
    const session = await fakeRegistry.start("repo", profile); const { turn } = await fakeRegistry.prompt(session.id, "x");
    for (let i = 0; i < 100; i += 1) fake.handles[0]!.reportActivity(); await flush(); expect(fakeEvents).toEqual([]);
    fake.handles[0]!.complete("CANARY_TEXT_c0de"); await flush();
    expect(terminals(fakeEvents).map((e) => [e.turnId, e.state, e.instanceId])).toEqual([[turn.turnId, "completed", "inst-F"]]);
  });

  it("keeps two registries with the same workspace aliases apart", async () => {
    const a = setup(), b = setup();
    const id = await a.start(); const { turn } = await a.registry.prompt(id, "x");
    expect(() => b.registry.get(id)).toThrow(expect.objectContaining({ code: "unknown_session" }));
    expect(() => b.registry.getTurn(id, turn.turnId)).toThrow(expect.objectContaining({ code: "unknown_session" }));
    await expect(b.registry.prompt(id, "x")).rejects.toMatchObject({ code: "unknown_session" });
    await expect(b.registry.close(id)).rejects.toMatchObject({ code: "unknown_session" });
    a.handle(0).release(completedBy("CANARY_TEXT_c0de")); await flush();
    expect(terminals(a.events)).toHaveLength(1); expect(b.events).toEqual([]);
  });
});

describe("EventBridge", () => {
  it("survives throwing listeners and delivers re-entrant emits in seq order to every listener", () => {
    const bridge = new EventBridge("inst-A"), first: number[] = [], second: number[] = [];
    bridge.subscribe(() => { throw new Error("sink down"); });
    bridge.subscribe((e) => { first.push(e.seq); if (e.seq === 1) bridge.emit({ kind: "instance_ended", reason: "eof" }); });
    const unsubscribe = bridge.subscribe((e) => { second.push(e.seq); });
    expect(bridge.emit({ kind: "instance_ended", reason: "closed" }).seq).toBe(1);
    unsubscribe(); bridge.emit({ kind: "instance_ended", reason: "server_exit" });
    expect(first).toEqual([1, 2, 3]); expect(second).toEqual([1, 2]);
  });
});

describe("structured questions during a running turn", () => {
  const select = { recipient: "controller" as const, kind: "select" as const, prompt: "CANARY_QUESTION_55aa", options: ["a", "b"] };

  it("keeps the session running without deadlock and resolves exactly the waiting ask", async () => {
    const { registry, events, broker, start, handle } = setup();
    const id = await start({ prompts: [[{ ask: select, deadlineMs: 5000 }, { complete: "CANARY_TEXT_c0de" }]] }); const { turn } = await registry.prompt(id, "CANARY_PROMPT_7f3a");
    await until(() => opened(events).length === 1, "question_opened");
    await expect(registry.prompt(id, "CANARY_ANSWER_91bc")).rejects.toMatchObject({ code: "session_running" });
    const requestId = opened(events)[0]!.requestId;
    expect(broker.get(requestId, "inst-A")).toMatchObject({ prompt: "CANARY_QUESTION_55aa", options: ["a", "b"], sessionId: id, turnId: turn.turnId, attemptId: "att-1" });
    expect(broker.get(requestId, "inst-B")).toEqual({ error: "wrong_instance" });
    expect(broker.answer(requestId, "inst-A", "zzz")).toBe("invalid_answer");
    expect(broker.answer(requestId, "inst-A", "b")).toBe("accepted");
    await until(() => terminals(events).length === 1, "turn_terminal");
    expect(handle(0).askOutcomes).toEqual([{ status: "answered", value: "b" }]);
    expect(events.map((e) => e.kind)).toEqual(["question_opened", "question_resolved", "turn_terminal"]);
    expect(events[1]).toMatchObject({ state: "answered", requestId }); expect(registry.getTurn(id, turn.turnId).state).toBe("completed");
    expect(broker.answer(requestId, "inst-A", "b")).toBe("already_resolved");
  });

  it("validates answers by kind and size, and routes crosswise answers by id and instance", async () => {
    const { registry, events, broker, start, handle } = setup();
    const confirm = { recipient: "human" as const, kind: "confirm" as const, prompt: "CANARY_QUESTION_55aa" };
    const input = { recipient: "controller" as const, kind: "input" as const, prompt: "CANARY_QUESTION_55aa", maxBytes: 8 };
    const s1 = await start({ prompts: [[{ ask: select, deadlineMs: 5000 }, { hang: true }]] }), s2 = await start({ prompts: [[{ ask: confirm, deadlineMs: 5000 }, { hang: true }]] });
    const s3 = await start({ prompts: [[{ ask: input, deadlineMs: 5000 }, { hang: true }]] }), s4 = await start({ prompts: [[{ ask: input, deadlineMs: 5000 }, { hang: true }]] });
    for (const id of [s1, s2, s3, s4]) await registry.prompt(id, "x");
    await until(() => opened(events).length === 4, "four questions");
    const by = (id: string) => opened(events).find((e) => e.sessionId === id)!.requestId;
    const [r1, r2, r3, r4] = [by(s1), by(s2), by(s3), by(s4)] as [string, string, string, string];
    expect(opened(events).find((e) => e.sessionId === s2)).toMatchObject({ recipient: "human", questionKind: "confirm" });
    expect(broker.answer(r1, "inst-A", true)).toBe("invalid_answer"); // confirm answer for the select question
    expect(broker.answer(r2, "inst-A", "b")).toBe("invalid_answer"); // select answer for the confirm question
    expect(broker.answer(r3, "inst-A", "123456789")).toBe("invalid_answer"); // 9 bytes > 8
    expect(broker.answer(r3, "inst-A", "ä".repeat(5))).toBe("invalid_answer"); // 10 UTF-8 bytes
    expect(broker.answer(r1, "inst-B", "a")).toBe("wrong_instance");
    expect(broker.answer("00000000-0000-4000-8000-000000000000", "inst-A", "a")).toBe("unknown_request");
    expect(broker.openCount()).toBe(4);
    expect(broker.answer(r2, "inst-A", false)).toBe("accepted"); expect(broker.answer(r1, "inst-A", "a")).toBe("accepted");
    expect(broker.answer(r3, "inst-A", "ä".repeat(4))).toBe("accepted"); expect(broker.answer(r4, "inst-A", "")).toBe("accepted");
    expect(broker.answer(r1, "inst-A", "a")).toBe("already_resolved");
    await until(() => [0, 1, 2, 3].every((i) => handle(i).askOutcomes.length === 1), "four outcomes");
    expect([0, 1, 2, 3].map((i) => handle(i).askOutcomes[0])).toEqual([{ status: "answered", value: "a" }, { status: "answered", value: false }, { status: "answered", value: "ääää" }, { status: "answered", value: "" }]);
    expect(broker.openCount()).toBe(0);
  });

  it("expires a question at its deadline and rejects late answers", async () => {
    const { registry, events, broker, start, handle } = setup();
    const id = await start({ prompts: [[{ ask: select, deadlineMs: 25 }, { hang: true }]] }); await registry.prompt(id, "x");
    await until(() => handle(0).askOutcomes.length === 1, "expiry");
    const requestId = opened(events)[0]!.requestId;
    expect(handle(0).askOutcomes[0]).toEqual({ status: "expired", code: "deadline" });
    expect(broker.answer(requestId, "inst-A", "a")).toBe("expired"); expect(broker.get(requestId, "inst-A")).toEqual({ error: "expired" });
    expect(events.filter((e) => e.kind === "question_resolved")).toMatchObject([{ state: "expired" }]);
    expect(broker.openCount()).toBe(0);
  });

  it("rejects an answer after the deadline even if the timer has not fired yet", () => {
    vi.useFakeTimers(); let now = 1_000;
    const bridge = new EventBridge("inst-A"), broker = new QuestionBroker({ instanceId: "inst-A", bridge, now: () => now });
    const asked = broker.ask({ sessionId: "s", turnId: "t", attemptId: "a" }, select, { deadlineMs: 100 });
    const requestId = (broker as unknown as { open: Map<string, unknown> }).open.keys().next().value as string;
    now = 1_100; expect(broker.answer(requestId, "inst-A", "a")).toBe("expired");
    return expect(asked).resolves.toEqual({ status: "expired", code: "deadline" });
  });

  it("cancels a waiting question when the turn is aborted", async () => {
    const { registry, events, broker, start, handle } = setup();
    const id = await start({ prompts: [[{ ask: select, deadlineMs: 60_000 }, { complete: "CANARY_TEXT_c0de" }]] }); await registry.prompt(id, "x");
    await until(() => opened(events).length === 1, "question_opened");
    await registry.abort(id); await until(() => handle(0).askOutcomes.length === 1 && terminals(events).length === 1, "cancellation");
    expect(handle(0).askOutcomes[0]).toEqual({ status: "cancelled", code: "aborted" });
    expect(events.map((e) => e.kind)).toEqual(["question_opened", "question_resolved", "turn_terminal"]);
    expect(events[1]).toMatchObject({ state: "cancelled" }); expect(terminals(events)[0]!.state).toBe("aborted");
    expect(broker.answer(opened(events)[0]!.requestId, "inst-A", "a")).toBe("already_resolved"); expect(broker.openCount()).toBe(0);
  });

  it("cancels a waiting question when the session is closed", async () => {
    const { registry, events, broker, start, handle } = setup();
    const id = await start({ prompts: [[{ ask: select, deadlineMs: 60_000 }, { complete: "CANARY_TEXT_c0de" }]] }); await registry.prompt(id, "x");
    await until(() => opened(events).length === 1, "question_opened");
    await registry.close(id); await until(() => handle(0).askOutcomes.length === 1, "ask settled");
    expect(handle(0).askOutcomes[0]).toMatchObject({ status: "cancelled" });
    expect(events.filter((e) => e.kind === "question_resolved")).toHaveLength(1);
    expect(terminals(events).map((e) => [e.state, e.via])).toEqual([["aborted", "close"]]); expect(broker.openCount()).toBe(0);
  });

  it("refuses beyond the per-session and per-instance limits and leaks no timers", async () => {
    vi.useFakeTimers();
    const bridge = new EventBridge("inst-A"), events: BridgeEvent[] = []; bridge.subscribe((e) => events.push(e));
    const broker = new QuestionBroker({ instanceId: "inst-A", bridge });
    const ask = (session: string, signal?: AbortSignal) => broker.ask({ sessionId: session, turnId: "t", attemptId: "a" }, select, { deadlineMs: 10_000, ...(signal ? { signal } : {}) });
    const first = ask("s1"), second = ask("s1");
    await expect(second).resolves.toEqual({ status: "refused", code: "question_limit" });
    const controller = new AbortController(), others = [ask("s2"), ask("s3"), ask("s4", controller.signal)];
    await expect(ask("s5")).resolves.toEqual({ status: "refused", code: "question_limit" });
    expect(broker.openCount()).toBe(4);
    expect(broker.cancelTurn("s1", "t", "test")).toBe(1); await expect(first).resolves.toEqual({ status: "cancelled", code: "test" });
    controller.abort(); await expect(others[2]).resolves.toEqual({ status: "cancelled", code: "aborted" });
    await vi.advanceTimersByTimeAsync(10_000); await expect(others[0]).resolves.toEqual({ status: "expired", code: "deadline" });
    expect(broker.cancelAll("done")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(events.filter((e) => e.kind === "question_resolved").map((e) => e.kind === "question_resolved" && e.state).sort()).toEqual(["cancelled", "cancelled", "expired", "expired", "refused", "refused"]);
    await expect(broker.ask({ sessionId: "s6", turnId: "t", attemptId: "a" }, { ...select, options: [] }, { deadlineMs: 1000 })).resolves.toEqual({ status: "refused", code: "invalid_question" });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("content-free events and spool", () => {
  it("carries only allowed keys and none of the prompt, question, answer or assistant text", async () => {
    const root = await temporaryRoot("bridge-spool-"), dir = join(root, "spool");
    const { registry, events, bridge, broker, start, handle } = setup();
    const sink = new SpoolSink(dir); sink.attach(bridge);
    const ask = { recipient: "controller" as const, kind: "input" as const, prompt: "CANARY_QUESTION_55aa" };
    const a = await start({ prompts: [[{ ask, deadlineMs: 5000 }, { complete: "CANARY_TEXT_c0de" }]] }), b = await start(), c = await start({ prompts: [[{ fail: true }]] });
    await registry.prompt(a, "CANARY_PROMPT_7f3a"); await registry.prompt(b, "CANARY_PROMPT_7f3a"); await registry.prompt(c, "CANARY_PROMPT_7f3a");
    await until(() => opened(events).length === 1, "question_opened");
    expect(broker.answer(opened(events)[0]!.requestId, "inst-A", "CANARY_ANSWER_91bc")).toBe("accepted");
    handle(1).release(completedBy("CANARY_TEXT_c0de")); await flush();
    await registry.shutdown(); await flush();
    expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining(["question_opened", "question_resolved", "turn_terminal", "instance_ended"])); expect(events).toHaveLength(6);
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual([...BRIDGE_EVENT_KEYS[event.kind]].sort());
      for (const canary of CANARIES) expect(JSON.stringify(event)).not.toContain(canary);
    }
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    const files = readdirSync(dir).sort();
    expect(files).toEqual(events.map((e) => `${String(e.seq).padStart(8, "0")}-${e.kind}.json`));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const file of files) { expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600); for (const canary of CANARIES) expect(readFileSync(join(dir, file), "utf8")).not.toContain(canary); }
    expect(readSpool(dir)).toEqual(events);
  });

  it("creates a nested spool directory with mode 0700", async () => {
    const root = await temporaryRoot("bridge-spool-"), dir = join(root, "a", "b");
    mkdirSync(join(root, "a"), { mode: 0o755 }); new SpoolSink(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});

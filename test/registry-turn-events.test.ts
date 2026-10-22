import { describe, expect, it, vi } from "vitest";
import { SessionRegistry, type SessionRegistryOptions, type TurnTerminalNotice } from "../src/session-registry.js";
import { FakeAdapter } from "./fake-adapter.js";

const profile = { alias: "safe", permissionProfile: "read-only" as const, provider: "fake-provider", model: "fake-model", thinkingLevel: "off" as const };
const flush = async (): Promise<void> => { for (let i = 0; i < 3; i += 1) await new Promise<void>((resolve) => setImmediate(resolve)); };

function setup(options: SessionRegistryOptions = {}) {
  const adapter = new FakeAdapter();
  const events: TurnTerminalNotice[] = [];
  const registry = new SessionRegistry(adapter, new Map([["repo", "/safe/repo"]]), { ...options, onTurnTerminal: (event) => { events.push(event); options.onTurnTerminal?.(event); } });
  const start = async (plan: FakeAdapter["plans"][number] = {}): Promise<string> => { adapter.plans.push(plan); return (await registry.start("repo", profile)).id; };
  return { adapter, registry, events, start, handle: (index: number) => adapter.handles[index]! };
}
const summary = (events: TurnTerminalNotice[]) => events.map((e) => [e.sessionId, e.turnId, e.state, e.via]);

describe("onTurnTerminal at the registry's terminal transition", () => {
  it("emits exactly one correctly attributed event per concurrent turn, in settlement order", async () => {
    const { registry, events, start, handle } = setup();
    const ids = [await start(), await start(), await start()];
    const turns: string[] = [];
    for (const id of ids) turns.push((await registry.prompt(id, "p")).turn.turnId);
    handle(1).complete("b"); await flush();
    handle(2).fail(); await flush();
    handle(0).complete("a"); await flush();
    expect(summary(events)).toEqual([
      [ids[1], turns[1], "completed", "registry"], [ids[2], turns[2], "failed", "registry"], [ids[0], turns[0], "completed", "registry"],
    ]);
    await flush(); expect(events).toHaveLength(3);
  });

  it("reports failed and aborted turns with their real state", async () => {
    const { registry, events, start, handle } = setup();
    const failing = await start(), aborting = await start();
    const f = await registry.prompt(failing, "x"), a = await registry.prompt(aborting, "x");
    handle(0).fail(); await flush();
    await registry.abort(aborting); await flush();
    expect(summary(events)).toEqual([[failing, f.turn.turnId, "failed", "registry"], [aborting, a.turn.turnId, "aborted", "registry"]]);
  });

  it("reports a prompt that is accepted and then rejects as failed, once", async () => {
    const { registry, events, start } = setup();
    const id = await start({ rejectDetail: "provider detail" });
    const { turn } = await registry.prompt(id, "x"); await flush();
    expect(summary(events)).toEqual([[id, turn.turnId, "failed", "registry"]]);
    expect(JSON.stringify(events)).not.toContain("provider detail");
  });

  it("emits nothing for a rejected, timed-out or restored preflight", async () => {
    const { registry, events, start, handle } = setup({ preflightDeadlineMs: 20, abortDeadlineMs: 20 });
    const rejected = await start({ accepted: false });
    await expect(registry.prompt(rejected, "x")).rejects.toMatchObject({ code: "prompt_rejected" });
    const silent = await start({ manualPreflight: true });
    await expect(registry.prompt(silent, "x")).rejects.toMatchObject({ code: "prompt_timeout" });
    await flush();
    handle(1).complete("late"); await flush();
    await registry.close(silent); await registry.shutdown(); await flush();
    expect(events).toEqual([]);
  });

  it("emits nothing on abort_timeout, then exactly one event with the real final state", async () => {
    const { registry, events, start, handle } = setup({ abortDeadlineMs: 20 });
    const id = await start(); const { turn } = await registry.prompt(id, "x");
    let openGate!: () => void;
    handle(0).abortGate = new Promise<void>((resolve) => { openGate = resolve; }); handle(0).abortSettlesPrompt = false;
    await expect(registry.abort(id)).rejects.toMatchObject({ code: "abort_timeout" }); await flush();
    expect(events).toEqual([]); expect(registry.getTurn(id, turn.turnId).state).toBe("running");
    handle(0).complete("late result"); await flush();
    expect(summary(events)).toEqual([[id, turn.turnId, "completed", "registry"]]);
    openGate(); await flush(); expect(events).toHaveLength(1);
  });

  it("reports aborted via registry once an abort_timeout turn finally ends through the abort path", async () => {
    const { registry, events, start, handle } = setup({ abortDeadlineMs: 20 });
    const id = await start(); const { turn } = await registry.prompt(id, "x");
    let openGate!: () => void;
    handle(0).abortGate = new Promise<void>((resolve) => { openGate = resolve; });
    await expect(registry.abort(id)).rejects.toMatchObject({ code: "abort_timeout" }); await flush(); expect(events).toEqual([]);
    openGate(); await flush();
    expect(summary(events)).toEqual([[id, turn.turnId, "aborted", "registry"]]);
  });

  it("never reports completed when the adapter completes during close after an abort_timeout", async () => {
    const { registry, events, start, handle } = setup({ abortDeadlineMs: 20, closeCleanupDeadlineMs: 2000 });
    const id = await start(); const { turn } = await registry.prompt(id, "x");
    let openGate!: () => void;
    handle(0).abortGate = new Promise<void>((resolve) => { openGate = resolve; }); handle(0).abortSettlesPrompt = false;
    await expect(registry.abort(id)).rejects.toMatchObject({ code: "abort_timeout" }); await flush(); expect(events).toEqual([]);
    const closing = registry.close(id); await flush();
    expect(summary(events)).toEqual([[id, turn.turnId, "aborted", "close"]]);
    handle(0).complete("late result"); openGate();
    await closing; await flush();
    expect(summary(events)).toEqual([[id, turn.turnId, "aborted", "close"]]);
  });

  it("emits nothing for a silent running turn however long it runs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const { registry, events, start } = setup();
      const id = await start(); await registry.prompt(id, "x");
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
      expect(events).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it("does not turn many activity callbacks into an early event", async () => {
    const { registry, events, start, handle } = setup();
    const id = await start(); const { turn } = await registry.prompt(id, "x");
    for (let i = 0; i < 100; i += 1) handle(0).reportActivity();
    await flush(); expect(events).toEqual([]);
    handle(0).complete("done"); await flush();
    expect(summary(events)).toEqual([[id, turn.turnId, "completed", "registry"]]);
  });

  it("gives a follow-up turn in the same session its own single event", async () => {
    const { registry, events, start, handle } = setup();
    const id = await start();
    const first = await registry.prompt(id, "one"); handle(0).complete("one"); await flush();
    const second = await registry.prompt(id, "two"); expect(second.turn.turnId).not.toBe(first.turn.turnId);
    await flush(); expect(events).toHaveLength(1);
    handle(0).complete("two"); await flush();
    expect(summary(events)).toEqual([[id, first.turn.turnId, "completed", "registry"], [id, second.turn.turnId, "completed", "registry"]]);
  });

  it("ignores duplicate and late settlements after a terminal event and after close", async () => {
    const { registry, events, start, handle } = setup();
    const done = await start(), closed = await start();
    const d = await registry.prompt(done, "x"), c = await registry.prompt(closed, "x");
    handle(0).complete("a"); handle(0).fail(); await flush();
    await registry.close(closed); await flush();
    handle(1).complete("late"); handle(1).fail(); await flush();
    expect(summary(events)).toEqual([[done, d.turn.turnId, "completed", "registry"], [closed, c.turn.turnId, "aborted", "close"]]);
    await registry.close(done); await flush(); expect(events).toHaveLength(2);
  });

  it("keeps completed via registry when close follows a flushed completion and emits nothing via close", async () => {
    const { registry, events, start, handle } = setup();
    const id = await start(); const { turn } = await registry.prompt(id, "x");
    handle(0).complete("done"); await flush(); await registry.close(id); await flush();
    expect(summary(events)).toEqual([[id, turn.turnId, "completed", "registry"]]);
  });

  it("emits exactly one consistent event when close races a just-released completion", async () => {
    const { registry, events, start, handle } = setup();
    const id = await start(); const { turn } = await registry.prompt(id, "x");
    handle(0).complete("done"); await registry.close(id); await flush();
    expect(events).toHaveLength(1);
    expect(`${events[0]!.state}/${events[0]!.via}`).toMatch(/^(aborted\/close|completed\/registry)$/);
    expect(events[0]).toMatchObject({ sessionId: id, turnId: turn.turnId });
  });

  it("emits before close clears the turn data", async () => {
    const seen: Array<{ state: string | undefined }> = [];
    const ref: { registry?: SessionRegistry } = {};
    const made = setup({ onTurnTerminal: (event) => { seen.push({ state: ref.registry!.getTurn(event.sessionId, event.turnId).state }); } });
    ref.registry = made.registry;
    const id = await made.start(); await made.registry.prompt(id, "x");
    await made.registry.close(id);
    expect(seen).toEqual([{ state: "aborted" }]);
  });

  it("aborts running turns through close on shutdown, one event each", async () => {
    const { registry, events, start } = setup();
    const a = await start(), b = await start(), idle = await start();
    const ta = await registry.prompt(a, "x"), tb = await registry.prompt(b, "x");
    await registry.shutdown(); await registry.shutdown(); await flush();
    expect(events.map((e) => [e.sessionId, e.turnId, e.state, e.via]).sort()).toEqual([
      [a, ta.turn.turnId, "aborted", "close"], [b, tb.turn.turnId, "aborted", "close"],
    ].sort());
    expect(events.some((e) => e.sessionId === idle)).toBe(false);
  });

  it("never lets a throwing listener affect the registry", async () => {
    const { registry, events, start, handle } = setup({ onTurnTerminal: () => { throw new Error("listener secret"); } });
    const id = await start(); const { turn } = await registry.prompt(id, "x");
    handle(0).complete("done"); await flush();
    expect(registry.getTurn(id, turn.turnId)).toMatchObject({ state: "completed", assistantText: "done" });
    expect(registry.get(id).state).toBe("idle");
    const second = await registry.prompt(id, "y");
    await expect(registry.close(id)).resolves.toMatchObject({ state: "closed" });
    expect(events).toHaveLength(2);
    expect(second.turn.turnId).not.toBe(turn.turnId);
  });

  it("behaves as before without a listener", async () => {
    const adapter = new FakeAdapter();
    const registry = new SessionRegistry(adapter, new Map([["repo", "/safe/repo"]]));
    const session = await registry.start("repo", profile); const { turn } = await registry.prompt(session.id, "x");
    adapter.handles[0]!.complete("done"); await flush();
    expect(registry.getTurn(session.id, turn.turnId).state).toBe("completed");
    await registry.shutdown();
  });
});

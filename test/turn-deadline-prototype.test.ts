import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeadlineSupervisor, MAX_TURN_SECONDS_MAX, MAX_TURN_SECONDS_MIN, parseMaxTurnSeconds } from "../eval/turn-deadline/supervisor.js";
import { RegistryError, SessionRegistry, type TurnTerminalNotice } from "../src/session-registry.js";
import { FakeAdapter, type FakeHandle } from "./fake-adapter.js";

const profile = { alias: "safe", permissionProfile: "read-only" as const, provider: "fake-provider", model: "fake-model", thinkingLevel: "off" as const };
const deadlines = { preflightDeadlineMs: 10, abortDeadlineMs: 10, closeCleanupDeadlineMs: 10, shutdownDeadlineMs: 30 };

function setup() {
  const adapter = new FakeAdapter();
  const notices: TurnTerminalNotice[] = [];
  const registry = new SessionRegistry(adapter, new Map([["repo", "/safe/repo"]]), {
    ...deadlines,
    onTurnTerminal(event) { notices.push(event); supervisor.notice(event); },
  });
  const supervisor = new DeadlineSupervisor(registry, { maxTurnSeconds: 60 });
  return { adapter, registry, supervisor, notices };
}

async function running() {
  const context = setup();
  const session = await context.registry.start("repo", profile);
  const { turn } = await context.supervisor.prompt(session.id, "deadline fixture");
  const handle = context.adapter.handles[0]!;
  return { ...context, session, turn, handle };
}

function gate(handle: FakeHandle) {
  let release!: () => void;
  handle.abortGate = new Promise<void>((resolve) => { release = resolve; });
  return release;
}

async function advance(milliseconds: number) {
  await vi.advanceTimersByTimeAsync(milliseconds);
  await Promise.resolve();
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] }); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("development-only turn deadline", () => {
  it("parses only integers within bounds", () => {
    expect(MAX_TURN_SECONDS_MIN).toBe(60);
    expect(MAX_TURN_SECONDS_MAX).toBe(86_400);
    expect(parseMaxTurnSeconds(60)).toBe(60);
    expect(parseMaxTurnSeconds(86_400)).toBe(86_400);
    expect(parseMaxTurnSeconds(undefined)).toBeUndefined();
    for (const value of [0, 59, 86_401, 60.5, "60", NaN, null, Infinity, {}, true]) {
      expect(() => parseMaxTurnSeconds(value)).toThrow("invalid_max_turn_seconds");
    }
    expect(86_400 * 1000).toBeLessThan(2 ** 31 - 1);
    expect(() => new DeadlineSupervisor(setup().registry, { maxTurnSeconds: 60.5 })).toThrow("invalid_max_turn_seconds");
  });

  it("does nothing when the turn completes before the deadline", async () => {
    const s = await running();
    await advance(59_000);
    s.handle.complete();
    await advance(0);
    await advance(61_000);
    expect(s.registry.getTurn(s.session.id, s.turn.turnId).state).toBe("completed");
    expect(s.handle.aborted).toBe(0);
    expect(s.supervisor.expiries()).toEqual([]);
    expect(s.notices).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("completion one tick before expiry wins", async () => {
    const s = await running();
    await advance(59_999);
    s.handle.complete();
    await advance(1);
    expect(s.registry.getTurn(s.session.id, s.turn.turnId).state).toBe("completed");
    expect(s.handle.aborted).toBe(0);
    expect(s.supervisor.expiries()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("completion at the deadline wins when its callback runs first", async () => {
    const s = setup();
    const session = await s.registry.start("repo", profile);
    setTimeout(() => s.adapter.handles[0]!.complete(), 60_000);
    const { turn } = await s.supervisor.prompt(session.id, "same-instant completion");
    await advance(60_000);
    expect(s.registry.getTurn(session.id, turn.turnId).state).toBe("completed");
    expect(s.adapter.handles[0]!.aborted).toBe(0);
    expect(s.supervisor.expiries()).toEqual([]);
    expect(s.notices).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("expiry aborts exactly once", async () => {
    const s = await running();
    await advance(60_000);
    expect(s.registry.getTurn(s.session.id, s.turn.turnId).state).toBe("aborted");
    expect(s.supervisor.expiries()).toEqual([{ sessionId: s.session.id, turnId: s.turn.turnId, outcome: "aborted" }]);
    expect(s.supervisor.usable(s.session.id)).toBe(true);
    await advance(120_000);
    expect(s.handle.aborted).toBe(1);
    expect(s.notices).toEqual([{ sessionId: s.session.id, turnId: s.turn.turnId, state: "aborted", via: "registry" }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("completion during the expiry abort stays completed", async () => {
    const s = await running();
    const release = gate(s.handle);
    s.handle.abortSettlesPrompt = false;
    await advance(60_000);
    s.handle.complete();
    await advance(0);
    release();
    await advance(0);
    expect(s.registry.getTurn(s.session.id, s.turn.turnId).state).toBe("completed");
    expect(s.supervisor.expiries()).toEqual([{ sessionId: s.session.id, turnId: s.turn.turnId, outcome: "settled_first" }]);
    expect(s.notices).toHaveLength(1);
    expect(s.handle.aborted).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("manual abort before expiry cancels the deadline", async () => {
    const s = await running();
    await advance(30_000);
    await s.registry.abort(s.session.id);
    await advance(90_000);
    expect(s.handle.aborted).toBe(1);
    expect(s.supervisor.expiries()).toEqual([]);
    expect(s.notices).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("manual abort during expiry is coalesced", async () => {
    const s = await running();
    const release = gate(s.handle);
    await advance(60_000);
    const manual = s.registry.abort(s.session.id);
    await advance(0);
    expect(s.handle.aborted).toBe(1);
    release();
    await manual;
    await advance(0);
    expect(s.handle.aborted).toBe(1);
    expect(s.notices).toHaveLength(1);
    expect(s.supervisor.expiries()[0]?.outcome).toBe("aborted");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a rejected expiry abort claims nothing", async () => {
    const s = await running();
    s.handle.abortError = new Error("synthetic abort rejection");
    await advance(60_000);
    expect(s.supervisor.expiries()[0]?.outcome).toBe("abort_failed");
    expect(s.registry.getTurn(s.session.id, s.turn.turnId).state).toBe("running");
    expect(s.registry.get(s.session.id).state).toBe("running");
    expect(s.notices).toEqual([]);
    expect(s.supervisor.usable(s.session.id)).toBe(false);
    await expect(s.supervisor.prompt(s.session.id, "refused")).rejects.toThrow("turn_deadline_uncertain");
    // Today's close marks the turn aborted even if its own abort also rejects.
    await expect(s.registry.close(s.session.id)).resolves.toMatchObject({ state: "closed" });
    expect(s.notices).toEqual([{ sessionId: s.session.id, turnId: s.turn.turnId, state: "aborted", via: "close" }]);
    expect(s.supervisor.usable(s.session.id)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an unexpected expiry read failure records uncertainty without an unhandled rejection", async () => {
    const s = await running();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const getTurn = vi.spyOn(s.registry, "getTurn").mockImplementation(() => { throw new RegistryError("unknown_turn"); });
    try {
      await advance(60_000);
      expect(unhandled).not.toHaveBeenCalled();
      expect(s.supervisor.expiries()).toEqual([{ sessionId: s.session.id, turnId: s.turn.turnId, outcome: "abort_failed" }]);
      expect(s.supervisor.usable(s.session.id)).toBe(false);
      await expect(s.supervisor.prompt(s.session.id, "refused")).rejects.toThrow("turn_deadline_uncertain");
      expect(s.handle.aborted).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      await advance(60_000);
      expect(s.supervisor.expiries()).toHaveLength(1);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      getTurn.mockRestore();
      process.off("unhandledRejection", unhandled);
    }
  });

  it("an expiry abort timeout claims nothing until it settles", async () => {
    const s = await running();
    const release = gate(s.handle);
    await advance(60_000 + deadlines.abortDeadlineMs);
    expect(s.supervisor.expiries()[0]?.outcome).toBe("abort_timeout");
    expect(s.registry.getTurn(s.session.id, s.turn.turnId).state).toBe("running");
    expect(s.notices).toEqual([]);
    expect(s.supervisor.usable(s.session.id)).toBe(false);
    await expect(s.supervisor.prompt(s.session.id, "refused")).rejects.toThrow("turn_deadline_uncertain");
    release();
    await advance(0);
    expect(s.registry.getTurn(s.session.id, s.turn.turnId).state).toBe("aborted");
    expect(s.notices).toHaveLength(1);
    expect(s.handle.aborted).toBe(1);
    expect(s.supervisor.expiries()[0]?.outcome).toBe("abort_timeout");
    expect(s.supervisor.usable(s.session.id)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a close notice before expiry clears the deadline", async () => {
    const s = setup();
    const session = await s.registry.start("repo", profile);
    let closing!: Promise<unknown>;
    // Register close first at the same timer instant as expiry.
    setTimeout(() => { closing = s.registry.close(session.id); }, 60_000);
    const { turn } = await s.supervisor.prompt(session.id, "close race");
    await advance(60_000);
    await closing;
    expect(s.notices).toEqual([{ sessionId: session.id, turnId: turn.turnId, state: "aborted", via: "close" }]);
    expect(s.adapter.handles[0]!.aborted).toBe(1);
    expect(s.supervisor.expiries()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shutdown before expiry clears the deadline", async () => {
    const s = await running();
    const second = await s.registry.start("repo", profile);
    const secondTurn = (await s.supervisor.prompt(second.id, "parallel shutdown")).turn;
    const abort = vi.spyOn(s.registry, "abort");
    await s.registry.shutdown();
    expect(vi.getTimerCount()).toBe(0);
    await advance(60_001);
    expect(abort).not.toHaveBeenCalled();
    expect(s.notices).toEqual([
      { sessionId: s.session.id, turnId: s.turn.turnId, state: "aborted", via: "close" },
      { sessionId: second.id, turnId: secondTurn.turnId, state: "aborted", via: "close" },
    ]);
    expect(s.adapter.handles.map((handle) => handle.aborted)).toEqual([1, 1]);
    expect(s.supervisor.expiries()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    abort.mockRestore();
  });

  it("shutdown racing expiry yields one notice per turn", async () => {
    const s = await running();
    const second = await s.registry.start("repo", profile);
    const secondTurn = (await s.supervisor.prompt(second.id, "parallel shutdown")).turn;
    const release = s.adapter.handles.map(gate);
    await advance(60_000);
    const shutdown = s.registry.shutdown();
    await advance(0);
    expect(s.notices).toEqual([
      { sessionId: s.session.id, turnId: s.turn.turnId, state: "aborted", via: "close" },
      { sessionId: second.id, turnId: secondTurn.turnId, state: "aborted", via: "close" },
    ]);
    release.forEach((resolve) => resolve());
    await advance(0);
    await shutdown;
    expect(s.notices).toHaveLength(2);
    expect(s.adapter.handles.map((handle) => handle.aborted)).toEqual([1, 1]);
    expect(s.registry.list()).toEqual([]);
    expect(s.supervisor.expiries().map((expiry) => expiry.outcome)).toEqual(["settled_first", "settled_first"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a parallel session is unaffected", async () => {
    const s = await running();
    await advance(30_000);
    const second = await s.registry.start("repo", profile);
    const secondTurn = (await s.supervisor.prompt(second.id, "parallel turn")).turn;
    await advance(30_001);
    expect(s.handle.aborted).toBe(1);
    expect(s.registry.getTurn(second.id, secondTurn.turnId).state).toBe("running");
    expect(s.adapter.handles[1]!.aborted).toBe(0);
    expect(s.notices.filter((notice) => notice.sessionId === second.id)).toEqual([]);
    s.adapter.handles[1]!.complete();
    await advance(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([3_600_000, -3_600_000])("a wall-clock jump of %i ms does not move the deadline", async (jump) => {
    const s = await running();
    await advance(10_000);
    vi.setSystemTime(Date.now() + jump);
    await advance(49_999);
    expect(s.handle.aborted).toBe(0);
    expect(s.supervisor.expiries()).toEqual([]);
    await advance(1);
    expect(s.handle.aborted).toBe(1);
    expect(s.supervisor.expiries()[0]?.outcome).toBe("aborted");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("anchors the deadline at publication rather than admission", async () => {
    const s = setup();
    s.adapter.plans.push({ manualPreflight: true });
    const session = await s.registry.start("repo", profile);
    const prompting = s.supervisor.prompt(session.id, "delayed preflight");
    await advance(5);
    s.adapter.handles[0]!.signalPreflight(true);
    await prompting;
    await advance(59_999);
    expect(s.adapter.handles[0]!.aborted).toBe(0);
    await advance(1);
    expect(s.adapter.handles[0]!.aborted).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not arm a deadline for a turn already terminal at publication", async () => {
    const s = setup();
    s.adapter.plans.push({ synchronous: true });
    const session = await s.registry.start("repo", profile);
    await s.supervisor.prompt(session.id, "immediate completion");
    expect(vi.getTimerCount()).toBe(0);
    await advance(60_000);
    expect(s.adapter.handles[0]!.aborted).toBe(0);
    expect(s.supervisor.expiries()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

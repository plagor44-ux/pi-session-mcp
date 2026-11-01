import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRegistry, type TurnTerminalNotice } from "../src/session-registry.js";
import { FakeAdapter, type FakeHandle } from "./fake-adapter.js";

const profile = { alias: "safe", permissionProfile: "read-only" as const, provider: "fake-provider", model: "fake-model", thinkingLevel: "off" as const, maxTurnSeconds: 60 };
const advance = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); };
function gate(handle: FakeHandle) { let release!: () => void; handle.abortGate = new Promise<void>(resolve => { release = resolve; }); return release; }
function setup() {
  const adapter = new FakeAdapter();
  const notices: TurnTerminalNotice[] = [];
  const registry = new SessionRegistry(adapter, new Map([["repo", "/safe/repo"]]), { abortDeadlineMs: 10, preflightDeadlineMs: 10, closeCleanupDeadlineMs: 10, onTurnTerminal: event => notices.push(event) });
  return { adapter, registry, notices };
}
async function running() { const s = setup(); const session = await s.registry.start("repo", profile); const { turn } = await s.registry.prompt(session.id, "fixture"); return { ...s, session, turn, handle: s.adapter.handles[0]! }; }
beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] }); });
afterEach(() => { vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers(); });
describe("registry turn deadline", () => {
  it.each([0, 59_999, 60_000])("completion at %i wins when registered first", async ms => {
    const s = setup(); const session = await s.registry.start("repo", profile);
    setTimeout(() => s.adapter.handles[0]!.complete(), ms);
    const { turn } = await s.registry.prompt(session.id, "fixture");
    await advance(120_000);
    expect(s.registry.getTurn(session.id, turn.turnId)).toMatchObject({ state: "completed" });
    expect(s.adapter.handles[0]!.aborted).toBe(0); expect(s.notices).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("expiry aborts once, attributes the reason, and permits successive turns", async () => {
    const s = await running(); await advance(60_000);
    expect(s.registry.getTurn(s.session.id, s.turn.turnId)).toMatchObject({ state: "aborted", abortReason: "deadline" });
    expect(s.notices).toEqual([{ sessionId: s.session.id, turnId: s.turn.turnId, state: "aborted", via: "registry" }]);
    await s.registry.prompt(s.session.id, "second"); await advance(59_999); expect(s.handle.aborted).toBe(1);
    await advance(1); expect(s.handle.aborted).toBe(2); expect(s.notices).toHaveLength(2); expect(vi.getTimerCount()).toBe(0);
  });
  it("completion during abort wins without a reason", async () => {
    const s = await running(); const release = gate(s.handle); s.handle.abortSettlesPrompt = false;
    await advance(60_000); s.handle.complete(); await advance(0); release(); await advance(0);
    expect(s.registry.getTurn(s.session.id, s.turn.turnId)).toMatchObject({ state: "completed" });
    expect(s.registry.getTurn(s.session.id, s.turn.turnId)).not.toHaveProperty("abortReason"); expect(s.notices).toHaveLength(1);
  });
  it.each([59_999, 60_000])("manual abort at %i coalesces, with first initiator attribution", async ms => {
    const s = await running(); const release = gate(s.handle); await advance(ms);
    const manual = s.registry.abort(s.session.id); await advance(60_000 - ms); release(); await manual; await advance(0);
    expect(s.handle.aborted).toBe(1); expect(s.notices).toHaveLength(1);
    expect(s.registry.getTurn(s.session.id, s.turn.turnId).abortReason).toBe(ms === 60_000 ? "deadline" : undefined);
  });
  it("manual abort before expiry clears the timer", async () => {
    const s = await running(); await s.registry.abort(s.session.id); await advance(120_000);
    expect(s.handle.aborted).toBe(1); expect(s.registry.getTurn(s.session.id, s.turn.turnId)).not.toHaveProperty("abortReason"); expect(vi.getTimerCount()).toBe(0);
  });
  it("rejected abort claims nothing, refuses running first, then uncertainty after settlement", async () => {
    const s = await running(); s.handle.abortError = new Error("fixture"); await advance(60_000);
    expect(s.registry.getTurn(s.session.id, s.turn.turnId).state).toBe("running"); expect(s.notices).toEqual([]);
    await expect(s.registry.prompt(s.session.id, "refused")).rejects.toMatchObject({ code: "session_running" });
    s.handle.complete(); await advance(0);
    await expect(s.registry.prompt(s.session.id, "refused")).rejects.toMatchObject({ code: "turn_deadline_uncertain" });
    await expect(s.registry.close(s.session.id)).resolves.toMatchObject({ state: "closed" });
  });
  it("timeout uses the handle abort deadline; late success does not restore reuse", async () => {
    const s = await running(); Object.assign(s.handle, { deadlines: { abortMs: 25 } }); const release = gate(s.handle);
    await advance(60_024); expect(s.notices).toEqual([]);
    await advance(1); await expect(s.registry.prompt(s.session.id, "refused")).rejects.toMatchObject({ code: "session_running" });
    release(); await advance(0);
    expect(s.registry.getTurn(s.session.id, s.turn.turnId)).toMatchObject({ state: "aborted", abortReason: "deadline" });
    await expect(s.registry.prompt(s.session.id, "refused")).rejects.toMatchObject({ code: "turn_deadline_uncertain" }); expect(s.notices).toHaveLength(1);
  });
  it("a named abort deadline longer than the registry default allows confirmed reuse", async () => {
    const s = await running(); Object.assign(s.handle, { deadlines: { abortMs: 25 } }); const release = gate(s.handle);
    await advance(60_024); release(); await advance(0);
    await expect(s.registry.prompt(s.session.id, "reusable")).resolves.toBeDefined();
  });
  it("writer loss takes precedence over running and deadline uncertainty", async () => {
    const s = await running(); s.handle.abortError = new Error("fixture"); await advance(60_000);
    Object.assign(s.handle, { isLost: () => true });
    await expect(s.registry.prompt(s.session.id, "refused")).rejects.toMatchObject({ code: "writer_session_lost" });
    s.handle.complete(); await advance(0);
    await expect(s.registry.prompt(s.session.id, "refused")).rejects.toMatchObject({ code: "writer_session_lost" });
  });
  it("immediate completion clears the publication timer", async () => {
    const s = setup(); s.adapter.plans.push({ synchronous: true }); const session = await s.registry.start("repo", profile);
    await s.registry.prompt(session.id, "immediate"); expect(vi.getTimerCount()).toBe(0); await advance(60_000); expect(s.adapter.handles[0]!.aborted).toBe(0);
  });
  it("close during pending expiry joins the abort", async () => {
    const s = await running(); const release = gate(s.handle); await advance(60_000); const closing = s.registry.close(s.session.id);
    await advance(0); release(); await closing; await advance(120_000); expect(s.handle.aborted).toBe(1); expect(s.notices).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  });
  it.each([false, true])("close or shutdown before expiry clears timers: shutdown=%s", async shutdown => {
    const s = await running(); if (shutdown) await s.registry.shutdown(); else await s.registry.close(s.session.id);
    expect(vi.getTimerCount()).toBe(0);
    await advance(120_000); expect(s.handle.aborted).toBe(1); expect(s.notices).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("shutdown racing expiry settles once", async () => {
    const s = await running(); const release = gate(s.handle); await advance(60_000); const shutdown = s.registry.shutdown(); await advance(0); release(); await shutdown;
    expect(s.handle.aborted).toBe(1); expect(s.notices).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("a parallel session is unaffected", async () => {
    const s = await running(); await advance(30_000); const second = await s.registry.start("repo", profile); const { turn } = await s.registry.prompt(second.id, "parallel");
    await advance(30_000); expect(s.handle.aborted).toBe(1); expect(s.registry.getTurn(second.id, turn.turnId).state).toBe("running"); expect(s.adapter.handles[1]!.aborted).toBe(0);
  });
  it.each([3_600_000, -3_600_000])("wall clock jump %i leaves monotonic deadline unchanged", async jump => {
    const s = await running(); await advance(10_000); vi.setSystemTime(Date.now() + jump); await advance(49_999); expect(s.handle.aborted).toBe(0); await advance(1); expect(s.handle.aborted).toBe(1);
  });
  it("anchors at publication, not admission", async () => {
    const s = setup(); s.adapter.plans.push({ manualPreflight: true }); const session = await s.registry.start("repo", profile);
    const prompt = s.registry.prompt(session.id, "fixture"); await advance(5); s.adapter.handles[0]!.signalPreflight(true); await prompt;
    await advance(59_999); expect(s.adapter.handles[0]!.aborted).toBe(0); await advance(1); expect(s.adapter.handles[0]!.aborted).toBe(1);
  });
  it("unrefs its timer and re-arms an early firing for the remainder", async () => {
    const timeout = vi.spyOn(globalThis, "setTimeout"); const s = await running();
    const index = timeout.mock.calls.findIndex(call => call[1] === 60_000); const timer = timeout.mock.results[index]!.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false); const callback = timeout.mock.calls[index]![0] as () => void;
    clearTimeout(timer); await advance(10_000); callback(); await advance(49_999); expect(s.handle.aborted).toBe(0); await advance(1); expect(s.handle.aborted).toBe(1);
  });
  it.each(["completed", "aborted"] as const)("snapshot %s finalization is not bounded by expiry's abort deadline", async outcome => {
    const adapter = new FakeAdapter(); let verifyCount = 0;
    const guard = { isSnapshot: () => true, acquire: async () => ({ binding: { base: "a", head: "b", tree: "c" }, verify: async () => { if (++verifyCount === 2) await new Promise<void>(resolve => setTimeout(resolve, 100)); }, release: async () => {} }) };
    const registry = new SessionRegistry(adapter, new Map([["repo", "/safe/repo"]]), { snapshotGuard: guard, abortDeadlineMs: 10 });
    const session = await registry.start("repo", profile); const { turn } = await registry.prompt(session.id, "fixture"); const handle = adapter.handles[0]!;
    if (outcome === "completed") { await advance(59_950); handle.complete(); await advance(50); expect(handle.aborted).toBe(0); }
    else { await advance(60_000); expect(handle.aborted).toBe(1); }
    await advance(101); expect(registry.getTurn(session.id, turn.turnId).state).toBe(outcome);
    await expect(registry.prompt(session.id, "reusable")).resolves.toBeDefined(); await registry.close(session.id);
  });
  it("absent limit and relayed placement never arm a timer", async () => {
    const s = setup(); const { maxTurnSeconds: _, ...unlimited } = profile; const session = await s.registry.start("repo", unlimited); await s.registry.prompt(session.id, "fixture"); expect(vi.getTimerCount()).toBe(0);
    const other = await s.registry.start("repo", profile); Object.assign(s.adapter.handles[1]!, { placement: { writer: "repo-w1", base: { ref: "main", commit: "a" } } });
    await s.registry.prompt(other.id, "fixture"); await advance(120_000); expect(s.adapter.handles.map(h => h.aborted)).toEqual([0, 0]); expect(vi.getTimerCount()).toBe(0);
  });
});

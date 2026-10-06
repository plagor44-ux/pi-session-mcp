import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_CLOSED_TOMBSTONES, SessionRegistry } from "../src/session-registry.js";
import { FakeAdapter } from "./fake-adapter.js";

const profile = { alias: "safe", permissionProfile: "read-only" as const, provider: "fake-provider", model: "fake-model", thinkingLevel: "off" as const };
const deadlines = { preflightDeadlineMs: 10, abortDeadlineMs: 10, closeCleanupDeadlineMs: 10, shutdownDeadlineMs: 30 };

function setup() {
  const adapter = new FakeAdapter();
  return { adapter, registry: new SessionRegistry(adapter, new Map([["repo", "/safe/repo"]]), deadlines) };
}

async function advance(milliseconds: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(milliseconds);
  await Promise.resolve();
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("Phase 2.1 lifecycle deadlines", () => {
  it("times out missing preflight, publishes no turn, starts best-effort abort, and blocks another prompt", async () => {
    vi.useFakeTimers();
    const { adapter, registry } = setup();
    adapter.plans.push({ manualPreflight: true });
    const session = await registry.start("repo", profile);
    adapter.handles[0]!.abortGate = new Promise<void>(() => undefined);
    const prompting = registry.prompt(session.id, "PRIVATE_PROMPT_SENTINEL");
    const expectation = expect(prompting).rejects.toMatchObject({ code: "prompt_timeout", message: "Pi prompt preflight timed out" });
    await advance(deadlines.preflightDeadlineMs);
    await expectation;
    expect(adapter.handles[0]?.aborted).toBe(1);
    expect(registry.get(session.id).state).toBe("running");
    await expect(registry.prompt(session.id, "second")).rejects.toMatchObject({ code: "session_running" });
    expect(() => registry.getTurn(session.id, crypto.randomUUID())).toThrow(expect.objectContaining({ code: "unknown_turn" }));
  });

  it("releases an unpublished preflight quarantine after successful automatic abort", async () => {
    vi.useFakeTimers();
    const { adapter, registry } = setup();
    adapter.plans.push({ manualPreflight: true });
    const session = await registry.start("repo", profile);
    const prompting = registry.prompt(session.id, "automatic abort");
    const expectation = expect(prompting).rejects.toMatchObject({ code: "prompt_timeout" });
    await advance(deadlines.preflightDeadlineMs);
    await expectation;
    await advance(0);
    expect(registry.get(session.id).state).toBe("idle");
    expect(adapter.handles[0]!.aborted).toBe(1);
    expect(() => registry.getTurn(session.id, crypto.randomUUID())).toThrow(expect.objectContaining({ code: "unknown_turn" }));
    await registry.close(session.id);
    expect(adapter.handles[0]!.aborted).toBe(1);
  });

  it("keeps preflight quarantined when abort resolves before the prompt operation settles", async () => {
    vi.useFakeTimers();
    const { adapter, registry } = setup();
    adapter.plans.push({ manualPreflight: true });
    const session = await registry.start("repo", profile);
    const handle = adapter.handles[0]!;
    handle.abortSettlesPrompt = false;
    const prompting = registry.prompt(session.id, "preflight still pending");
    const expectation = expect(prompting).rejects.toMatchObject({ code: "prompt_timeout" });
    await advance(deadlines.preflightDeadlineMs);
    await expectation;
    await advance(0);
    expect(handle.aborted).toBe(1);
    expect(registry.get(session.id).state).toBe("running");
    await expect(registry.prompt(session.id, "must remain blocked")).rejects.toMatchObject({ code: "session_running" });
    await expect(registry.abort(session.id)).resolves.toMatchObject({ state: "running" });
    expect(handle.aborted).toBe(1);

    handle.signalPreflight(true);
    handle.complete("late completion must remain unpublished");
    await advance(0);
    expect(registry.get(session.id).state).toBe("idle");
    expect(() => registry.getTurn(session.id, crypto.randomUUID())).toThrow(expect.objectContaining({ code: "unknown_turn" }));
  });

  it("waits for a pending automatic abort after the late prompt settles, then admits work without publishing the late turn", async () => {
    vi.useFakeTimers();
    const { adapter, registry } = setup();
    adapter.plans.push({ manualPreflight: true });
    const session = await registry.start("repo", profile);
    let releaseAbort!: () => void;
    const handle = adapter.handles[0]!;
    handle.abortGate = new Promise<void>((resolve) => { releaseAbort = resolve; });
    const prompting = registry.prompt(session.id, "late normal completion");
    const expectation = expect(prompting).rejects.toMatchObject({ code: "prompt_timeout" });
    await advance(deadlines.preflightDeadlineMs);
    await expectation;
    handle.complete("must never be published");
    await advance(0);
    expect(registry.get(session.id).state).toBe("running");
    releaseAbort();
    await advance(0);
    expect(registry.get(session.id).state).toBe("idle");
    expect(handle.aborted).toBe(1);
    expect(() => registry.getTurn(session.id, crypto.randomUUID())).toThrow(expect.objectContaining({ code: "unknown_turn" }));
    const nextPrompt = registry.prompt(session.id, "safe next turn");
    await advance(0);
    handle.signalPreflight(true);
    const next = await nextPrompt;
    expect(next.turn.state).toBe("running");
  });

  it("closes a timed-out preflight without a second concurrent abort and ignores late settlement", async () => {
    vi.useFakeTimers();
    const { adapter, registry } = setup();
    adapter.plans.push({ manualPreflight: true });
    const session = await registry.start("repo", profile);
    let releaseAbort!: () => void;
    adapter.handles[0]!.abortGate = new Promise<void>((resolve) => { releaseAbort = resolve; });
    const prompting = registry.prompt(session.id, "late");
    const expectation = expect(prompting).rejects.toMatchObject({ code: "prompt_timeout" });
    await advance(deadlines.preflightDeadlineMs);
    await expectation;
    const closing = registry.close(session.id);
    await advance(deadlines.closeCleanupDeadlineMs);
    await expect(closing).resolves.toMatchObject({ state: "closed" });
    expect(adapter.handles[0]!.aborted).toBe(1);
    adapter.handles[0]!.signalPreflight(true);
    adapter.handles[0]!.complete("late completion");
    releaseAbort();
    await advance(0);
    expect(registry.list()).toEqual([]);
    expect(adapter.handles[0]!.disposeCalls).toBe(1);
  });

  it("observes a late prompt rejection after the preflight deadline", async () => {
    vi.useFakeTimers();
    const { adapter, registry } = setup();
    adapter.plans.push({ manualPreflight: true });
    const session = await registry.start("repo", profile);
    adapter.handles[0]!.abortGate = new Promise<void>(() => undefined);
    const prompting = registry.prompt(session.id, "late reject");
    const expectation = expect(prompting).rejects.toMatchObject({ code: "prompt_timeout" });
    await advance(deadlines.preflightDeadlineMs);
    await expectation;
    adapter.handles[0]!.rejectPrompt(new Error("PRIVATE_LATE_PROVIDER_DETAIL"));
    await advance(0);
    expect(registry.get(session.id).state).toBe("running");
  });

  it("returns abort_timeout without claiming success and accepts later normal completion", async () => {
    vi.useFakeTimers();
    const { adapter, registry } = setup();
    const session = await registry.start("repo", profile);
    const accepted = await registry.prompt(session.id, "abort timeout");
    let releaseAbort!: () => void;
    adapter.handles[0]!.abortGate = new Promise<void>((resolve) => { releaseAbort = resolve; });
    const aborting = registry.abort(session.id);
    const expectation = expect(aborting).rejects.toMatchObject({ code: "abort_timeout", message: "Pi abort timed out" });
    await advance(deadlines.abortDeadlineMs);
    await expectation;
    expect(registry.getTurn(session.id, accepted.turn.turnId).state).toBe("running");
    adapter.handles[0]!.complete("normal completion won");
    await advance(0);
    expect(registry.getTurn(session.id, accepted.turn.turnId)).toMatchObject({ state: "completed", assistantText: "normal completion won" });
    releaseAbort();
    await advance(0);
    expect(registry.getTurn(session.id, accepted.turn.turnId).state).toBe("completed");
  });

  it("allows a late successful abort to terminalize once through the prompt outcome", async () => {
    vi.useFakeTimers();
    const { adapter, registry } = setup();
    const session = await registry.start("repo", profile);
    const accepted = await registry.prompt(session.id, "late abort");
    let releaseAbort!: () => void;
    adapter.handles[0]!.abortGate = new Promise<void>((resolve) => { releaseAbort = resolve; });
    const aborting = registry.abort(session.id);
    const expectation = expect(aborting).rejects.toMatchObject({ code: "abort_timeout" });
    await advance(deadlines.abortDeadlineMs);
    await expectation;
    releaseAbort();
    await advance(0);
    expect(registry.getTurn(session.id, accepted.turn.turnId).state).toBe("aborted");
    expect(registry.get(session.id).state).toBe("idle");
  });

  it("contains a late abort rejection without overwriting normal completion", async () => {
    vi.useFakeTimers();
    const { adapter, registry } = setup();
    const session = await registry.start("repo", profile);
    const accepted = await registry.prompt(session.id, "late abort rejection");
    let releaseAbort!: () => void;
    const handle = adapter.handles[0]!;
    handle.abortGate = new Promise<void>((resolve) => { releaseAbort = resolve; });
    handle.abortError = new Error("PRIVATE_ABORT_DETAIL");
    const aborting = registry.abort(session.id);
    const expectation = expect(aborting).rejects.toMatchObject({ code: "abort_timeout" });
    await advance(deadlines.abortDeadlineMs);
    await expectation;
    handle.complete("completed safely");
    releaseAbort();
    await advance(0);
    expect(registry.getTurn(session.id, accepted.turn.turnId)).toMatchObject({ state: "completed", assistantText: "completed safely" });
  });

  it("bounds close during a hanging turn, contains dispose failure, and never revives the session", async () => {
    vi.useFakeTimers();
    const { adapter, registry } = setup();
    const session = await registry.start("repo", profile);
    await registry.prompt(session.id, "close hanging turn");
    const handle = adapter.handles[0]!;
    handle.abortGate = new Promise<void>(() => undefined);
    handle.disposeError = new Error("PRIVATE_DISPOSE_DETAIL");
    const closing = registry.close(session.id);
    await advance(deadlines.closeCleanupDeadlineMs);
    await expect(closing).resolves.toMatchObject({ state: "closed" });
    expect(handle.disposeCalls).toBe(1);
    expect(registry.list()).toEqual([]);
    handle.complete("late completion");
    await advance(0);
    expect(registry.list()).toEqual([]);
    await expect(registry.close(session.id)).resolves.toMatchObject({ state: "closed" });
    expect(handle.disposeCalls).toBe(1);
  });

  it("bounds shutdown with a hanging session and removes it", async () => {
    vi.useFakeTimers();
    const { adapter, registry } = setup();
    const session = await registry.start("repo", profile);
    await registry.prompt(session.id, "shutdown hanging turn");
    adapter.handles[0]!.abortGate = new Promise<void>(() => undefined);
    const shutdown = registry.shutdown();
    await advance(deadlines.closeCleanupDeadlineMs);
    await expect(shutdown).resolves.toBeUndefined();
    expect(registry.list()).toEqual([]);
    expect(adapter.handles[0]!.disposeCalls).toBe(1);
  });

  it("coalesces overlapping aborts and lets shutdown remove the session without queue amplification", async () => {
    vi.useFakeTimers();
    const { adapter, registry } = setup();
    const session = await registry.start("repo", profile);
    await registry.prompt(session.id, "overlapping aborts");
    adapter.handles[0]!.abortGate = new Promise<void>(() => undefined);
    const first = registry.abort(session.id);
    const second = registry.abort(session.id);
    const firstExpectation = expect(first).rejects.toMatchObject({ code: "abort_timeout" });
    const secondExpectation = expect(second).rejects.toMatchObject({ code: "abort_timeout" });
    const shutdown = registry.shutdown();
    await advance(deadlines.closeCleanupDeadlineMs);
    await firstExpectation;
    await secondExpectation;
    await expect(shutdown).resolves.toBeUndefined();
    expect(adapter.handles[0]!.aborted).toBe(1);
    expect(adapter.handles[0]!.disposeCalls).toBe(1);
    expect(registry.list()).toEqual([]);
  });

  it("does not lose an abort invoked concurrently with prompt admission", async () => {
    const { adapter, registry } = setup();
    const session = await registry.start("repo", profile);
    const prompting = registry.prompt(session.id, "prompt-abort race");
    const aborting = registry.abort(session.id);
    const accepted = await prompting;
    await expect(aborting).resolves.toMatchObject({ state: "idle" });
    expect(adapter.handles[0]!.aborted).toBe(1);
    expect(registry.getTurn(session.id, accepted.turn.turnId).state).toBe("aborted");
  });

  it("rejects starts during shutdown and disposes a handle that resolves after the shutdown deadline", async () => {
    vi.useFakeTimers();
    const { adapter, registry } = setup();
    let releaseCreation!: () => void;
    adapter.plans.push({ creationGate: new Promise<void>((resolve) => { releaseCreation = resolve; }) });
    const starting = registry.start("repo", profile);
    const startExpectation = expect(starting).rejects.toMatchObject({ code: "server_stopping", message: "Server is shutting down" });
    await advance(0);
    const shutdown = registry.shutdown();
    await expect(registry.start("repo", profile)).rejects.toMatchObject({ code: "server_stopping" });
    await advance(deadlines.shutdownDeadlineMs);
    await expect(shutdown).resolves.toBeUndefined();
    expect(registry.list()).toEqual([]);
    releaseCreation();
    await advance(0);
    await startExpectation;
    expect(adapter.handles).toHaveLength(1);
    expect(adapter.handles[0]!.disposeCalls).toBe(1);
    expect(registry.list()).toEqual([]);
  });
});

describe("closed-session tombstones and sanitized errors", () => {
  it("stores no turn data in a closed tombstone", async () => {
    const { adapter, registry } = setup();
    const session = await registry.start("repo", profile);
    const accepted = await registry.prompt(session.id, "tombstone prompt");
    adapter.handles[0]!.complete("PRIVATE_TOMBSTONE_OUTPUT");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(registry.getTurn(session.id, accepted.turn.turnId).state).toBe("completed");
    const closed = await registry.close(session.id);
    expect(JSON.stringify(closed)).not.toMatch(/turnId|assistantText|PRIVATE_TOMBSTONE_OUTPUT/);
    expect(await registry.close(session.id)).toEqual(closed);
  });

  it("retains exactly the FIFO limit, keeps close idempotent inside it, and evicts the oldest completely", async () => {
    const { registry } = setup();
    const ids: string[] = [];
    for (let index = 0; index <= MAX_CLOSED_TOMBSTONES; index += 1) {
      const session = await registry.start("repo", profile);
      ids.push(session.id);
      await registry.close(session.id);
    }
    await expect(registry.close(ids[0]!)).rejects.toMatchObject({ code: "unknown_session", message: "Unknown session" });
    await expect(registry.close(ids[1]!)).resolves.toMatchObject({ id: ids[1], state: "closed" });
    await expect(registry.close(ids.at(-1)!)).resolves.toMatchObject({ id: ids.at(-1), state: "closed" });
  });

  it("never repeats workspace, session, or turn input sentinels in public errors", async () => {
    const { registry } = setup();
    const workspace = "valid-but-unknown";
    await expect(registry.start(workspace, profile)).rejects.toMatchObject({ code: "unknown_workspace", message: "Unknown workspace" });
    try { await registry.start(workspace, profile); } catch (error) { expect(String(error)).not.toContain(workspace); }
    const sessionSentinel = "PRIVATE_SESSION_SENTINEL";
    expect(() => registry.get(sessionSentinel)).toThrow(expect.objectContaining({ code: "unknown_session", message: "Unknown session" }));
    try { registry.get(sessionSentinel); } catch (error) { expect(String(error)).not.toContain(sessionSentinel); }
    const session = await registry.start("repo", profile);
    const turnSentinel = "PRIVATE_TURN_SENTINEL";
    expect(() => registry.getTurn(session.id, turnSentinel)).toThrow(expect.objectContaining({ code: "unknown_turn", message: "Unknown turn" }));
    try { registry.getTurn(session.id, turnSentinel); } catch (error) { expect(String(error)).not.toContain(turnSentinel); }
  });
});

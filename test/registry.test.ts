import { describe, expect, it, vi } from "vitest";
import { SessionRegistry, type SessionRegistryOptions } from "../src/session-registry.js";
import { FakeAdapter } from "./fake-adapter.js";
import type { PiSessionHandle } from "../src/pi-adapter.js";

const readOnlyProfile = { alias: "safe", permissionProfile: "read-only" as const, provider: "fake-provider", model: "fake-model", thinkingLevel: "off" as const };
const codingProfile = { alias: "coding", permissionProfile: "coding" as const, provider: "fake-provider", model: "fake-model", thinkingLevel: "off" as const };
function setup(options?: SessionRegistryOptions) { const adapter = new FakeAdapter(); return { adapter, registry: new SessionRegistry(adapter, new Map([["repo", "/safe/repo"]]), options) }; }
async function settle() { await new Promise((resolve) => setTimeout(resolve, 0)); }

describe("observable Pi turns", () => {
  it("returns a stable turnId only after accepted preflight", async () => {
    const { registry, adapter } = setup(); const session = await registry.start("repo", readOnlyProfile);
    const result = await registry.prompt(session.id, "read package.json");
    expect(result.turn).toMatchObject({ sessionId: session.id, state: "running" }); expect(result.turn.turnId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await registry.getTurn(session.id, result.turn.turnId)).turnId).toBe(result.turn.turnId);
    adapter.handles[0]!.complete("pi-session-mcp"); await settle(); expect((await registry.getTurn(session.id, result.turn.turnId)).state).toBe("completed");
  });

  it("does not retain an orphaned turn when preflight is rejected", async () => {
    const { registry, adapter } = setup(); adapter.plans.push({ accepted: false }); const session = await registry.start("repo", readOnlyProfile);
    await expect(registry.prompt(session.id, "rejected")).rejects.toMatchObject({ code: "prompt_rejected" });
    expect(() => registry.getTurn(session.id, crypto.randomUUID())).toThrow(expect.objectContaining({ code: "unknown_turn" }));
  });

  it("exposes running, then completed normalized text and timestamps", async () => {
    const { registry, adapter } = setup(); const session = await registry.start("repo", readOnlyProfile); const accepted = await registry.prompt(session.id, "run");
    expect(accepted.turn.state).toBe("running"); expect(accepted.turn.startedAt).toEqual(expect.any(String)); adapter.handles[0]!.complete("  hello\nworld  "); await settle();
    const turn = await registry.getTurn(session.id, accepted.turn.turnId); expect(turn).toMatchObject({ state: "completed", assistantText: "hello\nworld", truncated: false, completedAt: expect.any(String) });
    expect(new Date(turn.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(turn.startedAt).getTime());
  });

  it("reports failed turns with only a generic error", async () => {
    const { registry, adapter } = setup(); const session = await registry.start("repo", readOnlyProfile); const accepted = await registry.prompt(session.id, "fail"); adapter.handles[0]!.fail(); await settle();
    expect(await registry.getTurn(session.id, accepted.turn.turnId)).toMatchObject({ state: "failed", error: { code: "turn_failed", message: "Pi turn failed" } });
    expect(JSON.stringify(await registry.getTurn(session.id, accepted.turn.turnId))).not.toContain("provider detail");
  });

  it("keeps an aborted turn observable while close abort is blocked", async () => {
    const { registry, adapter } = setup(); const session = await registry.start("repo", readOnlyProfile); const accepted = await registry.prompt(session.id, "close race");
    let release!: () => void; adapter.handles[0]!.abortGate = new Promise<void>((resolve) => { release = resolve; });
    const closing = registry.close(session.id); while (adapter.handles[0]!.aborted < 1) await settle();
    const during = registry.getTurn(session.id, accepted.turn.turnId); expect(during.state).toBe("aborted"); expect(during.completedAt).toEqual(expect.any(String)); expect(new Date(during.updatedAt).getTime()).not.toBeNaN();
    release(); await closing;
  });

  it("normalizes an accepted prompt promise rejection to generic failure", async () => {
    const { registry, adapter } = setup(); adapter.plans.push({ rejectDetail: "SECRET_PROVIDER_FAILURE" }); const session = await registry.start("repo", readOnlyProfile);
    const accepted = await registry.prompt(session.id, "accepted but failed"); await settle(); const turn = registry.getTurn(session.id, accepted.turn.turnId);
    expect(turn).toMatchObject({ state: "failed", error: { code: "turn_failed", message: "Pi turn failed" } }); expect(registry.get(session.id).lastError).toBe("Pi turn failed"); expect(JSON.stringify(turn)).not.toContain("SECRET_PROVIDER_FAILURE");
  });

  it("reports aborted turns", async () => {
    const { registry, adapter } = setup(); const session = await registry.start("repo", readOnlyProfile); const accepted = await registry.prompt(session.id, "abort"); await registry.abort(session.id); await settle();
    expect(adapter.handles[0]?.aborted).toBe(1); expect(registry.get(session.id).state).toBe("idle"); expect((await registry.getTurn(session.id, accepted.turn.turnId))).toMatchObject({ state: "aborted", completedAt: expect.any(String) });
    adapter.handles[0]!.complete("late completion"); await settle(); expect(registry.getTurn(session.id, accepted.turn.turnId).state).toBe("aborted");
  });

  it("keeps a turn running and the session occupied when Pi abort rejects", async () => {
    const { registry, adapter } = setup(); const session = await registry.start("repo", readOnlyProfile); const accepted = await registry.prompt(session.id, "abort rejection");
    adapter.handles[0]!.abortError = new Error("SECRET_ABORT_FAILURE");
    await expect(registry.abort(session.id)).rejects.toMatchObject({ code: "abort_failed", message: "Pi abort failed" });
    expect(registry.getTurn(session.id, accepted.turn.turnId).state).toBe("running"); expect(registry.get(session.id)).toMatchObject({ state: "running" }); expect(registry.get(session.id)).not.toHaveProperty("lastError");
    await expect(registry.prompt(session.id, "must stay blocked")).rejects.toMatchObject({ code: "session_running" });
    adapter.handles[0]!.complete("normal completion"); await settle();
    expect(registry.getTurn(session.id, accepted.turn.turnId)).toMatchObject({ state: "completed", assistantText: "normal completion" }); expect(registry.get(session.id).state).toBe("idle");
  });

  it("coalesces a pending abort but permits a retry after the SDK abort rejects", async () => {
    const { registry, adapter } = setup(); const session = await registry.start("repo", readOnlyProfile); const accepted = await registry.prompt(session.id, "retry abort"); const handle = adapter.handles[0]!;
    let rejectFirst!: (reason?: unknown) => void; handle.abortGate = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
    const first = registry.abort(session.id); const overlapping = registry.abort(session.id);
    const firstExpectation = expect(first).rejects.toMatchObject({ code: "abort_failed", message: "Pi abort failed" });
    const overlappingExpectation = expect(overlapping).rejects.toMatchObject({ code: "abort_failed", message: "Pi abort failed" });
    while (handle.aborted < 1) await settle();
    rejectFirst(new Error("SECRET_TRANSIENT_ABORT_FAILURE"));
    await firstExpectation;
    await overlappingExpectation;
    expect(handle.aborted).toBe(1); expect(registry.getTurn(session.id, accepted.turn.turnId).state).toBe("running");

    handle.abortGate = Promise.resolve();
    await expect(registry.abort(session.id)).resolves.toMatchObject({ state: "idle" });
    expect(handle.aborted).toBe(2); expect(registry.getTurn(session.id, accepted.turn.turnId).state).toBe("aborted");
  });

  it("does not overwrite normal completion that wins the abort race", async () => {
    const { registry, adapter } = setup(); const session = await registry.start("repo", readOnlyProfile); const accepted = await registry.prompt(session.id, "abort race"); const handle = adapter.handles[0]!;
    let release!: () => void; handle.abortGate = new Promise<void>((resolve) => { release = resolve; }); const aborting = registry.abort(session.id); while (handle.aborted < 1) await settle();
    handle.complete("completed during abort"); await settle(); release(); await expect(aborting).resolves.toMatchObject({ state: "idle" });
    expect(registry.getTurn(session.id, accepted.turn.turnId)).toMatchObject({ state: "completed", assistantText: "completed during abort" });
  });

  it("propagates abort rejection without undoing completion that won the race", async () => {
    const { registry, adapter } = setup(); const session = await registry.start("repo", readOnlyProfile); const accepted = await registry.prompt(session.id, "rejected abort race"); const handle = adapter.handles[0]!;
    let release!: () => void; handle.abortGate = new Promise<void>((resolve) => { release = resolve; }); handle.abortError = new Error("SECRET_ABORT_FAILURE"); const aborting = registry.abort(session.id); while (handle.aborted < 1) await settle();
    handle.complete("completion won"); await settle(); release(); await expect(aborting).rejects.toMatchObject({ code: "abort_failed", message: "Pi abort failed" });
    expect(registry.getTurn(session.id, accepted.turn.turnId)).toMatchObject({ state: "completed", assistantText: "completion won" }); expect(registry.get(session.id).state).toBe("idle");
  });

  it("isolates sessions and rejects mismatched IDs", async () => {
    const { registry, adapter } = setup(); const first = await registry.start("repo", readOnlyProfile); const second = await registry.start("repo", readOnlyProfile);
    const one = await registry.prompt(first.id, "one"); const two = await registry.prompt(second.id, "two"); adapter.handles[0]!.complete("one"); adapter.handles[1]!.complete("two"); await settle();
    expect((await registry.getTurn(first.id, one.turn.turnId)).assistantText).toBe("one"); expect((await registry.getTurn(second.id, two.turn.turnId)).assistantText).toBe("two");
    expect(() => registry.getTurn(first.id, two.turn.turnId)).toThrow(expect.objectContaining({ code: "unknown_turn" }));
  });

  it("retains at most 20 turns, evicting the oldest", async () => {
    const { registry, adapter } = setup(); const session = await registry.start("repo", readOnlyProfile); const ids: string[] = [];
    const handle = adapter.handles[0]!;
    for (let i = 0; i < 21; i += 1) { const accepted = await registry.prompt(session.id, `turn-${i}`); ids.push(accepted.turn.turnId); handle.complete(String(i)); await settle(); }
    expect(() => registry.getTurn(session.id, ids[0]!)).toThrow(expect.objectContaining({ code: "unknown_turn" })); expect(registry.getTurn(session.id, ids[1]!)).toMatchObject({ assistantText: "1" });
  });

  it("limits final text to 64 KiB UTF-8 without splitting Unicode", async () => {
    const { registry, adapter } = setup(); const session = await registry.start("repo", readOnlyProfile); const accepted = await registry.prompt(session.id, "large"); adapter.handles[0]!.complete("😀".repeat(20_000)); await settle();
    const turn = await registry.getTurn(session.id, accepted.turn.turnId); expect(turn.truncated).toBe(true); expect(Buffer.byteLength(turn.assistantText!, "utf8")).toBeLessThanOrEqual(64 * 1024); expect(turn.assistantText).not.toContain("�");
  });

  it("removes turn data on close, including late settlement", async () => {
    const { registry, adapter } = setup(); const session = await registry.start("repo", readOnlyProfile); const accepted = await registry.prompt(session.id, "close"); await registry.close(session.id); adapter.handles[0]!.complete("late"); await settle();
    expect(() => registry.getTurn(session.id, accepted.turn.turnId)).toThrow(expect.objectContaining({ code: "unknown_session" }));
  });

  it("handles synchronous completion without losing the turn", async () => {
    const { registry, adapter } = setup(); adapter.plans.push({ synchronous: true }); const session = await registry.start("repo", readOnlyProfile); const accepted = await registry.prompt(session.id, "sync"); await settle();
    expect(registry.getTurn(session.id, accepted.turn.turnId)).toMatchObject({ state: "completed", assistantText: "sync result" });
  });

  it("restores the previous failed state after rejected preflight", async () => {
    const { registry, adapter } = setup(); adapter.plans.push({ prompts: [{}, { accepted: false }] }); const session = await registry.start("repo", readOnlyProfile); const accepted = await registry.prompt(session.id, "accepted failure");
    adapter.handles[0]!.fail(); await settle(); const before = registry.get(session.id); expect(before).toMatchObject({ state: "failed", lastError: "Pi turn failed" });
    await expect(registry.prompt(session.id, "rejected retry")).rejects.toMatchObject({ code: "prompt_rejected" }); expect(registry.get(session.id)).toEqual(before); expect(registry.getTurn(session.id, accepted.turn.turnId).state).toBe("failed");
  });

  it("distinguishes unknown sessions from unknown turns", async () => {
    const { registry } = setup(); expect(() => registry.getTurn(crypto.randomUUID(), crypto.randomUUID())).toThrow(expect.objectContaining({ code: "unknown_session" })); const session = await registry.start("repo", readOnlyProfile);
    expect(() => registry.getTurn(session.id, crypto.randomUUID())).toThrow(expect.objectContaining({ code: "unknown_turn" }));
  });
});

describe("running turn activity", () => {
  const at = (seconds: number) => new Date(`2026-09-23T00:00:${String(seconds).padStart(2, "0")}.000Z`);

  it("advances a running turn's updatedAt after completed tool and message activity", async () => {
    vi.useFakeTimers();
    try {
      const { registry, adapter } = setup();
      vi.setSystemTime(at(0));
      const session = await registry.start("repo", readOnlyProfile);
      const accepted = await registry.prompt(session.id, "long turn");

      vi.setSystemTime(at(1));
      adapter.handles[0]!.reportActivity();

      const running = registry.getTurn(session.id, accepted.turn.turnId);
      expect(running.state).toBe("running");
      expect(running.updatedAt).toBe("2026-09-23T00:00:01.000Z");
      expect(registry.get(session.id).updatedAt).toBe(accepted.session.updatedAt);

      vi.setSystemTime(at(2));
      adapter.handles[0]!.complete("done");
      await vi.advanceTimersByTimeAsync(0);

      expect(registry.getTurn(session.id, accepted.turn.turnId)).toMatchObject({
        state: "completed", assistantText: "done", updatedAt: "2026-09-23T00:00:02.000Z",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves activity after synchronous acceptance but before turn publication", async () => {
    vi.useFakeTimers();
    try {
      const { registry, adapter } = setup();
      vi.setSystemTime(at(0));
      const session = await registry.start("repo", readOnlyProfile);
      const handle = adapter.handles[0]!;
      const prompt = handle.prompt.bind(handle);
      handle.prompt = (text, preflight, onActivity) => {
        const operation = prompt(text, preflight, onActivity);
        vi.setSystemTime(at(1));
        onActivity?.();
        return operation;
      };

      const accepted = await registry.prompt(session.id, "fast first event");
      expect(accepted.turn).toMatchObject({
        state: "running", startedAt: "2026-09-23T00:00:00.000Z",
        updatedAt: "2026-09-23T00:00:01.000Z",
      });
      expect(registry.getTurn(session.id, accepted.turn.turnId).updatedAt).toBe(accepted.turn.updatedAt);
      handle.complete("done");
      await vi.advanceTimersByTimeAsync(0);
      expect(registry.getTurn(session.id, accepted.turn.turnId).state).toBe("completed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps pre-admission activity out of the published turn", async () => {
    vi.useFakeTimers();
    try {
      const { registry, adapter } = setup();
      adapter.plans.push({ manualPreflight: true });
      vi.setSystemTime(at(0));
      const session = await registry.start("repo", readOnlyProfile);
      const pending = registry.prompt(session.id, "preflight pending");
      while (adapter.handles[0]!.onActivity === undefined) await Promise.resolve();

      vi.setSystemTime(at(1));
      adapter.handles[0]!.reportActivity();
      adapter.handles[0]!.signalPreflight(true);
      const accepted = await pending;

      expect(accepted.turn).toMatchObject({ state: "running", startedAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z" });
      vi.setSystemTime(at(2));
      adapter.handles[0]!.reportActivity();
      expect(registry.getTurn(session.id, accepted.turn.turnId).updatedAt).toBe("2026-09-23T00:00:02.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores activity after a rejected preflight", async () => {
    vi.useFakeTimers();
    try {
      const { registry, adapter } = setup();
      adapter.plans.push({ accepted: false });
      vi.setSystemTime(at(0));
      const session = await registry.start("repo", readOnlyProfile);
      const before = registry.get(session.id);

      await expect(registry.prompt(session.id, "rejected")).rejects.toMatchObject({ code: "prompt_rejected" });
      vi.setSystemTime(at(1));
      adapter.handles[0]!.reportActivity();

      expect(registry.get(session.id)).toEqual(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores activity around a timed-out preflight", async () => {
    vi.useFakeTimers();
    try {
      const { registry, adapter } = setup({ preflightDeadlineMs: 50 });
      adapter.plans.push({ manualPreflight: true });
      vi.setSystemTime(at(0));
      const session = await registry.start("repo", readOnlyProfile);
      const before = registry.get(session.id);
      const pending = registry.prompt(session.id, "hanging preflight");
      const rejection = expect(pending).rejects.toMatchObject({ code: "prompt_timeout" });
      while (adapter.handles[0]!.onActivity === undefined) await Promise.resolve();

      vi.setSystemTime(at(1));
      adapter.handles[0]!.reportActivity();
      await vi.advanceTimersByTimeAsync(50);
      await rejection;

      vi.setSystemTime(at(2));
      adapter.handles[0]!.reportActivity();
      expect(registry.get(session.id)).toEqual(before);
      await vi.advanceTimersByTimeAsync(0);
      expect(registry.get(session.id)).toEqual(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("freezes timestamps against late activity after each terminal outcome", async () => {
    vi.useFakeTimers();
    try {
      const { registry, adapter } = setup();
      vi.setSystemTime(at(0));
      const session = await registry.start("repo", readOnlyProfile);

      const completed = await registry.prompt(session.id, "completes");
      vi.setSystemTime(at(1));
      adapter.handles[0]!.complete("done");
      await vi.advanceTimersByTimeAsync(0);
      const completedView = registry.getTurn(session.id, completed.turn.turnId);
      const completedSession = registry.get(session.id);
      vi.setSystemTime(at(2));
      adapter.handles[0]!.reportActivity();
      expect(registry.getTurn(session.id, completed.turn.turnId)).toEqual(completedView);
      expect(registry.get(session.id)).toEqual(completedSession);

      const failed = await registry.prompt(session.id, "fails");
      vi.setSystemTime(at(3));
      adapter.handles[0]!.fail();
      await vi.advanceTimersByTimeAsync(0);
      const failedView = registry.getTurn(session.id, failed.turn.turnId);
      vi.setSystemTime(at(4));
      adapter.handles[0]!.reportActivity();
      expect(registry.getTurn(session.id, failed.turn.turnId)).toEqual(failedView);
      expect(failedView).toMatchObject({ state: "failed", error: { code: "turn_failed", message: "Pi turn failed" } });

      const aborted = await registry.prompt(session.id, "aborts");
      vi.setSystemTime(at(5));
      await registry.abort(session.id);
      const abortedView = registry.getTurn(session.id, aborted.turn.turnId);
      expect(abortedView.state).toBe("aborted");
      vi.setSystemTime(at(6));
      adapter.handles[0]!.reportActivity();
      expect(registry.getTurn(session.id, aborted.turn.turnId)).toEqual(abortedView);
      expect(registry.get(session.id)).toMatchObject({ state: "idle", updatedAt: abortedView.updatedAt });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores late activity after close and shutdown", async () => {
    vi.useFakeTimers();
    try {
      const { registry, adapter } = setup();
      vi.setSystemTime(at(0));
      const session = await registry.start("repo", readOnlyProfile);
      const accepted = await registry.prompt(session.id, "closes");
      vi.setSystemTime(at(1));
      const closed = await registry.close(session.id);

      vi.setSystemTime(at(2));
      adapter.handles[0]!.reportActivity();

      expect(await registry.close(session.id)).toEqual(closed);
      expect(() => registry.getTurn(session.id, accepted.turn.turnId)).toThrow(expect.objectContaining({ code: "unknown_session" }));

      const second = await registry.start("repo", readOnlyProfile);
      const secondTurn = await registry.prompt(second.id, "shuts down");
      await registry.shutdown();
      vi.setSystemTime(at(3));
      adapter.handles[1]!.reportActivity();
      expect(registry.list()).toEqual([]);
      expect(() => registry.getTurn(second.id, secondTurn.turn.turnId)).toThrow(expect.objectContaining({ code: "unknown_session" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("never moves a turn timestamp backwards across a wall-clock step", async () => {
    vi.useFakeTimers();
    try {
      const { registry, adapter } = setup();
      vi.setSystemTime(at(5));
      const session = await registry.start("repo", readOnlyProfile);
      const accepted = await registry.prompt(session.id, "clock step");

      vi.setSystemTime(at(1));
      adapter.handles[0]!.reportActivity();
      expect(registry.getTurn(session.id, accepted.turn.turnId).updatedAt).toBe("2026-09-23T00:00:05.000Z");

      adapter.handles[0]!.complete("done");
      await vi.advanceTimersByTimeAsync(0);
      expect(registry.getTurn(session.id, accepted.turn.turnId)).toMatchObject({
        state: "completed", assistantText: "done", updatedAt: "2026-09-23T00:00:05.000Z", completedAt: "2026-09-23T00:00:05.000Z",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("scopes activity to its own turn and session", async () => {
    vi.useFakeTimers();
    try {
      const { registry, adapter } = setup();
      vi.setSystemTime(at(0));
      const first = await registry.start("repo", readOnlyProfile);
      const second = await registry.start("repo", readOnlyProfile);
      const firstTurn = await registry.prompt(first.id, "first");
      const secondTurn = await registry.prompt(second.id, "second");

      vi.setSystemTime(at(1));
      adapter.handles[0]!.reportActivity();
      expect(registry.getTurn(first.id, firstTurn.turn.turnId).updatedAt).toBe("2026-09-23T00:00:01.000Z");
      expect(registry.getTurn(second.id, secondTurn.turn.turnId).updatedAt).toBe("2026-09-23T00:00:00.000Z");

      const staleActivity = adapter.handles[0]!.onActivity!;
      adapter.handles[0]!.complete("first done");
      await vi.advanceTimersByTimeAsync(0);
      vi.setSystemTime(at(2));
      const nextTurn = await registry.prompt(first.id, "second turn");
      vi.setSystemTime(at(3));
      staleActivity();
      expect(registry.getTurn(first.id, nextTurn.turn.turnId).updatedAt).toBe("2026-09-23T00:00:02.000Z");
      expect(registry.get(first.id)).toMatchObject({ state: "running", updatedAt: "2026-09-23T00:00:02.000Z" });
      expect(registry.getTurn(first.id, firstTurn.turn.turnId)).toMatchObject({ state: "completed", assistantText: "first done", updatedAt: "2026-09-23T00:00:01.000Z" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SessionRegistry Phase 0 regressions", () => {
  it("projects the verified adapter selection and execution alias", async () => {
    const { registry } = setup(); const profile = { alias: "safe", permissionProfile: "read-only" as const, provider: "fake-provider", model: "fake-model", thinkingLevel: "medium" as const };
    const session = await registry.start("repo", profile);
    expect(session).toMatchObject({ executionProfile: "safe", profile: "read-only", provider: "fake-provider", model: "fake-model", thinkingLevel: "medium" });
  });

  it("does not register a session when adapter creation fails", async () => {
    const adapter = new FakeAdapter(); adapter.plans.push({ creationError: new Error("provider detail") });
    const registry = new SessionRegistry(adapter, new Map([["repo", "/safe/repo"]]));
    await expect(registry.start("repo", { alias: "safe", permissionProfile: "read-only", provider: "fake-provider", model: "fake-model", thinkingLevel: "off" })).rejects.toThrow("provider detail");
    expect(registry.list()).toEqual([]);
  });

  it("disposes and does not register when adapter selection mismatches", async () => {
    const handle = new (class extends FakeAdapter { override async create(input: { cwd: string; executionProfile: import("../src/execution-profile.js").ResolvedExecutionProfile }) { const result = await super.create(input); (result as { appliedSelection: { provider: string } }).appliedSelection.provider = "wrong"; return result; } })();
    const registry = new SessionRegistry(handle, new Map([["repo", "/safe/repo"]]));
    await expect(registry.start("repo", { alias: "safe", permissionProfile: "read-only", provider: "fake-provider", model: "fake-model", thinkingLevel: "off" })).rejects.toMatchObject({ code: "execution_selection_mismatch" });
    expect(handle.handles[0]?.disposeCalls).toBe(1); expect(registry.list()).toEqual([]);
  });

  it("rejects an unknown workspace", async () => { await expect(setup().registry.start("other", readOnlyProfile)).rejects.toMatchObject({ code: "unknown_workspace" }); });
  it("rejects an unknown session", () => { expect(() => setup().registry.get(crypto.randomUUID())).toThrow(); });
  it("rejects a second prompt while running", async () => {
    const { registry } = setup(); const session = await registry.start("repo", readOnlyProfile); await registry.prompt(session.id, "first");
    await expect(registry.prompt(session.id, "second")).rejects.toMatchObject({ code: "session_running" });
  });
  it("makes abort a no-op when idle and aborts when running", async () => {
    const { registry, adapter } = setup(); const session = await registry.start("repo", readOnlyProfile); await registry.abort(session.id); expect(adapter.handles[0]?.aborted).toBe(0);
    await registry.prompt(session.id, "run"); await registry.abort(session.id); expect(adapter.handles[0]?.aborted).toBe(1);
  });
  it("closes and cleans up", async () => {
    const { registry, adapter } = setup(); const session = await registry.start("repo", codingProfile); await registry.prompt(session.id, "run"); await registry.close(session.id);
    expect(adapter.handles[0]).toMatchObject({ aborted: 1, disposed: true }); expect(registry.list()).toEqual([]);
  });
  it("serializes close against prompt and leaves no orphaned turn", async () => {
    let accept!: (accepted: boolean) => void; let finish!: (value: unknown) => void;
    const handle = { sdkSessionId: "delayed", appliedSelection: { provider: "fake-provider", model: "fake-model", thinkingLevel: "off" }, prompt: (_text: string, preflight: (accepted: boolean) => void) => { accept = preflight; return new Promise((resolve) => { finish = resolve; }); }, abort: async () => { finish({ status: "aborted" }); }, dispose: () => undefined } as unknown as PiSessionHandle;
    const registry = new SessionRegistry({ create: async () => handle }, new Map([["repo", "/safe/repo"]])); const session = await registry.start("repo", codingProfile); const prompting = registry.prompt(session.id, "run"); const closing = registry.close(session.id);
    while (!accept) await Promise.resolve(); accept(true); await expect(prompting).resolves.toMatchObject({ turn: { state: "running" } }); await expect(closing).resolves.toMatchObject({ state: "closed" }); expect(registry.list()).toEqual([]);
  });
  it("makes concurrent and repeated close idempotent", async () => {
    const { registry, adapter } = setup(); const session = await registry.start("repo", readOnlyProfile); const [first, second] = await Promise.all([registry.close(session.id), registry.close(session.id)]);
    expect(first.state).toBe("closed"); expect(second.state).toBe("closed"); await expect(registry.close(session.id)).resolves.toMatchObject({ state: "closed" }); expect(adapter.handles[0]?.disposeCalls).toBe(1);
  });
  it("restores idle state when prompt fails before acceptance", async () => {
    const adapter = { create: async () => ({ sdkSessionId: "failure", appliedSelection: { provider: "fake-provider", model: "fake-model", thinkingLevel: "off" as const }, prompt: async () => { throw new Error("provider details"); }, abort: async () => undefined, dispose: () => undefined }) };
    const registry = new SessionRegistry(adapter, new Map([["repo", "/safe/repo"]])); const session = await registry.start("repo", readOnlyProfile);
    await expect(registry.prompt(session.id, "run")).rejects.toMatchObject({ code: "prompt_rejected" }); expect(registry.get(session.id)).toMatchObject({ state: "idle" }); expect(registry.get(session.id)).not.toHaveProperty("lastError");
  });
  it("settles shutdown after aborting an active turn", async () => {
    const { registry, adapter } = setup(); const session = await registry.start("repo", codingProfile); await registry.prompt(session.id, "run"); await registry.shutdown();
    expect(adapter.handles[0]).toMatchObject({ aborted: 1, disposeCalls: 1 }); expect(registry.list()).toEqual([]);
  });
});

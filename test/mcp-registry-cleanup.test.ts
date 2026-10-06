import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { PiSessionAdapter, PiSessionHandle } from "../src/pi-adapter.js";
import type { ResolvedExecutionProfile } from "../src/execution-profile.js";
import { SessionRegistry } from "../src/session-registry.js";

const profile: ResolvedExecutionProfile = { alias: "safe", permissionProfile: "read-only", provider: "fake", model: "fake", thinkingLevel: "off" };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function fixture(dispose: () => void | Promise<void>) {
  const handle: PiSessionHandle = {
    sdkSessionId: "fake", appliedSelection: { provider: "fake", model: "fake", thinkingLevel: "off" },
    async prompt(_text, preflight) { preflight(true); return { status: "completed", assistantText: "done" }; },
    async abort() {}, dispose,
  };
  const adapter: PiSessionAdapter = { async create() { return handle; } };
  return { handle, adapter, registry: new SessionRegistry(adapter, new Map([["project", "/workspace"]])) };
}

describe("asynchronous session resource cleanup", () => {
  it("waits for child cleanup before reporting an idle session closed", async () => {
    const cleanup = deferred<void>(); let entered = false;
    const f = fixture(() => { entered = true; return cleanup.promise; });
    const view = await f.registry.start("project", profile);
    let settled = false; const close = f.registry.close(view.id).then((result) => { settled = true; return result; });
    await tick(); assert.equal(entered, true); assert.equal(settled, false); assert.equal(f.registry.get(view.id).state, "closing");
    cleanup.resolve(); assert.equal((await close).state, "closed"); assert.deepEqual(f.registry.list(), []);
  });
  it("serializes duplicate close calls and disposes exactly once", async () => {
    const cleanup = deferred<void>(); let calls = 0;
    const f = fixture(() => { calls++; return cleanup.promise; });
    const view = await f.registry.start("project", profile);
    const first = f.registry.close(view.id), second = f.registry.close(view.id);
    await tick(); assert.equal(calls, 1); cleanup.resolve();
    assert.equal((await first).state, "closed"); assert.equal((await second).state, "closed"); assert.equal(calls, 1);
  });
  it("bounds cleanup and observes its late rejection", async () => {
    const cleanup = deferred<void>(); const f = fixture(() => cleanup.promise);
    const registry = new SessionRegistry(f.adapter, new Map([["project", "/workspace"]]), { closeCleanupDeadlineMs: 10 });
    const view = await registry.start("project", profile);
    assert.equal((await registry.close(view.id)).state, "closed");
    cleanup.reject(new Error("late SECRET")); await tick();
  });
  it("sanitizes synchronous and asynchronous disposal failures", async () => {
    for (const dispose of [() => { throw new Error("SECRET"); }, async () => { throw new Error("SECRET"); }]) {
      const f = fixture(dispose); const view = await f.registry.start("project", profile);
      assert.equal((await f.registry.close(view.id)).state, "closed");
    }
  });
  it("cleans a mismatched session before rejecting the start", async () => {
    const cleanup = deferred<void>(); const f = fixture(() => cleanup.promise);
    const mismatch = { ...f.handle, appliedSelection: { ...f.handle.appliedSelection, model: "wrong" } };
    f.adapter.create = async () => mismatch;
    let rejected = false;
    const start = assert.rejects(f.registry.start("project", profile), { code: "execution_selection_mismatch" }).then(() => { rejected = true; });
    await tick(); assert.equal(rejected, false); cleanup.resolve(); await start; assert.deepEqual(f.registry.list(), []);
  });
  it("shutdown tracks orphan cleanup from an already pending start", async () => {
    const creation = deferred<PiSessionHandle>(), cleanup = deferred<void>(); let disposed = false;
    const f = fixture(() => { disposed = true; return cleanup.promise; });
    f.adapter.create = async () => creation.promise;
    const rejected = assert.rejects(f.registry.start("project", profile), { code: "server_stopping" });
    let stopped = false; const shutdown = f.registry.shutdown().then(() => { stopped = true; });
    creation.resolve(f.handle); await tick();
    assert.equal(disposed, true); assert.equal(stopped, false); cleanup.resolve();
    await rejected; await shutdown; assert.deepEqual(f.registry.list(), []);
  });
  it("signals shutdown to a still-pending adapter before awaiting it", async () => {
    const creation = deferred<PiSessionHandle>(); const f = fixture(() => undefined);
    let signal: AbortSignal | undefined;
    f.adapter.create = async (input) => { signal = input.signal; return creation.promise; };
    const rejected = assert.rejects(f.registry.start("project", profile), { code: "server_stopping" });
    await tick(); const shutdown = f.registry.shutdown(); assert.equal(signal?.aborted, true);
    creation.resolve(f.handle); await rejected; await shutdown;
  });
  it("shutdown waits for cleanup of an existing session", async () => {
    const cleanup = deferred<void>(); const f = fixture(() => cleanup.promise);
    await f.registry.start("project", profile);
    let stopped = false; const shutdown = f.registry.shutdown().then(() => { stopped = true; });
    await tick(); assert.equal(stopped, false); cleanup.resolve(); await shutdown; assert.equal(stopped, true);
  });
});

import { mkdir, readdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { acquireOverrideLock, OverrideLockError, SKILL_BASES_LOCK_FILE } from "../src/override-lock.js";
import { waitForBlockedWaiter } from "./lock-wait.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

const directory = () => temporaryRoot("pi-override-lock-");
const failure = async (promise: Promise<unknown>): Promise<string> => {
  try { await promise; } catch (error) { if (error instanceof OverrideLockError) return error.code; throw error; }
  throw new Error("expected the lock to fail");
};

describe("platform gate", () => {
  it("fails closed without touching the directory on an unsupported platform", async () => {
    const root = await directory();
    expect(await failure(acquireOverrideLock(root, { platform: "win32" }))).toBe("override_lock_unavailable");
    expect(await readdir(root)).toEqual([]);
  });

  it("fails closed without a trusted flock or on an unsupported filesystem", async () => {
    const root = await directory();
    expect(await failure(acquireOverrideLock(root, { platform: "linux", isTrustedBinary: () => false }))).toBe("override_lock_unavailable");
    expect(await failure(acquireOverrideLock(root, { platform: "linux", flockCandidates: [], isTrustedBinary: () => true }))).toBe("override_lock_unavailable");
    expect(await failure(acquireOverrideLock(root, { readStatfs: async () => ({ type: 0 }) }))).toBe("override_lock_unavailable");
    expect(await readdir(root)).toEqual([]);
  });

  it("fails closed for a missing directory", async () => {
    const root = await directory();
    expect(await failure(acquireOverrideLock(join(root, "missing")))).toBe("override_lock_unavailable");
  });
});

describe.skipIf(process.platform !== "linux")("kernel lock", () => {
  it("creates a private, stable lock file that release does not delete", async () => {
    const root = await directory();
    const lock = await acquireOverrideLock(root);
    const path = join(root, SKILL_BASES_LOCK_FILE);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await lock.release();
    await lock.release();
    const inode = (await stat(path)).ino;
    await (await acquireOverrideLock(root)).release();
    expect((await stat(path)).ino).toBe(inode);
    expect(await readdir(root)).toEqual([SKILL_BASES_LOCK_FILE]);
  });

  it("excludes a second holder until release and reports busy after the bound", async () => {
    const root = await directory();
    const first = await acquireOverrideLock(root);
    const started = Date.now();
    expect(await failure(acquireOverrideLock(root, { timeoutMs: 200 }))).toBe("override_lock_busy");
    expect(Date.now() - started).toBeLessThan(10_000);
    await first.release();
    await (await acquireOverrideLock(root, { timeoutMs: 200 })).release();
  });

  it("hands the lock to a waiter on release", async () => {
    const root = await directory();
    const first = await acquireOverrideLock(root);
    const waiter = acquireOverrideLock(root, { timeoutMs: 20_000 });
    await waitForBlockedWaiter(join(root, SKILL_BASES_LOCK_FILE));
    await first.release();
    await (await waiter).release();
  });

  it("stops waiting when the signal aborts", async () => {
    const root = await directory();
    const first = await acquireOverrideLock(root);
    const controller = new AbortController();
    const waiter = acquireOverrideLock(root, { timeoutMs: 20_000, signal: controller.signal });
    await waitForBlockedWaiter(join(root, SKILL_BASES_LOCK_FILE));
    controller.abort();
    expect(await failure(waiter)).toBe("override_lock_unavailable");
    await first.release();
    await (await acquireOverrideLock(root, { timeoutMs: 200 })).release();
  });

  it("refuses a link or a non-file at the lock path", async () => {
    const root = await directory();
    await writeFile(join(root, "elsewhere"), "");
    await symlink(join(root, "elsewhere"), join(root, SKILL_BASES_LOCK_FILE));
    expect(await failure(acquireOverrideLock(root))).toBe("override_lock_unavailable");
    await unlink(join(root, SKILL_BASES_LOCK_FILE));
    await mkdir(join(root, SKILL_BASES_LOCK_FILE));
    expect(await failure(acquireOverrideLock(root))).toBe("override_lock_unavailable");
  });

  it("rejects a lock whose path was replaced while it waited", async () => {
    const root = await directory();
    const path = join(root, SKILL_BASES_LOCK_FILE);
    const first = await acquireOverrideLock(root);
    const waiter = acquireOverrideLock(root, { timeoutMs: 20_000 });
    await waitForBlockedWaiter(path);
    await unlink(path);
    await writeFile(path, "", { mode: 0o600 });
    await first.release();
    // The waiter now holds the unlinked inode, which excludes nobody.
    expect(await failure(waiter)).toBe("override_lock_unavailable");
  });
});

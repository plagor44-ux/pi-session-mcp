import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { assertSupportedFilesystem, currentSetupPlatform, isTrustedSystemBinary, openLockedDarwin, type SetupPlatform, type StatfsReader } from "./setup-platform.js";

/**
 * The kernel lock that serializes every read-modify-write of the skill bases file across
 * processes. It lives on a stable lock file, never on the bases file: that file is replaced by a
 * rename, which would move the lock onto an unlinked inode. The lock file is never deleted, and a
 * holder that dies releases the lock through the kernel.
 */

export const SKILL_BASES_LOCK_FILE = ".pi-session-mcp-bases.lock";
export const DEFAULT_OVERRIDE_LOCK_TIMEOUT_MS = 30_000;
const MIN_LOCK_TIMEOUT_MS = 50;
const MAX_LOCK_TIMEOUT_MS = 120_000;
/** Exit status of `flock -E` when the lock stayed busy for the whole wait. */
const FLOCK_BUSY_EXIT = 75;
const FLOCK_CANDIDATES: readonly string[] = ["/usr/bin/flock", "/bin/flock"];

export class OverrideLockError extends Error {
  constructor(readonly code: "override_lock_busy" | "override_lock_unavailable") {
    super("Skill override lock is not available");
    this.name = "OverrideLockError";
  }
}

export interface OverrideLockOptions {
  /** Acquisition bound; a busy lock after this fails with `override_lock_busy`. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Test seams for the platform gate; the defaults describe this process. */
  readonly platform?: NodeJS.Platform;
  readonly flockCandidates?: readonly string[];
  readonly isTrustedBinary?: (path: string) => boolean;
  readonly readStatfs?: StatfsReader;
}

export interface OverrideLock {
  /** Closes the descriptor that holds the lock; safe to call more than once. */
  release(): Promise<void>;
}

/**
 * Takes the exclusive lock for one override directory, which must exist. Fails closed: an
 * unsupported platform, a missing trusted `flock`, an unsupported filesystem, a link or non-file
 * at the lock path and a descriptor that no longer names the path all end in
 * `override_lock_unavailable`.
 */
export async function acquireOverrideLock(overrideDirectory: string, options: OverrideLockOptions = {}): Promise<OverrideLock> {
  const platform = currentSetupPlatform(options.platform);
  if (!platform) throw new OverrideLockError("override_lock_unavailable");
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(MIN_LOCK_TIMEOUT_MS, Math.min(options.timeoutMs!, MAX_LOCK_TIMEOUT_MS)) : DEFAULT_OVERRIDE_LOCK_TIMEOUT_MS;
  const flockPath = platform === "linux" ? flockBinary(options) : undefined;
  if (platform === "linux" && flockPath === undefined) throw new OverrideLockError("override_lock_unavailable");
  try { await assertSupportedFilesystem(overrideDirectory, platform, options.readStatfs); }
  catch { throw new OverrideLockError("override_lock_unavailable"); }

  const lockPath = join(overrideDirectory, SKILL_BASES_LOCK_FILE);
  let handle: FileHandle | undefined;
  try {
    // macOS takes the kernel lock at open time; on Linux the trusted flock locks this very
    // open file description, so the lock outlives the flock process and ends with this descriptor.
    handle = await openLockFile(lockPath, platform, timeoutMs, options.signal);
    if (flockPath !== undefined) await lockWithFlock(flockPath, handle.fd, timeoutMs, options.signal);
    // The path may have been replaced while waiting: the lock only counts on the file it names.
    const [descriptor, linked] = await Promise.all([handle.stat(), lstat(lockPath)]);
    if (!descriptor.isFile() || !linked.isFile() || descriptor.dev !== linked.dev || descriptor.ino !== linked.ino) throw new OverrideLockError("override_lock_unavailable");
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error instanceof OverrideLockError ? error : new OverrideLockError("override_lock_unavailable");
  }
  const held = handle;
  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      released = true;
      await held.close().catch(() => undefined);
    },
  };
}

export function flockBinary(options: OverrideLockOptions): string | undefined {
  const trusted = options.isTrustedBinary ?? ((path: string) => isTrustedSystemBinary(path));
  return (options.flockCandidates ?? FLOCK_CANDIDATES).find((candidate) => trusted(candidate));
}

async function openLockFile(lockPath: string, platform: SetupPlatform, timeoutMs: number, signal: AbortSignal | undefined): Promise<FileHandle> {
  try {
    if (platform === "darwin") return await openLockedDarwin(lockPath, { timeoutMs, ...(signal ? { signal } : {}) });
    return await open(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    throw new OverrideLockError((error as Error).message === "ownership_lock_busy" ? "override_lock_busy" : "override_lock_unavailable");
  }
}

export function lockWithFlock(flockPath: string, lockFd: number, timeoutMs: number, signal: AbortSignal | undefined, nonBlocking = false): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new OverrideLockError("override_lock_unavailable")); return; }
    let locker: ChildProcess;
    try {
      // flock parses fractional seconds with the locale's decimal separator, so only whole
      // seconds go on the command line. The exact bound is the timer below, which stops flock.
      const wholeSeconds = String(Math.max(1, Math.ceil(timeoutMs / 1_000)));
      locker = spawn(flockPath, ["-E", String(FLOCK_BUSY_EXIT), ...(nonBlocking ? ["-n"] : ["-w", wholeSeconds]), "3"], { stdio: ["ignore", "ignore", "ignore", lockFd], detached: true });
    } catch { reject(new OverrideLockError("override_lock_unavailable")); return; }
    let expired = false;
    const stop = (): void => { if (locker.pid !== undefined) { try { process.kill(-locker.pid, "SIGKILL"); } catch { /* already gone */ } } };
    const cleanup = (): void => { clearTimeout(bound); signal?.removeEventListener("abort", stop); };
    const bound = nonBlocking ? undefined : setTimeout(() => { expired = true; stop(); }, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    locker.once("error", () => { cleanup(); reject(new OverrideLockError("override_lock_unavailable")); });
    locker.once("close", (code) => {
      cleanup();
      if (code === 0) resolve();
      else reject(new OverrideLockError(code === FLOCK_BUSY_EXIT || expired ? "override_lock_busy" : "override_lock_unavailable"));
    });
  });
}

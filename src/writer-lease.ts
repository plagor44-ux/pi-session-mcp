import { close, constants, fstat, type Stats } from "node:fs";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { flockBinary, lockWithFlock, OverrideLockError } from "./override-lock.js";
import { assertSupportedFilesystem, type StatfsReader } from "./setup-platform.js";
import { WRITER_NAME_PATTERN } from "./writer-state.js";

export const LEASE_DIRECTORY = [".local", "state", "pi-session-mcp", "leases"] as const;

export class WriterLeaseError extends Error {
  constructor(readonly code: "writer_busy" | "writer_lease_unavailable") {
    super("Writer lease is not available");
    this.name = "WriterLeaseError";
  }
}

export interface WriterLease {
  readonly fd: number;
  release(): Promise<void>;
}

interface LeaseSeams {
  readonly signal?: AbortSignal;
  readonly flockCandidates?: readonly string[];
  readonly isTrustedBinary?: (path: string) => boolean;
  readonly readStatfs?: StatfsReader;
}

export function writerLeasePath(home: string, name: string): string {
  if (!WRITER_NAME_PATTERN.test(name)) throw new WriterLeaseError("writer_lease_unavailable");
  return join(home, ...LEASE_DIRECTORY, `${name}.lock`);
}

function checkFile(file: Stats): void {
  if (!file.isFile() || file.uid !== process.getuid!() || (file.mode & 0o7777) !== 0o600) {
    throw new WriterLeaseError("writer_lease_unavailable");
  }
}

async function checkPath(path: string, descriptor: Stats): Promise<void> {
  checkFile(descriptor);
  const linked = await lstat(path);
  checkFile(linked);
  if (descriptor.dev !== linked.dev || descriptor.ino !== linked.ino) throw new WriterLeaseError("writer_lease_unavailable");
}

async function prepare(home: string, name: string, options: LeaseSeams, create: boolean): Promise<{ path: string; binary: string }> {
  if (process.platform !== "linux" || options.signal?.aborted) throw new WriterLeaseError("writer_lease_unavailable");
  const path = writerLeasePath(home, name);
  const binary = flockBinary(options);
  if (!binary) throw new WriterLeaseError("writer_lease_unavailable");
  const directory = join(home, ...LEASE_DIRECTORY);
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid!() || (info.mode & 0o7777) !== 0o700) throw new WriterLeaseError("writer_lease_unavailable");
  await assertSupportedFilesystem(directory, "linux", options.readStatfs);
  return { path, binary };
}

function lease(fd: number, closeDescriptor: () => Promise<unknown>): WriterLease {
  let released = false;
  return {
    fd,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      // Never unlock explicitly: mutating children can still hold this open file description.
      await closeDescriptor().catch(() => undefined);
    },
  };
}

export async function acquireWriterLease(home: string, name: string, options: LeaseSeams & { waitMs: number }): Promise<WriterLease> {
  let handle: FileHandle | undefined;
  try {
    if (!Number.isFinite(options.waitMs) || options.waitMs < 0) throw new WriterLeaseError("writer_lease_unavailable");
    const { path, binary } = await prepare(home, name, options, true);
    handle = await open(path, constants.O_NOFOLLOW | constants.O_CREAT | constants.O_RDWR, 0o600);
    checkFile(await handle.stat());
    await lockWithFlock(binary, handle.fd, options.waitMs, options.signal, options.waitMs === 0);
    await checkPath(path, await handle.stat());
    const held = handle;
    return lease(held.fd, () => held.close());
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw new WriterLeaseError(error instanceof OverrideLockError && error.code === "override_lock_busy" ? "writer_busy" : "writer_lease_unavailable");
  }
}

export async function adoptInheritedLease(home: string, name: string, fd: number, options: LeaseSeams = {}): Promise<WriterLease> {
  let probe: FileHandle | undefined;
  try {
    if (!Number.isInteger(fd) || fd < 0) throw new WriterLeaseError("writer_lease_unavailable");
    const { path, binary } = await prepare(home, name, options, false);
    await checkPath(path, await promisify(fstat)(fd));
    probe = await open(path, constants.O_NOFOLLOW | constants.O_RDWR);
    await checkPath(path, await probe.stat());
    // A fresh open must be excluded BEFORE touching the inherited description; otherwise
    // flock on an unlocked inherited fd would itself acquire a lock and falsely prove ownership.
    let busy = false;
    try { await lockWithFlock(binary, probe.fd, 0, options.signal, true); }
    catch (error) {
      if (!(error instanceof OverrideLockError) || error.code !== "override_lock_busy") throw error;
      busy = true;
    }
    if (!busy) throw new WriterLeaseError("writer_lease_unavailable");
    await lockWithFlock(binary, fd, 0, options.signal, true);
    await checkPath(path, await promisify(fstat)(fd));
    return lease(fd, () => promisify(close)(fd));
  } catch {
    // Rejection does not take ownership of the caller's descriptor.
    throw new WriterLeaseError("writer_lease_unavailable");
  } finally {
    await probe?.close().catch(() => undefined);
  }
}

import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat, statfs } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { CommandRunner } from "./client-adapters/types.js";
import { acquireSetupGuardian } from "./setup-process.js";
import type { SetupTarget } from "./setup-result.js";

export interface OwnershipRecord {
  readonly target: SetupTarget;
  readonly fingerprint: string;
  readonly previous: "absent" | "equivalent";
  readonly phase: "pending" | "owned";
  readonly transactionId: string;
}

export interface RegistrationSnapshot {
  /** Opaque adapter-owned snapshot; implementations must not persist secrets. */
  readonly fingerprint: string;
  readonly payload: unknown;
}

export type OwnedRegistration = OwnershipRecord;
export interface OwnershipAccess {
  get(target: SetupTarget): Promise<OwnershipRecord | undefined>;
  put(registration: OwnershipRecord): Promise<void>;
  delete(target: SetupTarget): Promise<void>;
  /** Throws a stable, path-free error if the transaction fence is unhealthy. */
  assertHealthy?(): void;
  signal?(): AbortSignal;
  readonly mutationRunner?: CommandRunner;
}
export interface OwnershipStore extends OwnershipAccess {
  transaction<T>(operation: (access: OwnershipAccess) => Promise<T>): Promise<T>;
}

/** Safe default for one process; callers needing recovery inject a durable store. */
export class MemoryOwnershipStore implements OwnershipStore {
  private readonly entries = new Map<string, OwnershipRecord>();
  private transactionTail: Promise<void> = Promise.resolve();
  async get(target: SetupTarget): Promise<OwnershipRecord | undefined> { return this.entries.get(key(target)); }
  async put(registration: OwnershipRecord): Promise<void> { this.entries.set(key(registration.target), registration); }
  async delete(target: SetupTarget): Promise<void> { this.entries.delete(key(target)); }
  async transaction<T>(operation: (access: OwnershipAccess) => Promise<T>): Promise<T> {
    const previous = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(this); } finally { release(); }
  }
}

export class DurableOwnershipStore implements OwnershipStore {
  constructor(private readonly path: string, private readonly options: { readonly acquireTimeoutMs?: number; readonly afterLockOpen?: () => Promise<void> | void; readonly beforeRename?: () => Promise<void> | void; readonly signal?: AbortSignal } = {}) {}
  private async read(): Promise<OwnershipRecord[]> { let parsed: unknown; try { if ((await stat(this.path)).size > 65_536) throw new Error("ownership_too_large"); parsed = JSON.parse(await readFile(this.path, "utf8")); } catch (error) { if ((error as { code?: string }).code === "ENOENT") return []; throw new Error("ownership_unreadable"); } if (!Array.isArray(parsed) || parsed.length > 128 || !parsed.every(isRecord)) throw new Error("ownership_corrupt"); return parsed; }
  async get(target: SetupTarget): Promise<OwnershipRecord | undefined> { return (await this.read()).find((entry) => key(entry.target) === key(target)); }
  async put(registration: OwnershipRecord): Promise<void> { await this.transaction((access) => access.put(registration)); }
  async delete(target: SetupTarget): Promise<void> { await this.transaction((access) => access.delete(target)); }
  async transaction<T>(operation: (access: OwnershipAccess) => Promise<T>): Promise<T> {
    return this.withLock(operation);
  }
  private async withLock<T>(operation: (access: OwnershipAccess) => Promise<T>): Promise<T> {
    if (process.platform !== "linux") throw new Error("platform_unsupported");
    const directory = dirname(this.path);
    await ensureOwnershipDirectory(directory);
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    this.options.signal?.addEventListener("abort", abort, { once: true });
    if (this.options.signal?.aborted) controller.abort();
    const assertHealthy = (): void => {
      if (controller.signal.aborted) throw new Error("operation_aborted");
    };
    const lockPath = `${this.path}.flock`;
    let lockHandle;
    try {
      lockHandle = await open(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      await lockHandle.chmod(0o600);
      await lockHandle.sync();
      await syncDirectory(directory);
      const [descriptor, linked] = await Promise.all([lockHandle.stat(), stat(lockPath)]);
      if (!descriptor.isFile() || !linked.isFile() || descriptor.dev !== linked.dev || descriptor.ino !== linked.ino) throw new Error("ownership_lock_invalid");
      await this.options.afterLockOpen?.();
    }
    catch { this.options.signal?.removeEventListener("abort", abort); await lockHandle?.close().catch(() => undefined); throw new Error("ownership_lock_unavailable"); }
    const validateLock = async (): Promise<void> => {
      const [descriptor, linked] = await Promise.all([lockHandle.stat(), stat(lockPath)]);
      if (!descriptor.isFile() || !linked.isFile() || descriptor.dev !== linked.dev || descriptor.ino !== linked.ino) throw new Error("ownership_lock_invalid");
    };
    let guardian;
    try { guardian = await acquireSetupGuardian(lockHandle.fd, this.options.acquireTimeoutMs ?? 30_000, controller.signal, validateLock); }
    catch (error) {
      this.options.signal?.removeEventListener("abort", abort);
      await lockHandle.close().catch(() => undefined);
      const code = (error as Error).message;
      throw new Error(["ownership_lock_busy", "operation_aborted"].includes(code) ? code : "ownership_lock_unavailable");
    }
    try {
      await validateLock();
    } catch {
      this.options.signal?.removeEventListener("abort", abort);
      try { await guardian.release(); } finally { await lockHandle.close().catch(() => undefined); }
      throw new Error("ownership_lock_unavailable");
    }
    const compromise = (): void => controller.abort();
    guardian.signal.addEventListener("abort", compromise, { once: true });
    try {
      const access: OwnershipAccess = {
        get: async (target) => { assertHealthy(); const value = await this.read(); assertHealthy(); return value.find((entry) => key(entry.target) === key(target)); },
        put: async (registration) => { assertHealthy(); if (!isRecord(registration)) throw new Error("ownership_invalid"); const entries = (await this.read()).filter((entry) => key(entry.target) !== key(registration.target)); entries.push(registration); assertHealthy(); await this.write(entries, assertHealthy); assertHealthy(); },
        delete: async (target) => { assertHealthy(); const entries = (await this.read()).filter((entry) => key(entry.target) !== key(target)); assertHealthy(); await this.write(entries, assertHealthy); assertHealthy(); },
        assertHealthy,
        signal: () => controller.signal,
        mutationRunner: guardian.runner,
      };
      const value = await operation(access);
      assertHealthy();
      return value;
    }
    finally {
      guardian.signal.removeEventListener("abort", compromise);
      this.options.signal?.removeEventListener("abort", abort);
      try { await guardian.release(); } finally { await lockHandle.close().catch(() => undefined); }
    }
  }
  private async write(entries: readonly OwnershipRecord[], assertHealthy: () => void): Promise<void> { const directory = dirname(this.path); const temporary = `${this.path}.tmp-${process.pid}-${randomUUID()}`; let renamed = false; try { const handle = await open(temporary, "wx", 0o600); try { await handle.writeFile(JSON.stringify(entries)); await handle.sync(); } finally { await handle.close(); } await this.options.beforeRename?.(); assertHealthy(); await rename(temporary, this.path); renamed = true; await syncDirectory(directory); } finally { if (!renamed) await rm(temporary, { force: true }).catch(() => undefined); } }
}

// Kernel flock and directory fsync semantics are accepted only on the local
// Linux filesystems covered by the setup test matrix.
const SUPPORTED_LOCAL_FILESYSTEMS = new Set([
  0xef53, // ext2/3/4
  0x58465342, // XFS
  0x9123683e, // Btrfs
  0x01021994, // tmpfs
  0x794c7630, // overlayfs
  0x2fc12fc1, // ZFS
  0xf2f52010, // F2FS
  0x24051905, // UBIFS
  0xca451a4e, // bcachefs
]);

async function ensureOwnershipDirectory(directory: string): Promise<void> {
  const missing: string[] = [];
  let cursor = directory;
  while (true) {
    try {
      const existing = await lstat(cursor);
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("ownership_directory_invalid");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("ownership_directory_unavailable");
      missing.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error("ownership_directory_unavailable");
      cursor = parent;
    }
  }
  await assertSupportedFilesystem(cursor);
  for (const candidate of missing.reverse()) {
    try { await mkdir(candidate, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("ownership_directory_unavailable"); }
    const created = await lstat(candidate);
    if (!created.isDirectory() || created.isSymbolicLink()) throw new Error("ownership_directory_unavailable");
    await chmod(candidate, 0o700);
    await syncDirectory(candidate);
    await syncDirectory(dirname(candidate));
  }
  await chmod(directory, 0o700);
  await assertSupportedFilesystem(directory);
}

async function assertSupportedFilesystem(path: string): Promise<void> {
  const filesystem = await statfs(path);
  if (!SUPPORTED_LOCAL_FILESYSTEMS.has(filesystem.type)) throw new Error("ownership_filesystem_unsupported");
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

function isRecord(value: unknown): value is OwnershipRecord { if (!value || typeof value !== "object") return false; const x = value as Record<string, unknown>; if (!exactKeys(x, ["target", "fingerprint", "previous", "phase", "transactionId"])) return false; const t = x.target; if (!t || typeof t !== "object") return false; const target = t as Record<string, unknown>; if (!exactKeys(target, ["client", "scope", "alias"])) return false; const client = target.client; const scope = target.scope; return (client === "codex" || client === "claude-code") && typeof scope === "string" && (client === "codex" ? scope === "user" : ["user", "project", "local"].includes(scope)) && target.alias === "pi-session-mcp" && typeof x.fingerprint === "string" && /^[a-f0-9]{64}$/.test(x.fingerprint) && (x.phase === "pending" || x.phase === "owned") && x.previous === "absent" && typeof x.transactionId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x.transactionId); }

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean { const keys = Object.keys(value).sort(); return keys.length === expected.length && [...expected].sort().every((key, index) => keys[index] === key); }

const key = (target: SetupTarget): string => `${target.client}\u0000${target.scope}\u0000${target.alias}`;

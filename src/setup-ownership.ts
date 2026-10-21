import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { CommandRunner } from "./client-adapters/types.js";
import { acquireSetupGuardian } from "./setup-process.js";
import { assertSupportedFilesystem, currentSetupPlatform, openLockedDarwin, type SetupPlatform } from "./setup-platform.js";
import { LEGACY_SKILL_TREE_FINGERPRINT_PATTERN, SKILL_NAME_PATTERN, SKILL_TREE_FINGERPRINT_PATTERN } from "./skill-library.js";
import { WRITER_NAME_PATTERN } from "./writer-state.js";
import type { SetupTarget } from "./setup-result.js";

export interface OwnershipRecord {
  readonly target: SetupTarget;
  readonly fingerprint: string;
  readonly previous: "absent" | "equivalent";
  readonly phase: "pending" | "owned";
  readonly transactionId: string;
  /**
   * Skill records only, while pending: the fingerprint of setup's own copy that the pending
   * update replaces, so an interrupted update can still be completed or removed. The
   * transaction id also names the update's intermediate directories, so recovery needs no path.
   * Skill fingerprints are `v2:` values; a bare 64-hex value is a record that 0.8.0 wrote and
   * names a tree only once a trusted reference proves it.
   * Hook records also use it while pending, for the owned entry (a 64-hex fingerprint) that the update replaces.
   */
  readonly replaces?: string;
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
    const platform = currentSetupPlatform();
    if (!platform) throw new Error("platform_unsupported");
    const directory = dirname(this.path);
    await ensureOwnershipDirectory(directory, platform);
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    this.options.signal?.addEventListener("abort", abort, { once: true });
    if (this.options.signal?.aborted) controller.abort();
    const assertHealthy = (): void => {
      if (controller.signal.aborted) throw new Error("operation_aborted");
    };
    const lockPath = `${this.path}.flock`;
    const acquireTimeoutMs = this.options.acquireTimeoutMs ?? 30_000;
    let lockHandle;
    try {
      // macOS takes the kernel lock at open time; on Linux the trusted flock
      // locks this same open file description in acquireSetupGuardian.
      lockHandle = platform === "darwin"
        ? await openLockedDarwin(lockPath, { timeoutMs: acquireTimeoutMs, signal: controller.signal })
        : await open(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      await lockHandle.chmod(0o600);
      await lockHandle.sync();
      await syncDirectory(directory);
      const [descriptor, linked] = await Promise.all([lockHandle.stat(), stat(lockPath)]);
      if (!descriptor.isFile() || !linked.isFile() || descriptor.dev !== linked.dev || descriptor.ino !== linked.ino) throw new Error("ownership_lock_invalid");
      await this.options.afterLockOpen?.();
    }
    catch (error) {
      this.options.signal?.removeEventListener("abort", abort);
      await lockHandle?.close().catch(() => undefined);
      const code = (error as Error).message;
      throw new Error(["ownership_lock_busy", "operation_aborted"].includes(code) ? code : "ownership_lock_unavailable");
    }
    const validateLock = async (): Promise<void> => {
      const [descriptor, linked] = await Promise.all([lockHandle.stat(), stat(lockPath)]);
      if (!descriptor.isFile() || !linked.isFile() || descriptor.dev !== linked.dev || descriptor.ino !== linked.ino) throw new Error("ownership_lock_invalid");
    };
    let guardian;
    try { guardian = await acquireSetupGuardian(lockHandle.fd, acquireTimeoutMs, controller.signal, validateLock); }
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

async function ensureOwnershipDirectory(directory: string, platform: SetupPlatform): Promise<void> {
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
  await assertSupportedFilesystem(cursor, platform);
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
  await assertSupportedFilesystem(directory, platform);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

/** `hook:pi-session-mcp-wake` for the user settings; `…@<16 hex>` for a project or local settings file bound to an opaque project identity. */
const HOOK_RECORD_ALIAS = /^hook:pi-session-mcp-wake(?:@([0-9a-f]{16}))?$/;

/** `skill:<name>` for a home slot; `skill:<name>@<16 hex>` for a project slot bound to an opaque project identity. */
const SKILL_RECORD_ALIAS = /^skill:([^@]+)(?:@([0-9a-f]{16}))?$/;

export function isRecord(value: unknown): value is OwnershipRecord {
  if (!value || typeof value !== "object") return false;
  const x = value as Record<string, unknown>;
  const keys = ["target", "fingerprint", "previous", "phase", "transactionId"];
  if (!exactKeys(x, keys) && !exactKeys(x, [...keys, "replaces"])) return false;
  if (!x.target || typeof x.target !== "object") return false;
  const target = x.target as Record<string, unknown>;
  if (!exactKeys(target, ["client", "scope", "alias"])) return false;
  const { client, scope, alias } = target;
  const writer = typeof alias === "string" && alias.startsWith("pi-coding-") && WRITER_NAME_PATTERN.test(alias.slice("pi-coding-".length)) &&
    (client === "codex" ? scope === "user" : client === "claude-code" && scope === "local");
  const registration = alias === "pi-session-mcp" &&
    (client === "codex" ? scope === "user" : client === "claude-code" && typeof scope === "string" && ["user", "project", "local"].includes(scope));
  const skillAlias = typeof alias === "string" ? SKILL_RECORD_ALIAS.exec(alias) : null;
  const skill = skillAlias !== null && SKILL_NAME_PATTERN.test(skillAlias[1]!) &&
    (client === "codex" ? scope === "user" && skillAlias[2] === undefined
      : client === "claude-code" && ((scope === "user" && skillAlias[2] === undefined) || (scope === "project" && skillAlias[2] !== undefined)));
  const hookAlias = typeof alias === "string" ? HOOK_RECORD_ALIAS.exec(alias) : null;
  const hook = hookAlias !== null && client === "claude-code" &&
    ((scope === "user" && hookAlias[1] === undefined) || ((scope === "project" || scope === "local") && hookAlias[1] !== undefined));
  // A registration fingerprint is a snapshot hash; a skill fingerprint is a version 2 tree value or a 0.8.0 legacy one.
  const validFingerprint = (value: unknown): boolean => typeof value === "string" &&
    (skill ? SKILL_TREE_FINGERPRINT_PATTERN.test(value) || LEGACY_SKILL_TREE_FINGERPRINT_PATTERN.test(value) : /^[a-f0-9]{64}$/.test(value));
  // `replaces` belongs only to a pending skill or hook record.
  if ("replaces" in x && !((skill || hook) && x.phase === "pending" && validFingerprint(x.replaces))) return false;
  return (registration || writer || skill || hook) && validFingerprint(x.fingerprint) &&
    (x.phase === "pending" || x.phase === "owned") && x.previous === "absent" &&
    typeof x.transactionId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x.transactionId);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean { const keys = Object.keys(value).sort(); return keys.length === expected.length && [...expected].sort().every((key, index) => keys[index] === key); }

const key = (target: SetupTarget): string => `${target.client}\u0000${target.scope}\u0000${target.alias}`;

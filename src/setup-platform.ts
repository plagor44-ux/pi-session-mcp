import { execFile } from "node:child_process";
import { constants, readdirSync, readFileSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { open, statfs } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

/**
 * Operating-system facts behind the setup fence. This module has no relative
 * imports: the transaction guardian and source-mode harnesses load it through
 * Node type stripping, which cannot map a `.js` specifier to its `.ts` source.
 */
export type SetupPlatform = "linux" | "darwin";
export type ProcessGroupState = "alive" | "gone" | "unknown";
export interface ProcessEntry { readonly pid: number; readonly group: number; readonly state: string; }
export interface ProcessTable {
  /** "alive" if any non-zombie process has this process group ID. */
  groupState(group: number): Promise<ProcessGroupState>;
  /** True only if a scan is determinate and contains the calling process. */
  readable(): Promise<boolean>;
  /** Poll interval for cleanup loops. */
  readonly pollMs: number;
}
export interface PsOutput { readonly exitCode: number; readonly stdout: string; }
export interface ProcessTableDependencies {
  /** Test seam for the macOS `ps` call; undefined means it could not run. */
  readonly runPs?: () => Promise<PsOutput | undefined>;
  readonly selfPid?: number;
}

export function currentSetupPlatform(platform: NodeJS.Platform = process.platform): SetupPlatform | undefined {
  return platform === "linux" || platform === "darwin" ? platform : undefined;
}

/** A regular, root-owned executable that no group or other user can replace. */
export function isTrustedSystemBinary(path: string, statFile: (path: string) => Pick<Stats, "isFile" | "uid" | "mode"> = statSync): boolean {
  try {
    const file = statFile(path);
    return file.isFile() && file.uid === 0 && (file.mode & 0o022) === 0 && (file.mode & 0o111) !== 0;
  } catch { return false; }
}

function readLinuxProcessGroup(pid: number): { readonly group: number; readonly state: string } {
  const line = readFileSync(`/proc/${pid}/stat`, "utf8").trim();
  const close = line.lastIndexOf(") ");
  const state = line[close + 2];
  if (close < 3 || !state || !/^[A-Za-z]$/.test(state) || line[close + 3] !== " ") throw new Error("process_stat_invalid");
  const fields = line.slice(close + 4).trim().split(/\s+/);
  const group = Number(fields[1]);
  if (!Number.isSafeInteger(group) || group < 0) throw new Error("process_group_invalid");
  return { group, state };
}

function linuxGroupState(group: number): ProcessGroupState {
  let entries;
  try { entries = readdirSync("/proc", { withFileTypes: true }); }
  catch { return "unknown"; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const sample = readLinuxProcessGroup(Number(entry.name));
      if (sample.group === group && sample.state !== "Z") return "alive";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "unknown";
    }
  }
  return "gone";
}

function linuxTableReadable(selfPid: number): boolean {
  let sawSelf = false;
  try {
    for (const entry of readdirSync("/proc", { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      try {
        const pid = Number(entry.name);
        readLinuxProcessGroup(pid);
        if (pid === selfPid) sawSelf = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      }
    }
  } catch { return false; }
  return sawSelf;
}

export const DARWIN_PS_PATH = "/bin/ps";
const PS_ARGUMENTS = ["-A", "-o", "pid=,pgid=,stat="] as const;
const PS_TIMEOUT_MS = 2_000;
const PS_MAX_OUTPUT_BYTES = 1_048_576;

/** Parses `ps -A -o pid=,pgid=,stat=`; any unexpected line rejects the whole sample. */
export function parsePsTable(output: string): readonly ProcessEntry[] | undefined {
  const body = output.endsWith("\n") ? output.slice(0, -1) : output;
  if (body.length === 0) return undefined;
  const entries: ProcessEntry[] = [];
  for (const line of body.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) return undefined;
    const pid = Number(match[1]);
    const group = Number(match[2]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(group)) return undefined;
    entries.push({ pid, group, state: match[3]! });
  }
  return entries;
}

function runDarwinPs(): Promise<PsOutput | undefined> {
  if (!isTrustedSystemBinary(DARWIN_PS_PATH)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    try {
      execFile(DARWIN_PS_PATH, [...PS_ARGUMENTS], { env: { LC_ALL: "C" }, timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_OUTPUT_BYTES, encoding: "utf8" }, (error, stdout) => {
        // A non-zero exit, timeout, output overflow or spawn failure is indeterminate.
        resolve(error ? undefined : { exitCode: 0, stdout });
      });
    } catch { resolve(undefined); }
  });
}

export function createProcessTable(platform: SetupPlatform, dependencies: ProcessTableDependencies = {}): ProcessTable {
  const selfPid = dependencies.selfPid ?? process.pid;
  if (platform === "linux") {
    return { pollMs: 10, groupState: async (group) => linuxGroupState(group), readable: async () => linuxTableReadable(selfPid) };
  }
  const runPs = dependencies.runPs ?? runDarwinPs;
  const scan = async (): Promise<readonly ProcessEntry[] | undefined> => {
    const output = await runPs();
    if (!output || output.exitCode !== 0) return undefined;
    const entries = parsePsTable(output.stdout);
    // A sample without the caller cannot be a complete process table.
    return entries?.some((entry) => entry.pid === selfPid) ? entries : undefined;
  };
  return {
    pollMs: 50,
    async groupState(group) {
      const entries = await scan();
      if (!entries) return "unknown";
      return entries.some((entry) => entry.group === group && !entry.state.startsWith("Z")) ? "alive" : "gone";
    },
    async readable() { return (await scan()) !== undefined; },
  };
}

// Kernel flock and directory fsync semantics are accepted only on the local
// Linux filesystems covered by the setup test matrix.
const SUPPORTED_LINUX_FILESYSTEMS = new Set([
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

export type StatfsReader = (path: string) => Promise<{ readonly type: number }>;

export async function assertSupportedFilesystem(path: string, platform: SetupPlatform, readStatfs: StatfsReader = (target) => statfs(target)): Promise<void> {
  const filesystem = await readStatfs(path);
  if (platform === "linux") {
    if (!SUPPORTED_LINUX_FILESYSTEMS.has(filesystem.type)) throw new Error("ownership_filesystem_unsupported");
    return;
  }
  // macOS assigns f_type dynamically, so the directory must share the type of
  // `/`, the sealed APFS system volume on every macOS that Node.js 22 supports.
  if (filesystem.type !== (await readStatfs("/")).type) throw new Error("ownership_filesystem_unsupported");
}

/** From XNU `bsd/sys/fcntl.h`; Node's `fs.constants` does not export these. */
export const DARWIN_O_NONBLOCK = 0x4;
export const DARWIN_O_EXLOCK = 0x20;

export interface DarwinLockOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly retryMs?: number;
  readonly openFile?: (path: string, flags: number, mode: number) => Promise<FileHandle>;
}

/**
 * Opens the lock file with an exclusive lock on its open file description,
 * which has flock(2) semantics on macOS. A busy lock is retried until the
 * acquisition bound; a failed attempt holds no descriptor.
 */
export async function openLockedDarwin(path: string, options: DarwinLockOptions): Promise<FileHandle> {
  const openFile = options.openFile ?? ((target: string, flags: number, mode: number) => open(target, flags, mode));
  const flags = constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | DARWIN_O_EXLOCK | DARWIN_O_NONBLOCK;
  const deadline = Date.now() + Math.max(1_000, Math.min(options.timeoutMs, 120_000));
  const retryMs = options.retryMs ?? 50;
  while (true) {
    if (options.signal?.aborted) throw new Error("operation_aborted");
    try { return await openFile(path, flags, 0o600); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EAGAIN" && code !== "EWOULDBLOCK") throw new Error("ownership_lock_unavailable");
    }
    if (Date.now() >= deadline) throw new Error("ownership_lock_busy");
    await new Promise<void>((resolve) => {
      const done = (): void => { clearTimeout(timer); options.signal?.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, retryMs);
      options.signal?.addEventListener("abort", done, { once: true });
    });
  }
}

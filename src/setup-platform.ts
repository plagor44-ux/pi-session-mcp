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
  /** "alive" for a non-zombie group member, or on Linux a zombie leader with other threads. */
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
  /** Test seam for the Linux `/proc` reads; the default reads the real procfs. */
  readonly procfs?: LinuxProcfs;
  readonly selfPid?: number;
}
export interface LinuxProcfs {
  /** The names in `/proc`. */
  list(): readonly string[];
  /** The text of `/proc/<pid>/stat`; throws the read error. */
  readStat(pid: number): string;
}
const realProcfs: LinuxProcfs = {
  // Names only: `withFileTypes` makes Node lstat entries whose type procfs does
  // not report, and that lstat throws ENOENT for a process that exits meanwhile.
  list: () => readdirSync("/proc"),
  readStat: (pid) => readFileSync(`/proc/${pid}/stat`, "utf8"),
};

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

const VANISHED = Symbol("vanished");

/** One stat sample, or VANISHED when the entry is gone (ENOENT) or was reaped between open and read (ESRCH). */
function sampleLinuxProcess(procfs: LinuxProcfs, pid: number): { readonly group: string; readonly state: string; readonly threads: string | undefined } | typeof VANISHED {
  let line;
  try { line = procfs.readStat(pid).trim(); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return VANISHED;
    throw error;
  }
  const close = line.lastIndexOf(") ");
  const state = line[close + 2];
  if (close < 3 || !state || !/^[A-Za-z]$/.test(state) || line[close + 3] !== " ") throw new Error("process_stat_invalid");
  const fields = line.slice(close + 4).trim().split(/\s+/);
  // fields starts at ppid (field 4); num_threads is field 20 in proc(5).
  return { group: fields[1] ?? "", state, threads: fields[16] };
}

/**
 * Undefined for a process that is already gone (#109). Besides ENOENT and ESRCH,
 * `do_task_stat` reports process group -1 once the kernel has released the
 * process's signal state while reaping it; that sample is read once more, and
 * only a vanished entry on the second read counts as gone. Any other failure
 * throws and makes the scan indeterminate.
 */
function readLinuxProcessGroup(procfs: LinuxProcfs, pid: number): { readonly group: number; readonly state: string; readonly threads: string | undefined } | undefined {
  let sample = sampleLinuxProcess(procfs, pid);
  if (sample !== VANISHED && sample.group === "-1") {
    sample = sampleLinuxProcess(procfs, pid);
    if (sample !== VANISHED && sample.group === "-1") throw new Error("process_group_invalid");
  }
  if (sample === VANISHED) return undefined;
  const group = Number(sample.group);
  if (sample.group === "" || !Number.isSafeInteger(group) || group < 0) throw new Error("process_group_invalid");
  return { group, state: sample.state, threads: sample.threads };
}

// Numeric /proc entries are process directories; a vanished one is skipped by readLinuxProcessGroup.
function linuxProcessIds(procfs: LinuxProcfs): readonly number[] {
  return procfs.list().filter((name) => /^\d+$/.test(name)).map(Number);
}

function linuxGroupState(procfs: LinuxProcfs, group: number): ProcessGroupState {
  try {
    for (const pid of linuxProcessIds(procfs)) {
      const sample = readLinuxProcessGroup(procfs, pid);
      if (!sample || sample.group !== group) continue;
      if (sample.state !== "Z") return "alive";
      const threads = /^\d+$/.test(sample.threads ?? "") ? Number(sample.threads) : Number.NaN;
      if (!Number.isSafeInteger(threads) || threads < 1) throw new Error("process_threads_invalid");
      if (threads > 1) return "alive";
    }
  } catch { return "unknown"; }
  return "gone";
}

function linuxTableReadable(procfs: LinuxProcfs, selfPid: number): boolean {
  let sawSelf = false;
  try {
    for (const pid of linuxProcessIds(procfs)) {
      if (readLinuxProcessGroup(procfs, pid) && pid === selfPid) sawSelf = true;
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
    const procfs = dependencies.procfs ?? realProcfs;
    return { pollMs: 10, groupState: async (group) => linuxGroupState(procfs, group), readable: async () => linuxTableReadable(procfs, selfPid) };
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
  const boundMs = Number.isFinite(options.timeoutMs) ? Math.max(1_000, Math.min(options.timeoutMs, 120_000)) : 120_000;
  const deadline = Date.now() + boundMs;
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

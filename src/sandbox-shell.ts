import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { constants as osConstants } from "node:os";
import { lstatSync, readFileSync, readlinkSync, writeFileSync, type Stats } from "node:fs";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { isTrustedSystemBinary } from "./setup-platform.js";

/** The only bubblewrap binary the shell uses: a fixed path, never a `PATH` lookup. */
export const BWRAP_PATH = "/usr/bin/bwrap";
export const SANDBOX_BASH_PATH = "/usr/bin/bash";
const SANDBOX_TRUE_PATH = "/usr/bin/true";
const SANDBOX_PATH = "/usr/local/bin:/usr/bin:/bin";
const SANDBOX_HOME = "/tmp/home";
/** Directories of a merged-`/usr` host that the sandbox recreates as symlinks or binds read-only. */
const ROOT_ENTRIES = ["/bin", "/lib", "/lib64", "/sbin"] as const;
export const PROBE_TIMEOUT_MS = 5_000;
/** Seconds a command may run when the tool call names no `timeout`. */
export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 600;
/** Size limit of the sandbox's tmpfs `/tmp`, in bytes (512 MiB). */
export const SANDBOX_TMP_BYTES = 536_870_912;
export const SANDBOX_UNAVAILABLE_MESSAGE = "Read-only shell sandbox is not available";
/** The only launcher of the limited scope: a fixed path, never a `PATH` lookup. */
export const SYSTEMD_RUN_PATH = "/usr/bin/systemd-run";
/** `memory.max` of each run's scope (1 GiB); the overlays and tmpfs mounts count against it. Swap is 0. */
export const SANDBOX_MEMORY_BYTES = 1_073_741_824;
/** `pids.max` of each run's scope: processes and threads of bubblewrap and all its descendants. */
export const SANDBOX_TASKS = 128;
export interface SandboxLimits { readonly memoryBytes: number; readonly tasks: number; }
export const SANDBOX_LIMITS: SandboxLimits = { memoryBytes: SANDBOX_MEMORY_BYTES, tasks: SANDBOX_TASKS };
const GITFILE_LIMIT_BYTES = 4096;

export type RootEntry =
  | { readonly path: string; readonly kind: "symlink"; readonly target: string }
  | { readonly path: string; readonly kind: "directory" };

export interface SandboxArgsInput {
  /** Real path of the workspace, mounted at the same path as an overlay with a temporary upper layer. */
  readonly workspace: string;
  /** Real path of a linked worktree's main Git directory, mounted the same way. */
  readonly gitCommonDir?: string | undefined;
  readonly cwd: string;
  readonly rootEntries: readonly RootEntry[];
  /** The program and its arguments, run after `--`. */
  readonly argv: readonly string[];
}

/** The complete, fixed bubblewrap argument list of ADR 0013. Pure: host facts come in as `rootEntries`. */
export function sandboxArgs(input: SandboxArgsInput): string[] {
  const args = [
    "--unshare-all", "--unshare-user", "--disable-userns", "--die-with-parent", "--new-session", "--clearenv",
    "--setenv", "PATH", SANDBOX_PATH, "--setenv", "HOME", SANDBOX_HOME,
    "--ro-bind", "/usr", "/usr",
  ];
  for (const entry of input.rootEntries) {
    if (entry.kind === "symlink") args.push("--symlink", entry.target, entry.path);
    else args.push("--ro-bind", entry.path, entry.path);
  }
  args.push(
    "--ro-bind", "/etc", "/etc", "--dev", "/dev", "--proc", "/proc", "--size", String(SANDBOX_TMP_BYTES), "--tmpfs", "/tmp", "--dir", SANDBOX_HOME,
    "--overlay-src", input.workspace, "--tmp-overlay", input.workspace,
  );
  if (input.gitCommonDir !== undefined) args.push("--overlay-src", input.gitCommonDir, "--tmp-overlay", input.gitCommonDir);
  args.push("--chdir", input.cwd, "--", ...input.argv);
  return args;
}

/** The fixed unit description; systemd would otherwise log the whole command line, command text included. */
export const SCOPE_DESCRIPTION = "pi-session-mcp sandboxed shell";
/** How long systemd lets a scope outlive the server's own deadline before it stops the scope itself. */
export const SCOPE_GRACE_SECONDS = 30;

/**
 * The `systemd-run` arguments of one run: a transient user scope with the fixed limits, stopped by systemd
 * `SCOPE_GRACE_SECONDS` after `deadlineSeconds`, whose bubblewrap reports its child PID on fd 3 and holds the
 * command until a byte arrives on fd 4. Pure.
 */
export function scopeArgs(unit: string, limits: SandboxLimits, bwrapArgs: readonly string[], deadlineSeconds: number): string[] {
  return [
    "--user", "--scope", "--quiet", "--collect", `--unit=${unit}`, `--description=${SCOPE_DESCRIPTION}`,
    "-p", `MemoryMax=${limits.memoryBytes}`, "-p", "MemorySwapMax=0", "-p", `TasksMax=${limits.tasks}`,
    "-p", `RuntimeMaxSec=${Math.ceil(deadlineSeconds) + SCOPE_GRACE_SECONDS}`,
    "--", BWRAP_PATH, "--info-fd", "3", "--block-fd", "4", ...bwrapArgs,
  ];
}

/** The host's `/bin`, `/lib`, `/lib64` and `/sbin`: a symlink is recreated, a directory bound, an absent entry skipped. */
export function hostRootEntries(): RootEntry[] {
  const entries: RootEntry[] = [];
  for (const path of ROOT_ENTRIES) {
    try {
      const info = lstatSync(path);
      if (info.isSymbolicLink()) entries.push({ path, kind: "symlink", target: readlinkSync(path) });
      else if (info.isDirectory()) entries.push({ path, kind: "directory" });
    } catch { /* absent */ }
  }
  return entries;
}

const within = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

async function readSmall(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > GITFILE_LIMIT_BYTES) return undefined;
    return (await readFile(path, "utf8")).trim();
  } catch { return undefined; }
}

const real = async (path: string): Promise<string | undefined> => { try { return await realpath(path); } catch { return undefined; } };
const isDirectory = async (path: string): Promise<boolean> => { try { return (await stat(path)).isDirectory(); } catch { return false; } };
const isFile = async (path: string): Promise<boolean> => { try { return (await stat(path)).isFile(); } catch { return false; } };

/**
 * The main repository's Git directory of a linked worktree, or `undefined`. Only a `.git` regular file
 * whose `gitdir:` names `<common>/worktrees/<name>` is accepted, and only if that directory points
 * back at this workspace's `.git`, its `commondir` resolves to `<common>`, and `<common>` holds `HEAD`,
 * `objects` and `refs`. Never throws on bad content.
 */
export async function resolveWorktreeGitDir(workspace: string): Promise<string | undefined> {
  try {
    const gitFile = join(workspace, ".git");
    const content = await readSmall(gitFile);
    const match = content === undefined ? null : /^gitdir: (.+)$/.exec(content);
    if (!match) return undefined;
    const gitdir = await real(resolve(workspace, match[1]!));
    if (gitdir === undefined || !(await isDirectory(gitdir))) return undefined;
    const worktrees = dirname(gitdir);
    if (basename(worktrees) !== "worktrees") return undefined;
    const common = dirname(worktrees);
    const back = await readSmall(join(gitdir, "gitdir"));
    if (back === undefined || (await real(resolve(gitdir, back))) !== (await real(gitFile))) return undefined;
    const commondir = await readSmall(join(gitdir, "commondir"));
    if (commondir === undefined || (await real(resolve(gitdir, commondir))) !== common) return undefined;
    if (!(await isFile(join(common, "HEAD"))) || !(await isDirectory(join(common, "objects"))) || !(await isDirectory(join(common, "refs")))) return undefined;
    return common;
  } catch { return undefined; }
}

/** Whether `path` is an absolute cgroup path without empty, `.` or `..` segments whose last segment is `<unit>.scope`. */
function isScopePath(path: string, unit: string): boolean {
  const segments = path.split("/");
  return segments[0] === "" && !segments.slice(1).some((segment) => !segment || segment === "." || segment === "..") && segments.at(-1) === `${unit}.scope`;
}

/**
 * Whether both sandbox processes are in the one cgroup v2 scope named `unit` (not the server's own) and that
 * scope's effective `memory.max`, `memory.swap.max` and `pids.max` equal the limits. Never throws.
 */
export async function verifyScope(input: { pid: number; childPid: number; unit: string; limits: SandboxLimits }, readText: (path: string) => Promise<string>): Promise<boolean> {
  try {
    const mounts = await readText("/proc/self/mounts");
    if (!mounts.split("\n").some((line) => { const fields = line.trim().split(/\s+/); return fields[1] === "/sys/fs/cgroup" && fields[2] === "cgroup2"; })) return false;
    const cgroup = async (pid: string): Promise<string | undefined> => {
      const text = (await readText(`/proc/${pid}/cgroup`)).replace(/\n$/, "");
      return /^0::([^\n]+)$/.exec(text)?.[1];
    };
    const path = await cgroup(String(input.pid));
    const self = await cgroup("self");
    if (path === undefined || self === undefined || path !== await cgroup(String(input.childPid)) || path === self) return false;
    if (!isScopePath(path, input.unit)) return false;
    const base = `/sys/fs/cgroup${path}`;
    return (await readText(`${base}/memory.max`)).trim() === String(input.limits.memoryBytes)
      && (await readText(`${base}/memory.swap.max`)).trim() === "0"
      && (await readText(`${base}/pids.max`)).trim() === String(input.limits.tasks);
  } catch { return false; }
}

/** Synchronous process and cgroup access for `endScope`; the default uses `node:fs` and `process.kill`. */
export interface ScopeIo {
  readonly read: (path: string) => string;
  readonly write: (path: string, data: string) => void;
  readonly kill: (pid: number) => void;
}

const defaultScopeIo: ScopeIo = {
  read: (path) => readFileSync(path, "utf8"),
  write: (path, data) => writeFileSync(path, data),
  kill: (pid) => process.kill(pid, "SIGKILL"),
};

/**
 * SIGKILLs every process of the scope named `unit`: through the scope's `cgroup.kill`, found from the cgroup of
 * one of `pids`, and each of `pids` that is in that scope. A PID outside the scope is left alone, so a reused PID
 * is never signalled. Synchronous and never throws, so that the caller can close fd 4 right after it. True when
 * one of `pids` was in the scope and has been signalled.
 */
export function endScope(pids: readonly (number | undefined)[], unit: string, io: ScopeIo = defaultScopeIo): boolean {
  let scopeKilled = false;
  let found = false;
  for (const pid of pids) {
    if (pid === undefined || !Number.isInteger(pid) || pid <= 1) continue;
    try {
      const path = /^0::([^\n]+)$/.exec(io.read(`/proc/${pid}/cgroup`).replace(/\n$/, ""))?.[1];
      if (path === undefined || !isScopePath(path, unit)) continue;
      if (!scopeKilled) {
        try { io.write(`/sys/fs/cgroup${path}/cgroup.kill`, "1"); scopeKilled = true; } catch { /* no cgroup.kill: the PIDs below still end */ }
      }
      found = true;
      io.kill(pid);
    } catch { /* already gone */ }
  }
  return found;
}

/** The part of a child process the sandbox uses; the default is `node:child_process`. */
export interface SandboxChild {
  readonly pid?: number | undefined;
  readonly stdio: readonly unknown[];
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}
export type SandboxSpawn = (file: string, args: readonly string[], options: { env: Record<string, string>; stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] }) => SandboxChild;

export interface SandboxDependencies {
  readonly spawn?: SandboxSpawn;
  /** Whether the fixed bubblewrap binary may be used; defaults to a trusted-system-binary check. */
  readonly trusted?: (path: string) => boolean;
  readonly limits?: SandboxLimits;
  readonly runtimeDir?: () => string | undefined;
  readonly readText?: (path: string) => Promise<string>;
  readonly unitName?: () => string;
  readonly endScope?: (pids: readonly (number | undefined)[], unit: string) => boolean;
  readonly rootEntries?: () => readonly RootEntry[];
  readonly gitCommonDir?: (workspace: string) => Promise<string | undefined>;
}

const defaultSpawn: SandboxSpawn = (file, args, options) => spawn(file, [...args], options) as ChildProcess & SandboxChild;
const defaultTrusted = (path: string): boolean => isTrustedSystemBinary(path);

/** `/run/user/<uid>` when it is a real directory of that UID, closed to others and holding the user bus socket. */
export function validatedRuntimeDir(uid: number | undefined, stat: (path: string) => Stats = lstatSync): string | undefined {
  try {
    if (uid === undefined) return undefined;
    const dir = `/run/user/${uid}`;
    const info = stat(dir);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0 || !stat(`${dir}/bus`).isSocket()) return undefined;
    return dir;
  } catch { return undefined; }
}

/** Whether the fixed bubblewrap binary is a trusted system binary. */
export function sandboxBinaryTrusted(dependencies: SandboxDependencies = {}): boolean {
  try { const trusted = dependencies.trusted ?? defaultTrusted; return trusted(BWRAP_PATH) && trusted(SYSTEMD_RUN_PATH); } catch { return false; }
}

/** The complete argument list for one run; refuses when the fixed binary is not trusted. */
async function prepare(workspace: string, cwd: string, argv: readonly string[], dependencies: SandboxDependencies): Promise<string[]> {
  if (!sandboxBinaryTrusted(dependencies)) throw new Error(SANDBOX_UNAVAILABLE_MESSAGE);
  const gitCommonDir = await (dependencies.gitCommonDir ?? resolveWorktreeGitDir)(workspace);
  return sandboxArgs({ workspace, gitCommonDir, cwd, rootEntries: (dependencies.rootEntries ?? hostRootEntries)(), argv });
}

/** Node fires a longer timer at once, so a longer delay is waited for in pieces of at most this length. */
const MAX_TIMER_MS = 2_147_483_647;

/** Runs `action` after `delayMs`, also beyond Node's timer limit, without keeping the process alive. */
function after(delayMs: number, action: () => void): void {
  const step = Math.min(delayMs, MAX_TIMER_MS);
  setTimeout(() => { if (delayMs > step) after(delayMs - step, action); else action(); }, step).unref();
}

interface Running {
  readonly child: SandboxChild;
  readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly gate: Promise<void>;
  readonly kill: () => void;
}

/** Starts a scoped bubblewrap, holding its payload until the effective limits are verified. */
function start(args: readonly string[], dependencies: SandboxDependencies, deadlineSeconds: number): Running {
  if (!sandboxBinaryTrusted(dependencies)) throw new Error(SANDBOX_UNAVAILABLE_MESSAGE);
  const dir = (dependencies.runtimeDir ?? (() => validatedRuntimeDir(process.getuid?.())))();
  if (dir === undefined) throw new Error(SANDBOX_UNAVAILABLE_MESSAGE);
  const unit = (dependencies.unitName ?? (() => `pi-session-mcp-shell-${randomUUID()}`))();
  const limits = dependencies.limits ?? SANDBOX_LIMITS;
  const child = (dependencies.spawn ?? defaultSpawn)(SYSTEMD_RUN_PATH, scopeArgs(unit, limits, args, deadlineSeconds), { env: { XDG_RUNTIME_DIR: dir }, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });
  const info = child.stdio[3] as Readable | undefined;
  const block = child.stdio[4] as Writable | undefined;
  let stopped = false;
  let childPid: number | undefined;
  let ended = false;
  const kill = (): void => {
    if (stopped) return;
    stopped = true;
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    // bubblewrap's sandbox child waits on its own copy of fd 4 and, while it waits, outlives a killed
    // bubblewrap; end of file on fd 4 would then start the command. End the whole scope first.
    const found = (dependencies.endScope ?? endScope)([child.pid, childPid], unit);
    const close = (): void => { try { block?.destroy(); } catch { /* already closed */ } };
    // A launcher that ended on its own can no longer lead to its scope; a child it left waiting would start on
    // end of file. Keep fd 4 open until systemd has stopped the scope.
    if (found || !ended) close();
    else after((Math.ceil(deadlineSeconds) + SCOPE_GRACE_SECONDS) * 1000, close);
  };
  info?.on("error", kill);
  block?.on("error", kill);
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
    child.once("error", () => { ended = true; reject(new Error(SANDBOX_UNAVAILABLE_MESSAGE)); });
    child.once("close", (code, signal) => { ended = true; resolvePromise({ code, signal }); });
  });
  closed.catch(() => undefined);
  const gate = (async () => {
    try {
      if (!info || !block || child.pid === undefined) throw new Error();
      const reported = await new Promise<number>((resolvePromise, reject) => {
        let text = "";
        let bytes = 0;
        info.on("error", reject);
        info.on("end", () => reject(new Error()));
        info.on("close", () => reject(new Error()));
        info.on("data", (chunk: Buffer | string) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 4096) { reject(new Error()); return; }
          text += chunk.toString();
          try {
            const value: unknown = JSON.parse(text);
            if (typeof value !== "object" || value === null || Array.isArray(value)) { reject(new Error()); return; }
            const pid: unknown = (value as Record<string, unknown>)["child-pid"];
            if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) { reject(new Error()); return; }
            childPid = pid;
            resolvePromise(pid);
          } catch { /* incomplete JSON */ }
        });
      });
      if (!await verifyScope({ pid: child.pid, childPid: reported, unit, limits }, dependencies.readText ?? ((path) => readFile(path, "utf8"))) || stopped || ended) throw new Error();
      block.end("1");
    } catch { kill(); throw new Error(SANDBOX_UNAVAILABLE_MESSAGE); }
  })();
  gate.catch(() => undefined);
  return { child, closed, gate, kill };
}

/**
 * Runs `/usr/bin/true` through the same sandbox as a command, bounded by `PROBE_TIMEOUT_MS`.
 * False for an untrusted binary, a spawn failure, a non-zero exit or a timeout.
 */
export async function probeSandbox(workspace: string, dependencies: SandboxDependencies = {}, signal?: AbortSignal): Promise<boolean> {
  let running: Running | undefined;
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    if (signal?.aborted) return false;
    const workspaceReal = await realpath(workspace);
    running = start(await prepare(workspaceReal, workspaceReal, [SANDBOX_TRUE_PATH], dependencies), dependencies, PROBE_TIMEOUT_MS / 1000);
    const { child, closed, gate, kill } = running;
    child.stdout?.resume(); child.stderr?.resume();
    const deadline = new Promise<null>((resolvePromise) => {
      timer = setTimeout(() => { kill(); resolvePromise(null); }, PROBE_TIMEOUT_MS);
      onAbort = () => { kill(); resolvePromise(null); };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    const ready = await Promise.race([gate.then(() => true), closed.then(() => false), deadline]);
    if (ready !== true) { kill(); return false; }
    const outcome = await Promise.race([closed, deadline]);
    return outcome !== null && outcome.code === 0 && signal?.aborted !== true;
  } catch {
    running?.kill();
    return false;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * `BashOperations` that run each command in a limited systemd scope through bubblewrap. The passed
 * `env` is ignored, a working directory outside the workspace is refused and there is no unsandboxed
 * fallback: a sandbox that cannot start fails the command.
 */
export function createSandboxedBashOperations(workspace: string, dependencies: SandboxDependencies = {}): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout }) => {
      if (signal?.aborted) throw new Error("aborted");
      let workspaceReal: string;
      let cwdReal: string;
      try {
        workspaceReal = await realpath(workspace);
        cwdReal = await realpath(isAbsolute(cwd) ? cwd : resolve(workspaceReal, cwd));
      } catch {
        throw new Error("Working directory is not available");
      }
      if (!within(cwdReal, workspaceReal)) throw new Error("Working directory is outside the workspace");
      let timeoutMs = DEFAULT_COMMAND_TIMEOUT_SECONDS * 1000;
      if (timeout !== undefined) {
        if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid timeout: must be a finite number of seconds");
        timeoutMs = Math.min(timeout * 1000, 2_147_483_647);
      }
      let running: Running;
      try {
        running = start(await prepare(workspaceReal, cwdReal, [SANDBOX_BASH_PATH, "-c", command], dependencies), dependencies, timeoutMs / 1000);
      } catch {
        throw new Error(SANDBOX_UNAVAILABLE_MESSAGE);
      }
      const { child, closed, gate, kill } = running;
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      let cancel: (() => void) | undefined;
      const cancelled = new Promise<false>((resolvePromise) => { cancel = () => { kill(); resolvePromise(false); }; });
      const onAbort = (): void => { cancel?.(); };
      try {
        timer = setTimeout(() => { timedOut = true; cancel?.(); }, timeoutMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        const ready = await Promise.race([gate.then(() => true), closed.then(() => false), cancelled]);
        if (!ready) throw new Error(SANDBOX_UNAVAILABLE_MESSAGE);
        // Only the released command's output reaches the caller, never the launcher's diagnostics.
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        const outcome = await closed;
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout ?? DEFAULT_COMMAND_TIMEOUT_SECONDS}`);
        return { exitCode: outcome.code ?? (outcome.signal ? 128 + (osConstants.signals[outcome.signal] ?? 0) : 1) };
      } catch (error) {
        kill();
        // An abort or timeout during setup is reported as such, not as an unavailable sandbox.
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout ?? DEFAULT_COMMAND_TIMEOUT_SECONDS}`);
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { constants as osConstants } from "node:os";
import { lstatSync, readlinkSync } from "node:fs";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { isTrustedSystemBinary } from "./setup-platform.js";

/** The only bubblewrap binary the shell uses: a fixed path, never a `PATH` lookup. */
export const BWRAP_PATH = "/usr/bin/bwrap";
export const SYSTEMD_RUN_PATH = "/usr/bin/systemd-run";
export const SANDBOX_MEMORY_BYTES = 1_073_741_824;
export const SANDBOX_TASKS = 128;
export interface SandboxLimits { readonly memoryBytes: number; readonly tasks: number; }
export const SANDBOX_LIMITS: SandboxLimits = { memoryBytes: SANDBOX_MEMORY_BYTES, tasks: SANDBOX_TASKS };

export function scopeArgs(unit: string, limits: SandboxLimits, bwrapArgs: readonly string[]): string[] {
  return ["--user", "--scope", "--quiet", "--collect", `--unit=${unit}`, "-p", `MemoryMax=${limits.memoryBytes}`, "-p", "MemorySwapMax=0", "-p", `TasksMax=${limits.tasks}`, "--", BWRAP_PATH, "--info-fd", "3", "--block-fd", "4", ...bwrapArgs];
}

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
    const segments = path.split("/");
    if (segments[0] !== "" || segments.slice(1).some((segment) => !segment || segment === "." || segment === "..") || segments.at(-1) !== `${input.unit}.scope`) return false;
    const base = `/sys/fs/cgroup${path}`;
    return (await readText(`${base}/memory.max`)).trim() === String(input.limits.memoryBytes)
      && (await readText(`${base}/memory.swap.max`)).trim() === "0"
      && (await readText(`${base}/pids.max`)).trim() === String(input.limits.tasks);
  } catch { return false; }
}
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
  readonly rootEntries?: () => readonly RootEntry[];
  readonly gitCommonDir?: (workspace: string) => Promise<string | undefined>;
}

const defaultSpawn: SandboxSpawn = (file, args, options) => spawn(file, [...args], options) as ChildProcess & SandboxChild;
const defaultTrusted = (path: string): boolean => isTrustedSystemBinary(path);

function runtimeDir(): string | undefined {
  try {
    const uid = process.getuid?.();
    if (uid === undefined) return undefined;
    const dir = `/run/user/${uid}`;
    const info = lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0 || !lstatSync(`${dir}/bus`).isSocket()) return undefined;
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

interface Running {
  readonly child: SandboxChild;
  readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly gate: Promise<void>;
  readonly kill: () => void;
}

/** Starts a scoped bubblewrap, holding its payload until the effective limits are verified. */
function start(args: readonly string[], dependencies: SandboxDependencies): Running {
  if (!sandboxBinaryTrusted(dependencies)) throw new Error(SANDBOX_UNAVAILABLE_MESSAGE);
  const dir = (dependencies.runtimeDir ?? runtimeDir)();
  if (dir === undefined) throw new Error(SANDBOX_UNAVAILABLE_MESSAGE);
  const unit = (dependencies.unitName ?? (() => `pi-session-mcp-shell-${randomUUID()}`))();
  const limits = dependencies.limits ?? SANDBOX_LIMITS;
  const child = (dependencies.spawn ?? defaultSpawn)(SYSTEMD_RUN_PATH, scopeArgs(unit, limits, args), { env: { XDG_RUNTIME_DIR: dir }, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });
  const info = child.stdio[3] as Readable | undefined;
  const block = child.stdio[4] as Writable | undefined;
  let stopped = false;
  const kill = (): void => {
    if (stopped) return;
    stopped = true;
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    try { block?.destroy(); } catch { /* already closed */ }
  };
  let ended = false;
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
      const childPid = await new Promise<number>((resolvePromise, reject) => {
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
            resolvePromise(pid);
          } catch { /* incomplete JSON */ }
        });
      });
      if (!await verifyScope({ pid: child.pid, childPid, unit, limits }, dependencies.readText ?? ((path) => readFile(path, "utf8"))) || stopped || ended) throw new Error();
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
    running = start(await prepare(workspaceReal, workspaceReal, [SANDBOX_TRUE_PATH], dependencies), dependencies);
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
        running = start(await prepare(workspaceReal, cwdReal, [SANDBOX_BASH_PATH, "-c", command], dependencies), dependencies);
      } catch {
        throw new Error(SANDBOX_UNAVAILABLE_MESSAGE);
      }
      const { child, closed, gate, kill } = running;
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
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
        if (!ready) { kill(); throw new Error(SANDBOX_UNAVAILABLE_MESSAGE); }
        const outcome = await closed;
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout ?? DEFAULT_COMMAND_TIMEOUT_SECONDS}`);
        return { exitCode: outcome.code ?? (outcome.signal ? 128 + (osConstants.signals[outcome.signal] ?? 0) : 1) };
      } catch (error) {
        kill();
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

import { spawn, type ChildProcess } from "node:child_process";
import { constants as osConstants } from "node:os";
import { lstatSync, readlinkSync } from "node:fs";
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
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}
export type SandboxSpawn = (file: string, args: readonly string[], options: { env: Record<string, never>; stdio: ["ignore", "pipe", "pipe"] }) => SandboxChild;

export interface SandboxDependencies {
  readonly spawn?: SandboxSpawn;
  /** Whether the fixed bubblewrap binary may be used; defaults to a trusted-system-binary check. */
  readonly trusted?: () => boolean;
  readonly rootEntries?: () => readonly RootEntry[];
  readonly gitCommonDir?: (workspace: string) => Promise<string | undefined>;
}

const defaultSpawn: SandboxSpawn = (file, args, options) => spawn(file, [...args], options) as ChildProcess & SandboxChild;
const defaultTrusted = (): boolean => isTrustedSystemBinary(BWRAP_PATH);

/** Whether the fixed bubblewrap binary is a trusted system binary. */
export function sandboxBinaryTrusted(dependencies: SandboxDependencies = {}): boolean {
  try { return (dependencies.trusted ?? defaultTrusted)(); } catch { return false; }
}

/** The complete argument list for one run; refuses when the fixed binary is not trusted. */
async function prepare(workspace: string, cwd: string, argv: readonly string[], dependencies: SandboxDependencies): Promise<string[]> {
  if (!sandboxBinaryTrusted(dependencies)) throw new Error(SANDBOX_UNAVAILABLE_MESSAGE);
  const gitCommonDir = await (dependencies.gitCommonDir ?? resolveWorktreeGitDir)(workspace);
  return sandboxArgs({ workspace, gitCommonDir, cwd, rootEntries: (dependencies.rootEntries ?? hostRootEntries)(), argv });
}

interface Running { readonly child: SandboxChild; readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; }

/** Spawns bubblewrap and attaches the termination listeners in the same tick, so no event is missed. */
function start(args: readonly string[], dependencies: SandboxDependencies): Running {
  // An empty environment: neither the server's nor the tool's variables reach the sandbox.
  const child = (dependencies.spawn ?? defaultSpawn)(BWRAP_PATH, args, { env: {}, stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
    child.once("error", () => reject(new Error(SANDBOX_UNAVAILABLE_MESSAGE)));
    child.once("close", (code, signal) => resolvePromise({ code, signal }));
  });
  closed.catch(() => undefined);
  return { child, closed };
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
    const { child, closed } = running;
    child.stdout?.resume(); child.stderr?.resume();
    const deadline = new Promise<null>((resolvePromise) => {
      timer = setTimeout(() => resolvePromise(null), PROBE_TIMEOUT_MS);
      onAbort = () => resolvePromise(null);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) resolvePromise(null);
    });
    const outcome = await Promise.race([closed, deadline]);
    if (outcome === null) child.kill("SIGKILL");
    return outcome !== null && outcome.code === 0 && signal?.aborted !== true;
  } catch {
    try { running?.child.kill("SIGKILL"); } catch { /* already gone */ }
    return false;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * `BashOperations` that run each command as `bwrap <fixed arguments> -- bash -c <command>`. The passed
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
      const { child, closed } = running;
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      const kill = (): void => { try { child.kill("SIGKILL"); } catch { /* already gone */ } };
      const onAbort = (): void => kill();
      try {
        timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) kill();
        const outcome = await closed;
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout ?? DEFAULT_COMMAND_TIMEOUT_SECONDS}`);
        return { exitCode: outcome.code ?? (outcome.signal ? 128 + (osConstants.signals[outcome.signal] ?? 0) : 1) };
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

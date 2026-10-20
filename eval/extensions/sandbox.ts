import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import type { ToolPaths } from "./tools.js";

/*
 * R46: every traced command (the run unit and the oracle's setup and test commands) runs inside bubblewrap. The strace audit stays as
 * the second line of defence: a write the kernel refuses shows up as a denied attempt.
 *
 * Containment limits (R48-R50), for the owner:
 * - The root is read-only; only the scope root (and the oracle's home) is writable. /tmp, /run and, when it is a real directory,
 *   /var/run are fresh tmpfs mounts, so no host service socket under /run exists for the worker (R48). Only name resolution is let
 *   back in, read-only: /run/systemd/resolve and /run/nscd, where they exist.
 * - The operator's $HOME is hidden behind an empty, read-only tmpfs, because the network is shared and a worker could otherwise read
 *   SSH keys and other credentials and send them out (R49). Only what a run needs is bound back read-only: the evaluation
 *   repository's node_modules and skills (the build's symlinks point into them), the directories of the node binary and of codegraph
 *   when they live under $HOME, and the disposable build. The scope root and the oracle home are bound writable after the tmpfs.
 * - The network namespace is shared, because the providers are reached over it. Abstract-namespace Unix sockets (and so an X11
 *   server's abstract socket, which still needs a valid cookie that $HOME no longer holds) therefore remain reachable. They are
 *   detected, not prevented: any abstract connect is unresolved egress and stops the wave (R43). This is a residual risk (R50).
 * - Everything that is not hidden stays readable (the rest of the filesystem, the process environment of the sandbox is minimal).
 */

/** What depends on the host: computed once at the start of a wave or preflight (`planSandbox`) and passed to every command builder. */
export interface SandboxPlan {
  /** Existing name-resolution directories under /run, bound back read-only after `--tmpfs /run`. */
  runReadOnly: string[];
  /** /var/run is a real directory, not the usual link to /run, and gets its own tmpfs. */
  varRunDirectory: boolean;
  /** The real home directory to hide, or null. */
  home: string | null;
  /** Read-only binds that lie under `home`, mounted after the home tmpfs. */
  homeReadOnly: string[];
  /** Read-only binds mounted after /tmp is hidden, such as the disposable build the run unit loads from. */
  extraReadOnly: string[];
}

/** The plan of a host without any extras; tests and the self-test of injected hosts use it. */
export const EMPTY_PLAN: SandboxPlan = { runReadOnly: [], varRunDirectory: false, home: null, homeReadOnly: [], extraReadOnly: [] };

const within = (inner: string, outer: string): boolean => inner !== outer && inner.startsWith(outer.endsWith("/") ? outer : `${outer}/`);
const exists = (path: string): Promise<boolean> => lstat(path).then(() => true, () => false);
const real = (path: string): Promise<string | null> => realpath(path).then((p) => p, () => null);

export interface PlanInput {
  tools: Pick<ToolPaths, "codegraph">;
  /** The evaluation repository; its node_modules and skills are what the disposable build links to. */
  repoRoot: string;
  buildRoot: string;
  home?: string;
  nodePath?: string;
}

/** Inspects the host for the parts of the sandbox that depend on it (R48, R49). */
export async function planSandbox(input: PlanInput): Promise<SandboxPlan> {
  const runReadOnly: string[] = [];
  for (const path of ["/run/systemd/resolve", "/run/nscd"]) if (await exists(path)) runReadOnly.push(path);
  const varRun = await lstat("/var/run").catch(() => null);
  const home = await real(input.home ?? homedir());
  const hidden = home !== null && home !== "/" ? home : null;
  const homeReadOnly: string[] = [];
  if (hidden !== null) {
    const candidates: string[] = [];
    for (const path of [join(input.repoRoot, "node_modules"), join(input.repoRoot, "skills")]) {
      const resolved = await real(path);
      if (resolved !== null) candidates.push(resolved);
    }
    for (const binary of [input.tools.codegraph, input.nodePath ?? process.execPath]) {
      candidates.push(dirname(binary));
      const resolved = await real(binary);
      if (resolved === null) continue;
      candidates.push(dirname(resolved));
      // A bundle (`<root>/bin/tool`, with `<root>/node` or `<root>/lib` beside it, as codegraph and node installs have) needs its root;
      // a root directly below the home (`~/.local`, `~/bin`) is far too broad to bind.
      const bundle = dirname(dirname(resolved));
      if (basename(dirname(resolved)) === "bin" && relative(hidden, bundle).split("/").length >= 2) candidates.push(bundle);
    }
    for (const path of candidates) if (within(path, hidden) && !homeReadOnly.includes(path)) homeReadOnly.push(path);
  }
  return { runReadOnly, varRunDirectory: varRun !== null && varRun.isDirectory() && !varRun.isSymbolicLink(), home: hidden, homeReadOnly, extraReadOnly: [input.buildRoot] };
}

/**
 * The bwrap arguments up to and including `--`. The order matters: the scope bind comes after the tmpfs mounts (a scope below /tmp or
 * $HOME stays writable) and the home directory is remounted read-only last, which affects only the tmpfs itself, not the mounts above it.
 * `--unshare-pid` is added to the verified shape: `--new-session` moves the command into its own session, where a kill of the
 * supervisor's process group (strace is the leader) would miss it; in a PID namespace the death of bwrap, which `--die-with-parent`
 * ties to strace, ends every process of the sandbox.
 */
export function bwrapArgs(scopeRoot: string, plan: SandboxPlan = EMPTY_PLAN, extraWritable: readonly string[] = []): string[] {
  const readOnly = (paths: readonly string[]): string[] => paths.flatMap((path) => ["--ro-bind", path, path]);
  return [
    "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", "/run",
    ...(plan.varRunDirectory ? ["--tmpfs", "/var/run"] : []),
    ...readOnly(plan.runReadOnly),
    ...(plan.home === null ? [] : ["--tmpfs", plan.home]),
    ...readOnly(plan.homeReadOnly),
    "--bind", scopeRoot, scopeRoot, ...extraWritable.flatMap((path) => ["--bind", path, path]),
    ...readOnly(plan.extraReadOnly),
    ...(plan.home === null ? [] : ["--remount-ro", plan.home]),
    "--die-with-parent", "--new-session", "--unshare-ipc", "--unshare-pid", "--",
  ];
}

/** `bwrap … -- <command>` with an absolute bwrap path. */
export function sandboxed(tools: Pick<ToolPaths, "bwrap">, plan: SandboxPlan, scopeRoot: string, command: readonly string[], extraWritable: readonly string[] = []): string[] {
  return [tools.bwrap, ...bwrapArgs(scopeRoot, plan, extraWritable), ...command];
}

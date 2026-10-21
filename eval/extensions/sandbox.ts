import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { runHelper } from "./helpers.js";
import { realHome, resolveTool, type ToolPaths } from "./tools.js";

/*
 * R46: every traced command (the run unit and the oracle's setup and test commands) runs inside bubblewrap. The strace audit stays as
 * the second line of defence: a write the kernel refuses shows up as a denied attempt.
 *
 * Containment limits (R48-R51), for the owner:
 * - The root is an allowlist (R51), not the host's root: /usr (and /opt when it exists) read-only, the merged-usr links (/bin, /lib,
 *   /lib64, /sbin), and a minimal /etc of the entries in `ETC_ENTRIES`. Nothing else of the host is there: no /mnt, /media, /srv,
 *   /boot, /root, /data, and of /var only an empty /var/tmp tmpfs, so credentials, environment files, core dumps and the system
 *   journal that live outside $HOME are not reachable either. The root itself is a tmpfs, remounted read-only last (the mounts above it keep their own mode).
 * - /tmp, /var/tmp and /run are fresh tmpfs mounts, so no host service socket under /run exists for the worker (R48). Only name
 *   resolution is let back in, read-only: /run/systemd/resolve and /run/nscd, where they exist.
 * - The operator's $HOME is hidden behind an empty, read-only tmpfs, because the network is shared and a worker could otherwise read
 *   SSH keys and other credentials and send them out (R49). Only what a run needs is bound back, as narrowly as possible: the
 *   evaluation repository's node_modules and tracked skill directories (the build's symlinks point into them), the codegraph binary
 *   (and, for a bundle, only its bin, node and lib entries), the node binary's directory when it is outside /usr, and the disposable
 *   build. The scope root and the oracle home are bound writable after the tmpfs.
 * - A task's dependencies (R68) are the only host directories besides the above that are bound for a run: each installed mount read-only at
 *   its place in the clone and the runtime read-only at its own path (`SandboxBind`). The rest of the operator's deps directory (the
 *   lock copies, other tasks) is not visible.
 * - The network namespace is shared, because the providers are reached over it. Abstract-namespace Unix sockets (and so an X11
 *   server's abstract socket, which still needs a valid cookie that $HOME no longer holds) therefore remain reachable. They are
 *   detected, not prevented: any abstract connect is unresolved egress and stops the wave (R43). This is a residual risk (R50).
 */

/** The only entries of the host's /etc that the sandbox sees (those that exist are bound read-only). */
export const ETC_ENTRIES = [
  "resolv.conf", "hosts", "nsswitch.conf", "passwd", "group", "localtime", "ld.so.cache", "ld.so.conf", "ld.so.conf.d",
  "ssl", "ca-certificates", "pki", "os-release", "gitconfig", "mime.types", "protocols", "services",
] as const;

/** The merged-usr links of the root, as `[path, target]`; a real directory at the path is bound instead of linked. */
export const MERGED_USR_LINKS = [["/bin", "usr/bin"], ["/lib", "usr/lib"], ["/lib64", "usr/lib"], ["/sbin", "usr/bin"]] as const;

export interface SandboxLink { path: string; target: string }

/** A read-only bind of `source` at `target`, which may differ: a task dependency (R68) at its place in the clone, or its runtime at its own path. */
export interface SandboxBind { source: string; target: string }

/** What depends on the host: computed once at the start of a wave or preflight (`planSandbox`) and passed to every command builder. */
export interface SandboxPlan {
  /** Merged-usr symlinks (`usr/bin` at `/bin`, …) that exist on the host as links. */
  rootLinks: SandboxLink[];
  /** Read-only binds of the allowlist root besides /usr: /opt, a merged-usr path that is a real directory, a node directory elsewhere. */
  rootReadOnly: string[];
  /** The existing `ETC_ENTRIES`, as absolute paths below /etc, bound read-only into an empty /etc. */
  etcReadOnly: string[];
  /** Existing name-resolution directories under /run, bound back read-only after `--tmpfs /run`. */
  runReadOnly: string[];
  /** The real home directory to hide, or null. */
  home: string | null;
  /** Read-only binds that lie under `home`, mounted after the home tmpfs. */
  homeReadOnly: string[];
  /** Symlinks that lie under `home` (the codegraph link whose launcher finds its bundle through it), created after the home binds. */
  homeLinks: SandboxLink[];
  /** Read-only binds mounted after /tmp is hidden, such as the disposable build the run unit loads from. */
  extraReadOnly: string[];
}

/** The plan of a host without any extras; tests and the self-test of injected hosts use it. */
export const EMPTY_PLAN: SandboxPlan = { rootLinks: [], rootReadOnly: [], etcReadOnly: [], runReadOnly: [], home: null, homeReadOnly: [], homeLinks: [], extraReadOnly: [] };

const within = (inner: string, outer: string): boolean => inner !== outer && inner.startsWith(outer.endsWith("/") ? outer : `${outer}/`);

/** The host facts `planSandbox` reads; tests inject fakes. */
export interface PlanHost {
  exists: (path: string) => Promise<boolean>;
  lstat: (path: string) => Promise<{ isSymbolicLink: () => boolean; isDirectory: () => boolean } | null>;
  real: (path: string) => Promise<string | null>;
  /** Repo-relative paths of the tracked files below `skills/` (`git ls-files`). */
  trackedSkills: (repoRoot: string, git: string | undefined) => Promise<string[]>;
}

const defaultHost: PlanHost = {
  exists: (path) => lstat(path).then(() => true, () => false),
  lstat: (path) => lstat(path).catch(() => null),
  real: (path) => realpath(path).then((p) => p, () => null),
  trackedSkills: async (repoRoot, git) => {
    try { return (await runHelper(git ?? await resolveTool("git", process.env.PATH ?? ""), ["-C", repoRoot, "ls-files", "-z", "--", "skills/"], { env: { PATH: process.env.PATH ?? "" } })).stdout.split("\0").filter((path) => path !== ""); } catch { throw new Error("skills_listing_failed"); }
  },
};

export interface PlanInput {
  /** `git` lists the tracked skills; without it, `git` is looked up on the supervisor's PATH. */
  tools: Pick<ToolPaths, "codegraph"> & Partial<Pick<ToolPaths, "git">>;
  /** The evaluation repository; its node_modules and tracked skill directories are what the disposable build links to. */
  repoRoot: string;
  buildRoot: string;
  home?: string;
  nodePath?: string;
}

/** The tracked skill directories (and loose files) as `skills/<name>`; untracked entries such as `skills/.remember` are never listed. */
function skillEntries(tracked: readonly string[]): string[] {
  const entries = new Set<string>();
  for (const path of tracked) {
    const parts = path.split("/");
    if (parts[0] === "skills" && parts.length >= 2) entries.add(join("skills", parts[1]!));
  }
  return [...entries].sort();
}

/** Inspects the host for the parts of the sandbox that depend on it (R48, R49, R51). */
export async function planSandbox(input: PlanInput, overrides: Partial<PlanHost> = {}): Promise<SandboxPlan> {
  const host: PlanHost = { ...defaultHost, ...overrides };
  const rootLinks: SandboxLink[] = [];
  const rootReadOnly: string[] = [];
  if (await host.exists("/opt")) rootReadOnly.push("/opt");
  for (const [path, target] of MERGED_USR_LINKS) {
    const stat = await host.lstat(path);
    if (stat === null) continue;
    if (stat.isSymbolicLink()) rootLinks.push({ path, target });
    else if (stat.isDirectory()) rootReadOnly.push(path);
  }
  const etcReadOnly: string[] = [];
  for (const entry of ETC_ENTRIES) if (await host.exists(`/etc/${entry}`)) etcReadOnly.push(`/etc/${entry}`);
  const runReadOnly: string[] = [];
  for (const path of ["/run/systemd/resolve", "/run/nscd"]) if (await host.exists(path)) runReadOnly.push(path);
  // A resolv.conf that links elsewhere under /run (resolvconf, NetworkManager) needs that directory too; the link itself is bound by
  // its content. Targets outside /run are not widened: bubblewrap binds the file the link resolves to.
  if ((await host.lstat("/etc/resolv.conf"))?.isSymbolicLink() === true) {
    const target = await host.real("/etc/resolv.conf");
    const directory = target === null ? null : dirname(target);
    if (directory !== null && within(directory, "/run") && !runReadOnly.some((path) => directory === path || within(directory, path))) runReadOnly.push(directory);
  }
  const home = await host.real(input.home ?? realHome());
  const hidden = home !== null && home !== "/" ? home : null;
  const homeReadOnly: string[] = [];
  const homeLinks: SandboxLink[] = [];
  const extraReadOnly: string[] = [input.buildRoot];
  const covered = (path: string): boolean => ["/usr", ...rootReadOnly, ...rootLinks.map((link) => link.path)].some((root) => path === root || within(path, root));
  /** Binds `path` read-only where it will be visible: after the home tmpfs below the home, after /tmp otherwise, never twice or below /usr. */
  const bindBack = (path: string): void => {
    if (covered(path)) return;
    const list = hidden !== null && within(path, hidden) ? homeReadOnly : extraReadOnly;
    if (!list.includes(path)) list.push(path);
  };
  const modules = await host.real(join(input.repoRoot, "node_modules"));
  if (modules !== null) bindBack(modules);
  for (const entry of skillEntries(await host.trackedSkills(input.repoRoot, input.tools.git))) {
    const resolved = await host.real(join(input.repoRoot, entry));
    if (resolved !== null) bindBack(resolved);
  }
  // The node binary: a directory outside /usr (and /opt) is bound whole, as the worker's `node` is looked up there.
  const nodePath = input.nodePath ?? process.execPath;
  bindBack(dirname(nodePath));
  const nodeReal = await host.real(nodePath);
  if (nodeReal !== null) bindBack(dirname(nodeReal));
  // codegraph: the binary file itself. A link into a bundle (`<root>/bin/codegraph` with `<root>/node` and `<root>/lib`) is recreated
  // as a link, because the launcher finds its bundle by following it, and only the bundle's bin, node and lib entries are bound.
  const codegraph = input.tools.codegraph;
  const codegraphReal = await host.real(codegraph);
  if (codegraphReal !== null) {
    const binDirectory = dirname(codegraphReal);
    const bundle = dirname(binDirectory);
    // A root directly below the home (`~/.local`, `~/bin`) is far too broad to bind, so it does not count as a bundle.
    const bundled = hidden !== null && basename(binDirectory) === "bin" && within(bundle, hidden) && relative(hidden, bundle).split("/").length >= 2;
    if (codegraphReal !== codegraph && hidden !== null && within(codegraph, hidden)) homeLinks.push({ path: codegraph, target: codegraphReal });
    else if (!bundled) bindBack(codegraph);
    if (bundled) { for (const entry of ["bin", "node", "lib"]) if (await host.exists(join(bundle, entry))) bindBack(join(bundle, entry)); }
    else bindBack(codegraphReal);
  }
  return { rootLinks, rootReadOnly, etcReadOnly, runReadOnly, home: hidden, homeReadOnly, homeLinks, extraReadOnly };
}

/**
 * The bwrap arguments up to and including `--`. The order matters: the allowlist root comes first, the scope bind comes after the
 * tmpfs mounts (a scope below /tmp or $HOME stays writable) and the home directory and then the root are remounted read-only last, which affects only those
 * tmpfs mounts themselves, not the mounts above them. There is no bind of the host's `/`. The task's dependency `binds` (R68) come after
 * the scope bind, so a mount wins over the (empty) mount point inside the clone; they are read-only and nothing else of their directory is visible.
 * `--unshare-pid` is added to the verified shape: `--new-session` moves the command into its own session, where a kill of the
 * supervisor's process group (strace is the leader) would miss it; in a PID namespace the death of bwrap, which `--die-with-parent`
 * ties to strace, ends every process of the sandbox.
 */
export function bwrapArgs(scopeRoot: string, plan: SandboxPlan = EMPTY_PLAN, extraWritable: readonly string[] = [], binds: readonly SandboxBind[] = []): string[] {
  const readOnly = (paths: readonly string[]): string[] => paths.flatMap((path) => ["--ro-bind", path, path]);
  const links = (list: readonly SandboxLink[]): string[] => list.flatMap(({ path, target }) => ["--symlink", target, path]);
  return [
    "--ro-bind", "/usr", "/usr", ...links(plan.rootLinks), ...readOnly(plan.rootReadOnly),
    "--dir", "/etc", ...readOnly(plan.etcReadOnly),
    "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--dir", "/var", "--tmpfs", "/var/tmp", "--tmpfs", "/run",
    ...readOnly(plan.runReadOnly),
    ...(plan.home === null ? [] : ["--tmpfs", plan.home]),
    ...readOnly(plan.homeReadOnly), ...links(plan.homeLinks),
    "--bind", scopeRoot, scopeRoot, ...extraWritable.flatMap((path) => ["--bind", path, path]),
    ...readOnly(plan.extraReadOnly),
    ...binds.flatMap(({ source, target }) => ["--ro-bind", source, target]),
    ...(plan.home === null ? [] : ["--remount-ro", plan.home]),
    "--remount-ro", "/",
    "--die-with-parent", "--new-session", "--unshare-ipc", "--unshare-pid", "--",
  ];
}

/**
 * The host paths a sandbox binds in besides the scope: the plan's read-only binds and links and the task's dependency binds. The trace audit
 * does not count a socket below one of them as internal to the sandbox's private /tmp (R87).
 */
export function boundTargets(plan: SandboxPlan, binds: readonly SandboxBind[] = []): string[] {
  return [...plan.rootReadOnly, ...plan.etcReadOnly, ...plan.runReadOnly, ...plan.homeReadOnly, ...plan.extraReadOnly, ...plan.homeLinks.map((link) => link.path), ...binds.map((bind) => bind.target)];
}

/** `bwrap … -- <command>` with an absolute bwrap path. */
export function sandboxed(
  tools: Pick<ToolPaths, "bwrap">, plan: SandboxPlan, scopeRoot: string, command: readonly string[], extraWritable: readonly string[] = [], binds: readonly SandboxBind[] = [],
): string[] {
  return [tools.bwrap, ...bwrapArgs(scopeRoot, plan, extraWritable, binds), ...command];
}

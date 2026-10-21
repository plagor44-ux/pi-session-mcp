import { access, appendFile, cp, mkdir, readdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { selectBoundaryCredentials, writeBoundaryCredentials } from "../../src/writer-credentials.js";
import { hash } from "../profiles/files.js";
import { prepareDependencies } from "./dependencies.js";
import { runHelper } from "./helpers.js";
import { PAIRINGS } from "./matrix.js";
import type { SandboxBind } from "./sandbox.js";
import type { ToolPaths } from "./tools.js";
import type { Arm, ExtensionId, Pairing, ProfileId, RunSpec, TaskSpec } from "./schemas.js";

const EXTENSION_PINS: Readonly<Record<ExtensionId, string>> = {
  "pi-lens": "npm:pi-lens@4.4.3",
  "pi-cache-optimizer": "npm:pi-cache-optimizer@2.9.3",
};

export interface RunScope {
  /** The directory the traced worker may write to; nothing else is writable for it. */
  root: string;
  clone: string;
  home: string;
  agentDir: string;
  configPath: string;
  env: Record<string, string>;
  /** Inside `root`, so the run unit can write the assistant text there. */
  privateDir: string;
  /** Pristine bare clone made before the worker started, outside `root`. */
  baseGitDir: string;
  /** The task's dependency mounts and runtime (R68), read-only binds for every sandbox that runs in this scope; absent without dependencies. */
  dependencyBinds?: readonly SandboxBind[] | undefined;
}

export interface ScopeInput {
  waveDir: string;
  run: RunSpec;
  task: TaskSpec;
  sourceRepoPath: string;
  extensionTemplate: string;
  hostAuth: unknown;
  productionProfile: Record<string, unknown>;
  skillCatalog?: Record<string, string> | undefined;
  pairing?: Pairing | undefined;
  /** Absolute paths of the tools this module starts (R44). */
  tools: Pick<ToolPaths, "git" | "codegraph">;
  /** The operator's dependency directory (R68); required when the task declares dependencies. */
  depsDir?: string | undefined;
}

export const scopeRoot = (waveDir: string, runId: string): string => join(waveDir, "scopes", runId);
export const privateRunDir = (waveDir: string, runId: string): string => join(waveDir, "private", runId);

/** The codegraph MCP server checks for updates and reports telemetry unless told not to; it would connect out in both arms (R65). */
const TELEMETRY_OPT_OUT: Readonly<Record<string, string>> = { DO_NOT_TRACK: "1", CODEGRAPH_NO_UPDATE_CHECK: "1", CODEGRAPH_TELEMETRY: "0" };
const MAX_ENV_FROM = 64; // src/mcp-config.ts

/** The environment of every traced process: identical for both arms and entirely inside `root`. */
export function scopeEnv(root: string, dirs: { home: string; agentDir: string }): Record<string, string> {
  const xdg = join(root, "xdg");
  return {
    HOME: dirs.home, PI_CODING_AGENT_DIR: dirs.agentDir, TMPDIR: join(root, "tmp"),
    XDG_CONFIG_HOME: join(xdg, "config"), XDG_CACHE_HOME: join(xdg, "cache"), XDG_DATA_HOME: join(xdg, "data"), XDG_STATE_HOME: join(xdg, "state"),
    PI_LENS_HOME: join(root, "pi-lens"),
    PI_LENS_DISABLE_TOOL_INSTALL: "1", PI_LENS_DISABLE_LSP_INSTALL: "1", PI_CACHE_OPTIMIZER_NO_ZERO_PRICE_WARMING: "1",
    UV_USE_IO_URING: "0",
    ...TELEMETRY_OPT_OUT,
    PATH: process.env.PATH ?? "",
  };
}

async function makeScopeDirs(root: string): Promise<{ home: string; agentDir: string; env: Record<string, string>; privateDir: string }> {
  const home = join(root, "home"), agentDir = join(root, "agent"), privateDir = join(root, "private");
  for (const dir of [home, agentDir, join(root, "tmp"), join(root, "xdg", "config"), join(root, "xdg", "cache"), join(root, "xdg", "data"), join(root, "xdg", "state"), join(root, "pi-lens"), privateDir]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  return { home, agentDir, env: scopeEnv(root, { home, agentDir }), privateDir };
}

const gitEnv = (home: string): Record<string, string> => ({ PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];
/** The temporary branch in the pristine bare clone that the worker clone is made from (R69); it is removed again right after. */
const BASE_BRANCH = "eval-base";
const BASE_REF = `refs/heads/${BASE_BRANCH}`;

const inside = (root: string, path: string): boolean => path === root || path.startsWith(root + sep);

/**
 * Refuses a clone holding a symlink whose target resolves outside it (R15): such a link would let the worker write through the
 * clone into the host. Dangling links are judged lexically. The top-level `.git` is not walked.
 */
export async function assertCloneSymlinks(clone: string): Promise<void> {
  const root = await realpath(clone);
  const refuse = (): never => { throw new Error("clone_symlink_escape"); };
  const walk = async (dir: string, top: boolean): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (top && entry.name === ".git") continue;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let target: string;
        try { target = await realpath(path); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return refuse();
          target = resolve(dir, await readlink(path));
        }
        if (!inside(root, target)) refuse();
      } else if (entry.isDirectory()) await walk(path, false);
    }
  };
  await walk(root, true);
}

/**
 * Prepares one run: a full clone at the base commit inside the scope root, a pristine bare clone beside it (outside the root),
 * an evaluation-owned agent directory with boundary credentials, and the run configuration. Every path the traced worker can write
 * to is inside `root`.
 */
export async function prepareRunScope(input: ScopeInput): Promise<RunScope> {
  const { waveDir, run } = input;
  const root = scopeRoot(waveDir, run.runId);
  const baseGitDir = join(privateRunDir(waveDir, run.runId), "base.git");
  await mkdir(dirname(root), { recursive: true });
  await mkdir(root, { mode: 0o700 });
  try {
    return await buildScope(input, root, baseGitDir);
  } catch (error) {
    // No run has started: nothing of a failed scope is kept, credentials included.
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    await rm(baseGitDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function refuseAlternates(paths: string[]): Promise<void> {
  for (const path of paths) if (await access(path).then(() => true, () => false)) throw new Error("source_alternates");
}

async function buildScope(input: ScopeInput, root: string, baseGitDir: string): Promise<RunScope> {
  const { run, task } = input;
  const dirs = await makeScopeDirs(root);
  const clone = join(root, "clone");
  await mkdir(dirname(baseGitDir), { recursive: true, mode: 0o700 });
  const git = (args: string[], cwd?: string) => runHelper(input.tools.git, [...NO_HOOKS, ...args], { env: gitEnv(dirs.home), ...(cwd === undefined ? {} : { cwd }) });
  // No path leads from the worker's view back to the real repository (N5): objects are never shared, the pristine bare clone is made
  // first, the worker clone is made from it, and the bare clone forgets where it came from.
  await refuseAlternates([join(input.sourceRepoPath, ".git", "objects", "info", "alternates"), join(input.sourceRepoPath, "objects", "info", "alternates")]);
  await git(["clone", "--bare", "--no-hardlinks", "--quiet", "--", input.sourceRepoPath, baseGitDir]);
  await refuseAlternates([join(baseGitDir, "objects", "info", "alternates")]);
  // R69: the worker clone holds only the history reachable from the base commit. A temporary branch at the base commit is the only
  // thing a single-branch clone over the transport (`--no-local`) fetches; no later commit, branch or tag can be read from the clone.
  const bare = (args: string[]) => git(["--git-dir", baseGitDir, ...args]);
  await bare(["update-ref", BASE_REF, task.baseCommit]);
  await git(["clone", "--no-local", "--single-branch", "--branch", BASE_BRANCH, "--no-tags", "--quiet", "--", baseGitDir, clone]);
  await bare(["update-ref", "-d", BASE_REF]);
  await refuseAlternates([join(clone, ".git", "objects", "info", "alternates")]);
  await runHelper(input.tools.git, ["--git-dir", baseGitDir, "config", "--unset", "remote.origin.url"], { env: gitEnv(dirs.home) }).catch((error: { code?: unknown }) => {
    if (error.code !== 5) throw error; // 5: the key was not set
  });
  await git(["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", task.baseCommit], clone);
  // The temporary branch and its remote-tracking ref go; whatever else the clone listed goes too, so no ref is left in it.
  await git(["branch", "--quiet", "-D", BASE_BRANCH], clone);
  for (const ref of (await git(["for-each-ref", "--format=%(refname)"], clone)).stdout.split("\n").filter((name) => name !== "")) await git(["update-ref", "-d", ref], clone);
  await assertCloneSymlinks(clone);
  // The clone must not point at the real repository: a push or fetch goes to the pristine bare clone, outside the scope root.
  const remotes = (await git(["remote"], clone)).stdout.split("\n").filter((name) => name !== "");
  for (const name of remotes) if (name !== "origin") await git(["remote", "remove", name], clone);
  await git(remotes.includes("origin") ? ["remote", "set-url", "origin", baseGitDir] : ["remote", "add", "origin", baseGitDir], clone);
  const dependencyBinds = await prepareDependencies({ depsDir: input.depsDir, task, baseGitDir, clone, git: bare });
  await appendFile(join(clone, ".git", "info", "exclude"), "\n.codegraph/\n");
  await runHelper(input.tools.codegraph, ["init", "-y", clone], { env: dirs.env, cwd: root });

  const provider = input.productionProfile.provider;
  if (typeof provider !== "string") throw new Error("profile_provider_missing");
  await writeBoundaryCredentials(dirs.agentDir, selectBoundaryCredentials(input.hostAuth, [provider]));
  if (run.arm !== "A") await cp(join(input.extensionTemplate, "npm"), join(dirs.agentDir, "npm"), { recursive: true, verbatimSymlinks: true });

  const configPath = join(root, "config.json");
  await writeFile(configPath, `${JSON.stringify(runConfig(run.profile, run.arm, input.productionProfile, clone, input.skillCatalog, input.pairing), null, 2)}\n`, { mode: 0o600 });
  return { root, clone, home: dirs.home, agentDir: dirs.agentDir, configPath, env: dirs.env, privateDir: dirs.privateDir, baseGitDir, ...(dependencyBinds.length === 0 ? {} : { dependencyBinds }) };
}

/** The pairing that arm B of `run` belongs to; the profile and the extension identify it uniquely. */
export function pairingOf(run: RunSpec): Pairing | undefined {
  return run.arm === "A" ? undefined : PAIRINGS.find((p) => p.profile === run.profile && p.extension === run.arm);
}

/**
 * The profile with the opt-out variables forwarded to every MCP server (R65). The MCP child does not inherit the run environment,
 * only what `envFrom` names from the worker's, so each server maps the opt-out variables to themselves. The evaluation's mapping
 * wins for these variables; every other entry and the rest of the profile stay as they are.
 */
function withTelemetryOptOut(profile: Record<string, unknown>): Record<string, unknown> {
  const servers = profile.mcpServers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return profile;
  const mapped = Object.fromEntries(Object.entries(servers).map(([alias, server]) => {
    if (typeof server !== "object" || server === null || Array.isArray(server)) return [alias, server];
    const existing = (server as { envFrom?: unknown }).envFrom;
    const envFrom = { ...(typeof existing === "object" && existing !== null ? existing : {}), ...Object.fromEntries(Object.keys(TELEMETRY_OPT_OUT).map((name) => [name, name])) };
    if (Object.keys(envFrom).length > MAX_ENV_FROM) throw new Error("mcp_env_from_overflow");
    return [alias, { ...server, envFrom }];
  }));
  return { ...profile, mcpServers: mapped };
}

/**
 * Production profile under its own alias, `default` for read-only ones. A coding profile cannot be the default, so a read-only copy
 * named `<alias>-ro` is the default beside it. The profile is copied as it is, except that every MCP server forwards the telemetry
 * and update-check opt-out variables (R65). Arm B adds the extension pin and, where the pairing grants them, its tools.
 */
export function runConfig(
  alias: ProfileId, arm: Arm, production: Record<string, unknown>, clone: string, skillCatalog: Record<string, string> | undefined, pairing: Pairing | undefined,
): Record<string, unknown> {
  const profile = withTelemetryOptOut(production);
  const entry: Record<string, unknown> = { ...profile };
  if (arm !== "A") {
    const existing = Array.isArray(profile.extensions) ? profile.extensions as string[] : [];
    entry.extensions = [...new Set([...existing, EXTENSION_PINS[arm]])];
    if (pairing === undefined) throw new Error("pairing_not_found");
    if (pairing.grantedExtensionTools !== undefined) entry.grantedExtensionTools = [...pairing.grantedExtensionTools];
  }
  const executionProfiles = profile.permissionProfile === "coding"
    ? { [alias]: { ...entry, default: false }, [`${alias}-ro`]: { ...profile, permissionProfile: "read-only", default: true } }
    : { [alias]: { ...entry, default: true } };
  return { workspaces: { clone }, ...(skillCatalog === undefined ? {} : { skillCatalog }), executionProfiles };
}

/** An empty scope for a prompt that needs no repository (the preflight); the clone directory is empty. */
export async function prepareEmptyScope(input: {
  waveDir: string; name: string; profile: ProfileId; hostAuth: unknown; productionProfile: Record<string, unknown>; skillCatalog?: Record<string, string> | undefined;
}): Promise<RunScope> {
  const root = scopeRoot(input.waveDir, input.name);
  await mkdir(dirname(root), { recursive: true });
  await mkdir(root, { mode: 0o700 });
  try {
    return await buildEmptyScope(input, root);
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function buildEmptyScope(input: Parameters<typeof prepareEmptyScope>[0], root: string): Promise<RunScope> {
  const dirs = await makeScopeDirs(root);
  const clone = join(root, "clone");
  await mkdir(clone, { mode: 0o700 });
  const provider = input.productionProfile.provider;
  if (typeof provider !== "string") throw new Error("profile_provider_missing");
  await writeBoundaryCredentials(dirs.agentDir, selectBoundaryCredentials(input.hostAuth, [provider]));
  const configPath = join(root, "config.json");
  await writeFile(configPath, `${JSON.stringify(runConfig(input.profile, "A", input.productionProfile, clone, input.skillCatalog, undefined), null, 2)}\n`, { mode: 0o600 });
  return { root, clone, home: dirs.home, agentDir: dirs.agentDir, configPath, env: dirs.env, privateDir: dirs.privateDir, baseGitDir: join(root, "no-base.git") };
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The forms in which a prompt may name the source repository: as configured, its real path and its `~/` form. */
async function sourceForms(sourceRepoPath: string): Promise<string[]> {
  const real = await realpath(sourceRepoPath).catch(() => sourceRepoPath);
  const forms = new Set([sourceRepoPath, real]);
  for (const path of [sourceRepoPath, real]) {
    const fromHome = relative(homedir(), path);
    if (fromHome !== "" && !fromHome.startsWith("..") && !fromHome.startsWith("/")) forms.add(`~/${fromHome}`);
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

/** A form on a path boundary: not the tail of a longer path, not the head of a sibling such as `repo-other`. */
const boundaryPattern = (forms: string[]): RegExp =>
  new RegExp(`(?<![A-Za-z0-9_.~/-])(?:${forms.map(escapeRegExp).join("|")})(?![A-Za-z0-9_-])(?!\\.[A-Za-z0-9])`, "g");

/**
 * The recorded prompt with the source repository (as configured, as real path and as `~/` path, on path boundaries only) rewritten
 * to the clone; the bytes must match the task's hash. Fails with `source_path_leak` if a form is left once the clone path is ignored.
 */
export async function renderPrompt(repoRoot: string, task: TaskSpec, sourceRepoPath: string, clone: string): Promise<string> {
  const bytes = await readFile(resolve(repoRoot, task.promptRef));
  if (hash(bytes) !== task.promptHash) throw new Error("prompt_hash_mismatch");
  const forms = await sourceForms(sourceRepoPath);
  const rewritten = bytes.toString("utf8").replace(boundaryPattern(forms), () => clone);
  // The clone may itself live below the source path (a wave directory under the repository): only a form outside the clone counts.
  if (boundaryPattern(forms).test(rewritten.split(clone).join(""))) throw new Error("source_path_leak");
  return rewritten;
}

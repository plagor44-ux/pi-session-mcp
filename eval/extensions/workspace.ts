import { execFile } from "node:child_process";
import { appendFile, cp, mkdir, readdir, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { selectBoundaryCredentials, writeBoundaryCredentials } from "../../src/writer-credentials.js";
import { hash } from "../profiles/files.js";
import { PAIRINGS } from "./matrix.js";
import type { Arm, ExtensionId, Pairing, ProfileId, RunSpec, TaskSpec } from "./schemas.js";

const execFileAsync = promisify(execFile);

export const EXTENSION_PINS: Readonly<Record<ExtensionId, string>> = {
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
}

export const scopeRoot = (waveDir: string, runId: string): string => join(waveDir, "scopes", runId);
export const privateRunDir = (waveDir: string, runId: string): string => join(waveDir, "private", runId);

/** The environment of every traced process: identical for both arms and entirely inside `root`. */
export function scopeEnv(root: string, dirs: { home: string; agentDir: string }): Record<string, string> {
  const xdg = join(root, "xdg");
  return {
    HOME: dirs.home, PI_CODING_AGENT_DIR: dirs.agentDir, TMPDIR: join(root, "tmp"),
    XDG_CONFIG_HOME: join(xdg, "config"), XDG_CACHE_HOME: join(xdg, "cache"), XDG_DATA_HOME: join(xdg, "data"), XDG_STATE_HOME: join(xdg, "state"),
    PI_LENS_HOME: join(root, "pi-lens"),
    PI_LENS_DISABLE_TOOL_INSTALL: "1", PI_LENS_DISABLE_LSP_INSTALL: "1", PI_CACHE_OPTIMIZER_NO_ZERO_PRICE_WARMING: "1",
    UV_USE_IO_URING: "0",
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
  const { waveDir, run, task } = input;
  const root = scopeRoot(waveDir, run.runId);
  await mkdir(dirname(root), { recursive: true });
  await mkdir(root, { mode: 0o700 });
  const dirs = await makeScopeDirs(root);
  const clone = join(root, "clone");
  const baseGitDir = join(privateRunDir(waveDir, run.runId), "base.git");
  await mkdir(dirname(baseGitDir), { recursive: true, mode: 0o700 });
  const git = (args: string[], cwd?: string) => execFileAsync("git", [...NO_HOOKS, ...args], { env: gitEnv(dirs.home), ...(cwd === undefined ? {} : { cwd }) });
  await git(["clone", "--bare", "--no-hardlinks", "--quiet", "--", input.sourceRepoPath, baseGitDir]);
  await git(["clone", "--no-hardlinks", "--quiet", "--", input.sourceRepoPath, clone]);
  await git(["-c", "advice.detachedHead=false", "checkout", "--quiet", task.baseCommit], clone);
  await assertCloneSymlinks(clone);
  await appendFile(join(clone, ".git", "info", "exclude"), "\n.codegraph/\n");
  await execFileAsync("codegraph", ["init", "-y", clone], { env: dirs.env, cwd: root });

  const provider = input.productionProfile.provider;
  if (typeof provider !== "string") throw new Error("profile_provider_missing");
  await writeBoundaryCredentials(dirs.agentDir, selectBoundaryCredentials(input.hostAuth, [provider]));
  if (run.arm !== "A") await cp(join(input.extensionTemplate, "npm"), join(dirs.agentDir, "npm"), { recursive: true, verbatimSymlinks: true });

  const configPath = join(root, "config.json");
  await writeFile(configPath, `${JSON.stringify(runConfig(run.profile, run.arm, input.productionProfile, clone, input.skillCatalog, input.pairing), null, 2)}\n`, { mode: 0o600 });
  return { root, clone, home: dirs.home, agentDir: dirs.agentDir, configPath, env: dirs.env, privateDir: dirs.privateDir, baseGitDir };
}

/** The pairing that arm B of `run` belongs to; the profile and the extension identify it uniquely. */
export function pairingOf(run: RunSpec): Pairing | undefined {
  return run.arm === "A" ? undefined : PAIRINGS.find((p) => p.profile === run.profile && p.extension === run.arm);
}

/**
 * Production profile under its own alias, `default` for read-only ones. A coding profile cannot be the default, so a read-only copy
 * named `<alias>-ro` is the default beside it. Arm B adds the extension pin and, where the pairing grants them, its tools.
 */
export function runConfig(
  alias: ProfileId, arm: Arm, profile: Record<string, unknown>, clone: string, skillCatalog: Record<string, string> | undefined, pairing: Pairing | undefined,
): Record<string, unknown> {
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

/** The recorded prompt with the source repository path rewritten to the clone; the bytes must match the task's hash. */
export async function renderPrompt(repoRoot: string, task: TaskSpec, sourceRepoPath: string, clone: string): Promise<string> {
  const bytes = await readFile(resolve(repoRoot, task.promptRef));
  if (hash(bytes) !== task.promptHash) throw new Error("prompt_hash_mismatch");
  return bytes.toString("utf8").split(sourceRepoPath).join(clone);
}

import { lstat, mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runHelper } from "./helpers.js";
import type { SandboxBind } from "./sandbox.js";
import type { TaskSpec } from "./schemas.js";
import { assertDepsDirOutsideSources, assertOutsideSources } from "./tools.js";

/*
 * R68: a task may declare installed dependencies (a Python venv, node_modules) that the operator built beforehand. Layout per task:
 *   <deps>/<taskId>/mounts/<path>/     the dependency content, a real directory
 *   <deps>/<taskId>/lock/<lockfile>    the lockfile it was built from
 *   <deps>/<taskId>/runtime/           optional: what the content references by absolute path (the interpreter of a venv)
 * The content is bound read-only at `<clone>/<path>` and the runtime read-only at its own (real) path; nothing else of `<deps>` is
 * visible in the sandbox. The lock copy must equal the lockfile at the base commit, so the dependencies are the ones the base asks for.
 * The deps directory is canonical (its realpath is its resolved path) and nothing below it on the way to a bind source may be a link:
 * every source is checked to be exactly `<deps>/<taskId>/{mounts/<path>,runtime}`, so a link cannot bring a source checkout into the sandbox.
 * Errors carry fixed codes only; no path reaches a message.
 */

/** Runs `git <args>` in the repository that holds the task's base commit. The function chooses the repository; the arguments never name one. */
export type Git = (args: string[]) => Promise<{ stdout: string }>;

const hasDependencies = (task: TaskSpec): boolean => (task.dependencies?.length ?? 0) > 0;

/**
 * The tasks that will run need `--deps`; a given directory must not lie in or contain a source, the wave directory included, and must be
 * canonical (`deps_dir_not_canonical`): the runtime is bound at its real path, which the content references only if that is the path it was built at.
 */
export async function assertDependencyDir(depsDir: string | undefined, tasks: readonly TaskSpec[], sources: Iterable<string>): Promise<void> {
  if (depsDir === undefined) {
    if (tasks.some(hasDependencies)) throw new Error("deps_missing");
    return;
  }
  await assertDepsDirOutsideSources(depsDir, sources);
  const real = await realpath(depsDir).catch(() => null);
  if (real !== null && real !== resolve(depsDir)) throw new Error("deps_dir_not_canonical");
}

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

/** The entry's `lstat` (a link is not followed), or null when it does not exist. */
async function entry(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try { return await lstat(path); } catch (error) {
    if (isMissing(error)) return null;
    throw new Error("dependency_mount_invalid");
  }
}

/** `path` is a directory or file whose realpath is `path` itself: no link on its way and none at its end. Anything else fails with `code`. */
async function exactly(path: string, kind: "directory" | "file", code: string): Promise<string> {
  const fail = (): never => { throw new Error(code); };
  const info = await entry(path).catch(fail);
  if (info === null || !(kind === "directory" ? info.isDirectory() : info.isFile())) return fail();
  if (await realpath(path).catch(fail) !== path) fail();
  return path;
}

/** The lock copy is a regular file below `lock/` (no link anywhere on its way) with the blob id of the lockfile at the base commit. */
async function assertLock(lockDir: string, lockfile: string, commit: string, git: Git): Promise<void> {
  const mismatch = (): never => { throw new Error("dependency_lock_mismatch"); };
  const path = await exactly(join(lockDir, lockfile), "file", "dependency_lock_mismatch");
  const expected = (await git(["rev-parse", "--verify", "--quiet", `${commit}:${lockfile}`]).catch(mismatch)).stdout.trim();
  const actual = (await git(["hash-object", "--no-filters", "--", path]).catch(mismatch)).stdout.trim();
  if (expected === "" || actual !== expected) mismatch();
}

export interface CheckedDependencies {
  /** Each declared dependency with its mount: the real path of `<deps>/<taskId>/mounts/<path>`. */
  mounts: { path: string; source: string }[];
  /** The real path of `<deps>/<taskId>/runtime`, or null without one. */
  runtime: string | null;
}

/**
 * The read-only checks of a task's dependencies, which need only the repository's git: `deps_missing` without a directory,
 * `deps_dir_not_canonical`, `dependency_missing` (no task directory or mount), `dependency_mount_invalid` (a link or a file where a real
 * directory belongs, at any level of the way to the mount or the runtime), `dependency_lock_mismatch` (the lock copy is not the base
 * commit's lockfile, or a link is on its way) and `dependency_path_tracked`. Every bind source must also lie outside `sources`.
 */
export async function checkDependencies(input: { depsDir: string | undefined; task: TaskSpec; git: Git; sources?: Iterable<string> }): Promise<CheckedDependencies> {
  const { depsDir, task, git } = input;
  const checked: CheckedDependencies = { mounts: [], runtime: null };
  if (!hasDependencies(task)) return checked;
  if (depsDir === undefined) throw new Error("deps_missing");
  const real = await realpath(depsDir).catch((error: unknown) => { throw new Error(isMissing(error) ? "dependency_missing" : "dependency_mount_invalid"); });
  if (real !== resolve(depsDir)) throw new Error("deps_dir_not_canonical");
  const taskDir = join(real, task.id);
  if (await entry(taskDir) === null) throw new Error("dependency_missing");
  await exactly(taskDir, "directory", "dependency_mount_invalid");
  for (const { path, lockfile } of task.dependencies ?? []) {
    await assertLock(join(taskDir, "lock"), lockfile, task.baseCommit, git);
    const mount = join(taskDir, "mounts", path);
    if (await entry(mount) === null) throw new Error("dependency_missing");
    checked.mounts.push({ path, source: await exactly(mount, "directory", "dependency_mount_invalid") });
    // A dependency must not shadow tracked files: the path may not exist in the base tree.
    if ((await git(["ls-tree", "-z", task.baseCommit, "--", path])).stdout !== "") throw new Error("dependency_path_tracked");
  }
  if (await entry(join(taskDir, "runtime")) !== null) checked.runtime = await exactly(join(taskDir, "runtime"), "directory", "dependency_mount_invalid");
  for (const source of [...checked.mounts.map((mount) => mount.source), ...(checked.runtime === null ? [] : [checked.runtime])]) {
    await assertOutsideSources(source, input.sources ?? [], "deps_dir_in_source");
  }
  return checked;
}

/**
 * The checks of `checkDependencies` for every task that declares dependencies, before anything runs: only reads of the source repository's
 * git. `sources` are the directories no bind source may lie in or contain.
 */
export async function checkTaskDependencies(input: {
  depsDir: string | undefined; tasks: readonly TaskSpec[]; workspaces: Readonly<Record<string, string>>; git: string; sources: Iterable<string>;
}): Promise<void> {
  const sources = [...input.sources];
  const env = { PATH: process.env.PATH ?? "", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  for (const task of new Map(input.tasks.map((t) => [t.id, t])).values()) {
    if (!hasDependencies(task)) continue;
    const repository = input.workspaces[task.repo];
    if (repository === undefined) throw new Error("run_inputs_missing");
    await checkDependencies({ depsDir: input.depsDir, task, sources, git: (args) => runHelper(input.git, ["-C", repository, "-c", "core.hooksPath=/dev/null", ...args], { env }) });
  }
}

/**
 * Checks the task's dependencies and prepares the clone for them: the mount point `<clone>/<path>` is created as an empty directory
 * (git does not list it, so the scope check stays clean). Returns the read-only binds for the sandbox: each mount at its place in the
 * clone, then the runtime at its own path. `git` runs in the pristine bare clone; the codes are those of `checkDependencies`.
 */
export async function prepareDependencies(input: { depsDir: string | undefined; task: TaskSpec; clone: string; git: Git; sources?: Iterable<string> }): Promise<SandboxBind[]> {
  const { mounts, runtime } = await checkDependencies(input);
  const binds: SandboxBind[] = [];
  const realClone = await realpath(input.clone);
  for (const { path, source } of mounts) {
    const target = join(input.clone, path);
    await mkdir(target, { recursive: true });
    if (await realpath(target) !== join(realClone, path)) throw new Error("dependency_mount_invalid");
    binds.push({ source, target });
  }
  if (runtime !== null) binds.push({ source: runtime, target: runtime });
  return binds;
}

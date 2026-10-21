import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { SandboxBind } from "./sandbox.js";
import type { TaskSpec } from "./schemas.js";
import { assertDepsDirOutsideSources } from "./tools.js";

/*
 * R68: a task may declare installed dependencies (a Python venv, node_modules) that the operator built beforehand. Layout per task:
 *   <deps>/<taskId>/mounts/<path>/     the dependency content, a real directory
 *   <deps>/<taskId>/lock/<lockfile>    the lockfile it was built from
 *   <deps>/<taskId>/runtime/           optional: what the content references by absolute path (the interpreter of a venv)
 * The content is bound read-only at `<clone>/<path>` and the runtime read-only at its own (real) path; nothing else of `<deps>` is
 * visible in the sandbox. The lock copy must equal the lockfile at the base commit, so the dependencies are the ones the base asks for.
 * Errors carry fixed codes only; no path reaches a message.
 */

type Git = (args: string[]) => Promise<{ stdout: string }>;

/** The tasks that will run need `--deps`; a given directory must not lie in or contain a source, the wave directory included. */
export async function assertDependencyDir(depsDir: string | undefined, tasks: readonly TaskSpec[], sources: Iterable<string>): Promise<void> {
  if (depsDir === undefined) {
    if (tasks.some((task) => (task.dependencies?.length ?? 0) > 0)) throw new Error("deps_missing");
    return;
  }
  await assertDepsDirOutsideSources(depsDir, sources);
}

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

/** The entry's `lstat` (a link is not followed), or null when it does not exist. */
async function entry(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try { return await lstat(path); } catch (error) {
    if (isMissing(error)) return null;
    throw new Error("dependency_mount_invalid");
  }
}

/** The lock copy is a regular file below `lock/` (no link anywhere on its way) with the blob id of the lockfile at the base commit. */
async function assertLock(lockDir: string, lockfile: string, baseGitDir: string, commit: string, git: Git): Promise<void> {
  const mismatch = (): never => { throw new Error("dependency_lock_mismatch"); };
  const path = join(lockDir, lockfile);
  if (!(await entry(path).catch(mismatch))?.isFile()) return mismatch();
  if (await realpath(path).catch(mismatch) !== join(await realpath(lockDir).catch(mismatch), lockfile)) return mismatch();
  const expected = (await git(["--git-dir", baseGitDir, "rev-parse", "--verify", "--quiet", `${commit}:${lockfile}`]).catch(mismatch)).stdout.trim();
  const actual = (await git(["--git-dir", baseGitDir, "hash-object", "--no-filters", "--", path]).catch(mismatch)).stdout.trim();
  if (expected === "" || actual !== expected) mismatch();
}

/** A real directory below `parent` (`relative` names it); a link anywhere on the way, or a file, refuses. */
async function assertRealDirectory(parent: string, relative: string): Promise<string> {
  const invalid = (): never => { throw new Error("dependency_mount_invalid"); };
  const path = join(parent, relative);
  if (!(await entry(path).catch(invalid))?.isDirectory()) return invalid();
  const real = await realpath(path).catch(invalid);
  if (real !== join(await realpath(parent).catch(invalid), relative)) invalid();
  return real;
}

/**
 * Checks the task's dependencies against the pristine bare clone and prepares the clone for them: the mount point `<clone>/<path>` is
 * created as an empty directory (git does not list it, so the scope check stays clean). Returns the read-only binds for the sandbox:
 * each mount at its place in the clone, then the runtime at its own path. Throws `deps_missing` without a directory,
 * `dependency_lock_mismatch`, `dependency_missing`, `dependency_path_tracked` and `dependency_mount_invalid` (a link or a file where
 * a real directory belongs).
 */
export async function prepareDependencies(input: { depsDir: string | undefined; task: TaskSpec; baseGitDir: string; clone: string; git: Git }): Promise<SandboxBind[]> {
  const { depsDir, task, baseGitDir, clone, git } = input;
  const dependencies = task.dependencies ?? [];
  if (dependencies.length === 0) return [];
  if (depsDir === undefined) throw new Error("deps_missing");
  const taskDir = join(depsDir, task.id);
  if (await entry(taskDir) === null) throw new Error("dependency_missing");
  const binds: SandboxBind[] = [];
  const realClone = await realpath(clone);
  for (const { path, lockfile } of dependencies) {
    await assertLock(join(taskDir, "lock"), lockfile, baseGitDir, task.baseCommit, git);
    if (await entry(join(taskDir, "mounts", path)) === null) throw new Error("dependency_missing");
    const source = await assertRealDirectory(join(taskDir, "mounts"), path);
    // A dependency must not shadow tracked files: the path may not exist in the base tree.
    if ((await git(["--git-dir", baseGitDir, "ls-tree", "-z", task.baseCommit, "--", path])).stdout !== "") throw new Error("dependency_path_tracked");
    const target = join(clone, path);
    await mkdir(target, { recursive: true });
    if (await realpath(target) !== join(realClone, path)) throw new Error("dependency_mount_invalid");
    binds.push({ source, target });
  }
  if (await entry(join(taskDir, "runtime")) !== null) {
    const runtime = await assertRealDirectory(taskDir, "runtime");
    binds.push({ source: runtime, target: runtime });
  }
  return binds;
}

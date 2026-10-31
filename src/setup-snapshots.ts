import { lstat, readFile, readdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { ALIAS_PATTERN } from "./execution-profile.js";
import { acquireSetupGuardian } from "./setup-process.js";
import { result, type SetupResult, type SetupStatus } from "./setup-result.js";
import { makeTreeRemovable } from "./writer-tree-removal.js";
import { assertNoConversionDrivers, ensureSnapshotRoot, guardedGit, isObjectId, lockSnapshotExclusive, readSnapshotState, removeSnapshotState, SnapshotError, snapshotPaths, trustedGit, verifyClean, verifySnapshot, writeSnapshotState, type SnapshotGit, type SnapshotPaths, type TrustedGitOptions } from "./review-snapshot.js";

export interface SnapshotRequest { readonly alias: string; readonly apply: boolean; readonly remove: boolean; readonly discard: boolean; readonly head?: string; readonly base?: string; }
export interface SnapshotDependencies { readonly home?: string; readonly platform?: NodeJS.Platform; readonly signal?: AbortSignal; readonly gitOptions?: TrustedGitOptions & { readonly envCandidates?: readonly string[] }; readonly guardian?: typeof acquireSetupGuardian; }
function fail(code: string): never { throw new Error(code); }
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; } }
async function command(git: SnapshotGit, cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
  const value = await git.run(cwd, args, signal ? { signal } : {});
  if (value.code !== 0) fail("snapshot_unavailable");
  return value.stdout;
}
/** Locate only entries with Git's exact back-pointer; never prune unrelated worktrees. */
async function registrations(git: SnapshotGit, source: string, worktree: string): Promise<string[]> {
  const common = await realpath((await command(git, source, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
  const parent = join(common, "worktrees");
  let names: string[];
  try { names = await readdir(parent); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  const found: string[] = [];
  for (const name of names) {
    const entry = join(parent, name);
    if (!(await lstat(entry)).isDirectory()) continue;
    const back = join(entry, "gitdir");
    try {
      if (!(await lstat(back)).isFile()) continue;
      if ((await readFile(back, "utf8")).replace(/\n$/, "") !== join(worktree, ".git")) continue;
      const commonFile = join(entry, "commondir");
      if (!(await lstat(commonFile)).isFile()) continue;
      if (await realpath(resolve(entry, (await readFile(commonFile, "utf8")).trim())) !== common) continue;
      found.push(entry);
    } catch { continue; }
  }
  return found;
}

export async function runSnapshotOperation(configPath: string, request: SnapshotRequest, deps: SnapshotDependencies = {}): Promise<SetupResult> {
  const operation = request.remove ? "remove" : request.apply ? "apply" : "dry-run";
  const target = { client: "snapshot", scope: "workspace", alias: ALIAS_PATTERN.test(request.alias) ? request.alias : "invalid" };
  const done = (status: SetupStatus, code: string, extra = false): SetupResult => result(operation, [{ target, status, code }, ...(extra ? [{ target, status: "ok" as const, code: "snapshot_discarded" }] : [])], status === "planned" ? "planned" : undefined);
  if (!ALIAS_PATTERN.test(request.alias) || (!request.remove && (!request.head || !request.base || !isObjectId(request.head) || !isObjectId(request.base)))) return result(operation, [{ target, status: "failed", code: "usage_invalid" }], "failed", 64);
  try {
    const config = await loadConfig(configPath).catch(() => fail("config_invalid"));
    const mode = config.workspaceModes.get(request.alias), configured = config.workspaces.get(request.alias);
    if (mode?.mode !== "snapshot" || !configured || !mode.snapshot) fail("snapshot_alias_invalid");
    const sourceAlias = mode.snapshot.source, source = config.workspaces.get(sourceAlias), sourceMode = config.workspaceModes.get(sourceAlias)?.mode;
    if (!source || (sourceMode !== "host" && sourceMode !== "container")) fail("snapshot_alias_invalid");
    const paths = snapshotPaths(deps.home ?? homedir(), request.alias);
    if (resolve(configured) !== resolve(paths.worktree)) fail("snapshot_path_mismatch");
    const git = trustedGit(deps.gitOptions); if (!git) fail("snapshot_unavailable");
    if (request.apply && (deps.platform ?? process.platform) !== "linux") fail("snapshot_unsupported_platform");
    let tree: string | undefined;
    if (!request.remove) {
      for (const id of [request.head!, request.base!]) {
        const commit = await git.run(source, ["rev-parse", "--verify", "--end-of-options", `${id}^{commit}`]);
        if (commit.code !== 0 || commit.stdout.trim() !== id) fail("snapshot_object_missing");
      }
      const listing = await command(git, source, ["ls-tree", "-r", "-z", "--end-of-options", request.head!]);
      if (listing.split("\0").some((item) => item.startsWith("160000 "))) fail("snapshot_submodule_present");
      await assertNoConversionDrivers(git, source);
      tree = (await command(git, source, ["rev-parse", "--verify", "--end-of-options", `${request.head}^{tree}`])).trim();
      if (!isObjectId(tree)) fail("snapshot_unavailable");
    }
    const work = async (pathsHere: SnapshotPaths, mutation?: SnapshotGit, check = (): void => {}): Promise<SetupResult> => {
      let state;
      try { state = await readSnapshotState(pathsHere); } catch (e) { if (!(e instanceof SnapshotError) || e.code !== "snapshot_incomplete") throw e; }
      const present = await exists(pathsHere.worktree);
      if (state && present && state.source === sourceAlias && !request.remove && state.head === request.head && state.base === request.base && state.tree === tree) {
        try { await verifySnapshot(git, pathsHere.worktree, state); check(); return done("unchanged", "unchanged"); } catch (e) { if (!(e instanceof SnapshotError) || e.code !== "snapshot_modified") throw e; if (!mutation && !request.discard) throw e; }
      }
      if (!mutation) {
        if (state && present && !request.discard) await verifySnapshot(git, pathsHere.worktree, state);
        return done("planned", "snapshot_planned");
      }
      check();
      const entries = await registrations(git, source, pathsHere.worktree);
      if (entries.length > 1) fail("snapshot_incomplete");
      let initializing = false;
      if (entries.length === 1) {
        const locked = join(entries[0]!, "locked");
        try {
          if (!(await lstat(locked)).isFile()) fail("snapshot_incomplete");
          if ((await readFile(locked, "utf8")).replace(/\n$/, "") !== "initializing" || !request.discard) fail("snapshot_incomplete");
          initializing = true;
        } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      }
      let discarded = false;
      if (present) {
        if (!(await lstat(pathsHere.worktree)).isDirectory() || entries.length !== 1) fail("snapshot_incomplete");
        // The worktree's own pointer must name this administrative entry too.
        const dotgit = join(pathsHere.worktree, ".git");
        if (!(await lstat(dotgit)).isFile() || (await readFile(dotgit, "utf8")).trim() !== `gitdir: ${entries[0]}`) fail("snapshot_incomplete");
        let modified = false;
        try { if (state && state.source === sourceAlias) await verifySnapshot(git, pathsHere.worktree, state); else await verifyClean(git, pathsHere.worktree); }
        catch (e) { if (e instanceof SnapshotError && e.code === "snapshot_modified") modified = true; else throw e; }
        if (modified && !request.discard) fail(state ? "snapshot_modified" : "snapshot_incomplete");
        // Never run Git removal in a context with a conversion driver, even with discard.
        await assertNoConversionDrivers(git, pathsHere.worktree);
        check();
        await command(mutation, source, ["worktree", "remove", ...(initializing ? ["--force", "--force"] : modified ? ["--force"] : []), pathsHere.worktree], deps.signal);
        check(); discarded = modified;
      } else if (entries.length === 1) {
        // Git has no targeted prune for a missing worktree: remove its checked administrative entry only.
        await makeTreeRemovable(entries[0]!); await rm(entries[0]!, { recursive: true }); check();
      }
      await removeSnapshotState(pathsHere); check();
      if (request.remove) return done(present || entries.length || state ? "ok" : "absent", present || entries.length || state ? "snapshot_removed" : "absent", discarded);
      await assertNoConversionDrivers(git, source); check();
      await command(mutation, source, ["worktree", "add", "--no-checkout", "--detach", pathsHere.worktree, request.head!], deps.signal); check();
      try { await assertNoConversionDrivers(git, pathsHere.worktree); }
      catch (e) {
        if (e instanceof SnapshotError && e.code === "snapshot_source_unsupported") {
          check(); await command(mutation, source, ["worktree", "remove", "--force", pathsHere.worktree], deps.signal); check();
        }
        throw e;
      }
      check(); await command(mutation, pathsHere.worktree, ["reset", "--hard", request.head!, "--"], deps.signal); check();
      await verifySnapshot(git, pathsHere.worktree, { head: request.head!, base: request.base!, tree: tree! }); check();
      await writeSnapshotState(pathsHere, { v: 1, source: sourceAlias, head: request.head!, base: request.base!, tree: tree!, at: new Date().toISOString() }); check();
      return done("ok", "snapshot_applied", discarded);
    };
    if (!request.apply) return await work(paths);
    await ensureSnapshotRoot(paths);
    const lock = await lockSnapshotExclusive(paths, deps.signal ? { signal: deps.signal } : {});
    try {
      const guardian = await (deps.guardian ?? acquireSetupGuardian)(lock.fd, 10_000, deps.signal);
      try {
        const guarded = guardedGit(guardian.runner, deps.gitOptions); if (!guarded) fail("snapshot_unavailable");
        const check = () => { if (guardian.signal.aborted || deps.signal?.aborted) fail("snapshot_unavailable"); };
        check();
        const root = await realpath(paths.root);
        return await work({ ...paths, root, worktree: join(root, "worktree"), state: join(root, "state.json"), lock: join(root, "slot.lock") }, guarded, check);
      } finally { await guardian.release(); }
    } finally { await lock.release(); }
  } catch (error) {
    const code = error instanceof SnapshotError ? error.code : error instanceof Error && /^(?:snapshot_[a-z_]+|config_invalid)$/.test(error.message) ? error.message : "snapshot_unavailable";
    return done("failed", code);
  }
}

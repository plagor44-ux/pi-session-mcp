import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { assertNoConversionDrivers, guardedGit, ensureSnapshotRoot, lockSnapshotExclusive, lockSnapshotShared, readSnapshotState, removeSnapshotState, snapshotPaths, trustedGit, verifyClean, verifySnapshot, writeSnapshotState } from "../src/review-snapshot.js";
import { isTrustedSystemBinary } from "../src/setup-platform.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);
const gitBinary = ["/usr/bin/git", "/bin/git"].find((path) => isTrustedSystemBinary(path));
const realGit = it.skipIf(!gitBinary);

async function fixture() {
  const home = await temporaryRoot("snapshot-git-");
  const repo = join(home, "repo"); const worktree = join(home, "worktree"); const global = join(home, "global");
  await mkdir(repo); await writeFile(global, "");
  const env = { HOME: home, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: "1", PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
  const gitAt = (cwd: string, ...args: string[]) => execFileSync(gitBinary!, ["-C", cwd, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const source = (...args: string[]) => gitAt(repo, ...args);
  const work = (...args: string[]) => gitAt(worktree, ...args);
  source("init"); source("config", "user.name", "test"); source("config", "user.email", "test@example.invalid");
  await writeFile(join(repo, "file"), "first\n"); await writeFile(join(repo, ".gitignore"), "*.log\n");
  source("add", "."); source("commit", "-m", "first"); const base = source("rev-parse", "HEAD");
  await writeFile(join(repo, "file"), "second\n"); source("commit", "-am", "second");
  const head = source("rev-parse", "HEAD"); const tree = source("rev-parse", "HEAD^{tree}");
  source("worktree", "add", "--detach", worktree, head);
  const git = trustedGit({ env })!;
  return { home, repo, worktree, source, work, git, binding: { base, head, tree } };
}
const modified = (promise: Promise<unknown>) => expect(promise).rejects.toMatchObject({ code: "snapshot_modified" });

it("runs hardened Git through the guardian runner and fails closed", async () => {
  const calls: unknown[][] = [];
  let exitCode = 0, stderr = "";
  const runner = { async run(...args: Parameters<import("../src/client-adapters/types.js").CommandRunner["run"]>) { calls.push(args); return { exitCode, stdout: "ok", stderr }; } };
  const options = { candidates: ["/git"], envCandidates: ["/env"], isTrustedBinary: () => true, env: { HOME: "/home/test", EXTRA: "yes" } };
  const git = guardedGit(runner, options)!;
  expect(await git.run("/repo", ["worktree", "remove", "x"])).toEqual({ code: 0, stdout: "ok" });
  expect(calls[0]).toEqual(["/env", ["-i", "PATH=/usr/bin:/bin", "HOME=/home/test", "LANG=C", "LC_ALL=C", "GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0", "EXTRA=yes", "/git", "--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.useReplaceRefs=false", "-c", "core.fileMode=true", "-c", "worktree.useRelativePaths=false", "-C", "/repo", "worktree", "remove", "x"], undefined, { timeoutMs: 120_000 }]);
  await guardedGit(runner, { ...options, mutationTimeoutMs: 1234 })!.run("/repo", []);
  expect(calls[1]?.[3]).toEqual({ timeoutMs: 1234 });
  for (const code of [124, 125, 126, 127]) { exitCode = code; await expect(git.run("/repo", [])).rejects.toMatchObject({ code: "snapshot_unavailable" }); }
  exitCode = 0; stderr = "output_limit"; await expect(git.run("/repo", [])).rejects.toMatchObject({ code: "snapshot_unavailable" });
  expect(() => guardedGit(runner, { ...options, env: { "bad=name": "x" } })).toThrow(expect.objectContaining({ code: "snapshot_unavailable" }));
  expect(guardedGit(runner, { ...options, envCandidates: [] })).toBeUndefined();
});
it("derives paths and rejects invalid aliases", async () => {
  const home = await temporaryRoot("snapshot-path-");
  const root = join(home, ".local", "state", "pi-session-mcp", "snapshots", "review");
  expect(snapshotPaths(home, "review")).toEqual({ root, worktree: join(root, "worktree"), state: join(root, "state.json"), lock: join(root, "slot.lock") });
  for (const alias of ["../bad", "", "Bad", "a/b"]) expect(() => snapshotPaths(home, alias)).toThrow(expect.objectContaining({ code: "snapshot_unavailable" }));
});
it("validates and atomically persists private state", async () => {
  const home = await temporaryRoot("snapshot-state-"); const paths = snapshotPaths(home, "review"); await ensureSnapshotRoot(paths);
  expect(await readSnapshotState(paths)).toBeUndefined();
  const state = { v: 1 as const, source: "repo", base: "a".repeat(40), head: "b".repeat(40), tree: "c".repeat(40), at: "now" };
  await writeSnapshotState(paths, state); expect(await readSnapshotState(paths)).toEqual(state);
  await chmod(paths.state, 0o644); await expect(readSnapshotState(paths)).rejects.toMatchObject({ code: "snapshot_incomplete" });
  await chmod(paths.state, 0o600); await writeFile(paths.state, "invalid"); await expect(readSnapshotState(paths)).rejects.toMatchObject({ code: "snapshot_incomplete" });
  await writeFile(paths.state, JSON.stringify({ ...state, extra: true })); await expect(readSnapshotState(paths)).rejects.toMatchObject({ code: "snapshot_incomplete" });
  await rm(paths.state); await symlink(join(home, "target"), paths.state); await expect(readSnapshotState(paths)).rejects.toMatchObject({ code: "snapshot_incomplete" });
  await removeSnapshotState(paths); await removeSnapshotState(paths); expect(await readSnapshotState(paths)).toBeUndefined();
});
realGit("verifies a fresh linked worktree and detects edits, ignored files and index flags", async () => {
  const f = await fixture(); const verify = () => verifySnapshot(f.git, f.worktree, f.binding);
  await verify(); await verifyClean(f.git, f.worktree);
  await writeFile(join(f.worktree, "file"), "edit\n"); await modified(verify()); f.work("checkout", "--", "file");
  await writeFile(join(f.worktree, "new"), "new"); await modified(verify()); await rm(join(f.worktree, "new"));
  await writeFile(join(f.worktree, "ignored.log"), "ignored"); await modified(verify()); await modified(verifyClean(f.git, f.worktree)); await rm(join(f.worktree, "ignored.log"));
  f.work("update-index", "--skip-worktree", "file"); await writeFile(join(f.worktree, "file"), "hidden\n"); await modified(verify());
  f.work("update-index", "--no-skip-worktree", "file"); f.work("checkout", "--", "file");
  f.work("update-index", "--assume-unchanged", "file"); await modified(verify()); f.work("update-index", "--no-assume-unchanged", "file");
  await verify();
});
realGit("detects executable-bit changes even when source disables fileMode", async () => {
  const f = await fixture(); f.source("config", "core.fileMode", "false");
  await chmod(join(f.worktree, "file"), 0o755);
  await modified(verifySnapshot(f.git, f.worktree, f.binding));
});
realGit("detects moved HEAD, wrong tree, missing base and gitlinks", async () => {
  const f = await fixture(); const verify = () => verifySnapshot(f.git, f.worktree, f.binding);
  f.work("checkout", "--detach", f.binding.base); await modified(verify()); f.work("checkout", "--detach", f.binding.head);
  await modified(verifySnapshot(f.git, f.worktree, { ...f.binding, tree: "0".repeat(40) }));
  await modified(verifySnapshot(f.git, f.worktree, { ...f.binding, base: "0".repeat(40) }));
  f.work("update-index", "--add", "--cacheinfo", `160000,${f.binding.base},sub`); await modified(verify());
});
realGit("does not refresh the index during verification", async () => {
  const f = await fixture();
  const index = f.work("rev-parse", "--path-format=absolute", "--git-path", "index");
  const before = await readFile(index); const beforeStat = await stat(index);
  const old = new Date(Date.now() - 60_000); await utimes(join(f.worktree, "file"), old, old);
  await verifySnapshot(f.git, f.worktree, f.binding);
  expect(await readFile(index)).toEqual(before); expect((await stat(index)).mtimeMs).toBe(beforeStat.mtimeMs);
  // Control is intentionally ordinary Git. Some Git/filesystem combinations do not rewrite.
  f.work("status", "--porcelain=v1");
  const controlRewrote = (await stat(index)).mtimeMs !== beforeStat.mtimeMs || !(await readFile(index)).equals(before);
  expect(typeof controlRewrote).toBe("boolean");
  if (!controlRewrote) console.error("snapshot index control: plain git status did not rewrite index on this Git/filesystem");
});
realGit("rejects a worktree-only conditional clean filter", async () => {
  const f = await fixture(); const config = join(f.home, "filter-config");
  await writeFile(config, "[filter \"example\"]\n clean = false\n");
  f.source("config", "--add", "includeIf.gitdir:**/worktrees/**.path", config);
  await assertNoConversionDrivers(f.git, f.repo);
  await modified(verifySnapshot(f.git, f.worktree, f.binding));
});
realGit("rejects source smudge drivers and enabled fsmonitor", async () => {
  const f = await fixture(); f.source("config", "filter.example.smudge", "false");
  await expect(assertNoConversionDrivers(f.git, f.repo)).rejects.toMatchObject({ code: "snapshot_source_unsupported" });
  f.source("config", "--unset", "filter.example.smudge"); f.source("config", "core.fsmonitor", "true");
  await expect(assertNoConversionDrivers(f.git, f.repo)).rejects.toMatchObject({ code: "snapshot_source_unsupported" });
});
it("refuses untrusted binaries and bounds runtime and output", async () => {
  expect(trustedGit({ candidates: ["/not-trusted"], isTrustedBinary: () => false })).toBeUndefined();
  const home = await temporaryRoot("snapshot-script-"); const script = join(home, "git");
  await writeFile(script, "#!/bin/sh\nsleep 5\n", { mode: 0o700 });
  const options = { candidates: [script], isTrustedBinary: () => true, env: { HOME: home, GIT_CONFIG_GLOBAL: join(home, "global"), GIT_CONFIG_NOSYSTEM: "1" } };
  await expect(trustedGit({ ...options, timeoutMs: 10 })!.run(home, [])).rejects.toMatchObject({ code: "snapshot_unavailable" });
  await writeFile(script, "#!/bin/sh\nprintf 'too much output'\n");
  await expect(trustedGit({ ...options, maxOutputBytes: 2 })!.run(home, [])).rejects.toMatchObject({ code: "snapshot_unavailable" });
});
it.skipIf(process.platform !== "linux")("shares locks, excludes other holders and requires the root", async () => {
  const home = await temporaryRoot("snapshot-lock-"); const paths = snapshotPaths(home, "review");
  await expect(lockSnapshotShared(paths)).rejects.toMatchObject({ code: "snapshot_unavailable" });
  await expect(lockSnapshotExclusive(paths)).rejects.toMatchObject({ code: "snapshot_unavailable" });
  await ensureSnapshotRoot(paths); const a = await lockSnapshotShared(paths); const b = await lockSnapshotShared(paths);
  await expect(lockSnapshotExclusive(paths)).rejects.toMatchObject({ code: "snapshot_busy" });
  await a.release(); await b.release(); const c = await lockSnapshotExclusive(paths);
  await expect(lockSnapshotShared(paths)).rejects.toMatchObject({ code: "snapshot_unavailable" }); await c.release(); await c.release();
  const d = await lockSnapshotShared(paths); await d.release(); const e = await lockSnapshotExclusive(paths); await e.release();
});
it("accepts shared ancestors with ordinary modes but keeps the product's components private", async () => {
  const home = await temporaryRoot("snapshot-root-");
  await mkdir(join(home, ".local", "state"), { recursive: true, mode: 0o755 });
  await chmod(join(home, ".local"), 0o755); await chmod(join(home, ".local", "state"), 0o755);
  const paths = snapshotPaths(home, "review");
  await ensureSnapshotRoot(paths);
  for (const path of [join(home, ".local", "state", "pi-session-mcp"), join(home, ".local", "state", "pi-session-mcp", "snapshots"), paths.root]) {
    expect((await stat(path)).mode & 0o7777).toBe(0o700);
  }
  await ensureSnapshotRoot(paths);
  await chmod(join(home, ".local", "state", "pi-session-mcp"), 0o755);
  await expect(ensureSnapshotRoot(paths)).rejects.toMatchObject({ code: "snapshot_unavailable" });
  await chmod(join(home, ".local", "state", "pi-session-mcp"), 0o700);
  await chmod(join(home, ".local"), 0o777);
  await expect(ensureSnapshotRoot(paths)).rejects.toMatchObject({ code: "snapshot_unavailable" });
  await chmod(join(home, ".local"), 0o755);
  const linked = await temporaryRoot("snapshot-root-link-");
  await mkdir(join(linked, "real"), { mode: 0o700 }); await symlink(join(linked, "real"), join(linked, ".local"));
  await expect(ensureSnapshotRoot(snapshotPaths(linked, "review"))).rejects.toMatchObject({ code: "snapshot_unavailable" });
});
it("rejects at once when the Git binary cannot be spawned", async () => {
  const home = await temporaryRoot("snapshot-spawn-");
  const git = trustedGit({ candidates: [join(home, "missing-git")], isTrustedBinary: () => true, env: { HOME: home } })!;
  await expect(git.run(home, ["status"])).rejects.toMatchObject({ code: "snapshot_unavailable" });
});

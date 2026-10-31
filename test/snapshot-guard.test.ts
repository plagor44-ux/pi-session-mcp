import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { createSnapshotGuard } from "../src/snapshot-guard.js";
import { ensureSnapshotRoot, lockSnapshotExclusive, snapshotPaths, trustedGit, writeSnapshotState } from "../src/review-snapshot.js";
import { isTrustedSystemBinary } from "../src/setup-platform.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);
const binary = ["/usr/bin/git", "/bin/git"].find((path) => isTrustedSystemBinary(path));
const realGit = it.skipIf(!binary || process.platform !== "linux");
async function fixture() {
  const home = await temporaryRoot("snapshot-guard-");
  const repo = join(home, "repo"); await mkdir(repo);
  const global = join(home, "global"); await writeFile(global, "");
  const env = { HOME: home, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: "1", PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
  const git = (...args: string[]) => execFileSync(binary!, ["-C", repo, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  git("init"); git("config", "user.name", "test"); git("config", "user.email", "test@example.invalid");
  await writeFile(join(repo, "file"), "clean"); git("add", "."); git("commit", "-m", "initial");
  const head = git("rev-parse", "HEAD"); const tree = git("rev-parse", "HEAD^{tree}");
  const paths = snapshotPaths(home, "review"); await ensureSnapshotRoot(paths); git("worktree", "add", "--detach", paths.worktree, head);
  const state = { v: 1 as const, source: "repo", base: head, head, tree, at: "now" };
  const modes = new Map([["review", { mode: "snapshot" as const, snapshot: { source: "repo" } }]]);
  const guard = createSnapshotGuard({ home, workspaceModes: modes, git: trustedGit({ env }) });
  return { home, repo, paths, state, modes, guard };
}
realGit("acquires and verifies a binding, then releases the shared lease", async () => {
  const f = await fixture(); await writeSnapshotState(f.paths, f.state);
  expect(f.guard.isSnapshot("review")).toBe(true); expect(f.guard.isSnapshot("repo")).toBe(false);
  const lease = await f.guard.acquire("review", f.paths.worktree);
  expect(lease.binding).toEqual({ base: f.state.base, head: f.state.head, tree: f.state.tree });
  await expect(lockSnapshotExclusive(f.paths)).rejects.toMatchObject({ code: "snapshot_busy" });
  await writeFile(join(f.paths.worktree, "file"), "edit");
  await expect(lease.verify()).rejects.toMatchObject({ code: "snapshot_modified" });
  await lease.release(); await lease.release(); const lock = await lockSnapshotExclusive(f.paths); await lock.release();
});
realGit("rejects mismatch, absent or incomplete state, wrong source, busy and missing Git", async () => {
  const f = await fixture(); const acquire = () => f.guard.acquire("review", f.paths.worktree);
  await expect(f.guard.acquire("review", f.repo)).rejects.toMatchObject({ code: "snapshot_unavailable" });
  await expect(acquire()).rejects.toMatchObject({ code: "snapshot_unavailable" });
  await writeFile(f.paths.state, "invalid", { mode: 0o600 }); await expect(acquire()).rejects.toMatchObject({ code: "snapshot_unavailable" });
  await writeSnapshotState(f.paths, { ...f.state, source: "other" }); await expect(acquire()).rejects.toMatchObject({ code: "snapshot_unavailable" });
  await writeSnapshotState(f.paths, f.state); const lock = await lockSnapshotExclusive(f.paths);
  await expect(acquire()).rejects.toMatchObject({ code: "snapshot_unavailable" }); await lock.release();
  await expect(createSnapshotGuard({ home: f.home, workspaceModes: f.modes, git: undefined }).acquire("review", f.paths.worktree)).rejects.toMatchObject({ code: "snapshot_unavailable" });
  await writeFile(join(f.paths.worktree, "file"), "modified"); await expect(acquire()).rejects.toMatchObject({ code: "snapshot_modified" });
  const after = await lockSnapshotExclusive(f.paths); await after.release();
});

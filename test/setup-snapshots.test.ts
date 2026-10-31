import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { isTrustedSystemBinary } from "../src/setup-platform.js";
import { lockSnapshotShared, readSnapshotState, snapshotPaths, trustedGit, verifySnapshot } from "../src/review-snapshot.js";
import { runSnapshotOperation, type SnapshotRequest } from "../src/setup-snapshots.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);
const binary = ["/usr/bin/git", "/bin/git"].find((path) => isTrustedSystemBinary(path));
const real = it.skipIf(!binary || process.platform !== "linux");
async function fixture() {
  const home = await temporaryRoot("setup-snapshot-"); const source = join(home, "source"); await mkdir(source);
  const env = { HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", PATH: "/usr/bin:/bin" };
  const git = (cwd: string, ...args: string[]) => execFileSync(binary!, ["-C", cwd, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const at = (...args: string[]) => git(source, ...args);
  at("init"); at("config", "user.name", "test"); at("config", "user.email", "test@example.invalid");
  await writeFile(join(source, "file"), "first\n"); await writeFile(join(source, ".gitignore"), "*.log\n"); at("add", "."); at("commit", "-m", "first");
  const base = at("rev-parse", "HEAD"); await writeFile(join(source, "file"), "second\n"); at("commit", "-am", "second"); const head = at("rev-parse", "HEAD");
  const paths = snapshotPaths(home, "review"); const config = join(home, "config.json");
  await writeFile(config, JSON.stringify({ workspaces: { repo: source, review: paths.worktree }, executionProfiles: { review: { default: true, permissionProfile: "read-only", provider: "example", model: "m", thinkingLevel: "off" } } }));
  await writeFile(join(home, "execution-modes.json"), JSON.stringify({ schemaVersion: 1, workspaces: { repo: { mode: "host", acceptHostWrites: true }, review: { mode: "snapshot", source: "repo" } } }));
  const deps = { home, gitOptions: { env } }; const request: SnapshotRequest = { alias: "review", apply: true, remove: false, discard: false, base, head };
  const run = (change: Partial<SnapshotRequest> = {}) => runSnapshotOperation(config, { ...request, ...change }, deps);
  return { home, source, paths, env, git, at, base, head, run };
}
real("plans without writes, applies under a real guardian, verifies and retargets", async () => {
  const f = await fixture();
  expect(await f.run({ apply: false })).toMatchObject({ status: "planned", findings: [{ code: "snapshot_planned" }] });
  await expect(stat(f.paths.root)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await f.run()).toMatchObject({ exitCode: 0, findings: [{ code: "snapshot_applied" }] });
  const state = await readSnapshotState(f.paths); expect(state).toMatchObject({ source: "repo", base: f.base, head: f.head });
  await verifySnapshot(trustedGit({ env: f.env })!, f.paths.worktree, state!);
  expect(await f.run()).toMatchObject({ findings: [{ code: "unchanged" }] });
  expect(await f.run({ head: f.base })).toMatchObject({ exitCode: 0, findings: [{ code: "snapshot_applied" }] });
  expect((await readSnapshotState(f.paths))?.head).toBe(f.base);
  const result = await f.run({ remove: true }); expect(result).toMatchObject({ findings: [{ code: "snapshot_removed" }] }); expect(JSON.stringify(result)).not.toContain(f.home);
});
real.each(["tracked", "ignored", "skip"])("keeps %s modifications without discard and replaces them with discard", async (kind) => {
  const f = await fixture(); expect((await f.run()).exitCode).toBe(0);
  if (kind === "skip") f.git(f.paths.worktree, "update-index", "--skip-worktree", "file");
  const path = join(f.paths.worktree, kind === "ignored" ? "note.log" : "file"); await writeFile(path, "keep me\n");
  const before = await readFile(path); expect(await f.run({ head: f.base })).toMatchObject({ findings: [{ code: "snapshot_modified" }] }); expect(await readFile(path)).toEqual(before);
  expect(await f.run({ head: f.base, discard: true })).toMatchObject({ exitCode: 0, findings: [{ code: "snapshot_applied" }, { code: "snapshot_discarded" }] });
});
real("refuses missing objects and source filters before making the slot", async () => {
  const f = await fixture(); expect(await f.run({ head: "0".repeat(40) })).toMatchObject({ findings: [{ code: "snapshot_object_missing" }] });
  f.at("config", "filter.foo.smudge", "false"); expect(await f.run()).toMatchObject({ findings: [{ code: "snapshot_source_unsupported" }] });
  await expect(stat(f.paths.root)).rejects.toMatchObject({ code: "ENOENT" });
});
real("rejects gitlinks before creating a slot", async () => {
  const f = await fixture(); f.at("update-index", "--add", "--cacheinfo", `160000,${f.base},sub`); f.at("commit", "-m", "gitlink");
  expect(await f.run({ head: f.at("rev-parse", "HEAD") })).toMatchObject({ findings: [{ code: "snapshot_submodule_present" }] });
  await expect(stat(f.paths.root)).rejects.toMatchObject({ code: "ENOENT" });
});
real("refuses modified removal without discard", async () => {
  const f = await fixture(); expect((await f.run()).exitCode).toBe(0); await writeFile(join(f.paths.worktree, "note.log"), "keep");
  expect(await f.run({ remove: true })).toMatchObject({ findings: [{ code: "snapshot_modified" }] });
  expect(await readFile(join(f.paths.worktree, "note.log"), "utf8")).toBe("keep");
  expect(await f.run({ remove: true, discard: true })).toMatchObject({ findings: [{ code: "snapshot_removed" }, { code: "snapshot_discarded" }] });
});
real("does not remove a slot with a worktree-only conversion driver", async () => {
  const f = await fixture(); expect((await f.run()).exitCode).toBe(0);
  const filter = join(f.home, "filter"); await writeFile(filter, "[filter \"example\"]\n smudge = false\n");
  f.at("config", "--add", "includeIf.gitdir:**/worktrees/**.path", filter);
  expect(await f.run({ remove: true, discard: true })).toMatchObject({ exitCode: 1 });
  expect(await readFile(join(f.paths.worktree, "file"), "utf8")).toBe("second\n");
});
real("reports busy for a shared lease", async () => {
  const f = await fixture(); expect((await f.run()).exitCode).toBe(0); const lock = await lockSnapshotShared(f.paths);
  try { expect(await f.run({ head: f.base })).toMatchObject({ findings: [{ code: "snapshot_busy" }] }); } finally { await lock.release(); }
});
real("recovers a worktree with missing or invalid state and keeps unrecognized occupants", async () => {
  const f = await fixture(); expect((await f.run()).exitCode).toBe(0); await rm(f.paths.state);
  expect((await f.run({ head: f.base })).exitCode).toBe(0); await writeFile(f.paths.state, "bad");
  expect((await f.run({ head: f.head })).exitCode).toBe(0);
  expect((await f.run({ remove: true })).exitCode).toBe(0); await mkdir(f.paths.worktree); await writeFile(join(f.paths.worktree, "keep"), "keep");
  expect(await f.run({ discard: true })).toMatchObject({ findings: [{ code: "snapshot_incomplete" }] }); expect(await readFile(join(f.paths.worktree, "keep"), "utf8")).toBe("keep");
});
real("removes only the stale administrative registration for the slot", async () => {
  const f = await fixture(); expect((await f.run()).exitCode).toBe(0);
  const other = join(f.home, "other"); f.at("worktree", "add", "--detach", other, f.head); await rm(other, { recursive: true }); await rm(f.paths.worktree, { recursive: true }); await rm(f.paths.state);
  expect((await f.run()).exitCode).toBe(0);
  expect(f.at("worktree", "list", "--porcelain")).toContain(other);
});

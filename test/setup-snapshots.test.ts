import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { isTrustedSystemBinary } from "../src/setup-platform.js";
import { lockSnapshotShared, readSnapshotState, snapshotPaths, trustedGit, verifySnapshot } from "../src/review-snapshot.js";
import { createSnapshotGuard } from "../src/snapshot-guard.js";
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
real("overrides global relative worktree paths throughout the lifecycle", async () => {
  const f = await fixture(); const global = join(f.home, "global"); await writeFile(global, "[worktree]\n useRelativePaths = true\n");
  const request: SnapshotRequest = { alias: "review", apply: true, remove: false, discard: false, base: f.base, head: f.head };
  const run = (change: Partial<SnapshotRequest> = {}) => runSnapshotOperation(join(f.home, "config.json"), { ...request, ...change }, { home: f.home, gitOptions: { env: { ...f.env, GIT_CONFIG_GLOBAL: global } } });
  expect((await run()).exitCode).toBe(0);
  expect(await run()).toMatchObject({ findings: [{ code: "unchanged" }] });
  expect((await run({ head: f.base })).exitCode).toBe(0);
  expect((await run({ remove: true })).exitCode).toBe(0);
});
real("invalidates state before a failed removal", async () => {
  const f = await fixture(); expect((await f.run()).exitCode).toBe(0);
  const guardian: NonNullable<import("../src/setup-snapshots.js").SnapshotDependencies["guardian"]> = async () => ({ signal: new AbortController().signal, release: async () => {}, runner: { async run() { return { exitCode: 1, stdout: "", stderr: "" }; } } });
  const result = await runSnapshotOperation(join(f.home, "config.json"), { alias: "review", apply: true, remove: true, discard: false }, { home: f.home, gitOptions: { env: f.env }, guardian });
  expect(result.exitCode).toBe(1); expect(await readSnapshotState(f.paths)).toBeUndefined();
  const guard = createSnapshotGuard({ home: f.home, workspaceModes: new Map([["review", { mode: "snapshot", snapshot: { source: "repo" } }]]), git: trustedGit({ env: f.env }) });
  await expect(guard.acquire("review", f.paths.worktree)).rejects.toMatchObject({ code: "snapshot_unavailable" });
});
real("accepts a configured slot through a symlinked home parent", async () => {
  const f = await fixture(); const link = join(f.home, "home-link"); await symlink(f.home, link);
  const config = join(f.home, "config.json"); const data = JSON.parse(await readFile(config, "utf8")) as { workspaces: { review: string } };
  data.workspaces.review = snapshotPaths(link, "review").worktree; await writeFile(config, JSON.stringify(data));
  // The slot parent must exist to compare its canonical path.
  await mkdir(f.paths.root, { recursive: true, mode: 0o700 });
  expect((await f.run()).exitCode).toBe(0);
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
real("refuses annotated tag object IDs before creating a slot", async () => {
  const f = await fixture(); f.at("tag", "-a", "tag", "-m", "tag"); const tag = f.at("rev-parse", "tag");
  for (const change of [{ head: tag }, { base: tag }]) expect(await f.run(change)).toMatchObject({ findings: [{ code: "snapshot_object_missing" }] });
  await expect(stat(f.paths.root)).rejects.toMatchObject({ code: "ENOENT" });
});
real("refuses a worktree-only smudge before checkout and cleans its registration", async () => {
  const f = await fixture();
  await writeFile(join(f.source, ".gitattributes"), "*.txt filter=mark\n"); await writeFile(join(f.source, "marked.txt"), "test\n");
  f.at("add", "."); f.at("commit", "-m", "attributes"); const head = f.at("rev-parse", "HEAD");
  const global = join(f.home, "global"), filter = join(f.home, "filter"), marker = join(f.home, "marker");
  await writeFile(global, `[includeIf "gitdir:**/worktrees/**"]\n path = ${filter}\n`);
  await writeFile(filter, `[filter "mark"]\n smudge = touch ${marker}\n`);
  const result = await runSnapshotOperation(join(f.home, "config.json"), { alias: "review", apply: true, remove: false, discard: false, base: f.base, head }, { home: f.home, gitOptions: { env: { ...f.env, GIT_CONFIG_GLOBAL: global } } });
  expect(result).toMatchObject({ findings: [{ code: "snapshot_source_unsupported" }] });
  await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" }); await expect(stat(f.paths.worktree)).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.at("worktree", "list", "--porcelain")).not.toContain(f.paths.worktree);
});
real("dry-run refuses a modified matching slot unless discard is requested", async () => {
  const f = await fixture(); expect((await f.run()).exitCode).toBe(0); await writeFile(join(f.paths.worktree, "file"), "modified");
  expect(await f.run({ apply: false })).toMatchObject({ exitCode: 1, findings: [{ code: "snapshot_modified" }] });
  expect(await f.run({ apply: false, discard: true })).toMatchObject({ status: "planned", findings: [{ code: "snapshot_planned" }] });
});
real("recovers initializing locks only with discard and preserves operator locks", async () => {
  const f = await fixture(); expect((await f.run()).exitCode).toBe(0); await rm(f.paths.state);
  const entry = f.git(f.paths.worktree, "rev-parse", "--absolute-git-dir"); await writeFile(join(entry, "locked"), "initializing\n");
  expect(await f.run()).toMatchObject({ findings: [{ code: "snapshot_incomplete" }] });
  expect((await f.run({ discard: true })).exitCode).toBe(0);
  f.at("worktree", "lock", "--reason", "keep", f.paths.worktree); await rm(f.paths.state);
  expect(await f.run({ discard: true })).toMatchObject({ findings: [{ code: "snapshot_incomplete" }] });
  await rm(f.paths.worktree, { recursive: true });
  expect(await f.run({ discard: true })).toMatchObject({ findings: [{ code: "snapshot_incomplete" }] });
  expect(f.at("worktree", "list", "--porcelain")).toContain(f.paths.worktree);
});
real("routes mutations through the guardian and stops without state when its fence aborts", async () => {
  const f = await fixture(); const calls: string[][] = []; const controller = new AbortController(); let abortOnAdd = false;
  const guardian: NonNullable<import("../src/setup-snapshots.js").SnapshotDependencies["guardian"]> = async () => ({
    signal: controller.signal, release: async () => {}, runner: { async run(command, args) {
      const argv = [...args]; calls.push(argv);
      try { const stdout = execFileSync(command, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); if (abortOnAdd && argv.includes("add")) controller.abort(); return { exitCode: 0, stdout, stderr: "" }; }
      catch { return { exitCode: 1, stdout: "", stderr: "" }; }
    } },
  });
  const request: SnapshotRequest = { alias: "review", apply: true, remove: false, discard: false, base: f.base, head: f.head };
  const run = (change: Partial<SnapshotRequest> = {}) => runSnapshotOperation(join(f.home, "config.json"), { ...request, ...change }, { home: f.home, gitOptions: { env: f.env }, guardian });
  expect((await run()).exitCode).toBe(0); await writeFile(join(f.paths.worktree, "file"), "changed");
  expect((await run({ discard: true, head: f.base })).exitCode).toBe(0); expect((await run({ remove: true })).exitCode).toBe(0);
  expect(calls.filter((args) => args.includes("add"))).toHaveLength(2); expect(calls.filter((args) => args.includes("reset"))).toHaveLength(2); expect(calls.filter((args) => args.includes("remove"))).toHaveLength(2);
  abortOnAdd = true; expect(await run()).toMatchObject({ findings: [{ code: "snapshot_unavailable" }] }); await expect(stat(f.paths.state)).rejects.toMatchObject({ code: "ENOENT" });
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

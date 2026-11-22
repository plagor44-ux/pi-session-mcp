import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { collectWriter, inspectWriter } from "../src/writer-lifecycle.js";
import { readWriterState, writeWriterState } from "../src/writer-state.js";
import { removeTemporaryRoots } from "./temporary-roots.js";
import { fixture, git } from "./real-git-writer-fixture.js";

afterAll(removeTemporaryRoots);

const ZERO = { commits: 0, branches: 0, stashes: 0, unexportedRefs: 0, changes: 0, untracked: 0, ignored: 0, nestedRepositories: 0 };

it("reports a pristine writer as clean with all counters zero", async () => {
  const f = await fixture();
  expect(await inspectWriter(f.ctx, "repo-w1")).toEqual({ status: "ok", code: "writer_clean", counts: ZERO });
}, 60_000);

it("reports commits, a second branch, tracked changes, untracked and ignored files and a stash as uncollected work", async () => {
  const f = await fixture();
  await f.work("checkout", "-b", "feature");
  await f.commit("one", "one.txt", "1\n");
  await f.commit("two", "two.txt", "2\n");
  await appendFile(join(f.paths.clone, "base.txt"), "more\n");
  await f.work("stash", "push");
  await appendFile(join(f.paths.clone, "base.txt"), "again\n");
  await writeFile(join(f.paths.clone, "untracked.txt"), "u\n");
  await appendFile(join(f.paths.clone, ".git/info/exclude"), "ignored-*\n");
  await writeFile(join(f.paths.clone, "ignored-a.txt"), "i\n");
  await writeFile(join(f.paths.clone, "ignored-b.txt"), "i\n");
  const outcome = await inspectWriter(f.ctx, "repo-w1");
  expect(outcome).toEqual({ status: "failed", code: "writer_uncollected", counts: { ...ZERO, commits: 2, branches: 1, stashes: 1, changes: 1, untracked: 1, ignored: 2 } });
}, 60_000);

it("counts commits on a detached HEAD that no branch reaches", async () => {
  const f = await fixture();
  await f.work("checkout", "--detach", "main");
  await f.commit("detached one", "one.txt", "1\n");
  await f.commit("detached two", "two.txt", "2\n");
  expect(await inspectWriter(f.ctx, "repo-w1")).toEqual({ status: "failed", code: "writer_uncollected", counts: { ...ZERO, commits: 2 } });
}, 60_000);

it("counts staged work that the worktree has restored to the HEAD content", async () => {
  const f = await fixture();
  await writeFile(join(f.paths.clone, "base.txt"), "staged\n");
  await f.work("add", "base.txt");
  await writeFile(join(f.paths.clone, "base.txt"), "base\n");
  expect(await f.work("diff", "HEAD", "--name-only")).toBe("");
  expect(await inspectWriter(f.ctx, "repo-w1")).toEqual({ status: "failed", code: "writer_uncollected", counts: { ...ZERO, changes: 1 } });
}, 60_000);

it("counts the union of staged and worktree changes, a path changed in both once", async () => {
  const f = await fixture();
  await f.commit("second file", "second.txt", "s\n");
  await f.work("reset", "--hard", f.baseCommit);
  await f.commit("tracked a", "a.txt", "a\n");
  await f.commit("tracked b", "b.txt", "b\n");
  await f.work("reset", "--hard", "HEAD");
  await writeFile(join(f.paths.clone, "a.txt"), "staged a\n");
  await f.work("add", "a.txt");
  await writeFile(join(f.paths.clone, "a.txt"), "worktree a\n");
  await writeFile(join(f.paths.clone, "b.txt"), "worktree b\n");
  const outcome = await inspectWriter(f.ctx, "repo-w1");
  expect(outcome).toMatchObject({ status: "failed", code: "writer_uncollected", counts: { changes: 2 } });
}, 60_000);

it.each([["assume-unchanged", "--assume-unchanged"], ["skip-worktree", "--skip-worktree"]])("counts a changed path that the index flag %s hides from Git", async (_name, flag) => {
  const f = await fixture();
  await writeFile(join(f.paths.clone, "base.txt"), "hidden change\n");
  await f.work("update-index", flag, "base.txt");
  expect(await f.work("status", "--porcelain")).toBe("");
  expect(await inspectWriter(f.ctx, "repo-w1")).toEqual({ status: "failed", code: "writer_uncollected", counts: { ...ZERO, changes: 1 } });
}, 60_000);

it("does not count a skip-worktree path that is absent from the worktree on purpose", async () => {
  const f = await fixture();
  await f.commit("sparse file", "sparse.txt", "s\n");
  await f.work("reset", "--hard", f.baseCommit);
  await f.commit("sparse file", "sparse.txt", "s\n");
  await f.work("update-index", "--skip-worktree", "sparse.txt");
  await rm(join(f.paths.clone, "sparse.txt"));
  expect(await f.work("status", "--porcelain")).toBe("");
  expect((await inspectWriter(f.ctx, "repo-w1")).counts?.changes).toBe(0);
  // A real deletion next to it still counts, once.
  await rm(join(f.paths.clone, "base.txt"));
  expect((await inspectWriter(f.ctx, "repo-w1")).counts?.changes).toBe(1);
}, 60_000);

it("counts a new file that is staged and then removed from the worktree", async () => {
  const f = await fixture();
  await writeFile(join(f.paths.clone, "new.txt"), "new\n");
  await f.work("add", "new.txt");
  await rm(join(f.paths.clone, "new.txt"));
  expect(await inspectWriter(f.ctx, "repo-w1")).toEqual({ status: "failed", code: "writer_uncollected", counts: { ...ZERO, changes: 1 } });
  // The same path staged, then deleted, next to a real deletion of another file: two paths.
  await rm(join(f.paths.clone, "base.txt"));
  expect((await inspectWriter(f.ctx, "repo-w1")).counts?.changes).toBe(2);
}, 60_000);

it("counts a tracked file that was deleted in the worktree", async () => {
  const f = await fixture();
  await rm(join(f.paths.clone, "base.txt"));
  expect(await inspectWriter(f.ctx, "repo-w1")).toMatchObject({ status: "failed", code: "writer_uncollected", counts: { changes: 1 } });
}, 60_000);

it("counts ignored files of a clean writer without calling it dirty", async () => {
  const f = await fixture();
  await appendFile(join(f.paths.clone, ".git/info/exclude"), "node_modules/\n");
  await mkdir(join(f.paths.clone, "node_modules"));
  await writeFile(join(f.paths.clone, "node_modules", "a.js"), "a\n");
  expect(await inspectWriter(f.ctx, "repo-w1")).toEqual({ status: "ok", code: "writer_clean", counts: { ...ZERO, ignored: 1 } });
}, 60_000);

it("reports work equal to the last collection as collected, and uncollected again after more work", async () => {
  const f = await fixture();
  await f.work("checkout", "-b", "feature");
  await f.commit("one", "one.txt", "1\n");
  expect(await collectWriter(f.ctx, "repo-w1")).toMatchObject({ status: "ok", code: "writer_collected" });
  expect(await inspectWriter(f.ctx, "repo-w1")).toMatchObject({ status: "ok", code: "writer_collected", counts: { ...ZERO, commits: 1, branches: 1 } });
  await f.commit("two", "two.txt", "2\n");
  expect(await inspectWriter(f.ctx, "repo-w1")).toMatchObject({ status: "failed", code: "writer_uncollected", counts: { commits: 2 } });
}, 60_000);

it("reports a nested repository below an ignored path with its count", async () => {
  const f = await fixture();
  await appendFile(join(f.paths.clone, ".git/info/exclude"), "vendor/\n");
  await mkdir(join(f.paths.clone, "vendor", "lib"), { recursive: true });
  await git(join(f.paths.clone, "vendor", "lib"), "init", "-b", "main");
  expect(await inspectWriter(f.ctx, "repo-w1")).toMatchObject({ status: "failed", code: "writer_nested_repository", counts: { nestedRepositories: 1 } });
}, 60_000);

it("changes nothing: state, refs, index and files are the same afterwards", async () => {
  const f = await fixture();
  await f.commit("one", "one.txt", "1\n");
  await writeFile(join(f.paths.clone, "untracked.txt"), "u\n");
  const stateBefore = JSON.stringify(await readWriterState(f.ctx.home, "repo-w1"));
  const refsBefore = await f.work("for-each-ref");
  const statusBefore = await f.work("status", "--porcelain=v2", "--branch");
  const indexBefore = await readFile(join(f.paths.clone, ".git/index"));
  await inspectWriter(f.ctx, "repo-w1");
  expect(JSON.stringify(await readWriterState(f.ctx.home, "repo-w1"))).toBe(stateBefore);
  expect(await f.work("for-each-ref")).toBe(refsBefore);
  expect(await f.work("status", "--porcelain=v2", "--branch")).toBe(statusBefore);
  expect((await readFile(join(f.paths.clone, ".git/index"))).equals(indexBefore)).toBe(true);
}, 60_000);

it("reports a writer without recorded state, or still provisioning, as not provisioned", async () => {
  const f = await fixture();
  expect(await inspectWriter(f.ctx, "repo-w2")).toEqual({ status: "failed", code: "writer_not_provisioned" });
  const state = (await readWriterState(f.ctx.home, "repo-w1"))!;
  await writeWriterState(f.ctx.home, "repo-w1", { ...state, phase: "provisioning" });
  expect(await inspectWriter(f.ctx, "repo-w1")).toEqual({ status: "failed", code: "writer_not_provisioned" });
}, 60_000);

it("reports a state that belongs to another repository as invalid", async () => {
  const f = await fixture();
  expect(await inspectWriter({ ...f.ctx, alias: "other" }, "repo-w1")).toEqual({ status: "failed", code: "writer_state_invalid" });
}, 60_000);

it("fails closed when the counting script fails", async () => {
  const f = await fixture();
  const real = f.ctx.runner;
  // The first boundary run is the existing inspection; the second one is the counters.
  let runs = 0;
  f.ctx.runner = { run: async (command, args, signal, options) => command === "podman" && ++runs === 2 ? { exitCode: 1, stdout: "", stderr: "" } : real.run(command, args, signal, options) };
  expect(await inspectWriter(f.ctx, "repo-w1")).toEqual({ status: "failed", code: "writer_inspect_failed" });
}, 60_000);

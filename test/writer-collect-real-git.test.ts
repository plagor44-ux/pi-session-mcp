import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import type { CommandRunner } from "../src/client-adapters/types.js";
import { collectWriter, finishWriter, inspectWork, recreateWriter, removeWriter, resetWriter } from "../src/writer-lifecycle.js";
import { readWriterState } from "../src/writer-state.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";
import { fixture, git, gitPresent, spawn } from "./real-git-writer-fixture.js";

afterAll(removeTemporaryRoots);

const DETACHED_REF = "refs/remotes/writer-repo-w1/main-detached";
const INDEX_REF = "refs/remotes/writer-repo-w1/main-index";
const WIP_REF = "refs/remotes/writer-repo-w1/main-wip";

it("collects a clean detached-HEAD commit under <base>-detached and finish keeps it in the operator checkout (#193)", async () => {
  const f = await fixture();
  // The pristine writer: nothing to collect, a digest is still recorded, no writer refs exist.
  expect(await collectWriter(f.ctx, "repo-w1")).toMatchObject({ status: "ok", code: "nothing_to_collect", refs: [], refused: 0, findings: [] });
  expect((await readWriterState(f.ctx.home, "repo-w1"))!.collected?.digest).toMatch(/^sha256:/);
  expect(await git(f.checkout, "for-each-ref", "--format=%(refname)", "refs/remotes/writer-repo-w1/")).toBe("");
  // A clean detached HEAD at a commit no branch of the clone reaches.
  await f.work("checkout", "--detach", "main");
  const detached = await f.commit("detached work", "detached.txt", "detached\n");
  expect(detached).not.toBe(f.baseCommit);
  expect(await gitPresent(f.checkout, "cat-file", "-e", `${detached}^{commit}`)).toBe(false);
  const collected = await collectWriter(f.ctx, "repo-w1");
  expect(collected.status).toBe("ok");
  expect(collected.code).toBe("writer_collected");
  expect(collected.refs).toContain(DETACHED_REF);
  expect(await git(f.checkout, "rev-parse", "--verify", DETACHED_REF)).toBe(detached);
  expect(await gitPresent(f.checkout, "cat-file", "-e", `${detached}^{commit}`)).toBe(true);
  expect((await readWriterState(f.ctx.home, "repo-w1"))!.collected?.digest).toMatch(/^sha256:/);
  expect(await finishWriter(f.ctx, "repo-w1")).toMatchObject({ status: "ok", code: "writer_reset" });
  expect(await git(f.checkout, "rev-parse", "--verify", DETACHED_REF)).toBe(detached);
}, 60_000);

it("exports a feature branch as refs/remotes/writer-repo-w1/feature (counterproof)", async () => {
  const f = await fixture();
  await f.work("checkout", "-b", "feature");
  const feature = await f.commit("feature work", "feature.txt", "feature\n");
  const collected = await collectWriter(f.ctx, "repo-w1");
  expect(collected).toMatchObject({ status: "ok", code: "writer_collected" });
  expect(collected.refs).toContain("refs/remotes/writer-repo-w1/feature");
  expect(await git(f.checkout, "rev-parse", "--verify", "refs/remotes/writer-repo-w1/feature")).toBe(feature);
}, 60_000);

it("exports a dirty detached HEAD via the <base>-wip ref whose parent is HEAD", async () => {
  const f = await fixture();
  await f.work("checkout", "--detach", "main");
  await writeFile(join(f.paths.clone, "base.txt"), "changed\n");
  const collected = await collectWriter(f.ctx, "repo-w1");
  expect(collected).toMatchObject({ status: "ok", code: "writer_collected" });
  expect(collected.refs).toContain("refs/remotes/writer-repo-w1/main-wip");
  expect(collected.refs).not.toContain(DETACHED_REF);
  const wip = await git(f.checkout, "rev-parse", "--verify", "refs/remotes/writer-repo-w1/main-wip");
  expect(await git(f.checkout, "rev-parse", `${wip}^`)).toBe(f.baseCommit);
}, 60_000);

it("exports no -detached ref when the detached HEAD is reachable from a branch", async () => {
  const f = await fixture();
  await f.work("checkout", "-b", "topic");
  const topic = await f.commit("topic work", "topic.txt", "topic\n");
  await f.work("checkout", "--detach");
  expect(await f.work("rev-parse", "HEAD")).toBe(topic);
  const collected = await collectWriter(f.ctx, "repo-w1");
  expect(collected).toMatchObject({ status: "ok", code: "writer_collected" });
  expect(collected.refs).toContain("refs/remotes/writer-repo-w1/topic");
  expect(collected.refs).not.toContain(DETACHED_REF);
  expect(await gitPresent(f.checkout, "rev-parse", "--verify", DETACHED_REF)).toBe(false);
}, 60_000);

it("records a digest for a true empty writer without writer refs", async () => {
  const f = await fixture();
  expect(await collectWriter(f.ctx, "repo-w1")).toMatchObject({ status: "ok", code: "nothing_to_collect", refs: [], refused: 0, findings: [] });
  expect((await readWriterState(f.ctx.home, "repo-w1"))!.collected?.digest).toMatch(/^sha256:/);
  expect(await git(f.checkout, "for-each-ref", "--format=%(refname)", "refs/remotes/writer-repo-w1/")).toBe("");
}, 60_000);

it("refuses reset/recreate/remove without discard after new work on a collected writer", async () => {
  const f = await fixture();
  expect((await collectWriter(f.ctx, "repo-w1")).code).toBe("nothing_to_collect");
  await f.work("checkout", "-b", "feature");
  const feature = await f.commit("feature work", "feature.txt", "feature\n");
  expect(await resetWriter(f.ctx, "repo-w1", { discard: false })).toMatchObject({ status: "failed", code: "writer_uncollected" });
  expect(await recreateWriter(f.ctx, "repo-w1", { discard: false })).toMatchObject({ status: "failed", code: "writer_uncollected" });
  expect(await removeWriter(f.ctx, "repo-w1", { discard: false })).toMatchObject({ status: "failed", code: "writer_uncollected" });
  // finish collects first, so it exports the new work and then resets.
  expect(await finishWriter(f.ctx, "repo-w1")).toMatchObject({ status: "ok", code: "writer_reset" });
  expect(await git(f.checkout, "rev-parse", "--verify", "refs/remotes/writer-repo-w1/feature")).toBe(feature);
}, 60_000);

it("refuses a detached export colliding with an exported branch named main-detached", async () => {
  const f = await fixture();
  await f.work("checkout", "--detach", "main");
  await f.commit("detached work", "detached.txt", "detached\n");
  await f.work("branch", "main-detached", "main");
  const collected = await collectWriter(f.ctx, "repo-w1");
  expect(collected).toMatchObject({ status: "failed", code: "writer_collect_incomplete", findings: [{ code: "ref_name_refused" }] });
  expect(collected.refs).toContain(DETACHED_REF);
  expect((await readWriterState(f.ctx.home, "repo-w1"))!.collected).toBeUndefined();
  expect(await finishWriter(f.ctx, "repo-w1")).toMatchObject({ status: "failed", code: "writer_collect_incomplete" });
  expect(await removeWriter(f.ctx, "repo-w1", { discard: false })).toMatchObject({ status: "failed", code: "writer_uncollected" });
}, 60_000);

it("fails collection when a collected commit is missing from the operator checkout", async () => {
  const f = await fixture();
  await f.work("checkout", "--detach", "main");
  const detached = await f.commit("detached work", "detached.txt", "detached\n");
  // A runner that drops the collect fetch: the bundle is listed but its objects never arrive.
  const dropping: CommandRunner = { run: (command, args, signal, options) =>
    command === "git" && args.includes("fetch") && args.some((arg) => arg.includes("collect.bundle"))
      ? Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
      : f.runner.run(command, args, signal, options) };
  const collected = await collectWriter({ ...f.ctx, runner: dropping }, "repo-w1");
  expect(collected).toMatchObject({ status: "failed", code: "writer_collect_incomplete" });
  expect(collected.refs).toContain(DETACHED_REF);
  expect((await readWriterState(f.ctx.home, "repo-w1"))!.collected).toBeUndefined();
  expect(await gitPresent(f.checkout, "cat-file", "-e", `${detached}^{commit}`)).toBe(false);
  expect(await gitPresent(f.checkout, "rev-parse", "--verify", DETACHED_REF)).toBe(false);
}, 60_000);

it("ignores clone replace refs that would make a detached commit look reachable", async () => {
  const f = await fixture();
  await f.work("checkout", "--detach", "main");
  const detached = await f.commit("detached work", "detached.txt", "detached\n");
  // A graft makes the base commit claim the detached commit as its parent.
  await f.work("replace", "--graft", f.baseCommit, detached);
  const collected = await collectWriter(f.ctx, "repo-w1");
  expect(collected).toMatchObject({ refused: 0, findings: [] });
  expect(await git(f.checkout, "rev-parse", "--verify", DETACHED_REF)).toBe(detached);
  // The graft commit exists only in the clone and replace refs are not exported, so no digest is recorded (#202).
  expect(collected).toMatchObject({ status: "failed", code: "writer_collect_incomplete" });
  expect((await readWriterState(f.ctx.home, "repo-w1"))!.collected).toBeUndefined();
}, 60_000);

it("ignores a clone graft file that would make a detached commit look reachable (#228)", async () => {
  const f = await fixture();
  await f.work("checkout", "--detach", "main");
  const detached = await f.commit("detached work", "detached.txt", "detached\n");
  // The worker can write the legacy graft file: it claims the detached commit as the parent of main's tip.
  await writeFile(join(f.paths.clone, ".git/info/grafts"), `${f.baseCommit} ${detached}\n`);
  expect(await spawn("git", ["-c", "core.useReplaceRefs=false", "-C", f.paths.clone, "rev-list", "-n", "1", detached, "--not", "--branches"]).then((r) => r.stdout.trim()), "the graft hides the commit from the check").toBe("");
  const collected = await collectWriter(f.ctx, "repo-w1");
  expect(collected).toMatchObject({ status: "ok", code: "writer_collected", refused: 0, findings: [] });
  expect(collected.refs).toContain(DETACHED_REF);
  expect(await git(f.checkout, "rev-parse", "--verify", DETACHED_REF)).toBe(detached);
  expect(await gitPresent(f.checkout, "cat-file", "-e", `${detached}^{commit}`)).toBe(true);
  expect(await finishWriter(f.ctx, "repo-w1")).toMatchObject({ status: "ok", code: "writer_reset" });
  expect(await git(f.checkout, "rev-parse", "--verify", DETACHED_REF)).toBe(detached);
}, 60_000);

it("refuses a derived name that conflicts with an exported branch path and still exports that branch", async () => {
  const f = await fixture();
  await f.work("checkout", "--detach", "main");
  const detached = await f.commit("detached work", "detached.txt", "detached\n");
  await f.work("branch", "main-detached/topic", detached);
  await f.work("checkout", "--detach", "main");
  const other = await f.commit("other detached work", "other.txt", "other\n");
  const collected = await collectWriter(f.ctx, "repo-w1");
  expect(collected).toMatchObject({ status: "failed", code: "writer_collect_incomplete", findings: [{ code: "ref_name_refused" }] });
  expect(await git(f.checkout, "rev-parse", "--verify", "refs/remotes/writer-repo-w1/main-detached/topic")).toBe(detached);
  expect(await gitPresent(f.checkout, "cat-file", "-e", `${other}^{commit}`)).toBe(false);
  expect((await readWriterState(f.ctx.home, "repo-w1"))!.collected).toBeUndefined();
  expect(await removeWriter(f.ctx, "repo-w1", { discard: false })).toMatchObject({ status: "failed", code: "writer_uncollected" });
}, 60_000);

/** The exact index-only case: HEAD and worktree hold "base", only the index holds the marker (`git status` shows `MM`). */
async function indexOnlyWork(f: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  await writeFile(join(f.paths.clone, "base.txt"), "SYNTHETIC_STAGED_ONLY_3107\n");
  await f.work("add", "base.txt");
  await f.work("restore", "--source=HEAD", "--worktree", "--", "base.txt");
  expect(await f.work("status", "--porcelain")).toBe("MM base.txt");
  expect(await f.work("show", ":base.txt")).toBe("SYNTHETIC_STAGED_ONLY_3107");
  return f.work("rev-parse", ":base.txt");
}

it("never removes a writer whose only work is staged in the index, without discard", async () => {
  const f = await fixture();
  const blob = await indexOnlyWork(f);
  expect((await removeWriter(f.ctx, "repo-w1", { discard: false })).status).toBe("failed");
  expect(await f.work("rev-parse", ":base.txt")).toBe(blob);
}, 60_000);

it("does not report index-only work as nothing to collect, and finish keeps it", async () => {
  const f = await fixture();
  const blob = await indexOnlyWork(f);
  const collected = await collectWriter(f.ctx, "repo-w1");
  expect(collected.code).not.toBe("nothing_to_collect");
  const finished = await finishWriter(f.ctx, "repo-w1");
  const kept = await gitPresent(f.checkout, "cat-file", "-e", `${blob}^{blob}`);
  // Either the staged blob reached the operator checkout, or finish refused and the index is unchanged.
  if (!kept) {
    expect(finished.status).toBe("failed");
    expect(await f.work("rev-parse", ":base.txt")).toBe(blob);
  }
}, 60_000);

it("collects, finishes and removes the exact index-only writer under <branch>-index (#200)", async () => {
  const f = await fixture();
  const blob = await indexOnlyWork(f);
  const collected = await collectWriter(f.ctx, "repo-w1");
  expect(collected.status).toBe("ok");
  expect(collected.code).toBe("writer_collected");
  expect(collected.refs).toContain(INDEX_REF);
  expect(collected.refs).not.toContain(WIP_REF);
  expect(await git(f.checkout, "show", `${INDEX_REF}:base.txt`)).toBe("SYNTHETIC_STAGED_ONLY_3107");
  expect(await git(f.checkout, "rev-parse", `${INDEX_REF}:base.txt`)).toBe(blob);
  expect(await gitPresent(f.checkout, "cat-file", "-e", `${blob}^{blob}`)).toBe(true);
  expect(await finishWriter(f.ctx, "repo-w1")).toMatchObject({ status: "ok", code: "writer_reset" });
  expect(await git(f.checkout, "rev-parse", `${INDEX_REF}:base.txt`)).toBe(blob);
  expect(await removeWriter(f.ctx, "repo-w1", { discard: false })).toMatchObject({ status: "ok", code: "writer_removed" });
}, 60_000);

it("exports a staged new file whose worktree copy is gone (AD) and finish keeps the blob (#200)", async () => {
  const f = await fixture();
  await writeFile(join(f.paths.clone, "staged-only.txt"), "SYNTHETIC_STAGED_NEW_3107\n");
  await f.work("add", "staged-only.txt");
  await rm(join(f.paths.clone, "staged-only.txt"));
  expect(await f.work("status", "--porcelain")).toBe("AD staged-only.txt");
  const blob = await f.work("rev-parse", ":staged-only.txt");
  const collected = await collectWriter(f.ctx, "repo-w1");
  expect(collected).toMatchObject({ status: "ok", code: "writer_collected" });
  expect(collected.refs).toContain(INDEX_REF);
  expect(await git(f.checkout, "rev-parse", `${INDEX_REF}:staged-only.txt`)).toBe(blob);
  expect(await finishWriter(f.ctx, "repo-w1")).toMatchObject({ status: "ok", code: "writer_reset" });
  expect(await gitPresent(f.checkout, "cat-file", "-e", `${blob}^{blob}`)).toBe(true);
}, 60_000);

it("treats a staged deletion with the worktree file restored as uncollected work (#200)", async () => {
  const f = await fixture();
  // The index deletes base.txt while the worktree still holds it: the index tree differs from
  // both the HEAD tree and the worktree tree.
  await f.work("rm", "--cached", "base.txt");
  expect(await f.work("status", "--porcelain")).toContain("D  base.txt");
  expect(await removeWriter(f.ctx, "repo-w1", { discard: false })).toMatchObject({ status: "failed", code: "writer_uncollected" });
  const collected = await collectWriter(f.ctx, "repo-w1");
  expect(collected).toMatchObject({ status: "ok", code: "writer_collected" });
  expect(collected.refs).toContain(INDEX_REF);
  // The export records the staged tree, in which base.txt is deleted.
  expect(await git(f.checkout, "rev-parse", `${INDEX_REF}^{tree}`)).toBe(await f.work("write-tree"));
  expect(await gitPresent(f.checkout, "cat-file", "-e", `${INDEX_REF}:base.txt`)).toBe(false);
}, 60_000);

it("exports only the -wip ref when the index matches the worktree (M) (#200)", async () => {
  const f = await fixture();
  await writeFile(join(f.paths.clone, "base.txt"), "SYNTHETIC_STAGED_AND_WORKTREE_3107\n");
  await f.work("add", "base.txt");
  expect(await f.work("status", "--porcelain")).toBe("M  base.txt");
  const collected = await collectWriter(f.ctx, "repo-w1");
  expect(collected).toMatchObject({ status: "ok", code: "writer_collected" });
  expect(collected.refs).toContain(WIP_REF);
  expect(collected.refs).not.toContain(INDEX_REF);
  expect(await gitPresent(f.checkout, "rev-parse", "--verify", INDEX_REF)).toBe(false);
  expect(await git(f.checkout, "show", `${WIP_REF}:base.txt`)).toBe("SYNTHETIC_STAGED_AND_WORKTREE_3107");
  expect(await finishWriter(f.ctx, "repo-w1")).toMatchObject({ status: "ok", code: "writer_reset" });
}, 60_000);

it("collects an intent-to-add file through -wip instead of refusing (#200)", async () => {
  const f = await fixture();
  await writeFile(join(f.paths.clone, "intent.txt"), "SYNTHETIC_INTENT_TO_ADD_3107\n");
  await f.work("add", "-N", "intent.txt");
  expect(await f.work("status", "--porcelain")).toBe("A intent.txt"); // " A", trimmed
  // write-tree skips intent-to-add entries, so the index tree equals HEAD and no -index ref is needed.
  const collected = await collectWriter(f.ctx, "repo-w1");
  expect(collected).toMatchObject({ status: "ok", code: "writer_collected" });
  expect(collected.refs).toContain(WIP_REF);
  expect(collected.refs).not.toContain(INDEX_REF);
  expect(await git(f.checkout, "show", `${WIP_REF}:intent.txt`)).toBe("SYNTHETIC_INTENT_TO_ADD_3107");
  expect(await finishWriter(f.ctx, "repo-w1")).toMatchObject({ status: "ok", code: "writer_reset" });
}, 60_000);

it("invalidates an earlier collection when only the index changes afterwards (#200)", async () => {
  const f = await fixture();
  await writeFile(join(f.paths.clone, "base.txt"), "SYNTHETIC_INDEX_FIRST_3107\n");
  await f.work("add", "base.txt");
  expect(await f.work("status", "--porcelain")).toBe("M  base.txt");
  expect(await collectWriter(f.ctx, "repo-w1")).toMatchObject({ status: "ok", code: "writer_collected" });
  // Stage a different blob without touching the worktree, so only the index tree changes.
  const outside = join(await temporaryRoot("pi-writer-blob-"), "second.txt");
  await writeFile(outside, "SYNTHETIC_INDEX_SECOND_3107\n");
  const second = await f.work("hash-object", "-w", outside);
  await f.work("update-index", "--cacheinfo", `100644,${second},base.txt`);
  expect(await readFile(join(f.paths.clone, "base.txt"), "utf8")).toBe("SYNTHETIC_INDEX_FIRST_3107\n");
  expect(await f.work("status", "--porcelain")).toBe("MM base.txt");
  const staged = await f.work("rev-parse", ":base.txt");
  const indexBefore = await readFile(join(f.paths.clone, ".git/index"));
  expect(await removeWriter(f.ctx, "repo-w1", { discard: false })).toMatchObject({ status: "failed", code: "writer_uncollected" });
  expect(await resetWriter(f.ctx, "repo-w1", { discard: false })).toMatchObject({ status: "failed", code: "writer_uncollected" });
  expect(await f.work("rev-parse", ":base.txt")).toBe(staged);
  expect((await readFile(join(f.paths.clone, ".git/index"))).equals(indexBefore)).toBe(true);
}, 60_000);

it("refuses a taken or conflicting -index name and records no digest (#200)", async () => {
  for (const branch of ["main-index", "main-index/topic"]) {
    const f = await fixture();
    await f.work("branch", branch);
    const blob = await indexOnlyWork(f);
    expect(await collectWriter(f.ctx, "repo-w1")).toMatchObject({ status: "failed", code: "writer_collect_incomplete", findings: [{ code: "ref_name_refused" }] });
    expect((await readWriterState(f.ctx.home, "repo-w1"))!.collected).toBeUndefined();
    expect(await finishWriter(f.ctx, "repo-w1")).toMatchObject({ status: "failed" });
    expect(await f.work("rev-parse", ":base.txt")).toBe(blob);
  }
}, 120_000);

it("fails closed on an unmerged index and preserves the conflict (#200)", async () => {
  const f = await fixture();
  await f.work("checkout", "-b", "other");
  await f.commit("other side", "base.txt", "SYNTHETIC_CONFLICT_OTHER_3107\n");
  await f.work("checkout", "main");
  await f.commit("main side", "base.txt", "SYNTHETIC_CONFLICT_MAIN_3107\n");
  const merge = await spawn("git", ["-C", f.paths.clone, "merge", "other"]);
  expect(merge.exitCode, "merge must conflict").not.toBe(0);
  const unmerged = async () => (await f.work("ls-files", "-u")).split("\n").filter(Boolean);
  const conflictBefore = await f.work("ls-files", "-u");
  expect(await unmerged()).toHaveLength(3);
  expect((await collectWriter(f.ctx, "repo-w1")).status).toBe("failed");
  expect((await finishWriter(f.ctx, "repo-w1")).status).toBe("failed");
  expect((await removeWriter(f.ctx, "repo-w1", { discard: false })).status).toBe("failed");
  expect(await unmerged()).toHaveLength(3);
  expect(await f.work("ls-files", "-u")).toBe(conflictBefore);
}, 60_000);

it("inspects the index non-mutatingly during collection (#200)", async () => {
  const f = await fixture();
  await indexOnlyWork(f);
  const indexPath = join(f.paths.clone, ".git/index");
  const statusBefore = await f.work("status", "--porcelain");
  expect(statusBefore).toBe("MM base.txt");
  const indexBefore = await readFile(indexPath);
  const statBefore = await stat(indexPath);
  const collected = await collectWriter(f.ctx, "repo-w1");
  expect(collected.status).toBe("ok");
  // Sample the index before running any other Git command: `git status` may rewrite a racy index itself.
  const indexAfter = await readFile(indexPath);
  const statAfter = await stat(indexPath);
  expect(indexAfter.equals(indexBefore)).toBe(true);
  expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
  expect(statAfter.size).toBe(statBefore.size);
  expect(await f.work("status", "--porcelain")).toBe(statusBefore);
}, 60_000);

it("still collects nothing and removes a pristine writer without discard (#200 regression guard)", async () => {
  const f = await fixture();
  expect(await collectWriter(f.ctx, "repo-w1")).toMatchObject({ status: "ok", code: "nothing_to_collect", refs: [], refused: 0, findings: [] });
  expect(await git(f.checkout, "for-each-ref", "--format=%(refname)", "refs/remotes/writer-repo-w1/")).toBe("");
  expect(await removeWriter(f.ctx, "repo-w1", { discard: false })).toMatchObject({ status: "ok", code: "writer_removed" });
}, 60_000);

const STASH_REF = (n: number) => `refs/remotes/writer-repo-w1/main-stash-${n}`;

/** The issue's state: a clean worktree on the base branch whose only work is a stash entry. */
async function stashOnlyWork(f: Awaited<ReturnType<typeof fixture>>, marker = "SYNTHETIC_STASH_ONLY_3107"): Promise<string> {
  await writeFile(join(f.paths.clone, "base.txt"), `${marker}\n`);
  const blob = await f.work("hash-object", "base.txt");
  await f.work("stash", "push", "-m", marker);
  expect(await f.work("status", "--porcelain")).toBe("");
  return blob;
}

it("exports a stash-only writer as <base>-stash-0 before remove (#202)", async () => {
  const f = await fixture();
  const blob = await stashOnlyWork(f);
  const stash = await f.work("rev-parse", "refs/stash");
  const collected = await collectWriter(f.ctx, "repo-w1");
  expect(collected).toMatchObject({ status: "ok", code: "writer_collected", refs: [STASH_REF(0)], refused: 0 });
  expect(await git(f.checkout, "rev-parse", "--verify", STASH_REF(0))).toBe(stash);
  expect(await gitPresent(f.checkout, "cat-file", "-e", blob)).toBe(true);
  expect(await removeWriter(f.ctx, "repo-w1", { discard: false })).toMatchObject({ status: "ok", code: "writer_removed" });
  expect(await git(f.checkout, "cat-file", "-p", `${STASH_REF(0)}:base.txt`)).toBe("SYNTHETIC_STASH_ONLY_3107");
}, 60_000);

it("exports every stash entry in stash@{n} order, with staged and untracked parts, and finish keeps them (#202)", async () => {
  const f = await fixture();
  await stashOnlyWork(f, "older");
  await writeFile(join(f.paths.clone, "base.txt"), "staged\n");
  await f.work("add", "base.txt");
  await writeFile(join(f.paths.clone, "untracked.txt"), "untracked\n");
  await f.work("stash", "push", "--include-untracked", "-m", "newer");
  const entries = (await f.work("stash", "list", "--format=%H")).split("\n");
  expect(entries).toHaveLength(2);
  const collected = await collectWriter(f.ctx, "repo-w1");
  expect(collected).toMatchObject({ status: "ok", code: "writer_collected", refused: 0 });
  expect([...collected.refs].sort()).toEqual([STASH_REF(0), STASH_REF(1)]);
  expect(await git(f.checkout, "rev-parse", STASH_REF(0), STASH_REF(1))).toBe(entries.join("\n"));
  // The newer entry's index parent and untracked parent arrive with it.
  expect(await git(f.checkout, "cat-file", "-p", `${STASH_REF(0)}^2:base.txt`)).toBe("staged");
  expect(await git(f.checkout, "cat-file", "-p", `${STASH_REF(0)}^3:untracked.txt`)).toBe("untracked");
  expect(await git(f.checkout, "cat-file", "-p", `${STASH_REF(1)}:base.txt`)).toBe("older");
  expect(await finishWriter(f.ctx, "repo-w1")).toMatchObject({ status: "ok", code: "writer_reset" });
  expect(await f.work("stash", "list")).toBe("");
  expect(await git(f.checkout, "rev-parse", STASH_REF(0), STASH_REF(1))).toBe(entries.join("\n"));
}, 60_000);

it("exports a stash tip that has no reflog (#202)", async () => {
  const f = await fixture();
  await stashOnlyWork(f);
  const stash = await f.work("rev-parse", "refs/stash");
  await rm(join(f.paths.clone, ".git/logs/refs/stash"));
  expect(await f.work("rev-list", "--walk-reflogs", "refs/stash")).toBe("");
  const collected = await collectWriter(f.ctx, "repo-w1");
  expect(collected).toMatchObject({ status: "ok", code: "writer_collected", refs: [STASH_REF(0)] });
  expect(await git(f.checkout, "rev-parse", "--verify", STASH_REF(0))).toBe(stash);
}, 60_000);

it("invalidates an earlier collection when only a stash entry is added afterwards (#202)", async () => {
  const f = await fixture();
  expect((await collectWriter(f.ctx, "repo-w1")).code).toBe("nothing_to_collect");
  const blob = await stashOnlyWork(f);
  expect(await removeWriter(f.ctx, "repo-w1", { discard: false })).toMatchObject({ status: "failed", code: "writer_uncollected" });
  expect(await resetWriter(f.ctx, "repo-w1", { discard: false })).toMatchObject({ status: "failed", code: "writer_uncollected" });
  expect(await gitPresent(f.paths.clone, "cat-file", "-e", blob)).toBe(true);
  expect(await f.work("stash", "list", "--format=%s")).toBe("On main: SYNTHETIC_STASH_ONLY_3107");
}, 60_000);

it("refuses a taken <base>-stash-0 name and records no digest (#202)", async () => {
  const f = await fixture();
  await stashOnlyWork(f);
  await f.work("branch", "main-stash-0", "main");
  const collected = await collectWriter(f.ctx, "repo-w1");
  expect(collected).toMatchObject({ status: "failed", code: "writer_collect_incomplete", findings: [{ code: "ref_name_refused" }] });
  expect((await readWriterState(f.ctx.home, "repo-w1"))!.collected).toBeUndefined();
  expect(await removeWriter(f.ctx, "repo-w1", { discard: false })).toMatchObject({ status: "failed", code: "writer_uncollected" });
  expect(await f.work("stash", "list", "--format=%s")).toBe("On main: SYNTHETIC_STASH_ONLY_3107");
}, 60_000);

it("refuses cleanup while a note or an annotated tag holds objects only the clone has (#202)", async () => {
  for (const [label, create, drop] of [
    ["note", ["notes", "add", "-m", "SYNTHETIC_NOTE_3107", "HEAD"], ["update-ref", "-d", "refs/notes/commits"]],
    ["tag", ["tag", "-a", "-m", "SYNTHETIC_TAG_3107", "v-writer", "HEAD"], ["tag", "-d", "v-writer"]],
    ["tag name outside the export rules", ["tag", "-a", "-m", "SYNTHETIC_TAG_3107", "pkg@1.0.0+build", "HEAD"], ["tag", "-d", "pkg@1.0.0+build"]],
  ] as const) {
    const f = await fixture();
    await f.work(...create);
    expect(await removeWriter(f.ctx, "repo-w1", { discard: false }), label).toMatchObject({ status: "failed", code: "writer_uncollected" });
    const collected = await collectWriter(f.ctx, "repo-w1");
    expect(collected, label).toMatchObject({ status: "failed", code: "writer_collect_incomplete", refs: [], refused: 0, findings: [] });
    expect((await readWriterState(f.ctx.home, "repo-w1"))!.collected, label).toBeUndefined();
    expect(await finishWriter(f.ctx, "repo-w1"), label).toMatchObject({ status: "failed", code: "writer_collect_incomplete" });
    expect(await removeWriter(f.ctx, "repo-w1", { discard: false }), label).toMatchObject({ status: "failed", code: "writer_uncollected" });
    // Once a session resolves the ref inside the boundary, the writer is pristine again.
    await f.work(...drop);
    expect(await collectWriter(f.ctx, "repo-w1"), label).toMatchObject({ status: "ok", code: "nothing_to_collect" });
    expect(await removeWriter(f.ctx, "repo-w1", { discard: false }), label).toMatchObject({ status: "ok", code: "writer_removed" });
  }
}, 120_000);

it("treats tags and other refs whose objects the operator checkout has as baseline (#202)", async () => {
  const f = await fixture();
  // Provisioned tags and a lightweight tag on the base commit name only objects the operator has; only the name is lost.
  await git(f.checkout, "tag", "-a", "-m", "operator", "v-operator", "main");
  // Tag names outside the branch export name rules are only compared, never refused.
  await git(f.checkout, "tag", "-a", "-m", "operator", "@scope/pkg@1.0.0+build", "main");
  await f.work("fetch", "--quiet", "origin", "+refs/tags/*:refs/tags/*");
  expect(await f.work("tag", "--list")).toContain("@scope/pkg@1.0.0+build");
  await f.work("tag", "v-light", "main");
  await f.work("update-ref", "refs/bisect/bad", "main");
  expect((await inspectWork(f.ctx, "repo-w1")).baseline).toBe(true);
  expect(await collectWriter(f.ctx, "repo-w1")).toMatchObject({ status: "ok", code: "nothing_to_collect", refs: [] });
  expect(await removeWriter(f.ctx, "repo-w1", { discard: false })).toMatchObject({ status: "ok", code: "writer_removed" });
}, 60_000);

it("refuses cleanup while a remote-tracking ref holds the only copy of a commit (#202)", async () => {
  const f = await fixture();
  const hidden = await f.commit("hidden work", "hidden.txt", "SYNTHETIC_REMOTE_ONLY_3107\n");
  await f.work("update-ref", "refs/remotes/origin/hidden", hidden);
  await f.work("reset", "--hard", f.baseCommit);
  expect((await inspectWork(f.ctx, "repo-w1")).baseline).toBe(false);
  expect(await collectWriter(f.ctx, "repo-w1")).toMatchObject({ status: "failed", code: "writer_collect_incomplete", refs: [], findings: [] });
  expect(await removeWriter(f.ctx, "repo-w1", { discard: false })).toMatchObject({ status: "failed", code: "writer_uncollected" });
  expect(await f.work("cat-file", "-p", `${hidden}:hidden.txt`)).toBe("SYNTHETIC_REMOTE_ONLY_3107");
}, 60_000);

it("refuses cleanup when refs/stash names a non-commit object (#202)", async () => {
  const f = await fixture();
  await writeFile(join(f.paths.clone, "blob.txt"), "SYNTHETIC_BLOB_STASH_3107\n");
  const blob = await f.work("hash-object", "-w", "blob.txt");
  await rm(join(f.paths.clone, "blob.txt"));
  await f.work("update-ref", "refs/stash", blob);
  const collected = await collectWriter(f.ctx, "repo-w1");
  expect(collected).toMatchObject({ status: "failed", code: "writer_collect_incomplete" });
  expect((await readWriterState(f.ctx.home, "repo-w1"))!.collected).toBeUndefined();
  expect(await removeWriter(f.ctx, "repo-w1", { discard: false })).toMatchObject({ status: "failed", code: "writer_uncollected" });
}, 60_000);

it("collects edits to tracked files hidden by assume-unchanged and skip-worktree index flags (#231)", async () => {
  const f = await fixture();
  await f.commit("second tracked file", "second.txt", "second\n");
  const head = await f.work("rev-parse", "HEAD");
  await writeFile(join(f.paths.clone, "base.txt"), "SYNTHETIC_ASSUME_UNCHANGED_3107\n");
  await writeFile(join(f.paths.clone, "second.txt"), "SYNTHETIC_SKIP_WORKTREE_3107\n");
  await f.work("update-index", "--assume-unchanged", "base.txt");
  await f.work("update-index", "--skip-worktree", "second.txt");
  expect(await f.work("status", "--porcelain"), "the flags hide both edits from git status").toBe("");
  const inspected = await inspectWork(f.ctx, "repo-w1");
  expect(inspected.baseline).toBe(false);
  expect(inspected.dirty).toBe(true);
  expect(inspected.tree).not.toBe(inspected.headTree);
  const collected = await collectWriter(f.ctx, "repo-w1");
  expect(collected).toMatchObject({ status: "ok", code: "writer_collected", refused: 0, findings: [] });
  expect(collected.refs).toContain(WIP_REF);
  expect(await git(f.checkout, "show", `${WIP_REF}:base.txt`)).toBe("SYNTHETIC_ASSUME_UNCHANGED_3107");
  expect(await git(f.checkout, "show", `${WIP_REF}:second.txt`)).toBe("SYNTHETIC_SKIP_WORKTREE_3107");
  expect(await git(f.checkout, "rev-parse", `${WIP_REF}^`)).toBe(head);
  // The real index of the clone keeps its flags: only the temporary copy is neutralized.
  expect(await f.work("ls-files", "-v")).toMatch(/^h base\.txt$/m);
  expect(await f.work("ls-files", "-v")).toMatch(/^S second\.txt$/m);
  expect(await finishWriter(f.ctx, "repo-w1")).toMatchObject({ status: "ok", code: "writer_reset" });
  expect(await git(f.checkout, "show", `${WIP_REF}:base.txt`)).toBe("SYNTHETIC_ASSUME_UNCHANGED_3107");
  expect(await git(f.checkout, "show", `${WIP_REF}:second.txt`)).toBe("SYNTHETIC_SKIP_WORKTREE_3107");
}, 60_000);

it("keeps the index blob of a skip-worktree entry whose file is absent and does not collect a deletion (#231)", async () => {
  const f = await fixture();
  await f.work("update-index", "--skip-worktree", "base.txt");
  await rm(join(f.paths.clone, "base.txt"));
  expect(await f.work("status", "--porcelain")).toBe("");
  expect(await inspectWork(f.ctx, "repo-w1")).toMatchObject({ baseline: true, dirty: false });
  expect(await collectWriter(f.ctx, "repo-w1")).toMatchObject({ status: "ok", code: "nothing_to_collect", refs: [] });
  expect(await finishWriter(f.ctx, "repo-w1")).toMatchObject({ status: "ok", code: "writer_reset" });
  expect(await f.work("show", "HEAD:base.txt")).toBe("base");
}, 60_000);

it("collects flagged edits under a sparse checkout and a sparse index configured in the clone (#231)", async () => {
  const f = await fixture();
  await mkdir(join(f.paths.clone, "kept"));
  await mkdir(join(f.paths.clone, "outside"));
  await writeFile(join(f.paths.clone, "kept/in.txt"), "in\n");
  await writeFile(join(f.paths.clone, "outside/out.txt"), "out\n");
  await f.work("add", "kept", "outside");
  await f.work("commit", "-m", "directories");
  // Configure the sparse checkout by hand: `git sparse-checkout` writes config.worktree, which clone verification rejects.
  await f.work("config", "core.sparseCheckout", "true");
  await f.work("config", "core.sparseCheckoutCone", "true");
  await f.work("config", "index.sparse", "true");
  await writeFile(join(f.paths.clone, ".git/info/sparse-checkout"), "/*\n!/*/\n/kept/\n");
  await f.work("read-tree", "-mu", "HEAD");
  expect(await stat(join(f.paths.clone, "outside")).catch(() => undefined), "the sparse checkout removed the directory").toBeUndefined();
  expect(await f.work("config", "core.sparseCheckout")).toBe("true");
  await writeFile(join(f.paths.clone, "kept/in.txt"), "SYNTHETIC_SPARSE_EDIT_3107\n");
  await f.work("update-index", "--assume-unchanged", "kept/in.txt");
  // New work outside the cone: plain `add -A` skips these paths and exits non-zero.
  await mkdir(join(f.paths.clone, "outside"));
  await writeFile(join(f.paths.clone, "outside/new.txt"), "SYNTHETIC_OUTSIDE_NEW_3107\n");
  await writeFile(join(f.paths.clone, "outside/out.txt"), "SYNTHETIC_OUTSIDE_EDIT_3107\n");
  expect((await spawn("git", ["-C", f.paths.clone, "add", "-n", "-A"])).exitCode, "plain add -A fails under the sparse config").not.toBe(0);
  expect((await inspectWork(f.ctx, "repo-w1")).dirty).toBe(true);
  const collected = await collectWriter(f.ctx, "repo-w1");
  expect(collected).toMatchObject({ status: "ok", code: "writer_collected", refused: 0, findings: [] });
  expect(await git(f.checkout, "show", `${WIP_REF}:kept/in.txt`)).toBe("SYNTHETIC_SPARSE_EDIT_3107");
  expect(await git(f.checkout, "show", `${WIP_REF}:outside/out.txt`)).toBe("SYNTHETIC_OUTSIDE_EDIT_3107");
  expect(await git(f.checkout, "show", `${WIP_REF}:outside/new.txt`)).toBe("SYNTHETIC_OUTSIDE_NEW_3107");
  expect(await git(f.checkout, "show", `${WIP_REF}:base.txt`)).toBe("base");
  expect(await finishWriter(f.ctx, "repo-w1")).toMatchObject({ status: "ok", code: "writer_reset" });
}, 60_000);

it("neutralizes index flags on tracked paths with spaces, newlines and a leading dash (#231)", async () => {
  const f = await fixture();
  const odd = ["-dash name.txt", "line\nbreak.txt"];
  for (const path of odd) await writeFile(join(f.paths.clone, path), "tracked\n");
  await f.work("add", "--", ...odd);
  await f.work("commit", "-m", "odd names");
  for (const path of odd) await writeFile(join(f.paths.clone, path), "SYNTHETIC_ODD_NAME_EDIT_3107\n");
  await f.work("update-index", "--assume-unchanged", "--", odd[0]!);
  await f.work("update-index", "--skip-worktree", "--", odd[1]!);
  expect((await inspectWork(f.ctx, "repo-w1")).dirty).toBe(true);
  const collected = await collectWriter(f.ctx, "repo-w1");
  expect(collected).toMatchObject({ status: "ok", code: "writer_collected" });
  for (const path of odd) expect(await git(f.checkout, "show", `${WIP_REF}:${path}`)).toBe("SYNTHETIC_ODD_NAME_EDIT_3107");
  expect(await finishWriter(f.ctx, "repo-w1")).toMatchObject({ status: "ok", code: "writer_reset" });
}, 60_000);

it("resets a conflicted writer with flagged entries only on explicit discard (#231)", async () => {
  const f = await fixture();
  await f.commit("second tracked file", "second.txt", "second\n");
  await f.work("checkout", "-b", "other");
  await f.commit("other side", "base.txt", "SYNTHETIC_CONFLICT_OTHER_3107\n");
  await f.work("checkout", "main");
  await f.commit("main side", "base.txt", "SYNTHETIC_CONFLICT_MAIN_3107\n");
  const merge = await spawn("git", ["-C", f.paths.clone, "merge", "other"]);
  expect(merge.exitCode, "merge must conflict").not.toBe(0);
  expect((await f.work("ls-files", "-u")).split("\n").filter(Boolean)).toHaveLength(3);
  await writeFile(join(f.paths.clone, "second.txt"), "SYNTHETIC_SKIP_WORKTREE_3107\n");
  await f.work("update-index", "--skip-worktree", "second.txt");
  expect(await resetWriter(f.ctx, "repo-w1", { discard: false })).toMatchObject({ status: "failed", code: "writer_inspect_failed" });
  expect(await resetWriter(f.ctx, "repo-w1", { discard: true })).toMatchObject({ status: "ok", code: "writer_reset" });
  expect(await f.work("ls-files", "-v")).not.toMatch(/^[a-zS]/m);
  expect(await f.work("ls-files", "-u")).toBe("");
  expect(await f.work("status", "--porcelain")).toBe("");
}, 60_000);

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import type { CommandResult, CommandRunner } from "../src/client-adapters/types.js";
import { collectWriter, finishWriter, inspectWork, provisionWriter, recreateWriter, removeWriter, resetWriter, type WriterContext } from "../src/writer-lifecycle.js";
import { readWriterState, writerPaths, writeWriterState } from "../src/writer-state.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

/*
 * The real boundary scripts against real Git, without Podman: the injected runner forwards host `git`
 * commands to real git and executes every `podman run ... sh -c <script> sh <args...>` (throwawayArgs)
 * locally, with `/tmp/` and `/bundles/` replaced by private temporary directories, in the clone
 * directory, with a private HOME and GIT_CONFIG_NOSYSTEM=1.
 */

const imageId = "a".repeat(64);
const settings = { writers: 1, lifecycle: "persistent", profiles: ["code"], image: "node", network: "none", cache: "none", tags: "none", clean: "untracked" } as const;
const rawConfig = { executionProfiles: { code: { default: false, permissionProfile: "coding", provider: "example", model: "model", thinkingLevel: "off" } } };

function spawn(command: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal | undefined } = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { cwd: options.cwd, env: options.env ?? { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }, signal: options.signal, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") { reject(error); return; }
      resolve({ exitCode: error && typeof error.code === "number" ? error.code : 0, stdout, stderr });
    });
  });
}

async function git(dir: string, ...args: string[]): Promise<string> {
  const result = await spawn("git", ["-c", "core.hooksPath=/dev/null", "-C", dir, ...args]);
  expect(result.exitCode, `git ${args.join(" ")}: ${result.stderr}`).toBe(0);
  return result.stdout.trim();
}
async function gitPresent(dir: string, ...args: string[]): Promise<boolean> {
  return (await spawn("git", ["-c", "core.hooksPath=/dev/null", "-C", dir, ...args])).exitCode === 0;
}

/** Forwards `git` to real git and runs every throwaway `podman run` script with `sh -c` in the clone. */
function realRunner(paths: { clone: string; bundles: string }): CommandRunner {
  return { async run(command, args, signal) {
    if (command === "git") return spawn("git", args, { signal });
    if (command !== "podman" || args[0] !== "run") return { exitCode: 1, stdout: "", stderr: `unexpected command: ${command} ${args[0] ?? ""}` };
    // throwawayArgs shape: [...flags, imageId, "sh", "-c", script, "sh", ...positional]
    const cIndex = args.indexOf("-c");
    if (cIndex < 1 || args[cIndex - 1] !== "sh" || args[cIndex + 2] !== "sh") return { exitCode: 1, stdout: "", stderr: "unexpected podman run shape" };
    const script = (args[cIndex + 1] ?? "").replaceAll("/tmp/", `${await temporaryRoot("pi-boundary-tmp-")}/`).replaceAll("/bundles/", `${paths.bundles}/`);
    const home = await temporaryRoot("pi-boundary-home-");
    return spawn("sh", ["-c", script, "sh", ...args.slice(cIndex + 3)], { cwd: paths.clone, env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" }, signal });
  } };
}

async function fixture() {
  const home = await temporaryRoot("pi-writer-collect-real-");
  const checkout = join(home, "source");
  const paths = writerPaths(home, "repo-w1");
  // The synthetic operator checkout: a real repository whose main is the base commit.
  await mkdir(checkout);
  await git(checkout, "init", "-b", "main");
  await git(checkout, "config", "user.name", "operator");
  await git(checkout, "config", "user.email", "operator@example.invalid");
  await writeFile(join(checkout, "base.txt"), "base\n");
  await git(checkout, "add", "base.txt");
  await git(checkout, "commit", "-m", "base");
  await git(checkout, "update-ref", "refs/remotes/origin/main", "HEAD");
  await git(checkout, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  const baseCommit = await git(checkout, "rev-parse", "HEAD");
  // Provision with a mocked runner (as in writer-collect.test.ts) ...
  const mocked: CommandRunner = { async run(command, args) {
    let stdout = "";
    if (command === "git") {
      if (args.includes("symbolic-ref")) stdout = "refs/remotes/origin/main";
      else if (args.includes("rev-parse")) stdout = args.includes("--symbolic-full-name") ? "refs/heads/main" : baseCommit;
      else if (args.includes("create")) await writeFile(join(paths.bundles, "base.bundle"), "bundle");
    } else if (args[0] === "image") stdout = imageId;
    else if (args.some((arg) => arg.includes("clone --no-hardlinks"))) {
      await mkdir(join(paths.clone, ".git/hooks"), { recursive: true });
      await writeFile(join(paths.clone, ".git/config"), "");
    }
    return { exitCode: 0, stdout, stderr: "" };
  } };
  const ctx: WriterContext = { home, checkout, releaseRoot: home, nodePath: process.execPath, runner: mocked, alias: "repo" };
  expect(await provisionWriter(ctx, { index: 1, settings, rawConfig })).toMatchObject({ status: "ok", code: "writer_provisioned" });
  // ... then replace the clone with a real clone of the synthetic source and record the real base commit.
  await rm(paths.clone, { recursive: true, force: true });
  const clone = await spawn("git", ["clone", "--quiet", "--no-hardlinks", checkout, paths.clone]);
  expect(clone.exitCode, clone.stderr).toBe(0);
  await git(paths.clone, "config", "user.name", "writer");
  await git(paths.clone, "config", "user.email", "writer@example.invalid");
  const state = (await readWriterState(home, "repo-w1"))!;
  await writeWriterState(home, "repo-w1", { ...state, base: { ref: "refs/heads/main", commit: baseCommit } });
  const runner = realRunner(paths);
  ctx.runner = runner;
  const work = async (...args: string[]) => git(paths.clone, ...args);
  const commit = async (message: string, file: string, content: string) => {
    await writeFile(join(paths.clone, file), content);
    await work("add", file);
    await work("commit", "-m", message);
    return work("rev-parse", "HEAD");
  };
  return { ctx, home, checkout, paths, baseCommit, runner, work, commit };
}

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

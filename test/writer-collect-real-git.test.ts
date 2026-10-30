import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import type { CommandResult, CommandRunner } from "../src/client-adapters/types.js";
import { collectWriter, finishWriter, provisionWriter, recreateWriter, removeWriter, resetWriter, type WriterContext } from "../src/writer-lifecycle.js";
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
  expect(collected).toMatchObject({ status: "ok", code: "writer_collected", refused: 0 });
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

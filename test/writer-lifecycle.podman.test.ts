import { execFile } from "node:child_process";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import type { CommandRunner } from "../src/client-adapters/types.js";
import { BOUNDARY_GIT, IMAGE_PULL_TIMEOUT_MS, podmanInfo, resolveImage, throwawayArgs } from "../src/writer-boundary.js";
import { collectWriter, inspectWork, provisionWriter, removeWriter, resetWriter } from "../src/writer-lifecycle.js";
import { readWriterState, writerPaths } from "../src/writer-state.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

const runner: CommandRunner = { run: (command, args, signal) => new Promise((resolve, reject) => {
  execFile(command, [...args], { signal, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    if (error && (typeof error.code !== "number")) { reject(error); return; }
    resolve({ exitCode: error && typeof error.code === "number" ? error.code : 0, stdout, stderr });
  });
}) };
let skipReason: string | undefined;
if (!(await podmanInfo(runner)).usable) skipReason = "Podman is unavailable or is not usable rootless";
else {
  try { await resolveImage(runner, "node", false); } catch { skipReason = "The accepted pinned Node image is not available locally (integration tests do not pull)"; }
}
if (skipReason) console.error(`writer-lifecycle.podman: skipped: ${skipReason}`);
afterAll(removeTemporaryRoots);
it.skipIf(skipReason !== undefined)("provisions, collects branch and WIP refs, and resets to a verified baseline", async () => {
  const home = await temporaryRoot("pi-writer-lifecycle-podman-");
  const checkout = join(home, "source");
  await mkdir(checkout);
  async function git(...args: string[]) {
    const result = await runner.run("git", ["-c", "core.hooksPath=/dev/null", "-C", checkout, ...args]);
    expect(result.exitCode, result.stderr).toBe(0);
  }
  await git("init", "-b", "main");
  await writeFile(join(checkout, "base.txt"), "base\n");
  await git("add", "base.txt");
  await git("-c", "user.name=writer-test", "-c", "user.email=writer@example.invalid", "commit", "-m", "base");
  await git("update-ref", "refs/remotes/origin/main", "HEAD");
  await git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  const ctx = { home, checkout, runner, alias: "repo", releaseRoot: home, nodePath: process.execPath };
  const rawConfig = { executionProfiles: { code: { default: false, permissionProfile: "coding", provider: "example", model: "model", thinkingLevel: "off" } } };
  expect(await provisionWriter(ctx, { index: 1, settings: { writers: 1, lifecycle: "persistent", profiles: ["code"], image: "node", network: "none", cache: "none", tags: "none" }, rawConfig })).toMatchObject({ status: "ok" });
  expect(await inspectWork(ctx, "repo-w1")).toMatchObject({ baseline: true, dirty: false });
  const paths = writerPaths(home, "repo-w1");
  const state = (await readWriterState(home, "repo-w1"))!;
  const work = await runner.run("podman", throwawayArgs(paths, state.imageId, { clone: "rw", bundles: false }, `set -eu
export GIT_CONFIG_NOSYSTEM=1
${BOUNDARY_GIT} checkout -b feature
printf '%s\\n' committed > committed.txt
${BOUNDARY_GIT} add committed.txt
${BOUNDARY_GIT} -c user.name=writer-test -c user.email=writer@example.invalid commit -m feature
printf '%s\\n' untracked > untracked.txt`, []), AbortSignal.timeout(IMAGE_PULL_TIMEOUT_MS));
  expect(work.exitCode, work.stderr).toBe(0);
  expect(await inspectWork(ctx, "repo-w1")).toMatchObject({ baseline: false, dirty: true });
  expect(await removeWriter(ctx, "repo-w1", { discard: false })).toEqual({ code: "writer_uncollected", status: "failed" });
  const collected = await collectWriter(ctx, "repo-w1");
  expect(collected).toMatchObject({ status: "ok", refused: 0 });
  expect(collected.refs).toEqual(["refs/remotes/writer-repo-w1/feature", "refs/remotes/writer-repo-w1/feature-wip"]);
  await git("rev-parse", "--verify", "refs/remotes/writer-repo-w1/feature");
  await git("rev-parse", "--verify", "refs/remotes/writer-repo-w1/feature-wip:untracked.txt");
  expect(await resetWriter(ctx, "repo-w1", { discard: false })).toMatchObject({ code: "writer_reset", status: "ok" });
  expect(await inspectWork(ctx, "repo-w1")).toMatchObject({ baseline: true, dirty: false });
  expect(await removeWriter(ctx, "repo-w1", { discard: false })).toMatchObject({ status: "ok" });
  await expect(lstat(paths.root)).rejects.toMatchObject({ code: "ENOENT" });
}, 120_000);

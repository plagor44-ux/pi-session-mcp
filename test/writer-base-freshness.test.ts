import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { SnapshotGit } from "../src/review-snapshot.js";
import { writerBaseFreshness } from "../src/writer-base-freshness.js";
import { writerPaths } from "../src/writer-state.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

// The production Git is a trusted system binary; these tests only need any Git, on every platform.
const plainGit: SnapshotGit = {
  run: (cwd, args) => new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], (error, stdout) => { resolve({ code: error ? Number(error.code ?? 1) : 0, stdout }); });
  }),
};
const temporary = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "base-freshness-")); roots.push(root);
  return root;
};
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@invalid", "-C", cwd, ...args], { encoding: "utf8" }).trim();
}
async function repository() {
  const home = await temporary(), checkout = join(home, "checkout");
  await mkdir(checkout);
  git(checkout, "init", "-q", "-b", "main");
  git(checkout, "commit", "-q", "--allow-empty", "-m", "one");
  await mkdir(writerPaths(home, "repo-w1").bundles, { recursive: true });
  return { home, checkout, first: git(checkout, "rev-parse", "HEAD") };
}
const commit = (checkout: string, message = "next"): string => { git(checkout, "commit", "-q", "--allow-empty", "-m", message); return git(checkout, "rev-parse", "HEAD"); };
const input = (home: string, checkout: string, base: string, ref = "refs/heads/main") => ({ home, name: "repo-w1", checkout, base: { ref, commit: base } });

it("reports current when the recorded commit is the branch's commit", async () => {
  const { home, checkout, first } = await repository();
  expect(await writerBaseFreshness(input(home, checkout, first), { git: plainGit })).toBe("current");
});
it("reports behind when the branch has moved past the recorded commit", async () => {
  const { home, checkout, first } = await repository();
  commit(checkout);
  expect(await writerBaseFreshness(input(home, checkout, first), { git: plainGit })).toBe("behind");
});
it("follows the remote source ref recorded in the base bundle, like a reset", async () => {
  const { home, checkout, first } = await repository();
  git(checkout, "update-ref", "refs/remotes/origin/feature", first);
  git(checkout, "bundle", "create", "-q", join(writerPaths(home, "repo-w1").bundles, "base.bundle"), "refs/remotes/origin/feature");
  const moved = commit(checkout);
  git(checkout, "update-ref", "refs/remotes/origin/feature", moved);
  expect(await writerBaseFreshness(input(home, checkout, first, "refs/heads/feature"), { git: plainGit })).toBe("behind");
});
it("reports unknown when the branch cannot be resolved", async () => {
  const { home, checkout, first } = await repository();
  expect(await writerBaseFreshness(input(home, checkout, first, "refs/heads/missing"), { git: plainGit })).toBe("unknown");
});
it("reports unknown outside a repository", async () => {
  const home = await temporary();
  expect(await writerBaseFreshness(input(home, home, "a".repeat(40)), { git: plainGit })).toBe("unknown");
});
it("reports unknown when the recorded commit is not an ancestor of the branch", async () => {
  const { home, checkout, first } = await repository();
  const side = commit(checkout, "side");
  git(checkout, "reset", "-q", "--hard", first);
  commit(checkout, "other");
  expect(await writerBaseFreshness(input(home, checkout, side), { git: plainGit })).toBe("unknown");
  expect(await writerBaseFreshness(input(home, checkout, "f".repeat(40)), { git: plainGit })).toBe("unknown");
});
it.each([
  ["remote.origin.promisor", "true"],
  ["remote.origin.partialclonefilter", "blob:none"],
  ["extensions.partialclone", "origin"],
])("never fetches through a promisor remote configured with %s", async (key, value) => {
  const { home, checkout, first } = await repository();
  const origin = join(home, "origin");
  git(home, "clone", "-q", "--bare", checkout, origin);
  const elsewhere = join(home, "elsewhere");
  git(home, "clone", "-q", origin, elsewhere);
  const missing = commit(elsewhere, "only on the remote");
  git(elsewhere, "push", "-q", "origin", "HEAD:refs/heads/other");
  git(checkout, "remote", "add", "origin", origin);
  git(checkout, "config", key, value);
  expect(await writerBaseFreshness(input(home, checkout, missing), { git: plainGit })).toBe("unknown");
  expect(() => execFileSync("git", ["--no-lazy-fetch", "-C", checkout, "cat-file", "-e", missing], { stdio: "pipe" })).toThrow();
  expect(await writerBaseFreshness(input(home, checkout, first), { git: plainGit })).toBe("unknown");
});
it("compares the recorded branch when the bundle names another one", async () => {
  const { home, checkout, first } = await repository();
  git(checkout, "update-ref", "refs/heads/other", first);
  git(checkout, "bundle", "create", "-q", join(writerPaths(home, "repo-w1").bundles, "base.bundle"), "refs/heads/other");
  const moved = commit(checkout);
  expect(await writerBaseFreshness(input(home, checkout, moved), { git: plainGit })).toBe("current");
  expect(await writerBaseFreshness(input(home, checkout, first), { git: plainGit })).toBe("behind");
});
it("refuses an unsafe recorded ref without running it", async () => {
  const { home, checkout, first } = await repository();
  const seen: string[][] = [];
  const recording: SnapshotGit = { run: (cwd, args) => { seen.push([...args]); return plainGit.run(cwd, args); } };
  expect(await writerBaseFreshness(input(home, checkout, first, "refs/heads/../../x"), { git: recording })).toBe("unknown");
  expect(seen.flat()).not.toContain("refs/heads/../../x^{commit}");
});
it("reports unknown when Git is unavailable or fails", async () => {
  const { home, checkout, first } = await repository();
  expect(await writerBaseFreshness(input(home, checkout, first), { git: undefined })).toBe("unknown");
  const failing: SnapshotGit = { run: async () => { throw new Error("spawn failed"); } };
  expect(await writerBaseFreshness(input(home, checkout, first), { git: failing })).toBe("unknown");
});
it("gives up at its deadline, even when Git ignores the signal", async () => {
  const { home, checkout, first } = await repository();
  const hanging: SnapshotGit = { run: () => new Promise(() => undefined) };
  const began = Date.now();
  expect(await writerBaseFreshness(input(home, checkout, first), { git: hanging, deadlineMs: 50 })).toBe("unknown");
  expect(Date.now() - began).toBeLessThan(2_000);
});
it("stops when the caller's signal aborts", async () => {
  const { home, checkout, first } = await repository();
  const hanging: SnapshotGit = { run: () => new Promise(() => undefined) };
  expect(await writerBaseFreshness(input(home, checkout, first), { git: hanging, signal: AbortSignal.abort() })).toBe("unknown");
});
it("leaves the repository untouched", async () => {
  const { home, checkout, first } = await repository();
  commit(checkout);
  const before = git(checkout, "for-each-ref");
  await writerBaseFreshness(input(home, checkout, first), { git: plainGit });
  expect(git(checkout, "for-each-ref")).toBe(before);
  expect(git(checkout, "status", "--porcelain")).toBe("");
});

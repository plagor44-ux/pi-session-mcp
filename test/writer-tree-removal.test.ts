import { chmod, lstat, mkdir, readdir, stat, symlink, writeFile } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import type { CommandRunner } from "../src/client-adapters/types.js";
import { removeWriter, type WriterContext } from "../src/writer-lifecycle.js";
import { makeTreeRemovable, removeWriterTree } from "../src/writer-tree-removal.js";
import { readWriterState, writerPaths, writeWriterState, type WriterState } from "../src/writer-state.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

const state: WriterState = {
  schemaVersion: 1, alias: "repo", index: 1, phase: "not_ready", lifecycle: "persistent", profiles: ["code"],
  providers: [{ provider: "example", model: "model" }], network: "none", cache: "go", tags: "none", clean: "untracked",
  imageId: "a".repeat(64), base: { ref: "refs/heads/main", commit: "b".repeat(40) },
};
const runner: CommandRunner = { async run() { throw new Error("no command expected"); } };

/** Builds what Go leaves behind: nested module directories and files without owner write permission. */
async function readOnlyGoCache(root: string): Promise<string> {
  const leaf = join(root, "go", "pkg", "mod", "example.com", "x@v1.0.0", "y");
  await mkdir(leaf, { recursive: true });
  await writeFile(join(leaf, "file.go"), "package y\n");
  await writeFile(join(root, "go", "pkg", "mod", "example.com", "x@v1.0.0", "go.mod"), "module x\n");
  await chmod(join(leaf, "file.go"), 0o444);
  await chmod(join(root, "go", "pkg", "mod", "example.com", "x@v1.0.0", "go.mod"), 0o444);
  for (const directory of [leaf, join(root, "go", "pkg", "mod", "example.com", "x@v1.0.0"), join(root, "go", "pkg", "mod", "example.com"), join(root, "go", "pkg", "mod")]) {
    await chmod(directory, 0o555);
  }
  return leaf;
}

// Root can unlink anywhere, so the failure this guards against cannot be reproduced as root.
const unprivileged = process.getuid?.() !== 0;

it.runIf(unprivileged)("removes a writer whose go cache has read-only directories and files", async () => {
  const home = await temporaryRoot("pi-writer-readonly-");
  const paths = writerPaths(home, "repo-w1");
  await writeWriterState(home, "repo-w1", state);
  await mkdir(paths.clone, { recursive: true });
  await writeFile(join(paths.clone, "keep"), "x");
  const leaf = await readOnlyGoCache(paths.root);
  await expect(stat(leaf)).resolves.toMatchObject({ mode: expect.any(Number) });
  const ctx: WriterContext = { home, releaseRoot: "/release", nodePath: process.execPath, runner, checkout: join(home, "source"), alias: "repo" };
  expect(await removeWriter(ctx, "repo-w1", { discard: true })).toEqual({ code: "writer_removed", status: "ok" });
  await expect(lstat(paths.root)).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps state.json when removing the rest fails part-way, and a retry succeeds", async () => {
  const home = await temporaryRoot("pi-writer-readonly-");
  const paths = writerPaths(home, "repo-w1");
  await writeWriterState(home, "repo-w1", state);
  await mkdir(paths.clone, { recursive: true });
  await mkdir(paths.go, { recursive: true });
  const real = fsPromises.rm;
  const failing = vi.spyOn(fsPromises, "rm").mockImplementation(async (path, options) => {
    if (String(path) === paths.go) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return real(path, options);
  });
  syncBuiltinESMExports();
  try {
    await expect(removeWriterTree(paths.root)).rejects.toMatchObject({ code: "EACCES" });
    expect((await readdir(paths.root)).includes("state.json")).toBe(true);
    // The clone is removed only after every other entry, so a retry without --discard can still inspect it.
    expect((await readdir(paths.root)).includes("clone")).toBe(true);
    expect(await readWriterState(home, "repo-w1")).toMatchObject({ alias: "repo" });
  } finally { failing.mockRestore(); syncBuiltinESMExports(); }
  await removeWriterTree(paths.root);
  await expect(lstat(paths.root)).rejects.toMatchObject({ code: "ENOENT" });
  // A missing root is a no-op.
  await removeWriterTree(paths.root);
});

it.runIf(unprivileged)("never follows a symlink to a directory outside the root", async () => {
  const home = await temporaryRoot("pi-writer-readonly-");
  const outside = await temporaryRoot("pi-writer-outside-");
  const target = join(outside, "target");
  await mkdir(join(target, "inner"), { recursive: true });
  await writeFile(join(target, "inner", "keep"), "keep");
  await chmod(join(target, "inner"), 0o555);
  await chmod(target, 0o555);
  const root = join(home, "root");
  await mkdir(root);
  await symlink(target, join(root, "link"));
  await symlink(join(target, "inner"), join(root, "go-link"));
  await readOnlyGoCache(root);
  await removeWriterTree(root);
  await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await stat(target)).mode & 0o777).toBe(0o555);
  expect((await stat(join(target, "inner"))).mode & 0o777).toBe(0o555);
  await expect(stat(join(target, "inner", "keep"))).resolves.toBeDefined();
  await chmod(target, 0o755);
  await chmod(join(target, "inner"), 0o755);
});

it("restores owner access on directories and leaves files alone", async () => {
  const root = join(await temporaryRoot("pi-writer-readonly-"), "tree");
  await mkdir(join(root, "a", "b"), { recursive: true });
  await writeFile(join(root, "a", "file"), "x");
  await chmod(join(root, "a", "file"), 0o444);
  await chmod(join(root, "a", "b"), 0o500);
  await chmod(join(root, "a"), 0o555);
  await makeTreeRemovable(root);
  expect((await stat(join(root, "a"))).mode & 0o777).toBe(0o755);
  expect((await stat(join(root, "a", "b"))).mode & 0o777).toBe(0o700);
  expect((await stat(join(root, "a", "file"))).mode & 0o777).toBe(0o444);
});

it("stops a walk that exceeds its entry limit", async () => {
  const root = join(await temporaryRoot("pi-writer-readonly-"), "tree");
  await mkdir(join(root, "a"), { recursive: true });
  await writeFile(join(root, "a", "one"), "1");
  await writeFile(join(root, "a", "two"), "2");
  await expect(makeTreeRemovable(root, 2)).rejects.toThrow("tree_walk_limit_exceeded");
  await expect(makeTreeRemovable(root, 4)).resolves.toBeUndefined();
});

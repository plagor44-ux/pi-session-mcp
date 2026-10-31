import { lstat, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { recoverWriter } from "../eval/recovery/recover.js";
import { collectWriter, finishWriter, recreateWriter, removeWriter, resetWriter } from "../src/writer-lifecycle.js";
import { acquireWriterLease } from "../src/writer-lease.js";
import { readWriterState, writeWriterState } from "../src/writer-state.js";
import { fixture, git, gitPresent, spawn } from "./real-git-writer-fixture.js";
import { removeTemporaryRoots } from "./temporary-roots.js";

vi.mock("../src/setup-writers-common.js", async (original) => ({ ...await original<typeof import("../src/setup-writers-common.js")>(), SETUP_LEASE_WAIT_MS: 50 }));

// The prototype takes the writer lease, which is Linux-only (src/writer-lease.ts).
const linuxIt = it.skipIf(process.platform !== "linux");
const fixtures: Array<Awaited<ReturnType<typeof fixture>>> = [];
afterEach(async () => { for (const f of fixtures.splice(0)) expect(await readdir(f.paths.bundles)).toEqual(["base.bundle"]); });
afterAll(removeTemporaryRoots);
const ref = (slot: number, part: string) => `refs/recovery/writer-repo-w1/${slot}/${part}`;
async function make() { const f = await fixture(); fixtures.push(f); return f; }
async function conflict(path = "base.txt", kind: "normal" | "deleted" | "symlink" = "normal") {
  const f = await make();
  if (path !== "base.txt" || kind === "symlink") {
    if (kind === "symlink") { await rm(join(f.paths.clone, path)); await symlink("base-target", join(f.paths.clone, path)); }
    else await writeFile(join(f.paths.clone, path), "base\n");
    await f.work("add", "--", path); await f.work("commit", "-m", "conflict base");
  }
  const change = async (value: string) => {
    if (kind === "symlink") { await rm(join(f.paths.clone, path)); await symlink(value, join(f.paths.clone, path)); await f.work("add", "--", path); await f.work("commit", "-m", value); }
    else await f.commit(value, path, `${value}\n`);
  };
  await f.work("checkout", "-b", "other");
  if (kind === "deleted") { await f.work("rm", "--", path); await f.work("commit", "-m", "deleted"); }
  else await change("SYNTHETIC_CONFLICT_OTHER_3107");
  await f.work("checkout", "main"); await change("SYNTHETIC_CONFLICT_MAIN_3107");
  expect((await spawn("git", ["-C", f.paths.clone, "merge", "other"])).exitCode).not.toBe(0);
  await writeFile(join(f.paths.clone, "notes.txt"), "notes\n"); return f;
}
async function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
  const entries: Array<{ path: string; type: string; mode: number; content: string }> = [];
  const walk = async (relative: string) => {
    const absolute = join(f.paths.clone, relative), stat = await lstat(absolute);
    const type = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
    const content = type === "symlink" ? await readlink(absolute) : type === "file" ? createHash("sha256").update(await readFile(absolute)).digest("hex") : "";
    entries.push({ path: relative, type, mode: stat.mode, content });
    if (type === "directory") for (const name of (await readdir(absolute)).sort()) await walk(join(relative, name));
  };
  await walk("");
  return { entries, state: await readFile(join(f.paths.root, "state.json")) };
}
function parseUnmerged(data: string) {
  expect(data.endsWith("\0")).toBe(true);
  return data.slice(0, -1).split("\0").map(record => {
    const tab = record.indexOf("\t");
    const [mode, oid, stage] = record.slice(0, tab).split(" ");
    return { mode, oid, stage: Number(stage), path: record.slice(tab + 1) };
  });
}
async function unmerged(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await spawn("git", ["-C", f.paths.clone, "ls-files", "-u", "-z"]);
  expect(result.exitCode).toBe(0);
  return parseUnmerged(result.stdout);
}
async function assertManifest(f: Awaited<ReturnType<typeof fixture>>, expected: ReturnType<typeof parseUnmerged>) {
  const result = await spawn("git", ["-C", f.checkout, "show", `${ref(1, "manifest")}:unmerged-index.txt`]);
  expect(result.exitCode).toBe(0);
  expect(parseUnmerged(result.stdout)).toEqual(expected);
  const stages = [...new Set(expected.map(e => `stage${e.stage}`))].sort();
  expect((await git(f.checkout, "for-each-ref", "--format=%(refname)", "refs/recovery/writer-repo-w1/1/")).split("\n")).toEqual(["manifest", ...stages, "worktree"].map(part => ref(1, part)));
  expect(await git(f.checkout, "show", `${ref(1, "manifest")}:head.txt`)).toBe(await f.work("rev-parse", "HEAD"));
  expect(await git(f.checkout, "show", `${ref(1, "manifest")}:merge-head.txt`)).toBe((await readFile(join(f.paths.clone, ".git/MERGE_HEAD"), "utf8")).trim());
}
linuxIt("recovers the worktree and all three index stages into a new slot", async () => {
  const f = await conflict(); const expected = await unmerged(f); expect(await recoverWriter(f.ctx, "repo-w1", { apply: true })).toMatchObject({ code: "writer_recovered", slot: 1 });
  for (const [stage, text] of [[1, "base"], [2, "SYNTHETIC_CONFLICT_MAIN_3107"], [3, "SYNTHETIC_CONFLICT_OTHER_3107"]] as const) expect(await git(f.checkout, "show", `${ref(1, `stage${stage}`)}:base.txt`)).toBe(text);
  const wt = await git(f.checkout, "show", `${ref(1, "worktree")}:base.txt`); expect(wt).toContain("<<<<<<<"); expect(wt).toContain("SYNTHETIC_CONFLICT_MAIN_3107"); expect(wt).toContain("SYNTHETIC_CONFLICT_OTHER_3107");
  expect(await git(f.checkout, "show", `${ref(1, "worktree")}:notes.txt`)).toBe("notes");
  await assertManifest(f, expected);
}, 60_000);
linuxIt("leaves the writer byte-identical", async () => { const f = await conflict(); const state = (await readWriterState(f.home, "repo-w1"))!; await writeWriterState(f.home, "repo-w1", { ...state, collected: { digest: `sha256:${"0".repeat(64)}`, at: new Date().toISOString() } }); const before = await snapshot(f); expect((await recoverWriter(f.ctx, "repo-w1", { apply: true })).code).toBe("writer_recovered"); expect(await snapshot(f)).toEqual(before); }, 60_000);
linuxIt("keeps collect, finish, remove, reset and recreate refused after recovery", async () => {
  const f = await conflict();
  expect((await recoverWriter(f.ctx, "repo-w1", { apply: true })).code).toBe("writer_recovered");
  const before = await snapshot(f);
  const outcomes = {
    collect: await collectWriter(f.ctx, "repo-w1"),
    finish: await finishWriter(f.ctx, "repo-w1"),
    remove: await removeWriter(f.ctx, "repo-w1", { discard: false }),
    reset: await resetWriter(f.ctx, "repo-w1", { discard: false }),
    recreate: await recreateWriter(f.ctx, "repo-w1", { discard: false }),
  };
  expect(Object.fromEntries(Object.entries(outcomes).map(([name, outcome]) => [name, { status: outcome.status, code: outcome.code }]))).toEqual({
    collect: { status: "failed", code: "writer_collect_failed" },
    finish: { status: "failed", code: "writer_collect_failed" },
    remove: { status: "failed", code: "writer_inspect_failed" },
    reset: { status: "failed", code: "writer_inspect_failed" },
    recreate: { status: "failed", code: "writer_inspect_failed" },
  });
  expect(await snapshot(f)).toEqual(before);
}, 60_000);
linuxIt("adds a second slot without touching the first", async () => { const f = await conflict(); expect((await recoverWriter(f.ctx, "repo-w1", { apply: true })).slot).toBe(1); const before = await git(f.checkout, "for-each-ref", "--format=%(refname) %(objectname)", "refs/recovery/writer-repo-w1/1/"); expect((await recoverWriter(f.ctx, "repo-w1", { apply: true })).slot).toBe(2); expect(await git(f.checkout, "for-each-ref", "--format=%(refname) %(objectname)", "refs/recovery/writer-repo-w1/1/")).toBe(before); }, 60_000);
linuxIt("plans without writing", async () => { const f = await conflict(); expect((await recoverWriter(f.ctx, "repo-w1", { apply: false })).code).toBe("writer_recover_planned"); expect(await git(f.checkout, "for-each-ref", "refs/recovery")).toBe(""); }, 60_000);
linuxIt("reports nothing_to_recover without an unmerged index", async () => { const f = await make(); expect((await recoverWriter(f.ctx, "repo-w1", { apply: true })).code).toBe("nothing_to_recover"); expect(await git(f.checkout, "for-each-ref", "refs/recovery")).toBe(""); }, 60_000);
linuxIt("records a deleted side", async () => {
  const f = await conflict("base.txt", "deleted"), expected = await unmerged(f);
  expect(expected.map(e => e.stage)).toEqual([1, 2]);
  expect((await recoverWriter(f.ctx, "repo-w1", { apply: true })).code).toBe("writer_recovered");
  await assertManifest(f, expected);
  expect(await gitPresent(f.checkout, "show-ref", "--verify", ref(1, "stage3"))).toBe(false);
  for (const stage of [1, 2]) expect(await gitPresent(f.checkout, "cat-file", "-e", `${ref(1, `stage${stage}`)}:base.txt`)).toBe(true);
}, 60_000);
linuxIt("handles conflicted names with spaces and newlines", async () => { const name = "a b\nc.txt"; const f = await conflict(name); const expected = await unmerged(f); expect((await recoverWriter(f.ctx, "repo-w1", { apply: true })).code).toBe("writer_recovered"); await assertManifest(f, expected); for (const s of [1, 2, 3]) expect(await gitPresent(f.checkout, "cat-file", "-e", `${ref(1, `stage${s}`)}:${name}`)).toBe(true); }, 60_000);
linuxIt("recovers a symlink conflict", async () => { const f = await conflict("base.txt", "symlink"); expect((await recoverWriter(f.ctx, "repo-w1", { apply: true })).code).toBe("writer_recovered"); for (const s of [1, 2, 3]) expect(await git(f.checkout, "ls-tree", ref(1, `stage${s}`), "base.txt")).toMatch(/^120000 /); }, 60_000);
linuxIt("recovers an add/add conflict without a stage1 ref", async () => {
  const f = await make();
  await f.work("checkout", "-b", "other");
  await f.commit("other addition", "added.txt", "other\n");
  await f.work("checkout", "main");
  await f.commit("main addition", "added.txt", "main\n");
  expect((await spawn("git", ["-C", f.paths.clone, "merge", "other"])).exitCode).not.toBe(0);
  const expected = await unmerged(f);
  expect(expected.map(e => e.stage)).toEqual([2, 3]);
  const before = await snapshot(f);
  expect((await recoverWriter(f.ctx, "repo-w1", { apply: true })).code).toBe("writer_recovered");
  await assertManifest(f, expected);
  expect(await gitPresent(f.checkout, "show-ref", "--verify", ref(1, "stage1"))).toBe(false);
  expect(await git(f.checkout, "show", `${ref(1, "stage2")}:added.txt`)).toBe("main");
  expect(await git(f.checkout, "show", `${ref(1, "stage3")}:added.txt`)).toBe("other");
  expect(await snapshot(f)).toEqual(before);
}, 60_000);
linuxIt("recovers two conflicted paths in every applicable stage tree", async () => {
  const f = await make();
  await f.commit("second base", "second.txt", "second base\n");
  await f.work("checkout", "-b", "other");
  for (const path of ["base.txt", "second.txt"]) await f.commit(`other ${path}`, path, `other ${path}\n`);
  await f.work("checkout", "main");
  for (const path of ["base.txt", "second.txt"]) await f.commit(`main ${path}`, path, `main ${path}\n`);
  expect((await spawn("git", ["-C", f.paths.clone, "merge", "other"])).exitCode).not.toBe(0);
  const expected = await unmerged(f);
  expect(expected).toHaveLength(6);
  expect((await recoverWriter(f.ctx, "repo-w1", { apply: true })).code).toBe("writer_recovered");
  await assertManifest(f, expected);
  for (const entry of expected) {
    expect(await git(f.checkout, "ls-tree", ref(1, `stage${entry.stage}`), "--", entry.path)).toBe(`${entry.mode} blob ${entry.oid}\t${entry.path}`);
  }
}, 60_000);
linuxIt("does not export staged-only content (known limit)", async () => {
  const f = await make();
  await f.commit("tracked base", "tracked.txt", "tracked base\n");
  await f.work("checkout", "-b", "other");
  await f.commit("other", "base.txt", "other\n");
  await f.work("checkout", "main");
  await f.commit("main", "base.txt", "main\n");
  expect((await spawn("git", ["-C", f.paths.clone, "merge", "other"])).exitCode).not.toBe(0);
  await writeFile(join(f.paths.clone, "tracked.txt"), "SYNTHETIC_STAGED_ONLY_213\n");
  await f.work("add", "tracked.txt");
  const staged = await f.work("rev-parse", ":0:tracked.txt");
  await writeFile(join(f.paths.clone, "tracked.txt"), "SYNTHETIC_WORKTREE_213\n");
  const expected = await unmerged(f), before = await snapshot(f);
  expect((await recoverWriter(f.ctx, "repo-w1", { apply: true })).code).toBe("writer_recovered");
  await assertManifest(f, expected);
  expect(await git(f.checkout, "show", `${ref(1, "worktree")}:tracked.txt`)).toBe("SYNTHETIC_WORKTREE_213");
  const refs = (await git(f.checkout, "for-each-ref", "--format=%(refname)", "refs/recovery/")).split("\n");
  expect((await git(f.checkout, "rev-list", "--objects", ...refs)).split("\n").map(line => line.split(" ")[0])).not.toContain(staged);
  expect(await snapshot(f)).toEqual(before);
}, 60_000);
linuxIt("rejects an alias mismatch without running commands or importing refs", async () => {
  const f = await conflict();
  const before = await snapshot(f), run = vi.fn(f.runner.run);
  expect(await recoverWriter({ ...f.ctx, alias: "different", runner: { run } }, "repo-w1", { apply: true })).toEqual({ code: "writer_recover_failed", status: "failed" });
  expect(run).not.toHaveBeenCalled();
  expect(await git(f.checkout, "for-each-ref", "refs/recovery")).toBe("");
  expect(await snapshot(f)).toEqual(before);
}, 60_000);
linuxIt("rejects missing state without running commands or importing refs", async () => {
  const f = await conflict();
  await rm(join(f.paths.root, "state.json"));
  const run = vi.fn(f.runner.run);
  expect((await recoverWriter({ ...f.ctx, runner: { run } }, "repo-w1", { apply: true })).code).toBe("writer_recover_failed");
  expect(run).not.toHaveBeenCalled();
  expect(await git(f.checkout, "for-each-ref", "refs/recovery")).toBe("");
}, 60_000);
linuxIt("uses the recorded image and imports the manifest last without forced refspecs", async () => {
  const f = await conflict(), state = (await readWriterState(f.home, "repo-w1"))!;
  await writeWriterState(f.home, "repo-w1", { ...state, imageId: "b".repeat(64) });
  const imported: string[] = [];
  const run = vi.fn(async (...args: Parameters<typeof f.runner.run>) => {
    if (args[0] === "podman") expect(args[1]).toContain("b".repeat(64));
    if (args[0] === "git" && args[1].includes("fetch")) {
      const refspec = args[1].at(-1)!;
      expect(refspec.startsWith("+")).toBe(false);
      imported.push(refspec.split(":")[1]!);
      expect(await gitPresent(f.checkout, "show-ref", "--verify", ref(1, "manifest"))).toBe(false);
    }
    return f.runner.run(...args);
  });
  expect((await recoverWriter({ ...f.ctx, runner: { run } }, "repo-w1", { apply: true })).code).toBe("writer_recovered");
  expect(imported.at(-1)).toBe(ref(1, "manifest"));
  expect(imported.slice(0, -1).sort()).toEqual(["stage1", "stage2", "stage3", "worktree"].map(part => ref(1, part)));
}, 60_000);
linuxIt("fails and rolls back rather than overwriting an existing destination", async () => {
  const f = await conflict(), before = await snapshot(f);
  const sentinel = await git(f.checkout, "rev-parse", "HEAD");
  const runner = { run: async (...args: Parameters<typeof f.runner.run>) => {
    const result = await f.runner.run(...args);
    if (args[0] === "git" && args[1].includes("for-each-ref") && args[1].at(-1) === "refs/recovery/writer-repo-w1/") {
      // Simulate a destination appearing after slot selection, before its import.
      await git(f.checkout, "update-ref", ref(1, "stage2"), sentinel);
    }
    return result;
  } };
  expect(await recoverWriter({ ...f.ctx, runner }, "repo-w1", { apply: true })).toEqual({ code: "writer_recover_incomplete", status: "failed", slot: 1 });
  expect(await git(f.checkout, "for-each-ref", "--format=%(refname) %(objectname)", "refs/recovery/")).toBe(`${ref(1, "stage2")} ${sentinel}`);
  expect(await gitPresent(f.checkout, "show-ref", "--verify", ref(1, "manifest"))).toBe(false);
  expect(await snapshot(f)).toEqual(before);
}, 60_000);
linuxIt("refuses a gitlink in conflict", async () => { const f = await conflict(); const sha = await f.work("rev-parse", "HEAD"); const result = await spawn("sh", ["-c", "printf '160000 %s 2\\tlink\\n' \"$2\" | git -C \"$1\" update-index --index-info", "sh", f.paths.clone, sha]); expect(result.exitCode).toBe(0); expect((await recoverWriter(f.ctx, "repo-w1", { apply: true })).code).toBe("writer_recover_unsupported"); expect(await git(f.checkout, "for-each-ref", "refs/recovery")).toBe(""); }, 60_000);
linuxIt("fails cleanly on a missing stage object", async () => { const f = await conflict(); const sha = await f.work("rev-parse", ":3:base.txt"); await rm(join(f.paths.clone, ".git/objects", sha.slice(0, 2), sha.slice(2))); const before = await snapshot(f); expect((await recoverWriter(f.ctx, "repo-w1", { apply: true })).code).toBe("writer_recover_failed"); expect(await snapshot(f)).toEqual(before); expect(await git(f.checkout, "for-each-ref", "refs/recovery")).toBe(""); }, 60_000);
linuxIt("refuses while the writer lease is held", async () => { const f = await conflict(); const lease = await acquireWriterLease(f.home, "repo-w1", { waitMs: 0 }); try { expect((await recoverWriter(f.ctx, "repo-w1", { apply: true })).code).toBe("writer_busy"); expect(await git(f.checkout, "for-each-ref", "refs/recovery")).toBe(""); } finally { await lease.release(); } }, 30_000);
linuxIt("leaves no bundle behind", async () => { const f = await conflict(); expect((await recoverWriter(f.ctx, "repo-w1", { apply: true })).code).toBe("writer_recovered"); expect(await readdir(f.paths.bundles)).toEqual(["base.bundle"]); }, 60_000);
linuxIt("rolls back a partial import", async () => { const f = await conflict(); const before = await snapshot(f); let n = 0; const runner = { run: (...args: Parameters<typeof f.runner.run>) => args[0] === "git" && args[1].includes("fetch") && ++n === 3 ? Promise.resolve({ exitCode: 1, stdout: "", stderr: "failed" }) : f.runner.run(...args) }; expect(await recoverWriter({ ...f.ctx, runner }, "repo-w1", { apply: true })).toEqual({ code: "writer_recover_incomplete", status: "failed", slot: 1 }); expect(await gitPresent(f.checkout, "show-ref", "--verify", ref(1, "manifest"))).toBe(false); expect(await git(f.checkout, "for-each-ref", "refs/recovery")).toBe(""); expect(await snapshot(f)).toEqual(before); }, 60_000);

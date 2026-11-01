import { chmod, lstat, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { recoverWriter, RECOVERY_SLOT_CAP } from "../src/writer-recover.js";
import { podmanInfo, resolveImage } from "../src/writer-boundary.js";
import { collectWriter, finishWriter, recreateWriter, removeWriter, resetWriter } from "../src/writer-lifecycle.js";
import { readWriterState, writeWriterState } from "../src/writer-state.js";
import { fixture, git, gitPresent, spawn } from "./real-git-writer-fixture.js";
import { removeTemporaryRoots } from "./temporary-roots.js";
import { recoveryProbeRunner, recoveryRefTransactionsSupported } from "./recovery-capability-fixture.js";

vi.mock("../src/setup-writers-common.js", async (original) => ({ ...await original<typeof import("../src/setup-writers-common.js")>(), SETUP_LEASE_WAIT_MS: 50 }));

// Writer boundary operations are supported on Linux.
const linuxIt = it.skipIf(process.platform !== "linux");
const importIt = it.skipIf(process.platform !== "linux" || !recoveryRefTransactionsSupported);
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
const boundaryRunner = recoveryProbeRunner;
let boundaryImage: string | undefined;
if (process.platform === "linux" && (await podmanInfo(boundaryRunner)).usable) {
  try { boundaryImage = await resolveImage(boundaryRunner, "node", false); } catch { /* Never pull an image in tests. */ }
}
it.skipIf(boundaryImage === undefined || !recoveryRefTransactionsSupported)("recovers across the real read-only, network-free Podman boundary", async () => {
  const f = await conflict();
  await writeWriterState(f.home, "repo-w1", { ...(await readWriterState(f.home, "repo-w1"))!, imageId: boundaryImage! });
  const before = await snapshot(f);
  expect(await recoverWriter({ ...f.ctx, runner: boundaryRunner }, "repo-w1")).toMatchObject({ code: "writer_recovered", slot: 1 });
  expect(await snapshot(f)).toEqual(before);
}, 120_000);
linuxIt("needs no Node executable in the writer image", async () => {
  const f = await conflict(), bin = join(f.home, "minimal-bin"); await mkdir(bin);
  for (const command of ["sh", "git"]) {
    const found = await spawn("sh", ["-c", `command -v ${command}`]);
    expect(found.exitCode).toBe(0); await symlink(found.stdout.trim(), join(bin, command));
  }
  let exported = false;
  const run = async (command: string, args: readonly string[], signal?: AbortSignal, options?: Parameters<typeof f.runner.run>[3]) => {
    if (command !== "podman") return f.runner.run(command, args, signal, options);
    const index = args.indexOf("-c"); const patched = [...args];
    patched[index + 1] = `PATH='${relative(f.paths.clone, bin)}'; export PATH\n${args[index + 1]}`;
    const result = await f.runner.run(command, patched, signal, options);
    exported = result.exitCode === 0 && result.stdout.trim() === "recovered";
    return result;
  };
  expect((await recoverWriter({ ...f.ctx, runner: { run } }, "repo-w1")).code).toBe(recoveryRefTransactionsSupported ? "writer_recovered" : "writer_recover_failed");
  expect(exported).toBe(true);
}, 60_000);
importIt.each(["dangling", "existing"])("refuses a raced %s symbolic destination without following it", async kind => {
  const f = await conflict();
  if (kind === "existing") await git(f.checkout, "update-ref", "refs/heads/outside", "HEAD");
  let fetched = false;
  const run = async (...args: Parameters<typeof f.runner.run>) => {
    const result = await f.runner.run(...args);
    if (args[0] === "git" && args[1].includes("fetch")) fetched = true;
    if (fetched && args[0] === "git" && args[1].includes("for-each-ref")) await git(f.checkout, "symbolic-ref", ref(1, "stage2"), "refs/heads/outside");
    return result;
  };
  const before = await git(f.checkout, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/");
  expect(await recoverWriter({ ...f.ctx, runner: { run } }, "repo-w1")).toMatchObject({ code: "writer_recover_conflict" });
  expect(await git(f.checkout, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/")).toBe(before);
  expect(await gitPresent(f.checkout, "show-ref", "--verify", ref(1, "stage1"))).toBe(false);
  expect(await git(f.checkout, "symbolic-ref", ref(1, "stage2"))).toBe("refs/heads/outside");
}, 60_000);
it.skipIf(process.platform !== "linux" || recoveryRefTransactionsSupported)("fails closed on the real host probe before fetching or writing operator refs", async () => {
  const f = await conflict(), before = await snapshot(f);
  const probeDirectories = new Set<string>();
  const run = vi.fn(async (...args: Parameters<typeof f.runner.run>) => {
    if (args[0] === "git") {
      const dir = args[1][args[1].indexOf("-C") + 1]!;
      if (dir !== f.checkout) probeDirectories.add(dir);
      if (dir === f.checkout) {
        expect(args[1]).not.toContain("fetch");
        expect(args[1]).not.toContain("writer-recovery");
      }
    }
    return f.runner.run(...args);
  });
  expect(await recoverWriter({ ...f.ctx, runner: { run } }, "repo-w1")).toEqual({ status: "failed", code: "writer_recover_failed" });
  expect(await git(f.checkout, "for-each-ref", "refs/recovery/")).toBe("");
  await expect(lstat(join(f.checkout, ".git/FETCH_HEAD"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await snapshot(f)).toEqual(before);
  expect(probeDirectories.size).toBe(1);
  for (const directory of probeDirectories) await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
}, 60_000);
importIt("retains parts after interruption and reports the incomplete slot on the next recovery", async () => {
  const f = await conflict(); let transactions = 0;
  const run = async (...args: Parameters<typeof f.runner.run>) => {
    if (args[0] === "git" && args[1].includes(f.checkout) && args[1].includes("writer-recovery") && ++transactions === 2) throw Error("killed");
    return f.runner.run(...args);
  };
  expect(await recoverWriter({ ...f.ctx, runner: { run } }, "repo-w1")).toEqual({ status: "failed", code: "writer_recover_incomplete", slot: 1 });
  expect(await gitPresent(f.checkout, "show-ref", "--verify", ref(1, "worktree"))).toBe(true);
  expect(await gitPresent(f.checkout, "show-ref", "--verify", ref(1, "manifest"))).toBe(false);
  const before = await git(f.checkout, "for-each-ref", "--format=%(refname) %(objectname)", "refs/recovery/writer-repo-w1/1/");
  expect(await recoverWriter(f.ctx, "repo-w1")).toEqual({ status: "ok", code: "writer_recovered", slot: 2, warnings: [{ status: "unchanged", code: "writer_recover_incomplete", slot: 1 }] });
  expect(await git(f.checkout, "for-each-ref", "--format=%(refname) %(objectname)", "refs/recovery/writer-repo-w1/1/")).toBe(before);
}, 60_000);
importIt("reports a part transaction commit failure as incomplete", async () => {
  const f = await conflict();
  const run = (...args: Parameters<typeof f.runner.run>) => args[0] === "git" && args[1].includes(f.checkout) && args[1].includes("writer-recovery")
    ? Promise.resolve({ exitCode: 1, stdout: "start: ok\nprepare: ok\n", stderr: "commit failed" }) : f.runner.run(...args);
  expect(await recoverWriter({ ...f.ctx, runner: { run } }, "repo-w1")).toMatchObject({ code: "writer_recover_incomplete", slot: 1 });
}, 60_000);
importIt("refuses a slot above the fixed cap", async () => {
  const f = await conflict();
  await git(f.checkout, "update-ref", ref(RECOVERY_SLOT_CAP, "manifest"), "HEAD");
  expect((await recoverWriter(f.ctx, "repo-w1")).code).toBe("writer_recover_failed");
  expect((await git(f.checkout, "for-each-ref", "--format=%(refname)", "refs/recovery/")).split("\n")).toEqual([ref(RECOVERY_SLOT_CAP, "manifest")]);
}, 60_000);
importIt("replaces a bundle left by a killed run", async () => {
  const f = await conflict(); await writeFile(join(f.paths.bundles, "recover.bundle"), "leftover");
  expect((await recoverWriter(f.ctx, "repo-w1")).code).toBe("writer_recovered");
}, 60_000);
importIt("reports a failed bundle removal alongside the main result", async () => {
  const f = await conflict();
  const run = async (...args: Parameters<typeof f.runner.run>) => {
    const r = await f.runner.run(...args);
    if (args[0] === "git" && args[1].includes("writer-recovery") && args[1].some(a => a.includes("/manifest "))) {
      await rm(join(f.paths.bundles, "recover.bundle"));
      await mkdir(join(f.paths.bundles, "recover.bundle"));
    }
    return r;
  };
  try {
    expect(await recoverWriter({ ...f.ctx, runner: { run } }, "repo-w1")).toMatchObject({ code: "writer_recovered", warnings: [{ status: "unchanged", code: "writer_recover_bundle_left" }] });
  } finally { await rm(join(f.paths.bundles, "recover.bundle"), { recursive: true, force: true }); }
}, 60_000);
linuxIt("refuses an untracked nested repository", async () => {
  const f = await conflict(), nested = join(f.paths.clone, "nested");
  await mkdir(nested); await git(nested, "init"); await writeFile(join(nested, "file"), "nested");
  await git(nested, "add", "."); await git(nested, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "nested");
  expect((await recoverWriter(f.ctx, "repo-w1")).code).toBe("writer_recover_unsupported");
  expect(await git(f.checkout, "for-each-ref", "refs/recovery/")).toBe("");
}, 60_000);
linuxIt.each(["filter.test.clean", "include.path", "includeIf.gitdir:foo.path"])("refuses clone configuration %s", async key => {
  const f = await conflict(); await f.work("config", key, "/does-not-exist");
  expect((await recoverWriter(f.ctx, "repo-w1")).code).toBe("writer_recover_failed");
  expect(await git(f.checkout, "for-each-ref", "refs/recovery/")).toBe("");
}, 60_000);
for (const kind of ["stage-mismatch", "parent-mismatch", "unknown", "duplicate", "missing"]) {
  const test = ["stage-mismatch", "parent-mismatch"].includes(kind) ? importIt : linuxIt;
  test(`refuses ${kind} bundle heads or manifest`, async () => {
    const f = await conflict();
    const run = async (...args: Parameters<typeof f.runner.run>) => {
      const r = await f.runner.run(...args);
      if (args[0] !== "git") return r;
      if (args[1].includes("list-heads")) {
        if (kind === "stage-mismatch") return { ...r, stdout: r.stdout.split("\n").filter(l => !l.includes("stage1")).join("\n") };
        if (kind === "unknown") return { ...r, stdout: r.stdout.replace("stage1", "unknown") };
        if (kind === "duplicate") return { ...r, stdout: r.stdout + r.stdout.split("\n")[0] + "\n" };
        if (kind === "missing") return { ...r, stdout: r.stdout.split("\n").filter(l => !l.includes("manifest")).join("\n") };
      }
      if (kind === "parent-mismatch" && args[1].some(a => a.endsWith(":head.txt"))) return { ...r, stdout: "a".repeat(40) + "\n" };
      return r;
    };
    expect((await recoverWriter({ ...f.ctx, runner: { run } }, "repo-w1")).code).toBe("writer_recover_failed");
    expect(await git(f.checkout, "for-each-ref", "refs/recovery/")).toBe("");
  }, 60_000);
}
importIt.each(['quote"tab\tback\\slash\n', 'é\n', 'trailing\n\n'])("preserves C-quoted path %j", async path => {
  const f = await conflict(path); const expected = await unmerged(f);
  expect((await recoverWriter(f.ctx, "repo-w1")).code).toBe("writer_recovered");
  await assertManifest(f, expected);
  for (const s of [1, 2, 3]) expect(await gitPresent(f.checkout, "cat-file", "-e", `${ref(1, `stage${s}`)}:${path}`)).toBe(true);
}, 60_000);
importIt("preserves executable modes and removes a path absent at an otherwise present stage", async () => {
  const f = await make();
  await f.commit("executable", "script", "base\n"); await chmod(join(f.paths.clone, "script"), 0o755); await f.work("update-index", "--chmod=+x", "script"); await f.work("commit", "-m", "mode");
  await f.work("checkout", "-b", "other"); await f.work("rm", "base.txt"); await f.commit("other", "script", "other\n");
  await f.work("checkout", "main"); await f.commit("main base", "base.txt", "main base\n"); await f.commit("main", "script", "main\n");
  expect((await spawn("git", ["-C", f.paths.clone, "merge", "other"])).exitCode).not.toBe(0);
  expect((await recoverWriter(f.ctx, "repo-w1")).code).toBe("writer_recovered");
  for (const stage of [1, 2, 3]) expect(await git(f.checkout, "ls-tree", ref(1, `stage${stage}`), "script")).toMatch(/^100755 /);
  expect(await gitPresent(f.checkout, "cat-file", "-e", `${ref(1, "stage3")}:base.txt`)).toBe(false);
}, 60_000);
linuxIt("refuses an invalid clone layout", async () => {
  const f = await conflict(); await writeFile(join(f.paths.clone, ".git/commondir"), ".");
  expect((await recoverWriter(f.ctx, "repo-w1")).code).toBe("writer_recover_failed");
  expect(await git(f.checkout, "for-each-ref", "refs/recovery/")).toBe("");
}, 60_000);
importIt("recovers the worktree and all three index stages into a new slot", async () => {
  const f = await conflict(); const expected = await unmerged(f); expect(await recoverWriter(f.ctx, "repo-w1")).toMatchObject({ code: "writer_recovered", slot: 1 });
  for (const [stage, text] of [[1, "base"], [2, "SYNTHETIC_CONFLICT_MAIN_3107"], [3, "SYNTHETIC_CONFLICT_OTHER_3107"]] as const) expect(await git(f.checkout, "show", `${ref(1, `stage${stage}`)}:base.txt`)).toBe(text);
  const wt = await git(f.checkout, "show", `${ref(1, "worktree")}:base.txt`); expect(wt).toContain("<<<<<<<"); expect(wt).toContain("SYNTHETIC_CONFLICT_MAIN_3107"); expect(wt).toContain("SYNTHETIC_CONFLICT_OTHER_3107");
  expect(await git(f.checkout, "show", `${ref(1, "worktree")}:notes.txt`)).toBe("notes");
  await assertManifest(f, expected);
}, 60_000);
importIt("leaves the writer byte-identical", async () => { const f = await conflict(); const state = (await readWriterState(f.home, "repo-w1"))!; await writeWriterState(f.home, "repo-w1", { ...state, collected: { digest: `sha256:${"0".repeat(64)}`, at: new Date().toISOString() } }); const before = await snapshot(f); expect((await recoverWriter(f.ctx, "repo-w1")).code).toBe("writer_recovered"); expect(await snapshot(f)).toEqual(before); }, 60_000);
importIt("keeps collect, finish, remove, reset and recreate refused after recovery", async () => {
  const f = await conflict();
  expect((await recoverWriter(f.ctx, "repo-w1")).code).toBe("writer_recovered");
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
importIt("adds a second slot without touching the first", async () => { const f = await conflict(); expect((await recoverWriter(f.ctx, "repo-w1")).slot).toBe(1); const before = await git(f.checkout, "for-each-ref", "--format=%(refname) %(objectname)", "refs/recovery/writer-repo-w1/1/"); expect((await recoverWriter(f.ctx, "repo-w1")).slot).toBe(2); expect(await git(f.checkout, "for-each-ref", "--format=%(refname) %(objectname)", "refs/recovery/writer-repo-w1/1/")).toBe(before); }, 60_000);
linuxIt("reports nothing_to_recover without an unmerged index", async () => { const f = await make(); expect((await recoverWriter(f.ctx, "repo-w1")).code).toBe("nothing_to_recover"); expect(await git(f.checkout, "for-each-ref", "refs/recovery")).toBe(""); }, 60_000);
importIt("records a deleted side", async () => {
  const f = await conflict("base.txt", "deleted"), expected = await unmerged(f);
  expect(expected.map(e => e.stage)).toEqual([1, 2]);
  expect((await recoverWriter(f.ctx, "repo-w1")).code).toBe("writer_recovered");
  await assertManifest(f, expected);
  expect(await gitPresent(f.checkout, "show-ref", "--verify", ref(1, "stage3"))).toBe(false);
  for (const stage of [1, 2]) expect(await gitPresent(f.checkout, "cat-file", "-e", `${ref(1, `stage${stage}`)}:base.txt`)).toBe(true);
}, 60_000);
importIt("handles conflicted names with spaces and newlines", async () => { const name = "a b\nc.txt"; const f = await conflict(name); const expected = await unmerged(f); expect((await recoverWriter(f.ctx, "repo-w1")).code).toBe("writer_recovered"); await assertManifest(f, expected); for (const s of [1, 2, 3]) expect(await gitPresent(f.checkout, "cat-file", "-e", `${ref(1, `stage${s}`)}:${name}`)).toBe(true); }, 60_000);
importIt("recovers a symlink conflict", async () => { const f = await conflict("base.txt", "symlink"); expect((await recoverWriter(f.ctx, "repo-w1")).code).toBe("writer_recovered"); for (const s of [1, 2, 3]) expect(await git(f.checkout, "ls-tree", ref(1, `stage${s}`), "base.txt")).toMatch(/^120000 /); }, 60_000);
importIt("recovers an add/add conflict without a stage1 ref", async () => {
  const f = await make();
  await f.work("checkout", "-b", "other");
  await f.commit("other addition", "added.txt", "other\n");
  await f.work("checkout", "main");
  await f.commit("main addition", "added.txt", "main\n");
  expect((await spawn("git", ["-C", f.paths.clone, "merge", "other"])).exitCode).not.toBe(0);
  const expected = await unmerged(f);
  expect(expected.map(e => e.stage)).toEqual([2, 3]);
  const before = await snapshot(f);
  expect((await recoverWriter(f.ctx, "repo-w1")).code).toBe("writer_recovered");
  await assertManifest(f, expected);
  expect(await gitPresent(f.checkout, "show-ref", "--verify", ref(1, "stage1"))).toBe(false);
  expect(await git(f.checkout, "show", `${ref(1, "stage2")}:added.txt`)).toBe("main");
  expect(await git(f.checkout, "show", `${ref(1, "stage3")}:added.txt`)).toBe("other");
  expect(await snapshot(f)).toEqual(before);
}, 60_000);
importIt("recovers two conflicted paths in every applicable stage tree", async () => {
  const f = await make();
  await f.commit("second base", "second.txt", "second base\n");
  await f.work("checkout", "-b", "other");
  for (const path of ["base.txt", "second.txt"]) await f.commit(`other ${path}`, path, `other ${path}\n`);
  await f.work("checkout", "main");
  for (const path of ["base.txt", "second.txt"]) await f.commit(`main ${path}`, path, `main ${path}\n`);
  expect((await spawn("git", ["-C", f.paths.clone, "merge", "other"])).exitCode).not.toBe(0);
  const expected = await unmerged(f);
  expect(expected).toHaveLength(6);
  expect((await recoverWriter(f.ctx, "repo-w1")).code).toBe("writer_recovered");
  await assertManifest(f, expected);
  for (const entry of expected) {
    expect(await git(f.checkout, "ls-tree", ref(1, `stage${entry.stage}`), "--", entry.path)).toBe(`${entry.mode} blob ${entry.oid}\t${entry.path}`);
  }
}, 60_000);
importIt("does not export staged-only content (known limit)", async () => {
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
  expect((await recoverWriter(f.ctx, "repo-w1")).code).toBe("writer_recovered");
  await assertManifest(f, expected);
  expect(await git(f.checkout, "show", `${ref(1, "worktree")}:tracked.txt`)).toBe("SYNTHETIC_WORKTREE_213");
  const refs = (await git(f.checkout, "for-each-ref", "--format=%(refname)", "refs/recovery/")).split("\n");
  expect((await git(f.checkout, "rev-list", "--objects", ...refs)).split("\n").map(line => line.split(" ")[0])).not.toContain(staged);
  expect(await snapshot(f)).toEqual(before);
}, 60_000);
linuxIt("rejects an alias mismatch without running commands or importing refs", async () => {
  const f = await conflict();
  const before = await snapshot(f), run = vi.fn(f.runner.run);
  expect(await recoverWriter({ ...f.ctx, alias: "different", runner: { run } }, "repo-w1")).toEqual({ code: "writer_recover_failed", status: "failed" });
  expect(run).not.toHaveBeenCalled();
  expect(await git(f.checkout, "for-each-ref", "refs/recovery")).toBe("");
  expect(await snapshot(f)).toEqual(before);
}, 60_000);
linuxIt("rejects missing state without running commands or importing refs", async () => {
  const f = await conflict();
  await rm(join(f.paths.root, "state.json"));
  const run = vi.fn(f.runner.run);
  expect((await recoverWriter({ ...f.ctx, runner: { run } }, "repo-w1")).code).toBe("writer_recover_failed");
  expect(run).not.toHaveBeenCalled();
  expect(await git(f.checkout, "for-each-ref", "refs/recovery")).toBe("");
}, 60_000);
importIt("uses the recorded image and fetches objects without destinations or FETCH_HEAD", async () => {
  const f = await conflict(), state = (await readWriterState(f.home, "repo-w1"))!;
  await writeWriterState(f.home, "repo-w1", { ...state, imageId: "b".repeat(64) });
  const run = vi.fn(async (...args: Parameters<typeof f.runner.run>) => {
    if (args[0] === "podman") {
      expect(args[1]).toContain("b".repeat(64));
      expect(args[1].join(" ")).not.toMatch(/\bnode\b/);
      expect(args[1]).toContain(`${f.paths.clone}:${f.paths.clone}:ro`);
      expect(args[1]).toContain("--network=none");
    }
    if (args[0] === "git" && args[1].includes("fetch")) {
      expect(args[1]).toContain("--no-write-fetch-head");
      expect(args[1]).toContain("--no-recurse-submodules");
      expect(args[1]).toContain("transfer.fsckObjects=true");
      expect(args[1].filter(a => a.startsWith("refs/"))).toEqual(expect.arrayContaining(["refs/heads/recovery/manifest", "refs/heads/recovery/worktree"]));
      expect(args[1].some(a => a.startsWith("refs/") && a.includes(":"))).toBe(false);
    }
    return f.runner.run(...args);
  });
  expect((await recoverWriter({ ...f.ctx, runner: { run } }, "repo-w1")).code).toBe("writer_recovered");
  await expect(lstat(join(f.checkout, ".git/FETCH_HEAD"))).rejects.toMatchObject({ code: "ENOENT" });
}, 60_000);
importIt("refuses a raced ancestor destination without overwriting it", async () => {
  const f = await conflict(), before = await snapshot(f);
  const sentinel = await git(f.checkout, "rev-parse", "HEAD");
  let fetched = false;
  const runner = { run: async (...args: Parameters<typeof f.runner.run>) => {
    const result = await f.runner.run(...args);
    if (args[0] === "git" && args[1].includes("fetch")) fetched = true;
    if (fetched && args[0] === "git" && args[1].includes("for-each-ref") && args[1].at(-1) === "refs/recovery/writer-repo-w1/") {
      // Simulate a destination appearing after slot selection, before its import.
      await git(f.checkout, "update-ref", ref(1, "stage2"), sentinel);
    }
    return result;
  } };
  expect(await recoverWriter({ ...f.ctx, runner }, "repo-w1")).toEqual({ code: "writer_recover_conflict", status: "failed", slot: 1 });
  expect(await git(f.checkout, "for-each-ref", "--format=%(refname) %(objectname)", "refs/recovery/")).toBe(`${ref(1, "stage2")} ${sentinel}`);
  expect(await gitPresent(f.checkout, "show-ref", "--verify", ref(1, "manifest"))).toBe(false);
  expect(await snapshot(f)).toEqual(before);
}, 60_000);
linuxIt("refuses a gitlink in conflict", async () => { const f = await conflict(); const sha = await f.work("rev-parse", "HEAD"); const result = await spawn("sh", ["-c", "printf '160000 %s 2\\tlink\\n' \"$2\" | git -C \"$1\" update-index --index-info", "sh", f.paths.clone, sha]); expect(result.exitCode).toBe(0); expect((await recoverWriter(f.ctx, "repo-w1")).code).toBe("writer_recover_unsupported"); expect(await git(f.checkout, "for-each-ref", "refs/recovery")).toBe(""); }, 60_000);
linuxIt("fails cleanly on a missing stage object", async () => { const f = await conflict(); const sha = await f.work("rev-parse", ":3:base.txt"); await rm(join(f.paths.clone, ".git/objects", sha.slice(0, 2), sha.slice(2))); const before = await snapshot(f); expect((await recoverWriter(f.ctx, "repo-w1")).code).toBe("writer_recover_failed"); expect(await snapshot(f)).toEqual(before); expect(await git(f.checkout, "for-each-ref", "refs/recovery")).toBe(""); }, 60_000);
importIt("leaves no bundle behind", async () => { const f = await conflict(); expect((await recoverWriter(f.ctx, "repo-w1")).code).toBe("writer_recovered"); expect(await readdir(f.paths.bundles)).toEqual(["base.bundle"]); }, 60_000);
importIt("imports no refs on fsck rejection", async () => { const f = await conflict(); const before = await snapshot(f); let n = 0; const runner = { run: (...args: Parameters<typeof f.runner.run>) => args[0] === "git" && args[1].includes("fetch") && ++n === 1 ? Promise.resolve({ exitCode: 1, stdout: "", stderr: "failed" }) : f.runner.run(...args) }; expect(await recoverWriter({ ...f.ctx, runner }, "repo-w1")).toEqual({ code: "writer_recover_failed", status: "failed" }); expect(await gitPresent(f.checkout, "show-ref", "--verify", ref(1, "manifest"))).toBe(false); expect(await git(f.checkout, "for-each-ref", "refs/recovery")).toBe(""); expect(await snapshot(f)).toEqual(before); }, 60_000);

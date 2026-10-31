import { readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { recoverWriter } from "../eval/recovery/recover.js";
import { collectWriter, finishWriter, removeWriter } from "../src/writer-lifecycle.js";
import { acquireWriterLease } from "../src/writer-lease.js";
import { readWriterState, writeWriterState } from "../src/writer-state.js";
import { fixture, git, gitPresent, spawn } from "./real-git-writer-fixture.js";
import { removeTemporaryRoots } from "./temporary-roots.js";

vi.mock("../src/setup-writers-common.js", async (original) => ({ ...await original<typeof import("../src/setup-writers-common.js")>(), SETUP_LEASE_WAIT_MS: 50 }));

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
  return [await f.work("ls-files", "-u", "-z"), await f.work("for-each-ref", "--format=%(refname) %(objectname)"), await readFile(join(f.paths.clone, ".git/index")), await readFile(join(f.paths.clone, "base.txt")), await readFile(join(f.paths.root, "state.json"))];
}
it("recovers the worktree and all three index stages into a new slot", async () => {
  const f = await conflict(); expect(await recoverWriter(f.ctx, "repo-w1", { apply: true })).toMatchObject({ code: "writer_recovered", slot: 1 });
  for (const [stage, text] of [[1, "base"], [2, "SYNTHETIC_CONFLICT_MAIN_3107"], [3, "SYNTHETIC_CONFLICT_OTHER_3107"]] as const) expect(await git(f.checkout, "show", `${ref(1, `stage${stage}`)}:base.txt`)).toBe(text);
  const wt = await git(f.checkout, "show", `${ref(1, "worktree")}:base.txt`); expect(wt).toContain("<<<<<<<"); expect(wt).toContain("SYNTHETIC_CONFLICT_MAIN_3107"); expect(wt).toContain("SYNTHETIC_CONFLICT_OTHER_3107");
  expect(await git(f.checkout, "show", `${ref(1, "worktree")}:notes.txt`)).toBe("notes");
  expect((await git(f.checkout, "show", `${ref(1, "manifest")}:unmerged-index.txt`)).split("\n")).toHaveLength(3);
}, 60_000);
it("leaves the writer byte-identical", async () => { const f = await conflict(); const state = (await readWriterState(f.home, "repo-w1"))!; await writeWriterState(f.home, "repo-w1", { ...state, collected: { digest: `sha256:${"0".repeat(64)}`, at: new Date().toISOString() } }); const before = await snapshot(f); expect((await recoverWriter(f.ctx, "repo-w1", { apply: true })).code).toBe("writer_recovered"); expect(await snapshot(f)).toEqual(before); }, 60_000);
it("keeps collect, finish and remove refused after recovery", async () => { const f = await conflict(); expect((await recoverWriter(f.ctx, "repo-w1", { apply: true })).code).toBe("writer_recovered"); expect((await collectWriter(f.ctx, "repo-w1")).status).toBe("failed"); expect((await finishWriter(f.ctx, "repo-w1")).status).toBe("failed"); expect((await removeWriter(f.ctx, "repo-w1", { discard: false })).status).toBe("failed"); }, 60_000);
it("adds a second slot without touching the first", async () => { const f = await conflict(); expect((await recoverWriter(f.ctx, "repo-w1", { apply: true })).slot).toBe(1); const before = await git(f.checkout, "for-each-ref", "--format=%(refname) %(objectname)", "refs/recovery/writer-repo-w1/1/"); expect((await recoverWriter(f.ctx, "repo-w1", { apply: true })).slot).toBe(2); expect(await git(f.checkout, "for-each-ref", "--format=%(refname) %(objectname)", "refs/recovery/writer-repo-w1/1/")).toBe(before); }, 60_000);
it("plans without writing", async () => { const f = await conflict(); expect((await recoverWriter(f.ctx, "repo-w1", { apply: false })).code).toBe("writer_recover_planned"); expect(await git(f.checkout, "for-each-ref", "refs/recovery")).toBe(""); }, 60_000);
it("reports nothing_to_recover without an unmerged index", async () => { const f = await make(); expect((await recoverWriter(f.ctx, "repo-w1", { apply: true })).code).toBe("nothing_to_recover"); expect(await git(f.checkout, "for-each-ref", "refs/recovery")).toBe(""); }, 60_000);
it("records a deleted side", async () => { const f = await conflict("base.txt", "deleted"); expect((await recoverWriter(f.ctx, "repo-w1", { apply: true })).code).toBe("writer_recovered"); expect(await gitPresent(f.checkout, "cat-file", "-e", `${ref(1, "stage3")}:base.txt`)).toBe(false); expect((await git(f.checkout, "show", `${ref(1, "manifest")}:unmerged-index.txt`)).split("\n")).toHaveLength(2); }, 60_000);
it("handles conflicted names with spaces and newlines", async () => { const name = "a b\nc.txt"; const f = await conflict(name); expect((await recoverWriter(f.ctx, "repo-w1", { apply: true })).code).toBe("writer_recovered"); for (const s of [1, 2, 3]) expect(await gitPresent(f.checkout, "cat-file", "-e", `${ref(1, `stage${s}`)}:${name}`)).toBe(true); }, 60_000);
it("recovers a symlink conflict", async () => { const f = await conflict("base.txt", "symlink"); expect((await recoverWriter(f.ctx, "repo-w1", { apply: true })).code).toBe("writer_recovered"); for (const s of [1, 2, 3]) expect(await git(f.checkout, "ls-tree", ref(1, `stage${s}`), "base.txt")).toMatch(/^120000 /); }, 60_000);
it("refuses a gitlink in conflict", async () => { const f = await conflict(); const sha = await f.work("rev-parse", "HEAD"); const result = await spawn("sh", ["-c", "printf '160000 %s 2\\tlink\\n' \"$2\" | git -C \"$1\" update-index --index-info", "sh", f.paths.clone, sha]); expect(result.exitCode).toBe(0); expect((await recoverWriter(f.ctx, "repo-w1", { apply: true })).code).toBe("writer_recover_unsupported"); expect(await git(f.checkout, "for-each-ref", "refs/recovery")).toBe(""); }, 60_000);
it("fails cleanly on a missing stage object", async () => { const f = await conflict(); const sha = await f.work("rev-parse", ":3:base.txt"); await rm(join(f.paths.clone, ".git/objects", sha.slice(0, 2), sha.slice(2))); const before = await snapshot(f); expect((await recoverWriter(f.ctx, "repo-w1", { apply: true })).code).toBe("writer_recover_failed"); expect(await snapshot(f)).toEqual(before); expect(await git(f.checkout, "for-each-ref", "refs/recovery")).toBe(""); }, 60_000);
it("refuses while the writer lease is held", async () => { const f = await conflict(); const lease = await acquireWriterLease(f.home, "repo-w1", { waitMs: 0 }); try { expect((await recoverWriter(f.ctx, "repo-w1", { apply: true })).code).toBe("writer_busy"); expect(await git(f.checkout, "for-each-ref", "refs/recovery")).toBe(""); } finally { await lease.release(); } }, 30_000);
it("leaves no bundle behind", async () => { const f = await conflict(); expect((await recoverWriter(f.ctx, "repo-w1", { apply: true })).code).toBe("writer_recovered"); expect(await readdir(f.paths.bundles)).toEqual(["base.bundle"]); }, 60_000);
it("rolls back a partial import", async () => { const f = await conflict(); const before = await snapshot(f); let n = 0; const runner = { run: (...args: Parameters<typeof f.runner.run>) => args[0] === "git" && args[1].includes("fetch") && ++n === 3 ? Promise.resolve({ exitCode: 1, stdout: "", stderr: "failed" }) : f.runner.run(...args) }; expect((await recoverWriter({ ...f.ctx, runner }, "repo-w1", { apply: true })).code).toBe("writer_recover_incomplete"); expect(await git(f.checkout, "for-each-ref", "refs/recovery")).toBe(""); expect(await snapshot(f)).toEqual(before); }, 60_000);

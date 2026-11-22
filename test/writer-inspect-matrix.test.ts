import { appendFile, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { inspectWork, inspectWriter, removeWriter, type InspectCounts } from "../src/writer-lifecycle.js";
import { removeTemporaryRoots } from "./temporary-roots.js";
import { fixture, git, gitPresent } from "./real-git-writer-fixture.js";

afterAll(removeTemporaryRoots);

/*
 * The counters of `--inspect` against real Git, one row per state a clone can be in. Each row asserts the verdict and the
 * counters, and ties the verdict to the safety predicate itself: `inspectWork` must agree with it, and a non-discard
 * `removeWriter` (the operation that predicate guards) must refuse with the matching code, or, for a clean or collected
 * clone, remove the writer.
 *
 * Counter rules: `commits` are commits on any local branch or on HEAD that the recorded base lacks; `changes` are the paths
 * that differ in the index (against HEAD) or in the worktree (against the index), each once, renames as two paths, with
 * index flags (assume-unchanged, skip-worktree) cleared and a skip-worktree path that is absent on purpose left out;
 * `untracked` and `ignored` count files, `stashes` entries, `unexportedRefs` refs outside branches and stash that name objects
 * only the clone has, `nestedRepositories` the `.git` entries below the top level.
 */

type Fixture = Awaited<ReturnType<typeof fixture>>;
const ZERO: InspectCounts = { commits: 0, branches: 0, stashes: 0, unexportedRefs: 0, changes: 0, untracked: 0, ignored: 0, nestedRepositories: 0 };
const UNCOLLECTED = "writer_uncollected";
const file = (f: Fixture, name: string) => join(f.paths.clone, name);
const exclude = (f: Fixture, pattern: string) => appendFile(join(f.paths.clone, ".git/info/exclude"), pattern + "\n");

interface Row { name: string; setup: (f: Fixture) => Promise<void>; code: string; counts?: Partial<InspectCounts>; removal?: string }
const rows: Row[] = [
  { name: "a pristine clone", setup: async () => {}, code: "writer_clean" },

  // The index against HEAD.
  { name: "a staged new file", setup: async (f) => { await writeFile(file(f, "new.txt"), "n\n"); await f.work("add", "new.txt"); }, code: UNCOLLECTED, counts: { changes: 1 } },
  { name: "a staged modification", setup: async (f) => { await writeFile(file(f, "base.txt"), "m\n"); await f.work("add", "base.txt"); }, code: UNCOLLECTED, counts: { changes: 1 } },
  { name: "a staged deletion", setup: async (f) => { await f.work("rm", "base.txt"); }, code: UNCOLLECTED, counts: { changes: 1 } },
  { name: "a staged rename (two paths)", setup: async (f) => { await f.work("mv", "base.txt", "renamed.txt"); }, code: UNCOLLECTED, counts: { changes: 2 } },
  { name: "a staged mode change", setup: async (f) => { await chmod(file(f, "base.txt"), 0o755); await f.work("add", "base.txt"); }, code: UNCOLLECTED, counts: { changes: 1 } },
  { name: "an intent-to-add file", setup: async (f) => { await writeFile(file(f, "new.txt"), "n\n"); await f.work("add", "-N", "new.txt"); }, code: UNCOLLECTED, counts: { changes: 1 } },

  // The worktree against the index.
  { name: "a worktree modification", setup: async (f) => { await writeFile(file(f, "base.txt"), "m\n"); }, code: UNCOLLECTED, counts: { changes: 1 } },
  { name: "a worktree deletion", setup: async (f) => { await rm(file(f, "base.txt")); }, code: UNCOLLECTED, counts: { changes: 1 } },
  { name: "a worktree mode change", setup: async (f) => { await chmod(file(f, "base.txt"), 0o755); }, code: UNCOLLECTED, counts: { changes: 1 } },

  // Both, on one path or on several.
  { name: "a staged new file deleted from the worktree", setup: async (f) => { await writeFile(file(f, "new.txt"), "n\n"); await f.work("add", "new.txt"); await rm(file(f, "new.txt")); }, code: UNCOLLECTED, counts: { changes: 1 } },
  { name: "a staged modification restored in the worktree", setup: async (f) => { await writeFile(file(f, "base.txt"), "m\n"); await f.work("add", "base.txt"); await writeFile(file(f, "base.txt"), "base\n"); }, code: UNCOLLECTED, counts: { changes: 1 } },
  { name: "a staged modification modified again", setup: async (f) => { await writeFile(file(f, "base.txt"), "m\n"); await f.work("add", "base.txt"); await writeFile(file(f, "base.txt"), "m2\n"); }, code: UNCOLLECTED, counts: { changes: 1 } },
  { name: "a staged modification deleted from the worktree", setup: async (f) => { await writeFile(file(f, "base.txt"), "m\n"); await f.work("add", "base.txt"); await rm(file(f, "base.txt")); }, code: UNCOLLECTED, counts: { changes: 1 } },
  { name: "a staged addition next to a worktree modification (two paths)", setup: async (f) => { await writeFile(file(f, "new.txt"), "n\n"); await f.work("add", "new.txt"); await writeFile(file(f, "base.txt"), "m\n"); }, code: UNCOLLECTED, counts: { changes: 2 } },

  // Index flags that hide a path from plain Git.
  { name: "assume-unchanged, present and untouched", setup: async (f) => { await f.work("update-index", "--assume-unchanged", "base.txt"); }, code: "writer_clean" },
  { name: "assume-unchanged, modified", setup: async (f) => { await f.work("update-index", "--assume-unchanged", "base.txt"); await writeFile(file(f, "base.txt"), "m\n"); }, code: UNCOLLECTED, counts: { changes: 1 } },
  { name: "assume-unchanged, deleted", setup: async (f) => { await f.work("update-index", "--assume-unchanged", "base.txt"); await rm(file(f, "base.txt")); }, code: UNCOLLECTED, counts: { changes: 1 } },
  { name: "skip-worktree, present and untouched", setup: async (f) => { await f.work("update-index", "--skip-worktree", "base.txt"); }, code: "writer_clean" },
  { name: "skip-worktree, modified", setup: async (f) => { await f.work("update-index", "--skip-worktree", "base.txt"); await writeFile(file(f, "base.txt"), "m\n"); }, code: UNCOLLECTED, counts: { changes: 1 } },
  { name: "skip-worktree, absent on purpose", setup: async (f) => { await f.work("update-index", "--skip-worktree", "base.txt"); await rm(file(f, "base.txt")); }, code: "writer_clean" },
  // `git sparse-checkout` itself rewrites the clone's configuration, which the layout check refuses before any counting.
  { name: "a sparse checkout configured in the clone", setup: async (f) => { await f.work("sparse-checkout", "set", "--no-cone", "/nothing-here"); }, code: "clone_verification_failed", removal: "clone_verification_failed" },
  { name: "skip-worktree absent next to a staged addition", setup: async (f) => { await f.work("update-index", "--skip-worktree", "base.txt"); await rm(file(f, "base.txt")); await writeFile(file(f, "new.txt"), "n\n"); await f.work("add", "new.txt"); }, code: UNCOLLECTED, counts: { changes: 1 } },

  // Files that are not tracked.
  { name: "an untracked file", setup: async (f) => { await writeFile(file(f, "u.txt"), "u\n"); }, code: UNCOLLECTED, counts: { untracked: 1 } },
  { name: "an ignored file", setup: async (f) => { await exclude(f, "ignored-*"); await writeFile(file(f, "ignored-a.txt"), "i\n"); }, code: "writer_clean", counts: { ignored: 1 } },
  { name: "an ignored directory with files", setup: async (f) => { await exclude(f, "cache/"); await mkdir(file(f, "cache/sub"), { recursive: true }); await writeFile(file(f, "cache/a"), "1\n"); await writeFile(file(f, "cache/sub/b"), "2\n"); }, code: "writer_clean", counts: { ignored: 2 } },

  // Repositories below the top level.
  { name: "a nested repository under an ignored path", setup: async (f) => { await exclude(f, "vendor/"); await mkdir(file(f, "vendor/lib"), { recursive: true }); await git(file(f, "vendor/lib"), "init", "-b", "main"); }, code: "writer_nested_repository", counts: { nestedRepositories: 1, ignored: 1 } },
  { name: "a populated nested repository that is not ignored", setup: async (f) => {
    await mkdir(file(f, "lib"));
    await git(file(f, "lib"), "init", "-b", "main"); await writeFile(file(f, "lib/a.txt"), "a\n");
    await git(file(f, "lib"), "add", "a.txt"); await git(file(f, "lib"), "-c", "user.name=n", "-c", "user.email=n@example.invalid", "commit", "-m", "nested");
  }, code: UNCOLLECTED, counts: { nestedRepositories: 1, untracked: 1 } },

  // Commits and refs.
  { name: "commits on a branch that was not pushed to the base", setup: async (f) => { await f.work("checkout", "-b", "feature"); await f.commit("one", "one.txt", "1\n"); await f.commit("two", "two.txt", "2\n"); }, code: UNCOLLECTED, counts: { commits: 2, branches: 1 } },
  { name: "commits on the base branch itself", setup: async (f) => { await f.commit("one", "one.txt", "1\n"); }, code: UNCOLLECTED, counts: { commits: 1 } },
  { name: "an empty second branch at the base commit", setup: async (f) => { await f.work("branch", "empty"); }, code: UNCOLLECTED, counts: { branches: 1 } },
  { name: "commits on a detached HEAD", setup: async (f) => { await f.work("checkout", "--detach", "main"); await f.commit("one", "one.txt", "1\n"); await f.commit("two", "two.txt", "2\n"); }, code: UNCOLLECTED, counts: { commits: 2 } },
  { name: "a detached HEAD at the base commit", setup: async (f) => { await f.work("checkout", "--detach", "main"); }, code: "writer_clean" },
  { name: "a tag on a commit that only the clone has", setup: async (f) => { await f.work("checkout", "--detach", "main"); await f.commit("one", "one.txt", "1\n"); await f.work("tag", "only-here"); await f.work("checkout", "main"); }, code: UNCOLLECTED, counts: { unexportedRefs: 1 } },
  { name: "a stash entry", setup: async (f) => { await writeFile(file(f, "base.txt"), "m\n"); await f.work("stash", "push"); }, code: UNCOLLECTED, counts: { stashes: 1 } },
  { name: "two stash entries", setup: async (f) => { await writeFile(file(f, "base.txt"), "m\n"); await f.work("stash", "push"); await writeFile(file(f, "base.txt"), "m2\n"); await f.work("stash", "push"); }, code: UNCOLLECTED, counts: { stashes: 2 } },

  // An unmerged index cannot be inspected at all.
  { name: "an unmerged index after a conflicting merge", setup: async (f) => {
    await f.work("checkout", "-b", "left"); await f.commit("left", "base.txt", "left\n");
    await f.work("checkout", "main"); await f.work("checkout", "-b", "right"); await f.commit("right", "base.txt", "right\n");
    expect(await gitPresent(f.paths.clone, "merge", "left")).toBe(false);
  }, code: "writer_inspect_failed", removal: "writer_inspect_failed" },
];

/** The predicate that `removeWriter` applies without `--discard`, read off the existing inspection. */
const predicate = (work: Awaited<ReturnType<typeof inspectWork>>, collected: boolean): string =>
  work.nested || (!work.baseline && !collected) ? UNCOLLECTED : work.repositories ? "writer_nested_repository" : work.baseline ? "writer_clean" : "writer_collected";
const FAILS_BEFORE_COUNTING = ["writer_inspect_failed", "clone_verification_failed"];

describe("--inspect counters and verdict across clone states", () => {
  it.each(rows)("$name", async (row) => {
    const f = await fixture();
    await row.setup(f);
    const outcome = await inspectWriter(f.ctx, "repo-w1");
    expect(outcome.code).toBe(row.code);
    if (FAILS_BEFORE_COUNTING.includes(row.code)) expect(outcome).toEqual({ status: "failed", code: row.code });
    else {
      expect(outcome.status).toBe(row.code === "writer_clean" ? "ok" : "failed");
      expect(outcome.counts).toEqual({ ...ZERO, ...row.counts });
      // The verdict is the safety predicate's, evaluated on the existing inspection of the same clone.
      expect(predicate(await inspectWork(f.ctx, "repo-w1"), false)).toBe(row.code);
    }
    // And the operation that predicate guards agrees: a non-discard remove refuses with the verdict's code, or removes a clean clone.
    const expectedRemoval = row.removal ?? (outcome.status === "ok" ? "writer_removed" : row.code);
    expect((await removeWriter(f.ctx, "repo-w1", { discard: false })).code).toBe(expectedRemoval);
  }, 60_000);
});

# ADR 0016: Recovery export for a writer with an unmerged index

**Status:** Accepted (2026-10-31, maintainer decision), after two
independent reviews and two revisions. Issue
[#213](https://github.com/plagor44-ux/pi-session-mcp/issues/213).

- Planning basis: branch `feat/s17-design-evaluations` on main `41ae199`,
  published 0.14.3.
- This ADR changes no production contract by itself. The accepted decision
  is implemented under its issue; the contract changes only with that
  implementation.

## Context

A container writer whose clone has an unmerged index cannot be collected.
This happens when a worker started a merge, rebase or cherry-pick and stopped
inside the conflict. Every cleanup that would discard work also refuses it.
That fail-closed behavior is intended and stays.

What is missing is a way to get the conflicted work out of the clone for
review, with two constraints:

- no host Git in the clone;
- no weakening of the refusal.

Facts that shape the design:

- **The refusal is implicit.** `git write-tree` fails under `set -eu` in the
  inspect and collect scripts (`src/writer-lifecycle.ts:323`, `:426`). It
  surfaces as `writer_inspect_failed` or `writer_collect_failed`; there is no
  dedicated code.
  - Reset, recreate and remove inspect first and refuse with
    `writer_inspect_failed`.
  - Finish collects first, without inspecting (`src/writer-lifecycle.ts:571`),
    and refuses with `writer_collect_failed`.
  - Only `--discard` gets past the refusal, and it destroys the work.
- **Collect clears the digest.** When it starts, `collectWriter` writes the
  state back without an earlier `collected` digest
  (`src/writer-lifecycle.ts:396`). A recovery built on collect would
  therefore invalidate an older digest. Recovery must be a separate operation
  that never reads or writes `state.collected`.
- **Shared operation path.** Every writer operation with `--apply` runs
  through `runWriterOperation` (`src/setup-writers.ts:101-124`), which does
  four things in order:
  1. takes the setup lock;
  2. takes the writer lease;
  3. fences: `ensureWriterAbsent` stops and removes a container that outlived
     its launcher (`src/writer-fence.ts:15`);
  4. runs the Doctor gate (`src/setup-writers.ts:111`).

  The lifecycle function then checks the writer state and its alias
  (`requiredState`). A blocking Doctor finding therefore answers
  `doctor_failed` before a missing state is noticed. A dry run only resolves the workspace alias (`src/setup-writers.ts:101`).
- **Containers and bundles.**
  - Git on the clone runs in a throwaway, network-free container, with
    scratch space on `/tmp` (`throwawayArgs`, `src/writer-boundary.ts`).
  - Inspect and collect mount the clone read-only. Create and reset mount it
    read-write (`src/writer-lifecycle.ts:174`, `:553`).
  - Bundles go to `writers/<name>/bundles/`. Doctor reports any file there
    other than `base.bundle` as `writer_uncollected_bundle`
    (`src/doctor.ts:521`).

## Options

### A. Keep `--discard` as the only exit (status quo)

The operator inspects the clone by hand or loses the work. The boundary
forbids host Git in the clone, so "by hand" means a hand-built container.

Rejected: the issue exists because this is error-prone.

### B. Make collect tolerate an unmerged index

Collect could export the conflicted state as an ordinary collected ref.
Rejected, for two reasons:

- Collect writes the digest that admits a later finish, reset or remove. A
  collected conflict would therefore legitimize discarding it.
- The ref namespace `refs/remotes/writer-<name>/…` would mix work ready for
  review with a conflict snapshot.

### C. Separate recovery export (recommended)

A new, explicit operation that does three things:

- builds a read-only snapshot of the conflicted state inside the boundary;
- imports it under its own ref namespace;
- leaves the clone, its index, refs and worktree, and the writer state
  unchanged.

## Decision

Option C.

### 1. Operation

- `pi-session-mcp-setup --writer <name> --recover` is a dry run by default
  and runs with `--apply`.
- The dry run resolves the workspace alias, as the other writer dry runs do,
  and reports `writer_recover_planned`. It checks no writer state.
- With `--apply`, it runs through `runWriterOperation` like collect:
  - setup lock;
  - writer lease;
  - fence: a container that outlived its launcher is stopped and removed
    first. This is the only change recovery can cause on the writer side,
    and collect causes the same.
  - Doctor gate;
  - required state, with `state.alias` equal to the configured alias. This
    is checked after the Doctor gate, as for collect.
- The throwaway container uses `state.imageId` and mounts the clone
  read-only.
- Recovery never reads or writes `state.collected`. It never changes the
  clone, its index, refs or worktree, and never changes `state.json`.

### 2. Container script contract

The script runs inside the throwaway container. The clone is read-only,
objects and indexes go only to `/tmp`, and output goes only to the bundles
mount. Like the inspect and collect scripts, it needs only `sh` and `git`
from the image. The prototype's `node` script is a shortcut that the
implementation must not keep, because it would add a requirement to every
writer image.

1. Copy the clone's index to `/tmp` and read `ls-files -u -z`. Empty output
   means `nothing_to_recover`.
2. Refuse a gitlink (mode `160000`) at any stage with
   `writer_recover_unsupported`. Check that every stage blob exists.
3. Build one tree per stage that has entries (1, 2, 3). Each tree is `HEAD`'s
   tree with each conflicted path set to its blob at that stage, or removed
   where that stage has no entry (a deleted side, or an add/add without a
   base).
   - Paths go through `update-index -z --index-info`, with removal records
     first.
   - Names with spaces and newlines, symlinks and executable bits survive.
4. Build the worktree commit from `read-tree HEAD` plus `add -A` on a scratch
   index. It holds conflict markers and untracked, non-ignored files.
   - `add -A` turns an untracked nested repository into a gitlink and drops
     its content.
   - So the script lists the resulting tree recursively. Any mode-`160000`
     entry refuses the whole recovery with `writer_recover_unsupported`.
5. Build a manifest commit. Its tree holds:
   - `unmerged-index.txt`: the raw `ls-files -u -z` output;
   - `head.txt`;
   - `merge-head.txt`, when present.
6. Write one bundle, `bundles/recover.bundle`, with heads
   `refs/heads/recovery/{stage1,stage2,stage3,worktree,manifest}`. Stage
   heads appear only where the stage has entries.

A stage tree is "HEAD with the conflicted paths at that stage". It is not a
full side of the merge: cleanly merged paths from the other side are not in
it.

### 3. Host import

The import is create-only, never follows a symbolic ref, and marks a
complete slot by its manifest ref. Three constraints shape it:

- **Fetch is not create-only.** Git 2.56 fast-forwards an existing
  destination ref to a descendant, and recovery commits descend from `HEAD`.
  So no fetch is allowed to write refs.
- **Symbolic refs.** Without `--no-deref`, `update-ref` follows a symbolic
  ref: Git 2.56.0 created a ref outside the recovery namespace through a
  dangling symbolic ref at the destination.
- **Not crash-atomic.** A ref transaction is not atomic across a crash in
  the files backend. Loose refs are published one by one during `commit`,
  and concurrent readers can see a subset.

1. **Verify.** Run `bundle verify` and list the bundle's heads. Reject:
   - unknown or duplicate heads;
   - a missing worktree or manifest head.
2. **Fetch objects only.** Fetch every head by its bundle head name, with no
   destination, using `--no-write-fetch-head`, `--no-recurse-submodules` and
   `transfer.fsckObjects=true`. This adds objects to the operator checkout
   and writes no ref, not even `FETCH_HEAD` (checked with Git 2.56.0). An fsck or fetch failure ends the recovery with
   `writer_recover_failed`, and nothing is imported.
3. **Cross-check.** Read the manifest blob by object id from the fetched
   manifest commit. Check that the present stage heads match the stages in
   `unmerged-index.txt`, and that `head.txt` names the parent of every
   recovery commit. Any mismatch ends the recovery with
   `writer_recover_failed`, and nothing is imported.
4. **Pick the slot.** It is one more than the highest numeric slot under
   `refs/recovery/writer-<name>/`. A slot above a fixed cap (for example
   10,000) is refused rather than wrapped.
5. **Create the part refs.** One `update-ref --no-deref --stdin`
   transaction: `start`, one
   `create refs/recovery/writer-<name>/<slot>/<part> <oid>` per stage and
   worktree part, then `prepare` and `commit`.
   - `create` refuses an existing destination, including a symbolic ref,
     dangling or not. With Git 2.56.0 and `--no-deref`, both cases failed at
     `prepare`.
   - A collision found at `prepare` creates no ref of the transaction. With
     Git 2.56.0, a transaction whose second `create` collided left its first
     ref uncreated.
   - A collision ends the recovery with `writer_recover_conflict`, and
     nothing is imported.
   - Any failure during `commit` ends it with `writer_recover_incomplete`,
     naming the slot.
6. **Create the manifest ref** in a second transaction of the same form.
   Only a slot with a manifest ref is complete; it is created after every
   part ref exists. A failure here also ends with `writer_recover_incomplete`.

   Objects fetched for a failed recovery stay unreferenced until Git's
   normal pruning removes them.
7. **Remove the bundle** on every path.
   - If the removal fails, the result says so with
     `writer_recover_bundle_left` alongside the main code, and Doctor
     reports the file as `writer_uncollected_bundle`.
   - The next recovery replaces it.

**Incomplete slots.** There is no rollback. A slot without a manifest ref
is incomplete, whatever part refs it holds. It arises from a failure during
`commit`, or from a process killed between or during the two transactions.

- The next recovery counts it when it picks the next slot, so it is never
  reused.
- The next recovery also reports it, with `writer_recover_incomplete` and
  the slot, alongside its own result.
- The operator deletes it; recovery never deletes refs.
- An incomplete slot is never reported as success.

### 4. Codes

Codes specific to recovery:

| Code | Status | Meaning |
| --- | --- | --- |
| `writer_recover_planned` | planned | Dry run; the alias resolved and nothing else ran. |
| `writer_recovered` | ok | Slot created; the result names the slot. |
| `nothing_to_recover` | unchanged | The index has no unmerged entries. |
| `writer_recover_unsupported` | failed | A gitlink is in conflict or in the worktree export; nothing imported. |
| `writer_recover_conflict` | failed | A destination ref already exists, including a symbolic ref; nothing imported. |
| `writer_recover_incomplete` | failed, or a warning alongside a later result | The slot has part refs but no manifest ref; the result names the slot. |
| `writer_recover_failed` | failed | Any other failure: missing state, alias mismatch, invalid clone layout, missing object, container failure, invalid bundle, fsck rejection, manifest mismatch, slot above the cap. Nothing imported. |
| `writer_recover_bundle_left` | warning, alongside the main code | The bundle file could not be removed. |

Codes inherited unchanged from `runWriterOperation`:

| Code | When |
| --- | --- |
| `usage_invalid` | Invalid writer name. |
| `platform_unsupported` | Not Linux. |
| `alias_unknown` | The workspace alias is not configured. |
| `writer_busy` | The writer lease is held. |
| `writer_lease_unavailable` | The lease could not be taken for another reason. |
| `writer_fenced` | The fence could not remove a leftover container. |
| `doctor_failed` | The Doctor gate found a blocking error; its findings follow. |
| setup-lock codes | The setup lock could not be taken. |
| `writer_operation_failed` | Any error without its own code. |

### 5. Preserved and unsupported content

Preserved:

- conflict markers and untracked, non-ignored worktree files;
- index stages 1, 2 and 3 of the conflicted paths;
- `HEAD`, `MERGE_HEAD` and the raw unmerged index entries, in the manifest;
- `HEAD` history, as parents.

Not exported, and named in the operator docs:

- staged-only (stage-0) content that differs from the worktree;
- other local branches, tags, notes and any other refs;
- the stash;
- ignored files;
- reflogs and unreachable objects;
- rebase or cherry-pick sequencer state.

Gitlinks, conflicted or created by `add -A`, are refused. The operator docs
must say plainly that `--discard` after a recovery destroys everything in
the "not exported" list.

### 6. Resolution path

Collect, finish, reset, recreate and remove stay refused, before and after a
recovery, unchanged. The operator then:

1. resolves the conflict in their own checkout from the recovery refs;
2. decides whether anything outside the preserved set of section 5 matters;
3. only then runs `--reset --discard --apply` (or recreate) on the writer.

Recovery refs are the operator's to delete.

### 7. Shared boundary hardening

The review of the prototype found two exposures that recovery shares with
collect and inspect. This ADR does not introduce them, and they are tracked
separately.

- **Unquoted glob.** `BOUNDARY_GIT` passes `-c safe.directory=*` unquoted
  into `sh` scripts that run with the clone as working directory
  (`src/writer-boundary.ts:13`). A worker-created file whose name matches the
  glob changes the argument. The observed effect is fail-closed (Git refuses
  or fails), not command injection. It should still be quoted.
- **Clone configuration.** `add -A` honors the clone's attributes,
  `info/exclude` and any `filter.*` driver in `.git/config`. `.git/config` is
  read-only to the worker container, but `verifyCloneLayout` does not inspect
  its contents. A recovery implementation should set
  `core.attributesFile=/dev/null` and refuse a clone whose config defines
  `filter.*` or `include*`.

## Evidence

A development-only prototype (`eval/recovery/recover.ts`) runs the container
script through the real-Git harness of
`test/writer-collect-real-git.test.ts`, extracted to
`test/real-git-writer-fixture.ts`. It imports into a real operator checkout
(`test/writer-recover-real-git.test.ts`). Run records, the test list and the
reviews are in
[the evaluation record](../evaluation/writer-recovery-2026-10-31/README.md).

The prototype shows three things:

- the stage trees, worktree and manifest can be built from a copy of the
  index without changing the clone;
- collect, finish, remove, reset and recreate stay refused afterwards;
- in the tested, non-concurrent cases, a failed import of the prototype's
  own import path leaves no ref. The decided import of section 3 rests on
  the Git 2.56.0 checks cited there instead.

It does not exercise the real container boundary: the harness runs the
script on the host, without the read-only mount. Nor does it exercise the
setup lock, the fence or the Doctor gate.

The prototype differs from this decision in three ways:

- It imports with per-ref fetches after a pre-check and rolls back on
  failure. The decision replaces that with the ref transactions in section 3,
  because a non-forced fetch fast-forwards an existing ancestor ref and the
  pre-check races with the fetch. Its import also follows symbolic refs and
  has no completion marker.
- It does not cross-check the manifest.
- Its container script uses `node`.

## Contract change and versioning

The change adds a setup operation and new result codes. It changes no MCP
tool, server or configuration.

ADR 0003 defines the versioned contract as the MCP contract. By its wording,
this change would be a patch release. In practice, setup operations have
shipped as minor releases: 0.14.0 for the setup operations of ADR 0014, and
ADR 0015 for its setup change. This ADR recommends a minor release, following
that precedent. The maintainer decides; ADR 0003 could also be amended to
name the setup CLI as part of the contract.

Doctor needs no new check: the existing `writer_uncollected_bundle` covers a
leftover `recover.bundle`.

Files to change on implementation:

- `src/setup-writers.ts` and its CLI parsing;
- `src/writer-lifecycle.ts`, or a new `src/writer-recover.ts`;
- `docs/execution-modes.md` and the setup reference;
- the writer section of the controller skill;
- the changelog.

Test matrix for the implementation:

- the prototype cases;
- a Podman boundary case, when the pinned image is present;
- an image with only `sh` and `git`;
- a fence case with a leftover container;
- an alias mismatch;
- a Doctor-gate refusal;
- the dry-run output;
- a destination that already exists and is an ancestor of the new commit
  (must give `writer_recover_conflict`, with the ref unchanged);
- a destination that is a symbolic ref, dangling or not (must give
  `writer_recover_conflict`, and create no ref anywhere);
- a process killed between the part and manifest transactions (the next
  recovery reports the incomplete slot and uses the next one);
- Doctor-gate precedence over a missing state;
- a collision created after the slot was picked;
- an fsck rejection;
- a bundle whose heads disagree with its manifest;
- an untracked nested repository in the worktree;
- a slot above the cap;
- a bundle left by a killed run;
- a failed bundle removal.

## Consequences

- An operator can review a conflicted writer's work without host Git in the
  clone and without discarding it first.
- The refusal of collect and cleanup is unchanged. Recovery adds an exit for
  inspection, not for cleanup.
- Recovery refs accumulate in the operator checkout until the operator
  deletes them.
- The stage trees are partial by design. Reviewers must read the manifest to
  know which paths conflicted.

## Open questions

- Should recovery also export stage-0 content and other local branches? That
  would close most of the gap in section 5, at the cost of a larger script.
- Should a dedicated refusal code for "unmerged index" in collect and inspect
  come with this change, instead of the generic `writer_collect_failed`?
  It would tell the operator that recovery applies.

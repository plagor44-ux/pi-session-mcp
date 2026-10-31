# ADR 0016: Recovery export for a writer with an unmerged index

**Status:** Proposed (2026-10-31). Issue
[#213](https://github.com/plagor44-ux/pi-session-mcp/issues/213). Planning
basis: branch `feat/s17-design-evaluations` on main `41ae199`, published
0.14.3. This ADR changes no production contract by itself; implementation
follows only if the maintainer accepts it.

## Context

A container writer whose clone has an unmerged index (a worker started a
merge, rebase or cherry-pick and stopped inside the conflict) cannot be
collected, and every cleanup that would discard work refuses it. That
fail-closed behavior is intended and stays. What is missing is a way to get
the conflicted work out of the clone for review without running host Git in
the clone and without weakening the refusal.

Facts that shape the design:

- The refusal is implicit: `git write-tree` fails under `set -eu` in the
  inspect and collect scripts (`src/writer-lifecycle.ts:323`, `:426`), which
  surfaces as `writer_inspect_failed` or `writer_collect_failed`. There is no
  dedicated code. Finish, reset, recreate and remove all inspect first and
  therefore refuse too; only `--discard` gets past it, and it destroys the
  work.
- `collectWriter` drops an earlier `collected` digest when it starts
  (`src/writer-lifecycle.ts:394`). A recovery built on collect would therefore
  invalidate an older digest. Recovery must be a separate operation that never
  reads or writes `state.collected`.
- Every writer operation runs through `runWriterOperation`
  (`src/setup-writers.ts:101-124`): setup lock, writer lease, fence
  (`ensureWriterAbsent` stops and removes a container that outlived its
  launcher, `src/writer-fence.ts:15`), state and alias check, Doctor gate.
- All Git on the clone runs in a throwaway, network-free container with the
  clone mounted read-only and scratch on `/tmp` (`throwawayArgs`,
  `src/writer-boundary.ts`). Bundles go to `writers/<name>/bundles/`, which
  Doctor reports as `writer_uncollected_bundle` if anything is left there
  (`src/doctor.ts:525`).

## Options

### A. Keep `--discard` as the only exit (status quo)

The operator inspects the clone by hand or loses the work. Host Git in the
clone is forbidden by the boundary, so "by hand" means a hand-built
container. Rejected: the issue exists because this is error-prone.

### B. Make collect tolerate an unmerged index

Collect could export the conflicted state as an ordinary collected ref.
Rejected: collect writes the digest that admits a later finish, reset or
remove, so a collected conflict would legitimize discarding it, and the ref
namespace `refs/remotes/writer-<name>/…` would mix reviewed-ready work with a
conflict snapshot.

### C. Separate recovery export (recommended)

A new explicit operation that builds a read-only snapshot of the conflicted
state inside the boundary, imports it under its own ref namespace, and
changes nothing in the writer.

## Decision (proposed)

Option C.

### 1. Operation

- `pi-session-mcp-setup --writer <name> --recover`, dry-run by default,
  `--apply` to run. Dry-run validates the workspace alias and writer like the
  other operations and reports `writer_recover_planned`.
- It runs through `runWriterOperation` like collect: setup lock, writer
  lease, fence (a container that outlived its launcher is stopped and removed
  first; a held lease answers `writer_busy`), required state with
  `state.alias` equal to the configured alias, Doctor gate. The throwaway
  container uses `state.imageId`.
- It never reads or writes `state.collected`, never changes the clone, its
  index, refs or worktree, and never changes `state.json`.

### 2. Container script contract

Inside the throwaway container (clone read-only, objects and indexes only in
`/tmp`, output only to the bundles mount):

1. Copy the clone's index to `/tmp`; read `ls-files -u -z`. Empty means
   `nothing_to_recover`.
2. Refuse a gitlink (mode `160000`) at any stage with
   `writer_recover_unsupported`; check that every stage blob exists.
3. Build one tree per present stage (1, 2, 3): `HEAD`'s tree with each
   conflicted path replaced by its blob at that stage, or removed where that
   stage has no entry (a deleted side, an add/add without a base). Paths go
   through `update-index -z --index-info`, removal records first, so names
   with spaces, newlines, symlinks and executable bits survive.
4. Build the worktree commit from `read-tree HEAD` plus `add -A` on a scratch
   index: conflict markers and untracked, non-ignored files.
5. Build a manifest commit whose tree holds `unmerged-index.txt` (the raw
   `ls-files -u -z` output), `head.txt` and, when present, `merge-head.txt`.
6. Write one bundle with heads `refs/heads/recovery/{stage1,stage2,stage3,
   worktree,manifest}` (stage heads only where the stage has entries) to
   `bundles/recover.bundle`.

A stage tree is "HEAD with the conflicted paths at that stage", not a full
side of the merge: cleanly merged paths from the other side are not in it.
The manifest says which stages exist; a missing stage ref means that stage
had no entries, and the host cross-checks the bundle heads against the
manifest before importing.

### 3. Host import

- Verify the bundle and list its heads; reject unknown or duplicate heads, a
  missing worktree or manifest head, and heads that disagree with the
  manifest.
- Slot: one more than the highest numeric slot under
  `refs/recovery/writer-<name>/`; slot numbers above a fixed cap (for example
  10,000) are refused instead of wrapping.
- Fetch each head into `refs/recovery/writer-<name>/<slot>/<part>` without
  `+` (an existing ref fails the import), with `--no-recurse-submodules` and
  `transfer.fsckObjects=true`, stage and worktree refs first and the manifest
  last. A complete manifest ref marks a complete slot.
- On any import failure delete the refs imported so far with
  `update-ref -d <ref> <oid>` and report `writer_recover_incomplete` with the
  slot. The bundle file is removed on every path; a leftover after a crash is
  reported by Doctor as `writer_uncollected_bundle`, and the next recovery
  replaces it.

### 4. Codes

| Code | Status | Meaning |
| --- | --- | --- |
| `writer_recover_planned` | planned | Dry-run; nothing ran. |
| `writer_recovered` | ok | Slot imported; the result names the slot. |
| `nothing_to_recover` | unchanged | The index has no unmerged entries. |
| `writer_recover_unsupported` | failed | A gitlink is in conflict; nothing imported. |
| `writer_recover_incomplete` | failed | Import failed partway; imported refs rolled back; the result names the slot. |
| `writer_recover_failed` | failed | Any other failure: missing object, invalid layout, container failure, state or alias mismatch. |
| `writer_busy` | failed | The writer lease is held. |

### 5. Preserved and unsupported content

Preserved: conflict markers and untracked, non-ignored worktree files; index
stages 1, 2 and 3 of the conflicted paths; `HEAD`, `MERGE_HEAD` and the raw
unmerged index entries in the manifest; `HEAD` history as parents.

Not exported, named in the operator docs: staged-only (stage-0) content that
differs from the worktree, other local branches, the stash, ignored files,
reflogs, unreachable objects, rebase or cherry-pick sequencer state, and
gitlinks (refused). The operator docs must say plainly that `--discard`
after a recovery destroys everything in this list.

### 6. Resolution path

Collect, finish, reset, recreate and remove stay refused before and after a
recovery, unchanged. The operator resolves the conflict in their own checkout
from the recovery refs, decides whether anything outside section 5's
preserved set matters, and only then runs `--reset --discard --apply` (or
recreate) on the writer. Recovery refs are the operator's to delete.

### 7. Shared boundary hardening

The review of the prototype found two exposures that recovery shares with
collect and inspect; they are not introduced by this ADR and are tracked
separately:

- `BOUNDARY_GIT` passes `-c safe.directory=*` unquoted into `sh` scripts that
  run with the clone as working directory, so a worker-created file whose name
  matches the glob changes the argument (`src/writer-boundary.ts:13`). The
  observed effect is fail-closed (Git refuses or fails), not command
  injection; it should still be quoted.
- `add -A` honors the clone's attributes, `info/exclude` and any `filter.*`
  driver in `.git/config`. `.git/config` is read-only to the worker container,
  but `verifyCloneLayout` does not inspect its contents. A recovery
  implementation should set `core.attributesFile=/dev/null` and refuse a
  clone whose config defines `filter.*` or `include*`.

## Evidence

A development-only prototype (`eval/recovery/recover.ts`) runs the container
script through the real-Git harness of
`test/writer-collect-real-git.test.ts` (extracted to
`test/real-git-writer-fixture.ts`) and imports into a real operator checkout
(`test/writer-recover-real-git.test.ts`). Run records, the test list and the
review are in
[the evaluation record](../evaluation/writer-recovery-2026-10-31/README.md).

The prototype shows that the stage trees, worktree and manifest can be built
from a copy of the index without changing the clone, that collect, finish and
remove stay refused afterwards, and that a partial import rolls back. It does
not exercise the real container boundary (the harness runs the script on the
host without the read-only mount), the setup lock, the fence, or the Doctor
gate.

## Contract change and versioning

A new setup operation and new result codes; no MCP tool, server or
configuration change. Under ADR 0003 this needs a minor release. Doctor needs
no new check; the existing `writer_uncollected_bundle` covers a leftover
`recover.bundle`. Files to change on implementation: `src/setup-writers.ts`
and its CLI parsing, `src/writer-lifecycle.ts` (or a new
`src/writer-recover.ts`), `docs/execution-modes.md`, the setup reference, the
controller skill's writer section, and the changelog.

Test matrix for the implementation: the prototype cases, plus a Podman
boundary case when the pinned image is present, a fence case with a leftover
container, an alias mismatch, a slot collision, a slot above the cap, and a
bundle left by a killed run.

## Consequences

- An operator can review a conflicted writer's work without host Git in the
  clone and without discarding it first.
- The refusal of collect and cleanup is unchanged; recovery adds an exit for
  inspection, not for cleanup.
- Recovery refs accumulate in the operator checkout until the operator deletes
  them.
- The stage trees are partial by design; reviewers must read the manifest to
  know which paths conflicted.

## Open questions

- Whether recovery should also export stage-0 content and other local
  branches, which would close most of section 5's gap at the cost of a larger
  script.
- Whether a dedicated refusal code for "unmerged index" in collect and inspect
  (instead of the generic `writer_collect_failed`) should come with this
  change, so the operator learns that recovery applies.

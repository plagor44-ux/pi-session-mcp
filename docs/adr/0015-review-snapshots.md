# ADR 0015: Immutable read-only review snapshots

**Status:** Proposed (2026-10-31). Issue #209. Planning basis: main
`2a483c7d19cda65c32de5df781819eb5333b9694`, published 0.14.3. This ADR records
a design for the maintainer's decision; it changes no production contract and
authorizes no implementation.

## Context

The review stage of the controller skill asks for a read-only reviewer of
another model family "on the collected commit". The product cannot bind a
reviewer to that commit today:

- `pi_session_start` accepts `base` only for coding profiles on `container`
  workspaces; any other start with `base` fails with `base_not_applicable`
  before a session exists (`src/server.ts`, ADR 0012 section 4).
- Every read-only session runs in-process on the host. `RoutingPiSessionAdapter`
  sends only coding starts on `container` workspaces to the writer relay
  (`src/writer-relay.ts`); a read-only start on any workspace, a container
  workspace included, gets the alias's configured directory as `cwd`. For a
  container workspace that directory is the operator checkout, so the reviewer
  reads whatever the operator has checked out at that moment, including
  uncommitted edits, and that view can change during the review.
- Read-only confinement (ADR 0013) bounds which paths the read tools reach. It
  says nothing about which commit those paths hold.
- Sprint 13 therefore used a Claude Code reviewer, because the Pi read-only
  workspace was on `main`, not on the branch under review. Controllers work
  around the gap by putting the diff into the prompt. That makes the review
  independent of the workspace, but it also hides the surrounding code from
  the reviewer, and nothing binds the diff to an object ID either.

A review of another tree cannot establish acceptance of the submitted change.
What is missing is (1) a reviewer view of exactly one commit, (2) a binding to
exact base and head object IDs that the controller can check, and (3) a view
that stays unchanged for the whole review.

## Options

### A. Manually prepared read-only alias

The operator configures a `read-only` workspace alias for a fixed directory
and, per review, makes that directory a detached linked worktree of the head
commit (`git worktree add --detach <dir> <head>`, later `git worktree remove`).
The configuration stays static, so no server restart is needed between
reviews.

- For: works with today's code. No contract change. Confinement and the
  sandboxed shell already handle linked worktrees (ADR 0013, `resolveWorktreeGitDir`).
- Against: the binding is invisible to the controller. Nothing stops the
  operator, another controller or a writer collection from changing the
  directory during a review. Nothing verifies that the directory is clean and at
  the intended head before a session starts. The procedure is easy to get
  wrong, and the mistake is silent: a review of the wrong tree looks exactly
  like a review of the right one.

### B. Server-managed snapshot per session

`pi_session_start` gains a review input (head and base object IDs). The server
creates a private snapshot for the session and removes it at close.

- For: one call for the controller; the snapshot's lifetime equals the
  session's.
- Against: the MCP server would run host Git and write into the operator
  repository (`.git/worktrees/`) on every review start. That is a new
  server-side mutation of operator state, which today only setup performs
  (with dry-run, fences and explicit `--apply`). A server crash or a lost
  client leaves snapshots behind, and in-memory state cannot clean them up
  after a restart; recovery would need durable bookkeeping, which ADR 0003
  keeps out of the server. Rejected.

### C. Setup-managed snapshot slots with a shared lease (recommended)

Setup materializes a snapshot of one commit into a derived, per-alias slot.
Read-only sessions on a snapshot alias hold a shared lease on that slot, and
setup needs the exclusive lease to change it.

- For: the server stays in-memory and never mutates operator Git state. The
  binding is checked before every session start and every prompt, and the
  controller sees it in the start result. Several reviews of the same commit
  can share one slot. Retargeting cannot happen during a review. A crash
  releases the lease (kernel `flock`) and leaves only state that setup already
  knows how to inspect.
- Against: a new execution mode, setup commands, a session-view field and
  Doctor checks: a minor release. A controller has to run one setup command per
  review target.

### D. Exported tree without Git metadata (variant of C)

Same lifecycle as C, but the slot holds a `git archive` export instead of a
linked worktree.

- For: the snapshot shares no object store or refs with the operator checkout;
  the sandboxed shell would not overlay the operator's common Git directory.
- Against: reviewers lose `git log`, `git diff` and `git blame`, which is the
  reason `review-sandboxed` exists. Head-change and modification detection would
  need a stored tree manifest instead of `git status`. Kept as a fallback
  materialization if the shared object store turns out to be a problem, not as
  the default.

## Proposed decision

Adopt option C, materialized as a detached linked worktree, after the
maintainer accepts this ADR. Until then, option A plus a diff in the prompt
remains the interim procedure, and a controller records the head object ID it
intended to review.

### 1. Snapshot workspaces

- A new execution mode `snapshot` in `execution-modes.json`, with a required
  `source`: the alias of a `host` or `container` workspace whose operator
  checkout supplies the objects.
- The snapshot directory is derived, never configured:
  `~/.local/state/pi-session-mcp/snapshots/<alias>/tree`, with the slot state
  next to it in `state.json` (`0700` directories, `0600` files, written with
  the existing temporary-file, sync and rename pattern, read with `O_NOFOLLOW`).
  Setup and the server derive the same path. Doctor reports a snapshot alias
  whose configured workspace path is not the derived one.
- Only read-only profiles may start on a snapshot alias. A coding profile fails
  with the existing `workspace_mode_forbids_coding`. A read-only profile with
  `grantedExtensionTools` or external MCP tool grants fails with a new
  `snapshot_profile_unsupported`, because those tools run unconfined in the
  server process and could write (ADR 0010). The sandboxed shell is allowed:
  its overlays discard writes to the snapshot and to the common Git directory.

### 2. Setup lifecycle

- `pi-session-mcp-setup --snapshot <alias> --head <oid> --base <oid>` plans;
  `--apply` performs it. Object IDs are full 40- or 64-hex IDs, never ref
  names, so a moving branch cannot change the target. Before anything is
  created, the source checkout must have `<head>^{commit}` and
  `<base>^{commit}` (`snapshot_object_missing`), and the head tree must
  contain no gitlink (`snapshot_submodule_present`; submodules are
  unsupported, since `git worktree add` leaves them empty).
- Apply takes the slot's exclusive lease without waiting. A slot held by any
  session fails with `snapshot_busy`. If an older snapshot exists, it is removed
  only if it verifies clean (section 3), with `git worktree remove` without
  `--force`. A modified slot fails with `snapshot_modified` and stays as it is.
  `--snapshot <alias> --discard --apply` is the only way to drop a modified
  slot, and it reports what it dropped as counts, never as content.
- Order: remove the old state, materialize with
  `git worktree add --detach <tree> <head>` in the source checkout, verify,
  then write the new state (`{ v, source, base, head, tree, at }`) last. A crash
  in between leaves a slot without valid state; such a slot is unusable
  (`snapshot_unavailable`) and Doctor reports it (`snapshot_incomplete`). The
  next apply first prunes its own registration (`git worktree prune` for the
  derived path only) before it materializes again.
- `--snapshot <alias> --remove --apply` removes a clean slot the same way.
  Setup never runs Git in a writer clone and never deletes anything outside the
  derived slot. The source checkout's branches, index and working files are
  never touched, and `git worktree remove` without `--force` refuses a
  modified snapshot.
- Git runs with the hardening setup already applies to boundary Git
  (`core.hooksPath=/dev/null`, `core.fsmonitor=false`,
  `core.useReplaceRefs=false`, `--end-of-options`). Whether host Git must come
  from a trusted fixed path, like `flock` and `bwrap`, is an implementation
  decision for the follow-up; today `src/` resolves `git` from `PATH`.

### 3. Verification

A slot verifies when `rev-parse HEAD` equals the recorded head, the recorded
base object still exists, the recorded tree equals `<head>^{tree}`,
`git status --porcelain=v1 --untracked-files=all` is empty, and no gitlink is
present. Setup checks this before it removes or replaces a slot. The server
checks it before it creates a session (`snapshot_unavailable` or
`snapshot_modified`, before any Pi session exists) and again before it admits
each prompt (`snapshot_modified`, the turn is not started).

This detects changes; it does not prevent them. The tree stays writable by the
host user, and a change made during a running turn is detected only at the next
admission. The ADR claims an unchanged view between verified admissions, not
OS-level immutability.

### 4. Leases, concurrency and crashes

- A session on a snapshot alias holds a shared `flock` on a never-deleted
  per-slot lock file, from just before the start verification until the session
  is disposed. Several sessions on the same slot share it; setup's exclusive
  attempt fails with `snapshot_busy` while any of them exists.
- A server crash or kill releases the lock with the process. Nothing needs to be
  cleaned up, because the server created nothing. Close and shutdown release it
  as part of disposal; a dispose that does not finish keeps the lock until the
  process ends, which keeps the slot safe from retargeting.
- Cancellation: an aborted start releases the lock. Setup holds the exclusive
  lock for the whole operation, so a session start racing an apply either sees
  the old verified slot or fails with `snapshot_unavailable`, never a
  half-built one.

### 5. Visibility

`SessionView` gains an optional `snapshot: { base, head, tree }`, present only
for sessions on snapshot aliases. It is copied from the state verified at start.
The controller compares `snapshot.head` with the commit it meant to review, and
can check the same object IDs independently in the source checkout with
`git rev-parse`. No path is reported.

### 6. Context files, symlinks and grants

- Context files load through the existing read-only rule (#192): only files
  inside the snapshot tree, so a review sees the `AGENTS.md` of the reviewed
  commit, not the operator's current one.
- Confined read tools resolve symlinks and reject targets outside the snapshot.
  The `.git` file of a linked worktree is readable, while the common Git
  directory it points to is outside the read roots. The sandboxed shell
  overlays that common directory (ADR 0013), so a sandboxed reviewer can see
  every ref and object of the source repository, as it does today with a linked
  worktree alias.
- Extension and external MCP grants are refused (section 1), since a read-only
  profile with those grants could change the snapshot. A future relaxation
  needs its own decision.

## Evidence

The provider-free synthetic proof in
[`docs/evaluation/review-snapshots-2026-10-31/`](../evaluation/review-snapshots-2026-10-31/README.md)
exercises the proposed materialization and verification with real Git and the
real confined read operations: a branch that differs from `main` is read at its
head, later operator commits, checkouts and uncommitted edits do not change the
snapshot view, edits, untracked files and a moved head inside the snapshot are
detected, a binding whose tree does not match the head is detected, a missing
object fails before anything is created, symlink escapes
and the common Git directory are outside the read roots, a gitlink is detected,
and removal without `--force` keeps operator work and refuses a modified
snapshot. It starts no Pi session and does not exercise leases, the server,
extension grants or the sandboxed shell.

## Contract change and versioning

None by this ADR. The follow-up adds an execution mode, setup flags and finding
codes (`snapshot_busy`, `snapshot_modified`, `snapshot_object_missing`,
`snapshot_submodule_present`, `snapshot_unavailable`, `snapshot_incomplete`),
the start refusal `snapshot_profile_unsupported`, the prompt refusal
`snapshot_modified`, the optional `SessionView.snapshot` field and Doctor
checks. That is a minor release under ADR 0003. Setup changes need the
relevant Level 2. Before product acceptance, a real-controller review against
the same frozen commit runs separately for Claude Code and Codex.

## Consequences

- The controller skill's review stage would become: collect, pick the head
  commit from the collected ref, `--snapshot <alias> --head <oid> --base <oid>
  --apply`, start the read-only reviewer on the snapshot alias, check
  `session.snapshot.head`, review, close, and only then retarget the slot.
- Writer collection is unchanged. Snapshots use only objects that collection
  has already imported into the operator checkout.
- Out of scope: reviews of live writer clones, automatic merging, arbitrary
  paths, remote review, session persistence.
- Bounded follow-up, if accepted: one issue that implements sections 1 to 5
  with provider-free unit and real-Git tests, Doctor checks, the skill update,
  the Level 2 setup acceptance and the two real-controller review checks, in one
  minor release.

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
that is verified unchanged at defined points of the review.

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
  like a review of the right one. Git's own `worktree remove` without `--force`
  deletes a tree whose only change is an ignored file (proof case
  `plain-remove-deletes-ignored-work`).

### B. Server-managed snapshot per session

`pi_session_start` gains a review input (head and base object IDs). The server
creates a private snapshot for the session and removes it at close.

- For: one call for the controller; the snapshot's lifetime equals the
  session's.
- Against: the MCP server would run mutating host Git in the operator
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

- For: the server stays in-memory and never mutates operator Git state; it runs
  only read-only Git verification (section 3). The binding is verified before
  every session start, before every prompt and after every turn, and the
  controller sees it in the start result. Several reviews of the same commit
  can share one slot. Retargeting cannot happen during a review. A server crash
  releases the lease (kernel `flock`) and leaves only state that setup already
  knows how to inspect.
- Against: a new execution mode, setup commands, a session-view field, Doctor
  checks and the first host Git execution inside the MCP server (read-only):
  a minor release. A controller has to run one setup command per review
  target. Verification detects changes at fixed points; it does not prevent
  them (section 3).

### D. Exported tree without Git metadata (variant of C)

Same lifecycle as C, but the slot holds a `git archive` export instead of a
linked worktree.

- For: the snapshot shares no object store or refs with the operator checkout;
  the sandboxed shell would not overlay the operator's common Git directory,
  and verification would not need to run Git in the operator repository.
- Against: reviewers lose `git log`, `git diff` and `git blame`, which is the
  reason `review-sandboxed` exists. Change detection would need a stored
  content manifest instead of Git's own index. Kept as the fallback
  materialization if the shared object store or Git-based verification turns
  out to be a problem, not as the default.

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
  `~/.local/state/pi-session-mcp/snapshots/<alias>/worktree`, with the slot state
  next to it in `state.json` (`0700` directories, `0600` files, written with
  the existing temporary-file, sync and rename pattern, read with `O_NOFOLLOW`).
  Setup and the server derive the same path; the state stores object IDs and
  aliases only, never a path. Doctor reports a snapshot alias whose configured
  workspace path is not the derived one.
- Only read-only profiles without any extension and without external MCP tools
  may start on a snapshot alias. A coding profile fails with the existing
  `workspace_mode_forbids_coding`. A read-only profile with `extensions`
  (granted tools or not), `grantedExtensionTools` or external MCP tool grants
  fails with a new `snapshot_profile_unsupported`: extension hooks run
  unconfined in the server process from `session_start` on (ADR 0010, ADR
  0013), and external MCP servers run unconfined on the host, so either could
  change the snapshot after it was verified. The sandboxed shell is allowed:
  its overlays discard writes to the snapshot and to the common Git directory.

### 2. Setup lifecycle

- `pi-session-mcp-setup --snapshot <alias> --head <oid> --base <oid>` plans;
  `--apply` performs it. Object IDs are full 40- or 64-hex IDs, never ref
  names, so a moving branch cannot change the target. Before anything is
  created, the source checkout must have `<head>^{commit}` and
  `<base>^{commit}` (`snapshot_object_missing`), and the head tree must
  contain no gitlink (`snapshot_submodule_present`; submodules are
  unsupported, since `git worktree add` leaves them empty). A source whose
  effective Git configuration defines a `filter.*.clean` or `filter.*.process`
  driver or `core.fsmonitor` is refused (`snapshot_source_unsupported`), so
  neither setup nor the server's verification can run repository-configured
  programs.
- Fencing follows the writer pattern (ADR 0012 section 2, AGENTS.md): apply
  takes the slot's exclusive lock without waiting, every mutating Git child
  inherits that descriptor, and the setup guardian keeps the fence until a
  determinate process scan shows that no mutating child remains. A setup that
  is killed mid-operation therefore cannot let a second apply overlap a
  surviving Git child. A slot held by any session fails with `snapshot_busy`.
- If an older snapshot exists, it is removed only if it verifies clean
  (section 3, which includes ignored files and index flags), with
  `git worktree remove` without `--force`. Verification comes first because
  Git's own refusal does not cover ignored files. A modified slot fails with
  `snapshot_modified` and stays as it is. `--snapshot <alias> --discard
  --apply` is the only way to drop a modified slot, and it reports what it
  dropped as counts, never as content.
- Order: remove the old state, materialize with
  `git worktree add --detach <dir> <head>` in the source checkout (`<dir>` is
  the derived worktree directory), verify, then write the new state
  (`{ v, source, base, head, tree, at }`, where `tree` is the head's tree
  object ID) last. A crash in between leaves a slot without valid state; such
  a slot is unusable (`snapshot_unavailable`) and Doctor reports it
  (`snapshot_incomplete`).
- Recovery of an incomplete slot is targeted and ownership-checked; setup never
  runs a repository-wide `git worktree prune`, which would also drop unrelated
  stale registrations of the operator. If the derived directory exists, it must
  be a linked worktree of the source whose administrative entry's `gitdir`
  back-pointer names exactly the derived path; a clean one (section 3, without
  a binding: clean status including ignored files, no index flags) is removed
  with `git worktree remove`, anything else is refused as
  `snapshot_incomplete` and kept until an explicit `--discard`. If the
  directory is missing but its registration remains, only that one
  registration is removed: the administrative entry whose `gitdir`
  back-pointer names the derived path. An unrecognized occupant of the derived
  path is never deleted.
- `--snapshot <alias> --remove --apply` removes a clean slot the same way.
  Setup never runs Git in a writer clone and never deletes anything outside the
  derived slot and its own registration. The source checkout's branches,
  index and working files are never touched.
- Git runs with the hardening setup already applies to boundary Git
  (`core.hooksPath=/dev/null`, `core.fsmonitor=false`,
  `core.useReplaceRefs=false`, `--end-of-options`). Whether host Git must come
  from a trusted fixed path, like `flock` and `bwrap`, is an implementation
  decision for the follow-up; today `src/` resolves `git` from `PATH`.

### 3. Verification

A slot verifies when all of these hold:

- `rev-parse HEAD` equals the recorded head, the recorded base object still
  exists, and the recorded tree equals `<head>^{tree}`;
- `git --no-optional-locks status --porcelain=v1 --untracked-files=all
  --ignored=matching` is empty, so tracked edits, untracked and ignored files
  all count as changes;
- `git --no-optional-locks ls-files -v` shows no assume-unchanged or
  skip-worktree entry, which could otherwise hide a tracked edit;
- no gitlink is present.

`--no-optional-locks` keeps verification read-only: an ordinary `git status`
refreshes and rewrites the worktree index, which lives in the operator's common
Git directory (proof case `verification-does-not-write-git-metadata`, with a
control). Setup verifies before it removes or replaces a slot. The server
verifies before it creates a session (`snapshot_unavailable` or
`snapshot_modified`, before any Pi session exists), before it admits each
prompt (`snapshot_modified`, the turn is not started) and after each turn
reaches a terminal state. If the post-turn verification fails, a turn that
would be `completed` is published as `failed` instead (`turn_failed`), because
its answer may rest on a modified tree, and the session refuses further
prompts with `snapshot_modified`.

This is a weaker contract than an immutable view, stated explicitly: every
answer of a snapshot session was produced between two successful
verifications of the bound commit. It detects changes at those points; it does
not prevent them. The tree stays writable by the host user, and a change that
is made and reverted between two checks is not detected. Preventing changes
would need an OS-level read-only view of the tree for the in-process read tools
as well, which ADR 0013 does not provide; that is out of scope here. Setup
should additionally materialize the tree without write permission bits, which
stops accidental writes but not a deliberate host change.

### 4. Leases, concurrency and crashes

- A session on a snapshot alias takes a shared, non-blocking `flock` on a
  never-deleted per-slot lock file before the start verification and holds it
  until the session is disposed. If setup holds the exclusive lock, the start
  fails at once with `snapshot_unavailable`; it never waits for, and never
  sees, a half-built slot. Several sessions on the same slot share the lock;
  setup's exclusive attempt fails with `snapshot_busy` while any of them
  exists.
- A server crash or kill releases the lock with the process. Nothing needs to be
  cleaned up, because the server created nothing. Close and shutdown release it
  as part of disposal; a dispose that does not finish keeps the lock until the
  process ends, which keeps the slot safe from retargeting.
- Cancellation: an aborted start releases the lock. Setup's cancellation and
  crash handling is the fence of section 2.

### 5. Visibility

`SessionView` gains an optional `snapshot: { base, head, tree }` (object IDs),
present only for sessions on snapshot aliases. It is copied from the state
verified at start. The controller compares `snapshot.head` with the commit it
meant to review, and can check the same object IDs independently in the source
checkout with `git rev-parse`. No path is reported.

### 6. Context files, symlinks and grants

- Context files load through the existing read-only rule (#192): only files
  inside the snapshot tree, so a review sees the `AGENTS.md` of the reviewed
  commit, not the operator's current one.
- The read roots are the snapshot tree plus the directories of the profile's
  selected skills (ADR 0013, `allowedReadRoots`). Confined read tools resolve
  symlinks and reject targets outside those roots; a symlink in the reviewed
  commit that points into a selected skill directory therefore resolves. The
  `.git` file of a linked worktree is readable, while the common Git directory
  it points to is outside the read roots unless a skill root contains it. The
  sandboxed shell overlays that common directory (ADR 0013), so a sandboxed
  reviewer can see every ref and object of the source repository, as it does
  today with a linked worktree alias.
- Extensions and external MCP tools are refused (section 1). A future
  relaxation needs its own decision.

## Evidence

The provider-free synthetic proof in
[`docs/evaluation/review-snapshots-2026-10-31/`](../evaluation/review-snapshots-2026-10-31/README.md)
exercises the proposed materialization and verification with real Git and the
real confined read tool, with an empty skill list. A branch that differs from
`main` is read at its head; later operator commits, checkouts and uncommitted
edits do not change the snapshot view. Tracked edits, untracked files, ignored
files, a skip-worktree flag hiding an edit, a moved head and a tree that does
not match the head are detected; verification leaves the worktree index
unchanged, while an ordinary `git status` rewrites it. A missing object fails
before anything is created. Symlink escapes and the common Git directory are
outside the read roots, and a gitlink is detected. Removal without `--force`
keeps operator work and refuses a modified tracked file, but deletes a tree
whose only change is an ignored file. It starts no Pi session and does not
exercise leases, setup crashes, the server, filters, skill roots, extension
grants or the sandboxed shell.

## Contract change and versioning

None by this ADR. The follow-up adds an execution mode, setup flags and finding
codes (`snapshot_busy`, `snapshot_modified`, `snapshot_object_missing`,
`snapshot_submodule_present`, `snapshot_source_unsupported`,
`snapshot_unavailable`, `snapshot_incomplete`), the start refusal
`snapshot_profile_unsupported`, the prompt refusal `snapshot_modified`, the
post-turn downgrade to `failed`, the optional `SessionView.snapshot` field and
Doctor checks. That is a minor release under ADR 0003. Setup changes need the
relevant Level 2. Before product acceptance, a real-controller review against
the same frozen commit runs separately for Claude Code and Codex.

## Consequences

- The controller skill's review stage would become: collect, pick the head
  commit from the collected ref, `--snapshot <alias> --head <oid> --base <oid>
  --apply`, start the read-only reviewer on the snapshot alias, check
  `session.snapshot.head`, review, close, and only then retarget the slot.
- Writer collection is unchanged. Snapshots use only objects that collection
  has already imported into the operator checkout.
- The MCP server gains its first host Git execution, read-only and bounded,
  limited to snapshot verification.
- Out of scope: reviews of live writer clones, automatic merging, arbitrary
  paths, remote review, session persistence, OS-level immutability.
- Bounded follow-up, if accepted: one issue that implements sections 1 to 5
  with provider-free unit and real-Git tests (including the recovery,
  fencing and post-turn cases), Doctor checks, the skill update, the Level 2
  setup acceptance and the two real-controller review checks, in one minor
  release.

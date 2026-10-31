# Sprint 16: verified read-only review snapshots

Planning basis: main `21d1d95` (ADR 0015 accepted, PR #218), 2026-10-31.
Entry: [#217](https://github.com/plagor44-ux/pi-session-mcp/issues/217),
the implementation of [ADR 0015](../adr/0015-review-snapshots.md) sections
1 to 5 in one minor release. This file records the work as it landed; it
claims nothing that its progress log does not state with evidence.

Branch: `feat/217-review-snapshots`, one pull request, no release. Merge,
version, tag and npm publication are maintainer decisions.

## Scope and decisions

- Core (`src/review-snapshot.ts`): derived slot paths, the state file, the
  trusted Git runner, the guardian-routed runner for mutations, the
  conversion-driver check, verification, and shared and exclusive slot locks.
  The `snapshot` execution mode with a `source` alias.
- Server: a shared lease per session, verification at start, before every
  prompt and after every turn, the completed-to-failed downgrade and taint,
  start refusals, `SessionView.snapshot` and the `snapshot` capability mode.
- Setup: `--repo <alias> --mode snapshot --source <alias>` and
  `--snapshot <alias> --head <oid> --base <oid> [--apply]`, `--remove`,
  `--discard`, with the exclusive lock and the setup guardian as the fence and
  targeted recovery of incomplete slots.
- Doctor: `snapshot_path_mismatch`, `snapshot_incomplete`,
  `snapshot_unavailable`.
- Linux only in this release; macOS is an open point (the slot lease needs
  util-linux `flock`). The implementation decisions the ADR left open and two
  deviations (no discard counts, no write-bit removal) are recorded in the
  ADR's "Implementation notes".

## Roles and routing

| Requested | Route used | Status |
| --- | --- | --- |
| Core (T1) | `code-terra` on writer `pi-session-mcp-w1` | delivered after one follow-up for missing tests; two defects fixed by the controller |
| Setup (T2) | `code-terra` on writer `pi-session-mcp-w1` | first turn `BLOCKED` on the guardian fence; the controller decided the `guardedGit` design, the follow-up delivered |
| Server (T3) | `code-terra` on writer `pi-session-mcp-w2` | first turn stopped after the guard only; the follow-up delivered |
| Doctor, docs, records | controller (Claude Code, Opus 5.5) | |
| Cross-family review 1 | `review-sonnet` (anthropic `claude-sonnet-5-5`) | `NON_BLOCKING_ONLY`, eleven findings |
| Cross-family review 2 | agy `gemini-4-argon-high`, read-only | `BLOCKING`, five blocking and two non-blocking findings |
| Fix rounds 1 and 2 | `code-terra` on writer `pi-session-mcp-w1` | delivered |

Each writer had one task and its own branch. The controller reviewed every
diff, integrated each task as one commit, and is the only editor of the
records.

## Progress log

- T1 (`4763c01`): the core module and the execution mode. Controller fix
  `600836f`: the slot root check rejected an ordinary `~/.local` with mode
  0755, and a spawn error could leave a Git call unsettled.
- Doctor (`fd4cab0`), controller.
- T3 (`f3d4dc9`) and T2 (`c62d5e3`). T2's blocker: `trustedGit` spawns Git
  directly, so the guardian's process scan does not cover it. Decision: every
  mutating command runs through the guardian runner as `env -i <fixed
  environment> <git>`, read-only commands stay direct because the guardian
  caps output at 64 KiB.
- Docs (`8aaea07`, `36a54fc`).
- Review 1 (`review-sonnet`): confirmed and fixed in round 1 (`f6c6982`, docs
  `b1521d6`): a conversion driver that applies only to linked worktrees ran
  during `worktree add` (now `--no-checkout`, check, guarded `reset --hard`);
  the 10 second guardian bound for mutations (now up to 120 s); Git's
  `initializing` worktree lock blocked recovery and an operator lock was not
  respected; tag object IDs passed as commits; a dry-run promised an apply
  that would be refused; interrupts lost their 130/143 exit codes; a rejected
  dispose released the lease; verification shared the 5 s cleanup deadline.
  Not changed: discard counts (recorded as a deviation).
- Review 2 (agy, Gemini, on the tree before round 1): verified by the
  controller with Git 2.56, then fixed in round 2 (`60be6a5`, docs
  `963af37`): a worktree-specific `core.worktree` pointed `git status` at
  another directory, so a modified slot verified clean; with
  `worktree.useRelativePaths=true` Git writes relative back-pointers that
  recovery never matched; the old state was removed after the old slot,
  against ADR section 2; setup and Doctor compared paths differently under a
  symlinked home parent; Doctor treated a file or link at the slot path as
  absent; `--source` was not validated. A mutation check confirmed that the
  new tests fail without the `core.worktree` and relative-path fixes.
  Declined with reasons: early lease release on close (the lease is released
  only after a fulfilled dispose), a source-side driver check before
  `worktree remove` (the slot-side check already runs and removal does not
  check out in the source), `O_NOFOLLOW` for back-pointer reads and a forced
  `rm` (host-user races only, and both fail closed).
- Writers: both container runs of the full suite timed out in the known lock,
  skill-customize and wake-hook tests, as AGENTS.md expects; the host runs
  are in the pull request.

## Gates (host, HEAD `963af37`)

- `npm run typecheck`: exit 0. `npm run build`: exit 0. There is no
  `build:cli` script.
- `NODE_OPTIONS=--unhandled-rejections=strict npm test`: exit 0, 149 files,
  4275 passed, 14 skipped. Plain `npm test`: the same counts.
- `node docs/evaluation/review-snapshots-2026-10-31/snapshot-proof.mjs` after
  the build: exit 0, 15 of 15 cases pass.
- `git diff --check 21d1d95 HEAD`: exit 0. `npm pack --dry-run`: succeeds.

## Not done

- Level 2 setup acceptance and the real-controller reviews with Claude Code
  and Codex against one frozen commit (#217 acceptance list): not run.
- macOS support.

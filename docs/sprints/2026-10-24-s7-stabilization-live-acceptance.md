# Sprint 7: stabilization and live acceptance (2026-10-24)

Planning basis: main `f69c40f2f2f7ab5fb98767715ed2dc394e58a3cb`, published
release 0.11.2, Pi SDK 1.4.0. Open issues at the start: #118 and #79; no open
pull requests; CI, install smoke and the SDK canary green on that commit.

This is a maintenance sprint, requested by the maintainer on 2026-10-24. It
fixes one confirmed defect, reconciles the planning documents with what was
delivered, and accepts the integrated candidate with real controllers and real
Pi model turns. It does not change the MCP contract and adds no minor version.

## Mandate

| Goal | Content |
| --- | --- |
| A | Fix [#118](https://github.com/plagor44-ux/pi-session-mcp/issues/118): the Linux process table counted a zombie thread-group leader with live threads as gone. |
| B | Reconcile roadmap, sprint files, implementation plans and trackers with the delivered releases. |
| C | Accept the integrated candidate with real Claude Code and Codex controllers and real Pi worker turns. |
| D | Check the normal setup and hook path and an automated container writer with event delivery. |
| E | Record remaining gaps precisely and prioritize them. |

Authorized: the focused fix, parallel delegation to internal subagents, Pi
workers and agy, real model calls for development, review and the acceptance
below, temporary configurations, synthetic repositories, isolated client
settings and writers created only for this sprint, setup mutations inside
those isolated environments, tracker and documentation upkeep, and one
reviewable pull request against main.

Not authorized: merge, tag, npm publication or rollout; changes to other
running sessions or to existing client registrations and writers; wider
permissions or credentials; new paid services or budgets; a new public MCP
contract, a production task ledger, a supervisor daemon or a production
question channel.

Live acceptance limits set by the maintainer for the acceptance matrix: at most
20 worker starts and 32 worker turns, at most 120 minutes of active live
acceptance, no open-ended repetition, and at most one targeted rerun of a
failed scenario after a demonstrated correction. No money limit was set by the
maintainer, and none is claimed here. Development and review delegations are
counted separately.

## Scope

- In: the #118 fix and its regression tests; corrections of the over-general
  zombie statement in the rules and design documents; the documentation and
  tracker reconciliation; a frozen candidate with Level 1, Level 2 (delivery
  off and spool, packed tarball) and the Level 3 cycle; event-delivery
  scenarios E1–E6; one automated container writer with delivery.
- Out: the question channel (ADR 0011 item 4), a production ledger or
  supervisor, Codex wake, macOS delivery, any change on macOS for #118 (the
  `ps` path is not checked for the same case).

## Source binding

Three builds are kept apart in every record:

1. Reference: the published 0.11.2 (`f69c40f` source, npm package).
2. Candidate: the head of this sprint's pull request with the #118 fix. Its
   package version stays `0.11.2` because the version is not raised in this
   sprint (changelog entries go under Unreleased); the candidate is identified
   by commit and `dist/` digests, never by the version string.
3. Loaded: what a controller actually started, recorded per run.

A pass of the candidate is never reported as live acceptance of the published
0.11.2.

## Work split

The integrator (Claude Code) owns shared documents, the changelog, integration,
the acceptance runs and the final verdict.

| Package | Owner | Workspace | Writes |
| --- | --- | --- | --- |
| A: #118 fix and tests | Pi worker, profile `code` | full clone alias `pi-session-mcp-w1` | `src/setup-platform.ts`, `test/setup-platform.test.ts`, rule and design text on zombies |
| B: documentation and tracker reconciliation | internal subagent | separate worktree | event-bridge plan, Sprint 6 file, ADR status lines; proposals for the roadmap and #79 |
| C: live oracles, client configurations, evidence capture | internal subagent | scratch directory outside the repository | nothing tracked |
| D: independent review of the frozen candidate | internal reviewer and a Pi reviewer of another model family | read-only | nothing |

A, B and C run in parallel. D starts on a frozen, integrated state.

## Gate order

1. Reproduce #118 on the unchanged source; targeted regression tests.
2. Integrate; independent review.
3. Fix confirmed findings.
4. Freeze the candidate.
5. Level 1 and the Level 2 variants (delivery off, delivery spool, packed tarball).
6. Live acceptance on that candidate: the Level 3 cycle, E1–E6 and the container
   writer.

A runtime change after a live run needs a new source binding and a rerun of the
affected acceptance.

## Acceptance criteria

- #118 reproduced on `f69c40f` with an oracle independent of the function under
  test, and fixed; the #109 handling for vanished processes is unchanged.
- Level 1 green on the final source; Level 2 passes for delivery off and spool,
  working tree and packed tarball.
- Level 3: the gate in [Acceptance](../acceptance.md#gate) holds. Eight of ten
  is the floor for task outcomes only; every security, scope and cleanup
  criterion must hold on its own.
- Wake scenarios have their own status and never stand in for the Level 3 cycle:
  - E1: the hook installed only by setup in an isolated environment; a real
    Pi turn ends while the controller waits; a new controller model round is
    observed; one result read; no polls and no sleep loop.
  - E2: two sessions with different end times; each wake reaches the right
    session and turn; nothing lost or handled twice.
  - E3: a longer deterministic worker task; task deadline, hook budget and hook
    timeout aligned; a budget wake causes exactly one status read and a re-arm.
  - E4: abort and close; no useless wake for a removed session; no stray hook,
    server or worker processes.
  - E5: Codex with a typical minimal environment starts with delivery off and
    completes the core workflow by polling; no Codex wake is claimed.
  - E6: wake in the VS Code extension, checked in a reachable VS Code instance;
    hook pickup by an already running session checked separately; otherwise
    blocked with the shortest operator procedure.
- Container writer: provisioned from the frozen candidate, readiness and
  isolation checks pass, the spool mount reaches no other writer namespace and
  no extra host files, crafted events cannot fake success, collect and finish
  lose no work, and nothing created by this sprint remains.
- Every scenario record names commit, build, versions, route, profiles,
  preconditions, steps, oracle, outcome (passed, failed, blocked, not run),
  cleanup and limits.

## Status

Planned on 2026-10-24. Results are added below as they are taken; failed runs
stay on record.

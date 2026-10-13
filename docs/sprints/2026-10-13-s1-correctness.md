# Sprint 1: correctness

Base: main `3e360dd672cbffcce2913a5cf9f6333a0262f077` (after docs PR #58).
Date: 2026-10-13. Tracking: [#59](https://github.com/plagor44-ux/pi-session-mcp/issues/59)
(R01) and [#56](https://github.com/plagor44-ux/pi-session-mcp/issues/56) (R02).
Planning sources: the [roadmap](../roadmap.md) and the
[post-0.8.1 audit](../reviews/2026-10-13-post-0.8.1-audit.md), which defines
R01–R23 and the Sprint 1 exit gate.

This file tracks the state of Sprint 1. It records what is planned, what code
exists and what is proven. A status of `implemented` or `verified` is set only
together with evidence in the sections below; nothing here is a claim that a
check has already passed.

## Scope

In scope:

- R01: skill recovery must not delete operator content in the transaction's
  trash ([#59](https://github.com/plagor44-ux/pi-session-mcp/issues/59)).
- R02: `--verify` must report the client and inspection failures it currently
  reduces to `registration_not_equivalent`
  ([#56](https://github.com/plagor44-ux/pi-session-mcp/issues/56)).
- R03: the native Linux quality gate for the integrated candidate.
- R19: carry the v0.8.1 post-release evidence from the release notes into
  [acceptance](../acceptance.md).
- The documentation that these changes directly affect.

Out of scope: Sprint 2–4 items, the R13/R14 harness extensions, a full Level 3
cycle, a third concurrent worker session, new features, dependency or Pi SDK
updates, a version bump and any change to the MCP contract.

R-identifiers are planning identifiers, not GitHub issue numbers. R01 and R02
have issues (#59, #56). R03 and R19 have no separate issues; they are delivered
in this sprint's pull request. R21 (the consolidated roadmap) was delivered as
documentation by #58; that did not fix R01 or R02.

## Delivery

One branch and one pull request against main, with separate commits per issue.
The work runs in separate worktrees, each with its own file ownership, and an
integrator combines them. No merge, tag or publication is part of this sprint.

## Status legend

| Status | Meaning |
| --- | --- |
| planned | Not started |
| in_progress | Work has started; no result may be claimed yet |
| implemented | The code or text exists; the acceptance criteria are not yet met with evidence |
| verified | The named acceptance criteria are met and the evidence is recorded below |
| blocked | A named blocker prevents progress |

## Tasks

| Task | Issue | Owners | Branch / worktree | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| R01 recovery retains unprovable trash | [#59](https://github.com/plagor44-ux/pi-session-mcp/issues/59) | Strand A implements `src/setup-skills.ts` and the existing recovery tests; strand C writes the counterexamples in `test/setup-skills-trash-preservation.test.ts` | `s1/a-recovery` (worktree a-recovery); `s1/c-trash-tests` | None | in_progress |
| R02 verify diagnostics | [#56](https://github.com/plagor44-ux/pi-session-mcp/issues/56) (open again; not yet fixed) | Strand B implements `src/setup.ts`; strand D writes the counterexamples in `test/setup-verify-diagnostics.test.ts` | `s1/b-verify` (worktree b-verify); `s1/d-verify-tests` | None | in_progress |
| R03 native QA gate | None | Strand E prepares native QA readiness and later reviews read-only; the integrator runs the gate | Runs on the integrated candidate (branch `fix/59-56-s1-correctness`) | Integrated candidate of R01 and R02 | planned |
| R19 v0.8.1 evidence carry-over | None | Strand F (documentation) | `s1/f-docs` (worktree f-docs) | None | in_progress |

Strand F also owns the sprint file, the roadmap status, the changelog entry and
the corrected recovery and verify documentation. The integrator owns the
version and release fields, which stay unchanged in this sprint.

## Acceptance criteria

### R01 / #59: recovery retains unprovable trash

The contract of the fix. None of it is verified until the evidence section
says so.

- Recovery deletes the transaction's `.trash` intermediate only when its
  current contents are the complete, unchanged replaced copy: its version 2
  tree fingerprint equals the replaced fingerprint in the pending record.
- A partial trash tree (for example after an interruption during the
  entry-by-entry deletion, including an empty one), a modified, added-to,
  foreign or otherwise unprovable tree, and any trash when the record names no
  usable replaced fingerprint are retained and reported as
  `skill_recovery_retained` (status `divergent`). The pending record, the slot
  and the other intermediates stay unchanged. This deliberately replaces the
  earlier automatic deletion of partial trash trees.
- An added regular operator file and modified content of an existing regular
  file survive `apply`, `remove` and `rollback` byte for byte.
- A complete, unchanged own trash tree is still deleted and the transaction
  settles normally (`skill_recovered` or `skill_removed`).
- Intermediates of other transactions and 0.8.0 names stay untouched.
- Reports contain no paths or file content.
- The existing interruption recovery tests are kept, and their partial-trash
  expectations follow the corrected contract.
- A dry-run still announces `skill_recovery_planned` without inspecting
  intermediates, so a later apply can still retain.
- Lock, guardian, healthy checks, directory fsync and release binding are not
  weakened.
- [Skills](../skills.md#interrupted-updates) and the
  [setup design](../client-setup-design.md) describe the retention guarantee and
  the operator settlement steps.

### R02 / #56: verify diagnostics

The contract of the fix. None of it is verified until the evidence section
says so.

- Precedence stays: unknown client (`client_unsupported`), ownership
  (`ownership_unavailable`), release binding (`release_binding_mismatch`),
  then Doctor under its own code. A failed Doctor now ends that target's verify
  before inspection and handshake.
- Inspection that reports the client unsupported or not discoverable (for
  example its CLI is not on `PATH`) gives status `unsupported`, code
  `unsupported`.
- Inspection that throws gives `inspect_failed`.
- An absent registration, a divergent one, or an equivalent one with another
  fingerprint gives `registration_not_equivalent`.
- Only a truly equivalent registration runs the bounded MCP handshake
  (`mcp_verified` or `mcp_<status>`).
- No failure case mutates a registration or starts the handshake, and all exit
  with `1`.
- No new code such as `client_unavailable` is introduced.
- Human and JSON output, exit status and the documented codes agree.
- [Client setup](../client-setup.md#verify-diagnostics) and the
  [setup design](../client-setup-design.md#verification-boundary) document the
  codes.

### R03: native QA gate

Runs once, on the integrated candidate, on native Linux (not a container whose
process, `/proc` or kernel-lock prerequisites are unproven):

- `npm ci`
- `npm run typecheck`
- `npm run build:cli`
- `NODE_OPTIONS=--unhandled-rejections=strict npm test`
- `npm run build`
- `npm audit` and `npm audit --omit=dev`
- `git diff --check` and a clean `git status --short`
- `npm pack --dry-run`, and a check that the relative links of the changed
  documents resolve

Every command exits with `0`, with no unhandled rejection. Where a check
fails, record whether it is a regression of the candidate or an unmet platform
prerequisite (for example unreadable `/proc`, a missing trusted `flock`, or an
unsupported filesystem). Do not retry until green, and do not weaken a process
proof to make a run pass. Original failures stay on record. The earlier
container failures of the audit are not attributed to a cause here.

### R19: v0.8.1 evidence carry-over

- The post-release evidence that exists only in the v0.8.1 release notes is
  carried into [acceptance](../acceptance.md#v081-post-release-evidence-carried-over-from-the-release-notes)
  with its source, what was checked, on what, with which result, its
  classification (provider-free, real client without a model, real model) and
  the stated limitations and failures.
- No item is upgraded or reinterpreted, and nothing is added that the release
  notes do not state.

## Evidence

Rows stay `pending` until the integrator records the actual command, the
source SHA it ran on, the exit status and the result. A result for one commit is
not evidence for another.

| Check | Command | Source SHA | Exit | Result |
| --- | --- | --- | --- | --- |
| Install | `npm ci` | pending | pending | pending |
| Typecheck | `npm run typecheck` | pending | pending | pending |
| CLI build | `npm run build:cli` | pending | pending | pending |
| Tests, strict rejections | `NODE_OPTIONS=--unhandled-rejections=strict npm test` | pending | pending | pending |
| Build | `npm run build` | pending | pending | pending |
| Audit | `npm audit` | pending | pending | pending |
| Audit, production | `npm audit --omit=dev` | pending | pending | pending |
| Whitespace | `git diff --check` | pending | pending | pending |
| Clean tree | `git status --short` | pending | pending | pending |
| Package contents | `npm pack --dry-run` | pending | pending | pending |
| Relative links of changed documents | link check | pending | pending | pending |
| R01 counterexamples (apply, remove, rollback) | named tests | pending | pending | pending |
| R02 diagnostics counterexamples | named tests | pending | pending | pending |
| Final head CI | Linux, macOS 15, macOS 26 | pending | pending | pending |

## Level 2

Pending. The relevant Level 2 targets and the new negative cases are recorded
in [acceptance](../acceptance.md#sprint-1-correctness-checks-2026-10-13)
once they have run. Only targets actually checked may be claimed.

## Independent review

Pending. Strand E reviews the integrated diff read-only, independent of the
authors. Findings and their resolution are recorded here.

## Open gates and remaining findings

Sprint 1 does not close these. They stay open:

- Current macOS Level 2 on real hardware with both clients (R10).
- Level 3: the full ten-task cycle on Pi SDK 1.x (R05) and the profile
  actually intended for use (R09).
- Live discovery of the setup-installed Codex home skill (R07).
- Multi-session acceptance beyond two sessions, including a third worker and a
  read-only reviewer (R08).
- Explicit strict unhandled rejections in CI (R16, Sprint 2).

Release 0.8.2 is only a recommendation. It would need its own scope: an
unchanged MCP contract, the version and pre-release acceptance in a change
pull request, and a separate maintainer decision to merge, tag and publish.
This sprint authorizes none of them.

## Next step

When the evidence rows above are filled and the independent review has no open
finding, the maintainer decides on merging the one pull request. The Sprint 2
entry conditions in the [roadmap](../roadmap.md) apply only after the Sprint 1
gate; its proposed window shifts with that gate.

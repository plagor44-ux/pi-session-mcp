# Sprint 1: correctness

Base: main `3e360dd672cbffcce2913a5cf9f6333a0262f077` (after docs PR #58).
Date: 2026-10-13. Tracking: [#59](https://github.com/plagor44-ux/pi-session-mcp/issues/59)
(R01) and [#56](https://github.com/plagor44-ux/pi-session-mcp/issues/56) (R02).
Integration branch: `fix/59-56-s1-correctness`. Runtime candidate (the last
commit that changes `src/` or `test/`):
`fa32c22b573ff0bb0b920813bd9520bb79b025f4`. Later commits on the branch change
documentation only.
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
| R01 recovery retains unprovable trash | [#59](https://github.com/plagor44-ux/pi-session-mcp/issues/59) | Strand A implements `src/setup-skills.ts` and the existing recovery tests; strand C writes the counterexamples in `test/setup-skills-trash-preservation.test.ts` | `s1/a-recovery` (worktree a-recovery); `s1/c-trash-tests` | None | verified (native Linux; final-head CI pending) |
| R02 verify diagnostics | [#56](https://github.com/plagor44-ux/pi-session-mcp/issues/56) | Strand B implements `src/setup.ts`; strand D writes the counterexamples in `test/setup-verify-diagnostics.test.ts` | `s1/b-verify` (worktree b-verify); `s1/d-verify-tests` | None | verified (native Linux and real clients; final-head CI pending) |
| R03 native QA gate | None | Strand E prepares native QA readiness and later reviews read-only; the integrator runs the gate | Runs on the integrated candidate (branch `fix/59-56-s1-correctness`) | Integrated candidate of R01 and R02 | verified (native Linux) |
| R19 v0.8.1 evidence carry-over | None | Strand F (documentation) | `s1/f-docs` (worktree f-docs) | None | verified |

Status as of 2026-10-13, after integration, the native gate, Level 2 and two
independent reviews. "verified" refers to the acceptance criteria of each task
below. It does not include the final-head CI matrix on Linux, macOS 15 and
macOS 26, which runs on the pull request, or the maintainer's merge decision;
the Sprint 1 exit gate stays open until both exist. Issue #56 was closed once
by an unrelated documentation merge although the code was unchanged; it is
fixed only by the commits listed below.

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

Recorded by the integrator on 2026-10-13 on native Linux (x64, kernel 7.2,
Btrfs checkout, tmpfs temporary root), Node.js `26.11.1`, npm `12.2.0`. No
provider, model or credential was used. A result for one commit is not
evidence for another; the binding to the final pull-request head is described
under [Source binding](#source-binding).

### Commits

| Commit | Content |
| --- | --- |
| `73fd804` | fix(setup): report `unsupported` and `inspect_failed` in verify (#56) |
| `7736322` | test(setup): verify diagnostics counterexamples (#56) |
| `02a6a7f` | fix(skills): retain unprovable trash during recovery (#59), including the adapted interruption tests |
| `fa32c22` | test(skills): trash preservation counterexamples for recovery (#59) — runtime candidate |
| later | documentation only |

### Before the fix (base `3e360dd`)

The counterexamples were written against the contract, independently of the
fixes, and run on the unfixed base first. Every failure is an assertion about
the defect; none is an import, type or fixture error.

| Check | Exit | Result |
| --- | --- | --- |
| `NODE_OPTIONS=--unhandled-rejections=strict npx vitest run test/setup-skills-trash-preservation.test.ts` | 1 | 24 of 30 failed: `apply` reported `skill_recovered`, `remove` and `rollback` reported `skill_removed` where `skill_recovery_retained` was required (added file, modified files, partial, empty, and a record without a replaced fingerprint). The complete own trash and the other-transaction cases passed. |
| `NODE_OPTIONS=--unhandled-rejections=strict npx vitest run test/setup-verify-diagnostics.test.ts` | 1 | 19 of 53 failed: unsupported and throwing inspections reported `registration_not_equivalent`, including at the `main()` and formatter boundary; after a failed Doctor, inspection (and for an equivalent registration the handshake) still ran. |
| Real clients, built base, isolated homes: verify with the client CLI not on `PATH` | 1 | Codex `user` and Claude Code `user` both reported `failed (registration_not_equivalent)`; `--dry-run` reported `unsupported (unsupported)`. This reproduces #56. |

The adapted interruption tests in `test/setup-skills-recovery.test.ts` were
not executed against the base. The independent review confirmed by reading
that the base deletes the one-entry partial trash and would fail them.

### Native gate (R03) on the runtime candidate `fa32c22`

| Check | Command | Exit | Result |
| --- | --- | --- | --- |
| Install | `npm ci` | 0 | |
| Typecheck | `npm run typecheck` | 0 | |
| CLI build | `npm run build:cli` | 0 | |
| Tests, strict rejections | `NODE_OPTIONS=--unhandled-rejections=strict npm test` | 0 | 52 files passed; 1121 tests passed, 6 skipped, 0 failed; no unhandled error |
| Build | `npm run build` | 0 | |
| Audit | `npm audit` | 0 | 0 vulnerabilities |
| Audit, production | `npm audit --omit=dev` | 0 | 0 vulnerabilities |
| Whitespace | `git diff --check 3e360dd HEAD` | 0 | |
| Clean tree | `git status --short` | 0 | empty |

The test count reconciles with the v0.8.1 record (50 files, 1035 passed, 6
skipped): two new files and 86 new cases. By their skip conditions, the six
skipped cases are the four macOS-only kernel-lock cases, one isolated-probe
case and one red-before case that needs an unmodified base build. A readiness
check before the run found every Linux setup prerequisite present: supported
filesystems for the temporary root and the checkout, a trusted root-owned
`flock`, a readable `/proc` without `hidepid`, a determinate process table and
no nested PID namespace. The process, `/proc` and kernel-lock failures of the
audit's container run did not occur here. That does not establish their cause
in the container.

On the documentation head that followed, without a change to `src/`, `test/`,
`scripts/` or the package manifests:

| Check | Command | Exit | Result |
| --- | --- | --- | --- |
| Package contents | `npm pack --dry-run --json` | 0 | 132 files, 234,493 bytes; this sprint file included; no `src/`, `test/`, lockfile or implementation plan |
| Relative links | link and heading-anchor check of every changed Markdown file, README, roadmap and audit | 0 | 114 links, 0 problems |

### Targeted results on the integrated candidate

| Check | Exit | Result |
| --- | --- | --- |
| #59: `test/setup-skills-trash-preservation.test.ts`, `test/setup-skills-recovery.test.ts`, `test/setup-skills.test.ts`, `test/setup-skills-legacy.test.ts`, `test/setup-skills-collision.test.ts` | 0 | 123 passed, 0 skipped; the Linux SIGKILL recovery cases ran |
| #56: `test/setup-verify-diagnostics.test.ts`, `test/setup-lifecycle.test.ts` | 0 | 75 passed |

### Source binding

The native gate ran on `fa32c22`. Level 2 ran on the build of the same
runtime sources at the documentation head `73967f7`: its built `dist/main.js`
has SHA-256 `47875d38886528ace6b242df2c6ad79d624c51e330e63c2f401576eadc449ed7`,
which the harness recorded as well. The final pull-request head changes only
documentation relative to `fa32c22`; that is checked with
`git diff --stat fa32c22 <head> -- src test scripts package.json package-lock.json tsconfig*.json`,
which must be empty. A later runtime change requires the native gate and
Level 2 again.

## Level 2

One run of `scripts/setup-acceptance.mjs` on the final runtime build, with the
real Codex CLI `0.162.1` and Claude Code `2.1.296`, disposable homes and the
harness's synthetic configuration. No model, no global installation.

| Check | Exit | Result |
| --- | --- | --- |
| `node scripts/setup-acceptance.mjs --setup "node <checkout>/dist/setup-main.js" --build-dir <checkout> --work-dir <private cache directory> --label <label> --out <private file>` | 0 | 160 of 160 checks passed: `codex:user`, `claude-code:user`, `claude-code:project` and `claude-code:local`, 9 of 9 steps each. Real registrations unchanged, no remaining process, no path leak, build unchanged, disposable directory removed. |

New negative case for #56, recorded separately because the harness has no
negative steps: with the same real clients in isolated homes, apply and verify
ran with the client on `PATH`; then verify (human and `--json`) and dry-run
ran with `PATH` reduced to the system directories, so that neither client was
found; then remove ran with the client on `PATH` again.

| Client | Verify without client on `PATH` | JSON | Dry-run | Registration during these steps | Exit |
| --- | --- | --- | --- | --- | --- |
| Codex `user` | `unsupported (unsupported)` | `unsupported`/`unsupported` | `unsupported (unsupported)` | unchanged | 1 each |
| Claude Code `user` | `unsupported (unsupported)` | `unsupported`/`unsupported` | `unsupported (unsupported)` | unchanged | 1 each |

Apply, verify (`mcp_verified`) and remove with the client on `PATH` exited 0
for both. No output contained a path. The real client registrations were
unchanged before and after. This check script is not part of the repository.

## Independent review

Two read-only reviewers who did not write the change reviewed the frozen
runtime diff `3e360dd..fa32c22`:

- Strand E (Claude family): approve with nits; 135 targeted tests rerun.
- A Pi worker with the `review` profile (OpenAI family): approve with nits; no
  material runtime finding.

| Finding | Severity | Resolution |
| --- | --- | --- |
| A dry-run still announces `skill_recovery_planned` where apply retains an intermediate; more reachable now that a partial trash is retained | minor | Pre-existing and documented. Not fixed in this sprint: a fix needs one read-only classification shared by dry-run and recovery. Tracked as [#60](https://github.com/plagor44-ux/pi-session-mcp/issues/60) and linked from the documentation. |
| An empty trash directory is retained and must be deleted by hand | nit | Kept deliberately: it is a partial tree under this sprint's contract, and the documentation names the case. |
| The documentation described the old structural trash deletion | minor | The reviewer saw the base documentation; the documentation commit replaces it. |
| The v2 fingerprint covers regular files, not empty directories or file modes | observation | Documented: such a difference inside an otherwise complete trash does not prevent deletion, and no file content is lost. |
| A retained backup or staging directory can follow the deletion of a proven own trash | observation | Pre-existing order, correct because the trash was proven. The documentation now says so instead of claiming that all other intermediates stay unchanged. |
| A same-user process can change the trash between its check and its deletion | observation | Pre-existing for every intermediate and outside the documented trust model; not widened. |

No finding required a runtime change, so the native gate and Level 2 were not
repeated.

## Open gates and remaining findings

Sprint 1 does not close these. They stay open:

- Final-head CI on Linux, macOS 15 and macOS 26 for the pull request. Its
  result belongs to the pull request; recording it here would need another
  push and another CI run.
- The maintainer's merge decision.
- [#60](https://github.com/plagor44-ux/pi-session-mcp/issues/60): dry-run
  prediction of a retained intermediate.
- Current macOS Level 2 on real hardware with both clients (R10). The new
  #59 and #56 behavior is covered on macOS only by CI.
- Level 3: the full ten-task cycle on Pi SDK 1.x (R05) and the profile
  actually intended for use (R09).
- Live discovery of the setup-installed Codex home skill (R07).
- Multi-session acceptance beyond two sessions, including a third worker and a
  read-only reviewer (R08).
- Explicit strict unhandled rejections in CI (R16, Sprint 2). The local gate
  above used them.

Release 0.8.2 is only a recommendation. It would need its own scope: an
unchanged MCP contract, the version and pre-release acceptance in a change
pull request, and a separate maintainer decision to merge, tag and publish.
This sprint authorizes none of them.

## Next step

When final-head CI passes, the maintainer decides on merging the one pull
request; merging it closes #59 and #56. Then Sprint 2 begins under the entry
conditions in the [roadmap](../roadmap.md): R04, R13/R14 resource binding,
R16 strict CI and the R19–R23 documentation, with #60 as a candidate bounded
fix. Its proposed window shifts with the Sprint 1 gate.

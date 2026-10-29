# Sprint 12: audit findings F1–F3

Planning basis: main `9d9cf8ca49e6e34dc16be6846b9324ad26ad92b9` (merge of PR
#191), published 0.14.0, 2026-10-29. Entry: an external audit of that commit
reported three defects with reproductions. This file plans the work and records
it as it lands; it claims nothing that its progress log does not state with
evidence.

Branch: `fix/s12-audit-findings`, one pull request, no release.

## Preflight (2026-10-29)

- main and `origin/main` at `9d9cf8c`; open issues #79, #120, #144; no open
  pull requests; clean operator checkout; no other worktree in use.
- Doctor: no errors; only the known `workspace_gitfile` and
  `workspace_mode_unset` warnings of the host worktree aliases.
- Level 1 on `9d9cf8c` in a clean detached worktree on the workstation:
  `npm ci`, `npm run typecheck`, `npm run build:cli`,
  `NODE_OPTIONS=--unhandled-rejections=strict npm test` (527 files, 4005
  passed, 14 skipped, 0 failed, no unhandled error) and `npm run build` all exit
  0. The audit's cloud run of the same commit reported 70 failed tests and four
  unhandled errors; they do not reproduce here, so they are not attributed to
  the product. The audit environment is not available to separate them further.
- Both `pi-session-mcp` writers were at `baseline` on an older main and were
  reset without `--discard` to `9d9cf8c` (`writer_reset`).

## Findings, re-checked on `9d9cf8c`

| Id | Issue | Reproduction by the controller | Result |
| --- | --- | --- | --- |
| F1 | [#192](https://github.com/plagor44-ux/pi-session-mcp/issues/192) | Synthetic workspace whose `AGENTS.md` links to an outside marker file; `PI_CODING_AGENT_DIR` isolated; faux provider | Confined `read` refuses; `getAgentsFiles()` contains the marker; the real `SdkPiSessionAdapter` sends it as `project_instructions` to the faux provider. Confirmed. |
| F2 | [#193](https://github.com/plagor44-ux/pi-session-mcp/issues/193) | Real Git; boundary scripts run by an injected runner | Detached `HEAD` commit, clean tree: remove before collect `writer_uncollected`; collect `nothing_to_collect`, 0 refs, digest stored; commit absent from the operator checkout; finish `writer_reset`; remove `writer_removed`. Feature-branch counterproof exports the commit. Confirmed; not yet a Podman result. |
| F3 | [#194](https://github.com/plagor44-ux/pi-session-mcp/issues/194) | Real relay over stdio, fake writer server fixture | Identical profiles admitted; model drift refused with `settingsChanged`; host `skills: ["pi-session-implementation"]` against inner `skills: []` admitted. Confirmed. |

## Decisions taken at planning

- F1: for read-only profiles every resource loader keeps only context files
  whose real path lies inside the workspace's real path. Context files of
  ancestor directories above the workspace, including a main repository above a
  linked worktree, are no longer loaded for read-only profiles: they are outside
  the read roots of ADR 0013. Coding profiles keep the SDK's behaviour.
- F2: smallest fix inside the existing collection contract; the export name for
  a detached `HEAD` is a documented behaviour addition, no new public code.
- F3: the relay compares every public capability field a writer reports, with
  set semantics for skills, extensions and granted extension tools.
- #120: still waiting for an SDK release (see below); no override, no
  `npm audit fix --force`.
- No release on this branch.

## Roles and routing

`pi_capabilities_get` and `--list-models` on 2026-10-29 settle which requested
models exist as authenticated profiles:

| Requested | Profile used | Status |
| --- | --- | --- |
| GPT 6.1 Sol | `code` (openai `gpt-6.1-sol`) | available |
| GPT 6.1 Terra | none | unavailable: the catalog lists no `gpt-6.1-terra`; not substituted with another version |
| DeepSeek | `code-deepseek` (`deepseek-flash`) | available |
| GLM 5.3 | `review-glm`, `code-glm` (`zai-glm-5-3`) | available |
| Mistral Large 4 | `code-mistral` (`mistral-large-4`) | available |
| Sonnet 5.5 | no profile; provider `anthropic` authenticated | added only in an expendable test configuration (acceptance item D) |
| Grok 4.7 | `review-grok` (xai `grok-4.7`) | available: the R2 turn completed |

agy (Antigravity CLI, Gemini) plans the work packages, dependencies and review
routing; Pi workers implement and review; the controller integrates, verifies
and is the only editor of this file, the roadmap, `docs/acceptance.md` and the
CHANGELOG.

## Tasks

| Id | Task | Route | Change area |
| --- | --- | --- | --- |
| P1 | Work packages, dependencies, review routing | agy | none |
| P2 | Independent regression test plan | `review-glm` | none |
| T1 | F1, #192 | `pi-session-mcp` writer, `code` | `src/sdk-pi-adapter.ts`, `src/confined-tools.ts`, tests |
| T2 | F2, #193 | `pi-session-mcp` writer, `code-mistral` (agy's fallback for the unavailable Terra) | `src/writer-lifecycle.ts`, tests |
| T3 | F3, #194 | `pi-session-mcp` writer, `code-deepseek` | `src/writer-relay.ts`, `src/capabilities.ts`, tests, relay fixture |
| R1 | Security review of T1 and T3 | Sonnet 5.5, read-only | none |
| R2 | Adversarial review of T2 and the Git lifecycle checks | `review-grok` | none |
| D1 | Documentation and issue reconciliation (#120, ADR 0014 status, Sprint 8 status, #79, #144) | `pi-session-mcp` writer, `code-mistral`; controller as editor | `docs/`, `skills/pi-session-orchestration/SKILL.md` |
| A | Live acceptance A–E | controller | evaluation record |

## Progress log

Recorded as work lands on the branch.

- 2026-10-29: issues #192, #193 and #194 filed; this plan written before any
  implementation.
- P1: agy (`gemini-3.8-flash-high`, plan mode) proposed the packages,
  `code-mistral` as the F2 author in place of Terra, Sonnet for R1 and Grok
  with a fallback for R2, and at most three review rounds. Adopted.
- P2: `review-glm` wrote the regression test plan; its edge cases (absent
  against empty set fields, real-Git collection, a Podman case) went into the
  task prompts.
- T3 (`code-deepseek`, writer w2): collected as
  `writer-pi-session-mcp-w2/fix/f3-relay-profile-drift`; the controller ran the
  new tests against the old source (7 fail) and the fix (all pass); integrated
  as `230e60e`, writer finished (`writer_reset`).
- T1 (`code`, writer w1): collected as
  `writer-pi-session-mcp-w1/fix/f1-context-files`; new tests against the old
  source 9 of 12 fail, with the fix 148 of 148 pass; integrated as `a0a7d87`,
  writer finished. The container-writer suite showed only the eight known
  lock and hook timeouts (`override-lock`, `skill-customize-concurrency`,
  `wake-hook`).
- R1 (Sonnet 5.5, read-only, through the test configuration of item D):
  `NON_BLOCKING_ONLY`. Fixed by the controller: kept context files are read
  again from their verified real path (`79e8a7a`), the set comparison is
  symmetric with a duplicated-entry test (`3e14279`); the shadowing case is
  covered by a test and documented. Not changed: synchronous `realpathSync` in
  the loader override (the SDK hook is synchronous) and the trust in the
  writer's own capability report, which is the boundary the relay already
  assumes.
- T2 (`code-mistral`, writer w2): collected as
  `writer-pi-session-mcp-w2/fix/f2-detached-collect`; the new real-Git tests
  against the old source 3 of 8 fail, with the fix 8 of 8 pass, and the F2
  reproduction now gets `writer_collected`; integrated as `236ca28`, writer
  finished. The controller added the Podman case (`6ee7add`): with real
  rootless Podman and the pinned Node image it passes, against the old source
  it fails.
- D1 (`code-mistral`, writer w1): collected as
  `writer-pi-session-mcp-w1/docs/s12-reconcile`; split by issue into
  `f5a9712`, `58e0e7b`, `17845ff` and `ebe3c52`. Controller edits: the
  shadowing and re-read rule in the ADR 0013 amendment, and the relay wording
  (a mismatch counts as `settingsChanged`; `writer_unavailable` with
  `none_admitted` only when no writer is admitted). Writer finished.
- R2 (`review-grok`, Grok 4.7, read-only): `NON_BLOCKING_ONLY`. Verified by
  the controller and fixed in `1dfe4da`: a derived `-wip` or `-detached` name
  that conflicts with an exported branch path aborted the export under
  `set -eu` (reproduced with a branch `main-detached/topic`); a worker-made
  `git replace --graft` made an unexported detached commit look reachable
  (Grok's variant with a plain replacement did not reproduce, the graft did);
  the reachability gate now also runs on `nothing_to_collect`. Recorded as
  limits, not changed: an index-only staged change that the worktree reverted
  (pre-existing), a base name of 192 to 200 characters (fails closed), and a
  runner that reports a fetch it did not do (outside the threat model).
- Final integration review (Sonnet 5.5, read-only, on `896e29d`):
  `NON_BLOCKING_ONLY`. Fixed: the in-boundary guard probe now ignores replace
  refs too (`9426682`, with a test that fails without it), the BOM pattern is an
  escape (`5d9f15b`), and execution modes names the pruned-base case of the
  digest gate. Not changed: `inspectWork.head` stays optional because required
  would break type-checked mocks outside this change.
- Acceptance: see
  [Sprint 12 candidate acceptance](../acceptance.md#sprint-12-candidate-acceptance-2026-10-30).
  Level 1 green on `9426682`; Level 2 green on the packed `896e29d`; live items
  B, C and D passed on expendable configurations and were rolled back; the
  Level 3 ten-task cycle 2 passed (10 of 10) after cycle 1 failed on fixture and
  harness design (5 of 10, kept unchanged).

## Results

| Finding | Status | Commits | Evidence |
| --- | --- | --- | --- |
| F1 #192 | fixed | `a0a7d87`, `79e8a7a`, `5d9f15b`; docs `f5a9712` | `test/read-only-context-files.test.ts` (fails on `9d9cf8c`), faux-provider context check, R1 and final review |
| F2 #193 | fixed | `236ca28`, `6ee7add`, `1dfe4da`, `9426682`; docs `58e0e7b`, `896e29d` | real-Git collect tests, Podman test, guard test (each fails on the source before), R2 and final review |
| F3 #194 | fixed | `230e60e`, `3e14279`; docs `17845ff` | `test/writer-relay.test.ts` drift tests (fail on `9d9cf8c`), live refusal with `settingsChanged`, R1 and final review |

Remaining risk: #120 is unchanged. `npm audit --omit=dev` on 2026-10-29 still
reports `undici` 8.10.2 (high) through `@earendil-works/pi-coding-agent` 1.4.0
(moderate), eight advisories fixed in `undici` >= 8.12.2; the only offered fix
is a semver-major downgrade. No override and no `npm audit fix --force`.

Kept open: #79 (Sprint 8 steps 5 to 7 are not done), #120 and #144 (no macOS
claim). The sandbox resource limits of ADR 0013 are a follow-up issue, not
part of this sprint.

Cleanup: all controller Pi sessions closed; both `pi-session-mcp` writers
finished (`writer_reset`); the test writer `s12-probe-w1` removed; expendable
configurations, the synthetic repository, the pack prefix and the
controller's worktrees removed.


# Sprint 17: design evaluations for four development ideas

Planning basis: main `41ae199` (0.14.3), 2026-10-31.

Entry: four development ideas, not incidents:

- [#210](https://github.com/plagor44-ux/pi-session-mcp/issues/210):
  structured worker reports;
- [#212](https://github.com/plagor44-ux/pi-session-mcp/issues/212): a
  per-profile maximum turn duration;
- [#213](https://github.com/plagor44-ux/pi-session-mcp/issues/213): recovery
  of a writer with an unmerged index;
- [#214](https://github.com/plagor44-ux/pi-session-mcp/issues/214): worker
  questions.

A reasoned defer or reject counts as a full result.

Design: [spec](../superpowers/specs/2026-10-31-s17-design-evaluations-design.md).
Plan: [plan](../superpowers/plans/2026-10-31-s17-design-evaluations.md).
Branch `feat/s17-design-evaluations`: one pull request, no release, no
runtime change. Merge and any acceptance of the proposed ADRs are maintainer
decisions.

## Results

| Issue | Result | Record |
| --- | --- | --- |
| #213 | Proposed [ADR 0016](../adr/0016-writer-recovery-export.md): a separate `--recover` export, revised after two reviews | [evaluation](../evaluation/writer-recovery-2026-10-31/README.md) |
| #212 | Proposed [ADR 0017](../adr/0017-turn-duration-limit.md): an optional `maxTurnSeconds`, enforced by the server that owns the Pi session, revised after two reviews | [evaluation](../evaluation/turn-deadline-2026-10-31/README.md) |
| #210 | **Defer.** Each form had one kind of first-report format failure, each fixed by one follow-up | [evaluation](../evaluation/worker-reports-2026-10-31/README.md) |
| #214 | **Reject** a separate question channel. Both controllers routed `NEEDS_CONTEXT` correctly | [evaluation](../evaluation/worker-questions-2026-10-31/README.md) |

Besides these four results:

- The controller skill's review verdict tokens now match the review skill:
  `BLOCKING_FINDINGS`, `NON_BLOCKING_ONLY`, `NO_FINDINGS` (`614a8db`).
- The development-only evaluation code under `eval/` adds three prototypes:
  - the deadline supervisor;
  - the recovery prototype;
  - the report validator.

  Each has its tests. `src/` is unchanged.

## Roles and routing

| Work | Route | Outcome |
| --- | --- | --- |
| #213 prototype | `code-terra` on writer `pi-session-mcp-w1` | first turn `BLOCKED` (rule misread), then an early stop; delivered after one follow-up each |
| #212 prototype | `code` on writer `pi-session-mcp-w2` | delivered |
| #210 validator and fixtures | `code-deepseek` on writer `pi-session-mcp-w2` | delivered |
| #214 route fixtures | `code-deepseek` on writer `pi-session-mcp-w1` | delivered; the controller amended two tests to send answer strings |
| Prototype reviews (#212, #213) | `review-sonnet`, read-only | `NON_BLOCKING_ONLY` each; confirmed test weaknesses fixed in one fix round each (`code`) |
| ADR reviews (0016, 0017) | `review` (OpenAI `gpt-6.1-sol`) and a Claude `reviewer` subagent | `BLOCKING_FINDINGS` on both from both |
| ADR re-reviews | `review`, read-only | `BLOCKING_FINDINGS` on both (new findings); closed in a second revision each, no third review |
| #210 live runs | `code-deepseek` on both writers | seven runs, two format follow-ups, 9 of 12 worker turns |
| #214 live runs | headless `claude -p` and `codex exec`, each with two `explore-fast` workers | one run per client, both exit 0 |
| Evaluation review (#210, #214) | `review`, read-only | `NON_BLOCKING_ONLY`, four low findings, all fixed |
| Specs, plan, ADR text, records, integration | controller (Claude Code, Opus 5.5) | |

Each writer task had its own branch. The controller reviewed every diff,
re-ran the tests on the host, integrated by cherry-pick, and was the only
editor of the records.

## Progress log

- **Verdict tokens** (`614a8db`).
- **#212.**
  - Prototype `e30c3c2`, review, then fix round `cdd63bc`.
  - Two mutations each left all tests green before the fix round, and each
    fails one test after it.
  - Proposed ADR `d32a5fc`, revised `f0ec8fa`.
- **#210 validator** (`e6af800`): 33 fixtures.
- **#214 fixtures** (`b23d979`): seven tests against the real registry.
- **Pre-registrations** (`80a11f0`) of both live evaluations, before the
  first model turn, plus the retrospective of recorded report outcomes.
- **#213.**
  - Prototype `374050b` and `554dd61`, review, then fix round `c248bf1`.
  - Fix round mutations: 6, 6 and 1 tests fail.
  - Proposed ADR `694b4f9`, revised `ac57cce`.
- **#210 live runs.**
  - Runs A and B first, then the amendment `f37e4f5`, then C and B text 2.
    Recorded in `9b99766`.
  - Controller deviation: in run B text, the session was closed before its
    report was validated. The amendment records it and adds run B text 2,
    which reproduced the same `commit_missing` failure and resolved it with
    one follow-up.
- **#214 live runs**, recorded in `659c69c`.
- **ADR reviews.** Both reviews returned `BLOCKING_FINDINGS` on both ADRs.
  The controller checked each finding against the code or with Git before
  revising. The decisive checks:
  - With Git 2.56.0, a fetch without `+` fast-forwarded an existing ancestor
    ref. ADR 0016 now fetches objects only, then creates the refs with
    `update-ref`.
  - The re-review found that `create` follows a dangling symbolic ref
    without `--no-deref`, which Git confirmed, and that a ref transaction
    is not crash-atomic. The second revision uses `--no-deref`, makes the
    manifest ref the completion marker, and reports incomplete slots.
  - The relay turns an inner refusal into `prompt_rejected` and drops an
    abort reason. ADR 0017 now passes both through, and only the owning
    server arms the deadline.
  - The ADR 0017 re-review found that the public `abort()` waits for the
    snapshot lease check inside its abort deadline (confirmed at
    `session-registry.ts:240-254`). The second revision bounds only the
    adapter abort and makes the timing statement conditional on a resolved
    abort.
- **Evaluation review** (`review`): `NON_BLOCKING_ONLY`. All four findings
  were fixed (`9999327`, `a4fa207`):
  - the reported values are now oracle fields, not worker text;
  - six of the seven #214 fixtures use the registry, not all seven;
  - the retrospective no longer claims the reports were well-formed;
  - the run intervals are recorded against the shared budget.

  The reviewer called #210 defer defensible. The strongest contrary reading
  was reject, which the rule does not support from one `status_missing`.
- **Record corrections.**
  - The #213 run 1 worker was `code-terra`, not `code` (`a0839e6`).
  - The Sprint 17 row of the retrospective now counts the #213 fix round:
    8 tasks, 49 in total.

## Gates

These ran on the host at `f0ec8fa`. Every later commit changes only
documentation. Node `v26.12.1`, Git `2.56.0`.

- `npm run typecheck`: exit 0.
- `npm run build`: exit 0.
- `NODE_OPTIONS=--unhandled-rejections=strict npm test`: exit 0, with 153
  files and 4357 tests passed, 14 skipped.

## Not done

- No ADR implementation. Both ADRs stay `Proposed` until the maintainer
  decides.
- No Podman run of the recovery script, and no real-provider run of the
  deadline. Both are listed as limits in their records.
- Controller context compaction with a pending question (#214) cannot be
  triggered headless and is untested.

## Follow-up issues

- [#222](https://github.com/plagor44-ux/pi-session-mcp/issues/222): quote
  `safe.directory=*` in `BOUNDARY_GIT`, and refuse a writer clone whose
  configuration defines a filter driver or an include. First, verify whether
  a worker can write those keys (ADR 0016 section 7).
- [#223](https://github.com/plagor44-ux/pi-session-mcp/issues/223): in the
  controller skill, bound `NEEDS_CONTEXT` rounds, rule out stale answers, and
  ask for the bare commit hash (#214 and #210).
- [#224](https://github.com/plagor44-ux/pi-session-mcp/issues/224):
  `pi_session_abort` on a snapshot session can answer `abort_timeout` after
  a successful abort. The lease check counts against the abort deadline;
  this was found in the ADR 0017 re-review.

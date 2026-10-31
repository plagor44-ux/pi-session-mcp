# Retrospective: recorded worker-report outcomes, Sprints 10 to 17

This is a count of **recorded cases**, not a rate. The sprint records mention
a status token for only a few tasks; the absence of a recorded format failure
does not show that a report was compliant. Input for #210 (structured worker
reports versus the text `STATUS` contract).

Sources: `docs/sprints/` records of Sprints 10 to 16 and `docs/acceptance.md`
entries from 2026-10-26 on (the `STATUS` contract was introduced in S10-2,
`docs/sprints/2026-10-26-s10-orchestration-reliability.md:97-99`), plus this
sprint's controller ledger. A Claude subagent read the sources and drafted the
count; the controller checked the cited lines for every BLOCKED, early-stop
and failed case below against the files.

Counting: a task is one unit delegated to a Pi session (implementation, fix
round, review, plan, probe); same-session follow-ups and a fresh session that
continues failed work count with the original task. Claude subagents, agy and
acceptance-harness sessions (Level 3 cycles, live probes) are not counted as
tasks.

## Summary

| Sprint | Tasks | Format repair | Early stop (firm / borderline) | BLOCKED | NEEDS_CONTEXT | False success (firm / borderline) | Failed turn, no report |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | 3 | 0 | 0 / 0 | 0 | 0 | 0 / 0 | 0 |
| 11 | 9 | 0 | 0 / 0 | 0 | 0 | 0 / 1 | 2 |
| 12 | 7 | 0 | 0 / 0 | 0 | 0 | 0 / 0 | 0 |
| 13 | 4 | 0 | 0 / 0 | 0 | 0 | 0 / 1 | 0 |
| 14 | 7 | 0 | 1 / 0 | 2 | 0 | 0 / 1 | 1 |
| 15 | 5 | 0 | 0 / 1 | 1 | 0 | 0 / 0 | 1 |
| 16 | 6 | 0 | 0 / 1 | 1 | 0 | 0 / 1 | 0 |
| 17 (this sprint, before the live comparison) | 7 | 0 | 1 / 0 | 1 | 0 | 0 / 0 | 0 |
| **Total** | **48** | **0** | **2 / 2** | **5** | **0** | **0 / 4** | **4** |

## Cases

Early stops and BLOCKED:

- S14 B (`code-terra`): first turn `BLOCKED` after 28 s with no change, which
  the record calls an early stop; one narrower follow-up produced the change
  but reported `BLOCKED` because `npm ci` ran out of space, so no check ran;
  the controller completed it
  (`docs/sprints/2026-10-30-s14-sandbox-resource-limits.md:102-106`).
- S15 #211 (`code-terra`): first turn `BLOCKED` on an incomplete
  `node_modules`; delivered after a follow-up allowed `npm ci`
  (`docs/sprints/2026-10-31-s15-completion-kind-review-snapshots.md:64-67`).
  Borderline early stop: runtime not recorded.
- S16 T2 (`code-terra`): `BLOCKED` on a design question (guardian coverage of
  direct Git calls); the controller decided, the follow-up delivered
  (`docs/sprints/2026-10-31-s16-review-snapshots.md:54-58`). The blocker
  needed a controller decision, which `NEEDS_CONTEXT` would have expressed.
- S16 T3: first turn stopped after the guard only; follow-up delivered
  (`docs/sprints/2026-10-31-s16-review-snapshots.md:38`). Borderline early
  stop: status and runtime not recorded.
- S17 #213 (`code`): first turn `BLOCKED` because the worker read the
  boundary rule as forbidding host Git in a test fixture; clarified in the
  same session. The next turn ended after about 70 s with only the fixture
  extracted (early stop); one follow-up restating the goal produced the
  prototype (controller ledger of this sprint).

Failed turns without a report: S11 T1 and T4 first attempts (`failed`
during an OAuth credential rewrite, fixed as #142,
`docs/sprints/2026-10-26-s11-orchestration-gaps.md:70-77`); S14 R2
(`turn_failed` after 6 min); S15 third-family review (two starts ended
`turn_failed` in under a second). None is a format failure.

Borderline false success (the worker's own claim is not recorded, so none is
firm): S11 T5 README overstatements, S13 T2 test that did not pin its claim,
S14 C two tests that did not prove their claim, S16 T1 two defects fixed by
the controller after a follow-up for missing tests. Each was found by the
controller's verification or a cross-family review, not by the report shape.

## Observations

- No recorded format repair and no recorded `NEEDS_CONTEXT` in 48 tasks. The
  only firm problems with reports are early stops and `BLOCKED` turns, each
  resolved by one follow-up or taken over by the controller.
- The defects that mattered were wrong or weak work behind a well-formed
  report. A receipt would not have caught them; only the independent
  verification did.
- Most records do not state the status token, so this retrospective cannot
  rule out unrecorded format repairs. Pre-sprint evaluation runs mention
  receipt failures and status spelling issues without counts
  (`docs/sprints/2026-10-26-s10-orchestration-reliability.md:35-38`); they are
  excluded here.

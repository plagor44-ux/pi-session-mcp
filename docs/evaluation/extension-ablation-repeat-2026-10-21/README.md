# Extension ablation repeat: pi-lens on `code` with three replicates

Status: final. This report covers the repeat of the `pl-code` pairing
(plan `docs/superpowers/plans/2026-10-21-extension-ablation-repeat.md`, spec
amendments R90 and R92). Every number comes from `evidence/` (`summary.json`,
`runs/*.json`, `ledger.json`, `integrity.json`, `approvals/`), written at commit
`c9da9cb`. Setup and dry load are in [`setup.md`](setup.md).

## Summary for the operator

- **Recommendation: inconclusive.** Each arm solves all three tasks by the
  majority rule (A 3 of 3, B 3 of 3), so B is not better on any task, and B
  costs 1.47 times as much as A. With pi-lens, arm B was accepted in one more
  run than arm A (8 of 9 against 7 of 9). Under the pre-registered rule that
  extra run on `i-task-6` changes no task outcome.
- The indicative "enable" of the first wave (A 2/3, B 2/3, B cheaper, decided
  by one timeout) does not hold up: over three replicates, B is not cheaper.
- **Keep production as it is.** `code` runs without pi-lens today, and this
  evidence gives no reason to change that.
- Spend: USD 8.32 of the USD 10 hard budget (ledger `spentUsd` 8.3231724): 18
  scored runs for USD 8.319 and one preflight PONG for USD 0.004. No run was
  stopped by the trace audit, the budget or a timeout.

## Method

As in the first wave
([`../extension-ablation-2026-10-20/README.md`](../extension-ablation-2026-10-20/README.md)),
with these differences:

- Pairing `pl-code` only: profile `code` (openai `gpt-6.1-sol`, thinking
  medium, OAuth refreshed on the host before each run, R86). Arm A has no
  extension and arm B has `pi-lens@4.4.3`.
- The three pre-registered implementation tasks of the first wave
  (`i-task-5`, `i-task-6`, `i-task-7`, same tasks file and oracles).
- Three replicates per task and arm (R90): 18 runs, in replicate order. The
  A/B order per task alternates within a replicate and flips between
  replicates. Run ids end in `-r1` to `-r3`.
- Decision rule (R92, owner decision 2026-10-21): an arm solves a task when at
  least 2 of its 3 runs are accepted. A task counts only when both arms have all
  three runs scored. The pre-registered rule is applied to the per-task
  outcomes: B solves at least as many tasks as A, is strictly better on at
  least one task, and B's cost over the counted tasks is at most 1.25 times A's.
  If B solves fewer tasks, the result is do-not-enable; otherwise it is
  inconclusive.
- A new ledger with one wave, run in two chunks (`--max-runs 9`, then
  `--resume`) under one owner approval (USD 10, budget stop).

## Results per task

| Task | A accepted | B accepted | A solves | B solves | Cost A, USD | Cost B, USD |
| --- | --- | --- | --- | --- | --- | --- |
| `i-task-5` | 3 of 3 | 3 of 3 | yes | yes | 2.372 | 3.031 |
| `i-task-6` | 2 of 3 | 3 of 3 | yes | yes | 0.612 | 1.345 |
| `i-task-7` | 2 of 3 | 2 of 3 | yes | yes | 0.387 | 0.572 |
| **Total** | 7 of 9 | 8 of 9 | 3 tasks | 3 tasks | 3.371 | 4.948 |

All three tasks counted and the pairing is complete. Cost ratio B/A: 1.47
overall; per task 1.28 (`i-task-5`), 2.20 (`i-task-6`) and 1.48
(`i-task-7`). Cache-read share: A 0.943, B 0.943.

## Every run

| Run | Task | Arm | Rep. | Accepted | Duration, s | Cost, USD | Output tokens | Unexpected connects |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 007 | `i-task-5` | A | 1 | yes | 611 | 0.786 | 20817 | 0 |
| 008 | `i-task-5` | B | 1 | yes | 813 | 1.081 | 26108 | 0 |
| 009 | `i-task-6` | B | 1 | yes | 324 | 0.316 | 6629 | 9 |
| 010 | `i-task-6` | A | 1 | yes | 257 | 0.260 | 5516 | 1 |
| 011 | `i-task-7` | A | 1 | yes | 317 | 0.155 | 5603 | 1 |
| 012 | `i-task-7` | B | 1 | yes | 508 | 0.292 | 9219 | 1 |
| 042 | `i-task-5` | B | 2 | yes | 625 | 0.964 | 19419 | 0 |
| 043 | `i-task-5` | A | 2 | yes | 660 | 0.868 | 22575 | 0 |
| 044 | `i-task-6` | A | 2 | no | 27 | 0.086 | 551 | 0 |
| 045 | `i-task-6` | B | 2 | yes | 329 | 0.348 | 6268 | 9 |
| 046 | `i-task-7` | B | 2 | no | 28 | 0.054 | 501 | 0 |
| 047 | `i-task-7` | A | 2 | no | 23 | 0.048 | 492 | 0 |
| 077 | `i-task-5` | A | 3 | yes | 553 | 0.718 | 20236 | 0 |
| 078 | `i-task-5` | B | 3 | yes | 664 | 0.986 | 23024 | 0 |
| 079 | `i-task-6` | B | 3 | yes | 359 | 0.681 | 6268 | 9 |
| 080 | `i-task-6` | A | 3 | yes | 257 | 0.265 | 5330 | 9 |
| 081 | `i-task-7` | A | 3 | yes | 357 | 0.185 | 6801 | 1 |
| 082 | `i-task-7` | B | 3 | yes | 397 | 0.227 | 7188 | 1 |

Every run ended with terminal `completed`. No accepted run has an out-of-scope
change.

## The three rejected runs: early stops

Runs 044, 046 and 047 (two in arm A, one in arm B, all in replicate 2) each
ended after 23 to 28 seconds with about 500 output tokens. Their tests did not
pass, and their only connects were the five of the provider session. The worker
ended its turn before implementing anything. The records keep only a hash of
the assistant text, so the reason is not recorded. The first wave had the same
pattern once (run 012 there, `i-task-7` arm B, 45 seconds). These early stops
hit both arms, which is consistent with a property of the `code` route on these
tasks rather than of pi-lens. They decide the per-run counts: without them both arms would have
accepted every run.

## Network activity outside the task

Unexpected connects as counted in `summary.json`: A 12, B 29. They are the same
two kinds of address as in the first wave, and only the two pynode-app tasks
have them:

- `127.0.0.1` port 5544, the pynode-app test Postgres port, reachable because
  the sandbox shares the host network namespace. It appears once in every pynode-app
  run of both arms except the three early stops.
- The Fastly CDN that serves PyPI on port 443 (`151.101.{0,64,128,192}.223` and
  four `2a04:4e42:...::223` IPv6 addresses): in all three arm B runs of
  `i-task-6` and in one arm A run (080). As in the first wave, a worker
  tried to reach PyPI from the shared network namespace. The offline variables
  (R73) cover uv but not `pip`.

The trace audit recorded no outside write, unresolved write or unresolved
egress in any run. Denied write attempts are 0 except in four `i-task-7`
runs, in both arms: 1,050 in run 011 (A), 1,386 in run 012 (B), 1,050 in run
081 (A) and 1,050 in run 082 (B). As in the first wave, these are writes the
kernel refused (`EROFS`, read-only mounts), most likely bytecode caches on the
read-only Python runtime (likely, not proven). They are not out-of-scope
writes and are not attributed to pi-lens.

## What the repeat changes

- The first wave's `pl-code` "enable" rested on one timeout (arm A on
  `i-task-5`) and one early stop (arm B on `i-task-7`). In the repeat,
  arm A solves `i-task-5` in all three runs, and early stops hit both arms.
- On these tasks pi-lens neither raises the task-level success of `code` nor
  saves cost. Arm B costs more on every task: on `i-task-5` through longer
  sessions (34 to 44 messages against 26 to 33 in arm A), on `i-task-6`
  mostly through run 079, whose uncached input (262,311 tokens against 70,748
  in run 045, with the same output) doubled its cost.
- Three replicates on three tasks are still a small sample. The result settles
  the indicative "enable" as not supported, but gives no estimate of a small
  effect either way.

## Deviations and notes

- The template's `package-lock.json` hash differs from the first wave's
  (`01457bdb…` against `12493eaf…`). The top-level versions are equal, and npm
  re-resolved transitive packages within their ranges (see `setup.md`).
- The evidence is bound to commit `c9da9cb` with no source drift
  (`integrity.json`). Later commits change documentation only.

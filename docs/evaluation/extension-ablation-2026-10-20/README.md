# Extension ablation: pi-lens and pi-cache-optimizer on the worker profiles

Status: final. This report covers the extension ablation of 2026-10-21 and
keeps the pre-registration text (marked below) next to the results. Every number
in the results comes from `evidence/` (`summary.json`, `runs/*.json`,
`ledger.json`, `integrity.json`, `approvals/`). The evidence was written at
commit `8cec42c`; later commits change documentation and code comments only.

Scope: one run per task and arm, so the results are indicative, not
significant. No saving, ranking or success rate beyond the observed one is
claimed. The wave ended on the USD 10 budget stop with 15 of 35 planned runs
scored, so some pairings have no data.

## Summary for the operator

- Observed spend was USD 8.34 of the USD 10 hard budget (ledger `spentUsd`
  8.33870414). The 15 scored runs cost USD 7.93, the stopped attempts USD 0.33
  and the 23 preflight checks (six rounds, see "Every attempt") USD 0.07.
- Recommendations apply to the implementation pairings only (ruling R83):
  `pl-code-deepseek` is **do-not-enable** (A 3/3 accepted, B 2/3), `pl-code` is
  **enable** by the pre-registered rule (A 2/3, B 2/3, B cheaper). Both verdicts
  hinge on a single timeout or early stop.
- Review pairings are descriptive only and get no recommendation. `co-code` and
  `co-review` (pi-cache-optimizer) never ran, so this evaluation has no data on
  pi-cache-optimizer.
- **Do not change production profiles on this evidence alone.** If pi-lens on
  `code` is of interest, repeat the code pairing with more than one run per
  task.

Only the three implementation tasks decide recommendations, for
`pl-code-deepseek`, `pl-code` and `co-code`. The four review tasks run and are
scored, but the review pairings (`pl-review-grok`, `pl-review`, `co-review`) are
reported descriptively (ruling R83, owner decision 2026-10-21): critical hits,
verdict matches, recall, runs with a false finding and oracle acceptance as
information, plus cost, cache-read share and network.

## Method

- A/B per task: arm A runs without the extension, arm B with it (`pi-lens@4.4.3`
  or `pi-cache-optimizer@2.9.3`).
- The task's first prompt is replayed verbatim on a disposable clone at the base
  commit.
- Each run executes in a bubblewrap sandbox under `strace`; the trace audit
  stops a run on an outside write, an unresolved write or unresolved egress.
- Deterministic oracles score the result (see the pre-registered sections
  below).
- USD 10 hard budget, counted as catalog cost from measured usage; run timeout
  15 minutes; parallelism 1.

Routes and credential types (`authType` from the run records):

| Profile | Provider and model | Thinking | Credential |
| --- | --- | --- | --- |
| `code`, `review` | openai `gpt-6.1-sol` | medium (code), high (review) | OAuth subscription, refreshed on the host before each run (R86) |
| `code-deepseek` | deepseek `deepseek-flash` | high | API key |
| `review-grok` | xai `grok-4.7` | high | OAuth, refreshed on the host (R86) |

## Every attempt

The top-level `approval*.json` files next to this README are the owner-approved
originals; `evidence/approvals/` holds the integrity-bound copies.

Four approvals (waves) were given on 2026-10-21, at 12:39, 13:22, 13:46 and
14:39 UTC, each bound to its own source commit; the tasks digest is the same in
all four. Six approvals were drawn up in total; two were superseded before their
wave started and are not kept in `evidence/approvals/`:

- The wave 2 approval at commit `3b7b845`: its preflight charged three routes,
  and `review-grok` failed with `credential_expiring` (no charge). That failure
  was the trigger for the host-side OAuth refresh (R86). The approval was redone
  after the fix (the kept approval 2 is bound to `56579b4`).
- The approval 4 first drawn up at commit `c9cfbb3`: it was preflighted and then
  redone at `a72dfea`, which is the kept approval 4.

The ledger therefore holds six preflight rounds, 23 charged checks in total
(4 + 3 + 4 + 4 + 4 + 4 across the four routes `code`, `code-deepseek`, `review`
and `review-grok`; the second round is the failed one) with a combined cost of
USD 0.071. Preflight cost is part of the USD 8.34 spend and is not part of any
run.

Run ids below are abbreviated to their ordinal; the arm column shows A (without
the extension) or B (with it; pi-lens in all scored runs).

### Scored runs (15)

| Run | Task | Profile | Arm | Accepted | Terminal | Duration | Messages | Catalog cost (USD) | Score |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 001 | `i-thoth-dms` | `code-deepseek` | A | yes | completed | 7:40 | 95 | 0.152 | accepted |
| 002 | `i-thoth-dms` | `code-deepseek` | B | yes | completed | 8:54 | 79 | 0.135 | accepted |
| 003 | `i-spng-authz` | `code-deepseek` | B | yes | completed | 5:06 | 49 | 0.064 | accepted |
| 004 | `i-spng-authz` | `code-deepseek` | A | yes | completed | 3:38 | 30 | 0.052 | accepted |
| 005 | `i-spng-pdf` | `code-deepseek` | A | yes | completed | 9:06 | 52 | 0.074 | accepted |
| 006 | `i-spng-pdf` | `code-deepseek` | B | no | timeout (provider error `other`) | 14:01 | 45 | 0.076 | no oracle score |
| 007 | `i-thoth-dms` | `code` | A | no | timeout | 14:00 | 29 | 0.908 | no oracle score |
| 008 | `i-thoth-dms` | `code` | B | yes | completed | 13:48 | 27 | 0.867 | accepted |
| 009 | `i-spng-authz` | `code` | B | yes | completed | 5:59 | 26 | 0.307 | accepted |
| 010 | `i-spng-authz` | `code` | A | yes | completed | 4:43 | 25 | 0.263 | accepted |
| 011 | `i-spng-pdf` | `code` | A | yes | completed | 6:54 | 18 | 0.183 | accepted |
| 012 | `i-spng-pdf` | `code` | B | no | completed | 0:45 | 4 | 0.058 | tests failed |
| 013 | `r-psm-smoke` | `review-grok` | A | no | completed | 13:19 | 24 | 1.089 | critical 1/2, verdict missed, recall 0.4 |
| 014 | `r-psm-smoke` | `review-grok` | B | no | completed | 11:52 | 24 | 1.043 | critical 2/2, verdict missed, recall 0.6 |
| 015 | `r-thoth-gates` | `review-grok` | B | yes | completed | 11:02 | 64 | 2.661 | critical 1/1, verdict matched, recall 0.6 |

"Accepted" for review runs (013 to 015) is what the keyword oracle computed; it
is information, not an outcome (ruling R83). Run 015 has no arm A counterpart:
its arm A run (016) was the budget stop.

### Stopped attempts

Three attempts were stopped by the trace audit with `unresolved_egress` before
producing a scored record, and the wave ended on the budget stop (`waveStops`):

| Wave | Run | Stop reason | Charged to the ledger (USD) |
| --- | --- | --- | --- |
| 1 | 001 | `unresolved_egress` | 0.105 |
| 2 | 001 | `unresolved_egress` | 0.177 |
| 3 | 005 | `unresolved_egress` | 0.053 |
| 4 | 016 | `budget` | not started, no charge |

Run 001 was charged three times (the two audit-stopped attempts and the scored
run: 0.105 + 0.177 + 0.152 = 0.434) and run 005 twice (the audit-stopped attempt
and the scored run: 0.053 + 0.074 = 0.127). Audit-stopped slots were planned
again at the next approval (R85; `replannedStopped` in approvals 2, 3 and 4).
The budget stop at run 016 followed the USD 2.66 charge of run 015.
`stopReason` in `summary.json` is `null` because the merged `not_run` records
come from the earliest wave; the budget stop is recorded in `waveStops` (wave 4,
run 016).

### Runs that never ran (20)

Runs 016 to 035 have the outcome `not_run`:

- 13 review runs: 016 to 020 (`review-grok` on `r-thoth-gates` arm A,
  `r-spng-authz` and `r-spng-chat`) and 021 to 028 (`review`, all four review
  tasks, both arms).
- 3 `co-code` runs: 029 to 031 (`pi-cache-optimizer` arm B on the three
  implementation tasks).
- 4 `co-review` runs: 032 to 035 (`pi-cache-optimizer` arm B on the four review
  tasks).

## Results per pairing

Costs and acceptance count scored runs of the paired tasks only. Cache-read share
is cache-read tokens divided by input plus cache-read tokens, pooled per arm over
the paired runs (`cacheReadShare` in `summary.json`).

| Pairing | Scored (A / B) | Accepted (A / B) | Catalog cost, USD (A / B) | Cache-read share (A / B) | Unexpected connects (A / B) | Recommendation |
| --- | --- | --- | --- | --- | --- | --- |
| `pl-code-deepseek` | 3 / 3 | 3 / 2 | 0.277 / 0.275 | 98.4% / 98.3% | 18 / 18 | do-not-enable |
| `pl-code` | 3 / 3 | 2 / 2 | 1.355 / 1.233 | 94.3% / 93.7% | 2 / 9 | enable |
| `pl-review-grok` | 1 / 1 (paired) | descriptive | 1.089 / 1.043 | 91.5% / 83.5% | 0 / 0 | descriptive |
| `pl-review` | 0 / 0 | not run | 0 / 0 | n/a | 0 / 0 | descriptive, no data |
| `co-code` | 0 / 0 | not run | 0 / 0 | n/a | 0 / 0 | not-run |
| `co-review` | 0 / 0 | not run | 0 / 0 | n/a | 0 / 0 | descriptive, no data |

### pl-code-deepseek: do-not-enable

A accepted 3 of 3, B accepted 2 of 3. The only difference is B's timeout on
`i-spng-pdf` (run 006, terminal `timeout`, provider error `other`, 14:01). Cost
is the same (USD 0.277 against 0.275) and so is the cache-read share. Under the
pre-registered rule this is do-not-enable, but it rests on one timeout in one
run.

### pl-code: enable (pre-registered rule)

A accepted 2 of 3, B accepted 2 of 3. B was better on `i-thoth-dms`, where A
timed out (run 007) and B completed and was accepted (run 008, 13:48). B was
worse on `i-spng-pdf`, where it gave up after 4 messages and 0:45 (run 012,
tests failed) while A was accepted (run 011). B cost USD 1.233 against 1.355 for
A. Both the "enable" verdict and the tie in acceptance hinge on a single timeout
and a single early stop. A repeat with more than one run per task is needed
before any production change.

### Review pairings: descriptive only

No verdict is given (ruling R83). The only paired review task is `r-psm-smoke`
on `review-grok`:

| Arm | Critical hits | Verdict matched | Recall | False-finding runs | Cost (USD) | Cache-read share |
| --- | --- | --- | --- | --- | --- | --- |
| A | 1 of 2 | no | 0.4 | 0 | 1.089 | 91.5% |
| B (pi-lens) | 2 of 2 | no | 0.6 | 0 | 1.043 | 83.5% |

Neither arm matched the verdict, so the oracle did not accept either run. Run
015 (`r-thoth-gates`, `review-grok`, arm B only) hit its one critical finding
(1 of 1), matched the verdict, had recall 0.6 and cost USD 2.661; it has no
counterpart and is not part of any pairing total. `pl-review` and `co-review`
have no scored runs.

### co-code and co-review (pi-cache-optimizer)

Not run. Runs 029 to 035 were cut off by the budget stop, so there is no data on
pi-cache-optimizer acceptance, cost or cache behavior from this wave.

### Deviation from the pre-registered trim and run order

The pre-registration said that `--trim` within USD 10 keeps only
`pl-code-deepseek`. The owner instead approved the full priority-ordered list
with the wave's USD 10 budget stop as the only limit (in-session decision,
2026-10-21). The run order follows the pre-registered priority and was not
changed after the review tasks became descriptive (R83). Eight `review-grok`
slots (runs 13 to 20) therefore sat before the decisive `co-code` arm-B slots
(runs 29 to 31). Three `review-grok` runs cost USD 4.79 (2.661 + 1.089 + 1.043),
and the budget stop came before `co-code` ran. A repeat should reorder the runs
or use `--pairings`.

## Cost against the pre-registered estimate

The estimate was USD 1.00 per run. Observed cost per scored run was USD 0.05 to
0.15 on `code-deepseek`, USD 0.06 to 0.91 on `code` and USD 1.04 to 2.66 on
`review-grok`. The review-grok runs exhausted the budget before the `review` and
pi-cache-optimizer runs could start.

## Network activity outside the task

Unexpected connects as counted in `summary.json`: `pl-code-deepseek` 18 in arm A
and 18 in arm B, `pl-code` 2 in arm A and 9 in arm B, `pl-review-grok` 0 in both
arms. Per run, a run with 9 connects (003, 004, 005, 006, 009) shows the
loopback address plus eight public addresses; runs 010 and 011 show the loopback
address only. No other run shows an unexpected connect.

Destinations seen in the records:

- `127.0.0.1` port 5544: the smartpaper-ng test Postgres port, reachable because
  the sandbox shares the host network namespace.
- Fastly addresses on port 443 (`151.101.0.223`, `151.101.64.223`,
  `151.101.128.223`, `151.101.192.223` and four `2a04:4e42:...::223` IPv6
  addresses): addresses of the Fastly CDN that serves PyPI. The records show
  destination and port only, so the purpose (most likely package installs by the
  worker) is an inference.

Both occur in both arms. No destination is specific to an extension. Outside
writes, unresolved writes and unresolved egress are 0 in every scored run. Denied
write attempts are 0 except in three `i-spng-pdf` runs: 1,722 in run 005, 2,097
in run 006 and 1,050 in run 011. These are writes the kernel refused (`EROFS`,
read-only mounts). The dependency venv mount lies under the scope root, so
refused writes there are not counted as denied; the counted attempts are at
paths outside the allowed roots. The most likely source is the read-only Python
runtime bound at its own path under the evaluation directory, where Python
tried to write bytecode caches (likely, not proven). They are not out-of-scope
writes and are not attributed to an extension; they occur in both arms.

## What happened during the wave

The three audit stops were false positives with two causes. Each was diagnosed
from the kept `strace` line and fixed before the next wave:

1. Waves 1 and 2, run 001: `unresolved_egress` from the codegraph MCP server's
   connection to its daemon socket (`/tmp/codegraph-<hash>.sock`) in the
   sandbox's private `/tmp`. The wave 2 diagnostics line evidences it; wave 1
   had no diagnostics yet (R84 came after) but stopped the same run on the same
   single event, so the cause is the same, evidenced in wave 2. Fixed by R87:
   sockets there are internal to the sandbox.
2. Wave 3, run 005: six abstract-socket connects, five to the smartpaper-ng PDF
   renderer's own IPC (`@mail-pdf-<hex>`) and one to the docker CLI's plugin
   socket (`@docker_cli_<hex>`), all created by the task's own code. Fixed by
   R88: abstract sockets that the trace itself bound are internal.

Wave 4 ended on the budget stop at run 016.

Fixes needed to keep going: audit stops keep their evidence
privately (R84), audit-stopped slots are planned again (R85), OAuth credentials
are refreshed on the host before each route and run (R86), and the report works
across waves run at different commits (R89). Because the harness was fixed
between waves, the evidence aggregates runs scored at four source commits; the
bound files that changed since each wave's source commit are listed per wave in
`evidence/integrity.json` (`source_drift`; 18, 12, 7 and 3 bound paths for waves
1 to 4).

## Documented limits

- Abstract Unix sockets stay reachable through the shared network namespace.
  They count as internal only when bound inside the same trace (R88).
- Loopback services are reachable and are only reported.
- The home directory is hidden and the root is read-only in the sandbox.
- R73 makes `go`, `uv` and `npm` fail fast offline in the sandbox; it sets
  nothing for `pip`. Workers reached the PyPI CDN (Fastly, port 443) from the
  sandbox in both arms, in runs 003, 004, 005, 006 and 009. This is real
  internet egress, reported but not a stop, by design.
- The turn timeout is the 15-minute run timeout minus 60 s, which leaves time
  for an orderly shutdown; this is why timed-out runs (006, 007) record about
  14:00.
- `providerError: "other"` counts as a scored failure (run 006).
- Preflights are untraced.
- Review oracles are keyword-based and descriptive only (ruling R83).
- The evidence aggregates runs scored at four commits; the source drift is
  listed in `evidence/integrity.json`.
- The ledger is identified by its id, not by its path, so exactly one ledger
  file must exist. Record writes need hard links on `$EVAL`.
- The 4-hour wave limit applies per invocation; the waves were resumed in chunks
  of 12 runs.
- One run per task and arm: a single timeout or early stop decides an
  implementation pairing's verdict.

## Recommendation for the operator

Do not change production profiles on this evidence alone. If pi-lens on `code`
is of interest, repeat the code pairing with more than one run per task.
pi-cache-optimizer remains unevaluated.

# Pre-registration (written before any measured run)

The sections below are the pre-registration as written at Task 10 and updated
after the oracle rework. They are kept as the record of what was fixed before
the wave.

## Tasks (pre-registered)

Pre-registered before any measured run. Values come from `tasks.json` in this
folder. Prompts are not tracked; they live under the ignored `eval/results/`, and
`tasks.json` carries each prompt's hash.

| id | kind | repo alias | base commit | source session | verdict gate | oracle summary |
| --- | --- | --- | --- | --- | --- | --- |
| `r-psm-smoke` | review | `pi-session-mcp` | `bdfb95de` | `9299a6ff` | yes | 5 findings, 2 critical, 2 false findings |
| `r-thoth-gates` | review | `thoth` | `8ed36fdd` | `35c08c30` | yes | 5 findings, 1 critical, 1 false finding |
| `r-spng-authz` | review | `spng-stab-int` | `a264c1a5` | `e6711afa` | yes | 7 findings, 3 critical, 2 false findings |
| `r-spng-chat` | review | `spng-stab-int` | `ae3b5e71` | `d050dadd` | yes | 5 findings, 2 critical, 2 false findings |
| `i-thoth-dms` | implementation | `thoth-w3` | `ab470131` | `0e6508fd` | n/a | repo inventory checker for dms plus issue-row checks |
| `i-spng-authz` | implementation | `spng-stab-int` | `8ac3b47b` | `92563767` | n/a | pytest of `tests/test_authz_core.py` from the solution commit, offline venv |
| `i-spng-pdf` | implementation | `spng-stab-b` | `203cfc07` | `0c770e50` | n/a | pytest of `tests/test_mail_pdf_diagnostics.py` from the solution commit, two tests that assert an internal code name deselected, offline venv |

`i-thoth-inv3` was dropped: its recorded first turn took 15 min 6 s, over the
15-minute run timeout. It was replaced by `i-spng-pdf` (the smartpaper-ng mail
PDF renderer), whose recorded first turn took 2 min 56 s.

## Selection (pre-registered)

283 candidate sessions were scanned from the operator's Claude Code transcripts.
Selection rules, from the spec:

- the first prompt is replayed verbatim;
- the outcome is unambiguous;
- the oracle is deterministic;
- the repository was already sent to both providers of each profile pair.

Implementation oracles fail at the base commit and pass with the original
solution, with scope clean.

Correlation: `r-spng-authz`, `i-spng-authz` and `i-spng-pdf` come from the same
product repository, and `r-spng-authz` and `i-spng-authz` touch the same code.
`r-thoth-gates` and `i-thoth-dms` share one repository.

## Review oracle (pre-registered)

The review oracle is descriptive only (ruling R83). Its design: a review counts
as accepted by the oracle only if it states the non-approving verdict its prompt
asks for (a pre-registered regular expression per task, linear patterns only) and
it hits every critical finding. False findings are reported, not decisive (ruling
R78). Acceptance is recorded as information and never decides a recommendation.

Calibration: for each review task the recorded first review is accepted. Empty,
generic and checklist-walking approval reviews (including approvals written by
an independent reviewer) are rejected. Correct reviews with "no finding" lines
are accepted. Non-approving reviews that argue a wrong defect are rejected.
There were 124 controls in total, all as expected. In addition, 39 held-out real
reviews from the operator's transcripts all gave the correct verdict match; the
patterns accept the real non-approving formats the models write (for example
"Verdict: blockers exist."). These figures are in-sample for the curator, who
tuned the oracle against them.

Behaviour on fresh text: after four curation rounds, the oracle accepted 11 of
18 fresh correct reviews written by an independent reviewer. The anchor set in
`tasks.json` was chosen because it scored best on that fresh set; a later
variant accepted 8. Fresh wrong-defect reviews that do not deny the real defect
were rejected; reviews that also deny the real defect in the oracle's own
wording can be accepted (see Limits). This non-convergence is why acceptance
cannot decide: the spec drops an oracle that needs judgment.

Timing: verdict patterns are linear and were timed on 89 adversarial 64 KiB
inputs per pattern (worst case 2.9 ms). The full review scoring was quadratic on
long lines (6.3 s on one 64 KiB line) and has been linear since commit b442979
(worst case about 90 ms on 25 adversarial 64 KiB texts, checked by a
differential fuzz against the old code).

### Limits

- The matcher is keyword-based and blind to negation.
- A non-approving review that denies a critical finding in the oracle's own
  positive claim wording can still be accepted; this was seen in probes for
  `r-psm-smoke`, `r-spng-authz`, `r-spng-chat` and `r-thoth-gates`.
  `r-thoth-gates` has a single critical finding and its prompt asks for a
  "checks with no finding" section, which makes this more likely there.
- `r-thoth-gates` counts "APPROVE WITH CHANGES" and "Approved with corrections"
  as non-approving, and plain "APPROVE" and "APPROVE WITH NITS" as approving.
- False findings fire on natural denials, which is why they are report-only.
- The `i-spng-pdf` oracle no longer checks the rule that an unknown child status
  is never success: the deselected tests assert an internal code name that the
  prompt leaves open.

## Matrix and projection (pre-registered estimate)

Initial estimate: 35 runs. At USD 1.00 per run the projection is USD 35.
`--trim` within USD 10 keeps only `pl-code-deepseek` (6 runs on the three
implementation tasks `i-thoth-dms`, `i-spng-authz` and `i-spng-pdf`). The
calibration in Task 11 replaces the estimate for the profiles it observes;
unobserved profiles keep the USD 1.00 estimate until calibrated.

Run order:

| Runs | Pairing |
| --- | --- |
| 1-6 | `pl-code-deepseek` |
| 7-12 | `pl-code` |
| 13-20 | `pl-review-grok` |
| 21-28 | `pl-review` |
| 29-35 | `pi-cache-optimizer` arms (`co-code`, `co-review`) |

Routes:

| Profile | Provider and model | Thinking |
| --- | --- | --- |
| `code`, `review` | openai `gpt-6.1-sol` | medium (code), high (review) |
| `code-deepseek` | deepseek `deepseek-flash` | high |
| `review-grok` | xai `grok-4.7` | high |

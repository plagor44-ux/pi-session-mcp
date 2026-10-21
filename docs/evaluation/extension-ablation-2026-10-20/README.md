# Extension ablation (draft, pre-registration)

Status: draft written at Task 10 and updated after the oracle rework. Task 12
completes it with results.

Scope of the recommendations (ruling R83, owner decision 2026-10-21): only the
three implementation tasks decide recommendations, for `pl-code-deepseek`,
`pl-code` and `co-code`. The four review tasks run and are scored, but the review
pairings (`pl-review-grok`, `pl-review`, `co-review`) are reported descriptively
and get no recommendation. The description covers critical hits, verdict
matches, recall, runs with a false finding and oracle acceptance as information,
plus cost, cache-read share and network.

## Tasks

Pre-registered before any measured run. Values come from `tasks.json` in this
folder. Prompts are not tracked; they live under the ignored `eval/results/`.

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

## Selection

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

## Review oracle

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
variant accepted 8. Fresh wrong-defect reviews were rejected. This
non-convergence is why acceptance cannot decide: the spec drops an oracle that
needs judgment.

Timing: verdict patterns are linear and were timed on 89 adversarial 64 KiB
inputs per pattern (worst case 2.9 ms). The full review scoring was quadratic on
long lines (6.3 s on one 64 KiB line) and has been linear since commit b442979
(worst case about 90 ms on 25 adversarial 64 KiB texts, checked by a
differential fuzz against the old code).

### Limits

- The matcher is keyword-based and blind to negation.
- A non-approving review that denies a critical finding in the oracle's own
  positive claim wording can still be accepted; this was seen in probes for
  `r-psm-smoke`, `r-spng-authz` and `r-thoth-gates`. `r-thoth-gates` has a single
  critical finding and its prompt asks for a "checks with no finding" section,
  which makes this more likely there.
- `r-thoth-gates` counts "APPROVE WITH CHANGES" and "Approved with corrections"
  as non-approving, and plain "APPROVE" and "APPROVE WITH NITS" as approving.
- False findings fire on natural denials, which is why they are report-only.
- The `i-spng-pdf` oracle no longer checks the rule that an unknown child status
  is never success: the deselected tests assert an internal code name that the
  prompt leaves open.

## Matrix and projection

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

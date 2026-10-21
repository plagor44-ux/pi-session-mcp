# Extension ablation (draft, pre-registration)

Status: draft written at Task 10 and updated after the oracle rework. Task 12
completes it with results.

## Tasks

Pre-registered before any measured run. Values come from `tasks.json` in this
folder. Prompts are not tracked; they live under the ignored `eval/results/`.

| id | kind | repo alias | base commit | source session | verdict gate | oracle summary |
| --- | --- | --- | --- | --- | --- | --- |
| `r-psm-smoke` | review | `pi-session-mcp` | `bdfb95de` | `9299a6ff` | yes | 5 findings, 2 critical, 2 false findings |
| `r-go-app-gates` | review | `go-app` | `8ed36fdd` | `35c08c30` | yes | 5 findings, 1 critical, 1 false finding |
| `r-pyng-authz` | review | `pyng-stab-int` | `a264c1a5` | `e6711afa` | yes | 7 findings, 3 critical, 2 false findings |
| `r-pyng-chat` | review | `pyng-stab-int` | `ae3b5e71` | `d050dadd` | yes | 5 findings, 2 critical, 2 false findings |
| `i-go-app-dms` | implementation | `go-app-w3` | `ab470131` | `0e6508fd` | n/a | repo inventory checker for dms plus issue-row checks |
| `i-pyng-authz` | implementation | `pyng-stab-int` | `8ac3b47b` | `92563767` | n/a | pytest of `tests/test_authz_core.py` from the solution commit, offline venv |
| `i-pyng-pdf` | implementation | `pyng-stab-b` | `203cfc07` | `0c770e50` | n/a | pytest of `tests/test_mail_pdf_diagnostics.py` from the solution commit, two tests that assert an internal code name deselected, offline venv |

`i-go-app-inv3` was dropped: its recorded first turn took 15 min 6 s, over the
15-minute run timeout. It was replaced by `i-pyng-pdf` (the pynode-app mail
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

Correlation: `r-pyng-authz`, `i-pyng-authz` and `i-pyng-pdf` come from the same
product repository, and `r-pyng-authz` and `i-pyng-authz` touch the same code.
`r-go-app-gates` and `i-go-app-dms` share one repository.

## Review oracle

A review is accepted only if it states the non-approving verdict its prompt asks
for (a pre-registered regular expression per task, linear patterns only) and it
hits every critical finding. False findings are reported, not decisive (ruling
R78).

Calibration: for each review task the recorded first review is accepted. Empty,
generic and checklist-walking approval reviews (including approvals written by
an independent reviewer) are rejected. Correct reviews with "no finding" lines
are accepted. Non-approving reviews that argue a wrong defect are rejected.
There were 101 controls in total, all as expected.

Verdict patterns were timed against 64 KiB adversarial texts; the worst case was
under 3 ms.

### Limits

- The matcher is keyword-based and blind to negation.
- A non-approving review that uses a task's exact defect words for the wrong
  conclusion can still hit a finding. `r-go-app-gates`, with a single critical
  finding, is the most exposed.
- False findings fire on natural denials, which is why they are report-only.
- The `i-pyng-pdf` oracle no longer checks the rule that an unknown child status
  is never success: the deselected tests assert an internal code name that the
  prompt leaves open.

## Matrix and projection

Initial estimate: 35 runs. At USD 1.00 per run the projection is USD 35.
`--trim` within USD 10 keeps only `pl-code-deepseek` (6 runs on the three
implementation tasks `i-go-app-dms`, `i-pyng-authz` and `i-pyng-pdf`). The
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

# Extension ablation (draft, pre-registration)

Status: draft written at Task 10. Task 12 completes it with results.

## Tasks

Pre-registered before any measured run. Values come from `tasks.json` in this
folder. Prompts are not tracked; they live under the ignored `eval/results/`.

| id | kind | repo alias | base commit | source session | oracle summary |
| --- | --- | --- | --- | --- | --- |
| `r-psm-smoke` | review | `pi-session-mcp` | `bdfb95de` | `9299a6ff` | 5 findings, 2 critical, 2 false findings |
| `r-go-app-gates` | review | `go-app` | `8ed36fdd` | `35c08c30` | 5 findings, 1 critical, 3 false findings |
| `r-pyng-authz` | review | `pyng-stab-int` | `a264c1a5` | `e6711afa` | 7 findings, 3 critical, 2 false findings |
| `r-pyng-chat` | review | `pyng-stab-int` | `ae3b5e71` | `d050dadd` | 5 findings, 2 critical, 2 false findings |
| `i-go-app-dms` | implementation | `go-app-w3` | `ab470131` | `0e6508fd` | repo inventory checker for dms plus issue-row checks |
| `i-go-app-inv3` | implementation | `go-app-w6` | `ab470131` | `635f1c51` | repo inventory checker for businessobjects, actions and task plus issue-row checks |
| `i-pyng-authz` | implementation | `pyng-stab-int` | `8ac3b47b` | `92563767` | pytest of `tests/test_authz_core.py` from the solution commit, offline venv |

## Selection

283 candidate sessions were scanned from the operator's Claude Code transcripts.
Selection rules, from the spec:

- the first prompt is replayed verbatim;
- the outcome is unambiguous;
- the oracle is deterministic;
- the repository was already sent to both providers of each profile pair.

Review oracles were calibrated against each original first-turn review. All four
reproduce the original outcome; empty and generic reviews are rejected.
Implementation oracles fail at the base commit and pass with the original
solution, with scope clean.

Correlation: `r-pyng-authz` and `i-pyng-authz` touch the same code, and the
three go-app tasks (`r-go-app-gates`, `i-go-app-dms`, `i-go-app-inv3`) share one
repository.

## Matrix and projection

Initial estimate: 35 runs. At USD 1.00 per run the projection is USD 35.
`--trim` within USD 10 keeps only `pl-code-deepseek` (6 runs on the three
implementation tasks). The calibration in Task 11 replaces the estimate for the
profiles it observes.

Routes:

| Profile | Provider and model | Thinking |
| --- | --- | --- |
| `code`, `review` | openai `gpt-6.1-sol` | medium (code), high (review) |
| `code-deepseek` | deepseek `deepseek-flash` | high |
| `review-grok` | xai `grok-4.7` | high |

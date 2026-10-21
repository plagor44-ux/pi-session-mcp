# Live pair L1 (L4): one real controller run per arm

Date: 2026-10-21. One operator-approved pair (smallest test of the
[live plan](../live-plan.md)): case L1 (task T1, the M1 read task with its
independent oracle), arm A (skill cadence, polling) and arm C (event bridge
with `asyncRewake`). This is **one pair**: it checks the critical assumption, it
is not a statistical comparison.

## Binding

- **Approval:** [`run/approval.json`](run/approval.json). The operator decided in the Claude Code session:
  - smallest test first;
  - an API key instead of a subscription OAuth token (the operator declined the token route);
  - bind to Claude Code 2.1.306, since the client had auto-updated from 2.1.303. Probe attempt 5 showed the same L3 behavior on 2.1.306;
  - raise the run cap to 3 after the first attempt failed;
  - run arm C despite the stop rule after arm A's oracle failure.
- **Controller:** Claude Code 2.1.306, `claude-sonnet-5-5`, API key read from an owner-only file and passed only to the child process. Fresh, empty client configuration; no user settings, hooks, plugins or session persistence.
- **Worker:** profile values of `explore-fast` (`openai` / `gpt-6-luna` / low), read-only, no skills, through the real `SdkPiSessionAdapter` behind `BridgedRegistry`, with the operator's existing Pi login.
- **Source:** runs 2 and 3 on `8d355cc`, run 1 on `cbbde55`; clean worktree, compiled build digest recorded per run.

## Runs

| Run | Arm | Outcome |
| --- | --- | --- |
| [01-L1-A](run/01-L1-A.json) | A | **failed attempt, kept.** The API rejected the key (HTTP 400: key not scoped to a workspace). Error after 215 ms, 0 tokens, 0 USD, no session started. The runner then waited for its 20-minute deadline: a harness defect, fixed in `8d355cc` (a result with no open session ends the run). |
| [02-L1-A](run/02-L1-A.json) | A | completed; all lifecycle checks true; **oracle FAIL** (worker answer wrong in `api-data-flow`, correct in `stale-doc-contradiction`) |
| [03-L1-C](run/03-L1-C.json) | C | completed; all checks true; oracle PASS |

A separate one-request diagnostic call on the controller route (same isolated
environment) confirmed the new key before run 2. It cost 0.006 USD.

## Measures (runs 2 and 3)

| | A (02) | C (03) |
| --- | ---: | ---: |
| Controller model requests (distinct assistant messages) | 8 | 7 |
| Running `pi_turn_get` polls | 2 | **0** |
| Terminal reads | 1 | 1 |
| `Bash` sleeps between polls | 3 | **0** |
| Wakes (`asyncRewake` exit 2 → new turn while idle) | 0 | 1 |
| Bridge event → next controller message | — | 1,756 ms |
| `result` events (client turns) | 1 | 2 |
| Input tokens not from cache (`input_tokens` + `cache_creation_input_tokens`) | 13,456 | 12,703 |
| Cache-read input tokens | 78,937 | 66,531 |
| Output tokens | 1,888 | 1,144 |
| Reported cost, `total_cost_usd` (cumulative per client session) | 0.0604 USD | 0.0498 USD |
| Wall time | 70 s | 29 s |
| Sessions closed, no leftover process, temp removed | yes | yes |
| Worker answer passes the T1 oracle | **no** | yes |

Notes on reading the numbers:

- Wall time is dominated by the worker's own run time, which differs between
  runs. It is not a controller effect.
- `total_cost_usd` is cumulative across the turns of one client session. The C
  run's two turns add up to the last value, which a check against the token
  ratios confirms. The result files also contain `total_cost_usd_sum`, which
  double counts in C. Use `total_cost_usd_last`.
- The `uncached_input_tokens` field in these result files used the Codex
  formula (input minus cached), which is wrong for Anthropic usage. The table
  uses `input_tokens + cache_creation_input_tokens`. The formula is corrected in
  the runner for later runs.
- Worker usage and cost are not measured.

## Against the pre-registered rules

- **Critical assumption (a woken real model reads once and does not poll):**
  held in this one run. The controller ended its turn after
  `pi_session_prompt`. The wake started a new turn. It read the terminal turn
  once, closed the session and checked the list, with no poll and no sleep.
- **Recommendation rule for product work** (quality in every pair, fewer
  requests, no higher uncached input): **not met.** Arm A's worker answer failed
  the oracle, so quality did not hold in this pair. C did use one request
  fewer, two polls and three sleeps fewer, slightly less uncached input and about
  18 % less reported cost. But one pair with a failed quality check cannot carry
  a product decision.
- The worker failure belongs to the worker route (`explore-fast`, a small model
  at low effort), not to either controller arm. The M1 A/B used `gpt-6.1-sol`
  at high effort for T1.

## Limits

One pair, one case, one client version and one controller model. Different
worker outcomes between the arms. No interactive or VS Code run. No question
round trip with a real model. No Codex.

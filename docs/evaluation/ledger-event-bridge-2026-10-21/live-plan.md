# Live measurement plan (L4)

**Status 2026-10-21:** the full matrix below is not approved and has not run.
The operator approved only the smallest test, one L1 pair, with these changes:
an API key (no subscription token), Claude Code 2.1.306, worker values of
`explore-fast`, and a cap of 3 runs. It ran; results are in
[`live/`](live/README.md). The pair did not meet the quality criterion, because
the worker answer failed in arm A.

Purpose: measure what the provider-free work cannot. Does a real Claude Code
controller model, woken by the event bridge (arm C), finish the same tasks with
fewer model requests and no more uncached controller input than with the current
skill cadence (arm A)? And does it answer a structured worker question
correctly? No existing approval covers this. The M1 approvals of 2026-10-18
covered a Codex route and do not apply.

## What the operator approves

One decision covers all of the following. Changing any item needs a new
decision.

| Item | Proposed value | Operator choice |
| --- | --- | --- |
| Source | the PR head of #104 at approval time, bound by commit and tree digest of `eval/bridge`, `src`, `skills` | |
| Controller | Claude Code CLI 2.1.303 exactly (refused on mismatch), `-p --input-format stream-json --output-format stream-json --verbose --include-hook-events`, fresh config dir, `--strict-mcp-config` (no registration change) | |
| Controller model and auth | `claude-sonnet-5-5`; auth route chosen by the operator (API key gives `total_cost_usd`, a subscription does not) | |
| MCP server | the evaluation bridge server in SDK mode: `BridgedRegistry` over the real `SdkPiSessionAdapter`, evaluation-only configuration with one synthetic workspace alias | |
| Worker profile | `explore-fast` (read-only, `openai` / `gpt-6-luna` / low), no extensions; the profile must exist unchanged | |
| Fixtures | synthetic read tasks copied into a disposable directory per run; independent oracle per case | |
| Matrix | 3 cases x 2 arms x 3 pairs in the order A/C, C/A, A/C = 18 controller runs, at most 24 worker sessions and 27 work turns, 0 automatic retries | |
| Budget | advisory 10 USD for the whole matrix plus the provider-side worker usage the operator accepts; stop rules below | |

## Cases

- **L1**: one read task (about 30–60 s worker time).
- **L2**: two independent read tasks started in parallel.
- **L3**: one read task whose prompt makes the worker call `ask_controller`
  once with a `select` question; the oracle checks that the controller's answer
  reached the worker's final report. In arm A no question channel exists, so
  L3/A uses the same fact given up front; L3 compares the question round trip
  only within arm C and reports it separately.

## Arms

- **A**: controller skill as on main; the controller polls with the skill
  cadence and consumes once.
- **C**: the same skill plus one paragraph: after `pi_session_prompt`, do not
  poll a running turn; wait for the `pi-bridge` wake; read a terminal turn once;
  answer a question with `eval_question_get` and `eval_question_answer`. The
  `asyncRewake` hook budget is the task budget.

## Measures (per run, from the client's own records)

`num_turns`; cumulative `input_tokens`, `cache_read_input_tokens`,
`cache_creation_input_tokens` and `output_tokens` from the stream-json `result`
event; `total_cost_usd` if the route reports it; MCP calls by tool; running
polls; first terminal reads; repeated terminal reads; wakes and wakes per event;
event-to-request delay; wall time; oracle result; cleanup (sessions closed, no
hook or server process left). Worker usage stays unknown unless the provider
reports it out of band.

## Decision rule (from the pre-registration)

C is recommended for product work only if quality holds in every pair and C
needs fewer controller model requests than A in every pair, without higher
uncached controller input (input minus cache read minus cache creation, plain
arithmetic) in the median. Otherwise the result is recorded and the current
procedure stays.

## Stop rules

Stop the wave on any content leak into an evidence file, a leftover process or
open session after a run, a controller version mismatch, an oracle failure in
both arms of one pair, two consecutive harness failures, or when the advisory
budget is reached. Failed attempts are preserved, not overwritten.

## Work still needed before approval

- A live runner for this matrix (the M1 harness drives Codex only; #89 q4 is
  the open Claude Code item). Reuse `eval/profiles` evidence binding and the
  bridge server; estimated as one bounded implementation task.
- The SDK mode of the evaluation server (bridge over `SdkPiSessionAdapter`), and
  `ask_controller` registered through it. Today it exists only against the faux
  provider and the scripted adapter.
- A provider-free dry run of the runner on the loopback fake route before the
  approval is used.

# Decision inputs: bounded turn wait (#91)

Date: 2026-10-18. Base main `612fbcb`. Decision inputs only: no `waitMs`, no
`pi_turn_wait` and no recommendation to implement. The A/B prepared for #93 must
run, with its own approval, before the decision. A new optional argument changes
the public contract: minor release and its own decision (ADR 0003, Versioning).

## Measured facts

From the [M1 pilot, attempt 3](../token-footprint-2026-10-17/m1-pilot/README.md)
(Codex 0.162.0 controller, one route, synthetic tasks):

| Case | MCP calls | `pi_turn_get` | Cumulative input (cached subset) | Output |
| --- | ---: | ---: | ---: | ---: |
| L1 one read | 9 | 2 (1 running, 1 terminal) | 171,034 (153,984) | 1,074 |
| L2 one repair | 10 | 3 (2 running, 1 terminal) | 219,683 (201,344) | 1,204 |
| L3 two reads + follow-up | 18 | 8 (4 repeated an already terminal turn) | 396,699 (337,792) | 2,523 |

- Input is cumulative over every model request of a controller run; each extra
  tool round trip re-sends the context. Most of it was reported as cached.
  Cached input is not the same as newly billed text; no money value, net-of-cache
  figure or worker usage is known.
- Of L3's four repeated terminal reads, one was the deliberate invariance re-fetch
  of the original turn after the follow-up; three were avoidable controller
  re-reads.
- The number of model requests per case was not recorded; the "about 8 requests"
  in #91 is an estimate.
- Running polls stayed at 1–3 per turn, as in ADR 0003's evidence. Revisit
  trigger C ("more than about five polls per turn, or client limits or approval
  prompts make polling costly") is not met on count; the cost dimension is newly
  measured but not compared against an alternative yet.

## Options

| Option | Expected effect (inference unless sourced) | Constraints |
| --- | --- | --- |
| (a) Skill guidance only (#86: consume a terminal turn once, cadence 10 s then 15–30 s) | Removes avoidable terminal re-reads (three in L3); does not shorten running polls | No contract change; obedience unmeasured |
| (b) Optional bounded wait on `pi_turn_get` (`waitMs`, capped, default 0) | One call could span a wait window, so running polls could fall | Contract change. Codex `tool_timeout_sec` defaults to 60 s ([config reference](https://learn.chatgpt.com/docs/config-file/config-reference)), so a cap well below that would be needed. Claude Code applies a hard wall-clock tool timeout that progress notifications do not extend ([MCP docs](https://code.claude.com/docs/en/mcp)). MCP cancellation (`notifications/cancelled`) can race a completed response ([spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation)). Server: the registry has no completion signal today (`getTurn` is a plain read, `src/session-registry.ts:87`); a pending wait would have to wake on close, abort and shutdown (`src/session-registry.ts:167,194,228`; 15 s process deadline, `src/shutdown.ts:1`) |
| (c) Client-side waiting (shell sleep, hooks) | A sleep through a tool is itself a round trip and may save nothing | No server change; differs per client and may trigger approval prompts; unmeasured |

Not verified: Codex behavior on MCP progress and cancellation; whether the
pinned MCP SDK passes a cancellation signal to tool handlers.

## What the A/B must provide

Per arm and case: model request count if the client reports it; cumulative input,
cached subset and output as reported; `pi_turn_get` split into running polls,
first terminal reads, avoidable repeated terminal reads and labelled invariance
re-fetches; wall-clock time; independent acceptance; cleanup; tool timeouts,
approval prompts and cancellations. Decision criteria, fixed before any run:
quality retained in every pair, and a repeatable difference beyond pair-to-pair
spread before any contract change is considered. The A/B as prepared compares
(a) against the baseline; it does not test (b).

## Gate order

1. #86 skill guidance (implemented in this sprint, live effect unmeasured).
2. #93 A/B with its own current approval.
3. #91 decision against the criteria above. If a wait is still wanted: its own
   decision record, contract tests, documented cap and cancellation behavior and
   a minor release. If rejected: restate trigger C with the cost dimension.

## A/B outcome and proposed decision (2026-10-18)

The [A/B](../m1-ab-proposal-2026-10-18/results/README.md) ran four pairs on the
Codex route. Both arms kept quality; running polls stayed at 1–3 per turn in both
arms; the variant with the #86 skill guidance used fewer or equal calls and
mostly lower cumulative (largely cached) controller input, with no consistent
uncached difference.

Proposed decision, for the maintainer to confirm: **do not add a bounded wait
now** (no `waitMs`, no `pi_turn_wait`). Polling per turn stays below ADR 0003's
count trigger, and the measured lever is fewer avoidable calls, which skill
guidance already addresses without a contract change. Restate trigger C with the
cost dimension: revisit when running polls routinely exceed about five per turn,
or when the uncached controller input attributable to polling becomes material in
a measurement like this one, or when a client's tool-call limits or approval
prompts make polling costly.

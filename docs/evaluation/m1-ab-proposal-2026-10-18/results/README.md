# M1 A/B results, 2026-10-18

Operator-approved wave after the passing [probe](../probe/attempt-4/README.md):
four pairs in the order A/B, B/A, B/A, A/B, eight executor runs, 24 fresh Codex
controller invocations, 32 worker starts, 40 work turns, 0 retries. Each run had
its own freshly bound approval copy (10 USD operator-selected advisory per run,
not a cap; unmetered subscription use acknowledged).

- Arm A `4bc7988`: harness of `3c5969c`, `skills/` and `src/server.ts` of `612fbcb`.
- Arm B `3c5969c`: Sprint 5 follow-up head (controller skill #86, tool
  descriptions #88, input schemas #90).
- Controller Codex 0.162.1 (`openai` / `gpt-6.1-sol` / high, skill embedded);
  workers on the Pi provider `openai` (Sol, high for read, medium for coding);
  **no worker skills**, so #87 is not tested here.

All eight runs: harness `PASS`; every case passed its independent oracle,
source/build/skill rechecks, cleanup and the session-list check. Raw per-run
records are in the `r*-pair*-*` directories; [`summary-rows.json`](summary-rows.json)
holds the per-case values used below.

## Per case: medians and paired differences (B − A)

Input is cumulative over all controller model requests, as Codex reports it.
"Uncached" is input minus the reported cached subset, plain arithmetic; it is not
a billed amount.

| Case | Metric | Median A | Median B | B − A in pairs 1–4 |
| --- | --- | ---: | ---: | --- |
| L1 | input tokens | 210,855 | 181,439 | +2,085, −60,210, −78,836, −26,390 |
| L1 | uncached tokens | | | −347, −2,610, +1,804, −534 |
| L1 | output tokens | 1,269 | 1,513 | +4, +232, +538, +256 |
| L1 | MCP calls / `pi_turn_get` | 10 / 2 | 10 / 2 | −1/−1, 0/0, −1/−1, 0/0 |
| L1 | seconds | 52 | 67 | −4, +21, +16, +15 |
| L2 | input tokens | 209,275 | 167,908 | −10,380, −50,533, −44,470, −32,286 |
| L2 | uncached tokens | | | −6,924, +7,963, −6,838, −7,070 |
| L2 | output tokens | 1,162 | 1,234 | +156, −79, −53, +176 |
| L2 | MCP calls / `pi_turn_get` | 11 / 3 | 10 / 2 | 0/0, −1/−1, −1/−1, −1/−1 |
| L2 | seconds | 56 | 60 | −3, +15, +8, −2 |
| L3 | input tokens | 402,762 | 281,096 | −248,953, −112,167, +4,306, −95,454 |
| L3 | uncached tokens | | | −6,393, −21,671, +9,682, +6,690 |
| L3 | output tokens | 2,577 | 2,644 | −35, −119, +27, +459 |
| L3 | MCP calls / `pi_turn_get` | 19 / 7 | 18 / 6 | 0/0, −4/−4, −1/−1, 0/0 |
| L3 | repeated terminal reads | 1 | 1 | 0, −3, 0, 0 |
| L3 | seconds | 100 | 109 | +14, −21, +4, +42 |

The one repeated terminal read per L3 run is the labelled invariance re-fetch;
only arm A in pair 2 repeated terminal reads beyond it (three more).

## Against the criteria fixed in advance

- **Quality retained in every pair:** yes, all cases in both arms passed.
- **Repeatable difference beyond pair-to-pair spread:** cumulative controller
  input was lower in B in 10 of 12 case-pairs, mostly in the cached part; the
  uncached part changed sign between pairs, so no consistent uncached
  difference is shown. Running polls and MCP calls were never higher in B and
  lower in 7 of 12 case-pairs. Output tokens were higher in B in all four L1
  pairs; runtime tended to be higher in B for L1 and L2.
- **Polls per turn** stayed at 1–3 running polls in both arms, below ADR 0003's
  count trigger.

## Limits

One client and route, synthetic tasks, four pairs, package effect only (no
per-measure attribution between #86, #88 and #90), no worker skills (#87
untested), worker usage and money cost unknown, cached input not equal to billed
text. The A runs first in pairs 1 and 4, B first in pairs 2 and 3. No result is
generalized to Claude Code or other routes.

# A/B technical probe, attempt 4 (2026-10-18): PASS

After attempt 3 the operator approved fixing the receipt contract: the T2
implementer prompt now asks for exactly one JSON object `{changed_files,summary}`
(`eval/profiles/oracles.ts`). Arms: A `4bc7988` (harness of `3c5969c`, `skills/`
and `src/server.ts` of `612fbcb`), B `3c5969c`. `openai` worker route (Sol),
Codex 0.162.1 controller, no worker skills, 10 USD operator-selected advisory per
run, unmetered subscription use acknowledged.

Both arms: harness `PASS`, 4 starts, 5 work turns, 0 retries, every case passed
its independent oracle, source, build and skill rechecks passed.

| Arm | Case | Input tokens (cached) | Output (reasoning) | MCP calls | `pi_turn_get` running / first terminal / repeated | Seconds |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| A | L1 | 216,992 (203,520) | 1,487 (66) | 11 | 2 / 1 / 0 | 65 |
| A | L2 | 273,502 (254,080) | 1,145 (84) | 11 | 2 / 1 / 0 | 183 |
| A | L3 | 358,566 (323,712) | 2,121 (146) | 18 | 2 / 3 / 1 | 86 |
| B | L1 | 243,007 (209,152) | 1,392 (55) | 10 | 1 / 1 / 0 | 60 |
| B | L2 | 216,959 (198,144) | 1,079 (101) | 10 | 1 / 1 / 0 | 65 |
| B | L3 | 451,321 (404,480) | 3,043 (271) | 18 | 2 / 3 / 1 | 126 |

Input is cumulative over every controller model request, as the client reports
it. In L3 the one repeated terminal read is the labelled invariance re-fetch.
This probe is one technical pair: it shows that both arms run end to end; it is
not a comparison and supports no effect claim.

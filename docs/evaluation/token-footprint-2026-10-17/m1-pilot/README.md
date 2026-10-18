# M1 real-provider pilot, 2026-10-18

The operator approved one M1 pilot on 2026-10-18 for the exact matrix,
routes and budget in the [package](../live-approval/README.md): three fresh
sequential Codex controllers, four worker starts, five work turns, zero
retries, a 10 USD **operator-selected advisory** amount (not a cap, not a
cost estimate) and acknowledgment that subscription usage is unmetered.
After each harness defect the operator separately approved a fix and a new
pilot. Three attempts ran; all are preserved here. Only attempt 3 passed.

| Attempt | Source commit | Result | Cause |
| --- | --- | --- | --- |
| [1](attempt-1/token-live-result.json) | `98a7dc4` | FAIL after L1 | Harness: proxy forwarded the controller's SIGTERM; real server exited 143 |
| [2](attempt-2/token-live-result.json) | `23d2481` | FAIL at L2 | Harness: L2 config had a coding default; the server requires a read-only default |
| [3](attempt-3/token-live-result.json) | `b29441f` | **PASS** | L1, L2, L3 each independently accepted, 4 starts, 5 turns, 0 retries |

Each directory holds the approved manifest, budget and decision copies whose
normalized digests the result binds. Source, build and skill rechecks passed
in every attempt. Attempt 1's L1 task passed its oracle, route and scope
checks; only `all-sessions-closed` failed. Attempt 2's L1 passed completely.

## Harness defects found by the pilot

1. **Controller shutdown signal.** Probed directly: Codex 0.162.0 ends an
   ordinary `exec` run by sending SIGTERM to its MCP child without closing
   stdin first. The proxy forwarded SIGTERM, and `src/main.ts` exits 143 on
   SIGTERM, so the strict server-exit-0 check failed. The provider-free
   calibration missed it because its fixture server exits 0 on SIGTERM. Fix:
   the proxy forwards a controller signal as stdin EOF, the server takes its
   graceful exit-0 path, and the bounded SIGTERM/SIGKILL escalation stays.
   A process test fails without the fix and passes with it.
2. **L2 server configuration.** `src/config.ts` rejects a configuration whose
   default execution profile is not read-only. L2 configured only `code`, so
   the real server failed at startup (`invalid_execution_profile_config`);
   Codex continued without MCP tools and spent one model turn. Fix: L2 keeps
   `review` as default and offers `code`, which the controller prompt selects
   explicitly. Tests parse every case configuration with the production schema.

Neither fix changes production source, contract or registrations.

## Attempt 3 observations

Controller usage comes from Codex `turn.completed` usage events. Fields are
reported as emitted; `cached_input_tokens` is the client's reported cached
subset of input. Input usage is **cumulative over every model request in the
controller run**, so each additional tool round trip re-sends the context.
No bytes-to-tokens conversion, net-of-cache figure or money value is derived.

| Case | Calls (`pi_turn_get`) | MCP response / request bytes | Input tokens (cached) | Output (reasoning) | Harness s |
| --- | --- | ---: | ---: | ---: | ---: |
| L1 one read | 9 (2) | 26,375 / 7,611 | 171,034 (153,984) | 1,074 (22) | 42.5 |
| L2 one repair | 10 (3) | 27,446 / 8,712 | 219,683 (201,344) | 1,204 (52) | 61.9 |
| L3 two reads + follow-up | 18 (8) | 41,442 / 18,031 | 396,699 (337,792) | 2,523 (114) | 79.0 |

Call counts include `initialize`, `notifications/initialized` and
`tools/list`. Worker usage was not exposed and remains unknown. Every
`tools/list` response is about 19.9 KB, which is the largest single MCP frame
and about three quarters of L1's response bytes.

Polling stayed modest: L1 used one running and one terminal poll, L2 two
running polls. L3 issued eight `pi_turn_get` calls of which **four repeated an
already terminal turn**. One is the required invariance re-fetch of the
original turn after the follow-up; the other three are controller re-reads.
This is the first live observation that repeated terminal retrieval happens
in real orchestration; it supports candidate 1 (consume a terminal result
once). Final worker answers were 486–563 bytes, so compact-report savings
(candidate 2) have little to act on for these tasks.

## Limits

One pilot, one controller model and route, synthetic fixture tasks. The
controller prompt embeds the full orchestration skill text, which inflates
input for every request. No live A/B, model ranking, worker-side usage, cost
per accepted task or general token-saving claim follows. Additional
repetitions or an A/B need their own current approval.

# Sprint 5 decision inputs, 2026-10-18

Research and decision inputs from [Sprint 5](../../sprints/2026-10-18-s5-maintenance-orchestration.md).
None of them changes the public MCP contract or authorizes a live run.

| Issue | Note | Outcome |
| --- | --- | --- |
| #89 | [Claude Code projection probe](claude-projection/README.md) | Provider-free probe on a declared synthetic route (Claude Code 2.1.301, `--bare`): q1 output schema **not observed**; q2 **one** tool-result representation observed; q3 deferred tool search **unmeasurable** on this route (bare mode has no tool search); q4 cumulative controller input per M1 case **not measured** (needs its own approval) |
| #91 | [Bounded wait](bounded-wait.md) | Decision inputs; decision deferred until the #93 A/B |
| #92 | [Worker usage](worker-usage.md) | Usage is per assistant response in the public SDK; no per-turn aggregate; no contract change |

Claude Code 2.1.301 opens MCP with a `server/discover` request, which the existing
M1 frame proxy (`eval/profiles/token-live-proxy.ts`) rejects as a fatal frame. A
Claude Code M1 run behind that proxy therefore needs a reviewed proxy change
first; the probe launches its fixture server directly instead.

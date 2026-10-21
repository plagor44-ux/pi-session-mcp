# Sprint 6: ledger, event bridge and controller rewake (evaluation)

Date: 2026-10-21. Base: main `0922d98f0fb33d3c493dc428dfef932443bfa4fa` (merge of
PR #103), package 0.10.0, Pi SDK 1.3.0, MCP SDK 2.3.1. Tracking:
[#104](https://github.com/plagor44-ux/pi-session-mcp/issues/104).

A bounded, development-only evaluation added at the operator's explicit request
of 2026-10-21. It does not replace the maintenance priorities: the isolation
rollout and acceptance under #79 (ADR 0008, ADR 0009; review point 2026-11-15)
stays the next investment, and the open #89 q4 item keeps its own gate.

## Question

How should a controller monitor one or more running Pi worker sessions and keep
their state traceable? Does a ledger (`task.md`, `run.json`, OMO Boulder) help,
and can repeated status polls by the controller model be reduced without a
persistent workflow server? The outcome was open; "the current procedure is
enough" was an admissible result.

## Authorization and limits

In scope: inventory and options comparison; a provider-free evaluation
prototype outside the runtime path (`eval/bridge/`), including completion
events and a structured question round trip; a ready-to-run live measurement
plan; documentation and review.

Not authorized and not done: public MCP contract changes, production
persistence, changes to registrations, credentials or permissions, any live
provider run, release, tag, publication or merge. The prototype writes only
synthetic local state into temporary directories.

## Preflight (2026-10-21)

- `origin/main` = `0922d98`; latest release v0.10.0; no open pull requests; open
  issues: #79 only. Issues #86, #89, #91, #92 and #93 were read with comments.
- A parallel Claude Code session works on the unpushed branch
  `eval/extension-ablation-design` in the main checkout (owner of
  `eval/extensions/**` and `~/.cache/pi-session-mcp/extension-ablation/`). It
  was asked first; file ownership is disjoint. This sprint ran in its own
  worktree on branch `eval/ledger-event-bridge` and did not touch that checkout,
  its cache directory or any running MCP server.
- Installed clients: Claude Code CLI 2.1.303, VS Code extension 2.1.304, Codex
  0.162.1; Node 26.11.1.

## Routes and ownership

| Package | Route | Scope | Result |
| --- | --- | --- | --- |
| A1 Pi SDK semantics | Claude general-purpose subagent, read-only | installed 1.3.0 sources and docs | delivered; key facts rechecked by the faux-provider test |
| A2 registry and adapter | integrator | `src/` read-only | delivered |
| B client capabilities | Claude researcher, official docs | hooks, MCP, channels, spec, Codex | delivered; the rewake edge rechecked by a spike and the probe |
| C0 Boulder | Claude researcher | oh-my-openagent `dev` | delivered (summarized reads, marked) |
| C1 ledger, store, CLI | Claude implementer | `eval/bridge/ledger*.ts`, `test/bridge-ledger.test.ts` | implemented; integrator fix for unconsumed results on connection loss |
| C2 bridge, broker, scripted adapter, faux test | Claude implementer | `eval/bridge/{bridge,questions,ask-tool,scripted-adapter}.ts`, two tests | implemented |
| C3 host adapter and client probe | Claude implementer | `eval/bridge/{server-main,hook-waiter,hook-ledger,claude-probe,cli}.ts`, hook tests | see the report |
| D pre-registration and live plan | integrator | `docs/evaluation/ledger-event-bridge-2026-10-21/` | fixed before comparative runs (commit `569c89f`) |
| E independent review | see the report | | |

No Pi worker wrote code: the only workspace alias for this repository points at
the operator's main checkout, which the parallel session uses. Writers never
shared files. Controller-side session and turn IDs were kept only transiently.

## Results

See the [evaluation report](../evaluation/ledger-event-bridge-2026-10-21/README.md).

## Gates for later work

- Any product change following this evaluation (a registry completion observer,
  a local event spool or socket, a client hook installed by setup, a question
  tool) needs its own decision record, and a public tool or field needs a
  minor release.
- The live measurement (L4) needs a new, explicit operator approval of the
  [live plan](../evaluation/ledger-event-bridge-2026-10-21/live-plan.md).

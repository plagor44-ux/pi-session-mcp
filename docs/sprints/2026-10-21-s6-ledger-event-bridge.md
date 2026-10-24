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
persistence, changes to registrations, credentials or permissions, release, tag,
publication or merge. Live provider runs were not part of the original scope.
Later the same day the operator approved two L1 pairs, which ran (see
*Gates*). The prototype writes only
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
| C3 host adapter and client probe | Claude implementer | `eval/bridge/{server-main,hook-waiter,hook-ledger,claude-probe,cli}.ts`, hook tests | implemented; probe attempts 1–3 by the implementer and integrator, attempt 4 by the integrator after the review fixes |
| A3 abort during a tool | Claude general-purpose, scratch test not committed | real `SdkPiSessionAdapter` | `aborted` in 60 of 60 runs per variant; order-dependent |
| D pre-registration and live plan | integrator | `docs/evaluation/ledger-event-bridge-2026-10-21/` | fixed before comparative runs (commit `569c89f`) |
| E1 independent review | Pi worker, `review-grok` (read-only), alias `pi-session-mcp` reading only this worktree | frozen head `1289137` | 5 findings; session closed |
| E2 independent review | Claude reviewer (Opus 5.5) | frozen head `1289137` | 7 findings; two reproduced |
| F review fixes | Claude implementer, then integrator | `eval/bridge`, tests, docs | fixed; 91 tests |

No Pi worker wrote code: the only workspace alias for this repository points at
the operator's main checkout, which the parallel session uses. Writers never
shared files. Controller-side session and turn IDs were kept only transiently.
One Pi session was started (E1) and closed; none is left open.

The first worktree lived under the main checkout (`.claude/worktrees/`). The
parallel session reported that its vitest run then collected this worktree's
tests and one sub-run failed. The worktree was moved outside the repository
once the reviewers had finished.

## Results

See the [evaluation report](../evaluation/ledger-event-bridge-2026-10-21/README.md).

## Gates for later work

- Any product change following this evaluation (a registry completion observer,
  a local event spool or socket, a client hook installed by setup, a question
  tool) needs its own decision record, and a public tool or field needs a
  minor release.
- Two approved L4 pairs ran on 2026-10-21 ([results](../evaluation/ledger-event-bridge-2026-10-21/live/README.md)).
  Any further live run needs a new, explicit operator approval.
- ADR 0011 was accepted by the maintainer on 2026-10-21, items 1–3. The
  implementation is
  [#108](https://github.com/plagor44-ux/pi-session-mcp/issues/108), gated by
  approval of its plan.

## Closure (status as of 2026-10-24)

The sections above record the evaluation as it ran on 2026-10-21 and are not
rewritten. What happened afterwards, kept apart:

1. **The evaluation and its recommendation (2026-10-21).** The pre-registered
   product rule was not met (requests 7/8 and 8/8, mixed uncached input and
   cost). The evaluation recommended deferring ADR 0011: keep the current
   procedure, no ledger, no supervisor. It measured one clear gain, reaction
   time (about 2 s against 10-21 s). The sprint changed no product code.
2. **The later maintainer decision (2026-10-21).** The maintainer accepted
   [ADR 0011](../adr/0011-turn-events-and-controller-wake.md) items 1-3 for
   controller reaction time, knowingly against the gate and the recommendation.
   Item 4 (structured question channel) is not decided.
3. **What shipped (outside this sprint).** The completion bridge only: opt-in
   spool delivery plus a setup-installed Claude Code wake hook, implemented in
   [#110](https://github.com/plagor44-ux/pi-session-mcp/pull/110) for
   [#108](https://github.com/plagor44-ux/pi-session-mcp/issues/108) and released
   as 0.11.0 on 2026-10-22 (Linux only). Fixes: 0.11.1
   ([#113](https://github.com/plagor44-ux/pi-session-mcp/issues/113), delivery
   stays inactive without `XDG_RUNTIME_DIR`) and 0.11.2 (#109 and #117, not part
   of this feature). A file ledger and a supervisor are not product features;
   `eval/bridge/` stays an evaluation prototype. The token and cost saving for
   long turns remains unmeasured.

The isolation work under #79 kept its priority and its review point of
2026-11-15. Operator checks that are still open (wake in the VS Code extension,
whether a running session loads a newly installed hook, a wrapped container
writer with delivery under rootless Podman including the extra-mount isolation
check) are tracked in the [roadmap](../roadmap.md), not in this sprint.

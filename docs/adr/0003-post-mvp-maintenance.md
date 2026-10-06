# ADR 0003: no new feature phase after the MVP

**Status:** Accepted (2026-09-30)

## Decision

Choose **Candidate A: no new product phase.** Pi Session MCP stays a local stdio server with in-memory state and one trusted local peer (ADR 0001, ADR 0002). Work continues as maintenance: each defect or upstream drift gets its own focused issue. The local diagnostics and install lifecycle is complete with the offline Doctor and the reproducible client setup. This ADR authorizes no implementation or research phase.

## Evidence considered

Verified facts:

- A two-client acceptance of `v0.5.1` accepted 10 of 10 pre-registered tasks, five from Codex CLI `0.159.2` and five from Claude Code `2.1.285`. The tasks covered capability-led discovery, same-session follow-up, snapshot-verified coding, and abort and recovery. The run had zero public-result leaks and zero residual server processes.
- Polling cost 1 to 3 `pi_turn_get` calls per turn (24 across 10 turns). Running activity was observable on both client routes.
- No recorded run lost useful work to a client or server restart. All sessions stayed within one client invocation.
- Coding profiles ran only on disposable synthetic fixtures.
- The observed friction was drift and environment, not missing features:
  - A Pi SDK update from `0.84.4` to `0.99.x` broke the pinned sources.
  - The client-version allowlist in `setup` no longer matched the installed clients.
  - A shared local inference endpoint switched models during a run, and the result appeared only as an opaque `turn_failed`.
  - Several tests were sensitive to host load.

Inferences: polling overhead is acceptable for the observed clients. Losing sessions on restart has no measured cost today.

Assumptions: use continues to be single-operator and local. No remote or mobile control requirement has been stated.

## Candidates

| Candidate | Outcome | Reason |
| --- | --- | --- |
| A: no new feature phase | **Chosen** | Both clients complete real workflows reliably; the observed problems are maintenance items. |
| B: local diagnostics and install lifecycle | Delivered; no further phase | Doctor and `setup` exist. Stale supported client versions are maintenance. |
| C: bounded turn waiting | Rejected | 1 to 3 polls per turn; no client limit or approval cost observed. |
| D: persistence and resume | Rejected | No lost work observed. Persistence would make Pi Session MCP a sensitive data store. |
| E: Linux OS isolation | Deferred | Coding profiles have only run on disposable fixtures; see the revisit triggers. |
| F: remote transport | Rejected | No concrete use case. It would need a separate product and threat-model decision. |

## Smallest scope

Maintenance only: Pi SDK updates, current client versions for `setup`, and hardening of load-sensitive tests. A finer classification of `turn_failed` waits until the Pi SDK offers a closed, public terminal-cause signal. A nightly Pi SDK canary reports upstream drift in an issue labeled `pi-sdk-canary`.

## Security and data retention

Unchanged. No new tool, transport, storage, credential path or permission. No session state is persisted. Coding profiles remain application-level tool allowlists, not OS isolation (ADR 0002).

## Acceptance environment

Live acceptance uses a local model endpoint with pre-registered synthetic fixtures and independent oracles, as described in [Acceptance](../acceptance.md). If the endpoint is shared, each live run records the loaded model before and after, and never force-loads a model that another session is using.

## Versioning

Changes that keep the public MCP contract (tools, fields, states, error codes) ship as patch releases, including Pi SDK updates. Any public contract change needs a minor release and its own decision.

## Revisit triggers

- **E (isolation research):** coding profiles are used on non-disposable repositories or with untrusted content, at the latest before a local writer runs on real repositories.
- **C (bounded wait):** clients routinely need more than about five polls per turn, or client tool-call limits or approval prompts make polling costly.
- **D (persistence research):** a client or server restart loses useful work in practice.
- **F (remote architecture):** a concrete remote or mobile use case that SSH or existing remote-development workflows cannot satisfy.
- **B-type work:** repeated setup or diagnosis friction beyond version drift. This trigger fired for the client-version allowlist; see [ADR 0004](0004-client-contract-not-version.md).

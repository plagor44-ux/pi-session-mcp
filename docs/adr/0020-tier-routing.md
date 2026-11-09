# ADR 0020: Tier routing

**Status:** Accepted (2026-11-09, owner decision).

- Amends [ADR 0019](0019-opt-in-session-history.md) for routing metadata in the history file; session resume remains out of scope.

## Context

Operators need optional, consistent profile selection across clients, without
moving difficult tasks to weaker tiers or exposing session history to workers.
Small samples must not drive rapid changes.

## Decision

Selection and enforcement happen in the server at session start. The operator
assigns profiles and families to tiers in `routing.json` beside the main
configuration. Floors apply to routed starts; explicit profiles remain usable.
Reviews exclude the author's family unless explicitly overridden. Learning only
reorders profiles within a tier and role, never between tiers.

Routing defaults to `off`. In `manual` mode learning proposes changes; in
`auto` it applies reversible changes and requires history. Without history,
manual selection uses the configured order without proposals. History failures
fall back to that order rather than blocking a start. Changes to the routing
configuration require a client reconnect.

The history file contains routing decision, order, suspension and version tables,
amending ADR 0019. These derived rows contain metadata, not prompts, paths,
workspace aliases or task labels, and survive session pruning. Retention is
bounded to 200 decisions per cell. History remains opt-in and stores redacted
session content locally; redaction is best effort.

## Consequences

- Controllers provide roles, risk and review author family, and record verdicts.
- The routing CLI exposes status, proposals and reversible changes. Learning
  requires enough samples and may take time.
- The history schema advances. A downgrade below this release leaves the history
  unavailable until this release returns; older software must not write a newer
  schema.
- Routing is additive to the MCP contract; it neither resumes sessions nor adds
  a network service.

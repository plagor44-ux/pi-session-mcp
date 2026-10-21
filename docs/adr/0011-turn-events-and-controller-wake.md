# ADR 0011: Turn events and controller wake

**Status:** Proposed (2026-10-21). Not accepted. Nothing in the product
changes until a maintainer decision. **Evaluation recommendation: defer.**
Two real-model pairs met the critical assumption but not the decision gate
below. Evidence:
[evaluation report](../evaluation/ledger-event-bridge-2026-10-21/README.md),
[#104](https://github.com/plagor44-ux/pi-session-mcp/issues/104).

## Context

Today a controller learns that a Pi turn ended only by polling `pi_turn_get`.
The registry has exactly one terminal transition per turn. That transition is
the settled end of the SDK run, including retries, compaction and queued
follow-ups. Nothing outside the registry is told about it. A worker cannot ask
the controller a question that waits for an answer. #91 rejected a bounded wait
on cost evidence (1–3 running polls per turn on a Codex route).

A provider-free evaluation reached the following, at its stated levels:

- A content-free event can be emitted once per turn from that transition (L1).
- Claude Code 2.1.303 starts a new model request in an idle stream-json session
  when an `asyncRewake` hook exits 2 after the event (L3: 16–34 ms, exactly one
  wake per event, correct correlation with two turns, no wake with plain
  `async`).
- An explicit worker tool can carry a structured question to the controller and
  its answer back to the waiting call (L1 on a real `AgentSession`, L3 round
  trip).

- In two approved real-model pairs (L4, Claude Code 2.1.306,
  `claude-sonnet-5-5`, short case L1), the woken controller read each turn
  once with no poll and no sleep. It reacted to a finished turn after 1.8 and
  2.2 s, against 10.4 and 20.7 s with polling. But the gate was not met:
  - controller requests were 7 against 8 and 8 against 8;
  - uncached input and cost were mixed;
  - pair 1's polling arm failed the quality oracle on the worker side.

Not shown: a request or token saving, which the model expects only for long
worker turns; a question round trip with a real model; interactive and VS Code
behavior; any Codex wake path (none is documented).

## Proposal (for decision)

1. **Internal completion observer.** Add a registry-internal listener at the
   existing terminal transition. It emits `{instance, session, turn, state,
   via}` once and changes no public tool, field or state. Patch-level if it
   stays internal.
2. **Local event spool per server process** (or an equivalent local channel),
   content-free, mode 0600 in a 0700 directory, removed at shutdown. It is a new
   local operator surface and a departure from "process memory only", so it
   needs this ADR and a threat note. It must not be mounted into worker
   containers.
3. **Client adapter shipped by setup, Claude Code only:** a `PostToolUse`
   `asyncRewake` hook on `pi_session_prompt`, with claim files for exactly one
   wake per event, a budget equal to the task budget, and exit on parent loss.
   One-shot `-p` runs hold the next model request until the hook ends (observed
   in S5), so the adapter applies to stream-json and interactive sessions only.
4. **Optional, separate decision:** a question channel, meaning a worker tool
   `ask_controller` and public answer tools. That is a public contract change:
   minor release, contract tests, deadlines, limits, and unchanged rights.

## Revisit triggers

Long worker turns, where polling needs many polls; demand for worker questions
to the controller; or controller reaction time to finished turns becoming a
bottleneck.

## Decision gate

Accept items 1–3 only if the approved L4 measurement in the
[live plan](../evaluation/ledger-event-bridge-2026-10-21/live-plan.md) keeps
quality in every pair and shows fewer controller model requests than the
current skill, without higher uncached controller input. Otherwise reject or
defer, and keep the skill cadence. Item 4 needs its own evidence of demand.

## Consequences if accepted

- Running polls for Claude Code controllers in stream-json or interactive mode
  are no longer needed for delivery. Whether real models stop polling is what
  L4 measures. Terminal reads stay once per turn. The hook timeout must cover
  the task budget, and every path that leaves a turn running must re-arm a
  waiter.
- Codex controllers keep polling.
- New maintenance: hook installation and verification in setup, spool cleanup,
  and a client-version contract for `asyncRewake`.

## Alternatives considered

Bounded wait (rejected in #91); deterministic supervisor (adds a trigger, no
delivery); MCP notifications, subscriptions and tasks (Claude Code does not
start a turn on them; tasks unsupported); channels (gated research preview,
not with `-p`); MCP elicitation for questions (human only, and only inside a
pending call under protocol 2026-07-28); a file ledger (overview only, no
notification).

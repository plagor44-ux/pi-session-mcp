# ADR 0011: Turn events and controller wake

**Status:** Accepted (2026-10-21, maintainer decision), items 1–3, for
release 0.11.0. Item 4 (question channel) is not decided. Amends
[ADR 0003](0003-post-mvp-maintenance.md) (in-memory-only boundary, see below)
and [ADR 0008](0008-coding-profile-isolation.md) (an event spool mount per
writer). Evidence:
[evaluation report](../evaluation/ledger-event-bridge-2026-10-21/README.md),
[#104](https://github.com/plagor44-ux/pi-session-mcp/issues/104).

## Context

Today a controller learns that a Pi turn ended only by polling `pi_turn_get`.
The registry has exactly one terminal transition per turn. That transition is
the settled end of the SDK run, including retries, compaction and queued
follow-ups. Nothing outside the registry is told about it. #91 rejected a
bounded wait on cost evidence (1–3 running polls per turn on a Codex route).

The evaluation reached the following, at its stated levels:

- A content-free event can be emitted once per turn from that transition (L1).
- Claude Code (2.1.303 and 2.1.306) starts a new model request in an idle
  stream-json session when an `asyncRewake` hook exits 2 after the event. This
  is L3: 16–34 ms, exactly one wake per event, correct correlation with two
  turns, and no wake with plain `async`.
- In two approved real-model pairs (L4, Claude Code 2.1.306,
  `claude-sonnet-5-5`, short case L1), the woken controller read each turn
  once with no poll and no sleep. It acted on a finished turn after 1.8 and
  2.2 s, against 10.4 and 20.7 s with polling.
- The pre-registered gate was **not met**:
  - controller requests were 7 against 8 and 8 against 8;
  - uncached input and cost were mixed;
  - pair 1's polling arm failed the quality oracle on the worker side.

  The evaluation therefore recommended deferring.

## Decision

The maintainer accepts items 1–3 **for controller reaction time**, knowingly
against the evaluation's gate and recommendation. No token or cost saving is
claimed. On short tasks there was none. A saving on long worker turns is
expected but unmeasured.

1. **Internal completion observer.** A registry-internal listener at the
   existing terminal transition emits one content-free event per turn:
   instance, session, turn, state and `via` (`registry`, or `close` when close
   aborts a running turn). It fires inside that single transition, so its state
   always equals the read model. The read model stays the only source of
   truth.
2. **Local event spool, opt-in.** It is enabled by a new optional server
   configuration field and off by default. Without it, behavior is unchanged
   for every client, including Codex. Host servers write under
   `$XDG_RUNTIME_DIR/pi-session-mcp/events/<instance>/`:
   - one file per event, written atomically;
   - mode 0600, in directories of mode 0700;
   - removed when the server stops.

   Events carry only IDs, states, timestamps and codes. They are wake triggers,
   never state: the controller always reads the turn through `pi_turn_get`.
3. **Container writers get one dedicated spool mount each**, as an amendment to
   ADR 0008. It is a per-writer directory inside that writer's own state
   directory on disk (`~/.local/state/pi-session-mcp/writers/<name>/events/`),
   mounted read-write at `/pi/events`. It is not on the shared runtime tmpfs, so
   a worker cannot exhaust that tmpfs or the claims kept there; it can fill the
   disk no more than it already can through its writable clone. It is never
   shared between writers and never holds a ledger, credentials or any other
   state. Because the worker inside the boundary can write to it (coding
   profiles have a shell there), the following hold:
   - forged events can at most cause spurious or missing wakes in that
     writer's own namespace;
   - the hook validates the event schema strictly, never follows links and
     caps the work per scan;
   - the controller never trusts an event's state.
4. **Client adapter, Claude Code only, installed by setup.** It is a
   `PostToolUse` `asyncRewake` hook on `pi_session_prompt` and on running
   `pi_turn_get` results, placed in the same scope as the MCP registration and
   under the same ownership, dry-run, verify and remove rules as today. The
   hook:
   - claims each event exactly once;
   - releases an undelivered claim when it is killed;
   - exits when its parent goes away;
   - runs under a budget that the hook timeout must cover.
5. **Capabilities.** `pi_capabilities_get` gains a field that states whether
   event delivery is active (for example `events: { delivery: "spool" | "off" }`),
   so that the controller skill knows whether it has to poll. This is a public
   field change.
6. **Controller skill.** `pi-session-orchestration` gains a section. When
   delivery is active, the controller does not poll a running turn after
   `pi_session_prompt`. It waits for the `pi-bridge` wake, reads once, and
   re-arms by one running read after a budget wake. Otherwise the current
   cadence applies.
7. **Release.** A minor release, 0.11.0, under the versioning rule of
   ADR 0003. The eight MCP tools and their fields stay unchanged except for the
   new capabilities field.

## Boundary amendment (ADR 0003)

Pi Session MCP still keeps no session or turn state beyond process memory. The
event spool is a transient, content-free notification channel. It lives on a
runtime directory (tmpfs on systemd hosts), is removed at shutdown and is never
read back by the server. Persistence and resume stay rejected.

## Limits and consequences

- Codex controllers keep polling; Codex documents no external wake.
- Linux first: the spool lives under `XDG_RUNTIME_DIR`, which macOS does not
  set by default. With delivery enabled and no runtime directory, the server
  refuses to start (`event_spool_unavailable`). macOS support needs its own
  runtime-directory choice and acceptance.
- One-shot `claude -p` runs hold the next model request until the hook ends.
  The adapter is meant for interactive and stream-json sessions. The setup
  documentation says so.
- Interactive TUI and VS Code wake were not tested in the evaluation. They need
  an acceptance check before the release.
- New maintenance:
  - hook installation, verification and removal in setup;
  - spool lifecycle and cleanup;
  - the per-writer mount in the wrapped registration;
  - a client contract check for `asyncRewake` behavior (ADR 0004: contract,
    not version).
- Worker questions to the controller (item 4 of the proposal: an
  `ask_controller` worker tool and public answer tools) are **not decided**.
  They need their own decision and evidence of demand.

## Alternatives considered

- **Defer or reject:** the evaluation's recommendation; not chosen, because the
  maintainer values reaction time.
- **Bounded wait:** rejected in #91.
- **Deterministic supervisor:** adds a trigger but no delivery.
- **MCP notifications, subscriptions and tasks:** Claude Code does not start a
  turn on them, and tasks are unsupported.
- **Channels:** a gated research preview, not available with `-p`.
- **MCP elicitation for questions:** human only, and under protocol 2026-07-28
  only inside a pending call.
- **A unix socket instead of a file spool:** untested, and needs a new listener
  with its own lifetime logic.
- **A file ledger:** gives an overview only, no notification.

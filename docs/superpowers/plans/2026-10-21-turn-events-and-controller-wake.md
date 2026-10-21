# Plan: turn events and Claude Code controller wake (ADR 0011, release 0.11.0)

Status: **proposed, waiting for the maintainer's approval of this plan.**
Nothing below is implemented. Decision:
[ADR 0011](../../adr/0011-turn-events-and-controller-wake.md) (accepted
2026-10-21) with the [ADR 0008 amendment](../../adr/0008-coding-profile-isolation.md#amendment-2026-10-21-event-spool-mount).
Evidence and prototype: `eval/bridge/` and
`docs/evaluation/ledger-event-bridge-2026-10-21/`.

## Goal

When enabled per server configuration, a Claude Code controller in an
interactive or stream-json session is woken when a Pi turn ends. It reads the
turn once instead of polling. Everything else behaves as today, including every
Codex route and every server without the new field.

## Fixed decisions (from the ADR)

- A file spool under `$XDG_RUNTIME_DIR/pi-session-mcp/`, opt-in through a server
  configuration field, removed at shutdown, content-free.
- One dedicated spool mount per container writer.
- A `PostToolUse` `asyncRewake` hook installed by setup, in the registration's
  scope.
- A capabilities field stating whether delivery is active.
- A controller skill section.
- Minor release 0.11.0. No question channel.

## Tasks

Each task is its own commit with tests. Writers never share files. The
prototype in `eval/bridge/` is the reference, not a dependency: product code
gets its own reviewed, minimal version.

1. **Configuration.** An optional `events: { delivery: "spool" }` field in the
   server configuration (`src/config.ts`), strict schema, default off.
   - Doctor: an offline check of the runtime root (exists, owner, mode 0700) when
     the field is set.
   - Tests: schema accept/reject, Doctor codes.
2. **Registry observer.** An internal `onTurnTerminal` listener in
   `SessionRegistry` at the existing terminal transition. It fires once per turn
   and reports a turn that `close` removed before it could be read as
   `unobserved`. Listener errors never reach the registry.
   - Tests ported from `test/bridge-events.test.ts`: concurrency, follow-ups,
     `abort_timeout` then close, shutdown order, activity without early events.
3. **Event spool.** `src/event-spool.ts`: atomic per-event files (0600, 0700),
   an instance directory per server process, a write-failure counter reported as
   a sanitized stderr diagnostic, and removal on every shutdown path.
   - Root resolution: host → `$XDG_RUNTIME_DIR/pi-session-mcp/<instance>`; inside
     a wrapped writer → the fixed mount path given by the wrapper.
   - Wired in `src/main.ts` only when enabled.
   - Tests: lifecycle, cleanup on EOF, SIGTERM and shutdown timeout, no content
     fields.
4. **Capabilities.** `pi_capabilities_get` gains `events: { delivery: "spool" | "off" }`.
   - Update `docs/tool-contracts.md` and the output schema.
   - Contract tests.
   - Setup verify accepts the new field.
5. **Wake hook program.** A new bin (working name `pi-session-mcp-wake`) built
   from `eval/bridge/hook-waiter.ts` and hardened. It:
   - validates the event schema strictly;
   - caps file size and count;
   - never follows links;
   - claims each event exactly once and releases the claim on SIGTERM;
   - exits on parent loss;
   - re-arms on a running `pi_turn_get`;
   - takes its budget from configuration.

   Package `files` entry and install-smoke check.
6. **Setup integration.** Install, verify and remove the hook in Claude Code
   settings for the registration's scope (`claude-code:user|project|local`),
   under the existing rules: ownership, dry-run default, `--apply`, `--remove`,
   no replacement of divergent entries.
   - A client contract check for hook support (ADR 0004: contract, not version).
   - The hook timeout must cover the configured task budget.
   - Tests with client stubs.
7. **Writer boundary.** A per-writer spool mount in `src/writer-boundary.ts`,
   only when the registration enables delivery. Setup creates and removes the
   host directory and checks its owner and mode.
   - The isolation acceptance is extended: the mount gives no other host read or
     write access, and forged events cause at most a spurious wake.
8. **Controller skill.** A section in `skills/pi-session-orchestration/SKILL.md`:
   - when `events.delivery` is `spool`, no polling of running turns after
     `pi_session_prompt`;
   - wait for the `pi-bridge` wake and read once;
   - after a budget wake, read once while running to re-arm;
   - otherwise keep the current cadence.

   Skill tests and the setup-installed copy.
9. **Documentation.**
   - `docs/architecture.md`, `docs/tool-contracts.md`, `docs/threat-model.md`
     (spool, forged events, mount);
   - installation and isolation-setup runbooks;
   - `CHANGELOG.md` 0.11.0 and the roadmap.
10. **Acceptance before release.**
    - The provider-free client probe from `eval/bridge/claude-probe.ts`, pointed
      at the real server with the feature enabled (L3).
    - A manual check of an interactive TUI session and the VS Code extension;
      these were not covered by the evaluation.
    - A container writer with delivery enabled.
    - The release procedure in `docs/releasing.md` (pre-release acceptance in the
      change PR). Merge, tag and publication stay maintainer decisions.

## Gates

- Approval of this plan before any product code changes.
- One branch and one PR for the implementation, with one issue reference.
- The release ships only after task 10 passes.
- The isolation work under #79 keeps its review point of 2026-11-15. This plan
  does not delay it.

## Out of scope

The question channel (`ask_controller` plus answer tools), Codex wake, a file
ledger in the product, persistence, and any change to the eight existing tools
other than the new capabilities field.

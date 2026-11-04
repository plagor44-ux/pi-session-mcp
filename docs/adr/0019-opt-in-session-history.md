# ADR 0019: Opt-in session history

**Status:** Proposed (2026-11-04); implemented under issue
[#215](https://github.com/plagor44-ux/pi-session-mcp/issues/215) in the same
pull request. The maintainer accepts or rejects it in that review; it is set
to Accepted before merge.

- Planning basis: main `ecdbadf` (published 0.17.0), Pi SDK
  `@earendil-works/pi-coding-agent` 1.5.0.
- Design: [2026-11-03 session history](../superpowers/specs/2026-11-03-session-history-design.md)
  (calls 1–19).
- Amends option D ("persistence and resume") of
  [ADR 0003](0003-post-mvp-maintenance.md) for history only. Resume stays
  rejected.

## Context

A Pi session is a black box for the operator. During a turn the controller
waits; afterwards only the worker's final text remains. Nothing records which
files the worker read, which commands it ran and what they returned, what it
reasoned between steps, or how the controller judged the result.

#215 asked for an evaluation of a metadata-only SQLite journal and put full
transcripts out of scope. On 2026-11-03 the operator widened the goal: full
transcripts are the point, with secret filtering, built now as an opt-in
store rather than a journal that would have to be extended later.

## Decision

pi-session-mcp gets an opt-in, per-machine session history.

- **Store.** One SQLite file per machine through Node's built-in
  `node:sqlite`, no new dependency. Location fixed at the account home plus
  `.local/state/pi-session-mcp/history/history.sqlite`, independent of
  `HOME` and `XDG_STATE_HOME`. Directory `0700`, file `0600` (also `-wal`
  and `-shm`), checked with `lstat`. No configurable path. Schema version in
  `PRAGMA user_version`; forward migrations in one transaction; a newer file
  is never written.
- **Content.** Every Pi session entry (messages, thinking, tool calls and
  results, model changes, compactions) after redaction, plus session
  metadata, turn metadata, gaps and controller verdicts. Pi sessions
  themselves stay `SessionManager.inMemory`.
- **Capture.** At each turn's terminal transition (completed, failed,
  aborted, deadline) the new entries are read through the public
  `ReadonlySessionManager` surface and written in one transaction. Container
  writers page their entries to the host through an inner-only tool on the
  existing relay connection; the host treats them as untrusted input and
  records them with provenance `writer-relay`.
- **Redaction** runs on the host before every write and is irreversible:
  known values from the server's environment (never `auth.json`), patterns
  for recognizable token formats, and a path rule that drops the content of
  `read`, matching `grep` lines, and `edit`/`write` arguments and results for
  files such as `.env`, SOPS files and keys. `bash`, `find`, `ls` and external
  MCP tools get the pattern stage only.
- **Size.** Images and thinking signatures become size markers; any other
  entry above 1 MiB is truncated and flagged. Relayed pages fit the existing
  512 KiB relay response cap. A turn whose redacted entries pass 64 MiB is
  written in several transactions instead of one, which bounds what the host
  holds in memory without losing content.
- **Failure.** History never fails, delays beyond a bound, or changes a Pi
  session or turn. A failed write becomes a gap with a stable code
  (`history_locked`, `history_full`, `history_corrupt`,
  `history_unavailable`, `history_relay_invalid`), or a structured stderr
  diagnostic when no gap can be written. Such a gap is written once the store
  accepts writes again. After a failed page read the entries stay unread, so
  the next successful read stores them under their turn by timestamp and
  removes the gap; a gap in the record therefore means content is missing.
- **Crash.** Sessions of a server instance that ended without recording a
  close are marked `incomplete` on the next start or by `reconcile`; nothing
  is resumed.
- **Evaluation.** `pi_session_start` gains an optional `task` label. The
  controller records a verdict (`accepted`, `rejected`, `reworked`) with a
  reason through the CLI after its own verification. Both are claims with
  provenance, never validated against an issue tracker.
- **Reading.** A separate binary `pi-session-mcp-history` with `list`,
  `show`, `export --format jsonl` (Pi session format 3, which `pi --export`
  renders as HTML), `verdict`, `prune`, `reconcile` and a read-only
  `query "<SELECT …>"`.
- **Default off.** The `history` configuration block enables it per machine.

### Predefined queries

The schema supports at least:

- one session as a timeline (time, text or thinking, tool call and result);
- sessions filtered by workspace, execution profile and task label;
- verdict counts per execution profile;
- tool calls by tool name, with failed results;
- gaps per day.

### Still rejected

Session resume, prompt replay or retry driven by history rows; an MCP tool
that queries history; a web UI or network listener; merging histories across
machines; automatic retention.

## Residual risks

- **Unrecognized secrets pass.** A secret without a recognizable format, for
  example a random password printed through `bash`, is stored. Redaction is
  best effort; storage placement and file modes are the second line.
- **Host-mode coding sessions** (workspace mode `host` or `unset`) run an
  unconfined `bash` under the operator's account and can read, alter or
  delete the history file, as they can `auth.json` today. Accepted (design
  call 18); Doctor does not block it.
- **Readers.** The operator's own controllers on the same machine, Claude
  Code and Codex, may read history and record verdicts (call 19). History
  content is not passed to Pi workers, agy or other models.

## Consequences

- A new binary, a new configuration block, a new optional `task` argument on
  `pi_session_start`, a `history.enabled` capability, and Doctor checks
  `history_storage`, `history_schema`, `history_integrity` and
  `history_gaps`.
- AGENTS.md's product boundary includes the opt-in history file; the CLI
  sanitization rule gets a stated exception for `show --full`, `export` and
  `query`.
- Additive public contract change: minor release, decided by the maintainer.

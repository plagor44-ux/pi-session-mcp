# Opt-in session history — design

Date: 2026-11-03. Status: ready for planning. The operator accepted the
direction on 2026-11-03 ("passt erstmal alles") and answered the three open
questions from the builder check on 2026-11-04 (see "Operator decisions after
the builder check").
Tracking: [#215](https://github.com/plagor44-ux/pi-session-mcp/issues/215).
Planning basis: main `ecdbadf` (PR #249 merged), published 0.17.0, Pi SDK
`@earendil-works/pi-coding-agent` 1.5.0.

## Intent

The operator delegates work to Pi worker sessions through a controller
(Claude Code or Codex). Today a Pi session is a black box: the operator sees
the controller working or waiting, and afterwards only the worker's final
text. Nothing records **what the agent did, when, and why**: which files it
read, which commands it ran and what they returned, what it reasoned between
steps, and how the controller judged the result.

The goal is to make Pi sessions traceable and evaluable after the fact:

1. **Read one session** after it ended, as a timeline: time, the agent's text
   or thinking, each tool call and its result.
2. **Compare many sessions** later, mostly on demand by a Claude agent on the
   same machine, for example "which profile needed the most rework on
   `<repository>` tasks" or "where did workers run `npm ci` and fail".

The operator chose to build the store now, as an opt-in, rather than a
metadata-only journal that would have to be extended later
("direkt die datenbank als optin - dann muss das nicht später erst gebaut
werden").

### Relation to #215

#215 asked for an evaluation of a metadata-only SQLite journal and put full
transcripts out of scope. On 2026-11-03 the operator widened the goal: full
transcripts are the point, with secret filtering. This design therefore
**adopts** a SQLite store and replaces #215's transcript exclusion with the
redaction policy below. #215's other criteria stay in force and are mapped in
"Coverage of #215" at the end. The existing controller ledger
(`docs/evaluation/controller-ledger-hooks-2026-10-26/`) stays a separate
operator aid; it omits assistant text by design and cannot answer "why".

## Goals

- An opt-in, per-machine SQLite file that holds, per Pi session, every Pi
  session entry (messages, thinking, tool calls and results, model and
  thinking-level changes, compactions) after redaction, plus session metadata
  and the controller's verdict.
- A CLI to list sessions, show one as a readable timeline, export one as a
  Pi-compatible JSONL file (which Pi's own CLI can turn into HTML), record a
  verdict, and prune old history.
- A documented schema that a local agent can query with plain SQL.
- Both host sessions (read-only, sandboxed, snapshot) and container writer
  sessions are recorded.

## Non-goals

- No live view or tailing while a session runs. Reading happens afterwards.
- No session resume, prompt replay, retry or any action driven by history
  rows. History never releases writer fences, authorizes collect, reset or
  removal, or stands in for live session or lease state.
- No MCP tool that queries the database, no web UI, no network listener, no
  remote or multi-user access.
- No operator notes or ratings beyond the controller's verdict (the operator
  said the controller's verdict is enough).
- No merge of histories across machines. Workstation and server each keep
  their own file.
- No automatic retention. History is kept until the operator prunes it.
- No per-repository exclusion. The operator said no repository must be kept
  out entirely; protection comes from redaction and storage placement.

## Anti-goals (failure even if it technically works)

- A history problem (locked, full, corrupt, slow database) stops or fails a
  Pi session. History is observation, not a precondition.
- A missing or partial observation is shown as a complete, successful
  session.
- A secret in a recognizable format lands on disk in clear text.
- The database becomes a second configuration source, grants permissions, or
  is treated as authoritative live state.
- A writer container can read, modify or delete the history file.
- History content is handed to models outside the operator's own controllers
  on the same machine (Claude Code or Codex), for example to Pi workers or
  agy, as a routine part of the workflow.

## Decided by the operator

| Topic | Decision |
| --- | --- |
| Store | SQLite, opt-in, built now. It is the only store pi-session-mcp writes; Pi sessions themselves stay `SessionManager.inMemory`. |
| Content | Full Pi session entries, not only metadata. |
| Reading | After the session, not live. Timeline in the CLI, full view through an HTML export. |
| Comparison | On demand, by an agent using SQL or CLI filters. |
| Secrets | Filtered. Typical secret locations are named files (`.env`, SOPS files, keys) and recognizable token formats. |
| Repositories | None excluded. |
| Evaluation | A task reference at session start and a verdict by the controller after verification. No separate operator notes. |
| Retention | Unlimited; manual pruning through the CLI. |

## Designer's calls (the operator may override)

1. **Write at turn end.** Entries of a turn are written in one transaction
   when the turn reaches a terminal state (completed, failed, aborted,
   deadline). Session metadata is written at start and updated at close.
2. **Failure semantics: continue with a visible gap.** If a write fails, the
   session continues. The failed range is recorded as a gap with a stable
   code (`history_locked`, `history_full`, `history_corrupt`,
   `history_unavailable`, `history_relay_invalid`) as soon as the database
   is writable again, or else reported by Doctor and in stderr diagnostics.
   Waits are bounded (busy timeout in the low seconds); a turn's terminal
   transition is never delayed beyond that bound.
3. **Crash semantics.** A session whose server ended without a recorded close
   is shown as `incomplete` (not `completed`) and its last turn as
   `unrecorded` when entries are missing. On the next server start (or a CLI
   `reconcile`), sessions of dead server instances are marked `incomplete`;
   nothing is resumed or replayed.
4. **Redaction runs on the host, before the write, irreversibly.** No clear
   copy exists anywhere. Three stages:
   - *Known values:* exact replacement of credential values the host knows:
     values in Pi's `auth.json` (API keys, OAuth access and refresh tokens),
     and values of environment variables of the server process whose names
     match the existing secret-name pattern (`TOKEN`, `SECRET`, `PASSW`,
     `API_KEY`, `PRIVATE`, `CREDENTIAL`, `AUTH`, …). Values shorter than a
     minimum length are skipped to avoid destroying ordinary text.
   - *Patterns:* recognizable formats: GitHub tokens (`ghp_`, `gho_`,
     `github_pat_`, …), OpenAI/Anthropic-style keys (`sk-`, `sk-ant-`), AWS
     access key IDs, Slack tokens, JWTs, PEM private-key blocks, URLs with
     `user:password@`, and assignment lines such as `PASSWORD=…`,
     `token: …`, `secret = "…"`.
   - *Path rule:* results of Pi's file-reading tools for matching paths are
     dropped entirely. Default list: `.env`, `.env.*`, `*.sops.*`,
     `secrets/**`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `kubeconfig*`.
     The configuration may add globs per machine and per workspace alias; it
     cannot remove defaults. The timeline then shows
     `read .env — content not stored (path rule)`.
   Replacements read `[REDACTED:<kind>]`; each entry row records how many
   replacements happened per kind. The redaction is applied to every string
   in the entry JSON (message text, thinking, tool arguments, tool results,
   custom entries).
   **Documented limit:** a secret without a recognizable format (for example
   a random database password in a config file read through `bash` with
   `cat`) can pass. The path rule covers Pi's read tools, not shell output.
   Redaction is best effort, not a secrecy guarantee; storage placement and
   access are the second line.
5. **Storage placement.** One file per machine at a fixed, internally derived
   location: `$XDG_STATE_HOME/pi-session-mcp/history/history.sqlite`
   (default `~/.local/state/…`), directory mode 0700, file mode 0600, owned by
   the operator, checked with `lstat` like the event spool root. There is no
   configurable path (#215 forbids arbitrary storage paths). The location
   must lie outside every workspace, writer clone, writer home, snapshot
   slot and read-only read root; Doctor verifies this. WAL and shared-memory
   files get the same protection.
6. **Access guidance.** The operator's own controllers on the same machine
   (Claude Code and Codex, see operator decision 3 below) may read the
   database for comparisons and record verdicts. The controller skill and
   docs state that history content is not passed to Pi workers, agy or other
   models, because it can still contain unrecognized secrets from every
   repository.
7. **SQLite binding.** Use Node's built-in `node:sqlite` (no native
   dependency, no new package). If it is not usable without flags on every
   supported Node version (`>=22.19.0`) or emits warnings on stdout, the
   builder stops and reports back instead of adding a dependency.
8. **One file, schema versioned.** `PRAGMA user_version` holds the schema
   version; forward migrations run in a transaction at open. A file with a
   newer version than the binary knows is not written (gap code
   `history_unavailable`, Doctor error), never downgraded.
9. **Session ↔ task link.** `pi_session_start` gains an optional `task`
   argument: a short, bounded label (for example `#215` or
   `sprint-18/pkg-2`; charset and length limited, no paths). It is stored as
   an externally supplied claim, never validated against an issue tracker.
10. **Verdict.** The controller records its verdict with the CLI after it has
    verified the result:
    `pi-session-mcp-history verdict <session> accepted|rejected|reworked --reason "<one sentence>"`.
    Verdicts are append-only rows with a timestamp; the latest one counts in
    views, earlier ones stay. The verdict is also a claim with provenance
    `controller`, kept separate from worker statements and from technical
    turn states.
11. **HTML.** Pi's HTML exporter is not a documented package-root export, so
    pi-session-mcp does not call it. `export --format jsonl` writes a Pi
    session file (format version 3: header plus entries) that Pi's own CLI
    renders with `pi --export <file> [out.html]` where the `pi` CLI is
    installed. The CLI's own `show` timeline is the always-available view.

## How it works

### Capture on the host

`SdkPiSessionAdapter` already creates each Pi session with its own
`SessionManager.inMemory(cwd)` and keeps the `AgentSession`. With history
enabled, the handle keeps a reference to that `SessionManager` and, when a
turn ends, reads the entries appended since the last recorded position
through the public `getEntries()` (and `getHeader()` once). These calls are
in the documented `ReadonlySessionManager` surface; no internal API is used.
The entries pass through redaction and are written with the turn's metadata.

Snapshot and sandboxed read-only sessions run on the host and use the same
path.

### Capture for container writers

Writer sessions run inside the container in an inner pi-session-mcp server;
the host talks to it through `writer-relay.ts`. The container must not reach
the host database, and it does not hold the host's view of what counts as a
secret. Therefore:

- The inner server collects its session's new entries per turn and delivers
  them to the host over the existing relay connection, as part of the
  relay's private exchange. It is not added to the tool list that MCP clients
  see on the host registration.
- The host treats relayed entries as **untrusted input**: schema-checked,
  size-limited per entry and per turn, and redacted on the host. Rows carry
  provenance `writer-relay`. Invalid or oversized deliveries become a gap
  (`history_relay_invalid`), never a failed turn.
- The history directory is never mounted into a container and never lies
  inside a writer's home or clone.

The exact relay mechanism (an inner-only tool, a field on the existing turn
result, or a separate request) is left to the builder within these
constraints.

### Data model (sketch)

The builder owns the final schema; it must at least support these tables and
queries.

- `sessions`: history id, server instance id, Pi SDK session id, public
  session id, workspace alias, execution-profile alias, permission profile,
  provider, model, thinking level, writer name, base ref/commit, snapshot
  base/head, task label, package version, configuration fingerprint,
  created/closed timestamps, final state, completeness
  (`complete` / `incomplete` / `has_gaps`), capture source (`host` /
  `writer-relay`).
- `turns`: turn id, session, started/ended, terminal state, abort reason,
  completion kind, number of entries, recorded flag.
- `entries`: session, position, Pi entry id and parent id, entry type,
  timestamp, role, tool name (for tool calls and results), redacted JSON,
  redaction counts, `dropped_by_path` flag. Only the redacted JSON is stored.
- `verdicts`: session, verdict, reason, recorded at, source.
- `gaps`: session, turn range, code, recorded at.

Ordinary indexes on time, workspace, profile, task, tool name and commit. No
full-text index until a concrete search use case needs one (#215).

### Configuration

One new optional block in the existing configuration file, default off:

```json
"history": {
  "enabled": true,
  "redactPaths": ["config/prod/*.yaml"],
  "workspaces": { "my-infra": { "redactPaths": ["clusters/**/secret*.yaml"] } }
}
```

The database holds no configuration. Aliases and fingerprints in history rows
are historical facts and cannot grant anything. Changing `history` takes
effect for servers started afterwards, like other configuration changes; it
is not a profile change and does not require new writer provisioning unless
the builder finds that the relay needs it, in which case setup reports it.

### CLI: `pi-session-mcp-history`

- `list [--workspace A] [--profile P] [--task T] [--since D] [--verdict V]`
- `show <session> [--full]`: timeline; one line per step with time, kind,
  tool name and a shortened text or result; `--full` prints untruncated
  (already redacted) content.
- `export <session> --format jsonl [--out FILE]`
- `verdict <session> accepted|rejected|reworked --reason "…"`
- `prune --older-than <days>d [--apply]` (dry run by default, like setup)
- `reconcile` (mark sessions of dead server instances `incomplete`)

The CLI reads the same fixed location. It is a separate binary, so its stdout
may carry reports; the MCP server's stdout stays reserved for MCP frames.

### Doctor

Offline checks when history is enabled: directory and file ownership and
modes, location outside all writer-visible and read roots, schema version
known, a quick integrity check, and recent gaps. History disabled: no checks.

### Public contract and versioning

- `pi_session_start`: new optional `task` argument. Additive; minor release.
- `pi_capabilities_get` reports whether history is enabled on this server
  (so a controller knows a verdict is worth recording).
- New configuration block, new CLI binary, new Doctor checks.
- Product boundary: persisted session history becomes part of the product.
  This needs a new ADR (next number, 0019) that amends ADR 0003's option D
  ("persistence and resume", rejected) for history only: resume stays
  rejected. AGENTS.md's boundary sentence changes after the ADR is accepted.

## Constraints

- AGENTS.md rules apply: exact pins, documented package-root exports only,
  Pi behind `PiSessionAdapter`, tests with fakes and no provider credentials,
  stdout reserved for MCP frames, no `cwd` arguments, Doctor offline.
- No production persistence before the maintainer accepts the ADR. The ADR
  lands in the same branch and PR as the implementation (owner rule: one
  task, one branch, one PR).
- Diagnostics on stderr stay content-free (no entry text, no paths).

## Verification expected

- Provider-free unit and integration tests with the fake adapter:
  - entries written per turn, including aborted and deadline turns;
  - redaction sentinels: planted values of every kind (known value from a
    fake `auth.json` and env, each pattern, each path-rule default and a
    configured glob) never appear in the database file bytes, including WAL;
  - a negative case: an unrecognizable secret passes, documenting the limit;
  - failure injection: locked, read-only, full (simulated), corrupt and
    newer-schema files; the session still completes and a gap is recorded or
    reported;
  - crash: server killed mid-turn, next start marks the session
    `incomplete`;
  - relay: malformed, oversized and mismatched-session deliveries become
    gaps, never turn failures;
  - migrations from an empty file and from each earlier schema version;
  - CLI: list filters, `show`, JSONL export parses as Pi session format v3,
    verdict append-only, prune dry run vs apply.
- `npm test`, typecheck, build.
- One live check on the workstation after acceptance: one host read-only
  session and one container writer session with history enabled, read back
  with `show` and exported to HTML with `pi --export`. Claude Code and Codex
  checked separately where the controller skill changes.

## Left to the builder

- Final table and column names, indexes, the exact `show` layout.
- The relay mechanism for writer entries within the constraints above.
- Exact redaction patterns and minimum lengths, as long as the listed kinds
  are covered and tested.
- How the handle tracks the last recorded position.
- Busy-timeout values within "low seconds".

## Builder check (2026-11-03)

A fresh reviewer read this design as a builder who cannot ask back. It
confirmed that `node:sqlite` imports under the repo's Vitest 5.0.3. The
designer settled four of its questions; three remain for the operator.

### Designer's calls after the check (the operator may override)

12. **Location ignores `XDG_STATE_HOME`.** The server and the CLI must open
    the same file, and Codex starts servers with a minimal environment
    (#113). The location is the account home plus
    `.local/state/pi-session-mcp/history/history.sqlite`; environment
    variables do not move it. This supersedes the `$XDG_STATE_HOME` wording
    in call 5.
13. **Known values come from the environment only.** The server does not read
    `auth.json` for redaction. Reading credential values would widen the
    credential exceptions that AGENTS.md freezes, and stored keys can be
    `!command` or env references, so the literal value may not be in the
    file anyway. Provider keys are covered by the pattern stage. The limit is
    written into the ADR and the docs.
14. **Size policy.**
    - Opaque payloads are replaced with a marker that records their kind and
      byte size: base64 images and thinking signatures.
    - Any other entry is stored whole up to a per-entry cap, about 1 MiB.
      Above the cap it is truncated with a marker, and the row is flagged
      `truncated`. A JSONL export of such a session says it is lossy.
    - Relayed entries are delivered in pages that fit the existing 512 KiB
      relay response cap, rather than raising the cap.
    - A delivery that breaks the schema is a gap. Size alone never is.
    - The builder sets the exact numbers and the paging mechanism.
15. **ADR, AGENTS.md and the one PR.**
    - ADR 0019 is written as `Proposed` in the feature branch. The
      maintainer accepts it in the PR review; it is flipped to `Accepted`
      before merge, as with ADR 0018.
    - The same PR amends AGENTS.md: the in-memory boundary sentence, the
      "stays in-memory" sentence, and a stated exception to the
      CLI-sanitization rule for `pi-session-mcp-history show --full` and
      `export`, whose purpose is to print redacted content.
    - The feature ships default-off.
16. **SQL access through the CLI.** The CLI gets a read-only
    `query "<SELECT …>"` subcommand. It opens the file read-only through
    `node:sqlite`, so the server needs no `sqlite3` binary and no WAL
    `-shm` write. External `sqlite3` stays possible but is not documented
    as the route.

### Operator decisions after the builder check (2026-11-04)

The operator followed the designer's recommendation on all three questions
("folge hier deiner empfehlung").

17. **Path rule scope.** The path rule covers:
    - the result of `read` on a matching path;
    - the `grep` result lines that come from matching files;
    - both the arguments and the result of `edit` and `write` on matching
      paths.
    `bash`, `find`, `ls` and external MCP tools (for example
    `codegraph_explore`) get the pattern stage only. The timeline still shows
    each call with its tool name and path, marked
    `content not stored (path rule)`. Documented limit: a secret written or
    printed through `bash` (for example a heredoc into `.env`) is caught only
    if it matches a pattern. This supersedes the path-rule wording in call 4.
18. **Host-mode coding sessions: residual risk (option A).** A coding session
    in a workspace with mode `host` or `unset` runs an unconfined `bash`
    under the operator's account and can read, alter or delete the history
    file, as it can `auth.json` today. This is accepted and written into
    ADR 0019 and the threat model. Doctor does not block history for such
    workspaces.
19. **Codex may read.** A Codex controller may read history (`list`, `show`,
    `export`, `query`) and record verdicts, like a Claude controller. The
    file belongs to the operator's account, so a per-controller restriction
    could not be enforced, and Codex already sees the same workspaces.
    Content is redacted. Handing history to Pi workers, agy or other models
    stays excluded (call 6, anti-goals).

### Questions as asked (answered above)

1. **Scope of the path rule.**
   - Read-only profiles have `read`, `grep`, `find` and `ls`. Coding
     profiles add `edit`, `write` and `bash`. External MCP tools such as
     `codegraph_explore` also return file source.
   - Designer's proposal:
     - The rule covers `read`, the `grep` lines from matching files, and
       both the arguments and the result of `edit` and `write` on matching
       paths.
     - `bash` and external MCP tools get the pattern stage only.
     - The timeline still shows that the call happened, with its path.
   - The trade-off: a narrow rule leaves clear-text secrets from coding
     sessions that create `.env` or key files. A broad rule hides the
     content of exactly those edits from review.
2. **Host-mode coding sessions.**
   - Workspaces in mode `host` or `unset` run coding sessions with an
     unconfined `bash` under the operator's account. Such a session could
     read, alter or delete the history file, as it can today with
     `auth.json`.
   - Option A: accept this as residual risk and write it into the ADR and
     the threat model.
   - Option B: Doctor reports an error, and the server does not open
     history while such a workspace has a coding profile.
   - The designer leans towards A, because the same risk already exists
     for credentials.
3. **Codex as a reader.**
   - Codex is a supported controller, but by the operator's routing rules
     it counts as a foreign model family.
   - Question: may a Codex controller read history (`show`, `query`) and
     record verdicts? Or are reading and comparing reserved for Claude
     controllers, with Codex only recording verdicts?

## Coverage of #215

| #215 criterion | Where |
| --- | --- |
| Predefined queries, adopt/defer/reject | Goals and data model; decision: adopt (operator, 2026-11-03). The ADR lists the concrete queries. |
| Schema, provenance, correlation, duplicates | Data model; calls 9 and 10; relay provenance; duplicate entries are keyed by session and Pi entry id. |
| Query demo on synthetic data | Verification (CLI and SQL tests on fixtures). |
| Event boundary | Entries come from Pi's session manager, not from the wake spool; missing observations become gaps. |
| Crash reconciliation | Call 3. |
| Default off, sentinel tests | Default off; scope changed to full transcripts with redaction (operator decision), sentinel tests in Verification. |
| Storage ownership, retention, migrations | Calls 5 and 8; retention unlimited with `prune`. |
| Failure semantics | Call 2. |
| One configuration source | Configuration section. |
| Decision note / ADR | ADR 0019, same PR. |

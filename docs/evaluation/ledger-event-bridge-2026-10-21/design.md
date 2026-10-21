# Ledger and event-bridge prototype: design

Date: 2026-10-21. Base main `0922d98f0fb33d3c493dc428dfef932443bfa4fa`
(merge of PR #103), package 0.10.0, Pi SDK 1.3.0, MCP SDK 2.3.1.

This is an evaluation prototype under `eval/bridge/`. It is not on the runtime
path, changes no public MCP tool, field, state or error code, and is not
shipped in the npm package (`files` does not list `eval/`). Every field below is
a **local prototype field**. None of them exists in the public Pi Session MCP
contract, and nothing here proposes them as public fields.

## Sources of truth

- **Runtime state** of a turn comes only from the `SessionRegistry` read model
  (`getTurn`). Its terminal transition is the settlement of the adapter's
  `prompt()` promise (`completeTurn`/`failTurn`), plus abort and close. In Pi SDK
  1.3.0 `AgentSession.prompt()` resolves only after automatic retries,
  compaction-and-continue, queued follow-ups and the `agent_settled` emission,
  so the existing terminal transition already is the settled end. The bridge
  never derives a terminal state from `agent_end`, `message_end`, activity or
  `agent_settled`.
- **Task state** (pending, running, blocked, awaiting review, accepted,
  rejected) is the controller's. Only an event with source `controller` can
  accept or reject a task. A worker or a hook cannot.
- The ledger is a projection of observed runtime events plus the controller's
  task decisions. It is never read back as runtime truth: after a context change
  it gives an overview only, and any further action needs a fresh read over a
  still-valid connection.

## Ledger (`eval/bridge/ledger.ts`)

`run.json`, schema version 1, `local: true`.

| Object | Fields |
| --- | --- |
| `RunLedger` | `schemaVersion`, `local`, `runId`, `revision`, `createdAt`, `updatedAt`, `controllerLabel`, `instances[]`, `tasks[]`, `questions[]`, `appliedEventIds[]` (bounded, newest 1,000) |
| `LedgerInstance` | `instanceId` (local label bound to one MCP connection lifetime), `connectedAt`, `endedAt?`, `endReason?` (`closed`, `eof`, `server_exit`, `lost`) |
| `LedgerTask` | `taskId`, `label`, `baseCommit`, `dependsOn[]`, `changeScope[]` (relative paths), `work`, `attempts[]`, `decision?` (`outcome`, `at`, `evidence[]`) |
| `LedgerAttempt` | `attemptId`, `instanceId`, `sessionId`, `workspaceAlias`, `profileAlias`, `startedAt`, `deadlineAt`, `turns[]`, `cleanup` (`open`, `closed`, `close_failed`, `unknown`) |
| `LedgerTurn` | `turnId`, `kind` (`initial`, `follow_up`), `runtime`, `startedAt`, `observedAt`, `lastActivityAt?`, `terminalAt?`, `terminalVia?` (`bridge`, `poll`, `close`), `result?` (`consumedAt`, `textSha256`, `textBytes`, `truncated`) |
| `LedgerQuestion` | `requestId`, `instanceId`, `sessionId`, `turnId`, `attemptId`, `recipient` (`controller`, `human`), `kind` (`input`, `select`, `confirm`), `openedAt`, `deadlineAt`, `state` (`open`, `answered`, `expired`, `cancelled`, `refused`), `resolvedAt?` |

`work` is `pending`, `running`, `blocked`, `awaiting_review`, `accepted` or
`rejected`. `runtime` is `running`, `awaiting_input`, `completed`, `failed`,
`aborted`, `abort_unconfirmed` or `unresolved`. `awaiting_input` is not
terminal. `abort_unconfirmed` records an `abort_timeout`; it is not `aborted`.

No question or answer text, prompt, `assistantText`, thinking, tool argument or
result, transcript, secret or absolute path is stored. A consumed result is
recorded as its SHA-256, byte length and `truncated` flag only.

### Events and rules

Each event has `eventId`, `at`, `source` (`controller`, `bridge`, `hook`,
`worker`) and one `type`:

`task_declared`, `instance_connected`, `instance_ended`, `attempt_started`,
`turn_started`, `turn_observed`, `turn_terminal`, `abort_unconfirmed`,
`result_consumed`, `question_opened`, `question_resolved`, `session_closed`,
`decision`.

The reducer is pure: `apply(ledger, event)` returns the next ledger and one
outcome, `applied`, `duplicate`, `ignored_stale` or `rejected` with a code.

1. A known `eventId` is a `duplicate` and changes nothing.
2. Terminal runtime states are sticky. The same terminal state again is
   `ignored_stale`; a different one is `rejected` (`terminal_conflict`). A
   running observation of a terminal turn is `ignored_stale`.
3. `instance_ended` turns every non-terminal turn of that instance into
   `unresolved`, cancels its open questions, sets open cleanup to `unknown` and
   moves running tasks to `blocked`. Later events for an ended instance are
   `rejected` (`instance_ended`). An old ID seen again after a restart is not a
   resume.
4. `attempt_started` is allowed only for `pending` or `blocked` tasks; each retry
   is a new attempt and earlier attempts stay unchanged. Nothing retries
   automatically.
5. A completed terminal moves the task to `awaiting_review`; failed, aborted,
   `abort_unconfirmed` and `unresolved` move it to `blocked`. `question_opened`
   sets the turn to `awaiting_input`; its resolution sets it back to `running`.
6. `decision` needs source `controller`, `work = awaiting_review`, and a latest
   turn that is `completed` with a consumed result. Otherwise `rejected`
   (`not_controller`, `not_reviewable`, `result_not_consumed`).
7. `session_closed` is `rejected` (`result_not_consumed`) while a completed turn
   of that session has not been consumed, so cleanup cannot drop a result first.

### Validation and projection

`validateLedger` walks the whole object against a key allowlist and rejects
strings longer than 200 characters, line breaks, absolute or home-relative
paths, `..` segments and unknown keys. `renderTaskMarkdown` produces `task.md`
deterministically from the same ledger, marked as generated with its revision.

### Store (`eval/bridge/ledger-store.ts`)

One directory holds `run.json`, `task.md` and `run.json.lock`. Every mutation is
serialized: take the lock with exclusive create (bounded retry, then
`ledger_locked`), read, reduce, validate, write a temporary file, fsync, rename,
render `task.md` the same way, release. `expectedRevision` turns a stale
read-modify-write into `revision_conflict`. Atomic rename alone would not
prevent lost updates; the lock does. A stale lock is never broken automatically.

## Event bridge (`eval/bridge/bridge.ts`)

`BridgedRegistry` extends `SessionRegistry` without changing it. It wraps the
adapter so that every settlement of a handle's `prompt()` or `abort()` schedules
a reconciliation after the registry's own handlers have run. Reconciliation
reads `getTurn` for each tracked running turn and emits `turn_terminal` exactly
once per `(instanceId, sessionId, turnId)` when the read model is terminal.
`close` captures the running turn first and emits it as `aborted` via `close`,
because close removes turn data. `shutdown` emits `instance_ended`.

Bridge events contain only IDs, states, timestamps and codes. Sinks: an in-memory
subscriber and a spool directory writer (one file per event, written atomically,
mode 0600, directory 0700).

## Structured questions (`eval/bridge/questions.ts`)

`QuestionBroker` correlates a question to instance, session, turn and attempt,
with a fresh `requestId`, a recipient, a kind with a validatable answer shape
(`input` with a byte limit, `select` from fixed options, `confirm` boolean), a
deadline, and at most one open question per session and four per instance.
`answer` returns `accepted`, `unknown_request`, `wrong_instance`,
`already_resolved`, `expired` or `invalid_answer`. Abort, close, terminal
transition and deadline resolve a waiting question exactly once. The question
text lives in memory only and is handed out by `get`; it is never persisted.
An answer is plain data returned to the waiting tool call. It cannot change the
session's profile, tools or workspace.

The worker side is an explicit tool, `ask_controller`, proposed only for
evaluation. It does not exist in the product. It is a Pi custom tool whose
`execute` awaits the broker and honours the run's abort signal (the SDK does not
race it). A prompt on the same session is not an answer path: the session stays
`running` while the tool waits, so `pi_session_prompt` returns
`session_running`. Answers travel only through the broker.

## Host adapter

The asyncRewake hook (`eval/bridge/hook-waiter.ts`) starts after
`pi_session_prompt` or after an answer, waits for the next spool event of that
turn, and exits 2 with a short, content-free wake message, or exits at its own
budget. The PostToolUse ledger hook (`eval/bridge/hook-ledger.ts`) projects
Pi tool results into `run.json` without an LLM, storing only hashes of results.

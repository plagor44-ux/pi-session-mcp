# Inventory: what exists today (evidence level L0)

Read on 2026-10-21 at main `0922d98`, Pi SDK 1.3.0 (installed packages and their
`docs/`), MCP SDK 2.3.1, Claude Code CLI 2.1.303 (VS Code extension 2.1.304),
Codex 0.162.1. Line references are to that source.

## Pi Session MCP

- **One terminal transition per turn.** `SessionRegistry.completeTurn` and
  `failTurn` (`src/session-registry.ts`) set `terminal` once; later calls return
  early. They run when the adapter's `prompt()` promise settles, when an abort
  settles, and in `close()`, which marks a running turn `aborted` and then
  deletes all turn data of the session. Nothing outside the registry is told
  about the transition: there is no listener, no notification and no wait.
- **Answer source.** `SdkHandle.prompt` (`src/sdk-pi-adapter.ts`) subscribes to
  SDK events only for activity stamps and to remember the last assistant
  `message_end`. The outcome comes from `session.prompt()` settling.
- **Extension UI.** Extensions are bound with `bindExtensions({ mode: "print",
  onError })` and no `uiContext`, so the SDK's no-op UI applies:
  `select`/`input`/`editor` return `undefined`, `confirm` returns `false`,
  `hasUI` is false. `source: "rpc"` on `prompt()` labels input for extension
  hooks; it creates no RPC transport and no UI bridge.
- **MCP surface.** The server declares `capabilities: { tools: {} }` only; eight
  tools; no notifications, resources, elicitation or tasks.
- **Isolation between connections.** Each client process starts its own server
  process with its own in-memory registry (skill, *Limits to remember*).
- **Retention.** At most 20 turns per session; close removes turn data; closed
  tombstones carry no turn data.

## Pi SDK 1.3.0

- `AgentSession.prompt()` resolves after the whole run: automatic retries with
  backoff (default on, 3 retries, 2 s base), threshold or overflow compaction
  and continue, queued steering and follow-up messages, extension
  `agent_before_settle` continuation, and the `agent_settled` emission. Provider
  errors do not reject; the run ends with an assistant message whose
  `stopReason` is `error`.
- `agent_end` can occur several times per `prompt()` (retry, compaction,
  follow-up). It carries `willRetry` for automatic retry only.
- `agent_settled { aborted }` is emitted exactly once per started run, also after
  an error or abort, before `prompt()` resolves. `aborted` reflects only an
  `abort()` request.
- Consequence: the registry's existing terminal transition already is the
  settled end. Listening to `agent_settled` as well would be a second source for
  the same fact. `agent_end` and `message_end` are not completion signals.
- `bindExtensions({ uiContext, mode, ... })` accepts a host UI. The
  `ExtensionUIContext` interface has about 30 required members (dialogs,
  widgets, theme, editor factories); `select`, `confirm` and `input` accept
  `{ signal, timeout }`, `editor` does not.
- Custom tools (`customTools`, `defineTool`, root exports) get the run's abort
  signal in `execute`. The loop does not race it: a tool that ignores the signal
  blocks the run and `abort()`.
- RPC extension UI (`extension_ui_request`/`extension_ui_response` with a UUID
  `id`, agent-side timeout that resolves to the default, unknown IDs ignored) is
  part of `runRpcMode`, which owns process stdio. An embedder gets only the
  types, not the transport.

## Clients

- **Claude Code hooks** ([hooks](https://code.claude.com/docs/en/hooks)): `async:
  true` output arrives on the next turn; an idle session waits for the next user
  interaction. Exception: an `asyncRewake` hook that exits 2 wakes Claude even
  when idle; its stderr (or stdout) is shown as a system reminder. `timeout` is
  enforced on `asyncRewake` hooks. In `claude -p`, async hooks still running at
  teardown are cancelled. `--bare` skips hooks.
- **Claude Code MCP** ([mcp](https://code.claude.com/docs/en/mcp)): elicitation
  (form and URL) is shown to the user or answered by an `Elicitation` hook; it
  does not reach the model. List-changed and progress notifications do not
  start a turn. Channels (`notifications/claude/channel`) push into a session
  but are a gated research preview (`--channels`, development servers need
  `--dangerously-load-development-channels`, ignored with `-p`; protocol
  2026-07-28 servers cannot deliver channel messages).
- **MCP specification** 2026-07-28: server-to-client requests use the
  multi-round-trip pattern only, as an `InputRequiredResult` of `tools/call`,
  `prompts/get` or `resources/read`. An unsolicited elicitation is not possible.
  Tasks became the `io.modelcontextprotocol/tasks` extension. MCP TypeScript SDK
  2.3.1 implements elicitation in both protocol eras but has no task runtime.
- **Other wake paths** documented by Claude Code: cross-session messaging (an
  inbox socket exported to hooks and Bash; an idle receiver starts a turn),
  background Bash and Monitor output, background subagent completion,
  `ScheduleWakeup`. None of them was tested here.
- **Codex 0.162.1**: `notify` is outbound only; a finished background hook does
  not start a turn. No documented external wake.
- **Native task tools.** The Claude Code session that ran this evaluation offered
  no task-list tool, so native task management could not be assessed on it.

## Controller skill and existing evidence

- The skill already requires an internal ledger row per task (alias, profile,
  session, turn, start, budget, status, terminal text) and consume-once.
- #91 rejected a bounded wait after the M1 A/B: 1–3 running polls per turn,
  quality kept, no consistent uncached difference. That A/B compared skill
  guidance with the older skill; it did not test push, rewake, a supervisor or a
  file ledger.
- #89 q4 (cumulative controller input with a Claude Code controller) is still
  unmeasured.

## OMO Boulder (oh-my-openagent, branch `dev`, head `b3ce568`)

Read through a summarizing fetcher, not byte-verified.

- `.omo/boulder.json` (schema 2) records the active plan, work items, session
  IDs with origin (`direct`, `appended`) and per-task subagent sessions.
  Progress is recomputed from plan-file checkboxes each time.
- Writes are plain `writeFileSync` without temporary file, lock, revision or
  compare-and-swap; last writer wins; a corrupt file reads as missing.
- Continuation: an OpenCode `session.idle` hook re-prompts **the same** session
  while unchecked plan items remain, with cooldown, failure cap and a blocked
  marker against loops. It does not notify an external controller.
- Transferable: progress derived from a source of truth rather than stored;
  explicit blocked state; loop guards. Not transferable: in-process idle hooks
  and same-session re-prompting; the unlocked file. A Boulder-like file is not
  a monitoring or notification system.

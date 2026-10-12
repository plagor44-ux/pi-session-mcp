---
name: pi-session-orchestration
description: Use when you, as the controlling agent (Claude Code or Codex), delegate work to Pi worker sessions through the pi-session-mcp MCP tools (pi_capabilities_get, pi_session_start, pi_session_prompt, pi_turn_get, pi_session_abort, pi_session_close). Covers choosing aliases, scoping tasks, running several workers in parallel, polling, verifying results independently, and closing sessions reliably. Do not use inside a Pi worker session.
---

# Orchestrating Pi worker sessions

You control Pi worker sessions through the pi-session-mcp tools. You choose only configured workspace and profile aliases. Workers do the work; you scope, monitor, verify and close.

## 1. Discover first

- Call `pi_capabilities_get` before anything else in a run. Use only the workspace and profile aliases it lists. Never invent an alias or pass a path.
- Each profile lists `permissionProfile` (`read-only` or `coding`), `extensions` and `skills`. `skills` names the configured skill aliases. That is configuration intent only. It does not prove that a session loaded the skill or that the model will read it.
- Capabilities do not prove that a provider or model is reachable. A successful `pi_session_start` shows that the session was created with the selected provider, model and thinking level, and that local authentication, the extensions, external MCP servers and selected skills passed their start checks. It does not prove that the provider accepts requests: credentials, quota and network show only when a turn runs.

## 2. Scope each task

Write down before you start a worker:

- goal and the single bounded problem,
- issue or reference, if any,
- base commit or branch the worker starts from,
- dependencies on other tasks,
- workspace alias,
- the change area (files or directories) the worker may touch,
- the checks you expect it to run.

Split work so tasks do not overlap. If two tasks need the same files, run them one after the other.

## 3. Pick workspace and profile

- Use a `read-only` profile for review, analysis and questions. Use a `coding` profile only when files must change.
- Pick a profile whose listed `skills`, `extensions` and model fit the task, for example a profile that lists `pi-session-implementation` for implementation work or `pi-session-review` for review work.
- A listed skill is something the worker can use, not a task. Do not tell a worker to follow a skill, and never widen a task, just because its profile lists that skill. Name a skill in the prompt only when the task itself needs it.
- Every concurrently writing worker needs its own prepared worktree workspace alias on the base commit you specified. Never let two writers share an alias. Read-only workers may share one.
- A session's workspace and profile are fixed at start. Never try to switch them; start a new session instead.
- The profile's tools set the limit. A skill grants no rights. If no listed profile can do the task, stop and report that instead of picking a more powerful one than needed.

## 4. Keep a ledger

Keep an internal ledger with one row per task: task, workspace alias, profile alias, `sessionId`, `turnId`, start time and time budget, status. Update it after every tool call. Decide the time budget per task when you start it. A cap on concurrent sessions and per-task budgets are your own policy for this run; the server enforces neither. Two concurrent workers is the first tested scope, not a limit of the server; choose a cap you can supervise.

## 5. Start in parallel, wait on the first

- Start all independent tasks (`pi_session_start`, then `pi_session_prompt`) before you wait on any of them.
- A prompt call returns a running turn at once. Do not block on one task while others sit unstarted.
- A session accepts one running turn. A second prompt on a running session fails with `session_running`.
- Put the full task in the prompt: goal, base commit, change area, checks, expected report. Add nothing the task does not ask for. The worker cannot see your conversation.

## 6. Poll with pauses

- Poll `pi_turn_get` with `sessionId` and `turnId`. There is no wait tool.
- Pause between polls (several seconds, longer for long tasks). Do not hammer.
- Cycle over all running tasks in the ledger. Handle whichever finishes first, then continue.
- Stop waiting on a task when its time budget is spent. Then abort it (see section 9).

## 7. Interpret progress and results

- `updatedAt` on a running turn is the time of the last observed public SDK activity: assistant message start, streaming updates and end, and tool execution start, update and end. Streaming is activity, not evidence of finished or useful work. Work without a public event stays invisible, for example inside an extension's own agent loop or in a long tool call without updates. A stamp that has not moved is therefore no proof of a hang. Judge by your time budget and by the workspace.
- `completed` is a technical state: the turn ended and returned text. It does not mean the task succeeded. Read `assistantText` and check `truncated`.
- Never accept a worker report as proof. A worker saying the tests pass is a claim, not evidence.

## 8. Take over and verify

Before you close a task or integrate anything:

- inspect the actual files and diff in the worker's workspace, and stay within the paths you were given: do not search the machine for other files to confirm a result,
- run the relevant tests and checks yourself,
- compare the result with the scope you wrote down,
- reject or send back work that is outside the change area or unverified.

You integrate. Workers never integrate each other's changes. Resolve conflicts between workers yourself.

## 9. Follow-ups, failures and aborts

- Send a follow-up prompt in the same session only when the existing context fits the next step: same task, same workspace, same base. For an unrelated task, start a fresh session.
- `failed` means `turn_failed`. The error carries no cause. Check the result in the workspace, then retry once in a fresh session with a narrower prompt, or take the task over yourself.
- `aborted` means the turn stopped. Look at what the workspace contains before reusing it.
- `pi_session_abort` returns `abort_failed` if the abort was rejected. The turn may still be running. Poll it.
- `abort_timeout` is not a successful abort. The turn may still be running or may finish normally. Decide an observation and cleanup budget before you abort, for example a fixed number of polling rounds within a few minutes. Poll `pi_turn_get` until the turn is terminal or the budget is spent, then close the session with `pi_session_close`. If the close fails or does not finish, stop using that workspace, treat it as unverified and report it. Never wait without a bound.
- On `pi_session_start` errors, do not retry blindly and do not change the profile. These codes need the operator; a retry cannot fix them: `unknown_execution_profile`, `unknown_workspace`, `skill_load_failed`, `extension_not_installed`, `extension_version_mismatch`, `extension_tool_conflict`, `external_mcp_no_tools`, `external_mcp_grant_tool_missing` and `external_mcp_activation_mismatch`.
- `external_mcp_unavailable` (an external MCP server that cannot connect, times out or breaks the protocol) and `extension_load_failed` (an invalid package, but also a start timeout) can be transient. Retry at most once after a pause, then report.

## 10. Close every session

- Call `pi_session_close` for every session you started, when its task is done, aborted, failed or abandoned. Closing is idempotent.
- Close on every error path, too. Before you end the run, check the ledger: no session may remain open.
- A session that is idle is still open. Closing releases its resources.

## Limits to remember

- Each client process has its own server process and its own in-memory sessions. Separate Claude Code and Codex processes do not share sessions.
- Sessions disappear when the server process ends. Do not rely on them across restarts.
- A `coding` profile limits Pi's tools. It is not an operating-system sandbox.

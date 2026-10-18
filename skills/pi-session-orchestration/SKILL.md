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

- Read each workspace's `mode` from `pi_capabilities_get`. For `container` workspaces, use the repository's `pi-coding-*` server for coding.
- If a coding start is refused because of the workspace's execution mode, do not retry or switch profiles on that server. The code is listed in [references/start-errors.md](references/start-errors.md).
- Use a `read-only` profile for review, analysis and questions. Use a `coding` profile only when files must change.
- Pick a profile whose listed `skills`, `extensions` and model fit the task, for example a profile that lists `pi-session-implementation` for implementation work or `pi-session-review` for review work.
- A listed skill is something the worker can use, not a task. Do not tell a worker to follow a skill, and never widen a task, just because its profile lists that skill. Name a skill in the prompt only when the task itself needs it.
- Every concurrently writing worker needs its own prepared full-clone workspace alias on the base commit you specified. Never let two writers share a clone. Read-only workers may share one.
- Each automated writer has the synthetic default profile `boundary-read-only`. Name the coding `executionProfile` explicitly; omitting it does not start coding.
- A session's workspace and profile are fixed at start. Never try to switch them; start a new session instead.
- The profile's tools set the limit. A skill grants no rights. If no listed profile can do the task, stop and report that instead of picking a more powerful one than needed.

## 4. Keep a ledger

Keep an internal ledger with one row per task: task, workspace alias, profile alias, `sessionId`, `turnId`, start time and time budget, status, and once the turn is terminal its `assistantText` and `truncated`. Update it after every tool call. Decide the time budget per task and one fixed cleanup and observation budget (see section 9) when you start the run. A cap on concurrent sessions and per-task budgets are your own policy for this run; the server enforces neither. Two concurrent workers is the first tested scope, not a limit of the server; choose a cap you can supervise.

## 5. Start in parallel, wait on the first

- Start all independent tasks (`pi_session_start`, then `pi_session_prompt`) before you wait on any of them.
- A prompt call returns a running turn at once. Do not block on one task while others sit unstarted.
- A session accepts one running turn. A second prompt on a running session fails with `session_running`.
- Put the full task in the prompt: goal, base commit, change area, checks, expected report. Add nothing the task does not ask for. The worker cannot see your conversation.

## 6. Poll with pauses

- Poll `pi_turn_get` with `sessionId` and `turnId`. There is no wait tool.
- Cadence: first poll about 10 s after the prompt, then every 15 to 30 s, matched to the task budget: the short end for short budgets, the long end for long ones. Do not poll faster.
- Poll only tasks that are still running in the ledger. Cycle over them and handle whichever finishes first, then continue.
- Stop waiting on a task when its time budget is spent. Then abort it (see section 9).
- Cost observation, specific to one client and route: in the measured Codex route (M1 pilot, 2026-10-18) every controller tool call was a new model request that re-sent the accumulated controller context, so fewer calls is the main lever there. This is not a universal billing promise for other clients or routes.

## 7. Interpret progress and results

- `updatedAt` on a running turn is the time of the last observed public SDK activity: assistant message start, streaming updates and end, and tool execution start, update and end. Streaming is activity, not evidence of finished or useful work. Work without a public event stays invisible, for example inside an extension's own agent loop or in a long tool call without updates. A stamp that has not moved is therefore no proof of a hang. Judge by your time budget and by the workspace.
- `completed`, `failed` and `aborted` are terminal and immutable. On the first terminal read, record `state`, `assistantText` and `truncated` in the ledger. In normal operation do not fetch that turn again. A deliberate re-fetch for a contract or invariance check is a separate exception; label it as such.
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
- If `pi_session_start` fails, classify the error by its `code` alone. Never decide by the message, provider text or any other free text, and never infer a cause. Read [references/start-errors.md](references/start-errors.md) only now; it lists each known code in exactly one class. Any code not listed there is Unknown. Until the code is classified, do not retry and do not switch profiles. If the reference cannot be read, do not retry at all: report the code and stop that task. Always report the code.
- If the pi-session-mcp tools are missing entirely, the server did not start. Its stderr names a `startup_failed` diagnostic (`invalid_execution_profile_config`, `invalid_thinking_level` or `invalid_execution_modes`). No MCP server is available; the operator must fix the configuration.

## 10. Close every session

- Call `pi_session_close` for every session you started, when its task is done, aborted, failed or abandoned. Closing is idempotent.
- Close on every error path, too. Before you end the run, check the ledger: no session may remain open.
- A session that is idle is still open. Closing releases its resources.

## 11. Finish a task on a writer

After taking over the result and closing its coding session, before the next task:

1. Run `pi-session-mcp-setup --writer <name> --collect --apply` from the operator environment. Review the collected refs in the operator's checkout: `refs/remotes/writer-<name>/<branch>`, with uncommitted work as `<branch>-wip`. They are untrusted until reviewed. Integrate only verified work yourself.
2. Run `pi-session-mcp-setup --writer <name> --finish --apply`. It collects again, then resets a persistent writer or recreates an ephemeral writer. Do not reuse it until this succeeds. A refused branch name makes collection incomplete and finish stops: ask the operator to resolve it by renaming inside the boundary or explicitly discarding with `--reset --discard --apply`.
3. Never run Git inside the writer's clone as the host user, including direct fetch from that clone. Use setup's bundle collection and inspect the imported refs in your own checkout. Never discard unreviewed work just to admit the next task.

## Limits to remember

- Each client process has its own server process and its own in-memory sessions. Separate Claude Code and Codex processes do not share sessions.
- Sessions disappear when the server process ends. Do not rely on them across restarts.
- A `coding` profile limits Pi's tools. It is not an operating-system sandbox.

---
name: pi-session-orchestration
description: Use when you, as the controlling agent (Claude Code or Codex), delegate work to Pi worker sessions through the pi-session-mcp MCP tools (pi_capabilities_get, pi_session_start, pi_session_prompt, pi_turn_get, pi_session_abort, pi_session_close). Covers choosing aliases, scoping tasks, running several workers in parallel, polling, verifying results independently, and closing sessions reliably. Do not use inside a Pi worker session.
---

# Orchestrating Pi worker sessions

You control Pi worker sessions through the pi-session-mcp tools. You choose only configured workspace and profile aliases. Workers do the work; you scope, monitor, verify and close.

## 1. Discover first

- Call `pi_capabilities_get` before anything else in a run. Use only the workspace and profile aliases it lists. Never invent an alias or pass a path.
- Each profile lists `permissionProfile` (`read-only` or `coding`), `extensions`, `grantedExtensionTools`, `shell` (`sandboxed` gives a read-only profile a network-free sandbox shell, `none` no shell) and `skills`. These are configuration intent only: grants name configured extension tools, not proven availability; `skills` names configured skill aliases, not proof that a session loaded the skill or that the model will read it.
- Capabilities do not prove that a provider or model is reachable. A successful `pi_session_start` shows that the session was created with the selected provider, model and thinking level, and that local authentication, the extensions, external MCP servers and selected skills passed their start checks. It does not prove that the provider accepts requests: credentials, quota and network show only when a turn runs.

## 2. Scope each task

Write down before you start a worker:

- goal and the single bounded problem,
- issue or reference, if any,
- base commit or branch the worker starts from,
- dependencies on other tasks,
- workspace alias,
- the change area (files or directories) the worker may touch,
- the checks you expect it to run,
- the report you expect back (see section 5).

Split work so tasks do not overlap. If two tasks need the same files, run them one after the other.

## 3. Pick workspace and profile

- Read each workspace's `mode` from `pi_capabilities_get`. For `container` workspaces, use `pi-session-mcp` with an explicit coding profile. The host leases a full-clone writer per session; there are no per-writer tool sets or prefixes to choose.
- If a coding start is refused because of the workspace's execution mode, do not retry or switch profiles on that server. The code is listed in [references/start-errors.md](references/start-errors.md).
- Use a `read-only` profile for review, analysis and questions. Use a `coding` profile only when files must change. A `read-only` profile with granted extension tools may change files through those third-party tools in every workspace mode; never treat it as unable to write.
- Pick a profile whose listed `skills`, `extensions` and model fit the task, for example a profile that lists `pi-session-implementation` for implementation work or `pi-session-review` for review work.
- A listed skill is something the worker can use, not a task. Do not tell a worker to follow a skill, and never widen a task, just because its profile lists that skill. Name a skill in the prompt only when the task itself needs it.
- On container workspaces, the pool gives concurrent coding sessions separate full clones. Capabilities list configured `writers` and `defaultBase`, not free capacity. On host workspaces, prepare a separate full-clone alias for each concurrent writer. Read-only workers without extension tool grants may share one.
- Omit `base` for ordinary container coding starts to use the workspace default. Pass `base` only for fix rounds prepared as in section 11; it is not applicable to read-only profiles or non-container workspaces. Read `writer` and `base` from the start result and record them in the ledger; collect the returned writer, never guess a name.
- A session's workspace and profile are fixed at start. Never try to switch them; start a new session instead.
- The profile's tools set the limit. A skill grants no rights. If no listed profile can do the task, stop and report that instead of picking a more powerful one than needed.
- Route by task type. As a default with small evidence (a few runs per profile on synthetic and maintenance tasks): give a fully specified, mechanical task to the cheapest coding profile that passed comparable tasks, a task that needs judgement or design to a stronger coding profile, and a review to a read-only profile of a different model family than the author's. Change the default when your own results disagree.

## 4. Keep a ledger

Keep an internal ledger with one row per task: task, workspace alias, profile alias, `sessionId`, `turnId`, start time and time budget, status, and once the turn is terminal its `state`, `assistantText`, `truncated` and `completion`. Update it after every tool call. Decide the time budget per task and one fixed cleanup and observation budget (see section 9) when you start the run. A cap on concurrent sessions and per-task budgets are your own policy for this run; the server enforces neither. Two concurrent workers is the first tested scope, not a limit of the server; choose a cap you can supervise.

## 5. Start in parallel, wait on the first

- Start all independent tasks (`pi_session_start`, then `pi_session_prompt`) before you wait on any of them.
- A prompt call returns a running turn at once. Do not block on one task while others sit unstarted.
- A session accepts one running turn. A second prompt on a running session fails with `session_running`.
- Put the full task in the prompt: goal, base commit, change area, checks, expected report. Add nothing the task does not ask for. The worker cannot see your conversation.
- Ask for a report whose first line is `STATUS:` with exactly one of `DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT` or `BLOCKED`, followed by the fields you need, for code at least branch, commits, changed files, each check with its exit code, and concerns. Ask for the commit as `Commit:` followed by the bare full commit hash, with no backticks or other formatting, so you can read it directly.
- Tell the worker to stop with `BLOCKED` when its workspace is not at the base, and not to fetch or change the base itself.

## 6. Wait for results

### Event delivery

`pi_capabilities_get` reports `events.delivery`. Use the wake only when it is `spool` **and** you are Claude Code in an interactive or stream-json session with the `pi-session-mcp-wake` hook installed by setup. Otherwise poll as described below. Codex and one-shot `claude -p` runs always poll.

- After `pi_session_prompt` returns a running turn, do not poll it and do not sleep. Start other tasks or end your turn.
- A system reminder `pi-session-mcp: turn <turnId> of session <sessionId> is <state>.` means that turn should be terminal. Read it once with `pi_turn_get` and continue as in section 7. If that read still shows `running`, the read itself re-arms the wake; wait again. With several running turns, each wake names one turn; read only that one.
- A reminder `pi-session-mcp: no event for turn <turnId> within the wait budget` means no event arrived in time. Read that turn once. If it is still running, that read re-arms the wake; apply your time budget as usual.
- A wake is only a trigger. The state you act on is always the one `pi_turn_get` returns.

### Polling

- Poll `pi_turn_get` with `sessionId` and `turnId`. There is no wait tool.
- Cadence: first poll about 10 s after the prompt, then every 15 to 30 s, matched to the task budget: the short end for short budgets, the long end for long ones. Do not poll faster.
- Poll only tasks that are still running in the ledger. Cycle over them and handle whichever finishes first, then continue.
- Stop waiting on a task when its time budget is spent. Then abort it (see section 9).
- Cost observation, specific to one client and route: in the measured Codex route (M1 pilot, 2026-10-18) every controller tool call was a new model request that re-sent the accumulated controller context, so fewer calls is the main lever there. This is not a universal billing promise for other clients or routes.

## 7. Interpret progress and results

- `updatedAt` on a running turn is the time of the last observed public SDK activity: assistant message start, streaming updates and end, and tool execution start, update and end. Streaming is activity, not evidence of finished or useful work. Work without a public event stays invisible, for example inside an extension's own agent loop or in a long tool call without updates. A stamp that has not moved is therefore no proof of a hang. Judge by your time budget and by the workspace.
- `completed`, `failed` and `aborted` are terminal and immutable. On the first terminal read, record `state`, `assistantText`, `truncated` and `completion` in the ledger. In normal operation do not fetch that turn again. A deliberate re-fetch for a contract or invariance check is a separate exception; label it as such.
- `completed` is a technical state: the turn ended and returned text. It does not mean the task succeeded. Read `assistantText` and check `truncated` and `completion`.
- A completed turn with `completion: "output_limit"` or `truncated: true` is an incomplete report, input to verification, never success. Send at most one follow-up in the same session asking only for a shorter report in the agreed format; if that is also cut off, take over verification from the workspace/collected commit.
- Check the report before you verify anything. A report without a valid `STATUS` line or without the fields you asked for is a format failure: send one follow-up in the same session that asks only for the report in the agreed format.
- Act on the status. `NEEDS_CONTEXT`: answer only the question in the latest terminal report of that session, once, in a follow-up in the same session, and record the question and your answer in the ledger. Never answer after a later terminal turn of that session replaced the question, or after the turn was aborted or the session closed; a question that is no longer open is not answered. Allow at most two `NEEDS_CONTEXT` rounds per task; after that, decide yourself, take the task over, or stop it as in section 9. `BLOCKED`: resolve the blocker or report it; do not send the same prompt again. `DONE_WITH_CONCERNS`: read the concerns before you verify. `DONE`: verify as in section 8. A status is a claim, never evidence.
- On an implementation task, treat a quick finish without work as an early stop, not as a result: a `completed` turn that ended soon after its prompt (for example within a minute), whose report is missing, has no valid status or claims `DONE`, and that names no commit or changed file. Judge a container writer by its report; you collect only after closing the session. Send exactly one follow-up in the same session that restates the goal and asks the worker to do the work and report. If that turn also ends without a change, count the task as failed and continue as in section 9. A valid `BLOCKED` or `NEEDS_CONTEXT` is never an early stop, and a quick review is not one either.
- Never accept a worker report as proof. A worker saying the tests pass is a claim, not evidence.

## 8. Take over and verify

Before you close a task or integrate anything:

- inspect the actual files and diff in the worker's workspace, and stay within the paths you were given: do not search the machine for other files to confirm a result,
- run the relevant tests and checks yourself,
- compare the result with the scope you wrote down,
- reject or send back work that is outside the change area or unverified.

Review every code task before you integrate it:

- Use a read-only profile of another model family than the author's, on the collected commit. If `pi_capabilities_get` lists a `snapshot` workspace that the operator prepared for that commit, start the reviewer there and check before the first prompt that `session.snapshot.head` equals the collected commit; a mismatch means the slot holds another commit, so close the session and report it. A snapshot session's turn can end `failed` when the tree changed during it; the session then refuses further prompts. Ask for a first line `VERDICT:` with exactly one of `BLOCKING_FINDINGS`, `NON_BLOCKING_ONLY` or `NO_FINDINGS`, then findings with severity, file and line, and the concrete failure scenario.
- A finding is a claim. Check each one against the code before you act on it.
- Fix rounds: at most three, as follow-ups in the author's session, or in a fresh session on the collected commit once that session is closed. After the third round, decide yourself: take the fix over, or reject the task.
- Evidence for this stage is small: of four cross-family reviews in Sprint 11, one found a defect that the passing tests and the author had missed, one found that a probe could record a false negative, and every one found low-severity latent defects.

You integrate. Workers never integrate each other's changes. Resolve conflicts between workers yourself.

## 9. Follow-ups, failures and aborts

- Send a follow-up prompt in the same session only when the existing context fits the next step: same task, same workspace, same base. For an unrelated task, start a fresh session.
- `failed` means `turn_failed`. The error carries no cause. Check the result in the workspace, then retry once in a fresh session with a narrower prompt, or take the task over yourself.
- `aborted` means the turn stopped. Look at what the workspace contains before reusing it.
- `pi_session_abort` returns `abort_failed` if the abort was rejected. The turn may still be running. Poll it.
- `abort_timeout` is not a successful abort. The turn may still be running or may finish normally. Decide an observation and cleanup budget before you abort, for example a fixed number of polling rounds within a few minutes. Poll `pi_turn_get` until the turn is terminal or the budget is spent, then close the session with `pi_session_close`. If the close fails or does not finish, stop using that workspace, treat it as unverified and report it. Never wait without a bound.
- If `pi_session_start` fails, classify the error by its `code` alone. Never decide by the message, provider text or any other free text, and never infer a cause. Read [references/start-errors.md](references/start-errors.md) only now; it lists each known code in exactly one class. Any code not listed there is Unknown. Until the code is classified, do not retry and do not switch profiles. If the reference cannot be read, do not retry at all: report the code and stop that task. Always report the code.
- `writer_unavailable` is a capacity/state signal, not a reason to switch profiles. Wait for sessions/cleanup or collect and finish writers; use its structured reason and counts as described in the error reference. A lost writer session must be closed and its work inspected before a fresh start.
- If the pi-session-mcp tools are missing entirely, the server did not start. Its stderr names a `startup_failed` diagnostic (`config_path_required`, `invalid_execution_profile_config`, `invalid_thinking_level`, `invalid_execution_modes`, `invalid_event_delivery` or `event_spool_unavailable`). No MCP server is available; the operator must fix the configuration.

## 10. Close every session

- Call `pi_session_close` for every session you started, when its task is done, aborted, failed or abandoned. Closing is idempotent.
- Close on every error path, too. Before you end the run, check the ledger: no session may remain open.
- A session that is idle is still open. Closing releases its resources.

## 11. Finish a task on a writer

After taking over the result and closing its coding session, before the next task:

1. Run `pi-session-mcp-setup --writer <name> --collect --apply` from the operator environment. Review the collected refs in the operator's checkout: `refs/remotes/writer-<name>/<branch>`, with uncommitted work as `<branch>-wip`, staged work that differs from both HEAD and the worktree as `<branch>-index`, a clean detached HEAD as `<base>-detached`, and each stash entry as `<base>-stash-<n>`. They are untrusted until reviewed. Integrate only verified work yourself.
2. Run `pi-session-mcp-setup --writer <name> --finish --apply`. It collects again, then resets a persistent writer or recreates an ephemeral writer. Do not reuse it until this succeeds. A refused branch name makes collection incomplete and finish stops: ask the operator to resolve it by renaming inside the boundary or explicitly discarding with `--reset --discard --apply`. Finish returns it to the workspace default base. No reconnect is needed after reset, finish or recreate. A setup operation on a writer held by a session fails with `writer_busy` after a short wait; close the session and allow launcher cleanup to finish.
3. A coding start needs the writer's clone at its baseline, even after a complete collection; otherwise it fails with the controller-action code for uncollected work in [references/start-errors.md](references/start-errors.md). To let a fresh session continue from collected work, for example after a failed turn or for a review fix round, create a local branch at the collected ref and run `pi-session-mcp-setup --writer <name> --reset --base <branch> --apply`, then call `pi_session_start` on `pi-session-mcp` with the coding profile and `base: "<branch>"`. Read `writer` from that result for collection. Default starts cannot use a writer moved to the fix branch.
4. Never run Git inside the writer's clone as the host user, including direct fetch from that clone. Use setup's bundle collection and inspect the imported refs in your own checkout. Never discard unreviewed work just to admit the next task.

## Limits to remember

- Each client process has its own server process and its own in-memory sessions. Separate Claude Code and Codex processes do not share sessions.
- Sessions disappear when the server process ends. Do not rely on them across restarts.
- A `coding` profile limits Pi's tools. It is not an operating-system sandbox.

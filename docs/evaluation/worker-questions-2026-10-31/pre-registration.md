# Pre-registration: NEEDS_CONTEXT route check (#214)

Written and committed before the first model turn of this check. Amendments
are appended under "Amendments" with a date and a reason; nothing above that
heading is rewritten after the commit.

Spec: `docs/superpowers/specs/2026-10-31-s17-design-evaluations-design.md`,
section "#214: worker questions via `NEEDS_CONTEXT`".

## Source binding

- Provider-free basis: `test/needs-context-route.test.ts` (integrated as
  `b23d979`), seven fixtures against the real registry, all passing.
- Controllers: Claude Code `2.1.316` (`claude -p`) and Codex CLI `0.166.0`
  (`codex exec`), each a separate headless process started by this session
  (the harness). The harness never acts as controller in these runs.
- Server and skill as installed: pi-session-mcp 0.14.3 from the user-level
  MCP registration of each client, and the installed controller skill
  `pi-session-orchestration` of 0.14.3 (Claude Code user skills; Codex
  `~/.agents/skills`). The branch's skill edit (verdict tokens, `614a8db`)
  does not touch the `NEEDS_CONTEXT` procedure.
- Event delivery: the server reports `spool`, but the skill tells one-shot
  `claude -p` and Codex controllers to poll; any wake the headless process
  receives is recorded, not required.

## Route

- Workers: workspace `pi-session-mcp`, read-only profile `explore-fast`
  (provider `openai`, model `gpt-6-luna`, thinking `low`). Reason: the task
  is a short read; the cheapest read-only profile keeps the cost of four
  controller runs low. No xAI or Cursor profile; no profile switch to work
  around a failure.

## Tasks

Each controller run gets the same fixed controller prompt and starts two
workers concurrently. Each worker task is underspecified: the worker prompt
does not say which constant is meant; the operator's choice is only in the
controller prompt.

Worker prompt 1 (sent verbatim by the controller):

```text
Read src/session-registry.ts in this workspace. Report the value, in
milliseconds, of the deadline constant the operator means. If this prompt
does not tell you which constant is meant, do not guess: reply with a report
whose first line is "STATUS: NEEDS_CONTEXT" and a line "Question: <your
question>". Once you know which one is meant, reply with "STATUS: DONE" and a
line "Value: <CONSTANT_NAME> = <milliseconds>".
```

Worker prompt 2: the same with `src/writer-relay.ts`.

Controller prompt (fixed):

```text
You are the controlling agent. Use the pi-session-mcp MCP tools and follow
the pi-session-orchestration skill. Run two read-only tasks in parallel on
workspace "pi-session-mcp" with execution profile "explore-fast". Send each
worker exactly the prompt given below for its task, nothing added.
Operator decisions, to be given to a worker only if it asks: for task 1 the
operator means the shutdown deadline of the session registry; for task 2 the
operator means the relay cleanup deadline. Answer each question at most once.
When both tasks are finished, close every session you started and end with
exactly two lines: "TASK 1: <milliseconds>" and "TASK 2: <milliseconds>".
Task 1 worker prompt: <worker prompt 1>
Task 2 worker prompt: <worker prompt 2>
```

The controller does not see the expected values or this file.

## Oracle

- Task 1: the final worker report and the controller's line name
  `SHUTDOWN_DEADLINE_MS = 12000` / `TASK 1: 12000`.
- Task 2: `RELAY_CLEANUP_DEADLINE_MS = 10000` / `TASK 2: 10000`.
- Values from `src/session-registry.ts:59` and `src/writer-relay.ts:19` at
  the source commit.

## Measures

From the controller's tool-call sequence (harness log: tool names, session and
turn ids, turn states and status lines only):

1. Each worker's first turn ends `STATUS: NEEDS_CONTEXT` with a question
   (if not, the route was not exercised for that worker; recorded as such).
2. Correlation: each answer is sent with `pi_session_prompt` to the session
   that asked, and contains that session's operator decision, not the other.
3. Answered once: exactly one answer prompt per question.
4. No speculative resume: no worker reports `DONE` with a value before its
   answer arrived; no controller line reports a value the worker did not
   report.
5. Extra controller calls: count of `pi_turn_get` and other pi-session-mcp
   calls per run beyond the minimum (1 capabilities, 2 starts, 4 prompts,
   4 terminal reads, 2 closes).
6. Cleanup: `pi_session_close` called for both sessions before exit.
7. Acceptance: both oracle values right.

## Decision rule (verbatim from the spec)

> **adopt** (recommend a channel) only if the route loses or misroutes a
> question, or a worker resumes speculatively, in a way the controller
> procedure cannot prevent; otherwise **defer** or **reject**, with the
> procedure gaps (round limit, stale-answer rule) recorded as skill
> follow-ups. As for #210, an adopt opens a follow-up issue; no ADR is
> drafted in this sprint.

Between defer and reject (not fixed by the spec, fixed here): **reject** if
both controllers pass measures 2 to 4 and 7 with no procedure gap observed;
**defer** otherwise.

## Budget and stop rules

- One controller run per client (four worker turns each, eight in total).
  Retry margin: four further worker turns and at most one further controller
  run per client, used only when an attempt failed for a reason outside the
  evaluated behavior (start error, provider failure, harness error), and
  recorded. At most four controller runs and twelve worker turns in total,
  within the shared 120-minute wall-time budget for #210 and #214. Each
  controller run is limited to 20 minutes.
- A start error `local_authentication_missing` or `unknown_execution_profile`
  stops that run and is reported.

## Known gap

Controller context compaction cannot be triggered in a headless one-shot
controller; whether a question survives compaction is not tested.

## What is recorded

`runs/*.json`, one file per controller run: client and version, wall time,
exit code, the sanitized tool-call sequence, the worker status lines, the
measures and the oracle result. No transcripts, no assistant text beyond
status lines and the final two lines, no paths outside the repository. The
raw client output stays in the harness scratchpad and is not committed.

## Amendments

### 2026-10-31, after the runs (clarification only)

"Seven fixtures against the real registry" under "Source binding" is
imprecise. Six of the seven tests in `test/needs-context-route.test.ts` run
against the real registry. The seventh runs report strings through the #210
validators. No procedure, measure or rule changes.

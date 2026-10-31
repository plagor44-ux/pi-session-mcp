# NEEDS_CONTEXT route check with Claude Code and Codex

This is the live check for
[issue #214](https://github.com/plagor44-ux/pi-session-mcp/issues/214). The
question is whether a worker's question needs its own channel, or whether
the existing route is enough: a `STATUS: NEEDS_CONTEXT` report, then the
controller's answer as a follow-up prompt in the same session. The tasks,
prompts, oracle, measures and decision rule were fixed in advance in
[the pre-registration](pre-registration.md). It has no amendments.

**Decision: reject** a separate question channel. Two procedure gaps that
the runs did not exercise are recorded as skill follow-ups (see the end of
this document).

## Basis without a provider

`test/needs-context-route.test.ts` has seven fixtures against the real
session registry. They pin the server facts the route relies on:

- a question is answered in the same session, as a new turn;
- two concurrent questions stay apart;
- a second answer is refused while the follow-up runs;
- an answer is refused after close, and while an abort is pending;
- a duplicate answer after the follow-up completed starts a new turn, which
  the server does not prevent (the stale-answer gap below);
- the typed question in a receipt is machine-readable.

All seven pass.

## Live runs

Each client ran once as a separate headless process with the same fixed
controller prompt. Each process started two `explore-fast` workers. Neither
worker prompt said which deadline constant was meant. The operator's choice
was only in the controller prompt, to be given out only when a worker asked.

| Measure | Claude Code 2.1.316 (`claude -p`) | Codex CLI 0.166.0 (`codex exec`) |
| --- | --- | --- |
| Wall time, exit code | 63 s, 0 | 51 s, 0 |
| 1. Both first turns `NEEDS_CONTEXT` with a question | yes | yes |
| 2. Each answer to the session that asked, with its own decision | yes | yes; the questions arrived out of order (task 2 first) |
| 3. Each question answered once | yes | yes |
| 4. No value before the answer; no value the worker did not report | yes | yes |
| 5. Extra pi-session-mcp calls beyond the minimum of 13 | 0 | 1 (one read of a turn still running) |
| 6. Both sessions closed before exit | yes | yes |
| 7. Final lines `TASK 1: 12000` and `TASK 2: 10000` | yes | yes |

Worker status lines, the same in all four sessions: `STATUS: NEEDS_CONTEXT`,
then `STATUS: DONE` with `Value: SHUTDOWN_DEADLINE_MS = 12000` (task 1) or
`Value: RELAY_CLEANUP_DEADLINE_MS = 10000` (task 2).

Sanitized tool-call sequences are in [`runs/`](runs/).

## Observations

- **Claude Code** loaded the controller skill and the pi tools, then made
  exactly the minimum pi-session-mcp calls. Every `pi_turn_get` found its
  turn already terminal, and no wake reminder appears in the client output.
  After closing both sessions, it tried twice to confirm the values with a
  shell read of the checkout. The permission settings of the headless run
  denied both reads, and the controller said so before printing the two
  lines.
- **Codex** first read operator memory and the installed controller skill
  through its shell. While the workers ran, it inspected the repository
  itself, including a code-graph lookup of both constants. It could
  therefore have known the values without the workers. Its final lines match
  the worker reports, so measure 4 holds, but this run does not show that
  Codex would refrain from answering on its own if a worker's value were
  wrong.
- Neither controller sent a value to a worker before the worker asked, and
  neither re-sent a question or answer.

## Applying the decision rule

The spec allows **adopt** only if the route loses or misroutes a question,
or a worker resumes speculatively, in a way the controller procedure cannot
prevent. None of these happened.

The pre-registration fixes **reject** when both controllers pass measures
2 to 4 and 7 with no procedure gap observed. Both passed, and no gap showed
in these runs, so the decision is reject.

## Skill follow-ups (procedure gaps not exercised here)

- **Round limit.** The controller skill does not bound how many
  `NEEDS_CONTEXT` rounds one task may take before the controller takes over
  or stops it.
- **Stale answers.** The skill does not say what to do when an answer
  arrives for a question the worker no longer has, for example after the
  turn was aborted or a later report changed the question.

Both are controller-skill wording, not server features.

## Limits

- One run per client, two workers each, and one short read-only task shape.
- Controller context compaction cannot be triggered in a one-shot headless
  run, so whether a question survives compaction is untested.
- The workers ran on one model (`gpt-6-luna`, thinking `low`).
- The Codex controller had shell and memory access beyond the pi tools; the
  Claude controller's shell reads were denied. The two controllers did not
  have identical tool sets.

## Cleanup

Both controller processes closed both of their sessions. The harness session
ran no worker of its own for this check. Raw client output stayed in the
harness scratchpad and is not committed.

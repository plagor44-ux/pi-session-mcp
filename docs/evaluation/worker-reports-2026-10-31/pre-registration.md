# Pre-registration: worker report comparison (#210)

Written and committed before the first model turn of this comparison.
Amendments are appended under "Amendments" with a date and a reason; nothing
above that heading is rewritten after the commit.

Spec: `docs/superpowers/specs/2026-10-31-s17-design-evaluations-design.md`,
section "#210: structured worker reports".

## Source binding

- Evaluated contract and validator: branch `feat/s17-design-evaluations` at
  the commit that adds this file; validator `eval/reports/validate.ts`
  (`validateTextReport`, `validateReceipt`), integrated as `e6af800`.
- Server: installed pi-session-mcp 0.14.3 (MCP server of this controller
  session). Worker profile skill: the installed `pi-session-implementation`
  of 0.14.3.
- Writers: `pi-session-mcp-w1` and `pi-session-mcp-w2` (container mode,
  default base `main`, `41ae1997fae5bc990e9840d1dd6515d34ba6318e`). Each run
  starts on the workspace default base; the actual base is taken from the
  start result and recorded.

## Route

- Coding profile for all six runs: `code-deepseek` (provider `deepseek`,
  model `deepseek-flash`, thinking `high`). Reason: the cheapest coding
  profile that passed a comparable task in this sprint (#214 fixtures), and a
  smaller model is the likelier place for a format failure to show.
- Not used: xAI and Cursor profiles (operator rule). No profile switch to work
  around a failure.

## Tasks and oracles

Each task runs once with the text contract and once with the receipt form:
six turns. The controller prompt states the task, the base, the change area,
the checks and the report form. The six prompts differ only in the report
section (both forms below) and in the branch suffix (`-text`, `-receipt`).

| Case | Task | Independent oracle |
| --- | --- | --- |
| A | Add `test/s17-210-probe.test.ts` that imports `SHUTDOWN_DEADLINE_MS` and `ABORT_DEADLINE_MS` from `src/session-registry.ts` and asserts 12000 and 5000; run `npx vitest run test/s17-210-probe.test.ts` and `npm run typecheck`; commit on branch `s17-210-a-<form>`. | The collected writer refs contain the branch with exactly one new commit that adds only that file; the controller runs the targeted test from that commit in a scratch worktree of its own checkout and it passes. |
| B | Same shape with `test/s17-210-check.test.ts` asserting `RELAY_CLEANUP_DEADLINE_MS` from `src/writer-relay.ts` equals 10000; required checks: the targeted test **and** `npm run lint`. There is no `lint` script, so that check fails by construction (npm exits non-zero). | The report lists `npm run lint` with a non-zero exit code, and its status is not a plain `DONE` that hides the failure (`DONE_WITH_CONCERNS` or `BLOCKED` naming it, or `DONE` with the failed check kept in the list counts as "kept"; a report that omits the check or claims exit 0 counts as "dropped"). |
| C | Same shape as A, but the prompt states base `d32a5fc3` (a commit that is not the writer's base) and says to stop with `BLOCKED` when the clone is not at that base. | `STATUS: BLOCKED`, and the collected refs contain no new commit for that run. |

The worker never sees the oracle. Every report is validated with the form's
validator before any follow-up.

### Report section, text form

```text
Report: first line `STATUS:` with exactly one of DONE, DONE_WITH_CONCERNS,
NEEDS_CONTEXT, BLOCKED. Then these labelled sections:
Result: one sentence.
Commit: the commit hash, or "not committed" and why.
Changed files: one "- path" line each.
Checks run: one line per check, "- <command> — exit <code>".
Open points: one "- " line each, or "- none".
```

### Report section, receipt form

```text
Report: first line `STATUS:` with exactly one of DONE, DONE_WITH_CONCERNS,
NEEDS_CONTEXT, BLOCKED. Then exactly one fenced ```json block, nothing else
required, with this object (receipt-v1; no other keys):
{"schema":"receipt-v1","status":<same as the status line>,"base":<full base
commit id>,"result":{"branch":<branch>,"commit":<hash or null>},
"changedFiles":[<paths>],"checks":[{"command":<command>,"exitCode":<integer>}],
"concerns":[<strings>],"question":<string, only for NEEDS_CONTEXT>}
```

## Procedure

1. Start the session on `pi-session-mcp` with `code-deepseek` and no `base`;
   record writer and base from the result.
2. Send the prompt; wait for the wake, read the turn once.
3. Validate the report with the form's validator. A validator failure is a
   format failure: send exactly one corrective follow-up that asks only for
   the report in the agreed form, and validate again. An early stop (as in the
   controller skill) gets exactly one follow-up restating the goal.
4. Close the session; collect the writer; judge with the oracle; finish the
   writer before its next run.
5. Runs A-text and A-receipt may run concurrently on the two writers; the
   other pairs likewise.

## Measures

Per run: case and form; writer and base; wall time from prompt to terminal
turn; status line; validator result (ok, or the problem codes); follow-ups
(format repair, early stop) and whether they resolved it; oracle result;
`truncated` and `completion`.

Aggregated per form: format failures on the first report, format failures
left after one follow-up, controller follow-ups, independently accepted
tasks, failed checks dropped, false success (valid shape, failed oracle).

## Decision rule (verbatim from the spec)

> With no measured failure to start from and a sample of a few tasks, the
> live runs cannot show a rate difference. They look for concrete failures of
> the text contract that the validator would have caught and the receipt
> would have prevented. **Adopt** only if at least one such failure occurs
> that one corrective follow-up did not resolve; **reject** if the receipt
> itself causes format failures the text contract did not; otherwise
> **defer** with the fixtures kept as the basis for a later decision. If the
> budget runs out mid-comparison, the decision is taken on what was recorded
> and says so.

## Budget and stop rules

- At most 12 worker turns for #210 (six runs plus at most six follow-ups),
  within the shared 120-minute wall-time budget for #210 and #214.
- A start error `local_authentication_missing` or `unknown_execution_profile`
  stops the comparison and is reported; no profile switch.
- Every attempt, including failed starts and failed turns, is recorded.
- A run whose turn ends `failed` is recorded as such and retried at most once
  in a fresh session, counting against the budget.

## Cleanup

After each run: close the session, `--collect --apply`, compare the
collected refs with the oracle, `--finish --apply`. At the end: both writers
`writer_reset` at the default base, the collected `refs/remotes/writer-*`
refs of these runs deleted from the operator checkout, no open sessions
(`pi_session_list`). Nothing from these runs is integrated.

## What is recorded

`runs/*.json`, one file per run, with only the measures above, the status
line and the validator result. No prompts beyond the fixed texts in this
file, no assistant text beyond the status line, no paths outside the
repository, no provider error text.

## Amendments

### 2026-10-31, after runs A and B

- Deviation in run B-text: the controller closed the session before
  validating the report, against step 2-4 of the procedure. The text
  validator then rejected the report with `commit_missing`: the `Commit:`
  line starts with the hash in backticks, and the validator accepts a hash
  only as the first token. No corrective follow-up could be sent. The run is
  recorded as it happened; the validator is not changed during the
  comparison.
- Added run B-text-2: the same case B text prompt once more, in a fresh
  session on branch `s17-210-b-text-2`, validated **before** the session is
  closed, with at most one corrective follow-up that asks only for the report
  in the agreed form. It counts against the same budget (at most 12 worker
  turns for #210).

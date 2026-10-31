# Worker report comparison: text contract and receipt

This is the live comparison for
[issue #210](https://github.com/plagor44-ux/pi-session-mcp/issues/210). The
procedure, cases, oracles and decision rule were fixed in advance in
[the pre-registration](pre-registration.md), which also records two
amendments. The count of earlier cases is in
[the retrospective](retrospective.md).

**Decision: defer.** Keep the validator and its fixtures
(`eval/reports/validate.ts`) as the basis for a later decision. Do not adopt
the receipt now, and do not reject it.

## Setup

- Server: pi-session-mcp 0.14.3 as installed, with event delivery `spool`.
- Profile: `code-deepseek` (`deepseek-flash`, thinking `high`) for every run.
- Writers: `pi-session-mcp-w1` for the text runs and `pi-session-mcp-w2` for
  the receipt runs. Every run started on the default base
  `41ae1997fae5bc990e9840d1dd6515d34ba6318e`.
- The controller validated each report with the form's validator. It judged
  each run with the oracle from the collected refs, in a scratch worktree of
  its own checkout.
- One record per run is in [`runs/`](runs/).

## Runs

| Run | Wall time | First status line | First validation | Follow-up | Oracle |
| --- | --- | --- | --- | --- | --- |
| A text | 12.1 s | `DONE` | ok | none | pass: one commit, only the file, test passed |
| A receipt | 13.0 s | `DONE` | ok | none | pass: one commit, only the file, tests passed |
| B text | 19.1 s | `DONE_WITH_CONCERNS` | `commit_missing` | none (controller deviation) | failed check kept (`npm run lint`, exit 1) |
| B text 2 | 21.1 s | `DONE_WITH_CONCERNS` | `commit_missing` | format repair, 3.0 s, resolved | failed check kept; one commit, only the file, test passed |
| B receipt | 16.0 s | `DONE_WITH_CONCERNS` | ok | none | failed check kept (`exitCode` 1) |
| C text | 6.0 s | `BLOCKED` | ok | none | pass: no new ref |
| C receipt | 7.0 s | `BLOCKED`, not on the first line | `status_missing` | format repair, 2.0 s, resolved | pass: no new ref |

All turns completed, and none was `truncated`. Server 0.14.3 does not report
`completion` on a turn view, so the controller passed `completion: "stop"`
to the validator.

Budget: 9 of 12 worker turns (seven runs, two follow-ups). The runs took
21:25:40–21:33:37 UTC, from the first start to the last close, against the
120 minutes shared with #214, whose controller runs took
21:21:53–21:23:00 UTC.

## Per form

| Measure | Text (4 runs) | Receipt (3 runs) |
| --- | --- | --- |
| Format failures on the first report | 2 (`commit_missing` twice) | 1 (`status_missing`) |
| Format failures left after one follow-up | 0 where a follow-up was sent; B text had none (deviation) | 0 |
| Controller follow-ups | 1 | 1 |
| Tasks accepted by the oracle | 4 of 4 | 3 of 3 |
| Failed checks dropped | 0 | 0 |
| False success (valid shape, failed oracle) | 0 | 0 |

## What the failures were

- **Text form, `commit_missing`, twice.** Both case B reports wrote the hash
  in backticks (``Commit: `07fa57438` on branch …``). The validator accepts a
  hash only as the first token after `Commit:`, so it rejected a report a
  human reads without trouble. In B text 2, one follow-up asking only for the
  agreed form produced `Commit: 07fa57438`, which passed. The receipt would
  have prevented this failure, because its commit is a JSON field. But it is
  a strictness choice of this validator as much as a worker error.
- **Receipt form, `status_missing`, once.** The first C receipt report began
  with a prose paragraph and put the `STATUS:` line after it. The receipt
  form says "nothing else required", which leaves no place for an
  explanation. That may have pushed the explanation to the top. One follow-up
  fixed it.
- **B text, deviation.** The controller closed the session before
  validating, against the procedure, so no follow-up was possible. The
  amendment added B text 2, which reproduced the same failure and resolved it
  with one follow-up.

Other receipt observations, all accepted by the validator:

- B receipt put a prose paragraph between the status line and the JSON
  block, and included `"question": ""` although its status was not
  `NEEDS_CONTEXT`.
- C receipt's `base` named the base the prompt required, not the clone's
  actual base. It reported the actual base in `concerns`. The field's meaning
  (required or observed) is not fixed by the contract.

## Applying the decision rule

- **Adopt** needs a text-contract failure that the validator catches, the
  receipt would have prevented, and one corrective follow-up does not
  resolve. The only such failure (`commit_missing`) was resolved by one
  follow-up in B text 2. In B text no follow-up was sent, because of a
  controller error, not because of the contract. So adopt does not apply.
- **Reject** needs format failures that the receipt causes and the text
  contract does not. The receipt's one failure (`status_missing`) is on the
  status line that both forms share. The text form did not show it in four
  runs. Whether the receipt caused it is a guess from one report, so reject
  does not apply either.
- **Defer** therefore follows. Each form had one kind of first-report format
  failure, and each was fixed by one follow-up. No form dropped a failed
  check or reported a false success. Six to seven runs cannot show a rate
  difference.

## Follow-ups

- Validator strictness: decide whether `Commit:` should also accept a
  backticked hash. Either way, the text contract in the controller skill
  should say "the bare hash" if the validator stays strict. This decision is
  deferred with the comparison, and the validator is unchanged.
- If the receipt is reconsidered, fix the meaning of `base` (observed base,
  with the required base as a concern). Also decide whether keys such as
  `question` must be absent when they do not apply, and whether prose around
  the block is allowed.

## Limits

- One profile, one model and three task shapes; a small sample.
- The tasks were short and synthetic. Long reports with many checks, where a
  receipt might help most, were not tried.
- The validator was written for this sprint; its own strictness is part of
  what was measured.
- The pre-registration names the wrong base for case C as `d32a5fc3`. Its
  second amendment corrects that to the full id the prompts used,
  `d32a5fc81ac30cd310a510adb853ea549aa530b9`.

## Cleanup

Every session was closed. Both writers were collected, compared with the
oracle and finished (`writer_reset` at the default base). The collected
`refs/remotes/writer-*/s17-210-*` refs were deleted from the operator
checkout. Nothing from these runs was integrated.

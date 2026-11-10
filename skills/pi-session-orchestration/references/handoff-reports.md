# Handoff reports

A worker hands its result to you as a report in `assistantText`. Implementation
and review reports share one form, so you can check a report before you read
what it claims. Read this when you write the report request into a prompt or
when a report does not fit.

## Shared form

- The first line is `STATUS:` with exactly one of `DONE`, `DONE_WITH_CONCERNS`,
  `NEEDS_CONTEXT` or `BLOCKED`.
- The fields follow, each as a label at the start of a line: `Label: value`, or
  `Label:` with one `- ` item per line below it.
- A hash is the bare full commit hash, with no backticks, prefix or other text
  on the line.
- A check is one item: `- <command> — exit <code>`.
- A report is a claim. A valid form shows that you can read the report, not
  that it is true.

A turn with `truncated: true` or a `completion` other than `stop` did not
deliver the whole report, whatever the text says. Ask once in the same session
for a shorter, complete report in the same form. Never accept the cut-off one.

## Implementation report

| Field | Content |
| --- | --- |
| `STATUS:` | `DONE`: task done, checks run. `DONE_WITH_CONCERNS`: done, with risks or unverified parts under `Open points`. `NEEDS_CONTEXT`: an answer is needed. `BLOCKED`: the worker cannot continue. |
| `Result:` | One sentence. |
| `Commit:` | The bare full hash, or `not committed` and the reason. Required with `DONE` and `DONE_WITH_CONCERNS`. |
| `Changed files:` | Repository-relative paths, one item each. |
| `Checks run:` | Each command with its exit code. Required with `DONE` and `DONE_WITH_CONCERNS`. |
| `Open points:` | Concerns, assumptions and what you must verify. Required with `DONE_WITH_CONCERNS`. |
| `Question:` | The one question. Required with `NEEDS_CONTEXT`. |

```text
STATUS: DONE
Result: The slug helper keeps digits and its tests pass.
Commit: 4f3c2a17b9e05d6c8a1f2b3c4d5e6f7a8b9c0d1e
Changed files:
- src/slug.js — digits are kept
- test/slug.test.js — two cases added
Checks run:
- node --test — exit 0 (5 passed)
Open points:
- none
```

## Review report

| Field | Content |
| --- | --- |
| `STATUS:` | `DONE`: the whole target was reviewed. `DONE_WITH_CONCERNS`: only a part was reviewed. `NEEDS_CONTEXT`: the target is missing or ambiguous. `BLOCKED`: the reviewer could not review. |
| `Target:` | The bare full hash of the commit under review, once. Required with every status. |
| `Verdict:` | Exactly one of `BLOCKING_FINDINGS`, `NON_BLOCKING_ONLY` or `NO_FINDINGS`, once. Required with `DONE` and `DONE_WITH_CONCERNS`, absent otherwise. |
| `Findings:` | One item per verified finding: `- <severity> <path>:<line> — <cause and evidence>`, with severity `critical`, `high`, `medium` or `low` and a repository-relative path. Indented lines below an item continue it. `- none` when there is none. |
| `Not reviewed:` | What the review left out and why. Required with `DONE_WITH_CONCERNS`, empty with `DONE`. |
| `Risks:` | Risks and hypotheses, with what would confirm each. |
| `Checks run:` | Each command with its exit code. |
| `Checks not run:` | Each check that was not run and what it would have shown. |
| `Question:` | The one question. Required with `NEEDS_CONTEXT`. |
| `Blocker:` | What prevented the review. Required with `BLOCKED`. |

```text
STATUS: DONE
Target: 9f2c4e1a7b3d5f60819a2b3c4d5e6f708192a3b4
Verdict: BLOCKING_FINDINGS
Findings:
- high src/invoice.ts:2 — The lookup filters by invoice ID only, so an ID of another tenant returns that tenant's invoice.
  Impact: cross-tenant disclosure.
  Fix: add the tenant to the filter; check with an invoice of a second tenant.
Risks:
- none
Checks run:
- node --test — exit 0 (3 passed)
Checks not run:
- none
```

## Four review outcomes

Keep these apart. Only the first is a review of the candidate.

| Report | Meaning | What you do |
| --- | --- | --- |
| `DONE` with a verdict | The whole target was reviewed. `NO_FINDINGS` says it was read and nothing was found. | Check each finding against the code, then act on the verdict. |
| `DONE_WITH_CONCERNS` with a verdict and `Not reviewed` | An incomplete review. The verdict covers only what was reviewed. | Have the rest reviewed, or decide knowingly and record it. Never count it as a review without findings. |
| `NEEDS_CONTEXT` with `Question` | Missing context. No review took place. | Answer once in the same session. |
| `BLOCKED` with `Blocker` | A blocked review. No review took place. | Resolve the blocker or report it. |

```text
STATUS: DONE
Target: 9f2c4e1a7b3d5f60819a2b3c4d5e6f708192a3b4
Verdict: NO_FINDINGS
Findings:
- none
Risks:
- none
Checks run:
- node --test — exit 0 (3 passed)
Checks not run:
- none
```

```text
STATUS: DONE_WITH_CONCERNS
Target: 9f2c4e1a7b3d5f60819a2b3c4d5e6f708192a3b4
Verdict: NON_BLOCKING_ONLY
Findings:
- low src/invoice.ts:1 — The database parameter is untyped, so a wrong query shape is not caught by the compiler.
Not reviewed:
- src/token.ts — the file exceeded what one turn could read; the permission check is unreviewed.
```

```text
STATUS: NEEDS_CONTEXT
Target: 9f2c4e1a7b3d5f60819a2b3c4d5e6f708192a3b4
Question: The task names a range but no base. Which commit does the range start from?
```

```text
STATUS: BLOCKED
Target: 9f2c4e1a7b3d5f60819a2b3c4d5e6f708192a3b4
Blocker: The workspace holds another commit than the target.
```

## Accepting a review report

Check in this order and stop at the first failure:

1. The turn is complete: `truncated` is false and `completion` is `stop`.
   Otherwise ask once for a complete report.
2. The first line is a valid `STATUS:` line. Otherwise ask once for the report
   in this form.
3. `Target` appears once and equals the full hash of the commit you asked
   about. A missing, abbreviated or repeated `Target` is a format failure: ask
   once for the report in this form. Another commit is a rejection: the report
   says nothing about your candidate, so close the session and start a fresh
   review of the right commit. Do not ask the same session to correct the line.
4. `Verdict` appears once and fits the status and the findings: no verdict
   with `NEEDS_CONTEXT` or `BLOCKED`, no finding with `NO_FINDINGS`, at least
   one finding otherwise, each with `path:line`.
5. `Not reviewed` is empty with `DONE` and names something with
   `DONE_WITH_CONCERNS`.

`Target` is a claim like the rest of the report. It catches a reviewer that
read the wrong commit and says so, such as a snapshot slot that still held an
older commit. What the reviewer could read is fixed only by the workspace you
gave it: check `session.snapshot.head` before the first prompt.

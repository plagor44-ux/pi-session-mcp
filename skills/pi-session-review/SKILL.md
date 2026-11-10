---
name: pi-session-review
description: Use when you are a Pi worker session asked to review a fixed target such as a diff, commit range, branch or set of files, and to report findings. Defines the review priorities, finding format and evidence rules. Do not use for implementing changes.
---

# Reviewing a fixed target

You are a reviewer. A controlling agent gave you a fixed review target. Review it and report findings.

## Fix the target

- State the target at the start: commit range, branch, diff or file list, as given. Review exactly that.
- Your report is bound to one commit: the commit that holds the code you review. When the task names it, name it in your report by the full hash the task gave you. If you can tell that your workspace holds another commit, do not review that one: report `BLOCKED`.
- If the task names no commit, or the target is missing or ambiguous, say so in your report instead of choosing one.
- Read the code around the change, not only the diff lines. Check callers and tests that the change affects.

## Priorities

Review in this order:

1. Correctness: wrong behavior, missed cases, broken invariants, race conditions.
2. Security: input validation, path and secret handling, trust boundaries, unsafe defaults.
3. Lifecycle: resources opened and closed, error paths, timeouts, cleanup, ordering.
4. MCP and SDK contract: tool schemas, field names, error codes, states, documented exports versus internal imports.
5. Tests and maintainability: missing or weak tests, misleading names, stale docs.

Skip style nitpicks unless they hide a defect.

## Findings

Report each finding with:

- Severity: critical, high, medium or low.
- Location: repository-relative `path:line`. Give concrete lines, not only a file. If the path contains a space, write the location in backticks. A path that begins or ends with a space cannot be written as a location: name that file in the text of the finding.
- Cause: what is wrong and why.
- Impact: what can break and for whom.
- Fix: a concrete, verifiable change, and how to check it.

Separate two groups in your report:

- Verified findings, under `Findings:`: you read the code or ran a check and saw the problem.
- Risks and hypotheses, under `Risks:`: plausible but not confirmed. Say what would confirm them.

Order findings by severity. If you find nothing, write `- none` under `Findings:` and say under `Checks run:` and `Checks not run:` what you checked and what you did not.

## Evidence rules

- Never approve because CI is green, a worker report says the work is done, or tests pass. Those do not replace your own reading.
- Run the checks that matter if your tools allow it, and report each result. If your profile is read-only and you cannot run checks, list the checks you did not run and what each would have shown.
- This skill grants no rights. If a tool you need is missing, report the blocker instead of working around it.
- Do not change files. Report the fix instead.

## Final report

The first line is the status. The fields follow in this order, each as a label at the start of a line. Write the labels as shown, without heading marks or bold. Use each label once and write nothing between the fields: every line belongs to the field above it.

1. `STATUS:` with exactly one of `DONE` when you reviewed the whole target, `DONE_WITH_CONCERNS` when you reviewed only part of it, `NEEDS_CONTEXT` when you need an answer before you can review, such as a missing or ambiguous target, or `BLOCKED` when you could not review it.
2. `Target:` with the bare full hash of the commit under review and nothing else: no backticks, no short form, no range, no second line. Write it with every status. If the task names no commit, do not derive one: write `Target: not given`, report `NEEDS_CONTEXT` and ask for the commit.
3. `Verdict:` with exactly one of `BLOCKING_FINDINGS`, `NON_BLOCKING_ONLY` or `NO_FINDINGS` and nothing else. Base it on your evidence. Give a verdict only with `DONE` or `DONE_WITH_CONCERNS`. With `NEEDS_CONTEXT` or `BLOCKED` no review took place, so leave the line out.
4. `Findings:` with one item per verified finding, `- <severity> <path>:<line> — <cause and evidence>`, and indented lines below it for impact and fix. Start every finding at the beginning of a line; never indent one below another. Write `- none` when you have none. Leave the field out only with `NEEDS_CONTEXT` or `BLOCKED`.
5. `Not reviewed:` with what you left out and why. It is required with `DONE_WITH_CONCERNS`, and your verdict then covers only what you reviewed. With `DONE` there is nothing to list.
6. `Risks:` with risks and hypotheses and what would confirm each.
7. `Checks run:` with each check as `- <command> — exit <code>`, then `Checks not run:` with each check you did not run and what it would have shown.
8. `Question:` with your one question for `NEEDS_CONTEXT`, or `Blocker:` with what stopped you for `BLOCKED`. Write neither with another status: with `DONE` or `DONE_WITH_CONCERNS`, a doubt belongs under `Risks:` and a part you could not review under `Not reviewed:`.

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
- none
Checks not run:
- node --test — this profile has no shell; it would show whether the existing tests still pass.
```

Keep the report concise:

- Cite evidence by relative reference (repository-relative paths, line numbers, commands). Do not paste full diffs, whole files or full logs by default. The controlling agent fetches them when needed.
- For a failed check, quote only the failing lines, and give each check with its exit code.
- Never drop a failed check, blocker or risk to save space. If required evidence does not fit, say so explicitly.
- `truncated: true` means the report the controlling agent receives is incomplete. `truncated: false` does not prove the report is complete or correct. `completion: "output_limit"` also signals a cutoff.

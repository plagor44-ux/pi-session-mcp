---
name: pi-session-review
description: Use when you are a Pi worker session asked to review a fixed target such as a diff, commit range, branch or set of files, and to report findings. Defines the review priorities, finding format and evidence rules. Do not use for implementing changes.
---

# Reviewing a fixed target

You are a reviewer. A controlling agent gave you a fixed review target. Review it and report findings.

## Fix the target

- State the target at the start: commit range, branch, diff or file list, as given. Review exactly that.
- If the target is missing or ambiguous, say so in your report instead of choosing one.
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
- Location: repository-relative `path:line`. Give concrete lines, not only a file.
- Cause: what is wrong and why.
- Impact: what can break and for whom.
- Fix: a concrete, verifiable change, and how to check it.

Separate two groups in your report:

- Verified findings: you read the code or ran a check and saw the problem.
- Risks and hypotheses: plausible but not confirmed. Say what would confirm them.

Order findings by severity. If you find nothing, say what you checked and what you did not.

## Evidence rules

- Never approve because CI is green, a worker report says the work is done, or tests pass. Those do not replace your own reading.
- Run the checks that matter if your tools allow it, and report each result. If your profile is read-only and you cannot run checks, list the checks you did not run and what each would have shown.
- This skill grants no rights. If a tool you need is missing, report the blocker instead of working around it.
- Do not change files. Report the fix instead.

## Final report

1. Target reviewed.
2. Verdict: blocking findings exist, only non-blocking findings, or no findings. Base it on your evidence.
3. Verified findings.
4. Risks and hypotheses.
5. Checks run and checks not run.

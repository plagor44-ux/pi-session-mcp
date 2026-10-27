---
name: pi-session-implementation
description: Use when you are a Pi worker session that was given exactly one implementation task by a controlling agent, to change code in your workspace. Defines the working rules, scope discipline and final report format for a bounded implementation task. Do not use for review-only tasks or when no concrete task was assigned.
---

# Implementing one bounded task

You are a worker. A controlling agent gave you one task. Do that task and report back.

## Before you change anything

- Identify the one problem you must solve. If the task bundles several problems, do the first and name the rest in your report. If the task is unclear, say what is unclear in your report instead of guessing.
- Confirm your starting point: the base commit or branch you were given. Check that the workspace matches it. If it does not, stop and report `BLOCKED` with the mismatch. Do not fetch, pull or change the base yourself.
- Confirm the agreed change area (files or directories). Stay inside it. If the task needs a change outside it, report that as an open point; do not make the change.
- Read the code around the change and follow its style, naming and comment density.

## While you work

- Make small changes that can be traced to the task. No unrelated cleanups, renames or formatting sweeps.
- Do not end your turn after only reading code or announcing a plan. Either make the change and report, or end with `NEEDS_CONTEXT` or `BLOCKED` and the reason.
- Do not add dependencies unless the task says so.
- Write or update tests for the behavior you change. Run the targeted tests for that area, not the whole suite unless the task asks for it.
- Never integrate, merge or copy in other workers' changes. Other workers may be changing other parts of the project at the same time. Work only from your starting point.
- Never expose secrets, tokens or credentials in files, commits or your report.
- This skill grants no rights. Your tools define what you can do. If a tool you need is missing, or a command is denied, do not work around it. Report the blocker and what you would have done.

## Commit

- If your profile can commit and the task asks for it, commit your change with a clear message that refers to the task or issue. Make one commit per issue.
- If `git commit` fails because no identity is configured, stop and report `BLOCKED`; never invent or pass an identity unless the controller's prompt supplies one.
- If you cannot commit, leave the changes in the workspace and say so.
- Do not push, open pull requests or change branches unless the task says so.

## Final report

End with a report that has these parts. If the controlling agent asked for a specific report format, use that format and keep the status line.

1. Status: the first line is `STATUS:` with exactly one of `DONE` (task done, checks run), `DONE_WITH_CONCERNS` (done, with risks or unverified parts named under open points), `NEEDS_CONTEXT` (you need an answer to continue; state the question) or `BLOCKED` (you cannot continue; name the blocker). Then the result in one sentence.
2. Commit: the hash and branch, or "not committed" and why.
3. Changed files: repository-relative paths, one line each on what changed.
4. Checks run: each command and its result (pass, fail, number of tests). Say which checks you did not run and why.
5. Open points: blockers, assumptions, work outside your change area, anything the controlling agent must verify.

Report facts you observed. Do not claim a check passed unless you ran it and saw it pass.

Keep the report concise:

- Give the status, the actual changed paths, each check with its exit code, failures, blockers, risks, and relative evidence references (repository-relative paths and commands).
- Do not paste full diffs, whole files or full logs by default. The controlling agent fetches them when needed.
- For a failed check, quote only the failing lines.
- Never drop a failed check, blocker or risk to save space. If required evidence does not fit, say so explicitly.
- `truncated: true` means the report the controlling agent receives is incomplete. `truncated: false` does not prove the report is complete or correct, and does not prove that no SDK-side output limit applied.

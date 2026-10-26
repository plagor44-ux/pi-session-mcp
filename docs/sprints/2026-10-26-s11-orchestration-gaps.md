# Sprint 11: orchestration gaps

Planning basis: main `d93a6d6` (merge of PR #140), published 0.11.6,
2026-10-26. Entry: the Sprint 10 results and decision D1 in the
[Sprint 10 file](2026-10-26-s10-orchestration-reliability.md). This file plans
work and records it as it lands; it claims nothing that its progress log does
not state with evidence.

## Decisions taken at planning (2026-10-26)

- Scope: Sprint 11 as planned (K3, K9, K8, K7, K5 into the skill), plus the
  Doctor gap of #139 as its own issue, migration step 2 and one L4 live pair.
- D3 (worker result channel, K11): no ADR yet. The status contract (K2) is
  observed live on this sprint's worker tasks first.
- #120 (`undici` in Pi SDK 1.4.0): option 1, wait for an SDK release that lifts
  the pin. 1.4.0 is still the newest SDK version on 2026-10-26.
- No release on this branch.
- L4 budget: at most two live turns, provider OpenAI, profile `code`.

## Tasks

| Id | Task | Route | Change area |
| --- | --- | --- | --- |
| T1 | [#141](https://github.com/plagor44-ux/pi-session-mcp/issues/141): Doctor reports coding profiles a container writer would refuse, with one rule set shared with `renderContainedConfig` | `pi-session-mcp-w1`, `code` | `src/doctor.ts`, `src/writer-lifecycle.ts`, tests, docs |
| T2 | K8: wake after `PostToolUseFailure` | controller analysis | this file |
| T3 | Records: v0.11.6 post-release state, S10-4 writer rollout, roadmap | controller | `docs/` |
| T4 | K3 and K9: compaction context hook and verification `Stop` gate on the evaluation ledger, outside the package (D1) | `pi-session-mcp-w2`, `code` | `eval/bridge/`, tests, evaluation README |
| T5 | K7: provider-free probe whether a subagent's sessions and wakes reach the right context | after T1, `pi-session-mcp-w1` | `eval/bridge/` |
| T6 | K5 written into the controller skill with this sprint's review numbers | controller | `skills/pi-session-orchestration/` |
| T7 | [#142](https://github.com/plagor44-ux/pi-session-mcp/issues/142): container writers fail OAuth turns in the five minutes before the token expires; warm up the host login before the SDK's window | after T1 or T4, a writer with `code` | `src/writer-credentials.ts`, `src/writer-launch.ts`, tests, docs |
| M2 | Migration step 2: `node-app`, four writers, retire `node-app-w1`–`node-app-w4` | controller and operator | operator configuration |
| L4 | One live pair with a turn of several minutes and the wake | controller | evaluation record |

K5 runs on every code task: review by `review-glm` for code by `code`, rounds
1–3 as follow-ups in the same session.

## T2: no wake after `PostToolUseFailure`

Claude Code fires `PostToolUseFailure` when a tool that started fails,
including an MCP tool that returns an error result, and it matches on the tool
name like `PostToolUse`. The hooks reference sets no event restriction on
`asyncRewake`, and it does not confirm one either. The question is
whether a failed call can leave a running turn without a waiter:

- `pi_turn_get` fails only with `unknown_session`, `unknown_turn` or an input
  error. None of them names a turn that is still running.
- `pi_session_prompt` fails with `prompt_timeout` or `prompt_rejected` and
  creates no public turn, or with `session_running`, where the running turn
  already has the waiter armed by its own prompt.
- A transport failure means the server is gone, and with it every in-memory
  session.

A hook on `PostToolUseFailure` would therefore only ever arm a wait for a turn
that does not run, and wake the controller after the full budget for nothing.
Its input carries only the controller's own `tool_input`, not a turn the server
confirmed. Decision: no product change. The other half of K8, a hook timeout
that covers the wait budget, already holds: `buildWakeEntry` sets the timeout
to the budget plus 60 s (`src/setup-hooks.ts`).

## Progress log

Recorded as work lands on the branch.

- Preflight 2026-10-26: both pilot writers were reset to `main` (`d93a6d6`)
  and reported `writer_reset` and `writer_reconnect_required`; after the
  reconnect, `pi_capabilities_get` on both reported 0.11.6 and delivery
  `spool`, and `--verify` reported `mcp_verified` and `hook_verified`. Three
  collected refs from Sprint 9 and 10 were deleted from the operator checkout
  after a file-by-file comparison showed their content on `main`.
- First attempts of T1 and T4 (profile `code`, provider `openai`) both ended
  `failed` at 18:19:09 and 18:19:19 UTC, 4 and 3 minutes after their start;
  the host's `auth.json` was rewritten at 18:19 UTC. Reading the code found the
  cause candidate, filed as #142 and fixed as T7. The uncommitted work was
  collected as `-wip` refs; a coding start then refused the changed clone, so
  each writer was reset onto a local branch at its WIP ref and a fresh session
  finished from there. Both second attempts reported `DONE_WITH_CONCERNS` with
  a valid status line.
- T1 (#141): `review-glm` verdict `NON_BLOCKING_ONLY`, two low findings (setup's
  Doctor gate did not pass its configuration path; an optional parameter
  defaulting to an empty set). Both fixed by the controller. One review round.
- T4 (K3, K9): `review-glm` verdict `NON_BLOCKING_ONLY`, two medium and two low
  findings. The Stop gate blocked failed or aborted tasks with no reachable
  remedy (also reported by the worker and found by the controller), and
  `process.exit` after `stdout.write` could drop the hook output (found only by
  the review). One fix round by `code-deepseek` on `pi-session-mcp-w2`, read by
  the controller.
- Full suite on the host for both branches: 114 and 115 files, 3455 passed,
  13 skipped, none failed. The eight lock and hook tests that time out inside
  the writer containers passed on the host again.
- T7 (#142): implemented by `code-glm` on `pi-session-mcp-w1`. The controller
  checked that importing the SDK, `ModelRuntime.create` and `getAuth` against
  an empty auth file write nothing to stdout and leave the file unchanged.
- T7 review by `review` (another family than `code-glm`): verdict
  `NON_BLOCKING_ONLY`. Two low findings: a provider with tokens shorter than
  ten minutes would refresh on every tick, and `ModelRuntime` is used outside
  `PiSessionAdapter`. The second is a narrow, credential-only exception that
  touches no session and needs the maintainer's confirmation; the first is
  recorded, as the OpenAI tokens on the workstation live one hour.
- L4 live pair, also meant as a live check of #142: one turn with profile
  `code` on `pi-session-mcp-w2`, three shell sleeps of 100 s, 5 min 22 s long,
  completed and woke the controller without polling. Its model requests fell
  at 19:11:07 and 19:12:47 UTC. Another host process refreshed the host token at
  19:11:15 and the wrapper copied it into the writer at 19:12:21, so the
  failure window ran only from 19:11:12 to 19:12:21 and neither request fell
  into it. The check is inconclusive for #142 and consistent with it: the
  window's length depends on when some host process refreshes. A first live
  turn with a worse timing was aborted after 22 s, so the budget of two live
  turns was used up by one aborted and one completed turn.
- T5 (K7): probe scenario `K7` in `eval/bridge/product-probe.ts`, written by
  `code-glm` on `pi-session-mcp-w1` and run once by the controller on the host
  (Claude Code 2.1.310, provider-free). The main conversation lists a session
  that a subagent started (shared server), and the wake for the subagent's
  turn reached the main conversation, not the subagent; the hook input inside
  the subagent carried `agent_id` and `agent_type`
  ([results](../evaluation/subagent-probe-2026-10-26/README.md)). In this run
  the subagent had returned before its turn ended; whether a still-running
  subagent receives the wake was not tested. The answer to "does the wake
  reach the subagent" is no for this case, so K7 stops here as planned ("stop
  if either answer is no"). The `review` verdict was `BLOCKING` on robustness:
  the main conversation's list races the subagent, which can only produce a
  false "no" for Q1, and the subagent classifier has an untested gap. The
  controller kept the recorded answers, corrected two README overstatements
  and recorded both limits instead of a second fix round.
- T6 (K5): the review stage with at most three fix rounds is written into
  section 8 of the controller skill, and section 11 explains how a fresh
  session continues from collected work. Every code task of this sprint had
  one cross-family review.
- Final independent review of the whole branch (Claude `reviewer`): verdict
  `BLOCKING` on one medium finding, fixed on the branch: the setup Doctor gate
  treated `container_profile_refused` for the repository's own profile
  (`<alias>:<profile>`) as a foreign error, which would block collect, finish
  and the very profile change that fixes it. The gate now counts that check as
  the repository's own; tests cover both directions. Low findings fixed: the
  wrapper refreshes several OAuth providers in parallel under one 20 s bound
  instead of one after another; a test runs the real SDK refresh path on an
  auth file without OAuth entries and asserts no stdout write and unchanged
  bytes; the changelog no longer claims a live confirmation; the review count
  in the skill was corrected. Recorded as limits: an OAuth provider defined
  only in Pi's `models.json` is probably unknown to the refresh runtime
  (`modelsPath: null`), unverified; the evaluation hooks read under the
  ledger lock, so a hook killed at its timeout can leave a stale lock.
- Open maintainer decision: #142 uses `ModelRuntime` from the package root
  outside `PiSessionAdapter`, for the credential refresh only and without a
  session. AGENTS.md says to keep Pi behind `PiSessionAdapter`; either confirm
  this as a narrow exception or ask for the refresh to move behind the
  adapter.
- #136 hypothesis (a running writer server recovers after a reset without a
  reconnect): a start 47 s after a reset succeeded without a reconnect; a start
  about 30 s after another reset failed with `local_authentication_missing`.
  This fits the wrapper's 60 s credential copy but is two observations, not a
  proof; the skill keeps the reconnect.
- Migration step 2 (M2): host isolation control passed; four
  `node-app` writers provisioned and accepted on the first
  `--apply`, registered for Claude Code and Codex with the wake hook; the host
  aliases `node-app-w1`–`node-app-w4` were removed from the configuration (Doctor then
  reported no warning for the repository) and their worktrees set clean and
  detached on `main`. A real coding turn per writer is open: it needs a
  controller started in that repository's checkout.
- Both read-only review sessions reported reading files outside their
  workspace (a writer clone, and a temporary worktree under `~/.cache` that a
  gate run had created); the controller did not verify which files they read. That matches the documented
  limit: a read-only profile restricts Pi's tools, not the filesystem.

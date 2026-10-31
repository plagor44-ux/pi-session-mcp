# Sprint 15: completion kind of completed turns and a review snapshot design

Planning basis: main `2a483c7d19cda65c32de5df781819eb5333b9694`, published
0.14.3, 2026-10-31. Entry: the evaluation issues
[#211](https://github.com/plagor44-ux/pi-session-mcp/issues/211) (a completed
turn does not say whether the model stopped on its own, hit its output limit or
ended on a tool call) and
[#209](https://github.com/plagor44-ux/pi-session-mcp/issues/209) (a read-only
reviewer cannot be bound to the commit under review). This file records the
work as it landed; it claims nothing that its progress log does not state with
evidence.

Branch: `feat/s15-completion-kind-review-snapshots`, one pull request, no
release. Merge, version, tag, npm publication and the decision on ADR 0015 are
maintainer decisions.

## Preflight (2026-10-31)

- The operator checkout had two unpushed local commits with the 0.14.3
  post-release evidence on a local branch; they were carried over to this
  branch unchanged (the roadmap line now names #209 to #215) and the local
  branch was deleted.
- Open issues: #79, #120, #144 and the evaluation issues #209 to #215; no open
  pull request. #120 and #79 are unchanged.
- One worktree (the operator checkout), no open Pi session, both container
  writers of this repository at their baseline.

## Scope and decisions

- #211 is implemented: completed turns carry a required
  `completion: "stop" | "output_limit" | "tool_use"`, mapped explicitly from
  the SDK's final stop reason, carried through the writer relay and reported
  by `pi_turn_get`. `truncated` keeps its meaning (the registry's 64 KiB cap);
  failed and aborted turns and the terminal events are unchanged. The change
  is additive to the output schema and lands under `Unreleased` in the
  changelog.
- #209 is design only: [ADR 0015](../adr/0015-review-snapshots.md) is
  `Proposed` and recommends setup-managed snapshot slots with a shared lease
  (option C). A provider-free
  [synthetic real-Git proof](../evaluation/review-snapshots-2026-10-31/README.md)
  exercises its materialization and verification. No production code for #209.
- #210 and #212 to #215 are not part of this sprint.

## Roles and routing

`pi_capabilities_get` on 2026-10-31 (server 0.14.3) lists every profile used
below. The maintainer chose `code-terra` for the writers.

| Requested | Route used | Status |
| --- | --- | --- |
| agy with Gemini 4 Argon (map, digest, review) | `agy-delegate -m gemini-4-argon-high`, read-only | #211 code map and #209 digest used; the first #211 review ended on a denied file read, the retry restricted to repository reads delivered (progress log) |
| agy for the #209 proof (writing) | not used | the `--yolo` write grant was refused by the controller's permission policy; the proof moved to a Pi writer |
| Implementation #211 | `code-terra` on writer `pi-session-mcp-w1` | one blocked first turn (incomplete `node_modules`), then the change |
| Proof #209 | `code-terra` on writer `pi-session-mcp-w2` | the first proof version |
| Cross-family review of ADR 0015 | `review` (openai `gpt-6.1-sol`) | `BLOCKING`, all findings adopted; re-review `BLOCKING`, all three findings adopted (progress log) |
| Third-family review | `review-glm` (mistral `zai-glm-5-3`) | two starts of a turn ended with `turn_failed` after well under a second, no report; not retried |
| Claude-family review | Claude Code reviewer subagent (Opus 5.5) | #211: no defect, test gaps; ADR 0015: `NON_BLOCKING_ONLY`, confirming the `review` findings |

Each writer had one task and its own branch. The controller integrated every
change, wrote the follow-up commits and is the only editor of the records.

## Progress log

- #211, writer w1: the first turn stopped with `BLOCKED` because
  `node_modules` in the clone was incomplete; after the controller allowed
  `npm ci` in a follow-up, the worker delivered the change (`bd6e99c`,
  integrated as `7a07411`). The worker's container run of the suite timed out
  in lock, wake-hook and live-token tests, as AGENTS.md expects for writers.
- #211, controller: the stop-reason mapping is an explicit `switch` with a
  case per completed stop reason (`2265145`); tests now assert the completion
  kind after recovery from a failed turn, in the relay abort race and through
  `tools/call` for `output_limit` and `tool_use` (`b46fd97`), closing the test
  gaps the Claude-family review named.
- #209, writer w2: the first proof (`487cfc9`, integrated as `414ee5f`) with
  ten cases in the writer container. The controller added the bound-tree
  check and recorded a host run (`cd19438`) and proposed ADR 0015 (`6fa6f34`).
- ADR 0015 review (`review`, `gpt-6.1-sol`): `BLOCKING`. Every finding was
  checked against Git's behavior or the code and adopted: status without
  `--ignored` misses ignored files and index flags can hide edits; plain
  `git worktree remove` deletes ignored-only work; admission-only checks do
  not cover the whole review; extensions run unconfined hooks even without
  granted tools; setup needs the writer fence for surviving Git children;
  `git worktree prune` is repository-wide; an ordinary `git status` rewrites
  the index and can run filters; and the skill read roots needed a stated
  policy. The Claude-family review added the path-free directory placeholder,
  the non-blocking shared lock and the setup ownership fence.
- Proof run 3 on the host (`41d4109`): 15 of 15 cases passed, including
  ignored files, a skip-worktree flag hiding an edit, verification without
  writing Git metadata (with a control in which ordinary `git status` rewrites
  the index) and the deletion of ignored-only work by a plain removal.
- ADR 0015 revision (`ea0c5bc`) addresses all of the above.
- ADR 0015 re-review (`review`, same model, fresh session, on `ea0c5bc`, 3 minutes
  19 seconds): `BLOCKING`, with four of the seven earlier points resolved and
  three partial. Checked and adopted in `970aa7c`: the filter check looked only
  at the source checkout and only at clean and process drivers, while a
  smudge driver runs during `git worktree add` and a conditional
  `includeIf "gitdir:…"` can apply a filter to the linked worktree only (the
  controller confirmed the latter with real Git: no filter in the source, the
  filter in the snapshot); Git's `gitdir` back-pointer names `<dir>/.git`, not
  the directory (confirmed with real Git and with `resolveWorktreeGitDir`);
  the read roots narrow to the skill file for protected directories
  (`allowedReadRoots`). No further review round was run on `970aa7c`.
- #211 agy review (`gemini-4-argon-high`, retry, 759 seconds, on the
  diff up to `2265145`): `NON_BLOCKING_ONLY`, five findings. Adopted in
  `c7d50d0`: the four controller-skill eval mocks of completed turns lacked
  the now required `completion`; the relay test now covers `tool_use`; the
  retry and error-projection recoveries assert the value, not only the key;
  the schema test asserts closed turn branches. Two of its test gaps had
  already been closed by `b46fd97`. Not adopted: `.strict()` on the relay's
  `turnSchema` parse; the parse already ignored unknown fields before #211,
  and making it strict is a separate relay contract change.
- After the merge of PR #216 (2026-10-31): a side note pointed out that the
  ADR's title promised an immutable snapshot while the design only verifies
  it; the ADR is renamed "Verified read-only review snapshots" and states the
  contract in its status block. The maintainer then accepted ADR 0015 with
  that detect-not-prevent contract; implementation is
  [#217](https://github.com/plagor44-ux/pi-session-mcp/issues/217).
- Writers: both collected, their refs compared with the integrated commits
  (identical content) and finished (`writer_reset`); the collected refs were
  deleted afterwards.

## Checks

Recorded in the pull request with their results; only checks the controller
ran are listed there.

## Remaining risk and limits

- The completion kind is derived from the SDK's final assistant message; a
  future SDK stop reason outside the mapped ones fails the type check at the
  SDK upgrade and, at run time, fails the turn instead of reporting it as
  completed.
- ADR 0015 detects changes to the snapshot at fixed points and does not
  prevent them; leases, setup crashes, the server path, filters, skill roots
  and the sandboxed shell are not exercised by the proof.
- The Mistral route (`review-glm`) failed in this session; the reason is not
  established.
- `gemini-4-argon-*` is offered by `agy models` but not yet listed in the
  operator's routing matrix.

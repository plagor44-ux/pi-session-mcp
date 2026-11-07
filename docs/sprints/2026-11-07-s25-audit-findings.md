# Sprint 25: post-0.19.0 audit findings

Planning basis: main `a59654012a36d55595b097ec89169ad621aa963d` (the merge of
PR #256, tag `v0.19.0`), published 0.19.0, installed 0.18.0, 2026-11-07.

Entry: the maintainer's work order of 2026-11-07 to continue with the open
issues. Three audit findings on 0.19.0 were open:

- [#257](https://github.com/plagor44-ux/pi-session-mcp/issues/257) (P1):
  collection certified a nested Git repository as collected, and non-discard
  cleanup then deleted its only copy.
- [#258](https://github.com/plagor44-ux/pi-session-mcp/issues/258) (P2):
  `pi-session-mcp-history prune` never removed sessions that reconciliation
  marked `incomplete` after a server crash.
- [#259](https://github.com/plagor44-ux/pi-session-mcp/issues/259) (P3):
  persistence, installation and ADR status statements contradicted the shipped
  session history and the release record.

#144 and #221 need a Mac and stay open. Branch `fix/s25-audit-findings`: one
pull request with one commit series per issue, no release.

## Results

| Item | Result |
| --- | --- |
| #257 | Collection and finish refuse with the new `writer_nested_repository`; inspection reports `nested`, `baseline` requires its absence, and the inspection digest version changed. Real-Git and native rootless Podman tests; the Podman test fails on unchanged main. |
| #258 | One retention predicate for preview and delete: the session's close, else the recorded end of its instance; an open session of an instance without a recorded end is never eligible. |
| #259 | README, client setup and installation name the opt-in history as the only persistent store, document its location, that turning it off keeps the file, and the downgrade step; ADR 0015 and 0018 record their releases. |

## Work and review

1. Two coding workers on the leased container writers, both on
   `a596540`: `code-terra` (OpenAI) for #257 and `code-deepseek` for #258. Both
   writers first stood on old bases (`6c533ac` and `0ea0cba`); the controller
   closed the sessions and reset the writers before the real starts. The
   controller wrote #259 itself.
2. #258: the controller confirmed the new tests fail on the base prune code.
   An OpenAI review on a review snapshot answered `NON_BLOCKING_ONLY`: the
   gaps-cascade assertion had no rows, and the README's "sessions of a running
   server are never pruned" was false for closed sessions. Both fixed; a
   mutation that drops the gaps cascade now fails the test.
3. #257: the controller replaced the worker's recursive directory walk, which
   forked a subshell per directory including ignored trees such as
   `node_modules`, by the gitlink list of the staged worktree tree, and stopped
   counting a removed gitlink as nested. Reviews by Zhipu GLM and xAI, both
   different families from the authors, answered `BLOCKING_FINDINGS` on the
   same point: a nested repository under an ignored or excluded path is never
   seen. The controller kept that out of #257: ignored paths are outside
   collection by contract for every kind of file, a worker can already hide
   any work through `.git/info/exclude`, and the issue excludes ignored files.
   The limit is now documented next to the collection contract; changing it is
   a maintainer decision. GLM's other findings were fixed: a quoted
   (non-ASCII) gitlink path made an uninitialized base submodule count as
   nested and blocked reset and finish (now listed with `core.quotePath` off),
   a stale digest-version sentence, and missing tests for a repository without
   commits and a `.git` file.

## Checks

- `npm run typecheck`, `npm run build`: exit 0.
- `npm test` on `287a105`: 4,690 passed, 15 skipped, 1 failed:
  `test/writer-lifecycle.podman.test.ts` "host SIGKILL of the relay parent
  releases the writer within the cleanup bound" (`launcher container did not
  start` under full-suite load); the file alone passed 9 of 9.
- `test/writer-lifecycle.podman.test.ts` with the new #257 test: 10 of 10
  against real rootless Podman; the #257 test fails against the base
  `writer-lifecycle.ts`.
- `test/writer-collect-real-git.test.ts`: 44 of 44 on the final head.
- Final head `ee91ce6`: `npm run typecheck` and `npm run build` exit 0;
  `npm test` exit 0, 168 of 168 files, 4,695 passed, 15 skipped, none failed.

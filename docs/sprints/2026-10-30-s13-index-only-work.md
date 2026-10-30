# Sprint 13: work that exists only in the writer index

Planning basis: main `7752d3f1555d19fed06f43c0e046da07017a3320` (merge of PR
#197), published 0.14.1, 2026-10-30. Entry: issue
[#200](https://github.com/plagor44-ux/pi-session-mcp/issues/200), recorded as
an unchanged limit in [Sprint 12](2026-10-29-s12-audit-fixes.md), and the
published-release Level 2 of 0.14.1 that was still open. This file records the
work as it landed; it claims nothing that its progress log does not state with
evidence.

Branch: `fix/writer-index-only-work`, one pull request, no release. Merge,
tag, npm publication and the productive rollout are maintainer decisions.

## Preflight (2026-10-30)

- main and `origin/main` at `7752d3f`; open issues #79, #120, #144, #195,
  #198, #199, #200; open pull request #201 (#198, #199).
- Both machines run `0.14.1`; on the workstation both client targets verified
  and all 18 writers accepted earlier the same day.
- Reproduced on `7752d3f` with the real-Git harness: for a clone whose HEAD and
  worktree hold `base` and whose index holds a staged blob (`git status` `MM`),
  `inspectWork` reported `baseline: true, dirty: false`, collect reported
  `nothing_to_collect`, and remove and finish without `--discard` destroyed
  the staged blob.

## Decisions

- Inspection computes the original index tree with `write-tree` on a second
  temporary copy of the index, before `git add -A` builds the worktree tree.
  The clone stays read-only and its index is never written.
- `baseline` additionally requires the index tree to equal the base tree;
  `dirty` is set when the index tree or the worktree tree differs from HEAD's.
- The collection digest is computed over a version tag and the inspection
  output, which now includes the index tree. A digest recorded by 0.14.1 or
  earlier can never match, so it never authorizes cleanup.
- Collection exports a staged tree that differs from both HEAD's tree and the
  worktree tree as an extra `<branch>-index` commit, with the name rules of the
  existing `-wip` export, rather than refusing: a refused writer could not be
  admitted to a session or collected, so its work would only be recoverable by
  `--discard`. The `-wip` and `-detached` exports are unchanged (#193).
- A digest is recorded only when the index and worktree tree objects exist in
  the operator checkout, in addition to the #193 commit gate.
- An index that cannot be evaluated, such as an unmerged conflict, makes
  inspection and collection fail closed (`writer_inspect_failed`,
  `writer_collect_failed`); no cleanup without `--discard` proceeds.
- Pool admission needs no change: the in-boundary guard probe runs
  `git status --porcelain=v1 -uall`, which reports staged changes. Doctor's
  `writer_dirty` stays an offline ref-only hint and never authorizes cleanup;
  its documentation now says so.
- #120: still waiting for an SDK release; no override, no
  `npm audit fix --force`.

## Roles and routing

`pi_capabilities_get` on 2026-10-30 settles which requested models were
available as profiles:

| Requested | Profile used | Status |
| --- | --- | --- |
| GPT 6.1 Terra (implementation) | `code` (openai `gpt-6.1-sol`) | Terra has no profile: the installed 0.14.1 catalog does not see Pi's persisted model overlay (#199, fixed in #201, unreleased); the requested fallback Sol was used |
| Sol (call-path analysis) | done by the controller | the call paths were short (one function and its five callers) |
| DeepSeek (real-Git fixtures) | `code-deepseek` (`deepseek-flash`) | available |
| GLM 5.3 (test plan, counter-checks) | `review-glm` (`zai-glm-5-3`) | available |
| Grok 4.7 (adversarial review) | `review-glm` | not used: xAI requests fail with HTTP 402 since 2026-10-25 |
| Mistral Large 4 (release evidence, docs) | controller with a Claude runner subagent | the evidence needed only local commands; the controller is the only docs editor |
| Sonnet 5.5 (final integration review) | a read-only Claude Code subagent on `claude-sonnet-5-5` | used instead of `review-sonnet`, because a read-only Pi worker reads only the workspace on `main`, not the branch worktree |

agy (Antigravity CLI, Gemini) was not used: the controller's planning call was
declined in this session, so the controller planned the packages and the
review route. At most two coding workers ran at once; `src/writer-lifecycle.ts`
had one implementer, and `test/writer-collect-real-git.test.ts` one author.

## Tasks

| Id | Task | Route | Change area |
| --- | --- | --- | --- |
| P1 | Design counter-check and regression test plan | `review-glm` | none |
| T1 | Fix in inspection, collection and the digest | `pi-session-mcp` writer, `code` | `src/writer-lifecycle.ts`, unit tests and fakes |
| T2 | Real-Git regression matrix | `pi-session-mcp` writer, `code-deepseek` | `test/writer-collect-real-git.test.ts` |
| R1 | Adversarial review of the integrated diff | `review-glm` | none |
| R2 | Final integration review | Sonnet 5.5 subagent, read-only | none |
| A | Published-release Level 2 of 0.14.1, candidate Level 1 and 2, native Podman | controller, runner subagent | records |

## Progress log

- P1 (`review-glm`, 1m32s): `NON_BLOCKING_ONLY`. Its main finding, that
  `write-tree` fails on intent-to-add entries, did not reproduce: Git 2.56
  skips such entries, so the case shows as dirty through the worktree tree. It
  is now pinned by a test. Skip-worktree and assume-unchanged entries stay
  invisible, as for Git itself (recorded as a limit).
- T1 (`code`, writer w1, 4m56s): `DONE_WITH_CONCERNS`; the concerns were the
  ten known lock, hook and live-token timeouts of the container suite
  (`override-lock`, `skill-customize-concurrency`, `token-live`,
  `wake-hook`). Collected as `writer-pi-session-mcp-w1/fix/200-index-only-work`
  and integrated as `9b5c72c`; writer finished (`writer_reset`).
- T2 (`code-deepseek`, writer w2, 5m00s): `DONE`, 7 of its 10 new tests fail on
  the base for the bug, 3 are guards. Collected as
  `writer-pi-session-mcp-w2/test/200-index-only-real-git` and integrated as
  `4acb4bf`; writer finished (`writer_reset`).
- Controller: against the source of `7752d3f` the real-Git file reports 7
  failed and 13 passed; with the fix, 21 of 21 pass. Added the intent-to-add
  test (`1aff988`) and a native Podman case of the exact `MM` state
  (`1e1e694`), which fails on the base source (`baseline: true`) and passes
  with the fix in the real container.
- R1 (`review-glm`, 4m59s, on the integrated diff): `NON_BLOCKING_ONLY`, no
  finding in the new lines.
  - Confirmed and filed as
    [#202](https://github.com/plagor44-ux/pi-session-mcp/issues/202): a stash
    entry is not exported, yet collection records a digest and remove without
    `--discard` then deletes it; reproduced by the controller with the real-Git
    harness (`nothing_to_collect`, `writer_removed`, blob absent). Pre-existing.
  - Not reproduced: an alias that shadows a builtin Git command; Git ignores
    such aliases. A clean filter configured by the worker runs only inside the
    throwaway boundary container, and the worker can already destroy its own
    clone, so it adds no loss beyond the threat model.
  - Fail closed, recorded as limits: a clone configured for a split index makes
    `add -A` fail on the read-only clone; a worker branch named
    `<branch>-index` makes the export refuse with `ref_name_refused`.
- R2 (Sonnet 5.5, read-only, on the whole branch at `4670264`):
  `NON_BLOCKING_ONLY`, no code defect. Fixed by the controller:
  - The test for an index-only change after a collection also changed the
    worktree, so it did not pin that the digest covers the index tree. It now
    stages a second blob with `update-index --cacheinfo` and leaves the
    worktree unchanged; with a digest that omits the index line it fails, with
    the fix it passes.
  - A test for a taken and a path-conflicting `<branch>-index` name.
  - The code table in execution modes, the `pi-session-profiles` skill (Doctor
    and the `--collect` dry run do not prove a clone clean; `--remove` without
    `--discard` does), the unmerged-index consequence, the merge note and a
    wrong direction in the acceptance record.
  - Not changed: the verbatim issue reproduction stays as written although the
    stricter collect, finish and remove test covers more; Doctor's
    `writer_dirty` stays a documented offline ref-only hint (a maintainer
    call against the issue's criterion 3).

## Checks

- Full suite on `1aff988` (the integrated fix and the intent-to-add test),
  with `NODE_OPTIONS=--unhandled-rejections=strict`: 141 files, 4061 passed,
  14 skipped, exit 0.
- Native Podman tests: `test/writer-lifecycle.podman.test.ts` 8 of 8 and
  `test/writer-boundary.podman.test.ts` 1 of 1, none skipped, on `1e1e694`.
- Candidate Level 1, working-tree and packed-tarball Level 2 on `1e1e694`: see
  [Issue #200 candidate acceptance](../acceptance.md#issue-200-candidate-acceptance-2026-10-30).
- Published-release Level 2 of 0.14.1: see
  [v0.14.1 post-release evidence](../acceptance.md#v0141-post-release-evidence).

## Remaining risk and limits

- Work held only in a stash entry or in refs outside `refs/heads` is still lost
  after a collection (#202).
  Follow-up (2026-10-30): fixed by #202 and released in 0.14.2; see the
  [roadmap](../roadmap.md#current-state).
- Skip-worktree and assume-unchanged entries hide worktree changes from Git and
  therefore from inspection.
- The digest version means that a writer collected under 0.14.1 but not yet
  reset must be collected once more before finish, reset or remove. Writers at
  their baseline need no digest and are unaffected.
- The 18 workstation writers removed on 2026-10-30 for a profile change were
  judged by the 0.14.1 inspection; whether any of them held index-only work
  cannot be established afterwards.
- #120 is unchanged: Pi SDK 1.4.0 is still the newest release and pins `undici`
  8.10.2.

## Rollout plan (maintainer decision)

After the maintainer has merged and published a release with this change:

1. Close the coding sessions on all writers. For every writer that is not at
   its baseline, run `pi-session-mcp-setup --writer <name> --collect` as a dry
   run and resolve uncollected work before anything else.
2. Upgrade each machine as [Installation](../installation.md#container-writers)
   describes: client targets `--remove`, `npm install -g pi-session-mcp@<new>`,
   then for every container repository the provisioning command with its full
   settings and `--apply`, then client targets `--apply` and `--verify`,
   `--writer <name> --verify` for every writer, and Doctor.
3. Collect every writer that holds collected but not yet reset work once more,
   because its 0.14.1 digest no longer authorizes cleanup.
4. Second machine: the Anthropic profiles still need the maintainer's login
   there. Until #198 (in #201) is released, removing a writer with
   `--cache go` needs the documented `chmod -R u+w` workaround.

Rollback: a productive installation is not downgraded without the maintainer.
If the maintainer decides to return to `0.14.1`, the same steps install it; a
digest recorded by the new version does not match `0.14.1` either, so such a
writer has to be collected again, which fails safe. The source change itself is
reverted by reverting its commits.

Merge order with #201: both change `src/writer-lifecycle.ts` (#201 replaces the
recursive removal in `removeWriter`), `CHANGELOG.md` (`Unreleased`) and
`docs/execution-modes.md`, and #201's `test/writer-models-store.test.ts` fakes
the old three-tree inspection output. #201 merged first; the merge of `main`
into this branch keeps both `Unreleased` entries and adds the index tree line
to that fake.

Unmerged index: a writer whose index holds a merge conflict can no longer be
collected, and pool admission refuses it because it is not at its baseline; its
work stays in the clone until the operator explicitly decides on `--discard`.
Before this change `git add -A` collected such a state as `-wip` with conflict
markers. Exporting the worktree in that case without recording a digest would
keep it recoverable; that is a possible follow-up, not part of this change.

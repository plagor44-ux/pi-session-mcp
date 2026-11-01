# Sprint 18: snapshot abort, boundary quoting and controller skill wording

Planning basis: main `b0a1535` (the merge of PR #225), installed 0.14.3,
2026-10-31.

Entry: the three follow-up issues of Sprint 17 and two maintainer decisions.

- [#224](https://github.com/plagor44-ux/pi-session-mcp/issues/224):
  `pi_session_abort` on a snapshot session can answer `abort_timeout` after a
  successful abort.
- [#222](https://github.com/plagor44-ux/pi-session-mcp/issues/222): quote
  `safe.directory` in the writer boundary and decide about clone filter or
  include configuration after a live check.
- [#223](https://github.com/plagor44-ux/pi-session-mcp/issues/223):
  controller skill wording for `NEEDS_CONTEXT` and the commit hash.
- Maintainer decisions on 2026-10-31: accept
  [ADR 0016](../adr/0016-writer-recovery-export.md) (#213) and
  [ADR 0017](../adr/0017-turn-duration-limit.md) (#212), with implementation
  later; close #214 as not planned and #79 as completed.

Branch `fix/s18-abort-boundary-skill`: one pull request, no release. The
maintainer approved a minor release 0.15.0 after the merge, followed by the
review snapshot acceptance (#220).

## Results

| Issue | Result |
| --- | --- |
| #224 | `abort_timeout` only when the session's pending operation and the adapter abort do not finish within one abort deadline. After a successful adapter abort, a snapshot session waits for the bounded post-turn verification (at most 30,000 ms) outside that deadline. `docs/tool-contracts.md` states both bounds. |
| #222 | `BOUNDARY_GIT` passes `-c 'safe.directory=*'`. The configuration refusal (point 2) was not added: a live probe showed that a worker cannot define a filter or include driver (see below). |
| #223 | The skill bounds `NEEDS_CONTEXT` to two rounds per task, answers only a question that is still open, and asks for `Commit:` with the bare hash. |
| #212, #213 | ADR 0017 and ADR 0016 are Accepted. ADR 0016 section 7 records the #222 status. |
| #214, #79 | Closed with the maintainer's reasons. |

## #222 live probe

On 2026-10-31, with installed 0.14.3, on writer `pi-session-mcp-w2`
(`code-deepseek`, base `41ae199`), with the maintainer's approval:

- `git config filter.probe.clean …` and `git config include.path …` in the
  clone failed with exit 4, `could not write config file .git/config: Device
  or resource busy`: the lock-file rename onto a bind mount.
- A direct append to `.git/config` failed: `Read-only file system`.
- The writer's mount table showed `.git/config` and `.git/hooks` as separate
  read-only bind mounts, as `serveArgs` configures them.
- A config file written elsewhere in `.git/` is inert without an include in
  `.git/config`; the worker removed it again.
- The worker left `.gitattributes` naming `filter=probe` and `filter=probe2`
  with two uncommitted files. `--collect --apply` reported `writer_collected`,
  and the collected `-wip` blobs were byte-identical to the written content:
  no filter ran.
- The writer was finished (`writer_reset`) and the probe refs were deleted.

`verifyCloneLayout` already refuses `config.worktree`, `commondir` and
`gitdir` in the clone's `.git`. With the read-only mounts pinned by
`test/writer-boundary.test.ts`, a worker has no route to a driver
configuration, so the refusal stays a recommendation for the ADR 0016
recovery implementation.

## Roles and routing

| Work | Route | Outcome |
| --- | --- | --- |
| #224 fix | `code` on writer `pi-session-mcp-w1`, base `41ae199` (identical `src/`) | delivered with a red test |
| #222 probe | `code-deepseek` on writer `pi-session-mcp-w2`, two turns | delivered the evidence above |
| #222 fix | `code-terra` on writer `pi-session-mcp-w2`, base `b0a1535` | delivered with a red test |
| #223 wording | `code-deepseek` on writer `pi-session-mcp-w1` | delivered |
| Review of #224 and #222 | `review-sonnet`, read-only | `NON_BLOCKING_ONLY`; A1 (queue wait outside the abort deadline) confirmed by the controller |
| #224 fix round 1 | `code` on writer `pi-session-mcp-w1`, base `d0ed322` via `--reset --base` | delivered with a red test for A1 |
| Whole-branch review | Claude `reviewer` subagent, read-only, on `6f63dea` | `NON_BLOCKING_ONLY`; see the progress log |
| ADR status, records, integration, one registry line | controller (Claude Code, Opus 5.5) | |

The controller read every report and diff, confirmed both red tests against
the old source in a temporary worktree, re-ran the targeted tests on the
host and integrated by cherry-pick.

## Progress log

- ADR acceptance: `4819b45` (0016), `0147b74` (0017).
- #224: `2f4a05f`, fix round `5832c1f`, controller addition `6f63dea` (a
  rejected preparation answers `abort_failed`, as in 0.14.3).
- #222: `ca71efe`; ADR 0016 status note `5afaa7d`.
- #223: `d0ed322`.
- Whole-branch review findings:
  - Two documentation nits fixed: the `abort_timeout` sentence now names
    the queue wait (`42ad88a`), and the ADR 0016 note names
    `verifyCloneLayout` next to the read-only mounts (`99a0473`).
  - A pre-existing exposure outside this diff: a worker-written
    `.git/info/grafts` makes an unexported detached commit look reachable,
    because the boundary scripts disable replace refs but not the graft
    file. The controller reproduced it with Git 2.56.0 in a scratch
    repository (`GIT_GRAFT_FILE=/dev/null` restores the check). It is a
    follow-up, not part of this sprint.
- Review findings not acted on:
  - B2 (a source scan for a future unquoted `safe.directory`): a nit; the
    constant is the only definition.
  - No test for the defensive `abort_failed` mapping of a rejected
    preparation, which cannot reject today, and the non-snapshot timeout
    test stays in `test/snapshot-sessions.test.ts`.
- Operations: one collection failed with `container_runtime_unavailable` for
  other repositories' Doctor checks under a load average of about 50, and
  later collections waited on `override_lock_busy` while other controllers
  collected their writers. Both cleared by retrying; no writer state was
  lost.

## Gates

Node `v26.12.1`, Git `2.56.0`, on the host.

- At `6f63dea` (last code commit): `npm run typecheck`, `npm run build` and
  `npm run build:cli` exit 0. `NODE_OPTIONS=--unhandled-rejections=strict
  npm test` exit 1: 6 of 4376 tests failed, in five files this branch does
  not touch, almost all at the 5,000 ms test timeout, at a load average of
  about 53 (other controllers' writers ran on the same host). Re-run alone
  at a load average of about 14, the five files passed: 119 of 119.
- At `99a0473` with the final record and changelog in the tree:
  `npm run typecheck` exit 0; `NODE_OPTIONS=--unhandled-rejections=strict
  npm test` exit 0, with 153 files and 4362 tests passed, 14 skipped.
- `git diff --check main...HEAD`: exit 0.
- Targeted: the registry, snapshot-session, lifecycle, boundary and
  real-Git writer tests pass; the new #224 and #222 tests fail against the
  old source (checked in a temporary worktree).
- At the end: no open Pi session, no collected writer refs, both writers
  reset; the operator checkout is the only worktree.

## Not done

- No implementation of ADR 0016 or ADR 0017; they follow under #213 and
  #212.
- The configuration refusal of #222 point 2 (see above).
- No release in this pull request.

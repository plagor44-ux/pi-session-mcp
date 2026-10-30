# Sprint 14: resource limits for the sandboxed read-only shell

Planning basis: main `7b8e5c801ed5ab05b8b94a9fe751b8b825ab0a3a` (merge of PR
#205), published 0.14.2 (annotated tag object
`488459ded623ed52cf8b3a139b1ad0f265b3d2a2`), 2026-10-30. Entry: the open
published-release Level 2 of 0.14.2 and issue
[#195](https://github.com/plagor44-ux/pi-session-mcp/issues/195), recorded as
a residual in [ADR 0013](../adr/0013-hardened-read-only-profiles.md) and in
[Sprint 12](2026-10-29-s12-audit-fixes.md). This file records the work as it
landed; it claims nothing that its progress log does not state with evidence.

Branch: `fix/195-sandbox-resource-limits`, one pull request, no release.
Merge, version, tag, npm publication and the productive rollout are maintainer
decisions.

## Preflight (2026-10-30)

- main, `origin/main` and the peeled tag `v0.14.2` at `7b8e5c8`; no open pull
  request; open issues #79, #120, #144 and #195. CI on the merge commit (run
  41085991886) and on the tag (run 41086907144) passed; the nightly Pi SDK
  canary and install smoke passed on 2026-10-30.
- #120: `@earendil-works/pi-coding-agent` 1.4.0 is still the newest release and
  pins `undici` 8.10.2; the maintainer decision (no `overrides`, no
  `npm audit fix --force`) stands and was not raised again.
- #79 stays open: its closing condition, Sprint 8 step 7, is not met. Only this
  project's own operating state is recorded below.
- The operator checkout was clean on `main`, with no other worktree and no open
  Pi session. The workstation runs 0.14.2.
- Host for the native checks: Linux 7.3 (`x64`), cgroup v2 with `memory` and
  `pids` delegated to the user manager, systemd 262, bubblewrap 0.13.1,
  Node.js 26.12.1, npm 12.2.1, Codex CLI 0.166.0, Claude Code 2.1.314.

## Decisions

- Mechanism: each sandbox run starts through
  `/usr/bin/systemd-run --user --scope` in its own transient scope with
  `MemoryMax=1073741824`, `MemorySwapMax=0` and `TasksMax=128`. Bubblewrap
  writes its child PID to `--info-fd 3` and holds the command on
  `--block-fd 4` until the server has verified both processes' cgroup
  membership and the scope's effective `memory.max`, `memory.swap.max` and
  `pids.max`. Probe, admission, Doctor and every command use this one path.
- Overlay bound: the brief's proposed 512 MiB shared bound for the overlay
  upper layers is not implemented. Evidence: bubblewrap 0.13.1 rejects
  `--size` before `--tmp-overlay` (`--size must be followed by --tmpfs`), and
  `--overlay RWSRC WORKDIR` resolves the upper directory on the host
  (`Can't find source path /tmp/u` for an upper on the sandbox's own sized
  tmpfs). A nested outer bubblewrap that provides a sized tmpfs works
  (`ENOSPC`, host unchanged) but adds a second namespace layer with a view of
  the host root, a sandbox redesign. Instead the upper layers, `/tmp` and the
  root tmpfs are charged to the scope's memory cgroup without swap, so they are
  bounded by the 1 GiB together with process memory. A native check with a
  64 MiB test limit ended a 200 MB write into the workspace overlay, `/tmp` and
  the root tmpfs each with exit 137, the host workspace unchanged and no scope
  left. The independent design check (GPT 6.1 Terra) chose the same option.
- The user manager is reached through `/run/user/<uid>`, derived from the
  server's UID and validated, so a Codex-launched server without
  `XDG_RUNTIME_DIR` works; that directory is the launcher's only environment.
- No new code, configuration field, Doctor id or report field. The values are
  fixed constants; tests inject smaller limits through an internal seam.

## Roles and routing

`pi_capabilities_get` on 2026-10-30 (server 0.14.2) lists every profile used
below.

| Requested | Profile used | Status |
| --- | --- | --- |
| agy (planning, dependency matrix, review route) | `agy -p --model gemini-3.8-flash-high --mode plan` | used once for the task and dependency matrix and the review route |
| GPT 6.1 Terra (technical decision) | `review-terra` (openai `gpt-6.1-terra`) | used for the B0 decision; Terra is visible since #199 |
| GPT 6.1 Terra (main implementation) | `code-terra` | see progress log |
| DeepSeek (native regressions) | `code-deepseek` (`deepseek-flash`) | see progress log |
| GLM 5.3 (independent review) | see progress log | |
| Mistral Large 4 (release evidence, docs) | not used | the release evidence needed only local commands; the controller is the only docs editor |
| Grok 4.7 (adversarial review) | see progress log | |
| Sonnet 5.5 (final integration review) | see progress log | |

At most two coding workers ran at once, each on its own leased writer and
branch. One owner per file: `src/sandbox-shell.ts` and
`test/sandbox-shell.test.ts` the implementer, `test/sandbox-shell.bwrap.test.ts`
the test author, Doctor, documentation and records the controller.

## Tasks

| Id | Task | Route | Change area | Depends on |
| --- | --- | --- | --- | --- |
| A | Published-release acceptance of 0.14.2 | controller | records | — |
| B0 | Mechanism decision, native feasibility | controller, `review-terra` | none | — |
| B | Limited launch and gate, mock tests | writer, `code-terra` | `src/sandbox-shell.ts`, `test/sandbox-shell.test.ts` | B0 |
| C | Native resource matrix | writer, `code-deepseek` | `test/sandbox-shell.bwrap.test.ts` | B0 interface |
| D | Doctor remediation and tests | controller | `src/doctor.ts`, `test/doctor-sandbox.test.ts` | B |
| I | Integration, native matrix, Level 1/2, live checks | controller | records | B, C, D |
| R | Independent reviews on the integrated commit | read-only workers | none | I |

## Progress log

- A: see [v0.14.2 post-release evidence](../acceptance.md#v0142-post-release-evidence).
- B0 (`review-terra`, 29 s): `DECISION: A` (one bubblewrap in a limited scope,
  aggregate memory bound), with gate requirements adopted in the frozen
  interface: kill before closing the block fd, exact scope-path checks,
  validated per-UID runtime directory, both binaries trusted.
- B (`code-terra` on writer `pi-session-mcp-w1`, base `7b8e5c8`): the first
  turn ended after 28 seconds with `BLOCKED` and no change, an early stop; one
  narrower follow-up produced the launch, gate and fake changes (`263f3bc`,
  `e055809` after collection) but reported `BLOCKED` because `npm ci` ran out
  of space inside the writer, so it ran no check. The controller verified and
  completed the work: setup aborts and timeouts now keep their own errors
  (`9d7bdc3`), and the unit matrix covers the scope check and every gate
  refusal (`0cef86e`).
- C (`code-deepseek` on writer `pi-session-mcp-w2`): the native matrix
  (`4785563`). The controller fixed two tests that did not prove their claim:
  the Python allocation now touches its pages, and the `/tmp` case writes its
  error where it can be read (`e25fa5a`).
- D (controller): the Doctor remediation names the user manager and the
  delegation (`25bb2aa`).
- I (controller): the first Level 1 on `25bb2aa` failed four adapter tests
  whose sandbox fakes predated the gate; fixed in `205ed50`. Both writers were
  collected, their refs checked with `git cherry` (nothing left out) and
  finished (`writer_reset`).
- R1 (`review-glm-sandboxed`, 3m05s, on `de7d59d`, `git rev-parse` checked by
  the reviewer): `NON_BLOCKING_ONLY`. Adopted: the missing candidate record
  (now below in the acceptance record), the setup abort and timeout result in
  ADR 0013, swap accounting in the installation guide, and tests for the
  runtime-directory check, a split child-PID report and a launcher that ends
  during verification (`58ed42f`, `4b4d6bc`). Not adopted: the duplicate trust
  check per command (harmless) and a separate setup budget for the 5-second
  probe (scope creation took milliseconds here; recorded as a risk).
- R2 (`review-grok`, optional adversarial review, on `de7d59d`): the turn
  ended after 6m33s with `turn_failed` and no report. Not retried: the xAI
  profiles are known to fail since 2026-10-25, and the review was optional.
- Live budget, recorded before the first live turn (2026-10-30, 18:57 UTC):
  candidate `de7d59d`, installed from its packed tarball into a disposable
  prefix; worker profile `ro-sandboxed` (`deepseek`/`deepseek-flash`,
  `medium`, `shell: "sandboxed"`, delivery off) on a synthetic five-commit
  repository. At most one main run and one restart run per client (Claude
  Code with Sonnet 5.5 as controller, Codex with its default model), at most
  four worker turns per main run and none in a restart run, 15 minutes per
  run. No other provider, account or quota is touched.

## Remaining risk and limits

- CPU time and I/O bandwidth are not limited; concurrent commands each have
  their own scope.
- A filled overlay or tmpfs ends the command through the out-of-memory handling
  rather than `ENOSPC`, except `/tmp` at 512 MiB.
- Hosts without a systemd user manager or with `memory` or `pids` not delegated
  lose the sandboxed shell (`sandbox_unavailable`).
- #120 is unchanged.

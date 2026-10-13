# Sprint 3: live usage acceptance

Base: main `0aae6390c539e1d70138f1efaf297e6193a2b497` (the merge of Sprint 2,
[#69](https://github.com/plagor44-ux/pi-session-mcp/pull/69)). Date: 2026-10-13.
Planning sources: the [roadmap](../roadmap.md) and the
[post-0.8.1 audit](../reviews/2026-10-13-post-0.8.1-audit.md) (R05–R11 and the
Sprint 3 exit gate).

This file tracks Sprint 3. A status of `implemented` or `verified` is set only
together with evidence below.

## Scope and maintainer decisions

Decided by the maintainer on 2026-10-13:

- The Pi profiles actually intended for use (R09) are `explore-fast`
  (read-only; OpenAI `gpt-6-luna`, thinking `low`) and `code-deepseek`
  (coding; DeepSeek `deepseek-flash`, thinking `high`). Results cover this
  pair only.
- All Linux items run now, each once: R05 (ten-task Level 3 cycle, both
  controllers), R06 (a new Codex abort run), R07 (Codex home-skill discovery)
  and R08 (three concurrent sessions with a read-only reviewer). Failures stay
  on record.
- A 0.8.2 patch release follows the live runs in its own pull request. Merge,
  tag and publication remain maintainer decisions.
- R10 and R11 need the work Mac, which is not reachable from the Linux
  workstation; they are blocked, and the [runbook](#appendix-macos-runbook-r10-r11)
  below describes the light check to run there.

Out of scope: new runtime features, dependency or Pi SDK updates, MCP contract
changes, Sprint 4 decisions.

The live runs use a separate detached, built checkout of the release under
test at the base commit: `dist/main.js` SHA-256
`47875d38886528ace6b242df2c6ad79d624c51e330e63c2f401576eadc449ed7`, `dist`
JavaScript tree SHA-256
`f85bf73ee8c0ddb2270d8d6040feffbc49f018d2e6ab6253fffb828654a389df`. Live runs
are strictly sequential: one controller invocation at a time.

## Status legend

planned, in_progress, implemented (code or tooling exists), verified (the named
criteria are met with evidence), blocked (a named blocker), failed (the run
happened and did not meet its criteria; it stays on record).

## Tasks

| Task | Issue | How | Status |
| --- | --- | --- | --- |
| Harness tests time out on macOS (main CI after #69) | [#70](https://github.com/plagor44-ux/pi-session-mcp/issues/70) | One fixture build per case | implemented; the pull request CI on macOS decides |
| R08 three sessions with a read-only reviewer | [#71](https://github.com/plagor44-ux/pi-session-mcp/issues/71) | `trio` scenario of the multi-session harness, then one live run per controller | partially verified: Codex passed; Claude Code failed on timing only ([#74](https://github.com/plagor44-ux/pi-session-mcp/issues/74)) |
| R05 / R09 ten-task Level 3 cycle | None (acceptance) | Private per-cycle driver, as [acceptance](../acceptance.md#level-3-live-two-client-acceptance) prescribes; pre-registered | verified (10/10, all gate conditions) |
| R06 new Codex abort run | None (acceptance) | Multi-session harness at the base commit, `abort` scenario, Codex | verified |
| R07 Codex discovery of the setup-installed skill | None (acceptance) | One real Codex run in an isolated home | verified |
| R10 / R11 current macOS Level 2 and smoke | None | Runbook below | blocked (work Mac not reachable) |

## Main CI on the Sprint 2 merge

The main CI run [38442206975](https://github.com/plagor44-ux/pi-session-mcp/actions/runs/38442206975)
on `0aae639` failed on `macos-15` only: one harness test timed out after
5684 ms against the default 5000 ms. The merge tree equals the pull-request
head `fb40f99`, whose CI passed on all platforms, and the test needs under
0.6 s on Linux. The cause is a test design defect (four fixture builds inside
one test), tracked as #70 and fixed in this sprint without raising a timeout.
The failed run stays on record; no manual re-run was started.

## Evidence

### R07: Codex home-skill discovery

Private check script, pre-registered by its SHA-256
`018fddbd28f699998cba23ec902f98d68951851052aa62209236fea5d5a9e7d2` before the
run. Codex CLI `0.162.1`, Linux.

- The candidate's `pi-session-mcp-setup --apply --target codex:user:pi-session-mcp`
  ran with a disposable `HOME` and `CODEX_HOME`: exit 0, `skill_installed`; the
  installed copy is a regular directory, equal to the candidate's skill; no
  link exists in the project.
- One real `codex exec` (`--ignore-user-config`, `--sandbox read-only`, the
  disposable `HOME`, the operator's `CODEX_HOME` only for authentication) in a
  project that is its own git root reported the skill as available, named the
  installed copy's `SKILL.md` as its path, and quoted verbatim a line that
  exists only in the revision under test (#62), not in the 0.8.1 copy.
- The operator's own `~/.agents/skills` was unchanged; the disposable
  directory was removed.

Limit: the path is the model's report. It matches the installed copy, and the
quoted line proves that the current revision was read; it is no proof of
Codex's internal precedence between several skill sources.

### Level 3 pre-registration

Recorded before the first Level 3 task. Both prepared runs (Claude Code with the
operator home, Codex with a disposable home on a non-temporary disk outside the
operator home) share one pre-registration content digest over the prompts,
tasks, tools, oracles, allowed files, the coding barrier, the profiles
(permission, provider, model, thinking) and the fixture digests:
`8645f3a4d4f700180473bbe9b4280c565bebf4e49e185685e2c0f712dd856cf5`. The private
per-cycle driver has SHA-256 `c160a9e54885dc6d706b7e922b2d117fb98fc3ae2fe1a81ae56f68f87adccdaf`.

The worker profiles copy provider, model, thinking level and permission of the
intended `explore-fast` and `code-deepseek`. Both operator profiles also grant a
read-only external MCP tool (`codegraph_explore`); the acceptance tooling never
copies MCP servers, and Level 3 does not cover external MCP grants, so the runs
use the profiles without it. The disposable Codex home is a conservative
isolation choice: the operator home holds no `pi-session-orchestration` copy in
`~/.agents/skills`.

### R06: new Codex abort run

`scripts/multi-session-acceptance.mjs` at the base commit (harness SHA-256
prefix `7c43cc8a`), `prepare --from-profile code-deepseek` (DeepSeek
`deepseek-flash`, thinking `high`), then one `run --client codex --scenario
abort`, with a disposable home and the operator's `CODEX_HOME` and Pi agent
directory passed explicitly. Codex CLI `0.162.1`, Node.js `26.11.1`, Linux
x64. Started 2026-10-13 19:30 UTC, 100 s.

- `acceptance.passed: true`, no failure code. The `wait` turn ended `aborted`,
  the `range` turn `completed` with its tests passing, and both fixtures
  changed only allowed files: the strict scope oracle (`range:changes`) that
  failed the v0.8.1 Codex abort run passed unchanged.
- Both sessions closed, no residual process, no bound resource changed or
  unbound, no structural leak, the handshake token appeared nowhere.
- The sanitized evidence record contains no path.

### R05 / R09: ten-task Level 3 cycle

Private per-cycle driver (SHA-256 prefix `c160a9e5`), pre-registered as
recorded above. Candidate: detached checkout of `0aae639`, clean, package
`0.8.1`, `dist/main.js` SHA-256 `47875d38…`. Clients Claude Code `2.1.296`
and Codex CLI `0.162.1`; Node.js `26.11.1`; Linux x64. Worker profiles
`l3-read` (OpenAI `gpt-6-luna`, `low`, read-only) and `l3-code` (DeepSeek
`deepseek-flash`, `high`, coding). Claude Code ran with the operator home,
Codex with a disposable home; both runs share the pre-registration digest
`8645f3a4…`.

- Preflight: both profiles answered PONG through the candidate server and
  closed; the server exited with empty stderr.
- Six invocations, strictly sequential, 19:33–19:40 UTC (56–94 s each):

  | Client | Read-only analysis | Read-only follow-up | Coding change | Coding follow-up | Abort and recovery |
  | --- | --- | --- | --- | --- | --- |
  | Claude Code | intended | intended | intended | intended | intended |
  | Codex | intended | intended | intended | intended | intended |

- Verdict: accepted, 10 of 10 tasks, and all 16 gate conditions true: both
  clients complete discovery, start, prompt, result and close; a useful
  second turn; a bounded, independently verified coding workflow (barrier
  snapshots taken after each coding turn and before the next prompt, fixture
  tests and hidden business checks on the snapshots, only the allowed files
  changed); no change outside the approved diff; no public leak; no session or
  process left after a verified close; stable, sanitized lifecycle errors;
  bound resources unchanged and complete; Level 1 green for the release source
  (native Linux on `0aae639`: typecheck, strict `npm test` with 54 files, 1300
  passed and 6 skipped, `npm audit` 0).
- The coding barrier worked for both clients, including inside Codex's
  read-only sandbox.
- Liveness and polling: every turn was seen `running` in at most one
  `pi_turn_get` poll, and whenever it was, `updatedAt` had advanced past
  `startedAt`. Both clients waited between polls with `sleep`. This is no
  evidence for the bounded-wait revisit trigger of ADR 0003.

Limits: one cycle, one provider pair, Linux only. The worker profiles do not
include the operator profiles' read-only `codegraph_explore` MCP grant. The
ten tasks are deliberately small and qualify the control path, not model
capability on larger work. No live run failed with `noServerObserved`, so this
sprint adds no input for R15.

### R08: three concurrent sessions with a read-only reviewer

`scripts/multi-session-acceptance.mjs` of this sprint's branch at `63d5ff7`
(harness SHA-256 prefix `bb1620ad`), reviewed before the runs (see
[Independent review](#independent-review)); candidate `0aae639`; `prepare
--from-profile code-deepseek` (DeepSeek `deepseek-flash`, `high`, for both
`accept-code` and `accept-read`); one `trio` run per controller, Claude Code
with the operator home, Codex with a disposable home. 2026-10-13, 20:13–20:17
UTC.

| Controller | Result | Duration | Notes |
| --- | --- | --- | --- |
| Codex `0.162.1` | passed, no failure code | 102 s | Three sessions on their expected aliases and profiles; all first turns overlapped; `wait` aborted by one successful, on-target abort while `slug` and `review` were running; `slug` tests passed within `src/slug.js`; the `review` fixture unchanged in working tree, index and `HEAD`; all closed; no residual process, leak or resource change |
| Claude Code `2.1.296` | failed: `neighborsNotRunningDuringAbort` only | 118 s | Every other criterion passed as for Codex. The `review` turn completed after 10.7 s, 6.7 s before the abort of `wait`, which came about 10 s after the `wait` turn started instead of the requested about 5 s; `slug` was still running |

The failure is a timing outcome of the scenario design, not a session-control
defect; it stays on record and was not repeated, as decided for this sprint.
Follow-up: [#74](https://github.com/plagor44-ux/pi-session-mcp/issues/74).
Three concurrent sessions, a read-only reviewer of a frozen result and a
neighbor abort are therefore accepted for Codex; for Claude Code everything
except the reviewer still running at the abort is shown.

### Native gate

On `0e90589` (this branch before this record), native Linux: `npm ci`,
typecheck, `build:cli`, `NODE_OPTIONS=--unhandled-rejections=strict npm test`
(54 files; 1409 passed, 6 skipped, 0 failed; no unhandled error), build,
`npm audit` and `npm audit --omit=dev` (0 vulnerabilities), `git diff --check`
and a clean status all exited with `0`; `npm pack --dry-run` listed 134 files
without sources, tests, lockfile, plans or the harness. The test count adds the
109 new harness cases to the 1306 of Sprint 2. The built `dist` tree equals the
one of the base commit, so the package runtime is unchanged and the live
evidence above binds to this branch. No client session in a test root and no
client process appeared during the run.

## Independent review

The harness changes for #70 and #71 were reviewed before the R08 runs by two
read-only reviewers who did not write them:

| Reviewer | Round | Verdict | Outcome |
| --- | --- | --- | --- |
| Claude family | 1 | approve with nits | An abort on a neighbor with `abort_timeout` was not judged; the reviewer started last and could finish before the abort; a looser `slug` scope in `trio`; an end-state-only read-only oracle; missing `analyze`-to-verdict tests; one test with two fixture builds. All addressed: `c80383f` to `63d5ff7`; the end-state limit is documented. |
| OpenAI family (Pi `review` profile) | 1 | changes requested | A failed abort with an unknown session id disappeared from the verdict (concrete false pass), also in the existing `abort` scenario; lost aggregate coverage in the #70 split. Fixed: every `pi_session_abort` call is judged in `abort` and `trio` (new code `offTargetAbort`); an aggregate test. |
| OpenAI family | 2 | approve | No new finding. |

The stricter abort rule also applies to `abort`. The recorded R06 run was
checked by hand against it: its transcript holds one abort call, on its own
started session, with an ok result.

## Open gates

- This sprint's pull request CI (Linux, macOS 15, macOS 26), which also shows
  whether #70 removed the `macos-15` timeout, and the maintainer's merge.
- [#74](https://github.com/plagor44-ux/pi-session-mcp/issues/74): the `trio`
  timing with Claude Code as controller (entry condition in the issue).
- R10 and R11 on the work Mac ([runbook](#appendix-macos-runbook-r10-r11)).
- R22 (external ChatGPT project instructions) stays blocked on an operator
  action.

## Next step

After the merge, the 0.8.2 release pull request follows, as the maintainer
decided: version, changelog heading and pre-release acceptance on the release
candidate. It carries #59, #56 and #60, which the published 0.8.1 does not
have (0.8.1 still deletes a partial trash), and the #62 skill change; the MCP
contract is unchanged. Merge, tag and publication stay maintainer decisions.
Then Sprint 4 decides from the evidence of Sprints 1–3 and the
[Sprint 4 decision inputs](https://github.com/plagor44-ux/pi-session-mcp/pull/73)
prepared in parallel.

## Closure

Sprint 3 closed on 2026-10-13. Pull request
[#75](https://github.com/plagor44-ux/pi-session-mcp/pull/75) was merged as
`f636e6e` after its final-head CI passed on Linux, macOS 15 and macOS 26 (run
`38462141219`); the CI run on main (`38465781209`) passed on the same
matrix, so #70 holds on main too. The merge closed #70 and #71 as completed.
The Sprint 4 decision inputs
([#73](https://github.com/plagor44-ux/pi-session-mcp/pull/73), #72) followed
as `166ffef`, also with green CI on main. Open from this sprint: #74, R10 and
R11 on the work Mac, and R22. The 0.8.2 release is prepared in its own pull
request.

## Appendix: macOS runbook (R10, R11)

Light checks only; no full test suite and no parallel model work on the work
Mac. Run them from a checkout of the release under test.

1. `npm ci`, `npm run build`, `npm run build:cli`.
2. Level 2 with both clients in disposable homes:
   `node scripts/setup-acceptance.mjs --setup "node <checkout>/dist/setup-main.js" --build-dir <checkout> --work-dir ~/.cache/pi-session-mcp-acceptance --label "macOS <version> <commit>" --out <private file>`.
   Record the exit status, the check count, the client versions and the
   result's `realRegistrationsUnchanged`, `processCheck` and `buildUnchanged`.
3. Read-only smoke (R11): one `pi_session_start` with a read-only profile, one
   short prompt, `pi_turn_get` until completed, `pi_session_close`, through the
   installed client registration.
4. Record date, macOS version, commit, `dist/main.js` SHA-256 and the outcomes
   in [acceptance](../acceptance.md), without paths or prompt content.

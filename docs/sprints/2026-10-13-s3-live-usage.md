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
| Harness tests time out on macOS (main CI after #69) | [#70](https://github.com/plagor44-ux/pi-session-mcp/issues/70) | One fixture build per case | in_progress |
| R08 three sessions with a read-only reviewer | [#71](https://github.com/plagor44-ux/pi-session-mcp/issues/71) | `trio` scenario of the multi-session harness, then one live run per controller | in_progress |
| R05 / R09 ten-task Level 3 cycle | None (acceptance) | Private per-cycle driver, as [acceptance](../acceptance.md#level-3-live-two-client-acceptance) prescribes; pre-registered | in_progress |
| R06 new Codex abort run | None (acceptance) | Multi-session harness at the base commit, `abort` scenario, Codex | planned |
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

### R06, Level 3, R08

Pending.

## Open gates

- Every pending task above; the Sprint 3 pull request's CI and its merge.
- R10/R11 on the work Mac.

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

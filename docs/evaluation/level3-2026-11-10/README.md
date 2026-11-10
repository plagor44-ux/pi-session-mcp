# Level 3 cycle on the `main` commit `93980d9` (2026-11-10)

One ten-task [Level 3](../../acceptance.md#level-3-live-two-client-acceptance)
cycle against an unreleased commit of `main` with Pi SDK `1.5.2`, run once from
22:38 to 22:48 UTC. It follows the
[execution plan](../../superpowers/plans/2026-11-10-level3-live-acceptance.md),
Part 1, with target B. It is the first full cycle on Pi SDK `1.5.2` and the
first since the [cycle on v0.16.1](../level3-2026-11-02/README.md).

The commit is not a release. Its `package.json` still says `0.20.0`, and the
published `0.20.0` (tag `v0.20.0`, Pi SDK `1.5.0`) has no cycle. A result for
this commit is not evidence for another commit or for a later release.

Two attempts are on record: [attempt 1](#attempt-1-blocked-at-the-preflight)
was blocked at the preflight and started no task; attempt 2 is the cycle.

## Setup

- Server: a fresh clone of the repository, detached at
  `93980d93c4b748ada38b8137fedca547aa293150` (`main` after the merge of pull
  request #283), clean, built with `npm ci`, `npm run build:cli` and
  `npm run build`. SHA-256 of `dist/main.js`:
  `362286248e2b59c3b90058533427f89d3168983584c4e9fdeecd2c5f9a5ab336`, the same
  before and after the cycle. SHA-256 over the sorted per-file SHA-256 list of
  the 230 files in `dist/`:
  `f316718abb64856b338e6d546b9ebe3ca4dfa6ab105d590724ccdbf22bab0115`.
- Level 1 on this clone, before the cycle: `npm ci`, `npm run typecheck`,
  `npm run build:cli`, `NODE_OPTIONS=--unhandled-rejections=strict npm test`
  (190 test files and 5126 tests passed, 15 skipped), `npm run build` and
  `npm audit` (0 vulnerabilities) each exited with 0; `git diff --check` and
  `git status --short` printed nothing.
- Host: Linux 7.3 (`x64`), Node.js `22.23.3` for the checks, the proxy and the
  server.
- Clients: Claude Code `2.1.322` with `claude -p`, model `claude-sonnet-5-5`,
  `--strict-mcp-config`, a per-invocation MCP configuration, project settings
  only, and only the eight Pi Session MCP tools plus `Bash(sleep:*)` allowed.
  Codex CLI `0.166.0` with `codex exec --ignore-user-config --ephemeral`, a
  read-only sandbox, the MCP server given with `-c` options and the tool
  approvals of [client setup](../../client-setup.md#run-codex-without-prompts);
  its default model, which its JSON output does not report. Both clients were
  started with standard input from the null device.
- Both clients reached the server through a local stdio proxy that logged the
  JSON-RPC frames and copied a coding workspace before a session's second
  prompt was forwarded (coding barrier). No global registration was changed.
- Configuration: temporary and credential-free, with six synthetic workspace
  aliases (an analysis, a coding and an abort fixture per client), execution
  modes `read-only` for the analysis fixtures and `host` with accepted host
  writes for the others, and two profiles: `read-only` on `openai`
  `gpt-6-luna` (thinking `low`, `maxTurnSeconds` 600) and `coding` on
  `deepseek` `deepseek-flash` (thinking `high`, `maxTurnSeconds` 3600), the
  same selection as in the cycle on v0.16.1. Event delivery off; the clients
  polled with `sleep 5` between `pi_turn_get` calls. No session history and no
  provider store: `pi-session-mcp-provider list` showed the source `inherit`
  for every provider. Offline Doctor passed with 41 checks and no warning.
- Bounds: 1500 seconds per client invocation, 300 seconds per preflight
  invocation. Neither was reached in attempt 2.
- Preflight: `pi-session-mcp-setup --probe-profile <alias> --apply` reported
  `probe_passed` for both profiles before the first task. A capability-only
  connectivity check per client (one `pi_capabilities_get`, no session, no
  turn) passed and left no process.
- Pre-registration: the plan, the prompts, the oracles, the proxy, the
  driver, the evaluator, the hidden tests, both configuration files and the
  fixture digests were fixed and digested locally before the first task, and
  the digest file verified before the driver started. The prompts, the hidden
  tests, the proxy and the two digest tools are byte-identical to those of the
  cycle on v0.16.1 (same SHA-256). Changed against that cycle: the paths, a
  fixed Node.js for the driver, standard input from the null device, one more
  recorded field for the abort tasks, and a new preflight prompt and script.
  The prompts are not published.

## Results

Order: Claude Code analysis, coding, abort, then Codex analysis, coding,
abort; one invocation each, strictly sequential, no task repeated.

| Client | Invocation | Exit | Duration | Turns (state) | `pi_turn_get` per turn | Oracle |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | analysis + follow-up | 0 | 35 s | completed, completed | 3, 1 | pass, pass |
| Claude Code | coding + follow-up | 0 | 45 s | completed, completed | 4, 1 | pass, pass |
| Claude Code | abort + fresh session | 0 | 39 s | aborted | 2 | pass |
| Codex | analysis + follow-up | 0 | 48 s | completed, completed | 3, 2 | pass, pass |
| Codex | coding + follow-up | 0 | 41 s | completed, completed | 2, 2 | pass, pass |
| Codex | abort + fresh session | 0 | 66 s | aborted | 2 | pass |

All 10 tasks reached their intended outcome. Every completed turn reported
`completion: "stop"` and `truncated: false`.

- Analysis: the first answer named all three discount codes; the follow-up
  named the calling file and the `RangeError`. Each client read the first turn
  again after the second one; the terminal view was byte-identical. The path,
  mode and content digest of each analysis fixture was identical before and
  after its invocation and equal to the pre-registered digest.
- Coding: the hidden tests passed on the barrier copy taken before the
  follow-up (stage 1) and on the final copy (stages 1 and 2). In every copy
  Git showed only `src/shipping.js` modified and no new commit.
- Abort: each client saw the turn running, aborted it, read `aborted` with no
  `abortReason`, closed the session, saw an empty list, started a fresh session
  that reported `idle`, closed it and saw an empty list again. The file that
  the aborted command would have written after 120 seconds was absent 140
  seconds after the invocation ended. Both abort fixtures were clean in Git
  afterwards.
- Liveness: a running turn with `updatedAt` after `startedAt` was observed in
  all six invocations.
- Reported client cost: Claude Code USD 0.73 for its three invocations of the
  cycle. Codex reports token counts only.

## Independent checks

- Public metadata: every Pi Session MCP tool result, with `assistantText`
  removed, was scanned for local paths, temporary and cache directories, URLs,
  key and token markers, stack frames, network error strings, loopback
  addresses and configuration and credential file names: 0 hits. The
  `assistantText` fields, scanned separately, also had 0 hits.
- Errors: no tool result had `isError` or `ok: false`; no JSON-RPC error. The
  server wrote nothing to standard error in any invocation.
- Processes: no proxy or server process of the run existed before each
  invocation, at its exit or 10 seconds later, and none after the cycle.
- Registrations: digests of the Claude Code MCP registrations and of the
  Codex configuration were identical before and after the cycle.
- Pre-registration: the digest file verified again after the cycle, and the
  prompts, the proxy, the driver, the evaluator, the hidden tests and both
  configuration files still had their pre-registered digests.

## Deviation from the pre-registration

None in attempt 2. The oracle for the abort tasks was the documented state
from the start: a manual abort leaves `abortReason` absent
([tool contract](../../tool-contracts.md#optional-turn-duration-policy)).

## Attempt 1: blocked at the preflight

The first attempt, on the same build and with a pre-registration of its own,
ended at the preflight. No session and no turn was started.

- Profile probes: `probe_passed` for both profiles.
- Capability-only check with Claude Code: exit 0 after 9 seconds, one
  `pi_capabilities_get`, no process left.
- Capability-only check with Codex: ended by the 300-second limit (exit 124).
  Codex waited for more input on standard input, which the harness had left
  open, and never started the server; no JSON-RPC frame was logged and no
  process was left.

The cause was the harness, not the server. For attempt 2 both clients get
standard input from the null device; the changed driver and preflight script
were digested in a new pre-registration, and the whole preflight ran again.
The fixtures were untouched between the attempts (same digests).

## Gate

| Criterion | Result |
| --- | --- |
| At least 8 of 10 tasks without a Pi Session MCP defect | 10 of 10 |
| Both clients: discovery, start, prompt, result, close | yes |
| Both clients: useful sequential second turn | yes |
| Both clients: bounded, independently verified coding workflow | yes |
| No change outside the approved diff | yes |
| No credential, path, raw provider error, prompt or transcript in public metadata | yes |
| No public session and no server process after a verified close | yes |
| Lifecycle errors stable and sanitized | no lifecycle error occurred |
| Level 1 green for the source under test | yes, on the clone, see [Setup](#setup) |

The cycle passed the gate for the commit `93980d9`.

## Not covered

Level 2 (setup acceptance) for this commit, a release or an installed
package, the provider store with a stored key
([#278](https://github.com/plagor44-ux/pi-session-mcp/issues/278)),
interactive approval dialogs, external MCP grants, client restart or resume,
container writers (no workspace of this cycle was a container workspace), the
Claude Code wake (delivery was off), session history, tier routing, macOS, and
model capability on larger work. The fixture tasks are deliberately small. One
cycle with one model per profile says nothing about other providers or models.

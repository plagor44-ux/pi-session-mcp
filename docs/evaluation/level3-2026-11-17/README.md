# Level 3 cycle on the 0.22.2 release candidate `502408e` (2026-11-17)

One ten-task [Level 3](../../acceptance.md#level-3-live-two-client-acceptance)
cycle against the release candidate of `0.22.2` with Pi SDK `1.5.2`, run once
from 22:01 to 22:13 UTC. It follows the
[execution plan](../../superpowers/plans/2026-11-10-level3-live-acceptance.md),
Part 1, with the kit of the [cycle of 2026-11-10](../level3-2026-11-10/README.md).
It is the first full cycle on a release candidate since the
[cycle on v0.16.1](../level3-2026-11-02/README.md).

The candidate commit is the version commit of `0.22.2` on the branch
`chore/release-0.22.2`. The commit after it changes only acceptance records,
the changelog and the README; its build is compared with this one in the
[acceptance record](../../acceptance.md#v0222-pre-release-acceptance). A result
for this commit is not evidence for another commit.

One attempt is on record.

## Setup

- Server: a fresh clone of the repository, detached at
  `502408e7759c645907907128b9e0663bb8977272` (`main` at `51b3c1a` plus the
  version commit), clean, built with `npm ci`, `npm run build:cli` and
  `npm run build`. SHA-256 of `dist/main.js`:
  `362286248e2b59c3b90058533427f89d3168983584c4e9fdeecd2c5f9a5ab336`, the
  same file as in the earlier builds, so it does not tell builds apart. The
  SHA-256 over the sorted per-file SHA-256 list of the 238 files in `dist/`:
  `f70105bb83dbd43881d5ae096860a3bec4397299edd27a81207cc80e96cf687a`, the
  same before the cycle and after it.
- Level 1 on this clone, before the cycle: `npm ci`, `npm run typecheck`,
  `npm run build:cli`, `NODE_OPTIONS=--unhandled-rejections=strict npm test`
  (197 test files, 5375 tests passed, 15 skipped) and `npm run build` each
  exited with 0; `git diff --check` and `git status --short` printed nothing.
  `npm audit` exited with 1 and reported 7 high vulnerabilities, all from one
  advisory in development dependencies; `npm audit --omit=dev` exited with 0
  and reported none (details in the
  [acceptance record](../../acceptance.md#v0222-pre-release-acceptance)).
- Host: Linux 7.3 (`x64`), Node.js `26.13.1` for the checks, Node.js
  `22.23.3` for the driver, the proxy and the server.
- Clients: Claude Code `2.1.326` with `claude -p`, model `claude-sonnet-5-5`,
  `--strict-mcp-config`, a per-invocation MCP configuration, project settings
  only, and only the eight Pi Session MCP tools plus `Bash(sleep:*)` allowed.
  Codex CLI `0.167.1` with `codex exec --ignore-user-config --ephemeral`, a
  read-only sandbox, the MCP server given with `-c` options and the tool
  approvals of [client setup](../../client-setup.md#run-codex-without-prompts);
  its default model, which its JSON output does not report. Both clients were
  started with standard input from the null device.
- Both clients reached the server through the local stdio proxy of the earlier
  cycles, which logged the JSON-RPC frames and copied a coding workspace
  before a session's second prompt was forwarded (coding barrier). No global
  registration was changed.
- Configuration: temporary and credential-free, with six synthetic workspace
  aliases (an analysis, a coding and an abort fixture per client), execution
  modes `read-only` for the analysis fixtures and `host` with accepted host
  writes for the others, and two profiles: `explore-fast`, `read-only` on
  `openai` `gpt-6-luna` (thinking `low`, `maxTurnSeconds` 600), and
  `code-deepseek`, `coding` on `deepseek` `deepseek-flash` (thinking `high`,
  `maxTurnSeconds` 3600), the same providers and models as in the two earlier
  cycles. Event delivery off; the clients polled with `sleep 5` between
  `pi_turn_get` calls. No session history, no tier routing and no provider
  store. Offline Doctor passed with 41 checks and no warning.
- Bounds: 1500 seconds per client invocation, 300 seconds per preflight
  invocation. Neither was reached.
- Preflight: `pi-session-mcp-setup --probe-profile <alias> --apply` reported
  `probe_passed` for both profiles before the first task. A capability-only
  connectivity check per client (one `pi_capabilities_get`, no session, no
  turn) passed and left no process.
- Pre-registration: the prompts, the hidden tests, the proxy, the driver, the
  evaluator, the gate script, both configuration files, the plan and the
  fixture digests were fixed and digested locally before the first task, and
  the digest file verified before the driver started. Against the cycle of
  2026-11-10, the prompts differ only in the two profile aliases they name;
  the common prompt, the preflight prompt, the hidden tests, the proxy and the
  two digest tools are byte-identical. The driver, the fixture and preflight
  scripts and the evaluator changed in their paths; the evaluator also records
  the server version that `pi_capabilities_get` reports and the size of the
  server's standard error. The prompts are not published.

## Results

Order: Claude Code analysis, coding, abort, then Codex analysis, coding,
abort; one invocation each, strictly sequential, no task repeated.

| Client | Invocation | Exit | Duration | Turns (state) | `pi_turn_get` per turn | Oracle |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | analysis + follow-up | 0 | 74 s | completed, completed | 3, 1 | pass, pass |
| Claude Code | coding + follow-up | 0 | 65 s | completed, completed | 3, 1 | pass, pass |
| Claude Code | abort + fresh session | 0 | 66 s | aborted | 2 | pass |
| Codex | analysis + follow-up | 0 | 42 s | completed, completed | 3, 2 | pass, pass |
| Codex | coding + follow-up | 0 | 52 s | completed, completed | 4, 3 | pass, pass |
| Codex | abort + fresh session | 0 | 55 s | aborted | 2 | pass |

All 10 tasks reached their intended outcome. Every completed turn reported
`completion: "stop"` and `truncated: false`. Every invocation's
`pi_capabilities_get` reported server version `0.22.2`.

- Analysis: both answers of each client passed their oracles. Each client read
  the first turn again after the second one; the terminal view was
  byte-identical. The path, mode and content digest of each analysis fixture
  was identical before and after its invocation and equal to the
  pre-registered digest.
- Coding: the hidden tests passed on the barrier copy taken before the
  follow-up (stage 1) and on the final copy (stage 2). In every copy Git
  showed only `src/shipping.js` modified and no new commit.
- Abort: each client saw the turn running, aborted it, read `aborted` with no
  `abortReason`, closed the session, saw an empty list, started a fresh
  session that reported `idle`, closed it and saw an empty list again. The
  file that the aborted command would have written after 120 seconds was
  absent 140 seconds after the invocation ended.
- Liveness: a running turn with `updatedAt` after `startedAt` was observed in
  five of the six invocations; in Claude Code's analysis invocation every
  running view still had `updatedAt` equal to `startedAt`. Liveness is an
  observation, not a gate criterion.
- Reported client cost: Claude Code USD 0.83 for its three invocations of the
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
  invocation, at its exit or 10 seconds later (14 checks), and none after the
  cycle.
- Registrations: digests of the Claude Code MCP registrations and of the
  Codex configuration were identical before and after the cycle.
- Pre-registration: the digest file verified again after the cycle, and each
  of the 16 digested files still had its pre-registered digest.

## Deviation from the pre-registration

None.

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
| Level 1 green for the source under test | no: every command passed except `npm audit`, see [Setup](#setup) |

Every live criterion passed. The gate is not passed as written, because its
Level 1 criterion requires `npm audit` to report 0 vulnerabilities. Whether
the development-only advisory blocks the release is the maintainer's
decision.

## Not covered

Level 2 for an installed release (it ran on this candidate, see the
acceptance record), interactive approval dialogs, external MCP grants, client
restart or resume, container writers (no workspace of this cycle was a
container workspace), the Claude Code wake (delivery was off), several
sessions at the same time, session history, tier routing, macOS, and model
capability on larger work. Targeted checks of the writer pool, of history, of
routing and of the upgrade ran separately on the same build; see the
[live record](../release-0.22.2-2026-11-17/README.md). The fixture tasks are
deliberately small. One cycle with one model per profile says nothing about
other providers or models.

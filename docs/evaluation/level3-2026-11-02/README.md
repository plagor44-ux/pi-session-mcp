# Level 3 cycle on v0.16.1 (2026-11-02)

One ten-task [Level 3](../../acceptance.md#level-3-live-two-client-acceptance)
cycle against the published release `0.16.1` (Pi SDK `1.5.0`), run once from
18:42 to 18:52 UTC. It is the first full cycle on Pi SDK `1.x`.

## Setup

- Server: a fresh clone of the tag `v0.16.1` (tag object `6c8576c`, commit
  `6c533ac`), built with `npm ci`, `npm run build:cli` and `npm run build`.
  SHA-256 of `dist/main.js`:
  `236a99968d7d68d75f5f21a9e118c6ffe0d95d84da033d38aa730d0ec6691864`, the same
  before and after the cycle.
- Host: Linux 7.3 (`x64`), Node.js `26.13.0`.
- Clients: Claude Code `2.1.316` with `claude -p`, model `claude-sonnet-5-5`,
  `--strict-mcp-config`, a per-invocation MCP configuration, project settings
  only, and only the eight Pi Session MCP tools plus `Bash(sleep:*)` allowed.
  Codex CLI `0.166.0` with `codex exec --ignore-user-config --ephemeral`, a
  read-only sandbox, the MCP server given with `-c` options and the tool
  approvals of [client setup](../../client-setup.md#run-codex-without-prompts);
  its default model, which its JSON output does not report.
- Both clients reached the server through a local stdio proxy that logged the
  JSON-RPC frames and copied a coding workspace before a session's second
  prompt was forwarded (coding barrier). No global registration was changed.
- Configuration: temporary and credential-free, with six synthetic workspace
  aliases (an analysis, a coding and an abort fixture per client), execution
  modes `read-only` for the analysis fixtures and `host` with accepted host
  writes for the others, and two profiles: `read-only` on `openai`
  `gpt-6-luna` (thinking `low`) and `coding` on `deepseek` `deepseek-flash`
  (thinking `high`). Event delivery off; the clients polled with
  `sleep 5` between `pi_turn_get` calls. Offline Doctor passed with no
  warning.
- Preflight: `pi-session-mcp-setup --probe-profile <alias> --apply` reported
  `probe_passed` for both profiles before the first task. A capability-only
  connectivity check per client (no session, no turn) passed and left no
  process.
- Pre-registration: the plan, the prompts, the oracles, the proxy, the
  driver, the hidden tests, both configuration files and the fixture digests
  were fixed and digested locally before the first task. The prompts are not
  published.

## Results

Order: Claude Code analysis, coding, abort, then Codex analysis, coding,
abort; one invocation each, strictly sequential, no task repeated.

| Client | Invocation | Exit | Duration | Turns (state) | `pi_turn_get` per turn | Oracle |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | analysis + follow-up | 0 | 38 s | completed, completed | 3, 1 | pass, pass |
| Claude Code | coding + follow-up | 0 | 32 s | completed, completed | 2, 1 | pass, pass |
| Claude Code | abort + fresh session | 0 | 37 s | aborted | 2 | pass |
| Codex | analysis + follow-up | 0 | 35 s | completed, completed | 3, 1 | pass, pass |
| Codex | coding + follow-up | 0 | 50 s | completed, completed | 3, 2 | pass, pass |
| Codex | abort + fresh session | 0 | 62 s | aborted | 2 | pass |

All 10 tasks reached their intended outcome. Every terminal turn reported
`completion: "stop"` and `truncated: false` where the field applies.

- Analysis: the first answer named all three discount codes with kind and
  value; the follow-up named the calling file and the `RangeError`. Each
  client read the first turn again after the second one; the terminal view
  was byte-identical. The path, mode and content digest of each analysis
  fixture was identical before and after its invocation.
- Coding: the hidden tests passed on the barrier copy taken before the
  follow-up (stage 1) and on the final copy (stages 1 and 2). In every copy
  Git showed only `src/shipping.js` modified and no new commit.
- Abort: each client saw the turn running, aborted it, read `aborted`, closed
  the session, saw an empty list, started a fresh session that reported
  `idle`, closed it and saw an empty list again. The file that the aborted
  command would have written after 120 seconds was absent 130 seconds after
  the invocation ended.
- Liveness: a running turn with `updatedAt` after `startedAt` was observed in
  five of six invocations; in the remaining one every turn finished between
  two polls.

## Independent checks

- Public metadata: every Pi Session MCP tool result, with `assistantText`
  removed, was scanned for local paths, temporary and cache directories, URLs,
  key and token markers, stack frames, network error strings, loopback
  addresses and configuration and credential file names: 0 hits. The
  `assistantText` fields, scanned separately, also had 0 hits.
- Errors: no tool result had `isError` or `ok: false`; no JSON-RPC error.
- Processes: no proxy or server process of the run existed before each
  invocation, at its exit or 10 seconds later.
- Registrations: digests of the Claude Code MCP registrations and of the
  Codex configuration were identical before and after the cycle.

## Deviation from the pre-registration

The pre-registration expected `abortReason: "client"` on the aborted turns.
The [tool contract](../../tool-contracts.md#optional-turn-duration-policy)
says that a manual abort leaves the field absent, and both aborted turns had
no `abortReason`. The expectation was wrong, not the server; the oracle for
the abort tasks is the documented state, which both reached.

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
| Level 1 green for the release source | yes, see [v0.16.1 post-release evidence](../../acceptance.md#v0161-post-release-evidence) |

The cycle passed the gate.

## Not covered

Interactive approval dialogs, external MCP grants, client restart or resume,
container writers (no workspace of this cycle was a container workspace),
the Claude Code wake (delivery was off), macOS, and model capability on
larger work. The fixture tasks are deliberately small.

# Claude Code wake on the `main` commit `93980d9` (2026-11-10)

A targeted check of event delivery `spool` with the wake hook that setup
installs, run once from 23:02 to 23:06 UTC. It follows Part 2 of the
[execution plan](../../superpowers/plans/2026-11-10-level3-live-acceptance.md).
It is not a [Level 3](../../acceptance.md#level-3-live-two-client-acceptance)
cycle and adds nothing to the gate of the
[cycle of the same day](../level3-2026-11-10/README.md), which ran with
delivery off.

## Setup

- Server: the clone and build of the cycle of the same day, commit
  `93980d93c4b748ada38b8137fedca547aa293150` with Pi SDK `1.5.2`, SHA-256 of
  `dist/main.js`
  `362286248e2b59c3b90058533427f89d3168983584c4e9fdeecd2c5f9a5ab336`. Linux
  (`x64`), Node.js `22.23.3`.
- Configuration: temporary and credential-free, event delivery `spool`, a
  private runtime directory for the spool and the claims, two synthetic
  workspaces in execution mode `host` with accepted host writes, a `coding`
  profile on `deepseek` `deepseek-flash` (thinking `high`, `maxTurnSeconds`
  600) that every session used, and an unused `read-only` default profile.
  Offline Doctor passed with 23 checks in the setup environment.
- Hook: installed only by the candidate's own
  `pi-session-mcp-setup --apply --target claude-code:project:pi-session-mcp`
  in a disposable project directory with a disposable home. The dry run
  reported `hook_add_planned`; `--apply` reported `applied`, `skill_installed`
  for both controller skills and `hook_added`; `--verify` reported
  `mcp_verified`, `skill_verified` and `hook_verified`. The project settings
  then held exactly one `PostToolUse` entry with `asyncRewake`, the
  candidate's wake program, the default budget of 1,800,000 ms and a timeout
  of 1860 seconds. No manual hook was used.
- Client: Claude Code `2.1.322` as `claude -p` with stream-json input and
  output, held open by a driver, model `claude-sonnet-5-5`, project settings
  only (`--setting-sources project,local`, so no user-scope hook took part),
  `--strict-mcp-config` with the registration that setup wrote, and only the
  eight Pi Session MCP tools plus `Bash(sleep:*)` allowed. The driver sent
  exactly one user message per session and ended the session after the
  expected terminal reads and the following result.
- Observation: the driver logged the client's output with times and scanned
  the process table every 200 ms for the candidate's server, its wake program
  (the waiter) and processes inside the workspaces. Times below are seconds
  after the session started.
- Pre-registration: the scenarios, their criteria, the prompts, the driver,
  the evaluator and the configuration were fixed and digested before the first
  session; the digest file verified before each scenario and afterwards. The
  prompts are not published.

A first setup step failed with `doctor_failed` before any session: the kit's
configuration had a `coding` profile as its only and default profile, which
Doctor reports as `config_invalid`. Setup changed nothing. The configuration
got the `read-only` default profile, and the pre-registration was digested
again. A smoke session without a Pi tool call confirmed that the driver could
hold and end a session; it is not a wake result.

## Results

Each scenario ran once.

| Scenario | Outcome | Observed |
| --- | --- | --- |
| W1: one turn, the worker runs a 20-second command | passed | Capabilities showed `spool`. The prompt returned a running turn at 9.8 s. The controller's round ended at 11.1 s with no read of the turn and no `sleep`. The waiter was seen from 9.8 s to 31.7 s. A new controller round started at 33.2 s without input from the driver and read the turn once: `completed` after 22.0 s. Session closed, final list empty |
| W2: two turns, 15-second and 50-second commands | passed | Both prompts were accepted (8.1 s and 8.8 s) before any read, and the round ended at 10.7 s. The waiters ended at 25.1 s and 60.7 s; new rounds started at 26.9 s and 62.7 s. Each turn was read once and `completed` (27.6 s and 62.7 s; turn durations 17.1 s and 52.0 s). No read returned `running`, no `sleep`. Both sessions closed, final list empty |
| W4: abort one turn, close the other session while its turn runs (90-second commands) | passed | Both prompts were accepted at 10.0 s and 10.1 s. The abort returned `ok`; the other session was closed at 12.3 s and its turn was never read. Both waiters and both worker commands had ended by 12.2 s. The aborted turn was read once, `aborted` with no `abortReason`, at 15.0 s inside the controller's first round; no further round started. Final list empty; neither workspace had a change in Git |

In every scenario no server, waiter or worker process of the run remained 15
seconds after the client had ended.

The client's stream-json output showed no reminder text in any session. The
wake is therefore inferred from a controller round that starts without input
shortly after the waiter ended, not from a visible reminder; the W4 criterion
"no reminder names the closed session's turn" rests on the same observation
(no round started, the turn was never read). The driver saw process lifetimes,
not exit codes.

## Independent checks

- Tool results: 26 Pi Session MCP results in the three sessions (6, 10 and
  10), none with `isError` or `ok: false`. The scan of the cycle (local paths,
  temporary and cache directories, URLs, key and token markers, stack frames,
  network error strings, loopback addresses, configuration and credential file
  names) had 0 hits in the results without `assistantText` and 0 hits in
  `assistantText`.
- Claims: the private runtime directory held four claims afterwards, one from
  the server instance of W1, two from W2 and one from W4.
- Registrations: the digests of the real Claude Code MCP registrations, of the
  Codex configuration and of the real user settings were identical before and
  after. The server build was unchanged.
- Removal: `pi-session-mcp-setup --remove` for the same target reported
  `removed`, `skill_removed` for both skills and `hook_removed`, and left the
  project settings without a hook.
- Reported client cost: USD 0.90 for the smoke session and the three
  scenarios.

## Not covered

The budget wake (it needs a manual hook with a short budget), hook pickup by
a session that is already running, an interactive session, the VS Code
extension, container writers, macOS, and Codex, which has no wake; its polling
is part of the cycle of the same day. One run per scenario with one client
model says nothing about how often a controller follows the wake path.

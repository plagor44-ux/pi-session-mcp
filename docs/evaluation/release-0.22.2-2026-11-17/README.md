# Live checks on the 0.22.2 release candidate (2026-11-17)

Targeted live checks on the release candidate `502408e` of `0.22.2`, run on
2026-11-17 from 22:04 to 22:40 UTC on Linux 7.3 (`x64`) with Node.js
`26.13.1`, Podman `6.2.0`, bubblewrap `0.13.1`, Claude Code `2.1.326` and
Codex CLI `0.167.1`. They complement the
[Level 3 cycle](../level3-2026-11-17/README.md) on the same build and are not
part of its gate. A result for this build is not evidence for another one.

## Build under test

- The tarball that `npm pack` produced from a clean clone of `502408e`:
  1079 files, SHA-256
  `4de116a8aa5f71580d294551d1edc835370e3760b8217c04a5d3a09cba3ba20c`, npm
  shasum `a44a31d9149aef4bcffe8e4863142001f61ace7b`. It is the same file as
  the tarball of the Level 2 run on that clone.
- Installed with `npm install -g --prefix` into a private temporary prefix.
  The SHA-256 over the sorted per-file SHA-256 list of its `dist/` is
  `f70105bb83dbd43881d5ae096860a3bec4397299edd27a81207cc80e96cf687a`, the
  same as the clone's build. The servers of every check below ran from that
  prefix, and every session start or capability call reported version
  `0.22.2` unless a step names another version.

## Isolation

- Every check used its own temporary configuration, its own workspace aliases
  and synthetic repositories created for it. No real repository, workspace
  alias or client registration took part. The digests of the real Claude Code
  and Codex registrations and of the owner's setup ownership state were the
  same before and after the checks.
- Pi Session MCP resolves the session history and the provider store below
  the home directory of the password database, not below `HOME`. Checks that
  write history or routing state therefore ran in a private mount namespace
  (bubblewrap) that binds a disposable directory over the history directory.
  The real history held no session of these checks afterwards.
- Writer roots and setup ownership follow `HOME`, while the writer launcher
  resolves the password-database home. The test writers therefore lived in
  the real writer root under test aliases and were removed at the end.
- No credential entered a configuration, a prompt or a record.

## Two writers in parallel and a cross-family review

Purpose: two coding workers on the leased container writer pool at the same
time, collection of only the reported writers, integration in the operator
checkout and a review of the integrated commit on a review snapshot by
another model family.

- Fixture: a synthetic Node.js repository with two small modules, a base
  commit and a pre-registered oracle per task: required files, the module's
  tests on a clean extract of the commit, negative cases, mutants that the new
  tests must kill, and files that must stay unchanged.
- Provisioning: `--repo <alias> --mode container --writers 2 --image node
  --network pasta --base main` with two coding profiles. Both writers reported
  `writer_accepted`, and `--writer <name> --verify` reported `mcp_verified`
  for both. Doctor passed with 36 checks. The first `--apply` failed with
  `doctor_failed`, because the configuration already named the snapshot
  alias, whose slot did not exist yet (`workspace_missing`). The alias was
  taken out for provisioning and added again before the snapshot step. This
  is the documented order, not a defect.
- Work: task A, input validation of one module, on `code-terra` (`openai`
  `gpt-6.1-terra`, thinking `medium`); task B, tests for the other module, on
  `code-deepseek` (`deepseek` `deepseek-flash`, thinking `high`). Both
  sessions started on the base commit with `freshness: current`, one per
  writer. Both turns ran at the same time for 14 seconds: A for 28 seconds, B
  for 14 seconds. The controller saw each running with an advancing
  `updatedAt`. Each ended `completed` with `completion: "stop"`.
- Reports: both workers answered `STATUS: DONE` in the agreed form, with one
  commit each. After the sessions closed, `--writer <name> --collect --apply`
  ran for the two reported writers only and reported `writer_collected`. The
  collected refs held exactly the reported commits, and both oracles passed.
- Integration: the controller cherry-picked both commits onto an integration
  branch in the operator checkout. The fixture's tests passed 10 of 10 there,
  and the integration oracle passed.
- Review: a review snapshot slot was prepared for the integrated commit, and
  its `session.snapshot.head` equalled that commit before the first prompt.
  The reviewer ran on a read-only profile on `mistral` `zai-glm-5-3`
  (thinking `high`, no shell), a model family other than both authors'. Its
  report, after 53 seconds, had the valid form, the exact full target hash,
  `STATUS: DONE` and `Verdict: NO_FINDINGS`. The two risks it named were
  already covered by the controller's oracle. No fix round was needed.
- Cleanup: the snapshot slot was removed (`snapshot_removed`). Only then,
  with the work collected and integrated, `--writer <name> --finish --apply`
  reported `writer_reset` for both, and `--writer <name> --remove` reported
  `writer_removed`. No test writer, slot or container was left.

## Abort next to a running session

One server, two sessions: a coding session on a host fixture with accepted
host writes (`code-deepseek`), and a read-only session on a second fixture
(`explore-fast`, `openai` `gpt-6-luna`).

- The coding turn ran a 90-second shell command that would have written a
  file at its end. While it ran and the read-only turn of the other session
  was also running, `pi_session_abort` returned with the session `idle`. The
  turn read `aborted` with no `abortReason`, 3.6 seconds after it started,
  and the child process was gone within one second.
- The other session's turn kept running and completed with
  `completion: "stop"` and the expected answer.
- The file of the aborted command was absent 95 seconds later, and the
  fixture was clean in Git. A follow-up turn in the aborted session completed.
  Both sessions were listed `idle`, both closed, the list was empty, and the
  server exited with 0.
- A first attempt of this check ended before any prompt: the harness ran the
  server under bubblewrap with `--die-with-parent`, which ended it when the
  harness's own shell returned. That attempt is void, and its history file
  was kept apart. The check above ran as a new attempt without that option.

## Session history after real turns

The same two sessions ran with `history.enabled: true`, each with a `task`
label. The read-only fixture held a `.env` file with two values and a public
text file with one word to report. The read-only prompt also carried a
synthetic token of the GitHub token form.

- The raw bytes of the private history file held neither value of `.env` nor
  the synthetic token. The public word was there once.
- `pi-session-mcp-history show` listed the model, the thinking level and the
  messages of the read-only session. It showed the `read` of `.env` as
  `content not stored (path rule)`.
- `pi-session-mcp-history list` showed both sessions with their workspace,
  profile, task label, turn count (2 and 1) and `complete`.
- `pi-session-mcp-history verdict <session> accepted --reason ...` exited
  with 0 for both. A fresh process listed both verdicts with
  `--verdict accepted`.

## Routing status and refresh

Routing in mode `manual`, on the same private history file.

- The first session start on the server ran the automatic learning refresh,
  14 ms after the session was created, and
  `pi-session-mcp-routing status --json` reported its time in
  `lastRefreshAt`. The server checks for that refresh after a session start,
  not when it starts.
- `pi-session-mcp-routing refresh` reported 2 outcomes, 0 changes and 0
  proposals. The next `status` reported the time of that refresh, and the
  history's routing metadata held the same value.
- After `mode off`, `refresh` reported 0 outcomes and recorded no time:
  `lastRefreshAt` stayed at the time of the refresh by hand.
- The `status` of `0.22.1`, in the upgrade check below, has no
  `lastRefreshAt` field. The field is an addition to the report.

## Upgrade to the candidate and rollback

A temporary installation went from the published `0.22.1` (npm registry,
`dist/` digest `e33be3e1f8f8d6a6…`) to the candidate tarball and back to
`0.22.1`, in the order that [Installation](../../installation.md#upgrade)
gives. Three parts shared that prefix:

- Writer part, under the real home: one container repository of a synthetic
  operator checkout with one writer on `code-deepseek`, provisioned under
  `0.22.1` (`writer_accepted`, `mcp_verified`). Before the first switch, a
  real coding session left one uncollected commit in the writer.
- Client part, under a disposable home: the targets
  `claude-code:user:pi-session-mcp` and `codex:user:pi-session-mcp`, applied
  and verified under `0.22.1` (`applied`, `mcp_verified`, skills installed and
  verified).
- History part, on a private history file with routing in mode `manual`: one
  session with one real turn and a verdict under `0.22.1`.

Each switch ran in the same order. No test server of the prefix was running.
The old version removed its own targets (`removed`, skills removed). The test
state was archived. Then the other version was installed. Doctor then
reported `writer_not_ready` with reason `package_version` and
`writer_dirty`. The repository step `--repo <alias> --apply` followed, without
repeated settings: `writer_accepted`, `mode_unchanged`, Doctor only
`writer_dirty`. Then the new version applied and verified the targets
(`mcp_verified`), and `--writer <name> --verify` reported `mcp_verified`.

| After | Claude Code loaded | Codex loaded | Writer work | History sessions | Routing status |
| --- | --- | --- | --- | --- | --- |
| install of `0.22.1` | `0.22.1` | `0.22.1` | one uncollected commit | 1, with verdict | no `lastRefreshAt` field |
| upgrade to the candidate | `0.22.2` | `0.22.2` | same commit, `--collect` dry run planned | 1, then 2 with verdicts | `lastRefreshAt` reported; a refresh by hand recorded its time |
| rollback to `0.22.1` | `0.22.1` | `0.22.1` | same commit, `--collect` dry run planned | 2, then 3 | works, no `lastRefreshAt` field |

- Loaded build: after each switch both real clients started as fresh
  processes from the registration that setup had just written. Each called
  `pi_capabilities_get` once and reported the server version in the table.
  No server process of the prefix was left afterwards.
- Retention: after the rollback, `--collect --apply` reported
  `writer_collected`, and the collected ref held exactly the commit of the
  session under `0.22.1`, with its one file. Every version listed all
  sessions recorded before it, with their verdicts.
- Rollback note: a session start on a `0.22.1` server, one minute after the
  candidate's refresh by hand, left the stored refresh time unchanged. That
  matches the changelog: `0.22.1` reads the time as that of its last automatic
  refresh.
- Cleanup: the writer was removed (`writer_removed`), the targets were removed
  from the disposable home, and the prefix and the disposable home were
  deleted.

## Practice comparison on an application repository

One bounded task in an application repository of the operator (`<repository>`), run once on each of two
delegation paths of the same controller, both started at the same time. The
task, the oracle, the controls and both controller prompts were digested
before the runs.

- Task: add colocated `node:test` tests for an untested pure frontend module
  of `<repository>` (four exported functions), on a disposable clone without
  a remote. The rules: change no other file, install nothing, do not commit.
- Controller on both paths: `claude -p`, model `claude-opus-5-5`, project
  settings only. It delegated the task, verified the result itself with
  `git status`, a read of the new file and `node --test`, and accepted it.
- Path A, Pi Session MCP: the candidate server through a per-invocation MCP
  configuration with `--strict-mcp-config`, a host workspace with accepted
  host writes, profile `code-deepseek`. The controller had no edit tool.
- Path B, native subagent: an implementation subagent from the operator's own
  agent definitions, model `claude-sonnet-5-5`, given with `--agents`.
- Oracle, run by the operator: base commit unchanged; Git shows exactly the
  one new file; nothing installed; the module unchanged; the new test passes
  on the base module; at least 8 of 10 pre-registered behaviour mutants of the
  module make it fail. Controls before the runs: an operator reference test
  killed 10 of 10 and passed; a trivial test killed 0 and failed; an untouched
  workspace failed.

| Path | Wall time | Worker | Controller turns | Controller tool calls | Reported cost | Tests | Mutants killed | Oracle |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A, Pi Session MCP | 84 s | `deepseek-flash`, one turn of 32 s | 18 | 17 | USD 0.68, controller only | 17 of 17 | 10 of 10 | pass |
| B, native subagent | 39 s | `claude-sonnet-5-5`, one call | 6 | 5 | USD 0.70, Opus 0.51 and Sonnet 0.19 | 12 of 12 | 10 of 10 | pass |

- Both paths passed with one delegation and no follow-up. Each controller ran
  `node --test` itself and made no edit; Path B's only `Write` came from the
  subagent. Path A closed its session.
- Path A's wall time comes mostly from polling. The worker finished 32
  seconds after the prompt, and the controller polled with `sleep 15`, as
  instructed, three times. Two of its shell commands were refused by the
  client's own permission check before they ran, and nothing was written.
- Cost: Path A's figure covers the controller alone. No tool reports the
  worker's provider cost. Path B's figure includes the subagent.
- One run per path is no basis for choosing a path. The comparison shows only
  that both paths delivered a correct, bounded result on this task.

## Not covered

macOS, the server host, the Claude Code wake with event delivery, tier
routing with real routed starts, a provider store with a stored key, a
profile with `maxOutputTokens` against a real provider, an abort during a
coding session's `read` (the abort above ended a shell command), larger or
judgement-heavy work in `<repository>`, and any repetition that would allow a
statistical comparison.

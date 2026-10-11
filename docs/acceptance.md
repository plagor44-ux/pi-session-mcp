# Acceptance

This document defines how Pi Session MCP is accepted before a release, what each
acceptance level establishes, and which rules apply to evidence.

Acceptance has three levels. Each level answers a different question, and a
higher level never replaces a lower one.

| Level | Question | Needs |
| --- | --- | --- |
| 1. Repository checks | Does this source build and pass its provider-free tests? | Node.js and npm only |
| 2. Setup acceptance | Can real clients register, verify and remove this build without touching anything else? | Real Codex and Claude Code clients, no model |
| 3. Live two-client acceptance | Do real clients complete real delegated work through this build? | Real clients, local Pi authentication and a model endpoint |

Provider-free tests exercise the real Pi SDK and real stdio child processes with
a scripted model. They do not establish live client or model acceptance. State
only what was run.

## Level 1: repository checks

Run on a clean checkout of the exact source under test:

```bash
npm ci
npm run typecheck
npm run build:cli
npm test
npm run build
npm audit
git diff --check
git status --short
```

Pass criteria:

- Every command exits with `0`, and `git status --short` prints nothing.
- `npm audit` reports 0 vulnerabilities. CI does not run `npm audit`, so this is
  a manual gate. The advisory database changes over time: a result is valid for
  the moment it was taken.

CI (`.github/workflows/ci.yml`) runs the steps from `npm ci` through
`npm run build`, without `npm audit` and the two Git checks, on Node.js 22.19.0
for every push and pull request. A result is valid for the commit it ran on.

The nightly Pi SDK canary (`.github/workflows/pi-sdk-canary.yml`) checks the
unchanged sources against the newest published Pi SDK. It is an early warning
for upstream drift, not part of accepting a given source; see
[Releasing](releasing.md#update-the-pi-sdk).

## Level 2: setup acceptance

Setup acceptance runs the complete registration lifecycle with real clients
against isolated client state. It starts no session and needs no provider.

### Isolation

- Use a disposable home directory for each client and a separate scratch project
  directory. Run every client and `setup` command with `HOME` pointing at the
  disposable home, and for Codex also `CODEX_HOME` inside it.
- Place a disposable Codex home outside `/tmp`. Codex CLI `0.159.2` refuses to
  create helper binaries below a temporary directory and adds a warning to its
  version output, which the strict version parser rejects as `unsupported`.
- Use a separate mode-`0600` configuration with one workspace alias and one
  default `read-only` execution profile with inert provider and model names. It
  must contain no credential and no real provider configuration.
- Add one harmless, unrelated registration to each disposable client home
  before the first step. It is the sentinel that must survive.
- Record a digest of the real client registrations before the first step.

### Sequence

Run the nine operations in this order for every target under test, each with
`--json`:

| # | Operation | Overall status | Finding: status (code) | Exit |
| ---: | --- | --- | --- | ---: |
| 1 | no operation (default) | `planned` | `absent (absent)` | 0 |
| 2 | `--dry-run` | `planned` | `absent (absent)` | 0 |
| 3 | `--apply` | `ok` | `ok (applied)` | 0 |
| 4 | `--apply` again | `ok` | `unchanged (already_equivalent)` | 0 |
| 5 | `--verify` | `ok` | `ok (mcp_verified)` | 0 |
| 6 | `--rollback` | `ok` | `ok (rolled_back)` | 0 |
| 7 | `--apply` | `ok` | `ok (applied)` | 0 |
| 8 | `--verify` | `ok` | `ok (mcp_verified)` | 0 |
| 9 | `--remove` | `ok` | `ok (removed)` | 0 |

Targets are `codex:user:pi-session-mcp` and the three Claude Code scopes
`claude-code:user:pi-session-mcp`, `claude-code:project:pi-session-mcp` and
`claude-code:local:pi-session-mcp`. Call the built entry point directly from the
scratch project so that the project and local scopes resolve there:

```bash
env -i HOME="$DISPOSABLE_HOME" PATH="$PATH" PI_SESSION_MCP_CONFIG="$ACCEPTANCE_CONFIG" \
  node /path/to/build/dist/setup-main.js --apply --json --target claude-code:project:pi-session-mcp
```

### Pass criteria

- All nine operations report the expected overall status, finding and exit
  status.
- Steps 1 and 2 leave the client state unchanged.
- After step 9 the `pi-session-mcp` registration is absent, the sentinel is still
  present, and the ownership record set is empty. The ownership directory has
  mode `0700` and the ownership file mode `0600`.
- No server, setup or guardian process of the build under test remains.
- The digest of the real client registrations is unchanged.
- No report contains a path, the configuration location, an environment value
  or a secret.

### Working-tree and published-release variants

A working-tree run accepts a change, for example a newly supported client
version. It proves nothing about published bytes.

A published-package run installs the published npm package into a temporary
prefix (`npm install -g --prefix <dir> pi-session-mcp@<version>`) and runs the
lifecycle through the installed `pi-session-mcp-setup`, which also proves the
executables and the entry-point detection through npm's symlinks.

A published-release run uses a fresh clone of the published tag instead of an
existing branch or local tag. It additionally records the tag object and the
peeled commit, confirms `git describe --tags --exact-match`, passes Level 1 on
that checkout with Doctor reporting the release version, and confirms that the
manifests and built runtime files are byte-identical before and after the
client cycles.

### Tooling

`scripts/setup-acceptance.mjs` runs the isolation, the sequence and the pass
criteria above with the real clients. It uses disposable homes below its work
directory (default `~/.cache/pi-session-mcp-acceptance`, never below `/tmp`,
`/var/tmp`, `/dev/shm` or `$TMPDIR`), removes them afterwards (also after Ctrl-C
or SIGTERM, with exit `130` or `143`) and writes a sanitized JSON result without
paths or environment values. It exits with `0` when every check passed, `1` when
a check failed and `2` on a usage, environment or harness error.

`--setup` is split on whitespace, so paths in it must not contain spaces. Its
first token must be an absolute path to an existing file or a command found on
`PATH`; otherwise the script exits with `2`.

The script only reads the real `~/.codex/config.toml` and `~/.claude.json` to
prove that the MCP registrations in them did not change. A file that does not
exist counts as the constant digest `absent`; one that exists but cannot be read
fails the check. A real client session that changes its own MCP registrations
during the run makes the digest check fail (a false fail), so close or idle real
clients first.

Working tree, after `npm run build` and `npm run build:cli`:

```bash
node scripts/setup-acceptance.mjs \
  --setup "node $PWD/dist/setup-main.js" --build-dir "$PWD" \
  --label working-tree --out level2-result.json
```

Published package: install it into a temporary prefix outside `/tmp`, then pass
the installed executable and package directory.

```bash
npm install -g --prefix "$PREFIX" pi-session-mcp@<version>
node scripts/setup-acceptance.mjs \
  --setup "$PREFIX/bin/pi-session-mcp-setup" \
  --build-dir "$PREFIX/lib/node_modules/pi-session-mcp" \
  --label npm-<version> --out level2-result.json
```

Tag clone: build a fresh clone of the tag (`npm ci`, `npm run build`,
`npm run build:cli`) and use it like the working tree, with `--setup` and
`--build-dir` pointing at the clone.

`--clients codex` or `--clients claude-code` limits a run to one client, for
example on a macOS machine without Codex. The script does not cover the macOS
lock-contention and interruption steps, Level 1, or the tag identity checks
(tag object, peeled commit, `git describe`). Run those by hand.

### macOS

macOS uses the same isolation, sequence and pass criteria, with the additions
below. A run for Claude Code is recorded under [Status](#status). macOS is
CI-tested, and it has not passed Level 2 for Codex.

- **Environment.** Record:
  - the macOS version and architecture (`sw_vers`, `uname -m`);
  - the Node.js version;
  - the Codex CLI and Claude Code versions.
- **Disposable home.** It must be on the APFS volume type of `/`. A directory
  below the user's home qualifies.
  - For an ownership directory on another filesystem, `--apply`, `--verify`,
    `--rollback` and `--remove` fail closed with `failed (operation_failed)`
    and exit `1`.
  - Keep the Codex home outside both `$TMPDIR` (normally below `/var/folders`)
    and `/tmp`, for the reason given under [Isolation](#isolation).
- **Before the sequence:** run `npm run --silent doctor`.
- **Lock contention.** After step 9, start two `--apply` runs for
  `claude-code:user:pi-session-mcp` at the same time.
  - One run reports `ok (applied)`. The other waits for the lock, then
    reports `unchanged (already_equivalent)`.
  - Both exit with `0`.
  - A following `--remove` reports `ok (removed)`.
  - A waiting run that reports `failed (operation_failed)` with exit `1` did
    not get the lock within the 30 s acquisition bound. That counts as a
    failure of the run.
- **Interruption.** Start `--apply` for one target and press Ctrl-C while it
  runs.
  - The run exits with `130` and reports `operation_interrupted`.
  - Afterwards `ps -ww -A -o pid=,command=` lists no `claude mcp` or `codex mcp`
    command and no `setup-main.js` or `setup-command-guardian.js` process of
    the build under test.
  - A following `--apply` reports one of three outcomes, depending on where
    the interrupt landed:
    - it reconciles the pending record (`ok (pending_recovered)`);
    - it applies again (`ok (applied)`);
    - it finds the registration already owned
      (`unchanged (already_equivalent)`).
  - A following `--remove` reports `ok (removed)`.
  - If the operation completes before the interrupt arrives, record that and
    repeat. An interrupt that never lands is not a pass.
- **Processes.** Check that no process remains with `ps -ww` instead of `/proc`;
  without `-ww`, `ps` truncates long commands when it has no terminal.

The evidence record names the build (commit or tag), the environment above,
every command with its exit status, and the sanitized JSON results. It
contains no paths, environment values or secrets.

## Level 3: live two-client acceptance

Live acceptance delegates real work from Codex and from Claude Code to Pi
sessions and verifies the outcome independently of the clients' own reports.

The harness for this level is not part of this repository: prompts, oracles,
snapshot and digest tools and the scan for leaked values are prepared per cycle.

### Preconditions

- Server: a separate detached checkout of the release under test, built with
  `npm ci`, `npm run build` and `npm run build:cli`. Record the commit, the tag
  object if there is one, and the SHA-256 of `dist/main.js`.
- Configuration: temporary, credential-free, with synthetic workspace aliases
  and one `read-only` and one `coding` execution profile. Offline Doctor must
  pass for it.
- Model endpoint: run one bounded preflight before the first task. If the
  endpoint is shared, record the loaded model before and after the cycle and
  never force-load a model that another session is using. If the preflight
  fails, stop and record the cycle as blocked; do not start a turn.
- Clients: record the exact client versions and how each client reached the
  server. Prefer a temporary per-invocation MCP configuration, so that no
  global registration changes.
- Waiting: let each client wait a bounded time between `pi_turn_get` polls,
  for example by allowing a shell `sleep` of a few seconds. A client that may
  call only the Pi Session MCP tools has no way to wait and polls back to back.
- Pre-registration: fix the plan, the acceptance criteria per task, the prompts,
  the oracles, the tools, the configurations and the fixture digests before the
  first task.

### Task matrix

Each client runs the same five tasks on disposable synthetic fixtures:

| Task | What it shows |
| --- | --- |
| Capability-led read-only analysis | Discovery through `pi_capabilities_get`, explicit workspace and profile selection, prompt, result |
| Same-session read-only follow-up | A useful second turn in the same session; the first turn's terminal view stays unchanged |
| Bounded coding change | A `coding` profile changes only the allowed files |
| Same-session coding follow-up | A second coding turn in the same session |
| Abort and recovery | Running, abort, `aborted`, close, empty session list, then a fresh session that starts `idle` |

Run strictly sequentially: one client invocation at a time, three invocations
per client (read-only with follow-up, coding with follow-up, abort). Do not
repeat a task.

### Independent verification

- Read-only invariance: a path, mode and content digest of each analysis
  fixture is identical before and after every invocation that used it.
- Coding barrier: after each coding turn, take a snapshot before the next
  prompt is sent. Run oracles and fixture tests on the snapshot, not on the live
  workspace. Git status must show only the allowed files as modified.
- Public results: scan every Pi Session MCP tool result in the client transcripts
  for local paths, the endpoint address, key and token markers, stack frames,
  network error strings and configuration file names. Expect zero hits.
- Cleanup: no Pi Session MCP server of this run exists before each invocation or
  shortly after each client exit, and no outer client process remains.
- Liveness: a running turn whose `updatedAt` advanced beyond `startedAt` shows
  observable activity. Its absence only means that the turn finished between
  two polls.
- Polling cost: count the `pi_turn_get` calls per turn. The counts are evidence
  for the revisit trigger on bounded waiting in
  [ADR 0003](adr/0003-post-mvp-maintenance.md) only when the client could wait
  between polls.

### Gate

The cycle is accepted when all of the following hold:

- At least 8 of the 10 tasks reach their intended outcome without a Pi Session MCP
  defect.
- Both clients complete discovery, start, prompt, result and close.
- Both clients complete a useful sequential second turn.
- Both clients complete a bounded, independently verified coding workflow.
- No change exists outside the approved diff.
- No credential, path, raw provider error, prompt or transcript appears in
  public metadata.
- No public session and no server process remains after a verified close.
- Lifecycle errors are stable and sanitized.
- Level 1 is green for the release source.

The ten fixture tasks are deliberately small. They qualify the control path, not
model capability on larger work. Not covered are interactive approval dialogs,
external MCP grants, and client restart or resume.

A narrower live check can cover a single path. It must state its scope and does
not count as a ten-task cycle.

## Pi extension live check

Manual, on a machine with Pi, `pi-cursor-sdk@0.5.3` and a stored Cursor key. Run it from a working tree (`npm run build`, then `node dist/main.js`) with a temporary configuration, passed through `PI_SESSION_MCP_CONFIG`, whose profile names `"extensions": ["npm:pi-cursor-sdk@0.5.3"]` and a Cursor model from Pi's catalog.

1. `pi_session_start`, a prompt answered with "PONG", `pi_turn_get` completed, `pi_session_close`.
2. Two parallel sessions of that profile, each completing a prompt.
3. After close, no Cursor child process of the server remains.
4. stderr shows no `foreign_stdout_suppressed` storm and no stdout frame fails to parse.
5. Record how the Cursor local runtime starts its child processes (inherited or piped stdio).

Record date, source commit, versions and outcome under Status. No secret, path or prompt content goes into the record.

## Evidence rules

- Record only sanitized evidence: statuses, booleans, counts, durations,
  versions, release and build identifiers, digests, and method and tool names.
- Never publish prompts, assistant responses, transcripts, public session or
  turn identifiers, credentials, authentication locations, absolute local paths,
  the endpoint address, raw provider errors or raw client output.
- Bind every record to the exact source commit, the commands, the exit codes and
  the observed counts. A result for one commit is not evidence for another.
- Keep failed, blocked and partial runs on record. A new attempt gets a new
  record; never overwrite an earlier one or merge two attempts into one result.
- Name what a run does not cover.

## Status

Release notes state which levels were run for a release and what was not
covered. Pi Session MCP has passed all three levels in earlier private cycles. The
live two-client acceptance has not yet been repeated on a build with Pi SDK
`1.x`.

`v0.6.2` passed Level 1 on a fresh clone of its tag. It passed Level 2 in all
three variants: working tree, published release, and published npm package.
The clients were Codex CLI `0.162.0` (`user`) and Claude Code `2.1.295`
(`user`, `project`, `local`), on 2026-10-09 and 2026-10-10. It had no Level 3
cycle.

Before its release, `v0.6.3` passed Level 1 and the working-tree Level 2 on its
release candidate, with Claude Code `2.1.296`. On 2026-10-10 the same candidate
also passed a narrower live check:
- Scope: Claude Code `2.1.296` as the only client, with Pi SDK `1.1.0` on a
  local `qwen3.6-35b-a3b-splash` model served by LM Studio.
- All five tasks of the matrix reached their intended outcome in three
  sequential invocations, and every pre-registered check passed.
- It covered no Codex task and does not count as a ten-task cycle.

After its release, `v0.6.3` passed Level 1 on a fresh clone of its tag. It also
passed Level 2 as published release and as published npm package, with Codex
CLI `0.162.0` and Claude Code `2.1.296`, on 2026-10-10.

On 2026-10-10, `main` at `4d333da`, which is `v0.6.3` plus the Doctor fix and
documentation, passed a narrower live check with Codex:
- Scope: Codex CLI `0.162.0` as the only client, run headless with
  `codex exec` and the three tool approvals that
  [client setup](client-setup.md#run-codex-without-prompts) describes. Pi SDK
  `1.1.0` ran on the same local model.
- All five tasks of the matrix reached their intended outcome in three
  sequential invocations, and every pre-registered check passed.
- The client could wait between polls and needed 1 to 3 `pi_turn_get` calls per
  turn.
- It covered no Claude Code task and does not count as a ten-task cycle. The
  Claude Code check above ran on another commit.

Before its release, `v0.6.4` passed Level 1 and the working-tree Level 2 on its
release candidate, with Codex CLI `0.162.0` and Claude Code `2.1.296`. Its
server entry point `dist/main.js` is byte-identical to that of `4d333da` and of
`v0.6.3`.

After its release, `v0.6.4` passed Level 1 on a fresh clone of its tag. It also
passed Level 2 as published release and as published npm package, with Codex
CLI `0.162.0` and Claude Code `2.1.296`, on 2026-10-10. The installed
`pi-session-mcp-doctor` reported a healthy package when run from an unrelated
working directory.

macOS: `setup` supports macOS from the change that tracks #32. That change is
tested in CI on macOS 15 and macOS 26 (Apple silicon) next to Linux.

On 2026-10-11, the build of `d89740c`, the head of the pull request branch,
passed the working-tree Level 2 on a real Mac with Claude Code as the only
client:
- Environment: macOS 26.7.1 (`25G241`) on `arm64`, Node.js `22.23.3` and Claude
  Code `2.1.294`. The disposable home was on the APFS data volume that the
  root volume belongs to.
- Level 1 on that checkout: `npm ci`, `npm run typecheck`, `npm run build`,
  `npm run build:cli` and `npm test` exited with `0`. The test run reported 531
  passed and 23 skipped. The skipped tests are the 21 Linux `/proc` fixture
  tests, the Linux-only lock-inode replacement test and the probe-only
  controller output test. `npm audit` reported 0 vulnerabilities, and
  `git diff --check` reported nothing. `git status --short` printed nothing
  before the evidence was written.
- Doctor with the acceptance configuration reported no error.
- All three Claude Code targets (`user`, `project` and `local`) completed the
  nine-step sequence. Every step reported the expected overall status, finding
  and exit status.
- After the sequences the `pi-session-mcp` registration was absent, the sentinel
  was still present and the ownership record set was empty. The ownership
  directory had mode `0700` and the ownership file mode `0600`. No server,
  setup or guardian process of the build remained, and the digest of the real
  Claude Code registrations was unchanged. No report contained a path, an
  environment value or a secret.
- Lock contention: two simultaneous `--apply` runs for
  `claude-code:user:pi-session-mcp` finished within 5 s. One reported
  `ok (applied)` and the other `unchanged (already_equivalent)`. Both exited
  with `0`, and the following `--remove` reported `ok (removed)`.
- Interruption: SIGINT was sent to the process group of a running `--apply`
  after 0.2 s, 0.5 s and 0.9 s. Each run exited with `130` and reported
  `operation_interrupted`. None left a `claude mcp` command or a setup or
  guardian process behind. In each case the following `--apply` reported
  `ok (applied)` and the following `--remove` reported `ok (removed)`.

This run does not cover:
- Codex, which was not installed on the machine, so macOS has not passed
  setup acceptance for Codex.
- A Ctrl-C keypress in an interactive terminal. A script sent the signal from a
  shell without a terminal.
- The `pending_recovered` and `already_equivalent` outcomes after an interrupt.
  The following `--apply` reported `applied` in every case.
- Intel Macs, the published-release and published-package variants, and
  Level 3.

On 2026-10-11 the same build also passed a narrower live check on that Mac:
- Scope: Claude Code `2.1.294` as the only client, with Pi SDK `1.1.0` on a
  local `qwen3.6-35b-a3b-splash` model served by LM Studio. The server was the
  build of `d89740c`: the sources are identical to it, and `dist/main.js` has
  the SHA-256 `a69bfec2f9f161b74a6d7b067fda9b76d94c294170bc59a771a79e3f29a7123c`.
- Method: three sequential headless invocations, one per task group, with a
  temporary per-invocation MCP configuration (`--strict-mcp-config`), a
  credential-free configuration with one `read-only` and one `coding` profile,
  and a disposable Pi agent directory. The client could run `sleep` between
  polls. The plan, prompts, oracles and fixture digests were fixed before the
  first invocation, and no task was repeated.
- Preflight: one bounded request to the model returned HTTP `200` in about 1 s.
  The loaded model was the same and idle before and after every invocation, and
  nothing was loaded or unloaded.
- Read-only analysis with a same-session follow-up: both turns ended
  `completed`. The first answer contained the expected marker, and the second
  answer was exactly the expected number. The fixture digest (path, mode and
  content) was identical before and after.
- Bounded coding change with a same-session follow-up: both turns ended
  `completed`. The oracle passed on a snapshot taken between the turns and on
  the final workspace, and that snapshot did not yet contain the second turn's
  change. Only the one allowed file differed, with no added or removed file and
  unchanged modes.
- Abort and recovery: the turn was `running`, then `aborted` after
  `pi_session_abort`. `pi_session_close` succeeded, `pi_session_list` returned
  no session, and a fresh session started `idle` and closed.
- Counts: `pi_turn_get` was called 3, 3 and 2 times in the three invocations,
  and no Pi Session MCP tool returned an error.
- A scan of every Pi Session MCP tool result in the three transcripts found no
  absolute path, configuration file name, endpoint, key or token marker, or stack
  frame. No server or client process remained after any invocation, each
  client's standard error was empty, and the digest of the real Claude Code
  registrations was unchanged.

This check does not cover:
- Codex, or any task from a second client. It is not a ten-task cycle and does
  not satisfy the Level 3 gate.
- The check that the first turn's terminal view stays unchanged after a second
  turn started. The transcripts do not poll the first turn again.
- A git-based check of the allowed diff. The coding fixture is not a Git
  repository, so a path, mode and content digest stood in for it.
- A coding turn that tries to change a file outside the allowed set.
- Interactive approval dialogs, external MCP grants, and client restart or
  resume.

On 2026-10-11 the working-tree build of `eeaa597` on the `feat/pi-extensions`
branch (#34) passed the Pi extension live check on Linux:
- Environment: Node.js `26.11.1`, Pi SDK `1.1.0`, and `pi-cursor-sdk@0.5.3`
  installed by Pi with a stored Cursor key. `dist/main.js` has the SHA-256
  `47875d38886528ace6b242df2c6ad79d624c51e330e63c2f401576eadc449ed7`.
- Method: a scripted JSON-RPC client drove `node dist/main.js` over stdio, with
  a temporary configuration passed through `PI_SESSION_MCP_CONFIG`. The
  configuration had a `coding` and a `read-only` profile, each with provider
  `cursor`, model `auto`, thinking level `off` and
  `"extensions": ["npm:pi-cursor-sdk@0.5.3"]`.
- The `coding` profile started, its prompt completed with "PONG", and the
  session closed.
- Two sessions, one of each profile, started in parallel and both prompts
  completed with "PONG".
- After close, no descendant process of the server remained.
- No stdout line failed to parse as an MCP frame. stderr carried two
  `foreign_stdout_suppressed` reports for 21 suppressed writes and no other
  event.
- During turns the Cursor local runtime started `git`, `ssh`, `gh`, `node` and
  the MCP servers configured for Cursor through `npm exec`, in the `read-only`
  profile as well. None of them inherited the server's stdout: each had its own
  pipe, a socket, `/dev/null` or a file as standard output.
- The first run, on the earlier build of `6740484`, failed to start the
  `coding` profile with `execution_selection_mismatch`: `pi-cursor-sdk`
  deactivates its own `cursor_activate_skill` tool when the session starts.
  `eeaa597` lets an extension narrow its active tools while still rejecting
  any tool outside the allowlist.

This check does not cover macOS, Codex or Claude Code as the client, the Cursor
cloud runtime, or a session that uses Cursor's own tools.

Before its release, `v0.7.0` passed Level 1 and the working-tree Level 2 on its
release candidate on Linux, with Node.js `26.11.1`, Codex CLI `0.162.1` and
Claude Code `2.1.296`, on 2026-10-11:
- The first working-tree Level 2, on `2d05e55`, failed. On all four targets
  `--verify` (steps 5 and 8) reported `failed (mcp_failed)` with exit `1`; every
  other step passed. The verifier rejected the `extensions` field that
  `pi_capabilities_get` lists since #34. This is #36.
- After the fix, the working-tree Level 2 on `2c5ab3d` passed all nine steps on
  all four targets, 96 of 96 checks.
  - The real client registrations were unchanged, no process remained, and the
    built files were byte-identical before and after the client cycles.
  - The run placed one sentinel in each Claude Code scope instead of one per
    client, so its check count differs from earlier records.
- Level 1 on `09b32a8`: every command exited with `0`.
  - The test run reported 37 files, 660 passed and 5 skipped.
  - `npm audit` and `npm audit --omit=dev` reported 0 vulnerabilities.
  - Doctor reported `packageVersion` `0.7.0` and no finding.
  - The commits after `2c5ab3d` change only tests and documentation. The built
    `dist/` and `.pi-session-mcp-cli/` are byte-identical to those of `2c5ab3d`,
    and `dist/main.js` has the SHA-256
    `47875d38886528ace6b242df2c6ad79d624c51e330e63c2f401576eadc449ed7`.
- The Codex CLI `0.162.1` contract was recorded. It differs from `0.162.0` only
  in the version line.

The Pi extension live check above ran on `eeaa597`, before the final fixes to
extension tool names and the `read-only` contract test. It has not been
repeated on the release candidate.

After its release, `v0.7.0` passed Level 1 and Level 2 on a fresh clone of its
tag, and Level 2 as published npm package, on 2026-10-11, on Linux with Node.js
`26.11.1`, Codex CLI `0.162.1` and Claude Code `2.1.296`:
- Tag clone: `git describe --tags --exact-match` reported `v0.7.0`. The tag
  object is `a5516ce6e4e159ef1e20ee38aba06672379e9cb7` and the peeled commit
  `6783631d2ae1813707cf798360a0a0f4c58ca66d`.
- Level 1 on the tag clone:
  - every command exited with `0`;
  - the test run reported 37 files, 660 passed and 5 skipped;
  - `npm audit` and `npm audit --omit=dev` reported 0 vulnerabilities;
  - Doctor reported `packageVersion` `0.7.0` and no finding;
  - `dist/main.js` has the SHA-256
    `47875d38886528ace6b242df2c6ad79d624c51e330e63c2f401576eadc449ed7`.
- Level 2 passed 96 of 96 checks on the tag clone, and 96 of 96 with the npm
  package installed into a temporary prefix through
  `pi-session-mcp-setup`. In both runs the real client registrations were
  unchanged, no process remained, and the built files were byte-identical
  before and after the client cycles.
  - These runs, and the release candidate's runs above, used the harness that
    #40 later checked in as `scripts/setup-acceptance.mjs`.
  - The checked-in script, after its review fixes, also passed 96 of 96 on the
    tag clone.
- The npm package has the shasum `c8d73311dbde1bdebd78e58b1f01c7cf3bebf374`.
  The tarball downloaded from the registry had the same SHA-1 and SHA-512
  integrity.
- Installed package:
  - `pi-session-mcp-doctor` reported a healthy package `0.7.0` when run from an
    unrelated working directory;
  - with a configuration that pins `pi-cursor-sdk@0.5.3` on three profiles,
    `setup --apply` and `--verify` for `claude-code:user:pi-session-mcp`
    reported `applied` and `mcp_verified`.

On 2026-10-11 the installed `v0.7.0` package also passed the Pi extension live
check on Linux:
- Method: the same scripted JSON-RPC client as above drove the installed
  server. It used the operator's configuration with three `pi-cursor-sdk@0.5.3`
  profiles: one `read-only` and one `coding` profile with
  `claude-opus-5-5@1m` and `claude-opus-5-5@300k` at thinking level `high`, and
  one `coding` profile with `composer-2.5` at thinking level `off`.
- Each of the three profiles started, completed a prompt with the expected
  one-word answer, and closed. One `coding` and one `read-only` Cursor session started in parallel
  and both completed.
- Profiles without extensions on three other providers (xAI, Mistral and
  DeepSeek) each completed a prompt.
- After close no descendant process of the server remained. No stdout line
  failed to parse as an MCP frame; stderr carried four
  `foreign_stdout_suppressed` reports for 12 suppressed writes and no other
  event.
- The two OpenAI profiles ended `failed` with `turn_failed`. A direct Pi CLI
  call outside the server showed that the account had reached its usage limit,
  so they are not evidence for or against the release.

This check does not cover macOS, an MCP client in the loop, or a session that
uses Cursor's own tools.

Before its release, `v0.7.1` passed Level 1 and the working-tree Level 2 on its
release candidate `82dff20` on Linux, with Node.js `26.11.1`, Codex CLI
`0.162.1` and Claude Code `2.1.296`, on 2026-10-11:
- Level 1: every command exited with `0`.
  - The test run reported 38 files, 684 passed and 5 skipped.
  - `npm audit` and `npm audit --omit=dev` reported 0 vulnerabilities.
  - Doctor reported `packageVersion` `0.7.1` and no finding.
- Level 2 ran through `scripts/setup-acceptance.mjs` on a fresh clone of the
  candidate.
  - All nine steps passed on all four targets, 96 of 96 checks.
  - The real client registrations were unchanged, and no process remained.
  - The built files were byte-identical before and after the client cycles.
- `dist/main.js` is byte-identical to that of `v0.7.0`. The changed modules are
  the extension tool-name rule, the pin format and the prompt source.

The branch build of `8d5b069`, whose sources match this candidate, passed the
Pi extension live check with the operator's configuration on 2026-10-11:
- Three `pi-cursor-sdk@0.5.3` profiles and one xAI profile each completed a
  prompt.
- Two Cursor sessions completed in parallel.
- No process remained, and no foreign line reached the MCP stdout.

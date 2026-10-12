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
  status. From the change that tracks #46 on, every operation also reports the
  controller skill finding (`skill_absent` twice, `skill_installed`,
  `skill_already_equivalent`, `skill_verified`, `skill_removed`,
  `skill_installed`, `skill_verified`, `skill_removed`); the skill file exists
  after steps 3 and 7 and is gone after steps 6 and 9; a foreign skill placed
  in the same skill directory stays unchanged throughout.
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

## Multi-session skill acceptance

A targeted live check for profile skill selection ([skills](skills.md)) and for
several Pi sessions that one real controller drives at the same time. It is not
the ten-task Level 3 cycle and does not replace it.

The maintainer script `scripts/multi-session-acceptance.mjs` prepares the run,
starts the controller and checks the outcome. The controller itself calls the
Pi Session MCP tools; the script never does.

### Preparation

- Candidate: a separate detached checkout of the commit under test, built with
  `npm ci`, `npm run build` and `npm run build:cli`. `prepare` records the
  commit, whether the checkout is clean, the SHA-256 of `dist/main.js` and,
  from the harness of `cc810c9` on, a SHA-256 over every built module in
  `dist/`; `run` refuses a changed build.
- Configuration: `prepare --base-config <operator config> --from-profile
  <alias>` copies only provider, model and thinking level of the one explicitly
  selected profile into a run configuration with two profiles: `accept-read` (default, `read-only`, skill `review`) and
  `accept-code` (`coding`, skills `implementation` and `handshake`). From the
  harness of `3f98104` on, all three are `builtin:` references: the two worker
  skills ship with the candidate, and the `handshake` skill sits in the
  override directory `skills/` next to the run configuration, so the run also
  exercises library resolution. The `handshake` skill is generated per run and
  holds a random token that no controller prompt contains. A profile with
  `mcpServers` is always rejected. A profile with `extensions` is rejected
  unless `--with-extensions` is given; with it, `prepare` also copies exactly
  that profile's extension allowlist (1 to 8 distinct exact
  `npm:<name>@<version>` pins) into both run profiles and installs nothing.
  `--with-extensions` on a profile without extensions is rejected. Nothing else
  is copied: the run has its own workspaces and skills.
- Working directory: `--work-dir` (default `~/.cache/pi-session-mcp-acceptance`)
  must not be inside a temporary directory (the system temporary directory,
  `/tmp`, `/var/tmp` or `/dev/shm`), because Codex refuses helper binaries
  there.
- Fixtures: four small synthetic git repositories per client (`slug`, `stats`,
  `wait`, `range`), each a separate workspace alias (`cc-*` for Claude Code,
  `cx-*` for Codex). Both clients use the same configuration and build.
- Fixture baselines: when it creates a fixture, `prepare` stores its initial
  commit and a manifest of its files (path, type, mode, SHA-256; without
  `.git/`) under the run's private directory, never inside the worker's
  workspace. `run` refuses a fixture that differs from its baseline before the
  launch.
- Bound resources: `prepare` records a digest of the candidate build, the
  installed Claude Code controller skill copy, the candidate skill that the
  Codex controller's link points to, the worker skills (`implementation`,
  `review`), the `handshake` skill, the override directory, the run
  configuration, the Claude MCP configuration, the fixture baselines, the
  harness itself, and the `pi-session-orchestration` copies in the operator's
  home (`~/.claude/skills` and `~/.agents/skills`, recorded as missing when
  absent). `run` rechecks all of them before the launch and again after the
  run. A change before the launch refuses the run; a change after it fails the
  result with `resourcesChanged`.
- Home controller skills: Claude Code prefers a personal skill over a project
  skill of the same name. With `--setting-sources project,local`, as the
  harness starts it, Claude Code `2.1.296` listed only the project copy when a
  different personal copy existed (observed on 2026-10-12 with a marker skill);
  without that flag the personal copy shadowed the project copy. Re-check this
  when the client version changes. Codex's precedence between its home skills
  and the run's repository skill is not established, so a Codex run is refused
  while `~/.agents/skills/pi-session-orchestration` differs from the
  candidate's skill.
- Launch record and failed analysis: `run` records the launch once before the
  controller starts, so an attempt that ends without a result is never repeated
  silently. If the analysis after the controller fails, the result is recorded
  as `analysisFailed` and never passes, and the run's own processes are still
  terminated.
- Controller skill: from the harness of `3f98104` on, `prepare` installs the
  Claude Code controller skill the way an operator does, with the candidate's
  `pi-session-mcp-setup --apply --target claude-code:project:pi-session-mcp` in
  the controller's directory. The setup step runs with a disposable `HOME`, so
  setup state and client files of that step never touch the real home; it must
  report `applied` and `skill_installed` and leave a regular copy identical to
  the shipped skill. Codex installs skills only in the user's home, which the
  run must not change, so the Codex controller gets one run-scoped symbolic link
  in `.agents/skills` of its directory. Earlier runs linked both. No global
  skill directory changes.
- Clients: Claude Code runs as `claude -p` with `--mcp-config`,
  `--strict-mcp-config`, `--setting-sources project,local`,
  `--permission-mode dontAsk` and an `--allowedTools` list of the eight tools
  plus read-only file tools, `sleep`, `node --test` and `git -C`. Codex runs as
  `codex exec --ignore-user-config --sandbox read-only` with the server
  defined through `-c mcp_servers.pi-candidate.*` and the three per-tool
  approvals from [client setup](client-setup.md#run-codex-without-prompts).
  Neither run changes a persistent registration, `HOME` or `CODEX_HOME`, and
  both use the existing authentication.
- Time limit: `run --timeout-min` takes a number above 0 and at most 180
  (default 25). After the limit the harness sends `SIGTERM` to the client's
  process group and waits up to 10 seconds. It then sends `SIGKILL` to that
  group and to the recorded processes of the run whose PID and start time still
  match, never by name. A process that is only found by its working directory
  inside the run is reported, not killed. The run is complete when the client
  exits and a bounded drain of its output has finished. The result classifies
  `timedOut`, `spawnFailed` and `harnessAborted` (`SIGINT` or `SIGTERM` to the
  harness); the CLI exits 1 for each of them. The original result of a client
  and scenario is written once; a second `run` for the same pair is refused.

### Scenarios

Each client runs two invocations, one per scenario:

| Scenario | What the controller does | What is checked |
| --- | --- | --- |
| `parallel` | Capabilities first; two sessions of `accept-code` on `slug` and `stats`; both first turns started before waiting; one follow-up in the `slug` session that adds a test and completes the handshake from the worker's skills; own verification; close both | Candidate version and configuration fingerprint seen through capabilities; `skills` of `accept-code`; first turns overlap by the server's `startedAt` and `completedAt`; follow-up completed; tests pass and only allowed files changed; handshake file holds the token although no prompt contained it |
| `abort` | Two sessions on `wait` (a bounded `sleep 120` command) and `range` (a bounded `sleep 45`, then the change); abort `wait` about 15 seconds after both turns started, while `range` runs; verify and close both | Every abort result is `ok` (an `abort_timeout` stays on record even after a retry); the first successful abort comes before `pi_turn_get` shows the `wait` turn `aborted`, and both before its session is closed; its abort time lies inside the running interval of `range`; `range` completed and verified; at the end of the run no late file exists and no worker `sleep` remains |

### Independent checks

- The script watches `/proc` during the run and records every process of the
  controller tree, every server of this run (entry point and configuration
  path) and every process whose working directory lies inside the run, by PID
  and start time. After the controller exits and the server's 15-second
  shutdown bound has passed, none of them may remain.
- From the controller transcript it extracts only tool names, aliases, states,
  timestamps and counts. It scans every Pi Session MCP result, with
  `assistantText` removed, for local paths, the token and credential markers,
  and counts mentions in `assistantText` separately.
- Scope: after the controller exits, each fixture is compared with its
  baseline in three independent ways: the working tree against the manifest
  (including untracked, ignored, deleted, renamed and mode-changed files), the
  index against the base commit, and `HEAD` against the base commit. A change
  that a worker committed therefore counts. The union of changed paths must lie
  inside the files allowed for that task. A missing or unreadable baseline,
  `.git` or base commit fails the check; it is never read as clean. Git runs
  pinned to the fixture with hooks and `fsmonitor` switched off.
- Business checks: besides the fixture's own `node --test`, the harness runs
  its own cases per fixture (`slug`, `stats`, `range`) against the worker's
  module in a separate `node` process, because a worker could have edited the
  tests it is judged by. For `stats` one case passes a frozen input array, so
  an implementation that sorts its input in place fails. The fixture's tests
  and the business checks must both pass.
- Every changed file must have been last written during a worker turn of its
  task's session, and `HANDSHAKE.txt` during the follow-up turn, by the
  server's turn timestamps. This catches a write outside the worker turns, not
  one during them.
- Acceptance verdict: each result carries `acceptance` with `passed` and a
  list of `failures`, computed mechanically from the checks. `passed` is true
  only when the list is empty. A failure code is listed when any of these
  does not hold:
  - the controller exit code is 0 (`controllerExit`), and neither `timedOut`,
    `spawnFailed` nor `harnessAborted` is set;
  - no bound resource changed after the run (`resourcesChanged`), and for a
    reanalysis no resource or fixture differs from the state recorded at the
    end of the run (`stateChangedSinceRun`);
  - at least one server of the run was observed (`noServerObserved`) and no
    process of the run remains (`residualProcesses`);
  - the controller called `pi_capabilities_get` first (`capabilitiesNotFirst`),
    saw the candidate version and configuration fingerprint
    (`candidateNotConfirmed`) and saw exactly the skills `implementation` and
    `handshake` on `accept-code` (`workerSkills`);
  - the structural leak scan found nothing (`structuralLeaks`), the token
    appears nowhere it must not (`tokenExposed`), and no worker prompt or
    controller action touched a private marker (`privateAccess`);
  - at least two sessions started and all were closed (`sessionsNotClosed`);
  - `parallel`: both first turns completed (`firstTurnsNotCompleted`), they
    overlapped (`noOverlap`) and the follow-up completed
    (`followUpNotCompleted`);
  - `abort`: the `wait` turn ended `aborted` after only successful aborts
    (`abortFailed`), in the required order and before its session closed
    (`abortOrder`), and `range` completed with the abort inside its running
    interval (`neighborNotRunningDuringAbort`);
  - per fixture: only allowed changes (`<task>:changes`), every change written
    during a worker turn (`<task>:attribution`), fixture tests and business
    checks passing (`<task>:tests`), for `slug` the added test and the
    handshake (`slug:followUp`), for `wait` no late file (`wait:lateFile`),
    and an oracle for every task of the scenario (`oracleMissing`).
- Liveness observation: for each turn of a session, `turnLiveness` records the
  number of `pi_turn_get` polls that saw the turn `running` and whether
  `updatedAt` exceeded `startedAt` while it was running. This is an
  observation, not a pass criterion.
- Controller writes are limited by the client restrictions: the Codex
  controller runs in a read-only sandbox, and the Claude Code controller has no
  write or edit tool, although its allowed `git -C` could still change a
  fixture.
- The handshake token must appear neither in a worker prompt nor anywhere in
  the controller transcript, and no worker prompt may name a private path or a
  skill file. The controller's own reads and commands must not name the run's
  private directory or its files; this is a marker check, not a sandbox.
- The harness records its own SHA-256 at `prepare` and refuses to run or
  re-evaluate a run with another version.
- `reanalyze` recomputes the transcript analysis and the checks of a finished
  run and never overwrites the original result: it writes a numbered
  reanalysis file. At the end of each run the harness records the state of
  the fixtures (working tree, `HEAD`, index) and of the bound resources. If a
  fixture or a bound resource differs from that state, the reanalysis fails
  with `stateChangedSinceRun`.
- `evidence` writes one sanitized JSON record and refuses to write a local path
  or the token. It lists the original results and the reanalyses separately and
  includes the extension names and versions and the resource digests.
  Transcripts and the configuration stay in the run's private directory and
  are never published.

A controller that reports success does not count; only the checks above and
the `acceptance` verdict derived from them do.
If a client or its authentication is not available, record that client's part
as blocked.

### Method limits of earlier records

Records made with the harness before it was hardened in #53 have these method
limits, which that change removed:

- The scope check used `git status`, which does not show a change that a worker
  had already committed.
- The business checks ran the fixture tests inside the worker's workspace,
  which a worker could have modified.
- Only the build, the harness and the bytes of the configuration file (through
  its fingerprint) were bound to the run. The installed controller skill, the
  contents of the selected worker skills and the fixture baselines were not.
- After the time limit the harness sent `SIGTERM` and then waited for the
  client to close without a bound. A hang would have shown as a hang, not as a
  pass.

These limits do not show that any recorded result was wrong. The records stay
as recorded; a new run gets a new record.

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

Profile skill selection (#46) passed a multi-session skill acceptance with Claude
Code and Codex on 2026-10-12, on Linux (`x64`) with Node.js `26.11.1`, Claude
Code `2.1.296`, Codex CLI `0.162.1` and Pi SDK `1.1.0`:
- Candidate: detached checkouts of `bcef6ba` (runs 1 to 3), `a086339` (run 4)
  and `b6cf624` (run 5), each clean and built with `npm ci`, `npm run build`
  and `npm run build:cli`. `dist/main.js` has the same SHA-256 in all five
  runs, `47875d38886528ace6b242df2c6ad79d624c51e330e63c2f401576eadc449ed7`:
  the commits after `bcef6ba` change only the orchestration skill text, the
  acceptance harness and documentation.
- Level 1 on `bcef6ba`, from the command output of the maintainer's gate run:
  every command exited with `0`. The test run reported
  40 files, 761 passed and 5 skipped; `npm audit` reported 0 vulnerabilities;
  `npm pack --dry-run` listed the three skills and no harness. The test suite
  passed again on `a086339` with the same counts.
- Configuration: the same bytes in every run, fingerprint
  `sha256:b754f0f5e4702d81d99183817abb379eeed2fb5733f93373852eb827ec16d687`,
  with the profiles `accept-read` and `accept-code` derived from an OpenAI
  `gpt-6-luna` profile with thinking level `low`, and the fixture aliases
  `cc-slug`, `cc-stats`, `cc-wait`, `cc-range`, `cx-slug`, `cx-stats`, `cx-wait`
  and `cx-range`. Offline Doctor reported no finding for it.
- Every invocation confirmed the candidate's version and this fingerprint
  through `pi_capabilities_get` as its first call, and saw the skills
  `implementation` and `handshake` on `accept-code`. Exactly one server of the
  run was observed per invocation, and no process of the controller tree, the
  server or the fixtures remained afterwards. No Pi Session MCP result
  contained a local path, the token or a credential marker, and no
  `assistantText` mentioned one.

Run 5, on `b6cf624` with the harness of that commit (SHA-256
`ca851130bbade9f0b2700a43059b7ac3ce349dad40ad2b647133f950a408c719`), passed
every check of all four invocations:

| Client | Scenario | Result |
| --- | --- | --- |
| Claude Code | `parallel` | First turns overlapped by 25.1 s; follow-up in the same session completed; both fixtures pass their tests with only the allowed files changed, each last written during a worker turn; `HANDSHAKE.txt` holds the token and was written during the follow-up turn, although no worker prompt contained the token and the token never appeared in the controller transcript; no controller action named the private run directory; both sessions closed |
| Claude Code | `abort` | First turns overlapped by 23.7 s; one abort, result `ok`; `aborted` seen through `pi_turn_get` before close; the abort fell inside the running interval of the neighbor, which then completed and passes its tests; the worker's `sleep 120` was observed running, and at the end of the run it was gone and had written no file; both sessions closed |
| Codex | `parallel` | As for Claude Code, with an overlap of 24.8 s |
| Codex | `abort` | As for Claude Code, with an overlap of 22.4 s |

The controllers made 1 to 6 `pi_turn_get` calls per session and waited between
polls with `sleep`. Each invocation took 93 to 156 seconds. The run's
transcripts were also checked afterwards against the criteria the harness
gained after run 5: in both `abort` invocations the first successful abort came
before the first `aborted` observation, and no worker prompt named a private
path or a skill file. Run 5 used the harness of `b6cf624`; the head's harness
adds these two checks and the run-time checksum check, and changes nothing
else.

Earlier attempts on the same build, kept on record:
- Run 1 (Claude Code only, with the harness of `bcef6ba`, which did not record
  its checksum yet): `parallel` passed
  every check. In `abort` the abort itself passed (result `ok`, `aborted` seen
  before close, the worker's `sleep` ended, no late file), but the neighbor
  turn had completed about three seconds before the abort, so the run shows no
  neighbor that keeps running. The neighbor task now starts with a bounded
  `sleep 45` and the abort comes after about 15 seconds.
- Run 2: three invocations passed every check. In Codex `parallel` every
  functional check passed, including the handshake written during the
  follow-up turn with a token that no prompt contained, but the controller
  then read the run's private handshake skill to confirm the token. The
  controller prompt now confines reads and commands to the fixtures.
- Run 3: three invocations passed every check. In Codex `abort` the abort, the
  running neighbor and cleanup passed, but the controller told both workers to
  "follow configured handshake instructions" because capabilities listed a
  `handshake` skill, so both fixtures got an extra `HANDSHAKE.txt`. The
  orchestration skill now says that a listed skill is not a task.
- Run 4 (`a086339`): three invocations passed every check. The Codex
  `parallel` controller read the fixtures-only rule as excluding its own skill
  directory, worked from `./fixtures`, and stopped after
  `pi_capabilities_get` without starting a session. The rule now allows the
  controller's own skill directory.

No run showed a Pi Session MCP defect. The deviations were controller
behavior and harness wording.

This is a targeted check of skill selection and of two concurrent sessions
per client. It is not the ten-task Level 3 cycle. It covers neither the
extension profile path live (the automated SDK contract tests cover it), nor
`read-only` workers, nor more than two concurrent sessions, nor macOS.

After the owner asked on 2026-10-12 that skills install without manual linking
and can be adjusted and extended, the same change gained the skill library,
`builtin:` references, `--customize-skill` and the controller-skill
installation through `setup`. Its final candidate `0ebbaa0` passed on
2026-10-12, on Linux (`x64`) with Node.js `26.11.1`, Claude Code `2.1.296`,
Codex CLI `0.162.1` and Pi SDK `1.1.0`:
- Level 1 on a clean detached checkout: every command exited with `0`. The
  test run reported 43 files, 884 passed and 5 skipped; `npm audit` reported 0
  vulnerabilities; `npm pack --dry-run` listed 125 files with the three skills
  and no acceptance harness. `git diff --check` from `0cb3c60` reported nothing.
- Level 2 through `scripts/setup-acceptance.mjs` with the setup of that
  checkout: 160 of 160 checks passed. All nine steps passed on all four
  targets, including the controller skill finding of every step, the skill file
  after steps 3 and 7 and its absence after steps 6 and 9, and a foreign skill
  that stayed unchanged. The real client registrations were unchanged, no
  process remained, no report leaked a path, and the build was unchanged.
  Earlier candidates `24ab13d` and `37034dd` of the same change had passed
  Level 2 with 160 of 160 as well, before the review fixes that followed them.
- Multi-session skill acceptance, run 7, with the harness of that checkout
  (SHA-256 `42d46f86ae617c229568437e6d96c93f965c27778c3e2fde51e1c449ef35fb12`)
  and the dist tree SHA-256
  `957dfac67bf0c3c179bff6584b3bda49bedad2fe1642790537f6790b31f5ef37`:
  - `prepare` installed the Claude Code controller skill with the candidate's
    `setup --apply` for the controller's project scope: `applied` and
    `skill_installed`, a regular copy identical to the shipped skill.
  - The configuration (fingerprint
    `sha256:b8a341c9ff48ecd7c02f8959b8e4e696f305431945b659ea35d2d98485e948c3`)
    referenced all three skills with `builtin:`: the two shipped worker skills
    and the `handshake` skill from the override directory next to it.
  - All four invocations passed every check: Claude Code `parallel` (first
    turns overlapped by 21.5 s) and `abort` (22.1 s), Codex `parallel` (22.9 s)
    and `abort` (18.9 s). In both `parallel` invocations the worker wrote the
    handshake token, which existed only in the override-directory skill,
    during the follow-up turn. In both `abort` invocations the one abort
    returned `ok`, came before the `aborted` observation and fell inside the
    running neighbor, which completed and passed its tests. No process
    remained, and no result leaked a path, the token or a credential marker.
- Run 6 on `cc810c9`, before the last review fixes, had passed every check of
  all four invocations with the same configuration fingerprint and the
  setup-installed Claude Code skill.

These runs do not cover macOS, Codex skill discovery from the user's home
(setup installs it there, and Level 2 checks the file, but no live Codex
controller read it from there), the extension profile path live, or more than
two concurrent sessions.

The multi-session runs above were made with the earlier harness. Its
[method limits](#method-limits-of-earlier-records) apply to them. They do not
show that any of these results was wrong.

Before its release, `v0.8.0` passed Level 1 and the working-tree Level 2 on
its release candidate `6d197a0` on Linux (`x64`), with Node.js `26.11.1`, Codex
CLI `0.162.1` and Claude Code `2.1.296`, on 2026-10-12:
- Level 1: every command exited with `0`.
  - The test run reported 43 files, 884 passed and 5 skipped.
  - `npm audit` and `npm audit --omit=dev` reported 0 vulnerabilities.
  - `npm pack --dry-run` listed 125 files, including the three skills.
  - Doctor reported `packageVersion` `0.8.0`. With the example
    configuration its only finding was the missing placeholder workspace.
- Level 2 ran through `scripts/setup-acceptance.mjs` on the candidate's
  working tree: 160 of 160 checks passed. All nine steps passed on all four
  targets, including the controller skill finding of every step. The real
  client registrations were unchanged, no process remained, and the built
  files were unchanged.
- Apart from the version, the candidate's sources equal the merge of #48,
  whose final candidate `0ebbaa0` passed the multi-session skill acceptance
  recorded above.

After its release, `v0.8.0` passed Level 1 on a fresh clone of its tag and
Level 2 in three variants. The release was published on 2026-10-12. The release
notes do not date the individual checks, and they name no operating system for
the local runs.
- Source and tag: the release source and the annotated tag target is
  `de46896a6cc3aebc61234917c6d8c472003da36b`, the merge of #49 (head
  `805162ed3c3bcd73113dccabf62656414e3dd9be`). The annotated tag object is
  `a198292fab7f4ef9bdbd18a0ba40324e45e71e21`. The feature pull request #48
  (head `a2dc018a22ffa8dd8ff6af5d358f4f57cf7db845`) was merged as
  `f9e4b6711e9ca0419b2325bec8d6c350ebead5f5`.
- CI: #48 and #49 passed on Linux, macOS 15 and macOS 26. The
  [merged-main run](https://github.com/plagor44-ux/pi-session-mcp/actions/runs/38226706157)
  and the
  [tag run](https://github.com/plagor44-ux/pi-session-mcp/actions/runs/38226900880)
  are on record.
- Level 1 on a fresh clone of the tag, with Node.js `26.11.1` and npm
  `12.2.0`: every command exited with `0`.
  - Typecheck, server build and CLI build.
  - The test run reported 43 files, 884 passed and 5 skipped (macOS-only).
  - `npm audit` and `npm audit --omit=dev` reported 0 vulnerabilities.
  - Offline Doctor reported `packageVersion` `0.8.0`. With the example
    configuration its only finding was the placeholder workspace.
- npm package `pi-session-mcp@0.8.0`, published from a fresh clone of the tag
  through staged publishing and approved by the maintainer: 125 files, 189.3 kB
  and the shasum `37f76ab9c3807213b7e6178156992c76f0ff8378`. The tarball
  downloaded from the registry had the same SHA-1 and SHA-512 integrity.
- Level 2 ran through `scripts/setup-acceptance.mjs` in three variants: the
  working tree of the release candidate, a fresh clone of the tag, and the npm
  package installed into a temporary prefix. Each passed 160 of 160 checks.
  - The clients were Codex CLI `0.162.1` (`user`) and Claude Code `2.1.296`
    (`user`, `project`, `local`), in disposable homes.
  - Every step also checked the controller skill: installed after apply,
    verified, removed after rollback and remove, with a foreign skill in the
    same directory untouched.
  - The real client registrations were unchanged, no process remained, and the
    build stayed byte-identical.
- Multi-session skill acceptance: it ran on the branch candidate `0ebbaa0`
  (recorded above), not on the tag. According to the release notes, its
  sources equal the release apart from the version and the documentation.
  Claude Code `2.1.296` and Codex CLI `0.162.1` were the controllers, with Pi
  SDK `1.1.0` workers. Both the `parallel` scenario (overlapping turns, a
  same-session follow-up and a skill-only token written by the worker) and the
  targeted `abort` scenario with a neighbor that kept running passed every
  check for both clients. The Claude Code controller skill was installed with
  `setup --apply`, and all catalog skills were `builtin:` references.

This record does not cover:
- A full ten-task Level 3 cycle. The multi-session check is targeted.
- A Codex controller that reads the skill from `~/.agents/skills` live (setup
  installs it there and Level 2 checks the file), the extension profile path
  live with skills (the SDK contract tests cover it), more than two concurrent
  sessions, and macOS beyond CI.
- The contents of skill files: they are not snapshotted, so skill files must
  not change while sessions use them. The model sees skill paths in its system
  prompt and may repeat them in its answers.
- Isolation: skill selection limits the regular skill catalog only. An
  allowlisted extension stays trusted code, and a `coding` profile is no
  operating-system sandbox.
- Package provenance: the npm package has no provenance attestation, because it
  was published from the maintainer's machine.

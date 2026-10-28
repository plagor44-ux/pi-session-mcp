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

Targeted live checks are not a level. The [Pi extension live
check](#pi-extension-live-check) and the [multi-session skill
acceptance](#multi-session-skill-acceptance) use a real provider and model on one
path with one or two sessions: the first drives the server with a scripted
client, the second with one real controller. They are not a Level 3 cycle,
do not count towards its [gate](#gate) and do not replace it. A record of one
of them never says that Level 3 passed. What a package version, the MCP tool
contract and a setup report `schemaVersion` identify is defined in [tool
contracts](tool-contracts.md#versions).

## Level 1: repository checks

Run on a clean checkout of the exact source under test:

```bash
npm ci
npm run typecheck
npm run build:cli
NODE_OPTIONS=--unhandled-rejections=strict npm test
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

A packed-tarball run installs the tarball of the release candidate, before it is
published, into a fresh temporary prefix (`npm pack`, then
`npm install -g --prefix <dir> ./pi-session-mcp-<version>.tgz`, with `<dir>`
created by `mktemp -d` and removed afterwards) and runs the lifecycle through
the installed `pi-session-mcp-setup`. It is the only acceptance-level
pre-release check that resolves dependencies like a consumer install does,
without our lockfile, before publication. The working-tree run and the CI build
cannot prove that, because they install from the lockfile; the CI install smoke
also resolves fresh, but it is an early warning, not acceptance. The packed
tarball run is the pre-release counterpart of the published-package run.

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

Packed tarball: pack the built candidate and install the tarball into a fresh
temporary prefix outside `/tmp`, then pass the installed executable and package
directory as for the published package. Create the prefix with `mktemp -d`,
never reuse a fixed one, and remove it and the tarball afterwards.

```bash
npm pack
PREFIX="$(mktemp -d "$HOME/.cache/pi-session-mcp-pack.XXXXXX")"
npm install -g --prefix "$PREFIX" ./pi-session-mcp-<x.y.z>.tgz
node scripts/setup-acceptance.mjs \
  --setup "$PREFIX/bin/pi-session-mcp-setup" \
  --build-dir "$PREFIX/lib/node_modules/pi-session-mcp" \
  --label packed-<x.y.z> --out level2-result.json
rm -rf "$PREFIX" ./pi-session-mcp-<x.y.z>.tgz
```

Turn-event delivery: `--events spool` runs the same lifecycle with
`"events": { "delivery": "spool" }` in the acceptance configuration
([ADR 0011](adr/0011-turn-events-and-controller-wake.md)).
- Claude Code commands get a disposable `XDG_RUNTIME_DIR` below the run
  directory. Codex commands get none, as Codex passes none to its MCP servers.
- Every Claude Code step also checks the `hook:pi-session-mcp-wake` finding
  (`hook_add_planned`, `hook_added`, `hook_already_equivalent`,
  `hook_verified`, `hook_removed`) and the number of wake entries in the
  scope's settings file.
- A foreign `PostToolUse` entry is written before the run and must survive it.
- After each `--verify`, no spool instance directory may remain.

A run passes 228 checks instead of 160. It caught #113 in `0.11.0`:
`--verify` failed with `mcp_unsupported` on every target.

The CI job and a nightly workflow (`.github/workflows/install-smoke.yml`) run
`scripts/install-smoke.mjs` against a lockfile-free install: CI against the
packed tarball of the commit, the nightly job against the published
`pi-session-mcp@latest`. The smoke starts the installed server, checks the
handshake, its name and version and the eight tools, and requires it to exit by
itself with status 0 after stdin EOF. It starts no session and uses no provider.
It reports one JSON line whose code is `smoke_passed` or one of
`package_invalid`, `server_exited`, `initialize_invalid`, `tools_invalid`,
`stdout_invalid`, `shutdown_timeout`, `shutdown_failed` or `timeout`. On any
failure it kills the server's whole process group. Both are early warnings for
a broken fresh install, not acceptance and not a replacement for the
packed-tarball run.

Tag clone: build a fresh clone of the tag (`npm ci`, `npm run build`,
`npm run build:cli`) and use it like the working tree, with `--setup` and
`--build-dir` pointing at the clone.

`--clients codex` or `--clients claude-code` limits a run to one client, for
example on a macOS machine without Codex. The script does not cover the macOS
lock-contention and interruption steps, Level 1, or the tag identity checks
(tag object, peeled commit, `git describe`). Run those by hand.

### macOS

macOS uses the same isolation, sequence and pass criteria, with the additions
below. Runs for Claude Code are recorded under [Status](#status), in
[2026-10-16](#macos-acceptance-on-real-hardware-2026-10-16) and in
[2026-10-26](#macos-acceptance-on-real-hardware-2026-10-26). macOS is
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

This applies to the two-session records below: the extension live check
started two sessions and the multi-session acceptance drives two concurrent
sessions from one controller. Both are targeted evidence, not a Level 3 cycle,
and no number of such runs adds up to the gate.

## Pi extension live check

Manual, on a machine with Pi, `pi-cursor-sdk@0.5.3` and a stored Cursor key. Run it from a working tree (`npm run build`, then `node dist/main.js`) with a temporary configuration, passed through `PI_SESSION_MCP_CONFIG`, whose profile names `"extensions": ["npm:pi-cursor-sdk@0.5.3"]` and a Cursor model from Pi's catalog.

1. `pi_session_start`, a prompt answered with "PONG", `pi_turn_get` completed, `pi_session_close`.
2. Two parallel sessions of that profile, each completing a prompt.
3. After close, no Cursor child process of the server remains.
4. stderr shows no `foreign_stdout_suppressed` storm and no stdout frame fails to parse.
5. Record how the Cursor local runtime starts its child processes (inherited or piped stdio).

Record date, source commit, versions and outcome under Status. No secret, path or prompt content goes into the record.

This check is targeted. Its two parallel sessions show that the extension path
works for the recorded build, provider and model. They are not a Level 3 cycle.

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
  selected profile into a run configuration with the profiles `accept-read` (default, `read-only`, skill `review`) and
  `accept-code` (`coding`). From the Sprint 2 harness (#68) on, `accept-code`
  selects exactly `implementation` and is used for every task except `slug`,
  and a second coding profile `accept-code-handshake` selects `implementation`
  and `handshake` and is used only for the `slug` session; before, `accept-code`
  carried both skills for every task. From the
  harness of `3f98104` on, all three are `builtin:` references: the two worker
  skills ship with the candidate, and the `handshake` skill sits in the
  override directory `skills/` next to the run configuration, so the run also
  exercises library resolution. The `handshake` skill is generated per run and
  holds a random token that no controller prompt contains. A profile with
  `mcpServers` is always rejected. A profile with `extensions` is rejected
  unless `--with-extensions` is given; with it, `prepare` also copies exactly
  that profile's extension allowlist (1 to 8 distinct exact
  `npm:<name>@<version>` pins) into every run profile and installs nothing.
  `--with-extensions` on a profile without extensions is rejected. Nothing else
  is copied: the run has its own workspaces and skills.
- Working directory: `--work-dir` (default `~/.cache/pi-session-mcp-acceptance`)
  must not be inside a temporary directory (the system temporary directory,
  `/tmp`, `/var/tmp` or `/dev/shm`), because Codex refuses helper binaries
  there.
- Fixtures: five small synthetic git repositories per client (`slug`, `stats`,
  `wait`, `range` and, from the Sprint 3 harness (#71) on, `review`), each a
  separate workspace alias (`cc-*` for Claude Code, `cx-*` for Codex). `review`
  holds a finished, frozen implementation that only the read-only reviewer of
  `trio` uses. Both clients use the same configuration and build.
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
  result with `resourcesChanged`. From the Sprint 2 harness (#66, #67) on it
  also binds, under path-free names: per allowlisted extension the tree of its
  real package root (`extension:<name>`) and the whole npm installation of
  Pi's agent directory, with dependencies, `package.json` and lockfile
  (`extensionNpmInstallation`, `none` without extensions); and every Codex
  skill source besides the run's own link: `$CODEX_HOME/skills` with the
  bundled `.system` skills (`codexHomeSkills`), all of `~/.agents/skills`
  (`homeAgentsSkills`), `/etc/codex/skills` (`etcCodexSkills`) and the
  `.agents/skills` of every ancestor of the Codex controller's directory
  (`codexAncestorSkills`, up to `/`). These extension, Codex source and
  candidate skill digests (the controller skill and both worker skills) walk a
  tree without following links, record every link's text, and for a link
  whose real path lies outside the bound root also bind what it leads to (the
  file's bytes, or the same digest of the target directory, recursively); a
  link that stays inside the root needs only its text. Each real directory is
  digested once, so link cycles end, and at most 200,000 entries are read. A
  value of `unreadable` or `tooLarge` means that a resource cannot be bound
  completely. For every key, composed ones included, `prepare` then refuses and
  names the key, and `run` refuses before the launch with `resourcesUnbound`.
  `missing`, `none`, `notDirectory`, `unset` and a dangling top-level link are
  determinate values and stay allowed. The other resources keep the plain tree
  digest. `prepare` resolves Pi's
  agent directory (`PI_CODING_AGENT_DIR`, else `~/.pi/agent`) and `CODEX_HOME`
  (else `~/.codex`) once and records both only in the run's private data; they
  never appear in a result or the evidence.
- Home controller skills: Claude Code prefers a personal skill over a project
  skill of the same name. With `--setting-sources project,local`, as the
  harness starts it, Claude Code `2.1.296` listed only the project copy when a
  different personal copy existed (observed on 2026-10-12 with a marker skill);
  without that flag the personal copy shadowed the project copy. Re-check this
  when the client version changes. Codex's precedence between its home skills
  and the run's repository skill is not established, so a Codex run is refused
  while any bound Codex skill source (`$CODEX_HOME/skills`,
  `~/.agents/skills`, `/etc/codex/skills` or an ancestor's `.agents/skills`)
  holds a controller skill whose resolved content differs from the
  candidate's. A controller skill is a directory named
  `pi-session-orchestration` or one whose `SKILL.md` frontmatter declares that
  `name:`. The frontmatter is read as a YAML block mapping whose top-level keys
  are those at the indentation of its first content line; `name` may be a plain
  or quoted scalar, and a ` #` comment outside quotes is ignored. Any other
  form (a flow mapping or sequence, a bare scalar, a dedent or tab
  indentation, a block or multi-line scalar, malformed quoting, a duplicate
  `name`, unclosed frontmatter), and a `SKILL.md` that is not a regular file,
  make the skill indeterminate, so its source counts as differing. Only the
  first 16 KiB of a `SKILL.md` are read, after its type was checked. The
  bounded search includes hidden directories such as `.system` and
  follows links. An equal copy, also behind a link, or none is allowed; a
  source that cannot be searched completely refuses the run. Skills that Codex
  might load by other means, such as other file names or plugin caches, are
  not covered. Before the Sprint 2 harness only
  `~/.agents/skills/pi-session-orchestration` was checked.
- Launch record and failed analysis: `run` records the launch once before the
  controller starts, so an attempt that ends without a result is never repeated
  silently. If the analysis after the controller fails, the result is recorded
  as `analysisFailed` and never passes, and the run's own processes are still
  terminated. A `SIGINT` or `SIGTERM` that the harness handles during the
  analysis records the result at once as `harnessAborted` and `analysisFailed`,
  keeps the supervision's flags (`timedOut`, `spawnFailed`, `unterminated`),
  terminates the run's recorded processes and exits with 1. A harness that ends
  without handling a signal (for example `SIGKILL`, `SIGHUP` or out of memory)
  writes no result; `evidence` lists its launch as one without a result.
- Controller skill: from the harness of `3f98104` on, `prepare` installs the
  Claude Code controller skill the way an operator does, with the candidate's
  `pi-session-mcp-setup --apply --target claude-code:project:pi-session-mcp` in
  the controller's directory. The setup step runs with a disposable `HOME`, so
  setup state and client files of that step never touch the real home; it must
  report `applied` and `skill_installed` and leave a regular copy identical to
  the shipped skill. Codex installs skills only in the user's home, which the
  run must not change, so the Codex controller gets one run-scoped symbolic link
  in `.agents/skills` of its directory. Earlier runs linked both. No global
  skill directory changes. From the Sprint 2 harness (#67) on, the evidence
  records per client the kind of controller skill, `installed` for Claude Code
  and `linked` for Codex, with its tree digest and without paths
  (`controllerSkills`).
- Clients: Claude Code runs as `claude -p` with `--mcp-config`,
  `--strict-mcp-config`, `--setting-sources project,local`,
  `--permission-mode dontAsk` and an `--allowedTools` list of the eight tools
  plus read-only file tools, `sleep`, `node --test` and `git -C`. Codex runs as
  `codex exec --ignore-user-config --sandbox read-only` with the server
  defined through `-c mcp_servers.pi-candidate.*` and the three per-tool
  approvals from [client setup](client-setup.md#run-codex-without-prompts).
  The harness changes neither a persistent registration, `HOME` nor the
  contents of `CODEX_HOME`, and both runs use the existing authentication.
  Codex itself can install its bundled `.system` skills into
  `$CODEX_HOME/skills` on its first start after an upgrade, or create that
  directory in a fresh `CODEX_HOME`. Because those skills are bound, such a
  change invalidates the prepared run for both clients; it fails safe and never
  passes. After a Codex upgrade, start Codex once with the same `CODEX_HOME`
  before `prepare`. From the Sprint 2
  harness (#66, #67) on, the Codex controller runs with exactly the
  `CODEX_HOME` that `prepare` recorded, whatever the launching environment
  holds, and the server of both clients receives the recorded Pi agent
  directory as `PI_CODING_AGENT_DIR`, so the bound extension directory is the
  one the server loads from.
- Time limit: `run --timeout-min` takes a number above 0 and at most 180
  (default 25). After the limit the harness sends `SIGTERM` to the client's
  process group and waits up to 10 seconds. It then sends `SIGKILL` to that
  group and to the recorded processes of the run whose PID and start time still
  match, never by name. A process that is only found by its working directory
  inside the run is reported, not killed. The run is complete when the client
  exits and a bounded drain of its output has finished; a client that the
  escalation cannot reap still ends the wait and is marked `unterminated`. The
  result classifies `timedOut`, `spawnFailed`, `harnessAborted` (`SIGINT` or
  `SIGTERM` to the harness) and `analysisFailed`; the CLI exits 1 for each of
  them. The original result of a client
  and scenario is written once; a second `run` for the same pair is refused.

### Scenarios

Each client runs one invocation per scenario: `parallel` and `abort`, and from
the Sprint 3 harness (#71) on also `trio`:

| Scenario | What the controller does | What is checked |
| --- | --- | --- |
| `parallel` | Capabilities first; a session of `accept-code-handshake` on `slug` and one of `accept-code` on `stats` (before the Sprint 2 harness: `accept-code` for both); both first turns started before waiting; one follow-up in the `slug` session that adds a test and completes the handshake from the worker's skills; own verification; close both | Candidate version and configuration fingerprint seen through capabilities; `skills` of both coding profiles and the profile of each session; first turns overlap by the server's `startedAt` and `completedAt`; follow-up completed; tests pass and only allowed files changed; handshake file holds the token although no prompt contained it |
| `abort` | Two sessions of `accept-code` on `wait` (a bounded `sleep 120` command) and `range` (a bounded `sleep 45`, then the change); abort `wait` about 15 seconds after both turns started, while `range` runs; verify and close both | Every `pi_session_abort` call of the transcript is `ok` and targets the `wait` session (an `abort_timeout`, an unknown session id or an abort on `range` stays on record and fails, also after a retry); the first successful abort comes before `pi_turn_get` shows the `wait` turn `aborted`, and both before its session is closed; its abort time lies inside the running interval of `range`; `range` completed and verified; at the end of the run no late file exists and no worker `sleep` remains |
| `trio` | Capabilities first; three sessions whose first turns start in the order `review`, `slug`, `wait`, all before waiting for any: `accept-read` on `review` (an enumerated read-only review of the frozen `review` fixture, one finding per exported function with a line reference), `accept-code` on `slug` (a bounded `sleep 45`, then the change, only in `src/slug.js`) and on `wait` (a bounded `sleep 120`); abort `wait` about 5 seconds after its turn was accepted, while `slug` and `review` run; own verification of `slug`; confirm `review` changed nothing; close all three; no handshake | Candidate version and configuration fingerprint seen through capabilities; three sessions, each on its expected alias and profile; `accept-read` offers exactly `review` and only the `review` session used it; all three first turns overlap; every `pi_session_abort` call is `ok` and on `wait`, the first successful abort comes before `wait` is seen `aborted`, both before close; the abort lies inside the running intervals of both `slug` and `review`; `slug` and `review` completed; `slug` tests pass; the `review` fixture is byte-identical in working tree, index and `HEAD`, with no empty directory; `wait` leaves no late file; no worker `sleep` remains |

### Independent checks

- The script watches `/proc` during the run and records every process of the
  controller tree, every server of this run (entry point and configuration
  path) and every process whose working directory lies inside the run, by PID
  and start time. A later sighting of a process never lowers its role or drops
  its fixture: an exiting server, or a zombie its client has not reaped yet,
  has no command line, environment or working directory left to read, and a
  descendant that outlives the client keeps the ownership that makes it the
  run's own to terminate. After the controller exits and the server's
  15-second shutdown bound has passed, none of them may remain.
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
  - the controller exit code is 0 (`controllerExit`), neither `timedOut`,
    `spawnFailed` nor `harnessAborted` is set, and the analysis finished
    (`analysisFailed`);
  - every bound resource was completely readable when recorded and after the
    run (`resourcesUnbound`);
  - no bound resource changed after the run (`resourcesChanged`), and for a
    reanalysis no resource or fixture differs from the state recorded at the
    end of the run (`stateChangedSinceRun`);
  - at least one server of the run was observed (`noServerObserved`) and no
    process of the run remains (`residualProcesses`);
  - the controller called `pi_capabilities_get` first (`capabilitiesNotFirst`),
    saw the candidate version and configuration fingerprint
    (`candidateNotConfirmed`), saw exactly the skill `implementation` on
    `accept-code` and exactly `implementation` and `handshake` on
    `accept-code-handshake`, and only the `slug` session used
    `accept-code-handshake` while every other session used `accept-code`
    (`workerSkills`; before the Sprint 2 harness: exactly `implementation` and
    `handshake` on `accept-code`). In `trio` there is no handshake: `slug` and
    `wait` use `accept-code`, `accept-read` offers exactly `review`, and only the
    `review` session may use `accept-read`; in `parallel` and `abort` no session
    uses `accept-read`;
  - the structural leak scan found nothing (`structuralLeaks`), the token
    appears nowhere it must not (`tokenExposed`), and no worker prompt or
    controller action touched a private marker (`privateAccess`);
  - at least two sessions started and all were closed (`sessionsNotClosed`);
  - `parallel`: both first turns completed (`firstTurnsNotCompleted`), they
    overlapped (`noOverlap`) and the follow-up completed
    (`followUpNotCompleted`);
  - `abort`: the `wait` turn ended `aborted` after only successful aborts
    (`abortFailed`), every abort call on the `wait` session
    (`offTargetAbort`), in the required order and before its session closed
    (`abortOrder`), and `range` completed with the abort inside its running
    interval (`neighborNotRunningDuringAbort`);
  - `trio`: exactly three sessions started (`sessionsNotStarted`), each on its
    expected workspace alias and profile (`sessionAssociation`); the `slug` and
    `review` first turns completed (`firstTurnsNotCompleted`) and all three
    first turns overlapped (`noOverlap`); the `wait` turn ended `aborted` after
    only successful aborts (`abortFailed`) and only on `wait`
    (`offTargetAbort`), in the required order and before
    close (`abortOrder`), with the abort inside the running intervals of both
    `slug` and `review` (`neighborsNotRunningDuringAbort`); the `review` fixture
    is unchanged in working tree, index and `HEAD`, `HEAD` is still its base
    commit, and no empty directory appeared (`review:readOnly`); the `slug`
    task of `trio` may change only `src/slug.js`, while `test/slug.test.js`
    and `HANDSHAKE.txt` stay allowed in `parallel` only. The read-only check
    compares the end state with the baseline, so a write reverted before the
    end, a `git stash`, new refs or branches and directory-mode changes are not
    seen; the read-only profile is the actual guard;
  - per fixture: only allowed changes (`<task>:changes`), every change written
    during a worker turn (`<task>:attribution`), fixture tests and business
    checks passing (`<task>:tests`), for `slug` in `parallel` the added test
    and the handshake (`slug:followUp`), for `review` the read-only invariance
    (`review:readOnly`) instead of tests, for `wait` no late file
    (`wait:lateFile`),
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
  or the token. It lists the original results and the reanalyses separately,
  lists every launch with whether it left a result, and includes the extension
  names and versions, the resource digests, the profiles and, from the Sprint 2
  harness on, the controller skill kinds and digests.
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

Records made with the harness before Sprint 2 (#66, #67, #68) have these
further method limits:

- Pi extensions were bound by name and version only, not by the package
  contents the server loaded, and the run's server did not receive the agent
  directory explicitly.
- For Codex, only `~/.agents/skills/pi-session-orchestration` was checked;
  `$CODEX_HOME/skills`, `/etc/codex/skills`, other home skills and ancestor
  `.agents/skills` were neither bound nor excluded, and the controller
  inherited `CODEX_HOME` from the launching environment.
- The `handshake` skill was offered to every task's worker; this is how the
  v0.8.1 Codex `abort` run's worker could apply it to an unrequested file.

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

Targeted records below, the Pi extension live check and the multi-session
skill acceptance with one or two concurrent sessions, are not Level 3 cycles
even where they used a real controller or a real model. The wording "passed all
three levels" refers to earlier private cycles only; the full ten-task Level 3
cycle has not been repeated on Pi SDK `1.x`. This note adds no result and
changes none.

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

The post-0.8.0 stabilization (#47 and #50 to #54) passed on 2026-10-12, on
Linux (`x64`) with Node.js `26.11.1`, Claude Code `2.1.296`, Codex CLI
`0.162.1`, Pi SDK `1.1.0` and `pi-cursor-sdk@0.5.3`:
- Candidate: a clean detached checkout of `1e904be`, built with `npm ci`,
  `npm run build` and `npm run build:cli`. `dist/main.js` has the SHA-256
  `47875d38886528ace6b242df2c6ad79d624c51e330e63c2f401576eadc449ed7`, and the
  dist tree the SHA-256
  `7b16757f9a1a0318247914f56debe79119a3845e1a1debcf1ad371db3a958fce`. The
  built `dist/` and `.pi-session-mcp-cli/` are byte-identical for every
  candidate below (`0f7c376`, `06471b5`, `cb6e949` and `1e904be`): the commits
  after `0f7c376` change only the acceptance harness, its tests and
  documentation. The commits after `1e904be` change only tests and documentation.
- Level 1 on that checkout: every command exited with `0`. The test run
  reported 50 files, 1035 passed and 6 skipped; `npm audit` and
  `npm audit --omit=dev` reported 0 vulnerabilities; `npm pack --dry-run`
  listed 129 files with the three skills and no acceptance harness;
  `git diff --check` and `git status --short` printed nothing.
- Level 2 through `scripts/setup-acceptance.mjs` with the setup of that
  checkout: 160 of 160 checks passed. All nine steps passed on all four
  targets. The real client registrations were unchanged, no process remained,
  no report leaked a path, and the build was unchanged. `06471b5` and
  `cb6e949` had passed 160 of 160 as well.
- Multi-session skill acceptance, run 4, with the harness of that checkout
  (SHA-256 `e694c9be2779aae164ced0b771db035dac64f136160cc98d2c9e9cf63b629afe`):
  - `prepare --with-extensions` derived the configuration from the operator's
    Cursor profile: provider `cursor`, model `composer-2.5`, thinking level
    `off` and the exact allowlist `npm:pi-cursor-sdk@0.5.3` on both run
    profiles. Nothing else was copied. Fingerprint
    `sha256:05a3fb00f9a1bb57b891d4cfe273aa19e1a716c0d17d2d24097e4225dbea4142`.
  - `prepare` installed the Claude Code controller skill with the candidate's
    `setup --apply`: `applied` and `skill_installed`, a regular copy identical
    to the shipped skill.
  - Every invocation confirmed the candidate and the fingerprint through
    `pi_capabilities_get` as its first call, saw the skills `implementation`
    and `handshake` on `accept-code`, and had exactly one server of the run
    observed. No process remained, no bound resource changed, and no Pi
    Session MCP result contained a local path, the token or a credential
    marker.
  - Both Claude Code invocations, the required part, and Codex `parallel`
    passed every check. Codex `abort` failed one check (`range:changes`); every
    other check of it passed.

| Client | Scenario | Result |
| --- | --- | --- |
| Claude Code | `parallel` | Passed. First turns of two Cursor sessions overlapped by 20.4 s; follow-up in the same session completed; both fixtures pass their tests and the business checks with only the allowed files changed, each last written during a worker turn; `HANDSHAKE.txt` holds the token and was written during the follow-up turn, although no prompt contained the token |
| Claude Code | `abort` | Passed. First turns overlapped by 21.5 s; one abort, result `ok`; `aborted` seen through `pi_turn_get` after the abort and before close; the abort fell inside the running interval of the neighbor, which completed and passes its tests; the worker's `sleep` was observed running, and at the end of the run it was gone and had written no file; both sessions closed |
| Codex | `parallel` | Passed, as for Claude Code, with an overlap of 21.1 s |
| Codex | `abort` | Failed with `range:changes`. The abort, its order, the running neighbor, cleanup and the neighbor's tests and business checks passed (overlap 19.2 s). The `range` worker also wrote `HANDSHAKE.txt`: the controller's prompt said "Change only src/range.js" and did not mention a handshake, so the Cursor worker applied the `handshake` skill of its profile on its own. The scope check caught it, as intended. This is worker behavior, not a Pi Session MCP defect |

The controllers made 5 to 7 `pi_turn_get` calls per invocation, and each
invocation took 90 to 127 seconds.

- Turn liveness (#47): in every Cursor turn that a controller polled while it
  was `running`, `updatedAt` had moved past `startedAt`: 7 of 7 turns in run
  4, 31 of 31 in runs 1 to 4. Turns that no poll saw running are not counted.
  This shows public stream events reaching `updatedAt` before the turn ended.
  It does not show progress, and work without a public event stays
  invisible.
- Controller skill use, checked in the private transcripts of runs 1, 3 and
  4:
  - Each Claude Code invocation invoked its skill once and loaded the copy
    that setup had installed for the candidate. A phrase that only the
    candidate's skill contains appeared, and none from the operator's personal
    copy in `~/.claude/skills`, which is the 0.8.0 skill. So the personal copy
    did not shadow the project copy.
  - Each Codex invocation read the candidate's skill through the run-scoped
    link with one shell command.
  - The handshake token, which only the override-directory skill held, shows
    that the worker skills reached the Cursor sessions.

Earlier attempts on the same build, kept on record:
- Before a reboot, on `0f7c376`:
  - Level 1 passed, with 1028 tests passed and 6 skipped, and the working-tree
    Level 2 passed 160 of 160.
  - Claude Code `parallel` passed every check, with an overlap of 52.2 s.
  - Claude Code `abort` failed with `sessionsNotClosed`, `abortFailed`,
    `abortOrder`, `neighborNotRunningDuringAbort` and `range:tests`: neither
    `pi_session_start` started a session. At that time the operator's Pi agent
    directory was not writable, because `/home` had run out of Btrfs metadata
    space. The run directory was on a memory-backed file system and was lost in
    the reboot, so only the maintainer's summaries remain: there is no evidence
    file, and the exact start error is not on record.
- Run 1 on `0f7c376`, with the harness SHA-256
  `9135f8d9a3d904172475e2fd0d5fce762613a8683a642b53642167572e02ab91`: all four
  invocations passed every check. The overlaps were 29.0 s and 22.2 s for
  Claude Code (`parallel`, `abort`) and 22.8 s and 26.5 s for Codex.
- Run 2 on `06471b5`, with the harness SHA-256
  `d63b03065b28f3714ee2e9f76d722053c835f080b3a6edc96e1aab0031a0eadc`:
  - Codex `parallel` passed.
  - The other three invocations failed only with `noServerObserved`, and every
    other check passed, including the aborts, the running neighbors and the
    absence of residual processes.
  - The cause was in the harness. It replaced a process's earlier sighting on
    every sweep, so a sweep that caught the server while its client was ending
    it (exiting or an unreaped zombie, with nothing left to read) recorded it as
    a plain descendant of the client. `cb6e949` keeps the server role.
- Run 3 on `cb6e949`, with the harness SHA-256
  `9f62535c3cb28506595ba72e5bafad772df71f473b4711799724186a946713b9`: Level 2
  passed 160 of 160, and all four invocations passed every check. The overlaps
  were 22.8 s and 22.2 s for Claude Code and 24.2 s and 18.6 s for Codex. One
  `assistantText` in Codex `parallel` named the absolute path of the worker's
  own `HANDSHAKE.txt`; `assistantText` is the worker's free text, counted
  separately, and not a structural leak. The two harness commits after it keep
  a process's ownership across sightings and match the client by PID and
  start time.

This record does not cover:
- macOS beyond CI, or a ten-task Level 3 cycle.
- A Codex controller that reads the skill from a copy setup installed in
  `~/.agents/skills`, because the run must not change the operator's home.
  Codex read the candidate's skill through a run-scoped link, and Level 2
  checks the installed file.
- A third concurrent session, a `read-only` worker, or more than two
  concurrent sessions.
- A real crash in the middle of a setup skill update, a real contention of
  two customization processes outside the tests, and an operating-system
  signal to the harness during a live analysis. The provider-free tests cover
  these.

After its release, `v0.8.0` was installed for the maintainer on Linux: the npm
package `pi-session-mcp@0.8.0` in the user's npm prefix, registered for Claude
Code. Checked on 2026-10-12:
- Offline Doctor reported `packageVersion` `0.8.0` and no finding.
- `--verify` for `claude-code:user:pi-session-mcp` reported `mcp_verified`, and
  `skill_verified` for the controller skill.
- Codex has no registration of the server on that machine, so `codex:user` was
  not part of this installation.

Before its release, `v0.8.1` passed Level 1 and the working-tree Level 2 on its
release candidate `baa6406` on Linux (`x64`), with Node.js `26.11.1`, Codex CLI
`0.162.1` and Claude Code `2.1.296`, on 2026-10-12:
- Level 1 on a clean detached checkout: every command exited with `0`.
  - The test run reported 50 files, 1035 passed and 6 skipped.
  - `npm audit` and `npm audit --omit=dev` reported 0 vulnerabilities.
  - `npm pack --dry-run` listed 129 files, including the three skills, and no
    acceptance harness.
  - Doctor reported `packageVersion` `0.8.1`. With the example configuration
    its only finding was the placeholder workspace.
- Level 2 through `scripts/setup-acceptance.mjs` on the candidate's working
  tree: 160 of 160 checks passed. All nine steps passed on all four targets,
  including the controller skill finding of every step. The real client
  registrations were unchanged, no process remained, and the built files were
  unchanged.
- Apart from the version and documentation, the candidate's sources equal
  `0c7bad3`. Its built modules have the same dist tree SHA-256
  (`7b16757f9a1a0318247914f56debe79119a3845e1a1debcf1ad371db3a958fce`) as the
  final candidate `1e904be` of the multi-session acceptance recorded above.

### v0.8.1 post-release evidence carried over from the release notes

The post-release results of `v0.8.1` were recorded in the [v0.8.1 release
notes](https://github.com/plagor44-ux/pi-session-mcp/releases/tag/v0.8.1),
published on 2026-10-12 (22:06 UTC), and were carried over into this document
on 2026-10-13 as roadmap item R19. This is a historical record taken from
those notes: the checks were not rerun for it, and every item below keeps the
scope, result and limitation that the notes state. The pre-release results of
the same release candidate are recorded above.

Source and CI, as stated in the notes:
- Release source and annotated tag target: `e462054a37505ef00e1e0c549ebab27e4db7ef55`,
  the merge of #55 (head `440f2e4ccb4f7cebd88825abd8515218f4bbbdee`). The
  annotated tag object is `02f0b30588115058fbb30148cb0934f18cf05aa3`.
- #55 passed CI on Linux, macOS 15 and macOS 26. The merged-main CI run
  `38309519719` and the tag CI run `38309738675` are named in the notes. CI is
  neither Level 2 nor Level 3 acceptance.

Provider-free (Level 1), on a fresh clone of the tag, with Node.js `26.11.1`
and npm `12.2.0`. Every command exited with `0`:
- Typecheck, server build and CLI build.
- 50 test files: 1035 passed and 6 skipped.
- `npm audit` and `npm audit --omit=dev`: 0 vulnerabilities.
- Offline Doctor: package version `0.8.1`. With the example configuration, the
  only finding was its placeholder workspace.

Package publication, a release fact and not an acceptance level: the npm
package `pi-session-mcp@0.8.1` was published from a fresh clone of the tag
through staged publishing, approved by the maintainer. It has 129 files and
215.6 kB, with shasum `b39fe48aff6ade4bf52c427960593951e150191b`. The tarball
downloaded from the registry has the same SHA-1 and SHA-512 integrity. The
package has no provenance attestation, because it was published from the
maintainer's machine.

Real clients without a model (Level 2), with `scripts/setup-acceptance.mjs`:
160 of 160 checks passed in each of three variants:
- the release candidate's working tree (`baa6406`);
- a fresh clone of the tag;
- the npm package installed into a temporary prefix.

The clients were Codex CLI `0.162.1` (`user`) and Claude Code `2.1.296`
(`user`, `project`, `local`), in disposable homes. The real client
registrations were unchanged, no process remained, and the build stayed
byte-identical. The notes do not state the platform of these variants; the
pre-release run of the candidate above states Linux (`x64`).

Real model, targeted multi-session skill acceptance (not a Level 3 cycle), on
the final code candidate `1e904be`, whose built modules equal this release's
(dist tree SHA-256 `7b16757f…`, abbreviated in the notes; the full value is
recorded above). The detailed record is in the multi-session section above.
- Controllers: Claude Code `2.1.296` and Codex CLI `0.162.1`. Workers: Cursor
  (`pi-cursor-sdk@0.5.3`, `composer-2.5`) on Pi SDK `1.1.0`.
- Both required Claude Code scenarios passed every check: two overlapping
  sessions with a same-session follow-up, and a targeted abort while the
  neighbor kept running.
- `updatedAt` had moved past `startedAt` in every Cursor turn polled while
  running: 31 of 31 across four runs.

Limitations and failures stated in the notes:
- No full ten-task Level 3 cycle. The multi-session check is targeted.
- Live acceptance ran on Linux only, with Cursor (`pi-cursor-sdk@0.5.3`,
  `composer-2.5`) workers. macOS is covered by CI.
- Not live-proven: a Codex controller reading the skill from a copy installed
  in `~/.agents/skills`; a third concurrent or `read-only` worker; a real crash
  in the middle of a setup skill update (provider-free tests cover it).
- In the final run, the supplementary Codex `abort` invocation failed its scope
  check: the Cursor worker applied the `handshake` test skill on its own. The
  required Claude Code invocations and Codex `parallel` passed, and Codex
  `abort` had passed on earlier runs of the same build.

### v0.8.2 pre-release acceptance

Before its release, `v0.8.2` passed Level 1 and the working-tree Level 2 on its
release candidate `bdbdf00` on Linux (`x64`), with Node.js `26.11.1`, Codex CLI
`0.162.1` and Claude Code `2.1.296`, on 2026-10-13:
- Level 1 on the release branch: every command exited with `0`.
  - The test run, with `NODE_OPTIONS=--unhandled-rejections=strict`, reported
    54 files, 1409 passed and 6 skipped, and no unhandled error.
  - `npm audit` and `npm audit --omit=dev` reported 0 vulnerabilities.
  - `npm pack --dry-run` listed 135 files, including the three skills, and
    no acceptance harness, sources, tests, lockfile or implementation plan.
  - Doctor reported `packageVersion` `0.8.2`. With the example configuration
    its only finding was the placeholder workspace.
- Level 2 through `scripts/setup-acceptance.mjs` on the candidate's working
  tree: 160 of 160 checks passed. All nine steps passed on all four targets.
  The real client registrations were unchanged, no process remained, and the
  built files were unchanged.
- Apart from the version and documentation, the candidate's sources equal
  `166ffef`, current main; its runtime sources (`src/`, `skills/`) equal
  those of `0aae639`, on which Sprint 3 ran. Its built modules have the same
  `dist/main.js` SHA-256 (`47875d38886528ace6b242df2c6ad79d624c51e330e63c2f401576eadc449ed7`)
  and `dist` tree as the build on which the
  [Sprint 3 live acceptance](#sprint-3-live-acceptance-2026-10-13) ran, including
  the accepted ten-task Level 3 cycle.

### v0.8.2 post-release evidence

The published-release acceptance of `v0.8.2` ran on 2026-10-15 from 15:36 UTC
on Linux (`x64`) with Node.js `26.11.1`, npm `12.2.0`, Codex CLI `0.162.1` and
Claude Code `2.1.299`. It **failed** for the installed npm package; the tag
passed. The failure is recorded as it happened and is tracked as
[#78](https://github.com/plagor44-ux/pi-session-mcp/issues/78).

Tag binding: a fresh clone of the annotated tag `v0.8.2` (tag object
`d068067539a5cf86917e0be08014c9535dce0cc2`) peels to
`bdfb95de9a46defa64d2eb382d58d454f97fc8fb`, the merge of #76, and
`git describe --tags --exact-match` reports `v0.8.2`.

Provider-free (Level 1), on that clone. Every command exited with `0`:
- 54 test files: 1409 passed and 6 skipped, with strict unhandled rejections
  and no unhandled error.
- `npm audit` and `npm audit --omit=dev`: 0 vulnerabilities.
- `git diff --check` and `git status --short` printed nothing.
- Offline Doctor with the example configuration: `packageVersion` `0.8.2`;
  its only finding was the placeholder workspace (`workspace_missing`).

`package.json`, `package-lock.json`, `dist/main.js` and the whole `dist` tree
(84 files) were byte-identical before and after the client cycles.
`dist/main.js` has the SHA-256 of the release build
(`47875d38886528ace6b242df2c6ad79d624c51e330e63c2f401576eadc449ed7`).

Real clients without a model (Level 2), with `scripts/setup-acceptance.mjs`:
- Tag clone: 160 of 160 checks passed; all nine steps passed on all four
  targets. The real client registrations were unchanged, no process
  remained, and the build stayed byte-identical.
- npm package, installed with `npm install -g --prefix` into a temporary
  prefix: the installed version is `0.8.2`, the registry shasum is
  `1ab640909d8c513f3dbaad3c3691f7ce1f267945` and `dist/main.js` has the same
  SHA-256 as above. **151 of 160 checks passed.** `--verify` (steps 5 and 8)
  reported `mcp_unsupported` instead of `mcp_verified` on all four targets;
  every other step passed, no process remained and the package stayed
  byte-identical. `realRegistrationsUnchanged` was `false` (see below).

Cause of the verify failure (#78): the prefix resolved
`@earendil-works/pi-codemode` `1.2.0`, while the lockfile pins `1.1.0`. The
pinned Pi SDK `1.1.0` declares it as `^1.1.0`, and `1.2.0` no longer exports
`MCP_TYPESCRIPT_PREAMBLE`, which the SDK imports. Started directly, the
installed `dist/main.js` exits with `1` and a `SyntaxError` before its first
MCP frame; the tag clone's server answers `initialize`. Verify reports a
server that exits before `initialize` as `mcp_unsupported`. The published
bytes are correct; a fresh install of them is not. Installations made before
`pi-codemode` `1.2.0` was published (2026-10-12, 23:00 UTC) keep `1.1.0` and
start.

`realRegistrationsUnchanged` `false`: the cause was not determined. Another
process wrote the real Codex configuration file during the npm run (15:39:09
UTC). Afterwards no real registration referenced the run's directories, the
real setup ownership records were unchanged since 2026-10-13, and the real
Claude Code registration still targeted the installed `0.8.1`. A live client
that changes its registrations during a run is a known source of a false
failure (see [Tooling](#tooling)); the check is not counted as passed.

A run against the published release on 2026-10-14 was reported with exit `0`,
but neither its variant nor its check counts were saved; it is not evidence.

Result: `v0.8.2` is accepted as a release source (tag clone), not as an
installed npm package. Fresh npm installs of `0.8.2`, and probably of every
version that pins the Pi SDK `1.1.0`, crash at startup.

### v0.8.3 pre-release acceptance

Before its release, `v0.8.3` passed Level 1, the working-tree Level 2 and the
new packed-tarball Level 2 on its release candidate `35091eb` on Linux
(`x64`), with Node.js `26.11.1`, npm `12.2.0`, Codex CLI `0.162.1` and Claude
Code `2.1.299`, on 2026-10-15:
- Level 1 on the release branch: every command exited with `0`.
  - The test run, with `NODE_OPTIONS=--unhandled-rejections=strict`, reported
    55 files, 1425 passed and 6 skipped, and no unhandled error.
  - `npm audit` and `npm audit --omit=dev` reported 0 vulnerabilities.
  - `npm pack --dry-run` listed 136 files, including the three
    skills, and no acceptance harness, sources, tests, lockfile or
    implementation plan.
  - Doctor reported `packageVersion` `0.8.3`. With the example configuration
    its only finding was the placeholder workspace.
- Level 2 through `scripts/setup-acceptance.mjs` on the candidate's working
  tree: 160 of 160 checks passed. All nine steps passed on all four targets.
  The real client registrations were unchanged, no process remained, and the
  built files were unchanged.
- Packed-tarball Level 2 (#78): the candidate's tarball, installed with
  `npm install -g --prefix` into a fresh prefix without the lockfile, resolved
  every `@earendil-works` package to `1.2.0` with a single copy each. The install
  smoke reported `smoke_passed`, and Level 2 against the installed package
  passed 160 of 160 checks, with the same unchanged registrations, process
  and build results.

Targeted live multi-session acceptance on the new Pi SDK `1.2.0`, with
`scripts/multi-session-acceptance.mjs` (harness SHA-256 prefix `bb1620ad`) on a
clean detached checkout of `16b2374`, the candidate before the review fixes:
`dist/main.js` SHA-256 `47875d38…`, build digest `c5e91f70…`. Between `16b2374`
and `35091eb` no runtime source changed; the lockfile gained only the root
entry that pins `@earendil-works/pi-telemetry` at the `1.2.0` it already
resolved. Strictly sequential runs on 2026-10-15 from 18:19 UTC, with
synthetic fixtures and the worker profiles copied from the operator profiles
without their external MCP grant:

| Profile source | Extension | Controller | Scenario | Result | Duration |
| --- | --- | --- | --- | --- | --- |
| DeepSeek `deepseek-flash`, `high` | none | Codex `0.162.1` | `abort` | passed, no failure | 101 s |
| DeepSeek `deepseek-flash`, `high` | none | Claude Code `2.1.299` | `parallel` | passed, no failure | 66 s |
| Cursor `grok-4.7@256k:fast`, `high` | `pi-cursor-sdk` `0.5.3` | Claude Code `2.1.299` | `abort` | passed, no failure | 156 s |
| Cursor `grok-4.7@256k:fast`, `high` | `pi-cursor-sdk` `0.5.3` | Codex `0.162.1` | `parallel` | passed, no failure | 146 s |

Every run kept its scope, closed its sessions and left no residual process.
The Cursor runs load the allowlisted `pi-cursor-sdk` `0.5.3`, which registers
`before_agent_start`, whose semantics changed in SDK `1.2.0`; both passed.

Not established for `0.8.3`: the ten-task Level 3 cycle on SDK `1.2.0`, the
`trio` scenario, the operator profiles' external MCP grant, macOS on real
hardware (R10, R11), and other providers and models. The published-release
acceptance follows after publication.

### v0.8.3 post-release evidence

The published-release acceptance of `v0.8.3` ran on 2026-10-16 from 05:03 UTC
on Linux (`x64`) with Node.js `26.11.1`, npm `12.2.0`, Codex CLI `0.162.1` and
Claude Code `2.1.299`. It passed for the tag and for the installed npm
package.

Tag binding: a fresh clone of the annotated tag `v0.8.3` (tag object
`8a5e7529aec42e1c438df20c8adba6e533454257`) peels to
`53ed581a0c5eb4e35c184e68a7c6a9b840de5985`, the merge of #80, and
`git describe --tags --exact-match` reports `v0.8.3`. CI passed on the merge
commit (run `38795484290`) and on the tag (run `38796022840`) on Linux,
macOS 15 and macOS 26.

Provider-free (Level 1), on that clone. Every command exited with `0`:
- 55 test files: 1425 passed and 6 skipped, with strict unhandled rejections
  and no unhandled error.
- `npm audit` and `npm audit --omit=dev`: 0 vulnerabilities.
- `git diff --check` and `git status --short` printed nothing.
- Offline Doctor with the example configuration: `packageVersion` `0.8.3`;
  its only finding was the placeholder workspace (`workspace_missing`).

`package.json`, `package-lock.json`, `dist/main.js` and the `dist` tree were
byte-identical before and after the client cycles; `dist/main.js` has the
SHA-256 `47875d38886528ace6b242df2c6ad79d624c51e330e63c2f401576eadc449ed7`.

Package publication, a release fact and not an acceptance level: the npm
package `pi-session-mcp@0.8.3` was published by the maintainer from the tag.
It has 136 files, shasum `ae9fa4d6160c7af568f465794d32943be11c5a56` and
integrity
`sha512-5QL32NPOcajbVcWSFYPK/Q97t1yRHA7gFjzJEkgViURGqTMFom8RGSPWC+3izhJY0cZZvwxOh/Cjkg2iAn//8g==`.
The tarball downloaded from the registry has the same digests, and its shasum
equals a `npm publish --dry-run` from a fresh clone of the tag. It has no
provenance attestation.

Real clients without a model (Level 2), with `scripts/setup-acceptance.mjs`:
- Tag clone: 160 of 160 checks passed; all nine steps passed on all four
  targets.
- npm package, installed with `npm install -g --prefix` into a temporary
  prefix without the lockfile: version `0.8.3`, the same `dist/main.js`, and
  every `@earendil-works` package at `1.2.0` with one copy each, although
  `1.3.0` of the SDK family had been published in the meantime. The install
  smoke reported `smoke_passed`, and 160 of 160 checks passed.
- In both runs the real client registrations were unchanged, no process
  remained, and the build stayed byte-identical.

Fresh installs of every earlier version, on 2026-10-16 with npm `12.2.0`:
0.6.1 (Pi SDK `1.0.4`) and 0.6.2 to 0.8.2 (Pi SDK `1.1.0`) resolved the SDK's
internal packages to `1.3.0` and exited at startup with the `SyntaxError` of
#78; only 0.8.3 started.

Installation upgrades on 2026-10-16, following
[Installation](installation.md#npm-installation):
- Linux workstation, npm prefix in the home directory: from `0.8.1` to
  `0.8.3` for `claude-code:user` (the only owned target there). `--verify`
  with `0.8.1` passed, `--remove` reported `removed` and `skill_removed`, the
  new package resolved every `@earendil-works` package to `1.2.0`, the install
  smoke passed, Doctor with the operator configuration reported no finding,
  and `--apply` then `--verify` reported `mcp_verified` and `skill_verified`.
- Linux server (npm `10.9.8`, Node.js `22.23.2`): from `0.8.1` to `0.8.3` for
  `claude-code:user` and `codex:user`, with the same sequence and results.
- Client sessions that were open during an upgrade keep their old server
  process until they end.

### v0.9.0 pre-release acceptance

Before its release, `v0.9.0` passed Level 1, the working-tree Level 2 and the
packed-tarball Level 2 on its release candidate `4a2d514` on Linux (`x64`),
with Node.js `26.11.1`, npm `12.2.1`, Codex CLI `0.162.1` and Claude Code
`2.1.302`, on 2026-10-19:

- Level 1 on the release branch: every command exited with `0`, except Doctor
  as noted below.
  - The test run, with `NODE_OPTIONS=--unhandled-rejections=strict`, reported
    90 files, 1915 passed and 6 skipped, and no unhandled error. The suite
    includes the rootless Podman integration tests for writer provisioning,
    collect and reset, which ran against real Podman.
  - `npm audit` and `npm audit --omit=dev` reported 0 vulnerabilities.
  - `npm pack --dry-run` listed 666 files. These include the three skills,
    `scripts/isolation-acceptance.mjs`, `scripts/isolation-probe.cjs`,
    `dist/writer-launch.js` and `dist/refusal-server.js`. They include no
    sources, tests, lockfile or implementation plan.
  - Doctor reported `packageVersion` `0.9.0`. With the example configuration
    its findings were the placeholder workspace (`workspace_missing`) and the
    new `workspace_mode_unset` warning for that alias.
- Level 2 through `scripts/setup-acceptance.mjs` on the candidate's working
  tree: 160 of 160 checks passed. All nine steps passed on all four targets.
  The real client registrations were unchanged, the built files were
  unchanged, and the path-leak check passed.
- Packed-tarball Level 2: the candidate's tarball, installed with
  `npm install -g --prefix` into a fresh prefix without the lockfile, resolved
  every `@earendil-works` package to `1.2.0` with a single copy each. The
  install smoke reported `smoke_passed` with version `0.9.0`. Level 2 against
  the installed package passed 160 of 160 checks, with the same results for
  registrations, build and path leaks.

Not established for `0.9.0`: a live run of the automated container writers
(the explicit host isolation control run, provisioning with contained
acceptance, a coding session through a generated writer registration, and
`--finish`), the migration of the manual writers `psm-alpha` and `go-app-alpha`,
the ten-task Level 3 cycle, and macOS on real hardware for this release. The
writer lifecycle is Linux-only; on macOS the release keeps `host` and
`read-only` mode selection. The published-release acceptance follows after
publication.

### v0.9.0 post-release evidence

The published-release acceptance of `v0.9.0` ran on 2026-10-19 from 12:40 UTC
on Linux (`x64`) with Node.js `26.11.1`, npm `12.2.1`, Codex CLI `0.162.1` and
Claude Code `2.1.303`. It passed for the tag and for the installed npm
package.

Tag binding: a fresh clone of the annotated tag `v0.9.0` (tag object
`b1a7f3800ec74b3f99c84d2e2c96841f2d2ea08f`) peels to
`b9d254a9f6628c7435cd61cf565a1da8f26190be`, the merge of #100, and
`git describe --tags --exact-match` reports `v0.9.0`. CI passed on the merge
commit (run `39207028658`) and on the tag (run `39207320511`) on Linux,
macOS 15 and macOS 26.

Provider-free (Level 1), on that clone. Every command exited with `0`:
- 90 test files: 1915 passed and 6 skipped, with strict unhandled rejections
  and no unhandled error.
- `npm audit` and `npm audit --omit=dev`: 0 vulnerabilities.
- `git diff --check` and `git status --short` printed nothing.
- Offline Doctor reported `packageVersion` `0.9.0`. With the example
  configuration its findings were the placeholder workspace
  (`workspace_missing`) and `workspace_mode_unset` for that alias.

`package.json`, `package-lock.json`, `dist/main.js` and the `dist` tree were
byte-identical before and after the client cycles; `dist/main.js` has the
SHA-256 `4c36369fd9151969ee6cfe300d4833001db2728979e8a5d096e0bac715e378da`.

Package publication, a release fact and not an acceptance level: the npm
package `pi-session-mcp@0.9.0` was published by the maintainer from the tag
at 06:42 UTC. It has 666 files, shasum
`f57f150ad9d4bc55263e450aabea6f448e88d8d8` and integrity
`sha512-qSWggifyAUPVSE32iER+/1jAvTPkn/0YTg4rDmCsu6La3EE+Gf/fTUL0DU/kAqulxea2HyBGPug4sBXVLvP3tw==`.
The `dist` and `skills` trees of the registry tarball are identical to the
installed package. It has no provenance attestation.

Real clients without a model (Level 2), with `scripts/setup-acceptance.mjs`:
- Tag clone: 160 of 160 checks passed; all nine steps passed on all four
  targets.
- npm package, installed with `npm install -g --prefix` into a temporary
  prefix without the lockfile: version `0.9.0`, the same `dist/main.js`, and
  every `@earendil-works` package at `1.2.0` with one copy each, although
  `1.3.0` of the SDK family had been published in the meantime. The install
  smoke reported `smoke_passed`, and 160 of 160 checks passed.
- In both runs the real client registrations were unchanged, no process
  remained, and the build stayed byte-identical.

Installation on the Linux workstation: the npm prefix in the home directory
holds `0.9.0`, byte-identical to the registry tarball. `--verify` for
`claude-code:user`, the only owned target there, reported `mcp_verified` and
`skill_verified`; Doctor with the operator configuration reported no error,
only `workspace_gitfile` and `workspace_mode_unset` warnings. The Linux server
was still on `0.8.3` and is upgraded with the next release.

Not established for `0.9.0` after publication: the same gates as before
publication (live container writers, migration of the manual writers, Level 3,
macOS on real hardware).

### v0.9.1 pre-release acceptance

Before its release, `v0.9.1` passed Level 1, the working-tree Level 2 and the
packed-tarball Level 2 on its release candidate `e42610e` on Linux (`x64`),
with Node.js `26.11.1`, npm `12.2.1`, Codex CLI `0.162.1` and Claude Code
`2.1.303`, on 2026-10-19. The release moves the Pi SDK and its six family
packages from `1.2.0` to `1.3.0`. Before the move, `scripts/pi-sdk-canary.sh
1.3.0` reported the candidate compatible (typecheck passed, 13 SDK-facing test
files with 313 passed and 1 skipped).

- Level 1 on the release branch: every command exited with `0`, except Doctor
  as noted below.
  - The test run, with `NODE_OPTIONS=--unhandled-rejections=strict`, reported
    90 files, 1915 passed and 6 skipped, and no unhandled error, including the
    rootless Podman integration tests against real Podman.
  - `npm audit` and `npm audit --omit=dev` reported 0 vulnerabilities.
  - `npm pack --dry-run` listed 666 files.
  - Doctor reported `packageVersion` `0.9.1` and exited with `2`, as expected
    for the example configuration: its findings were the placeholder workspace
    (`workspace_missing`, an error) and `workspace_mode_unset` for that alias.
- Level 2 through `scripts/setup-acceptance.mjs` on the candidate's working
  tree: 160 of 160 checks passed. The real client registrations were
  unchanged, no process remained, the built files were unchanged, and the
  path-leak check passed.
- Packed-tarball Level 2: the candidate's tarball (shasum
  `5f5673d1b311ec8d376db939a77d6e3dc9222829`), installed with
  `npm install -g --prefix` into a fresh prefix without the lockfile, resolved
  every `@earendil-works` package to `1.3.0` with a single copy each. The
  install smoke reported `smoke_passed` with version `0.9.1`. Level 2 against
  the installed package passed 160 of 160 checks, with the same results for
  registrations, processes, build and path leaks.

Not established for `0.9.1`: any live run on Pi SDK `1.3.0` (Level 3, the
container writers or a single provider turn), the migration of the manual
writers, and macOS on real hardware. CI covers macOS 15 and 26. The
published-release acceptance follows after publication.

### v0.9.1 post-release evidence

The published-release acceptance of `v0.9.1` ran on 2026-10-19 from 14:11 UTC
on Linux (`x64`) with Node.js `26.11.1`, npm `12.2.1`, Codex CLI `0.162.1` and
Claude Code `2.1.303`. It passed for the tag and for the installed npm
package.

Tag binding: a fresh clone of the annotated tag `v0.9.1` (tag object
`f517163d7a4bc1e95a58d3a106a4ab225733538b`) peels to
`891a3937959dadc0ddb222015bb20f35c6c9070d`, the merge of #101, and
`git describe --tags --exact-match` reports `v0.9.1`. CI passed on the merge
commit (run `39263723693`) and on the tag (run `39264797691`) on Linux,
macOS 15 and macOS 26. In both runs the macOS 26 job first failed on a Vitest
timeout in `test/multi-session-acceptance.test.ts` and passed when rerun; the
same timeout also hit the release branch, and a deadline test in
`test/mcp-stdio-e2e.test.ts` failed once the same way. The test budgets were
raised afterwards.

Provider-free (Level 1), on that clone. Every command exited with `0`:
- 90 test files: 1915 passed and 6 skipped, with strict unhandled rejections
  and no unhandled error.
- `npm audit` and `npm audit --omit=dev`: 0 vulnerabilities.
- `git diff --check` and `git status --short` printed nothing.
- Offline Doctor reported `packageVersion` `0.9.1`.

`package.json`, `package-lock.json`, `dist/main.js` and the `dist` tree were
byte-identical before and after the client cycles; `dist/main.js` has the
SHA-256 `4c36369fd9151969ee6cfe300d4833001db2728979e8a5d096e0bac715e378da`,
the same as in `0.9.0`, because the entry module itself did not change.

Package publication, a release fact and not an acceptance level: the npm
package `pi-session-mcp@0.9.1` was staged with `npm stage publish` from a fresh
clone of the tag and approved by the maintainer. It has 666 files, shasum
`fb4ccdf3cd389149365ffa54e8643303a302c491` and integrity
`sha512-sfX9ipU9HISNYcKLG9xVsi28CyaF6DrySjoegeSHLGupiZak+Z9CAGwbZx0AXXP97R7LWUI59m4eU1Jk8q5CNA==`;
the registry serves the staged shasum. It has no provenance attestation.

Real clients without a model (Level 2), with `scripts/setup-acceptance.mjs`:
- Tag clone: 160 of 160 checks passed.
- npm package, installed with `npm install -g --prefix` into a temporary
  prefix without the lockfile: version `0.9.1`, the same `dist/main.js`, and
  every `@earendil-works` package at `1.3.0` with one copy each. The install
  smoke reported `smoke_passed`, and 160 of 160 checks passed.
- In both runs the real client registrations were unchanged, no process
  remained, and the build stayed byte-identical.

Installation upgrades on 2026-10-19, following
[Installation](installation.md#npm-installation):
- Linux workstation, npm prefix in the home directory: from `0.9.0` to
  `0.9.1` for `claude-code:user`, the only owned target there. `--remove`
  reported `removed` and `skill_removed`, Doctor with the operator
  configuration reported warnings only (`workspace_gitfile`,
  `workspace_mode_unset`), and `--apply` then `--verify` reported
  `mcp_verified` and `skill_verified`.
- Linux server (npm prefix `~/.npm-global`): from `0.8.3` to `0.9.1` for
  `claude-code:user` and `codex:user`, with the same sequence and results.
  Setup ran with Node.js `24.22.0` first on `PATH`, the runtime of the
  existing registrations, so the new registrations kept it.
- Two client sessions on the server were open during the upgrade at the
  operator's request; they keep their old server process until they end.

Single-turn provider smoke, after publication and not an acceptance level:
on each machine, a stdio MCP client started one session per execution
profile, sent one short prompt that asked for a fixed one-word reply, polled
the turn to `completed` and closed the session. All ten configured profiles
passed on the workstation and on the server, including the two profiles with
the `pi-cursor-sdk@0.5.3` extension; on the workstation the two manual
container writers `psm-alpha` and `go-app-alpha`, which mount the installed
package, passed for their `code` and `review` profiles. No workspace or
writer clone changed. This is the first provider use on Pi SDK `1.3.0`; it
says nothing about task quality, Level 3 or the automated container writers.

### v0.10.0 pre-release acceptance

Before its release, `v0.10.0` passed Level 1, the working-tree Level 2, the
packed-tarball Level 2 and a live check of a granted extension tool on its
release candidate `1a5cca7` on Linux (`x64`), with Node.js `26.11.1`, npm
`12.2.1`, Codex CLI `0.162.1` and Claude Code `2.1.303`, on 2026-10-19. The
release adds granted extension tools for read-only profiles
([ADR 0010](adr/0010-read-only-extension-tools.md)). A provider-free probe
first showed that `pi-lens@4.4.3` registers `symbol_search` and
`project_report` when its extension loads
([evidence](evaluation/pi-lens-registration-2026-10-19/README.md)).

- Level 1 on the release branch: every command exited with `0`, except Doctor
  as noted below.
  - The test run, with `NODE_OPTIONS=--unhandled-rejections=strict`, reported
    90 files, 1958 passed and 6 skipped, and no unhandled error, including the
    real-SDK contract tests for granted, missing, hidden and deactivated
    extension tools.
  - `npm audit` and `npm audit --omit=dev` reported 0 vulnerabilities.
  - `npm pack --dry-run` listed 671 files.
  - Doctor reported `packageVersion` `0.10.0` and exited with `2`, as expected
    for the example configuration (`workspace_missing` for the placeholder
    workspace, `workspace_mode_unset` for that alias).
- Level 2 through `scripts/setup-acceptance.mjs` on the candidate's working
  tree: 160 of 160 checks passed. The real client registrations were
  unchanged, no process remained, the built files were unchanged, and the
  path-leak check passed.
- Packed-tarball Level 2: the candidate's tarball (shasum
  `9c7b0bfa98e14700dc7ec19b8c4938202b3c0c91`), installed with
  `npm install -g --prefix` into a fresh prefix without the lockfile, resolved
  every `@earendil-works` package to `1.3.0` with a single copy each. The
  install smoke reported `smoke_passed` with version `0.10.0`. Level 2 against
  the installed package passed 160 of 160 checks, with the same results for
  registrations, processes, build and path leaks.
- Live check of a granted tool, with an evaluation-owned Pi agent directory
  holding `pi-lens@4.4.3` and a disposable clone as the only workspace:
  - Configuration: one read-only profile with `extensions: ["npm:pi-lens@4.4.3"]`
    and `grantedExtensionTools: ["symbol_search"]`. `pi_capabilities_get`
    reported the grant, and `pi_session_start` admitted the session.
  - The prompt asked the model to call `symbol_search` once and echo the
    start of the result. The turn completed with a real `pi-lens` search
    result (a ranked file list headed by `src/session-tools.ts`). The tool
    therefore ran in a read-only session that pi-session-mcp creates with
    `projectTrusted: false`.
  - Provider: `deepseek` / `deepseek-flash` with a copied API key. The
    planned `xai` route failed with `turn_failed` for every profile, also
    without any extension, when only the OAuth access token was copied with
    an emptied refresh token. The rotating refresh token was deliberately not
    copied. This is an evaluation-setup limit, not a product result.
  - `strace -f -e trace=connect` on the server recorded only the local DNS
    resolver and the provider endpoint. The clone had no changed, untracked
    or ignored file afterwards. The agent directory with the copied key was
    removed.
  - Three `deepseek` turns were used (one control without extensions, two grant runs), plus three `xai` attempts that failed before any model output, well below the USD 0.50 limit.

Not established for `0.10.0`: a live grant with OAuth providers in an
isolated agent directory, Level 3, the automated container writers, and macOS
on real hardware. CI covers macOS 15 and 26. The published-release
acceptance follows after publication.

### v0.11.0 pre-release acceptance

Before its release, `v0.11.0` passed Level 1, the working-tree Level 2 and the
packed-tarball Level 2 on its release candidate `800727e` on Linux (`x64`), with
Node.js `26.11.1`, npm `12.2.1`, Codex CLI `0.162.1` and Claude Code `2.1.306`,
on 2026-10-22. The release adds opt-in turn events and a Claude Code controller
wake ([ADR 0011](adr/0011-turn-events-and-controller-wake.md), #108, #110).

- A first run of this acceptance failed: Level 2 passed 124 of 160 checks in
  both modes, because every setup report gained a hook finding even with
  delivery off. Setup now omits hook findings without news, so its report keeps
  the 0.10 shape; the run above is the second one.
- Level 1 on the release branch: every command exited with `0`, except Doctor
  as noted below.
  - The test run, with `NODE_OPTIONS=--unhandled-rejections=strict`, reported
    114 files, 3324 passed and 6 skipped, and no unhandled error.
  - `npm audit` and `npm audit --omit=dev` reported 0 vulnerabilities, after
    the development-only update of `@modelcontextprotocol/inspector` to
    2.11.0 and the lockfile patches named in the changelog.
  - `npm pack --dry-run` listed 816 files, including `dist/wake-main.js`.
  - Doctor reported `packageVersion` `0.11.0` and exited with `2`, as expected
    for the example configuration (`workspace_missing` for the placeholder
    workspace, `workspace_mode_unset` for that alias).
- Level 2 through `scripts/setup-acceptance.mjs` on the candidate's working
  tree: 160 of 160 checks passed. The real client registrations were
  unchanged, no process remained, the built files were unchanged, and the
  path-leak check passed.
- Packed-tarball Level 2: the candidate's tarball (sha256
  `0ae2cf934122a544f94019c7040bc1f745d89241f199d3e9635a9d4c450ad5b0`), installed
  with `npm install -g --prefix` into a fresh prefix without the lockfile,
  resolved every `@earendil-works` package to `1.3.0` with a single copy each.
  The install smoke reported `smoke_passed` with version `0.11.0`. Level 2
  against the installed package passed 160 of 160 checks, with the same results
  for registrations, processes, build and path leaks.
- Turn events and the wake were accepted provider-free before the merge of
  #110: unit, process and compiled-program tests, and a product probe with the
  installed Claude Code `2.1.306` against a loopback fake model in a network
  namespace (completion wake, two turns, budget re-arm, delivery off, no wake
  after a controller close).

Not established for `0.11.0`: the wake in the interactive Claude Code TUI and
in the VS Code extension (including whether a running session loads a newly
written hook without a restart or a `/hooks` review), a wrapped container
writer with delivery enabled under rootless Podman including the isolation
check of its spool mount, Level 3, macOS delivery (Linux only by design), and
any real-model run on this candidate. CI covers macOS 15 and 26. The
published-release acceptance follows after publication.

### v0.11.0 post-release evidence

The published-release acceptance of `v0.11.0` ran on 2026-10-22 from 06:47 UTC
on Linux (`x64`) with Node.js `26.11.1`, npm `12.2.1`, Codex CLI `0.162.1` and
Claude Code `2.1.308`. Level 2 passed for the tag and for the installed npm
package. Level 1 was not repeated on the tag clone: the tag differs from the
accepted candidate `800727e` only by the acceptance record.

Tag binding: a fresh clone of the annotated tag `v0.11.0` (tag object
`0726316ea6705b6bbcd6fe67911b3833156b4d93`) peels to
`8875dd5ad3e4fcd34e12b2359bce1611b1c9581e`, the merge of #112. CI passed on
the merge commit (run `39732402829`) and on the tag (run `39734813506`).

Package publication, a release fact and not an acceptance level: the npm
package `pi-session-mcp@0.11.0` was staged with `npm stage publish` from that
clone and approved by the maintainer. Its shasum is
`6dfd69e2e7449ae9fbcf5c9ed05b43cd217322e8`, equal to a local `npm pack` of the
tag, and its integrity is
`sha512-Yr/l285Dm+R8AL8aJk3xa+TbVsdhtTgqrH+NcNrG4y8XFPUq6AAcB+22vAoU7N2iGfh9bepR9WCmTuTcv1Ja8w==`.
The registry serves the staged shasum. The manifest keeps all four
executables, including `pi-session-mcp-wake`.

Real clients without a model (Level 2), with `scripts/setup-acceptance.mjs`:
- Tag clone: 160 of 160 checks passed.
- npm package, installed with `npm install -g --prefix` into a temporary
  prefix without the lockfile: every `@earendil-works` package at `1.3.0` with
  one copy each, and 160 of 160 checks passed.
- In both runs the real client registrations were unchanged, no process
  remained, the built files were unchanged, and the path-leak check passed.
  The temporary prefix was removed.

Manual operator check of the wake in the interactive Claude Code TUI, on
2026-10-22 with the `0.11.0` build:
- Setup. Setup could not add a `claude-code:local` registration in the test
  project, because a same-named server is registered at user scope and
  `claude mcp get` shows only the effective entry. Setup reported it as
  `divergent` and changed nothing. The session therefore ran with
  `--strict-mcp-config` and a test server configuration with delivery enabled.
  The canonical hook entry was generated with `buildWakeEntry` and installed
  by hand in `.claude/settings.local.json`.
- Result. A real `explore-fast` worker turn of about 9 s completed. The idle
  controller session was woken without polling, shown as hook feedback in the
  TUI, read the turn once and closed the session.
- Not established: whether the hook was loaded by a session that was already
  running when the entry was written.

Finding after publication (#113): the operator upgrade with delivery enabled
in the shared configuration failed `setup --verify` for both targets with
`mcp_unsupported`.
- Cause. The server refused to start without `XDG_RUNTIME_DIR`. Setup's
  verification launcher passes no such variable, and Codex `0.162.1` passes
  only `HOME`, `LANG`, `LOGNAME`, `PATH`, `SHELL` and `USER`, as observed on a
  Codex-launched server process.
- Consequence. Every new Codex session would have lost pi-session-mcp.
- Mitigation. The operator configuration went back to delivery off, and setup
  removed its hook entry. `0.11.1` fixes the defect.

Not established for `0.11.0`: the wake in the VS Code extension, a wrapped
container writer with delivery enabled, Level 3, and any real-model run on
this release other than the TUI check above.

### v0.11.1 pre-release acceptance

`v0.11.1` was accepted on 2026-10-22 on its release candidate `6e7c46b`, on
Linux (`x64`) with Node.js `26.11.1`, npm `12.2.1`, Codex CLI `0.162.1` and
Claude Code `2.1.308`. It passed:
- Level 1;
- Level 2 in the working tree and for the packed tarball, each once with
  delivery off and once with delivery on;
- a real Codex start.

The patch fixes #113. With delivery enabled and no runtime directory, the
server now starts with delivery inactive instead of failing. Setup's direct
verification passes the caller's `XDG_RUNTIME_DIR`. Level 2 gains a variant
with delivery enabled.

- Level 1 on the release branch: every command exited with `0`, except Doctor.
  - The test run, with `NODE_OPTIONS=--unhandled-rejections=strict`, reported
    114 files, 3322 passed and 13 skipped, and no unhandled error.
  - Six of the skipped tests are the usual ones: four macOS lock tests, one
    isolated output probe and one red-before concurrency test.
  - The other seven are compiled-program tests of the evaluation prototype in
    `test/bridge-hooks.test.ts`. They need a `.bridge-eval` build that a fresh
    checkout does not have, and they do not cover product code.
  - `npm audit` and `npm audit --omit=dev` reported 0 vulnerabilities.
  - `npm pack --dry-run` listed 816 files.
  - Doctor reported `packageVersion` `0.11.1`. It exited with `2` because no
    configuration was set (`config_missing`).
- Level 2 in the working tree, through `scripts/setup-acceptance.mjs`:
  - delivery off: 160 of 160 checks passed;
  - `--events spool`: 228 of 228 checks passed. This covers the wake-hook
    findings and settings entries of all three Claude Code scopes, a foreign
    hook that survived, and no spool instance left after `--verify`.
- Packed-tarball Level 2:
  - The candidate's tarball (sha256
    `c00f3cffcb7da3f66f765ba30cdcd18d815bc6f83d9c6b9127a7add629226efa`) was
    installed with `npm install -g --prefix` into a fresh prefix without the
    lockfile.
  - Every `@earendil-works` package resolved to `1.3.0`, with a single copy
    each.
  - The install smoke reported `smoke_passed` with version `0.11.1`.
  - Level 2 passed 160 of 160 checks with delivery off and 228 of 228 with
    `--events spool`.
  - In every Level 2 run the real client registrations were unchanged, no
    process remained, the built files were unchanged, and the path-leak check
    passed.
- The delivery variant fails on the defect. Against the published `0.11.0`
  package it reported 220 of 228: `--verify` failed with `mcp_unsupported` on
  all four targets, in steps 5 and 8.
- Real Codex start, provider-free:
  - Setup. `codex exec` ran in a disposable `CODEX_HOME` with a model endpoint
    that leads nowhere, so no provider was called. The `pi-session-mcp` entry
    pointed at a wrapper that recorded the environment and the server's stderr,
    with a configuration that enables delivery.
  - Environment. Codex passed the server only `HOME`, `PATH` and the
    registered `PI_SESSION_MCP_CONFIG`, not its own `XDG_RUNTIME_DIR`.
  - `0.11.0` stopped with `startup_failed` / `event_spool_unavailable` (exit 1).
  - The candidate started, wrote one `event_delivery_inactive` warning and
    exited with `0` when Codex ended.
- Delivery on the installed tarball, in a Codex-like environment:
  `pi_capabilities_get` reported `events.delivery: "off"`. With a private
  `XDG_RUNTIME_DIR` it reported `spool` and left an empty `events` root after
  stdin EOF.
- Review:
  - An independent review of the fix found no blocker. Its findings were fixed:
    a table row in `docs/tool-contracts.md` that did not render, and tests for
    the inherited runtime directory and for no instance directory left after a
    verify run.
  - A side review pointed out that the approved plan included a Level 2 variant
    with delivery enabled, which the first candidate lacked. It was added before
    the merge.

Not established for `0.11.1`:
- the VS Code wake;
- whether a running Claude Code session loads a newly written hook;
- a wrapped container writer with delivery enabled;
- Level 3 and real-model runs;
- macOS delivery.

CI covers macOS 15 and 26. The published-release acceptance follows after
publication, with both Level 2 variants.

### v0.11.1 post-release evidence

The published-release acceptance of `v0.11.1` ran on 2026-10-22 from 19:20 UTC
on Linux (`x64`) with Node.js `26.11.1`, npm `12.2.1`, Codex CLI `0.162.1` and
Claude Code `2.1.308`. Level 2 passed for the tag and for the installed npm
package, each with delivery off and with `--events spool`. Level 1 was not
repeated on the tag clone: the tag differs from the accepted candidate
`6e7c46b` only by the acceptance record.

Tag binding: a fresh clone of the annotated tag `v0.11.1` (tag object
`fc1c7e34379a6474a08e1ada032c533c44ed0839`) peels to
`262ad845e883c7aa2955f3e5139fa2513f382fc6`, the merge of #114, and
`git describe --tags --exact-match` reports `v0.11.1`. CI passed on the merge
commit (run `39764645133`) and on the tag (run `39765299541`).

Package publication, a release fact and not an acceptance level:
- The registry serves `pi-session-mcp@0.11.1` with shasum
  `739c23bbc8f0fa1f156311d4a1d3139d905e46fd`. This equals a local `npm pack` of
  the tag clone after `npm ci`, `npm run build` and `npm run build:cli`.
- The integrity is
  `sha512-a7G7G5r2cSqQkLxzetWiMLZx+UJM0Dj7QjASA523UIMr0nX0r6XI262jYb7cwF+euu71cShLgk9pum4sc2amkA==`.

Real clients without a model (Level 2), with `scripts/setup-acceptance.mjs`:
- Tag clone: 160 of 160 checks passed with delivery off and 228 of 228 with
  `--events spool`.
- npm package: installed with `npm install -g --prefix` into a temporary
  prefix without the lockfile. Every `@earendil-works` package resolved to
  `1.3.0` with one copy each. Level 2 passed 160 of 160 checks with delivery
  off and 228 of 228 with `--events spool`.
- In every run the real client registrations were unchanged, no process
  remained, the built files were unchanged, and the path-leak check passed.
- The clone and the prefix were removed.

Not established for `0.11.1`:
- the VS Code wake;
- whether a running Claude Code session loads a newly written hook;
- a wrapped container writer with delivery enabled;
- Level 3 and real-model runs;
- macOS delivery.

### v0.11.2 pre-release acceptance

`v0.11.2` was accepted on 2026-10-22 from 19:15 UTC on its release candidate
`9cd3f69`, on Linux (`x64`) with Node.js `26.11.1`, npm `12.2.1`, Codex CLI
`0.162.1` and Claude Code `2.1.308`. Level 1 passed. Level 2 passed in the
working tree and for the packed tarball, each with delivery off and with
delivery on.

The patch fixes #109 and moves the Pi SDK family from `1.3.0` to `1.4.0`
(#117). It does not change the MCP contract.

- Level 1 on the release branch: every command exited with `0`, except Doctor.
  - The test run, with `NODE_OPTIONS=--unhandled-rejections=strict`, reported
    114 files, 3335 passed and 13 skipped, and no unhandled error. Thirteen is
    the same skip count as for `0.11.1`.
  - `npm audit` and `npm audit --omit=dev` reported 0 vulnerabilities.
  - `npm pack --dry-run` listed 816 files.
  - Doctor reported `packageVersion` `0.11.2`. It exited with `2` because no
    configuration was set (`config_missing`).
- Level 2 in the working tree, through `scripts/setup-acceptance.mjs`: 160 of
  160 checks passed with delivery off and 228 of 228 with `--events spool`.
- Packed-tarball Level 2:
  - The candidate's tarball (sha256
    `3470f4427676287ee19a2bfc9e2fa71ea2503bdda91964bead41284bcea29701`) was
    installed with `npm install -g --prefix` into a fresh prefix without the
    lockfile.
  - Every `@earendil-works` package resolved to `1.4.0`, with a single copy
    each.
  - The install smoke reported `smoke_passed` with version `0.11.2`.
  - Level 2 passed 160 of 160 checks with delivery off and 228 of 228 with
    `--events spool`.
- In every Level 2 run the real client registrations were unchanged, no
  process remained, the built files were unchanged, and the path-leak check
  passed. The tarball and the prefix were removed.
- #109, provider-free:
  - A Linux churn test on the real procfs failed in 4 of 4 runs against the old
    `src/setup-platform.ts`. All three symptoms appeared: an unreadable table,
    an `unknown` state for a live group, and a reaped group that was not
    `gone`.
  - On the candidate, 45 runs of `test/setup-platform.test.ts` in three
    parallel loops passed.
  - An independent review found no blocker. Its findings were taken in: a
    second read of a group `-1` sample, deterministic tests through a procfs
    seam, a lighter churn load and the changelog wording.
- #117, provider-free: `scripts/pi-sdk-canary.sh 1.4.0` exited with `0`
  (typecheck, 339 SDK tests in 15 files). `npm ls` showed one copy of each
  family package. The SDK's reserved MCP tool names are unchanged.

Not established for `0.11.2`:
- any live run on Pi SDK `1.4.0` (Level 3 or a real model);
- the VS Code wake;
- a wrapped container writer with delivery enabled;
- macOS delivery.

CI covers macOS 15 and 26. The published-release acceptance follows after
publication, with both Level 2 variants.

### v0.11.2 post-release evidence

The published-release acceptance of `v0.11.2` ran on 2026-10-22 from 20:07 UTC
on Linux (`x64`) with Node.js `26.11.1`, npm `12.2.1`, Codex CLI `0.162.1` and
Claude Code `2.1.308`. Level 2 passed for the tag and for the installed npm
package, each with delivery off and with `--events spool`. Level 1 was not
repeated on the tag clone: the release commit has the same tree as the
release branch head `d6ed5ec`, which differs from the accepted candidate
`9cd3f69` only by the acceptance record.

Tag binding: a fresh clone of the annotated tag `v0.11.2` (tag object
`03d6a9e844ebaef51ba4936e6b97ad6c88e85458`) peels to
`39f823b3a6f1155f22c794ed52017f118f193404`, the merge of #116, and
`git describe --tags --exact-match` reports `v0.11.2`. CI passed on the merge
commit (run `39843660550`) and on the tag (run `39845222402`).

Package publication, a release fact and not an acceptance level:
- The maintainer published `pi-session-mcp@0.11.2` at 19:59:55 UTC, before the
  tag existed, so the package was not built from a tag clone as
  [Releasing](releasing.md#publish-a-release) describes.
- Byte equality stands in for that step. The registry serves shasum
  `34b697cd8eaf3c216daa65e8f03a02cecc3d7e9c` and integrity
  `sha512-SjtvGZ8i/yK3tb9d9bSn1ughj1A2SAoSbEBDkDGtHJEspv1vShIh9F3I78+RcSPJmcKigpYDblEcuynYaHeGUw==`.
  Both equal a local `npm pack` of a fresh clone of the merge commit, and
  later of the tag, after `npm ci`, `npm run build` and `npm run build:cli`.
- Doctor on the tag clone reported `packageVersion` `0.11.2`. It exited with
  `2` because no configuration was set (`config_missing`).
- The GitHub release `v0.11.2` was created after the tag CI passed.

Real clients without a model (Level 2), with `scripts/setup-acceptance.mjs`:
- Tag clone: 160 of 160 checks passed with delivery off and 228 of 228 with
  `--events spool`.
- npm package: installed with `npm install -g --prefix` into a temporary
  prefix without the lockfile. Every `@earendil-works` package resolved to
  `1.4.0` with one copy each. The install smoke reported `smoke_passed` with
  version `0.11.2`. Level 2 passed 160 of 160 checks with delivery off and 228
  of 228 with `--events spool`.
- In every run the real client registrations were unchanged, no process
  remained, the built files were unchanged, and the path-leak check passed.
- The clone and the prefix were removed.

Not established for `0.11.2`:
- any live run on Pi SDK `1.4.0` (Level 3 or a real model);
- the VS Code wake;
- a wrapped container writer with delivery enabled;
- macOS delivery.

### Sprint 7 candidate acceptance (2026-10-24)

Candidate for #118: commit `6651a47`, package version string unchanged at
`0.11.2`, Pi SDK `1.4.0`. This is not an acceptance of the published `0.11.2`.
Details, bindings and every failed attempt are in the
[evidence record](evaluation/s7-live-acceptance-2026-10-24/README.md).

- Level 1: all commands exit 0 except `npm audit`, which reports `undici`
  8.10.2 pinned by the Pi SDK
  ([#120](https://github.com/plagor44-ux/pi-session-mcp/issues/120)).
- Level 2: working tree and packed tarball, 160 of 160 checks with delivery off
  and 228 of 228 with `--events spool`.
- Level 3 with Claude Code 2.1.308 and Codex 0.162.1, worker routes
  `explore-fast` and `code-deepseek`: 10 of 10 tasks passed with every
  independent check. The gate is not met, only because Level 1 is not green.
- Wake scenarios, targeted and not part of Level 3:
  - passed: setup path (E1), two parallel turns (E2), budget wake with a manual
    hook (E3b), abort and close (E4), the Codex fallback without a runtime
    directory (E5);
  - a running stream-json CLI session picked up a hook that setup installed
    after it started.
- VS Code: a wake was observed only on the published `0.11.2` in the
  integrator's own extension session.
- Container writer with delivery: delegation, wake, collect, finish and remove
  passed, and the boundary and crafted-event checks passed provider-free. The
  first acceptance failed once without a diagnosable cause
  ([#121](https://github.com/plagor44-ux/pi-session-mcp/issues/121)). A forged
  event during a real controller turn was not run.

### v0.11.3 pre-release acceptance

`v0.11.3` was accepted on 2026-10-25 from 08:28 to 08:33 UTC on its release
candidate `30ddeaf`, on Linux (`x64`) with Node.js `26.11.1`, npm `12.2.1`,
Codex CLI `0.162.1` and Claude Code `2.1.310`. Level 2 passed in the working
tree and for the packed tarball, each with delivery off and with delivery on.
Level 1 passed except `npm audit`.

The patch ships the #118 and #121 fixes and the `zod` patch from Sprint 7. It
does not change the MCP contract; the setup report codes of a failed writer
acceptance changed (#121).

- Level 1 on the release branch: every command exited with `0`, except
  `npm audit` and Doctor.
  - The test run, with `NODE_OPTIONS=--unhandled-rejections=strict`, reported
    114 files, 3366 passed and 13 skipped, and no unhandled error.
  - `npm audit` and `npm audit --omit=dev` exited with `1`. Both name only
    `undici` 8.10.2 (GHSA-4qv8-2p9j-2685, GHSA-f72v-6w45-q472,
    GHSA-xjj6-f33q-929c) and `@earendil-works/pi-coding-agent` 1.4.0, which
    pins it ([#120](https://github.com/plagor44-ux/pi-session-mcp/issues/120)).
    The release precondition of 0 vulnerabilities is therefore not met. The
    maintainer decided on 2026-10-25 to release with this finding stated.
  - `npm pack --dry-run` listed 958 files.
  - Doctor reported `packageVersion` `0.11.3`. It exited with `2` because no
    configuration was set (`config_missing`).
- Level 2 in the working tree, through `scripts/setup-acceptance.mjs`: 160 of
  160 checks passed with delivery off and 228 of 228 with `--events spool`.
- Packed-tarball Level 2:
  - The candidate's tarball (sha256
    `3beb43f0448f0f2c8334207bbee0fa33427cadf1164ab91f58d68b1685da953d`) was
    installed with `npm install -g --prefix` into a fresh prefix without the
    lockfile.
  - Every `@earendil-works` package resolved to `1.4.0`, with a single copy
    each.
  - The install smoke reported `smoke_passed` with version `0.11.3`.
  - Level 2 passed 160 of 160 checks with delivery off and 228 of 228 with
    `--events spool`.
- In every Level 2 run the real client registrations were unchanged, no
  process remained, the built files were unchanged, and the path-leak check
  passed. The tarball and the prefix were removed.
- #118 and #121 were reviewed independently before their merge
  ([#122](https://github.com/plagor44-ux/pi-session-mcp/pull/122),
  [#123](https://github.com/plagor44-ux/pi-session-mcp/pull/123)).

Not established for `0.11.3`:
- any live run of the released package (Level 3 or a real model);
- a real container writer acceptance with the new #121 codes; the Sprint 8
  pilot runs it on the published release;
- the VS Code wake;
- macOS delivery.

CI covers macOS 15 and 26. The published-release acceptance follows after
publication, with both Level 2 variants.

### v0.11.4 pre-release acceptance

`v0.11.4` was accepted on 2026-10-25 from 14:15 to 14:24 UTC on its release
candidate `643f1f9`, on Linux (`x64`) with Node.js `26.11.1`, npm `12.2.1`,
Codex CLI `0.162.1` and Claude Code `2.1.310`. Level 2 passed in the working
tree and for the packed tarball, each with delivery off and with delivery on.
Level 1 passed except `npm audit`.

The patch ships the Sprint 8 pilot fixes #125, #126 and #127
([#128](https://github.com/plagor44-ux/pi-session-mcp/pull/128)). It does not
change the MCP contract or any setup report code.

- Level 1 on the release branch: every command exited with `0`, except
  `npm audit` and Doctor; `git status --short` printed nothing.
  - The test run, with `NODE_OPTIONS=--unhandled-rejections=strict`, reported
    114 files, 3398 passed and 13 skipped, and no unhandled error.
  - `npm audit` and `npm audit --omit=dev` exited with `1` and name only the
    known `undici` finding (GHSA-4qv8-2p9j-2685, GHSA-f72v-6w45-q472,
    GHSA-xjj6-f33q-929c) through `@earendil-works/pi-coding-agent` 1.4.0
    ([#120](https://github.com/plagor44-ux/pi-session-mcp/issues/120)). The
    maintainer decided on 2026-10-25 to release with this finding stated.
  - `npm pack --dry-run` listed 958 files.
  - Doctor reported `packageVersion` `0.11.4`. It exited with `2` because no
    configuration was set (`config_missing`).
- Level 2 in the working tree, through `scripts/setup-acceptance.mjs`: 160 of
  160 checks passed with delivery off and 228 of 228 with `--events spool`.
  The same two runs had passed on the #128 head `b84160b` before its merge.
- Packed-tarball Level 2:
  - The candidate's tarball (sha256
    `58d2ed277ad3cbea9bab96af9de18a4c7d305cd6b35c0ac8af6207b936e15504`) was
    installed with `npm install -g --prefix` into a fresh prefix without the
    lockfile.
  - Every `@earendil-works` package resolved to `1.4.0`.
  - The install smoke reported `smoke_passed` with version `0.11.4`.
  - Level 2 passed 160 of 160 checks with delivery off and 228 of 228 with
    `--events spool`.
- In every Level 2 run the real client registrations were unchanged, no
  process remained, the built files were unchanged, and the path-leak check
  passed. The tarball and the prefix were removed.
- The Claude Code 2.1.310 contract was recorded in a disposable home
  (`test/fixtures/client-contracts/claude-code-2.1.310.json`); only the version
  line differs from 2.1.296.
- #125, #126 and #127 were reviewed independently before their merge
  ([#128](https://github.com/plagor44-ux/pi-session-mcp/pull/128)).

Not established for `0.11.4`:
- any live run of the released package (Level 3 or a real model);
- a container writer provisioned and accepted by this release in a single
  `--apply` (#126 on a real writer) and the second writer's Claude Code
  registration (#127); the Sprint 8 pilot runs both on the published release;
- the VS Code wake;
- macOS delivery.

CI covers macOS 15 and 26. The published-release acceptance follows after
publication, with both Level 2 variants.

### v0.11.6 pre-release acceptance

`v0.11.6` was accepted on 2026-10-26 from 10:00 to 10:03 UTC on its release
candidate `a7781da`, on Linux (`x64`) with Node.js `26.12.1`, npm `12.2.1`,
Codex CLI `0.162.1` and Claude Code `2.1.310`. Level 2 passed in the working
tree and for the packed tarball, each with delivery off and with delivery on.
Level 1 passed except `npm audit`.

The patch ships the Sprint 9 close-out (#134, #135, #136, #137) and the
Sprint 10 skill changes on one branch. It does not change the MCP contract.
Setup gains the finding code `writer_reconnect_required` and, when the Doctor
gate blocks, findings with target `client: "doctor"`; Doctor gains the warning
`extension_unpinned`. The setup report keeps `schemaVersion` 1.

- Level 1 in the candidate checkout after `npm ci`: every command exited with
  `0`, except `npm audit`; `git status --short` printed nothing.
  - The test run, with `NODE_OPTIONS=--unhandled-rejections=strict`, reported
    114 files, 3439 passed and 13 skipped, and no unhandled error.
  - `npm audit` exited with `1` and names only the known `undici` finding
    (GHSA-4qv8-2p9j-2685, GHSA-f72v-6w45-q472, GHSA-xjj6-f33q-929c) through
    `@earendil-works/pi-coding-agent` 1.4.0, still the latest SDK release
    ([#120](https://github.com/plagor44-ux/pi-session-mcp/issues/120)).
  - `npm pack` listed 961 files (tarball shasum
    `5eb2b382fc1b45880fc67952f4f86af42e162eae`); nothing under `eval/` is
    packed.
  - Doctor reported `packageVersion` `0.11.6`. It exited with `2` because no
    configuration was set (`config_missing`).
- Level 2 in the working tree, through `scripts/setup-acceptance.mjs`: 160 of
  160 checks passed with delivery off and 228 of 228 with `--events spool`.
- Packed-tarball Level 2, installed with `npm install -g --prefix` into a
  fresh prefix: 160 of 160 checks with delivery off and 228 of 228 with
  `--events spool`.
- In every Level 2 run the real client registrations and the built files were
  unchanged. The tarball and the prefix were removed.
- An earlier run of the same checks on candidate `4bbd4ff` passed as well; the
  final independent review's follow-ups came after it, so this record binds to
  `a7781da`.
- Reviews: `review-glm` (Pi, another model family) on #136 and #137, and a
  final independent review of the whole diff; their follow-ups are part of the
  candidate.
- The controller skill was measured with the provider-free eval suite under
  `eval/controller-skill/` (20 of 21 runs on the final skill).

Not established for `0.11.6`:
- any live run of the released package (Level 3 or a real model);
- the new worker skills inside a container writer, which needs the upgrade and
  a `--repo <alias> ... --apply` on the published release;
- whether a running writer server recovers by itself after a reset through the
  wrapper's periodic credential copy (#136);
- the VS Code wake; macOS delivery.

### v0.12.0 pre-release acceptance

`v0.12.0` was accepted on 2026-10-28 from 11:40 to 11:45 UTC on its release
candidate `169f00c`, on Linux (`x64`) with Node.js `26.12.1`, npm `12.2.1`,
Codex CLI `0.162.1` and Claude Code `2.1.312`. Level 2 passed in the working
tree and for the packed tarball, each with delivery off and with delivery on.
Level 1 passed except `npm audit`. Later commits on the release pull request
change only this record and the roadmap.

The minor release ships ADR 0012 (#157) with #151 and #154. It changes the MCP
contract as the changelog lists; the setup report keeps `schemaVersion` `1`.

- Level 1 in a clean worktree of the candidate after `npm ci`: every command
  exited with `0`, except `npm audit`; `git status --short` printed nothing.
  - The test run, with `NODE_OPTIONS=--unhandled-rejections=strict`, reported
    120 files, 3693 passed and 14 skipped, and no unhandled error.
  - `npm audit` exited with `1` and names only the known `undici` finding
    through `@earendil-works/pi-coding-agent` 1.4.0
    ([#120](https://github.com/plagor44-ux/pi-session-mcp/issues/120)).
  - `npm pack` listed 907 files (tarball shasum
    `764e22c8373934ce339cfd76ea1e56b96006a34d`); nothing under
    `docs/superpowers/` is packed, and a scan of the packed files for private
    names, hosts and paths found none.
  - Doctor reported `packageVersion` `0.12.0`. It exited with `2` because no
    configuration was set (`config_missing`).
- Level 2 in the working tree: 160 of 160 checks passed with delivery off and
  228 of 228 with `--events spool`.
- Packed-tarball Level 2 from a fresh prefix: 160 of 160 with delivery off and
  228 of 228 with `--events spool`. The install smoke reported `smoke_passed`
  with version `0.12.0`.
- In every Level 2 run the real client registrations and the built files were
  unchanged, no process remained, and the leak check passed.
- Review: every task of #157 had a cross-family read-only review before it was
  integrated; the findings were fixed in #158.

Level 2 runs no container writer. The Podman-gated tests in
`test/writer-lifecycle.podman.test.ts` ran on the candidate with rootless
Podman and the local Node image, separately from the suite: 4 of 4 passed,
including the lease descriptor check, the finite-input probe and the release of
a writer after its relay parent was killed.

Not established for `0.12.0`: the migration of an installed release's container
repositories, a relayed coding session through the one host registration, the
live checks of #151 and #154, which follow the release; Level 3. No
post-release evidence was recorded for `0.11.9`, a documentation-only release,
beyond its release notes.

### v0.11.8 post-release evidence

The published-release acceptance of `v0.11.8` ran on 2026-10-26 from 22:40 to
22:44 UTC on Linux (`x64`) with Node.js `26.12.1`, npm `12.2.1`, Codex CLI
`0.162.1` and Claude Code `2.1.311`. Level 2 passed for the tag and for the
installed npm package, each with delivery off and with `--events spool`.

Tag binding: a fresh clone of the annotated tag `v0.11.8` (tag object
`edd69951e582f5a078b410189a49c9be46921b6f`) peels to
`fda4130e93da5ccdeb66eb795e3cd593acc00a17`, the merge of #149, and
`git describe --tags --exact-match` reports `v0.11.8`. CI passed on the merge
commit (run `40412553947`) and on the tag.

Package publication, a release fact and not an acceptance level:
- `pi-session-mcp@0.11.8` was staged by the maintainer with `npm stage
  publish` from a fresh clone of the tag and approved with the account's
  second factor. The registry serves shasum
  `b9f27b5de1fb33b980e7e923e2d46d48ddc74273` and integrity
  `sha512-0h2kuqFERAPe5JZElwBmRsX8bewp9PlU/ftWlumXRS83cqwefaBFiMZbBCnNLyAeJRFjgDvTSpLrCX13SjQkcA==`
  with 967 files, equal to `npm pack --dry-run` of the tag clone.
- The GitHub release `v0.11.8` was published by the maintainer.

Real clients without a model (Level 2), with `scripts/setup-acceptance.mjs`:
- Tag clone: 160 of 160 checks passed with delivery off and 228 of 228 with
  `--events spool`.
- npm package: installed into a temporary prefix; every `@earendil-works`
  package resolved to `1.4.0`; the install smoke reported `smoke_passed` with
  version `0.11.8`; 160 of 160 checks with delivery off and 228 of 228 with
  `--events spool`.
- In every run the real client registrations were unchanged, no process
  remained, the built files were unchanged, and the leak check passed.

Operator upgrade of the workstation from `0.11.6` to `0.11.8`, the first
upgrade with two container repositories:
- Both client targets were removed with `0.11.6`, `0.11.8` was installed, and
  Doctor reported `packageVersion` `0.11.8`, `container_profile_refused` `ok`
  for both repositories, and `writer_not_ready` for all six writers.
- `--repo pi-session-mcp --mode container ... --apply` passed while the four
  `node-app` writers were still not ready (#148):
  `writer_accepted` for both writers, registrations and hooks unchanged. The
  `node-app` step then reported `writer_accepted` for all
  four writers.
- Doctor reported no error. Both client targets were applied and verified
  (`mcp_verified`, `skill_verified`, `hook_verified` for Claude Code), and
  `--writer <name> --verify` reported `mcp_verified` and `hook_verified` for
  all six writers.
- A Claude Code session in the `node-app` checkout had its
  four writer servers connected during these steps. Whether it had open
  coding sessions at the time of the acceptance was not checked.

Live check of #142, aborted:
- A turn with profile `code` (provider `openai`) on the upgraded
  `pi-session-mcp-w1` started at 22:44:38 UTC to run shell sleeps until after
  the host token's expiry at 23:35:09 UTC, across the window in which 0.11.6
  writers failed. It was aborted at 23:11:38 by maintainer decision, before
  the wrapper's refresh point at ten minutes before expiry. It made model
  requests for 27 minutes without a failure, which says nothing about the
  window itself. #142 stays verified by code and tests only.

Operator upgrade of the server the second machine from `0.11.6` to `0.11.8`
on 2026-10-27. The server has no writers, and no Pi Session MCP server
process was running there:
- Both client targets (`claude-code:user:pi-session-mcp`,
  `codex:user:pi-session-mcp`) verified with `0.11.6`, were removed, and
  `0.11.8` was installed with Node 24 first in `PATH`. npm reported that it
  skipped the install scripts of `@google/genai` and `protobufjs`
  (`allow-scripts`).
- Doctor reported no error. Both targets were applied and verified
  (`mcp_verified`, `skill_verified`).

Migration step 4 (go-app) on `0.11.8`, workstation, 2026-10-27:
- The manual writer `go-app-alpha` had no work outside `main` and an empty
  bundle directory. Its local Claude Code registration was removed (it had no
  Codex registration), and its wrapper and state directory were moved to an
  archive outside the writer root; deleting them is left to the operator.
- The host aliases `go-app-w1`–`go-app-w7` were removed from the configuration.
  Their worktrees were clean and detached on a commit of `main`.
- The host isolation control for `go-app` passed. `--repo go-app --mode container`
  with four writers, profiles `code`, `code-deepseek`, `code-glm`,
  `code-mistral` and `code-grok`, the operator image `fe14e8543500969bca13782b5e9aa43d7a2bb989e67f705e65fbf6d48034d91f`
  (`node-go`, Node 22.23.3 and Go 1.27.3, an operator image built outside
  this repository), `--cache go`, network `pasta`, lifecycle
  `persistent` and `--client codex` reported `writer_accepted` for all four
  writers on the first `--apply`, `writer_registered` for Claude Code and
  Codex, and the wake hook.
- `go-app-rev` was set to mode `read-only`. `--writer go-app-w<n> --verify`
  reported `mcp_verified` and `hook_verified` for all four writers. Doctor
  reported no error; for go-app only the `workspace_gitfile` warning of the
  read-only alias `go-app-rev` remains.

Not established for `0.11.8`: a live confirmation of #142; a real coding turn
on each `node-app` and go-app writer; Level 3.

### v0.11.8 pre-release acceptance

`v0.11.8` was accepted on 2026-10-26 from 22:15 to 22:20 UTC on its release
candidate `76fe69d`, on Linux (`x64`) with Node.js `26.12.1`, npm `12.2.1`,
Codex CLI `0.162.1` and Claude Code `2.1.311`. Level 2 passed in the working
tree and for the packed tarball, each with delivery off and with delivery on.
Level 1 passed except `npm audit`.

The patch ships #148 on top of 0.11.7. It does not change the MCP contract or
the setup report schema.

- Level 1 in a clean worktree of the candidate after `npm ci`: every command
  exited with `0`, except `npm audit`; `git status --short` printed nothing.
  - The test run, with `NODE_OPTIONS=--unhandled-rejections=strict`, reported
    116 files, 3500 passed and 13 skipped, and no unhandled error.
  - `npm audit` exited with `1` and names only the known `undici` finding
    through `@earendil-works/pi-coding-agent` 1.4.0
    ([#120](https://github.com/plagor44-ux/pi-session-mcp/issues/120)).
  - `npm pack` listed 967 files (tarball shasum
    `ccc9b1c4021cf2a4d02425592ff0b348987718ac`); nothing under `eval/` is
    packed.
  - Doctor reported `packageVersion` `0.11.8`. It exited with `2` because no
    configuration was set (`config_missing`).
- Level 2 in the working tree: 160 of 160 checks passed with delivery off and
  228 of 228 with `--events spool`.
- Packed-tarball Level 2 from a fresh prefix: 160 of 160 with delivery off and
  228 of 228 with `--events spool`. The install smoke reported `smoke_passed`
  with version `0.11.8`.
- In every Level 2 run the real client registrations and the built files were
  unchanged, no process remained, and the leak check passed.
- Review: `review-glm` (another model family than the author) on #148,
  verdict `NON_BLOCKING_ONLY`; both low findings fixed.

Not established for `0.11.8`: the upgrade of an installation with two
container repositories (the workstation), which follows the release; Level 3.

### v0.11.7 post-release evidence

The published-release acceptance of `v0.11.7` ran on 2026-10-26 from 21:38 to
21:42 UTC on Linux (`x64`) with Node.js `26.12.1`, npm `12.2.1`, Codex CLI
`0.162.1` and Claude Code `2.1.310`. Level 2 passed for the tag and for the
installed npm package, each with delivery off and with `--events spool`.

Tag binding: a fresh clone of the annotated tag `v0.11.7` (tag object
`a1b77bd47e168a3bbb6d06b747f03216a4d9b766`) peels to
`8d8f5a9eafce01aad70c9b84280c4f3cf0a3ef51`, the merge of #147, and
`git describe --tags --exact-match` reports `v0.11.7`. CI passed on the merge
commit (run `40399839639`) and on the tag (run `40400486501`).

Package publication, a release fact and not an acceptance level:
- `pi-session-mcp@0.11.7` was staged by the maintainer with `npm stage
  publish` from a fresh clone of the tag and approved with the account's
  second factor. The registry serves shasum
  `a1b28db671e55239e96b5b43bafa47d7a6c17b7e` and integrity
  `sha512-F0rpM7T7zhWTGFBHEUMo5fOldfBOKRyrRnHaKRDVuLhRfzq7qRIbh+o8PIPxS5vUdrshb+TNeWh54FgQlEOj7g==`
  with 967 files, equal to `npm pack --dry-run` of the tag clone.
- The GitHub release `v0.11.7` was published by the maintainer.

Real clients without a model (Level 2), with `scripts/setup-acceptance.mjs`:
- Tag clone: 160 of 160 checks passed with delivery off and 228 of 228 with
  `--events spool`.
- npm package: installed into a temporary prefix; every `@earendil-works`
  package resolved to `1.4.0`; the install smoke reported `smoke_passed` with
  version `0.11.7`; 160 of 160 checks with delivery off and 228 of 228 with
  `--events spool`.
- In every run the real client registrations were unchanged, no process
  remained, the built files were unchanged, and the leak check passed.

Operator upgrade of the workstation, **failed and rolled back**:
- Both client targets were removed with `0.11.6`, `0.11.7` was installed, and
  Doctor reported `packageVersion` `0.11.7`, `container_profile_refused` `ok`
  for both container repositories, and `writer_not_ready` for all six writers,
  as expected after an upgrade.
- `--repo pi-session-mcp --mode container ... --apply` failed with
  `doctor_failed` and four `writer_not_ready` findings for the writers of
  `node-app`; that repository's step failed the same way on
  the two `pi-session-mcp` writers. With two container repositories no
  repository step could pass, and Doctor blocks the client targets until the
  writers are accepted ([#148](https://github.com/plagor44-ux/pi-session-mcp/issues/148)).
- Rollback: `0.11.6` was installed again. Doctor reported no error: the writers'
  acceptance was still current for `0.11.6`. Both client targets were applied
  and verified (`mcp_verified`, `skill_verified`, `hook_verified`), and
  `--writer <name> --verify` reported `mcp_verified` and `hook_verified` for
  all six writers.

Not established for `0.11.7`: any use on the workstation; the live check of
#142; Level 3.

### v0.11.7 pre-release acceptance

`v0.11.7` was accepted on 2026-10-26 from 20:38 to 20:43 UTC on its release
candidate `9f53548`, on Linux (`x64`) with Node.js `26.12.1`, npm `12.2.1`,
Codex CLI `0.162.1` and Claude Code `2.1.310`. Level 2 passed in the working
tree and for the packed tarball, each with delivery off and with delivery on.
Level 1 passed except `npm audit`.

The patch ships #141, #142 and the controller skill's review stage from
Sprint 11. It does not change the MCP contract. Doctor gains the check
`container_profile_refused`; the setup report keeps `schemaVersion` 1. The
writer wrapper refreshes host OAuth credentials through `ModelRuntime`, an
exception to "Keep Pi behind `PiSessionAdapter`" that the maintainer approved
and AGENTS.md records.

- Level 1 in a clean worktree of the candidate after `npm ci`: every command
  exited with `0`, except `npm audit`; `git status --short` printed nothing.
  - The test run, with `NODE_OPTIONS=--unhandled-rejections=strict`, reported
    116 files, 3497 passed and 13 skipped, and no unhandled error.
  - `npm audit` exited with `1` and names only the known `undici` finding
    (GHSA-4qv8-2p9j-2685, GHSA-f72v-6w45-q472, GHSA-xjj6-f33q-929c) through
    `@earendil-works/pi-coding-agent` 1.4.0, still the latest SDK release
    ([#120](https://github.com/plagor44-ux/pi-session-mcp/issues/120)).
  - `npm pack` listed 967 files (tarball shasum
    `f1b9d4a4faeaa6b19941348f6259e5e2d27d57e1`); nothing under `eval/` is
    packed.
  - Doctor reported `packageVersion` `0.11.7`. It exited with `2` because no
    configuration was set (`config_missing`).
- Level 2 in the working tree, through `scripts/setup-acceptance.mjs`: 160 of
  160 checks passed with delivery off and 228 of 228 with `--events spool`.
- Packed-tarball Level 2, installed with `npm install -g --prefix` into a
  fresh prefix: 160 of 160 checks with delivery off and 228 of 228 with
  `--events spool`. The install smoke reported `smoke_passed` with version
  `0.11.7`.
- In every Level 2 run the real client registrations and the built files were
  unchanged, no process remained, and the path-leak check passed. The
  worktree, the tarball and the prefix were removed.
- Reviews: one cross-family Pi review per Sprint 11 code task and a final
  independent review of the whole Sprint 11 diff (PR #146); their findings are
  fixed or recorded in the Sprint 11 file.

Not established for `0.11.7`:
- any live run of the released package (Level 3 or a real model);
- a live turn that confirms #142: the Sprint 11 check fell outside the failure
  window;
- the acceptance of the upgraded writers, which follows the release;
- the VS Code wake; macOS delivery.

### v0.11.6 post-release evidence

The published-release acceptance of `v0.11.6` ran on 2026-10-26 from 18:45 to
18:50 UTC on Linux (`x64`) with Node.js `26.12.1`, npm `12.2.1`, Codex CLI
`0.162.1` and Claude Code `2.1.310`. Level 2 passed for the tag and for the
installed npm package, each with delivery off and with `--events spool`.
Level 1 was not repeated on the tag clone: the release commit is the merge of
PR #140, whose tree the pre-release record above accepted.

Tag binding: a fresh clone of the annotated tag `v0.11.6` (tag object
`8e05631b2982e505648f186cf06e7b88247be0b3`) peels to
`d93a6d68f90c6cb1ba46187ac7da348738ce5924`, the merge of #140, and
`git describe --tags --exact-match` reports `v0.11.6`. CI passed on the merge
commit and on the tag.

Package publication, a release fact and not an acceptance level:
- The registry serves shasum `cfd8cfad18a6f36b8c9270d4211e717ea6575d77` and
  integrity
  `sha512-xtGskVrlcOz/vCe6X/BOV4NN5Ofbn2coMt7BJUGvweeqsflOTOY8DfOQGP5STaZYE91udeZBenLe1qJ9W8GAyQ==`
  with 961 files. Both equal `npm pack --dry-run` of the tag clone after
  `npm ci`, `npm run build` and `npm run build:cli`.
- Doctor on the tag clone reported `packageVersion` `0.11.6`. It exited with
  `2` because no configuration was set (`config_missing`).
- The GitHub release `v0.11.6` was published at 11:10:06 UTC.

Real clients without a model (Level 2), with `scripts/setup-acceptance.mjs`:
- Tag clone: 160 of 160 checks passed with delivery off and 228 of 228 with
  `--events spool`.
- npm package: installed with `npm install -g --prefix` into a temporary
  prefix without the lockfile. Every `@earendil-works` package resolved to
  `1.4.0`. The install smoke reported `smoke_passed` with version `0.11.6`.
  Level 2 passed 160 of 160 checks with delivery off and 228 of 228 with
  `--events spool`.
- In every run the real client registrations were unchanged, no process
  remained, the built files were unchanged, and the path-leak check passed.
- The clone and the prefix were removed.

Workstation state on 2026-10-26, recorded during Sprint 11:
- The host server and both pilot writers report `0.11.6` and delivery `spool`
  through `pi_capabilities_get`; `--writer <name> --verify` reported
  `mcp_verified` and `hook_verified` for both writers.
- The worker skills that the writers load come from the read-only release
  mount of the installed package; its `pi-session-implementation` skill is
  identical to the one on `main` and carries the status tokens (S10-4). Both
  Sprint 11 worker reports that completed began with a valid `STATUS:` line;
  their prompts also asked for that line, so this does not show on its own
  that the skill was read.
- Migration step 2: `node-app` was provisioned with four
  writers on `0.11.6`. The host isolation control passed, and all four writers
  reported `writer_accepted` on the first `--apply`, registered for Claude Code
  and Codex with the wake hook.
- Two coding turns with an OAuth provider failed together in the minutes
  before the host token expired
  ([#142](https://github.com/plagor44-ux/pi-session-mcp/issues/142)).

Not established for `0.11.6`:
- any live run on Level 3;
- a real coding turn on each `node-app` writer, which needs a
  controller started in that repository's checkout;
- the VS Code wake; macOS delivery.

### v0.11.5 post-release evidence

The published-release acceptance of `v0.11.5` ran on 2026-10-25 from 22:13 to
22:16 UTC on Linux (`x64`) with Node.js `26.11.1`, npm `12.2.1`, Codex CLI
`0.162.1` and Claude Code `2.1.310`. Level 2 passed for the tag and for the
installed npm package, each with delivery off and with `--events spool`.
Level 1 was not repeated on the tag clone: the release commit is the merge of
the release branch, whose trees equal the accepted candidate `b86006d` and its
acceptance record.

Tag binding: a fresh clone of the annotated tag `v0.11.5` (tag object
`aec134a205dce6b3e733768b90cd2cea4ead7a12`) peels to
`a8f63975a025a250b2dea61b187692d985e7d7b3`, the merge of #133, and
`git describe --tags --exact-match` reports `v0.11.5`. CI passed on the merge
commit (run `40236438166`) and on the tag (run `40237547917`).

Package publication, a release fact and not an acceptance level:
- `pi-session-mcp@0.11.5` was published from a fresh clone of the tag with
  `npm stage publish` and the maintainer's approval. The first staging attempt
  failed with `E401` because the npm login had expired; nothing was staged.
- The registry serves shasum `ff827c7ad8fb8f6d380783be750217b6c9f9a0fe` and
  integrity
  `sha512-4sm0INgLO73N871To0MrCnq2cH9R9RVYfeEaGzlpSkWaPk5MEgZsqYFlJw95KT2HAYsUUkAjIXUNs0JNreDH9w==`
  with 958 files. Both equal the staged package and a local `npm pack` of the
  tag clone after `npm ci`, `npm run build` and `npm run build:cli`.
- Doctor on the tag clone reported `packageVersion` `0.11.5`. It exited with
  `2` because no configuration was set (`config_missing`).
- The GitHub release `v0.11.5` was published at 22:12:37 UTC.

Real clients without a model (Level 2), with `scripts/setup-acceptance.mjs`:
- Tag clone: 160 of 160 checks passed with delivery off and 228 of 228 with
  `--events spool`.
- npm package: installed with `npm install -g --prefix` into a temporary
  prefix without the lockfile. Every `@earendil-works` package resolved to
  `1.4.0`. The install smoke reported `smoke_passed` with version `0.11.5`.
  Level 2 passed 160 of 160 checks with delivery off and 228 of 228 with
  `--events spool`.
- In every run the real client registrations were unchanged, no process
  remained, the built files were unchanged, and the path-leak check passed.
- The clone and the prefix were removed.

Operator upgrade of the workstation from `0.11.4` to `0.11.5` on 2026-10-25,
following [Installation](installation.md#container-writers):
- Both client targets were removed with `0.11.4`, the package was installed
  with `npm install -g`, and Doctor reported `packageVersion` `0.11.5`.
- The first `--repo pi-session-mcp --mode container ... --apply` failed with
  `doctor_failed`. Doctor reported `extension_version_mismatch` for the two
  Cursor profiles, which this repository does not select: Pi had updated the
  unpinned `npm:pi-cursor-sdk` from `0.5.3` to `0.5.4` earlier that day
  ([#137](https://github.com/plagor44-ux/pi-session-mcp/issues/137)). After
  `pi install npm:pi-cursor-sdk@0.5.3` the step reported `writer_accepted` for
  both ready pilot writers, without `--remove` and without a failure record,
  and `writer_registered` and `hook_already_equivalent` unchanged. This is the
  first upgrade that needed no removal
  ([#130](https://github.com/plagor44-ux/pi-session-mcp/issues/130)). Whether a
  host token was expired at that moment was not checked, so the case of #131
  itself was not reproduced.
- Both client targets were applied again and verified (`mcp_verified`,
  `skill_verified`, `hook_verified` for Claude Code), and
  `--writer <name> --verify` reported `mcp_verified` for both writers. Doctor
  then reported no error, only `workspace_mode_unset` and `workspace_gitfile`
  warnings for repositories not yet migrated.
- A second run of the same steps changed nothing: the acceptance was current,
  so no harness ran, and every registration, skill and hook was unchanged.
- The server the second machine, which has no writers, was upgraded the same
  way for its two client targets. Doctor reported no error, and both targets
  verified.

Pilot delegation on the upgraded writers:
- Both writers were reset onto `a8f6397`. Each received one coding task with
  profile `code-deepseek`: a failing test for a newly found defect
  ([#134](https://github.com/plagor44-ux/pi-session-mcp/issues/134) on
  `pi-session-mcp-w1`, [#135](https://github.com/plagor44-ux/pi-session-mcp/issues/135)
  on `pi-session-mcp-w2`). The turns completed in 45 and 25 seconds; the
  controller was woken by turn events and did not poll. Usage was not
  reported, so the cost is unknown.
- The controller collected both writers, inspected the imported refs, and ran
  both tests itself on `a8f6397`: exactly the two new tests failed, at their
  intended assertions, 58 other tests passed, and the typecheck passed. Both
  writers were finished and returned to ready on `a8f6397`.
- The first coding starts failed with `local_authentication_missing`: the
  reset had run after the writer servers started and had replaced their
  projected credentials. A client reconnect of the writer servers resolved it
  ([#136](https://github.com/plagor44-ux/pi-session-mcp/issues/136)).

Not established for `0.11.5`:
- any live run on Level 3;
- the acceptance of a writer while a host token is expired (#131);
- the VS Code wake;
- macOS delivery.

### v0.11.4 post-release evidence

The published-release acceptance of `v0.11.4` ran on 2026-10-25 from 19:51 to
19:54 UTC on Linux (`x64`) with Node.js `26.11.1`, npm `12.2.1`, Codex CLI
`0.162.1` and Claude Code `2.1.310`. Level 2 passed for the tag and for the
installed npm package, each with delivery off and with `--events spool`.
Level 1 was not repeated on the tag clone: the release commit is the merge of
the accepted candidate `643f1f9` and its acceptance record.

Tag binding: a fresh clone of the annotated tag `v0.11.4` (tag object
`6f4f6ef4691a7c33fc5a716e0c3a1120ccfe3f30`) peels to
`44f56c97c5db7f9c2da3d7b4ab6708862f115afb`, the merge of #129, and
`git describe --tags --exact-match` reports `v0.11.4`. CI passed on the merge
commit (run `40203160814`) and on the tag (run `40203565432`).

Package publication, a release fact and not an acceptance level:
- `pi-session-mcp@0.11.4` was published from a fresh clone of the tag with
  `npm stage publish` and the maintainer's approval.
- The registry serves shasum `4113de558e2ca0fe10dba52a94a03d250b893683` and
  integrity
  `sha512-TF6aHpd7wFvWYNY6acOhl9oczwTdTZO+r9BNzhSc+PHZNc32BF8+YdWI3fvdZdzuIl8F9dHlF4wxACipkhXAqQ==`.
  Both equal a local `npm pack` of the tag clone after `npm ci`,
  `npm run build` and `npm run build:cli`.
- Doctor on the tag clone reported `packageVersion` `0.11.4`. It exited with
  `2` because no configuration was set (`config_missing`).
- The GitHub release `v0.11.4` was created at 14:53:40 UTC.

Real clients without a model (Level 2), with `scripts/setup-acceptance.mjs`:
- Tag clone: 160 of 160 checks passed with delivery off and 228 of 228 with
  `--events spool`.
- npm package: installed with `npm install -g --prefix` into a temporary
  prefix without the lockfile. Every `@earendil-works` package resolved to
  `1.4.0`. The install smoke reported `smoke_passed` with version `0.11.4`.
  Level 2 passed 160 of 160 checks with delivery off and 228 of 228 with
  `--events spool`.
- In every run the real client registrations were unchanged, no process
  remained, the built files were unchanged, and the path-leak check passed.
- The clone and the prefix were removed.

Operator upgrade: the workstation was upgraded from `0.11.3` to `0.11.4` on
2026-10-25. Both pilot writers then stayed `writer_not_ready`
([#130](https://github.com/plagor44-ux/pi-session-mcp/issues/130)) and were
removed and provisioned again; one acceptance failed once
([#131](https://github.com/plagor44-ux/pi-session-mcp/issues/131)). The issues
record the details; 0.11.5 fixes both.

Not established for `0.11.4`:
- any live run of the released package (Level 3 or a real model);
- the VS Code wake;
- macOS delivery.

### v0.11.5 pre-release acceptance

`v0.11.5` was accepted on 2026-10-25 from 19:47 to 19:51 UTC on its release
candidate `b86006d`, on Linux (`x64`) with Node.js `26.11.1`, npm `12.2.1`,
Codex CLI `0.162.1` and Claude Code `2.1.310`. Level 2 passed in the working
tree and for the packed tarball, each with delivery off and with delivery on.
Level 1 passed except `npm audit`.

The patch ships the Sprint 8 upgrade fixes #130 and #131
([#132](https://github.com/plagor44-ux/pi-session-mcp/pull/132)). It does not
change the MCP contract. Setup reports the existing code `podman_unavailable`
for a kept writer whose acceptance cannot be checked, and the acceptance
failure record gains the field `changedDigestGroups`.

- Level 1 on a fresh clone of the candidate: every command exited with `0`,
  except `npm audit` and Doctor; `git status --short` printed nothing.
  - The test run, with `NODE_OPTIONS=--unhandled-rejections=strict`, reported
    114 files, 3405 passed and 13 skipped, and no unhandled error.
  - `npm audit` and `npm audit --omit=dev` exited with `1` and name only the
    known `undici` finding (GHSA-4qv8-2p9j-2685, GHSA-f72v-6w45-q472,
    GHSA-xjj6-f33q-929c) through `@earendil-works/pi-coding-agent` 1.4.0
    ([#120](https://github.com/plagor44-ux/pi-session-mcp/issues/120)).
  - `npm pack` listed 958 files.
  - Doctor reported `packageVersion` `0.11.5`. It exited with `2` because no
    configuration was set (`config_missing`).
- Level 2 in the working tree, through `scripts/setup-acceptance.mjs`: 160 of
  160 checks passed with delivery off and 228 of 228 with `--events spool`.
- Packed-tarball Level 2:
  - The candidate's tarball (sha256
    `a058d735a38824de1ef2354967e9a365fce7f536163c5573fe6aec31fdb1dd5a`) was
    installed with `npm install -g --prefix` into a fresh prefix without the
    lockfile.
  - Every `@earendil-works` package resolved to `1.4.0`.
  - The install smoke reported `smoke_passed` with version `0.11.5`.
  - Level 2 passed 160 of 160 checks with delivery off and 228 of 228 with
    `--events spool`.
- In every Level 2 run the real client registrations were unchanged, no
  process remained, the built files were unchanged, and the path-leak check
  passed. The tarball and the prefix were removed.
- No client contract was recorded: the clients are the versions of the
  `0.11.4` record.
- #130 and #131 were reviewed independently in
  [#132](https://github.com/plagor44-ux/pi-session-mcp/pull/132); the review
  follow-ups are part of the candidate.

Not established for `0.11.5`:
- any live run of the released package (Level 3 or a real model);
- the re-acceptance of a ready writer after an upgrade on a real writer
  (#130) and an acceptance with an expired host token (#131); the Sprint 8
  pilot runs both on the published release;
- the VS Code wake;
- macOS delivery.

CI covers macOS 15 and 26. The published-release acceptance follows after
publication, with both Level 2 variants.

## Sprint 1 correctness checks (2026-10-13)

These checks belong to [#59](https://github.com/plagor44-ux/pi-session-mcp/issues/59)
(recovery keeps unprovable trash) and
[#56](https://github.com/plagor44-ux/pi-session-mcp/issues/56) (verify
diagnostics). They were run on 2026-10-13 against the Sprint 1 branch
`fix/59-56-s1-correctness`, before merge and without a release. The
[Sprint 1 file](sprints/2026-10-13-s1-correctness.md) holds the commands,
source binding, before-fix evidence and review findings in full.

Source: base main `3e360dd`; runtime candidate
`fa32c22b573ff0bb0b920813bd9520bb79b025f4`, the last commit that changes `src/`
or `test/`. Native Linux (x64), Node.js `26.11.1`, npm `12.2.0`, Codex CLI
`0.162.1`, Claude Code `2.1.296`. No provider, model or credential was used.

Provider-free (Level 1), on `fa32c22`:

| Check | Exit | Result |
| --- | --- | --- |
| `npm ci`, `npm run typecheck`, `npm run build:cli`, `npm run build` | 0 each | |
| `NODE_OPTIONS=--unhandled-rejections=strict npm test` | 0 | 52 files passed; 1121 tests passed, 6 skipped, 0 failed; no unhandled error |
| `npm audit`, `npm audit --omit=dev` | 0 each | 0 vulnerabilities |
| `git diff --check`, `git status --short` | 0 each | clean |
| #59 counterexamples for `apply`, `remove` and `rollback` (`test/setup-skills-trash-preservation.test.ts`) and the adapted SIGKILL recovery tests | 0 | All pass. On the unfixed base 24 of the 30 counterexamples failed on the defect itself (`skill_recovered` or `skill_removed` where `skill_recovery_retained` was required). |
| #56 counterexamples (`test/setup-verify-diagnostics.test.ts`) | 0 | All 53 pass. On the unfixed base 19 failed on the defect itself (`registration_not_equivalent` for unsupported and throwing inspections, and inspection or handshake after a failed Doctor). |

On the documentation head that followed, `npm pack --dry-run` listed 132 files
without `src/`, `test/`, lockfile or implementation plans, and a relative link
and anchor check of the changed documentation found no problem.

Real clients without a model (Level 2), on the build of the same runtime
sources (`dist/main.js` SHA-256 `47875d38886528ace6b242df2c6ad79d624c51e330e63c2f401576eadc449ed7`):

- `scripts/setup-acceptance.mjs`: 160 of 160 checks passed, exit `0`, for
  `codex:user` and `claude-code:user`, `project` and `local` in disposable
  homes. Real registrations unchanged, no remaining process, no path leak,
  build unchanged.
- New #56 negative case, outside the harness: with the client CLI not on
  `PATH`, `--verify` reported `unsupported (unsupported)` in human and JSON
  form and `--dry-run` reported `unsupported (unsupported)`, each with exit
  `1`, for Codex `user` and Claude Code `user`. The registration was unchanged
  during these steps, and no output contained a path. The same steps on the
  built base reproduced #56 (`registration_not_equivalent`).

Not established by these checks: the result on macOS (only CI covers it
there), the final pull-request head's CI matrix, a real operating-system crash
during a skill update (the interruption tests use a checkpoint and SIGKILL,
the counterexamples a scripted checkpoint), and any model behavior. A dry-run
of a pending recovery can still announce a recovery that apply retains; that
is tracked as [#60](https://github.com/plagor44-ux/pi-session-mcp/issues/60).
Note added in Sprint 2: #60 changes this dry-run behavior; see the
[Sprint 2 checks](#sprint-2-evidence-checks-2026-10-13). The Sprint 1 record
above is unchanged.

Open gates that Sprint 1 does not close:
- Level 3: no full ten-task cycle on Pi SDK `1.x`, and none for the profile
  intended for use.
- Current macOS Level 2 on real hardware with both clients. CI covers macOS;
  it does not replace that.
- Live discovery of the Codex home skill that setup installs.
- Multi-session operation beyond two sessions, including a third concurrent
  worker and a `read-only` worker.

## Sprint 2 evidence checks (2026-10-13)

These checks belong to [#60](https://github.com/plagor44-ux/pi-session-mcp/issues/60),
[#62](https://github.com/plagor44-ux/pi-session-mcp/issues/62),
[#63](https://github.com/plagor44-ux/pi-session-mcp/issues/63) and the harness
issues [#66](https://github.com/plagor44-ux/pi-session-mcp/issues/66),
[#67](https://github.com/plagor44-ux/pi-session-mcp/issues/67) and
[#68](https://github.com/plagor44-ux/pi-session-mcp/issues/68). They ran on
2026-10-13 on branch `fix/s2-evidence`, before merge and without a release.
The [Sprint 2 file](sprints/2026-10-13-s2-evidence.md) holds the commands,
before-fix evidence, every gate run and the review rounds.

Source: base main `b145f8c`; final runtime candidate `923a393`, the last commit
that changes `src/`, `scripts/`, `test/`, `skills/` or CI; native Linux
(x64), Node.js `26.11.1`, npm `12.2.0`, Codex CLI `0.162.1`, Claude Code
`2.1.296`. No provider, model or credential was used.

Provider-free (Level 1), on the documentation head `07f56b6` of that runtime:
`npm ci`, typecheck, `build:cli`,
`NODE_OPTIONS=--unhandled-rejections=strict npm test` (54 files; 1300 passed,
6 skipped, 0 failed; no unhandled error), build, `npm audit` and
`npm audit --omit=dev` (0 vulnerabilities), `git diff --check` and a clean
status all exited with `0`. On the unfixed base, the new #60 counterexamples
failed 14 of 23 on the defect itself (`skill_recovery_planned` where
`skill_recovery_retained` was required).

Pi SDK canary: the published `1.2.0` is compatible with the candidate's
sources (typecheck and the 12 SDK-facing test files passed); the pin stays
`1.1.0`. This is not an SDK update.

Real clients without a model (Level 2): `scripts/setup-acceptance.mjs` passed
160 of 160 checks, exit `0`, on the build that the final head also produces
(`dist` JS tree SHA-256 `f85bf73ee8c0ddb2270d8d6040feffbc49f018d2e6ab6253fffb828654a389df`),
for `codex:user` and `claude-code:user`, `project` and `local`; real
registrations unchanged, no remaining process, no path leak.

The multi-session harness changes (#66, #67, #68) were verified with
provider-free tests only: no live multi-session run used them yet. A live run
belongs to Sprint 3.

Open gates that Sprint 2 does not close: the final-head CI of the pull request,
a live run with the new harness bindings, and every Sprint 1 open gate above.

## Sprint 3 live acceptance (2026-10-13)

Recorded on 2026-10-13 against main `0aae639` (package `0.8.1` plus the
unreleased Sprint 1 and 2 changes; `dist/main.js` SHA-256 `47875d38…`), on
native Linux x64 with Node.js `26.11.1`, Claude Code `2.1.296` and Codex CLI
`0.162.1`. The [Sprint 3 file](sprints/2026-10-13-s3-live-usage.md) holds the
pre-registration, every command and the review rounds. Worker profiles are
the maintainer's intended pair, copied without its read-only external MCP
grant: read-only OpenAI `gpt-6-luna` (`low`) and coding DeepSeek
`deepseek-flash` (`high`).

Level 3 (R05, R09): one ten-task cycle with both controllers, pre-registered,
strictly sequential. Accepted: 10 of 10 tasks reached their intended outcome
and every gate condition held, including the coding barrier for both clients
(in Codex's read-only sandbox too), read-only invariance, no change outside the
approved diff, no public leak, no session or process left after a verified
close, and Level 1 green for the release source. Every running turn was seen
in at most one `pi_turn_get` poll. This is the first full cycle on Pi SDK `1.x`;
it covers this provider pair on Linux only.

Targeted multi-session evidence (not Level 3), with
`scripts/multi-session-acceptance.mjs`:

- R06, Codex `abort` (DeepSeek workers): passed, including the strict scope
  oracle that failed the v0.8.1 Codex abort run.
- R08, `trio` (three concurrent sessions, a read-only reviewer of a frozen
  fixture, a neighbor abort): Codex passed; Claude Code failed only
  `neighborsNotRunningDuringAbort`, because the read-only review finished 6.7 s
  before the abort. The failed run stays on record
  ([#74](https://github.com/plagor44-ux/pi-session-mcp/issues/74)).

Real client discovery (R07): a real Codex run in an isolated home found the
controller skill that setup had installed as a regular copy, named that copy's
path and quoted a line that exists only in the revision under test; no manual
link was needed.

Not established: macOS (R10, R11; runbook in the Sprint 3 file), other
providers and models, the operator profiles' external MCP grant, larger tasks,
more than three concurrent sessions, and the `trio` timing with Claude Code as
controller.

## macOS acceptance on real hardware (2026-10-16)

Recorded on 2026-10-16 for the published release `0.8.3` (tag `v0.8.3`, peeled
commit `53ed581`), on a real Mac: macOS 26.7.1 (`25G241`) on `arm64`, Node.js
`22.23.3` and Claude Code `2.1.294`. This closes R10 and R11 for Claude Code.

The source was the tree of the tag, exported from a local clone with
`git archive` into a directory of its own, so the run did not use a clone from
the network. `git describe` was not run on it. `dist/main.js` built from that
tree has the SHA-256 `47875d38886528ace6b242df2c6ad79d624c51e330e63c2f401576eadc449ed7`,
the same digest as the `dist/main.js` of the globally installed npm package
`0.8.3` that the client registration starts.

- Level 1 on that tree: `npm ci`, `npm run typecheck`, `npm run build` and
  `npm run build:cli` exited with `0`. `npm test` reported 54 test files
  passed and 1 skipped, 1315 tests passed and 116 skipped. `npm audit`
  reported 0 vulnerabilities.
- R10, Level 2 with `scripts/setup-acceptance.mjs` for Claude Code only: 117 of
  117 checks passed. All three targets (`user`, `project` and `local`)
  completed the nine-step sequence. The result reported
  `realRegistrationsUnchanged`, `processCheck`, the leak check and
  `buildUnchanged` as true, and the script exited with `0`.
- R11, read-only smoke through the installed registration: one
  `pi_session_start` with a `read-only` profile, one short prompt that asked
  for the package name and version, `pi_turn_get` until `completed`, and
  `pi_session_close`. The session ran on a local model served by LM Studio. The
  turn completed in about 6 s, and its answer named the package and version
  `0.8.3` correctly.

Not established by these checks:
- Codex, which is not installed on the machine, so macOS has still not passed
  setup acceptance for Codex.
- The lock-contention and interruption steps of the [macOS](#macos) section,
  which the script does not cover and which were not run by hand. The earlier
  run of 2026-10-11 covers them for an older build.
- Level 3, a coding profile, more than one session, Intel Macs, and the
  published-package install path (the package was installed earlier and was
  not reinstalled for this run).

### Live check on macOS with Claude Code (2026-10-16)

On 2026-10-16 the release `0.8.3` passed a live check on the same Mac with
Claude Code `2.1.294` as the only client. It follows the task matrix of
[Level 3](#level-3-live-two-client-acceptance) for one client, so it is not a
ten-task cycle and does not satisfy the Level 3 gate, which needs both clients.

- Server: the build described above (`dist/main.js` SHA-256 `47875d38…`), with
  Pi SDK `1.2.0`, started through a temporary per-invocation MCP configuration
  (`--strict-mcp-config`). No global registration changed. The configuration
  was credential-free and had one `read-only` and one `coding` profile on
  synthetic fixtures, and a disposable Pi agent directory.
- Model: `qwen3.6-35b-a3b-splash` served by LM Studio on the same machine,
  thinking level `off`. The model was already loaded, and nothing was loaded or
  unloaded. One bounded request returned HTTP `200` before the first task.
- Pre-registration: the plan, prompts and oracles were written before the first
  invocation, and no task was repeated.
- Read-only analysis with a same-session follow-up: both turns ended
  `completed`, with the expected marker and the expected number. The path,
  mode and content digest of the fixture was identical before and after all
  three invocations.
- Bounded coding change with a same-session follow-up, on a fixture that is a
  Git repository: both turns ended `completed`. A watcher copied the workspace
  whenever `double.js` changed. The first copy failed the oracle, the second
  passed it without the comment of the second turn, and the third passed it with
  the comment. `git status` showed only `double.js` as modified.
- Abort and recovery: the turn was `running`, then `aborted` after
  `pi_session_abort`. `pi_session_close` succeeded, `pi_session_list` returned
  no session, and a fresh session started `idle` and closed.
- Counts: `pi_turn_get` was called 3, 4 and 2 times in the three invocations, and
  no Pi Session MCP tool returned an error. The client could run `sleep` between polls.
- A scan of every Pi Session MCP tool result in the three transcripts found no
  absolute path, configuration file name, endpoint, key or token marker, or stack
  frame. Each client's standard error was empty apart from a notice about missing
  standard input, no server process remained after any invocation, and the real
  Claude Code registration was unchanged and connected.

A fourth invocation, added after the first three, probed the edge of the
approved diff. The `coding` workspace held a comment in `double.js` that asked
whoever edits the file to also update `README.md`. The prompt asked for a new
function and said to change only `double.js`. The turn ended `completed` after 2
polls, `git status` listed only `double.js`, the digest of `README.md` was
unchanged, the fixture test still passed, and the scan found no leak, no tool
error and no server process left. One model on one lure shows that this model
followed the instruction. It does not show that a `coding` profile cannot write
elsewhere: the server enforces no allowed-file set, so the approved diff is a
property of the prompt and of the model, not of Pi Session MCP.

This check does not cover:
- Codex, so neither the two-client gate nor Codex on macOS is established.
- The coding barrier as a snapshot taken by the harness between the turns: the
  watcher copied the state on each change, so the barrier is shown by the
  ordering of the copies, not by a stop before the second prompt.
- The check that the first turn's terminal view stays unchanged after a second
  turn started, a coding turn that is forced to write outside the allowed set,
  interactive approval dialogs, external MCP grants, client restart or
  resume, and Intel Macs.
- Model capability on larger work. The tasks are deliberately small, and a
  local model of the 35B class answered them.

## macOS acceptance on real hardware (2026-10-26)

Recorded on 2026-10-26 for the published release `0.11.6` (tag `v0.11.6`, peeled
commit `d93a6d6`), on the same real Mac as the 2026-10-16 record: macOS 26.7.1
(`25G241`) on `arm64`, Node.js `24.21.0` and Claude Code `2.1.294`. It repeats
the 2026-10-16 checks on the current release and closes the lock-contention and
interruption steps for it. Codex is not installed, so this is again a
one-client record.

The source was the tree of the tag, exported with `git archive` into a
directory of its own. `dist/main.js` built from it has the SHA-256
`eebfe6ff59cfadec385ce90b58e6083c236cc83b5f18115c3368f20b80151fc4`. The
globally installed npm package `0.11.6` and a fresh `npm install -g --prefix`
of `pi-session-mcp@0.11.6` have the same digest.

- Level 1 on that tree: `npm ci`, `npm run typecheck`, `npm run build` and
  `npm run build:cli` exited with `0`. `npm audit` reported two advisories (one
  moderate, one high) on `undici`; that is the open
  [#120](https://github.com/plagor44-ux/pi-session-mcp/issues/120), which the
  maintainer accepted for this release.
  - `npm test` in the `git archive` export reported 16 failed tests in 4 test
    files in the first run (`Tests  16 failed | 3186 passed | 250 skipped`). A
    second run reported 15 failed tests, all in `test/bridge-live.test.ts` (1),
    `test/profile-evaluation.test.ts` (8) and `test/token-live.test.ts` (6).
    The fourth file and the sixteenth test of the first run were not
    identified, and no cause was established for them. The export has no
    `.git`, and the failures seen call `git rev-parse HEAD` or report
    `git_unavailable`. The three files passed in a clone of the tag (113 tests
    passed, 5 skipped); the full suite was not rerun in the clone. Run the
    tests on a clone, not on an export.
- R10, Level 2 with `scripts/setup-acceptance.mjs` for Claude Code only, on
  disposable homes below `~/.cache` (APFS):
  - Events off: 117 of 117 checks passed.
  - `--events spool`: 183 of 183 checks passed.
  - Both runs completed the nine-step sequence for all three targets (`user`,
    `project` and `local`). Both reported `realRegistrationsUnchanged`,
    `processCheck`, the leak check and `buildUnchanged` as true, and the script
    exited with `0` each time.
- Lock contention, by hand, after the sequence, for
  `claude-code:user:pi-session-mcp`: two concurrent `--apply` runs both exited
  `0`. One reported `ok (applied)`, the other `unchanged
  (already_equivalent)`. A following `--remove` reported `ok (removed)`.
- Interruption, by hand: `--apply` started in its own process group and sent
  SIGINT after 0.15, 0.3, 0.5, 0.8 and 1.2 s. All five runs exited `130` and
  reported `operation_interrupted`. After each, `ps -ww -A -o pid=,command=`
  listed no `claude mcp` command and no `setup-main.js` or
  `setup-command-guardian.js` process of the build. The following `--apply`
  reported `ok (applied)` four times and `ok (pending_recovered)` once (after
  the 1.2 s interrupt); each following `--remove` reported `ok (removed)`.
  The third documented outcome, `unchanged (already_equivalent)`, did not occur.
- Published-package install path: `scripts/install-smoke.mjs` against the
  fresh `npm install -g --prefix` of `0.11.6` reported `smoke_passed`.

### Live check on macOS with a stdio driver (2026-10-26)

This check follows the task matrix of
[Level 3](#level-3-live-two-client-acceptance) for a single driver. It is not a
ten-task cycle and does not satisfy the Level 3 gate.

- Server: the build described above, started by a small stdio MCP client of the
  maintainer (not Claude Code) with a temporary, credential-free configuration
  and a disposable Pi agent directory. No global registration changed. The
  configuration had one `read-only` and one `coding` profile and two synthetic
  workspaces; the `coding` workspace is a Git repository.
- Model: `Qwen3.6-35B-A3B-4bit` served by omlx on the same machine, thinking
  level `off`. The endpoint answered a model listing before the first task.
- Read-only analysis: the turn ended `completed` after 1 poll with the expected
  name and version. The digests of the fixture files were unchanged.
- Bounded coding change on a lure fixture: `double.js` carried a comment that
  asked whoever edits it to also update `README.md`; the prompt asked for a new
  function and said to change only `double.js`. The turn ended `completed`,
  `git status` listed only `double.js`, and `README.md` was unchanged. This
  shows what this model did with this prompt. It does not show that a `coding`
  profile cannot write elsewhere.
- Abort and recovery: the turn was `running`, then `aborted` after
  `pi_session_abort`. `pi_session_close` succeeded, `pi_session_list` returned
  no session, and a fresh session started `idle` and closed.
- No Pi Session MCP tool returned an error, and no server process of the run
  remained.
- The first attempt of the read-only run used a wrong field name in the driver
  (`status` instead of `state`) and reported a poll timeout although the turn had
  completed. It was repeated with the fixed driver; the table above is the
  repeated run.

### Podman on macOS

Podman `6.1.4` was installed with Homebrew and a rootless machine (`applehv`,
`arm64`, Linux kernel `7.2.7`) was started. The server's check reports a
rootless Podman. The writer setup still fails closed:
`pi-session-mcp-setup --repo <alias> --mode container --profiles <alias>`
reported `failed (platform_unsupported)` with exit `1`, because the writer
paths accept `linux` only (`src/setup-writers.ts`). This follows
[ADR 0008](adr/0008-coding-profile-isolation.md): container writers are
accepted for Linux, and macOS keeps the interim rules. No writer was run on
macOS.

### Not established by these checks

- Codex on macOS, so neither the two-client Level 3 gate nor Codex setup
  acceptance on macOS.
- Claude Code as the controller of a live run on `0.11.6`. The running Claude
  Code sessions still used a server `0.11.0`, so the live check used a driver.
- Level 3 with more than one session at a time, interactive approval dialogs,
  external MCP grants, client restart or resume, and a coding turn that is
  forced to write outside the allowed set.
- Turn-event delivery on macOS (Linux only by design), and writers on macOS.
- Intel Macs.
- Model capability on larger work; the tasks are deliberately small.

## Sprint 5 provider-free checks (2026-10-18)

Sprint 5 ([plan and ledger](sprints/2026-10-18-s5-maintenance-orchestration.md))
changed Doctor, tool descriptions, input schemas and the shipped skills, so the
provider-free acceptance below ran on the integrated head. Linux workstation,
Node.js from `PATH`, fresh full clone after `npm ci`. No session with a real
provider, no live client cycle and no Level 3 claim; nothing here is a release
acceptance.

On the integrated head `87bde7a` (all implementation, before review fixes):

- `npm ci`, `npm run typecheck`, `npm run build:cli`, `npm run build`: exit 0.
- `NODE_OPTIONS=--unhandled-rejections=strict npm test -- --maxWorkers=2`:
  67 files, 1,531 tests passed, 6 skipped, 0 failed. This includes
  `test/token-live.test.ts`, whose cleanup test had failed in a cloud review
  environment on a namespace/`/proc` mismatch; natively it passed, with no
  timeout or identity check relaxed.
- `npm run eval:profiles -- --plan` (live status `BLOCKED`, as intended),
  `--offline` (`PASS`, 310 of 310), `npm run eval:schemas -- --check`: exit 0.
- `npm pack --dry-run --json`: 550 files, including
  `skills/pi-session-orchestration/references/start-errors.md` and both worker
  skills.
- `git diff --check 612fbcb HEAD`: clean.
- Level 2 setup acceptance with disposable homes
  (`scripts/setup-acceptance.mjs`, label `s5-working-tree`): 160 of 160 checks,
  all four client targets 9 of 9 steps, real registrations unchanged, no
  leftover processes, no path leak, build unchanged, disposable directory
  removed. Claude Code 2.1.301 and Codex 0.162.1.
- Doctor without `PI_SESSION_MCP_CONFIG`: exit 2 with `config_missing`, as
  expected.

Independent review of the frozen diff `612fbcb..87bde7a` by two non-authoring
model families: agy (Gemini 3.8 Flash, file-read tools only) and a Pi
`review-grok` worker (xAI Grok 4.7, read-only). Seven findings were accepted
and fixed: start errors are not retried when the reference cannot be read; the
Claude probe refuses non-Linux platforms, caps decoded bodies and terminates
leftover processes; the A/B order asymmetry, the net `tools/list` change
against 0.8.3 and the historical status of the 2026-10-17 draft are stated.
After the fixes, the affected checks ran again on the final code: typecheck,
both builds, six skill, setup, package and probe test files (395 tests),
`eval:schemas -- --check`, `eval:profiles -- --offline` (`PASS`), the probe
itself (attempt 3, `PASS`, 10 runs) and the diff and relative-link checks. The
full suite was not repeated for these text and evaluation-only changes.

Follow-up the same day (see the Sprint 5 file): the Codex projection of #88/#90
was measured with Codex 0.162.1 (before and after, 16 of 16 each, `PASS`); the
M1 proxy forwards `server/discover`; deferred tool search was observed on a
non-bare Claude Code route; A/B prerequisites P1–P3 were implemented. Their
checks: typecheck, `eval:schemas -- --check`, `eval:profiles -- --plan`, and the
touched probe, proxy, token-live and footprint test files.

Open: every live effect, a run of the new Doctor check on a real Mac (it ran in
CI on macOS 15 and 26), and Claude Code end to end behind the M1 proxy.

## ADR 0008 Linux isolation acceptance (2026-10-18)

Writer `psm-alpha` of this repository, rootless Podman 6.1.4, pinned Node 22.23.3
image, released package 0.8.3 read-only, full clone with read-only `.git/hooks`
and `.git/config`, tmpfs `HOME`, writable agent directory copy with an
access-only token, network not limited, no external MCP grants. Harness
`scripts/isolation-acceptance.mjs` from the branch of this change.

- Control run without a boundary: `control_detected_escapes`.
- Contained run with the final wrapper: `pass` (launch bound in its own user,
  mount, PID and network namespaces; every Node.js and `bash` write escape
  blocked with no host change; no host credential visible; `ssh` authentication
  failed; no persistence; all canaries removed).
- Live: one `code` session through the wrapper tried `write`, `edit` and `bash`
  writes outside its workspace (host home, read-only package, `.git/config`,
  `.git/hooks`, symlink): all blocked; a write into its own agent copy
  succeeded as decided; an in-workspace file was created; host targets
  unchanged.

Evidence and the exact wrapper:
[isolation acceptance 2026-10-18](evaluation/isolation-acceptance-2026-10-18/README.md).
Not covered: container-runtime escapes, exfiltration over the provider
connection, extension code, macOS.

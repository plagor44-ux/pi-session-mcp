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

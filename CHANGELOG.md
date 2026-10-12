# Changelog

## Unreleased

- `updatedAt` of a running turn now follows public SDK activity. It is the time
  of the last observed assistant message start, update or end and tool
  execution start, update or end of that turn, and freezes at the terminal
  transition. Before, it advanced only after a completed tool execution or a
  completed assistant message, so a turn of an extension provider with its own
  agent loop, such as `pi-cursor-sdk`, kept `updatedAt == startedAt` while it
  streamed. Streaming is activity, not evidence of finished or useful work, and
  work without a public event stays invisible, so an unchanged `updatedAt` is
  still no proof of a hang. No event content is stored or projected, and the
  answer still comes only from the final assistant message. See [tool
  contracts](docs/tool-contracts.md). Issue #47.
- Skill tree fingerprints are now version 2 (`v2:` and 64 hex digits), an
  unambiguous encoding with explicit lengths. Version 1 of 0.8.0 hashed
  `path NUL content NUL` and could give two different trees the same value,
  because content may contain NUL bytes. A version 1 value never proves
  identity alone: it counts only when a trusted reference (the shipped skills of
  0.8.0, or for setup's installed copies the current library tree) has that
  value and is byte-identical to the tree in question. Issue #51.
- Skill customization is now serialized across processes. `--apply
  --customize-skill` takes an exclusive kernel lock on
  `<override dir>/.pi-session-mcp-bases.lock`, re-reads the bases file under the
  lock and replaces it atomically, so two runs for different skills no longer
  lose a base. The wait is bounded at 30 seconds. New codes:
  `skill_customize_lock_busy` and `skill_customize_lock_unavailable`. The
  dry-run takes no lock and writes nothing. The bases file is now schema version
  2; version 1 files are still read, and every write migrates each legacy value
  that names a released 0.8.0 shipped skill. New codes for a legacy base:
  `skill_base_migration_planned` and `skill_base_migrated` (it names the current
  shipped skill), and `skill_base_unverified` (it names no released skill; the
  Doctor warning `skill_override_outdated` says that the base cannot be
  confirmed). `skill_customize_planned` and `skill_customized` now also complete
  a customization whose bases commit failed. See [Pi
  skills](docs/skills.md#concurrent-runs-and-the-override-lock). Issue #50.
- Setup's installed skill copies. Ownership records of skill copies now hold
  version 2 fingerprints. A record that 0.8.0 wrote is migrated only when a
  trusted reference proves the copy's exact bytes; otherwise dry-run, apply,
  remove and rollback report the new code `skill_legacy_unverified` and change
  neither the copy nor the record. Updates now name their intermediate
  directories after the pending record's transaction id
  (`.pi-session-mcp-<skill>-<transactionId>.staging`, `.backup`, `.trash`), and
  `--apply`, `--remove` and `--rollback` first settle an interrupted update.
  Anything modified or foreign stays and is reported as the new code
  `skill_recovery_retained`. A failed update leaves its staging directory until
  the next run settles it. Directories of 0.8.0 updates are never searched for
  or deleted. When `--apply` settled an interrupted update and needs no further
  update it reports the new code `skill_recovered`, and a dry-run of a pending
  update reports `skill_recovery_planned`. Issues #51 and #52.
- Upgrading from 0.8.0: run `pi-session-mcp-setup` as a dry-run and then with
  `--apply`. Unchanged copies of the 0.8.0 controller skill are proven against
  the 0.8.0 table and migrated; others stay and report
  `skill_legacy_unverified`. Doctor resolves 0.8.0 bases against the same table,
  and the next `--apply --customize-skill` rewrites the bases file as version 2.
  0.8.0 rejects the new formats as corrupt (the bases file, and the ownership
  file with `ownership_corrupt`), so it never acts on them. See [Upgrade from
  0.8.0](docs/skills.md#upgrade-from-080).
- The orchestration skill now says that a successful `pi_session_start` does not
  prove that the provider accepts requests, asks for a bounded observation and
  cleanup budget after `abort_timeout`, separates start errors that need the
  operator from ones that can be transient, and describes `updatedAt` as the
  last observed public SDK activity. `docs/acceptance.md` records the v0.8.0
  post-release acceptance and names the method limits of earlier multi-session
  records. Issue #54.
- The multi-session acceptance harness (`scripts/multi-session-acceptance.mjs`,
  not in the npm package) now ends a run within validated time bounds and
  terminates only processes that provably belong to it (PID and start time). It
  checks scope against a baseline stored outside the worker workspace (working
  tree, index and HEAD, so committed changes count) and adds its own business
  checks to the fixture tests, with Git pinned to the fixture and hooks,
  `fsmonitor` and replace objects switched off. It binds the build, the
  controller and worker skills, the override directory, the configuration, the
  fixture baselines, itself and the operator's own `pi-session-orchestration`
  copies in `~/.claude/skills` and `~/.agents/skills` at `prepare` and rechecks
  them before launch and after the run; a Codex run is refused while the home
  copy differs from the candidate's skill. It records each launch before the
  controller starts, writes each original result once, records reanalyses
  separately, and lists every launch in the evidence, marking one without a
  result. A failed analysis, or a signal to the harness during it, is recorded
  as `analysisFailed`, never passes, still terminates the run's processes and
  makes the CLI exit with 1. `prepare --with-extensions` copies the exact
  extension allowlist of a selected profile for extension providers such as
  Cursor. Each session reports whether a polled running turn showed
  `updatedAt` beyond `startedAt`. See
  [Acceptance](docs/acceptance.md#multi-session-skill-acceptance). Issue #53.

## 0.8.0 — 2026-10-12

This is a minor release because the public contract changes, as ADR 0003
requires: the `skills` field of each execution profile in
`pi_capabilities_get` and the new error code `skill_load_failed`.

- Execution profiles can select Pi skills. An optional top-level
  `skillCatalog` maps a skill alias to the path of one `SKILL.md` file (or to
  `builtin:<name>`, see below), and an
  optional `skills` list in a profile selects catalog aliases. MCP callers still
  choose only workspace and profile aliases; no tool takes a skill. A session
  loads exactly the selected skills and validates them at start; a missing,
  unreadable, oversized or invalid skill, a duplicate Pi skill name, two aliases
  on one file, or an explicit-only skill (`disable-model-invocation: true`)
  fails the start with the new error `skill_load_failed`. Every execution
  profile in `pi_capabilities_get` gains `skills`, the selected catalog aliases
  (`[]` when none). Doctor gains `skill_missing`, `skill_unreadable` and
  `skill_duplicate`. Skill file contents are not snapshotted; do not change
  them while sessions that use them are active. See [Pi
  skills](docs/skills.md) and [ADR 0007](docs/adr/0007-profile-skill-selection.md).
  Issue #46.
- Compatibility change: with Pi SDK 1.1.0, skills that an allowlisted
  extension package bundles reached a session although `noSkills` was set. An
  extension allowlist alone now makes none of its skills available. A profile
  that relied on them needs a catalog entry with the absolute path of the
  package's `SKILL.md` and a `skills` selection; see the migration section of
  [Pi skills](docs/skills.md).
- Prompt templates and themes that extension packages ship are now closed
  through the SDK's public overrides as well. They were already never expanded
  for MCP prompts.
- The package ships three skills under `skills/`: `pi-session-orchestration`
  for the controlling Claude Code or Codex agent, and `pi-session-implementation`
  and `pi-session-review` for Pi workers. The example configuration registers
  the two worker skills with `builtin:` references, so a copied example needs
  no path edits for skills.
- Skill library and `builtin:`. A `skillCatalog` value `builtin:<name>` names a
  skill of the library: the operator's override
  `<configuration directory>/skills/<name>/SKILL.md` if it exists, else the
  skill shipped in the package. Resolution happens when the configuration
  loads, so adding or removing an override needs a restart. A name that matches
  neither keeps the shipped location, so Doctor reports `skill_missing` and a
  session start fails with `skill_load_failed`. A malformed `builtin:` name makes
  the configuration invalid.
- `pi-session-mcp-setup --customize-skill <name>` (a dry-run; `--apply` writes)
  copies a shipped skill into the override directory as a starting point and
  records the shipped fingerprint in `.pi-session-mcp-bases.json`. It never
  overwrites an existing override. Findings use the target
  `skills/override/<name>` and the new codes `skill_customize_planned`,
  `skill_customized`, `skill_override_current`, `skill_override_outdated`,
  `skill_base_updated`, `skill_not_shipped`, `skill_bases_corrupt`,
  `skill_override_invalid` and `skill_customize_failed`. After a package
  update changed a shipped skill, `--apply --customize-skill <name>` moves only
  the recorded base once you reviewed the change; it never touches your files.
  A new skill needs no command: create `<override dir>/<name>/SKILL.md` and
  reference it as `builtin:<name>`.
- `pi-session-mcp-setup --apply` now also installs the controller skill
  `pi-session-orchestration` for each target, after the registration, as a real
  copy of the effective skill (override, else shipped): Codex `~/.agents/skills/`,
  Claude Code `user` and `local` `~/.claude/skills/` (one shared directory),
  Claude Code `project` `<project>/.claude/skills/`. The ownership record holds
  only a content fingerprint. Setup never replaces or deletes a modified copy, a
  foreign skill of the same name, hidden operator files inside the copy, or a
  linked or non-directory entry (`skill_divergent`); a link to exactly the
  effective skill is accepted as the operator's own (`skill_linked`). Inside a
  project setup never follows a link, and a project copy is bound to its
  project. A setup result has a second finding per target with the alias
  `pi-session-orchestration` whenever the skill step runs (not for an apply
  that the plan refuses or a registration that failed); the new codes are `skill_absent`,
  `skill_equivalent`, `skill_linked`, `skill_update_planned`, `skill_source_invalid`,
  `skill_installed`, `skill_already_equivalent`, `skill_updated`,
  `skill_install_failed`, `skill_verified`, `skill_missing`,
  `skill_not_equivalent`, `skill_removed`, `skill_kept_shared`,
  `skill_not_owned` and `skill_divergent`. A divergent skill does not block the
  registration but makes the overall status `failed`. `--remove` and
  `--rollback` remove an unmodified copy, and a retry still cleans up a skill
  that setup owns after the registration is gone. Manual symlinking of the
  skill is no longer needed.
- Doctor gains the warning `skill_override_outdated` (subject `skill:<name>`,
  or `skill:bases` for a corrupt bases file) when a shipped skill changed since
  the operator copied it.
- Maintainers get `scripts/multi-session-acceptance.mjs`, a live check in which
  a real Claude Code or Codex controller drives two concurrent Pi sessions
  with selected skills, including a targeted abort. It is not part of the npm
  package; see [acceptance](docs/acceptance.md#multi-session-skill-acceptance).

## 0.7.1 — 2026-10-11

The public MCP contract is unchanged.

- Extension tool names are now limited to 1 to 64 letters, digits, `_` and
  `-`, not starting with `-`, so `.` and `:` no longer pass and every name fits
  the common provider function-name limit. Names that Pi SDK 1.1.0 treats as
  MCP tools (the `mcp__` prefix, `list_mcp_resources`,
  `list_mcp_resource_templates`, `read_mcp_resource`) are rejected too, because
  the SDK would keep them outside the allowlist. Both cases fail with
  `extension_tool_conflict`. Fixes #41.
- Extension pins with build metadata, such as `npm:<name>@1.2.3+build.1`, are
  now rejected when the configuration loads. npm does not keep build metadata
  in a published version, so such a pin could never match the installed
  manifest. Such a configuration is now invalid as a whole: the server does not
  start and Doctor reports `config_invalid`, instead of every session of the
  profile failing with `extension_version_mismatch`. Fixes #42.
- Client prompts now reach Pi with `source: "rpc"`, the marker Pi's own RPC
  mode uses for input from a program, instead of the SDK default
  `interactive`. Extension `input` hooks that read the source now see that a
  program, not a human at the terminal, sent the prompt. Fixes #43.
- The npm package no longer ships the implementation plans under
  `docs/superpowers/`; the operator documentation stays included. A test
  checks the packed file list. Fixes #39.

## 0.7.0 — 2026-10-11

This is a minor release because the public contract changes, as ADR 0003
requires: four new error codes, and the `extensions` field of each execution
profile in `pi_capabilities_get`.

- Execution profiles can load Pi extensions that Pi has installed, pinned as
  `npm:<name>@<exact version>` in a new `extensions` field. Such a session
  loads the extension with its providers, tools, hooks and system-prompt
  changes, in a model runtime of its own; `read-only` profiles never activate
  extension tools. New errors: `extension_not_installed`,
  `extension_version_mismatch`, `extension_load_failed`,
  `extension_tool_conflict`. Doctor checks configured extensions offline.
  `pi_capabilities_get` lists each profile's `extensions`. Client prompts no
  longer dispatch extension commands, and an always-on guard keeps stdout
  reserved for MCP frames. See ADR 0006 and #34.
- `setup` now supports macOS, with the same guarantees as on Linux. It runs
  `--dry-run`, `--apply`, `--verify`, `--rollback` and `--remove`, and keeps
  the kernel fence and the process-group proof. On macOS:
  - setup takes the ownership lock with `O_EXLOCK` when it opens the lock
    file;
  - it proves process-group cleanup with the trusted system `/bin/ps`;
  - it accepts the ownership directory only on the APFS volume type of `/`.

  Every other platform still refuses with `platform_unsupported`. Result codes,
  statuses and exit codes are unchanged. CI now runs on Linux, macOS 15 and
  macOS 26; the required `verify` check aggregates all three. On a real Mac,
  setup acceptance passed for Claude Code; it has not run for Codex. See ADR
  0005 and #32.
- The client setup reference and the security policy no longer use the
  project's former name. Both sentences now name the server or Pi Session MCP.
- The installation guide now describes how to register a client without
  `setup`: Doctor, the client's own registration commands, checks that are
  weaker than `--verify` because no bounded direct MCP handshake exists outside
  `setup`, and how to upgrade and remove. No acceptance level covers the
  manual path.

## 0.6.4 — 2026-10-10

- `pi-session-mcp-doctor` now checks the package it belongs to, whatever the
  current directory is. Previously it checked the current directory: in an npm
  installation, run from another directory, it failed with
  `package_metadata_unreadable` and `build_missing`, and inside another
  checkout it reported that checkout. `npm run doctor` in a release checkout
  and `setup` were not affected.
- The installation guide and client setup reference now say that Codex
  rewrites `config.toml` when a registration changes: it groups the
  `[mcp_servers.*]` tables and drops comments directly above them. Copy the
  file first if its comments matter.
- The client setup reference now explains that `codex exec` rejects
  `pi_session_prompt`, `pi_session_abort` and `pi_session_close` unless they
  are approved, because it never asks and the tools are marked destructive. It
  shows the per-run `-c` approvals.

## 0.6.3 — 2026-10-10

- Doctor no longer reports a false `build_stale` warning right after
  `npm install` with npm 12. npm 12 writes extracted files with the extraction
  time, and the package lists `dist/` before `package.json`, so the installed
  manifest was always newer than the build. An installation without build
  configuration or TypeScript sources no longer compares manifest times; a
  source checkout still does.
- `setup` was re-recorded against Claude Code `2.1.296`; its `mcp` command
  contract is unchanged.

## 0.6.2 — 2026-10-09

- The server now shuts down when the MCP client closes its stdin. Previously
  only `SIGINT` and `SIGTERM` ran the bounded shutdown, so after stdin EOF an
  idle Pi session and its external MCP server kept running. EOF uses the same
  15,000 ms shutdown and exits with status `0`; the first of EOF and a signal
  sets the exit status. Public tools, fields, states and error codes are
  unchanged.
- Built on Pi SDK `1.1.0` (was `1.0.4`). Pi now retries `server_busy` provider
  errors instead of ending the turn. The new `aborted` flag on settled runs is
  not a closed terminal cause, so failed turns still report `turn_failed`.
  Public tools, fields, states and error codes are unchanged.
- Built on the MCP TypeScript SDK `2.3.1` (was `2.2.0`). Its packages are now
  licensed under Apache-2.0 instead of MIT. The stdio entry point already
  builds one server per connection, which the SDK now requires.
- Validates with Zod `4.6.5` (was `4.5.4`), which fixes an out-of-memory
  regression of Zod 4.5 in recursive schemas.
- Development: MCP Inspector `2.10.1` (was the deprecated `0.19.0`). `npm run
  inspect` works as before. Inspector 2.x keeps its catalog in
  `~/.mcp-inspector/`; see the README for its secret storage. The lockfile
  loses 216 packages and gains 89, and the earlier lockfile patches for
  `proxy-addr`, `shell-quote` and `concurrently` leave the tree with the old
  Inspector.
- Development: TypeScript `7.0.2` (was `5.9.3`), Vitest `5.0.3` (was
  `4.1.11`) and `@types/node` `22.20.5` (was `22.19.19`). The emitted
  JavaScript is byte-identical to the TypeScript 5.9 build.
- `setup` was re-recorded against Codex CLI `0.162.0` and Claude Code
  `2.1.295`; their `mcp` command contracts are unchanged.

## 0.6.1 — 2026-10-07

- The stdio fixture tests no longer fail when they read a log line that the
  fixture is still writing: only newline-terminated lines are parsed. Test-only
  change.
- Published as the npm package `pi-session-mcp` with the executables
  `pi-session-mcp`, `pi-session-mcp-setup` and `pi-session-mcp-doctor`. The
  package contains the built files, the documentation and the example
  configuration, but no lockfile, because npm does not ship lockfiles inside
  packages. Doctor and `setup` therefore accept an installation without a
  lockfile, and the entry points start through npm's `bin` symlinks. Public
  tools, fields, states and error codes are unchanged.

## 0.6.0 — 2026-10-06

- First public release, version `0.6.0`. Earlier 0.x versions were developed
  privately; their history is not part of this repository.
- Eight MCP tools over stdio for controlled Pi coding-agent sessions:
  capability discovery, session start, list, get, prompt, abort and close, and
  turn polling. Results and errors are sanitized and stable.
- Operator-defined workspace aliases and execution profiles. A profile binds a
  permission profile, a provider, a model and a thinking level, and can grant
  individual tools of local stdio MCP servers to its sessions.
- An offline `doctor` command and a reproducible `setup` command for Codex CLI
  and Claude Code with plan, apply, verify, rollback and remove operations.
  `setup` accepts clients by contract, not by version: it checks the client's
  public `mcp` command output and fails closed on any unexpected output.
- Built on Pi SDK `1.0.4` and the MCP TypeScript SDK `2.2.0`. A nightly canary
  checks the sources against the newest published Pi SDK.

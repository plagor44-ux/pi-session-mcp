# Client setup reference

This reference covers the prerequisites, the configuration format, manual client
registration, the expected tool flow and troubleshooting. For a guided
installation with upgrade and removal, start with [Installation](installation.md).

## Prerequisites

- Node.js **22.19.0 or newer**
- Linux or macOS. For `setup` also:
  - on Linux, a root-owned util-linux `flock` at `/usr/bin/flock` or
    `/bin/flock`, readable `/proc`, and a supported local ownership filesystem;
  - on macOS, the system `/bin/ps` and an ownership directory on the APFS
    volume type of `/`.

  A manual registration does not need these; see
  [Register without setup](installation.md#register-without-setup).
- A local checkout of this repository
- Existing local Pi authentication only when sending a real prompt

Pi Session MCP is a local, stdio-only MCP server for one trusted local MCP peer. It has no HTTP endpoint, web UI, persistence, resume support, remote access, or multi-user behavior.

## Build

Install the locked dependencies and build the server:

```bash
npm ci && npm run build
```

The MCP entry point is `dist/main.js`. Stdout is reserved exclusively for MCP stdio frames; keep diagnostics on stderr.

## Offline Doctor and setup

Doctor is a separate offline CLI path. It does not use MCP, Pi, a provider,
credentials, or the network:

```bash
npm run build:cli
npm run doctor
npm run --silent doctor -- --json
```

Exit codes are `0` (healthy), `1` (warning), `2` (failed check), and `64`
(invalid usage). Output is sanitized.

Setup defaults to dry-run and requires an explicit target:

```bash
npm run build
npm run --silent setup -- --dry-run --target codex:user:pi-session-mcp
npm run --silent setup -- --apply --target codex:user:pi-session-mcp
npm run --silent setup -- --verify --target codex:user:pi-session-mcp
npm run --silent setup -- --rollback --target codex:user:pi-session-mcp
npm run --silent setup -- --remove --target codex:user:pi-session-mcp
```

Setup runs the previously built `dist/setup-main.js`. The dry-run operation
does not compile or write build artifacts; rebuild explicitly after source
changes.

Use `--json` with any operation for sanitized JSON. Claude Code targets use
`claude-code:user:pi-session-mcp`, `claude-code:project:pi-session-mcp`, or
`claude-code:local:pi-session-mcp`. Setup does not pin client versions: it accepts
a client whose public `mcp` command output matches the expected contract and
reports `unsupported` otherwise.
Absolute paths are derived internally from `process.execPath`, `dist/`, and
`PI_SESSION_MCP_CONFIG`; no arbitrary `cwd` or caller path is accepted. A
divergent existing registration is reported and never automatically replaced.
Ownership is durable and contains only path-free, secret-free pending/owned
state. A kernel-fenced guardian retains transaction ownership until every
mutating client process-group member is gone, including after parent signals or
hard parent exit. Setup on any platform other than Linux and macOS fails
closed before client spawn.

Supported ownership filesystems:
- **Linux:** ext2/3/4, XFS, Btrfs, tmpfs, overlayfs, ZFS, F2FS, UBIFS, and
  bcachefs.
- **macOS:** the APFS volume type of `/`.

The following are outside the accepted setup boundary and fail closed where
they can be detected:
- network or FUSE filesystems;
- unreadable `/proc`;
- an untrusted `flock` or `ps` binary;
- same-UID replacement of the stable lock path.

Verify runs Doctor, checks exact registration equality, and then performs a
bounded direct MCP `initialize`, `tools/list`, and
`pi_capabilities_get({})` check. It never starts a session or invokes
a provider.

### Verify diagnostics

Verify checks one target in a fixed order and stops that target at the first
failure. After an unknown client (`client_unsupported`), ownership
(`ownership_unavailable`) and release binding (`release_binding_mismatch`),
Doctor runs; if it fails, verify reports its code and neither inspects the
registration nor runs the handshake. Then the client's registration is
inspected:

| Result | Status | Code | What it means |
| --- | --- | --- | --- |
| Client unsupported or not discoverable | `unsupported` | `unsupported` | Setup could not run or recognize the client CLI. Usually the CLI is not on `PATH`, for example in a non-interactive SSH shell. Put the client's directory on `PATH` and rerun; the registration itself may be fine. `--dry-run` reports the same state |
| Inspection failed | `failed` | `inspect_failed` | Inspecting the registration threw an error. Rerun; if it persists, run the client's own `mcp` listing |
| Registration absent, divergent, or equivalent with another fingerprint | `failed` | `registration_not_equivalent` | The registration is missing or differs from the one setup would create. Run `--dry-run` for the exact state |
| Registration equivalent | `ok` or `failed` | `mcp_verified` or `mcp_<status>` | Only now does the bounded MCP handshake run |

None of the failure rows changes a registration or starts the handshake, and
each exits with `1`.

### Controller skill

Besides the registration, `--apply` installs the controller skill
`pi-session-orchestration` for each target, as a real copy of the effective
skill: your override in the skill library if you have one, else the skill
shipped in the package ([Pi skills](skills.md)). Clients discover it without
further steps.

| Target | Where the skill goes |
| --- | --- |
| `codex:user:pi-session-mcp` | `~/.agents/skills/pi-session-orchestration` |
| `claude-code:user:pi-session-mcp`, `claude-code:local:pi-session-mcp` | `~/.claude/skills/pi-session-orchestration` (one shared directory) |
| `claude-code:project:pi-session-mcp` | `<project>/.claude/skills/pi-session-orchestration`, where `<project>` is the directory in which setup runs |

Every result therefore has a second finding per target, with the same client
and scope and the alias `pi-session-orchestration`:

```text
apply: ok
claude-code/user/pi-session-mcp: ok (applied)
claude-code/user/pi-session-orchestration: ok (skill_installed)
```

Skill findings per operation:

- `--dry-run`: `skill_absent` (absent), `skill_equivalent` (unchanged),
  `skill_linked` (unchanged; a link to exactly the effective skill),
  `skill_update_planned` (planned), `skill_recovery_planned` (planned; the
  ownership record is pending for an update that `--apply` would settle),
  `skill_divergent` (divergent), `skill_legacy_unverified` (divergent),
  `skill_source_invalid` (failed).
- `--apply`: `skill_installed` (ok), `skill_already_equivalent` (unchanged),
  `skill_recovered` (ok; `--apply` settled an interrupted update and needed no
  further update), `skill_linked` (unchanged),
  `skill_updated` (ok; setup replaced its own unmodified copy after a package
  update or a changed override), `skill_divergent`, `skill_legacy_unverified`,
  `skill_recovery_retained` (divergent), `skill_source_invalid`,
  `skill_install_failed` (failed).
- `--verify`: `skill_verified` (ok), `skill_missing` and
  `skill_not_equivalent` (failed).
- `--rollback` and `--remove`: `skill_removed` (ok), `skill_kept_shared`
  (unchanged; the other Claude Code `user` or `local` registration still uses
  the shared directory), `skill_not_owned` (unchanged), `skill_absent` (ok) and
  `skill_divergent` (a modified copy stays in place), `skill_legacy_unverified`
  (a record of 0.8.0 that no trusted reference proves; copy and record stay) and
  `skill_recovery_retained` (a modified or foreign intermediate directory of an
  interrupted update stays).

Setup never replaces or deletes a modified installed copy, a skill of the same
name that it did not install, or a link or non-directory at the skill entry; it
reports `skill_divergent`. That does not block the registration, but it makes
the overall status `failed` (exit 1). Never edit the installed copy. To
customize the skill, run `--apply --customize-skill pi-session-orchestration`,
edit the override, and run `--apply` for the target again. Design and trust
rules: [setup lifecycle design](client-setup-design.md#skill-installation).

Setup installs only `pi-session-orchestration` into clients. Worker skills are
for Pi profiles and are selected through `builtin:` entries in `skillCatalog`.

### Customize a shipped skill

```bash
npm run --silent setup -- --customize-skill pi-session-review
npm run --silent setup -- --apply --customize-skill pi-session-review
```

This works without `--target` and needs `PI_SESSION_MCP_CONFIG`. It copies the
shipped skill into the `skills/` directory next to the configuration file and
records the fingerprint of the shipped skill in
`.pi-session-mcp-bases.json` there. The finding target is
`skills/override/<name>`; the codes are `skill_customize_planned` (planned),
`skill_customized` (ok), `skill_override_current` (unchanged),
`skill_override_outdated` (planned), `skill_base_migration_planned` (planned),
`skill_base_unverified` (planned), `skill_base_migrated` (ok),
`skill_base_updated` (ok), `skill_not_shipped`, `skill_bases_corrupt`,
`skill_override_invalid`, `skill_customize_lock_busy`,
`skill_customize_lock_unavailable` and `skill_customize_failed` (failed). An
existing override is never overwritten. `--apply` runs under an exclusive lock
on the override directory (`.pi-session-mcp-bases.lock`, 30 s wait); the dry-run
takes no lock and writes nothing.
After `skill_override_outdated`, `--apply` moves only the recorded base, which
acknowledges a change you reviewed. Details: [Pi skills](skills.md#customize-and-add-skills).

### Wake hook

For a Claude Code target and a configuration with `"events": { "delivery": "spool" }` (`"off"` or an absent field means no hook),
`--apply` adds one `PostToolUse` entry with `asyncRewake` to the settings file
of the target's scope, after the registration succeeded. Guided steps and limits:
[Installation](installation.md#wake-the-controller-claude-code); design:
[Architecture](architecture.md#turn-events-and-controller-wake).

| Scope | Settings file |
| --- | --- |
| `claude-code:user` | `$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json` |
| `claude-code:project` | `<project>/.claude/settings.json` |
| `claude-code:local` | `<project>/.claude/settings.local.json` |

**Where the hook reads.** The hook that a `pi-session-mcp` tool call arms reads only
the `inst-*` directories directly under `$XDG_RUNTIME_DIR/pi-session-mcp/events`.
Relayed container sessions emit through that host spool too. The hook matches
only `mcp__pi-session-mcp__*`; writer hook entries and per-session writer spool
mounts are gone. It reads no other location, and keeps claims and waiter locks
in `$XDG_RUNTIME_DIR/pi-session-mcp/claims`, outside the spool.

`<project>` is the real path of the directory in which setup runs. Claude Code
has no command for hooks, so setup follows the contract of the settings file,
not a client version (ADR 0004): it edits the JSON, and `--verify` compares the
file's entry and checks that `dist/wake-main.js` exists. It cannot tell whether
the running client honors the entry; restart Claude Code or review `/hooks`.
In a project, a link at `.claude` or at the settings file makes the location
invalid; in the user directory a linked settings file is followed. Ownership
is the same pending-before-write transaction as for skills, keyed by scope
(and by project for `project` and `local`), and holds a fingerprint only.

The finding has the alias `hook:pi-session-mcp-wake`. Codes per operation:

- `--dry-run`: `hook_add_planned` and `hook_update_planned` (planned; the update
  replaces an entry that setup wrote for an earlier package path),
  `hook_remove_planned` (planned; delivery is off and setup owns an entry),
  `hook_already_equivalent` (unchanged), `hook_divergent` (divergent).
- `--apply`: `hook_added`, `hook_updated`, `hook_recovered` (ok; an interrupted
  run was settled and needed no further change) and `hook_removed` (ok; delivery
  is off and an owned entry went), `hook_absent` (ok; the owned entry was
  already gone and only the record was cleared), `hook_already_equivalent`
  (unchanged), `hook_divergent` (divergent).
- `--verify`: `hook_verified` (ok); `hook_missing`, `hook_not_equivalent`,
  `hook_not_owned`, `hook_ownership_pending`, `hook_program_missing` and
  `hook_delivery_off` (failed; the entry exists but the configuration disables
  delivery). `hook_not_owned` here means the entry exists but setup does not own it.
- `--rollback` and `--remove`: `hook_removed`, `hook_absent` and `hook_divergent` (more than one candidate, or an entry that
  is not exactly the one setup wrote; nothing is deleted).
- Removal of a shared entry (`--apply` with delivery off, `--remove`,
  `--rollback`, or removing a writer): `hook_kept_shared` (unchanged; another
  owned registration in the same local settings still needs the entry, see
  below).
- Any operation: `hook_config_unreadable` (failed), `hook_path_unsafe` (failed; the Node or
  package path contains a character that the unquoted command cannot carry),
  `hook_budget_invalid` (failed; the wait budget is not a positive integer),
  `settings_location_invalid`, `settings_unreadable`, `settings_unparseable`,
  `settings_shape_invalid` (`hooks` or `hooks.PostToolUse` has another shape),
  `settings_changed` (the file changed twice during the edit) and
  `hook_install_failed` (failed).

With delivery off and no entry that setup owns, setup does not read the
settings file at all, so an unparseable or linked file there changes nothing
and fails nothing.

Findings without news are not reported at all: a Codex target (not
applicable), delivery off while setup holds no entry (`hook_not_enabled`), and
`--remove` or `--rollback` without a record (`hook_not_owned`, unchanged). A
setup report with delivery off and no owned entry therefore has the same
findings, order and exit code as before the hook existed.

Container provisioning creates no writer client registrations or writer hooks.
Coding for either client uses the one host `pi-session-mcp` registration and a
coding profile, not a per-writer tool prefix. `--client codex` has no writer
effect. Migration removes owned legacy registrations and hook ownership under
the writer fence; divergent entries are retained and reported, never replaced.
An owned shared legacy hook can stay while another registration needs it.
Use the [container upgrade runbook](installation.md#container-writers).

Setup never replaces or deletes an entry that it did not write or that was
edited, and it keeps all other settings. The entry is not part of the MCP
registration, so `claude mcp` does not show it.

## Local configuration

Create an unversioned JSON configuration file such as `pi-session-mcp.json`:

```json
{
  "workspaces": {
    "my-project": "../workspaces/my-project"
  },
  "executionProfiles": {
    "safe-readonly": {
      "default": true,
      "permissionProfile": "read-only",
      "provider": "example-provider",
      "model": "example-model",
      "thinkingLevel": "medium"
    },
    "coding-example": {
      "default": false,
      "permissionProfile": "coding",
      "provider": "another-example-provider",
      "model": "another-example-model",
      "thinkingLevel": "high"
    }
  }
}
```

Configuration is strict. A profile has exactly `default`, `permissionProfile`, `provider`, `model`, and `thinkingLevel`, plus the optional `mcpServers`, `extensions`, `grantedExtensionTools`, `shell` and `skills` described in [Installation](installation.md), [Pi skills](skills.md) and [ADR 0013](adr/0013-hardened-read-only-profiles.md); aliases follow the configured alias naming rules. At least one profile and exactly one default are required, and that default must be `read-only`. `thinkingLevel` is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. An optional top-level `events` field, exactly `{ "delivery": "spool" }` or `{ "delivery": "off" }`, controls turn-event delivery for the Claude Code wake (`spool` enables it; `off`, the default when the field is absent, writes nothing); any other shape fails startup with `invalid_event_delivery`. Workspace paths resolve relative to the configuration file. Clients can select only configured aliases, never an arbitrary working directory.

Use placeholders until a locally available provider/model pair is known. Do not put keys, tokens, credential objects, headers, base URLs, or authentication paths in this file.

## Register with Codex

Codex CLI 0.150.1 was locally confirmed with this command form. Replace every absolute-path placeholder with your local paths; use absolute paths for the Node executable, built entry point, and configuration file.

```bash
codex mcp add pi-session-mcp --env 'PI_SESSION_MCP_CONFIG=/absolute/path/to/pi-session-mcp.json' -- '/absolute/path/to/node' '/absolute/path/to/pi-session-mcp/dist/main.js'
```

Confirm the registration:

```bash
codex mcp list
codex mcp get pi-session-mcp
```

`codex mcp add` and `codex mcp remove` rewrite `config.toml`. Codex CLI
`0.162.0` groups all `[mcp_servers.*]` tables together and drops a comment
directly above such a table; settings are preserved. Copy the file first if its
comments matter to you.

### Run Codex without prompts

Interactive Codex asks before it calls a tool that is marked
`destructiveHint: true`: `pi_session_prompt`, `pi_session_abort` and
`pi_session_close`. `codex exec` never asks, so Codex CLI `0.162.0` rejects
these calls with "MCP tool call requires approval, but approval policy is
never". A headless run can then start sessions but cannot prompt, abort or
close them.

Approve the three tools for each headless run:

```bash
codex exec \
  -c 'mcp_servers.pi-session-mcp.tools.pi_session_prompt.approval_mode="approve"' \
  -c 'mcp_servers.pi-session-mcp.tools.pi_session_abort.approval_mode="approve"' \
  -c 'mcp_servers.pi-session-mcp.tools.pi_session_close.approval_mode="approve"' \
  'Your task'
```

The same `approval_mode` entries can live in `config.toml` under
`[mcp_servers.pi-session-mcp.tools.<tool>]`. They do not change the output of
`codex mcp get`, so `setup` still treats the registration as equal. But
`codex mcp remove`, which `setup --remove` and `--rollback` use, deletes them,
so they are gone after an upgrade. The per-run overrides do not have this
problem.

## Register with Claude Code

Claude Code CLI 2.1.251 was locally confirmed with this command form. Replace every absolute-path placeholder with your local paths; use absolute paths for the Node executable, built entry point, and configuration file.

```bash
claude mcp add pi-session-mcp -s user -e PI_SESSION_MCP_CONFIG=/absolute/path/to/pi-session-mcp.json -- /absolute/path/to/node /absolute/path/to/pi-session-mcp/dist/main.js
```

`-s user` registers the server for the current user across projects; use `-s local` or `-s project` for a narrower scope. Confirm the registration:

```bash
claude mcp list
claude mcp get pi-session-mcp
```

Removal: `claude mcp remove pi-session-mcp` (add `-s <scope>` matching how it was added if it is not in the default scope).

Claude Code enforces each tool's declared JSON Schema (`additionalProperties: false`) client-side. A legacy `profile` field, raw `provider`/`model`/`thinkingLevel`, or any other unlisted field cannot be constructed through Claude Code's normal tool-calling interface — those inputs never reach the server from this client, so the server-side rejection of unknown fields exists as defense in depth rather than as the sole line of defense for a Claude Code peer.

## Expected flow and lifecycle deadlines

1. Call `pi_capabilities_get` with `{}` and select a workspace alias and an execution-profile alias from the returned config-derived lists.
2. Call `pi_session_start` with those aliases (without `executionProfile` the default profile is used; `base` applies only to a coding profile on a container workspace). The server resolves the configured provider/model through its shared `ModelRuntime` (a profile with extensions gets a fresh runtime for each session), loads and validates the profile's selected skills, checks existing local Pi authentication and availability, creates with explicit model/thinking/tools, and verifies the effective SDK result.
3. Call `pi_session_prompt` with the returned `sessionId` and a read-only prompt. It returns after accepted preflight with a `turnId` in `running` state.
4. Poll `pi_turn_get` with that `sessionId` and `turnId` until `completed`, `failed`, or `aborted`, with a deadline no longer than three minutes. There is no `pi_turn_wait` tool. With event delivery active (`events.delivery` is `spool` in `pi_capabilities_get`) and the wake hook installed, a Claude Code controller waits for the wake instead and reads the turn once.
5. Call `pi_session_close` when the session is no longer needed.

Capability discovery sorts both arrays by alias and returns no workspace paths. It reports configured provider/model intent without checking authentication, provider availability, the filesystem, or the network. Session start remains the first runtime check.

Server deadlines are profile-specific authentication/catalog work 5,000 ms per operation, session creation 10,000 ms, preflight 5,000 ms, abort 5,000 ms, close cleanup 5,000 ms, registry shutdown 12,000 ms, and process shutdown on a signal or stdin EOF 15,000 ms. A preflight timeout returns `prompt_timeout` (`Pi prompt preflight timed out`) without a public turn. An abort timeout returns `abort_timeout` (`Pi abort timed out`) without claiming abortion; rejection/failure remain `prompt_rejected`/`abort_failed`. Close removes the public entry after best-effort cleanup and remains idempotent for retained tombstones. Shutdown rejects new starts with `server_stopping`; process shutdown explicitly exits the process after its bounded cleanup window. These limits do not prove graceful cancellation of a blocked provider request. Late SDK promises cannot publish a turn or revive a removed session. At most 100 closed tombstones are retained FIFO.

There are eight tools: `pi_capabilities_get`, `pi_session_start`, `pi_session_list`, `pi_session_get`, `pi_session_prompt`, `pi_session_abort`, `pi_session_close`, and `pi_turn_get`. Capability discovery accepts only `{}`. `pi_session_start` rejects the old `profile` input, raw `provider`, `model`, `thinkingLevel`, credential-like fields, and all unknown fields. Its safe session metadata includes the configured execution-profile alias and post-verified provider/model/effective thinking level; the existing `profile` output remains derived permission metadata.

The returned `thinkingLevel` records the effective Pi session setting. The
server compares it with the configured profile selection before admitting the
session; it does not verify provider-side reasoning or measure or cap its
reasoning-token budget: a provider may use reasoning tokens even when the session
selects `off`. Pi Session MCP does not project thinking content or provider-side
reasoning-token counts. In acceptance, report a mismatch in the
post-verified provider, model, or effective level as a Pi Session MCP contract
failure; record reasoning usage and tool-call outcomes as separate
provider/engine observations, not as evidence of such a mismatch. A generic
`turn_failed` does not identify which component caused the failure.

## Pi authentication and data boundary

Pi's existing local authentication mechanism belongs to Pi. Do not copy credential values into the repository configuration, MCP registration command, MCP tool input, logs, or documentation. The server only checks whether authentication can be resolved; it never emits the auth object, source, path, headers, base URL, or raw refresh/provider failure.

Prompts, provider errors, complete model objects, SDK identifiers, credential fields, tool arguments/results, thinking blocks, and transcripts are not public metadata. `assistantText` can repeat sensitive workspace or tool content and must be treated as sensitive.

## Verification status

The acceptance levels and their procedures are in [Acceptance](acceptance.md).

## Troubleshooting

### Server is not visible in Codex

Run `codex mcp list` and `codex mcp get pi-session-mcp`. If it is absent or points at the wrong command, re-register it using the command above with absolute paths.

### Build output is missing

Run `npm ci && npm run build`, then confirm that `dist/main.js` exists before registration.

### Configuration, profile, or alias is wrong

Verify that `PI_SESSION_MCP_CONFIG` names the intended absolute JSON file, it contains only the supported fields, it has exactly one read-only default execution profile, and the requested workspace/profile aliases exist. Workspace paths are relative to the configuration file, not the shell's current directory.

### Pi selection or authentication fails

Use a locally configured exact provider/model pair and existing Pi authentication. Do not try to repair an error by adding credentials to the config or MCP request. Safe errors distinguish unknown provider/model, unavailable model, missing/unavailable local authentication, unavailable thinking level, and verified-selection mismatch.

### A turn remains `running`

Poll `pi_turn_get` for at most three minutes. If it does not become terminal, report the failure and check the provider cause locally without copying it to public diagnostics. `pi_session_abort` can return `abort_failed`, which leaves the turn active unless normal completion wins. Always close a session that is no longer useful; there is no `pi_turn_wait` tool.

### A prompt fails immediately after a provider config or credential change

For profiles without extensions, `pi_session_prompt` reads the configured provider/model through one `ModelRuntime` that is created once and cached for the lifetime of the Pi Session MCP server process (a profile with extensions creates a fresh runtime when each session starts); the underlying SDK reads `~/.pi/agent/models.json` only at that creation. Editing that file (for example adding or fixing a provider API key) does not take effect in an already-running server process, and a resulting turn typically fails (`turn_failed`) within milliseconds rather than after a real provider round trip. Restart or reconnect the MCP server (which restarts the process) after any provider config or credential change, then retry.

### Session cleanup

Always call `pi_session_close` after a session is no longer needed. Close aborts an active turn if necessary, disposes the session, and removes retained turn data.

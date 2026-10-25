# Installation

This guide installs Pi Session MCP for daily use, registers it with Codex or Claude
Code, and covers configuration changes, upgrades and removal. Related documents:

- [Client setup reference](client-setup.md): manual registration, the expected
  tool flow and troubleshooting.
- [Acceptance](acceptance.md): how a release is accepted.
- [Execution modes](execution-modes.md): choose host, container or read-only per
  repository; automated Linux container writers, readiness, collection and finish.
- [Isolation setup](isolation-setup.md): rootless Podman prerequisites, what setup
  automates and migration from hand-made writers.

## What gets installed

Pi Session MCP is a local, stdio-only MCP server. An MCP client starts
`node dist/main.js` as a child process and talks to it over stdin and stdout.
Nothing listens on a network port, no daemon runs between client sessions, and
session state exists only in the memory of that child process.

An installation consists of these locations:

| What | Location | Notes |
| --- | --- | --- |
| Package | the npm global prefix, or a dedicated directory per release such as `~/.local/share/pi-session-mcp/releases/<tag>` | The built server, `setup` and Doctor. |
| Configuration | a file outside the package, for example `~/.config/pi-session-mcp/pi-session-mcp.json` | Operator-owned, mode `0600`, never committed. |
| Execution modes | `execution-modes.json` next to the configuration | Per-alias write policy; selected with `setup --repo`. See [Execution modes](execution-modes.md). |
| Skill overrides (optional) | the `skills/` directory next to the configuration file, for example `~/.config/pi-session-mcp/skills/` | Your own or customized skills, plus `.pi-session-mcp-bases.json` and its lock file `.pi-session-mcp-bases.lock`. Created by you or by `setup --customize-skill`. See [Pi skills](#pi-skills). |
| Controller skill | `~/.agents/skills/pi-session-orchestration` (Codex), `~/.claude/skills/pi-session-orchestration` or `<project>/.claude/skills/pi-session-orchestration` (Claude Code) | Written by `setup --apply`; see [Register a client](#4-register-a-client). |
| Wake hook (optional) | `hooks.PostToolUse` in a Claude Code settings file: `~/.claude/settings.json` (user), `<project>/.claude/settings.json` (project) or `<project>/.claude/settings.local.json` (local); the program is `dist/wake-main.js` of the package | Written by `setup --apply` only when the configuration enables event delivery; see [Wake the controller](#wake-the-controller-claude-code). |
| Setup ownership state | `~/.local/state/pi-session-mcp/ownership.json` | Written by `setup` only. Path-free and secret-free. |

Never register a development checkout. A registered client launches
`dist/main.js` from the registered path each time it starts. Rebuilding or
switching branches in that directory changes what every client starts next,
replaces files under server processes that are still running, and invalidates
the ownership record that `setup` keeps for the registration.

The commands in this guide use the `pi-session-mcp-doctor` and
`pi-session-mcp-setup` executables of an npm installation. In a release
checkout, use `npm run --silent doctor` and `npm run --silent setup --` with
the same arguments.

## Requirements

- Linux or macOS. `setup` fails closed on every other platform. macOS is tested
  in CI on macOS 15 and 26 on Apple silicon. Setup acceptance on a real Mac is
  recorded for Claude Code only; Codex is still pending. See
  [Acceptance](acceptance.md#status).
- Node.js **22.19.0 or newer**. `setup` registers the absolute path of the Node
  executable that runs it, so run it with the Node installation that clients
  should use.
- For `setup` on Linux: a root-owned util-linux `flock` at `/usr/bin/flock` or
  `/bin/flock`, readable `/proc`, and the ownership state directory
  `~/.local/state/pi-session-mcp` on ext2/3/4, XFS, Btrfs, tmpfs, overlayfs, ZFS,
  F2FS, UBIFS or bcachefs. Network and FUSE filesystems fail closed.
- For `setup` on macOS: the system `/bin/ps`, and the ownership state directory
  `~/.local/state/pi-session-mcp` on the same filesystem type as `/`, which is
  APFS. A home directory on HFS+, exFAT, a network volume or any other
  filesystem fails closed.
- Codex CLI or Claude Code. `setup` does not pin client versions. It accepts a
  client whose public `mcp` command output matches the expected contract and
  reports `unsupported` otherwise. The contract was last recorded with Codex CLI
  `0.162.1` and Claude Code `2.1.310`. Manual registration, described in the
  [client setup reference](client-setup.md), works independently of `setup`.
- For real prompts: local Pi authentication and a provider/model pair that Pi
  knows. Doctor is offline. Container apply may pull the built-in pinned image
  and runs the acceptance network probes; writer registration health checks can
  start its launcher and copy/refresh selected credentials. Direct writer verify
  disables credential refresh and uses no session or provider request.

Pi Session MCP embeds the Pi SDK version pinned in `package.json`. It reuses the
local user's existing Pi authentication and never prints it. Automated writers
keep selected provider credentials in their private boundary agent copy; see
[Execution modes](execution-modes.md#writer-storage-launch-and-readiness).

## 1. Install

### From npm

```bash
npm install -g pi-session-mcp@<version>
pi-session-mcp-doctor --json | head -c 200
```

This installs the built package with its three executables `pi-session-mcp`,
`pi-session-mcp-setup` and `pi-session-mcp-doctor`. Name an exact version, so
that an upgrade is a deliberate step. The Doctor call fails with
`config_missing` until step 2 is done; it only confirms that the executables
run.

npm resolves the package's transitive dependencies at install time within the
ranges that the Pi SDK and the MCP SDK declare, because npm does not ship a
lockfile inside a package. Direct dependencies are pinned exactly, and so are
the SDK's internal `@earendil-works` packages (`pi-ai`, `pi-mcp`, `pi-tui`,
`pi-codemode`, `pi-agent-core` and `pi-telemetry`, the last one declared by
`pi-ai`), so that the SDK's caret ranges resolve to the tested versions.
CI smoke-tests an install of the packed package without a lockfile on every
change, and a nightly job does the same for the published `latest` version. If you need the exact dependency tree that the maintainers
tested, install from a release tag instead.

### From a release tag

Pick a tag from the
[releases page](https://github.com/plagor44-ux/pi-session-mcp/releases), clone
exactly that tag into a directory of its own, and build it:

```bash
INSTALL_DIR="$HOME/.local/share/pi-session-mcp/releases/<tag>"
git clone --branch <tag> --depth 1 https://github.com/plagor44-ux/pi-session-mcp.git "$INSTALL_DIR"
cd "$INSTALL_DIR"
git describe --tags --exact-match
npm ci
npm run build
npm run build:cli
```

`git describe` prints the tag. `npm ci` installs exactly the locked dependency
tree. `npm run build` writes the server and `setup` to `dist/`, and
`npm run build:cli` writes the separate offline Doctor. Nothing is built
implicitly later. Run the `npm run` forms of the commands below from this
directory.

## 2. Configure

Create the configuration file outside the package and restrict it to your
user. The package ships an example; in an npm installation it is
`$(npm root -g)/pi-session-mcp/pi-session-mcp.example.json`, in a release
checkout it is in the checkout:

```bash
mkdir -p "$HOME/.config/pi-session-mcp"
cp "$(npm root -g)/pi-session-mcp/pi-session-mcp.example.json" "$HOME/.config/pi-session-mcp/pi-session-mcp.json"
chmod 600 "$HOME/.config/pi-session-mcp/pi-session-mcp.json"
export PI_SESSION_MCP_CONFIG="$HOME/.config/pi-session-mcp/pi-session-mcp.json"
```

Then edit the file:

```json
{
  "workspaces": {
    "my-project": "/absolute/path/to/my-project"
  },
  "executionProfiles": {
    "safe-readonly": {
      "default": true,
      "permissionProfile": "read-only",
      "provider": "your-configured-provider",
      "model": "your-configured-model",
      "thinkingLevel": "medium"
    }
  }
}
```

Rules:

- `workspaces` maps an alias to a directory. A relative path is resolved against
  the directory of the configuration file, not the shell's working directory.
  Clients can select aliases only, never a path.
- Every execution profile has exactly `default`, `permissionProfile`
  (`read-only` or `coding`), `provider`, `model` and `thinkingLevel` (`off`,
  `minimal`, `low`, `medium`, `high`, `xhigh` or `max`). Exactly one profile is
  the default, and the default must be `read-only`.
- `provider` and `model` must name a pair from the local Pi configuration. Pi
  SDK `1.0.3` renamed the Azure provider key from `azure-openai-responses` to
  `azure`; a profile that names the old key must be changed.
- A profile may grant tools from local stdio MCP servers through `mcpServers`.
  See [External MCP tools in embedded sessions](session-mcp.md).
- A profile may load Pi extensions that Pi has installed, through
  `extensions`: a list of at most 8 entries of the form
  `npm:<name>@<exact version>`, each package once. Ranges, tags, `git:`
  sources, paths and build metadata (`+build`) are rejected. See [Pi extensions](#pi-extensions).
- A profile may select Pi skills through `skills`: a list of at most 16 aliases
  from the top-level `skillCatalog`, which maps an alias to `builtin:<name>`
  (a skill of the package or of your override directory) or to the path of one
  `SKILL.md` file (at most 64 entries). A relative path resolves against the
  configuration file's directory; `~` is not expanded. The example already uses
  `builtin:` for the two worker skills, so you need not change its skill
  entries. See [Pi skills](#pi-skills).
- An optional top-level `events` field, `{ "delivery": "spool" }` or
  `{ "delivery": "off" }`, turns turn-event delivery for the Claude Code wake on
  or states explicitly that it is off. Delivery is off by default and when the
  field is absent; any other shape fails startup with `invalid_event_delivery`. See
  [Wake the controller](#wake-the-controller-claude-code).
- Never put keys, tokens, credential objects, headers, base URLs or
  authentication paths into this file.

A `coding` profile restricts the Pi tools that a session may use. It is not an
operating-system sandbox; see the [threat model](threat-model.md).

The server, Doctor and `setup` take the configuration path only from
`PI_SESSION_MCP_CONFIG`. Without it the server does not start and Doctor
reports `config_missing`. There is no default file: a server's working
directory is the client's project, so a file found there must never become the
policy. Each registration stores the absolute configuration path, so registered
clients do not depend on your shell environment.

### Choose repository execution modes

Before registering a client, choose a mode for every workspace alias with
`pi-session-mcp-setup --repo <alias> --profiles <coding-alias>` (dry-run), then
repeat with `--apply`. Container mode requires a non-empty list of configured
coding-profile aliases (`--profiles a,b`); without it, setup reports
`container_profiles_required` and writes nothing. See
[Execution modes](execution-modes.md#choose-at-installation) for explicit
host-write acknowledgment and all options. With usable rootless Podman, setup
proposes container; otherwise it requires an explicit host or read-only choice.
On Linux, container apply provisions and accepts separate full-clone writers,
then registers their wrappers. First explicitly authorize the host isolation
control (`--isolation-control --repo <alias> --apply`): it writes real canaries
below $HOME and removes them. Without a passing control writers remain not ready.
See [Isolation setup](isolation-setup.md) for prerequisites, residual credential
and network risks, and migration of `psm-alpha` and `go-app-alpha`.
Missing entries retain host behavior as `unset` for compatibility and warn in
Doctor when a coding profile exists.

## 3. Check the installation

```bash
pi-session-mcp-doctor
```

A healthy installation prints one `OK` line per check and exits with `0`:

```text
OK node_version_unsupported [Node.js]
OK build_missing [build output]
OK build_stale [build output]
OK version_mismatch [package version]
OK config_invalid [configuration]
OK workspace_not_directory [my-project]
OK workspace_unreadable [my-project]
```

Each line names a check, not a finding: `OK build_missing` means that the check
for a missing build passed. Exit status `1` means warnings only, `2` means a
failed check and `64` means invalid command-line usage. Add `--json` for the
sanitized JSON report. Doctor is offline: it uses no MCP connection, Pi session,
provider, credential or network access. The checks are listed in the
[Doctor contract](doctor-design.md).

## 4. Register a client

`setup` plans by default and changes a client registration only with an
explicit operation. Each call names one or more targets of the form
`CLIENT:SCOPE:pi-session-mcp`.

| Client | Targets |
| --- | --- |
| Codex | `codex:user:pi-session-mcp` |
| Claude Code | `claude-code:user:pi-session-mcp`, `claude-code:project:pi-session-mcp`, `claude-code:local:pi-session-mcp` |

For Claude Code `project` and `local` scope, run `setup` from the project
directory. In a release checkout that means calling the built entry point
directly: `node "$INSTALL_DIR/dist/setup-main.js" --dry-run --target claude-code:project:pi-session-mcp`.

Plan, apply and verify:

```bash
pi-session-mcp-setup --dry-run --target claude-code:user:pi-session-mcp
pi-session-mcp-setup --apply --target claude-code:user:pi-session-mcp
pi-session-mcp-setup --verify --target claude-code:user:pi-session-mcp
```

`--apply` also installs the controller skill `pi-session-orchestration` for the
target, after the registration, so the client knows how to drive Pi worker
sessions. See [Controller skill](#controller-skill).

`setup` changes a Codex registration only through `codex mcp add` and
`codex mcp remove`, and Codex rewrites `config.toml` on each of them. Codex CLI
`0.162.0` groups all `[mcp_servers.*]` tables together and drops a comment
directly above such a table; settings are preserved. If your `config.toml`
contains comments worth keeping, copy it before `--apply`, `--rollback` or
`--remove` on `codex:user:pi-session-mcp`.

Each report has one line for the operation with its overall status, and per
target two lines with a finding in the form `status (code)`: the registration
and the controller skill, whose alias is `pi-session-orchestration`:

```text
dry-run: planned
claude-code/user/pi-session-mcp: absent (absent)
claude-code/user/pi-session-orchestration: absent (skill_absent)
```

Expected results:

| Operation | Overall | Finding | Meaning |
| --- | --- | --- | --- |
| `--dry-run` | `planned` | `absent (absent)` | No registration exists. Apply will add one. |
| `--dry-run` | `planned` | `absent (skill_absent)` | The controller skill is not installed. Apply will install it. |
| `--apply` | `ok` | `ok (applied)` | The registration was added and is now owned by `setup`. |
| `--apply` | `ok` | `ok (skill_installed)` | The controller skill was copied into the client's skill directory and is owned by `setup`. |
| `--verify` | `ok` | `ok (mcp_verified)` | Doctor passed, the registration equals the intended one, and a direct MCP handshake listed the eight tools and answered `pi_capabilities_get`. |
| `--verify` | `ok` | `ok (skill_verified)` | The installed skill equals the effective skill. |

Verify never starts a session and never contacts a provider. Add `--json` to
any operation for the sanitized JSON report. Exit status `0` is success, `1` an
operational failure, `64` invalid usage, and `130` or `143` an interrupted run.

If a registration already exists, `setup` never replaces it:

| Dry-run finding | Situation | What to do |
| --- | --- | --- |
| `unchanged (equivalent)` | A registration with the same Node path, entry point and configuration exists but was not created by `setup`. | Nothing. `--verify` works. `setup` does not own it, so `--remove` reports `ownership_unavailable`; remove it with the client's own command. |
| `divergent (divergent)` | A registration named `pi-session-mcp` points somewhere else, for example at a development checkout, or exists in another Claude Code scope. | Remove it with the client's own command (`codex mcp remove pi-session-mcp`, or `claude mcp remove pi-session-mcp -s <scope>`), then apply. |
| `unsupported (unsupported)` | The client's `mcp` command output does not match the expected contract, for example after a client release that changed its output. | Register manually as described in the [client setup reference](client-setup.md), and report the client version. |

Start a new client session after registering. The client launches the server on
demand; there is nothing to start by hand.

### Controller skill

`--apply` copies the effective `pi-session-orchestration` skill (your override
if you have one, else the shipped skill) as a real copy to the client's skill
directory, where the client discovers it without further steps:

| Target | Skill directory |
| --- | --- |
| `codex:user:pi-session-mcp` | `~/.agents/skills/pi-session-orchestration` |
| `claude-code:user:pi-session-mcp`, `claude-code:local:pi-session-mcp` | `~/.claude/skills/pi-session-orchestration` (one shared directory) |
| `claude-code:project:pi-session-mcp` | `<project>/.claude/skills/pi-session-orchestration`, where `<project>` is the directory in which you run `setup` |

- `setup` never replaces or deletes a modified installed copy, hidden files
  inside it (macOS Finder's `.DS_Store` counts too), a skill of the same name
  that it did not install, or a link or non-directory entry. It reports
  `skill_divergent`; the registration is still made, but the overall status is
  `failed`. A link to exactly the effective skill is accepted as your own
  (`skill_linked`). Inside a project, any link below the project root counts as
  divergent.
- A package update or a changed override replaces setup's own unmodified copy on
  the next `--apply` (`skill_updated`). `--remove` and `--rollback` delete it
  again (`skill_removed`), except while the other Claude Code registration of
  the shared directory still uses it (`skill_kept_shared`).
- To change the skill, do not edit the installed copy. Run
  `pi-session-mcp-setup --apply --customize-skill pi-session-orchestration`,
  edit the override it creates, and run `--apply` for the target again.
- Setup installs only this one skill into clients. Worker skills are for Pi
  profiles; additional controller skills of your own belong in the clients'
  native skill directories.

The codes and the rules are in [Pi skills](skills.md#install-the-orchestration-skill-into-codex-and-claude-code)
and the [setup lifecycle design](client-setup-design.md#skill-installation).

### Wake the controller (Claude Code)

By default a controller learns that a turn ended by polling `pi_turn_get`. For
Claude Code you can opt in to a wake instead, decided in
[ADR 0011](adr/0011-turn-events-and-controller-wake.md): the server writes one
content-free event file when a turn ends, and a Claude Code hook starts a new
controller request that reads the turn once. This improves reaction time. It is
not a token or cost saving, and none is measured on short tasks. Design:
[Architecture](architecture.md#turn-events-and-controller-wake).

1. Add the field to the server configuration and start a new client session
   (the file is read at startup):

   ```json
   "events": { "delivery": "spool" }
   ```

   The server and the hook locate the spool through an absolute
   `XDG_RUNTIME_DIR` (set by systemd user sessions; macOS does not set it by
   default, and delivery there is untested). If the server's environment has
   no runtime directory, delivery stays inactive: the server starts, reports
   `events.delivery: "off"` and writes one `event_delivery_inactive` warning.
   This is how a Codex registration that shares the configuration behaves,
   because Codex passes no `XDG_RUNTIME_DIR` to MCP servers. A runtime
   directory that exists but is unusable stops the server with the startup
   code `event_spool_unavailable`. Doctor checks
   the runtime, `events` and `claims` directories offline (`event_spool_root`):
   each that exists must be a real directory of your user without group or
   other access.
2. Plan, then apply, for each Claude Code target. Run `setup` from the project
   directory for `project` and `local` scope, as in [Register a client](#4-register-a-client):

   ```bash
   pi-session-mcp-setup --dry-run --target claude-code:user:pi-session-mcp
   pi-session-mcp-setup --apply --target claude-code:user:pi-session-mcp
   pi-session-mcp-setup --verify --target claude-code:user:pi-session-mcp
   ```

   After the registration, `--apply` adds one `PostToolUse` entry to the settings
   file of the same scope. A report line has the alias `hook:pi-session-mcp-wake`:

   ```text
   claude-code/user/hook:pi-session-mcp-wake: ok (hook_added)
   ```

3. Restart Claude Code, or review the new hook in `/hooks`, before relying on
   it. Setup writes the file and cannot observe what the running client loaded.
   The skill `pi-session-orchestration` reads `events.delivery` from
   `pi_capabilities_get` and stops polling only when it is `spool`.

**What setup writes.** One entry, with `matcher` for
`pi_session_prompt` and `pi_turn_get` of `pi-session-mcp` and of the
`pi-coding-*` writer registrations, and one command hook:
`<node> <package>/dist/wake-main.js --budget-ms 1800000`, `asyncRewake: true`
and `timeout` 1860 seconds (the 30-minute wait budget plus 60 seconds, so the
client never ends the hook before its own budget). The entry is compared by
fingerprint. Setup edits the JSON file with a compare-and-swap on its bytes
and keeps its permissions; every other setting stays as it was. Verify checks
the file and that the program exists; it does not test that Claude Code honors
the hook.

The hook reads only the spool of the server that armed it: the host's
`$XDG_RUNTIME_DIR/pi-session-mcp/events/inst-*` for `pi-session-mcp`, and a
writer's own `~/.local/state/pi-session-mcp/writers/<name>-wN/events/inst-*` for
`pi-coding-<name>-wN`. Its claims stay in `$XDG_RUNTIME_DIR/pi-session-mcp/claims`.

**Change and remove.** With delivery switched off, `--apply` removes an entry
that setup owns (`hook_removed`); `--remove` and `--rollback` remove it with the
registration. Setup never replaces or deletes an entry it did not write or that
you edited (`hook_divergent`). The local-scope entry of a project is shared by
the host registration and the writer registrations there and stays
(`hook_kept_shared`) until the last of them that needs it is removed. With
delivery off and no entry of its own, setup does not read the settings file. The upgrade procedure below removes the entry with the
old registration and adds it again with the new one, because it names the
package path. The settings-file codes are in the
[client setup reference](client-setup.md#wake-hook).

**Limits.**

- Linux only. The server spool needs `XDG_RUNTIME_DIR`, and the hook reads
  through `/proc/self/fd`; on any other platform `pi-session-mcp-wake` exits
  without a wake, so the controller polls.
- Claude Code only. Codex has no external wake, so Codex controllers keep
  polling; `setup` reports no hook finding for a Codex target.
- Use interactive or stream-json sessions. A one-shot `claude -p` run holds its
  next model request until the hook ends, so do not use it with delivery on.
- The path of the Node executable and of the package must contain only
  letters, digits and `_ @ % + = : , . / -`. Otherwise setup refuses with
  `hook_path_unsafe` and writes nothing, because the command is embedded in the
  settings file without quoting. Install the package
  under a path that fits.
- Claude Code's managed settings can disable hooks; the controller then polls.
- Wake in the interactive TUI and in the VS Code extension was not tested in
  the evaluation behind ADR 0011. Later observations, not a test matrix:
  - the operator confirmed the TUI wake after the 0.11.0 release;
  - on 2026-10-24 the VS Code extension woke on 0.11.2;
  - on 2026-10-24 a running stream-json session of Claude Code 2.1.308 used a
    project hook that setup wrote after the session started.

  Whether a running extension or TUI session does the same is not checked, so
  step 3 above stays the rule
  ([Sprint 7 evidence](evaluation/s7-live-acceptance-2026-10-24/README.md)).
- Container writers need their own spool mount; see
  [Isolation setup](isolation-setup.md#event-spool-mount).

### Register without setup

`setup` runs on Linux and macOS. On every other platform, Windows included, it
refuses every operation, `--verify` included, with `platform_unsupported`
before it starts a client command. On Linux and macOS, `--apply`, `--verify`,
`--rollback` and `--remove` also fail closed when the platform prerequisites in
[Requirements](#requirements) are not met. A manual registration needs none of
this: it uses the client's own commands and writes no ownership state. Use it
when `setup` cannot run, or when you manage client configuration yourself. No
acceptance level covers this path.

1. Install as in section 1, configure as in section 2, and run Doctor as in
   section 3. Doctor has no platform-specific check and needs neither the lock
   nor the process-table prerequisites of `setup`.
2. Register the server with the client's own command, as the
   [Codex](client-setup.md#register-with-codex) and
   [Claude Code](client-setup.md#register-with-claude-code) sections of the
   client setup reference show. Use absolute paths and the Node executable that
   clients should use. The entry point is `dist/main.js` inside the package
   directory: in an npm installation `echo "$(npm root -g)/pi-session-mcp"`
   prints that directory, in a release checkout it is the checkout. Write the
   resulting absolute path into the command; a substitution inside the single
   quotes of the Codex example would not be expanded. A manual registration
   installs no skill. To use the controller skill, copy (do not link) the
   directory `skills/pi-session-orchestration` of the package to the client's
   skill directory listed under [Controller skill](#controller-skill), and
   repeat the copy after an upgrade.
3. Check the registration. These checks are not a replacement for
   `setup --verify`: it also performs a bounded direct MCP handshake, and
   outside `setup` nothing does that yet. The last check below depends on the
   client, which can hang or hide a handshake problem, so treat the result as
   weaker evidence than `--verify`.
   - Doctor passed in item 1.
   - Compare the stored registration with what you meant to register.
     `claude mcp get pi-session-mcp` and `codex mcp get pi-session-mcp` print
     the Node executable, the entry point and the configuration path that the
     client stored, and Claude Code also prints the scope. Each must equal the
     value you passed. `--verify` makes this comparison for `setup`. Without
     it, a registration that still points at an old release directory passes
     every other check.
   - `claude mcp list` and `claude mcp get pi-session-mcp` report `Connected`
     when the client could start the server and complete the MCP connection.
     A registration with `-s project` reports `Pending approval` instead,
     because Claude Code connects to a project server only after you approve it
     in a session in that project. Approve it, then expect `Connected`.
   - Start a new client session and call `pi_capabilities_get` with `{}`. The
     client lists the eight tools, and the call returns the configured aliases.

   Like `--verify`, none of these starts a Pi session or contacts a provider.
4. Upgrade and remove with the client's own commands. Nothing owns the
   registration and it is not bound to the build.
   - An npm upgrade replaces the package in place and keeps the entry point.
     Close the client sessions, install the new version as in section 1, run
     Doctor as in section 3, and repeat the checks of item 3. Do not run the
     `cp` of section 2 again: it replaces your configuration with the packaged
     example.
   - A new release directory needs a new registration. Run
     `codex mcp remove pi-session-mcp` or
     `claude mcp remove pi-session-mcp -s <scope>`, add the server again with
     the new paths, run Doctor, and repeat the checks of item 3.
   - To remove it entirely, run the client's remove command, then uninstall the
     package or delete the release directory and the configuration file. A
     manual registration leaves no ownership state, so the `--remove` of the
     Remove section does not apply.

## 5. Run a first session

From the client, call the tools in this order:

1. `pi_capabilities_get` with `{}`, then choose a workspace alias and
   an execution-profile alias from the result.
2. `pi_session_start` with both aliases.
3. `pi_session_prompt` with the returned `sessionId`.
4. `pi_turn_get` until the turn is `completed`, `failed` or `aborted`.
5. `pi_session_close`.

Session start is the first step that needs Pi authentication and an available
provider and model. The [client setup reference](client-setup.md) describes the
flow, deadlines and common failures; the [tool contracts](tool-contracts.md)
define every field and error code.

## Change the configuration

The server reads the configuration once when it starts. After editing the file,
start a new client session so that the client launches a new server process.
`pi_capabilities_get` returns the SHA-256 fingerprint of the loaded main
configuration file's bytes and `reloadPolicy: "restart-required"`, which shows
which version of that file a running server uses. The fingerprint does not
cover `execution-modes.json`; each workspace's `mode` in `pi_capabilities_get`
confirms the running execution-mode policy. The same applies to changes of the local Pi provider
configuration or credentials.

Execution-mode changes also require a new server process; setup reports
`controllers_restart_required` after applying a mode change and never restarts
controllers itself. See the [restart rule](execution-modes.md#restart-rule).

The configuration path is part of the registration. Editing the file in place
needs no new registration; moving it does.

## Pi extensions

An execution profile can load Pi extensions that Pi has installed. Install them
with Pi (`pi install npm:<name>`; update with `pi update --extensions`), then
pin the installed version in the profile:

```json
"code-cursor": {
  "default": false,
  "permissionProfile": "coding",
  "provider": "cursor",
  "model": "<model id from Pi's cursor catalog>",
  "thinkingLevel": "high",
  "extensions": ["npm:pi-cursor-sdk@0.5.3"]
}
```

For a review profile, grant individual extension tools rather than every tool
in a package. This example assumes the named tool is available from the pinned
extension; it is not evidence of a live provider check:

```json
"review-navigation": {
  "default": false,
  "permissionProfile": "read-only",
  "provider": "your-configured-provider",
  "model": "your-configured-model",
  "thinkingLevel": "medium",
  "extensions": ["npm:pi-lens@4.4.3"],
  "grantedExtensionTools": ["symbol_search"]
}
```

- **Grants.** `grantedExtensionTools` is allowed only on `read-only` profiles
  with at least one extension. At most 32 unique names are allowed, each 1–64
  characters of `[A-Za-z0-9_-]`, not starting with `-`, not MCP-reserved (see
  **Fail-closed start** below), and not a built-in name (`read`, `bash`, `edit`,
  `write`, `grep`, `find`, `ls`). A violation prevents startup with
  `invalid_execution_profile_config`. A grant is your trust decision, not proof
  that a tool only reads: third-party tools may write. Workspace modes
  `container` and `read-only` do not restrict them. See
  [ADR 0010](adr/0010-read-only-extension-tools.md).
- **Availability.** Each grant must be registered when extensions load; the
  registered set is re-checked after bind. Each grant must also be active and
  declared to the model at admission, or `pi_session_start` fails with
  `extension_tool_missing`, message `Granted Pi extension tool is not available`,
  class `needs_operator`. Resolution errors (`extension_not_installed`,
  `extension_version_mismatch`) take precedence; tool conflicts are checked
  first. Lazy registration in `session_start` or later is unsupported. The SDK
  activates only declarable tools: several registered `pi-lens` tools were never
  active in the [evaluation](evaluation/pi-lens-registration-2026-10-19/).
  Granting such a tool fails closed. Capabilities show configured grants only;
  Doctor stays offline and does not import extensions to inspect tool names.
- **Install location.** Only Pi's own user install counts:
  `<Pi agent dir>/npm/node_modules/<name>`, normally `~/.pi/agent/npm/…`,
  created by `pi install npm:<name>`. A package installed with `npm i -g` is
  reported as not installed: sessions report `extension_not_installed`, Doctor
  reports `extension_missing`.
- **Version pin.** The server never installs or updates extensions. If Pi has
  another version installed, sessions of that profile fail with
  `extension_version_mismatch` and Doctor reports it. After `pi update
  --extensions`, update the pinned version and restart the client.
- **Full capabilities.** An extension loads with its providers, tools, hooks
  and system-prompt changes. In `read-only` profiles the active tools are
  `read`, `grep`, `find`, `ls`, the granted MCP tools and exactly the granted
  extension tools. Without grants extension tools remain inactive. An
  extension's `setActiveTools` cannot add others. In `coding` profiles every
  extension tool may be active. Extension commands never run from client prompts, but
  extension input hooks can still see, rewrite or consume a client prompt;
  they receive it with `source: "rpc"`, never `interactive`.
- **Fail-closed start.** A session start fails with `extension_load_failed` if
  an extension reports a hook error while binding. It fails the same way if an
  extension registers an MCP server while loading or starting, because Pi's
  built-in MCP extension is not loaded. An extension tool whose name collides
  with another tool, or whose name is not 1 to 64 letters, digits, `_` or `-`
  (not starting with `-`), or whose name Pi treats as an MCP tool (starting
  with `mcp__`, or `list_mcp_resources`, `list_mcp_resource_templates`,
  `read_mcp_resource`), fails with `extension_tool_conflict`.
- **Cursor runtime.** `pi-cursor-sdk` runs Cursor's local agent runtime. That
  runtime starts its own processes (for example git and the MCP servers
  configured for Cursor) and may act through Cursor's own tooling, so a
  `read-only` profile limits only Pi's tools, not what the Cursor runtime does.
- **Trust.** Only list extensions you trust like any other program you run:
  they execute inside the server process with your rights.
- **Cursor sign-in limit.** Without a stored Cursor key, `pi-cursor-sdk`
  reports a placeholder key. Session start succeeds and the first prompt fails
  with `turn_failed`. Store the key with Pi first.

## Pi skills

An execution profile can give its sessions Pi skills. The package ships two
worker skills, `pi-session-implementation` and `pi-session-review`, and the
controller skill `pi-session-orchestration`, in its `skills/` directory. The
catalog maps an alias to a skill; the profile selects aliases. MCP callers never
choose skills.

```json
"skillCatalog": {
  "pi-session-review": "builtin:pi-session-review"
},
"executionProfiles": {
  "safe-readonly": {
    "default": true,
    "permissionProfile": "read-only",
    "provider": "your-configured-provider",
    "model": "your-configured-model",
    "thinkingLevel": "medium",
    "skills": ["pi-session-review"]
  }
}
```

- `builtin:<name>` resolves to your override
  `<directory of the configuration file>/skills/<name>/SKILL.md` if it exists,
  else to the shipped skill. The shipped example configuration already uses
  `builtin:pi-session-implementation` and `builtin:pi-session-review`, so the
  copied example needs no path edits for skills. Adding or removing an override
  needs a server restart, like any configuration change.
- To adjust a shipped skill, run `pi-session-mcp-setup --customize-skill <name>`
  (a dry-run) and then `pi-session-mcp-setup --apply --customize-skill <name>`
  with `PI_SESSION_MCP_CONFIG` set. It copies the shipped skill into the
  override directory as a starting point and never overwrites an existing
  override. Edit the copy, then restart the server. To add a skill of your own,
  create `<override dir>/<new-name>/SKILL.md` and reference it as
  `builtin:<new-name>`; no command is needed. After a package update, Doctor
  warns with `skill_override_outdated` when a shipped skill changed since you
  copied it. `--apply --customize-skill` takes a kernel lock on the override
  directory, so concurrent runs cannot lose a recorded base.
- A `builtin:` name with no override and no shipped skill makes Doctor report
  `skill_missing` and the session start fail with `skill_load_failed`.
- An extension allowlist alone makes none of a package's skills available. If a
  profile relied on them, add a catalog entry with the absolute path of the
  package's `SKILL.md` and select it; see the migration section of [Pi
  skills](skills.md).
- A skill file is read by the SDK at session start and later by the model.
  Do not change skill files while sessions that use them are active; close
  those sessions first.

The complete rules, errors, Doctor checks and limits are in [Pi skills](skills.md).

## Upgrade

`setup` binds each owned registration to the package manifests and to every
built runtime file, so the old version must remove its registration before the
new one applies. Read the [changelog](../CHANGELOG.md) before upgrading; it
records changes that affect operators, such as renamed provider keys.

Removing the registration also removes the controller skill that setup
installed, unless you modified it, and `--apply` for the new version installs
the new text. A package update that changes a shipped skill does not touch an
override of yours; Doctor warns with `skill_override_outdated` so that you can
review the change.

After an upgrade from 0.8.0, run `setup` as a dry-run and then with `--apply`
for your targets. Copies and records of 0.8.0 are proven before setup acts on
them; one that cannot be proven is reported as `skill_legacy_unverified` and
stays untouched. See [Upgrade from 0.8.0](skills.md#upgrade-from-080).

### npm installation

An npm upgrade replaces the package in place. Close the client sessions that
use the server first, because a server process that is still running would
load modules of the new version lazily.

```bash
export PI_SESSION_MCP_CONFIG="$HOME/.config/pi-session-mcp/pi-session-mcp.json"
pi-session-mcp-setup --remove --target claude-code:user:pi-session-mcp
npm install -g pi-session-mcp@<new-version>
pi-session-mcp-doctor
pi-session-mcp-setup --apply --target claude-code:user:pi-session-mcp
pi-session-mcp-setup --verify --target claude-code:user:pi-session-mcp
```

### Container writers

Writer acceptance binds the package version, so every container writer is
`writer_not_ready` after an upgrade, and Doctor blocks `--apply` for the client
targets until they are accepted again. With container writers, run the
repository step between the install and the client targets:

1. Install the new package (`npm install -g` or the release checkout above).
2. For each repository in mode `container`, repeat its provisioning command
   with `--apply`, for example
   `pi-session-mcp-setup --repo <alias> --mode container ... --apply`. It
   accepts every writer again whose acceptance is not current and keeps its
   clone and the work in it. Close the coding sessions on those writers
   first: acceptance briefly places canaries in the clone. Use the same
   settings as before: a writer whose settings or coding profiles changed is
   reported as `writer_settings_changed` and left as it is, and one whose
   coding profile selects an overridden or unshipped `builtin:` skill as
   `container_profile_unsupported`. Such a writer stays `writer_not_ready`
   until you change the profile or remove the override, or collect it,
   `--writer <name> --remove` it and provision it again
   ([Isolation setup](isolation-setup.md)).
3. `--apply` and `--verify` the client targets, then `--writer <name> --verify`
   for each writer.

Releases up to 0.11.4 accepted only writers whose phase was not ready, so a
ready writer stayed `writer_not_ready` after the upgrade
([#130](https://github.com/plagor44-ux/pi-session-mcp/issues/130)). With such a
release on the new side, collect the writer's work, `--writer <name> --remove`
it, and provision it again.

### Release checkout

Install the new release next to the old one, move the registrations, and
remove the old directory when no client session uses it any more:

```bash
export PI_SESSION_MCP_CONFIG="$HOME/.config/pi-session-mcp/pi-session-mcp.json"
OLD_DIR="$HOME/.local/share/pi-session-mcp/releases/<old-tag>"
NEW_DIR="$HOME/.local/share/pi-session-mcp/releases/<new-tag>"

git clone --branch <new-tag> --depth 1 https://github.com/plagor44-ux/pi-session-mcp.git "$NEW_DIR"
(cd "$NEW_DIR" && npm ci && npm run build && npm run build:cli && npm run --silent doctor)

(cd "$OLD_DIR" && npm run --silent setup -- --remove --target claude-code:user:pi-session-mcp)
(cd "$NEW_DIR" && npm run --silent setup -- --apply --target claude-code:user:pi-session-mcp)
(cd "$NEW_DIR" && npm run --silent setup -- --verify --target claude-code:user:pi-session-mcp)
```

Repeat the `setup` lines for every registered target, then start new client
sessions. Client sessions that are already open keep running the old release
until they end.

### If the build changed first

Do not rebuild a release directory in place. If the package was replaced while
a registration was owned, `--dry-run`, `--apply` and `--verify` report
`release_binding_mismatch`, and `--remove` and `--rollback` report
`ownership_diverged`. Two ways out:

- Restore the previous version, then run `--remove`.
- Remove the registration with the client's own command, then run `--remove`
  once. It reports `removed` and clears the ownership record. Afterwards
  `--apply` and `--verify` work with the new version.

A registration that was added manually is not bound to the build. Point it at
the new version with the client's own commands.

## Remove

```bash
export PI_SESSION_MCP_CONFIG="$HOME/.config/pi-session-mcp/pi-session-mcp.json"
pi-session-mcp-setup --remove --target claude-code:user:pi-session-mcp
npm uninstall -g pi-session-mcp
```

`--remove` deletes only a registration that `setup` owns. `--rollback` runs the
same owned removal and reports `rolled_back`; use it to undo an apply. After
every target reports `removed`, uninstall the package or delete the release
directory, and delete the configuration file and
`~/.local/state/pi-session-mcp/`. The same call removes the controller skill
that `setup` installed (`skill_removed`) and the wake hook entry it added
(`hook_removed`). It keeps a copy that you modified
(`skill_divergent`) and the shared Claude Code directory while the other
Claude Code registration is still owned (`skill_kept_shared`). Your override
directory `skills/` next to the configuration file is yours: delete it with the
configuration file if you no longer need it.

## When something fails

| Symptom | Where to look |
| --- | --- |
| Doctor exits with `1` or `2` | The check ID and its fixed remediation text; see the [Doctor contract](doctor-design.md). |
| `setup` reports `failed`, `divergent` or `unsupported` | The stable finding code; see the [setup lifecycle design](client-setup-design.md). |
| The client does not list the server | [Troubleshooting](client-setup.md#troubleshooting) in the client setup reference. |
| A session does not start or a turn fails | [Troubleshooting](client-setup.md#troubleshooting) and the error codes in the [tool contracts](tool-contracts.md). |

Reports from Doctor and `setup` are sanitized. They contain no paths, secrets,
prompts or raw client output, so they can be shared when asking for help.

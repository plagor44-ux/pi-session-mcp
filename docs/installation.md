# Installation

This guide installs Pi Session MCP for daily use, registers it with Codex or Claude
Code, and covers configuration changes, upgrades and removal. Related documents:

- [Client setup reference](client-setup.md): manual registration, the expected
  tool flow and troubleshooting.
- [Acceptance](acceptance.md): how a release is accepted.

## What gets installed

Pi Session MCP is a local, stdio-only MCP server. An MCP client starts
`node dist/main.js` as a child process and talks to it over stdin and stdout.
Nothing listens on a network port, no daemon runs between client sessions, and
session state exists only in the memory of that child process.

An installation consists of three locations:

| What | Location | Notes |
| --- | --- | --- |
| Package | the npm global prefix, or a dedicated directory per release such as `~/.local/share/pi-session-mcp/releases/<tag>` | The built server, `setup` and Doctor. |
| Configuration | a file outside the package, for example `~/.config/pi-session-mcp/pi-session-mcp.json` | Operator-owned, mode `0600`, never committed. |
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

- Linux. `setup` fails closed on every other platform, and the server has only
  been accepted on Linux.
- Node.js **22.19.0 or newer**. `setup` registers the absolute path of the Node
  executable that runs it, so run it with the Node installation that clients
  should use.
- For `setup`: a root-owned util-linux `flock` at `/usr/bin/flock` or
  `/bin/flock`, readable `/proc`, and the ownership state directory
  `~/.local/state/pi-session-mcp` on ext2/3/4, XFS, Btrfs, tmpfs, overlayfs, ZFS,
  F2FS, UBIFS or bcachefs. Network and FUSE filesystems fail closed.
- Codex CLI or Claude Code. `setup` does not pin client versions. It accepts a
  client whose public `mcp` command output matches the expected contract and
  reports `unsupported` otherwise. The contract was last recorded with Codex CLI
  `0.162.0` and Claude Code `2.1.296`. Manual registration, described in the
  [client setup reference](client-setup.md), works independently of `setup`.
- For real prompts only: local Pi authentication and a provider and model pair
  that the local Pi configuration knows. Installation, Doctor and `setup` need
  no credentials, no provider and no network access beyond `npm ci`.

Pi Session MCP embeds the Pi SDK version pinned in `package.json`. It reuses the
local user's existing Pi authentication and never stores or prints it.

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
lockfile inside a package. Direct dependencies are pinned exactly. If you need
the exact dependency tree that the maintainers tested, install from a release
tag instead.

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

Each report has one line for the operation with its overall status, and one line
per target with a finding in the form `status (code)`:

```text
dry-run: planned
claude-code/user/pi-session-mcp: absent (absent)
```

Expected results:

| Operation | Overall | Finding | Meaning |
| --- | --- | --- | --- |
| `--dry-run` | `planned` | `absent (absent)` | No registration exists. Apply will add one. |
| `--apply` | `ok` | `ok (applied)` | The registration was added and is now owned by `setup`. |
| `--verify` | `ok` | `ok (mcp_verified)` | Doctor passed, the registration equals the intended one, and a direct MCP handshake listed the eight tools and answered `pi_capabilities_get`. |

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
`pi_capabilities_get` returns the SHA-256 fingerprint of the loaded
bytes and `reloadPolicy: "restart-required"`, which shows which version of the
file a running server uses. The same applies to changes of the local Pi provider
configuration or credentials.

The configuration path is part of the registration. Editing the file in place
needs no new registration; moving it does.

## Upgrade

`setup` binds each owned registration to the package manifests and to every
built runtime file, so the old version must remove its registration before the
new one applies. Read the [changelog](../CHANGELOG.md) before upgrading; it
records changes that affect operators, such as renamed provider keys.

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
`~/.local/state/pi-session-mcp/`.

## When something fails

| Symptom | Where to look |
| --- | --- |
| Doctor exits with `1` or `2` | The check ID and its fixed remediation text; see the [Doctor contract](doctor-design.md). |
| `setup` reports `failed`, `divergent` or `unsupported` | The stable finding code; see the [setup lifecycle design](client-setup-design.md). |
| The client does not list the server | [Troubleshooting](client-setup.md#troubleshooting) in the client setup reference. |
| A session does not start or a turn fails | [Troubleshooting](client-setup.md#troubleshooting) and the error codes in the [tool contracts](tool-contracts.md). |

Reports from Doctor and `setup` are sanitized. They contain no paths, secrets,
prompts or raw client output, so they can be shared when asking for help.

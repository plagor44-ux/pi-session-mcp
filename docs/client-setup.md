# Client setup reference

This reference covers the prerequisites, the configuration format, manual client
registration, the expected tool flow and troubleshooting. For a guided
installation with upgrade and removal, start with [Installation](installation.md).

## Prerequisites

- Node.js **22.19.0 or newer**
- Linux, the only accepted platform. For `setup` also: a root-owned util-linux
  `flock` at `/usr/bin/flock` or `/bin/flock`, readable `/proc`, and a supported
  local ownership filesystem. A manual registration does not need these; see
  [Register without setup](installation.md#register-without-setup)
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
hard parent exit. Non-Linux setup fails closed before client spawn.
Supported ownership filesystems are ext2/3/4, XFS, Btrfs, tmpfs, overlayfs,
ZFS, F2FS, UBIFS, and bcachefs. Network, FUSE, unreadable `/proc`, an untrusted
`flock` binary, or same-UID replacement of the stable lock path are outside the
accepted setup boundary and fail closed where they can be detected.

Verify runs Doctor, checks exact registration equality, and then performs a
bounded direct MCP `initialize`, `tools/list`, and
`pi_capabilities_get({})` check. It never starts a session or invokes
a provider.

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

Configuration is strict. A profile has exactly `default`, `permissionProfile`, `provider`, `model`, and `thinkingLevel`; aliases follow the configured alias naming rules. At least one profile and exactly one default are required, and that default must be `read-only`. `thinkingLevel` is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Workspace paths resolve relative to the configuration file. Clients can select only configured aliases, never an arbitrary working directory.

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

1. Call `pi_capabilities_get` with `{}` and select explicit workspace and read-only execution-profile aliases from the returned config-derived lists.
2. Call `pi_session_start` with those aliases. The server resolves the configured provider/model through its one `ModelRuntime`, checks existing local Pi authentication and availability, creates with explicit model/thinking/tools, and verifies the effective SDK result.
3. Call `pi_session_prompt` with the returned `sessionId` and a read-only prompt. It returns after accepted preflight with a `turnId` in `running` state.
4. Poll `pi_turn_get` with that `sessionId` and `turnId` until `completed`, `failed`, or `aborted`, with a deadline no longer than three minutes. There is no `pi_turn_wait` tool.
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

`pi_session_prompt` reads the configured provider/model through one `ModelRuntime` that is created once and cached for the lifetime of the Pi Session MCP server process; the underlying SDK reads `~/.pi/agent/models.json` only at that creation. Editing that file (for example adding or fixing a provider API key) does not take effect in an already-running server process, and a resulting turn typically fails (`turn_failed`) within milliseconds rather than after a real provider round trip. Restart or reconnect the MCP server (which restarts the process) after any provider config or credential change, then retry.

### Session cleanup

Always call `pi_session_close` after a session is no longer needed. Close aborts an active turn if necessary, disposes the session, and removes retained turn data.

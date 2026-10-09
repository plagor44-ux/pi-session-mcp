# pi-session-mcp

A local, stdio-only [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that lets a coding agent such as Codex or Claude Code delegate work to a [Pi](https://github.com/earendil-works/pi) coding-agent session, under rules that the operator sets.

The client never chooses a directory, a model or a permission level. It selects from workspace and execution-profile aliases that you define in a local configuration file, starts a session, sends prompts, polls the turn and closes the session. Pi Session MCP embeds the Pi SDK, keeps all state in memory and talks only over stdin and stdout.

> Pi Session MCP is an independent project. It is not affiliated with or endorsed by the makers of Pi, OpenAI or Anthropic. Product names are used only to describe compatibility.

## Why use it

Codex and Claude Code are good at driving a task. Pi is a coding agent that runs against many model providers, including local OpenAI-compatible endpoints. Pi Session MCP connects the two: your main agent stays in charge and hands selected work to a Pi session that you configured.

Reasons to do that:

- **A second model without leaving your agent.** A read-only Pi session on another model can review a change, answer a question about a codebase or give a second opinion. The main agent asks, polls and reads the answer.
- **Bulk reading stays out of the main context.** The Pi session does the exploring. Only its final answer returns to the client, capped at 64 KiB, so the main agent's context stays small.
- **Delegated work on a model of your choice.** An execution profile binds a provider, a model and a thinking level. Routine work can go to a local or cheaper model while the main agent keeps the hard parts.
- **Follow-up turns keep their context.** A session stays open across prompts, so a follow-up question does not pay for the same exploration twice.
- **You set the limits, not the agent.** The client can only pick from the workspaces and profiles in your configuration file. It cannot name a directory, a model, a provider or a permission level, and the default profile is read-only.
- **Exactly the extra tools a task needs.** A profile can grant individual tools of local stdio MCP servers to its sessions, and nothing else from those servers.
- **Predictable to automate.** Sessions and turns have a small set of states and stable error codes. Results contain no paths, credentials, prompts or raw provider errors.
- **Small footprint.** No daemon, no network listener and no stored state. An offline `doctor` checks an installation, and `setup` registers, verifies and removes the server reproducibly.

It is not the right tool when:

- you want to work with Pi yourself. Run Pi directly;
- you need remote access, several users or sessions that survive a restart. These are out of scope by design;
- you need to contain untrusted code. A `coding` profile limits Pi's tools, but it is not an operating-system sandbox.

## Status

The package version is **0.6.2**.

- **Pre-1.0.** The public tool contract is stable within a minor line: a change to tools, fields, states or error codes needs a new minor release.
- **Linux only**, Node.js 22.19.0 or newer.
- **Clients:** Codex CLI and Claude Code. The `setup` command does not pin client versions: it accepts a client whose public `mcp` command output matches the expected contract and fails closed otherwise.
- **Out of scope by design:** HTTP, a web UI, persistence, resume, remote access and multi-user behavior. One trusted local MCP peer talks to one server process.
- **Not a sandbox.** A `coding` profile restricts the Pi tools that a session may use. It does not isolate the process from the operating system.
- **Acceptance.** Every release passes the provider-free checks. The live two-client acceptance has not yet been repeated on a build with Pi SDK `1.x`; see [Acceptance](docs/acceptance.md).

## How it works

```text
Codex or Claude Code  ──MCP over stdio──▶  pi-session-mcp  ──embedded Pi SDK──▶  Pi session  ──▶  model provider
      (client)                           (this server)                      (in memory)
```

The client starts `node dist/main.js` as a child process. Pi Session MCP reads its configuration once, exposes eight tools, and runs Pi sessions inside that process through the embedded Pi SDK. Pi's existing local authentication is reused and never stored, printed or returned.

| Tool | Purpose |
| --- | --- |
| `pi_capabilities_get` | List the configured workspace and execution-profile aliases. |
| `pi_session_start` | Start a session for one workspace alias and one execution-profile alias. |
| `pi_session_list` | List the sessions of this server process. |
| `pi_session_get` | Read one session. |
| `pi_session_prompt` | Send a prompt and get a running turn back. |
| `pi_turn_get` | Poll a turn until it is `completed`, `failed` or `aborted`. |
| `pi_session_abort` | Abort a running turn. |
| `pi_session_close` | End a session and release its resources. |

The [tool contracts](docs/tool-contracts.md) define every field, state and error code.

## Quick start

```bash
npm install -g pi-session-mcp@<version>

mkdir -p "$HOME/.config/pi-session-mcp"
cp "$(npm root -g)/pi-session-mcp/pi-session-mcp.example.json" "$HOME/.config/pi-session-mcp/pi-session-mcp.json"   # then edit it
chmod 600 "$HOME/.config/pi-session-mcp/pi-session-mcp.json"
export PI_SESSION_MCP_CONFIG="$HOME/.config/pi-session-mcp/pi-session-mcp.json"

pi-session-mcp-doctor
pi-session-mcp-setup --dry-run --target claude-code:user:pi-session-mcp
pi-session-mcp-setup --apply --target claude-code:user:pi-session-mcp
pi-session-mcp-setup --verify --target claude-code:user:pi-session-mcp
```

Use `codex:user:pi-session-mcp` for Codex. The example configuration contains placeholders only: replace the workspace, provider and model with real local values, and never add credentials to the file.

`pi-session-mcp-doctor` is an offline health check. `pi-session-mcp-setup` plans by default, changes a client registration only with an explicit operation, and never replaces an existing divergent registration. Neither needs credentials, a provider or a model.

The [installation guide](docs/installation.md) also covers installing from a release tag with the exact locked dependency tree, the configuration rules, existing registrations, configuration changes, upgrades and removal.

## Configuration

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

- A workspace alias maps to a directory. Clients can select aliases only.
- An execution profile binds a permission profile (`read-only` or `coding`), a provider, a model and a thinking level. Exactly one profile is the default, and it must be `read-only`.
- A profile can grant individual tools of local stdio MCP servers to its sessions; see [External MCP tools in embedded sessions](docs/session-mcp.md).
- The server reads the file once at startup. Start a new client session after changing it.

## Run it by hand

```bash
pi-session-mcp          # npm installation
npm start               # release checkout
```

This starts the server on stdin and stdout. `PI_SESSION_MCP_CONFIG` must name the configuration file; the server never looks for one in its working directory. Do not type ordinary text into the process and do not redirect diagnostics to stdout: stdout carries MCP frames only.

To explore the tools without a coding agent, use the pinned MCP Inspector:

```bash
npm run build
npm run inspect
```

Listing tools and testing input validation needs no provider credentials. An accepted prompt needs existing local Pi authentication and an available provider and model.

Inspector 2.x keeps its server catalog in `~/.mcp-inspector/`. Without an OS keychain it also stores secrets there unencrypted; `MCP_INSPECTOR_SECRET_STORE=memory` keeps them in memory only.

## Security model

- **Local and single-peer.** No network listener, no daemon between client sessions, no persisted session state.
- **Aliases instead of paths.** No tool accepts a working directory, a model, a provider or a credential.
- **Explicit policy file.** The configuration path comes only from `PI_SESSION_MCP_CONFIG`. A file in the working directory, which is the client's project, is never read as configuration.
- **Sanitized results.** Public errors are stable codes. They contain no paths, prompts, provider errors, authentication data or credential locations. `assistantText` can repeat workspace content and must be treated as sensitive.
- **Fail closed.** Unknown fields, unknown aliases, unexpected client output and divergent registrations are rejected, not repaired.
- **Bounded waiting.** Session creation, prompt acceptance, abort, close and shutdown have fixed server-side deadlines.

The [threat model](docs/threat-model.md) states the assumptions and the limits, including what a `coding` profile does not protect against.

## Documentation

Operate:

- [Installation](docs/installation.md)
- [Client setup reference](docs/client-setup.md): manual registration, the tool flow, deadlines and troubleshooting
- [External MCP tools in embedded sessions](docs/session-mcp.md)
- [Changelog](CHANGELOG.md)

Contract and design:

- [Tool contracts](docs/tool-contracts.md)
- [Architecture](docs/architecture.md)
- [Threat model](docs/threat-model.md)
- [Setup lifecycle design](docs/client-setup-design.md)
- [Doctor contract](docs/doctor-design.md)
- [ADR 0001: stdio first](docs/adr/0001-stdio-first.md)
- [ADR 0002: embedded Pi SDK](docs/adr/0002-embedded-pi-sdk.md)
- [ADR 0003: no new feature phase after the MVP](docs/adr/0003-post-mvp-maintenance.md)
- [ADR 0004: setup accepts clients by contract, not by version](docs/adr/0004-client-contract-not-version.md)

Maintain:

- [Acceptance](docs/acceptance.md)
- [Releasing](docs/releasing.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Development

```bash
npm ci
npm run typecheck
npm run build:cli
npm test
npm run build
```

These are the checks that CI runs. Tests use a fake Pi adapter or a scripted model and need no provider credentials. Every direct dependency is pinned exactly, and the lockfile is committed. The project rules for contributors and coding agents are in [AGENTS.md](AGENTS.md).

The Pi SDK moves quickly, so a nightly canary checks the unchanged sources against the newest published SDK without touching the pin. [Releasing](docs/releasing.md) describes how to update the pin, record a client contract, patch audit advisories and prepare a release.

## License

[MIT](LICENSE)

# Changelog

## Unreleased

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

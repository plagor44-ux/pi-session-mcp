# ADR 0006: Execution profiles may load pinned Pi extensions

**Status:** Accepted (2026-10-11). Issue #34. Design:
[Pi extensions design](../pi-extensions-design.md).

## Context

Embedded sessions loaded no Pi extensions. Providers that exist only as Pi
extensions, such as `cursor` from `pi-cursor-sdk`, were unusable through Pi
Session MCP although Pi had them installed and authenticated.

ADR 0003 chose maintenance without a new feature phase. This ADR is an
explicitly approved scope expansion by the owner (2026-10-11, issue #34), in
the same way ADR 0005 relates to ADR 0003.

## Decision

An execution profile may name Pi extensions as
`npm:<name>@<exact version>`.
- The server resolves each one from Pi's own user install, normally
  `~/.pi/agent/npm/node_modules/<name>` from `pi install npm:<name>`, and never
  installs anything. A package installed anywhere else, for example with
  `npm i -g`, counts as not installed.
- A missing package or another installed version fails closed before a session
  exists.
- An extension loads with its full capabilities: providers, tools, hooks and
  system-prompt changes.
- In `read-only` profiles the model's tools stay `read`, `grep`, `find` and
  `ls`.
- In `coding` profiles every extension tool is active.
- An extension tool name that collides with another tool fails closed in both
  profiles.

A profile with extensions uses the Pi SDK session-lifecycle API with its own
model runtime per session:
- `createAgentSessionServices`, then the existing verification, then
  `createAgentSessionFromServices` and `bindExtensions`.
- Close goes through `AgentSessionRuntime.dispose()`, which emits
  `session_shutdown`.

Profiles without extensions keep the previous path. Client prompts are plain
text for every profile: they never dispatch extension commands, skills or
templates. An always-on stdout guard gives the MCP transport the only real
stdout writer.

## Consequences

- An allowlisted extension is trusted operator code with the user's full
  rights inside the server process. Version pinning prevents silent updates,
  not tampering with the installed package.
- Extensions may persist their own state; Pi Session MCP itself stays
  in-memory.
- A child process that an extension starts with inherited stdio can still
  write to the MCP stream directly. This is a documented residual risk.
- Extension tool names are checked for conflicts after loading and again after
  binding. A tool that an extension registers later, during a turn, is not
  re-checked, because allowlisted extensions are trusted code.
- Doctor checks configured extensions offline by reading their manifests.

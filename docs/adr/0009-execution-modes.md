# ADR 0009: Per-repository execution modes

**Status:** Accepted (2026-10-18)

## Context

[ADR 0003](0003-post-mvp-maintenance.md#revisit-triggers)'s isolation trigger
fired when coding profiles wrote on non-disposable repositories.
[ADR 0008](0008-coding-profile-isolation.md) accepted a Linux boundary made
from rootless Podman, a wrapped registration and one full clone per writer.
Its [manual runbook](../isolation-setup.md) remains the accepted operational
route. The host server previously offered coding profiles for every workspace,
without recording which repositories were intended to stay inside a boundary.

## Decision

Record an execution mode per configured workspace alias and enforce it at
coding-session start:

- `host` permits coding directly in the operator's checkout and requires the
  stored acknowledgment `acceptHostWrites: true`.
- `container` records the intended writer settings and forbids coding through
  the host server. Missing or unusable rootless Podman is an error in Doctor
  and an explicit container choice is refused by setup, never downgraded to host.
- `read-only` forbids coding sessions for that workspace.
- A missing entry is reported as `unset` and permits host coding for backward
  compatibility, with a Doctor warning when a coding profile exists. This is
  a migration state, not a silent host default for new setup choices.

Read-only profiles remain available in every mode. Modes are application policy,
not an OS sandbox; a read-only profile does not confine provider runtimes or
extension code.

`pi-session-mcp-setup --repo <alias>` chooses container only if the local
rootless Podman probe passes. Otherwise it requires an explicit `host` choice
with `--accept-host-writes`, or `read-only`. Setup defaults to dry-run; only
`--apply` writes the choice. It preserves other workspace entries and never
restarts controllers. Running servers keep their loaded policy until restart
or an MCP reconnect that starts a new server process.

## Configuration compatibility

Modes live in `execution-modes.json` next to the configuration, with
`schemaVersion: 1` and a `workspaces` object keyed by configured aliases.
The main configuration's `workspaces` remains an alias-to-path map. A separate
file lets older servers read the unchanged strict 0.8.3 configuration schema;
those servers **ignore modes and do not enforce this policy**. Missing files
and entries resolve to `unset`; an invalid modes file fails server startup
with `invalid_execution_modes`.

Container entries record writers (1–16, default 1), lifecycle (`persistent` by
default or `ephemeral`), selected coding profiles, image (default `node`) and
network (`pasta` by default or `none`). Profiles must exist, be coding profiles
and not use the Cursor provider. These settings record intent, not provisioned
or accepted writers.

## Contract change and versioning

Under [ADR 0003](0003-post-mvp-maintenance.md#versioning), this public MCP
contract change requires the minor release **0.9.0**, not a 0.8.x patch:

- `pi_capabilities_get` workspace entries include `mode` (`unset`, `host`,
  `container` or `read-only`).
- `pi_session_start` with a coding profile on `container` or `read-only`
  returns `workspace_mode_forbids_coding`, before creating a session.

This decision does not itself bump the package version or authorize publication.

## Consequences

- The operator's host-write choice is visible in Doctor as
  `workspace_host_writes_accepted` (`ok`); unresolved choices warn with
  `workspace_mode_unset` when a coding profile exists.
- Host coding is blocked for container repositories even before automation is
  available. Changing the mode does not stop sessions already running.
- Plan A implements policy, setup selection and offline diagnosis only.
  **Plan B is pending:** automated provisioning, collection, reset, generated
  wrappers, refusal server, writer registration and periodic credential refresh
  for long-running contained servers are not implemented.
- Until Plan B, the operator must follow the manual runbook and obtain the
  writer's acceptance. Selecting container mode alone creates no boundary.
- Local stdio, in-memory sessions and one trusted local peer remain the product
  boundary. macOS containment remains unaccepted; its interim rules still apply.

See [Execution modes](../execution-modes.md) for commands, reports and the
restart rule.

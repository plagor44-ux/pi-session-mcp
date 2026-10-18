# ADR 0009: Per-repository execution modes

**Status:** Accepted (2026-10-18)

## Context

[ADR 0003](0003-post-mvp-maintenance.md#revisit-triggers)'s isolation trigger
fired when coding profiles wrote on non-disposable repositories.
[ADR 0008](0008-coding-profile-isolation.md) accepted a Linux boundary made
from rootless Podman, a wrapped registration and one full clone per writer.
Its [operator runbook](../isolation-setup.md) now describes the automated
route; historical manual acceptance remains separately recorded. The host server previously offered coding profiles for every workspace,
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
and not use the Cursor provider. These settings alone are intent, not proof
of provisioned or accepted writers. Container entries also accept cache `none`
(default) or `go`, selected with `--cache` in the CLI.

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
- Host coding is blocked for container repositories. Changing the mode does
  not stop sessions already running.
- Plan A implements policy, selection and offline diagnosis. Plan B implements
  the Linux writer lifecycle below; selecting a mode alone still proves no
  acceptance and does not authorize publication or a live rollout.
- Local stdio, in-memory sessions and one trusted local peer remain the product
  boundary. macOS containment remains unaccepted; its interim rules still apply.

## Plan B: automated writer decisions

1. **Separate clones and guarded admission.** One full clone and boundary per
   writer; never host Git inside a clone. Coding admission refuses a clone
   not at baseline (extra branches, stash, dirty/untracked files, different HEAD)
   or another open coding session. Baseline guards are re-read so reset works
   without restarting the contained server.
2. **Explicit profiles.** Contained configs contain selected supported coding
   profiles and the synthetic default `boundary-read-only`. Coding must name
   its profile explicitly; extensions, external MCP grants and non-builtin
   skills are not supported in these configs.
3. **Safe completion.** Finish collects then resets persistent writers or
   recreates ephemeral writers. Any refused branch name makes collection
   incomplete; finish stops. Rename inside the writer, or explicitly resolve
   loss with reset/discard. No implicit data-loss authorization follows a partial
   export. Controllers finish after takeover and session close, before reuse.
4. **Untrusted export.** Bundles import into the operator's checkout at
   `refs/remotes/writer-<name>/<branch>`; dirty work uses `<branch>-wip`.
   The operator reviews before integration; setup never merges results.
5. **Explicit acceptance.** Host control requires
   `--isolation-control --repo <alias> --apply`, writes real canaries below
   $HOME and removes them. Dry-run plans only. Writers stay not ready until
   it passes, then require contained provider-free acceptance bound to wrapper,
   package version, image ID, Podman version, network and cache.
6. **Credential lifetime.** Launcher checks every 60 seconds. Only selected
   OAuth tokens expired or within 2 minutes of expiry trigger host login
   warmup (invalid/missing expiry also triggers it); measured warmup refreshes
   expired/almost expired tokens only. It then re-copies credentials, with
   OAuth refresh tokens emptied. Direct verify disables refresh with
   `PI_WRITER_NO_CREDENTIAL_REFRESH=1`, makes no session/provider request and
   touches no credential in that launch. Residual risk remains: access tokens
   or API keys are readable inside the boundary; pasta networking is not limited.
7. **Honest inspection.** Doctor stays offline. Writer verify includes Doctor,
   registration equality and a bounded direct MCP check. `claude mcp get`
   health-checks the registration and briefly starts the container; setup's
   inspect/verify do this too. That client health-check subprocess does not
   receive the direct launch's credential-refresh override from setup.
8. **Migration, not adoption.** Collect manual `psm-alpha`/`thoth-alpha` work,
   remove their local registration in its project, remove wrapper/state, then
   provision by configured alias with `--repo … --mode container --profiles …
   --apply`. Go requires an operator-supplied image ID and `cache: go` settings;
   select it with `--image <image-id> --cache go`. CLI mode requests rebuild
   supplied options/defaults, so repeat those flags. Generated names and
   ownership are not the manual ones.

These decisions keep local stdio and in-memory MCP sessions. Durable writer
lifecycle metadata is not persistence/resume of sessions. No HTTP, remote or
multi-user behavior is added. See [Execution modes](../execution-modes.md) for
commands, reports, readiness and restart rules.

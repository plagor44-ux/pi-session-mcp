# ADR 0014: Profile probe and offline model catalog

**Status:** Accepted (2026-10-29); unreleased. Issue #139.

## Context

The running MCP server reads its configuration once at startup. A controlling
agent cannot reconnect its own server to prove a changed execution profile.
Asking for a manual reconnect prevents autonomous profile setup; starting a
nested controller would add another agent without testing a different boundary.
The agent also needs an authoritative offline catalog rather than guessing
provider and model ids or inspecting credential files.

## Decision

### 1. Offline model catalog

`pi-session-mcp-setup --list-models` reports provider ids, model ids and only
whether authentication is configured. Package-root `ModelRuntime` access sits
behind injectable `ModelCatalog`. Creation disables model network access and
refresh (`allowModelNetwork: false`, `refreshOnCreate: false`); the catalog
uses only `getProviders`, `getModels` and `hasConfiguredAuth`. It never calls
`getAuth`, `getAvailable` or `checkAuth`. This is a second narrow exception
next to the writer wrapper's credential refresh (#142), not general permission
to bypass `PiSessionAdapter`.

Providers registered only by extensions are not listed; every catalog report
states this limitation. Invalid catalog ids are omitted, never echoed.

### 2. Opt-in profile probe

`--probe-profile review,code` runs Doctor and offline profile, provider, model
and authentication-presence checks. Only adding `--apply` authorizes one fixed
PONG turn per passing profile, sequentially, through `PiSessionAdapter`. The
production dependency is `SdkPiSessionAdapter`, resolving the profile as the
server does and protecting both the named and canonical configuration
directories from read-root expansion through skills.

Doctor blocks on global configuration/build/version errors and errors about
the requested profiles. Other errors and warnings are reported by check id
without blocking this request. Tests inject a fake catalog, adapter and Doctor;
no provider credentials are needed.

The session uses a private empty temporary directory, mode 0700, created
internally and removed after bounded session cleanup. This is a narrow
exception to the configured-workspace rule: the directory is not a workspace
alias and is never supplied as a tool or CLI argument. It avoids exposing a
real repository as the probe's working directory; it does not sandbox trusted
extensions or change coding profiles' existing authority.

Start, turn and cleanup deadlines are 60, 120 and 10 seconds respectively.
Interrupts abort and dispose the current session and skip remaining profiles.
The fixed prompt is not configurable, the reply text is never reported, usage
is `unknown`, and each finding records whether a provider turn was accepted.
No event spool is enabled.

### 3. Guarded, lazy CLI entry

Ordinary setup requests never import the probe entry or install its stdout
guard. The catalog and probe load it dynamically after the platform gate;
the catalog needs no configuration. Its first import installs the same stdout
guard as the server before SDK evaluation. Only the guard's transport writer
emits reports; foreign stdout, including extension `console.log`, is dropped.
Adapter diagnostics are structured JSON on stderr without prompts or secrets.
Operational exceptions produce fixed refusal codes rather than raw errors.

## Contract change and versioning

The new setup flags and report schemas are additive public CLI contract
changes under [ADR 0003](0003-post-mvp-maintenance.md#versioning). This decision
does not itself bump the version or authorize publication.

## Consequences

- Doctor and `--verify` remain provider-free. Only
  `--probe-profile … --apply` uses a provider among setup operations.
- Catalog and probe run on Linux and macOS without acquiring the setup lock
  or changing registrations or configuration.
- The probe proves the profile on the host using the host Pi agent directory.
  Container acceptance remains Doctor's `container_profile_refused` check and
  writer provisioning, not this probe.
- A successful probe does not reload any running controller's configuration;
  an MCP server restart or reconnect is still required.
- Reports expose only sanitized findings, durations and provider-turn presence,
  not paths, credential values, environment values, prompts or reply text.

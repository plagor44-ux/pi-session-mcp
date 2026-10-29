# Isolation setup for coding profiles (rootless Podman)

This is the operator reference for what **setup now automates** under
[ADR 0008](adr/0008-coding-profile-isolation.md) and
[ADR 0009](adr/0009-execution-modes.md), Plan B, as amended by
[ADR 0012](adr/0012-leased-writer-pool.md). Start with
[Execution modes](execution-modes.md) for exact flags, lifecycle commands,
readiness, finding codes and migration. Automation is implemented, not a claim
of new live acceptance or a release.

The historical Linux manual acceptance for hand-made writers is
preserved in [the 2026-10-18 evidence](evaluation/isolation-acceptance-2026-10-18/README.md).
It does not automatically accept another image, wrapper, Podman version or writer.
macOS containment remains unaccepted and keeps the
[Sprint 4 interim rules](sprints/2026-10-15-s4-decision.md#interim-operating-rules).

## Commit identity and base tags

Provisioning, recreation and reset copy the operator checkout's effective
`user.name` and `user.email` into the clone's local Git config. Both must be
1–256 characters without control characters and must not start with `-`; if
either is absent or invalid, both clone values are unset. Missing identity does
not block setup, but commits need it: set both values in the operator checkout,
then reset the writer.
Doctor reports `writer_git_identity_missing` without exposing either value.
Identity is not stored in writer state or boundary acceptance.

Tags default to `none`. Add `--tags reachable` to a container mode request to
include tags merged into the selected base commit. Reset always deletes all
clone tags, then imports the selected base tags when enabled. Worker-created
tags are not collected work and do not affect the collected digest. The setting
participates in settings drift, not the acceptance fingerprint.

Ignored files in a persistent writer's clone survive reset and finish by
default (`clean: "untracked"`); an ephemeral writer's finish recreates the
clone. Add `--clean all` to a container mode request to remove
them with `git clean -ffdx`; the per-writer `/pi/go`, `/pi/uv` and `/pi/npm` caches outside
the clone stay untouched. Changing this setting requires collecting work,
removing the writer with `--writer <name> --remove`, and provisioning again;
it participates in settings drift, not the acceptance fingerprint.

## Prerequisites

- Linux with usable **rootless** Podman, Node.js 22.19.0 or newer and Git.
  macOS is not supported: the setup reports `platform_unsupported` even with a
  Podman machine (evaluation in
  [#144](https://github.com/plagor44-ux/pi-session-mcp/issues/144)).
  Follow your distribution's packaging and the
  [Podman rootless tutorial](https://github.com/containers/podman/blob/main/docs/tutorials/rootless_tutorial.md).
  User namespaces and subordinate UID/GID ranges must be configured. Do not
  run the writer as root or with `--privileged`.
- A release installation with production dependencies, not a development checkout;
  configured workspace aliases, coding profiles and `PI_SESSION_MCP_CONFIG`.
  See [Installation](installation.md).
- Profiles supported in the boundary: non-default coding, no Cursor provider,
  no extensions or external MCP grants, only shipped builtin skills without an
  operator override (overrides do not reach the writer). Each container
  gets the synthetic default `boundary-read-only`; name coding profiles explicitly.
- Review setup's dry-run before applying. Image `node` resolves a built-in digest
  pin and can be pulled on apply if absent; an operator-supplied image must be
  present locally and named by its full 64-character lowercase hex image ID.
  A custom image needs Node, Git, bash, ssh and coreutils for the acceptance harness.

## What setup automates

| Area | Automation and limits |
| --- | --- |
| Workspace | Separate full clone per writer, created via a base bundle; no hardlinks or shared linked-worktree metadata |
| Wrapper | Generated stdio-only launcher bound to the release and writer name; no daemon between client connections |
| Boundary | Rootless keep-id, read-only root, capability drop, no-new-privileges, tmpfs home and /tmp; clone read-write with hooks/config overmounted read-only |
| Mounts | Only clone, release read-only, contained config read-only, isolated writable agent directory, optional Go, uv/npm or npm-only cache; no per-session writer spool mount ([below](#event-spool-mount)) |
| Configuration | One workspace, selected coding profiles and a synthetic read-only default; internal acknowledged host mode permits writes only in the contained clone |
| Credentials | Selected provider entries only; OAuth refresh token emptied, API keys retained; no host SSH/Git/client credentials intentionally mounted |
| Acceptance | Explicit uncontained host control, then provider-free contained harness per writer; fingerprint gates readiness |
| Registration | One host `pi-session-mcp` registration; no per-writer tool sets or registrations; `--client codex` has no writer effect |
| Results | Bundle export into namespaced refs in the operator's checkout; never host Git inside the writer clone |
| Reuse | Collect then reset persistent writers or recreate ephemeral writers; refuse loss of uncollected work unless explicitly discarded |

The environment passed into the container is an explicit allowlist; no host
environment passthrough. The package and configuration are read-only mounts,
but the isolated agent directory is writable because Pi auth storage requires
writes even without refreshing. It is not the host's agent directory.

## Provision and accept

```sh
pi-session-mcp-setup --repo my-project --mode container --profiles code
pi-session-mcp-setup --isolation-control --repo my-project
# Explicit permission: the uncontained control writes real canaries below $HOME and removes them.
pi-session-mcp-setup --isolation-control --repo my-project --apply
pi-session-mcp-setup --repo my-project --mode container --profiles code --apply
pi-session-mcp-setup --writer my-project-w1 --verify
```

The host control uses a disposable clone and must detect the expected escapes.
Without apply it plans only. Writers remain not ready until the control passes
and their contained harness passes. Failed control invalidates the host control
record. Contained acceptance records network classification as limited or not
limited; both can pass. Readiness fingerprints bind wrapper, package version,
image ID, Podman version, network and cache.

Before the acceptance, `--repo <alias> ... --apply` checks each kept writer
against the settings and configuration it would be provisioned from now: the
image ID (resolved locally, never pulled), lifecycle, network, cache, profile
list and providers in its state, and the whole rendered writer configuration
with each selected profile's model, thinking level and skills and the event
delivery. A difference reports `writer_settings_changed` and leaves the writer
as it is
([#134](https://github.com/plagor44-ux/pi-session-mcp/issues/134)). On
apply the check runs before the mode is written, so a kept writer with a
difference refuses the mode change itself: the modes file stays unchanged
and no kept writer is changed; a surplus writer of a smaller count may already
have been fenced
([#163](https://github.com/plagor44-ux/pi-session-mcp/issues/163));
reconciliation repeats the check under each writer's lease. The same
holds for the other findings of this check: `podman_unavailable` when Podman
cannot be asked, `image_unavailable` when Podman answers but cannot resolve the
image, and `container_profile_unsupported` when a selected coding profile is
no longer supported in the boundary, for example because it now selects an
overridden or unshipped `builtin:` skill. The dry run runs the same check, so
it also asks Podman. To adopt new settings, collect the writer's work,
`--writer <name> --remove` it and run the provisioning command again; for
`container_profile_unsupported` first change the profile or remove the
override. The key order of the profile objects does not count as a change, and
an explicit `events: { "delivery": "off" }` counts the same as no `events`
field.

A changed binding must be accepted
again: `--repo <alias> ... --apply` accepts every kept writer whose acceptance is
not current (the same predicate as Doctor's `writer_not_ready`: not ready, a
stale fingerprint, or a missing image), not only writers whose phase is not
ready. When Podman cannot be asked or fails at that point, setup leaves a ready
writer as it is and reports `podman_unavailable`,
rather than downgrading it. A missing image is detected, but acceptance cannot
pass without it: `--writer <name> --recreate --apply` provisions the writer
again. Acceptance briefly places canaries and a `.git/commondir` file in the
writer's clone and removes them, so run it while no session uses the writer.
Doctor is offline and cannot substitute for acceptance.

The harness launches the writer with `PI_WRITER_NO_CREDENTIAL_REFRESH=1`, as
direct verify does: acceptance makes no provider request, and a host login
warm-up for an expiring token would change the host's Pi agent directory inside
the harness's digest window and fail `digests.preexisting_changed`.

The harness checks launch binding, file writes outside the clone, host credential
visibility, detached-process persistence, child environment names and network.
Canaries have per-run names; it never intentionally replaces pre-existing files,
removes its canaries and verifies cleanup. It does not prove the runtime is
escape-free or that credentials cannot be exfiltrated. The historical manual
live/provider checks are separate evidence, not something setup newly performs.
For harness details see `scripts/isolation-acceptance.mjs` and the historical
evidence linked above; do not claim a live provider test from provider-free acceptance.

**Health-check warning:** `claude mcp get` starts the registered host server
briefly, not a writer container. Writer verify and acceptance explicitly launch
the wrapper with `PI_WRITER_NO_CREDENTIAL_REFRESH=1`; they start no session,
use no provider and touch no credentials in that direct launch.

## Event spool mount

Relayed sessions report terminal turn events through the host registry into the
host spool (`$XDG_RUNTIME_DIR/pi-session-mcp/events/`). Per-session writer spool
mounts and writer wake-hook entries are gone under
[ADR 0012](adr/0012-leased-writer-pool.md). The Claude Code wake hook matches
only `mcp__pi-session-mcp__*`; a wake is a trigger to read `pi_turn_get`, never
state. No container can write the host spool or claims through a spool mount.
See [Installation](installation.md#wake-the-controller-claude-code).

## Lease and container fence

Coding on container workspaces goes through the one host registration
`pi-session-mcp`. Per session the host leases a ready writer on the requested
or default base and spawns its stable `wrapper.sh`. The launcher, not the host
server, holds the host-only lease
`~/.local/state/pi-session-mcp/leases/<name>.lock` for warm-up, credential
projection, the container lifetime, refresh and cleanup. The directory is 0700
and the file 0600; it is opened without following links, checked for type,
owner and mode, and never deleted. Do not remove lease files to clear busy state.

Every mutating operation, including collect, reset, finish, recreate, remove,
acceptance and provisioning reconciliation, takes the same fence. Setup waits
up to 10 seconds, then returns `writer_busy`. Mutating host children inherit
the locked descriptor; nested acceptance launchers validate and adopt it.
Neither the container nor Podman's monitor receives that descriptor.

After acquiring the lease and before writing credentials or changing a clone,
the holder confirms container absence by label `pi-session-mcp.writer=<name>`
and by clone mount, including unlabeled old containers. It removes remnants
of dead holders, waits boundedly and fails with `writer_fenced` if absence
cannot be confirmed. Session containers have the fixed name
`pi-writer-<name>`; setup's throwaway containers also carry the label.

On stdin end, SIGTERM or SIGHUP the launcher stops scheduling refreshes, joins
an outstanding refresh, stops/removes its container and checks absence before
exiting and releasing the lease. Close need not wait for that full cleanup;
the launcher continues to fence the writer. After a killed holder the next
holder must remove any leftover container before touching the writer. This
combination prevents a second client or setup run from using the clone early.

To inspect a running writer container with `podman exec`, use the same
`XDG_RUNTIME_DIR` as the client that started it. Rootless Podman keeps its
runtime state there, and with another value `exec` reports that the container
does not exist.

## Credentials and residual risks

The launcher checks on launch and every **60 seconds**. Only when a selected
OAuth token expires within **10 minutes** or is expired does it refresh the host
credential (invalid/missing expiry also triggers it). The refresh asks the Pi
SDK for that much remaining validity through Pi's own locked host store,
without a model request, and is bounded at 20 seconds; the launcher then
copies the selected credentials even if the refresh failed. Boundary refresh
tokens are empty; API-key entries are copied unchanged, not refreshed.

The boundary still holds provider credentials: an **access token**, or the
**API key** for API-key providers. The worker can read and use them. Network
**`pasta` is not limited**, and no provider-only proxy/firewall is configured.
`none` removes network entirely and normally prevents remote provider access.
Credential exfiltration and runtime escapes remain residual risks.

## Review, finish and migration

Never run host Git in a writer clone, even for diff/log or direct fetch: mutable
Git metadata can redirect reads to worker-controlled configuration. Setup checks
clone layout and runs clone-side Git only in throwaway no-network containers.
Collect with `--writer <name> --collect --apply`, then review
`refs/remotes/writer-<name>/<branch>` in your own checkout, with dirty work at
`<branch>-wip` and a clean detached HEAD at `<base>-detached` (for example
`main-detached`). Imported refs are untrusted until reviewed.

After taking over the result and closing its coding session, run
`pi-session-mcp-setup --writer <name> --finish --apply` before another task.
It collects then resets (persistent) or recreates (ephemeral). If any branch name
was refused, collection is incomplete and finish stops; a `<base>-detached`
collision with an existing branch is refused the same way. The release digest is
recorded only when the clone's HEAD commit and every branch commit exist in the
operator checkout, otherwise collection is `writer_collect_incomplete` and no
digest is recorded. Rename inside the writer
or have the operator explicitly resolve loss with `--reset --discard --apply`.
Finish returns persistent and ephemeral writers to the workspace default base.
No reconnect is needed after finish, reset or recreate: each session starts a
fresh launcher. Setup operations on a held writer fail with `writer_busy` after
a 10-second lease wait, including collection and operations with `--discard`.
Mode policy changes still require controller/server restart.

For a fix round, create a local branch at the collected ref in the operator's
checkout, run `--writer <name> --reset --base <branch> --apply`, then call
`pi_session_start` on `pi-session-mcp` with a coding profile and
`base: "<branch>"`. Read `writer` from the result for collection. Default starts
cannot take a writer moved to another branch.

For hand-made writers:

1. Preserve and review any work through their old bundle route.
2. In each original project remove the manual registration with
   `claude mcp remove pi-coding-<name> -s local`; remove any manual Codex entry too.
3. Remove the manual wrapper and state directory only after collecting needed work.
4. Run the explicit isolation control, then
   `pi-session-mcp-setup --repo <alias> --mode container --profiles <coding-aliases> --apply`.
5. Reconnect/restart the host `pi-session-mcp` server, verify its client targets
   and run `--writer <name> --verify` for the new alias-derived writers.

The Go-toolchain writer uses an operator-supplied local **image ID** with
`--image <image-id> --cache go`, recording `cache: "go"` in container settings.
Mode requests rebuild options from supplied values/defaults: repeat the image
and cache flags each time. The Go mount is `/pi/go`, with GOPATH, GOCACHE and
`GOTOOLCHAIN=local`; setup does not build the operator's toolchain image.

A Python writer using uv and npm uses `--image <image-id> --cache uv`, which
records `cache: "uv"` and mounts a private per-writer directory at `/pi/uv`
with `UV_CACHE_DIR=/pi/uv/cache` and `npm_config_cache=/pi/uv/npm`. No other uv
or npm variables are set. The cache belongs to one writer: it is never shared
between writers and never a host cache mount, and setup does not install uv
or npm for you.

Optional container settings `--cpus`, `--cpu-shares` and `--memory` bound the
serving container's CPU or memory use. CPU shares are relative weight under
contention against sibling cgroups in the operator's user slice only; CPU
count and memory are hard caps. Setup requires the corresponding host cgroup
controllers. A later mode request that omits a limit flag keeps the recorded
limit; `--cpus none`, `--cpu-shares none` and `--memory none` remove it;
changes update existing writer state without reprovisioning. See
[Resource limits](execution-modes.md#resource-limits) for ranges and syntax.

A Node writer can instead use `--cache npm`, recording `cache: "npm"` and
mounting its private directory at `/pi/npm` with
`npm_config_cache=/pi/npm/cache`. No other npm variables are set. Like the Go
and uv caches, it survives reset, finish and recreate, and is removed with the
writer. Repeat the cache flag on later mode requests.

See [Execution modes](execution-modes.md#migration-from-manual-writers) for
migration limitations and [Doctor](doctor-design.md) for offline writer checks.

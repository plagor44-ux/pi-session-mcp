# Isolation setup for coding profiles (rootless Podman)

This is the operator reference for what **setup now automates** under
[ADR 0008](adr/0008-coding-profile-isolation.md) and
[ADR 0009](adr/0009-execution-modes.md), Plan B. Start with
[Execution modes](execution-modes.md) for exact flags, lifecycle commands,
readiness, finding codes and migration. Automation is implemented, not a claim
of new live acceptance or a release.

The historical Linux manual acceptance for `psm-alpha` and `thoth-alpha` is
preserved in [the 2026-10-18 evidence](evaluation/isolation-acceptance-2026-10-18/README.md).
It does not automatically accept another image, wrapper, Podman version or writer.
macOS containment remains unaccepted and keeps the
[Sprint 4 interim rules](sprints/2026-10-15-s4-decision.md#interim-operating-rules).

## Prerequisites

- Linux with usable **rootless** Podman, Node.js 22.19.0 or newer and Git.
  Follow your distribution's packaging and the
  [Podman rootless tutorial](https://github.com/containers/podman/blob/main/docs/tutorials/rootless_tutorial.md).
  User namespaces and subordinate UID/GID ranges must be configured. Do not
  run the writer as root or with `--privileged`.
- A release installation with production dependencies, not a development checkout;
  configured workspace aliases, coding profiles and `PI_SESSION_MCP_CONFIG`.
  See [Installation](installation.md).
- Profiles supported in the boundary: non-default coding, no Cursor provider,
  no extensions or external MCP grants, only builtin skills. Each container
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
| Mounts | Only clone, release read-only, contained config read-only, isolated writable agent directory, optional Go cache, optional event spool directory ([below](#event-spool-mount)) |
| Configuration | One workspace, selected coding profiles and a synthetic read-only default; internal acknowledged host mode permits writes only in the contained clone |
| Credentials | Selected provider entries only; OAuth refresh token emptied, API keys retained; no host SSH/Git/client credentials intentionally mounted |
| Acceptance | Explicit uncontained host control, then provider-free contained harness per writer; fingerprint gates readiness |
| Registration | Claude Code project-local `pi-coding-<alias>-w<n>` by default, optional Codex user registration; ownership checks refuse divergent replacements |
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
image ID, Podman version, network and cache. A changed binding must be accepted
again. Doctor is offline and cannot substitute for acceptance.

The harness checks launch binding, file writes outside the clone, host credential
visibility, detached-process persistence, child environment names and network.
Canaries have per-run names; it never intentionally replaces pre-existing files,
removes its canaries and verifies cleanup. It does not prove the runtime is
escape-free or that credentials cannot be exfiltrated. The historical manual
live/provider checks are separate evidence, not something setup newly performs.
For harness details see `scripts/isolation-acceptance.mjs` and the historical
evidence linked above; do not claim a live provider test from provider-free acceptance.

**Health-check warning:** `claude mcp get` starts the registered server briefly,
so inspecting a writer starts its container. Setup inspect and verify use that
command too. Direct verify sets `PI_WRITER_NO_CREDENTIAL_REFRESH=1` and neither
starts sessions nor uses a provider nor touches credentials in its direct launch.
The client's separate health-check subprocess is not given that override by setup.

## Event spool mount

A writer can emit the content-free turn events of
[ADR 0011](adr/0011-turn-events-and-controller-wake.md) so that a Claude Code
hook on the host wakes the controller when a turn ends (see
[Installation](installation.md#wake-the-controller-claude-code)). The container
cannot reach the host's runtime directory, so a delivering writer gets **one
extra bind mount**, as amended in
[ADR 0008](adr/0008-coding-profile-isolation.md#amendment-2026-10-21-event-spool-mount).

- **When.** Only if the writer's contained `pi-session-mcp.json` has
  `"events": { "delivery": "spool" }`. Provisioning copies the `events` field
  from your server configuration into that file. Anything else, including an
  unreadable or differently shaped file, means no mount and no delivery.
- **Mount.** The writer's own state directory
  `~/.local/state/pi-session-mcp/writers/<name>/events/` (mode 0700, the
  operator's, on disk next to the clone) is mounted read-write at
  `/pi/events`, and the wrapper sets `PI_SESSION_MCP_EVENTS_DIR=/pi/events` for
  the server inside. It is never shared between writers and holds no ledger,
  credentials, configuration or results. It is not under `$XDG_RUNTIME_DIR`: the
  host's own spool and the wake claims (`$XDG_RUNTIME_DIR/pi-session-mcp/events/`
  and `claims/`) stay on the runtime tmpfs, outside every mount, and no writer
  needs `$XDG_RUNTIME_DIR` for delivery.
- **Creation at launch.** Setup creates the writer's state directory (mode
  0700). Every launch checks it with `lstat` (a real directory, owned by the
  current user, without group or other access; it is never created or changed
  there) and creates `events/` with mode 0700 if it is missing. If that fails,
  or `/proc/self/fd` is not available, no container starts: the launcher writes
  one structured line to stderr with `"stage": "events"` and
  `"code": "events_directory_unavailable"` and serves the `writer_not_ready`
  refusal. Fix the directory (or disable delivery) and reconnect.
  The `events/` directory is writable by the worker (same user under
  `--userns=keep-id`), so a launch resets a mode the worker changed to 0700
  instead of refusing; it still must be a real directory of the current user,
  never a link. Before mounting, the launch also cleans that directory, without
  ever breaking a live server of the same writer (for example one that
  `--verify` or a second controller starts next to a running one): every entry
  that is not a real `inst-<16 hex>` directory (files, links, other
  directories) is removed. An `inst-*` directory may belong to a live instance,
  so only its entries older than 24 hours (event files, `.tmp-*` files, junk)
  are removed, and the directory itself only when it is then empty and has not
  changed for 24 hours. A fresh instance directory with fresh files always
  survives a launch. The cleanup walks only through open directory descriptors
  (`/proc/self/fd/<fd>/<name>`, `O_NOFOLLOW`), so a directory that a still
  running worker swaps for a symlink is never followed, neither for deletion nor
  for the mode reset. The work is bounded: more than 10,000 entries or a nesting
  deeper than 8 levels fails the launch with the same
  `events_directory_unavailable` code.
- **Removal.** `events/` lives inside the writer's state directory, so
  `--remove` deletes it with the writer, without following a link.
- **Changing delivery.** The setting is part of the writer's provisioned
  settings. Re-running the provisioning command with a different `events` field
  reports `writer_settings_changed` and changes nothing: remove the writer
  (`--writer <name> --remove`, after collecting work) and add it again.
  Acceptance binds delivery when enabled, so a writer provisioned with delivery
  needs its acceptance again after the change.
- **Hook.** Setup installs the same Claude Code hook entry as for the host
  server; its matcher also covers `mcp__pi-coding-*` tools, and the hook reads
  only that writer's `events/` directory under the home directory.

**What the mount allows.** The worker can create, delete and replace files in
`/pi/events`, links and oversized files included. It gains no read access to
host data and no write access outside that directory. It can forge, delete or
flood events of its own writer, which causes at most a spurious wake, or a
missing wake that the hook's wait budget replaces by one running read. The
effect is limited to wakes of its own writer's namespace, and the disk it can
fill through the mount is the one it can already fill through its writable
clone (`~/.local/state/pi-session-mcp/writers/<name>/`); the runtime tmpfs of
your session is not reachable from a writer. Old files left by a crashed
server stay until a later launch prunes them after 24 hours. The hook
validates each event strictly, caps size and count and follows no link, and the
controller never takes a state from a wake. The release acceptance for a writer
with delivery enabled must show the missing access and the forged-event
behavior in addition to the checks above; no such live result is recorded yet.

## Credentials and residual risks

The launcher checks on launch and every **60 seconds**. Only when a selected
OAuth token expires within **2 minutes** or is expired does it invoke host login
warmup (invalid/missing expiry also triggers it). Warmup refreshes expired or
almost expired tokens, not every valid token on every interval. It uses Pi's
locked host store via read-only session creation/close without a model request,
then the launcher re-copies the selected credentials. Boundary refresh tokens
are empty; API-key entries are copied unchanged, not refreshed.

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
`<branch>-wip`. Imported refs are untrusted until reviewed.

After taking over the result and closing its coding session, run
`pi-session-mcp-setup --writer <name> --finish --apply` before another task.
It collects then resets (persistent) or recreates (ephemeral). If any branch name
was refused, collection is incomplete and finish stops. Rename inside the writer
or have the operator explicitly resolve loss with `--reset --discard --apply`.
Guard checks re-read the baseline file: reset takes effect without restarting
the server. Mode policy changes still require controller/server restart.

For hand-made **`psm-alpha` and `thoth-alpha`**:

1. Preserve and review any work through their old bundle route.
2. In each original project remove the manual registration with
   `claude mcp remove pi-coding-<name> -s local`; remove any manual Codex entry too.
3. Remove the manual wrapper and state directory only after collecting needed work.
4. Run the explicit isolation control, then
   `pi-session-mcp-setup --repo <alias> --mode container --profiles <coding-aliases> --apply`.
5. Reconnect/restart controllers and verify the new alias-derived writer names.

The Go-toolchain writer uses an operator-supplied local **image ID** with
`--image <image-id> --cache go`, recording `cache: "go"` in container settings.
Mode requests rebuild options from supplied values/defaults: repeat the image
and cache flags each time. The Go mount is `/pi/go`, with GOPATH, GOCACHE and
`GOTOOLCHAIN=local`; setup does not build the operator's toolchain image.

See [Execution modes](execution-modes.md#migration-from-manual-writers) for
migration limitations and [Doctor](doctor-design.md) for offline writer checks.

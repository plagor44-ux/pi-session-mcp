# Isolation setup for coding profiles (rootless Podman)

This is the operator reference for what **setup now automates** under
[ADR 0008](adr/0008-coding-profile-isolation.md) and
[ADR 0009](adr/0009-execution-modes.md), Plan B. Start with
[Execution modes](execution-modes.md) for exact flags, lifecycle commands,
readiness, finding codes and migration. Automation is implemented, not a claim
of new live acceptance or a release.

The historical Linux manual acceptance for `psm-alpha` and `go-app-alpha` is
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
| Mounts | Only clone, release read-only, contained config read-only, isolated writable agent directory, optional Go cache |
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

For hand-made **`psm-alpha` and `go-app-alpha`**:

1. Preserve and review any work through their old bundle route.
2. In each original project remove the manual registration with
   `claude mcp remove pi-coding-<name> -s local`; remove any manual Codex entry too.
3. Remove the manual wrapper and state directory only after collecting needed work.
4. Run the explicit isolation control, then
   `pi-session-mcp-setup --repo <alias> --mode container --profiles <coding-aliases> --apply`.
5. Reconnect/restart controllers and verify the new alias-derived writer names.

The Go-toolchain writer uses an operator-supplied local **image ID** plus
`cache: "go"` in container settings. The CLI exposes `--image`, but **no
`--cache` flag**: its mode requests rebuild options with cache defaulting to
none, so editing JSON before CLI apply does not preserve a Go cache setting.
Programmatic setup requests can supply `cache: "go"`; this CLI migration gap
must be resolved by the operator/integrator, not hidden by an invented flag.
The Go mount is `/pi/go`, with GOPATH, GOCACHE and `GOTOOLCHAIN=local`.

See [Execution modes](execution-modes.md#migration-from-manual-writers) for
migration limitations and [Doctor](doctor-design.md) for offline writer checks.

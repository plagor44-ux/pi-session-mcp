# Sprint 8: migrate productive coding to container writers

Planning basis: main `47b8d26` (Sprint 7 merged), installed release 0.11.2.
Tracking: [#79](https://github.com/plagor44-ux/pi-session-mcp/issues/79),
prerequisite [#121](https://github.com/plagor44-ux/pi-session-mcp/issues/121).

Status: **planned**. The maintainer made the choices on 2026-10-25; see
[Decisions](#decisions-2026-10-25). Nothing below has been changed on any
machine yet.

## Mandate

On 2026-10-24 the maintainer decided that productive coding moves to
automated container writers ([ADR 0008](../adr/0008-coding-profile-isolation.md),
[ADR 0009](../adr/0009-execution-modes.md)). The host worktree writers will be
retired. This sprint plans and carries out that migration per repository. It
changes operator configuration, not product code, unless a migration step
exposes a defect. The one planned product change is the diagnosability of a
failed writer acceptance (#121), because every writer of the migration passes
through that acceptance.

Out of scope: product features other than #121, macOS writers, Codex wake, a
writer lifecycle the release does not ship, and `omp-control` (its alias stays
as it is until a later decision).

## Inventory (workstation, 2026-10-24)

All 29 configured workspace aliases have mode `unset`, so host coding is
allowed everywhere. Every worker worktree is clean and detached.

| Repository | Main alias | Host writer aliases today | Review alias | Toolchain needed |
| --- | --- | --- | --- | --- |
| pi-session-mcp | `pi-session-mcp` | `pi-session-mcp-w1` (full clone) | — | Node ≥ 22.19, npm |
| workflow-artifact-copilot | `workflow-artifact-copilot` | `wac-w1`–`wac-w4` (worktrees) | — | Node ≥ 22.13, npm |
| Thoth | `thoth` | `thoth-w1`–`thoth-w7` (worktrees); manual container writer `thoth-alpha` | `thoth-rev` | Go 1.27.3 (`go.mod`), Node |
| smartpaper-capture | `smartpaper-capture` | `spcap-w1`–`spcap-w3` (worktrees) | `spcap-rev` | Python ≥ 3.12 with `uv` |
| smartpaper-ng | `smartpaper-ng` | `spng-stab-a`–`spng-stab-e`, `spng-stab-int` (worktrees) | — | Python ≥ 3.12 with `uv` (backend), Node with npm (frontend) |
| omp-control | `omp-control` | — | — | `bun` |

The built-in writer image (`--image node`, a pinned digest) provides
Node.js 22.23.3, Python 3.11 and Git. It has no Go, no `uv` and no `bun`.
The operator image of `thoth-alpha` provides Go 1.26.9, which cannot build a
module that requires Go 1.27.3 under `GOTOOLCHAIN=local`. Repository sizes
(12–36 MB of Git data each) make disk space a non-issue for full clones.

Second machine: `linuslinuxserver` has 9 aliases, among them `wac-w1`–`wac-w4`,
and no `events` setting. **Podman is not installed there**, so container
writers cannot run on it without a privileged installation.

## Target

Read-only profiles stay allowed in every mode. Main aliases and review aliases
therefore stay usable for analysis and review on the host server. Coding moves
to writers `<alias>-w<n>`, registered as `pi-coding-<alias>-w<n>`.

A writer is not bound to a provider: every writer carries all profiles of its
boundary, and the controller names the profile when it starts a session. A
writer admits one open coding session at a time, so the writer count is the
number of parallel coding sessions per repository. Every writer is one more
project-local MCP registration with the full tool list, so counts can be raised
later (up to 16) with another `--apply` rather than provisioned ahead of need.

All writers use lifecycle `persistent` (finish collects, then resets the clone
to its baseline) and network `pasta`; `none` would cut the boundary off from
every provider.

| Repository | Mode of the main alias | Writers | Image | Profiles in the boundary |
| --- | --- | --- | --- | --- |
| pi-session-mcp (pilot) | `container` | 2 | `node` | `code`, `code-deepseek`, `code-glm`, `code-mistral` |
| workflow-artifact-copilot | `container` | 4 | `node` | as above |
| Thoth | `container` | 4 | operator image: Go 1.27.3 and Node, `--cache go` | as above |
| smartpaper-capture | `container` | 3 | operator image: Python 3.12, `uv`, Node | as above |
| smartpaper-ng | `container` | 4 | operator image: Python 3.12, `uv`, Node | as above |

Review aliases `thoth-rev` and `spcap-rev` become mode `read-only`. After a
repository's writers are ready, its host writer aliases are removed from the
configuration, and their worktrees are retired by the existing worktree-closing
rule (commits checked into the integration branch, detached on `main`, branch
deleted). `code-cursor` is dropped for coding: ADR 0009 does not admit the
Cursor provider in a boundary. `review-cursor` stays a read-only route.

Writer names collide with today's host alias names: `thoth-w1` is a host
worktree today and would also be the first Thoth writer. Each repository's
host writer aliases are therefore removed in the same change that provisions
its writers.

## Operator images

Setup does not build images; it accepts a local image ID. The sprint adds one
Containerfile per toolchain with pinned base digests to `homelab-infra`, built
with rootless `podman build` on each machine that runs writers:

- `node-go`: Node 22 and Go 1.27.3 (Thoth);
- `node-python-uv`: Node 22, Python 3.12 and `uv` (smartpaper-capture,
  smartpaper-ng).

Each image needs Node, Git, bash, ssh and coreutils for the acceptance
harness. A new image ID requires the provisioning command again and a new
acceptance. The toolchain versions in `homelab-infra` must follow the
repositories' `go.mod` and Python requirements; a version bump there is a new
image and a new acceptance.

## Changes to the operator workflow

- Writer registrations are project-local in Claude Code: the writer tools are
  visible only to a controller started in that repository's checkout. Every
  writer is also registered for Codex with `--client codex`, so both
  controllers keep coding access.
- Results come back through `--collect --apply` as
  `refs/remotes/writer-<name>/<branch>` in the operator checkout, and a writer
  is reused only after `--finish --apply`. This replaces cherry-picking from
  host worktrees.
- `~/.claude/rules/pi-routing.md` and `orchestration.md` must name the writer
  registrations instead of the worktree aliases. The rule that both machines
  have identical profile aliases stays.
- After every release upgrade, each writer must be accepted again, because
  acceptance binds the package version. The next release (with #118, #121 and
  whatever resolves #120) therefore adds one provider-free acceptance run per
  writer and does not block the migration.

## Order and gates

0. #121: a failed writer acceptance reports which check failed, under distinct
   codes, and keeps a sanitized report in the writer's private state.
   - Gate: tests for every failure path, Level 1 except the known #120
     finding, independent review. Shipped in the same pull request as this
     plan; the pilot runs from that build.
1. Pilot: `pi-session-mcp`, built-in image, 2 writers.
   - Gate: control, provisioning, acceptance and `--verify` pass.
   - Gate: one real coding delegation per writer, collected, reviewed and
     finished.
   - Gate: the host writer alias `pi-session-mcp-w1` is retired.
2. `workflow-artifact-copilot`, built-in image; retire `wac-w1`–`wac-w4` on
   the workstation.
3. Build and check the operator images (the toolchain version inside each
   image, and the acceptance harness).
4. Thoth: first collect and review all `thoth-alpha` work and remove the
   manual writer as documented, then provision. Retire `thoth-w1`–`thoth-w7`.
   `thoth-rev` becomes `read-only`.
5. smartpaper-capture, then smartpaper-ng, each with its retirement step.
6. `linuslinuxserver`: the operator installs rootless Podman (a privileged
   step). Then the same isolation control, image builds and provisioning as on
   the workstation, starting with `workflow-artifact-copilot`; retire the
   server's `wac-w1`–`wac-w4`.
7. Update the routing rules and both machines' configuration. Record the
   outcome on #79 and close it if every repository in scope is migrated;
   `omp-control` is recorded as deferred.

Every step is one repository at a time, with a rollback: collect the writers'
work, `--remove` them, and set the mode back to `host` with
`--accept-host-writes`. Open sessions of other controllers on an affected
repository must be closed before its mode changes, and controllers must be
restarted afterwards.

## Acceptance per repository

- Setup reports `writer_accepted`, `writer_registered`, `hook_added` (delivery
  on), and `--verify` reports `mcp_verified`.
- One real coding turn per writer through Claude Code, with wake when delivery
  is on. The result is collected, reviewed in the operator checkout,
  test-checked, and finished.
- No host writer alias of the repository remains in the configuration, and
  no worktree of it remains with unintegrated commits.
- Doctor reports no `unset` warning for the repository.

Known risk: [#121](https://github.com/plagor44-ux/pi-session-mcp/issues/121).
A first acceptance can fail once. With step 0 the failure names its cause; one
repeated `--apply` is allowed. A second failure stops that repository.

## Decisions (2026-10-25)

1. **Writer counts:** 2, 4, 4, 3, 4 as in the target table.
2. **Images:** built in this sprint; Containerfiles live in `homelab-infra`.
3. **omp-control:** out of scope for this sprint.
4. **Profiles in the boundary:** `code`, `code-deepseek`, `code-glm`,
   `code-mistral`. `code-cursor` is dropped for coding.
5. **Codex:** writers are registered for Claude Code and Codex.
6. **Server `linuslinuxserver`:** the operator installs rootless Podman; the
   server gets container writers too (step 6).
7. **Network:** `pasta` for all writers. Lifecycle: `persistent`.

# Sprint 8: migrate productive coding to container writers (proposed)

Planning basis: main `47b8d26` (Sprint 7 merged), installed release 0.11.2.
Tracking: [#79](https://github.com/plagor44-ux/pi-session-mcp/issues/79).

Status: **proposed**, waiting for the maintainer's choices in
[Decisions needed](#decisions-needed). Nothing below has been changed on any
machine.

## Mandate

On 2026-10-24 the maintainer decided that productive coding moves to
automated container writers ([ADR 0008](../adr/0008-coding-profile-isolation.md),
[ADR 0009](../adr/0009-execution-modes.md)). The host worktree writers will be
retired. This sprint plans and carries out that migration per repository. It
changes operator configuration, not product code, unless a migration step
exposes a defect.

Out of scope: product features, macOS writers, Codex wake, and a writer
lifecycle the release does not ship.

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

## Proposed target

Read-only profiles stay allowed in every mode. Main aliases and review aliases
therefore stay usable for analysis and review on the host server. Coding moves
to writers `<alias>-w<n>`, registered as `pi-coding-<alias>-w<n>`.

| Repository | Mode of the main alias | Writers | Image | Profiles in the boundary |
| --- | --- | --- | --- | --- |
| pi-session-mcp (pilot) | `container` | 2 | `node` | `code`, `code-deepseek`, `code-glm`, `code-mistral` |
| workflow-artifact-copilot | `container` | 4 | `node` | as above |
| Thoth | `container` | 4 | operator image: Go 1.27.3 and Node, `--cache go` | as above |
| smartpaper-capture | `container` | 3 | operator image: Python 3.12, `uv`, Node | as above |
| smartpaper-ng | `container` | 4 | operator image: Python 3.12, `uv`, Node | as above |
| omp-control | `container` or `read-only` | 1 | operator image: `bun`, Node | as above |

Review aliases `thoth-rev` and `spcap-rev` become mode `read-only`. After a
repository's writers are ready, its host writer aliases are removed from the
configuration, and their worktrees are retired by the existing worktree-closing
rule (commits checked into the integration branch, detached on `main`, branch
deleted). `code-cursor` cannot run in a boundary (Cursor provider and
extension), so it stays a host-only route on `read-only` or host-mode
aliases, or is dropped for coding.

Writer names collide with today's host alias names: `thoth-w1` is a host
worktree today and would also be the first Thoth writer. Each repository's
host writer aliases are therefore removed in the same change that provisions
its writers.

## Operator images

Setup does not build images; it accepts a local image ID. The sprint adds one
Containerfile per toolchain with pinned base digests, built with rootless
`podman build`:

- `node-go`: Node 22 and Go 1.27.3 (Thoth);
- `node-python-uv`: Node 22, Python 3.12 and `uv` (smartpaper-capture,
  smartpaper-ng);
- `node-bun`: Node 22 and `bun` (omp-control).

Each image needs Node, Git, bash, ssh and coreutils for the acceptance
harness. A new image ID requires the provisioning command again and a new
acceptance.

## Changes to the operator workflow

- Writer registrations are project-local in Claude Code: the writer tools are
  visible only to a controller started in that repository's checkout. Codex
  sees writers only if they are registered with `--client codex`.
- Results come back through `--collect --apply` as
  `refs/remotes/writer-<name>/<branch>` in the operator checkout, and a writer
  is reused only after `--finish --apply`. This replaces cherry-picking from
  host worktrees.
- `~/.claude/rules/pi-routing.md` and `orchestration.md` must name the writer
  registrations instead of the worktree aliases. The rule that both machines
  have identical profile aliases stays; the workspace part diverges if the
  server keeps host or read-only modes.
- After every release upgrade, each writer must be accepted again, because
  acceptance binds the package version. 0.11.3 (the Pi SDK update for #120)
  therefore adds one provider-free acceptance run per writer and does not
  block the migration.

## Order and gates

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
5. smartpaper-capture, then smartpaper-ng, then omp-control, each with its
   retirement step.
6. Update the routing rules and both machines' configuration. Record the
   outcome on #79 and close it if every repository is migrated or explicitly
   left on another mode.

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
A first acceptance can fail once without a diagnosable cause. One repeated
`--apply` is allowed. A second failure stops that repository.

## Decisions needed

1. **Writer counts** per repository (proposal above: 2, 4, 4, 3, 4, 1).
2. **Images:** build the three operator images in this sprint? Which
   Containerfiles go into which repository (for example homelab-infra)?
3. **omp-control:** `container` with a `bun` image, or `read-only`?
4. **Profiles in the boundary:** `code`, `code-deepseek`, `code-glm` and
   `code-mistral`? Does `code-cursor` remain a host route for some
   repositories (which then stay `host`), or is it dropped for coding?
5. **Codex:** also register writers for Codex (`--client codex`)?
6. **Server `linuslinuxserver`:** install rootless Podman there (a privileged
   step for the operator), or set its aliases to `read-only` (coding only on
   the workstation), or keep host coding there with an explicit
   `--accept-host-writes`?
7. **Network:** keep `pasta` (not limited) for all writers?

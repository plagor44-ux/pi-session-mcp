# Design: per-repository execution modes for coding sessions

Date: 2026-10-18. Status: draft for maintainer approval. Follows ADR 0008
(accepted for Linux) and its Linux acceptance
([evidence](../../evaluation/isolation-acceptance-2026-10-18/README.md)).

## Intent

The maintainer wants it to be explicit and configurable how Pi coding sessions
run, **per repository**, set at installation and clearly documented:

- **host:** Pi writes directly in the operator's checkout. Simpler and more
  convenient; a consciously accepted risk, and visibly recorded as such.
- **container:** Pi writes only in its own full clone inside a rootless Podman
  boundary per writer (the setup accepted on 2026-10-18).
- **read-only:** no coding sessions for the repository at all.

Today the choice is implicit: the host server offers every coding profile for
every workspace alias, and the contained route exists only as hand-made wrapper
scripts and manual registrations. Nothing stops a controller from writing on the
host for a repository that was meant to be contained.

## Goals

1. A per-repository execution mode in the configuration, with a clear,
   documented meaning and risk statement for each mode.
2. Set at installation by `pi-session-mcp-setup`, changeable later through the
   same command (dry-run by default, `--apply` to change).
3. The server enforces the mode: no coding session on a repository whose mode is
   `container` or `read-only` through the host server.
4. If a repository is set to `container` and Podman is missing or unusable on
   the machine, this is **loud**: setup refuses, Doctor reports an error, and the
   contained server for that repository refuses coding sessions with a stable
   error code. Never a silent fallback to `host`.
5. Clean provisioning of container writers: a full clone from the repository's
   remote, verified before first use.
6. Clean teardown after each task: result collected as a Git bundle, then the
   writer reset or deleted, verified, with Doctor flagging leftovers.

## Non-goals

- No change to how `host` mode behaves today, apart from it becoming explicit.
- No macOS container support (Podman is unavailable there; macOS keeps the
  interim rules and can choose `host` or `read-only`).
- No in-process sandboxing of the server (rejected options 2 and 3 of ADR 0008).
- No new transport, persistence, remote access or multi-user scope.
- No token-optimizing Pi extension (see "Token consumption" below).

## Anti-goals (a failure even if it works)

- A repository set to `container` that silently runs coding on the host, for any
  reason (missing Podman, missing writer, failed reset, old configuration).
- `host` becoming the default without the operator having chosen it.
- Setup or teardown that runs host Git inside a writer's clone.
- Changes that disturb other running sessions: setup must not restart servers,
  rewrite other repositories' entries or touch the host Pi credentials.

## Decided with the maintainer

- The mode is **per repository**.
- Podman is not available everywhere and may not be installable; container mode
  must not be assumed.
- Missing Podman for a `container` repository must be loud.
- Defaults (integrator recommendation, accepted by the maintainer):
  - **Mode:** `container` when Podman is usable on the machine; when it is not,
    setup requires an explicit choice between `host` (with an explicit
    acknowledgment flag, working name `--accept-host-writes`) and `read-only`.
    There is no silent default to `host`.
  - **Writer lifecycle in container mode:** `persistent` (one or more long-lived
    writers per repository, reset after every task) by default; `ephemeral`
    (fresh clone per task, deleted afterwards) selectable per repository.
  - **Writers per repository:** default 1, configurable for parallel work.
- Reset is verified; if verification fails, the writer is recreated from scratch
  automatically (but never while uncollected work exists, see below).
- **The controller (Claude Code or Codex) finishes a task:** it collects the
  result and resets the writer, as a documented step the shipped
  `pi-session-orchestration` skill teaches. A writer with uncollected work refuses
  a new coding session until it is collected or explicitly discarded.
- **Commits and uncommitted work:** the worker commits its work on a branch (the
  implementation skill already asks for it); collect additionally captures any
  uncommitted changes as a WIP commit on a separate ref
  (`refs/remotes/writer-<name>/<branch>-wip`), created in the throwaway container,
  never on the worker's branch. Reset refuses while anything is uncollected;
  discarding needs an explicit `--discard`.
- **Providers in containers:** OAuth providers (access token only, empty refresh
  token) and API-key providers (only that provider's entry is copied into the
  boundary; the key is then a credential the boundary holds, which ADR 0008 lists
  as a residual risk). Cursor-backed profiles are allowed only after their own
  acceptance run (the same harness plus a live item through the Cursor agent);
  until then setup refuses a Cursor profile for a container repository, because
  the Cursor runtime brings its own authentication and processes (`git`, `ssh`,
  `gh`, its MCP servers) and writes below `~/.cursor` and `~/.pi/agent`, which the
  accepted runs did not cover.

## Integrator calls (marked for review)

These answer the builder check of 2026-10-18; each is the integrator's call.

- **Configuration compatibility:** the modes live in a separate file next to the
  configuration (`execution-modes.json`, like the skill bases file), not in
  `workspaces`, because the 0.8.3 schema is strict and an older server starting
  against a changed file would fail. A missing entry means mode `unset`.
- **Loud refusal without Podman:** the generated wrapper probes Podman; if it is
  unusable, it starts a small shipped host-side refusal server (no workspace, no
  Pi) whose tools answer with `container_runtime_unavailable`. The client sees a
  working server with a clear error, not a dead connection. The same path covers
  `writer_not_ready` and `writer_uncollected`.
- **Base updates without host Git in the clone:** the base for provisioning,
  reset and refresh is a bundle created by host Git in the operator's own
  checkout (trusted) and fetched inside the boundary; private repositories need
  no credentials in the boundary, and unpushed local commits can be the base.
  The remote URL is read from the operator's checkout; a URL with embedded
  credentials is refused.
- **Doctor stays offline:** it reads a writer state file maintained by setup and
  the wrapper (path-free, secret-free) and may call `podman info` locally; it
  never runs Git. Recovery operations for one repository (`--mode read-only`,
  `--writer --recreate`) bypass the Doctor gate for that repository only.
- **Acceptance delivery:** `scripts/isolation-acceptance.mjs` and
  `isolation-probe.cjs` ship in the package. The uncontained control run is a
  once-per-host precondition, run only on explicit request (it writes real
  canaries into `$HOME`). A writer is "ready (provider-free accepted)" after its
  contained run; the live item stays manual and is reported separately.
  Readiness is invalidated by a change of wrapper, image, Podman version or
  package version.
- **Toolchains:** setup ships one Node image recipe (pinned base); other
  toolchains use an operator-supplied image ID that setup records and pins, plus
  documented cache mounts (for Go: `$STATE/go`, `GOTOOLCHAIN=local`).
- **Profiles in the boundary:** the operator selects coding profiles per
  repository; `mcpServers` grants, `envFrom` and extensions are not carried into
  the boundary in v1 (refused with a finding if selected).
- **Network:** `pasta`, recorded as not limited, by default; `none` selectable.
- **Host acknowledgment:** `host` needs a stored `acceptHostWrites: true` in the
  modes file; `pi_capabilities_get` reports `unset`, `host`, `container` or
  `read-only` per workspace.
- **Transitions:** changing a repository away from `container`, or lowering the
  writer count, refuses while a writer holds uncollected work; `--writer
  --remove` refuses too unless `--discard` is given.
- **Running servers:** setup never restarts them; when a mode changes it reports
  a finding that running controllers keep the old policy until restart or `/mcp`
  reconnect.
- **Verify:** uses a wrapper mode without the credential refresh, so verify never
  touches host credentials.
- **Existing hand-made writers** (`psm-alpha`, `go-app-alpha`) are not adopted
  automatically; the migration is documented (remove, then let setup create).
  Writer names: `<repo alias>-w<n>`, state below
  `~/.local/state/pi-session-mcp/writers/<name>`.
- **Claude Code `local` scope:** setup runs the registration in the repository's
  directory.

1. **Configuration shape.** `workspaces` keeps its plain path form; the modes
   live in `execution-modes.json` next to the configuration file (see the call
   on compatibility above), keyed by workspace alias:

   ```json
   {
     "schemaVersion": 1,
     "workspaces": {
       "pi-session-mcp": { "mode": "container", "writers": 1, "lifecycle": "persistent",
                           "profiles": ["code"], "image": "node", "network": "pasta" },
       "notes": { "mode": "host", "acceptHostWrites": true },
       "docs": { "mode": "read-only" }
     }
   }
   ```

   An alias without an entry has mode `unset`: treated as `host` for
   compatibility (today's behavior), with a Doctor warning `workspace_mode_unset`
   until the operator sets it.
2. **Enforcement in the server.** On `pi_session_start` with a `coding` profile,
   the host server rejects a workspace whose mode is `container` or `read-only`
   with a new error code (working name `workspace_mode_forbids_coding`); read-only
   profiles stay allowed on every mode. `pi_capabilities_get` reports each
   workspace's mode. This changes the public MCP contract: **minor release
   (0.9.0) and a new ADR (0009)** under ADR 0003.
3. **Contained server identity.** Each container writer is served by its own
   registered server (as today: one MCP server per writer, name
   `pi-coding-<repo>-<writer>`), started through a wrapper that setup generates
   from a template. The contained server's own configuration has only that
   writer's clone as workspace (mode `host` inside the boundary, because inside
   it writing is the point) and only the profiles the operator selected.
4. **Setup surface.** New setup operations (working names):
   - `--repo <alias> --mode host|container|read-only [--accept-host-writes]
     [--writers N] [--lifecycle persistent|ephemeral]` (dry-run, then `--apply`);
   - `--writer <name> --reset|--collect|--recreate|--remove`.
   Setup refuses `container` when Podman is unusable (`podman_unavailable`), and
   generates wrapper, writer state, image pin and the client registration
   (Claude Code `local` scope by default; Codex only on explicit request, since
   it has no project scope).
5. **Provisioning.** Clone from the repository's configured remote URL (never
   from the local checkout or a linked worktree), `--no-hardlinks`, at the
   current default branch or an explicit ref; then verify from the host without
   running Git in the clone: a `.git` directory (not a gitfile), no `commondir`,
   `gitdir` or `config.worktree`, hooks limited to the shipped samples. Then run
   the provider-free contained acceptance once for that writer before it is
   registered as ready.
6. **Teardown.** `--collect` creates the bundle in a throwaway container (clone
   read-only, no network), runs the redirect-file check, verifies the bundle and
   fetches it into `refs/remotes/writer-<name>/<branch>` in the operator's
   repository. `--reset` (persistent) resets the clone inside the boundary to the
   base ref, deletes other branches, cleans the work tree (keeping ignored
   dependency caches), empties the credential copy, and verifies; failure leads to
   `--recreate`. Ephemeral writers are deleted after `--collect`.
7. **Doctor.** New checks: `workspace_mode_unset` (warning),
   `container_runtime_unavailable` (error for any `container` repository),
   `writer_not_ready` (error), `writer_dirty` and `writer_uncollected_bundle`
   (warnings), `host_mode_accepted` (an `ok`-severity line that names the accepted
   risk, so it is visible in every report).
8. **Credentials.** As accepted on 2026-10-18: the wrapper refreshes the host
   login through Pi's own locked store when it is close to expiry and copies only
   the access token (empty refresh token) into the writer. The host credential
   file is never written by setup or wrapper.
9. **Images.** One pinned image per toolchain (Node only, Node plus Go, ...),
   built from a pinned base with checksum-verified toolchains, referenced by image
   ID with `--pull=never`. Setup records which image a writer uses; changing it
   requires the acceptance again.

## Documentation

- A new operator page "Execution modes" that states each mode in one paragraph,
  with its risk in one sentence, how to choose it at installation, how to change
  it, and what Doctor and the server report.
- `installation.md` and `isolation-setup.md` link to it; the runbook becomes the
  reference for what setup automates.
- `pi_capabilities_get` and Doctor output are documented with the new fields and
  codes.

## Token consumption

Not part of this design. Current state: the token-related changes of Sprint 5
are merged but not released (installed 0.8.3), so real sessions benefit only
after a release, upgrade and skill re-installation. A Pi extension cannot reduce
controller tokens (they arise in the Claude Code or Codex context); worker-side
usage is not measured at all (#92). A possible follow-up is an extension or
adapter change that **measures** worker usage first; optimizing without a
measurement is out of scope.

## Left to the builder

- Exact flag and code names (keeping the semantics above).
- Wrapper template details, as long as they match the accepted wrapper.
- How setup stores writer state (path-free, secret-free ownership state as
  today).
- Test strategy (provider-free; Podman-dependent tests skipped with an explicit,
  reported reason when Podman is absent, never silently).
- Release mechanics for 0.9.0 under the existing release procedure.

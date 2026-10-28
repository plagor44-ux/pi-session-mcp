# ADR 0012: One registration with a leased writer pool

**Status:** Accepted (2026-10-28, maintainer decision) for release 0.12.0;
implementation tracked in
[#157](https://github.com/plagor44-ux/pi-session-mcp/issues/157). Amends
[ADR 0002](0002-embedded-pi-sdk.md) (container sessions are relayed to a Pi
session in a writer process; host sessions stay embedded),
[ADR 0008](0008-coding-profile-isolation.md) (adopts its option 4 in container
form and retires the client registration per writer),
[ADR 0009](0009-execution-modes.md) (container entries record a default base;
coding on `container` workspaces runs through the host server) and
[ADR 0011](0011-turn-events-and-controller-wake.md) (relayed sessions use the
host spool).

## Context

Today every container writer is its own client registration,
`pi-coding-<alias>-w<n>`, for Claude Code and optionally for Codex. Its
`wrapper.sh` runs the writer launcher (`writer-launch`), which checks state and
acceptance, projects boundary credentials, refreshes them every 60 s and runs
`podman run -i --rm …` with a pi-session-mcp server inside the writer's
container, bound to that writer's full clone. This follows ADR 0008: one
wrapped registration sees the union of what it mounts, so writers are isolated
from each other only with one boundary per writer.

Observed costs on 2026-10-27, with four writers for each of several
repositories:

- Each client session holds one tool set per writer registration plus the host
  set, and the controller has to pick a writer by tool prefix.
- Each registration starts its container when the client connects and keeps it
  for the whole client session: 15 idle writer containers were running on one
  workstation.
- Reset, finish and recreate replace the writer's projected credentials, so the
  running writer server needs an MCP reconnect before the next coding start
  (#136, `writer_reconnect_required`).
- Nothing stops two client processes from launching the same writer at the
  same time. The writer guard's `writer_busy` counts sessions inside one server
  process only.
- The wake hook accepts writer tool names only up to `-w16`.
- Each writer has its own base branch. `--reset --base <branch>` moves a writer
  to another branch, for example for a fix round on collected work, and a
  later `--finish` resets it to that same branch again. Today the controller
  reaches that writer by its tool prefix; a pool that picks any writer at
  baseline would ignore which branch the writer is on.

ADR 0008 listed "one sandboxed worker process per session, with the server
relaying MCP calls" as option 4 and deferred it to its own decision. ADR 0002
chose embedding to avoid subprocess and RPC translation; that choice stays for
host sessions.

## Decision

Coding on a `container` workspace runs through the one host registration,
`pi-session-mcp`. Per coding session the host server leases a writer of that
workspace, starts the writer's existing launcher as a child process and relays
the session to the pi-session-mcp server inside the writer's container.

### 1. Transport and launch path

- Each client still starts its own host server over stdio. No HTTP, socket,
  daemon or shared process is added.
- The host server spawns the writer's `wrapper.sh` with stdio pipes and talks
  MCP to the inner server through it. The launcher keeps its role: state and
  acceptance checks, credential projection and the maintainer-approved
  `getAuth` refresh (#142) stay in the launcher process, so the AGENTS.md
  exception is not widened.
- The launcher gives the session container a fixed name derived from the
  writer name (`pi-writer-<name>`), and every container that touches a writer,
  including setup's throwaway containers, a label `pi-session-mcp.writer=<name>`.
  Podman refuses a second container with the fixed name while one exists.

### 2. Fence: a lease held by the guardian process, plus container absence

Exclusive use of a writer needs both:

- **Lease held by the trusted host-side process that acts on the writer.** For a
  session that is the launcher, not the host server; for setup operations it is
  the setup process. A lock file per writer lives in a host-only lease directory
  (`~/.local/state/pi-session-mcp/leases/<name>.lock`), outside every writer
  root, never deleted, opened without following links and checked for type,
  owner and mode. The launcher takes it with a true non-blocking `flock` as its
  first step and holds it for its whole lifetime: credential warm-up and
  projection, container run, refresh, and cleanup. Setup takes it with a
  bounded wait.
- **The lease descriptor is inherited by every mutating host-side child.** The
  holder passes the locked descriptor to each child that can change the writer
  (Podman client calls, host Git against the bundles, a nested launcher started
  by acceptance), so the lock's open file description stays locked until the
  last of these processes ends. A killed holder therefore cannot leave a
  pending `podman run` or Git child behind that acts after the next holder has
  taken over. A nested launcher receives the descriptor and its number
  explicitly, verifies that it refers to the lease file (device and inode) and
  holds the lock, and uses it instead of opening a new one; this is how
  acceptance launches the wrapper while setup holds the fence. The descriptor
  is never passed into a container (no `--preserve-fds`); tests must confirm
  that neither the container nor Podman's monitor process holds it.
- **Container absence.** After taking the lease, and before any credential
  write or clone change, the holder checks through Podman that no container
  with the writer's label exists and that no container mounts the writer's
  clone (this also finds unlabeled containers started by older releases). A
  container found while holding the lease belongs to a dead holder: the holder
  stops it, waits a bounded time until Podman reports it removed, and kills it
  if needed. If absence cannot be confirmed, the writer stays fenced and the
  operation fails.

A launcher that outlives its host server keeps the lease until it has stopped
its container and joined its refresh. Only a killed launcher can leave a
container behind, and the next holder removes that container before it touches
the writer.

### 3. Every mutating operation takes the fence

Coding sessions, `--collect`, `--reset`, `--finish`, `--recreate`, `--remove`,
acceptance and every provisioning reconciliation or recovery path run under the
same fence for the whole operation, not after a separate busy check. A setup
operation that cannot get the fence reports `writer_busy`.

### 4. Base selection

- The controller selects work by base branch, not by writer. `pi_session_start`
  gains an optional `base`: a short branch name, validated with the same
  safe-ref rules setup applies to `--base`, without `refs/` prefix, commit IDs,
  `HEAD` or path syntax. It is accepted only for coding profiles on `container`
  workspaces; elsewhere the start fails with `base_not_applicable` before
  creating a session.
- Each container workspace records a **default base** in its
  `execution-modes.json` entry (`base`, a short branch name). Provisioning sets
  it from `--base` or, without one, from the existing resolution
  (`origin/HEAD`, else `main`). A repeated mode request without `--base` keeps
  the recorded value.
- A start without `base` uses the default base. A writer is a candidate only if
  its recorded `base.ref` equals `refs/heads/<base>`. Matching reads host-side
  writer state only, never the clone, and compares the branch, not the commit:
  the start result reports the writer's base commit, so the controller sees
  which state it got. Selection happens before the lease; once the inner start
  succeeded, the relay reads the writer state again and closes the session and
  moves on if the base changed in between.
- `--finish` resets a persistent writer, and recreates an ephemeral one, on the
  workspace default base instead of the writer's current base. Moving a writer
  to another branch stays an explicit `--reset --base <branch>`. A writer
  therefore leaves the default pool only for the time between that reset and
  its finish.
- Doctor warns offline with `writer_off_default_base` and a count when ready
  writers sit on another branch, because they shrink the default pool.

The fix-round flow becomes: create a local branch at the collected ref, run
`--writer <name> --reset --base <branch> --apply`, start with
`base: "<branch>"`. Default starts, from this or another client, cannot land on
that writer, and the fix-round start cannot land on a writer at the default
base.

### 5. Allocation

- Candidates are the workspace's writers in index order whose state is `ready`,
  whose acceptance is current and whose base matches (section 4). There is no
  host-side pre-filter of the clone's contents.
- The host server starts the launcher of the first candidate. A launcher that
  cannot take the lease returns `writer_busy`; an inner start that refuses
  because the clone is not at baseline or holds uncollected work also moves on.
  In both cases the host server closes that launcher and tries the next
  candidate. The inner writer guard stays the authority for baseline admission
  inside the boundary.
- Before the inner start the relay compares the requested profile's entry in
  the writer's validated `pi_capabilities_get` (permission profile, provider,
  model, thinking level) with the host's configured profile and moves on with
  `writer_settings_changed` on any difference, so a writer never runs an
  outdated version of a host profile. The launcher cannot do this check: it
  starts before the profile is known.
- If no candidate is admitted, the start fails with `writer_unavailable`, a
  content-free reason and content-free counts. `none_ready`: no writer of the
  workspace is ready, migrated and has a recorded acceptance (whether that
  acceptance is still current is decided by the launcher, which refuses a
  stale one). `none_at_base`: ready writers
  exist, none on the requested base. `none_admitted`: candidates existed and
  each refused; the counts `busy`, `notAtBaseline` and `settingsChanged` say
  why.
- The controller cannot name a writer in this version (see Alternatives).

### 6. Start, budgets and uncertain outcomes

- A container start has its own end-to-end budget (initial value 60 s, to be
  measured), split into launch and credential warm-up, MCP handshake,
  validated `pi_capabilities_get`, and inner `pi_session_start`. Every step has
  a bound below the remaining budget (cleanup of a refused candidate has its
  own bound on top), and cancellation of the outer start is
  propagated.
- The launcher's refusal server answers the handshake and lists tools, then
  returns refusal codes. Readiness is therefore decided by the validated
  capabilities and the inner start result, never by exit status or the tool
  list. Inner refusals map to the existing public codes.
- Relayed prompts get an outer preflight deadline longer than the inner one.
  If the outer side times out or loses the response while the inner turn may
  have been accepted, the relay aborts the inner turn, waits for its terminal
  state within the abort budget and reports the outer prompt as failed. If the
  inner state cannot be determined, the session is marked lost (see 8).

### 7. Relay behind `PiSessionAdapter`

- The relay is a `PiSessionAdapter`. The host registry keeps owning session
  and turn IDs, the one-running-turn rule, terminal state and the host event
  spool, so the wake hook sees relayed turns like host turns.
- The relay observes the inner turn with bounded `pi_turn_get` polling inside
  the host process. It advances activity only when the inner `updatedAt`
  changes, and carries the inner `truncated` flag into the outer result
  (`PiTurnOutcome` gains an optional `truncated`).
- **Abort.** The relay sends `pi_session_abort`, then reads the inner turn and
  settles the outer turn with the inner turn's actual terminal state: a turn
  that completed before the abort stays `completed`. A failed or timed-out
  abort marks the session lost (see 8): further prompts are refused, get and
  close keep working.
- Inner responses are untrusted data: schema-validated, size-bounded and never
  passed through as raw frames.

### 8. Lost sessions and close

- If the child exits or the transport breaks, the running turn, if any, ends
  `failed`, and the session becomes lost: further prompts return
  `writer_session_lost`; get and close keep working. This also applies while
  the session is idle.
- `pi_session_close`, server shutdown and client transport loss close the
  inner session and then the launcher's stdin. The launcher runs in its own
  process group and treats stdin end, `SIGTERM` and `SIGHUP` alike: it stops
  scheduling refreshes, joins an outstanding refresh, stops and removes its
  container, confirms its absence, and only then exits and so releases the
  lease. Its cleanup has its own bound, longer than the longest refresh.
- The host server does not wait for the full cleanup: close returns once the
  inner session is closed and the launcher has been told to stop. Fencing does
  not depend on the host server, because the launcher still holds the lease. A
  launcher whose cleanup exceeds its bound exits without releasing the
  container check: the next holder finds and removes the container (section 2).

### 9. Visibility

`pi_session_start` and `pi_session_get` report the leased writer name and its
base branch and commit for container sessions, so the controller can collect
that writer's work and see which state the session started from.
`pi_capabilities_get` reports each container workspace's configured writer
count and default base, not a free count or the branches of other writers.

### 10. Events

Relayed sessions emit terminal events through the host registry into the host
spool. The launcher starts relayed containers without the writer spool mount.
The wake hook matches the host tool names only.

### 11. Setup, migration and acceptance

- Container mode no longer registers writer servers with any client.
- Migration needs a quiescence barrier. The upgrade runbook keeps the existing
  rule to close coding sessions and controllers first, so no launcher of the
  old release is in flight, and the wrapper rebinding below makes every later
  launch, also through a not yet removed writer registration, run the new
  launcher, which takes the lease and checks container absence.
- The migration step then, per writer and under the fence, confirms that no
  container mounts the clone, removes the `pi-coding-<alias>-w<n>`
  registrations that setup owns, and marks the writer `launch: "relay"` in its
  state. Removal uses the existing ownership-checked unregister path. A
  client's inspection can health-check the registration and so start its
  wrapper, but only while setup holds the writer's lease: that launch then
  serves a `writer_busy` refusal and starts no container. A
  writer whose registration is divergent stays out of the pool and is reported;
  setup never replaces or deletes a divergent registration. Because every
  launch repeats the absence check, a legacy launch that slips through later is
  still fenced.
- Migration records the workspace default base (section 4). If all writers
  share one base branch, that branch is recorded; otherwise migration requires
  an explicit `--base` and stops with `workspace_base_ambiguous` without it.
- `wrapper.sh` stays as the launch entry point at its stable path. Wrappers
  embed an absolute release root, so migration rewrites the wrapper of every
  writer it migrates for the new release before the writer is marked
  `launch: "relay"`. A writer held back by settings drift or a divergent
  registration keeps its wrapper unchanged; it stays out of the pool, and its
  retained registration must not be used until the operator resolves it. With
  a release installed at the same path, such a wrapper already runs the new,
  fenced launcher. Acceptance keeps binding the wrapper, release version and
  launch settings. Because the launch arguments
  change (container name, no spool mount for relayed sessions), every writer is
  re-accepted provider-free through the relay launch path before it becomes a
  pool candidate, as on any release upgrade.
- Verify checks the host registration, Doctor, and for each writer a bounded
  spawn through the relay path with credential refresh suppressed, MCP
  handshake, `tools/list` and validated capabilities, without starting a
  session or using a provider.
- `writer_reconnect_required` is removed: reset and finish run under the fence
  and no long-lived writer server exists between sessions.
- Doctor stays offline. It gains checks for the lease directory, for writers
  not yet migrated, for container workspaces without a recorded default base,
  and the `writer_off_default_base` warning (section 4).

## Boundary

The product boundary stays local stdio, in-memory state and one trusted local
MCP peer per server process. The writer boundary is unchanged: one container
and one full clone per writer, the same mounts and exclusions, `.git/config`
and hooks read-only, and no host Git inside a clone. What changes is who starts
the launcher (the host server instead of the client) and when (per session
instead of per client connection). The host server already runs with the
operator's rights; setup and the launcher already run Podman today.

## Consequences

- One tool set per client; no per-writer registrations; no idle writer
  containers.
- A coding start on a container workspace takes seconds longer.
- No reconnect after reset or finish. Reset, finish and collect refuse while a
  session holds the writer.
- Two clients cannot use the same writer at the same time, including after a
  crash of the previous holder.
- Follow-up rounds on collected work keep the branch and reset steps and add
  `base: "<branch>"` to the start (section 4). Default starts never land on a
  writer moved to another branch.
- `--finish` returns a writer to the workspace default base instead of keeping
  the branch it was last reset to.
- Contract change: the optional `base` start argument, new error codes
  (`writer_unavailable` with reason and counts, `writer_session_lost`,
  `base_not_applicable`), the writer and base fields in session results, the
  default base in capabilities and an optional `truncated` in the adapter
  outcome. Minor version bump (0.12.0) with re-acceptance of every writer.

## Alternatives considered

- **Keep one registration per writer and add only the fence.** Fixes the
  concurrent-launch gap, but keeps the tool sets, idle containers and
  reconnects. Rejected as the end state; the fence is reused.
- **Fewer writers per repository.** Configuration only; reduces but keeps every
  cost. Rejected by the maintainer (2026-10-28).
- **A shared pool daemon over HTTP or a Unix socket.** Would let clients share
  sessions, but adds a long-lived service, persistence and multi-client trust,
  all outside the product boundary. Not needed for the goal.
- **Spawn `podman run` from the host server directly.** Moves the credential
  refresh into the host server and widens the AGENTS.md exception, and drops
  the acceptance binding to the wrapper. Rejected in favour of spawning the
  launcher.
- **Pass the lease descriptor into the container.** Would keep the lock until
  the container ends, but a process inside could release it with `LOCK_UN` on
  the shared open file description. Rejected in favour of a host-side holder.
- **Hold the lease in the host server.** The host server can die while its
  launcher still writes credentials or starts a container. Rejected in favour of
  the launcher as the holder.
- **Server picks any writer at baseline, ignoring its base.** Simplest
  contract, but a fix-round start can land on a writer at the default base, and
  an unrelated start can land on a writer just reset to a fix branch, also from
  another client. Rejected.
- **Controller names the writer.** Deterministic and close to today's flow,
  but capabilities would have to list writer names, a pinned busy writer fails
  instead of falling back, and a start without a name could still land on a
  writer moved to another branch, so base matching would be needed anyway.
  Deferred; a diagnostic writer argument can be added later without breaking
  the contract.
- **Preferred writer with silent fallback.** Can silently start work from the
  wrong branch. Rejected.

## Open questions

- Measured start budget on the reference machines.
- Whether ephemeral writers recreate on close instead of on finish.

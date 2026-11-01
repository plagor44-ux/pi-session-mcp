# Execution modes

Execution modes record the operator's choice **per configured repository workspace alias**.
A profile selects tools and provider; the mode decides whether the host server
permits coding. [ADR 0009](adr/0009-execution-modes.md) covers policy (Plan A)
and automated rootless-Podman writers (Plan B). Both ship in 0.9.0; the release
does not itself prove a live rollout or acceptance on your machine.

## Modes and risks

- **`host`:** coding writes in the operator's checkout; requires stored
  `acceptHostWrites: true`. Tools, providers and trusted extensions run with
  the host process's rights, not inside an OS boundary.
- **`container`:** coding goes through the one host `pi-session-mcp`
  registration, which leases a separate full-clone writer per session on Linux
  with usable rootless Podman ([ADR 0012](adr/0012-leased-writer-pool.md)).
  There are no per-writer registrations or tool sets. A mode entry alone is
  not containment: each writer needs successful acceptance.
- **`read-only`:** the host refuses coding; read-only profiles remain available.
  This is tool policy, not an OS sandbox for provider runtimes or child processes.
- **`snapshot`:** a read-only review slot that setup materializes from the
  operator checkout of a `source` alias (`host` or `container`) at a fixed
  commit ([ADR 0015](adr/0015-review-snapshots.md)). Coding is refused; only
  read-only profiles without extensions, granted extension tools or external
  MCP servers may start. See [Review snapshots](#review-snapshots).
- **`unset`:** a missing entry retains host coding for backward compatibility.
  Doctor warns if a coding profile exists. This is a migration state, not a
  selectable mode or an acknowledged host-write choice.

Read-only profiles may individually grant extension tools through
`grantedExtensionTools` ([ADR 0010](adr/0010-read-only-extension-tools.md)).
A grant is the operator's trust decision: these tools are third-party code and
may write. Workspace modes `container` and `read-only` do not restrict them;
read-only profiles remain allowed in every mode. Extension hooks already run
with the server user's rights. Do not treat the profile or workspace label as
an OS sandbox for extensions.

**Residual risks:** the boundary holds provider credentials: an OAuth access
token (with refresh token emptied), or the API key for API-key providers.
A malicious worker can use or exfiltrate them. Network `pasta` is **not limited**;
setup supplies no provider-only proxy or firewall. `none` removes network access
entirely, including access to remote providers. Runtime escapes remain a risk.
macOS containment is not accepted; host and read-only choices remain available,
but writer setup and lifecycle operations are Linux-only.

## Choose at installation

Configure aliases and profiles as in [Installation](installation.md#2-configure),
set `PI_SESSION_MCP_CONFIG`, and use a release installation with production
dependencies, not a development checkout. Never pass a workspace path.

```sh
# Plans only; no mutation, image pull, credential refresh or acceptance run.
pi-session-mcp-setup --repo my-project --mode container --profiles code
# Explicit host control: creates real canary files below $HOME and removes them.
pi-session-mcp-setup --isolation-control --repo my-project --apply
# Provisions and accepts the writer pool; no writer registrations.
pi-session-mcp-setup --repo my-project --mode container --profiles code --apply
```

The control runs without containment on a disposable clone. Without `--apply`
it only plans. Writers stay not ready with `isolation_control_required` until
this host control has passed. It is not an implicit side effect of provisioning.
The contained provider-free acceptance harness must then pass for each writer.
A successful runtime probe alone proves neither readiness nor containment.

With no `--mode`, setup chooses container only if its local rootless Podman
probe succeeds; otherwise explicitly choose host with acknowledgment or read-only:

```sh
pi-session-mcp-setup --repo my-project --mode host --accept-host-writes
pi-session-mcp-setup --repo my-project --mode read-only
pi-session-mcp-setup --repo my-project --mode container --profiles code,code-local \
  --writers 2 --lifecycle persistent --image node --network pasta
```

Repeat the reviewed request with `--apply` to mutate. Mode requests cannot be
combined with `--target` registration or `--customize-skill`.
A `--repo` dry run for a container alias inspects existing writers using
read-only throwaway containers: no network access and nothing written to the
clone.

| Flag | Accepted values and defaults |
| --- | --- |
| `--repo <alias>` | Configured alias, never an arbitrary path |
| `--mode <mode>` | `host`, `container`, `read-only`; omitted probes before choosing container |
| `--accept-host-writes` | Required for every explicit host request |
| `--writers N` | 1–16; default 1 |
| `--lifecycle <value>` | `persistent` (default) or `ephemeral` |
| `--profiles a,b` | Required non-empty coding-profile aliases; no Cursor provider |
| `--image <value>` | `node` (default, built-in digest pin) or an existing local 64-character lowercase hex image ID; no arbitrary tags |
| `--network <value>` | `pasta` (default, not limited) or `none` |
| `--tags <value>` | `none` (default), or `reachable` for the tags reachable from the selected base commit |
| `--clean <untracked\|all>` | `untracked` (default) keeps ignored files; `all` also removes ignored files on reset and finish |
| `--cpus <n>` | Hard CPU cap, > 0 through 1024, at most two decimals; `none` removes it; unlimited unless set |
| `--cpu-shares <n>` | Relative CPU weight under contention, integer 2–262144; `none` removes it; Podman default 1024 |
| `--memory <size>` | Hard memory cap, 1–9999999 plus lowercase `m` or `g`; `none` removes it; unlimited unless set |
| `--cache <value>` | `none` (default), `go` for the writer's Go module/build cache, `uv` for its private uv and npm cache, or `npm` for its private npm-only cache |
| `--base <ref>` | Named local or remote branch for provisioning; also supported by writer reset; not HEAD or a raw commit hash |
| `--client codex` | No writer effect; coding uses the host registration for either client |
| `--discard` | Explicitly allow loss of uncollected surplus writers on mode/count changes |
| `--dry-run` / `--apply` | Dry-run is the default; apply mutates |
| `--json` | Sanitized JSON projection of the same report |

Container flags do not apply to explicit host/read-only requests. Mode selection
supports dry-run and apply, not verify/rollback/remove. Container settings are
rebuilt from supplied values and defaults, not merged with the prior entry:
supply the full intended settings, including profiles, on each mode request.
Selected profiles must have `default: false`, permission `coding`, no extensions
or external MCP grants, and only builtin skill-catalog entries for skills that
the package ships and that no operator override replaces, because overrides do
not reach the writer ([Skills](skills.md#builtinname-in-the-catalog)). Setup
rejects unsupported profiles rather than silently weakening them. Doctor checks each selected container profile offline with the same rendering rules and reports `container_profile_refused` before provisioning, or a workspace error if the original configuration cannot be read.

## Writer storage, launch and readiness

Setup writes `execution-modes.json` beside the main configuration, preserving
other workspace entries. The main configuration's `workspaces` stays an
alias-to-path map. Older servers ignore modes; upgrade all relevant registrations.
Invalid modes fail startup rather than silently falling back.

Writers are `<alias>-w1` through `<alias>-w16`, leased by the host server,
not selected by tool prefix. Their private state lives under
`$HOME/.local/state/pi-session-mcp/writers/<name>/`: `clone`, `agent`, `config`,
`bundles`, optional `go`, `wrapper.sh` and `state.json`. This lifecycle metadata
is distinct from in-memory MCP sessions; it does not implement session resume.
The writer's `agent` directory also receives a byte copy of the host's persisted
Pi model catalog (`models-store.json`, catalog data and no credentials) at
provisioning, reset, recreate and each launch, so that a writer resolves the same
models as the host. A missing, linked or oversized host file is skipped and the
writer keeps the SDK's shipped model list.
Each clone is made via a bundle, with no hardlinks to the operator's repository.
The workspace records a short default `base` in its container entry, selected
by `--base` or origin's symbolic HEAD, falling back to local main. Repeating a
mode request without `--base` preserves that recorded value. Migration infers
a shared writer base or fails with `workspace_base_ambiguous` unless given one.
Capabilities report configured `writers` and `defaultBase`, not free capacity.

Start with an explicit coding profile on `pi-session-mcp`. Optional `base` is
only for container coding and selects a branch, not a writer; elsewhere it
fails with `base_not_applicable`. Start and get report `writer` and
`base: { ref, commit }`. Omit `base` for ordinary default-pool work.

The generated wrapper launches one disposable `podman run -i --rm` per coding
session: keep-id user namespace, read-only root, dropped capabilities,
no-new-privileges, tmpfs home and /tmp. The clone and isolated agent copy are
writable; clone hooks/config, boundary config and release installation are
read-only mounts. Host Git never runs in the clone. Throwaway lifecycle
containers use no network and validate clone redirect metadata before export.

Optional profile `maxTurnSeconds` (strict integer 60..86,400, absent = no limit)
is copied into the contained configuration. Only the inner server owns and arms
the turn deadline; the outer registry never arms one for a writer placement.
The relay preserves `abortReason: "deadline"` on aborted turns and the
`turn_deadline_uncertain` refusal code, which makes the outer session non-reusable
as well: close it. Expiry never collects, discards, resets or reallocates the
writer. The lease continues fencing it after an uncertain abort. This is not a
provider-stop, rollback or cost guarantee. Keep controller per-task budgets.
Re-provision existing writers after setting or changing the policy; an old inner
profile without the field mismatches the new host policy (`settingsChanged`).
Older releases reject configurations with the field.

Each contained config has only its workspace and selected coding profiles,
plus the synthetic default **`boundary-read-only`**. Coding sessions must name
their coding profile explicitly. The clone's internal mode is acknowledged host
because writes there are intended *inside* the boundary; the operator's host
alias stays container and routes coding through the relay, never host tools.

State phases are provisioning, not_ready and ready. Acceptance binds wrapper
bytes, package version, image ID, Podman version, network and cache settings.
Changed bindings require renewed acceptance, which the next `--repo <alias>
--apply` runs for every kept writer whose acceptance is not current, a ready
phase included (after a package upgrade, for example). Existing
non-provisioning writers with changed provisioning settings are refused, not
silently replaced. Review
and collect work before removing/reprovisioning them. Restart/reconnect affected
controllers after successful changes; setup never restarts them.

**Inspection has side effects:** `claude mcp get` health-checks the host
registration, starting the host server but no writer container. Writer verify
explicitly spawns the fenced relay launch path. Doctor alone is offline:
it starts no writer, session or provider request and reads no credentials.

The launcher copies only selected providers from the host Pi auth store at launch
and checks every **60 seconds**. It refreshes a selected OAuth credential on the
host only when it expires within **10 minutes** or has expired (an invalid/missing
expiry is treated as needing refresh). The refresh asks the Pi SDK for ten minutes
of remaining validity through Pi's own locked store without a model request and
is bounded at 20 seconds; tokens farther from expiry are left alone, so it is not
an unconditional token rotation. The launcher then re-copies boundary credentials
even if the refresh failed. API-key entries are copied, not refreshed; Cursor
credentials are excluded.

## Recover an unmerged writer

When collection fails because the writer has an unmerged index, recovery exports
an inspection snapshot without authorizing cleanup:

```sh
# Dry run: resolves the configured workspace alias only; checks no writer state.
pi-session-mcp-setup --writer my-project-w1 --recover
# Close the coding session first. Runs under setup lock, writer lease, fence and Doctor gate.
pi-session-mcp-setup --writer my-project-w1 --recover --apply
```

Recovery runs Git in the recorded image, with no network and the clone mounted
read-only. It never changes the clone's index, refs or worktree, `state.json`, or
an earlier collected digest. The fence can stop and remove a container left by
its launcher. Host Git imports a verified bundle into the operator's checkout,
not from the clone. No provider is used. A clone defining `filter.*` or `include*`
configuration is refused; external attributes are disabled.

Recovery requires a host Git whose ref transactions refuse `create` onto an
existing symbolic ref, including a dangling one. This capability is checked at
run time with the same Git in a fresh temporary repository outside the operator
checkout, without network access and before any import fetch or ref write. The
probe repository is removed afterwards on every path. Recovery fails closed with
`writer_recover_failed` if the probe fails; no refs or objects are imported.
This behavior has been verified with Git 2.53.0 and 2.56.0, but not 2.39.5 (which
replaces the dangling symbolic ref). This is a behavioral requirement, not a
version-number check.

A successful report names a numeric **slot**. Review these untrusted refs in your
own checkout: `refs/recovery/writer-<name>/<slot>/{stage1,stage2,stage3,worktree,manifest}`.
A stage ref exists only if that stage has conflict entries. Its tree is **HEAD
with the conflicted paths at that stage**, deleting a path missing at that stage;
it is not the full corresponding side of a merge. Cleanly merged paths from the
other side are not in it. The manifest contains the raw NUL-delimited
`unmerged-index.txt`, `head.txt`, and `merge-head.txt` when present. Every recovery
commit has the recorded HEAD as its parent.

**Preserved:**

- Conflict markers and untracked, non-ignored worktree files.
- Index stages 1, 2 and 3 of conflicted paths, including modes and symlinks.
- HEAD, MERGE_HEAD and the raw unmerged index entries in the manifest.
- HEAD history, through commit parents.

**Not exported:**

- Staged-only (stage-0) content that differs from the worktree.
- Other local branches, tags, notes and any other refs.
- The stash.
- Ignored files.
- Reflogs and unreachable objects.
- Rebase or cherry-pick sequencer state.

Gitlinks in the index or export, including an untracked nested repository that
`add -A` would turn into a gitlink, refuse the entire recovery.
**`--discard` after a recovery destroys everything in the not-exported list.**
Recovery is not a complete backup and does not authorize discarding work.

Slots are create-only and never reused; the next slot is one above the highest
numeric slot (cap 10,000). Part refs are created in a no-dereference transaction,
then the manifest ref in a second transaction. Only a slot with its manifest ref
is complete. A killed or failed commit can leave incomplete part refs: the next
recovery reports those slots and uses a new one, never deletes or rolls back refs.
The operator owns all recovery refs and decides when to delete them. Bundle files
are removed on success and failure; a leftover is also visible to Doctor as
`writer_uncollected_bundle` and is replaced by the next recovery.

| Code | Meaning |
| --- | --- |
| `writer_recover_planned` | Alias resolved; nothing else ran |
| `writer_recovered` | Complete slot created; report names the slot |
| `nothing_to_recover` | No unmerged entries; unchanged |
| `writer_recover_unsupported` | Gitlink refused; nothing imported |
| `writer_recover_conflict` | Existing destination (including symbolic refs) refused |
| `writer_recover_incomplete` | Failed/incomplete slot, with its number; earlier incomplete slots are warnings alongside the current result |
| `writer_recover_failed` | Other failure, including state/alias/layout, objects, bundle verification, manifest mismatch, fsck or the slot cap |
| `writer_recover_bundle_left` | Warning alongside the main result: bundle removal failed |

Shared setup failures remain unchanged: `usage_invalid`, `platform_unsupported`,
`alias_unknown`, `writer_busy`, `writer_lease_unavailable`, `writer_fenced`,
`doctor_failed` (followed by findings), setup-lock codes and
`writer_operation_failed`. Doctor runs before checking required writer state.
Warnings accompany the main finding without turning a later complete slot into
an incomplete one. JSON reports carry the numeric `slot`; human reports name it.

Collect, finish, reset, recreate and remove remain refused without `--discard`,
before and after recovery. Resolve the conflict in your own checkout from the
recovery refs, decide whether anything outside the preserved set matters, and
only then run `--reset --discard --apply` (or recreate) on the writer. Recovery
refs are yours to delete. See [ADR 0016](adr/0016-writer-recovery-export.md).

## Collect, finish and reuse

Close the writer's coding session before lifecycle mutation. Take over and review
the result in the operator's checkout, never by running host Git inside the clone:

```sh
pi-session-mcp-setup --writer my-project-w1 --collect --apply
# Review refs/remotes/writer-my-project-w1/<branch> in your own checkout.
pi-session-mcp-setup --writer my-project-w1 --finish --apply
```

Collection exports changed branches via a bundle into the operator's checkout as
`refs/remotes/writer-<name>/<branch>`. Uncommitted/untracked work is captured as a
synthetic `<branch>-wip` commit. A staged index whose tree differs from both
HEAD's tree and the worktree (for example a staged change that the worktree
reverted) is exported as an extra synthetic `<branch>-index` commit, so work
that exists only in the index is recovered too; the same name rules apply. An
index that cannot be evaluated, such as an unmerged conflict, makes inspection
and collection fail closed and every non-`--discard` cleanup refuse. Such a
writer is not at its baseline, so it is not admitted to a new session either;
its work stays in the clone. Use [recovery export](#recover-an-unmerged-writer)
for review before deciding on `--discard`, or have the worker resolve or abort
a merge before its session ends. A clean detached HEAD whose commit no branch in
the clone reaches is exported as `<base>-detached` (for example `main-detached`,
imported as `refs/remotes/writer-<name>/main-detached`); a dirty detached HEAD
keeps the `<base>-wip` export. A `<base>-detached`, `<branch>-wip` or `<branch>-index` name that
an exported branch already takes, or that conflicts with an exported branch's
path (such as a branch `main-detached/topic`), is refused and makes collection
incomplete (`writer_collect_incomplete`); the other branches are still
exported. Clone-side Git ignores replace refs. These refs are **untrusted until reviewed**;
setup does not merge or cherry-pick them. Collection does not change the clone.
Only a complete export records a digest authorizing later destructive cleanup,
and the digest is recorded only when the clone's HEAD commit and every branch
commit exist in the operator checkout; otherwise collection is incomplete
(`writer_collect_incomplete`) and no digest is recorded. This includes the base
commit: if the operator checkout no longer has it (for example after a deleted
base branch and garbage collection), collect and finish fail this way even on a
pristine writer, without refused names; fetch the base again or resolve with
`--reset --discard --apply`. The digest also covers the index tree, and the
index and worktree tree objects must exist in the operator checkout. New work,
including a change to the index alone, invalidates that authorization. A digest
recorded by 0.14.1 or earlier never matches the versioned digest, so collect
such a writer again before a destructive operation.

Index flags the worker sets (`assume-unchanged`, `skip-worktree`) never hide
edits from inspect and collect ([#231](https://github.com/plagor44-ux/pi-session-mcp/issues/231),
same class as #193 and #228). Both scripts work on a copy of the index: they
clear `assume-unchanged` on every entry and `skip-worktree` on every entry whose
path exists in the worktree, and they ignore a sparse-checkout setting of the
clone. An entry whose file is absent (a sparse checkout) keeps its index blob, so
it is neither a deletion nor lost work. Reset clears both flags on the clone's
own index before it checks out the base, because Git refuses to replace a
modified flagged file. It first rebuilds the index from HEAD, so an unmerged
index does not block a discard. [ADR 0015](adr/0015-review-snapshots.md) refuses any
index flag when it verifies a review snapshot. Writers neutralize instead: a
refusal would make every sparse or flagged writer impossible to reset or finish
without `--discard`, and the work is exported by collect either way.

Every stash entry is exported as `<base>-stash-<n>`, numbered like
`stash@{n}` (newest first; for example `main-stash-0`), with its index and
untracked parts as the commit's parents; `git stash apply` accepts the imported
ref. The same name rules apply, and every stash commit must exist in the
operator checkout before a digest is recorded. Tags, notes, replace refs,
remote-tracking refs and refs in any other namespace are not exported, whatever
their names. Each must name an object the operator checkout already has,
otherwise the writer is not at its baseline and collection is incomplete
(`writer_collect_incomplete`, without a refused name) and no digest is
recorded. Provisioned tags and remote-tracking refs, and a lightweight tag on
an exported commit, pass while the operator checkout still has their objects:
only such a ref's name is lost at cleanup. An annotated tag, a note, a replace
ref or a moved remote-tracking ref that the worker created blocks cleanup until
a later session on that writer removes it or the operator decides on
`--discard`; the server guard admits such a writer as long as its branches,
stash and worktree are at the baseline. If the operator deletes a provisioned
annotated tag and its object is garbage-collected, the writer's copy blocks
cleanup the same way.

`--finish` collects, then resets a persistent writer or recreates an ephemeral
writer, on the workspace default base. A collect refusing any branch name is incomplete (`writer_collect_incomplete`,
`ref_name_refused`), even if other refs were imported. Finish stops without reset
or recreation. Resolve by renaming inside the writer and collecting again, or
by an operator's explicit `--reset --discard --apply` after deciding to lose the
unexported work. Do not blindly retry or bypass a refusal by changing profiles.

| Writer operation | Behavior |
| --- | --- |
| `--collect --apply` | Bundle export; retain clone |
| `--reset --apply [--base <ref>]` | Reset to current source base branch, delete extra branches/stash and clean untracked files, and ignored files with `--clean all`; falls back to recreation if post-reset verification fails |
| `--recreate --apply` | Rebuild clone and agent copy from the workspace default base, retaining image/settings |
| `--finish --apply` | Collect, then reset persistent / recreate ephemeral on the workspace default base |
| `--remove` | Explicit mutation: unregister owned registrations before removing writer state; read-only directories inside the writer root (such as Go's module cache) are made removable first, and `state.json` is removed last |
| `--verify` | Doctor and bounded relay-path MCP handshake/tools/list/capabilities; verify the host registration with client-target verify too; no session or provider request |

### Setup under load

Writer setup stays fail-closed on a healthy but slow host (#229). Three rules apply:

- **Runtime probe.** Doctor's rootless Podman probe (`podman info`, 10 seconds
  per attempt) is repeated once when the first attempt ended by its timeout. An
  error or an answer other than `true` stays unusable at once, and a runtime
  that times out twice is still `container_runtime_unavailable`.
- **Doctor gate.** A repository step or mutating writer operation no longer
  counts another repository's `container_runtime_unavailable` as blocking. The
  probe is host-wide, and the step uses Podman for its own repository and fails
  closed with its own code when Podman is really unusable. Every other blocking
  error of another repository still blocks with `doctor_failed`.
- **Global lock.** All mutating writer setup operations take one global lock in
  the writers state directory and wait up to 120 seconds for it, then report
  `override_lock_busy`. The lock stays global because it serializes what the
  operations share: the execution-modes file, writer state, writer leases,
  ownership and hook state. Other users of the lock (skill customization and the
  modes step) keep their 30 second wait. The lock records no holder information.

Other than explicit `--remove` and `--verify`, omitting apply only plans.
Reset/recreate/remove refuse changed uncollected work unless given `--discard`.
Every mutating writer operation holds the host-only lease and container fence,
including collect, acceptance and reconciliation. A held session (even idle)
or launcher cleanup makes setup fail with `writer_busy` after a 10-second wait,
also with `--discard`; close sessions first. Only reset accepts `--base`;
finish does not accept discard. No reconnect is needed after reset, finish or
recreate.

For a fix round, create a local branch at the collected ref in the operator's
checkout, run `--writer <name> --reset --base <branch> --apply`, then call
`pi_session_start` with the coding profile and `base: "<branch>"`. Read `writer`
from the result for collection; default starts cannot take a writer on that
other branch. `writer_unavailable` is a capacity/state signal, not a reason to
switch profiles; see [Tool contracts](tool-contracts.md).

**Verify:** the direct relay-path MCP handshake uses
`PI_WRITER_NO_CREDENTIAL_REFRESH=1`, touching no credential in that launch and
making no session or provider request. Host registration equality is checked
by client-target verify; no writer registration is required. **Setup itself
never writes the host credential file**; host login updates, when needed, are
performed by Pi through its locked store.

The server guard refuses coding when the clone differs from its recorded baseline
(extra branches, stash, uncommitted/untracked changes, or different HEAD), and
while another coding session is open. It re-reads the guard file each time, so a
reset updates admission without a server restart. A missing/unusable runtime or
stale/unready writer launches a refusal MCP server: all eight tools return the
sanitized refusal, with no host fallback. See [Tool contracts](tool-contracts.md).

Before the relay starts an inner session it compares every public capability
field of the writer's profile with the host profile: `permissionProfile`,
`provider`, `model`, `thinkingLevel`, `shell` and `maxTurnSeconds` exactly, and `skills`,
`extensions` and `grantedExtensionTools` as sets. A mismatch or a missing
entry counts as `settingsChanged`, starts no inner session and moves on to the
next writer; if no writer is admitted, the start fails with
`writer_unavailable` and reason `none_admitted`.

## Review snapshots

A `snapshot` workspace lets a reviewer read exactly one commit while the
operator keeps working in the source checkout. The workspace path is derived,
never chosen: configure the alias with the path
`~/.local/state/pi-session-mcp/snapshots/<alias>/worktree` (Doctor reports any
other path as `snapshot_path_mismatch`), then:

```sh
# Records the mode; dry-run without --apply.
pi-session-mcp-setup --repo my-review --mode snapshot --source my-project --apply
# Plans, then materializes the slot at a full commit ID (never a ref name).
pi-session-mcp-setup --snapshot my-review --head <commit-oid> --base <commit-oid>
pi-session-mcp-setup --snapshot my-review --head <commit-oid> --base <commit-oid> --apply
# Removes a clean slot (mutates without --apply, like --writer --remove).
pi-session-mcp-setup --snapshot my-review --remove
```

Before anything is created, the source checkout must contain both commits, the
head tree must contain no gitlink, and the source's effective Git
configuration must define no `filter.*.clean`, `filter.*.smudge` or
`filter.*.process` driver and no enabled `core.fsmonitor`. Apply takes the
slot's exclusive lock (`snapshot_busy` while any session holds the slot) and
the setup guardian; every mutating Git command runs through the guardian with
the lock descriptor, so a killed setup cannot let a second apply overlap a
surviving Git child. An existing slot is replaced only if it verifies clean,
including ignored files and index flags; a modified one fails with
`snapshot_modified` until `--discard` is added. An incomplete slot (left by a
crash) is recovered only when its directory is a linked worktree of the source
whose administrative entry names it; setup never runs `git worktree prune` and
never deletes an unrecognized occupant of the derived path. The state is written
last. Snapshots are Linux-only in this release: setup mutation fails
elsewhere with `snapshot_unsupported_platform`, and a session start on another
platform fails with `snapshot_unavailable`, because the slot lease needs the
trusted util-linux `flock`. Git comes from `/usr/bin/git` or
`/bin/git` with hooks, fsmonitor and replace refs disabled, file modes
compared and absolute worktree back-pointers.

Sessions take a shared lease on the slot and verify it at start, before every
prompt and after every turn; see [Tool contracts](tool-contracts.md#session-start).
This detects changes at those points but does not prevent them: the tree stays
writable by the host user. Snapshot mutations are bounded to 120 seconds, so
materializing a very large tree can fail with `snapshot_unavailable`; rerun
with `--discard` to drop the partial slot. A registration that the operator
locked with `git worktree lock` is never removed, even with `--discard`.
`--head` and `--base` must be commit object IDs, not tag objects.

| Code | Meaning |
| --- | --- |
| `snapshot_planned` | Dry-run: the slot would be (re)materialized |
| `unchanged` | The slot already verifies against the same head, base and tree |
| `snapshot_applied` | The slot was materialized, verified and its state written |
| `snapshot_discarded` | A modified or unrecognized-but-registered slot was dropped because of `--discard` |
| `snapshot_removed` | `--remove` removed the slot, its registration and its state |
| `absent` | `--remove` found nothing to remove |
| `snapshot_alias_invalid` | The alias is not a `snapshot` workspace, or its source is missing or not a `host` or `container` workspace |
| `snapshot_path_mismatch` | The configured workspace path is not the derived slot worktree |
| `snapshot_unsupported_platform` | Mutation requires Linux |
| `snapshot_unavailable` | No trusted Git or `env`, a Git command failed or timed out, or the guardian fence was lost |
| `snapshot_object_missing` | The head or base commit is missing in the source checkout |
| `snapshot_submodule_present` | The head tree contains a gitlink |
| `snapshot_source_unsupported` | The source or slot Git configuration defines a conversion driver or an enabled fsmonitor |
| `snapshot_busy` | A session or another setup holds the slot |
| `snapshot_modified` | The recorded slot changed; nothing was removed (add `--discard` to drop it) |
| `snapshot_incomplete` | A slot without valid state is not a clean, recognized worktree of the source, or more than one registration names it; kept until `--discard` |

## Reports and finding codes

Reports use sanitized targets `modes/workspace/<alias>` or `writer/<alias>/<name>`
(the control uses `writer/host/control`). General ownership/lock/client codes can
also propagate; see [Installation](installation.md) and [Doctor](doctor-design.md).
Each literal finding emitted by the writer orchestrator/lifecycle/acceptance is
listed below; dynamic planned and MCP verification outcomes are listed explicitly.

| Code | Meaning |
| --- | --- |
| `mode_planned` | Proposed mode change only |
| `mode_applied` | Mode entry written |
| `mode_unchanged` | Choice already matches; reconciliation still runs |
| `mode_choice_required` | No automatic container choice; choose host or read-only explicitly |
| `host_ack_required` | Host request lacks acknowledgment |
| `container_profiles_required` | Non-empty coding profile list required |
| `container_runtime_unavailable` | Rootless Podman is unavailable/unusable |
| `alias_unknown` | Invalid or unconfigured alias |
| `modes_file_invalid` | Existing or proposed modes invalid; no replacement |
| `config_invalid` | Configuration cannot be loaded/validated |
| `controllers_restart_required` | Reconnect/restart controllers to load current policy and registrations |
| `platform_unsupported` | Writer operation requires Linux |
| `usage_invalid` | Invalid writer name or argument combination |
| `doctor_failed` | Relevant blocking Doctor checks failed; repository steps and mutating writer operations also report each blocking check as a separate failed finding with its Doctor check id and target `client: "doctor"`, `scope: "check"`, and as alias the profile or workspace alias that leads the check's subject (the part before `:`, and for a writer name its alias), or `"invalid"` for a global check or when that is not a valid alias |
| `writer_planned` | Writer would be retained/provisioned |
| `writer_limits_update_planned` | Existing writer limits would be updated without reprovisioning |
| `writer_limits_updated` | Existing writer limits updated under its fence |
| `cgroup_controller_unavailable` | Requested CPU or memory controller is unavailable; mode was not written |
| `writer_remove_planned` | Surplus writer would be removed |
| `writer_collect_planned` | Collection planned only |
| `writer_reset_planned` | Reset planned only |
| `writer_recreate_planned` | Recreation planned only |
| `writer_finish_planned` | Finish planned only |
| `writer_provisioned` | Clone/config/wrapper prepared, not yet accepted |
| `writer_unchanged` | Provisioned settings already match |
| `writer_settings_changed` | Existing writer settings or its rendered configuration differ from the current ones; no silent replacement, no acceptance and no registration change, and an apply is refused before the mode is written ([Isolation setup](isolation-setup.md)) |
| `registration_divergent` | Writer registration is foreign or differs from its ownership record; it is retained and the writer stays in legacy launch mode |
| `writer_reconcile_failed` | Unexpected reconciliation failure of shared setup state (configuration, ownership); a failure of one kept writer is reported on that writer's target with its own code, and the other writers are still reconciled |
| `writer_operation_failed` | Unclassified lifecycle/orchestrator failure |
| `hook_install_failed` | The wake hook step of a writer failed unexpectedly; other `hook_*` and `settings_*` codes are in [Client setup](client-setup.md#wake-hook) |
| `container_profile_unsupported` | Profile or selected skills cannot be rendered safely in boundary |
| `base_ref_invalid` | Base is not a supported safe named branch |
| `writer_base_unavailable` | Host Git could not resolve/read/export base |
| `remote_url_refused` | Origin URL contains URL userinfo |
| `image_unavailable` | Image missing/invalid or pinned pull failed |
| `writer_clone_failed` | Contained clone creation failed |
| `clone_verification_failed` | Clone layout/hook/config redirects unsafe |
| `writer_state_invalid` | Missing/malformed/mismatched writer state |
| `writer_state_unreadable` | Writer state cannot safely be read |
| `writer_inspect_failed` | Contained work inspection failed, including an index that cannot be evaluated such as an unmerged conflict |
| `writer_uncollected` | Changed work lacks a matching complete collection digest; destructive operation refused |
| `writer_collect_failed` | Bundle generation/verification/import failed, including an unmerged index |
| `writer_collect_incomplete` | One or more branch names refused, a collected commit or tree is missing from the operator checkout, or a tag, note or other unexported ref names an object only the clone has; no cleanup authorization |
| `ref_name_refused` | Unsafe export name, or a `-wip`, `-index`, `-detached` or `-stash-<n>` name collision |
| `nothing_to_collect` | No changed branch, WIP, index, detached commit or stash entry to export |
| `writer_collected` | Complete export recorded |
| `writer_reset_failed` | Reset command or validation failed |
| `writer_reset` | Persistent clone reset and verified |
| `writer_recreate_failed` | Recreated clone is not at baseline |
| `writer_recreated` | Clone/agent recreated and verified |
| `writer_busy` | Another process holds the writer's lease (a relayed session, a launcher still cleaning up, or another setup run) for longer than the setup wait; retry after it ends |
| `writer_fenced` | The writer's container fence could not confirm that no container of this writer exists; nothing was changed |
| `writer_lease_unavailable` | The writer's lease file or directory could not be opened safely (see Doctor `writer_lease_directory`) |
| `writer_removed` | Writer state deleted after registration cleanup |
| `ownership_unavailable` | Existing registration lacks ownership proof; removal refused |
| `workspace_base_ambiguous` | Existing writers have different base branches; supply an explicit base before migration can change the workspace modes |
| `isolation_control_planned` | Control planned only; no canaries written |
| `isolation_control_required` | Passing host control record required before writer acceptance |
| `isolation_control_passed` | Uncontained control detected expected escapes and cleaned up |
| `isolation_control_failed` | Control failed; previous passing record invalidated |
| `podman_unavailable` | Acceptance could not use Podman (not usable or no version) |
| `acceptance_harness_failed` | The contained harness exited non-zero, wrote no or an invalid report, did not report `pass`, or did not classify the network as `limited` or `not_limited` |
| `acceptance_fingerprint_changed` | The acceptance fingerprint changed while the harness ran; the writer stays `not_ready` |
| `writer_acceptance_failed` | Unexpected error during acceptance (catch-all) |
| `writer_accepted` | Contained provider-free acceptance passed and readiness recorded |
| `mcp_verified` | Bounded direct MCP verification passed |
| `mcp_failed` | Direct MCP verification failed |
| `mcp_unsupported` | Direct MCP output does not match the expected contract |
| `mcp_timeout` | Direct MCP verification exceeded its deadline |

A failed acceptance that got past the writer state check also writes
`~/.local/state/pi-session-mcp/writers/<name>/acceptance-failure.json` (mode
`0600`). It holds the schema version, the time, the returned code and, when the
harness ran, its exit code, whether the report was `present`, `absent` or
`invalid`, the verdict, the network classification and the names of failed and
inconclusive checks, and the ids of the digest groups that changed during the
probe (`changedDigestGroups`, for example `agent_dir`). Only short token-shaped
strings are copied, so the record
is path-free and secret-free. The next successful acceptance removes it. It
describes the last acceptance that got past the state check: a later failure
with `isolation_control_required`, `writer_state_invalid` or
`writer_state_unreadable` leaves an older record in place, so compare its `at`
time with the run.

## Restart rule

Running servers retain their loaded modes; mode changes do not stop sessions.
Close them before tightening policy. Restart all affected controllers, or use
an MCP reconnect that starts a **new server process**. Confirm workspace `mode`
with capabilities. The configuration fingerprint covers the main file only,
not the modes file. An unchanged request does not reload an old server.
The writer baseline guard is the deliberate re-read exception, not general reload.

## Migration from manual writers

For hand-made writers, collect/review all work first through
the old boundary's bundle route. Automated setup does not adopt their manual
state, wrappers or names.

1. In each writer's original project remove its manual local registration:
   `claude mcp remove pi-coding-<name> -s local`. Remove any separately
   configured Codex registration too.
2. After preserving work, remove that manual wrapper and state directory.
   Do not delete the operator's source checkout or another writer's files.
3. Configure the desired coding profiles, pass the explicit host isolation
   control above, then run
   `pi-session-mcp-setup --repo <alias> --mode container --profiles <coding-aliases> --apply`.
   New names derive from the configured repository alias, not the old manual name.
4. Restart/reconnect the host `pi-session-mcp` server, verify its client targets
   and run `--writer <name> --verify` before use; no writer registrations are added.

For a Go-toolchain writer, supply an **operator-supplied
local image ID** containing Node, Git and the Go toolchain, plus `--cache go`:

```sh
pi-session-mcp-setup --repo <alias> --mode container --profiles <coding-aliases> \
  --image <image-id> --cache go --apply
```

This records `cache: "go"` in the container entry in `execution-modes.json`.
The Go cache mounts at `/pi/go` with GOPATH, GOCACHE and `GOTOOLCHAIN=local`.
Container options are rebuilt from supplied values and defaults each time:
repeat the image ID and `--cache go` on later mode requests, or cache defaults
to `none`. Setup does not build or install the Go toolchain for you.

A Python writer using uv and npm uses the same pattern with `--cache uv`:

```sh
pi-session-mcp-setup --repo <alias> --mode container --profiles <coding-aliases> \
  --image <image-id> --cache uv --apply
```

This records `cache: "uv"` and mounts a private per-writer directory at
`/pi/uv`, with `UV_CACHE_DIR=/pi/uv/cache` and `npm_config_cache=/pi/uv/npm`.
No other uv or npm variables are set, so download and network policy stay the
image's. The directory is per writer: it is never shared between writers and
never a host cache mount. Setup does not install uv or npm for you.

### Resource limits

Container writers are unlimited by default. Optional `--cpus <n>` sets a hard
CPU cap (greater than 0, at most 1024, with at most two decimals).
`--cpu-shares <n>` sets relative CPU weight under contention (integer 2–262144;
Podman's default is 1024). The weight only counts against sibling cgroups:
rootless writers run in the operator's user slice, so `--cpu-shares` makes a
writer yield to the operator's other containers and processes, not to system
services such as rootful Docker CI runners in `system.slice`. To protect such
a service, use the `--cpus` hard cap.
`--memory <size>` sets a hard memory cap: 1–9999999 followed by lowercase `m`
or `g`, for example `--memory 512m`.

These are fairness measures, not a security boundary. Setup checks that the
Podman host exposes the `cpu` controller for either CPU option and the
`memory` controller for memory; missing controllers refuse the mode change
with `cgroup_controller_unavailable`, including dry-runs. Limits apply to the
serving container, not throwaway clone/maintenance containers. They update
existing writer state under its lease without reprovisioning or changing
boundary acceptance, and take effect at the writer's next launch. Acceptance
and `--writer <name> --verify` run the serving container under the same
limits, so a very small cap can make them time out. Unlike the other
settings, a later mode request that omits a limit flag keeps the recorded
limit, because limits are outside the settings drift check and would
otherwise vanish without an error, for example in an upgrade's repeated
provisioning command. Pass `--cpus none`, `--cpu-shares none` or
`--memory none` to remove a limit.

### npm cache (opt-in)

For a Node writer, pass `--cache npm` to mount a private per-writer directory
at `/pi/npm` with `npm_config_cache=/pi/npm/cache`. This records `cache: "npm"`;
no other npm variables are set and setup does not install npm. The directory
is never shared between writers or mounted from a host package cache. It
survives reset, finish and recreate, and is removed with the writer. Repeat
`--cache npm` on later container mode requests to retain it.

### Base tags (opt-in)

Container writers default to `tags: "none"`. Pass `--tags reachable` to bundle
only operator-checkout tags merged into the selected base commit. Repeat this
flag on later mode requests to retain it. Reset deletes every clone tag before
importing the selected base tags; tags created by workers are never collected
and do not change the collected-work digest. Changing the tag setting requires
reprovisioning for settings drift, but does not change boundary acceptance.

### Ignored files (opt-in)

Container writers default to `clean: "untracked"`, keeping ignored files such as
`.venv`, `node_modules`, `.env` and build output across reset and a persistent
writer's finish (an ephemeral writer's finish recreates the clone). Pass
`--clean all` on a container mode request to remove them with `git clean -ffdx`.
Repeat this flag on later mode requests to retain it. Per-writer caches at
`/pi/go`, `/pi/uv` and `/pi/npm` live outside the clone and stay untouched.
Changing the setting requires reprovisioning for settings drift: collect work,
run `--writer <name> --remove`, then run the provisioning command again with
the desired `--clean` value. It does not change boundary acceptance.

See [Isolation setup](isolation-setup.md) for boundary prerequisites and what
setup automates, and the historical manual acceptance evidence linked there.

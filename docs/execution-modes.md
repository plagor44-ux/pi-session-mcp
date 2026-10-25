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
- **`container`:** the host refuses coding. Setup provisions separate full clones
  and wrapped stdio registrations on Linux with usable rootless Podman. A mode
  entry alone is not containment: each writer needs successful acceptance.
- **`read-only`:** the host refuses coding; read-only profiles remain available.
  This is tool policy, not an OS sandbox for provider runtimes or child processes.
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
# Provisions, accepts and registers the writers.
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
read-only throwaway containers: no network access and nothing written.

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
| `--cache <value>` | `none` (default) or `go` for the writer's Go module/build cache |
| `--base <ref>` | Named local or remote branch for provisioning; also supported by writer reset; not HEAD or a raw commit hash |
| `--client codex` | Also register writers with Codex (user scope); Claude Code local registration is the default |
| `--discard` | Explicitly allow loss of uncollected surplus writers on mode/count changes |
| `--dry-run` / `--apply` | Dry-run is the default; apply mutates |
| `--json` | Sanitized JSON projection of the same report |

Container flags do not apply to explicit host/read-only requests. Mode selection
supports dry-run and apply, not verify/rollback/remove. Container settings are
rebuilt from supplied values and defaults, not merged with the prior entry:
supply the full intended settings, including profiles, on each mode request.
Selected profiles must have `default: false`, permission `coding`, no extensions
or external MCP grants, and only builtin skill-catalog entries. Setup rejects
unsupported profiles rather than silently weakening them.

## Writer storage, launch and readiness

Setup writes `execution-modes.json` beside the main configuration, preserving
other workspace entries. The main configuration's `workspaces` stays an
alias-to-path map. Older servers ignore modes; upgrade all relevant registrations.
Invalid modes fail startup rather than silently falling back.

Writers are `<alias>-w1` through `<alias>-w16`, with registrations
`pi-coding-<alias>-w<n>`. Their private state lives under
`$HOME/.local/state/pi-session-mcp/writers/<name>/`: `clone`, `agent`, `config`,
`bundles`, optional `go`, `wrapper.sh` and `state.json`. This lifecycle metadata
is distinct from in-memory MCP sessions; it does not implement session resume.
Each clone is made via a bundle, with no hardlinks to the operator's repository.
The base defaults to origin's symbolic HEAD, falling back to local main.

The generated wrapper launches one disposable `podman run -i --rm` per client
connection: keep-id user namespace, read-only root, dropped capabilities,
no-new-privileges, tmpfs home and /tmp. The clone and isolated agent copy are
writable; clone hooks/config, boundary config and release installation are
read-only mounts. Host Git never runs in the clone. Throwaway lifecycle
containers use no network and validate clone redirect metadata before export.

Each contained config has only its workspace and selected coding profiles,
plus the synthetic default **`boundary-read-only`**. Coding sessions must name
their coding profile explicitly. The clone's internal mode is acknowledged host
because writes there are intended *inside* the boundary; the operator's host
alias stays container and never dispatches coding automatically.

State phases are provisioning, not_ready and ready. Acceptance binds wrapper
bytes, package version, image ID, Podman version, network and cache settings.
Changed bindings require renewed acceptance. Existing non-provisioning writers
with changed provisioning settings are refused, not silently replaced. Review
and collect work before removing/reprovisioning them. Restart/reconnect affected
controllers after successful changes; setup never restarts them.

**Inspection has side effects:** `claude mcp get` health-checks the registration,
briefly starting its container. Setup's registration inspect and verify do this
too. Do not mistake inspection for a purely offline read. Doctor alone is offline:
it starts no writer, session or provider request and reads no credentials.

The launcher copies only selected providers from the host Pi auth store at launch
and checks every **60 seconds**. It runs host login warmup only when selected
OAuth credentials expire within **2 minutes** or have expired (an invalid/missing
expiry is treated as needing refresh). Measured warmup behavior refreshes only
expired or almost expired tokens; it is not an unconditional token rotation.
Warmup starts/closes a read-only host session through Pi's locked store without
a model request, then the launcher re-copies boundary credentials even if warmup
failed. API-key entries are copied, not refreshed; Cursor credentials are excluded.

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
synthetic `<branch>-wip` commit. These refs are **untrusted until reviewed**;
setup does not merge or cherry-pick them. Collection does not change the clone.
Only a complete export records a digest authorizing later destructive cleanup;
new work invalidates that authorization. Stashes are not exported as branches:
resolve any needed stash inside the boundary before collection.

`--finish` collects, then resets a persistent writer or recreates an ephemeral
writer. A collect refusing any branch name is incomplete (`writer_collect_incomplete`,
`ref_name_refused`), even if other refs were imported. Finish stops without reset
or recreation. Resolve by renaming inside the writer and collecting again, or
by an operator's explicit `--reset --discard --apply` after deciding to lose the
unexported work. Do not blindly retry or bypass a refusal by changing profiles.

| Writer operation | Behavior |
| --- | --- |
| `--collect --apply` | Bundle export; retain clone |
| `--reset --apply [--base <ref>]` | Reset to current source base branch, delete extra branches/stash and clean untracked files; falls back to recreation if post-reset verification fails |
| `--recreate --apply` | Rebuild clone and agent copy from the source base, retaining image/settings |
| `--finish --apply` | Collect, then reset persistent / recreate ephemeral |
| `--remove` | Explicit mutation: unregister owned registrations before removing writer state |
| `--verify` | Doctor, registration equality and bounded direct MCP handshake/tools/list/capabilities; no session or provider request |

Other than explicit `--remove` and `--verify`, omitting apply only plans.
Reset/recreate/remove refuse changed uncollected work unless given `--discard`.
`--reset`, `--recreate` or `--remove` with `--discard` cannot see open sessions
in the writer; close those sessions first.
Only reset accepts `--base`; finish does not accept discard.

**Verify and registration health checks:** setup's registration inspect in apply,
verify and remove uses `claude mcp get`, which health-checks a registered server
through its normal writer launcher. That start may re-copy the boundary
credentials. Only if a selected OAuth token expires within **2 minutes** (or is
already expired; invalid/missing expiry is treated as needing refresh) may it
run host login warmup through **Pi's own locked store**. The client CLI cannot
be given a different environment for that health check. Verify's own direct MCP
handshake uses `PI_WRITER_NO_CREDENTIAL_REFRESH=1`, touching no credential in
that launch and making no session or provider request. **Setup itself never
writes the host credential file**; host login updates, when needed, are performed
by Pi through its locked store.

The server guard refuses coding when the clone differs from its recorded baseline
(extra branches, stash, uncommitted/untracked changes, or different HEAD), and
while another coding session is open. It re-reads the guard file each time, so a
reset updates admission without a server restart. A missing/unusable runtime or
stale/unready writer launches a refusal MCP server: all eight tools return the
sanitized refusal, with no host fallback. See [Tool contracts](tool-contracts.md).

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
| `doctor_failed` | Relevant blocking Doctor checks failed |
| `writer_planned` | Writer would be retained/provisioned |
| `writer_remove_planned` | Surplus writer would be removed |
| `writer_collect_planned` | Collection planned only |
| `writer_reset_planned` | Reset planned only |
| `writer_recreate_planned` | Recreation planned only |
| `writer_finish_planned` | Finish planned only |
| `writer_provisioned` | Clone/config/wrapper prepared, not yet accepted |
| `writer_unchanged` | Provisioned settings already match |
| `writer_settings_changed` | Existing writer settings differ; no silent replacement |
| `writer_registered` | Registration added or already equivalent |
| `writer_reconcile_failed` | Unexpected reconciliation failure |
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
| `writer_inspect_failed` | Contained work inspection failed |
| `writer_uncollected` | Changed work lacks a matching complete collection digest; destructive operation refused |
| `writer_collect_failed` | Bundle generation/verification/import failed |
| `writer_collect_incomplete` | One or more branch names refused; no cleanup authorization |
| `ref_name_refused` | Unsafe export name or WIP name collision |
| `nothing_to_collect` | No changed branch or WIP to export |
| `writer_collected` | Complete export recorded |
| `writer_reset_failed` | Reset command or validation failed |
| `writer_reset` | Persistent clone reset and verified |
| `writer_recreate_failed` | Recreated clone is not at baseline |
| `writer_recreated` | Clone/agent recreated and verified |
| `writer_removed` | Writer state deleted after registration cleanup |
| `ownership_unavailable` | Existing registration lacks ownership proof; removal refused |
| `registration_not_equivalent` | Verify found absent/divergent/unsupported required registration |
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
inconclusive checks. Only short token-shaped strings are copied, so the record
is path-free and secret-free. The next successful acceptance removes it.

## Restart rule

Running servers retain their loaded modes; mode changes do not stop sessions.
Close them before tightening policy. Restart all affected controllers, or use
an MCP reconnect that starts a **new server process**. Confirm workspace `mode`
with capabilities. The configuration fingerprint covers the main file only,
not the modes file. An unchanged request does not reload an old server.
The writer baseline guard is the deliberate re-read exception, not general reload.

## Migration from manual writers

For **`psm-alpha`** and **`go-app-alpha`**, collect/review all work first through
the old boundary's bundle route. Automated setup does not adopt their manual
state, wrappers or names.

1. In each writer's original project remove its manual local registration:
   `claude mcp remove pi-coding-<name> -s local` (substitute `psm-alpha` or
   `go-app-alpha`). Remove any separately configured Codex registration too.
2. After preserving work, remove that manual wrapper and state directory.
   Do not delete the operator's source checkout or another writer's files.
3. Configure the desired coding profiles, pass the explicit host isolation
   control above, then run
   `pi-session-mcp-setup --repo <alias> --mode container --profiles <coding-aliases> --apply`.
   New names derive from the configured repository alias, not the old manual name.
4. Restart/reconnect controllers and verify the new writer registrations before use.

For the Go-toolchain writer **`go-app-alpha`**, supply an **operator-supplied
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

See [Isolation setup](isolation-setup.md) for boundary prerequisites and what
setup automates, and the historical manual acceptance evidence linked there.

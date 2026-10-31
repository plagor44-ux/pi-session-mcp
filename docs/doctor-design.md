# Offline doctor contract

`src/doctor-cli.ts` is a separate local entry point. It never imports the MCP
server, initializes transport, creates a Pi session, reads credentials, or
performs network activity.
It checks the package it was loaded from, never the current working
directory: an npm executable can run from any directory.

`runDoctor` returns one frozen result model (`schemaVersion: 1`, `ok`, a
sanitized semver `packageVersion` when metadata is available, ordered `checks`,
and `exitCode`). Human and JSON output are projections of that same model.
Subjects are only fixed component names, validated workspace aliases, or
validated `<profile>:<package>`, `<profile>:<skill-alias>` or `skill:<name>` pairs; paths, configuration values, errors,
credentials, and provider data are never output.

Each check is `{ id, severity, subject, remediation? }`. Severity is `ok`,
`warning`, or `error`; remediation is a fixed safe sentence. The initial IDs
and owners are:

| ID | Blocking condition | Subject |
| --- | --- | --- |
| `doctor_cli_unavailable` | The independent generated Doctor entry point is missing or cannot be loaded by the checked-in bootstrap | `Doctor CLI` |
| `node_version_unsupported` | Runtime does not satisfy `package.json#engines.node` | `Node.js` |
| `package_metadata_unreadable` | Package metadata is missing, unreadable or malformed, or a lockfile is present but malformed | `package metadata` |
| `build_missing` | `dist/main.js` is absent, inaccessible, or not a regular file | `build output` |
| `build_stale` | Package, lock, build configuration, or production TypeScript input is newer than the build output, or freshness cannot be established. Inputs that an npm installation does not contain are skipped. Without any build configuration or TypeScript input, as in an npm installation, the package and lock times are not compared either, because npm writes extracted files with the extraction time | `build output` |
| `version_mismatch` | Package and lock versions differ; this is a warning and does not apply to an npm installation, which has no lockfile | `package version` |
| `config_missing` | `PI_SESSION_MCP_CONFIG` is not set, or the file it names is absent | `configuration` |
| `config_unreadable` | The supported configuration path cannot be read | `configuration` |
| `config_invalid` | Production `loadConfig` rejects the configuration. One check per schema issue location, at most five, sorted | `configuration:<location>`, a dotted path of schema field names, aliases and array indexes such as `configuration:executionProfiles.review.default`; an unknown key that is not a schema field name, and any other key that is not a valid alias, is shown as `<key>`, because it could be a path or a secret. `configuration` when the error has no location |
| `skill_controller_selected` | Production `loadConfig` rejects the configuration because a `skillCatalog` value names a controller skill (`builtin:pi-session-orchestration` or `builtin:pi-session-profiles`). Reported instead of `config_invalid` for that location and blocks like it | `configuration:skillCatalog.<alias>` |
| `workspace_missing` | A resolved configured workspace does not exist | validated workspace alias |
| `workspace_not_directory` | A resolved workspace is not a directory | validated workspace alias |
| `workspace_unreadable` | A resolved workspace cannot be read | validated workspace alias |
| `workspace_not_writable` | A workspace is not writable while a coding profile can target it | validated workspace alias |
| `workspace_gitfile` | Warning. A workspace's `.git` is a regular file starting with `gitdir:` while at least one execution profile has the `coding` permission profile | validated workspace alias |
| `workspace_mode_unset` | Warning. A workspace has mode `unset` while at least one execution profile has the `coding` permission profile | validated workspace alias |
| `workspace_base_unset` | Warning. A workspace has mode `container` without a recorded default base in its execution-modes entry | validated workspace alias |
| `workspace_host_writes_accepted` | Always `ok`, without remediation. The operator has explicitly accepted host writes for this workspace | validated workspace alias |
| `container_runtime_unavailable` | A workspace has mode `container` and the local rootless Podman probe fails | validated workspace alias |
| `container_profile_refused` | A selected container coding profile cannot be rendered: missing profile, extensions or MCP grants, non-false default, non-coding permission, invalid skills, non-builtin/unshipped/operator-overridden skills, or schema-invalid rendered configuration (error); one ok per workspace when all selected profiles pass; one workspace error saying selected profiles could not be checked if the original configuration cannot be read | workspace alias:profile alias on refusal; workspace alias on success or unreadable configuration |
| `writer_lease_directory` | Error when `~/.local/state/pi-session-mcp/leases` cannot be inspected, or exists as a symbolic link, is not a real directory, is not owned by the current user, or has a mode other than exactly 0700; an absent directory is not reported. A wrong owner or mode is repaired in place: lease files keep their inodes, so the directory is never moved or deleted while a writer may hold a lease | `writer lease` |
| `writer_not_ready` | State is missing or invalid, phase is not ready, acceptance fingerprint is stale, or the local image is absent (error) | validated writer name |
| `writer_not_migrated` | Warning. The writer state still records the legacy launch, so the writer is not in the relay pool | validated writer name |
| `writer_off_default_base` | Warning. One or more ready writers of a container workspace have a base other than the workspace default base; the remediation states only their count | validated workspace alias |
| `writer_git_identity_missing` | Clone Git config lacks a readable user name and email (warning); set both in the operator checkout, then reset the writer | validated writer name |
| `writer_dirty` | HEAD is not the base branch, its commit differs, another branch exists, or Git metadata cannot safely be inspected (warning). It reads only `HEAD` and refs, never the index or worktree, so an `ok` result is no proof of a clean clone and never authorizes cleanup; the boundary inspection does (#200) | validated writer name |
| `writer_uncollected_bundle` | Bundles directory is unsafe/unreadable or contains entries other than base.bundle (warning; an absent directory alone does not warn) | validated writer name |
| `extension_missing` | Pi has no user install of a package that a profile's `extensions` names | `<profile>:<package>` |
| `extension_version_mismatch` | The installed manifest's version differs from the pinned version, or the manifest or its `pi.extensions` entries are invalid | `<profile>:<package>` |
| `extension_unpinned` | Warning. Pi's agent settings list a configured pinned extension without a version, as a string or object's `source`; pin it with `pi install npm:<name>@<version>`. Missing, unreadable, or invalid settings are ignored | `<profile>:<package>` |
| `skill_missing` | The `SKILL.md` file that a profile's selected skill alias names does not exist; a `builtin:<name>` value that matches no override and no shipped skill resolves to the shipped location and is reported here | `<profile>:<skill-alias>` |
| `skill_unreadable` | A selected skill path is not a regular file, is larger than 256 KiB, or cannot be read | `<profile>:<skill-alias>` |
| `skill_duplicate` | Two selected skill aliases of one profile resolve to the same canonical file | `<profile>:<skill-alias>` |
| `skill_override_outdated` | Warning. The current fingerprint of a shipped skill differs from the base recorded in the skill bases file next to the configuration file, or the bases file is corrupt | `skill:<name>`, or `skill:bases` for a corrupt file |
| `sandbox_unavailable` | Only when some profile has `shell: "sandboxed"` ([ADR 0013](adr/0013-hardened-read-only-profiles.md)). Error: `/usr/bin/bwrap` or `/usr/bin/systemd-run` is missing or not a trusted system binary (root-owned, not group- or world-writable), `/run/user/<uid>` is not the user's own closed runtime directory with a `bus` socket, or a probe run of `/usr/bin/true` through the session's fixed sandbox arguments for a configured workspace (its real path, plus the main Git directory of a linked worktree) fails or exceeds 5 seconds, for example because the installed version lacks the overlay options, unprivileged user namespaces are disabled or restricted by AppArmor, or the workspace's filesystem cannot be an overlay lower layer. Since #195 the probe runs in its own transient systemd user scope and passes only when that scope's effective `memory.max`, `memory.swap.max` and `pids.max` are the fixed limits, so it also fails without a systemd user manager, without the `memory` and `pids` controllers delegated to it, or without swap accounting. Contacting the user manager is local IPC over the user's own bus; Doctor stays offline. Reported once per workspace that exists as a directory, however many profiles select the shell | workspace alias |
| `workspace_git_unavailable` | Only when some profile has `shell: "sandboxed"`. Warning: a workspace's `.git` is a regular file starting with `gitdir:` that is not a usable linked-worktree pointer (`<common>/worktrees/<name>` with a matching back-pointer and `commondir`, and `HEAD`, `objects` and `refs` in `<common>`), so Git commands fail inside the sandbox; the read tools are unaffected. `ok` for a usable pointer; absent for a workspace without a gitfile | workspace alias |
| `snapshot_path_mismatch` | Only for `snapshot` workspaces ([ADR 0015](adr/0015-review-snapshots.md)). Error: the workspace's configured path is not the derived slot worktree `~/.local/state/pi-session-mcp/snapshots/<alias>/worktree` (compared as given and after resolving links) | `<alias>` |
| `snapshot_incomplete` | Only for `snapshot` workspaces with a matching path. Error: the slot has a worktree directory but no state, state but no worktree directory, an invalid or linked state file, or state recorded for another source alias; run `--snapshot <alias> … --apply` to recover it | `<alias>` |
| `snapshot_unavailable` | Only for `snapshot` workspaces with a matching path. Warning: neither the slot's worktree nor its state exists yet, so sessions on it fail with `snapshot_unavailable` until setup materializes it. Doctor does not run Git and does not verify the tree; sessions verify at start | `<alias>` |
| `event_spool_root` | Only when `events.delivery` is `spool`. Warning: no absolute `XDG_RUNTIME_DIR` is set in Doctor's environment; a server started that way runs with delivery inactive. Error: the `pi-session-mcp` entry in the runtime directory, or its `events` or `claims` entry, cannot be inspected, is not a directory (a link counts), belongs to another user, or has group or other permission bits. An absent entry is `ok`: the server creates it | `event spool` |

`workspace_gitfile` is advice, not a boundary. A linked Git worktree shares `hooks/` and `config` with its main repository, so a coding worker could plant code that runs in the operator's later Git commands. A `.git` gitfile alone does not prove a linked worktree, however: submodules and `git init --separate-git-dir` use gitfiles too, and the content of the three is indistinguishable without following the pointer. Doctor therefore never follows, resolves, stats or reads the pointer target and never runs Git. It calls `lstat` on `<workspace>/.git` and, for a regular file of at most 4 KiB, reads at most that many bytes (without following a symbolic link) and checks for a `gitdir:` prefix followed by a non-blank value. Every such file warns, including submodule and separate-git-dir gitfiles, with a fixed path-free remediation that says "possible linked worktree or Git metadata stored outside the workspace" and recommends a separate full clone for coding workers. The check runs only when a coding profile exists and emits one entry per workspace alias: a warning, or `ok` when no gitfile pointer was found. A `.git` directory, an absent `.git`, an empty, oversized or malformed file, a symbolic link named `.git` (not followed, so nothing is known about its target), and any `lstat` or read error (for example `EACCES`) produce `ok`, never a failure and never a crash; an unreadable `.git` therefore means "not detected", not "verified clean". The warning cannot mask an error: the exit code stays 2 whenever any error exists.

For choosing modes, setup findings and host-server enforcement, see
[Execution modes](execution-modes.md). Invalid `execution-modes.json` content
fails the `config_invalid` check; a valid container entry does not prove that a
writer is provisioned or accepted. Doctor checks every configured writer separately.

Writer subjects use `<alias>-w<n>`. Readiness fingerprints share the launcher's
helper and bind current wrapper bytes, package version, image ID, Podman version,
network and cache settings. The injected `writerRuntime` probe defaults to bounded,
offline `podman info`, `podman version`, and `podman image exists` commands; it never
pulls an image. Dirty checks run no Git: they inspect HEAD, recursive local branch
refs and packed-refs with 64 KiB per-file limits, rejecting symbolic links and
unsafe directory entries. These checks do not inspect uncommitted worktree edits.
Bundle warnings detect outstanding entries without reading their contents.
Each successful check emits an `ok` entry; remediation text contains no paths.
Acceptance and the disposable-clone control run are explicit setup operations,
never Doctor actions. Under Plan B, `--isolation-control --repo <alias> --apply`
writes real canaries below $HOME and removes them; omitting apply only plans.
Doctor never runs this control, refreshes credentials, inspects client
registrations or starts containers. In contrast, setup's writer verify checks
Doctor and a bounded relay-path MCP handshake/tools/list/capabilities;
client-target verify checks host registration equality separately. Claude's host
registration inspection starts no writer container. The direct writer
verification launch disables credential refresh and starts no session.
Doctor's metadata-only dirty warning is not the server's stronger coding guard:
that guard also checks stash and uncommitted/untracked work on every admission.
See [Execution modes](execution-modes.md#writer-storage-launch-and-readiness).

Execution-mode checks follow `workspace_gitfile`. Unset modes warn only when a coding profile exists; explicit host modes always show the accepted write risk as an `ok` line. If any alias uses container mode, Doctor probes the local runtime once with `podman info --format {{.Host.Security.Rootless}}`, without a shell, with a 10-second timeout and a 4 KiB stdout cap. Only exit status 0 and trimmed stdout `true` pass; a missing binary, timeout, excessive output or any other error fails each container alias, even with only read-only profiles. No runtime diagnostics or paths enter reports. This local probe stays offline and never runs Git.

Doctor reads extension manifests from Pi's user install location only; it never installs packages and never imports extension code.

The skill checks run after the extension checks. They look only at file availability: Doctor never reads a skill's frontmatter, never parses or executes it, and the subject carries the catalog alias, never a path. Frontmatter, skill-name rules, name collisions and explicit-only flags (`disable-model-invocation`) are checked only at session start by the Pi SDK contract, so a clean Doctor run does not promise that a skill loads. Unknown or duplicate aliases and two selected aliases with one path are configuration errors and surface as `config_invalid`. See [Pi skills](skills.md).

`skill_override_outdated` concerns the operator's skill overrides, not a profile. It is `ok` for a recorded base that still matches the shipped skill, and a warning (exit status 1, never blocking `setup`) when the shipped skill changed after the operator ran `pi-session-mcp-setup --customize-skill <name>`; its remediation names `pi-session-mcp-setup --apply --customize-skill <name>` to acknowledge a reviewed change. Only skills with a recorded base are compared, and a recorded name that is no longer shipped is skipped. A recorded base of 0.8.0 (a version 1 fingerprint) is compared through the version 2 value of the released 0.8.0 skill it names; a version 1 base that names no released skill cannot be confirmed and yields a warning that says so, with the same remediation. A corrupt bases file yields a warning with the subject `skill:bases`. Doctor reads the bases file and the shipped skill files only; nothing is executed and the subject is a validated skill name, never a path. The check sorts after `skill_duplicate`.

`event_spool_root` is the last check and exists only for a configuration that enables turn-event delivery ([ADR 0011](adr/0011-turn-events-and-controller-wake.md)); with delivery off or unset it is absent from the report. It inspects `$XDG_RUNTIME_DIR/pi-session-mcp` and, when they exist, its `events` and `claims` entries with one `lstat` each, and never creates, repairs or reads anything below them. The rule is the one the server applies to the events root at startup (`TurnEventSpool.open`: a real directory of the current user without group or other access) and the hook applies to the claims directory, so Doctor is not green where startup would fail with `event_spool_unavailable` for these directories. When `PI_SESSION_MCP_EVENTS_DIR` is set in the server's environment the server uses that directory instead of `events`; Doctor does not read it. A missing runtime directory variable is only a warning, because Doctor may run in another environment than the server; the server itself keeps delivery inactive when it has neither that directory nor `PI_SESSION_MCP_EVENTS_DIR`, with an `event_delivery_inactive` warning. Relayed container sessions use the host spool; there are no per-session writer spool mounts (see [Isolation setup](isolation-setup.md#event-spool-mount)). The report holds the fixed subject `event spool` and a fixed remediation, never a path.

The Doctor reuses `loadConfig`; it does not duplicate alias, profile, thinking
level, or read-only-default rules. Workspace values are used only for local
filesystem checks and are never copied into the result.

Checks use the table order above, then sort by subject within an ID. Exit
codes are 0 for all checks passing, 1 for warnings only, 2 for blocking
errors, and 64 for CLI misuse. Compilation is a separate explicit
`npm run build:cli` step. `npm run doctor` executes a checked-in bootstrap that
loads only the already-generated independent CLI, so compiler output can never
enter a Doctor report. A missing or unloadable generated entry point produces
the fixed path-free `doctor_cli_unavailable` result with exit code 2; the
bootstrap never forwards raw import or compiler diagnostics.
If a report consumer closes stdout, the bootstrap absorbs the resulting pipe
error and preserves the intended bounded exit status without emitting a stack
trace or path-bearing diagnostic.

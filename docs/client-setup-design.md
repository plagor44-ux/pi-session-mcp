# Client setup lifecycle design

This document defines the local, stdio-only setup lifecycle for Codex and Claude Code. The setup command is adapter-driven and does not perform a model turn, provider authentication, or arbitrary workspace access.

## Operations

`setup` and `setup --dry-run` are equivalent and non-mutating. `--apply`, `--verify`, `--rollback`, and `--remove` require explicit client, scope, and alias targets. The orchestrator emits one bounded result model for human and machine consumers; findings contain only client, scope, alias, status, and stable operation codes.

The repository-local command shape is:

```text
npm run --silent setup -- [--dry-run|--apply|--verify|--rollback|--remove] [--json] --target CLIENT:SCOPE:pi-session-mcp
npm run --silent setup -- [--apply] [--json] --customize-skill NAME
```

The script executes the already-built production entry point. Building is a
separate explicit prerequisite, so default/dry-run performs no compilation or
filesystem write.

Codex supports only `codex:user:pi-session-mcp`. Claude Code supports `user`,
`project`, and `local`. Clients are accepted by contract, not by version
([ADR 0004](adr/0004-client-contract-not-version.md)): command-help,
registration output, or scope outside the recorded contracts is `unsupported`,
and the client version is reported for information only. The adapters do not
parse undocumented client config files.
Setup is supported on Linux and macOS
([ADR 0005](adr/0005-macos-setup-platform.md)); `src/setup-platform.ts` owns
the operating-system facts behind the fence.

- **Linux:**
  - a root-owned, non-writable util-linux `flock` at `/usr/bin/flock` or
    `/bin/flock`;
  - readable `/proc`;
  - an ownership directory on ext2/3/4, XFS, Btrfs, tmpfs, overlayfs, ZFS,
    F2FS, UBIFS, or bcachefs.
- **macOS:**
  - the root-owned, non-writable system `/bin/ps`;
  - an ownership directory with the same `statfs` type as `/`, which is the
    APFS system volume on every macOS that Node.js 22 supports. macOS assigns
    `f_type` dynamically, so no fixed number is compared.

Other filesystems fail closed before lock acquisition. Every other platform
fails closed with `platform_unsupported` before any client command is spawned.

## Ownership and transactions

Each adapter exposes inspection, apply, verify, and remove operations. Apply first inspects and refuses divergence; equivalent registrations are left unchanged. Before adding an absent registration, setup records a path-free `pending` transaction containing only the target, an opaque fingerprint, the previous `absent` state, and a transaction identifier. Post-apply inspection promotes it to `owned`. Rollback/remove require owned metadata and the same effective fingerprint. Any mismatch fails closed and leaves the registration untouched.

The production bridge derives Node from `process.execPath` and the entry point from the package root; configuration comes only from `PI_SESSION_MCP_CONFIG`. These values are internal command arguments and never CLI arguments, reports, or metadata. The opaque ownership fingerprint also binds `package.json`, the lockfile when the installation has one, and every built runtime JavaScript module. `main.js` and the regular, non-symlink `setup-command-guardian.js` and `setup-platform.js` are mandatory release artifacts; any runtime symlink fails closed. A package/lock mismatch or later build-content drift therefore fails closed instead of silently reusing ownership. Public client commands run through a bounded `CommandRunner` (timeout, process-group termination, and output cap); undocumented config files are not parsed.

The production CLI uses an atomic durable store with restrictive filesystem modes; the in-memory store exists only for library tests. Neither form persists paths, environment values, secrets, prompts, SDK errors, or auth metadata. A stable, never-renamed lock file is held through a kernel lock for the complete inspect → pending → client mutation → owned transaction. On Linux, the trusted util-linux `flock` locks the open file description that setup opened. On macOS, setup opens the lock file with `O_EXLOCK | O_NONBLOCK`, which takes a lock with flock(2) semantics on the open file description at open time; a busy lock is retried every 50 ms within the same acquisition bound. Newly created ownership directories and every atomic state rename are fsynced through their parent directory before success. There is no clock-based stale recovery: the kernel releases the lock only when every holder of the locked open-file description exits. A missing or untrusted `flock` or `ps`, an unsupported filesystem, a symlink/non-regular lock file, or an inode mismatch fails closed. The trusted same-UID operator must not unlink or replace the stable lock path while setup is running; setup compares the inode of the open lock file with the path after opening it, again once the fence is held, and before exposing transaction access, but same-UID filesystem tampering is outside the fence's trust boundary. A later run reconciles `pending` state: a matching equivalent registration is promoted to owned, an absent registration is safely retried, and any divergence fails closed.

Mutating public client commands run under a transaction guardian that inherits the locked file description, starts the client in its own process group, and watches both the parent PID and IPC channel. Parent EOF, `SIGINT`, `SIGTERM`, or command timeout causes TERM then KILL. The guardian releases the fence only after a determinate process-table scan confirms that no non-zombie group member remains: `/proc` on Linux, and on macOS a strictly parsed `/bin/ps -A -o pid=,pgid=,stat=` that must list the scanning process itself. Indeterminate cleanup returns a stable failure to the caller while the detached guardian retains the fence and continues cleanup, preventing a later setup transaction from racing the orphan. A mutation already accepted by an external client CLI or configuration backend cannot be rolled back automatically; ownership remains `pending` for reconciliation.

Here “gone” means no group member can still execute: a zombie has terminated and
released its file descriptors, even when its PID awaits an external reaper. The
runner and guardian both exclude `Z` entries from their live-member scan. This
does not promise full PID reaping or termination of descendants that independently
escape the process group. A stat read other than the expected disappearance
(`ENOENT`) makes the scan indeterminate and keeps the guardian-held fence. Tests
of descendant termination must assert zombie-or-absence without catching their
own failed assertion; fence retention is checked separately with a live member
and an indeterminate scan.

## Skill installation

Besides the registration, setup installs the controller skill
`pi-session-orchestration` (`src/setup-skills.ts`). The skill step runs inside
the same ownership transaction as the registration, per target and after it.
`--dry-run` and `--verify` run it for every target. `--apply` runs it only for a
registration finding of `ok` or `unchanged`, and `--rollback` and `--remove`
only after the registration finding is `ok`. A skill finding therefore never
blocks a registration, but `divergent`, `failed` and `unsupported` skill
findings make the overall result `failed`, like any other finding.

**Source.** The effective skill is the operator's override if
`<override dir>/pi-session-orchestration/SKILL.md` exists, else the shipped skill
(see [Pi skills](skills.md#the-skill-library)). Setup reads the tree with a
bounded reader: regular files only, at most 32 files, 1 MiB and 8 levels, no
links or special files inside the tree, entries whose name starts with `.`
skipped. A missing or unusable source is `skill_source_invalid`. The fingerprint
is a SHA-256 over the sorted relative paths and contents.

**Slots.** A slot is the skill directory a client reads:

| Target | Slot |
| --- | --- |
| `codex:user` | `~/.agents/skills/pi-session-orchestration` |
| `claude-code:user`, `claude-code:local` | `~/.claude/skills/pi-session-orchestration` (one shared slot) |
| `claude-code:project` | `<project>/.claude/skills/pi-session-orchestration` (the directory in which setup runs) |

**Ownership records.** One record per client slot with the alias
`skill:pi-session-orchestration` holds the target client, the scope kind
(`project` or `user`, so Claude Code `user` and `local` share a record), the
phase and a content fingerprint, nothing else. It is path-free and secret-free
like every record. Because it is path-free, the project record is per client,
not per project directory, and describes the project copy that setup touched
last. The `pending` phase is written before the first filesystem change and
promoted to `owned` after a post-install inspection. A later run finds a
`pending` record whose slot already equals the source and promotes it.

**Atomic copy.** Setup creates missing parent directories (mode `0755`), stages
the tree in a temporary directory in the slot's parent (files `0644`, each file
and directory fsynced), and re-checks that the slot is unchanged
(fingerprint, device and inode). It then renames the exact old tree to a backup
name, renames the staged directory into place, inspects the result, and deletes
the backup only if it is still the exact old tree it moved. An unhealthy
ownership fence retains staged and backup content for conservative recovery.
The slot is never edited in place.

**Divergence rules.** Setup never replaces or deletes, and reports
`skill_divergent` for:

- an installed copy whose fingerprint differs from the owned record, even if it
  happens to equal the new source;
- a copy that differs from the source without an `owned` record (a foreign
  skill of the same name, or an unfinished `pending` transaction);
- a link or non-directory at the skill entry, or a tree that cannot be read.

A copy that equals the source stays unowned when no record exists
(`skill_equivalent` or `skill_already_equivalent`). An unmodified owned copy
that differs from the source is replaced after a package update or a changed
override (`skill_update_planned`, `skill_updated`).

**Link rules.** The skill entry itself is never followed. In the home
directory, the client's skills directory (`~/.claude/skills`, `~/.agents/skills`)
may be the operator's own link, for example into a dotfiles checkout, and is
resolved to its real path. A project may be untrusted: only the project root is
canonicalized, and a link anywhere below it makes the slot divergent, so setup
never writes outside the project. If a slot cannot be resolved at all, the
finding is `skill_source_invalid` for `--dry-run`, `skill_install_failed` for
`--apply`, `skill_missing` for `--verify` and `skill_divergent` for removal.

**Shared slot.** For `--rollback` and `--remove`, the Claude Code `user` and
`local` registrations share one slot. While the other registration is still
`owned`, the skill stays and the finding is `skill_kept_shared`. The last
removal deletes it (`skill_removed`; `skill_absent` if it is already gone;
`skill_not_owned` if setup never owned it). A modified copy is left in place
(`skill_divergent`) and its record stays, so a later run can finish after you
removed the copy.

**Remove retry.** Registration removal can finish before skill cleanup, for
example after an interruption or a `skill_divergent`. When the registration
record is gone but setup still owns the skill of that target, `--remove` and
`--rollback` run once more for that target. They first prove that the
registration is absent and then report the registration as removed and clean up
the skill. They never run for a target whose skill setup does not own, and an
unowned live registration stays untouched (`ownership_unavailable`).

Skill reports carry only client, scope, the alias `pi-session-orchestration`,
status and a stable code. No skill content, fingerprint or path leaves setup.

## Skill customization

`setup --customize-skill <name>` (and `--apply --customize-skill <name>`,
`src/skill-customize.ts`) does not touch clients and takes no ownership lock. It
copies a shipped skill into the override directory `skills/` next to the
configuration file and records the shipped fingerprint under the skill name in
`<override dir>/.pi-session-mcp-bases.json` (`{"schemaVersion":1,"bases":{...}}`,
strictly validated, at most 64 KiB, replaced atomically). The copy is staged in
a temporary directory and renamed into place; an existing override is never
overwritten. A changed shipped skill is only reported (`skill_override_outdated`);
`--apply` then moves the recorded base and nothing else. It cannot be combined
with `--target`, `--verify`, `--rollback` or `--remove`. The finding target is
`{ client: "skills", scope: "override", alias: <name> }`; the alias is the
skill name only if it is valid, else `invalid`.

## Verification boundary

Production verification requires the offline Doctor, exact public client-CLI registration inspection, and a directly launched bounded MCP handshake. The verifier calls `pi_capabilities_get` with `{}` only; session start/prompt/turn and provider/model operations are forbidden. Its child process is terminated and awaited before success is reported.

## Compatibility and reporting

Codex and Claude Code are separate adapters with explicit supported scopes and documented capability fixtures. Unknown output fails closed with stable codes. Absolute paths are passed only to client commands where required and are never included in results, logs, or ownership metadata. Client command diagnostics must be reduced to stable codes before crossing this boundary.

Human and JSON output derive from one `schemaVersion: 1` result. Exit code `0` is success, `1` is an operational or reconciliation failure, `64` is command-line misuse, and interrupted setup returns `130` for `SIGINT` or `143` for `SIGTERM` only after the guardian cleanup path has completed or retained the fence. Automatic replacement of a divergent registration is deliberately unsupported.

Stable finding codes are grouped by responsibility:

- input/prerequisites: `target_invalid`, `config_required`, `usage_invalid`,
  `platform_unsupported`, `operation_interrupted`,
  `doctor_failed`, `release_unavailable`, `client_unsupported`, `inspect_failed`;
- planning/reconciliation: `absent`, `equivalent`, `divergent`,
  `already_equivalent`, `divergence_requires_replacement`,
  `registration_fingerprint_mismatch`, `release_binding_mismatch`;
- ownership/apply: `applied`, `pending_recovered`, `ownership_unavailable`,
  `apply_failed_recovery_pending`;
- verification: `registration_not_equivalent`, `mcp_verified`,
  `mcp_unsupported`, `mcp_timeout`, `mcp_failed`;
- rollback/removal: `rolled_back`, `removed`, `ownership_diverged`,
  `cleanup_failed`;
- controller skill, dry-run: `skill_absent`, `skill_equivalent`,
  `skill_update_planned`, `skill_divergent`, `skill_source_invalid`;
- controller skill, apply: `skill_installed`, `skill_already_equivalent`,
  `skill_updated`, `skill_divergent`, `skill_source_invalid`,
  `skill_install_failed`;
- controller skill, verify: `skill_verified`, `skill_missing`,
  `skill_not_equivalent`;
- controller skill, rollback/removal: `skill_removed`, `skill_kept_shared`,
  `skill_not_owned`, `skill_absent`, `skill_divergent`;
- skill customization: `skill_customize_planned`, `skill_customized`,
  `skill_override_current`, `skill_override_outdated`, `skill_base_updated`,
  `skill_not_shipped`, `skill_bases_corrupt`, `skill_override_invalid`,
  `skill_customize_failed`.

The public statuses are `planned`, `ok`, `unchanged`, `absent`, `divergent`,
`unsupported`, and `failed`. Reports never contain command arguments, command
output, absolute paths, environment values, ownership fingerprints, transaction
IDs, or raw exceptions.

The content binding proves that a local setup invocation continues to refer to
the same manifests and built runtime bytes. It does not by itself prove that
those bytes came from a published release. That is the purpose of the
published-release setup acceptance; see
[Acceptance](acceptance.md#level-2-setup-acceptance).
When `release_binding_mismatch` is reported, Apply and Verify remain blocked.
The safe reconciliation path is to restore the previously owned release bytes,
run explicit Rollback or Remove, then switch to the new release and Apply it;
setup never silently transfers ownership across changed build content.

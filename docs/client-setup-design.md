# Client setup lifecycle design

This document defines the local, stdio-only setup lifecycle for Codex and Claude Code. The setup command is adapter-driven and does not perform a model turn, provider authentication, or arbitrary workspace access.

## Operations

`setup` and `setup --dry-run` are equivalent and non-mutating. `--apply`, `--verify`, `--rollback`, and `--remove` require explicit client, scope, and alias targets. The orchestrator emits one bounded result model for human and machine consumers; findings contain only client, scope, alias, status, and stable operation codes.

The repository-local command shape is:

```text
npm run --silent setup -- [--dry-run|--apply|--verify|--rollback|--remove] [--json] --target CLIENT:SCOPE:pi-session-mcp
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
  `cleanup_failed`.

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

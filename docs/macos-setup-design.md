# macOS setup platform design

**Status:** Implemented (2026-10-10); Level-2 acceptance on real hardware is
pending. Tracking issue: #32. Follows #28 and PR #30. The decision record is
[ADR 0005](adr/0005-macos-setup-platform.md).

## Goal

The complete setup lifecycle (`--dry-run`, `--apply`, `--verify`,
`--rollback`, `--remove`) works on macOS with the same guarantees as on Linux:

- a kernel lock fences the whole inspect → pending → client mutation → owned
  transaction;
- the fence is released only after a determinate process-table scan confirms
  that no non-zombie member of a client command's process group remains;
- the ownership directory sits on a filesystem whose lock and fsync semantics
  are accepted.

macOS counts as accepted only after Level-2 setup acceptance on real hardware
(see [Acceptance on real hardware](#acceptance-on-real-hardware)). Until then,
the documentation calls it CI-tested.

## Non-goals

- Windows and every platform other than `linux` and `darwin` keep failing
  closed with `platform_unsupported` before any client command is spawned.
- Intel Macs are not part of the CI matrix. The code path is identical, so
  they are expected to work but are documented as untested.
- The ownership location stays `~/.local/state/pi-session-mcp/` on both
  platforms.
- No new public result codes, statuses, exit codes or result schema changes.
- No release or version change; that is a separate release change.

## Current Linux dependencies

| Concern | Linux mechanism | Location |
| --- | --- | --- |
| Kernel lock | util-linux `flock -E 75 -w N 3` locks the open file description that the parent opened; the guardian inherits it as fd 3 | `src/setup-process.ts` `acquireSetupGuardian` |
| Process-group proof | `/proc/<pid>/stat` scan; `Z` entries do not count as live | `src/setup-process.ts` `processGroupState`, `src/setup-command-guardian.ts` `groupState`, `processTableReadable` |
| Filesystem | `statfs().type` allowlist of Linux magic numbers | `src/setup-ownership.ts` `SUPPORTED_LOCAL_FILESYSTEMS` |
| Platform gates | `process.platform !== "linux"` | `src/setup-main.ts`, `src/setup-process.ts` (runner, guardian), `src/setup-ownership.ts` |

Facts that rule out a direct port, with sources from the research on
2026-10-10:

- macOS ships no `flock(1)`.
- macOS has no `/proc`.
- On macOS, `statfs` `f_type` is a dynamically assigned VFS type index, not a
  stable magic number (Apple Developer Forums thread 87745). Node does not
  expose `f_fstypename`.

## Design

### Platform module

A new module `src/setup-platform.ts` owns every operating-system fact that the
fence relies on. It has no relative imports, so the guardian can load it in
both source and built form.

```ts
export type SetupPlatform = "linux" | "darwin";
export function currentSetupPlatform(platform?: NodeJS.Platform): SetupPlatform | undefined;

export type ProcessGroupState = "alive" | "gone" | "unknown";
export interface ProcessTable {
  /** "alive" if any non-zombie process has this process group ID. */
  groupState(group: number): Promise<ProcessGroupState>;
  /** True only if a scan is trustworthy and contains the calling process. */
  readable(): Promise<boolean>;
  /** Poll interval for cleanup loops: 10 ms on Linux, 50 ms on macOS. */
  readonly pollMs: number;
}
export function createProcessTable(platform: SetupPlatform): ProcessTable;

export function parsePsTable(output: string): readonly ProcessEntry[] | undefined;
export function isTrustedSystemBinary(path: string): boolean;
export function assertSupportedFilesystem(path: string, platform: SetupPlatform): Promise<void>;
export function openLockedDarwin(path: string, options: DarwinLockOptions): Promise<FileHandle>;
```

The exact signatures may gain injected dependencies for tests, such as `stat`,
`statfs`, `open` and the `ps` executor. The behavior below is the contract.

`isTrustedSystemBinary` is the existing `flock` check, moved and shared: a
regular file owned by uid 0, not group- or world-writable, and executable.

### Kernel lock

**Linux (unchanged):**

1. The parent opens the lock file with `O_CREAT | O_RDWR | O_NOFOLLOW`.
2. It validates the file.
3. A trusted `flock -E 75 -w N 3` locks the shared open file description.
4. The guardian inherits that description as fd 3.

**macOS:**

1. The parent opens the lock file with
   `O_CREAT | O_RDWR | O_NOFOLLOW | O_EXLOCK | O_NONBLOCK`.
   - `O_EXLOCK` (`0x20`) and `O_NONBLOCK` (`0x4`) come from XNU
     `bsd/sys/fcntl.h`. `fs.constants` does not export `O_EXLOCK`, so it is a
     named constant in the module with that citation.
   - XNU takes an `F_FLOCK` write lock on the open file description at open
     time. libuv passes the flags through unchanged, adding only
     `O_CLOEXEC`.
2. `EAGAIN` or `EWOULDBLOCK` means the lock is held elsewhere. The open is
   retried every 50 ms until the existing acquisition timeout
   (`acquireTimeoutMs`, default 30 s, at most 120 s); then it fails with
   `ownership_lock_busy`.
   - An abort signal ends the loop with `operation_aborted`.
   - Every other error, including `EOPNOTSUPP` or `ENOTSUP` on a filesystem
     without locking, is `ownership_lock_unavailable`.
   - A failed attempt returns no descriptor and cannot release another
     holder's lock, because these are flock semantics on the open file
     description.
3. The rest is the Linux path, unchanged:
   - `chmod 0600`;
   - fsync of the file and its directory;
   - the inode comparison between descriptor and path;
   - the `afterLockOpen` test hook;
   - `validateFence`;
   - starting the guardian with the locked descriptor as fd 3;
   - the second validation.
4. `acquireSetupGuardian` derives the lock step from the platform:
   - on Linux it runs the util-linux step;
   - on macOS it skips it, because the caller passes a descriptor from
     `openLockedDarwin` that is already locked.

   There is no lock-mode parameter, so a caller cannot select the
   already-locked mode for an unlocked descriptor by mistake. The guardian
   start, IPC protocol and release are shared.

### Process-group proof

**Linux:** the existing `/proc` scan moves unchanged into the platform module.
The two copies in `setup-process.ts` and `setup-command-guardian.ts` become
one.

**macOS:** one scan runs `/bin/ps -A -o pid=,pgid=,stat=`. The call:

- uses the absolute path;
- passes `isTrustedSystemBinary` before every call;
- runs with fixed arguments, an environment of only `LC_ALL=C`, a 2 s timeout
  and a 1 MiB output cap;
- is not detached, so `ps` is never a member of the group under test.

`parsePsTable` accepts only lines that match `^\s*(\d+)\s+(\d+)\s+(\S+)\s*$`.
Any other line rejects the whole output.

The scan result is `unknown` if any of these holds:

- `ps` is untrusted, fails to start, times out or exits non-zero;
- the output exceeds the cap or fails to parse;
- the output does not contain the calling process's own PID.

Otherwise the result is `alive` if any entry has the requested process group
ID and a `stat` that does not start with `Z`, and `gone` if none does.

`readable()` is true only for a scan that is not `unknown`. The guardian sends
`ready` only after `readable()` succeeds, as it does today with `/proc`.

`kill(-pgid, 0)` is deliberately not used as proof. The XNU source treats
zombie-only groups inconsistently.

**Callers become asynchronous:**

- the process runner's `finishAfterGroup`;
- the MCP launcher's `kill`;
- the guardian's `groupState` loops.

Deadlines stay as they are (2 s report deadline, 1 s launcher cleanup). Only
the poll interval comes from `ProcessTable.pollMs`.

**Guardian loading.** The guardian is started as `.ts` in source-mode tests
(Node type stripping) and as `.js` in production. A static relative import
would fail in source mode. The guardian therefore loads the platform module
with a dynamic import that picks `./setup-platform.ts` or
`./setup-platform.js` next to itself. This is the same selection that
`setup-process.ts` already uses to locate the guardian. `setup-platform.js`
becomes a mandatory regular, non-symlink release artifact next to `main.js`
and `setup-command-guardian.js` in `src/setup.ts`. The ownership fingerprint
already binds every built runtime module.

### Filesystem rule

**Linux:** unchanged magic-number allowlist.

**macOS:** the ownership directory, and the nearest existing ancestor that is
checked before creation, must have the same `statfs().type` as `/`. The
reasoning:

- The minimum macOS that Node.js 22 supports is macOS 11.
- From macOS 11 on, `/` is the sealed APFS system volume, so its type is
  APFS in every case.
- `f_type` identifies a filesystem type for the running kernel, so equality
  with `/` means APFS.
- APFS volumes are local.
- HFS+, exFAT, MS-DOS, SMB, NFS, AFP and every other type fail closed with
  `ownership_filesystem_unsupported`.

Directory fsync uses the existing `FileHandle.sync()`. On macOS, libuv already
tries `F_FULLFSYNC`, then `F_BARRIERFSYNC`, then `fsync`. Whether this
succeeds on a directory descriptor on APFS is unverified, so a macOS CI test
asserts it. A failure fails closed.

### Platform gates

`process.platform !== "linux"` becomes `currentSetupPlatform() === undefined`
in these places:

- `setup-main.ts`, before any client command;
- the process runner, which returns exit code 126;
- `acquireSetupGuardian`;
- `DurableOwnershipStore.withLock`.

## Failure semantics

Public behavior is identical on both platforms:

- The stable codes are unchanged. Lock failures are `ownership_lock_busy`,
  `ownership_lock_unavailable` and `ownership_filesystem_unsupported`.
  Internally they surface as the existing public `ownership_unavailable`,
  `cleanup_failed` and `operation_interrupted`.
- An `unknown` process-group state while the guardian holds the fence keeps
  the fence and reports exit code 126 to the caller. Cleanup continues in the
  detached guardian.
- Exit codes stay `0`, `1`, `64`, `130` and `143`.
- Results never contain paths, command arguments, command output or raw
  errors. `ps` output never leaves the platform module.

## Trust boundary and limits

These are added to `threat-model.md` and `client-setup-design.md`:

- On macOS, the proof that no live group member remains rests on `/bin/ps`,
  which sits on the sealed, SIP-protected system volume, together with the
  uid and mode check.
- Tampering by the same UID with the stable lock path stays outside the
  fence's trust boundary on both platforms.
- On both platforms, the fence does not cover descendants that escape the
  process group, and it does not promise PID reaping.
- The macOS lock depends on the documented `O_EXLOCK` behavior of open(2):
  flock(2) semantics, with `EOPNOTSUPP` on filesystems without locking.

## Testing

**Unit tests, run on Linux and macOS with injected dependencies:**

- `parsePsTable`:
  - a live group, a zombie-only group and a foreign group;
  - a malformed line, an extra header line, empty output;
  - a missing own PID, a non-zero exit, output over the cap.
- `isTrustedSystemBinary`: not root-owned, group-writable, world-writable,
  not executable, not a regular file, missing. Like the existing `flock`
  check, it follows symlinks, so Linux behavior is unchanged.
- macOS filesystem rule: same type, different type, and `statfs` failure.
- macOS lock loop:
  - `EAGAIN` then success; persistent `EAGAIN` until the timeout gives
    `ownership_lock_busy`;
  - `EOPNOTSUPP` gives `ownership_lock_unavailable`;
  - an abort during the wait gives `operation_aborted`;
  - no descriptor leaks on any of these paths.
- `currentSetupPlatform`: `linux`, `darwin`, `win32`, `freebsd`.

**Integration tests:** their gate changes from `process.platform !== "linux"`
to "setup platform supported", so they also run on macOS:

- `test/setup-ownership.test.ts`: the durable store, including real lock
  contention between processes;
- `test/setup-process.test.ts`: the runner terminates a real process group,
  and fence retention on an indeterminate scan;
- `test/setup-main.test.ts`: the `SIGINT` and `SIGTERM` cleanup with exit
  codes 130 and 143, and the stubborn process group;
- `test/setup-lifecycle.test.ts`: the corrupt durable ownership store.

**macOS-only tests:**

- `O_EXLOCK` semantics:
  - a second non-blocking open is busy while the first descriptor is open;
  - a child process that inherited the descriptor keeps the lock after the
    parent closes its copy;
  - the lock is free after the last close.
- Directory fsync on the test's temporary APFS directory succeeds.
- `os.tmpdir()` passes the macOS filesystem rule.

**Server lifecycle:** `test/process-fixture.ts` reads `/proc/<pid>/stat` and
`/proc/<pid>/cmdline`. It moves to a platform helper that uses `/proc` on
Linux and `/bin/ps -p <pid> -o stat=,command=` on macOS. Then
`test/process-stdin-eof.test.ts` also runs on macOS and proves that the server
exits on stdin EOF there. This is a separate commit.

**Load sensitivity:** no timeout is raised in advance. Flaky tests observed on
macOS runners are treated individually, with the cause recorded.

## CI

The ruleset "Protect main" requires a status check named `verify`. A plain
matrix would rename it to `verify (macos-15)` and so on, and block every merge.
The workflow therefore has two jobs:

- **`test`:** a matrix over `os: [ubuntu-latest, macos-15, macos-26]` with
  `fail-fast: false`, the same steps as today, and Node pinned to `22.19.0`.
- **`verify`:** depends on `test`, always runs, and passes only if every
  platform passed. It keeps the required check name, so the ruleset does
  not change.

Standard GitHub-hosted runners are free for this public repository. The Pi SDK
canary stays on Linux.

## Documentation and governance

- **ADR 0005, "macOS as a supported setup platform":**
  - It records that the B-type revisit trigger of ADR 0003 (repeated setup
    friction) fired with #28.
  - It records the chosen approach and the rejected alternatives:
    - a `lockf(1)` helper with `/sbin/mount` parsing, rejected because the fd
      mode of `lockf` on macOS 15 and the `mount` output format are
      unverified;
    - a weaker macOS profile without the kernel fence or the process-group
      proof.
  - It sets the condition that macOS counts as accepted only after Level-2
    acceptance on real hardware.
  - Its revisit triggers: a change in the `ps` output format, in `O_EXLOCK`
    semantics, or in the minimum macOS version that Node supports.
- **`AGENTS.md`:** the rule "Mutating setup is Linux-only and requires …"
  becomes a rule for Linux or macOS, each with its platform's requirements.
  This change to an agent rule is called out in the PR.
- **`docs/client-setup-design.md` and `docs/threat-model.md`:** platform
  requirements and the trust boundary for both platforms.
- **`docs/installation.md`:**
  - `setup` on macOS;
  - "Register without setup" stays as a general alternative, without a macOS
    special case.
- **`README.md`:** the Status line names Linux and macOS, the macOS CI
  versions, Intel as untested, and the acceptance status.
- **`docs/acceptance.md`:** the macOS Level-2 checklist and its evidence
  format.
- **`CHANGELOG.md`:** an Unreleased entry.

## Acceptance on real hardware

A Level-2 run on the owner's Mac, from the PR branch build, records:

- **Environment:** macOS version, architecture, Node version, Claude Code and
  Codex versions.
- **Before mutating:** `doctor`, and `setup --dry-run` for
  `claude-code:user:pi-session-mcp` and `codex:user:pi-session-mcp`.
- **The lifecycle, for each target:** `--apply`, `--verify`, `--rollback`,
  then `--apply` and `--remove`.
- **Lock contention:** two `--apply` runs for the same target, started in
  parallel.
  - The second waits for the first, because the acquisition timeout is 30 s.
  - It then reports the registration as already equivalent.
  - Both exit with 0, and the ownership record stays readable.
  - `ownership_lock_busy` would appear only if the first run held the lock
    for longer than the timeout.
- **Interruption:** Ctrl-C during `--apply` gives exit code 130, leaves no
  process from the client command's group behind, and a following run
  reconciles.
- **Evidence:** exit codes and the sanitized human and JSON results. No paths,
  environment values or secrets are recorded.

The evidence is committed to the same PR before merge.

## Delivery

One branch, `feat/macos-setup`, and one PR referencing #32. Separate commits,
in this order:

1. platform module;
2. macOS lock;
3. process table and guardian;
4. filesystem rule;
5. server lifecycle fixture;
6. CI matrix;
7. documentation, ADR 0005 and `AGENTS.md`;
8. acceptance evidence.

The merge requires all of the following:

- green CI on all three runners;
- reviews without open findings;
- the owner's evidence from the Mac.

# ADR 0005: setup supports macOS with the same fence as on Linux

**Status:** Accepted (2026-10-10). macOS counts as accepted only after
Level-2 setup acceptance on real hardware; see [Acceptance](../acceptance.md).

## Context

`setup` refused every operation on macOS with `platform_unsupported`. #28
reported this from a Mac: Doctor and a manual registration worked, but
`--verify` and the ownership lifecycle were unavailable. ADR 0003 names
repeated setup friction beyond version drift as a trigger to revisit this
area.

The setup fence relied on three Linux facts:

- util-linux `flock` locks the open file description of the ownership lock
  file, and the transaction guardian inherits it;
- a `/proc` scan proves that no non-zombie member of a client command's
  process group remains before the fence is released;
- `statfs` magic numbers identify the local filesystems on which lock and
  fsync semantics are accepted.

None of them carries over: macOS ships no `flock(1)` and no `/proc`, and its
`statfs` `f_type` is a dynamically assigned VFS index rather than a stable
magic number.

## Decision

`setup` supports Linux and macOS. Every other platform still fails closed with
`platform_unsupported` before any client command is spawned.

`src/setup-platform.ts` owns the operating-system facts behind the fence. Its
macOS primitives are:

- **Lock.** The lock file is opened with `O_EXLOCK | O_NONBLOCK`. XNU takes a
  flock(2)-semantics lock on the open file description at open time. A busy
  lock is retried every 50 ms within the existing acquisition bound, and the
  guardian inherits the locked description as on Linux.
- **Process-group proof.** The trusted system `/bin/ps -A -o pid=,pgid=,stat=`
  is parsed strictly. A scan that fails, times out, has an unexpected line or
  does not list the caller is `unknown`, and `unknown` retains the fence.
- **Filesystem.** The ownership directory must have the same `statfs` type
  as `/`, which is the APFS system volume on every macOS that Node.js 22
  supports. Any other type fails closed.

Public result codes, statuses, exit codes and the result schema do not
change. CI runs on Linux, macOS 15 and macOS 26. A `verify` job aggregates
the matrix, so the required status check keeps its name.

## Consequences

- Operators on macOS get the same lifecycle, ownership records and
  verification as on Linux, including `--verify` for a registration that
  `setup` made.
- On macOS, the proof that no live group member remains rests on `/bin/ps`,
  which sits on the sealed system volume, plus the uid and mode check that
  already guarded `flock`. As on Linux, it does not cover descendants that
  escape the process group, and it does not promise PID reaping.
- An ownership directory on HFS+, exFAT, a network volume or any other
  non-APFS filesystem fails closed on macOS.
- Intel Macs run the same code path but are not in the CI matrix.
- The guardian and the process runner load the platform module with a
  dynamic import, because source-mode tests run them through Node type
  stripping. `setup-platform.js` is therefore a mandatory release artifact
  next to `main.js` and `setup-command-guardian.js`.

## Alternatives considered

- **A `lockf(1)` helper and `/sbin/mount` parsing.** This would have mirrored
  the Linux shape. Rejected: the descriptor mode of `lockf` on macOS 15 and
  the `mount` output format are unverified.
- **A weaker macOS profile without the kernel fence or the process-group
  proof.** Rejected: it would break the guarantee that a later setup
  transaction cannot race an orphaned client command.
- **`kill(-pgid, 0)` as the process-group proof.** Rejected: the XNU source
  handles groups that contain only zombies inconsistently.

## Revisit triggers

- The `ps` output format or its `stat` letters change.
- The `O_EXLOCK` semantics of open(2) change.
- The minimum macOS version that Node.js supports changes.
- A request to add Intel Macs to CI, or to support another platform.

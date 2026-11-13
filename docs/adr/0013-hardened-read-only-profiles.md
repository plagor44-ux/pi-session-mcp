# ADR 0013: Hardened read-only profiles

**Status:** Accepted (2026-10-28); released in 0.13.0. Amends
[ADR 0006](0006-pi-extension-allowlist.md) and
[ADR 0010](0010-read-only-extension-tools.md). Issue #169.

## Context

Read-only profiles have `read`, `grep`, `find` and `ls` and no shell. Review
workers cannot run `git log`, `git blame`, a test file or a short script, and
read more files instead.

Read-only sessions run in the host server process. The SDK's read tools accept
absolute paths, `..`, `~` and symlinks, so a read-only worker can read every
file the operator can read, including Pi credentials outside the workspace.
Today only the absence of a network path keeps that content local. A granted
research tool with free-form input (search, documentation lookup) would give a
prompt-injected worker a channel to send it out.

## Decision

### 1. Workspace-confined read tools for every read-only profile

`read`, `grep`, `find` and `ls` of **every** read-only profile accept only
paths inside the allowed read roots:

- the session's workspace root, and
- the directory of each selected skill file, because the model loads skills
  with `read` and they live outside the workspace. If that directory equals or
  contains the operator's home directory, the configuration file's directory
  (and, for a symlinked configuration file, its target's directory), `~/.pi`
  or Pi's agent directory (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`), only the
  skill file itself is a root, so a catalog entry such as `./SKILL.md` next to
  the configuration or Pi's credentials does not expose them. The real file of
  a symlinked skill file is a root as well, so the model can read it.

The server replaces the SDK's built-in definitions with definitions built from
the root exports `createReadToolDefinition`, `createGrepToolDefinition`,
`createFindToolDefinition` and `createLsToolDefinition`, registered under the
same names as SDK custom tools. Two layers check each call:

1. Before the SDK tool runs, the `path` argument is resolved against the
   session directory and canonicalized with `realpath` (for a path that does
   not exist yet, the nearest existing ancestor plus the remaining segments).
   It must equal an allowed root or lie below one. Arguments the SDK would
   rewrite before resolving (a leading `@` or `~`, a `file:` URL, Unicode
   spaces, NUL) are refused, so this check and the SDK always resolve the
   same path.
2. The `*Operations` hooks of `read`, `grep` and `ls` check the absolute path
   the SDK hands them again. This also covers `read`'s file-name variants and
   symlinks met during reading.

`grep` and `find` start `rg` and `fd` on the checked path. Neither follows
symlinks during traversal by default, so a symlink below the workspace does not
lead out of it. A refusal is an ordinary tool error,
`Path is outside the allowed read roots`, without the path.

At admission the server checks with `getToolDefinition` that each of these
names resolves to the server's own definition; otherwise the start fails with
`pi_session_creation_failed`.

The confinement is always on; there is no configuration field. Reading outside
the workspace has no review use, and a per-profile switch would invite the
unconfined variant for exactly the profiles that get external tools.

### 2. Sandboxed shell, opt-in per profile

The optional profile field `shell` takes the single value `"sandboxed"`. It is
allowed only on `read-only` profiles, not together with
`grantedExtensionTools` (granted extension tools may write, so the shell's
read-only guarantee would not hold), and only on Linux; any other combination
fails config validation with `invalid_execution_profile_config`.

Such a profile also gets `bash`, built with `createBashToolDefinition(cwd,
{ operations, exposeSessionEnvironment: false })` and a custom
`BashOperations.exec`. Each command runs as
`/usr/bin/bwrap <fixed arguments> -- /usr/bin/bash -c <command>`:

- `--unshare-all` (no network), `--unshare-user` (which bubblewrap requires
  for `--disable-userns`), `--disable-userns`, `--die-with-parent`,
  `--new-session`, `--clearenv` with
  `PATH=/usr/local/bin:/usr/bin:/bin` and `HOME=/tmp/home`;
- `/usr` and `/etc` read-only; `/bin`, `/lib`, `/lib64` and `/sbin` recreated
  as the host's merged-`/usr` symlinks or bound read-only; `--dev /dev`,
  `--proc /proc`, a tmpfs `/tmp` limited to 512 MiB; no other host path, so the operator's home
  is not visible;
- the workspace at its host path as an overlay with a temporary upper layer
  (`--overlay-src <workspace> --tmp-overlay <workspace>`): writes succeed
  inside the sandbox and vanish when the command ends;
- for a linked worktree (a `.git` file instead of a directory), the main
  repository's Git directory as a second temporary overlay at its host path,
  so `git log` and `git blame` work. The server accepts the pointer only if
  `gitdir:` names `<common>/worktrees/<name>`, that directory's `gitdir` file
  points back to the workspace's `.git`, its `commondir` resolves to
  `<common>`, and `<common>` holds `HEAD`, `objects` and `refs`. Otherwise
  nothing extra is bound and Git commands fail inside the sandbox. The read
  tools stay confined to the workspace either way.

A command without a `timeout` argument gets a default of 600 seconds; on
timeout or abort the server kills bubblewrap, and the PID namespace takes every
process of the sandbox with it.

The bubblewrap path is fixed and must be a trusted system binary (root-owned,
not group- or world-writable); there is no `PATH` lookup. The tool's own
environment, the controller's environment and `PI_*` session variables never
reach the command.

Fail closed: before a session with `shell: "sandboxed"` starts, the server runs
`/usr/bin/true` through the same sandbox for the session's workspace, bounded
and cancelled with the start request. If the binary is untrusted or the probe
fails, `pi_session_start` fails with the new code `sandbox_unavailable`, class
`needs_operator`. A command whose sandbox cannot start fails as that command;
there is never an unsandboxed fallback.

### 3. Research tools

There is no new mechanism. Operators grant them through the existing
per-profile `mcpServers` with `readOnly: true`. The documentation advises
query-style tools over free URL fetching. Now that every read-only profile is
confined, granting research tools to read-only profiles no longer exposes files
outside the workspace and the skill directories.

### Doctor and capabilities

Doctor stays offline. When any profile has `shell: "sandboxed"`, it probes
each configured workspace with the session's fixed arguments, including a
linked worktree's main Git directory, and reports `sandbox_unavailable` as an
error when the trusted bubblewrap binary is missing or a probe fails, for
example because the installed version lacks the overlay options, unprivileged
user namespaces are disabled or restricted by AppArmor (see
[ADR 0008](0008-coding-profile-isolation.md)), or the workspace's filesystem
cannot be an overlay lower layer. For each
workspace with an unusable gitfile pointer, it warns with
`workspace_git_unavailable` when any profile has a sandboxed shell.

Capabilities expose `shell` (`"none"` or `"sandboxed"`) for every profile,
directly after `grantedExtensionTools`. This is configured intent only.

## Amendments

- [ADR 0018](0018-sandbox-go-module-cache.md) (proposed, 2026-11-02): an
  opt-in profile field `goModuleCache` adds a read-only Go module cache at
  `/go/pkg/mod` and fixed Go variables to the argument list of section 2.
  Without the field the arguments are unchanged.
- ADR 0006: read-only profiles have `read`, `grep`, `find` and `ls`, and
  additionally `bash` with `shell: "sandboxed"`. The read tools are
  workspace-confined.
- ADR 0010: the active tools of a read-only profile are the above, the granted
  MCP tools and the granted extension tools. A profile with granted extension
  tools cannot have a sandboxed shell.

### Amendment 2026-10-29: context files

Issue #192. Previously every resource loader kept the SDK behaviour: Pi
context files (`AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`,
`CLAUDE.MD`) were loaded from the session directory and every ancestor
directory, and a context file reached through a symlink was followed to its
target, so a read-only session also loaded context from outside the workspace.

New rule: for **read-only profiles** every resource loader keeps only context
files whose real path lies inside the workspace's real path, on every reload
and before the first provider request. A symlinked context file that resolves
outside the workspace, a dangling one, and the context files of ancestor
directories above the workspace (including a main repository above a linked
worktree) are not loaded for read-only profiles; the linked worktree's own file
inside the workspace is. Coding profiles keep the SDK behaviour (the working
directory and its ancestors).

The filter runs on the SDK's result, after the SDK has picked the first
existing name per directory. If that file is dropped, the directory contributes
no context file: an `AGENTS.override.md` that resolves outside the workspace
also hides an `AGENTS.md` beside it. This fails closed. A kept file's content
is read again from its verified real path, so a link swapped after the SDK
read cannot bring in outside content.

Why: the read roots of this ADR. Section 1 confines the read tools of
read-only profiles to the workspace and the skill directories; context files
are model input rather than tool reads, and before this amendment they were the
one channel through which content from outside those roots still reached a
read-only session.

### Amendment 2026-10-30: resource limits of the sandboxed shell

Issue #195. Previously the sandbox bounded only `/tmp` (512 MiB) and the
command time (600 seconds by default). Memory, the number of processes and
threads, and the overlay upper layers were unbounded, so a prompt-injected
worker could exhaust the operator user's memory or task count until its command
ended.

New rule: every sandbox run, the start probe and each command alike, starts
inside its own transient systemd user scope with fixed limits, and the command
runs only after the server has verified that the limits are in force.

- Launcher: `/usr/bin/systemd-run --user --scope --quiet --collect
  --unit=pi-session-mcp-shell-<uuid>
  --description="pi-session-mcp sandboxed shell" -p MemoryMax=2147483648
  -p MemorySwapMax=0 -p TasksMax=512 -p RuntimeMaxSec=<deadline + 30>
  -- /usr/bin/bwrap --info-fd 3
  --block-fd 4 <the fixed arguments of section 2>`. systemd-run moves itself
  into the new scope before it executes bubblewrap, so bubblewrap and every
  descendant inherit the scope from their first instruction. The memory value
  was `1073741824` until the
  [amendment of 2026-11-13](#amendment-2026-11-13-memory-limit-of-2-gib).
- Limits per run: `memory.max` 1 GiB (2 GiB since the
  [amendment of 2026-11-13](#amendment-2026-11-13-memory-limit-of-2-gib)),
  `memory.swap.max` 0 and `pids.max` 512
  (processes and threads of bubblewrap and all descendants together). `/tmp`
  stays a 512 MiB tmpfs, and the default timeout stays 600 seconds. The
  first value, 128, was raised before the release: a Node.js process runs
  about ten threads, and this repository's own serial test run
  (`vitest run --maxWorkers=1`) peaked at 179 tasks and could not start its
  workers, so a sandboxed reviewer could not run it. With 512 tasks and 1 GiB
  that run passed; parallel runs still end on the memory limit.
- Gate: bubblewrap writes the sandbox's child PID to fd 3 and then holds the
  command until a byte arrives on fd 4. The server reads both processes'
  `/proc/<pid>/cgroup`, requires one identical cgroup v2 path whose last
  component is the unit it named and which is not the server's own cgroup,
  requires a `cgroup2` mount at `/sys/fs/cgroup`, and reads `memory.max`,
  `memory.swap.max` and `pids.max` of that cgroup. Only when all three equal
  the fixed values does it release the command. On any other outcome, also on
  abort or timeout during this phase, it ends the whole scope before it
  closes fd 4 and the run fails. End of file on fd 4 releases bubblewrap, and
  bubblewrap's sandbox child, which waits on its own copy of fd 4, outlives a
  killed bubblewrap while it waits (`--die-with-parent` does not cover it yet;
  observed natively on 2026-10-30, where closing fd 4 after the kill started
  the command). The server therefore sends `SIGKILL` to the launcher, writes
  `1` to the scope's `cgroup.kill`, found through the launcher's or the
  reported child's `/proc/<pid>/cgroup` and accepted only for its own unit
  name, kills each of those PIDs that is in that scope, and only then closes
  fd 4. When neither PID leads to the scope because the launcher has already
  ended on its own, fd 4 stays open until `RuntimeMaxSec` has passed and
  systemd has stopped the scope. The run then fails: the
  probe reports `false`, and a command fails with the unavailable message, or
  with its usual abort or timeout error when the client aborted it or its
  timeout passed during that phase.
- Scope housekeeping: the unit has the fixed description
  `pi-session-mcp sandboxed shell`, so the user journal never records the
  command line, and `RuntimeMaxSec` set to the run's deadline (5 seconds for
  the probe, the command timeout otherwise) plus 30 seconds. The server's own
  timeout acts first; `RuntimeMaxSec` stops a scope that outlives it, including
  an empty scope that systemd keeps when the launcher is killed before it has
  joined its scope (observed natively for aborts within milliseconds of the
  start). Such an empty scope holds no process and no memory but stays listed
  for the run's whole deadline, up to the command timeout the worker chose.
- Fixed binaries: `/usr/bin/systemd-run` must be a trusted system binary like
  `/usr/bin/bwrap`; there is no `PATH` lookup. The user manager is reached
  through `/run/user/<uid>`, derived from the server's UID and accepted only as
  a real directory owned by that UID without group or other access that holds the `bus`
  socket. That directory is the launcher's only environment variable
  (`XDG_RUNTIME_DIR`); bubblewrap's `--clearenv` keeps it from the command. A
  client that passes no `XDG_RUNTIME_DIR`, such as Codex, works the same way.
- Fail closed: without a trusted launcher, a usable user manager, delegated
  `memory` and `pids` controllers, or the exact values, the probe fails and
  `pi_session_start` returns `sandbox_unavailable`; a later command whose
  verification fails is refused the same way. There is no unlimited fallback
  and no new code, field or configuration. Doctor runs the same probe.

Overlay upper layers: the 512 MiB shared bound that was considered is not
implemented. Bubblewrap places `--tmp-overlay` upper layers on its root tmpfs
and accepts `--size` only before `--tmpfs`; `--overlay` resolves an explicit
upper directory on the host, not on a tmpfs inside the sandbox. A dedicated
bound would need a second, outer bubblewrap with its own namespaces and a view
of the host root, which is a sandbox redesign. Instead the upper layers of the
workspace and of a linked worktree's Git directory, the root tmpfs and `/tmp`
are all RAM-backed and charged to the scope's memory cgroup, which has no swap:
together with the processes' own memory they cannot exceed the memory limit
(1 GiB at first, 2 GiB since 2026-11-13). Filling them
past that ends the command through the kernel's out-of-memory handling rather
than with `ENOSPC`; `/tmp` still reports `ENOSPC` at 512 MiB. The individual
bounds act together; they cannot all be reached at once.

Why: the limits must be in place before the command's first instruction and
verifiable from outside; a per-user shell `ulimit` is shared by every process
of the operator, and an address-space limit per process bounds no total.
systemd's transient scopes use the cgroup v2 controllers that the user manager
already delegates and need no privileges, no new dependency and no change to
the sandbox's mounts.

Residual risk: CPU time and I/O bandwidth are not limited; each concurrent
command has its own scope, so several commands can together use several times
the limits; a process of the operator's own UID or the user manager can change
a scope's limits after the check (outside this threat model). Hosts without a
systemd user manager, or with the `memory` or `pids` controller not delegated,
lose the sandboxed shell; it is refused there rather than run without limits.
If the server process itself dies while a run waits at the gate, the kernel
closes fd 4 and the waiting command starts without a reader; it still runs in
its limited scope, and `RuntimeMaxSec` ends it at the run's deadline plus 30
seconds.

### Amendment 2026-11-10: operations hooks under Pi SDK 1.5.2

Pi SDK 1.5.1 changed two of the operations interfaces behind the second layer
of section 1. The move of the pin from 1.5.0 to 1.5.2 (#270) brings both in:

- `GrepOperations.readFile` is optional and no longer called. Up to 1.5.0
  `grep` read every matched file through that hook when `context` was set.
  Now `rg` emits the context lines itself, as it already did for the matched
  lines of a search without `context`. The server no longer provides the hook,
  so the only path `grep` hands a hook is the search path (`isDirectory`). A
  search stays inside the read roots because both layers check the search path
  and `rg` does not follow symlinks during traversal; the residual in
  [Consequences](#consequences) about a directory swapped after the check is
  unchanged.
- `ReadOperations.createReadStream` is new and optional. The server does not
  provide it, so `read` keeps reading through the guarded `readFile`. It
  therefore still loads a whole file before it selects lines; the SDK's
  streaming would need a guarded stream hook.

The SDK takes a tool's operations as a whole and uses its own unconfined
defaults only when a tool gets none, so a hook the server leaves out is absent
and never replaced. `test/confined-tools.test.ts` checks this for `read`, and
that the hooks alone refuse an outside path inside the SDK's `read`, `grep`
and `ls`. The return type of `confinedOperations` requires a decision for every
hook of `ReadOperations`, `GrepOperations` and `LsOperations`: guarded, or
named as left out. A hook that a later SDK adds to one of them fails the
typecheck and therefore the nightly Pi SDK canary, which did not notice
`createReadStream`. The check goes by hook name: it does not notice an existing
hook whose parameters change, which remains for the source comparison of an SDK
update. `find` gets no operations, as before, and relies on the first layer
alone.

2026-11-13, #273: the server now provides the guarded `read.createReadStream`
hook, so streamable text ranges no longer load the whole file through `readFile`.
Images and non-streamable ranges still use the guarded `readFile`. The order
remains check, then open by path; the residual risk of a directory swapped for
a symlink after the check is unchanged. Unlike the SDK's default, the hook
refuses a signal that is already aborted before it creates the stream: Node
raises a second, uncaught `AbortError` for a stream created with an aborted
signal.

2026-11-13, #298: coding sessions now get a `read` of the server's own as well.
It is the SDK's `read` over the SDK's default operations, except that its
stream is the one above (`src/read-operations.ts`, shared with the confined
hook). With the SDK's default stream, `pi_session_abort` or the turn deadline
ended the server process when it fired while `read` detected the image type or
opened the file: the tool checks its signal before both, and the default
creates the stream on the aborted signal. Paths of the coding `read` stay
unconfined, as with the built-in it replaces, and the other coding tools stay
the SDK's built-ins. Two routes could fix it: an SDK release that checks the
signal itself, adopted through a dependency update, or the server's own read
operations for coding sessions. No Pi SDK release after 1.5.2 has the check, so
the server takes the second route; it uses only exports of the package root,
as the confined tools do. Once an SDK release has the check, a dependency
update can return coding sessions to the built-in `read`.

### Amendment 2026-11-13: memory limit of 2 GiB

Issue #301, maintainer decision of 2026-11-13. The 1 GiB of the
[amendment of 2026-10-30](#amendment-2026-10-30-resource-limits-of-the-sandboxed-shell)
was chosen so that a sandboxed reviewer could run this repository's checks. It
no longer covers them: the kernel ends `npx tsc --noEmit -p .` (TypeScript
7.0.2) with exit status 137 in a scope with `MemoryMax=1073741824`,
`MemorySwapMax=0` and `TasksMax=512`, with or without the task limit, and the
same command passes with `MemoryMax=2147483648` and with 4 GiB (reproduced on
the host with the same scope properties). A routed sandboxed review on
2026-11-13 fell back to type-checking narrowed file sets and reported the
project-wide check as unverified.

New rule: `memory.max` of every run's scope is 2 GiB (`-p MemoryMax=2147483648`
in the launcher above). Swap stays 0, `pids.max` stays 512, `/tmp` stays a
512 MiB tmpfs and the default timeout stays 600 seconds. The gate requires the
new value exactly, as it required the old one, and fails closed otherwise. The
value stays fixed for every sandboxed profile; there is no configuration field.

Why: 2 GiB is the smallest measured value at which the project's own typecheck
passes, so the bound of one command grows only as far as that need requires.
A bounded per-profile limit would add a configuration field and a profile
comparison for one known need. Keeping 1 GiB and documenting the gap would
leave sandboxed reviewers unable to run the project-wide typecheck and push
that check back to the controller.

Consequences: one command, together with its RAM-backed overlay upper layers,
the root tmpfs and `/tmp`, can now use up to 2 GiB of the operator user's
memory, and each concurrent command has its own 2 GiB scope. The other limits
and residual risks of the amendment of 2026-10-30 are unchanged. Hosts need no
change; the start probe and Doctor verify the new value.

## Contract change and versioning

The capabilities field `shell`, the start error `sandbox_unavailable` and the
confinement of existing read-only profiles change the public contract and need
minor release **0.13.0** under
[ADR 0003](0003-post-mvp-maintenance.md#versioning). The confinement breaks
read-only workflows that read files outside the workspace. This decision does
not itself bump the version or authorize publication.

## Consequences

- Read-only workers can run Git, tests and scripts without touching the host
  tree or the network.
- The sandbox shows only `/usr`, `/etc` and the workspace. Toolchains under the
  home directory or `/opt` (nvm, `~/.local`) are not available; Node.js and Git
  from the distribution are.
- Lock-dependent tests that need a supported local filesystem can fail on the
  overlay (seen with `test/setup-modes.test.ts` in the #169 probe).
- Until the amendment of 2026-10-30 the sandbox had no memory, process-count
  or overlay upper-layer limits, so a prompt-injected worker could exhaust
  memory or processes of the operator's user until the command timed out.
  Since then each run has its own systemd scope with fixed limits; see
  [that amendment](#amendment-2026-10-30-resource-limits-of-the-sandboxed-shell).
- When `bash` truncates long output, the SDK stores the full output in the
  host's temporary directory and names that file. Confined `read` refuses it
  and the sandbox's `/tmp` is a fresh tmpfs, so only the truncated output is
  available; workers should narrow their commands instead.
- `ls` omits entries that are symlinks pointing outside the read roots,
  without a notice.
- The confinement checks a path when the call starts. A concurrent writer in
  the same workspace, for example a host-mode coding session, could swap a
  checked directory for a symlink before `rg` or `fd` opens it. Read-only
  workers cannot create such symlinks themselves.
- Extension hooks and granted extension tools keep running in the server
  process with the operator's rights (ADR 0006/0010); confinement covers the
  built-in tools only.
- macOS, a VM backend and network allowlists inside the sandbox are out of
  scope. Coding profiles are unchanged (ADR 0008/0009), except for the `read`
  of #298 in the
  [amendment of 2026-11-10](#amendment-2026-11-10-operations-hooks-under-pi-sdk-152).

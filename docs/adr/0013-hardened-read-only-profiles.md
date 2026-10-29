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
- The sandbox has no memory, process-count or overlay upper-layer limits.
  A prompt-injected worker can exhaust memory or processes of the operator's
  user until the command times out, as a host-mode coding session already
  can. Limits through a cgroup scope are a possible follow-up.
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
  scope. Coding profiles are unchanged (ADR 0008/0009).

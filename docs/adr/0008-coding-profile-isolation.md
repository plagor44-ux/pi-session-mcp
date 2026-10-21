# ADR 0008: Isolation for coding profiles on non-disposable repositories

**Status:** Accepted for Linux (2026-10-18, maintainer decision on the
[decision brief](../reviews/2026-10-18-adr-0008-decision-brief.md)); proposed
2026-10-16. macOS keeps the Sprint 4 interim rules. The Linux setup's acceptance
below passed on 2026-10-18 for one writer of this repository
([evidence](../evaluation/isolation-acceptance-2026-10-18/README.md)); the interim
rules end on Linux for coding work that runs through an accepted wrapped
registration. Issue
[#79](https://github.com/plagor44-ux/pi-session-mcp/issues/79). Follows the
fired isolation trigger of [ADR 0003](0003-post-mvp-maintenance.md#revisit-triggers)
and the [Sprint 4 decision](../sprints/2026-10-15-s4-decision.md).

## Context

Coding profiles have written on non-disposable repositories (maintainer,
2026-10-15). ADR 0003 deferred isolation until coding profiles are used on
non-disposable repositories or with untrusted content, at the latest before a
local writer runs on real repositories; that point has passed. Sprint 4
chose this decision as the one next investment and ruled out any runtime
change before it is accepted.

Facts the options must meet:

- A `coding` profile grants the built-in tools `read`, `bash`, `edit`,
  `write`, `grep`, `find` and `ls` ([`src/session-tools.ts`](../../src/session-tools.ts)),
  plus granted MCP and extension tools. Pi runs inside the server process
  (ADR 0002): `edit` and `write` are file writes of the server's own Node.js
  process. `bash` starts a shell, and `grep` and `find` start `rg` and `fd`,
  which the SDK downloads into its tool directory when they are missing (Pi
  SDK 1.2.0, `core/tools/` and `utils/tools-manager.js`), in `read-only`
  profiles too.
- Other child processes exist too. A granted external MCP server is started
  with the workspace as its working directory and with host environment values
  named in its `envFrom` ([`src/mcp-stdio-client.ts`](../../src/mcp-stdio-client.ts)).
  The Cursor runtime of `pi-cursor-sdk` starts `git`, `ssh`, `gh` and its own
  MCP servers, in `read-only` profiles too ([threat model](../threat-model.md#residual-risks)).
- One server process serves every session of its client. Whatever confines
  that process confines all of its sessions alike, so it can only allow the
  union of their workspaces, plus what the process itself needs: its
  installation, configuration and skill files, Pi's agent directory, temporary
  files, the tool directory and the provider network.
- A workspace alias selects a working directory, not a boundary; symlinks and
  Pi tools reach whatever the OS identity can reach. Pi's agent directory holds
  provider authentication and the installed extension packages that
  allowlisted profiles load.
- A linked Git worktree shares `hooks/` and `config` with its main repository
  ([gitrepository-layout](https://git-scm.com/docs/gitrepository-layout),
  [git-worktree](https://git-scm.com/docs/git-worktree));
  `extensions.worktreeConfig` adds a per-worktree scope but removes no sharing
  ([git-config](https://git-scm.com/docs/git-config)). Local configuration
  such as `core.fsmonitor` or `diff.external` runs commands, so a writer that
  changes a repository's `.git` can run code in the operator's later Git
  commands.
- Linux and macOS are supported platforms. macOS live acceptance on real
  hardware (R10, R11) passed for Claude Code on 2026-10-16 (release 0.8.3);
  it covers setup and smoke, not containment, and Codex on macOS is not
  established. The server runs without root.
- Each client starts its own server over stdio, so a client can register a
  second server under another name with another command. A registration that
  setup did not make is not bound to a build and not owned or verified by
  setup ([installation](../installation.md#if-the-build-changed-first)).

## Threats

| Threat | Acting through |
| --- | --- |
| T1 model error | the session's tools |
| T2 prompt injection from repository content or `AGENTS.md` | the session's tools |
| T3 host code execution later: changed `.git` hooks or config, Pi's agent directory, shell start-up files, scheduled jobs | writes outside the change the operator reviews |
| T4 credential use: push, SSH, tokens | `bash`, MCP and extension children |
| T5 exfiltration of readable data | the network, including the provider connection |
| T6 allowlisted extension code | trusted code with the server's rights (ADR 0006) |

## Options

Sources were read on 2026-10-16.

1. **Operator-environment containment, no server change.** A second client
   registration for coding work (for example `pi-coding`) starts the server
   inside a boundary: rootless Podman (`podman run -i --rm …`) or a separate
   OS user. The host registration stays for read-only work, and Claude Code
   and Codex stay on the host. Inside the boundary only the writer's full
   clone is writable, its `.git/hooks` and `.git/config` are mounted
   read-only, Pi's agent directory is a separate copy or read-only, and no SSH
   agent, GitHub token or Git credential helper is passed in.
   - Confines the whole server process tree: `edit`, `write`, `bash`, `rg`,
     `fd`, MCP and extension children, and limits the reach of extension
     code.
   - One wrapped registration sees the union of what it mounts. Writers are
     isolated from each other only with one boundary per writer.
   - Linux first. On macOS it needs a Linux VM (for example Lima or Podman
     machine); no macOS VM setup has been tried or accepted (R10/R11 cover
     setup and smoke only).
   - Adds no code, dependency or platform path to the server. The operator
     carries the setup, and setup does not own or verify the wrapped
     registration.
   - Limits: network egress stays possible unless the boundary removes it,
     and every writable mount stays writable.
2. **In-server layered sandbox.** Start the server with the Node.js
   permission model (`--permission`, `--allow-fs-write` for the aliases) to
   confine `edit` and `write`, and wrap each `bash` child in bubblewrap on
   Linux and `sandbox-exec` (Seatbelt) on macOS, as Claude Code does for its
   shell tool ([Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing)).
   - Node defines its permission model as a guard "to reduce the blast radius
     of mistakes in trusted application code", not "a security boundary
     against intentional misuse"
     ([Node SECURITY.md](https://github.com/nodejs/node/blob/main/SECURITY.md));
     symlinks and existing file descriptors bypass it by design
     ([permissions](https://nodejs.org/docs/latest-v24.x/api/permissions.html)).
     Node security releases fixed bypasses of its checks in
     [December 2025](https://nodejs.org/en/blog/vulnerability/december-2025-security-releases),
     [June 2026](https://nodejs.org/en/blog/vulnerability/june-2026-security-releases)
     and [July 2026](https://nodejs.org/en/blog/vulnerability/july-2026-security-releases).
   - `bash`, `rg`, `fd`, MCP servers and extension children need
     `--allow-child-process`, which leaves them outside Node's model; a `bash`
     wrapper confines only `bash`.
   - bubblewrap needs unprivileged user namespaces, which Ubuntu 24.04
     restricts through AppArmor by default
     ([Ubuntu](https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces));
     `sandbox-exec` is deprecated and its profile language is not API
     ([Apple DTS](https://developer.apple.com/forums/thread/777509)).
   - A partial form, a `bash` wrapper that only protects `.git/hooks` and
     `.git/config`, is false assurance: `edit` and `write` reach the same files
     from the server process.
   - Adds two platform-specific sandbox paths and a launch-mode change to a
     deliberately small server. Claude Code's own built-in file tools also run
     outside its sandbox, which is the same gap.
3. **Linux whole-process self-restriction.** The server restricts itself with
   Landlock (and seccomp) at start
   ([landlock(7)](https://man7.org/linux/man-pages/man7/landlock.7.html)).
   - Covers in-process writes and every child, but is Linux-only, needs a
     native addon or helper, applies to all threads only with kernel 7.0
     (`TSYNC`), and gives every session the union of all aliases. Network rules
     cover TCP ports only, and only from kernel 6.7.
4. **One sandboxed worker process per session.** Move each Pi session out of
   process into a worker confined to its own workspace, with the server
   relaying MCP calls.
   - The only server-side option with per-session confinement of every tool.
   - Amends ADR 0002 and adds process supervision, a relay protocol, abort and
     close across processes, and platform wrappers; the largest change.

| Threat | 1 wrapped registration | 2 in-server sandbox | 3 Landlock | 4 worker per session |
| --- | --- | --- | --- | --- |
| T1, T2 writes outside the workspace | confined to the mounts | `bash` only reliably; in-process writes best effort | confined to the union | confined per session |
| T3 later host code execution | prevented by read-only `.git` and agent directory | partly (`bash` only) | partly (union of aliases) | per session, with read-only `.git` |
| T4 credentials | not passed in | `bash` only | not addressed | depends on the worker's environment |
| T5 exfiltration | only if the boundary removes the network; the provider stays reachable | `bash` network only | TCP rules only | with an OS wrapper |
| T6 extension code | reach limited to the boundary | not confined | confined to the union | confined per session |

## Decision

Accepted on 2026-10-18 as proposed below, for Linux first:

- Direction: option 1 in its wrapped-registration form, rootless Podman with one
  boundary per writer and a full clone per writer; a separate OS user remains the
  documented alternative.
- macOS keeps the Sprint 4 interim rules; a VM runbook is not planned yet.
- The open questions below (auth refresh, external MCP grants and `envFrom`,
  network egress) are settled in the setup's acceptance, not in advance.
- Review point: 2026-11-15, to review the switch of the remaining coding work
  to wrapped registrations. The Linux acceptance passed on 2026-10-18 for the
  writer `psm-alpha`, with a writable agent directory copy holding only the
  access token, network not limited and no external MCP grants.
- Until the acceptance passes, the interim rules stay in force. As an immediate
  step, coding workers for this repository get a dedicated workspace alias on a
  full clone instead of a linked worktree. The operator runbook is
  [Isolation setup](../isolation-setup.md).

## Proposed decision (as proposed on 2026-10-16)

Choose **option 1 in its wrapped-registration form** and add no runtime
change.

- Document one setup first: on Linux, a coding-only registration that starts
  the server in rootless Podman, one boundary per writer, with the mounts and
  exclusions of option 1, and the host registration for read-only work. A
  separate OS user is the documented alternative where Podman is not
  available.
- Review a writer's result from outside the boundary by fetching its branch
  into the host repository and inspecting it there. Never run Git as the host
  user inside a writer's clone: its local configuration can run code.
- Cursor-backed coding profiles stay off non-disposable repositories until
  they are accepted inside the boundary, because their runtime brings its own
  authentication and processes.
- End of the interim period: once this ADR is accepted and the setup passed
  its acceptance below, coding profiles write on non-disposable repositories
  only through the wrapped registration, and the Sprint 4 interim rules end.
  Until then they stay in force with their recorded residual risks.
- Reject option 2 and its partial forms as false assurance for the surface
  they add. Reject option 3: Linux-only, union-wide, and kernel-dependent.
- Defer option 4 with a trigger: untrusted content, more than one person's
  sessions on one server, or an incident that option 1 would not have
  prevented.

Follow-ups, each with its own issue:
- The threat model states the boundary of option 1; today it only says that
  OS isolation is outside the verified boundary.
- The installation guide documents the wrapped registration.
- First, because linked worktrees are in use today: an offline Doctor
  advisory when a workspace alias is a linked Git worktree while a coding
  profile exists ([#81](https://github.com/plagor44-ux/pi-session-mcp/issues/81)).
  Implemented in Sprint 5 as the warning `workspace_gitfile`, which detects a
  possible linked worktree from a `.git` gitfile without following it; not yet
  released. Refusing coding sessions on such an alias would add a public
  error code and needs a minor release and its own decision.
- Setup support for a wrapped registration would change setup's contract and
  needs its own decision.

Open questions to settle in the setup's acceptance: whether provider
authentication refresh needs write access to Pi's agent directory (a writable
copy then holds only that boundary's credentials), and which external MCP
grants and `envFrom` values a coding registration keeps.

## Acceptance

Linux only. The setup is accepted when all of these pass:

- **Launch binding.** The server process that the client's registered command
  starts runs inside the boundary: checked from the host by its user,
  namespaces or container, not assumed from the configuration.
- **Writes**, provider-free, through that launch command and as its user:
  create or change files outside the workspace through Node.js file writes (as
  `edit` and `write` do) and through `bash`: an absolute path, `../`, a
  symlink that points out, the operator's home, the source repository's
  `.git/hooks` and `.git/config`, Pi's agent directory and its extension
  packages. Every attempt fails. The digests of the host-side targets are
  taken from outside the boundary, before and after, and are unchanged; a
  write that only lands in a bind mount of the protected path does not pass.
- **Credentials**: `~/.ssh`, the SSH agent socket, GitHub and Git credentials,
  the client configurations and the Pi Session MCP configuration are not
  visible, and `git push` and `ssh` to a remote fail.
- **Persistence**: no process, scheduled job or user service outlives the
  session.
- **Children**: MCP children receive only the intended `envFrom` values.
- **Network**: egress is recorded as limited, or explicitly as not limited.
- **Live**: one coding session through the wrapped registration is asked to
  write outside its workspace with `edit`, `write` and `bash`; every attempt
  fails, the host digests stay unchanged, and an ordinary in-workspace change
  still succeeds.

## Consequences

- The server keeps its size, platform parity and MCP contract; ADR 0002 stays
  unchanged.
- Safety for real-repository writing becomes an operator responsibility with a
  documented, tested setup, not a server guarantee.
- Residual risks inside the boundary remain: network egress, the credentials
  the boundary needs for its provider, and trusted extension code.
- macOS keeps the interim rules until a VM-based setup is accepted there.
- If option 4 becomes necessary later, it needs its own decision and amends
  ADR 0002.

## Amendment (2026-10-21): event spool mount

[ADR 0011](0011-turn-events-and-controller-wake.md) adds an opt-in, content-free
event spool so that a Claude Code hook on the host can wake the controller when
a turn ends. For a wrapped registration the server writes from inside the
boundary, so each writer gets **one additional bind mount**:

- A dedicated host directory under the operator's runtime root
  (`$XDG_RUNTIME_DIR/pi-session-mcp/writer-<name>/`), mode 0700, mounted
  read-write at one fixed path inside the boundary.
- It is never shared between writers and never holds a ledger, credentials,
  configuration or results. Setup creates it, checks its ownership and mode,
  and removes it with the registration.
- It is mounted only when the registration enables event delivery.

Threat note: the worker inside the boundary can write to this directory. It can
therefore forge, delete or flood events. The consequences are bounded by design:

- an event is only a wake trigger and carries no state the controller trusts,
  since the controller always reads `pi_turn_get`;
- the host hook validates the event schema strictly, caps the size and number
  of files it reads and never follows links;
- the worst outcome is a spurious or missing wake. A missing wake falls back to
  the hook's budget and one running read.

The mount gives the worker no new read access to host data and no write access
outside this directory. The acceptance of a wrapped writer with event delivery
must show both, in addition to the existing checks.

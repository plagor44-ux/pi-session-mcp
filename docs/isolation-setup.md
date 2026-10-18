# Isolation setup for coding profiles (rootless Podman)

This is the operator runbook for [ADR 0008](adr/0008-coding-profile-isolation.md)
(issue [#79](https://github.com/plagor44-ux/pi-session-mcp/issues/79)): a
coding-only registration whose server runs inside a rootless Podman container,
one container per writer, on Linux. Pi Session MCP does not change. It does not
start, own or verify this registration, and `pi-session-mcp-setup` does not
know about it.

**Status.** Accepted on Linux on 2026-10-18 for one writer of this repository
(`psm-alpha`, rootless Podman 6.1.4), with the wrapper below after three
corrections found by the first runs (tmpfs ownership option, writable agent
directory copy, harness fixes). Evidence:
[isolation acceptance 2026-10-18](evaluation/isolation-acceptance-2026-10-18/README.md).
Every other writer, image or Podman version needs its own acceptance run. The
interim rules of the
[Sprint 4 decision](sprints/2026-10-15-s4-decision.md#interim-operating-rules)
end on Linux only for coding work that goes through an accepted wrapped
registration.

**Platforms.** Linux only. macOS keeps the Sprint 4 interim rules; an isolation
there would need a Linux VM (for example Lima or Podman machine), which nobody
has set up or accepted.

Items that need an operator decision are marked **Open decision** and
collected in [Operator decisions](#operator-decisions).

## The model

- The host keeps its read-only registration (profiles with
  `permissionProfile: "read-only"`). It never gets a coding profile that points
  at a non-disposable repository.
- A second, coding-only registration, for example `pi-coding-alpha`, starts the
  server through `podman run -i --rm …`. The MCP client talks to `podman`
  over stdio; the server runs inside the container.
- **One boundary per writer.** Each writer has its own full clone, its own Pi
  agent directory copy, its own configuration file and its own container. One
  container serves every session of its registration, so two writers in one
  container are not isolated from each other.
- Mounted into the container, and nothing else from the host:
  - the writer's **full clone**, read-write, at the same absolute path as on
    the host (the acceptance script compares paths and the profile's workspace
    alias names that path);
  - the installed package with its production dependencies, **read-only**;
  - the boundary's own configuration file, **read-only**;
  - an **isolated copy of Pi's agent directory** holding only this boundary's
    provider credentials and the extension packages its profile allowlists;
  - a small `tmpfs` for `/tmp` and the container home.
- Not available inside: `~/.ssh`, `SSH_AUTH_SOCK`, GitHub tokens, Git
  credential helpers or stores, the Claude Code and Codex configuration, the
  host Pi Session MCP configuration, the source repository and any other
  workspace. The environment is an explicit allowlist.
- The writer's result leaves the boundary as a Git bundle that the host
  fetches. Host Git never runs inside a writer's clone.

A linked Git worktree is not a boundary clone: it shares `hooks/` and `config`
with its main repository. Use a full clone (`.git` is a directory).

## 1. Install rootless Podman

Use your distribution's package and follow the
[Podman rootless tutorial](https://github.com/containers/podman/blob/main/docs/tutorials/rootless_tutorial.md)
for the prerequisites of your release. For example, on Arch or Linux:

```sh
sudo pacman -S podman
```

Other distributions package it as `podman` as well. Rootless operation needs a
user namespace setup that fits your system:

```sh
# The kernel must allow unprivileged user namespaces and your user needs subordinate id ranges.
grep "^$(id -un):" /etc/subuid /etc/subgid       # both files must list a range of at least 65536
podman info --format '{{.Host.Security.Rootless}}'   # expect: true
podman unshare cat /proc/self/uid_map                # expect a mapping of more than one id
```

If `/etc/subuid` or `/etc/subgid` has no line for your user, an administrator
adds one (`usermod --add-subuids 100000-165535 --add-subgids 100000-165535 <user>`),
and you run `podman system migrate` afterwards. On SELinux hosts the bind mounts
below need the `:Z` option; on AppArmor-restricted user namespaces (for example
Ubuntu 24.04) the distribution documents the required policy. Do not run the
server as root or with `--privileged`.

## 2. Image

The container needs Node.js 22.19.0 or newer, `bash`, `git`, `ssh` (for the
acceptance check) and `coreutils`. A Debian-based Node image fits; an Alpine
image has no `bash`, and the acceptance reports `inconclusive` without it. Build
or pull the image once, pin it by digest and keep the pin in the wrapper
script. **Open decision:** the image source and update policy.

```sh
podman pull docker.io/library/node:22-bookworm      # example only; pin the digest you accept
podman image inspect --format '{{.Digest}}' docker.io/library/node:22-bookworm
```

## 3. Prepare one writer

Per writer (`alpha` below), create state outside the clone:

```sh
STATE="$HOME/writer-state/alpha"
mkdir -p "$STATE/agent" "$STATE/bundles"

# Full clone, no hard links into the source repository. Run this on the host, once, before the writer starts.
git clone --no-hardlinks /path/to/source-repo "$STATE/clone"
```

**Agent directory copy.** Copy only what this boundary needs and nothing else
(not `mcp-auth.json`, not other providers' entries, not session history):

```sh
install -m 0600 /dev/null "$STATE/agent/auth.json"
# Fill it with the entry of the one provider this boundary uses. Do not copy the whole host file.
# Accepted variant: the access token only, with an empty refresh token, so the rotating refresh
# token never enters the boundary (a session past the token's expiry then fails instead of refreshing):
python3 -c 'import json,os,sys; e=json.load(open(os.path.expanduser("~/.pi/agent/auth.json")))["openai"]; e["refresh"]=""; json.dump({"openai":e}, open(sys.argv[1],"w"))' "$STATE/agent/auth.json"
# Empty it again after use: echo '{}' > "$STATE/agent/auth.json"
mkdir -p "$STATE/agent/npm"
# If the profile allowlists extensions, install exactly those into $STATE/agent/npm (Pi's user install layout).
```

Pi's install resolves extensions from `<agent dir>/npm/node_modules/<name>`;
the server never installs. See [installation](installation.md) for the layout.

**Configuration.** Write `$STATE/pi-session-mcp.json` with the one workspace of
this writer (the clone's absolute path) and only the coding profile this
boundary needs. Do not copy `mcpServers` grants or `envFrom` entries from the
host configuration unless you decided to (see the open decisions). The file is
mounted read-only; the profile's provider and model must match the credentials
in the agent directory copy.

**Package.** Use a release installation directory with production dependencies
(`npm ci --omit=dev` in a release checkout), as described in
[installation](installation.md). It is mounted read-only. Never mount a
development checkout.

## 4. The wrapper

Keep the container command in one script, so that the client registration and
the acceptance run use the same flags and mounts. This is an **illustrative,
untested** starting point; adapt it and let the acceptance show whether it
holds.

```sh
#!/bin/sh
# ~/.local/bin/pi-writer-alpha  (mode 0755). Stdout is reserved for MCP frames: no echo, no -t, exec the container.
STATE="$HOME/writer-state/alpha"
CLONE="$STATE/clone"
RELEASE="$HOME/.local/share/pi-session-mcp/releases/vX.Y.Z"
IMAGE="docker.io/library/node@sha256:<pinned digest>"
NETWORK="${PI_WRITER_NETWORK:-pasta}"   # Open decision: network egress policy (see below)

if [ "$#" -eq 0 ]; then set -- node /opt/pi-session-mcp/dist/main.js; fi

exec podman run -i --rm \
  --name pi-writer-alpha \
  --userns=keep-id \
  --read-only \
  --cap-drop=all --security-opt=no-new-privileges \
  --network="$NETWORK" \
  --tmpfs /tmp:rw,nosuid,nodev,size=512m \
  --tmpfs /pi/home:rw,nosuid,nodev,mode=0700,size=64m,U \
  -v "$CLONE:$CLONE:rw" \
  -v "$RELEASE:/opt/pi-session-mcp:ro" \
  -v "$STATE/pi-session-mcp.json:/pi/config.json:ro" \
  -v "$CLONE/.git/hooks:$CLONE/.git/hooks:ro" \
  -v "$CLONE/.git/config:$CLONE/.git/config:ro" \
  -v "$STATE/agent:/pi/agent:rw" \
  --workdir "$CLONE" \
  -e HOME=/pi/home \
  -e PI_SESSION_MCP_CONFIG=/pi/config.json \
  -e PI_CODING_AGENT_DIR=/pi/agent \
  "$IMAGE" "$@"
```

Notes:

- `--env-host` is never used and no `-e NAME` without a value, so no host
  variable passes through. Every variable the container needs is listed. If
  the provider authenticates through an environment variable, pass it with
  `--env-file` from a mode-0600 file that belongs to this boundary only.
- `$STATE/agent` must be mounted read-write: Pi's auth storage writes there even
  without a refresh, and a read-only copy failed session start with
  `local_authentication_unavailable`. Run the acceptance with
  `--agent-dir-copy-writable --agent-dir-copy "$STATE/agent"`.
- Podman 6 rejects `uid=`/`gid=` on `--tmpfs`; the `U` option gives the tmpfs to
  the container user instead.
- `$CLONE/.git/hooks` and `$CLONE/.git/config` are mounted read-only on top of
  the read-write clone. The host never runs Git there; this protects against a
  later mistake. The live acceptance item checked both.
- The container is removed at the end (`--rm`) and has no restart policy. The
  pinned image is the only thing that persists.

## 5. Register the coding-only server

Register the wrapper under its own name, once per writer. This is a manual
registration; `setup` neither makes nor verifies it, and Doctor does not check
it.

```sh
claude mcp add pi-coding-alpha -s local -- "$HOME/.local/bin/pi-writer-alpha"
codex mcp add pi-coding-alpha -- "$HOME/.local/bin/pi-writer-alpha"
```

Use the narrowest scope your client offers. Keep the host registration
read-only: its configuration has no coding profile for a non-disposable
repository. Cursor-backed coding profiles stay off non-disposable repositories
until they are accepted inside this boundary (ADR 0008).

## 6. Review the writer's result from the host

Do not run Git as the host user inside `$CLONE`: its local configuration
(`core.fsmonitor`, `diff.external`, hooks, aliases) can run code. Read-only
mounts of `.git/hooks` and `.git/config` do not close this: the rest of `.git`
stays writable for the worker, which can create redirect files such as
`.git/commondir` or `.git/config.worktree` that point a later host `git` at a
configuration the worker controls (the acceptance records
`commondir_writable_inside: true`).

Before every review, check from the host without Git and refuse the clone if any
redirect file exists:

```sh
for f in commondir gitdir config.worktree; do
  if [ -e "$CLONE/.git/$f" ]; then echo "refuse: .git/$f present" >&2; exit 1; fi
done
```

If a host `git` command in the clone is ever unavoidable, run it as
`GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -c core.fsmonitor=false -c core.hooksPath=/dev/null ...`
after the check above. Stricter variant: mount the whole `$CLONE/.git` read-only;
the worker then cannot commit, and the review takes a patch
(`git diff HEAD`) from the throwaway container instead of a bundle. A direct
`git fetch "$CLONE"` also starts `git upload-pack` against the clone's
configuration; the ADR says to fetch the branch, and this runbook does it from a
bundle, so that no host Git process reads the clone. (Which clone settings
`upload-pack` honors was not audited here.)

```sh
# 1. Create the bundle inside a throwaway container with the clone read-only, no network, no other mounts.
podman run --rm --network=none --userns=keep-id --cap-drop=all --security-opt=no-new-privileges \
  -v "$CLONE:$CLONE:ro" -v "$STATE/bundles:/bundles:rw" \
  "$IMAGE" git -c safe.directory='*' -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "$CLONE" bundle create /bundles/alpha.bundle HEAD

# 2. On the host, in the source repository: verify and fetch into a namespaced ref.
git -C /path/to/source-repo bundle verify "$STATE/bundles/alpha.bundle"
git -C /path/to/source-repo fetch "$STATE/bundles/alpha.bundle" "HEAD:refs/remotes/writer-alpha/work"
git -C /path/to/source-repo log --stat writer-alpha/work   # inspect on the host, then merge or cherry-pick yourself
```

Treat the fetched history as untrusted until you reviewed it. Reset or recreate
the writer's clone and agent directory copy between unrelated tasks.

## Run the acceptance

`scripts/isolation-acceptance.mjs` covers the provider-free items of the
[ADR acceptance](adr/0008-coding-profile-isolation.md#acceptance): launch
binding, writes, credentials, persistence, the checkable part of children, and
network. It needs Linux, Node.js 22.19.0 or newer and Git on the host and uses
Node built-ins only. The **Live** item needs a provider and a real session and
stays manual (below).

How it works: it pipes `scripts/isolation-probe.cjs` to
`<launch prefix> - <config>`, so the prefix must end in a command that behaves
like `node`. Use the wrapper itself: `--launch "$HOME/.local/bin/pi-writer-alpha node"`
runs `node` in the same container flags as the registered server, with the same
mounts. The probe attempts to create or change files, through Node.js file
writes and through `bash -c`, at: an absolute path, `../` out of the workspace,
a symlink in the workspace that points out, the home directory, Pi's agent
directory and its extension packages directory, a user systemd unit directory,
and the `.git/hooks` and `.git/config` of a disposable source repository. It
also looks at credentials, leaves a detached process behind, lists the
environment names of a child process and tries a TCP connect to a public host
on port 443.

Safety of the harness itself (it matters because the control run really
succeeds):

- It only creates new files whose names carry a per-run token, and never
  modifies or deletes a pre-existing file. Git is never run inside the
  workspace.
- The disposable source repository and an `outside` directory live in a run
  directory below `~/.cache/pi-session-mcp-isolation/`, created and removed by
  the harness.
- The host side digests every target before and after, removes every canary it
  finds and verifies the removal. A leftover canary or a changed pre-existing
  target fails the run.
- The report holds booleans, counts, check ids and 12-character digest
  prefixes: no path, file content or environment value. The script refuses to
  write a report that contains anything else.
- `ssh -o BatchMode=yes -o ConnectTimeout=5 -T git@github.com` is the only
  remote command; only "did authentication succeed" is kept. No `git push` and
  no other mutating remote command runs.

### Step 1: the control run (once per host, before the first contained run)

The control shows that the checks can see an escape on this host. It runs
without a boundary against a disposable clone and really performs the escapes.

```sh
CACHE="$HOME/.cache/pi-session-mcp-isolation"; mkdir -p "$CACHE/control"
git clone --no-hardlinks /path/to/any-repo "$CACHE/control/clone"
node scripts/isolation-acceptance.mjs --mode uncontained-control --launch node \
  --workspace "$CACHE/control/clone" --out "$HOME/isolation-control.json"
```

Expected: verdict `control_detected_escapes`, exit 0, every write attempt
`probe_blocked: false` and `host_changed: true`, `residual_canaries: 0`, and
`preexisting_unchanged_after_cleanup: true`. Exit 1 means the control missed an
escape: the checks cannot be trusted on this host, so fix that first.

### Step 2: the contained run

```sh
node scripts/isolation-acceptance.mjs --mode contained \
  --agent-dir-copy-writable --agent-dir-copy "$HOME/writer-state/alpha/agent" \
  --launch "$HOME/.local/bin/pi-writer-alpha node" \
  --workspace "$HOME/writer-state/alpha/clone" --out "$HOME/isolation-alpha.json"
```

Options:

- `--env-allow A,B`: the environment names you chose to pass in. Secret-like
  names that are not listed fail the run; with this option any other
  unexpected name fails it too.
- `--agent-dir-copy-writable`: declares that you decided on a writable agent
  directory copy. Then a write into the boundary's own copy of the agent
  directory or its extension packages does not count as "not blocked", but a
  change that reaches the host still fails.
- `--agent-dir-copy <host path>`: with `--agent-dir-copy-writable`, the host
  path of that copy, so canaries written into it are found and removed.
- `--no-remote-checks`: skips the `ssh` and TCP checks. The run can then end at
  best `inconclusive`.

The exit codes are 0 pass (or the expected control result), 1 fail, 2 usage or
environment error or `inconclusive` (for example no `bash` in the image, the
workspace not writable from inside, or a remote check skipped). The workspace
must be the writer's full clone (a `.git` directory) and must be mounted at the
same absolute path inside.

### What counts as accepted

Setup of a writer is accepted when all of these hold, on Linux:

1. The control run of Step 1 on this host ended `control_detected_escapes`.
2. The contained run ended verdict `pass` (exit 0). That means:
   - **Launch binding:** the probe ran in a different user namespace or mount
     namespace, or as a different OS user, than the harness
     (`launch_binding.bound: true`).
   - **Writes:** every attempt was blocked from inside (`probe_blocked: true`)
     and no host target changed (`host_changed: false`, pre-existing digests
     unchanged before and after).
   - **Credentials:** none of `~/.ssh`, the SSH agent socket, the `gh` hosts
     file or token variable, a Git credential file or helper, the Claude Code
     or Codex client configuration, or the Pi Session MCP configuration is
     visible (`visible_count: 0`), and the `ssh` authentication check did not
     succeed.
   - **Persistence:** the detached process did not outlive the probe, and the
     crontab and user unit file counts did not change.
   - **Children:** no secret-like environment name reaches a child process
     beyond the ones you allowed. This checks the container's environment as
     seen by a `bash` child. Which `envFrom` values a granted external MCP
     server receives in a real session is **not** covered without a provider
     and stays a manual check (see open decisions).
   - **Network:** `network.classification` is recorded as `limited` or as
     `not_limited`. Either is acceptable to the script; the choice is yours.
3. **Live** (manual, with a provider): one coding session through the wrapped
   registration is asked to write outside its workspace with `edit`, `write`
   and `bash`; every attempt fails, the host digests stay unchanged (use the
   same before/after digests as the harness reports), and an ordinary change
   inside the workspace still succeeds.
4. The sanitized JSON reports and the wrapper, with the image digest, are kept
   as the evidence record. No claim of acceptance exists before then.

A writer that fails any item stays out of use. Repeat the acceptance after any
change of the wrapper, the image or the Podman version.

What the script does not show: that the container runtime itself is free of
escapes; that a process inside cannot reach the provider and exfiltrate over
that connection; what trusted extension code does with the credentials in the
agent directory copy. These are the residual risks of ADR 0008.

## Alternative: a separate OS user

Where Podman is not available, a dedicated OS user can serve as the boundary:
its own home, a full clone it owns, no access to your home. Launch the server as
that user through `sudo -u <user>` or `systemd-run`, and run the acceptance with
a launch prefix that does the same and ends in `node`. The harness accepts a
different OS user as binding evidence. The same mounts-and-exclusions logic
applies by file permissions instead of mounts; this path is not described
further here and was not tried.

## Operator decisions

Taken per writer. For `psm-alpha` on 2026-10-18: the official Node image pinned
by digest; network `pasta`, recorded as not limited; no external MCP grants and
no `envFrom`; a writable agent copy holding only the access token. The questions
stay open for every other writer.

1. **Open decision: provider authentication refresh.** Does the provider's
   token refresh need to write into Pi's agent directory? If yes, the copy is
   mounted read-write and holds only this boundary's credentials; pass
   `--agent-dir-copy-writable` to the acceptance. If no, mount it read-only.
   Related: `rg` and `fd` are downloaded into Pi's tool directory when
   missing, which also needs a writable place; either pre-provide them in the
   image or accept a writable copy.
2. **Open decision: external MCP grants and `envFrom`.** Which granted external
   MCP servers, and which host environment values via `envFrom`, a coding
   registration keeps. The default in this runbook is none: no `mcpServers`
   grant and no `envFrom` in the boundary configuration. If you keep some, list
   the names with `--env-allow`, mount their binaries explicitly and check what
   the child receives in a real session.
3. **Open decision: network egress policy.** Rootless Podman gives the
   container outbound access by default (`pasta`). The provider connection
   needs egress to its hosts. `--network=none` removes it entirely (the
   session then cannot reach a provider, so it only fits an in-container
   provider or local model); restricting to the provider hosts needs a proxy
   or firewall that this runbook does not define. Whatever you choose, the
   acceptance records it as `limited` or `not_limited`; the ADR accepts
   either, as long as it is stated.
4. **Open decision: image source and update policy** (see [Image](#2-image)).

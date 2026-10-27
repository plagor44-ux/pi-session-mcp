# ADR 0008 Linux acceptance, 2026-10-18: writers `psm-alpha` and `go-app-alpha`

Setup under test, following [Isolation setup](../../isolation-setup.md): rootless
Podman 6.1.4 (overlay, netavark), image `docker.io/library/node` pinned at
`sha256:c4d5523090a817b7aa86d2111241fdd4f66d1e27782b44160e6aa63b357ecb2d`
(Node 22.23.3, bash, Git, OpenSSH), the released package 0.8.3 mounted read-only,
one full clone of this repository as the only workspace, its `.git/hooks` and
`.git/config` mounted read-only, a tmpfs `HOME`, the minimal server configuration
read-only, and a writable agent directory copy. The [wrapper](wrapper.sh) is the
exact launch command (paths through `$HOME`).

Operator decisions taken for this writer:

| Open decision | Choice |
| --- | --- |
| Image source | Debian-based official Node image, pinned by digest |
| Network egress | `pasta`, recorded as **not limited** (the provider is needed) |
| External MCP grants / `envFrom` | none |
| Auth refresh | writable agent directory copy holding only the `openai` access token with an **empty refresh token**: Pi's auth storage needs write access (a read-only copy failed with `local_authentication_unavailable`), and the rotating refresh token never enters the boundary. The copy is emptied after use; a session past the token's expiry cannot refresh |

## Results

| Item | Evidence | Result |
| --- | --- | --- |
| Control (uncontained, same host) | [control.json](control.json) | `control_detected_escapes`: every write escape seen, canaries removed |
| Contained, final wrapper | [contained.json](contained.json) | **pass**: launch bound (user, mount, PID and network namespaces differ), every write through Node.js and `bash` blocked with no host change, no host credential visible, own configuration not the host's, `ssh` authentication failed, no persistence, children clean, network not limited, all canaries removed (including those in the agent copy); `.git/commondir` could be created inside the clone (expected, the clone is writable) and was removed, none left |
| Contained, read-only agent copy (earlier variant) | [contained-agent-ro.json](contained-agent-ro.json) | pass |
| Live | [live.json](live.json) | **pass**: one `code` session (Sol) through the wrapper attempted `write` to the host home, `edit` on the read-only package and on `.git/config`, and `bash` writes to the host home, `.git/hooks` and through a symlink: all blocked; a `bash` write into the boundary's own agent copy succeeded, as decided; an ordinary file inside the workspace was created. Host targets digested from outside were unchanged except the boundary's own agent copy listing |

Two harness defects surfaced against the runbook and were fixed before the final
runs: the boundary's own tmpfs `HOME` counted as an escape (now exempt only when
the probe sees a tmpfs mount), and the boundary's own server configuration
counted as a visible host configuration (now compared by digest with the host
file). A third gap: with a writable agent copy, canaries in that copy were not
removed; `--agent-dir-copy <host path>` now covers it. A security review then
pointed out that the worker can create Git redirect files (`.git/commondir`,
`.git/config.worktree`) in its clone, which would steer a later host `git` in that
clone to a worker-controlled configuration. The harness now records whether
`commondir` can be created and fails if a redirect file is left behind; the
runbook adds a pre-review refusal check and safe Git flags. The documented flow
never runs host Git in the clone.

One deviation by the integrator: `git status` was run once as the host user in
the writer's clone after the live run, which the runbook forbids. The clone's
`.git/config` and hooks were unchanged by then (digests above), so no code from
the clone could run (no redirect file was present either, checked afterwards); the rule stands.

Not covered: escapes from the container runtime itself, exfiltration over the
provider connection, trusted extension code (none selected), macOS, other
writers or images. Repeat the acceptance after any change of wrapper, image or
Podman version.

## Follow-up the same day: credential sync, second writer, registrations

Other Claude Code and Codex sessions were running on this host and use the host
configuration and `~/.pi/agent`. To leave them undisturbed, the host
configuration and its coding profiles were not changed, no server was
restarted, no new uncontained control run was made (it writes real canaries
into `$HOME` and `~/.pi/agent`; the host's control run above stands), new
clones came from the remote, and the host `auth.json` is only read.

- **Credential sync.** With an access-only copy, a boundary fails
  (`local_authentication_unavailable`) once the host token has expired, because
  Pi refreshes only on demand. The wrappers now run
  [`auth-warmup.mjs`](auth-warmup.mjs) first: if the host token expires within
  20 minutes, it starts and closes one session of the released server with a
  minimal read-only configuration (no model request), which lets Pi refresh the
  host login through its own locked credential store, the same path the
  running sessions use. The wrapper then copies the fresh access token with an
  empty refresh token. The wrapper change was followed by new contained runs.
- **`psm-alpha`** after the change: [contained.json](contained.json) `pass`.
- **`go-app-alpha`** (Go repository): image built from the pinned Node image plus
  Go 1.26.9 with its official checksum, pinned by image ID with `--pull=never`;
  a writable `$STATE/go` for the module and build cache. Contained: `pass`.
  Live: `pass`, the same pattern as `psm-alpha`. Its raw records are not
  published because they name a private repository.
- **Registrations:** `pi-coding-psm-alpha` (this repository) and
  `pi-coding-go-app-alpha` (a private Go repository) in Claude Code's `local` scope only. A running
  session sees a new server after `/mcp` reconnects. Codex has no
  project-local scope, so no Codex registration was added.

Still open: the host configuration keeps its coding profiles for other aliases
(the Sprint 4 interim rules apply to them), other repositories, and macOS.

## Workflow test through a registered wrapper (2026-10-18)

From a Claude Code session with `pi-coding-psm-alpha` registered (`local`
scope), the writer clone was first updated to main inside the boundary. A `code`
worker then created a branch, ran `npm ci` and `test/doctor-gitfile.test.ts`
(network allowed), committed one file, and tried `git push` once. The push failed
(the clone's origin is a host path that is not mounted). A direct push to the
GitHub remote from inside the boundary also failed: no credentials, prompts
disabled.

The review followed the runbook:
- the redirect-file check found nothing;
- the bundle was created in a throwaway container with the clone read-only and
  no network, then verified and fetched into a namespaced ref on the host;
- the commit changed only the requested file, and an independent test run inside
  the boundary passed (18 tests);
- the ref, the bundle and the branch were removed afterwards, and the clone was
  reset inside the boundary.

The branch deletion warned that `.git/config` could not be written, which is the
read-only mount at work. One pitfall found: in zsh, unbraced `$CLONE:ro` in mount
arguments mounts the wrong path; the runbook commands now use `${CLONE}`.

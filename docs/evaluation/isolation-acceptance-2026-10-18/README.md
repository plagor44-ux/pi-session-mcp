# ADR 0008 Linux acceptance, 2026-10-18: writer `psm-alpha`

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

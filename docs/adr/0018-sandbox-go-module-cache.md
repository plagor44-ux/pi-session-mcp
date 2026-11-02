# ADR 0018: Read-only Go module cache in the sandboxed shell

**Status:** Proposed (2026-11-02), implemented as a candidate under issue
[#243](https://github.com/plagor44-ux/pi-session-mcp/issues/243). The
maintainer decides acceptance and the release line.

- Planning basis: main `6c533ac` (published 0.16.1).
- Amends the fixed argument list of
  [ADR 0013](0013-hardened-read-only-profiles.md#2-sandboxed-shell-opt-in-per-profile).

## Context

Read-only reviewers with `shell: "sandboxed"` (ADR 0013) cannot run Go tests
in Go repositories. The sandbox hides the home directory, so the host's Go
module cache (normally `~/go/pkg/mod`) is invisible, and it has no network,
so modules cannot be downloaded. `go test`, `go vet` and `go build` in a
module with dependencies fail while resolving modules, and reviewers fall
back to static review. The same repositories' tests pass inside their
container writers, which mount a private Go cache (`--cache go`).

The issue proposed `GOFLAGS=-mod=mod`, `GOPROXY=off`, `GOSUMDB=off`,
`GOTOOLCHAIN=local` and `GOCACHE` below the sandbox's `/tmp`. Go 1.27.3 was
checked on the host before the design, with a synthetic module, a file proxy
and a separate cache:

| Setting | Observed |
| --- | --- |
| `GOPROXY=off`, module cached | builds and tests pass offline |
| `GOPROXY=off`, module not cached | fails: `module lookup disabled by GOPROXY=off` |
| `GOSUMDB=off`, cache zip hash differs from `go.sum` | still fails: `checksum mismatch` |
| default `-mod=readonly`, `go.sum` entry missing | fails: `missing go.sum entry`, nothing written |
| `GOFLAGS=-mod=mod`, `go.sum` entry missing | succeeds and **rewrites `go.sum`** from the cache |
| `GOTOOLCHAIN=local`, `go 1.99` in `go.mod` | fails: `requires go >= 1.99` |
| `GOENV=off` | `go env GOENV` prints an empty line; `printenv GOENV` prints `off` |

`-mod=mod` silently turns a missing checksum into a green test inside the
overlay: the reviewer would not see that the change under review is broken
for everyone else. That contradicts the review use, so this decision leaves
`GOFLAGS` unset.

## Decision

### Configuration

A new optional execution-profile field `goModuleCache` names the host
directory to bind. It must be an absolute, normalized path of 2 to 4096
characters without NUL, and it is allowed only on a `read-only` profile with
`shell: "sandboxed"`; any other combination fails config validation with
`invalid_execution_profile_config`. There is no default and no automatic
discovery (`go env GOMODCACHE` is never run): an operator who sets the field
decides to disclose the whole cache.

### Sandbox arguments

With the field set, each command and the start probe get, in this order,
after the existing `HOME=/tmp/home`:

- `--setenv GOMODCACHE /go/pkg/mod`, `--setenv GOCACHE /tmp/go-build`,
  `--setenv GOPROXY off`, `--setenv GOSUMDB off`,
  `--setenv GOTOOLCHAIN local`, `--setenv GOENV off`;
- `--ro-bind-fd 5 /go/pkg/mod` after `--dir /tmp/home` and before the
  workspace overlay. Fd 5 is the checked directory handle (see below);
  fds 3 and 4 stay bubblewrap's info and block pipes.

`GOFLAGS` is not set (see Context). `--clearenv` stays, so no inherited Go
variable reaches the command. `GOENV=off` keeps a host `go.env` or a
workspace-level setting from changing these values. The build cache lives in
the sandbox's 512 MiB tmpfs `/tmp` and vanishes with the command. Without the
field the argument list is byte-identical to before.

The target `/go/pkg/mod` is fixed and does not depend on the host path, so
the host path does not appear inside the sandbox.

### Resolution and protection

Each run and each start probe opens the configured path again with
`O_RDONLY | O_DIRECTORY` and checks the opened directory through
`/proc/self/fd/<fd>`: its real path comes from that link, and access, the
`cache/download` check and the protection rules apply to that real path. The
server passes the same descriptor to the child as fd 5 and closes its copy
right after the spawn and on every error path. bubblewrap binds the
descriptor, so the directory that was checked is the directory that is
mounted. Doctor runs the same checks and closes the descriptor.

| Problem | Meaning |
| --- | --- |
| `missing` | the path does not exist |
| `not_directory` | it is not a directory |
| `unreadable` | the server lacks read and search access |
| `unsuitable` | it has no `cache/download` directory, so it is not a module cache |
| `protected` | it is, or contains, the home directory, or it is, contains or lies inside the configuration directory, `~/.pi` or Pi's agent directory |

A cache below the home directory stays allowed (the default `~/go/pkg/mod` is
there). Opening again each run means a symlink retargeted after start is
checked again. Any problem fails closed: the session start fails with
`sandbox_unavailable` and the fixed message, and a command fails as that
command. There is never a run without the cache or without the sandbox.

### Doctor and capabilities

Doctor stays offline. For each profile with `goModuleCache` it reports the
new check `sandbox_go_cache_unavailable` as an error with a path-free
remediation per problem, and probes the sandbox with the cache on the first
workspace whose plain probe passed. Without such a workspace the check is an
error too: the cache is unproven. Doctor builds the protected set with the
same helper as the session adapter (account home, Pi's agent directory, the
configuration directory). Capabilities do not expose the field or
the path; `shell: "sandboxed"` already tells the controller that a shell
exists. A separate capabilities field was rejected: it would be a public
contract change for configured intent that the controller cannot act on.

## Contract change and versioning

No MCP tool, field, state or error code changes. The new configuration field
and the new Doctor check id are operator surfaces, not the MCP contract of
[ADR 0003](0003-post-mvp-maintenance.md#versioning). Configurations without
the field behave exactly as before. A patch release is therefore possible;
the maintainer decides between patch and minor. This decision does not bump
the version or authorize publication.

## Consequences

- With the opt-in, offline `go test`, `go vet` and `go build` work for modules
  whose dependencies are in the cache. A missing module, a missing `go.sum`
  entry, a checksum mismatch or a newer required toolchain fail as they would
  for a careful offline developer.
- The worker, and through it the model provider, can read every module in the
  cache, including private modules from other projects. Operators who keep
  private modules in their main cache should use a dedicated cache populated
  only for the reviewed repositories.
- The cache is read-only inside the sandbox; writes fail with
  `Read-only file system`. Nothing else below the home directory becomes
  visible.
- Check-to-mount race: the first candidate bound the resolved path string.
  Review found that a container writer owns its own Go cache below
  `~/.local/state/pi-session-mcp/writers/<name>/go` and is not a trusted
  local peer: pointed at that cache, it could swap a path component for a
  symlink between the check and the mount and expose the home directory or
  Pi's credentials read-only. Binding the checked descriptor closes that
  window. A writer can still change the cache's contents, so a writer cache
  holds untrusted module code; it runs only inside the sandbox. Prefer a
  cache that only the operator writes.
- Symlinks inside the cache resolve inside the sandbox, where the home
  directory is not mounted.
- The bind's source path is visible inside the sandbox in
  `/proc/self/mountinfo`, as the workspace path already is. Capabilities,
  diagnostics and error messages never contain it.
- A workspace at `/go` or above it would shadow the bind with its overlay;
  such a workspace is not a supported layout.
- Toolchains under `~` or `/opt` stay unavailable; Go must come from `/usr`.
- Nested user namespaces stay refused by `--disable-userns`; tests that start
  their own sandbox still fail.
- The configuration field and the descriptor handling are Linux-only, like
  the sandboxed shell.
- CI has neither bubblewrap nor Go, so the native test
  `test/sandbox-shell.go-cache.bwrap.test.ts` skips there and must be run on a
  host that has both before a release.

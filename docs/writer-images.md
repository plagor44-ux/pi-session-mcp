# Building a custom writer image

Container writers run in a rootless Podman container. Setup ships one image
choice, the built-in `node`. A repository whose work needs more than Node.js and
Git, such as a Go toolchain, Python with uv or Bun, needs an image you build
yourself. This guide explains what setup accepts, what the image must contain,
what the writer provides at runtime, how to build and check an image, and what
changes when you replace it later.

The repository ships no Containerfile and no prebuilt image, and setup never
builds one. The examples below are starting points for your own file, not
supported artifacts. Read [Execution modes](execution-modes.md) for the full
flag reference and [Isolation setup](isolation-setup.md) for the boundary
prerequisites first; this guide does not repeat them.

An agent that builds and adopts an image on the owner's behalf follows the
[Agent guide to building and adopting a writer image](agent-writer-image.md). It
lists what needs the owner's approval, the order of commands, which result codes
mean stop and what to report.

## 1. What setup accepts

`--image <value>` takes exactly one of two forms:

| Value | Meaning |
| --- | --- |
| `node` (default) | The built-in image: the official Node.js image, referenced by a digest pin in the release. Setup looks it up locally and pulls it on `--apply` when it is absent. |
| A 64-character lowercase hex image ID | An image that already exists in the local Podman storage of the operator account. Setup resolves it locally and never pulls it. |

Anything else is refused: a tag such as `localhost/my-image:1`, a registry
reference, a digest with a `sha256:` prefix and a shortened ID such as the
12-character form that `podman images` prints. An ID that Podman cannot resolve
reports `image_unavailable`. Every container setup starts uses `--pull=never`,
so a writer never fetches its image later.

Consequences:

- Podman storage is per account and per machine. The image must exist, with the
  same ID, in the rootless storage of the account that runs the writers on
  every machine that has writers. To move an image between machines use
  `podman save --format oci-archive` and `podman load`, which keep the ID
  (see [section 6](#6-changing-an-image-later)).
- The image architecture must match the host.
- The ID is recorded in the writer state and in the acceptance fingerprint.
  A different ID is a different image, even when its Containerfile did not
  change ([section 6](#6-changing-an-image-later)).

## 2. What the image must contain, and what the writer provides

### Required in the image

Setup does not install anything into your image. These tools must be present
and usable by an unprivileged user:

| Needed | Why |
| --- | --- |
| `node` on `PATH`, version 22.19.0 or newer | The writer starts `node /opt/pi-session-mcp/dist/main.js` from the release, which is mounted read-only into the container. |
| Git | Clone creation, collection, reset, recreation, inspection and recovery run Git inside the recorded image, never on the host clone. |
| `sh` and coreutils (`cp`, `mkdir`, `head`, `printf` and similar) | Those lifecycle steps run as `sh -c` scripts. |
| `find` (GNU findutils) | Cleanup walks the clone with `find` to refuse nested repositories; an image without a working `find` makes reset, finish, recreate and remove refuse. |
| `bash` | The acceptance harness runs each escape attempt through Node.js and through `bash -c`; without bash the acceptance is inconclusive and the writer is not accepted. |
| `ssh` | [Isolation setup](isolation-setup.md#prerequisites) lists it for the harness, which probes for SSH authentication. |

The official Node.js image that the built-in `node` is based on contains all of
these, so deriving from it (section 3) satisfies this table.

Two further rules follow from how the container runs:

- **Install tools system-wide and world-readable**, for example below
  `/usr/local` or `/opt`. The container runs as your own numeric user
  (`--userns=keep-id`), not as root, so anything under `/root` is unreachable.
  The root file system is read-only, so nothing can be installed or updated at
  run time.
- **Do not replace the image's `ENTRYPOINT` with one that does not run its
  arguments.** Setup appends its command (`node ...` or `sh -c ...`) after the
  image, so the entry point has to hand it over unchanged. The official Node.js
  image's entry point does. A `USER` instruction has no effect.

Everything in the image is readable by the worker. Put no credentials, tokens
or private package registry settings into it.

### What the writer provides at run time

The serving container is started with a fixed set of options. Rely on these
and on nothing else the host happens to have:

- Options: `--read-only`, `--cap-drop=all`, `--security-opt=no-new-privileges`,
  `--userns=keep-id`, `--pull=never`, and `--network=pasta` (default) or
  `--network=none` from `--network`. Optional `--cpus`, `--cpu-shares` and
  `--memory` apply to the serving container only.
- Writable places: the clone (mounted at its host path, which is also the working
  directory), `/tmp` as a 512 MiB tmpfs and `HOME=/pi/home` as a 64 MiB tmpfs.
  Both tmpfs directories start empty on every launch. Throwaway clone and
  collection containers use a 1 GiB `/tmp`, no network and the same read-only root.
- Environment that setup sets explicitly (`-e`): `HOME`, `PI_SESSION_MCP_CONFIG`,
  `PI_CODING_AGENT_DIR` and `PI_SESSION_MCP_WRITER_GUARD`, a variable naming
  the event spool directory when event delivery is enabled, and the cache
  variables in the table below. Setup passes no host environment variable by
  name, and it sets no `PATH`, `GOPROXY`, `GOFLAGS` or similar variable.
  Everything else comes from the image's own `ENV`.
- **Exception: proxy variables.** Setup does not pass `--http-proxy=false`, so
  Podman's default applies: it copies the proxy variables of the Podman client's
  own environment (`http_proxy`, `https_proxy`, `ftp_proxy` and `no_proxy`, in
  either case) into every container it starts. The writer that the relay starts
  for a session gets a filtered environment (`HOME`, `PATH` and
  `XDG_RUNTIME_DIR`), but setup's own Podman calls (clone, collect, reset,
  recreate and recovery) and the acceptance harness run with the environment of
  the shell that runs setup. A proxy URL set there, including any user name and
  password in it, is therefore visible inside those containers, including the
  throwaway ones that have no network. Do not keep credentials in proxy
  variables in the shell that runs setup, and do not make an image depend on
  them. A check for this guide confirmed the Podman behavior: a container
  started with `HTTPS_PROXY` set on the client saw the full URL, and
  `--http-proxy=false` removed it.
- One optional per-writer cache, chosen by `--cache`. It lives outside the clone,
  is never shared between writers, survives reset, finish and recreate, and is
  removed with the writer:

| `--cache` | Mount | Variables set by setup |
| --- | --- | --- |
| `none` (default) | none | none |
| `go` | `/pi/go` | `GOPATH=/pi/go`, `GOCACHE=/pi/go/cache`, `GOTOOLCHAIN=local` |
| `uv` | `/pi/uv` | `UV_CACHE_DIR=/pi/uv/cache`, `npm_config_cache=/pi/uv/npm` |
| `npm` | `/pi/npm` | `npm_config_cache=/pi/npm/cache` |

`GOTOOLCHAIN=local` means the Go in the image is the only Go: Go never
downloads another toolchain, so the image must carry the version the
repository's `go.mod` needs. No other tool has a cache option. A cache that
setup does not mount, such as Bun's install cache, lands under `HOME` and is
lost on every launch (see the Bun example).

With `--network=pasta` the writer can reach the network, which is how package
downloads work at run time; it is not a limited network. With `--network=none`
nothing can be downloaded, so the image must already contain everything the
work needs.

**`--network=none` also cuts the session off from its model provider.** The
relay forwards each prompt to the server running inside the writer container,
and that server makes the provider calls itself. In a container without a
network it cannot perform a turn against a remote provider, however complete
the image is. The provider-free acceptance makes no provider request, so a
writer can pass acceptance and verification with `none` and still be unable to
work. Choose `pasta` for a writer that must run a model session, and weigh its
risks in [Execution modes](execution-modes.md#modes-and-risks); `none` only
suits an image you use for checks that need no model.

## 3. How to build

1. **Start from the built-in image's base.** The release pins the base by
   digest in the constant `NODE_IMAGE_REF` (`src/writer-boundary.ts`, compiled
   into `dist/writer-boundary.js` of the installation). Read it from the
   installed package instead of copying a value from a document, because a
   release may change it:

   ```sh
   grep -o 'docker.io/library/node@sha256:[0-9a-f]\{64\}' \
     <package-root>/dist/writer-boundary.js
   ```

   `<package-root>` is the installation directory that contains `dist/`. Pass
   the result to your build as a build argument, as the examples do. A different
   base is allowed, but then check every row of the table above yourself.
2. **Pin every download** by version and checksum. Take the checksum from the
   upstream publisher, not from the file you downloaded, and verify it in the
   same `RUN` step with `sha256sum -c`. A distribution package installed with
   `apt-get` is pinned only by the base's Debian release, not by version or
   checksum.
3. **Build with rootless Podman** as the account that will run the writers, and
   give the image a local name with a version tag. Do not use `latest`, and do
   not publish the image if it contains anything private:

   ```sh
   podman build --build-arg BASE=<NODE_IMAGE_REF> \
     -t localhost/my-writer-go:1 -f go.Containerfile .
   ```

4. **Read the ID** and run the checks in [section 5](#5-verification-checklist):

   ```sh
   podman image inspect --format '{{.Id}}' localhost/my-writer-go:1
   ```

   The printed 64-character hex string is the value for `--image`. The tag is
   only a handle for you; setup never sees it.
5. **Run the repository step as a dry run, then apply**, repeating the full
   settings as on every container mode request (profiles, writers, lifecycle,
   network and any limits, tags or `--clean`), with the `--cache` that matches
   the image:

   ```sh
   pi-session-mcp-setup --repo <alias> --mode container \
     --profiles <coding-profiles> --image <image-id> --cache go
   pi-session-mcp-setup --repo <alias> --mode container \
     --profiles <coding-profiles> --image <image-id> --cache go --apply
   ```

   Apply provisions each writer from the image and runs the contained
   acceptance, so the host isolation control must already have passed; see
   [Isolation setup](isolation-setup.md#provision-and-accept). Then run
   `pi-session-mcp-setup --writer <name> --verify` for each writer.

## 4. Examples

These examples are short and generic. They were built with rootless Podman for
`linux/amd64` from the built-in image's base, and each passed the checks in
section 5. For another architecture, change the download file name and
checksum. Versions drift: update the version and checksum together, taking the
checksum from the publisher's release page. None of these is an endorsement of a
particular version.

Each example takes the base as `--build-arg BASE=<NODE_IMAGE_REF>`.

### Node and Go (`--cache go`)

The checksum comes from the Go download page. Go is installed below
`/usr/local/go`, and setup supplies `GOPATH`, `GOCACHE` and `GOTOOLCHAIN=local`
at run time, so the image only needs the toolchain on `PATH`.

```dockerfile file=go.Containerfile
ARG BASE
FROM ${BASE}
ARG GO_VERSION=1.27.4
ARG GO_SHA256=7226736c2339719cda28fbf3a54d71aa63bcefe376e98cef00034268dab24840
RUN curl -fsSL -o /tmp/go.tgz "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" \
 && echo "${GO_SHA256}  /tmp/go.tgz" | sha256sum -c - \
 && tar --no-same-owner -C /usr/local -xzf /tmp/go.tgz \
 && rm /tmp/go.tgz
ENV PATH=/usr/local/go/bin:${PATH}
```

Use `--image <image-id> --cache go`.

### Node, Python and uv (`--cache uv`)

The checksum comes from the `.sha256` file next to the uv release archive. The
example lets uv install a pinned CPython into a system-wide directory at build
time and forbids downloads at run time, where the root file system is read-only
and the directory would be unwritable anyway. `python3` stays the base's
Debian Python; the uv-managed interpreter is `python3.13`, and `uv venv` finds
it. `UV_LINK_MODE=copy` avoids hard-link warnings, because the clone and the
cache are on different file systems.

```dockerfile file=uv.Containerfile
ARG BASE
FROM ${BASE}
ARG UV_VERSION=0.13.9
ARG UV_SHA256=a7fbaff2b9a271d85c1bdb540941090fd1ce011797b4abeb48e4dcd39c2471d5
ARG PYTHON_VERSION=3.13.18
RUN curl -fsSL -o /tmp/uv.tgz "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz" \
 && echo "${UV_SHA256}  /tmp/uv.tgz" | sha256sum -c - \
 && tar --no-same-owner -C /usr/local/bin --strip-components=1 -xzf /tmp/uv.tgz \
 && rm /tmp/uv.tgz
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python \
    UV_PYTHON_BIN_DIR=/usr/local/bin \
    UV_PYTHON_DOWNLOADS=never \
    UV_LINK_MODE=copy
RUN UV_PYTHON_DOWNLOADS=automatic uv python install "${PYTHON_VERSION}" \
 && chmod -R a+rX /opt/uv-python
```

Use `--image <image-id> --cache uv`. That cache also serves npm
(`npm_config_cache=/pi/uv/npm`).

### Node and Bun (`--cache npm`)

The checksum comes from the `SHASUMS256.txt` file of the Bun release. The
archive needs `unzip`, installed from the Debian repositories in the same step
as the download. Setup has no Bun cache: with `--cache npm` the npm cache is
mounted, but Bun writes its install cache under `HOME`, a 64 MiB tmpfs that is
empty on every launch. To keep Bun's cache across launches, add
`ENV BUN_INSTALL_CACHE_DIR=/pi/npm/bun` to the image and use `--cache npm`; in
a check with the mount present, Bun then wrote its cache below `/pi/npm`. Add
the line only for an image that is always provisioned with `--cache npm`,
because the directory exists only with that cache.

```dockerfile file=bun.Containerfile
ARG BASE
FROM ${BASE}
ARG BUN_VERSION=1.4.5
ARG BUN_SHA256=94559b3b528995a49452f9f2404cec74f2efd7d06e0a000a8cd214b02c3666eb
RUN apt-get update && apt-get install -y --no-install-recommends unzip \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
 && echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum -c - \
 && unzip -q -j /tmp/bun.zip 'bun-linux-x64/bun' -d /usr/local/bin \
 && chmod 0755 /usr/local/bin/bun \
 && rm /tmp/bun.zip
```

Use `--image <image-id> --cache npm`.

### Adding a service, such as a database

A writer cannot run a system service: it has no init system, no root and a
read-only root file system. A service the work needs, for example a database for
integration tests, must be started by the worker as an ordinary process. Install
the server binaries in the image, put its data directory under `/tmp` (the
tmpfs, empty on every launch) and give the worker a small start script. The data
is lost when the container ends, which suits tests, and the 512 MiB of `/tmp`
bounds it. Keep the service on a Unix socket or loopback.

This example installs PostgreSQL from the Debian repositories of the base
(version 15 at the time of writing; the binary directory follows the Debian
release, so adjust it for another base):

```dockerfile file=db.Containerfile
ARG BASE
FROM ${BASE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql postgresql-client \
 && rm -rf /var/lib/apt/lists/*
ENV PATH=/usr/lib/postgresql/15/bin:${PATH}
COPY --chmod=0755 db-start.sh /usr/local/bin/db-start
```

```sh file=db-start.sh
#!/bin/sh
# Start a throwaway PostgreSQL in /tmp (tmpfs): data is lost when the container ends.
set -eu
dir=/tmp/pgdata
initdb -D "$dir" -A trust -U postgres >/dev/null
pg_ctl -D "$dir" -o "-k /tmp -c listen_addresses=''" -l /tmp/pg.log -w start >/dev/null
echo "ready: psql -h /tmp -U postgres"
```

Put `db-start.sh` next to the Containerfile. The same pattern works for other
services: no `systemd`, no files outside `/tmp` and the clone, nothing started
by the image itself. The same extension can sit on top of any example above.

## 5. Verification checklist

Run the image the way a writer does, as your own user, read-only and without
capabilities, before you give its ID to setup. The command below uses the same
options as the serving container, without the mounts:

```sh
ID=$(podman image inspect --format '{{.Id}}' localhost/my-writer-go:1)
check() {
  podman run --rm --pull=never --userns=keep-id --read-only --cap-drop=all \
    --security-opt=no-new-privileges --network=none \
    --tmpfs /tmp:rw,nosuid,nodev,size=512m \
    --tmpfs /pi/home:rw,nosuid,nodev,mode=0700,size=64m,U -e HOME=/pi/home \
    "$ID" "$@"
}
check sh -c 'id -u; node -v; git --version; bash --version | head -1; ssh -V; find --version | head -1; cp --version | head -1'
```

Expect: a non-zero user ID (your own), Node.js 22.19.0 or newer, and a version
line for every other tool. Then check the toolchain you added, for example:

```sh
check go version                       # Go example
check sh -c 'uv --version; python3.13 --version; cd /tmp && uv venv v && v/bin/python -V'   # uv example
check bun --version                    # Bun example
```

Checks that go wrong here go wrong at acceptance too: a missing tool, a tool
under `/root`, or an entry point that swallows its arguments shows up as
`command not found`, a permission error or no output. To test a cache, add the
mount and variables from the table in section 2 and use `--network=pasta`.

## 6. Changing an image later

**A new image ID is a settings change.** A rebuilt image, even from the same
Containerfile, normally gets a different ID (a rebuild with `--no-cache`
produced a different ID in the check for this guide), and so does a changed
base. Existing writers keep the ID they were provisioned from. If you repeat the
provisioning command with a new `--image`, the repository step reports
`writer_settings_changed` for each kept writer, refuses before it writes the
mode, and leaves the writers as they are. The same holds for a changed
`--cache`. To adopt the new settings:

1. Build and check the new image. **Keep the old image** until step 6:
   collection and removal still run inside the image a writer recorded.
2. Close the sessions on the writer. Collect its work with
   `pi-session-mcp-setup --writer <name> --collect --apply` and review the
   collected refs in your own checkout.
3. Preserve what collection does not cover. Collection and the work check that
   guards `--remove` see only what Git in the clone counts as work: commits,
   staged and unstaged changes, untracked files that are not ignored, and the
   stash. **Files under ignored paths are neither inspected nor exported**,
   whatever `--clean` says: `.venv`, `node_modules`, a local `.env`, build
   output and any other ignored file are deleted with the writer, together
   with its per-writer cache. Copy out anything you cannot regenerate before
   you go on (see [Execution modes](execution-modes.md#writer-storage-launch-and-readiness)
   for where a writer keeps its clone). Do not run Git there.
4. Run `pi-session-mcp-setup --writer <name> --remove`. It removes immediately;
   it is not a dry run. Without `--discard` it refuses only work that the
   collection check covers, and never warns about ignored files.
5. Run the provisioning command again with the full settings and the new
   `--image <image-id>`, first as a dry run, then with `--apply`.
6. Once no writer records the old ID, remove the old image with `podman rmi`.

`--recreate` and `--reset` keep the recorded image; neither adopts a new one.

**Recovery from `image_missing`.** If the recorded image disappears from the
local Podman storage (`podman rmi`, `podman system prune`, a reset of the
storage), Doctor reports the writer as `writer_not_ready` with reason
`image_missing` and coding starts fail. A rebuild does not fix it, because the
rebuilt image has a different ID, and `--recreate` uses the same missing image.
Restore the image with that ID:

```sh
podman load -i <archive>
podman image exists <image-id> && echo present
```

An archive made earlier with `podman save --format oci-archive -o <archive>
<name>` restores the same ID (checked for this guide: saved, removed and
loaded again, the ID was identical). Keep such an archive for every image that
has writers. Then run `pi-session-mcp-setup --repo <alias> --apply` without
other settings to accept the writers again; see
[Installation](installation.md#container-writers).

With no archive, setup cannot collect work from that writer, because collection
runs inside the missing image. If the clone holds nothing you need, or you
already collected it, remove the writer with
`pi-session-mcp-setup --writer <name> --remove --discard`, which loses anything
uncollected and every ignored file, and provision it again from a new image as
above. Never run host Git in a writer clone to rescue its work.

# Execution modes

Execution modes record the operator's choice **per repository workspace alias**.
They are separate from execution profiles: a profile chooses tools and a
provider; the workspace mode decides whether the host server permits a coding
session. The decision is [ADR 0009](adr/0009-execution-modes.md). This is Plan A
(policy and diagnosis), intended for release 0.9.0; automated container writers
are not yet implemented.

## Modes and risks

**`host`.** Pi coding sessions write directly in the operator's checkout. The
entry must store `acceptHostWrites: true`, set by setup with
`--accept-host-writes`. **Risk:** coding tools, provider runtimes and trusted
extensions run with the host process's rights, not inside an OS boundary.

**`container`.** The host server refuses coding sessions for this repository;
the entry records the intended writer count, lifecycle, profiles, image and
network. Setup requires usable local rootless Podman, but does not create or
register writers. Use the [manual isolation runbook](isolation-setup.md) for an
accepted wrapped registration with one full clone and boundary per writer.
**Risk:** a recorded mode is not containment, and an actual boundary still holds
provider credentials and may allow exfiltration through its network connection.

**`read-only`.** The host server refuses coding profiles for this repository;
read-only profiles remain available, as they do for every mode. **Risk:** this
is a Pi tool-policy restriction, not an OS sandbox for provider runtimes,
extensions or child processes.

**`unset` (migration state).** A missing file or workspace entry behaves like
host for compatibility; it is reported as `unset`, not as an accepted host
choice. It cannot be selected with `--mode`. **Risk:** existing host coding
remains possible until the operator explicitly chooses a mode.

## Choose at installation

First configure aliases and execution profiles as in
[Installation](installation.md#2-configure), and set `PI_SESSION_MCP_CONFIG`.
Use a configured alias, never a directory. Run mode selection separately from
client registration (`--target`) and skill customization (`--customize-skill`):

```sh
# Inspect the proposed choice; no file is written.
pi-session-mcp-setup --repo my-project --profiles code
# Apply after reviewing the report, if rootless Podman is usable.
pi-session-mcp-setup --repo my-project --profiles code --apply
```

With no `--mode`, setup proposes `container` only when the local rootless Podman
probe succeeds. Otherwise it reports `mode_choice_required`: explicitly choose
`host` with acknowledgment or `read-only`. Container mode requires a non-empty
list of configured coding-profile aliases; replace `code` with yours. Without
that list, explicit or proposed container mode reports
`container_profiles_required` and writes nothing. A profile whose provider is
`cursor` is refused pending its own boundary acceptance.
A successful runtime probe does not prove writer readiness or containment.

Explicit alternatives (dry-run first, then repeat with `--apply`):

```sh
pi-session-mcp-setup --repo my-project --mode host --accept-host-writes
pi-session-mcp-setup --repo my-project --mode read-only
pi-session-mcp-setup --repo my-project --mode container --profiles code,code-local \
  --writers 2 --lifecycle persistent --image node --network pasta
```

| Flag | Accepted values and defaults |
| --- | --- |
| `--repo <alias>` | An alias already in the configuration; no arbitrary path |
| `--mode <mode>` | `host`, `container`, `read-only`; omitted means probe before proposing container |
| `--accept-host-writes` | Required for each explicit host-mode request |
| `--writers N` | Integer 1–16; default 1 |
| `--lifecycle <value>` | `persistent` (default) or `ephemeral` |
| `--profiles a,b` | Non-empty comma-separated coding-profile aliases; required for container mode; no Cursor provider |
| `--image <value>` | Image setting, default `node`; currently recorded only, not pulled, built or pinned |
| `--network <value>` | `pasta` (default, not limited) or `none`; currently recorded only |
| `--dry-run` / `--apply` | Dry-run is the default; only apply writes |
| `--json` | Sanitized JSON instead of the human report |

Writer, lifecycle, profile, image and network flags apply to container mode,
not explicit host or read-only requests. Mode selection supports only dry-run
and apply, not `--verify`, `--rollback` or `--remove`. Writer lifecycle and
network settings describe future provisioning intent, not operations performed
by this command today.

## Storage and changing later

Use the same command to change an existing choice, inspecting a dry-run before
applying. Other workspace entries are preserved. Container options are rebuilt
from the supplied values and defaults, not merged with the previous entry, so
supply the full intended settings (including `--profiles`) each time.

Setup writes `execution-modes.json` next to the configuration. For example:

```json
{
  "schemaVersion": 1,
  "workspaces": {
    "my-project": { "mode": "host", "acceptHostWrites": true },
    "writer-project": {
      "mode": "container", "writers": 1, "lifecycle": "persistent",
      "profiles": ["code"], "image": "node", "network": "pasta"
    },
    "notes": { "mode": "read-only" }
  }
}
```

All aliases must exist in the main configuration. Do not add these objects to
its `workspaces` map: that map still holds paths. Unknown fields, aliases,
profiles or modes, missing host acknowledgment, and malformed files are
invalid. Older servers can read the unchanged main configuration but ignore
this separate file; upgrade every relevant registration before relying on
mode enforcement.

## Reports and enforcement

Setup reports sanitized findings under `modes/workspace/<alias>`:

| Code | Meaning |
| --- | --- |
| `mode_planned` | Dry-run proposes a change; nothing written |
| `mode_applied` | The new entry was written |
| `mode_unchanged` | The stored choice already equals the requested choice |
| `mode_choice_required` | Automatic choice found no usable rootless Podman; explicitly choose host or read-only |
| `host_ack_required` | Explicit host request lacks `--accept-host-writes` |
| `container_profiles_required` | Explicit or proposed container mode lacks a non-empty `--profiles` list; nothing written |
| `container_runtime_unavailable` | Explicit container request found no usable rootless Podman |
| `alias_unknown` | The requested alias is invalid or not configured |
| `modes_file_invalid` | Existing or proposed modes fail validation; no replacement is made |
| `controllers_restart_required` | Emitted after a mode change is applied; running controllers retain the old policy |

Configuration and filesystem/lock failures can also produce setup's general
failure codes; the table lists mode-specific outcomes, not every setup error.
Doctor reports `workspace_mode_unset` as a warning only when a coding profile
exists, `workspace_host_writes_accepted` as an `ok` line for explicit host
choices, and `container_runtime_unavailable` as an error for each container
alias if its local rootless Podman probe fails. Doctor stays offline and never
starts a writer, session or provider request. Invalid modes surface through its
`config_invalid` check. See the [Doctor contract](doctor-design.md).
When any alias uses container mode, a `container_runtime_unavailable` error
also blocks setup's `--target` operations with `doctor_failed` until Doctor is
clean, because those operations run Doctor first. Run `pi-session-mcp-doctor`
to see the cause.

The server fails startup with `invalid_execution_modes` for an invalid modes
file. `pi_capabilities_get` reports each workspace's `mode`. A
`pi_session_start` using a coding profile on `container` or `read-only` returns
`workspace_mode_forbids_coding` before creating a session. The host server does
not dispatch that request to a container and never falls back to host coding
for a container entry. Read-only profiles remain allowed.

## Restart rule

Setup never restarts servers or controllers. After applying a change, restart
all affected controllers, or use `/mcp` reconnect where the client provides it
and ensure it starts a **new server process**. Confirm the new mode with
`pi_capabilities_get`'s workspace `mode`, which confirms the running policy.
The configuration fingerprint covers only the main configuration file, not
`execution-modes.json`. Running servers retain their loaded policy, and changing
the file does not stop existing sessions; close them before tightening policy.
An unchanged request does not emit a new restart finding, but does not make an
old running server reload either.

## Plan B and the manual route

**Plan B is pending, not implemented:** automated writer provisioning,
collection, reset/recreation, generated wrappers, refusal server, writer
registration, and periodic credential refresh for long-running contained
servers. Setup currently records intent only; it neither manages uncollected
work nor verifies writer readiness. No writer lifecycle commands are available.

Follow [Isolation setup](isolation-setup.md) for the manual Linux route and its
acceptance requirements. Keep the host alias in container mode and use a
separate manually registered wrapped server for coding. Its configuration and
mode policy are separate: inside the boundary, an explicit acknowledged host
entry permits writes in that writer's clone. The wrapper's startup credential
copy is not periodic refresh for a long-running server. macOS containment is
not accepted; macOS retains the interim rules and can choose host or read-only.
Follow-up: **Plan B, issue to be opened**.

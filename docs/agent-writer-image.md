# Agent guide to building and adopting a writer image

This guide is for an agent that builds a custom writer image and puts it into
use on the owner's behalf. The owner makes the decisions below; the agent must
not infer approval from silence or from an earlier approval of a different step.
Read [Building a custom writer image](writer-images.md) first: it explains what
an image must contain and what each command does. This page adds the approval
boundaries, the exact order of commands and the evidence to report.

The agent never asks for, handles or stores a provider credential. Building an
image and accepting a writer use no provider. Sign-in commands such as
`pi-session-mcp-provider auth login` belong to the owner alone
([Agent guide to guided installation](agent-install.md)).

## Stop and ask the owner

Stop before each of these and wait for an explicit answer:

- **Choosing versions.** The toolchain and its version (Go, Python, uv, Bun, a
  database), the base image if it is not the one the release pins, and the
  checksums taken from the publisher. Do not pick the "latest" version on the
  owner's behalf.
- **Network access.** Any download the build makes (the base image, a toolchain
  archive, `apt-get`) when the owner restricts network access or has not said it
  is allowed.
- **Building on a machine that already has writers.** A build uses CPU, memory,
  disk and network on a host that may be serving sessions, and the image lands in
  the same Podman storage as the writers' images.
- **Every `--apply`.** The repository step, the isolation control, `--collect`,
  `--reset`, `--finish` and `--recreate` each change state. Show the dry run and
  ask before the matching `--apply`. Approval of one `--apply` covers that command
  only.
- **`--remove` and `--discard`.** `--remove` runs immediately; it has no dry run
  and no `--apply`. `--discard` deliberately loses uncollected work and every
  ignored file. Never combine them on your own initiative.
- **A writer that holds work, and any replacement of a writer's image.** A new
  image ID means collecting, reviewing, removing and provisioning again
  ([Changing an image later](writer-images.md#6-changing-an-image-later)). The
  owner decides when, which writers and what to copy out of ignored paths first.
- **The isolation control.** `pi-session-mcp-setup --isolation-control --repo
  <alias> --apply` runs without containment and creates and removes real canary
  files below the home directory. Ask whether it has passed on this machine before
  you provision; Doctor does not report it.
- **Removing images.** Never run `podman rmi`, `podman image prune` or
  `podman system prune` on your own. An old image that a writer still records
  must stay, and an untagged image is a candidate for pruning. Use a new version
  tag for every build and do not move a tag a writer was provisioned from.
- **The network mode.** `--network=pasta` (default) is not a limited network;
  `--network=none` leaves a writer unable to reach its model provider
  ([network note](writer-images.md#2-what-the-image-must-contain-and-what-the-writer-provides)).
  Do not change a recorded value.
- **Archives.** `podman save` writes the full image to a file. Ask where it may
  go and treat it as the image itself.
- **Proxy variables and secrets in the environment.** Podman copies proxy
  variables, including any user name and password in them, into setup's
  containers ([details](writer-images.md#2-what-the-image-must-contain-and-what-the-writer-provides)).
  Never print the environment. If a proxy URL with credentials is set in the shell
  that would run setup, ask the owner before you run anything.
- **Reconnecting controllers.** On `controllers_restart_required` the owner
  reconnects or restarts the affected controllers. Report it; do not restart them.
- **Anything unexpected.** An unknown result code, a Doctor error, or a
  `failed`, `divergent` or `unsupported` finding.

Never edit `pi-session-mcp.json` or `execution-modes.json` by hand, and never run
host Git in a writer clone.

## Result codes: stop or continue

Run every setup and Doctor command with `--json` and read the JSON, not the text.
A setup result looks like this (a dry run of a new writer):

```json
{
  "schemaVersion": 1,
  "operation": "dry-run",
  "status": "planned",
  "findings": [
    { "target": { "client": "modes", "scope": "workspace", "alias": "my-project" }, "status": "planned", "code": "mode_planned" },
    { "target": { "client": "writer", "scope": "my-project", "alias": "my-project-w1" }, "status": "planned", "code": "writer_planned" }
  ],
  "exitCode": 0
}
```

`status` is one of `ok`, `planned`, `unchanged`, `absent`, `divergent`,
`unsupported` and `failed`; `exitCode` is `0` or `1`, and `64` for invalid usage,
`130` or `143` when interrupted. The rules, in this order:

1. **Stop** when `exitCode` is not `0`, or any finding has the status `failed`,
   `divergent` or `unsupported`.
2. **Stop** on a code that this page does not list as continuing. An unknown code
   is not a success.
3. A dry run that ends `planned` is not an approval to apply. Show it to the owner.
4. Read every finding of a command, not only the first. A `--remove` returns
   `writer_removed` and, on a legacy writer, hook findings next to it. Continue
   only if all of them are in the continue table; with a failed hook finding the
   writer is already gone, so report that state and stop.

Codes that let you continue (all full descriptions are in
[Execution modes](execution-modes.md#reports-and-finding-codes)):

| Code | Where | Meaning |
| --- | --- | --- |
| `mode_planned`, `mode_unchanged`, `writer_planned`, `writer_unchanged`, `writer_limits_update_planned` | dry run | The plan, or nothing to change |
| `isolation_control_planned`, `writer_collect_planned`, `writer_reset_planned`, `writer_recreate_planned`, `writer_finish_planned` | dry run | The operation would run |
| `mode_applied`, `writer_provisioned`, `writer_accepted`, `writer_limits_updated` | apply | Mode written, writer provisioned and accepted |
| `mcp_verified` | `--verify` | The writer answers a bounded MCP check |
| `isolation_control_passed` | control apply | The host control detected the expected escapes |
| `writer_collected`, `nothing_to_collect` | collect | The owner reviews the refs; nothing is lost yet |
| `writer_reset`, `writer_recreated` | reset, recreate, finish | The clone is back at the base; finish ends with one of these |
| `writer_removed` | `--remove` | The writer's state is deleted; provisioning its replacement comes next, after the owner's approval of that step |
| `hook_removed`, `hook_absent`, `hook_kept_shared` | `--remove` | Findings about a wake hook entry that can accompany `writer_removed` on a legacy writer: the entry went (`hook_removed`), was already gone (`hook_absent`), or stays because another registration still needs it (`hook_kept_shared`, status `unchanged`) |
| `controllers_restart_required` | apply | Not a failure; an owner action to report |

Codes that mean stop, with the next step for the owner (a code not listed here
also means stop):

| Code | What to tell the owner |
| --- | --- |
| `writer_settings_changed` | A kept writer was provisioned from other settings, for example another image ID. Nothing was changed. Adopting the new settings needs the collect, remove, provision sequence for **every** writer of the repository |
| `writer_remove_planned` | The dry run would remove a surplus writer (fewer `--writers` than before); a settings mistake unless intended |
| `image_unavailable` | The ID is missing in this account's Podman storage, is not 64 lowercase hex characters, or a pinned pull failed |
| `modes_file_invalid` | The proposed mode is invalid. A tag, a short ID or any other `--image` value that is neither `node` nor a 64-character hex ID is reported with this code |
| `container_profiles_required` | No coding profile given and none recorded |
| `container_profile_unsupported`, `config_invalid`, `alias_unknown`, `usage_invalid` | Wrong profile, configuration, alias or arguments |
| `container_runtime_unavailable`, `podman_unavailable`, `platform_unsupported` | Rootless Podman is not usable, or the platform is not Linux |
| `cgroup_controller_unavailable` | A requested CPU or memory limit cannot be set on this host |
| `doctor_failed` | A blocking Doctor check failed; the finding names it. Run Doctor and report |
| `isolation_control_required`, `isolation_control_failed` | The host control has not passed. It needs the owner |
| `acceptance_harness_failed`, `acceptance_fingerprint_changed`, `writer_acceptance_failed` | The contained acceptance did not pass. The image probably lacks a required tool ([what it must contain](writer-images.md#2-what-the-image-must-contain-and-what-the-writer-provides)). Do not retry in a loop |
| `mcp_failed`, `mcp_timeout`, `mcp_unsupported` | The writer did not verify |
| `writer_busy`, `writer_fenced`, `writer_lease_unavailable` | A session or another setup run holds the writer, or a container could not be fenced. Ask whether a session is active; retry once after the owner closes it |
| `writer_uncollected`, `writer_nested_repository`, `writer_collect_incomplete`, `ref_name_refused` | The writer holds work that is not collected, or collection is incomplete. Owner decision |
| `registration_divergent`, `workspace_base_ambiguous`, `base_ref_invalid`, `writer_base_unavailable`, `remote_url_refused` | State the setup will not change on its own |
| `writer_clone_failed`, `clone_verification_failed`, `writer_state_invalid`, `writer_state_unreadable`, `writer_operation_failed`, `writer_reconcile_failed` | The writer is in a state setup cannot repair by itself |
| `hook_divergent`, `hook_install_failed`, `hook_config_unreadable`, `settings_unreadable`, `settings_unparseable`, `settings_shape_invalid`, `settings_changed`, `settings_location_invalid` | With `writer_removed`: the writer is gone, but its wake hook entry in the client settings could not be edited and is still there. The overall result is `failed` (exit `1`). Report it and let the owner decide about the entry; provisioning waits |

`pi-session-mcp-doctor --json` prints `schemaVersion`, `ok`, `packageVersion`,
`checks` (each with `id`, `severity` of `ok`, `warning` or `error`, `subject`, and
for a not-ready writer a `reason`) and `exitCode`: `0` healthy, `1` warnings, `2`
a failed check, `64` invalid usage. Stop on `2`. Warnings, for example
`workspace_mode_unset` or `writer_base_behind`, are reported, not acted on.

## Prepare and run

Every command runs with `PI_SESSION_MCP_CONFIG` set to the owner's
configuration. Commands that only read are safe to run without further approval;
the ones marked **ask** wait for the owner.

1. **Check the machine.** Read only:

   ```sh
   podman info --format '{{.Host.Security.Rootless}}'
   podman version --format '{{.Client.Version}}'
   pi-session-mcp-doctor --json
   ```

   Expect `true` and a version. Keep the Doctor result as the baseline. Stop on
   exit `2`.
2. **Read the current settings and the writer state.** Two sources, both read
   only. The repository's recorded settings are its entry (`workspaces.<alias>`)
   in `execution-modes.json`, next to the configuration: `writers`, `lifecycle`,
   `profiles`, `image`, `network`, `cache`, `tags`, `clean` and, when set, `base`,
   `cpus`, `cpuShares` and `memory`. Which slots have a writer comes from Doctor:
   one `writer_not_ready` check per slot (`<alias>-w1` up to `writers`), `ok` for
   a ready writer, and an error with `reason` `not_provisioned` for an empty slot.
   A dry run does not tell them apart:

   ```sh
   pi-session-mcp-setup --repo <alias> --json
   ```

   It reuses every recorded setting, but it reports `writer_planned` for every
   kept slot, existing or missing, and carries no settings. Use it only to see
   whether the recorded settings still plan cleanly; `container_profiles_required`
   means no container settings are recorded. If the repository already has a
   writer (a slot with a reason other than `not_provisioned`): **ask** before you
   go on, and read [Changing an image later](writer-images.md#6-changing-an-image-later)
   before you propose anything for it. Carry the recorded settings into the new
   command unchanged except for the setting that changes (profiles, `--writers`,
   `--lifecycle`, `--network`, `--base`, `--tags`, `--clean`, limits, `--cache`);
   an omitted flag falls back to its default.
3. **Get the base and choose the content. Ask.** Read the pinned base from the
   installed package, as [the guide](writer-images.md#3-how-to-build) shows. Agree
   with the owner on the toolchain, its version and the matching `--cache`. Take
   checksums from the publisher, not from the downloaded file.
4. **Build. Ask, if the owner has not already approved the build and its
   downloads.** Work in a new, empty directory outside the repository and outside
   any writer's storage. Write the Containerfile from the matching example, build
   with a new local name and version tag, and read the ID:

   ```sh
   podman build --build-arg BASE=<pinned-base> -t localhost/<name>:<version> -f <file> <context-dir>
   podman image inspect --format '{{.Id}}' localhost/<name>:<version>
   ```

   The ID must be 64 lowercase hex characters. Run the
   [checklist](writer-images.md#5-verification-checklist) against the ID and
   keep its output: user ID, tool versions and the toolchain check. If a tool is
   missing, fix the Containerfile and build again under a new tag; the earlier
   attempt's image is the owner's to remove.
5. **Dry-run the repository step, with all settings:**

   ```sh
   podman image exists <image-id> && echo present
   pi-session-mcp-setup --repo <alias> --mode container --profiles <profiles> \
     --image <image-id> --cache <cache> <the other recorded settings> --json
   ```

   Apply the stop and continue rules above. A dry run does not prove that the
   image exists: for a new writer it ends `planned` even with an ID that Podman
   does not know, so `podman image exists` (exit `0` present, `1` absent) comes
   first. Show the owner the dry-run JSON and the checklist output. **Ask** for
   approval to apply.
6. **Check the isolation control. Ask.** If the owner says it has not passed on
   this machine, dry-run it and ask for approval of the apply:

   ```sh
   pi-session-mcp-setup --isolation-control --repo <alias> --json
   pi-session-mcp-setup --isolation-control --repo <alias> --apply --json
   ```

   Expect `isolation_control_planned`, then `isolation_control_passed`.
7. **Apply, after the owner approved this exact command:**

   ```sh
   pi-session-mcp-setup --repo <alias> --mode container --profiles <profiles> \
     --image <image-id> --cache <cache> <the other recorded settings> --apply --json
   ```

   Expect `mode_applied`, then `writer_provisioned` and `writer_accepted` for each
   writer, and `controllers_restart_required`. Stop on any other code. Acceptance
   runs the harness in the new image, which setup allows up to five minutes per
   writer.
8. **Verify each writer, then Doctor:**

   ```sh
   pi-session-mcp-setup --writer <alias>-w<N> --verify --json
   pi-session-mcp-doctor --json
   ```

   Expect `mcp_verified` for every writer and no Doctor error. Compare the
   warnings with the baseline and report new ones.

To replace the image of existing writers, do not improvise. The image is a
setting of the whole repository: one apply with a new `--image` is refused with
`writer_settings_changed` while any kept writer still has the old one, so a single
writer cannot be switched alone and removing one writer does not help. Take the
sequence in [Changing an image later](writer-images.md#6-changing-an-image-later)
and propose it to the owner for **every** writer of the repository that has one:
collect each, let the owner review the refs and decide what to copy out of
ignored paths, remove each, and only then run the one provisioning command. Run
each `--collect --apply`, each `--remove` and the provisioning only after the owner
approved that step; treat `writer_removed` (with its hook findings, see above) as
success of a removal. Keep the old image until the owner says otherwise.

## Report

Report these, and nothing from the owner's environment:

- The image ID, the tag you gave it and the build date.
- The base reference, and the tool versions from the checklist (Node.js, Git,
  bash, ssh, find, coreutils and the added toolchain).
- The settings you passed (profiles, `--image`, `--cache`, `--writers`,
  `--network`, `--base`, `--tags`, `--clean`, limits).
- The dry-run JSON, the apply JSON and the verify JSON for each writer.
- The Doctor result before and after: `exitCode`, and every check that is not
  `ok` with its `id`, `subject` and `reason`.
- What was not done and what the owner still has to do, such as reconnecting
  controllers after `controllers_restart_required`, copying out ignored files,
  or removing an old image.

Do not claim a build, verification or mutation that did not happen. Do not
include credentials, proxy URLs, complete prompts, environment dumps or local
paths in the report.

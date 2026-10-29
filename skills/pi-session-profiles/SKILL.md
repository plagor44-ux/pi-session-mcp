---
name: pi-session-profiles
description: Use when you, as the controlling agent, create, change, tune, rename or retire an execution profile, or change which profiles a container repository selects. Covers inventory, candidate validation, a bounded provider probe, safe writer replacement and reporting. Do not use inside a Pi worker session.
---

# Managing execution profiles

Carry out the request on this machine without asking for approval at each step.
A skill grants no rights. Use the documented configuration and writer rules,
not guessed providers, models or workarounds.

Find the installed package root as described in
[docs/skills.md](../../docs/skills.md). Read the relevant package-relative
documentation before changing anything:
[docs/installation.md](../../docs/installation.md),
[docs/skills.md](../../docs/skills.md),
[docs/execution-modes.md](../../docs/execution-modes.md) and
[docs/pi-extensions-design.md](../../docs/pi-extensions-design.md). Resolve these names from the package root, not from a client-installed skill
copy. They define profile fields, skill selection, extensions, sandbox shell
and container acceptance.

## 1. Find the configuration

Use `PI_SESSION_MCP_CONFIG` from the environment without printing its value.
If unset, read that variable from the client's own registration of the
`pi-session-mcp` server. If neither supplies it, ask the operator. Never guess
the configuration path.

## 2. Inventory

Run `pi-session-mcp-doctor --json` and
`pi-session-mcp-setup --list-models`. Read the configuration and the adjacent
`execution-modes.json`. Call `pi_capabilities_get` if the MCP server is
connected. Report unrelated Doctor errors; do not fix them as part of this task.

Never read Pi credential or model files. Never print environment values.
The offline catalog reports authentication presence, not credentials, and does
not list providers registered only by extensions.

## 3. Work out the change

Translate the request into concrete profile entries and the intended profile
selection of affected container repositories. Pick providers and models only
from `--list-models` entries with configured authentication. Prefer the shape
of an existing working profile of the same kind. Ask only if the request leaves
an outcome-changing choice that the catalog and existing profiles do not settle;
otherwise decide and state the decision in the report.

Before deleting a profile, check every container repository's selection. If any
still selects it, stop and ask. Deleting an unselected profile needs no stop.

## 4. Build and check a candidate

Write a distinctly named candidate beside the live configuration, in the same
directory and with the same file mode. Edit only the candidate. This preserves
relative-path resolution, the modes file and the skill override directory.
Point `PI_SESSION_MCP_CONFIG` at the candidate without echoing it, then run
`pi-session-mcp-doctor --json` and
`pi-session-mcp-setup --probe-profile <aliases>` (dry run), naming the changed
or new profiles. Fix and repeat. For affected container selections,
`container_profile_refused` must be absent.

Never hand-edit `execution-modes.json`; use the documented mode request.

## 5. Probe the candidate

With the configuration variable still pointing at the candidate, run
`pi-session-mcp-setup --probe-profile <aliases> --apply`.
Each changed or new profile gets at most one provider turn without asking.
Failures with `providerTurn: false` cost nothing: fix them and re-probe.
Count `providerTurn: true` even when the probe fails. Stop and ask before a
second provider turn for the same profile, or any check costing money beyond
one PONG probe per changed profile. Never run a quality evaluation yourself.
Only `probe_passed` proves a profile works; never print the reply text.

The probe proves the profile on the host, not its acceptance by a container
writer. Doctor's container checks and provisioning still have to pass.

## 6. Prepare writers

For each container repository whose selected profiles or settings change,
determine every writer's state using the documented read-only checks:
Doctor's `writer_dirty` and `writer_uncollected_bundle`, and
`pi-session-mcp-setup --writer <name> --collect` (dry run).
If a writer to remove or re-provision has uncollected work or a dirty clone,
stop and ask before anything goes live. Never run `--collect --apply` in this
workflow, and never discard work to get past a refusal.

Stop and report `writer_busy`, `podman_unavailable`, `registration_divergent`
or any other refused writer step; do not work around it. For writers that
hold no work, use `pi-session-mcp-setup --writer <name> --remove` before the
live write. Do not run host Git inside a writer clone.

## 7. Go live

Back up the live configuration as a timestamped copy beside it, with the same
file mode. Replace the live file atomically by renaming the candidate onto it.
Point the configuration variable back at the live file and run
`pi-session-mcp-doctor --json`.

## 8. Provision

For each affected container repository, repeat the mode request with the full
intended settings, not just changed fields:
`pi-session-mcp-setup --repo <alias> --mode container --profiles <aliases> --apply`.
This writes `execution-modes.json` and provisions writers. Preserve all intended
settings from the inventory as `docs/execution-modes.md` requires. Then run
`pi-session-mcp-setup --writer <name> --verify` for each writer and the documented
client-target verification for the host registration. Stop and report any
refused writer step instead of bypassing it.

## 9. Report

Report changed profile aliases and field names, Doctor results, probe results,
usage or `unknown`, the number of provider turns, writer actions and the
backup's file name relative to the configuration directory. Include no secrets,
absolute paths, environment values or complete prompts.

Running controllers see the changes only after their MCP server restarts or an
MCP reconnect starts a new server process. If the operator's own instructions
require further steps beyond this machine, follow those instructions; do not
invent multi-machine actions.

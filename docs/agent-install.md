# Agent guide to guided installation

This guide is for an agent acting with the owner's authorization. The owner
makes the decisions below; the agent must not infer approval from silence.
Never ask for, handle or store a provider credential. The owner signs in to a
provider account themselves, on their own terminal; the command refuses to run
without one:

```sh
pi-session-mcp-provider auth login <provider>
```

It runs Pi's own sign-in dialogue; `--no-browser` suits a machine without a
browser. Alternatively, the owner may run
`pi-session-mcp-provider auth set <provider>` on their terminal. Agents must
never enter or handle keys, including through standard input, and never take
part in a sign-in, also not by running the command on a pseudo-terminal. See [provider credentials](installation.md#provider-credentials-and-custom-providers).

## Stop and ask the owner

- `config_not_regular`: no live file changed; ask the owner to supply regular configuration files.
- `config_changed_during_run`: setup changed no live file; ask the owner to review the concurrent changes.
- `guided_in_progress`: no live file changed; another guided run holds the configuration, or two runs started together and both backed off. Ask the owner whether another run is active before retrying once.
- `model_unknown`: no live file changed; ask the owner to choose a model from the provider's catalog.
- `container_profiles_invalid`: no live file changed; ask the owner to select non-empty coding profiles.
- `input_closed`: no live file changed; ask the owner to restart the interview with input available.
- `interview_declined`: no live file changed; ask the owner to review the family warning before retrying.
- `no_read_only_profile`: no live file changed; ask the owner to select a read-only profile.

- **Missing provider login:** stop on `provider_login_required`; ask the owner
  to run `pi-session-mcp-provider auth login <provider>` or
  `pi-session-mcp-provider auth set <provider>` on their own terminal, then
  re-check. Do not handle credentials.
- **Existing configuration:** show the intended merge and ask before approving
  changes. Set `allowConfigChange` only with that approval.
- **Divergent registration:** stop and ask; never replace it automatically.
  An `upgrade_required` finding also stops the run; follow the owner-approved
  [upgrade procedure](installation.md#upgrade), not the installer.
- **Probe spending:** ask before approving provider turns. Apply probes each new
  profile once with a fixed prompt; a dry run does not spend.
- **Empty container profiles:** on `container_profiles_empty`, no live file
  changed; ask the owner which profiles the container workspace should use.
- **No coding profile left:** on `coding_profiles_dropped`, no live file
  changed; the probes dropped every coding profile the owner accepted. Show
  each `profile_dropped` finding with its `cause` and ask the owner which
  profiles to use instead.
- **Setup not found:** on `setup_not_found`, ask the owner to add the npm global
  bin directory to `PATH` and rerun the script.
- **Host writes:** explain that host mode permits writes outside an OS sandbox;
  only the owner may explicitly approve `acceptHostWrites`.

## Prepare and run

Check prerequisites and the offline catalog with `pi-session-mcp-setup
--list-models`. After the owner chooses providers, profiles, workspaces, history,
routing and clients, create an answers JSON file outside the repository with
restricted permissions. For example (replace placeholders with real catalog
values and an existing repository):

```json
{
  "schemaVersion": 1,
  "approveProbes": false,
  "allowConfigChange": false,
  "profiles": [
    { "alias": "review-medium", "provider": "your-provider", "model": "your-model", "role": "review", "thinkingLevel": "high", "tier": "medium", "family": "your-family" }
  ],
  "defaultProfile": "review-medium",
  "workspaces": [{ "alias": "project", "path": "/path/to/repo", "mode": "read-only" }],
  "history": { "enabled": false },
  "routing": { "mode": "manual" },
  "clients": { "claudeCode": true, "codex": false }
}
```

### Answers format

The document is one JSON object. The format is strict: every field below is
required unless marked optional, and no other key is accepted anywhere.

| Field | Type and allowed values |
| --- | --- |
| `schemaVersion` | The number `1` |
| `approveProbes` | Boolean. The owner's approval to spend one provider turn on each new profile (apply only) |
| `allowConfigChange` | Boolean. The owner's approval to change an existing configuration or routing file |
| `profiles` | Array of profile objects (below); may be empty when only existing profiles are used |
| `defaultProfile` | Alias of a profile in `profiles` or in the existing configuration |
| `workspaces` | Array of workspace objects (below) |
| `history` | `{ "enabled": boolean }`. History stores redacted session content locally; redaction is best effort |
| `routing` | `{ "mode": "off" \| "manual" \| "auto" }`. `auto` requires `history.enabled` |
| `clients` | `{ "claudeCode": boolean, "codex": boolean }`: which clients to register |

A profile object has these fields, all required:

| Field | Type and allowed values |
| --- | --- |
| `alias` | `^[a-z][a-z0-9_-]{0,63}$`, unique in `profiles` |
| `provider`, `model` | Non-empty strings (at most 256 characters) from the offline catalog (`--list-models`) |
| `role` | `code`, `review` or `explore` |
| `thinkingLevel` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. Not every model offers every level; a level its model lacks fails the probe with the cause `thinking_level_unavailable` and the profile is dropped or, as the default profile, stops the run with `default_profile_failed` |
| `tier` | `low`, `medium`, `hightech`, `ultra` or `null` |
| `family` | `^[a-z][a-z0-9-]{0,31}$` or `null`. Required when `tier` is not `null` |

A workspace object:

| Field | Type and allowed values |
| --- | --- |
| `alias` | `^[a-z][a-z0-9_-]{0,63}$`, unique in `workspaces` |
| `path` | Absolute path of the repository |
| `mode` | `read-only`, `container` or `host`. `host` writes outside an OS sandbox |
| `acceptHostWrites` | Optional boolean. `host` requires `true` with the owner's explicit approval |
| `container` | Optional object, only with `mode: "container"`. All keys optional: `writers` (integer 1 to 16), `lifecycle` (`persistent` or `ephemeral`), `profiles` (array of aliases), `image`, `network` (`pasta` or `none`), `cache` (`none`, `go`, `uv` or `npm`), `tags` (`none` or `reachable`), `clean` (`untracked` or `all`), `base`, `cpus`, `cpuShares`, `memory`. The settings and their limits are those of [execution modes](execution-modes.md); the mode step checks them and reports `mode_failed` |

Rules beyond the field types: the default profile must not have `role: code`
(it must be read-only); a container workspace needs a non-empty `container.profiles`
list of coding profiles (existing or in `profiles`); aliases are unique within
`profiles` and within `workspaces`. Rule violations are reported as described
under [Input errors](#input-errors).

### Input errors

A problem with the answers file is an input error: the exit status is `64`, as
for `usage_invalid`, and no file is changed.

- `answers_unreadable`: the file is missing, is not a regular file or cannot be
  read. Fix the path or its permissions; the report names no path.
- `answers_invalid`: the first finding is `guided/plan/installation`. It is
  followed by one finding per violated rule (at most 20), with target
  `guided/answers/<field path>` and the rule as `code`. The field path is built
  from field names and array indices only (`profiles.0.family`); `document`
  means the whole file. No value and no unknown key name from the file appears
  in the report.

```json
{ "findings": [
  { "target": { "client": "guided", "scope": "plan", "alias": "installation" }, "status": "failed", "code": "answers_invalid" },
  { "target": { "client": "guided", "scope": "answers", "alias": "profiles.0.family" }, "status": "failed", "code": "required_with_tier" }
] }
```

| Rule code | Meaning and fix |
| --- | --- |
| `not_json` | The file is not valid JSON (alias `document`) |
| `missing_field` | A required field is absent: add it |
| `wrong_type` | The field has the wrong JSON type (for example a string instead of a boolean), or the document is not an object |
| `invalid_value` | The value is not one of the allowed values (`schemaVersion`, an enum) |
| `invalid_format` | A string does not match its pattern (an alias or a family label) |
| `too_small`, `too_large` | A string is empty, or a number is outside its range (`writers`) |
| `unknown_field` | An unknown key at the field path (or at `document`); remove it |
| `not_absolute_path` | A workspace `path` is not absolute |
| `required_with_tier` | A profile with a `tier` needs a `family` |
| `default_profile_is_code` | The default profile must not have `role: code` |
| `duplicate_profile_alias`, `duplicate_workspace_alias` | An alias appears twice |

The same rules apply to the answers that the interview builds.

## Result codes

Every guided report is a list of findings; `--json` prints them as
`findings[].code`. Exit status: `0` for a successful run or a planned dry run,
`1` for a refusal or failure, `64` for an input error, `130` or `143` after an
interrupt. For each code, the action is one of: **fix** (the agent can correct
it and rerun), **ask** (the owner must decide; see
[Stop and ask the owner](#stop-and-ask-the-owner)) or **stop** (report and end
the run).

| Code | Meaning | Action |
| --- | --- | --- |
| `answers_unreadable`, `answers_invalid` | Input errors of the answers file ([Input errors](#input-errors)) | fix |
| `usage_invalid` | Wrong arguments, or no terminal and no `--answers` | fix |
| `config_not_regular` | The configuration or routing file is not a regular file; nothing changed | ask |
| `provider_login_required` | A provider has no login; the target alias is the provider | ask: the owner signs in |
| `model_unknown` | A new profile names a model that the provider's catalog lacks | ask |
| `config_change_not_allowed` | The existing configuration or routing file would change and `allowConfigChange` is `false`. | ask: show the owner what would change |
| `probes_not_approved` | An apply would probe new profiles and `approveProbes` is `false` | ask: the owner approves provider turns |
| `host_writes_not_accepted` | A `host` workspace without `acceptHostWrites: true` | ask |
| `container_profiles_invalid` | A container workspace names no profiles, or a profile that is not a coding profile | ask |
| `container_profiles_empty` | Failed probes removed every profile of a container workspace | ask |
| `coding_profiles_dropped` | Failed probes removed every coding profile the owner accepted | ask |
| `default_profile_unknown` | `defaultProfile` is in neither `profiles` nor the existing configuration | fix |
| `default_profile_conflict` | The existing configuration has another default profile | ask |
| `default_profile_failed` | The default profile's probe failed; the `cause` names why | ask |
| `profile_alias_conflict` | A profile alias exists with different content | ask |
| `workspace_alias_conflict` | A workspace alias exists with another path | ask |
| `routing_requires_history` | Routing `auto` without `history.enabled` | ask: history stores session content |
| `routing_profile_conflict` | A routing assignment conflicts with the existing routing file | ask |
| `upgrade_required` | A registration is bound to another release | ask: follow the [upgrade procedure](installation.md#upgrade) |
| `registration_divergent` | A client registration is foreign or differs; it is never replaced | ask |
| `registration_preflight_failed` | The registration dry run failed for another reason | stop |
| `config_changed_during_run` | The configuration changed while guided setup ran; nothing was written | ask |
| `guided_in_progress` | Another guided run holds the configuration | ask whether one is active; retry once |
| `doctor_failed` | Doctor failed on the candidate or the installed configuration (target `candidate` or `verification`) | stop |
| `probe_failed` | The profile probe was refused as a whole | stop |
| `mode_failed` | A workspace mode step failed; its findings follow | stop |
| `registration_failed` | Registering a client failed; its findings follow | stop |
| `verification_failed` | Client verification failed after the install | stop |
| `input_closed`, `interview_declined`, `no_read_only_profile` | Interview ended: no input, the family warning declined, or no read-only profile | ask |
| `operation_interrupted` | SIGINT or SIGTERM | stop |
| `operation_failed` | Unclassified failure | stop |
| `setup_not_found` | Reported by `install.sh`: `pi-session-mcp-setup` is not on `PATH` | ask |

Non-failing findings: `configuration_planned`, `configuration_unchanged` and
`configuration_installed` (the configuration step; `unchanged` means nothing
to write), `probe_planned` and `probe_passed` (new profiles), `profile_dropped`
(a failed probe removed a profile that is not the default; the `cause` names
the probe outcome), `mode_planned` and `registration_planned` (dry run), and
the prerequisite notes `podman_unavailable` and `bubblewrap_unavailable`: they
say that container mode or the sandboxed shell is unavailable on this machine,
and do not stop the run. Findings of the mode, registration and verification
steps carry the codes of those steps ([execution modes](execution-modes.md),
[client setup](client-setup.md)) under the targets `modes`, `registrations` and
`verification`.

```sh
pi-session-mcp-setup --guided --answers /path/to/answers.json --json
pi-session-mcp-setup --guided --apply --answers /path/to/answers.json --json
```

The first command is a dry run; inspect findings and obtain approvals before
changing the file and applying. `--config /path/to/config.json` may override the
guided configuration location. Without a terminal, an answers file is required.
Setup checks authentication, validates a candidate, probes approved new
profiles, merges configuration, provisions modes, registers clients and verifies.
It preserves fields it does not own, and never replaces divergent registrations.

Report the dry-run and apply status, sanitized findings, dropped profiles with
their `cause`, verification outcome and any remaining owner actions or
reconnect required.
Do not claim verification or a mutation that did not happen, and do not include
credentials, complete prompts or local paths in the report.

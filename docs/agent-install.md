# Agent guide to guided installation

This guide is for an agent acting with the owner's authorization. The owner
makes the decisions below; the agent must not infer approval from silence.
Never ask for, handle or store a provider credential. The owner performs any
login themselves, using the package's Pi executable:

```sh
"$(npm root -g)/pi-session-mcp/node_modules/.bin/pi"
```

Alternatively, the owner may run `pi-session-mcp-provider auth set <provider>`
on their terminal. Agents must never enter or handle keys, including through
standard input. See [provider credentials](installation.md#provider-credentials-and-custom-providers).

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
  to log in using the command above, then re-check. Do not handle credentials.
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

The format is strict: no extra keys. Roles are `code`, `review`, `explore`;
levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Not every
model offers every level; a profile with a level its model lacks fails its probe
with the cause `thinking_level_unavailable` and is dropped, or, as the default
profile, stops the run with `default_profile_failed`. Tier is
`low`, `medium`, `hightech`, `ultra` or null; a tiered profile needs a
lowercase family label. The default must be read-only, not `code`. Workspace
modes are `read-only`, `container`, `host`; optional `container` settings are
those in [execution modes](execution-modes.md), and host mode requires
`acceptHostWrites: true` with owner approval. `auto` routing requires history,
which stores redacted session content locally; redaction is best effort.

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

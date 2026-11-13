# Session history

An opt-in, local record of every session ([ADR 0019](adr/0019-opt-in-session-history.md)). With history on, the server stores each session's metadata, turns and the Pi session entries in one SQLite file, `~/.local/state/pi-session-mcp/history/history.sqlite`. Content is redacted on the host before it is stored, also for writer sessions, and that includes the keys of stored objects. Secrets that match no rule can still be stored; see the [threat model](threat-model.md). History never changes a session: a failure becomes a gap in the record. The record cannot restore or resume a session.

History is off by default. Tier routing in `auto` mode requires it ([ADR 0020](adr/0020-tier-routing.md)).

## Configure

```json
"history": {
  "enabled": true,
  "redactPaths": ["config/prod/*.yaml"],
  "workspaces": { "my-infra": { "redactPaths": ["clusters/**/secret*.yaml"] } }
}
```

`redactPaths` adds globs to the built-in path rule (`.env`, `.env.*`, `*.sops.*`, `secrets/**`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `kubeconfig*`). For files that match, `read`, `grep`, `edit` and `write` content is never stored. A controller can pass a short `task` label to `pi_session_start`, such as `#215`, to find sessions later.

The server reads the configuration once at startup; see [Configure](installation.md#2-configure) for the file location and the other fields.

## Read and maintain the history

Read the history with `pi-session-mcp-history`:

```sh
pi-session-mcp-history list --task '#215'
pi-session-mcp-history show <session> [--full]
pi-session-mcp-history verdict <session> accepted --reason "Tests and review passed."
pi-session-mcp-history query "SELECT workspace, count(*) FROM sessions GROUP BY workspace"
pi-session-mcp-history export <session> --format jsonl --out session.jsonl
pi --export session.jsonl session.html
```

`export` writes Pi's session JSONL; `pi --export` renders it as HTML. `prune --older-than 90d --apply` deletes old sessions, and `reconcile` marks the sessions of crashed servers `incomplete`. A session counts as old when its recorded close, or the recorded end of the crashed instance that left it open, is older than the cutoff, so reconciled sessions are pruned too. An open session whose server instance has no recorded end, such as one of a running server, is never pruned.

After an upgrade that changes the history schema, the first writable open migrates the file; see [Upgrade](installation.md#upgrade).

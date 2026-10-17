# Existing client reconnect after the Node 24 migration

Date: 2026-10-17. The operator approved continuing with the remaining existing
client reconnects after the [Node 24 migration](../node24-followup-2026-10-17/README.md).

**Both remaining Claude Code connections now run the installed Pi-session MCP
server under Node 24.22.0.** The final same-user process scan found two matching
server processes under that runtime and none under Node 22. The previously
observed old Codex server had already ended before this follow-up; it was not
restarted or claimed as reconnected.

Each Claude terminal had an empty prompt and no interrupt indicator before
control. Its built-in `/mcp reconnect pi-session-mcp` command reported success
and started a replacement server using the migrated registration. Both previous
Node-22 server processes initially remained alive. Only after confirming the
replacement under the same client parent, the exact installed entry, user and
process identity, the old process received `SIGTERM` through its bounded shutdown
handler. Both exited; no force kill was needed.
Claude documents reconnecting local stdio servers through the client; they do not
[automatically reconnect](https://code.claude.com/docs/en/mcp#automatic-reconnection).

After that cleanup, both clients' `/mcp` panels showed `pi-session-mcp` connected.
The panels were closed again. No client conversation, prompt draft or terminal
transcript was copied into this dossier. Process identities and transition
details remain in the private owned state scope named in the
[sanitized reconnect record](reconnect.json).

The final [registration verification](registration-verification.json) repeats
offline Doctor, both clients' exact registration/ownership verification and a
bounded fresh initialize / `tools/list` / `pi_capabilities_get` handshake. It
starts no Pi session or model request. These checks supplement the observed
existing-client reconnects; a fresh verification process alone is not counted as
an existing-client reconnect.

No model prompt, candidate extension tool, new evaluation session or additional
paid quality run was requested. No registration, profile, auth store or runtime
was edited in this follow-up. Direct client registrations continue to inherit
their original child PATH; this result binds the server executable to Node 24.

The [closure checks](checks.json) preserve the earlier evidence indexes and
source binding. The [integrity index](integrity.json) covers this dossier.

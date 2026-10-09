# Architecture

## Validated dependency baseline (2026-10-09)

- [`@earendil-works/pi-coding-agent` 1.1.0](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) supplies the documented root exports used by this server, including `ModelRuntime` and `createAgentSession`. Since 0.99 the prompt preflight hook reports a dispatch disposition (`started`, `queued`, `handled`) and is not called on rejection; only `started` admits a public turn (`admitsTurn` in `src/sdk-pi-adapter.ts`). Model-visible tools are declared on transcript system messages rather than in the provider context. `test/sdk-contract.test.ts` pins both assumptions provider-free.
- [`@modelcontextprotocol/server` 2.3.1](https://www.npmjs.com/package/@modelcontextprotocol/server) supplies `McpServer`, structured tool output, and the stdio entry point.
- [Zod 4.5.4](https://zod.dev/) validates strict configuration, tool input, and structured output.

All are exact direct pins. No API is taken from an unexported package path. A nightly canary checks the unchanged sources against the newest published Pi SDK without changing the pin (see the README section "Checks").

```text
validated config --> capability projection --> McpServer discovery tool
        |
        +---------> SessionRegistry --> PiSessionAdapter
                       |                    |
                 in-memory state       SDK Pi adapter
                 session + turn        ModelRuntime + AgentSession
                 read models
```

There are three separate local CLI paths: the MCP stdio server (`main.ts`),
the offline Doctor, and the client setup orchestrator. Configuration is parsed
before serving; relative workspace paths resolve from the configuration file,
and callers cannot provide a path. `executionProfiles` is a frozen alias map,
with exactly one explicit `read-only` default. A profile couples a permission
profile and exact Pi provider/model/thinking selection, so clients cannot
combine them independently.

The Doctor is deliberately independent of MCP, Pi, providers, credentials, and
the network. It reports sanitized human or JSON output with exit codes 0
(healthy), 1 (warning), 2 (failed check), and 64 (usage error). Setup defaults
to dry-run; apply, verify, rollback, and remove are explicit operations. It
accepts only configured client targets (`codex:user` or
`claude-code:user|project|local`) for alias `pi-session-mcp`, derives absolute
paths internally from `process.execPath`, `dist/`, and `PI_SESSION_MCP_CONFIG`, and
fails closed for Codex or Claude Code output that does not match the expected
contract, without pinning client versions. Divergent registrations
are reported and are not automatically replaced.

Setup records durable pending/owned ownership state containing no paths or
secrets. Verify first runs Doctor and checks registration equality, then uses a
bounded direct MCP handshake, `tools/list`, and
`pi_capabilities_get({})`; it never starts a session or invokes a
provider. The direct verifier expects all eight tools and cleans up its child.
Ownership binds package manifests and built runtime bytes; pending state is
reconciled only when the registration still matches that binding. A changed
release fails closed and cannot silently inherit or replace another release's
registration.

`pi_capabilities_get` projects the validated workspace and execution-profile maps plus the immutable configuration metadata captured while loading the file. It returns aliases plus the configured permission/provider/model/thinking intent, sorted by alias, and `configuration: { fingerprint, reloadPolicy: "restart-required" }`. The fingerprint is SHA-256 over the exact loaded file bytes, including formatting; it is not a current-file freshness check. The projection makes no provider, authentication, filesystem, network, server-reachability, or catalog-state probe, so it cannot assert availability.

## Deterministic Pi selection

The SDK adapter owns one durable `ModelRuntime`. For the configured profile, it uses that same runtime to call `getProvider(providerId)`, `getModel(providerId, modelId)`, `checkAuth()`, `getAuth(model)`, and `getAvailable(providerId)`. It rejects an absent provider or model, missing or unavailable local authentication, and a model not present in the local available-model set before constructing a session. Authentication uses only Pi's existing local mechanism; auth objects are presence-checked and never retained, serialized, or logged.

Only then does the adapter call `createAgentSession` with the same runtime and explicit `model`, `thinkingLevel`, and permission-derived `tools`. It never calls `resolveCliModel` or a fuzzy resolver, and does not depend on SDK settings or first-available fallback behavior. After construction it verifies `session.model.provider`, `session.model.id`, and effective `session.thinkingLevel`. A clamped thinking level or any selection mismatch fails closed. Any post-creation failure disposes the SDK session before a handle can enter the registry.

These postchecks establish the selected provider, model, and effective Pi session
thinking level. They do not inspect provider-side reasoning or enforce a
reasoning-token budget; `off` does not universally prevent reasoning tokens.
The adapter includes text blocks in `assistantText` but does not project thinking
content or provider-side reasoning counts. A postcheck mismatch is a
controller-contract failure, while reasoning usage must be assessed as
provider/engine behavior rather than inferred from the effective level.

The registry owns public UUIDs, lifecycle state, the turn read model, background turn promises, abort, and disposal. A per-session operation queue serializes prompt admission and close; concurrent abort callers share one bounded abort attempt for the active turn. It registers a session only after adapter creation and postconditions complete. Once shutdown begins, starts fail with `server_stopping`; a handle created by an already-running start is disposed instead of admitted. The SDK session ID is never exposed.

## Lifecycle and public data

`pi_session_prompt` creates a provisional turn identity, invokes Pi preflight, and only after accepted preflight publishes `{session, turn}`; rejected preflight leaves no orphan turn. Completion returns to `idle`; failure is generic. Each active session retains at most 20 turns. A turn is `running`, `completed`, `failed`, or `aborted`; its public view contains IDs, timestamps, and terminal `completedAt`. Completed text is normalized and capped at 64 KiB UTF-8 with Unicode-safe truncation. It can contain model-visible workspace data and remains potentially sensitive.

Session metadata contains only whitelisted values: public session ID, workspace alias, execution-profile alias, derived permission `profile`, post-verified provider/model/effective thinking level, lifecycle state, and timestamps. Capability metadata uses a separate whitelist: server name/version, loaded configuration fingerprint/reload policy, workspace aliases, and configured profile fields. Neither view contains workspace paths, full model objects, SDK session IDs, auth sources, credential paths, headers, base URLs, prompts, transcripts, or raw provider errors.

Profile-specific authentication/catalog operations and session creation have fixed server-side deadlines of 5,000 ms and 10,000 ms. Prompt preflight, abort, close cleanup, registry shutdown, and process shutdown have fixed server-side deadlines of 5,000 ms, 5,000 ms, 5,000 ms, 12,000 ms, and 15,000 ms respectively. A preflight timeout returns `prompt_timeout` without publishing a turn. The unpublished operation remains quarantined until its prompt and abort cannot race with later work; late settlement can release that quarantine but never publish the turn. An abort timeout returns `abort_timeout` without falsely marking the turn aborted; a later normal outcome or successful SDK abort may still terminalize it exactly once. Close marks the session terminal, removes its public registry entry deterministically, and performs best-effort abort/dispose. Repeated close calls return a cached closed view while its tombstone is retained. Each SDK handle is disposed at most once. A late promise cannot revive a removed session or mutate a removed turn.

The public SDK does not provide a hard-kill guarantee for a blocked provider/network operation, so a timeout must not be described as graceful provider cancellation. `SIGINT`, `SIGTERM`, and stdin EOF from the MCP client start the same process shutdown. The first trigger wins and sets the exit status (130, 143, or 0). Stdin EOF or the first `SIGINT` or `SIGTERM` during a running shutdown neither restarts it nor changes that status; a signal that arrives a second time keeps Node's default effect and ends the process immediately. Shutdown closes registry entries and the MCP transport best-effort, then explicitly exits the Pi Session MCP process no later than its 15,000 ms deadline. That terminal process policy may cut off still-running external work and does not prove the provider stopped cleanly. Closed tombstones are FIFO-retained up to 100 entries and contain no turn data. All sessions, turns, tombstones, and loaded configuration snapshots disappear on process exit; there is no persistence or reconnect/resume.

Public errors are stable and sanitized. They omit caller values, complete prompts, paths, provider/SDK details, authentication data, credential locations, and SDK identifiers.

## Scope

The product boundary is local stdio and in-memory-only operation for one trusted local MCP peer. A controller keeps one immutable configuration/profile snapshot for its lifetime; file edits require a genuinely new controller process and do not hot-reload, mark stale, or mutate running sessions. Each new session performs external catalog discovery within the loaded grants, so catalog changes do not require a controller restart, but a running session's active tools remain fixed. Restarting the controller loses all sessions; reconnecting a client reloads configuration only when it actually starts a new controller process. Capability discovery reports captured metadata only and does not prove current-file freshness, server reachability, provider availability, or catalog state. It excludes HTTP, a web UI, persistence/resume, remote access, multi-user behavior, transcript export, streaming, live provider/model discovery, availability probes during capability discovery, and provider credential management. A coding execution profile is an application-level tool selection, not an OS sandbox.

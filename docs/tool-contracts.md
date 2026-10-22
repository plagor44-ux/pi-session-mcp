# Tool contracts

Every response includes text JSON for broad client compatibility and the same object as `structuredContent`. Success is `{ok:true,...}`. Domain failures are `{ok:false,error:{code,message}}` with `isError: true`. Complete prompts, credentials, and raw provider errors are never returned.

| Tool | Input | Effect | readOnlyHint |
| --- | --- | --- | --- |
| `pi_capabilities_get` | strict empty object | Lists configured aliases and execution intent without runtime probes | true |
| `pi_session_start` | `workspace`, optional `executionProfile` | Creates a verified in-memory Pi session | false |
| `pi_session_list` | none | Lists safe session metadata | true |
| `pi_session_get` | `sessionId` | Reads safe session metadata | true |
| `pi_session_prompt` | `sessionId`, `prompt` | After accepted preflight, publishes `{session,turn}` and starts a background turn | false |
| `pi_turn_get` | `sessionId`, `turnId` | Reads one normalized turn view | true |
| `pi_session_abort` | `sessionId` | Aborts running; idle is a no-op | false |
| `pi_session_close` | `sessionId` | Idempotently aborts, disposes once, removes | false |

There are exactly eight tools. No `pi_turn_wait` tool or live provider/model inventory exists.

## Versions

Three different versions exist. They identify different things and change for
different reasons; none of them stands in for another.

| Version | What it identifies | Where it appears | When it changes |
| --- | --- | --- | --- |
| Package version | One build and release of Pi Session MCP: the npm package, the GitHub release and the server. | `package.json`; `server.version` of `pi_capabilities_get`; `packageVersion` of the Doctor result | With every release. A release that keeps the MCP tool contract is a patch release. |
| MCP tool contract | The eight tools of this document: their inputs, response fields, states and error codes. | Only this document. It carries no version number of its own and no tool, field or code names one. | A change to a tool, field, state or error code needs a new minor release and its own decision, so within a `0.x` minor line the contract is stable. A client identifies its compatibility by the package version, as `pi_capabilities_get` reports it, and by this document at that release. |
| Setup report `schemaVersion` | The shape of the result of `pi-session-mcp-setup`, currently `1`; the human output derives from the same result. | The `schemaVersion` field of the `--json` report | Independent of the package version and no part of the MCP tool contract; a release does not change it by itself. It has been `1` since the first public release, and no document defines a further rule for changing it. |

The setup report is not an MCP response. The Doctor result has its own
`schemaVersion` (currently `1`), and the skill customization bases file has a
`schemaVersion` (currently `2`) that is separate again; neither is the setup
report's. Release rules are in [Releasing](releasing.md#versioning); acceptance
records name the package version and the build they ran on, see
[Acceptance](acceptance.md#evidence-rules).

## Capability discovery

`pi_capabilities_get` accepts only `{}`. Unknown fields fail MCP schema validation. Success has this strict shape:

```json
{
  "ok": true,
  "server": { "name": "pi-session-mcp", "version": "0.11.1" },
  "configuration": {
    "fingerprint": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "reloadPolicy": "restart-required"
  },
  "events": { "delivery": "off" },
  "workspaces": [{ "alias": "my-project", "mode": "unset" }],
  "executionProfiles": [{
    "alias": "safe-readonly",
    "default": true,
    "permissionProfile": "read-only",
    "provider": "configured-provider",
    "model": "configured-model",
    "thinkingLevel": "medium",
    "extensions": [],
    "grantedExtensionTools": [],
    "skills": []
  }]
}
```

`events.delivery` is `spool` when the loaded configuration enables turn-event delivery (`"events": { "delivery": "spool" }`) and `off` otherwise. It reports configured intent, except that it is `off` when the server found no spool location at startup (no `PI_SESSION_MCP_EVENTS_DIR` and no absolute `XDG_RUNTIME_DIR`, as under Codex); it makes no claim that the spool directory is writable, and it carries no path.

The server sorts both arrays by alias with a deterministic code-point comparison. It copies only loaded configuration fingerprint/reload policy, the event delivery setting, configured aliases and workspace modes, and the nine documented profile fields. Each workspace has a required `mode`: `unset`, `host`, `container`, or `read-only`; a missing modes entry is reported as `unset`. `extensions` lists the configured extension specs (`npm:<name>@<version>`), empty when a profile loads none; it makes no claim that the package is installed. `grantedExtensionTools`, directly after `extensions`, lists the configured extension tool grants in configured order, `[]` when absent. It is configuration intent only, not proof of registration, activation or declaration to the model. `skills` lists the skill-catalog aliases that the profile selects, in configured order, `[]` when it selects none. It contains no paths, file names, contents or SDK diagnostics, and it is configuration intent only: it makes no claim that a skill file exists, loads, or will be read by the model. See [Pi skills](skills.md). It never copies the configuration path or contents, workspace paths, authentication state, SDK data, session/turn data, prompts, transcripts, or tool arguments/results. The handler reads the in-memory loaded snapshot only and does not call the registry, Pi adapter, provider, filesystem, or network. The fingerprint identifies the exact loaded bytes, not current-file freshness; provider/model fields describe configured intent and make no availability claim.

Setup verify accepts and validates `grantedExtensionTools` in its bounded direct
MCP capabilities check, without starting a session or using a provider.
**Verifier limit:** at maximum field sizes (8 extension specs of 256 characters,
32 grants of 64 characters, provider and model of 256 characters each), at most
6 such profiles fit the verifier's 65,536-byte frame bound. Real configurations
with short values fit far more.

Annotations are `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, and `openWorldHint: false`. Clients may use them for presentation, but the strict input schema and server-owned projection enforce the contract.

## Session start

`pi_session_start` accepts a strict object containing a configured `workspace` alias and optional configured `executionProfile` alias. If omitted, the sole configured default profile is used. Unknown aliases fail before registry admission or SDK session creation.

Coding profiles are refused on `container` and `read-only` workspaces with `workspace_mode_forbids_coding` before registry admission or adapter session creation. Read-only profiles remain allowed on every mode; `unset` and `host` preserve existing coding behavior.

Inside a writer boundary only, `PI_SESSION_MCP_WRITER_GUARD` names the read-only, server-owned baseline guard file. Coding admission re-reads it on every check: the guarded workspace must have no open coding session, HEAD and its sole local branch must match the baseline commit/ref, no stash may exist, and `status --porcelain=v1 -uall` must be clean. Missing or invalid guards and failed Git probes fail closed. Other configured workspaces and read-only profiles are unaffected. Without this boundary-only variable, admission is unchanged. The controller must collect and reset uncollected writers, or wait for or close an open coding session; clients must not bypass refusals by switching profiles.

The former `profile` input is rejected; it is not reinterpreted as an execution-profile alias. Raw `provider`, `model`, `thinkingLevel`, credential-like fields, and every other unknown field are rejected. MCP annotations are hints only; authorization and selection come from schema validation, alias lookup, and the server-owned profile.

Successful session metadata is a whitelist: `id`, `workspace`, `executionProfile`, `profile`, `provider`, `model`, `thinkingLevel`, `state`, `createdAt`, and `updatedAt`. `profile` remains derived permission metadata (`read-only` or `coding`) for compatibility; it is not client-selectable. Provider, model, and thinking level are projected only after SDK post-verification.

The selected skills of an execution profile are never an input. A session loads exactly the skills that the profile selects from the operator's skill catalog, validated at start; a failure is `skill_load_failed`. A catalog value is the path of one `SKILL.md` or `builtin:<name>`, which names a skill of the skill library: the operator's override next to the configuration file if it exists, else the skill shipped in the package. It is resolved when the server loads the configuration, and the value never appears in tool output. See [Pi skills](skills.md).

A read-only profile may configure `grantedExtensionTools` only if it lists at
least one extension. The array has at most 32 unique extension tool names:
1–64 characters of `[A-Za-z0-9_-]`, not starting with `-`, not MCP-reserved
(`mcp__` prefix, `list_mcp_resources`, `list_mcp_resource_templates`,
`read_mcp_resource`) and not a built-in name (`read`, `bash`, `edit`, `write`,
`grep`, `find`, `ls`). Violations prevent startup with
`invalid_execution_profile_config`.

With grants, active tools are `read`, `grep`, `find`, `ls`, the granted MCP
tools and exactly the granted extension tools; an extension's `setActiveTools`
cannot add others. Each grant must be registered when extensions load. After
bind, the existing registered-set re-check applies; each grant must also be
active and declared to the model at admission. Otherwise start fails with
`extension_tool_missing`. Resolution errors `extension_not_installed` and
`extension_version_mismatch` take precedence, and conflict checks run first,
still failing with `extension_tool_conflict`. The SDK activates only declarable
tools: registered-but-inactive tools fail closed too. Lazy registration in
`session_start` or later is unsupported. A grant is the operator's trust
decision: third-party tools may write, and workspace modes `container` and
`read-only` do not restrict them. See [ADR 0010](adr/0010-read-only-extension-tools.md).

## Automated writer boundary (Plan B)

The host's container-mode policy does not route calls. Use the generated
`pi-coding-<alias>-w<n>` registration, which starts its own contained stdio server.
Its synthetic default `boundary-read-only` means coding starts must name an
explicit coding profile. A refusal server exposes the same eight tool names
but returns a sanitized domain error for every call, including capabilities.
No session is created by a refusal.

The guard rejects extra branches, stash, uncommitted/untracked changes and a
HEAD different from the recorded baseline, as well as another open coding
session. It re-reads its baseline file on every coding check so reset takes
effect without restarting that server. After review and session close, the
controller runs `pi-session-mcp-setup --writer <name> --finish --apply`: collect,
then reset persistent or recreate ephemeral. Incomplete collection stops finish;
never bypass admission by switching profiles. Host Git must never run inside
the clone. See [Execution modes](execution-modes.md) for lifecycle findings,
readiness, credential refresh, verification and migration. These are operator
CLI operations, not extra MCP tools or tool arguments.

## Deterministic MCP errors

Public MCP errors are stable and sanitized. Their messages do not include inputs, auth details, provider responses, filesystem paths, or secrets.

| Code | Meaning |
| --- | --- |
| `unknown_execution_profile` | The requested alias is not configured. |
| `workspace_mode_forbids_coding` | The workspace's execution mode does not allow coding sessions on this server. Operator needed: do not retry or switch profiles on this server. |
| `unknown_provider` / `unknown_model` | The exact configured item is absent from the local Pi catalog. |
| `local_authentication_missing` / `local_authentication_unavailable` | Existing local Pi authentication is absent or cannot be resolved within its deadline. |
| `model_unavailable` | The exact model is not locally available for the configured provider. |
| `thinking_level_unavailable` | The configured level is not effective for the resolved model. |
| `execution_selection_mismatch` | The created session does not match the requested verified selection. |
| `external_mcp_unavailable` | An external MCP connection, startup, transport, protocol, schema, or complete-discovery operation failed. |
| `external_mcp_no_tools` | Complete valid discovery returned no tools while explicit grants were required. |
| `external_mcp_grant_tool_missing` | Complete valid nonempty discovery omitted an explicitly granted remote tool. |
| `external_mcp_activation_mismatch` | Pi did not activate exactly the expected post-discovery tool set. |
| `extension_not_installed` | Pi has no installed package for a configured extension. |
| `extension_version_mismatch` | Pi's installed extension package has another version than the configured one. |
| `extension_load_failed` | A configured extension has an invalid manifest, failed to load or failed to bind. |
| `extension_tool_conflict` | An extension tool name collides with a built-in, MCP or other extension tool, or is unsafe: not 1 to 64 letters, digits, `_` or `-` (not starting with `-`), or reserved for MCP (`mcp__` prefix, `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`). |
| `extension_tool_missing` | A granted extension tool is not registered at load or is not active and declared to the model at admission. Fixed message: `Granted Pi extension tool is not available`; class `needs_operator` (operator needed; do not retry or switch profiles). |
| `skill_load_failed` | A skill that the profile selects could not be loaded: a missing (also a `builtin:` name that matches no override and no shipped skill), unreadable or oversized (over 256 KiB) file, an invalid skill, two selected files with the same Pi skill name, two aliases on the same canonical file, or a skill with `disable-model-invocation: true`. The message is the fixed `Configured Pi skill could not be loaded`; it never contains a path, skill name or SDK text. |
| `pi_session_creation_failed` | Pi session construction failed without a more specific safe classification. |
| `writer_uncollected` | The writer is not at its collected baseline, or its guard/Git state could not be verified; controller must collect and reset it. |
| `writer_busy` | The writer already has an open coding session; wait for or close it before starting another. |
| `writer_not_ready` | The writer launcher cannot establish current readiness; operator must run repository setup/acceptance. All refusal-server tools return this error. |
| `container_runtime_unavailable` | The writer launcher found no usable rootless Podman; all refusal-server tools refuse work, with no host fallback. |
| `server_stopping` | Shutdown has begun, so a new session cannot be admitted. |

Lifecycle errors include `unknown_workspace`, `unknown_session`, `session_running`, `prompt_rejected`, `prompt_timeout`, `abort_failed`, `abort_timeout`, and `turn_failed`. Timeout messages are stable: `Pi prompt preflight timed out` and `Pi abort timed out`.

Invalid execution-profile configuration prevents startup, so it cannot be an MCP response. In that case stderr receives a structured, sanitized `startup_failed` diagnostic with one of these stable codes; it contains no raw parser message or configuration path.

| Startup diagnostic code | Meaning |
| --- | --- |
| `invalid_execution_profile_config` | The execution-profile configuration violates its invariants or strict shape, including `grantedExtensionTools` on a coding profile or a profile without extensions, more than 32 grants, duplicate, unsafe, MCP-reserved or built-in grant names, an unknown or duplicate selected skill alias, two selected skill aliases with the same path, or an invalid `skillCatalog` entry (including a malformed `builtin:` name). |
| `invalid_thinking_level` | A configured thinking level is outside the supported enum. |
| `invalid_execution_modes` | The execution modes file is invalid or unreadable, including an unknown alias, an unrecognized shape, or an invalid container profile selection. |
| `invalid_event_delivery` | The optional `events` field is not exactly `{ "delivery": "spool" }` or `{ "delivery": "off" }`. |
| `event_spool_unavailable` | `events.delivery` is `spool`, but the spool directory cannot be used: `PI_SESSION_MCP_EVENTS_DIR` is set but not absolute, or the directory cannot be created, is a symlink or not a directory, belongs to another user, or is accessible to group or others. Without either a `PI_SESSION_MCP_EVENTS_DIR` or an absolute `$XDG_RUNTIME_DIR` the server does not fail: delivery stays inactive and stderr carries one `{"level":"warn","event":"event_delivery_inactive","stage":"startup","code":"event_runtime_dir_missing"}` line. |

`pi_session_prompt` returns `{session,turn}` only after successful Pi preflight. Preflight is bounded at 5,000 ms; a missing callback, hanging prompt acceptance, or timeout returns `prompt_timeout` / `Pi prompt preflight timed out` and creates no public turn. Late settlement may only release the unpublished operation's quarantine; it cannot publish a turn. `pi_session_abort` waits at most 5,000 ms per caller for one shared SDK abort attempt and returns `abort_timeout` / `Pi abort timed out` without claiming the turn was aborted. Rejection/failure remain `prompt_rejected`/`abort_failed`. Close allows at most 5,000 ms for abort cleanup, then performs best-effort disposal and removes the public registry entry; it remains idempotent through the retained tombstone. Registry shutdown rejects new starts, allows 12,000 ms, and disposes a handle from a late-resolving start instead of admitting it. Process shutdown, started by `SIGINT`, `SIGTERM`, or stdin EOF, allows 15,000 ms, attempts transport cleanup even after registry failure/timeout, then explicitly exits the process. These boundaries do not guarantee graceful cancellation of a provider request. `pi_turn_get` returns a `TurnView` with `turnId`, `sessionId`, state, timestamps, and `completedAt` for terminal turns. Completed views add normalized final `assistantText` and `truncated`; failed views contain only `{code:"turn_failed",message:"Pi turn failed"}`. Final assistant text is capped at 64 KiB UTF-8 bytes, each active session retains at most 20 turns, and close removes its turn data.

While a turn runs, `updatedAt` is the time of the last observed public SDK activity of that turn: assistant message start, streaming updates and end, and tool execution start, update and end. It freezes at the terminal transition. The `updatedAt` of the session does not follow this activity: it moves when a turn starts and at its terminal transition. It is a liveness lower bound only. Streaming is activity, not evidence of finished or useful work. Work without a public event, such as the internal steps of an extension's own agent loop or a long tool call without updates, stays invisible, so a stamp that has not moved can still be a working turn (a long model response, thinking, a first token, or a long tool call) and never justifies a claim that a turn is hung. The stamp is a wall-clock ISO-8601 millisecond value for ordering, not a progress count, duration, or step total, and activity within one millisecond simply reuses the stamp. Only the type of an event and the role of its message are inspected: no delta, thinking block, tool argument, or partial result is stored or projected, and the answer still comes only from the final assistant message.

Context usage stays out of the boundary: no token, usage, context-window, or cost figure is projected for a running or terminal turn, so approaching context exhaustion remains invisible in the turn view and in `pi_session_get`. This change adds no progress counters, tool names, arguments, results, or transcripts; see *Failure causes* below for failure-cause classification, which is not part of the turn view and is decided in *Failure causes* below.

Raw SDK objects/events, prompts, provider errors, credential fields, tool arguments/results, thinking blocks, and complete transcripts are not projected. `assistantText` can repeat sensitive workspace or tool content, so clients must treat it as potentially sensitive. Per-session prompt/close serialization, per-turn abort coalescing, the shutdown admission gate, and at-most-once disposal protect lifecycle races. Closed tombstones are FIFO-retained up to 100 entries and contain no turn data; after eviction an old ID is simply `unknown_session`.

## Failure causes

The allowlisted `SOURCE_TOO_LARGE` projection for a granted external MCP tool is
an internal failed Pi tool execution, not a terminal turn failure code. The agent
can correct the tool arguments and complete the same turn/session. Successful
external results over the fixed 262,144-byte UTF-8 envelope limit also become
failed tool executions with a controller-owned size diagnosis and a hint to
request less data. Neither adds a terminal turn cause. This changes
none of the eight public tools or their fields, states and error codes; see the
bounded projection policy in [session-mcp.md](session-mcp.md). If the turn itself
fails, the public result still contains only `turn_failed` / `Pi turn failed`.

`turn_failed` remains the only terminal failure projection. The characterization was made against `@earendil-works/pi-coding-agent` 0.84.4, which exposes no closed, structured terminal cause discriminator; its provider-free tests keep their assertions on the pinned 1.4.0, whose public `AssistantMessage` type still carries only the stop reason plus free-form `errorMessage`, `rawStopReason`, and open-typed `diagnostics`, and Pi Session MCP uses no such discriminator: it normalizes the final assistant outcome by its stop reason (`src/sdk-pi-adapter.ts:106-130`, see *Final stop reasons* below) and the registry projects `turn_failed` for every outcome that is neither `completed` nor `aborted` (`src/session-registry.ts:242-243`). Retry and compaction events can describe an interim error that later recovers. Assistant `errorMessage`, `rawStopReason`, and `diagnostics` are free-form and may contain sensitive provider text; they cannot reliably identify the underlying terminal cause.

This change therefore adds no runtime classification: no code is derived from `errorMessage`, `rawStopReason`, diagnostics, context size, or event order, and no provider text, diagnostics, or context figure is projected. In particular `turn_context_exceeded` is not added; an observed pattern (a long same-session turn fails, a fresh narrow session succeeds) stays a hypothesis that the public surface cannot confirm.

### Final stop reasons

The stop reason of the final assistant message is the only SDK field that selects the outcome. The mapping is an exhaustive `switch` over the SDK's `StopReason` union, derived from the root-exported `AgentSessionEvent`; a stop reason added by a future SDK fails the typecheck and therefore the Pi SDK canary instead of being mapped silently.

| Final `stopReason` | Turn state | Public projection | Reason |
| --- | --- | --- | --- |
| `stop` | `completed` | `assistantText` | finished answer (unchanged) |
| `length` | `completed` | `assistantText`, possibly cut off by the output limit | unchanged; `truncated` reports only Pi Session MCP's own 64 KiB cap |
| `toolUse` | `completed` | `assistantText` (text before the tool call, possibly empty) | unchanged; the agent loop ends on a tool call only when the tool batch terminates the run |
| `error` | `failed` | `turn_failed` / `Pi turn failed` | unchanged |
| `aborted` | `aborted` | `completedAt` | unchanged |
| `pending` | `failed` | `turn_failed` / `Pi turn failed` | new in SDK 0.99; marks a message that is still streaming, not a finished answer (previously `completed`) |
| `deferred` | `failed` | `turn_failed` / `Pi turn failed` | new in SDK 0.99; the provider has not delivered the response (previously `completed`) |
| missing or outside the union | `failed` | `turn_failed` / `Pi turn failed` | fail closed (previously `completed`); the SDK types require the field |

`pending` and `deferred` were not observed on an OpenAI-compatible local endpoint. `test/sdk-pi-adapter.test.ts` pins every row; `test/sdk-contract.test.ts` shows on the real `AgentSession` that a `deferred` final message ends the run after one model call and projects as `turn_failed`.

| Trigger | Double layer | Observed public SDK signal | Recovery or terminal | MCP projection | Limit |
| --- | --- | --- | --- | --- | --- |
| Scripted non-retryable model error (final assistant `stopReason: "error"`) | scripted model stream → real embedded `AgentSession` → controller | accepted preflight, `prompt()` resolves, assistant `message_end` with `stopReason: "error"`, `agent_end.willRetry: false`; one model call, no retry or compaction | terminal | `turn_failed` / `Pi turn failed`, no raw message | the scripted error is not evidence that a specific inference server rejects the same input |
| Scripted retryable model error | same | assistant `message_end(stopReason: "error")` → `auto_retry_start` → second model call / successful assistant `message_end` → `auto_retry_end(success: true)` | interim: turn completes | `completed` + text; no error projection | the assistant's `stopReason: "error"` also occurs in the terminal row; retry eligibility depends on SDK logic |
| Context overflow with compactable history, recovery succeeds | same | `compaction_start(reason: "overflow")` → `compaction_end(result, willRetry: true)` → continued turn | **interim**: `completed` | `completed` + text; no context, usage, or compaction field exists | a recovered overflow is invisible by design; no `turn_context_exceeded` is justified |
| Context overflow whose summarization/compaction fails | same | overflow assistant `turn_end` → `compaction_start(reason: "overflow")` → `compaction_end(willRetry: false, errorMessage present)`; no subsequent `turn_end` | terminal | same `turn_failed` / `Pi turn failed` | the cause-bearing event is transient and may contain raw provider text |
| Overflow-classified error with history too small to compact | same | no compaction event at all, one model call | terminal | same `turn_failed` | Pi Session MCP cannot tell whether the SDK even detected an overflow |
| Schema-invalid arguments for a granted external tool | scripted model → real Pi validation; real stdio child observed independently | tool result `isError: true` returned to the model; the child receives no call; the next model step succeeds | interim: `completed` | registry TurnView `completed`, argument absent; separate MCP serialization not repeated | SDK-side validation does not reproduce the reported inference-server rejection in #41 |
| External server JSON-RPC error | scripted model → real stdio child | child receives the call, tool result `isError: true` with sanitized bridge failure; next model step succeeds | interim: `completed` | registry TurnView `completed`, server marker absent; separate MCP serialization not repeated | a failed tool call does not imply a failed turn; an MCP `isError` response is covered separately by the existing stdio bridge test |
| External MCP `isError` response | real stdio child → bridge (existing test) | `isError: true` result from the child becomes a failed tool execution | tool outcome only | no new terminal turn classification | `test/mcp-stdio-e2e.test.ts` verifies the bridge, not a subsequent model step for this case |
| Prompt preflight rejection or timeout | fake handle → real registry; MCP surface (existing tests) | no accepted or published turn; late settlement cannot publish one | not a turn | `prompt_rejected` / `prompt_timeout`, no turn ID | controller admission outcome, not a provider verdict |
| Abort | fake handle → real registry; MCP surface (existing tests) | controller abort yields an `aborted` turn with `completedAt` | terminal (aborted) | `aborted` + `completedAt` | fake controller outcome does not establish the SDK's reason for abort |
| Close/disposal during a running turn, late result | fake handle → real registry (existing tests); stdio cleanup tested separately | active turn becomes `aborted`, then session and turns are removed; late outcome cannot revive them | terminal (closed) | `unknown_session` after removal; tombstone retains idempotent close | no provider cause is inferred from an arbitrary prompt rejection |

Provider-free evidence is `test/sdk-failure-recovery.test.ts` (real `createAgentSession`, conforming scripted model stream at the public `ModelRuntime.streamSimple` seam, real stdio child where a tool is involved). The terminal assistant error reaches the MCP client through an in-memory server; tool and compaction rows inspect the registry TurnView rather than repeat the MCP serialization check. Preflight, abort, close, late-result, and the standalone MCP `isError` response use existing tests rather than duplicate coverage: `test/registry.test.ts`, `test/lifecycle-hardening.test.ts`, `test/mcp-contract.test.ts`, `test/mcp-stdio-e2e.test.ts`, and `test/sdk-pi-adapter.test.ts`.

The model-side errors are synthetic at the public provider boundary. They exercise SDK retry/compaction logic, not a specific inference server or its validation policy; no provider or network is used. For a real failure, an operator can compare the sanitized turn state with the inference-server's own restricted diagnostics and verify whether a controlled MCP child actually received a tool call. Neither elapsed time, context size, an absent call, nor a successful fresh-session retry establishes a terminal cause. Keep credentials, arguments, raw errors, and transcripts out of MCP output and published reports.

### Requested SDK contract change

Pi Session MCP needs a documented, closed, structured cause on the public final assistant outcome or on `AgentSession.prompt()` resolution. The SDK contract must distinguish a terminal provider rejection, protocol failure, context failure after recovery, cancellation, and internal failure without relying on free-form `errorMessage`, `rawStopReason`, or `diagnostics`; positive and negative examples must include recovered errors. Only a verified terminal signal would justify a narrowly scoped controller classification later. Until then `turn_failed` remains the fallback and existing states stay unchanged.

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

## Capability discovery

`pi_capabilities_get` accepts only `{}`. Unknown fields fail MCP schema validation. Success has this strict shape:

```json
{
  "ok": true,
  "server": { "name": "pi-session-mcp", "version": "0.6.4" },
  "configuration": {
    "fingerprint": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "reloadPolicy": "restart-required"
  },
  "workspaces": [{ "alias": "my-project" }],
  "executionProfiles": [{
    "alias": "safe-readonly",
    "default": true,
    "permissionProfile": "read-only",
    "provider": "configured-provider",
    "model": "configured-model",
    "thinkingLevel": "medium"
  }]
}
```

The server sorts both arrays by alias with a deterministic code-point comparison. It copies only loaded configuration fingerprint/reload policy, configured aliases, and the six documented profile fields. It never copies the configuration path or contents, workspace paths, authentication state, SDK data, session/turn data, prompts, transcripts, or tool arguments/results. The handler reads the in-memory loaded snapshot only and does not call the registry, Pi adapter, provider, filesystem, or network. The fingerprint identifies the exact loaded bytes, not current-file freshness; provider/model fields describe configured intent and make no availability claim.

Annotations are `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, and `openWorldHint: false`. Clients may use them for presentation, but the strict input schema and server-owned projection enforce the contract.

## Session start

`pi_session_start` accepts a strict object containing a configured `workspace` alias and optional configured `executionProfile` alias. If omitted, the sole configured default profile is used. Unknown aliases fail before registry admission or SDK session creation.

The former `profile` input is rejected; it is not reinterpreted as an execution-profile alias. Raw `provider`, `model`, `thinkingLevel`, credential-like fields, and every other unknown field are rejected. MCP annotations are hints only; authorization and selection come from schema validation, alias lookup, and the server-owned profile.

Successful session metadata is a whitelist: `id`, `workspace`, `executionProfile`, `profile`, `provider`, `model`, `thinkingLevel`, `state`, `createdAt`, and `updatedAt`. `profile` remains derived permission metadata (`read-only` or `coding`) for compatibility; it is not client-selectable. Provider, model, and thinking level are projected only after SDK post-verification.

## Deterministic MCP errors

Public MCP errors are stable and sanitized. Their messages do not include inputs, auth details, provider responses, filesystem paths, or secrets.

| Code | Meaning |
| --- | --- |
| `unknown_execution_profile` | The requested alias is not configured. |
| `unknown_provider` / `unknown_model` | The exact configured item is absent from the local Pi catalog. |
| `local_authentication_missing` / `local_authentication_unavailable` | Existing local Pi authentication is absent or cannot be resolved within its deadline. |
| `model_unavailable` | The exact model is not locally available for the configured provider. |
| `thinking_level_unavailable` | The configured level is not effective for the resolved model. |
| `execution_selection_mismatch` | The created session does not match the requested verified selection. |
| `external_mcp_unavailable` | An external MCP connection, startup, transport, protocol, schema, or complete-discovery operation failed. |
| `external_mcp_no_tools` | Complete valid discovery returned no tools while explicit grants were required. |
| `external_mcp_grant_tool_missing` | Complete valid nonempty discovery omitted an explicitly granted remote tool. |
| `external_mcp_activation_mismatch` | Pi did not activate exactly the expected post-discovery tool set. |
| `pi_session_creation_failed` | Pi session construction failed without a more specific safe classification. |
| `server_stopping` | Shutdown has begun, so a new session cannot be admitted. |

Lifecycle errors include `unknown_workspace`, `unknown_session`, `session_running`, `prompt_rejected`, `prompt_timeout`, `abort_failed`, `abort_timeout`, and `turn_failed`. Timeout messages are stable: `Pi prompt preflight timed out` and `Pi abort timed out`.

Invalid execution-profile configuration prevents startup, so it cannot be an MCP response. In that case stderr receives a structured, sanitized `startup_failed` diagnostic with one of these stable codes; it contains no raw parser message or configuration path.

| Startup diagnostic code | Meaning |
| --- | --- |
| `invalid_execution_profile_config` | The execution-profile configuration violates its invariants or strict shape. |
| `invalid_thinking_level` | A configured thinking level is outside the supported enum. |

`pi_session_prompt` returns `{session,turn}` only after successful Pi preflight. Preflight is bounded at 5,000 ms; a missing callback, hanging prompt acceptance, or timeout returns `prompt_timeout` / `Pi prompt preflight timed out` and creates no public turn. Late settlement may only release the unpublished operation's quarantine; it cannot publish a turn. `pi_session_abort` waits at most 5,000 ms per caller for one shared SDK abort attempt and returns `abort_timeout` / `Pi abort timed out` without claiming the turn was aborted. Rejection/failure remain `prompt_rejected`/`abort_failed`. Close allows at most 5,000 ms for abort cleanup, then performs best-effort disposal and removes the public registry entry; it remains idempotent through the retained tombstone. Registry shutdown rejects new starts, allows 12,000 ms, and disposes a handle from a late-resolving start instead of admitting it. Process shutdown, started by `SIGINT`, `SIGTERM`, or stdin EOF, allows 15,000 ms, attempts transport cleanup even after registry failure/timeout, then explicitly exits the process. These boundaries do not guarantee graceful cancellation of a provider request. `pi_turn_get` returns a `TurnView` with `turnId`, `sessionId`, state, timestamps, and `completedAt` for terminal turns. Completed views add normalized final `assistantText` and `truncated`; failed views contain only `{code:"turn_failed",message:"Pi turn failed"}`. Final assistant text is capped at 64 KiB UTF-8 bytes, each active session retains at most 20 turns, and close removes its turn data.

While a turn runs, `updatedAt` is the controller's last-activity stamp: it advances after each completed tool execution and each completed assistant message, then freezes at the terminal transition. It is a liveness lower bound only. A stamp that has not moved can still be a working turn (a long model response, thinking, or a first token), so it never justifies a claim that a turn is hung; it is a wall-clock ISO-8601 millisecond stamp for ordering, not a progress count, duration, or step total, and activity within one millisecond simply reuses the stamp. It is never derived from event payloads.

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

`turn_failed` remains the only terminal failure projection. The characterization was made against `@earendil-works/pi-coding-agent` 0.84.4, which exposes no closed, structured terminal cause discriminator; its provider-free tests keep their assertions on the pinned 1.0.4, whose public `AssistantMessage` type still carries only the stop reason plus free-form `errorMessage`, `rawStopReason`, and open-typed `diagnostics`, and Pi Session MCP uses no such discriminator: it normalizes the final assistant outcome by its stop reason (`src/sdk-pi-adapter.ts:106-130`, see *Final stop reasons* below) and the registry projects `turn_failed` for every outcome that is neither `completed` nor `aborted` (`src/session-registry.ts:242-243`). Retry and compaction events can describe an interim error that later recovers. Assistant `errorMessage`, `rawStopReason`, and `diagnostics` are free-form and may contain sensitive provider text; they cannot reliably identify the underlying terminal cause.

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

# Claude Code projection probe (issue #89), 2026-10-18

Provider-free probe of what Claude Code 2.1.301 sends on a **declared synthetic
route**: a loopback Messages-API fake (`/v1/messages`, SSE), a disposable client
home, and the existing MCP fixture server (`eval/profiles/token-projection-server.ts`,
fake Pi adapter). No real credentials, provider, TLS interception or undocumented
API. Source: `eval/profiles/token-claude-projection.ts`, CLI mode
`--footprint-claude-offline`, unit test `test/token-claude-projection.test.ts`.

Command shape (every run; temp paths omitted):

```
claude --bare -p --strict-mcp-config --mcp-config <owned json: fixture server> \
  --output-format stream-json --verbose --model claude-sonnet-5-5 \
  --allowedTools mcp__pi-projection__<tool> --no-session-persistence --max-turns 3 "<fixed synthetic prompt>"
Harness invocation: node scripts/profile-evaluation.mjs --footprint-claude-offline --output <fresh dir>
```

The environment is built from scratch (PATH only inherited): fresh `HOME`,
`CLAUDE_CONFIG_DIR`, `XDG_*` and `TMPDIR` inside an owned temp root, a fixed dummy
`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL=http://127.0.0.1:<ephemeral>`,
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_TELEMETRY=1`,
`DISABLE_ERROR_REPORTING=1`, `DISABLE_AUTOUPDATER=1`,
`CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`, `ENABLE_TOOL_SEARCH=false|true`.
Plain http loopback was accepted; a fresh config dir did not force onboarding or login.

Files hold only byte sizes, counts, marker hit counts, booleans, safe labels and
hashes; no request body, prompt, header or tool data.

The probe runs on Linux only: its leftover-process check scans `/proc`, so it
refuses other platforms up front rather than report cleanup it cannot show.

## Attempts (all preserved)

- [attempt-1](attempt-1/claude-projection.json): **INCONCLUSIVE, 1 run (pilot only).**
  The pilot routed the MCP server through the existing byte-transparent frame
  proxy (`token-live-proxy`). Claude Code 2.1.301 opens MCP with a
  `server/discover` request, which the proxy's strict method allowlist treats as a
  fatal frame, so the server stayed `pending` until the client's 30 s connect
  timeout; the first model request then carried no fixture tool. (Method name and
  the 30 s timeout were confirmed in two local diagnostic runs with `--debug-file`
  and a logging stub server in scratch space; those logs are not kept.) This file
  comes from the first harness version and is not reproducible from the committed
  code. The proxy was not changed (it guards approved live runs); the committed
  probe launches the fixture server directly, so server-side frame metrics are
  not collected on this route.
- [attempt-2](attempt-2/claude-projection.json): **PASS, 10 runs** (1 pilot, then
  3 repetitions each for normal/tool-search off, normal/tool-search on,
  domain-error/tool-search off). All runs: exit 0, 2 model requests (both
  `/v1/messages?beta=true`, both main class), 0 auxiliary model requests, 0
  `count_tokens`/`HEAD /api/hello` requests, dummy key matched, no `Authorization`
  header, no leftover process, temp root removed, source and build digests
  unchanged. Repetitions were identical in every measured size.

- [attempt-3](attempt-3/claude-projection.json): **PASS, 10 runs**, same schedule,
  run by the integrator after review fixes to the probe (decoded-body cap,
  termination of leftover processes, Linux-only guard), on the Sprint 5 head
  that includes #88 and #90. Attempt 2 ran on the base `612fbcb`, so the two
  attempts are a before/after pair for the server's tool definitions on this
  route. Every measured field is identical except: `pi_capabilities_get`
  description 126 → 159 bytes and entry 328 → 361 bytes (#88); whole `tools[]`
  7,144 → 6,325 bytes (−819, the same net change as the server's `tools/list`);
  first request body 11,608 → 9,004 bytes (normal) and 11,605 → 9,001 bytes
  (domain error). The body shrank by 1,785 bytes more than `tools[]`; that
  remainder is observed, not explained. No leftover process, temp roots removed.

## Findings (attempt-2, this route only)

| Question | Result |
|---|---|
| q1 output schema in `tools[]` | **Not observed.** The fixture tool entry has exactly the keys `name`, `description`, `input_schema`; no `outputSchema`/`output_schema` key at any depth, and the schema-only marker (`reloadPolicy`; `createdAt` for the error tool) occurs 0 times in the entry and in the whole `tools[]`. `pi_capabilities_get`: name 39 B, description 126 B, input_schema 119 B, entry 328 B. `pi_session_start`: 36 / 69 / 282 / 431 B. |
| q2 result projection | **Observed.** In the request after the call, the fixture result is one `tool_result` whose content is a single string (not a block array) of 493 B (normal) / 93 B (domain error, `is_error: true`). The content-text marker occurs **1** time and no `structuredContent` key is present, although the server returned two equal representations (content text and `structuredContent`; verified for this fixture by the earlier Codex probe, not re-measured here). Domain error: error marker 1 hit. So only the text representation reaches the request, as in the Codex probe. |
| q3 tool search off vs on | **Unmeasurable on this route.** `ENABLE_TOOL_SEARCH=false` and `=true` give identical requests: first body 11608 B (normal) / 11605 B (error), `tools[]` 11 entries / 7144 B, 0 `defer_loading`, no tool-search tool. A diagnostic debug run showed the client recognizes `ENABLE_TOOL_SEARCH=true` but logs "Tool search disabled: ToolSearchTool is not available" (bare mode); `--tools=default` did not change this. No workaround outside the documented bare route was tried. |

Other observed values: the second (post-tool) request is smaller than the first
(9011 B vs 11608 B normal, 8680 B domain error) while `tools[]` is unchanged; this
was not investigated.

## Limits

- `--bare` is a minimal client (no hooks, skills, plugins sync, auto-discovered MCP,
  keychain/OAuth), not a default user configuration. A default-configuration client
  may send different `tools[]`, system text and auxiliary requests.
- Whole-HTTP-body bytes are not token counts. No model, token, billing, cache or
  real-route (Anthropic, Bedrock, Vertex, gateway) behavior is measured; the SSE
  fake is the only model.
- `ENABLE_TOOL_SEARCH` was forced by environment on a non-first-party base URL; the
  result says nothing about default tool-search behavior.
- Outbound traffic is not OS-contained; containment rests on the scrubbed
  environment, loopback base URL and disabled non-essential traffic only.
- Client version pinned to `2.1.301 (Claude Code)`; any other version is rejected.

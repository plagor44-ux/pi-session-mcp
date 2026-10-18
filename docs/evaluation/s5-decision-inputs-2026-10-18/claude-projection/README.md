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
Non-bare variant (attempts 4 and 5): the same command line without --bare, invoked with
  node scripts/profile-evaluation.mjs --footprint-claude-nonbare-offline --output <fresh dir>
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
  Later update: the proxy now forwards exactly `server/discover` (a method defined by
  the pinned MCP SDK 2.3.1, protocol revision 2026-07-28) and counts it in
  `discover_requests`, with a provider-free test; this probe still launches the fixture
  server directly and was not re-run behind the proxy.
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

- [attempt-4](attempt-4/claude-projection.json): **PASS, 7 runs, non-bare** (opt-in
  mode `--footprint-claude-nonbare-offline`): the same probe without `--bare`, normal
  scenario only, in the identical scrubbed environment (fresh owned `HOME` and
  `CLAUDE_CONFIG_DIR`, PATH only, dummy key, loopback base URL, non-essential traffic
  off, `--strict-mcp-config`, `--no-session-persistence`). Schedule: 1 pilot
  (`ENABLE_TOOL_SEARCH=true`), then 3 repetitions each for `false` and `true`. The pilot
  gates the repetitions on isolation facts only (not on the tool-search flow completing).
  Isolation check, all 7 runs: exit 0; no request outside the loopback fake that the fake
  could see (0 `count_tokens`, 0 `HEAD /api/hello`, 0 unexpected HTTP); every request on
  `/v1/messages?beta=true`, class header absent, dummy key matched, **no `Authorization`
  header**; the owned config dir held 2 files and the owned home 3 files after the run
  (no credential file was needed; a fresh config dir did not force onboarding or login);
  a per-run socket sampler (5 samples per run, a 380 ms client) saw 0 non-loopback
  connections and 1 loopback connection in 5 of 7 runs; no leftover process, temp roots
  removed. The sampler can miss short-lived sockets, so it is a sanity check only; see
  attempt-5 for containment. The recorded binding digest predates one later test-only
  edit (`test/token-claude-projection.test.ts`); the probe code in `eval/profiles` is
  identical to the committed code.
- [attempt-5](attempt-5/claude-projection.json): **PASS, 7 runs**, the same non-bare
  schedule repeated once inside a loopback-only network namespace
  (`unshare -rn`, `lo` up; an HTTPS request to a public host failed there), so that any
  non-loopback attempt would have failed instead of leaving the machine. Every measured
  size is identical to attempt-4 (all 7 summaries equal), exit 0 in every run. This is an
  isolation confirmation, not a second measurement series.

## Findings (attempt-2, this route only)

| Question | Result |
|---|---|
| q1 output schema in `tools[]` | **Not observed.** The fixture tool entry has exactly the keys `name`, `description`, `input_schema`; no `outputSchema`/`output_schema` key at any depth, and the schema-only marker (`reloadPolicy`; `createdAt` for the error tool) occurs 0 times in the entry and in the whole `tools[]`. `pi_capabilities_get`: name 39 B, description 126 B, input_schema 119 B, entry 328 B. `pi_session_start`: 36 / 69 / 282 / 431 B. |
| q2 result projection | **Observed.** In the request after the call, the fixture result is one `tool_result` whose content is a single string (not a block array) of 493 B (normal) / 93 B (domain error, `is_error: true`). The content-text marker occurs **1** time and no `structuredContent` key is present, although the server returned two equal representations (content text and `structuredContent`; verified for this fixture by the earlier Codex probe, not re-measured here). Domain error: error marker 1 hit. So only the text representation reaches the request, as in the Codex probe. |
| q3 tool search off vs on | **Unmeasurable on this route.** `ENABLE_TOOL_SEARCH=false` and `=true` give identical requests: first body 11608 B (normal) / 11605 B (error), `tools[]` 11 entries / 7144 B, 0 `defer_loading`, no tool-search tool. A diagnostic debug run showed the client recognizes `ENABLE_TOOL_SEARCH=true` but logs "Tool search disabled: ToolSearchTool is not available" (bare mode); `--tools=default` did not change this. No workaround outside the documented bare route was tried. |

Other observed values: the second (post-tool) request is smaller than the first
(9011 B vs 11608 B normal, 8680 B domain error) while `tools[]` is unchanged; this
was not investigated.

## Findings (attempts 4 and 5, non-bare route, q3 only)

| Question | Result |
|---|---|
| q3 tool search off vs on | **Observed**, on this synthetic route with `ENABLE_TOOL_SEARCH` forced by environment. All 3 repetitions per setting were identical, and attempt-5 matched attempt-4. |

| Non-bare, normal scenario | `ENABLE_TOOL_SEARCH=false` | `ENABLE_TOOL_SEARCH=true` |
|---|---|---|
| model requests (all main class) | 2 | 3 (scripted: tool search, tool call, text) |
| first request body | 68,067 B | 45,853 B (-22,214 B) |
| whole `tools[]` in the first request | 28 entries, 50,363 B | 12 entries, 27,472 B (-22,891 B) |
| `defer_loading` entries in the first `tools[]` | 0 | 1 |
| tool-search tool in the first `tools[]` | no | yes |
| fixture tool in the first `tools[]` | yes, 361 B entry, not deferred | **no** |
| `tools[]` in the second request | 28 entries, 50,363 B (no search step) | 13 entries, 27,855 B; fixture entry present, 382 B, `defer_loading: true` |
| later request bodies | 67,255 B (after the tool call) | 45,093 B (after the search), 45,896 B (after the tool call) |

The first-request body shrinks by 677 B less than `tools[]` does, so other request
content grows by 677 B with tool search on (`system` is 6,049 B in both). That remainder
is observed, not explained, as is which single entry in the first `tools[]` carries
`defer_loading` with tool search on.

## Limits

- Attempts 4 and 5 use a client without `--bare` but still in a scrubbed, empty
  `HOME`/`CLAUDE_CONFIG_DIR` with `--strict-mcp-config`: no user settings, hooks, skills,
  plugins, memory files or other MCP servers, so it is not a default user configuration
  either. The byte differences above are bytes of this fixture server and this client
  version, not tokens, cost or cache behavior; the SSE fake is the only model, and the
  scripted tool-search call is synthetic. Isolation in attempt-4 rests on the scrubbed
  environment and the loopback base URL; only attempt-5 is network-contained.
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

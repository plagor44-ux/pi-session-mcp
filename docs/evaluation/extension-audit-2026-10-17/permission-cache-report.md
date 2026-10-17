# Pi Extension Static Audit: Permission System and Cache Optimizer

Audit date: 2026-10-17 (UTC registry snapshot observed during this audit)

This is a static review of the exact npm artifacts named below. The local Pi installation was checked by the controlling session and neither package was present. Tarballs were downloaded to a fresh `/tmp` directory, hashed, and unpacked for reading. No `npm install`, lifecycle script, extension import, extension execution, credential read, provider/model call, or production configuration change occurred. Runtime status for both packages is therefore **NOT RUN**.

## Findings

| Package | Exact npm identity at audit time | SDK 1.2.0 compatibility | Headless use | Decision |
|---|---|---|---|---|
| Permission policy | `@gotgenes/pi-permission-system@40.3.0` | Declared peers `@earendil-works/pi-coding-agent >=1.0.0` and `@earendil-works/pi-tui >=1.0.0`; the installed project versions are both `1.2.0`. The version ranges include the installed SDK. The artifact's dev dependencies use SDK/TUI `1.0.0`; there is no runtime qualification against this host. | Policy gates can run without a UI. `ask` can be forwarded from a child session to a serving parent, while a headless session without a usable authority must fail closed; it cannot obtain a human confirmation from this local MCP host by itself. | Candidate for a controlled provider-free integration test after isolated installation. Do not call it an OS sandbox or assume it enforces arbitrary collector-internal methods. |
| Cache optimizer | `pi-cache-optimizer@2.9.3` | Declared peer `@earendil-works/pi-coding-agent >=0.82.0`, which includes `1.2.0`. Its README says it is validated against Pi `1.3.0`; current host `1.2.0` is inside the peer range, but that is not runtime evidence. The source uses extension hooks and `getAgentDir()` that are present in installed SDK 1.2.0 declarations. | Its hooks and read-only diagnosis can operate without interactive UI. Commands that write config or model files require interactive confirmation and are documented to refuse writes in non-interactive mode. | Candidate only with all write fixes disabled and cache warming explicitly off. It can make Pi perform extra billable provider refresh requests through the host's cache-warming hook. |

### Identity and provenance

The registry identity `@gotgenes/pi-permission-system` is valid and distinct from forks such as `@xzzpig/pi-permission-system`. The current npm package points to the `packages/pi-permission-system` directory of `gotgenes/pi-packages`; this audit did not substitute the separate `epheien/pi-permission-system` repository for the npm artifact. The current cache package identity is `pi-cache-optimizer`, repository `jiangge/pi-cache-optimizer`; it documents a rename from `pi-deepseek-cache-optimizer`.

The registry's `latest` tag resolved to permission-system `40.3.0` (published 2026-10-17 02:29:10 UTC) and cache-optimizer `2.9.3` (published 2026-10-17 00:03:54 UTC). Pin these exact versions and verify tarball integrity again at installation time; `latest` is mutable.

## Static behavior and data paths

### `@gotgenes/pi-permission-system`

The package registers Pi lifecycle/input/tool-call hooks and applies deterministic allow/ask/deny policy to the tool surface. Its README describes gates for bash, file paths, skills, MCP servers/tools and special operations. It has no built-in model call or model configuration; model-assisted authorization is a separately installed authorizer link and requires explicit opt-in configuration.

The reviewed shipped source contains no direct HTTP client, `fetch`, WebSocket, analytics or telemetry client reference. Local data paths include its extension configuration, debug/review JSONL logs, and forwarding request/response files for child sessions. Review logs can contain bash command text and tool-input previews. The source applies width caps, name-based redaction and owner-only file modes, but its README explicitly says it cannot infer every secret from a value; logs still need local handling as potentially sensitive. The package has no `preinstall`, `install`, `postinstall`, or other install lifecycle hook in its published `package.json`. Its declared dependencies (`web-tree-sitter`, `tree-sitter-bash`, `zod`) may have their own lifecycle behavior; that transitive install behavior was not executed or independently qualified here.

The README explicitly defines this package as a decision layer, not an isolation mechanism or sandbox. Its policy only controls actions Pi routes through the extension's registered hooks. It does not prove OS-level file confinement, stop unmediated code paths, or establish policy over unexposed internal methods of this project's MCP collectors. Treat those as separate enforcement boundaries.

### `pi-cache-optimizer`

The extension hooks can rewrite parts of prompts, add a conservative OpenAI-compatible cache key, adapt provider request payload/headers, collect local cache usage counters, and present diagnostics. Source imports use Pi's public package root and Node built-ins; this static source scan found no direct HTTP client, `fetch`, WebSocket, analytics or telemetry client. The provider request that Pi normally makes remains an outbound data path to the selected provider; the extension's payload edits are part of that request. Local persistence includes cache-stat shards/archives and extension-owned configuration/receipts under Pi's agent directory. Stats are keyed with provider/model and opaque session identifiers according to the README and source.

The extension handles Pi's `cache_warming_decision` hook. When enabled under its zero-price policy, it can tell Pi to replay a provider request with a one-token output cap. That is a real provider request and may be billable even if local catalog prices are zero or unknown; turn off Pi cache warming and the extension's zero-price-warming option for an evaluation intended to make exactly one model request per turn. The extension itself does not run a separate keepalive timer.

Several slash commands (`fix`, `rollback`, persistent feature config) can change `models.json` or extension-owned files after preview and UI confirmation. The package documents refusing such writes when interactive confirmation is unavailable. Those mutation paths must stay out of a headless evaluation profile. The README's `doctor`/`compat` paths are diagnostic and read-only.

The published package has no dependencies and no install lifecycle scripts. Its `pi` manifest exposes `./index.ts` as its extension entry point.

## Provider-free qualification plan

No new tests were executed as part of this static audit. After an isolated, exact-version install into a disposable evaluation fixture, the following tests can qualify extension behavior without provider access:

1. **Permission policy:** invoke the real local Pi hook contract with a fake in-memory provider; test explicit deny and allow, a representative file-path deny, bash wrapper/unparseable cases, MCP server/tool matching, and fail-closed hook errors. For `ask`, test TUI, RPC/print headless fallback, and child-to-parent forwarding separately. Assert that a headless ask never becomes an implicit allow and that no MCP-provider method outside the mediated hook surface is claimed as protected.
2. **Permission data handling:** direct logs and forwarding files to a temporary fake agent directory; test redaction and owner-only creation modes with synthetic secret-like values, then assert cleanup. Do not use real home/agent state.
3. **Cache payload logic:** use synthetic model and provider request events; assert the exact request fields changed/preserved for each supported API, that OpenAI Responses/Codex bypasses are honored where documented, and that no test sends a request.
4. **Cache stats and persistence:** use temporary agent dirs and synthetic response usage events to test shard creation/aggregation, malformed file handling, concurrent writers, session partitioning, retention/cleanup and absence of prompt text, response payloads, headers or credentials in persisted JSON.
5. **Billable-call gate:** provide zero and unknown pricing fixtures and verify `cache_warming_decision` returns no warming decision when evaluation policy disables it. Verify fix/rollback commands refuse in headless mode and no project/global `models.json` is changed.
6. **MCP/server boundary:** run the project server with a fake extension loader and fake Pi SDK seams, verify stdout remains protocol-only and that the extension allowlist is exact. Separately test any internal collector method grant enforcement; outer MCP exposure does not establish inner-method authorization.

These tests can check contract behavior without network/provider credentials. They do not by themselves establish OS sandboxing or evaluate model quality.

## Evidence

The companion [evidence JSON](permission-cache-evidence.json) records registry versions, metadata, source URLs, local SDK versions, install status, tarball hashes and test status. Registry package metadata is primary evidence for the published identity and artifact integrity; the unpacked files are the reviewed artifact. No test/result in this report should be read as runtime qualification.

Primary sources:

- [npm registry metadata: `@gotgenes/pi-permission-system`](https://registry.npmjs.org/%40gotgenes%2Fpi-permission-system)
- [Published permission-system package](https://www.npmjs.com/package/%40gotgenes/pi-permission-system)
- [Permission-system source repository](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system)
- [npm registry metadata: `pi-cache-optimizer`](https://registry.npmjs.org/pi-cache-optimizer)
- [Published cache-optimizer package](https://www.npmjs.com/package/pi-cache-optimizer)
- [Cache-optimizer source repository](https://github.com/jiangge/pi-cache-optimizer)

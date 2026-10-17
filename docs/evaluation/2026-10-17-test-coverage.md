# Test coverage register — 2026-10-17

This is the historical state before the subsequent
[seven-extension audit and OpenWiki component tests](extension-audit-2026-10-17/README.md).
The subsequent approved [Node 24 follow-up](node24-followup-2026-10-17/README.md)
adds isolated installation and component checks of the four missing packages and
Cursor. Earlier inventory-only or blocked statuses remain historical records.
The later [client reconnect record](client-reconnect-2026-10-17/README.md)
also verifies the two existing Claude MCP connections under Node 24.
The [plan continuation](plan-continuation-2026-10-17/README.md) records the later
T1/T5 instruction clarification, unchanged acceptance logic and provider-free
checks under a new source binding; the historical rows below are preserved.
The later [permission policy checks](permission-gates-2026-10-17/README.md)
exercise seven public policy queries and four genuine SDK hook decisions, with
no tool executor or model turn. This adds a bounded technical gate result to the
earlier extension load checks.
The later authorized [live re-screen](live-rescreen-2026-10-17/README.md) again
uses baseline A only: five starts, three task acceptances, no selected worker
skills/extensions/external MCP grants, and one planned Grok repetition blocked.
The later [extension functional dossier](extension-functions-2026-10-17/README.md)
adds actual candidate functions with separately named hooks, tools, standalone MCP
paths and remaining blockers. It supersedes load-only conclusions for those named
functions while preserving this historical register. No additional live model evaluation was run.
The original run evidence and machine-readable register are preserved; the new
dossier records the later checks and remaining runtime blockers separately.

The eight live runs tested **baseline A with no selected Pi extensions, no selected
worker skills and no external worker MCP grants**. They exercised the real
`pi-session-mcp` server and native model routes. Local contract tests separately
exercised synthetic extension packages and MCP children. No production extension
or external MCP service was qualified by this wave.

This register consolidates the [historical offline record](2026-10-17-profile-evaluation-evidence.md)
and [live screening report](2026-10-17-live-screening.md). The
[machine-readable register](test-coverage-2026-10-17.json) pins their underlying
evidence with hashes and includes exact source-test references and N1–N8 limits.
Compiling this register started **zero additional live evaluations**.

## What actually ran

| Component | Execution and evidence | Result and limits |
| --- | --- | --- |
| `pi-session-mcp` 0.8.3 with Pi SDK 1.2.0 | Eight real compiled-server MCP stdio sessions, exact provider/model/effort binding, prompt and polling, close and empty-session check | 8/8 harness PASS; 4/8 task gates PASS; observed cleanup PASS. This qualifies the exercised path, not every MCP method or event ordering. |
| Native model routes | `openai-codex/gpt-6-luna` low: T1/T2; `openai-codex/gpt-6.1-sol` medium: T1/T2; `deepseek/deepseek-flash` high: T1/T2; `xai/grok-4.7` high: T5 twice | Three accepted backend fixes and one accepted review. Detailed rejected receipt checks remain in the live report. |
| Pi built-in tool selection | Read-only: `read`, `grep`, `find`, `ls`; coding additionally `bash`, `edit`, `write` | These are the configured allowlists. The archived live records do not expose per-tool execution counts; availability must not be described as proof each tool was invoked. |
| Controller MCP methods | `pi_capabilities_get`, `pi_session_start`, `pi_session_prompt`, `pi_turn_get`, `pi_session_close`, `pi_session_list` | Exercised by the live runner. Abort was not needed in the completed live wave; abort/EOF/error paths have separate local regression coverage. |
| T3 browser reference calibration | Real local Vite/Chromium through Playwright; 375px/1280px, preserved content, keyboard focus, initial and post-Refresh error states, screenshots | Failing reference before and passing reference after a controller-provided CSS fix. Not a live model UI repair or a browser MCP integration test. |

Live inputs, eight claims and results, accepted snapshots and patches, diagnostics,
comparison, [audit](live-screening-2026-10-17/audit.json) and
[integrity index](live-screening-2026-10-17/integrity.json) are archived together.
The source digest remained
`sha256:686887d57899c2e55593bb7dd98b78be08ea0fc6c471a6dd4eab3298f890d160`.

## Extensions and skills: local fixtures versus production packages

| Exact identity | What was executed | What this establishes |
| --- | --- | --- |
| `npm:pi-extension-fixture@1.0.0` | Private local fixture loaded by the installed SDK, with an in-memory fixture provider; [SDK extension tests](../../test/sdk-extension-contract.test.ts) | Provider registration and completed prompt, RPC input hook, read-only allowlist despite `setActiveTools`, coding tool advertisement, literal slash-command forwarding and shutdown event. No external provider or real-world extension package is qualified. |
| `npm:pi-skill-fixture@1.0.0` | Private extension/skills/prompts fixture and explicit skill folders; [SDK skill tests](../../test/sdk-skill-contract.test.ts), included in the full suite | Explicit selection/order, concurrent and empty selections, package/late-discovery non-widening, duplicate-name protection, invalid selection rejection, sanitized errors and lifecycle cleanup. Some fault paths use injected lifecycle seams. These are contract tests, not worker-quality tests with production skills. |
| `npm:fixture-ext@1.2.3` | Temporary package manifests/files in [resolver tests](../../test/pi-extensions.test.ts) | Exact installed version and package resolution; missing/malformed manifests, version mismatch, invalid entries and escaping symlinks. This is a resolver fixture, not an independently evaluated published extension. |
| `npm:pi-cursor-sdk@0.5.3` | Configuration identity inventoried only during the original eight-run wave | **NOT_RUN in that wave**. The later [component dossier](extension-functions-2026-10-17/cursor/README.md) adds local activation tests; actual Cursor model/cloud/MCP sessions remain unqualified. |
| `pi-session-review`, `pi-session-implementation` | Configured skill aliases inventoried only | **NOT_RUN as worker skills**. Recorded digests are null, so no content hash or successful loading is established by this inventory. None of the eight live profiles selected these skills. |

The controlling agent read and applied `pi-session-orchestration` for orchestration
and cleanup. That is controller procedure; it is not a worker skill treatment or
a measured skill-quality improvement. No extension was newly installed for this
evaluation. Fixtures were copied into owned temporary test directories.

`pi-lens`, `context-mode`, a cache optimizer, a permission-system experiment and
research tooling remain **NOT_RUN**. No B/C ablation, package/telemetry/data-path
audit or benchmark of these candidates was completed.

## MCP coverage

| MCP surface | Tested scope | Result and limit |
| --- | --- | --- |
| Local synthetic stdio service | [Fixture child](../../test/fixtures/mcp-stdio-server.mjs), [stdio tests](../../test/mcp-stdio-e2e.test.ts) and [bridge tests](../../test/mcp-session-tools.test.ts): granted dispatch, ungranted-call denial, argument/output schema checks, paginated discovery, missing/empty/looping/capability-less discovery, `isError`, sanitized JSON-RPC errors, lost response, timeout/cancellation, per-session resources and EOF/SIGTERM/SIGKILL cleanup | Real local process and MCP SDK transport, with synthetic payloads and scripted model responses. This does not establish behavior of any production MCP service. The fixture also includes deliberate deny/error/timeout tools; their catalog presence does not mean every tool was successfully granted. |
| Outer tool grant with inner method | In-memory synthetic `collector` connection in [boundary tests](../../test/profile-boundaries.test.ts), observed forwarding of `method:delete_all` | **N2 boundary FAIL**: there is no independent inner-method authorization filter. The regression test passes by observing this missing boundary. It did not contact a production service or delete real data. Baseline A grants no collector. |
| Production `codegraph_explore` / Graphify | No Pi-worker integration call in this evaluation | **NOT_RUN**. The routing document's statement that production profiles have this grant is not runtime evidence. The temporary baseline profiles omitted external MCP grants. |
| Other production external MCP services, including Cursor's own MCP connections | No selected live grant, service call or service-specific test | **NOT_RUN**. Connector availability in the controller does not establish availability or behavior inside Pi workers. |

## Negative cases and task coverage

The [exact N1–N8 map](../../test/fixtures/profile-evaluation/coverage.json) separates
test execution from the required property being assessed:

| Requirement | Recorded property result | Scope |
| --- | --- | --- |
| N1 | PASS | Scripted forbidden `write`, `edit`, `bash` requests rejected after hostile synthetic AGENTS context; canary unchanged. |
| N2 | **FAIL** | Outer MCP grants do not filter arbitrary inner methods. Ungranted outer-call rejection is separately covered and passes. |
| N3 | PASS | Strict inputs and server-side alias/profile resolution; loaded configuration snapshot. |
| N4 | PASS | Implemented missing/invalid skill, extension binding and MCP startup/discovery gates. |
| N5 | PASS | Covered errors/timeouts, malformed/truncated receipts, lost acknowledgement, no controller mutation retry and selection mismatch. |
| N6 | PASS | Covered abort/EOF/close/SIGTERM/SIGKILL cleanup cases, including observed real child processes. |
| N7 | PASS | Two controlled concurrent synthetic run scopes and separate per-session resources. The paid live wave itself was sequential. |
| N8 | PASS | Same controlled hostile-context/tool-denial evidence; not a general prompt-injection guarantee. |

All nine task families have public fixtures. T1/T2/T5 were the only live model
tasks. T3 had real browser reference calibration; T4/T6/T7/T8 have local oracle
tests but no live candidate runs. T9's public handoff fixture exists, but controlled
compaction remains BLOCKED: no observable controlled event was supplied.

The full provider-free suite passed 1,459 tests, with six skipped, zero failed,
across 60 files. The offline subset passed 308 tests with no skips or failures.
These suites overlap; their counts must not be added. The historical evidence
preserves earlier failed attempts and subsequent final checks. The full suite
includes SDK skill-contract tests; that file is not part of the shorter offline
subset's explicit file list.

OS sandboxing, general filesystem read/write isolation, arbitrary multi-user
isolation and containment of deliberately detached unsampled processes are not
established. Coding file-scope boundaries remain FAIL. Clean final diffs do not
prove prevention of earlier or out-of-scope access.

## Record completeness

The record includes approval/budget bindings, source/task/profile hashes, exact
routes, timing, result states, checks, scoped artifacts and cleanup. It deliberately
does not retain raw model receipts, full prompts, credentials or raw provider
errors. Consequently, exact rejected receipt contents cannot be reconstructed;
the second Grok clean-case rejection cannot establish a general model weakness.

Actual cost, token usage, SDK-internal retry counts and live per-tool execution
counts remain unavailable. The USD 5 budget was advisory and its actual financial
compliance cannot be demonstrated. No additional paid run was made to fill these
logging gaps.

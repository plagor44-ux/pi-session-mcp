# Pi extension function checks: navigation and context

These bounded checks invoked the exact isolated installs `pi-lens@4.4.3` and `context-mode@1.0.169` through Pi's public SDK session/extension runner with a synthetic fixture and temporary HOME, using Node 24.22.0. No provider/model prompt ran. One network attempt and 20 child-process attempts by the context-mode bundled server were intercepted by its child preload before connection/execution; each temporary scope was removed and each owned process group was empty at completion.

| Package | Evidence and outcome |
|---|---|
| `pi-lens@4.4.3` | The registered `symbol_search` tool was invoked six times and `project_report` once through `session.getToolDefinition()` and `session.extensionRunner.createToolContext()`. **PASS for observed cold-cache behavior:** `symbol_search` returned the documented background-index/retry response; `project_report` returned `available: false` with the background-build/retry hint. Fixture retrieval is **INCONCLUSIVE** because no completed index or search hit was observed. The final run passed with zero denied network/child requests and verified cleanup for Git and both exact read-only `getconf` metadata calls. No warm retrieval, ranking, or citation behavior is claimed. |
| `context-mode@1.0.169` | A synthetic `read` tool result reached the real SDK `tool_result` handler and was persisted in the isolated session DB with the fixture `project_dir`. **PASS for hook capture and persistence.** The public `before_agent_start` hook also ran and the bundled MCP server process started and was cleaned up. Its child guard intercepted one network attempt and 20 child-process attempts. The public tool registry showed no `ctx_*` tools after direct hook emission, leaving MCP tool execution/retrieval **INCONCLUSIVE**: the child guard prevented bridge bootstrap dependencies, and direct hook emission may also omit an SDK refresh step used during a real agent turn. No production integration conclusion, search scope, original-evidence retrieval, or compression behavior is claimed. |

The SQL oracle checks only that the hook persisted the canary and tagged the event with the fixture project directory. It does not prove controller-enforced project filtering in a search tool. Candidate tool invocations for context-mode are zero; its hook invocation count is one.

## Evidence and audit trail

- `function-probe.mjs` contains the fixture assertions, public SDK calls, network barrier, and exact child-process allowlist. `function-runner.mjs` supervises isolated runs, bounds their runtime, checks process-group cleanup, and sanitizes receipts.
- The initial public SDK-context `BLOCKED` diagnosis is retained in `attempt.json` as a superseded harness diagnosis. [Archived receipt copies](receipt-archive.json) preserve later diagnostics and final receipts; they are not silently treated as extension failures.
- The final summary is [`final-result.json`](final-result.json); it links the per-run receipts. The last Pi-lens receipt is `isolated-extensions-results-2026-10-17T13-46-56-605Z-f46134c2-8523-4892-ab76-e88195d79ed2.json`; the last context-mode receipt is `isolated-extensions-results-2026-10-17T13-45-48-020Z-06f478f2-43c4-48a7-ac02-7e53d4df8aaf.json`.
- Permitted fixture child processes were limited to fixed, read-only Git index/metadata queries, exact read-only `getconf` queries (`CLK_TCK`, `PAGESIZE`) through native `execFile` callback semantics, the exact pinned context-mode bundled Node server with `--import child-guard.mjs`, and literal `command -v <runtime>` metadata checks with PATH restricted to the isolated Node runtime. The child guard instruments Node network APIs and all child-process APIs in the server process; it is instrumentation, not OS-level containment.
- No packages were installed, no credentials/auth stores were read, and no production profile, global settings, or source code was changed.

Hashes for the runnable probes and final evidence summary are recorded in `SHA256SUMS.txt`.

Final raw receipts are copied under `attempts/`. The component integrity index binds their exact original bytes, the public SDK probe, supervisor and child preload.

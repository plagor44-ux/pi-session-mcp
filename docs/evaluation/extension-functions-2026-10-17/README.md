# Pi extension functional evidence — 2026-10-17

The initial model screens used baseline A without selected third-party extensions. Subsequent SDK load/registration checks established package compatibility in that bounded path, but did not establish useful extension behavior. This dossier adds actual provider-free function checks of the seven selected candidates and preserves the distinction between Pi integration, standalone MCP execution and fixture-host component tests.

No external model turn, paid provider call, subscription, global package installation, production profile change or production repository write was performed for this follow-up. Node 24.22.0 was used. The evaluation source remains bound to commit `406dae7e6b99aa5715960490e869bd3fc668cca2` and digest `sha256:a4524626851448908b8d21ecbd7248c9956ce830406e81c45fda46c8eb6fffc5`.

## What is actually qualified

| Exact package | Actual execution | Result and remaining limit |
|---|---|---|
| `pi-lens@4.4.3` | Public SDK tool definitions against a synthetic source repository | [Seven tool calls](navigation/README.md) PASS for cold-cache/retry responses (six searches and one project report). Warm-index retrieval remains **INCONCLUSIVE**; no expected fixture hit was observed. |
| `context-mode@1.0.169` | Actual SDK `tool_result` hook receives a synthetic AGENTS read result; independent inspection of its owned database checks persistence | [Hook persistence](navigation/README.md) PASS. The inner MCP server started with its own guard; the restricted overall probe is **BLOCKED** and MCP tool retrieval remains **INCONCLUSIVE**. No compression or original-output retrieval was executed. Project tagging does not prove a search authorization boundary. |
| `pi-cache-optimizer@2.9.3` | Actual hooks and registered command callbacks from the published entrypoint, driven by a synthetic host | [Six cases](cache/README.md) PASS: payload mutation/preservation, Codex bypass, disabled zero/unknown-price warming, headless fix/rollback refusal and synthetic usage persistence. No measured cache savings or live scheduler qualification. |
| `@gotgenes/pi-permission-system@40.3.0` | Seven public policy queries and four actual SDK hook decisions, already completed | [Policy and hook checks](../permission-gates-2026-10-17/README.md) PASS. The hook counter is synthetic; no tool executor or OS containment is established. |
| `openwiki@0.7.2` | All six registered Pi lifecycle tools invoke the real stdio MCP child; one owned repository and one writer | [14 checks](bridges/README.md) PASS, including plan, claims, written-page submission, completion and invalid-state rejection. Source preserved and cleanup observed. Retrieval/model quality remains untested. |
| `pi-web-access@0.41.0` | Production Pi resolver plus separately published standalone MCP CLI | [Six checks](bridges/README.md) PASS for discovery, owned-loopback raw fetch, stored-content lookup and invalid requests. **Pi extension loading remains BLOCKED** by the directory-valued manifest entry; `web_search` and `source_check` were discovered but not called. |
| `pi-cursor-sdk@0.5.3` | Local activation component is reported separately from model execution | [Two component cases](cursor/README.md) PASS: activation, resource listing, unknown/disabled skill rejection, symlink omission and disabled bridge. Cursor local-agent/cloud/provider sessions remain NOT_RUN. |

These rows do not qualify entire packages or production deployment. The package/peer/license/telemetry audits and isolated installations remain in the earlier [extension audit](../extension-audit-2026-10-17/README.md) and [Node 24 follow-up](../node24-followup-2026-10-17/README.md); those records are not rewritten.

## MCP and data paths

OpenWiki exercised the Pi extension's genuine stdio child and six lifecycle methods. Web Access exercised its genuine standalone stdio child and two content tools against one controller-owned HTTP fixture. Context-mode's event persistence check does not establish its separate MCP compressor. Cursor's local activation component does not establish Cursor-owned MCP servers. The prior synthetic MCP and permission tests remain separately scoped in the [coverage register](../2026-10-17-test-coverage.md).

The probes use fresh owned homes/workspaces, no credential environment and narrowly instrumented network/child paths. OpenWiki's one observed outgoing fetch attempt was blocked, despite explicit telemetry opt-outs; its purpose was not attributed. Context-mode's guarded MCP child attempted one network request and 20 child processes, all intercepted; this restricted bridge experiment is inconclusive. Web Access allowed only the local fixture port with temporary package SSRF configuration. These JavaScript guards and process-group observations are bounded instrumentation, not a sandbox or general filesystem boundary.

## Remaining work and scope

A live quality/cache/context benefit over baseline A is **NOT_RUN**: no B/C ablation was selected and this follow-up consumes no new model slots. Such a comparison needs matched tasks and an explicitly approved route/start/budget matrix. Existing screening approval does not authorize additional model calls.

The other inventoried workflow packages, including `pi-subagents`, `@juicesharp/rpiv-todo`, `pi-goal-x` and `pi-advisor-flow`, are not part of this seven-candidate functional result. No default inner agents, goal loops or workflow framework were enabled. The original assignment explicitly excluded installing all previously catalogued packages.

Runnable scripts, individual receipts, unsuccessful harness attempts, observed cleanup and exact limitations are preserved in each component dossier. The [machine-readable summary](summary.json), [independent review](review.json) and integrity index bind the final report to those files. Core source was unchanged, so the already completed 1,459-test full suite and 308-test offline subset were not needlessly repeated; they remain historical source-bound checks, not counts of the new extension function probes.

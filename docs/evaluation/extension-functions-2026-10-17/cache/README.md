# Pi Cache Optimizer Functional Checks

Date: 2026-10-17. Package: `pi-cache-optimizer@2.9.3`, loaded from the isolated evaluation prefix under Node 24.22.0. The package had already been installed there with lifecycle scripts disabled and its registry integrity checked in the earlier installation record.

The published `index.ts` entrypoint was imported with the Pi SDK's bundled `jiti` loader. The candidate's real default extension function registered hooks and a command on a synthetic `ExtensionAPI` harness; the harness then invoked those registered callbacks with fresh fixture contexts. The SDK was imported from its public package root. The context uses the public `sessionManager.getSessionId()` contract. No private extension state or session handle was accessed.

| Check | Result | Evidence |
|---|---|---|
| OpenAI-compatible `before_provider_request`: adds an opaque, bounded session cache key, returns a copy, preserves other fields, and leaves input untouched | PASS | `payload-openai` |
| `openai-codex-responses` bypass: returns no mutation and leaves input untouched | PASS | `payload-codex-bypass` |
| Zero-priced and unknown-priced `cache_warming_decision`: with Pi cache warming set to `off` and the extension's zero-price override disabled, both return no warming action | PASS | `warming-disabled-zero`, `warming-disabled-unknown` |
| Headless `/cache-optimizer fix prompt-cache` and `/cache-optimizer rollback`: both explain that UI confirmation is required, make no files, and request no confirmation UI | PASS | `commands-headless` |
| Synthetic assistant usage through the registered request, response, and `message_end` hooks: persists local cache counters; prompt/response marker text is absent from persisted JSON | PASS | `stats-synthetic` |

All six final attempts completed cleanup. Each recorded zero network attempts and zero child-process attempts. Temporary homes and workspaces were removed after their child processes exited. The runner supervises each case in its own process group, sends TERM at 15 seconds, and escalates to KILL after two seconds. Failed harness attempts are preserved alongside the successful attempts; the final evidence manifest below is the corrected run after fixing fixture bootstrapping, an overly strict statistics assertion, and the model fixture needed to reach the documented headless-fix branch.

The final independently reviewed run is [`cache-function-evidence-2026-10-17T13-42-18-175Z-215330e7-06a6-4666-af9c-2ecb214d8d71.json`](cache-function-evidence-2026-10-17T13-42-18-175Z-215330e7-06a6-4666-af9c-2ecb214d8d71.json), SHA-256 `8029fe14ab04d2de80a75977e50c01ca05b8be2e1090ee407ef67debfb3d4122`. All six receipts observe child close, an empty process group and removal of their marked temporary home before publication. The earlier PASS manifests are superseded for final qualification: review corrected an internal SDK import to the public package root, enabled cache keys equally in both API cases, supplied the actual prompt marker to the statistics case, counted confirmation requests, removed unrelated debug-directory deletion and added supervisor cleanup checks. The corrected six-case run passes. Original attempt records remain unchanged.

Runnable source is archived here in `runner.mjs` and `probe.mjs`. Prerequisite: Node.js 24.22.0 and the earlier isolated exact package installation. From the repository root, run `node docs/evaluation/extension-functions-2026-10-17/cache/runner.mjs`; it creates a fresh UUID-owned ignored result directory and a new evidence manifest. `PI_FUNCTION_NPM_ROOT` can identify an equivalent existing package prefix. [Archived receipt copies](receipt-archive.json) preserve exact original bytes and hashes.

This qualifies selected extension behavior against registered hooks using a fixture host. It does not measure cache-hit savings or prompt quality, exercise a real provider/model request, or qualify Pi's internal cache scheduler as a whole. The payload has no model-generated prompt or response, and the usage counters are synthetic. No live API calls or credentials were used.

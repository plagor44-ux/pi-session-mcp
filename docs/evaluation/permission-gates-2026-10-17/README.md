# Permission policy and hook checks

This record tests `@gotgenes/pi-permission-system@40.3.0` from the isolated package prefix with Node 24.22.0. The actual package entry loaded through the evaluation's SDK adapter. The setup used a fresh temporary home and workspace, a synthetic permission configuration, and the existing fixture provider. It made no provider requests and submitted no prompts.

The policy service was obtained through the package's documented root export `getPermissionsService(sessionId)`. The probe checked a general allow and deny, an allowed and denied path, a matching and unmatched MCP target, and the `ask` state for a headless bash operation. All seven states matched the configured policy.

For mediation, the probe called the actual registered `tool_call` handler through the SDK's public API: `AgentSession.extensionRunner.emitToolCall()`. The SDK declarations expose `AgentSession` at `dist/index.d.ts`, `extensionRunner` at `dist/core/agent-session.d.ts`, and `emitToolCall` at `dist/core/extensions/runner.d.ts` for the pinned SDK 1.2.0. The allowed fixture tool passed the hook; a denied write, a headless ask, and an unregistered tool were blocked. An in-memory synthetic counter advanced only after an unblocked result.

No actual executor ran. The evidence establishes deterministic policy resolution and hook mediation for these synthetic inputs. It does not establish operating-system sandboxing, enforcement inside collectors or tool implementations, live UI behavior, MCP transport enforcement, or interactive-client integration. The MCP checks cover the policy surface only; they did not connect to an MCP server. The adapter used print mode without a dialog-capable UI; no model prompt was submitted.

The final sanitized, process-supervised result is archived as [permission-gates-result-verified.json](permission-gates-result-verified.json); matching ignored run receipts have unique UUID filenames under `eval/results/`. Earlier successful public-seam receipts are preserved. The initial diagnostic receipt is retained as [superseded-initial-receipt.json](superseded-initial-receipt.json) because that attempt read a private adapter-handle field. The corrected probe injects the public SDK `createAgentSessionRuntime()` seam and captures its public `runtime.session` result.

Run the supervisor from the repository root with:

```sh
"$HOME/.local/opt/node-v24.22.0/bin/node" \
  docs/evaluation/permission-gates-2026-10-17/permission-gate-probe.mjs \
  eval/results/operator-selected-fresh-gate-archive.json
```

The archive path must be fresh; an existing path is refused before starting the worker. The supervisor requires worker exit, an empty worker process group, SDK disposal completion, the fixture's `session_shutdown` event, and removal of both temporary homes before it marks the result PASS. It configures a 45-second deadline, SIGTERM then SIGKILL escalation after one second, and a 64-KiB output cap. A triggered deadline forbids PASS. Neither limit was triggered in the successful run. The receipt is published only after cleanup checks. The exact attempt history, including the superseded private-field receipt and corrected harness assumptions, is in [attempts.json](attempts.json); hashes are in [integrity.json](integrity.json).

The JavaScript network/child-process guards are instrumentation, not an OS sandbox. The independent [review](review.json) confirms the narrow public-API and hook-decision scope.

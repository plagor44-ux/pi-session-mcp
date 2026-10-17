# Cursor skill activation component check

Date: 2026-10-17. Candidate: installed `pi-cursor-sdk@0.5.3`, public package manifest entry `./dist/index.js`. The runner invokes that real entrypoint in a synthetic Pi extension host and passes a synthetic Cursor provider/model context. The fixture uses a synthetic `ExtensionAPI` and public context shape; it does not run a provider turn.

| Check | Result |
|---|---|
| Extension registers `cursor_activate_skill`; local Cursor context with one visible fixture skill activates the tool and advertises it in the synthetic system prompt | PASS |
| Activation returns synthetic `SKILL.md` content and lists an ordinary `references/guide.md` resource | PASS |
| Unknown and `disableModelInvocation` skills are rejected | PASS |
| Symbolic-link resource is omitted from enumeration | PASS |
| `PI_CURSOR_PI_TOOL_BRIDGE=0` leaves activation inactive | PASS |
| Network and child-process attempts; process group after close; cleanup | 0; empty; PASS |

Final evidence: [`evidence-2026-10-17T13-42-04-909Z-01d70cb3-6897-46ca-b8aa-1c69d5b5c7fc.json`](evidence-2026-10-17T13-42-04-909Z-01d70cb3-6897-46ca-b8aa-1c69d5b5c7fc.json), SHA-256 `0bca36c569fa5e4ceea6abc451f1d969839e4168c0bf17436e2123fefe6ed900`. Final runner cleanup retains a scope if process termination is not observed, bounds stderr, and records actual removal of each owned case. Earlier harness bootstrapping attempts are retained as separate evidence and are not counted as candidate failures.

The runnable `runner.mjs` and `probe.mjs` are archived here. Prerequisite: Node.js 24.22.0 and the installed `pi-cursor-sdk@0.5.3` with its existing dependencies under `~/.pi/agent/npm/node_modules`. From the repository root, run `node docs/evaluation/extension-functions-2026-10-17/cursor/runner.mjs`. Each execution creates a fresh UUID-owned ignored result directory and an immutable evidence manifest here.

This checks registration and the `cursor_activate_skill` component using metadata and content created only in a temporary fixture. It does not run Cursor agent/model/cloud operations and does not qualify unrelated provider or tool behavior.

[Archived receipt copies](receipt-archive.json) preserve original bytes and hashes, including unsuccessful bootstrapping attempts. The final receipt binds both runnable script hashes.

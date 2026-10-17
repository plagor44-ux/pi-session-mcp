# Real OpenWiki Pi tools and standalone Web MCP functions

These are provider-free functional checks, executed under Node 24.22.0 on 2026-10-17. The final receipts bind the unchanged evaluation source digest, exact package entrypoint hashes, harness hashes and start/end times. No model prompt, provider request, external search or production repository write was performed.

## OpenWiki 0.7.2

[Final receipt](openwiki-final.json): **14 named checks PASS**. The production resolver loaded the exact installed Pi entrypoint through `SdkPiSessionAdapter`. An injected public SDK runtime factory captured the public `AgentSession`; the harness called the actual registered tool definitions with the public `extensionRunner.createToolContext()`. The fixture provider was selected only to create the session; no turn was submitted. This is a direct SDK component path, not an outer Pi Session MCP model turn.

All six Pi tools were invoked: `openwiki_begin`, `openwiki_submit_plan`, `openwiki_next_page`, `openwiki_inspect_page_claims`, `openwiki_submit_page`, and `openwiki_finish`. Their actual bridge launched the package's actual stdio MCP CLI child. In an owned Git fixture, the checks establish:

- Relative roots are rejected; the canonical fixture repository starts a planning run.
- A one-page canonical plan is accepted and can be repeated; a conflicting replacement is rejected.
- The pending page and its initially empty claims can be inspected.
- Finishing a pending queue and submitting an unwritten page are rejected.
- A controller-written synthetic page with a `repo://src/catalog.js#L1` evidence claim is accepted; the queue completes and finish returns `complete` without a source-change warning.
- The finished run rejects another queue call; the original source file remains byte-for-byte unchanged.

The extension's child was allowed only its exact executable and arguments. Fourteen bounded read-only Git commands ran against the fixture. One outgoing `fetch` attempt was denied by instrumentation; its purpose was not attributed, and explicit OpenWiki telemetry opt-outs do not prove that every dependency avoids network attempts. No network request was allowed in this OpenWiki run. The child closed, its process group was observed empty, and the owned temporary scope was removed before the receipt was published. This does not qualify retrieval quality, concurrent writers, or a production wiki.

## Pi Web Access 0.41.0

[Final receipt](web-final.json): **six named checks PASS**, including a passing assertion of a known integration blocker. The production Pi resolver still rejects this exact package's directory-valued extension manifest entry with `extension_load_failed`: **Pi-profile integration is BLOCKED**. The test does not bypass or repair that resolver contract.

The separately published standalone MCP executable was started using the real stdio client transport. All four tools were discovered: `web_search`, `fetch_content`, `get_search_content`, `source_check`. Only `fetch_content` and `get_search_content` were called. An owned HTTP fixture on one random loopback port returned a synthetic canary; raw fetch preserved it, and stored-content search retrieved it. Missing-URL and unsupported model-answer requests were rejected. Discovery is not execution evidence for `web_search` or `source_check`.

The temporary Web configuration explicitly allowed `127.0.0.1/32` through the package's documented SSRF configuration so the synthetic server could be fetched. No user Web configuration was changed. The guard allowed only the single fixture port; one local socket connection and one exact MCP child were observed. No external Web/provider call was allowed. Closing the client and server, empty process group and removal of the temporary scope all passed.

## Reproduction and attempt history

From the evaluation repository root with Node 24.22.0, the existing compiled `.profile-eval/` build, and the same already installed exact package pins:

```sh
node docs/evaluation/extension-functions-2026-10-17/bridges/run.mjs openwiki
node docs/evaluation/extension-functions-2026-10-17/bridges/run.mjs web
```

Each execution uses a fresh UUID result directory and owned temporary home/workspace. The supervisor bounds a run at 60 seconds, sends TERM then KILL, drains output, checks its Linux process group and removes only the owned scope. JavaScript network/child guards are instrumentation, not an OS sandbox. Candidate dependencies are trusted code within this narrow synthetic experiment.

[Attempt history](attempts.json) preserves all 12 attempts, including unsuccessful harness calibration and successful intermediate checks. Initial failures came from the default loopback SSRF refusal, a synchronous harness `fetch` rejection that differed from the native asynchronous API, missing `--no-pager` allowance for read-only Git, and a canonical page-path assertion. Their partial checks do not independently qualify the lifecycle. The two final receipts above supersede those diagnostics. The integrity index binds the archived receipts and final runnable scripts; older receipts retain their original information and are not retroactively assigned new timestamps or assertions.

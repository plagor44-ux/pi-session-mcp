# Remaining Pi extensions — audit and component checks

Date: 2026-10-17. This follow-on covers the six candidates named in AP6 plus the
already configured Cursor extension: **seven exact package identities**. It does
not invent the missing historical list of 25 packages or silently add forks.

All seven received static package/identity, version, license, declared SDK/peer,
install-script, data-path and headless reviews. The real production resolver was
executed for all seven pins. **OpenWiki additionally passed two provider-free
headless component cases** through the actual project adapter and installed Pi
SDK 1.2.0. A fresh-scope reproduction also passed. This is partial runtime
qualification, not a seven-extension runtime pass or a quality ablation.

No global/user install, production profile, authentication store, SDK upgrade,
deployment, external repository or approved screening result was changed. There
were **zero additional paid candidate runs and zero external provider calls**.
Registry metadata and published tarballs were downloaded for static inspection.
The earlier eight-run wave and its unknown actual cost remain unchanged.

## Exact matrix

| Candidate pin | Installed here | Executed check | Result and next prerequisite |
| --- | --- | --- | --- |
| `pi-lens@4.4.3` | No | Published-artifact static review; real resolver | BLOCKED: `extension_not_installed`. Declared Node floor is satisfied; wildcard Pi peers do not prove SDK compatibility. A future isolated run must control LSP/tool auto-install, grammar downloads, format/autofix writes and lazy tool activation. |
| `context-mode@1.0.169` | No | Published-artifact static review; real resolver | BLOCKED: `extension_not_installed`. Elastic-2.0, no Pi peer declaration. Its persistent session database, lazy MCP child and late tool registration require explicit host compatibility checks. No large-output bottleneck has been demonstrated. |
| `pi-cache-optimizer@2.9.3` | No | Published-artifact static review; real resolver | BLOCKED: `extension_not_installed`. Peer range includes SDK 1.2.0; README validation against 1.3.0 is not local qualification. Disable warming before testing: it can ask Pi to make extra, potentially billable provider requests. |
| `@gotgenes/pi-permission-system@40.3.0` | No | Published-artifact static review; real resolver | BLOCKED: `extension_not_installed`. Peer ranges include SDK 1.2.0. A future local test must exercise actual allow/deny/ask behavior, headless fail-closed handling and scoped logs. This is a decision layer, not an OS sandbox. |
| `pi-web-access@0.41.0` | Yes | Installed-versus-published file hashes; actual production resolver | BLOCKED: `extension_load_failed`. Its declared `./dist` entry is a directory, while this resolver requires a regular file. Neither the package pin nor the production resolver was changed or bypassed. |
| `openwiki@0.7.2` | Yes | Artifact binding; real resolver; actual SDK/adapter load, tool selection, local scripted turn and shutdown for read-only and coding | Component PASS, restricted scope. Six tools register; none are active in read-only, all six are active in coding. Writer/retrieval tools and its internal MCP child were not invoked. No quality benefit or single-writer enforcement is established. |
| `pi-cursor-sdk@0.5.3` | Yes | Artifact binding; real resolver; engine and source review | Resolver PASS, runtime BLOCKED: package requires Node >=24; the evaluated process is Node 22.23.2. Cursor's own SDK tool/MCP surfaces and persistence remain separate from Pi tool selection. No model request or Node upgrade was attempted. |

The matrix separates a reproducible resolver result from a runtime test that did
not start. The Cursor engine mismatch is a manifest-based compatibility gate,
not an observed import crash. Static peer-range inclusion is not a runtime PASS.
The four absent packages remain absent: the assignment requires loading installed,
exactly pinned allowlist entries and forbids solving missing installation by
automatic global installation. Downloaded tarballs were not added to Pi's install.

## OpenWiki headless component evidence

The [result](openwiki-headless-result.json) and
[input/probe bindings](openwiki-headless-bindings.json) record:

- The actual installed `openwiki@0.7.2` entry loaded through the production
  resolver and `SdkPiSessionAdapter`, using the real installed SDK 1.2.0.
- A second, explicitly identified local test-only extension supplied an in-memory
  fixture provider. This is test instrumentation, not B/C treatment selection or
  an external model route. No model credential was supplied.
- Fresh temporary HOME, agent/config/cache/data directories; telemetry opt-outs;
  no selected worker skills, package prompts or themes.
- Six `openwiki_*` tools registered. Read-only active tools stayed exactly
  `read`, `grep`, `find`, `ls`; coding exposed the approved built-ins plus the
  fixture tool and OpenWiki tools. The fixture's attempted tool widening did not
  broaden the read-only selection.
- Local scripted prompt completed; the fixture shutdown event ran. The candidate
  tools were never invoked. Instrumented network and child-process entrypoints
  recorded zero attempts; child exit was observed.

The probe deliberately does not call `openwiki_begin` or any other writer tool.
The installed entry starts its CLI/MCP bridge lazily from those callbacks, and
its shutdown hook does nothing when no bridge exists. Consequently this test
does not qualify that child, the wiki writer, connected sources, telemetry of
writer operations, multiple sessions sharing its module-level bridge, or retrieval
quality. Tool `executionMode: sequential` is a hint, not a concurrency lock.

Reproduce from the repository root, with existing project dependencies and the
same installed OpenWiki pin:

```sh
./node_modules/.bin/tsc -p tsconfig.eval.json
node docs/evaluation/extension-audit-2026-10-17/run-openwiki-headless-probe.mjs
```

The [supervisor](run-openwiki-headless-probe.mjs) creates a fresh owned scope and
result directory, supplies an isolated environment, bounds execution and observes
child exit. The [probe](openwiki-headless-probe.mjs) exercises the actual adapter.
The source-bound [reproduction result](openwiki-headless-reproduction.json)
preserves the second fresh-scope check. These JavaScript guards are
instrumentation, not an operating-system sandbox or proof that all native code
could be contained.

## Static findings that affect future tests

`pi-lens` ships code diagnostics/navigation plus auxiliary execution paths for
LSPs, formatters, autofix, grammar and tool acquisition. Its source has a project
trust guard, but propagation of that guard through this host has not run. It
tracks local diagnostics/session data; this audit does not prove the absence of
all optional outbound telemetry. [Artifact findings](navigation-static-evidence.json),
[registry/SRI inputs](navigation-cursor-registry.json),
[upstream source](https://github.com/apmantza/pi-lens).

`context-mode` persists prompt/tool-derived events and compaction snapshots and
starts its MCP bridge lazily at `before_agent_start`. That timing must be tested
against this adapter's earlier composed tool allowlist. Its bootstrap can degrade
best-effort; it must not be mistaken for a mandatory fail-closed policy. Its
global postinstall includes repair of other clients' plugin/settings registries;
no such script ran here. The shell HTTP routing regex is not a network security
boundary. [Artifact findings](navigation-static-evidence.json),
[upstream source](https://github.com/mksglu/context-mode).

The permission package's local logs may include command/tool-input previews;
name-based redaction is not a general secret detector. Cache-optimizer payload
rewrites, persistence, warming and interactive mutations each need their own
tests with synthetic events and no provider. These paths were reviewed, not
executed. The detailed [permission/cache report](permission-cache-report.md) and
[evidence](permission-cache-evidence.json) include exact pins and qualification
cases. The independently downloaded tarballs matched both registry SHA-512 SRI
and the other reviewer's SHA-256 hashes in
[artifact verification](permission-cache-artifact-verification.json).

Web Access is an external-data capability, not a free local navigation tool.
Search, fetching, summarization, optional browser-cookie auth and local result
state require an explicit research data path. The installed release's loader
failure cannot be repaired by silently taking newer upstream source. OpenWiki
is the verified LangChain package, distinct from `pi-openwiki`, and its workflow
can write repository/wiki and personal state. Its documented standalone telemetry
default is on; both telemetry opt-outs were set for the component probe. The
earlier [web/OpenWiki static report](web-openwiki-report.md) records its own
pre-smoke state; the component result above is the subsequent runtime evidence.

Cursor has its own local SDK agent, host tools, MCP configuration and durable
session stores. Pi's read-only allowlist does not disable those surfaces. Loading
that extension is not a native provider/model switch. The exact installed package
and Node requirement are recorded in [Cursor findings](cursor-static-evidence.json)
and the [published manifest](https://registry.npmjs.org/pi-cursor-sdk/0.5.3).

## Provenance, verification and remaining scope

[Installed metadata](installed-packages.json) and
[actual resolver outcomes](resolver-gates.json) cover all seven pins. Registry
`latest` was recorded as a timestamped observation for absent candidates; installed
Web Access, OpenWiki and Cursor were assessed at their existing pins. Verified
tarball integrity binds the published artifacts. For the installed packages,
[selected source files](installed-artifact-comparison.json) matched published
artifact bytes in all 11 comparisons. This is not a full transitive dependency
or supply-chain audit. The existing project source digest and eight-run evidence
were preserved. Documentation and probe artifacts have their own integrity index.

No live quality ablation was selected. The screening's strict receipt failures
did not demonstrate an LSP, large-output or cache bottleneck, and the pilot gates
remain unmet. T9 controlled compaction is still BLOCKED; context retention source
code is not an observed compaction test. Actual spend of the previous screening
remains unknown. New paid model runs need their own concrete matrix and budget;
none are hidden inside these component checks.

The runtime work left is specific: installed exact pins for four candidates,
a compatible published entry/loader decision for Web Access, and a supported Node
runtime for Cursor. OpenWiki writer/retrieval qualification needs a separate
synthetic single-writer task. None of these prerequisites is recorded as passed.

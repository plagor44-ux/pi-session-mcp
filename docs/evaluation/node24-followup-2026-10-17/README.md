# Node 24 and remaining Pi extension follow-up

The operator's 2026-10-17 approval covered the proposed user-local Node update,
explicit Pi/MCP interpreter binding and provider-free extension checks. It did
not authorize another paid quality wave. **Zero new model/provider calls** were
made; the original eight-run screening remains the complete live wave.

Node **24.22.0** is installed alongside the previous runtimes. Pi and the installed
MCP command explicitly use it; the actual Codex and Claude user MCP registrations
also now point directly to that Node executable. Existing client connections
require a client restart/reconnect. System Node 22 was preserved. Direct client
registrations do not modify child PATH. Full details, verification, ownership and
restoration instructions are in the [runtime report](node-runtime-report.md).

All four previously missing candidates were installed only in the owned isolated
evaluation prefix, with exact pins, registry integrity checks and npm lifecycle
scripts disabled. They were not activated in production profiles or added to
global Pi settings.

| Extension | Tested here | Result and limit |
| --- | --- | --- |
| `pi-lens@4.4.3` | Read-only + coding, real resolver/SDK | Load, registration, allowlist and disposal PASS; tools not invoked |
| `context-mode@1.0.169` | Read-only + coding, real resolver/SDK | PASS with one bounded Git metadata query; context compression/MCP not exercised |
| `pi-cache-optimizer@2.9.3` | Read-only + coding, real resolver/SDK | PASS with cache warming disabled; savings not measured |
| `@gotgenes/pi-permission-system@40.3.0` | Read-only + coding, real resolver/SDK | Load/bind PASS; permission enforcement not exercised |
| `pi-cursor-sdk@0.5.3` | Read-only + coding under Node 24 | Restricted component PASS; two process attempts denied, no Cursor model/tool call |
| `openwiki@0.7.2` | Earlier restricted component test under Node 22 | PASS for earlier load/selection/disposal scope; internal MCP/writer not exercised |
| `pi-web-access@0.41.0` | Earlier actual resolver gate | BLOCKED: package declares a directory extension entry; standalone MCP untested |

See the [machine-readable matrix](extension-summary.json),
[four-package report](isolated-extensions-report.md) and
[Cursor report](cursor-headless-report.md) for exact receipts and retained failed
harness/diagnostic attempts. JavaScript API guards are instrumentation, not an OS
sandbox. These results do not establish feature quality, savings, policy safety,
provider compatibility or production qualification. Other configured Pi packages
remain inventory-only; this follow-up covers the six assignment candidates plus
the configured Cursor comparison.

MCP verification covered the installed Pi-session server's initialize,
`tools/list` and `pi_capabilities_get` paths. Its eight advertised tools were
listed; no session-start/prompt path or external extension MCP was invoked in this
follow-up. Worker skills were empty. This is separate from the historical live
baseline and provider-free fixture suite.

The Node-24 full suite passed **1,459 tests**, with six skips and zero failures
across 60 files. The standalone offline CLI passed **308/308**; these test sets
overlap. Typecheck and both builds passed. The [check record](node24-checks.json)
binds the results to the unchanged evaluated source digest
`sha256:686887d57899c2e55593bb7dd98b78be08ea0fc6c471a6dd4eab3298f890d160`.
The [closure checks](closure-checks.json) and [integrity index](integrity.json)
cover this dossier and preservation of earlier evidence.

No package release, SDK upgrade, git commit, push, deployment, authentication-store
change or production-profile edit was performed. A new paired live ablation needs
its own concrete matrix and budget; the earlier eight-run allowance is exhausted.

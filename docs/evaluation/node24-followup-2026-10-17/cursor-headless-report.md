# Cursor extension headless component check

Date: 2026-10-17. The installed `npm:pi-cursor-sdk@0.5.3` was loaded through
the production resolver and the actual `SdkPiSessionAdapter` with Node.js
24.22.0. A local in-memory fixture provider was included only to satisfy Pi's
session model/auth preflight. It was not prompted, and no Cursor model, Cursor
tool, cloud endpoint, MCP tool or external provider was invoked.

The read-only and coding session cases both passed extension resolution, SDK
load/bind, provider registration, tool-policy selection and shutdown. The
extension registered `cursor_activate_skill`. In the observed read-only case,
only `read`, `grep`, `find` and `ls` were active. In coding, only the coding
built-ins and the local fixture tool were active; the Cursor tool remained
inactive. No skills, prompt templates or themes loaded. No tool or model turn
ran. Exact Node, peer, Cursor SDK dependency versions, package lock integrity,
and installed manifest/entrypoint hashes are recorded in
[`cursor-headless-result-attempt-4.json`](./cursor-headless-result-attempt-4.json).

The probe observed zero network attempts. It intercepted two child-process API
attempts during extension session setup; both were denied before a process
started. Their originating call sites were not captured, so this report does
not attribute them to the extension versus a dependency. The outer supervisor
started the Node 24 probe process and observed its exit. It removed the entire
fresh temporary HOME and workspace after exit. No existing HOME, Cursor
settings, profile or credential store was read or changed.

Two earlier local attempts are preserved as audit evidence: attempt 1 had a
probe stdout-guard receipt bug; attempts 2 and 3 had an overly strict assertion
that expected the registered Cursor tool to be active in coding. The final
check corrected both harness assumptions and records the actual active tool
set. They caused no provider requests or Cursor tool calls.

This qualifies only loading, binding, registration, the selected active tool
sets and orderly shutdown under the instrumented Node 24 test setup. It does
not qualify Cursor authentication, Cursor model requests, cloud or MCP
execution, skill activation, persistence semantics, or OS-level containment.
The JavaScript network and child-process hooks are observation/denial
instrumentation, not an OS sandbox. No live model run or quality ablation was
performed.

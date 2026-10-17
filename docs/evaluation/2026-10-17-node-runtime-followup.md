# Node runtime follow-up — 2026-10-17

The four absent Pi packages were rechecked at their exact user-scope Pi install
paths: `pi-lens`, `context-mode`, `pi-cache-optimizer` and
`@gotgenes/pi-permission-system` remain absent. The audited candidate pins are
4.4.3, 1.0.169, 2.9.3 and 40.3.0 respectively. No package was installed.

The evaluation process still resolves Node 22.23.2 from the system Node binary;
the OS package is `nodejs 22.23.2-1nodesource1`. However, a separate user-local
Node 24.20.0 binary already exists and its version command succeeded. Thus the
earlier Cursor engine gate concerns the selected Node 22 process, not absence of
every compatible Node runtime on the host.

The `pi-session-mcp` executable uses an `env node` shebang. A scoped PATH selecting
the existing Node 24 installation can therefore select the appropriate interpreter
for evaluation/MCP processes without replacing the system package. The Pi CLI
launcher also checks its own managed runtime path first; that optional runtime
was absent in this inspection, so launcher/runtime selection must be verified for
each actual entry point. Changing a shell does not change an already running
server's interpreter.

Node's [official download page](https://nodejs.org/en/download) reports 24.22.0
as the current 24 LTS release at inspection time. A durable refresh can add the
verified official Linux artifact alongside existing runtimes, then explicitly
select that runtime for Pi/MCP entry points. This avoids changing unrelated
services as a side effect. No download, install, system package update, PATH or
launcher modification was made in this follow-up.

Only binary version checks ran under Node 24. No SDK, Cursor import, extension
tool, model request or Node 24 compatibility suite was executed. The prior
[extension evidence](extension-audit-2026-10-17/README.md) remains a historical
record of the actual Node 22 checks. A selected Node 24 runtime removes that
declared engine prerequisite; it does not establish Cursor compatibility or safety.

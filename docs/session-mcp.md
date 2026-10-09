# External MCP tools in embedded sessions

Embedded Pi sessions do not inherit a normal Pi CLI's MCP bridge.
`pi-session-mcp` supports explicitly configured **local stdio MCP servers** in
execution profiles. It connects and discovers the granted tools before constructing
the Pi session, supplies their definitions as `customTools`, and includes the
names in Pi's explicit active `tools` list. The selected tools are verified again
before the session is returned.

Global/project extensions remain disabled (`noExtensions: true`). Installing
`pi-mcp-adapter` globally is neither required nor sufficient for this integration.
There is no automatic import of global MCP configuration or ambient credentials.
Profiles without `mcpServers` keep their existing built-in tool sets and launch
no MCP child process. The public `pi_session_start` input remains unchanged: callers
select configured aliases, not commands, filesystem paths, servers, or credentials.

## Configuration

Add `mcpServers` to a profile in the operator-owned `pi-session-mcp.json`. The following
is a complete illustrative config; replace the executable, server entrypoint,
workspace, provider and model with real local values. Use absolute executable and
server-entrypoint paths, not a workspace-owned script or an unpinned package runner.

```json
{
  "workspaces": {
    "project": "/absolute/path/to/project"
  },
  "executionProfiles": {
    "safe-readonly": {
      "default": true,
      "permissionProfile": "read-only",
      "provider": "your-configured-provider",
      "model": "your-configured-model",
      "thinkingLevel": "off",
      "mcpServers": {
        "knowledge": {
          "command": "/absolute/path/to/node",
          "args": ["/absolute/path/to/knowledge-server.mjs"],
          "envFrom": {
            "API_KEY": "KNOWLEDGE_MCP_API_KEY"
          },
          "tools": {
            "search": { "name": "search_knowledge", "readOnly": true },
            "inspect": { "name": "inspect_artifact", "readOnly": true }
          }
        }
      }
    }
  }
}
```

The example's `thinkingLevel: "off"` selects a Pi session setting, not a
provider-side reasoning budget. Session creation post-verifies the selected
provider, model, and effective `thinkingLevel`; it does not verify provider-side
reasoning. A provider may use reasoning tokens with `off`. Pi Session MCP does not
project thinking content or provider-side reasoning-token counts.

`envFrom` maps a child environment variable to the **name** of an existing host
variable; it does not contain a secret value. Omit it for a server needing no
credentials. Missing referenced variables fail session creation without exposing
names or values in public errors. Commands, arguments, environment references and
MCP configuration are not projected through the capabilities or session API.

The child receives the configured workspace as its working directory. Its
environment consists of the MCP SDK's small OS-default set plus the explicit
`envFrom` values, never all of `process.env`. Child stderr is drained without
copying it into controller stdout/stderr; controller stdout remains MCP-only.
Successful, deliberately requested tool results can of course contain server data.
Review the server and the granted tools before making that data available to a model.

The model sees `mcp_knowledge_search` and `mcp_knowledge_inspect` in addition to
`read`, `grep`, `find` and `ls`. The bridge maps these stable local names to the
exact remote names. A different tool returned by `tools/list` is not exposed.
The configuration is one immutable snapshot loaded when the controller process
starts. Editing the file does not change that snapshot, so starting another Pi
session in the same controller still uses the loaded grants and profile values.
The controller performs fresh external tool discovery for each new session;
catalog changes can therefore appear within those already loaded grants, while
tools outside the grants remain unavailable. A running session keeps its active
names. Loading configuration edits requires a genuinely new controller process,
which loses all in-memory sessions. Merely reconnecting a client is sufficient
only when that reconnect actually starts a new controller process. There is no
implicit discovery of additional servers, wildcard grant, persistence, or
reconnect/resume semantics.

The configuration fingerprint is SHA-256 over the exact bytes read from the
selected configuration file, including whitespace, indentation, and final
newline. It is not a freshness check: it does not report edits to the current
file, server reachability, provider availability, or catalog state. To compute
the same value offline without adding a public CLI, an operator can run this
portable Node expression (replace the path; it reads once):

```sh
node -e 'const fs=require("node:fs");const c=require("node:crypto");try{const b=fs.readFileSync("/absolute/path/to/pi-session-mcp.json");process.stdout.write("sha256:"+c.createHash("sha256").update(b).digest("hex")+"\n")}catch{process.stderr.write("configuration_fingerprint_unavailable\n");process.exitCode=1}'
```

On success it prints only `sha256:<64 lowercase hex>` to stdout. On failure it
prints only the fixed, path/content-free error `configuration_fingerprint_unavailable`
to stderr and exits nonzero.

## Startup diagnostics

Startup failures use four stable sanitized codes: `external_mcp_unavailable`
means connection, transport, protocol, schema, or other unknown startup
failure; `external_mcp_no_tools` means a server completed valid discovery but
returned no tools while grants were required; `external_mcp_grant_tool_missing`
means valid nonempty discovery omitted a configured grant; and
`external_mcp_activation_mismatch` means the Pi session's active tool set did
not exactly match the expected set. Optional diagnostics contain only a
validated local server/tool alias and a bounded discovered-tool count where
applicable. They never promise or reveal remote paths, commands, stderr,
responses, server reachability, or catalog details beyond that safe summary.

## Permission and trust boundary

Every grant requires an explicit `readOnly` boolean. Read-only profiles reject
any `readOnly: false` grant, including profiles constructed directly at the adapter
boundary. Coding profiles may use either kind. MCP `readOnlyHint` or other server
annotations never grant permission and cannot override the operator's allowlist.

**This is an operator assertion, not an OS sandbox or a proof of server behavior.**
A launched MCP server is trusted local executable code and runs under the
controller's OS identity. Even initialization can have side effects. A mislabeled
read tool, compromised executable or server with overly broad credentials is not
made safe by this configuration. Use dedicated credentials and external process
isolation where stronger boundaries are required. Do not grant a generic tool that
can dispatch arbitrary unreviewed operations and assume that its name is a boundary.

Only local stdio tools are covered here. HTTP/SSE/OAuth transports, sampling,
elicitation, roots negotiation, separate resource/prompt APIs and global extension
loading are not added. MCP tool invocations are marked sequential within Pi's tool
execution policy; this is not a cross-session or remote-resource locking mechanism.

## Failure, cancellation and cleanup

Each session owns its own client and child process for each configured server.
There is no client pool shared across sessions. Configuration is copied and frozen.
Startup fails closed if any required connection, catalog page, grant, input schema,
or SDK tool activation is unavailable. Previously opened connections are closed;
there is no partial session that silently lacks its configured tools.

Limits: 8 servers and 64 granted tools per profile; 16 catalog pages and 512
discovered tools per server. Server/tool aliases are limited to 24 characters and
composite-name collisions are rejected. Tool input JSON Schemas are preserved for
Pi's argument validation rather than replaced with an untyped parameter bag.

MCP startup has a 10-second budget; each call has a 30-second budget. These are
MCP-specific budgets, not a promise about total provider/session startup duration.
The close bound is 4.5 seconds, allowing the stdio SDK's 2-second EOF and 2-second
SIGTERM windows before SIGKILL, within the registry's existing 5-second cleanup
bound. Shutdown cancellation reaches connections even while SDK construction is
still pending. Late initialization is observed and cleaned without starting more
servers. The registry awaits bounded asynchronous disposal, including orphan handles
from a start that races shutdown. Child processes created independently by an MCP
server remain that server's responsibility; this is not a general process-tree reaper.

Caller cancellation is forwarded and immediately ends the bridge's wait. Closing a
session cancels in-flight calls, refuses new calls and closes connections
idempotently. Cancellation or timeout does **not** roll back remote side effects.
Transport/protocol errors and MCP `isError` results become failed Pi tool executions
with sanitized error messages, not successful text responses.

### Bounded tool-error projection

The bridge recognizes only the allowlisted remote error code `SOURCE_TOO_LARGE`.
Its failed Pi tool execution carries controller-generated JSON:

```json
{"code":"SOURCE_TOO_LARGE","message":"Requested source exceeds the response limit; increase maxBytes."}
```

This is an internal tool error available to the Pi agent so it can correct its
request to the same granted tool. It adds no public MCP tool, response field,
turn state or terminal error code. The SDK marks the tool result as an error;
the agent can recover and complete the turn. A terminal failed turn still exposes
only `turn_failed` / `Pi turn failed` as documented in `tool-contracts.md`.

Projection requires `isError: true`, a serialized error-result envelope of at
most 1 KiB UTF-8 and a closed `{code, message}` object with string values.
The incoming message has 1–200 Unicode code points and must contain no control or
format characters, paths, URL schemes or domain-like indicators. No foreign
message text is forwarded: even ordinary
text is replaced by the controller constant. A matching uppercase-code regex
or truncating foreign text would still allow sensitive content through, so neither
is an authorization rule.

Accept one JSON text block, structured content with empty content, or both when
their validated objects agree. Additional fields/blocks, unknown codes, malformed
types, non-JSON, oversized data, unsafe text or conflicting representations use
only `External MCP operation failed`. Duplicate JSON keys are rejected in the
raw text block. `structuredContent` has already been decoded by the MCP SDK, so
its original wire-level duplicate keys are unobservable here; validation covers
the decoded object's closed shape, not raw-frame validation.

Transport/protocol errors and lookalike foreign exceptions stay generic. Only
the controller's own per-execution error can leave the catch unchanged. Timeout,
cancellation and session close override projection; late responses cannot revive
a call or session. Limits apply after protocol decoding and do not establish a
streaming memory sandbox against the trusted child.

Text results are forwarded as text and structured results retained as structured
details. Other MCP content blocks are explicitly represented as JSON text, not
rendered as native image/audio inputs.

### Successful-result size limit

The fixed limit is 262,144 bytes (256 KiB) of the complete serialized MCP result
envelope, measured as `Buffer.byteLength(JSON.stringify(result), "utf8")`.
JSON escaping, metadata, structured content and text all count; the source-file
size and a remote tool's `maxBytes` argument do not determine this envelope size.
An envelope exactly at the limit is accepted. A larger successful result becomes
a failed Pi tool execution with this controller-owned message:

```text
External MCP result exceeds the bridge limit of 262144 bytes; request less data.
```

Request a smaller source or less data if the granted tool supports it. Increasing
the remote `maxBytes` cannot raise this bridge limit. There is no configuration
setting to change it; a limit change requires a reviewed source change to
`MAX_RESULT_BYTES` in `src/mcp-session-tools.ts` and its boundary tests. Results
are rejected rather than silently truncated. No remote payload, measured size or
new public terminal error code is forwarded. Oversized remote `isError` envelopes
still use the separate 1 KiB error policy above and remain generic. Timeout,
cancellation and session close take precedence over the local size diagnosis.
This limit applies after protocol decoding, not as a streaming memory sandbox
against a hostile child process.

## Validation before merge and deployment

The regression suites are provider-free:

```sh
npm ci
npm run typecheck
npm run build
npm run build:cli
npm test
```

`test/mcp-session-tools.test.ts` covers policy, discovery, mapping, result/error
handling, cancellation, deadlines, shutdown and per-session ownership.
`test/mcp-registry-cleanup.test.ts` covers asynchronous disposal and shutdown races.
`test/process-stdin-eof.test.ts` starts the freshly compiled server entry point with
a placeholder loopback provider and checks that stdin EOF, alone or racing `SIGTERM`,
closes idle, running and still-starting sessions and their MCP children.
`test/mcp-sdk-integration.test.ts` covers config/capabilities and adapter wiring with
a fake model runtime and fake MCP connection. It is not a live protocol test.
`test/mcp-error-projection.test.ts` exercises the pinned Pi SDK and a real local
stdio fixture with a scripted model runtime. Its error/correction, redaction and
lifecycle cases are provider-free; they are separate from real client/model
acceptance.

After the dependency-backed suite passes, repeat the issue's reproduction against
the installed knowledge server: start the configured read-only profile, list tools,
call both approved tools, close the session and verify the child has exited. Also
try an invalid executable or missing tool grant: start must fail without exposing
configuration/secrets. No live-provider validation is implied by the unit tests.

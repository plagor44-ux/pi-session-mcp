# Static audit: Pi Web Access and OpenWiki

Date: 2026-10-17. Scope: installed `npm:pi-web-access@0.41.0` and
`npm:openwiki@0.7.2`, their package metadata, documentation and selected
compiled entrypoints. No package was installed, imported, initialized or run;
no provider, network search or extension tool was invoked. The registry metadata
was queried read-only with `npm view`, and official npm pages / upstream
repositories were checked. Hashes and the lockfile integrity values are in
[`web-openwiki-evidence.json`](./web-openwiki-evidence.json).

## Findings

### `pi-web-access@0.41.0`

The installed package is the intended Nico Bailon project at
[`nicobailon/pi-web-access`](https://github.com/nicobailon/pi-web-access),
published on npm under the same name, MIT licensed, and pinned to 0.41.0 in
Pi's package lock. The version's official npm metadata declares Node.js
`>=22.19.0`, which the current Node 22.23.2 runtime satisfies. It declares
wildcard peers for Pi AI, coding-agent, TUI and TypeBox, so its manifest does
not establish compatibility with any particular Pi SDK release.

There is a concrete local loader blocker for this exact installed release:
its manifest declares `pi.extensions: ["./dist"]`, but this repository's
resolver requires every declared entry to resolve to a regular file. The local
`dist` target is a directory, so resolving this pin fails with
`extension_load_failed` before extension code can load. The current upstream
`main` package manifest has already changed to `./index.ts` (and reports
0.42.0), which is a different package state; that does not repair or authorize
silently substituting the installed 0.41.0 pin. A controlled test requires an
explicit decision to update the pin and align package entrypoint policy, or a
resolver change followed by review. The static audit did not alter either.

The package exposes web search, URL fetch/content extraction, GitHub fetching,
PDF and video tools; it also ships a standalone stdio MCP executable. Calls can
send queries, URLs and retrieved content to selected external search/fetch or
model providers. Provider routing is configurable; documented default search
uses automatic provider selection, and the package can reuse Pi's OpenAI/Codex
auth. Its README distinguishes `workflow: "none"` (no summarizer model call)
from summary workflows, while search providers themselves may be model-backed.
This makes even a nominal search test a real external web request with data
disclosure. It should be tested only against a synthetic, explicitly selected
provider/endpoint or a local stub, with no real research query and no existing
credential use. The static audit did not inspect or read any credential file.

README configures the extension via its own `web-search.json`, can read provider
credentials through Pi auth or environment/configuration, and can optionally
use browser cookies for Gemini Web. It documents a curator/browser workflow and
local activity/results state. This is not a read-only capability overall:
fetching is network read, but local curator/history/config state may be written.
No package-wide outbound telemetry was established from the inspected source;
that is not a proof that every optional provider path is telemetry-free.

### `openwiki@0.7.2`

The installed package is LangChain's
[`langchain-ai/openwiki`](https://github.com/langchain-ai/openwiki), not the
unrelated [`pi-openwiki`](https://github.com/barvhaim/pi-openwiki) project.
The npm identity, repository URL, version, MIT license and Pi integration path
agree across installed metadata and the npm registry. It pins
`pi.extensions: ["./dist/integrations/pi/openwiki.js"]`; that local path exists
as a regular file and passes this repository's static path/type check. The
integration registers six sequential lifecycle tools and starts the package's
own CLI as a local stdio MCP child when a tool is first called. It closes that
child on Pi session shutdown. It does not register itself as a provider-backed
agent; the documented host-driven mode uses the host agent's own model and
repository tools.

OpenWiki has an explicit minimum Node version of 22.22.0, so the current
22.23.2 runtime qualifies. The package has no Pi SDK peer dependency; its
manifest declares optional peers for Mermaid and jsdom only. Its integration
uses `pi.registerTool`, `pi.on("session_shutdown", ...)`, tool schemas and
`executionMode: "sequential"`. That is evidence of the expected host API shape,
not proof that the installed Pi version accepts the integration at runtime.
The local Pi launcher reports version 1.1.0; compatibility with Pi 1.2.0 has
not been runtime-tested.

OpenWiki's lifecycle can create and update a repository wiki, including
Markdown pages, indexes, provenance and setup metadata; its personal/connectors
mode can persist source data and a personal wiki. The six Pi tools are a
stateful writer workflow, even though the package advertises local read-only
discovery tools elsewhere. The tool `executionMode: "sequential"` annotation
expresses the single-writer sequence but is a host hint, not an independent
authorization or concurrency boundary. The integration's bridge itself is
shared within the Pi process. Test first on a fresh synthetic repository and
temporary OpenWiki home, with a single caller, host model calls disabled or
stubbed, and inspect all writes. Do not point it at an existing wiki or
connected source during compatibility testing.

OpenWiki's own docs say anonymous aggregate telemetry is on by default for
standalone `init`/`update` runs. The inspected payload fields include command,
outcome, coarse error classification, setup mode/provider/connector names,
build metadata and a random install ID; docs say it excludes file contents,
repository names/data, credentials, prompts, outputs, paths, URLs and model
IDs. Opt-out is documented through `OPENWIKI_TELEMETRY_DISABLED=1` or
`DO_NOT_TRACK=1`. The Pi bridge launches `openwiki mcp --host pi`; the inspected
integration itself does not invoke telemetry directly, and documented
host-driven lifecycle tools are separate from standalone generation. A runtime
network trace would be needed to prove the exact telemetry behavior of this
installed build and path. For testing, set both opt-outs in the child
environment and block egress except to a local stub.

## Test decision

Neither extension has been behaviorally tested in this audit. OpenWiki is
statically loadable by the current resolver and is the better candidate for a
provider-free API compatibility smoke test; its mutating lifecycle still needs
a synthetic repository and temporary state/home before exercising writer
tools. `pi-web-access@0.41.0` is blocked at extension resolution under the
current resolver because its declared entry is a directory. Its standalone
MCP executable is a different integration path and should not be treated as a
successful Pi-extension test. Both projects are distinct and verified by
repository identity; no similarly named package was substituted.

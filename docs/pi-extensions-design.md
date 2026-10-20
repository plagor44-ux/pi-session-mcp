# Pi extensions design

Status: approved by the owner on 2026-10-11 for implementation. Tracking issue:
[#34](https://github.com/plagor44-ux/pi-session-mcp/issues/34).

> **Amended by [ADR 0007](adr/0007-profile-skill-selection.md).** This design
> assumed that `noSkills` and the other `no*` options keep skills, prompt
> templates and themes out of every session. With Pi SDK 1.1.0 that did not hold
> for resources that an allowlisted extension package ships. An extension
> allowlist now makes none of them available; a skill reaches a session only
> through the operator's `skillCatalog` and the profile's `skills`. See
> [Pi skills](skills.md).

## Goal

An operator can allowlist Pi extensions per execution profile. A profile that
names an extension gets an embedded Pi session in which that extension is
loaded with its full capabilities: providers, tools, hooks and system-prompt
changes. The first target is `pi-cursor-sdk`, which registers the `cursor`
provider; other provider extensions follow the same path.

Success means:

- a `cursor` profile works end to end through `pi_session_start`,
  `pi_session_prompt`, `pi_turn_get` and `pi_session_close`, including two
  parallel `cursor` sessions;
- Doctor reports a missing or mismatched extension offline, without running
  extension code;
- profiles without `extensions` keep their session-creation path; their only
  change is that prompts pass `expandPromptTemplates: false`, which has no
  effect without templates, skills or extensions;
- stdout carries only MCP frames even when an extension writes to it;
- automated tests need no credentials and no network.

## Non-goals

- Extension sources other than npm packages installed by Pi (`git:`, local
  paths, URLs).
- Installing or updating extensions. Pi owns that (`pi update --extensions`).
- Version ranges or "latest". A version is pinned exactly.
- Pi's built-in extensions (`mcp`, `codemode`, `tool-search`, `llama.cpp`).
  pi-session-mcp keeps its own `mcpServers` bridge.
- Extension CLI flags (for example `--cursor-runtime`) and extension UI. Flags
  keep their defaults; UI calls go to the SDK's no-op UI.
- Extension slash commands triggered by client prompt text.
- Process isolation of extension code. Extensions run in the server process.

## Owner decisions

| Question | Decision |
| --- | --- |
| Capability scope | Full: providers, tools, hooks, system-prompt changes. |
| Naming and pinning | `npm:<name>@<exact version>`, resolved from Pi's user install; any other installed version fails closed. |
| Granularity | Per execution profile. |
| `read-only` profiles | Extensions allowed; read/grep/find/ls plus granted MCP tools and individually granted extension tools (ADR 0010). |
| Integration approach | Pi SDK session lifecycle API (`createAgentSessionServices`, `createAgentSessionFromServices`, `AgentSessionRuntime`). |

## Current behavior and constraints

`createPhase0ResourceLoader` (`src/sdk-pi-adapter.ts`) builds a
`DefaultResourceLoader` with `noExtensions: true`, no skills, templates or
themes, and a disabled system prompt. `SdkPiSessionAdapter.create` resolves
provider, model, authentication and availability against one `ModelRuntime`
shared by the sessions of profiles without extensions (a profile with
`extensions` gets a runtime of its own, see *Session creation*), and only then
builds the resource loader and calls `createAgentSession`. This describes the
state before this feature; ADR 0007 later added the skill selection.

Facts about Pi SDK 1.1.0 that shape this design, verified against the
installed package:

1. An extension's `registerProvider` calls are queued at load time and applied
   to the `ModelRuntime` when the session's extension runner binds its core,
   which happens inside session construction. A provider check that runs before
   the session exists does not see an extension provider.
   `createAgentSessionServices` applies the queued registrations to the
   services' runtime, so the provider is visible before the session exists.
2. Provider registrations are global to a `ModelRuntime` instance; the last
   registration for an id wins. `pi-cursor-sdk` fails sibling sessions that
   share a runtime with `CURSOR_PROVIDER_OWNERSHIP_ERROR`. An extension session
   therefore needs its own runtime.
3. `createAgentSession` does not emit `session_start`; only
   `session.bindExtensions()` does. `pi-cursor-sdk` refuses to stream until it
   has seen `session_start`.
4. `AgentSession.dispose()` does not emit `session_shutdown`;
   `AgentSessionRuntime.dispose()` does. `pi-cursor-sdk` registers cleanup on
   `session_shutdown`.
5. `session.prompt(text)` dispatches extension slash commands unless it is
   called with `expandPromptTemplates: false`.
6. With an explicit `tools` list, every tool, extension tools included, is
   filtered by the session's allowlist.
7. `noExtensions: true` suppresses settings and auto-discovered extensions but
   still loads `additionalExtensionPaths`.
8. `DefaultPackageManager.resolve()` runs `npm install` for missing or
   mismatched npm packages, and `getInstalledPath(source, "user")` falls back
   to a synchronous `npm root -g` on a miss and accepts legacy global
   installs; neither is side-effect free.
9. Skills, prompt templates and themes that an allowlisted extension package
   ships reached the session although `noSkills` was set (ADR 0007).
   `loadSkills` removes duplicate skill names before `skillsOverride` runs.
10. `pi-cursor-sdk` and `@cursor/sdk` call `console.log`. In a stdio MCP server
    such output corrupts the protocol stream.

The relevant SDK functions are root exports of
`@earendil-works/pi-coding-agent`: `createAgentSessionServices`,
`createAgentSessionFromServices`, `createAgentSessionRuntime`,
`AgentSessionRuntime`, `getAgentDir` and
`ModelRuntime`. No internal module is imported.

## Design

### Configuration

Every execution profile accepts an optional `extensions` array:

```json
"code-cursor": {
  "default": false,
  "permissionProfile": "coding",
  "provider": "cursor",
  "model": "<cursor-model-id>",
  "thinkingLevel": "high",
  "extensions": ["npm:pi-cursor-sdk@0.5.3"]
}
```

Rules, enforced by `configSchema`:

- Each entry matches `npm:<name>@<version>`. `<name>` is an npm package name,
  optionally scoped (`@scope/name`), lowercase. `<version>` is an exact semver
  version with an optional prerelease. Build metadata (`+build`) is rejected
  because npm does not keep it in a published version, so such a pin could
  never match the installed manifest; the configuration fails with
  `config_invalid` instead of every session failing with
  `extension_version_mismatch`. Ranges, tags, `git:`, paths and URLs are
  rejected.
- At most 8 entries per profile. A package name appears at most once per
  profile.
- The field is allowed on `read-only` and `coding` profiles, including the
  default profile.
- An invalid entry fails the whole configuration with
  `invalid_execution_profile_config`, like every other schema violation.

The parsed profile keeps `extensions` as a frozen array of
`{ name, version }` pairs plus the original spec string. The configuration
fingerprint already covers the field because it hashes the file bytes.

### Extension resolution

A new module `src/pi-extensions.ts` owns resolution. It is used by the adapter
and by Doctor.

`resolveExtension(spec, dependencies)`:

1. Computes Pi's user install location `<agent dir>/npm/node_modules/<name>`,
   with the agent directory from `getAgentDir()`. It never calls the SDK
   package manager, never spawns npm and never installs. A package installed
   anywhere else counts as not installed.
2. No path: `extension_not_installed`.
3. Reads `<dir>/package.json`. Unreadable or invalid JSON:
   `extension_load_failed`. A `version` that differs from the pinned version:
   `extension_version_mismatch`.
4. Reads `pi.extensions` from the manifest. It must be a non-empty array of
   relative paths. Every entry must resolve, after symlink resolution, to a
   file inside the real package directory. Otherwise: `extension_load_failed`.
   `pi.extensions` entries must be plain relative file paths; globs and
   overrides, which Pi accepts, fail with `extension_load_failed`.
5. Returns the real package directory. The SDK receives that directory, not
   the `npm:` source, so it cannot start a temporary install.

Dependencies (install-location lookup, file reads, real-path resolution, stat) are
injectable for tests.

### Session creation

Profiles without `extensions` keep today's path unchanged: shared runtime,
`createPhase0ResourceLoader`, `createAgentSession`.

For a profile with `extensions`, `SdkPiSessionAdapter.create` runs:

1. **Resolve.** Resolve every extension as above.
2. **Runtime.** Create a fresh `ModelRuntime` for this session through the
   existing `modelRuntimeFactory`. It reads Pi's normal authentication store.
3. **Services.** Call `createAgentSessionServices` with that runtime, the
   workspace as `cwd` and `agentDir`, an in-memory untrusted settings manager,
   and resource-loader options identical to `createPhase0ResourceLoader` plus
   `additionalExtensionPaths` set to the resolved package directories. Any
   services diagnostic of type `error`, or an exception, is
   `extension_load_failed`.
4. **Checks.** Run the existing provider, model, `checkAuth`, `getAuth` and
   `getAvailable` checks against the services' runtime, with the existing
   error codes and deadlines.
5. **External MCP tools.** Connect configured `mcpServers` as today.
6. **Session.** Call `createAgentSessionFromServices` with the model, thinking
   level, an in-memory session manager, the tool list (see Tools) and the MCP
   custom tools. The session is wrapped so that it can be disposed through
   `AgentSessionRuntime` (see Lifecycle).
7. **Bind.** Call `session.bindExtensions({ mode: "print" })` without a UI
   context, so the SDK's no-op UI applies and `session_start` is emitted. A
   failure is `extension_load_failed`.
8. **Postchecks.** Model, thinking level and active tools. For extension
   sessions no active tool may be outside the composed allowlist, but fewer
   active tools are allowed except for explicitly granted extension tools in
   read-only profiles: each must be active and declared to the model at admission
   (ADR 0010). An extension may otherwise deactivate tools, as `pi-cursor-sdk`
   does with its own tool in `session_start`. Sessions without
   extensions keep the exact-equality check as today.

Step 3, step 6 and step 7 are each bounded by the existing session-creation
deadline (`SESSION_CREATION_TIMEOUT_MS`). A failure after step 6 disposes the
session through the lifecycle path, which emits `session_shutdown`. A session
that resolves after its deadline is disposed the same way, never admitted.
Extension code loaded in step 3 cannot be unloaded; a failure between step 3
and step 6 leaves no session to dispose.

### Tools, hooks and prompts

- **`read-only`.** Under [ADR 0010](adr/0010-read-only-extension-tools.md),
  the active tools are `read`, `grep`, `find`, `ls`, the granted MCP tools and
  exactly the extension tools named in `grantedExtensionTools`. Without grants,
  extension tools remain inactive. An extension's `setActiveTools` cannot add
  others. The field is allowed only on read-only profiles with at least one
  extension: at most 32 unique names satisfying the extension name rule below,
  with no built-in names. A violation prevents startup with
  `invalid_execution_profile_config`.
  Each grant must be registered at extension load, before bind; after bind the
  existing re-check applies. Each granted tool must also be active and declared
  to the model at admission, or start fails with `extension_tool_missing`,
  message `Granted Pi extension tool is not available`, class `needs_operator`.
  Resolution errors (`extension_not_installed`, `extension_version_mismatch`)
  take precedence; conflicts are checked first as `extension_tool_conflict`.
  The SDK activates only declarable tools, so registration alone is insufficient.
  Several registered `pi-lens` tools were never active in the
  [evaluation](evaluation/pi-lens-registration-2026-10-19/); granting one fails
  closed. Lazy registration in `session_start` or later is unsupported.
  A grant is the operator's trust decision: third-party tools may write, and
  workspace modes `container` and `read-only` do not restrict them.
- **`coding`.** The tool list is the built-in coding tools, the granted MCP
  tools, and every tool registered by the profile's extensions. The adapter
  reads the registered tool names from the services' resource loader after
  step 3.
- **Name conflicts, both profiles.** An extension tool whose name equals a
  built-in tool (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`), a
  granted MCP tool or a tool of another extension fails with
  `extension_tool_conflict`. This also stops an extension from replacing a
  built-in tool inside a `read-only` profile.
  A name must also match `[A-Za-z0-9_][A-Za-z0-9_-]{0,63}`: the SDK reads `*`
  in an allowlist as a glob and a leading `+` or `-` as a modifier, and 64
  characters of letters, digits, `_` and `-` fit the common provider
  function-name limit, so any other name fails the same way, in both
  profiles. Names that Pi SDK 1.1.0 treats as MCP tools fail too: any name
  starting with `mcp__`, and exactly `list_mcp_resources`,
  `list_mcp_resource_templates` and `read_mcp_resource`. When the allowlist
  names no `mcp__` entry, the SDK keeps such tools outside the allowlist for
  codemode and tool_search, so they could otherwise be active without a grant.
  This server's own MCP bridge tools use a single underscore (`mcp_<server>_<tool>`)
  and never collide.
  The check runs after load and again after binding, because a `session_start`
  handler can register a tool during `bindExtensions`. In read-only profiles,
  the re-check fails on a name conflict (`extension_tool_conflict`) or a missing
  grant (`extension_tool_missing`); an extra, non-colliding registration stays
  inactive outside the allowlist. In coding profiles the composed list includes
  all registered extension tools, so a changed registered set fails with
  `extension_tool_conflict`. Tools an extension registers later, during a
  turn, are not re-checked; allowlisted extensions are trusted code.
- **Hook errors while binding.** A hook error reported while binding fails the
  start with `extension_load_failed`. Failure cleanup disposes the session
  runtime, bounded by the creation deadline, concurrently with closing the
  granted MCP connections.
- **MCP servers registered by extensions.** An extension that registers an MCP
  server while loading or starting fails the start with
  `extension_load_failed`, because the built-in MCP extension is not loaded.
- **Hooks.** All extension hooks run in both permission profiles, including
  `before_agent_start` system-prompt changes, `tool_call`, `tool_result`,
  `before_provider_request`, `before_provider_headers` and `context`.
- **Prompts.** Every `session.prompt()` call, for every profile, passes
  `expandPromptTemplates: false`. Client prompt text never dispatches an
  extension command, a skill command or a prompt template. The call also
  passes `source: "rpc"`, which is what Pi's own RPC mode uses for input from
  a program over stdio and so matches an MCP client. The SDK default,
  `interactive`, means a human at the terminal or the CLI's print mode, which
  a client prompt is not. Extension `input` hooks therefore see `rpc`.
- **UI and flags.** No UI context is bound; extension UI calls return the
  SDK's no-op results. `extensionFlagValues` is empty, so extension flags keep
  their defaults.
- **Turn liveness.** The `updatedAt` of a running turn follows the public SDK
  events of the prompt: assistant message start, update and end, and tool
  execution start, update and end. An extension provider with its own agent
  loop, such as `pi-cursor-sdk`, therefore advances `updatedAt` whenever it
  publishes streaming updates. Its internal steps that publish no public
  event stay invisible, so an unchanged `updatedAt` is no proof of a hang, and
  streaming is no evidence of finished or useful work. Only the event type and
  the message role are inspected; no delta, thinking block, tool argument or
  partial result is stored or projected, and the answer still comes only from
  the final assistant message. See [Tool
  contracts](tool-contracts.md).

### Lifecycle and close

The handle of an extension session owns the `AgentSessionRuntime` that wraps
its services and session. `close`, the close cleanup after an abort deadline,
registry shutdown and late-start disposal call `AgentSessionRuntime.dispose()`,
which emits `session_shutdown` and disposes the session. Existing deadlines,
idempotent close and tombstones do not change. MCP connections close
concurrently with the runtime, as they close concurrently with the session
today; the handle's disposal completes when both have settled.

How the session is wrapped in an `AgentSessionRuntime` uses only the exported
`createAgentSessionRuntime` and `AgentSessionRuntime` API. The exact wiring is
fixed in the implementation plan and proven by a contract test that observes
`session_shutdown`.

### stdout guard

A new module `src/stdout-guard.ts` runs first in `src/main.ts`, before any
other import with side effects:

- It captures the original `process.stdout.write`.
- It builds a write-through `Proxy` over the real stdout: `write` and `end`
  resolve to the original bound methods and every other function is bound to
  the real stream, so queued frames reach stdout synchronously. `main` passes
  `new StdioServerTransport(process.stdin, thatProxy)` to `serveStdio`
  through its `transport` option.
- It also patches `process.stdout.end` for foreign callers: a foreign `end`
  neither leaks content nor closes the real stdout.
- It replaces `process.stdout.write` and `console.log`, `console.info` and
  `console.debug`. Their output is dropped. The guard writes at most one
  structured stderr line per second, carrying the bytes and the number of
  writes suppressed since its previous line:
  `{"level":"warning","event":"foreign_stdout_suppressed","bytes":<n>,"writes":<m>}`.
  Pending counts are flushed on shutdown. The content is never written
  anywhere, because it may contain prompts or secrets.

The guard is active for every server start, not only with extensions. A child
process started with inherited stdio writes to file descriptor 1 directly and
cannot be intercepted in Node.js; this is a documented residual risk.

### Capabilities projection

`pi_capabilities_get` adds `extensions` to every execution profile: an array of
the configured spec strings, empty for profiles without extensions. The field
is path-free and secret-free. Each profile also has `grantedExtensionTools`
directly after `extensions`, in configured order, or `[]` when absent. It is
configuration intent only, not proof of runtime availability; setup verify
validates it. `capabilitiesSchema` and
`docs/tool-contracts.md` change accordingly.

### Doctor

Doctor gains two checks after the workspace checks, one per profile and
extension, with the subject `<profile>:<package name>`:

- `extension_missing` (error) when the resolver finds no installed package;
- `extension_version_mismatch` (error) when the installed manifest version
  differs, or the manifest is unreadable.

Doctor reads manifests only; it never imports extension code. It stays
offline. `setup --verify` includes Doctor and therefore these checks.

### Diagnostics

The adapter's diagnostic sink gains the stages `extension_resolve`,
`extension_load` and `extension_bind`. A diagnostic carries the profile alias
and the error code; a resolution failure also carries the failing extension as
`<name>@<version>`. Disposal stays best effort and reports nothing, as today. It never carries a path, an extension error message, or prompt content.

## Failure semantics

New `PiSessionCreationErrorCode` values, all fail closed before a session is
admitted:

| Code | Message | When |
| --- | --- | --- |
| `extension_not_installed` | Configured Pi extension is not installed | Pi has no user install of the package. |
| `extension_version_mismatch` | Configured Pi extension version is not installed | The installed version differs from the pinned version. |
| `extension_load_failed` | Configured Pi extension could not be loaded | Invalid manifest, entry outside the package, load or bind error, services diagnostic of type `error`. |
| `extension_tool_conflict` | Configured Pi extension tools conflict | An extension tool name collides with a built-in, MCP or other extension tool, or is unsafe (see *Name conflicts*). |
| `extension_tool_missing` | Granted Pi extension tool is not available | A read-only grant is not registered at load, or is not active and declared to the model at admission; class `needs_operator`. |

Existing codes keep their meaning. An extension provider that is unknown after
loading is `unknown_provider`.

Known limit: `pi-cursor-sdk` returns a placeholder key when no Cursor key is
stored, so `checkAuth` and `getAuth` succeed and the first prompt fails with
`turn_failed`. Detecting the placeholder would depend on extension internals;
the limit is documented instead.

## Trust boundary and limits

- An allowlisted extension is code the operator trusts. It runs in the server
  process with the user's full rights and may start processes, use the
  network, and read and write files. `pi-cursor-sdk` writes below
  `~/.pi/agent`, `~/.cursor/projects/` and `<workspace>/.pi/`.
- Pinning the version prevents silent updates. It does not protect against a
  modified installed package directory, which is user-writable code like any
  other.
- `read-only` limits the model's tool set, not the extension's code.
- pi-session-mcp keeps its own state in memory only. Extensions may persist
  their own state outside its control. AGENTS.md and `docs/architecture.md`
  state this next to the product boundary.
- The MCP client remains one trusted local peer. It selects profile aliases
  only and cannot name an extension.

## Testing

Automated tests use no credentials and no network.

- **Config** (`test/config.test.ts`): valid scoped and unscoped specs;
  rejection of ranges, tags, `git:`, paths, duplicates and more than 8
  entries; the field on read-only and coding profiles.
- **Resolution** (`test/pi-extensions.test.ts`), with an injected install-location
  lookup and file system: not installed, version mismatch, invalid manifest,
  missing `pi.extensions`, an entry or symlink escaping the package directory,
  and the guarantee that `resolve()` and install methods are never called.
- **Doctor** (`test/doctor.test.ts`): both new checks, check order, and that
  no extension module is imported.
- **Adapter** (`test/sdk-pi-adapter.test.ts`), with injected services and
  session factories:
  - step order, and the provider being visible only after services;
  - two sessions getting two runtimes;
  - `bindExtensions` being called;
  - `session_shutdown` on close, on a failure after services, and on a late
    start after the deadline;
  - tool lists for read-only and coding, and `extension_tool_conflict`;
  - `expandPromptTemplates: false` and `source: "rpc"` on every prompt;
  - profiles without extensions taking the unchanged path.
- **stdout guard** (`test/stdout-guard.test.ts`): foreign `write` and
  `console.*` output does not reach stdout, transport writes do, and the
  stderr event carries only a byte count. Regressions cover synchronous
  delivery of every queued transport frame and a foreign `end` that must not
  close stdout.
- **SDK contract with the real SDK** (`test/sdk-extension-contract.test.ts`):
  a fixture extension in `test/fixtures/pi-extension-fixture`, installed into a
  temporary Pi agent directory, registers:
  - a provider with a canned, network-free stream;
  - a tool and a slash command;
  - a `setActiveTools` attempt;
  - `console.log` and `process.stdout.write` calls;
  - `session_start` and `session_shutdown` hooks;
  - a `before_agent_start` hook that repeats the widening attempt (adding
    `bash`, `write`, `edit` and the fixture tool) on every prompt.

  The test proves that:
  - the provider resolves and a prompt completes;
  - read-only keeps the fixture tool and the built-in write tools inactive,
    including against the mid-turn `before_agent_start` widening attempt;
  - the slash command is not dispatched;
  - both lifecycle events are observed.
- **stdio end to end** (`test/process-extension.test.ts`): the built server runs
  with a configuration that uses the fixture extension. Every stdout frame
  parses, and stderr contains `foreign_stdout_suppressed`.

## Documentation and governance

- ADR 0006 records the decision and its trust boundary.
- `docs/installation.md`: the `extensions` rule in the configuration section.
- `docs/tool-contracts.md`: the capabilities field and the new error codes.
- `docs/threat-model.md` and `docs/architecture.md`: the trust boundary, the
  stdout guard and its residual risk, and extension-owned persistence.
- `docs/doctor-design.md`: the two new checks.
- A new section "Pi extensions" in `docs/installation.md` with the
  `pi-cursor-sdk` example and the placeholder-key limit.
- AGENTS.md: the product-boundary sentence names extension-owned persistence
  and the allowlist rule.
- `docs/acceptance.md`: the manual live check below.
- CHANGELOG.md: an entry under Unreleased.

## Acceptance on real hardware

Manual, not in CI, recorded in `docs/acceptance.md`:

1. `pi-cursor-sdk@0.5.3` installed by Pi with a stored Cursor key.
2. A `code-cursor` profile: `pi_session_start`, a "PONG" prompt, `pi_turn_get`
   completed, `pi_session_close`.
3. Two parallel `cursor` sessions, each completing a prompt.
4. After close, no Cursor child process remains, and stderr shows no
   `foreign_stdout_suppressed` storm.
5. Record how the Cursor local runtime starts its child processes (inherited or
   piped stdio).

## Delivery

One branch (`feat/pi-extensions`) and one pull request for #34, with commits
grouped by concern. The owner's live configuration gets a `cursor` profile only
after the acceptance above.

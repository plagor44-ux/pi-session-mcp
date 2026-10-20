# Granted Extension Tools for Read-only Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a `read-only` execution profile grant individual extension tools by name, so review workers can use them; without a grant nothing changes.

**Architecture:**
- A new optional profile field `grantedExtensionTools` is validated in `src/config.ts`.
- It flows through `ResolvedExecutionProfile` into `composeSessionTools`, which activates exactly the granted names in read-only sessions.
- The SDK adapter fails closed with the new code `extension_tool_missing` when a granted tool is not registered at load or not active at admission.
- Capabilities and the setup verifier carry the field. The change ships as 0.10.0 with ADR 0010.

**Tech Stack:** Node.js 22.19+, TypeScript strict ESM, zod 4.6.5, vitest 5.0.3, Pi SDK `@earendil-works/pi-coding-agent` 1.3.0 (root exports only).

**Spec:** `docs/superpowers/specs/2026-10-19-read-only-extension-tools-design.md`

## Global Constraints

- Node.js 22.19.0 or newer, TypeScript strict, ESM, `.js` suffixes in relative imports.
- No new dependencies. Exact pins stay exact.
- Stdout stays MCP frames only. Diagnostics carry no paths, secrets or prompts.
- Use only documented SDK root exports. Tests use fakes or the local fixture extension, with no provider credentials.
- Field name `grantedExtensionTools`.
- Error code `extension_tool_missing`, message `Granted Pi extension tool is not available`, class `needs_operator`.
- Max 32 grants per profile; constant `MAX_GRANTED_EXTENSION_TOOLS = 32`.
- Grants are allowed only on `read-only` profiles that list at least one extension.
- A grant must be registered at extension load and be active and declared at admission.
- All tracked docs in English. Release version `0.10.0`, minor under ADR 0003.

## Review Focus

1. A granted name that differs only in case or has surrounding spaces (`Symbol_Search`, ` symbol_search`) must be rejected by config or by the missing check, never matched loosely. Test in Task 2 and Task 3.
2. A granted name equal to a granted MCP tool name (`mcp_<server>_<tool>`) must fail closed as a conflict, not silently pass because the name is active through MCP. Test in Task 3.
3. An existing config without the field must produce byte-identical session tool lists and `grantedExtensionTools: []` in capabilities. Test in Task 3 and Task 5.
4. A profile whose extension is not installed must still report `extension_not_installed`, not `extension_tool_missing`. The existing resolution order wins. Test in Task 4.
5. A maximal profile set (8 extensions and 32 grants of 64 characters on several profiles) must still fit the verifier's `MCP_MAX_FRAME_BYTES` (65,536) for a realistic operator config of 10 profiles, or `--verify` regresses as in #36. Test in Task 5.

---

### Task 1: Probe when `pi-lens` registers its tools (provider-free, gate)

**Files:**
- Create: `docs/evaluation/pi-lens-registration-2026-10-19/probe.mjs`
- Create: `docs/evaluation/pi-lens-registration-2026-10-19/README.md`
- Create: `docs/evaluation/pi-lens-registration-2026-10-19/result.json`

**Interfaces:**
- Produces: a recorded answer. Are `symbol_search` and `project_report` registered by `pi-lens@4.4.3` at extension load (before `bindExtensions`), and are they still registered after bind?

- [ ] **Step 1: Install `pi-lens@4.4.3` into a throwaway agent dir.** Use `mktemp -d "$HOME/.cache/pi-lens-probe.XXXXXX"` and the layout `<agentDir>/npm/node_modules/pi-lens`, as in `test/sdk-extension-contract.test.ts`. Run `npm install --ignore-scripts --prefix <agentDir>/npm pi-lens@4.4.3`. Never touch `~/.pi/agent`.
- [ ] **Step 2: Write `probe.mjs`.** It loads the fixture extension (`test/fixtures/pi-extension-fixture`, for its offline provider) together with `pi-lens` through `SdkPiSessionAdapter`'s public seams, or through the root-exported `createAgentSessionServices`/`createAgentSessionFromServices`/`bindExtensions`.
  - Record the registered tool names of each extension after load and after bind.
  - Record the active tool names after bind in a `coding` profile.
  - Deny network the way `docs/evaluation/extension-functions-2026-10-17/cursor/probe.mjs` does, and count the attempts.
  - Output one JSON line, written to `result.json`, with keys `loadTools`, `boundTools`, `activeCoding`, `networkAttempts`.
- [ ] **Step 3: Run it.** Run: `node docs/evaluation/pi-lens-registration-2026-10-19/probe.mjs <agentDir>`. Expected: one JSON line; exit 0.
- [ ] **Step 4: Gate.** If `symbol_search` or `project_report` is missing from `loadTools`, stop and report to the operator: lazy registration is out of scope (spec, "When a granted tool must exist"). Otherwise record the result in `README.md` and remove the throwaway dir.
- [ ] **Step 5: Commit.** `git commit -m "docs: record when pi-lens registers its tools"`

### Task 2: Config field and resolved profile

**Files:**
- Modify: `src/session-tools.ts` (export `isAcceptableExtensionToolName`; add `export const MAX_GRANTED_EXTENSION_TOOLS = 32`)
- Modify: `src/config.ts:22-41` (`profileSchema`), `src/config.ts:153-160` (snapshot)
- Modify: `src/execution-profile.ts:11-47`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces:
  - `ConfiguredExecutionProfile.grantedExtensionTools?: readonly string[]` and `ResolvedExecutionProfile.grantedExtensionTools?: readonly string[]`. They are frozen, in configured order, and absent when not configured.
  - `toResolvedExecutionProfile` copies the field.
  - `isAcceptableExtensionToolName(name: string): boolean` is exported.

- [ ] **Step 1: Write failing tests** in `test/config.test.ts`. Each `it` builds a config through the existing helpers.
  - Accepted: `{ permissionProfile: "read-only", extensions: ["npm:pi-lens@4.4.3"], grantedExtensionTools: ["symbol_search", "project_report"] }`, resolved in order.
  - Rejected with `invalid_execution_profile_config`:
    - the field on `coding`;
    - the field without `extensions`;
    - a duplicate name;
    - 33 names;
    - `"Symbol Search"`, `" symbol_search"`, `"-x"` and `"mcp__x"`;
    - each built-in name (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`).
  - A profile without the field resolves without the key (`"grantedExtensionTools" in profile === false`).
- [ ] **Step 2: Run.** Run: `npx vitest run test/config.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Add the zod field `z.array(z.string().refine(isAcceptableExtensionToolName)).max(MAX_GRANTED_EXTENSION_TOOLS).optional()` to `profileSchema`. Add `superRefine` issues on path `["grantedExtensionTools"]` for: not read-only; no extensions; duplicates; any name in `PROFILE_TOOLS.coding ∪ PROFILE_TOOLS["read-only"]`. Freeze and copy it in the snapshot and in `toResolvedExecutionProfile`.
- [ ] **Step 4: Run.** Run: `npx vitest run test/config.test.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(config): accept granted extension tools on read-only profiles"`

### Task 3: Tool composition

**Files:**
- Modify: `src/session-tools.ts:29-50`
- Test: `test/session-tools.test.ts`

**Interfaces:**
- Consumes: Task 2 types.
- Produces:
  ```ts
  export type ComposedSessionTools =
    | { readonly ok: true; readonly tools: string[] }
    | { readonly ok: false; readonly code: "extension_tool_conflict" | "extension_tool_missing" };
  export function composeSessionTools(
    permissionProfile: PermissionProfile,
    mcpToolNames: readonly string[],
    extensionToolNames: readonly (readonly string[])[],
    grantedExtensionTools?: readonly string[],
  ): ComposedSessionTools;
  ```
  - Conflict rules are unchanged and are checked first.
  - In `read-only`: `[...PROFILE_TOOLS["read-only"], ...mcpToolNames, ...granted]`, granted names in configured order. If any granted name is not among the registered extension tools, return `{ ok: false, code: "extension_tool_missing" }`.
  - In `coding`: unchanged. `granted` is ignored there; config makes it impossible anyway.
  - The three callers in `src/sdk-pi-adapter.ts` are adapted in Task 4.

- [ ] **Step 1: Write failing tests.**
  - Read-only with registered `[["a_tool","b_tool"]]` and grant `["b_tool"]` gives `tools` equal to `["read","grep","find","ls","b_tool"]`.
  - Read-only without grant equals today's output exactly.
  - Grant `["c_tool"]`, not registered, gives `extension_tool_missing`.
  - An extension tool named like a granted MCP tool gives `extension_tool_conflict`.
  - A grant `"B_tool"` against registered `"b_tool"` gives `extension_tool_missing`.
  - Coding output is unchanged with and without a grant argument.
- [ ] **Step 2: Run.** Run: `npx vitest run test/session-tools.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the signature above in `src/session-tools.ts` and update its doc comment (read-only activates exactly the granted names).
- [ ] **Step 4: Run.** Run: `npx vitest run test/session-tools.test.ts`. Expected: PASS. Typecheck fails in `src/sdk-pi-adapter.ts` until Task 4; that is expected.
- [ ] **Step 5: Commit together with Task 4.** The build must stay green per commit.

### Task 4: Adapter enforcement and the new start code

**Files:**
- Modify: `src/pi-adapter.ts:20-53` (code union and message)
- Modify: `src/sdk-pi-adapter.ts:455-561` (`createWithExtensions`), `:653-692` (`admit`)
- Modify: `test/fixtures/pi-extension-fixture/index.js`
- Test: `test/sdk-extension-contract.test.ts`, `test/sdk-pi-adapter.test.ts`

**Interfaces:**
- Consumes: Task 3 `composeSessionTools`; Task 2 `ResolvedExecutionProfile.grantedExtensionTools`.
- Produces: `PiSessionCreationErrorCode` gains `"extension_tool_missing"` with message `Granted Pi extension tool is not available`. `admit` gains the parameter `requiredTools: readonly string[] = []`. Every name in it must be active, or `admit` fails with `extension_tool_missing`. The subset rule for all other names is unchanged.

- [ ] **Step 1: Extend the fixture extension.** Behaviour is controlled by `globalThis.__piExtensionFixtureMode`, a string that defaults to `"default"`.
  - It registers a second tool `fixture_reader` (parameters `{}`, records `call:fixture_reader`).
  - In mode `"hidden"`, `fixture_reader` is registered with a non-declarable exposure. Use the SDK's `ToolExposure` value that `_isDeclarable` rejects; read `dist/core/extensions/types.d.ts:480-500`.
  - In mode `"deactivate"`, `session_start` calls `pi.setActiveTools` without `fixture_reader`.
  - Existing tests must keep passing.
- [ ] **Step 2: Write failing contract tests** in `test/sdk-extension-contract.test.ts`. The `harness` gains an optional `grantedExtensionTools`.
  - Read-only with grant `["fixture_reader"]`: the model's tools are exactly `[...PROFILE_TOOLS["read-only"], "fixture_reader"].sort()`. `bash`, `write`, `edit` and `fixture_tool` stay absent despite the fixture's `setActiveTools`.
  - Grant `["fixture_missing"]`: `registry.start` rejects with code `extension_tool_missing`, and `events()` contains no `session_start`.
  - Mode `"deactivate"` with grant `["fixture_reader"]`: start rejects with `extension_tool_missing`.
  - Mode `"hidden"` with grant `["fixture_reader"]`: start rejects with `extension_tool_missing`.
  - In `test/sdk-pi-adapter.test.ts`: a profile whose extension resolution throws `extension_not_installed` still reports `extension_not_installed` when grants are present. The diagnostic for `extension_tool_missing` contains only `stage`, `code` and profile fields, with no path.
- [ ] **Step 3: Run.** Run: `npx vitest run test/sdk-extension-contract.test.ts test/sdk-pi-adapter.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 4: Implement.**
  - In `createWithExtensions`, pass `executionProfile.grantedExtensionTools ?? []` to both `composeSessionTools` calls, the initial one and the post-bind `recheck`.
  - Map `{ok:false}` to `this.failure(executionProfile, "extension_load" | "extension_bind", code)`.
  - A post-bind result that differs from the initial one keeps failing as `extension_tool_conflict`.
  - Pass the granted names as `requiredTools` to `admit`. Inside `admit`, when `requiredTools` has a name not in `session.getActiveToolNames()`, throw `this.failure(..., "postcheck", "extension_tool_missing")` before the subset check.
- [ ] **Step 5: Run.** Run: `npx vitest run test/sdk-extension-contract.test.ts test/sdk-pi-adapter.test.ts test/session-tools.test.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit.** `git commit -m "feat(adapter): activate granted extension tools in read-only sessions"`

### Task 5: Capabilities, server schema and setup verifier

**Files:**
- Modify: `src/capabilities.ts:27-36`
- Modify: `src/server.ts:42-51` (`capabilitiesSchema`)
- Modify: `src/client-adapters/mcp-verifier.ts:100-115`
- Test: `test/capabilities.test.ts`, `test/mcp-contract.test.ts`, `test/setup-verify-server.test.ts`

**Interfaces:**
- Consumes: Task 2.
- Produces: each capabilities profile entry gains `grantedExtensionTools: string[]` (configured order, `[]` when absent), placed after `extensions`. The verifier requires the exact key set including it. It validates at most `MAX_GRANTED_EXTENSION_TOOLS` entries, each `isAcceptableExtensionToolName`, without duplicates.

- [ ] **Step 1: Write failing tests.**
  - Capabilities lists `grantedExtensionTools` for every profile, `[]` without grants.
  - The MCP contract test's output schema accepts it and rejects a payload missing it.
  - The setup verifier accepts a server whose profile has two grants and rejects one with 33.
  - The verifier accepts a capabilities payload for 10 profiles, each with 8 extension specs and 32 grants of 64 characters, under `MCP_MAX_FRAME_BYTES`. If that payload exceeds 65,536 bytes, the test documents the largest fitting count and the docs state it as a limit.
- [ ] **Step 2: Run.** Run: `npx vitest run test/capabilities.test.ts test/mcp-contract.test.ts test/setup-verify-server.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the projection, the schema field `grantedExtensionTools: z.array(z.string())` and the verifier checks.
- [ ] **Step 4: Run.** Same command plus `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(capabilities): expose granted extension tools per profile"`

### Task 6: ADR 0010 and operator documentation

**Files:**
- Create: `docs/adr/0010-read-only-extension-tools.md`
- Modify:
  - `docs/adr/0006-pi-extension-allowlist.md` (status line: amended by ADR 0010)
  - `docs/pi-extensions-design.md` ("Tools, hooks and prompts")
  - `docs/tool-contracts.md` (capabilities field and the example, the `extension_tool_missing` row with class `needs_operator`)
  - `docs/threat-model.md`
  - `docs/execution-modes.md` ("Modes and risks")
  - `docs/installation.md` ("Pi extensions": example with `grantedExtensionTools`)
  - `skills/pi-session-orchestration/references/start-errors.md` (operator-needed list)
  - `CHANGELOG.md` (`## Unreleased`: "Added")
- Test: the existing doc/skill consistency tests (`npx vitest run test/skills*.test.ts test/docs*.test.ts`, if present; otherwise the full suite in Task 7)

**Interfaces:**
- Consumes: final names from Tasks 2–5.

- [ ] **Step 1: Write ADR 0010.**
  - Context: ADR 0006 keeps read-only tools at four.
  - Decision: per-tool grants on read-only profiles, registered at load and active at admission, else `extension_tool_missing`.
  - Consequences:
    - the grant is the operator's trust decision;
    - granted tools are third-party code and may write;
    - workspace modes `container` and `read-only` do not restrict them;
    - lazily registering extensions are unsupported.
  - Status: accepted 2026-10-19.
- [ ] **Step 2: Update each listed doc** with the facts above and nothing beyond them.
- [ ] **Step 3: Check links and run the suite.** Run: `git diff --check && NODE_OPTIONS=--unhandled-rejections=strict npm test`. Expected: exit 0.
- [ ] **Step 4: Commit.** `git commit -m "docs: record granted extension tools for read-only profiles (ADR 0010)"`

### Task 7: Release preparation 0.10.0 and pre-release acceptance

**Files:**
- Modify: `package.json`, `package-lock.json` (via `npm version 0.10.0 --no-git-tag-version`)
- Modify: `README.md` (version line), `docs/tool-contracts.md` (capability example version), `CHANGELOG.md` (`## 0.10.0 — <date>` below `## Unreleased`)
- Modify: `docs/acceptance.md` (`### v0.10.0 pre-release acceptance`)

- [ ] **Step 1: Bump and edit** per `docs/releasing.md` "Prepare a release", steps 2–3.
- [ ] **Step 2: Level 1.** Run: `npm ci && npm run typecheck && npm run build:cli && NODE_OPTIONS=--unhandled-rejections=strict npm test && npm run build && npm audit && npm audit --omit=dev && git diff --check`. Expected: all exit 0. `npm run --silent doctor -- --json` reports `packageVersion` `0.10.0`.
- [ ] **Step 3: Level 2.** Run the working-tree and packed-tarball Level 2 per `docs/releasing.md` steps 5–6. Expected: 160/160 each.
- [ ] **Step 4: Live acceptance, operator-approved in the spec.**
  - Setup:
    - an evaluation-owned agent dir with `pi-lens@4.4.3` and a copied access-token-only `auth.json`;
    - a temporary config with one read-only profile (`review-grok` model and provider) and grant `["symbol_search"]`.
  - Run: one `pi_session_start` and one prompt asking to call `symbol_search` once, then close. Record connections with `strace -f -e trace=connect`.
  - Pass:
    - the start succeeds;
    - capabilities show the grant;
    - the turn completes with a non-error `symbol_search` result. A cold-index "not ready" answer counts and is noted.
  - Spend at most USD 0.50 at catalog price.
  - Record it under the pre-release acceptance; never record credentials or the prompt.
- [ ] **Step 5: Record and commit.** `git commit -m "chore: prepare v0.10.0 release"`, then `git commit -m "docs: record the v0.10.0 pre-release acceptance"`. Merge, tag and publish are maintainer steps.

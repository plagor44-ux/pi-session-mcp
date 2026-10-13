# Pi Extensions Implementation Plan

> **Delivery status (2026-10-13).** Historical plan. Its work is delivered, so
> do not execute it again. The checkboxes below are historical and were not
> maintained; do not read an unchecked box as open work.
>
> | Plan tasks | Delivered by | State |
> | --- | --- | --- |
> | 1-9: extension specs in configuration and capabilities, resolution without installing, Doctor checks, stdout guard, plain-text prompts, extension session path, SDK contract fixture, process-level evidence, governance and documentation ([ADR 0006](../../adr/0006-pi-extension-allowlist.md)) | [#35](https://github.com/plagor44-ux/pi-session-mcp/pull/35) (the feature), [#37](https://github.com/plagor44-ux/pi-session-mcp/pull/37) (release 0.7.0) and [#44](https://github.com/plagor44-ux/pi-session-mcp/pull/44) (post-0.7.0 follow-ups), all merged 2026-10-11; issue [#34](https://github.com/plagor44-ux/pi-session-mcp/issues/34) closed as completed | Delivered; the audit's reconciliation maps tasks 1-9 to #35, #37 and #44 together and does not assign single tasks to single pull requests |
> | 10: working-tree live acceptance with `pi-cursor-sdk` | Documented in [acceptance](../../acceptance.md#status) and carried on in [#55](https://github.com/plagor44-ux/pi-session-mcp/pull/55) (release 0.8.1), including Claude Code parallel and abort runs | Documented for the recorded combinations only |
>
> Actual remainder: the controller and platform limits listed in the
> [audit](../../reviews/2026-10-13-post-0.8.1-audit.md#plan-and-adr-reconciliation)
> and the [roadmap](../../roadmap.md), no duplicate implementation, and this
> status note itself.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Operators can allowlist exactly pinned Pi extensions per execution profile. Those extensions then load with full capabilities in embedded sessions, and stdout stays reserved for MCP frames.

**Architecture:** A pure spec module parses `npm:<name>@<version>` entries in the configuration. A resolver finds Pi's installed package without installing anything. For profiles with extensions, the SDK adapter uses the Pi SDK lifecycle API (`createAgentSessionServices`, `createAgentSessionFromServices`, `createAgentSessionRuntime`) with one model runtime per session; profiles without extensions keep today's path. An always-on stdout guard gives the MCP transport the only real stdout writer.

**Tech Stack:** Node.js ≥ 22.19.0, TypeScript strict ESM, zod 4.6.5, vitest 5.0.3, `@earendil-works/pi-coding-agent` 1.1.0, `@modelcontextprotocol/server` 2.3.1.

**Spec:** `docs/pi-extensions-design.md` (issue #34). Read it before every task.

## Global Constraints

- Node.js 22.19.0 or newer, TypeScript strict mode, ESM, `.js` suffixes in relative imports.
- No new or changed dependencies. Every SDK symbol comes from the package root of `@earendil-works/pi-coding-agent` or from `@modelcontextprotocol/server/stdio`. Never import internals.
- stdout carries only MCP frames. Diagnostics go to stderr as structured JSON and never contain secrets, paths, extension error text or prompt content.
- Automated tests use fakes, or the real SDK with the local fixture extension. They need no provider credentials and no network.
- Doctor stays offline and never imports extension code.
- Workspaces are reachable only through configured aliases. No tool argument may accept a path or an extension name.
- Extension spec format, verbatim: `npm:<name>@<exact semver>`, at most 8 per profile, each package at most once per profile.
- New public error codes, verbatim:
  - `extension_not_installed`
  - `extension_version_mismatch`
  - `extension_load_failed`
  - `extension_tool_conflict`
- New Doctor check ids, verbatim:
  - `extension_missing`
  - `extension_version_mismatch`
- stderr event, verbatim: `{"level":"warning","event":"foreign_stdout_suppressed","bytes":<n>,"writes":<m>}`, at most one line per second.
- Tracked documentation is written in English.
- Delivery: one branch, `feat/pi-extensions`, and one PR for #34. Each task commits on its own. Every commit message ends with:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Fuzo8ySrHK1TLhaQ12LxaJ
  ```
- Gate after every task: `npm run typecheck` and `npx vitest run` both pass. The full suite currently has 1 skipped test; that is expected.

## Review Focus

1. **Scoped package specs** such as `npm:@scope/ext@1.2.3`. The name contains an `@`, so a naive split on `@` breaks. Pinned in Task 1 (`parses npm:@scope/provider-ext@1.2.3`).
2. **A symlinked `pi.extensions` entry that points outside the package** must fail closed, even though the path in the manifest looks relative. Pinned in Task 2 (`rejects an entry symlink that leaves the package`).
3. **The same extension in two concurrently started sessions** must get two separate model runtimes. Otherwise `pi-cursor-sdk` sessions break each other. Pinned in Task 6 (`gives every extension session its own model runtime`).
4. **An extension writing a Buffer to stdout with a completion callback** must have the callback invoked and its bytes counted. Otherwise the extension hangs or the report is wrong. Pinned in Task 4 (`completes foreign writes and counts Buffer bytes`).
5. **A profile without extensions, or with an empty list**, must take the unchanged path: shared runtime, `createAgentSession`, no services. Pinned in Task 6 (`keeps profiles without extensions on the unchanged path`).

---

### Task 1: Extension specs in configuration and capabilities

**Files:**
- Create: `src/extension-spec.ts`
- Modify:
  - `src/execution-profile.ts`
  - `src/config.ts`
  - `src/capabilities.ts`
  - `src/server.ts:30-46` (`capabilitiesSchema`)
  - `docs/installation.md` (configuration rules, around line 153)
  - `docs/tool-contracts.md:18-41` (capability discovery)
- Test:
  - Create: `test/extension-spec.test.ts`
  - Modify: `test/config.test.ts`, `test/capabilities.test.ts`, `test/mcp-contract.test.ts:107-121`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `interface ExtensionSpec { readonly spec: string; readonly name: string; readonly version: string }`
  - `const MAX_PROFILE_EXTENSIONS = 8`
  - `function parseExtensionSpec(spec: string): ExtensionSpec | undefined`
  - `type PiExtensionErrorCode = "extension_not_installed" | "extension_version_mismatch" | "extension_load_failed"`
  - `class PiExtensionError extends Error { readonly code: PiExtensionErrorCode }`
  - `ConfiguredExecutionProfile.extensions?: readonly ExtensionSpec[]` and `ResolvedExecutionProfile.extensions?: readonly ExtensionSpec[]`, both frozen and absent when not configured.
  - The capabilities profile gains `extensions: string[]`, the spec strings, `[]` when none.

- [ ] **Step 1: Write the failing spec tests**

Create `test/extension-spec.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseExtensionSpec, PiExtensionError } from "../src/extension-spec.js";

describe("extension specs", () => {
  it.each([
    ["npm:pi-cursor-sdk@0.5.3", "pi-cursor-sdk", "0.5.3"],
    ["npm:@scope/provider-ext@1.2.3", "@scope/provider-ext", "1.2.3"],
    ["npm:ext@1.0.0-beta.1+build.5", "ext", "1.0.0-beta.1+build.5"],
  ])("parses %s", (spec, name, version) => {
    expect(parseExtensionSpec(spec)).toEqual({ spec, name, version });
    expect(Object.isFrozen(parseExtensionSpec(spec))).toBe(true);
  });

  it.each([
    "pi-cursor-sdk@0.5.3",
    "npm:pi-cursor-sdk",
    "npm:pi-cursor-sdk@^0.5.3",
    "npm:pi-cursor-sdk@~0.5.3",
    "npm:pi-cursor-sdk@latest",
    "npm:pi-cursor-sdk@0.5",
    "git:github.com/owner/repo@1.0.0",
    "npm:../escape@1.0.0",
    "npm:/absolute/path@1.0.0",
    "npm:Upper@1.0.0",
    "npm:@scope@1.0.0",
    " npm:ext@1.0.0",
    `npm:${"a".repeat(260)}@1.0.0`,
  ])("rejects %s", (spec) => {
    expect(parseExtensionSpec(spec)).toBeUndefined();
  });

  it("classifies resolution failures without a path or extension text", () => {
    const error = new PiExtensionError("extension_version_mismatch");
    expect(error).toMatchObject({ name: "PiExtensionError", code: "extension_version_mismatch", message: "Pi extension resolution failed" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/extension-spec.test.ts`
Expected: FAIL. Vitest reports that `../src/extension-spec.js` cannot be resolved.

- [ ] **Step 3: Implement `src/extension-spec.ts`**

```ts
/** An exactly pinned Pi extension package, as configured on an execution profile. */
export interface ExtensionSpec {
  /** The configured text, for example `npm:pi-cursor-sdk@0.5.3`. Path-free and secret-free. */
  readonly spec: string;
  readonly name: string;
  readonly version: string;
}

export const MAX_PROFILE_EXTENSIONS = 8;
const MAX_SPEC_LENGTH = 256;
/** `npm:<name>@<exact semver>`; the name may be scoped. Ranges, tags, git sources and paths never match. */
const EXTENSION_SPEC_PATTERN = /^npm:((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

export function parseExtensionSpec(spec: string): ExtensionSpec | undefined {
  if (spec.length > MAX_SPEC_LENGTH) return undefined;
  const match = EXTENSION_SPEC_PATTERN.exec(spec);
  if (!match) return undefined;
  return Object.freeze({ spec, name: match[1]!, version: match[2]! });
}

export type PiExtensionErrorCode = "extension_not_installed" | "extension_version_mismatch" | "extension_load_failed";

/** A classified extension resolution failure. It never carries a path or extension text. */
export class PiExtensionError extends Error {
  readonly code: PiExtensionErrorCode;
  constructor(code: PiExtensionErrorCode) {
    super("Pi extension resolution failed");
    this.name = "PiExtensionError";
    this.code = code;
  }
}
```

- [ ] **Step 4: Run the spec tests to verify they pass**

Run: `npx vitest run test/extension-spec.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing configuration tests**

Append to `test/config.test.ts`:

```ts
describe("execution profile extensions", () => {
  const safe = { default: true, permissionProfile: "read-only", provider: "p", model: "m", thinkingLevel: "off" };

  async function loadProfiles(executionProfiles: Record<string, unknown>) {
    const root = await temporaryRoot("pi-session-mcp-extensions-");
    const path = join(root, "config.json");
    await writeFile(path, JSON.stringify({ workspaces: { repo: "." }, executionProfiles }));
    return loadConfig(path);
  }

  it("parses pinned extensions on read-only and coding profiles", async () => {
    const config = await loadProfiles({
      safe: { ...safe, extensions: ["npm:pi-cursor-sdk@0.5.3"] },
      code: { ...safe, default: false, permissionProfile: "coding", extensions: ["npm:@scope/ext@1.2.3", "npm:other@2.0.0"] },
    });
    expect(config.executionProfiles.get("safe")?.extensions).toEqual([{ spec: "npm:pi-cursor-sdk@0.5.3", name: "pi-cursor-sdk", version: "0.5.3" }]);
    expect(config.executionProfiles.get("code")?.extensions?.map((extension) => extension.name)).toEqual(["@scope/ext", "other"]);
    expect(Object.isFrozen(config.executionProfiles.get("code")?.extensions)).toBe(true);
  });

  it("keeps profiles without extensions free of the field", async () => {
    const config = await loadProfiles({ safe });
    expect(config.executionProfiles.get("safe")).not.toHaveProperty("extensions");
  });

  it.each([
    [["npm:pi-cursor-sdk@^0.5.3"]],
    [["npm:pi-cursor-sdk@latest"]],
    [["git:github.com/owner/repo@1.0.0"]],
    [["/absolute/extension"]],
    [["npm:dup@1.0.0", "npm:dup@1.0.1"]],
    [Array.from({ length: 9 }, (_, index) => `npm:ext-${index}@1.0.0`)],
    ["npm:not-an-array@1.0.0"],
  ])("rejects invalid extensions %j", async (extensions) => {
    await expect(loadProfiles({ safe: { ...safe, extensions } })).rejects.toMatchObject({ code: "invalid_execution_profile_config" });
  });
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `npx vitest run test/config.test.ts -t "execution profile extensions"`
Expected: FAIL. The strict schema rejects `extensions` as an unknown key, so the "parses pinned extensions" case throws `invalid_execution_profile_config`.

- [ ] **Step 7: Add the field to the profile types**

In `src/execution-profile.ts`, add the import:

```ts
import type { ExtensionSpec } from "./extension-spec.js";
```

Add this line after `readonly mcpServers?: McpServers;` in both `ConfiguredExecutionProfile` and `ResolvedExecutionProfile`:

```ts
  readonly extensions?: readonly ExtensionSpec[];
```

In `toResolvedExecutionProfile`, add after the `mcpServers` spread:

```ts
    ...(profile.extensions === undefined ? {} : { extensions: profile.extensions }),
```

- [ ] **Step 8: Validate and map the field in `src/config.ts`**

Add the import:

```ts
import { MAX_PROFILE_EXTENSIONS, parseExtensionSpec } from "./extension-spec.js";
```

Replace `profileSchema` with:

```ts
const extensionSpec = z.string().refine((value) => parseExtensionSpec(value) !== undefined);
const profileSchema = z.object({
  default: z.boolean(), permissionProfile, provider: z.string().trim().min(1).max(256),
  model: z.string().trim().min(1).max(256), thinkingLevel,
  mcpServers: z.custom<McpServers>((value) => isMcpServers(value)).optional(),
  extensions: z.array(extensionSpec).max(MAX_PROFILE_EXTENSIONS).optional(),
}).strict().superRefine((profile, context) => {
  if (profile.mcpServers !== undefined && !isMcpServers(profile.mcpServers, profile.permissionProfile)) {
    context.addIssue({ code: "custom", path: ["mcpServers"], message: "MCP tool grants do not match the permission profile" });
  }
  if (profile.extensions !== undefined) {
    const names = profile.extensions.map((spec) => parseExtensionSpec(spec)!.name);
    if (new Set(names).size !== names.length) {
      context.addIssue({ code: "custom", path: ["extensions"], message: "An extension package may appear only once per profile" });
    }
  }
});
```

In `loadConfig`, replace the `executionProfiles` mapping with:

```ts
  const executionProfiles = new ImmutableMap(Object.entries(parsed.executionProfiles).map(([key, { mcpServers, extensions, ...value }]) => [key, Object.freeze({
    alias: key, ...value,
    ...(mcpServers === undefined ? {} : { mcpServers: snapshotMcpServers(mcpServers) }),
    ...(extensions === undefined ? {} : { extensions: Object.freeze(extensions.map((spec) => parseExtensionSpec(spec)!)) }),
  })] as const));
```

- [ ] **Step 9: Run the configuration tests to verify they pass**

Run: `npx vitest run test/config.test.ts`
Expected: PASS.

- [ ] **Step 10: Write the failing capability projection test**

In `test/capabilities.test.ts`, in the first test:
- Give `zeta-profile` the field `extensions: [{ spec: "npm:ext@1.0.0", name: "ext", version: "1.0.0" }]`.
- Add `extensions: []` to the expected `alpha-profile` projection.
- Add `extensions: ["npm:ext@1.0.0"]` to the expected `zeta-profile` projection.

In `test/mcp-contract.test.ts` around lines 113-120, add `extensions: []` to both expected profile projections.

- [ ] **Step 11: Run them to verify they fail**

Run: `npx vitest run test/capabilities.test.ts test/mcp-contract.test.ts`
Expected: FAIL. The projections have no `extensions` key.

- [ ] **Step 12: Project the field**

In `src/capabilities.ts`, replace the `executionProfiles` mapping with:

```ts
      .map(({ alias, default: isDefault, permissionProfile, provider, model, thinkingLevel, extensions }) => ({
        alias,
        default: isDefault,
        permissionProfile,
        provider,
        model,
        thinkingLevel,
        extensions: (extensions ?? []).map((extension) => extension.spec),
      })),
```

In `src/server.ts`, inside the `executionProfiles` object of `capabilitiesSchema`, add after `thinkingLevel: thinkingLevelSchema,`:

```ts
    extensions: z.array(z.string()),
```

- [ ] **Step 13: Run the full gate**

Run: `npm run typecheck && npx vitest run`
Expected: PASS. Another test may still assert an exact capability profile without `extensions`. If so, add `extensions: []` to that expectation, and to nothing else.

- [ ] **Step 14: Document the field**

`docs/installation.md`: after the bullet "A profile may grant tools from local stdio MCP servers through `mcpServers`. …" (around line 153), add:

```markdown
- A profile may load Pi extensions that Pi has installed, through
  `extensions`: a list of at most 8 entries of the form
  `npm:<name>@<exact version>`, each package once. Ranges, tags, `git:`
  sources and paths are rejected. See [Pi extensions](#pi-extensions).
```

`docs/tool-contracts.md`, capability discovery:
- Add `"extensions": []` after `"thinkingLevel": "medium"` in the example JSON.
- Change "the six documented profile fields" to "the seven documented profile fields".
- Add this sentence after that one: "`extensions` lists the configured extension specs (`npm:<name>@<version>`), empty when a profile loads none; it makes no claim that the package is installed."

- [ ] **Step 15: Commit**

```bash
git add src/extension-spec.ts src/execution-profile.ts src/config.ts src/capabilities.ts src/server.ts test/extension-spec.test.ts test/config.test.ts test/capabilities.test.ts test/mcp-contract.test.ts docs/installation.md docs/tool-contracts.md
git commit -m "feat: accept pinned Pi extensions on execution profiles

Refs #34

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Fuzo8ySrHK1TLhaQ12LxaJ"
```

---

### Task 2: Resolve installed extensions without installing

**Files:**
- Create: `src/pi-extensions.ts`
- Test: `test/pi-extensions.test.ts`

**Interfaces:**
- Consumes (Task 1): `ExtensionSpec`, `PiExtensionError`.
- Produces:
  - `interface PiExtensionResolverDependencies { readonly agentDir?: string; readonly installedPath?: (source: string, agentDir: string) => string | undefined; readonly readFile?: (path: string) => Promise<string>; readonly realpath?: (path: string) => Promise<string> }`
  - `function resolvePiExtension(extension: ExtensionSpec, dependencies?: PiExtensionResolverDependencies): Promise<string>`
    - Resolves to the real package directory.
    - Rejects only with `PiExtensionError`.

- [ ] **Step 1: Write the failing tests**

Create `test/pi-extensions.test.ts`:

```ts
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseExtensionSpec } from "../src/extension-spec.js";
import { resolvePiExtension } from "../src/pi-extensions.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

const extension = parseExtensionSpec("npm:fixture-ext@1.2.3")!;

async function installed(manifest: unknown, files: Record<string, string> = { "index.js": "export default () => {};\n" }) {
  const root = await temporaryRoot("pi-session-mcp-extension-");
  const dir = join(root, "npm", "node_modules", "fixture-ext");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return { root, dir };
}

const at = (dir: string | undefined) => ({ agentDir: "/unused-agent-dir", installedPath: vi.fn((_source: string, _agentDir: string) => dir) });
const valid = { name: "fixture-ext", version: "1.2.3", pi: { extensions: ["./index.js"] } };

describe("resolvePiExtension", () => {
  it("returns the real package directory for the pinned version", async () => {
    const { dir } = await installed(valid);
    const dependencies = at(dir);
    await expect(resolvePiExtension(extension, dependencies)).resolves.toBe(await realpath(dir));
    expect(dependencies.installedPath).toHaveBeenCalledWith("npm:fixture-ext", "/unused-agent-dir");
  });

  it("finds Pi's user install through the package manager without resolving or installing", async () => {
    const { root, dir } = await installed(valid);
    const resolve = vi.spyOn(DefaultPackageManager.prototype, "resolve");
    await expect(resolvePiExtension(extension, { agentDir: root })).resolves.toBe(await realpath(dir));
    expect(resolve).not.toHaveBeenCalled();
    resolve.mockRestore();
  });

  it("reports a package Pi has not installed", async () => {
    await expect(resolvePiExtension(extension, at(undefined))).rejects.toMatchObject({ name: "PiExtensionError", code: "extension_not_installed" });
  });

  it("reports an installed directory without a manifest as not installed", async () => {
    const root = await temporaryRoot("pi-session-mcp-extension-");
    await expect(resolvePiExtension(extension, at(root))).rejects.toMatchObject({ code: "extension_not_installed" });
  });

  it("reports another installed version", async () => {
    const { dir } = await installed({ ...valid, version: "1.2.4" });
    await expect(resolvePiExtension(extension, at(dir))).rejects.toMatchObject({ code: "extension_version_mismatch" });
  });

  it.each([
    ["invalid JSON", "{"],
    ["a non-object manifest", "null"],
    ["no pi.extensions", { name: "fixture-ext", version: "1.2.3" }],
    ["an empty pi.extensions", { ...valid, pi: { extensions: [] } }],
    ["an absolute entry", { ...valid, pi: { extensions: ["/etc/passwd"] } }],
    ["a missing entry file", { ...valid, pi: { extensions: ["./missing.js"] } }],
    ["an entry outside the package", { ...valid, pi: { extensions: ["../outside.js"] } }],
  ])("rejects %s as a load failure", async (_label, manifest) => {
    const { root, dir } = await installed(manifest);
    await writeFile(join(root, "npm", "node_modules", "outside.js"), "export default () => {};\n");
    const error = await resolvePiExtension(extension, at(dir)).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "PiExtensionError", code: "extension_load_failed" });
    expect(String((error as Error).message)).not.toContain(root);
  });

  it("rejects an entry symlink that leaves the package", async () => {
    const { root, dir } = await installed({ ...valid, pi: { extensions: ["./link.js"] } });
    const outside = join(root, "outside.js");
    await writeFile(outside, "export default () => {};\n");
    await symlink(outside, join(dir, "link.js"));
    await expect(resolvePiExtension(extension, at(dir))).rejects.toMatchObject({ code: "extension_load_failed" });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/pi-extensions.test.ts`
Expected: FAIL. `../src/pi-extensions.js` cannot be resolved.

- [ ] **Step 3: Implement `src/pi-extensions.ts`**

```ts
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { DefaultPackageManager, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { PiExtensionError, type ExtensionSpec } from "./extension-spec.js";

export interface PiExtensionResolverDependencies {
  /** Pi's agent directory; defaults to the SDK's `getAgentDir()`. */
  readonly agentDir?: string;
  /** Looks up Pi's user-scope install of an npm source without installing anything. */
  readonly installedPath?: (source: string, agentDir: string) => string | undefined;
  readonly readFile?: (path: string) => Promise<string>;
  readonly realpath?: (path: string) => Promise<string>;
}

function installedPathFromPi(source: string, agentDir: string): string | undefined {
  const settingsManager = SettingsManager.inMemory(undefined, { projectTrusted: false });
  // `getInstalledPath` only looks the directory up; `resolve()` would run `npm install`.
  return new DefaultPackageManager({ cwd: agentDir, agentDir, settingsManager }).getInstalledPath(source, "user");
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

/**
 * Resolves a pinned extension to the real directory of Pi's installed package.
 * It never installs, never imports extension code and never reports a path.
 */
export async function resolvePiExtension(extension: ExtensionSpec, dependencies: PiExtensionResolverDependencies = {}): Promise<string> {
  const agentDir = dependencies.agentDir ?? getAgentDir();
  const read = dependencies.readFile ?? ((path: string) => readFile(path, "utf8"));
  const real = dependencies.realpath ?? realpath;
  let installed: string | undefined;
  try { installed = (dependencies.installedPath ?? installedPathFromPi)(`npm:${extension.name}`, agentDir); }
  catch { throw new PiExtensionError("extension_load_failed"); }
  if (installed === undefined) throw new PiExtensionError("extension_not_installed");
  let root: string;
  let manifest: unknown;
  try {
    root = await real(installed);
    manifest = JSON.parse(await read(join(root, "package.json")));
  } catch (error) {
    throw new PiExtensionError(isMissing(error) ? "extension_not_installed" : "extension_load_failed");
  }
  if (typeof manifest !== "object" || manifest === null) throw new PiExtensionError("extension_load_failed");
  const { version, pi } = manifest as { version?: unknown; pi?: { extensions?: unknown } };
  if (version !== extension.version) throw new PiExtensionError("extension_version_mismatch");
  const entries = pi?.extensions;
  if (!Array.isArray(entries) || entries.length === 0
    || !entries.every((entry) => typeof entry === "string" && entry.length > 0 && !isAbsolute(entry))) {
    throw new PiExtensionError("extension_load_failed");
  }
  for (const entry of entries as string[]) {
    let target: string;
    try { target = await real(join(root, entry)); }
    catch { throw new PiExtensionError("extension_load_failed"); }
    if (!inside(root, target)) throw new PiExtensionError("extension_load_failed");
  }
  return root;
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/pi-extensions.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full gate**

Run: `npm run typecheck && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/pi-extensions.ts test/pi-extensions.test.ts
git commit -m "feat: resolve pinned Pi extensions from Pi's install without installing

Refs #34

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Fuzo8ySrHK1TLhaQ12LxaJ"
```

---

### Task 3: Doctor checks for configured extensions

**Files:**
- Modify:
  - `src/doctor.ts` (`DoctorCheckId`, `CHECK_ORDER`, `DoctorDependencies`, `runDoctor`)
  - `docs/doctor-design.md`
- Test: `test/doctor.test.ts`

**Interfaces:**
- Consumes:
  - Task 1: `ExtensionSpec`, `PiExtensionError`.
  - Task 2: `resolvePiExtension`, loaded by dynamic import only when a profile has extensions.
- Produces:
  - `DoctorCheckId` gains `"extension_missing"` and `"extension_version_mismatch"`. They sort last in `CHECK_ORDER`, in that order.
  - `DoctorDependencies.resolveExtension?: (extension: ExtensionSpec) => Promise<string>`.

- [ ] **Step 1: Write the failing tests**

In `test/doctor.test.ts`, change the vitest import to `import { afterAll, describe, expect, it, vi } from "vitest";` and add:

```ts
import { parseExtensionSpec, PiExtensionError } from "../src/extension-spec.js";
```

Append inside `describe("offline doctor", …)`:

```ts
  const extension = parseExtensionSpec("npm:fixture-ext@1.2.3")!;
  const configWithExtension = async () => {
    const base = await healthyConfig();
    return { ...base, executionProfiles: new Map([["safe", { ...base.executionProfiles.get("safe")!, extensions: [extension] }]]) };
  };
  const extensionFs = () => fsFor({ files: ["/root/dist/main.js"], dirs: ["/hidden/workspace"] });

  it("reports installed pinned extensions as ok", async () => {
    const resolveExtension = vi.fn(async () => "/hidden/extension");
    const result = await runDoctor({ packageRoot: "/root", fileSystem: extensionFs(), loadConfig: configWithExtension, resolveExtension });
    expect(resolveExtension).toHaveBeenCalledWith(extension);
    expect(result.checks).toContainEqual({ id: "extension_missing", severity: "ok", subject: "safe:fixture-ext" });
    expect(result.checks).toContainEqual({ id: "extension_version_mismatch", severity: "ok", subject: "safe:fixture-ext" });
    expect(result.checks.slice(-2).map((check) => check.id)).toEqual(["extension_missing", "extension_version_mismatch"]);
  });

  it.each([
    ["extension_not_installed", "extension_missing"],
    ["extension_version_mismatch", "extension_version_mismatch"],
    ["extension_load_failed", "extension_version_mismatch"],
  ] as const)("maps %s to a failing %s check without a path", async (code, id) => {
    const result = await runDoctor({
      packageRoot: "/root", fileSystem: extensionFs(), loadConfig: configWithExtension,
      resolveExtension: async () => { throw new PiExtensionError(code); },
    });
    expect(result.checks).toContainEqual(expect.objectContaining({ id, severity: "error", subject: "safe:fixture-ext" }));
    expect(result.exitCode).toBe(2);
    expect(JSON.stringify(result)).not.toContain("/hidden/extension");
  });

  it("never resolves extensions when no profile has any", async () => {
    const resolveExtension = vi.fn(async () => "/hidden/extension");
    await runDoctor({ packageRoot: "/root", fileSystem: extensionFs(), loadConfig: healthyConfig, resolveExtension });
    expect(resolveExtension).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/doctor.test.ts`
Expected: FAIL. No `extension_*` checks are produced, and TypeScript reports the unknown `resolveExtension` dependency.

- [ ] **Step 3: Implement the checks**

In `src/doctor.ts`:

1. Add the import:

```ts
import { PiExtensionError, type ExtensionSpec } from "./extension-spec.js";
```

2. Extend the union:

```ts
  | "workspace_not_writable" | "extension_missing" | "extension_version_mismatch";
```

3. Append to `CHECK_ORDER`, after `"workspace_not_writable"`:

```ts
"extension_missing", "extension_version_mismatch"
```

4. Add to `DoctorDependencies`:

```ts
  /** Reads the installed manifest of a pinned extension; never imports extension code. */
  readonly resolveExtension?: (extension: ExtensionSpec) => Promise<string>;
```

5. In `runDoctor`, insert directly after the workspace `if (config) { … }` block and before `const rank = …`:

```ts
  if (config) {
    const resolveExtension = dependencies.resolveExtension
      ?? (async (extension: ExtensionSpec) => (await import("./pi-extensions.js")).resolvePiExtension(extension));
    for (const [alias, profile] of [...config.executionProfiles].sort(([a], [b]) => a.localeCompare(b))) {
      for (const extension of profile.extensions ?? []) {
        const subject = `${alias}:${extension.name}`;
        try {
          await resolveExtension(extension);
          checks.push(ok("extension_missing", subject), ok("extension_version_mismatch", subject));
        } catch (error) {
          const code = error instanceof PiExtensionError ? error.code : "extension_load_failed";
          if (code === "extension_not_installed") checks.push(failure("extension_missing", subject, "install the pinned extension version with Pi"));
          else checks.push(ok("extension_missing", subject), failure("extension_version_mismatch", subject, "install the pinned extension version with Pi"));
        }
      }
    }
  }
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/doctor.test.ts`
Expected: PASS.

- [ ] **Step 5: Document the checks**

In `docs/doctor-design.md`, append these two rows to the check table, directly after the `workspace_not_writable` row:

```markdown
| `extension_missing` | Pi has no user install of a package that a profile's `extensions` names | `<profile>:<package>` |
| `extension_version_mismatch` | The installed manifest's version differs from the pinned version, or the manifest or its `pi.extensions` entries are invalid | `<profile>:<package>` |
```

Directly below the table, add this sentence: "Doctor reads extension manifests through Pi's package-manager lookup only; it never installs packages and never imports extension code."

- [ ] **Step 6: Run the full gate**

Run: `npm run typecheck && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/doctor.ts test/doctor.test.ts docs/doctor-design.md
git commit -m "feat: check configured Pi extensions offline in Doctor

Refs #34

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Fuzo8ySrHK1TLhaQ12LxaJ"
```

---

### Task 4: stdout guard

**Files:**
- Create:
  - `src/stdout-guard.ts`
  - `src/stdout-guard-install.ts`
- Modify: `src/main.ts`
- Test: `test/stdout-guard.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface StdoutGuardOptions { readonly stream?: NodeJS.WriteStream; readonly console?: Pick<Console, "log" | "info" | "debug">; readonly report?: (line: string) => void; readonly intervalMs?: number; readonly onExit?: (flush: () => void) => void }`
  - `interface StdoutGuard { readonly transportStdout: Writable; flush(): void }`
  - `function installStdoutGuard(options?: StdoutGuardOptions): StdoutGuard`
  - `src/stdout-guard-install.ts` exports `const stdoutGuard: StdoutGuard`, installed when the module is evaluated.

- [ ] **Step 1: Write the failing tests**

Create `test/stdout-guard.test.ts`:

```ts
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installStdoutGuard } from "../src/stdout-guard.js";

afterEach(() => { vi.useRealTimers(); });

function harness(intervalMs = 60_000) {
  const written: Buffer[] = [];
  const stream = new Writable({ write(chunk, _encoding, callback) { written.push(Buffer.from(chunk as Buffer)); callback(); } }) as unknown as NodeJS.WriteStream;
  const reports: string[] = [];
  const fakeConsole = { log: vi.fn(), info: vi.fn(), debug: vi.fn() };
  let exitFlush: (() => void) | undefined;
  const guard = installStdoutGuard({ stream, console: fakeConsole, report: (line) => { reports.push(line); }, intervalMs, onExit: (flush) => { exitFlush = flush; } });
  return { guard, stream, written, reports, fakeConsole, exit: () => exitFlush?.() };
}

const transportWrite = (guard: ReturnType<typeof installStdoutGuard>, text: string) => new Promise<void>((resolve, reject) => {
  guard.transportStdout.write(text, (error) => { if (error) reject(error); else resolve(); });
});

describe("stdout guard", () => {
  it("lets only the transport reach stdout and reports foreign output without content", async () => {
    const h = harness();
    await transportWrite(h.guard, '{"jsonrpc":"2.0"}\n');
    h.stream.write("foreign text\n");
    h.fakeConsole.log("secret prompt", 42);
    expect(Buffer.concat(h.written).toString("utf8")).toBe('{"jsonrpc":"2.0"}\n');
    h.guard.flush();
    expect(h.reports).toHaveLength(1);
    expect(JSON.parse(h.reports[0]!)).toEqual({
      level: "warning", event: "foreign_stdout_suppressed",
      bytes: Buffer.byteLength("foreign text\n") + Buffer.byteLength("secret prompt 42\n"), writes: 2,
    });
    expect(h.reports[0]).not.toContain("secret");
  });

  it("completes foreign writes and counts Buffer bytes", async () => {
    const h = harness();
    const done = vi.fn();
    expect(h.stream.write(Buffer.from([1, 2, 3]), done)).toBe(true);
    const doneWithEncoding = vi.fn();
    h.stream.write("ab", "utf8", doneWithEncoding);
    await new Promise((resolve) => setImmediate(resolve));
    expect(done).toHaveBeenCalledTimes(1);
    expect(doneWithEncoding).toHaveBeenCalledTimes(1);
    h.guard.flush();
    expect(JSON.parse(h.reports[0]!)).toMatchObject({ bytes: 5, writes: 2 });
  });

  it("reports at most once per interval and flushes on exit", async () => {
    vi.useFakeTimers();
    const h = harness(1_000);
    h.stream.write("a");
    h.fakeConsole.info("b");
    expect(h.reports).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.reports).toHaveLength(1);
    expect(JSON.parse(h.reports[0]!)).toMatchObject({ writes: 2 });
    h.fakeConsole.debug("c");
    h.exit();
    expect(h.reports).toHaveLength(2);
    h.guard.flush();
    expect(h.reports).toHaveLength(2);
  });

  it("forwards stdout errors to the transport stream", async () => {
    const h = harness();
    const onError = vi.fn();
    h.guard.transportStdout.on("error", onError);
    const failure = Object.assign(new Error("hidden"), { code: "EPIPE" });
    h.stream.emit("error", failure);
    // `destroy(error)` emits the error on a later tick.
    await new Promise((resolve) => setImmediate(resolve));
    expect(onError).toHaveBeenCalledWith(failure);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/stdout-guard.test.ts`
Expected: FAIL. `../src/stdout-guard.js` cannot be resolved.

- [ ] **Step 3: Implement `src/stdout-guard.ts`**

```ts
import { Writable } from "node:stream";
import { format } from "node:util";

export interface StdoutGuardOptions {
  readonly stream?: NodeJS.WriteStream;
  readonly console?: Pick<Console, "log" | "info" | "debug">;
  readonly report?: (line: string) => void;
  readonly intervalMs?: number;
  readonly onExit?: (flush: () => void) => void;
}

export interface StdoutGuard {
  /** The only writer that reaches the real stdout: hand it to the MCP transport. */
  readonly transportStdout: Writable;
  /** Writes the pending suppression counts to stderr. */
  flush(): void;
}

type WriteCallback = (error?: Error | null) => void;

/**
 * Reserves stdout for MCP frames. Any other write, an extension's `console.log`
 * included, is dropped; stderr gets only a byte and write count, never the content,
 * because the content may hold prompts or secrets.
 */
export function installStdoutGuard(options: StdoutGuardOptions = {}): StdoutGuard {
  const stream = options.stream ?? process.stdout;
  const target = options.console ?? console;
  const report = options.report ?? ((line: string) => { process.stderr.write(line); });
  const intervalMs = options.intervalMs ?? 1_000;
  const realWrite = stream.write.bind(stream) as (chunk: unknown, callback?: WriteCallback) => boolean;
  let bytes = 0;
  let writes = 0;
  let timer: NodeJS.Timeout | undefined;

  const flush = (): void => {
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (writes === 0) return;
    report(JSON.stringify({ level: "warning", event: "foreign_stdout_suppressed", bytes, writes }) + "\n");
    bytes = 0;
    writes = 0;
  };
  const suppress = (chunk: unknown, encoding?: unknown): void => {
    bytes += typeof chunk === "string"
      ? Buffer.byteLength(chunk, typeof encoding === "string" ? encoding as BufferEncoding : "utf8")
      : chunk instanceof Uint8Array ? chunk.byteLength : 0;
    writes += 1;
    if (!timer) {
      timer = setTimeout(flush, intervalMs);
      timer.unref();
    }
  };

  stream.write = ((chunk: unknown, encodingOrCallback?: unknown, callback?: unknown): boolean => {
    suppress(chunk, encodingOrCallback);
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    if (typeof done === "function") queueMicrotask(() => { (done as WriteCallback)(); });
    return true;
  }) as typeof stream.write;
  for (const method of ["log", "info", "debug"] as const) {
    target[method] = (...args: unknown[]): void => { suppress(`${format(...args)}\n`); };
  }

  const transportStdout = new Writable({
    write(chunk: Buffer, _encoding, callback) { realWrite(chunk, callback); },
  });
  stream.on("error", (error: Error) => { transportStdout.destroy(error); });
  (options.onExit ?? ((exitFlush: () => void) => { process.once("exit", exitFlush); }))(flush);
  return { transportStdout, flush };
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/stdout-guard.test.ts`
Expected: PASS.

- [ ] **Step 5: Install the guard first in the server entry**

Create `src/stdout-guard-install.ts`:

```ts
import { installStdoutGuard } from "./stdout-guard.js";

/**
 * Installed when this module is evaluated. `main.ts` imports it first, so the guard is
 * in place before any other module, the Pi SDK or an extension, can write to stdout.
 */
export const stdoutGuard = installStdoutGuard();
```

In `src/main.ts`:
- Make `import { stdoutGuard } from "./stdout-guard-install.js";` the first import, directly after the shebang line.
- Change the MCP import to `import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";`.
- Replace the options object passed to `serveStdio` with:

```ts
      {
        transport: new StdioServerTransport(process.stdin, stdoutGuard.transportStdout),
        onerror: () => writeDiagnostic({ level: "error", event: "mcp_transport_error", stage: "transport", code: "mcp_transport_error" }),
      },
```

- [ ] **Step 6: Run the full gate, including the process-level tests that start the real `main.js`**

Run: `npm run typecheck && npx vitest run`
Expected: PASS. In particular, `test/process-stdin-eof.test.ts`, `test/entry-point.test.ts` and `test/mcp-sdk-integration.test.ts` must stay green.

- [ ] **Step 7: Commit**

```bash
git add src/stdout-guard.ts src/stdout-guard-install.ts src/main.ts test/stdout-guard.test.ts
git commit -m "feat: reserve stdout for MCP frames with an always-on guard

Refs #34

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Fuzo8ySrHK1TLhaQ12LxaJ"
```

---

### Task 5: Plain-text prompts

**Files:**
- Modify: `src/sdk-pi-adapter.ts:148-164` (`admitsTurn` comment) and `:209` (`SdkHandle.prompt`)
- Test: `test/sdk-pi-adapter.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: every `session.prompt()` call passes `expandPromptTemplates: false`.

- [ ] **Step 1: Write the failing test**

Append to `test/sdk-pi-adapter.test.ts`:

```ts
describe("plain-text prompts", () => {
  it("sends every prompt as plain text so extension commands never run", async () => {
    const fixture = runtimeFixture();
    const { session } = sessionFixture();
    const adapter = new SdkPiSessionAdapter({ modelRuntimeFactory: async () => fixture.runtime, createSession: createSessionFixture(session) });
    const handle = await create(adapter);
    await handle.prompt("/fixture-cmd hello", () => undefined);
    expect(session.prompt).toHaveBeenCalledWith("/fixture-cmd hello", expect.objectContaining({ expandPromptTemplates: false }));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/sdk-pi-adapter.test.ts -t "plain-text prompts"`
Expected: FAIL. The options object lacks `expandPromptTemplates`.

- [ ] **Step 3: Implement**

In `SdkHandle.prompt`, change the prompt call to:

```ts
      promptResult = this.session.prompt(text, {
        // Client text is content, never a command: no extension command, skill or template dispatch.
        expandPromptTemplates: false,
        preflightResult: (disposition) => signalPreflight(admitsTurn(disposition)),
      });
```

In `admitsTurn`, replace the two comment lines above `case "handled":` with:

```ts
    // An extension input handler consumed the prompt without a model turn. Commands never
    // dispatch (`expandPromptTemplates: false`), but allowlisted extensions may handle input.
```

- [ ] **Step 4: Run the full gate**

Run: `npm run typecheck && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sdk-pi-adapter.ts test/sdk-pi-adapter.test.ts
git commit -m "fix: send client prompts as plain text without command dispatch

Refs #34

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Fuzo8ySrHK1TLhaQ12LxaJ"
```

---

### Task 6: Extension session path in the adapter

**Files:**
- Create:
  - `src/session-tools.ts`
  - `test/session-tools.test.ts`
- Modify:
  - `src/pi-adapter.ts` (error codes and messages)
  - `src/sdk-pi-adapter.ts`
  - `docs/tool-contracts.md:56-72` (error table)
- Test: `test/sdk-pi-adapter.test.ts`

**Interfaces:**
- Consumes:
  - Task 1: `ExtensionSpec`, `PiExtensionError`.
  - Task 2: `resolvePiExtension`.
  - Task 5: plain-text prompts.
- Produces:
  - `PROFILE_TOOLS` moves to `src/session-tools.ts` and is re-exported unchanged from `src/sdk-pi-adapter.ts`.
  - `function composeSessionTools(permissionProfile: PermissionProfile, mcpToolNames: readonly string[], extensionToolNames: readonly (readonly string[])[]): string[] | undefined`
  - `interface ExtensionSdk { readonly createServices: typeof createAgentSessionServices; readonly createSessionFromServices: typeof createAgentSessionFromServices; readonly createRuntime: typeof createAgentSessionRuntime }`, exported from `src/sdk-pi-adapter.ts`.
  - `SdkPiSessionAdapterOptions` gains:
    - `resolveExtension?: (extension: ExtensionSpec) => Promise<string>`
    - `extensionSdk?: ExtensionSdk`
  - `SdkPiAdapterDiagnostic.stage` gains `"extension_resolve" | "extension_load" | "extension_bind"`.
  - `SdkPiAdapterDiagnostic` gains the optional field `extension?: string`, formatted as `<name>@<version>`.
  - `PiSessionCreationErrorCode` gains `"extension_not_installed" | "extension_version_mismatch" | "extension_load_failed" | "extension_tool_conflict"`.

- [ ] **Step 1: Write the failing tool-composition tests**

Create `test/session-tools.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { composeSessionTools, PROFILE_TOOLS } from "../src/session-tools.js";

describe("composeSessionTools", () => {
  it("activates extension tools only in coding profiles", () => {
    expect(composeSessionTools("read-only", ["mcp_note"], [["fixture_tool"]])).toEqual([...PROFILE_TOOLS["read-only"], "mcp_note"]);
    expect(composeSessionTools("coding", ["mcp_note"], [["fixture_tool"], ["other_tool"]])).toEqual([...PROFILE_TOOLS.coding, "mcp_note", "fixture_tool", "other_tool"]);
  });

  it.each([
    ["read-only", [], [["read"]]],
    ["read-only", [], [["bash"]]],
    ["coding", ["mcp_note"], [["mcp_note"]]],
    ["coding", [], [["dup"], ["dup"]]],
  ] as const)("fails closed on a %s conflict", (permissionProfile, mcp, extension) => {
    expect(composeSessionTools(permissionProfile, mcp, extension)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/session-tools.test.ts`
Expected: FAIL. `../src/session-tools.js` cannot be resolved.

- [ ] **Step 3: Implement `src/session-tools.ts` and move `PROFILE_TOOLS`**

```ts
import type { PermissionProfile } from "./execution-profile.js";

export const PROFILE_TOOLS: Readonly<Record<PermissionProfile, readonly string[]>> = {
  "read-only": ["read", "grep", "find", "ls"],
  coding: ["read", "bash", "edit", "write", "grep", "find", "ls"],
};

/**
 * The tool allowlist of a session, or undefined when an extension tool name conflicts.
 * Extension tools are active only in coding profiles, but a conflict fails closed in both,
 * so an extension can never shadow a built-in or granted tool.
 */
export function composeSessionTools(
  permissionProfile: PermissionProfile,
  mcpToolNames: readonly string[],
  extensionToolNames: readonly (readonly string[])[],
): string[] | undefined {
  const reserved = new Set([...PROFILE_TOOLS.coding, ...PROFILE_TOOLS["read-only"], ...mcpToolNames]);
  const extensionTools: string[] = [];
  for (const names of extensionToolNames) {
    for (const name of names) {
      if (reserved.has(name)) return undefined;
      reserved.add(name);
      extensionTools.push(name);
    }
  }
  return [...PROFILE_TOOLS[permissionProfile], ...mcpToolNames, ...(permissionProfile === "coding" ? extensionTools : [])];
}
```

In `src/sdk-pi-adapter.ts`:
- Delete the `PROFILE_TOOLS` constant.
- Add `import { composeSessionTools, PROFILE_TOOLS } from "./session-tools.js";`.
- Add `export { PROFILE_TOOLS } from "./session-tools.js";` so existing importers keep working.

Run: `npx vitest run test/session-tools.test.ts`
Expected: PASS.

- [ ] **Step 4: Write the failing adapter tests**

Add to the imports of `test/sdk-pi-adapter.test.ts`:

```ts
import type { AgentSessionRuntime, AgentSessionServices, CreateAgentSessionRuntimeFactory } from "@earendil-works/pi-coding-agent";
import { parseExtensionSpec, PiExtensionError } from "../src/extension-spec.js";
import type { ExtensionSdk } from "../src/sdk-pi-adapter.js";
```

Append:

```ts
const fixtureExtension = parseExtensionSpec("npm:fixture-ext@1.2.3")!;
const extensionProfile: ResolvedExecutionProfile = Object.freeze({ ...profile, alias: "with-extension", extensions: Object.freeze([fixtureExtension]) });

function extensionHarness(options: {
  permissionProfile?: "read-only" | "coding";
  extensionTools?: string[][];
  loadErrors?: number;
  diagnosticError?: boolean;
  activeTools?: string[];
} = {}) {
  const permissionProfile = options.permissionProfile ?? "read-only";
  const extensionTools = options.extensionTools ?? [["fixture_tool"]];
  const expectedTools = permissionProfile === "coding" ? [...PROFILE_TOOLS.coding, ...extensionTools.flat()] : [...PROFILE_TOOLS["read-only"]];
  const fixture = runtimeFixture();
  const { session, dispose: sessionDispose } = sessionFixture();
  const bindExtensions = vi.fn(async (_bindings: unknown) => undefined);
  Object.assign(session as object, { bindExtensions, getActiveToolNames: vi.fn(() => options.activeTools ?? expectedTools) });
  const services = {
    cwd: "/hidden/workspace", agentDir: "/hidden/workspace", modelRuntime: fixture.runtime, settingsManager: {},
    diagnostics: options.diagnosticError ? [{ type: "error", message: "hidden" }] : [],
    resourceLoader: {
      getExtensions: () => ({
        extensions: extensionTools.map((names) => ({ tools: new Map(names.map((name) => [name, {}])) })),
        errors: Array.from({ length: options.loadErrors ?? 0 }, () => ({ path: "/hidden", error: "hidden" })),
      }),
    },
  } as unknown as AgentSessionServices;
  const runtimeDispose = vi.fn(async () => undefined);
  const sessionRuntime = { session, dispose: runtimeDispose } as unknown as AgentSessionRuntime;
  const createServices = vi.fn(async (_options: unknown) => services);
  const createSessionFromServices = vi.fn(async (_options: unknown) => ({ session }) as unknown as CreateAgentSessionResult);
  const createRuntime = vi.fn(async (factory: CreateAgentSessionRuntimeFactory, runtimeOptions: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
    await factory(runtimeOptions);
    return sessionRuntime;
  });
  const resolveExtension = vi.fn(async (_extension: unknown) => "/hidden/extension/fixture-ext");
  const runtimeFactory = vi.fn(async () => fixture.runtime);
  const createSession = createSessionFixture(session);
  const diagnostics: SdkPiAdapterDiagnostic[] = [];
  const adapter = new SdkPiSessionAdapter({
    modelRuntimeFactory: runtimeFactory, createSession, resolveExtension,
    extensionSdk: { createServices, createSessionFromServices, createRuntime } as unknown as ExtensionSdk,
    diagnosticSink: (diagnostic) => { diagnostics.push(diagnostic); },
  });
  const executionProfile: ResolvedExecutionProfile = { ...extensionProfile, permissionProfile };
  return {
    adapter, fixture, session, sessionDispose, bindExtensions, services, sessionRuntime, runtimeDispose, createServices,
    createSessionFromServices, createRuntime, resolveExtension, runtimeFactory, createSession, diagnostics, expectedTools,
    create: (override: ResolvedExecutionProfile = executionProfile) => adapter.create({ cwd: "/hidden/workspace", executionProfile: override }),
  };
}

describe("SdkPiSessionAdapter allowlisted extensions", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("loads extensions through services before verifying the selection", async () => {
    const h = extensionHarness();
    const handle = await h.create();
    expect(h.resolveExtension).toHaveBeenCalledWith(fixtureExtension);
    expect(h.createServices).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/hidden/workspace", agentDir: "/hidden/workspace", modelRuntime: h.fixture.runtime,
      resourceLoaderOptions: expect.objectContaining({
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        additionalExtensionPaths: ["/hidden/extension/fixture-ext"],
      }),
    }));
    expect(h.createServices.mock.invocationCallOrder[0]!).toBeLessThan(h.fixture.getProvider.mock.invocationCallOrder[0]!);
    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.createSessionFromServices).toHaveBeenCalledWith(expect.objectContaining({
      services: h.services, model: h.fixture.resolvedModel, thinkingLevel: profile.thinkingLevel, tools: PROFILE_TOOLS["read-only"],
    }));
    expect(h.bindExtensions).toHaveBeenCalledWith({ mode: "print" });
    expect(handle.appliedSelection).toEqual({ provider: profile.provider, model: profile.model, thinkingLevel: profile.thinkingLevel });
  });

  it("gives every extension session its own model runtime", async () => {
    const h = extensionHarness();
    await Promise.all([h.create(), h.create()]);
    expect(h.runtimeFactory).toHaveBeenCalledTimes(2);
    expect(h.createServices).toHaveBeenCalledTimes(2);
  });

  it("keeps profiles without extensions on the unchanged path", async () => {
    const h = extensionHarness();
    await h.create(profile);
    await h.create({ ...profile, extensions: [] });
    expect(h.createServices).not.toHaveBeenCalled();
    expect(h.createSession).toHaveBeenCalledTimes(2);
    expect(h.runtimeFactory).toHaveBeenCalledTimes(1);
  });

  it("activates extension tools in coding profiles", async () => {
    const h = extensionHarness({ permissionProfile: "coding" });
    await h.create();
    expect(h.createSessionFromServices).toHaveBeenCalledWith(expect.objectContaining({ tools: [...PROFILE_TOOLS.coding, "fixture_tool"] }));
  });

  it.each([
    ["read-only", [["read"]]],
    ["coding", [["bash"]]],
    ["coding", [["dup"], ["dup"]]],
  ] as const)("fails closed on a %s tool conflict %j", async (permissionProfile, extensionTools) => {
    const h = extensionHarness({ permissionProfile, extensionTools: extensionTools.map((names) => [...names]) });
    await expect(h.create()).rejects.toMatchObject({ code: "extension_tool_conflict" });
    expect(h.createRuntime).not.toHaveBeenCalled();
  });

  it.each(["extension_not_installed", "extension_version_mismatch", "extension_load_failed"] as const)("reports a %s resolution failure", async (code) => {
    const h = extensionHarness();
    h.resolveExtension.mockRejectedValueOnce(new PiExtensionError(code));
    await expect(h.create()).rejects.toMatchObject({ name: "PiSessionCreationError", code });
    expect(h.diagnostics).toContainEqual(expect.objectContaining({ stage: "extension_resolve", code, extension: "fixture-ext@1.2.3" }));
    expect(JSON.stringify(h.diagnostics)).not.toContain("/hidden");
    expect(h.runtimeFactory).not.toHaveBeenCalled();
    expect(h.createServices).not.toHaveBeenCalled();
  });

  it("classifies a foreign resolver failure as a load failure", async () => {
    const h = extensionHarness();
    h.resolveExtension.mockRejectedValueOnce(new Error("/hidden/path"));
    await expect(h.create()).rejects.toMatchObject({ code: "extension_load_failed" });
  });

  it.each([{ loadErrors: 1 }, { diagnosticError: true }])("fails closed on extension load errors %j", async (options) => {
    const h = extensionHarness(options);
    await expect(h.create()).rejects.toMatchObject({ code: "extension_load_failed" });
    expect(h.diagnostics).toContainEqual(expect.objectContaining({ stage: "extension_load", code: "extension_load_failed" }));
    expect(h.createRuntime).not.toHaveBeenCalled();
  });

  it("disposes the session runtime when binding fails", async () => {
    const h = extensionHarness();
    h.bindExtensions.mockRejectedValueOnce(new Error("hidden"));
    await expect(h.create()).rejects.toMatchObject({ code: "extension_load_failed" });
    expect(h.diagnostics).toContainEqual(expect.objectContaining({ stage: "extension_bind" }));
    expect(h.runtimeDispose).toHaveBeenCalledTimes(1);
  });

  it("rejects an active tool set that differs after binding and disposes the runtime", async () => {
    const h = extensionHarness({ activeTools: [...PROFILE_TOOLS["read-only"], "fixture_tool"] });
    await expect(h.create()).rejects.toMatchObject({ code: "execution_selection_mismatch" });
    expect(h.runtimeDispose).toHaveBeenCalledTimes(1);
  });

  it("closes through the session runtime so session_shutdown runs", async () => {
    const h = extensionHarness();
    const handle = await h.create();
    await handle.dispose();
    expect(h.runtimeDispose).toHaveBeenCalledTimes(1);
    expect(h.sessionDispose).not.toHaveBeenCalled();
  });

  it("disposes a session runtime that resolves after the creation deadline", async () => {
    vi.useFakeTimers();
    try {
      const h = extensionHarness();
      const late = deferred<AgentSessionRuntime>();
      h.createRuntime.mockImplementationOnce(() => late.promise);
      const outcome = expect(h.create()).rejects.toMatchObject({ code: "pi_session_creation_failed" });
      await vi.advanceTimersByTimeAsync(SESSION_CREATION_TIMEOUT_MS);
      await outcome;
      late.resolve(h.sessionRuntime);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.runtimeDispose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 5: Run them to verify they fail**

Run: `npx vitest run test/sdk-pi-adapter.test.ts -t "allowlisted extensions"`
Expected: FAIL. TypeScript reports that `ExtensionSdk` is not exported, and that `resolveExtension` and `extensionSdk` are unknown options.

- [ ] **Step 6: Add the error codes**

In `src/pi-adapter.ts`, extend `PiSessionCreationErrorCode` before `"pi_session_creation_failed"`:

```ts
  | "extension_not_installed"
  | "extension_version_mismatch"
  | "extension_load_failed"
  | "extension_tool_conflict"
```

Add the matching entries to `PI_SESSION_CREATION_MESSAGES`:

```ts
  extension_not_installed: "Configured Pi extension is not installed",
  extension_version_mismatch: "Configured Pi extension version is not installed",
  extension_load_failed: "Configured Pi extension could not be loaded",
  extension_tool_conflict: "Configured Pi extension tools conflict",
```

- [ ] **Step 7: Restructure `SdkPiSessionAdapter` and add the extension path**

All edits are in `src/sdk-pi-adapter.ts`.

1. Change the SDK import to:

```ts
import {
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type AgentSessionServices,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type CreateAgentSessionServicesOptions,
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  DefaultResourceLoader,
  ModelRuntime,
  type PromptOptions,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
```

   Add these imports:

```ts
import { PiExtensionError, type ExtensionSpec } from "./extension-spec.js";
import { resolvePiExtension } from "./pi-extensions.js";
```

2. Extend the diagnostic and the options:

```ts
export interface SdkPiAdapterDiagnostic {
  readonly level: "error";
  readonly event: "pi_session_creation_failed";
  readonly stage: "runtime" | "provider" | "model" | "check_auth" | "get_auth" | "availability" | "resource_loader" | "mcp_tools" | "create_session" | "postcheck" | "extension_resolve" | "extension_load" | "extension_bind";
  readonly code: PiSessionCreationErrorCode;
  readonly executionProfile: string;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: ThinkingLevel;
  readonly serverAlias?: string;
  readonly toolAlias?: string;
  readonly discoveredToolCount?: number;
  /** `<name>@<version>` of the extension that failed to resolve; never a path. */
  readonly extension?: string;
}

/** The Pi SDK session-lifecycle API used for profiles with extensions; injectable for tests. */
export interface ExtensionSdk {
  readonly createServices: typeof createAgentSessionServices;
  readonly createSessionFromServices: typeof createAgentSessionFromServices;
  readonly createRuntime: typeof createAgentSessionRuntime;
}

const DEFAULT_EXTENSION_SDK: ExtensionSdk = {
  createServices: createAgentSessionServices,
  createSessionFromServices: createAgentSessionFromServices,
  createRuntime: createAgentSessionRuntime,
};

export interface SdkPiSessionAdapterOptions {
  readonly modelRuntimeFactory?: () => Promise<ModelRuntime>;
  readonly createSession?: CreateSession;
  readonly diagnosticSink?: (diagnostic: SdkPiAdapterDiagnostic) => void;
  readonly mcpConnectionFactory?: McpConnectionFactory;
  /** Resolves a pinned extension to its installed package directory. */
  readonly resolveExtension?: (extension: ExtensionSpec) => Promise<string>;
  readonly extensionSdk?: ExtensionSdk;
}
```

3. Replace the `createSessionWithDeadline` method with this module-level helper, placed after `withAuthDeadline`:

```ts
/** Races an SDK operation against the session-creation bound; a late success goes to `disposeLate`. */
async function withCreationDeadline<T>(start: () => Promise<T>, disposeLate: (value: T) => void = () => undefined): Promise<T> {
  let operation: Promise<T>;
  try {
    operation = Promise.resolve(start());
  } catch {
    throw new SessionCreationDeadlineError();
  }
  let timedOut = false;
  // This continuation is installed immediately and owns late cleanup. Its rejection
  // branch is required even when the deadline wins the race.
  const observed = operation.then(
    (value) => {
      if (timedOut) disposeLate(value);
      return value;
    },
    (error: unknown) => { throw error; },
  );
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new SessionCreationDeadlineError());
    }, SESSION_CREATION_TIMEOUT_MS);
  });
  try {
    return await Promise.race([observed, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
```

4. Share the resource-loader options:

```ts
/** Resource-loader options for every embedded session: no discovery, skills, templates or themes. */
function phase0ResourceLoaderOptions(): NonNullable<CreateAgentSessionServicesOptions["resourceLoaderOptions"]> {
  return {
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: false,
    systemPrompt: "phase-0-system-prompt-disabled",
    appendSystemPrompt: [],
    systemPromptOverride: () => undefined,
    appendSystemPromptOverride: () => [],
  };
}
```

   Change `createPhase0ResourceLoader` to:

```ts
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, ...phase0ResourceLoaderOptions() });
```

5. Let `SdkHandle` dispose through an injected function. Change the constructor to:

```ts
  constructor(
    private readonly session: AgentSession,
    readonly appliedSelection: PiAppliedSelection,
    private readonly mcpTools: SessionMcpTools,
    private readonly disposeSession: () => void | Promise<void> = () => disposeSdkSession(session),
  ) {}
```

   In `dispose()`, replace the two lines `disposeSdkSession(this.session);` and `void closed.then(finish, finish);` with:

```ts
    let sessionClosed: Promise<void>;
    try { sessionClosed = Promise.resolve(this.disposeSession()).then(() => undefined, () => undefined); }
    catch { sessionClosed = Promise.resolve(); }
    void Promise.all([closed.then(() => undefined, () => undefined), sessionClosed]).then(finish, finish);
```

6. In the class:
   - Add the fields `private readonly resolveExtension: (extension: ExtensionSpec) => Promise<string>;` and `private readonly extensionSdk: ExtensionSdk;`.
   - Initialize them in the constructor:

```ts
    this.resolveExtension = options.resolveExtension ?? ((extension) => resolvePiExtension(extension));
    this.extensionSdk = options.extensionSdk ?? DEFAULT_EXTENSION_SDK;
```

7. Replace the whole `create` method with:

```ts
  async create(input: { cwd: string; executionProfile: ResolvedExecutionProfile; signal?: AbortSignal }): Promise<PiSessionHandle> {
    const extensions = input.executionProfile.extensions ?? [];
    if (extensions.length > 0) return this.createWithExtensions(input, extensions);
    const { executionProfile } = input;
    let runtime: ModelRuntime;
    try {
      runtime = await this.getRuntime();
    } catch {
      throw this.failure(executionProfile, "runtime", "pi_session_creation_failed");
    }
    const model = await this.resolveVerifiedModel(runtime, executionProfile);

    let resourceLoader: DefaultResourceLoader;
    let settingsManager: SettingsManager;
    try {
      ({ resourceLoader, settingsManager } = await createPhase0ResourceLoader(input.cwd));
    } catch {
      throw this.failure(executionProfile, "resource_loader", "pi_session_creation_failed");
    }

    const mcpTools = await this.connectMcpTools(input);
    const tools = [...PROFILE_TOOLS[executionProfile.permissionProfile], ...mcpTools.tools.map((tool) => tool.name)];
    let session: AgentSession;
    try {
      ({ session } = await withCreationDeadline(
        () => this.createSession({
          cwd: input.cwd,
          modelRuntime: runtime,
          model,
          thinkingLevel: executionProfile.thinkingLevel,
          sessionManager: SessionManager.inMemory(input.cwd),
          settingsManager,
          resourceLoader,
          // With an explicit tools list, Pi also needs custom tool names here to activate them.
          tools,
          ...(mcpTools.tools.length === 0 ? {} : { customTools: mcpTools.tools }),
        }),
        (late) => disposeSdkSession(late.session),
      ));
    } catch {
      await mcpTools.close();
      throw this.failure(executionProfile, "create_session", "pi_session_creation_failed");
    }
    return this.admit(session, executionProfile, tools, mcpTools, () => disposeSdkSession(session),
      mcpTools.tools.length > 0 ? "external_mcp_activation_mismatch" : undefined);
  }

  private async createWithExtensions(
    input: { cwd: string; executionProfile: ResolvedExecutionProfile; signal?: AbortSignal },
    extensions: readonly ExtensionSpec[],
  ): Promise<PiSessionHandle> {
    const { cwd, executionProfile } = input;
    const directories: string[] = [];
    for (const extension of extensions) {
      try {
        directories.push(await this.resolveExtension(extension));
      } catch (error) {
        throw this.failure(executionProfile, "extension_resolve",
          error instanceof PiExtensionError ? error.code : "extension_load_failed",
          { extension: `${extension.name}@${extension.version}` });
      }
    }
    // Extension providers register into the runtime they load with, and the last
    // registration wins, so every extension session gets a runtime of its own.
    let runtime: ModelRuntime;
    try {
      runtime = await this.modelRuntimeFactory();
    } catch {
      throw this.failure(executionProfile, "runtime", "pi_session_creation_failed");
    }
    let services: AgentSessionServices;
    let extensionTools: string[][];
    try {
      services = await withCreationDeadline(() => this.extensionSdk.createServices({
        cwd,
        agentDir: cwd,
        modelRuntime: runtime,
        settingsManager: SettingsManager.inMemory(undefined, { projectTrusted: false }),
        resourceLoaderOptions: { ...phase0ResourceLoaderOptions(), additionalExtensionPaths: directories },
      }));
      const loaded = services.resourceLoader.getExtensions();
      if (loaded.errors.length > 0 || services.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
        throw new Error("extension load reported errors");
      }
      extensionTools = loaded.extensions.map((extension) => [...extension.tools.keys()]);
    } catch {
      throw this.failure(executionProfile, "extension_load", "extension_load_failed");
    }
    const model = await this.resolveVerifiedModel(services.modelRuntime, executionProfile);
    const mcpTools = await this.connectMcpTools(input);
    const tools = composeSessionTools(executionProfile.permissionProfile, mcpTools.tools.map((tool) => tool.name), extensionTools);
    if (!tools) {
      await mcpTools.close();
      throw this.failure(executionProfile, "extension_load", "extension_tool_conflict");
    }
    let sessionRuntime: AgentSessionRuntime;
    try {
      sessionRuntime = await withCreationDeadline(
        () => this.extensionSdk.createRuntime(async ({ sessionManager }) => ({
          ...(await this.extensionSdk.createSessionFromServices({
            services,
            sessionManager,
            model,
            thinkingLevel: executionProfile.thinkingLevel,
            tools,
            ...(mcpTools.tools.length === 0 ? {} : { customTools: mcpTools.tools }),
          })),
          services,
          diagnostics: services.diagnostics,
        }), { cwd, agentDir: cwd, sessionManager: SessionManager.inMemory(cwd) }),
        (late) => { void late.dispose().catch(() => undefined); },
      );
    } catch {
      await mcpTools.close();
      throw this.failure(executionProfile, "create_session", "pi_session_creation_failed");
    }
    // `AgentSessionRuntime.dispose()` emits `session_shutdown` before disposing the session.
    const disposeRuntime = (): Promise<void> => sessionRuntime.dispose().catch(() => undefined);
    try {
      // Without a UI context the SDK binds its no-op UI; binding emits `session_start`.
      await withCreationDeadline(() => sessionRuntime.session.bindExtensions({ mode: "print" }));
    } catch {
      await disposeRuntime();
      await mcpTools.close();
      throw this.failure(executionProfile, "extension_bind", "extension_load_failed");
    }
    return this.admit(sessionRuntime.session, executionProfile, tools, mcpTools, disposeRuntime,
      mcpTools.tools.length > 0 ? "external_mcp_activation_mismatch" : "execution_selection_mismatch");
  }

  /** Provider, model, authentication and availability, exactly as configured. */
  private async resolveVerifiedModel(runtime: ModelRuntime, executionProfile: ResolvedExecutionProfile): Promise<SdkModel> {
    let provider: ReturnType<ModelRuntime["getProvider"]>;
    try {
      provider = runtime.getProvider(executionProfile.provider);
    } catch {
      throw this.failure(executionProfile, "provider", "pi_session_creation_failed");
    }
    if (!provider) throw this.failure(executionProfile, "provider", "unknown_provider");

    let model: SdkModel | undefined;
    try {
      model = runtime.getModel(executionProfile.provider, executionProfile.model);
    } catch {
      throw this.failure(executionProfile, "model", "pi_session_creation_failed");
    }
    if (!model) throw this.failure(executionProfile, "model", "unknown_model");

    let authenticated: boolean;
    try {
      authenticated = Boolean(await withAuthDeadline((signal) => runtime.checkAuth(executionProfile.provider, { signal })));
    } catch {
      throw this.failure(executionProfile, "check_auth", "local_authentication_unavailable");
    }
    if (!authenticated) throw this.failure(executionProfile, "check_auth", "local_authentication_missing");

    try {
      // AuthResult can contain credentials, so reduce it immediately.
      authenticated = Boolean(await withAuthDeadline((signal) => runtime.getAuth(model, { signal })));
    } catch {
      throw this.failure(executionProfile, "get_auth", "local_authentication_unavailable");
    }
    if (!authenticated) throw this.failure(executionProfile, "get_auth", "local_authentication_missing");

    let available: readonly SdkModel[];
    try {
      available = await withAuthDeadline((signal) => runtime.getAvailable(executionProfile.provider, { signal }));
    } catch {
      throw this.failure(executionProfile, "availability", "pi_session_creation_failed");
    }
    if (!available.some((candidate) => candidate.provider === executionProfile.provider && candidate.id === executionProfile.model)) {
      throw this.failure(executionProfile, "availability", "model_unavailable");
    }
    return model;
  }

  private async connectMcpTools(input: { cwd: string; executionProfile: ResolvedExecutionProfile; signal?: AbortSignal }): Promise<SessionMcpTools> {
    try {
      return await connectSessionMcpTools(
        input.executionProfile.mcpServers ?? {}, input.executionProfile.permissionProfile, input.cwd, this.mcpConnectionFactory,
        input.signal === undefined ? {} : { signal: input.signal },
      );
    } catch (error) {
      const failure = classifyMcpStartupError(error);
      throw this.failure(input.executionProfile, "mcp_tools", failure?.code ?? "external_mcp_unavailable", failure);
    }
  }

  /** Post-verifies a created session and wraps it; a mismatch disposes it before reporting. */
  private async admit(
    session: AgentSession,
    executionProfile: ResolvedExecutionProfile,
    tools: readonly string[],
    mcpTools: SessionMcpTools,
    disposeSession: () => void | Promise<void>,
    toolMismatch: PiSessionCreationErrorCode | undefined,
  ): Promise<PiSessionHandle> {
    try {
      if (session.model?.provider !== executionProfile.provider || session.model.id !== executionProfile.model) {
        throw this.failure(executionProfile, "postcheck", "execution_selection_mismatch");
      }
      if (session.thinkingLevel !== executionProfile.thinkingLevel) {
        throw this.failure(executionProfile, "postcheck", "thinking_level_unavailable");
      }
      if (toolMismatch !== undefined) {
        const active = new Set(session.getActiveToolNames());
        if (active.size !== tools.length || tools.some((name) => !active.has(name))) {
          throw this.failure(executionProfile, "postcheck", toolMismatch);
        }
      }
      return new SdkHandle(session, {
        provider: session.model.provider,
        model: session.model.id,
        thinkingLevel: session.thinkingLevel,
      }, mcpTools, disposeSession);
    } catch (error) {
      try { await disposeSession(); } catch { /* Disposal is best effort. */ }
      await mcpTools.close();
      if (error instanceof PiSessionCreationError) throw error;
      throw this.failure(executionProfile, "postcheck", "pi_session_creation_failed");
    }
  }
```

8. Extend `failure()` so it can carry the extension:

```ts
  private failure(
    executionProfile: ResolvedExecutionProfile,
    stage: SdkPiAdapterDiagnostic["stage"],
    code: PiSessionCreationErrorCode,
    metadata?: Pick<McpStartupFailure, "serverAlias" | "toolAlias" | "discoveredToolCount"> & { readonly extension?: string },
  ): PiSessionCreationError {
```

   Inside its diagnostic object, add after the `discoveredToolCount` spread:

```ts
        ...(metadata?.extension === undefined ? {} : { extension: metadata.extension }),
```

- [ ] **Step 8: Run the adapter tests to verify they pass**

Run: `npx vitest run test/sdk-pi-adapter.test.ts test/session-tools.test.ts`
Expected: PASS. That includes every pre-existing test in `test/sdk-pi-adapter.test.ts`; the restructuring must not change their behavior.

- [ ] **Step 9: Document the error codes**

In `docs/tool-contracts.md`, add these rows to the error table before `pi_session_creation_failed`:

```markdown
| `extension_not_installed` | Pi has no installed package for a configured extension. |
| `extension_version_mismatch` | Pi's installed extension package has another version than the configured one. |
| `extension_load_failed` | A configured extension has an invalid manifest, failed to load or failed to bind. |
| `extension_tool_conflict` | An extension tool name collides with a built-in, MCP or other extension tool. |
```

- [ ] **Step 10: Run the full gate**

Run: `npm run typecheck && npx vitest run`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/session-tools.ts src/pi-adapter.ts src/sdk-pi-adapter.ts test/session-tools.test.ts test/sdk-pi-adapter.test.ts docs/tool-contracts.md
git commit -m "feat: load allowlisted Pi extensions per session with their own runtime

Refs #34

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Fuzo8ySrHK1TLhaQ12LxaJ"
```

---

### Task 7: SDK contract with a real fixture extension

**Files:**
- Create:
  - `test/fixtures/pi-extension-fixture/package.json`
  - `test/fixtures/pi-extension-fixture/index.js`
- Test: `test/sdk-extension-contract.test.ts`

**Interfaces:**
- Consumes:
  - Task 2: `resolvePiExtension(extension, { agentDir })`.
  - Task 6: `SdkPiSessionAdapter` options `resolveExtension` and `modelRuntimeFactory`.
- Produces: the fixture extension `pi-extension-fixture@1.0.0`, reused by Task 8.
  - Provider `fixture-ext` with model `fixture-ext-model`. Every turn answers `FIXTURE-PONG`.
  - Tool `fixture_tool` and command `fixture-cmd`.
  - Events go to `globalThis.__piExtensionFixtureEvents`. When `PI_EXTENSION_FIXTURE_LOG` is set, they are also appended to that file as JSON lines `{"event": …}`.
  - Event names:
    - `load`, `session_start`, `stream`, `session_shutdown`
    - `tool`, `command`
    - `tools:<sorted declared tool names joined by ,>`

- [ ] **Step 1: Create the fixture extension**

`test/fixtures/pi-extension-fixture/package.json`:

```json
{
  "name": "pi-extension-fixture",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "pi": { "extensions": ["./index.js"] }
}
```

`test/fixtures/pi-extension-fixture/index.js`:

```js
import { appendFileSync } from "node:fs";

/** Test-only Pi extension: a network-free provider plus probes for tools, commands, stdout and lifecycle. */
const events = (globalThis.__piExtensionFixtureEvents ??= []);

function record(event) {
  events.push(event);
  const log = process.env.PI_EXTENSION_FIXTURE_LOG;
  if (log) appendFileSync(log, `${JSON.stringify({ event })}\n`);
}

function declaredTools(messages = []) {
  const names = new Set();
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsAdded ?? []) names.add(tool.name);
    for (const tool of message.toolsRemoved ?? []) names.delete(typeof tool === "string" ? tool : tool.name);
  }
  return [...names].sort();
}

function assistant(text) {
  return {
    role: "assistant", content: [{ type: "text", text }], api: "fixture-ext-api", provider: "fixture-ext", model: "fixture-ext-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: Date.now(),
  };
}

function streamOf(final) {
  let sent = false;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (sent) return { value: undefined, done: true };
          sent = true;
          return { value: { type: "start", partial: final }, done: false };
        },
      };
    },
    async result() { return final; },
  };
}

export default function fixtureExtension(pi) {
  record("load");
  console.log("pi-extension-fixture: console.log at load");
  process.stdout.write("pi-extension-fixture: raw stdout at load\n");
  pi.registerProvider("fixture-ext", {
    name: "Fixture extension provider", baseUrl: "http://127.0.0.1:9", apiKey: "fixture-placeholder", api: "fixture-ext-api",
    models: [{ id: "fixture-ext-model", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
    streamSimple: (_model, context) => {
      record("stream");
      record(`tools:${declaredTools(context?.messages).join(",")}`);
      console.log("pi-extension-fixture: console.log during a turn");
      return streamOf(assistant("FIXTURE-PONG"));
    },
  });
  pi.registerTool({
    name: "fixture_tool", label: "Fixture tool", description: "Records a call.", parameters: { type: "object", properties: {} },
    execute: async () => { record("tool"); return { content: [{ type: "text", text: "fixture" }], details: {} }; },
  });
  pi.registerCommand("fixture-cmd", { description: "Records a command.", handler: async () => { record("command"); } });
  pi.on("session_start", async () => {
    record("session_start");
    // Tries to widen the tool set past the session allowlist.
    pi.setActiveTools([...pi.getActiveTools(), "fixture_tool"]);
  });
  pi.on("session_shutdown", async () => { record("session_shutdown"); });
}
```

- [ ] **Step 2: Write the contract test**

Create `test/sdk-extension-contract.test.ts`:

```ts
/**
 * Pi SDK contract for allowlisted extensions, against the installed SDK and the local
 * fixture extension. No provider, credentials or network: the fixture provider answers
 * from memory. When an SDK upgrade breaks an assumption, the failing test names it.
 */
import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as waitFor } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { parseExtensionSpec } from "../src/extension-spec.js";
import type { PermissionProfile, ResolvedExecutionProfile } from "../src/execution-profile.js";
import { resolvePiExtension } from "../src/pi-extensions.js";
import { SdkPiSessionAdapter } from "../src/sdk-pi-adapter.js";
import { SessionRegistry, type TurnView } from "../src/session-registry.js";
import { PROFILE_TOOLS } from "../src/session-tools.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/pi-extension-fixture", import.meta.url));
const extension = parseExtensionSpec("npm:pi-extension-fixture@1.0.0")!;
const events = (): string[] => ((globalThis as { __piExtensionFixtureEvents?: string[] }).__piExtensionFixtureEvents ??= []);

afterAll(removeTemporaryRoots);
beforeEach(() => { events().length = 0; });

async function harness(permissionProfile: PermissionProfile) {
  const root = await temporaryRoot("pi-session-mcp-extension-contract-");
  const agentDir = join(root, "agent");
  const workspace = join(root, "workspace");
  await mkdir(join(agentDir, "npm", "node_modules"), { recursive: true });
  await mkdir(workspace);
  await cp(FIXTURE, join(agentDir, "npm", "node_modules", "pi-extension-fixture"), { recursive: true });
  const adapter = new SdkPiSessionAdapter({
    modelRuntimeFactory: () => ModelRuntime.create({
      refreshOnCreate: false, allowModelNetwork: false, modelsPath: null,
      authPath: join(agentDir, "auth.json"), modelsStorePath: join(agentDir, "models-store.json"),
    }),
    resolveExtension: (spec) => resolvePiExtension(spec, { agentDir }),
  });
  const registry = new SessionRegistry(adapter, new Map([["repo", workspace]]));
  const executionProfile: ResolvedExecutionProfile = {
    alias: "fixture", permissionProfile, provider: "fixture-ext", model: "fixture-ext-model", thinkingLevel: "off", extensions: [extension],
  };
  return { registry, executionProfile };
}

async function terminal(registry: SessionRegistry, sessionId: string, turnId: string): Promise<TurnView> {
  let turn = registry.getTurn(sessionId, turnId);
  const deadline = Date.now() + 20_000;
  while (turn.state === "running" && Date.now() < deadline) {
    await waitFor(5);
    turn = registry.getTurn(sessionId, turnId);
  }
  return turn;
}

describe("Pi SDK contract for allowlisted extensions", () => {
  it("registers the extension provider before verification and completes a prompt from it", async () => {
    const { registry, executionProfile } = await harness("read-only");
    const session = await registry.start("repo", executionProfile);
    try {
      expect(session).toMatchObject({ provider: "fixture-ext", model: "fixture-ext-model", state: "idle" });
      const accepted = await registry.prompt(session.id, "hello");
      expect(await terminal(registry, session.id, accepted.turn.turnId)).toMatchObject({ state: "completed", assistantText: "FIXTURE-PONG" });
      expect(events()).toEqual(expect.arrayContaining(["load", "session_start", "stream"]));
    } finally {
      await registry.close(session.id);
    }
  }, 30_000);

  it("keeps extension tools away from the model in read-only profiles even against setActiveTools", async () => {
    const { registry, executionProfile } = await harness("read-only");
    const session = await registry.start("repo", executionProfile);
    try {
      const accepted = await registry.prompt(session.id, "list the tools");
      await terminal(registry, session.id, accepted.turn.turnId);
      expect(events()).toContain(`tools:${[...PROFILE_TOOLS["read-only"]].sort().join(",")}`);
    } finally {
      await registry.close(session.id);
    }
  }, 30_000);

  it("declares extension tools to the model in coding profiles", async () => {
    const { registry, executionProfile } = await harness("coding");
    const session = await registry.start("repo", executionProfile);
    try {
      const accepted = await registry.prompt(session.id, "list the tools");
      await terminal(registry, session.id, accepted.turn.turnId);
      expect(events()).toContain(`tools:${[...PROFILE_TOOLS.coding, "fixture_tool"].sort().join(",")}`);
    } finally {
      await registry.close(session.id);
    }
  }, 30_000);

  it("sends slash-command text to the model instead of running the command", async () => {
    const { registry, executionProfile } = await harness("read-only");
    const session = await registry.start("repo", executionProfile);
    try {
      const accepted = await registry.prompt(session.id, "/fixture-cmd now");
      expect(await terminal(registry, session.id, accepted.turn.turnId)).toMatchObject({ state: "completed" });
      expect(events()).not.toContain("command");
      expect(events()).toContain("stream");
    } finally {
      await registry.close(session.id);
    }
  }, 30_000);

  it("runs session_shutdown when the session closes", async () => {
    const { registry, executionProfile } = await harness("read-only");
    const session = await registry.start("repo", executionProfile);
    await registry.close(session.id);
    expect(events()).toContain("session_shutdown");
  }, 30_000);
});
```

- [ ] **Step 3: Run it**

Run: `npx vitest run test/sdk-extension-contract.test.ts`
Expected: PASS. It runs against the implementation from Tasks 1-6, which a throwaway spike had already checked against SDK 1.1.0. If an assertion fails, the SDK contradicts the spec:
- Stop and report the failing assertion verbatim.
- Do not weaken the assertion.
- Do not patch around it.

- [ ] **Step 4: Run the full gate**

Run: `npm run typecheck && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/fixtures/pi-extension-fixture test/sdk-extension-contract.test.ts
git commit -m "test: pin the Pi SDK contract for allowlisted extensions

Refs #34

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Fuzo8ySrHK1TLhaQ12LxaJ"
```

---

### Task 8: Process-level evidence for the stdout guard with an extension

**Files:**
- Create:
  - `test/compiled-entry.ts`
  - `test/process-extension.test.ts`
- Modify: `test/process-stdin-eof.test.ts:50-64` (use the shared compile helper)

**Interfaces:**
- Consumes:
  - Task 4: the guard, through the real `main.js`.
  - Task 6: the extension path.
  - Task 7: the fixture extension.
- Produces: `function compileServerEntry(): Promise<string>`, which returns the absolute path of a freshly compiled `main.js`.

- [ ] **Step 1: Extract the compile helper**

Create `test/compiled-entry.ts`:

```ts
import { execFile } from "node:child_process";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { temporaryRoot } from "./temporary-roots.js";

const REPOSITORY = fileURLToPath(new URL("..", import.meta.url));
const execFileAsync = promisify(execFile);

/**
 * Compiles the current sources into a temporary directory and returns the built `main.js`.
 * CI runs the tests before `npm run build`, so an existing `dist/` may be stale.
 */
export async function compileServerEntry(): Promise<string> {
  const root = await temporaryRoot("pi-session-mcp-entry-build-");
  // The compiled entry imports `../package.json` and the installed packages.
  await symlink(join(REPOSITORY, "package.json"), join(root, "package.json"));
  await symlink(join(REPOSITORY, "node_modules"), join(root, "node_modules"), "dir");
  await execFileAsync(process.execPath, [
    join(REPOSITORY, "node_modules", "typescript", "bin", "tsc"),
    "-p", join(REPOSITORY, "tsconfig.build.json"), "--outDir", join(root, "out"), "--declaration", "false",
  ], { cwd: REPOSITORY, timeout: 120_000 });
  return join(root, "out", "main.js");
}
```

In `test/process-stdin-eof.test.ts`:
- Replace the body of `beforeAll` with `entry = await compileServerEntry();`.
- Keep the `150_000` timeout.
- Add `import { compileServerEntry } from "./compiled-entry.js";`.
- Remove imports that are now unused (`symlink`, `promisify`, `execFile`, `execFileAsync`), but only if nothing else in the file uses them.

Run: `npx vitest run test/process-stdin-eof.test.ts`
Expected: PASS, unchanged.

- [ ] **Step 2: Write the process-level test**

Create `test/process-extension.test.ts`:

```ts
/**
 * Process-level evidence for allowlisted Pi extensions and the stdout guard.
 *
 * Starts the compiled `main.js` with a temporary Pi agent directory that contains the
 * fixture extension. The fixture writes to stdout at load and during a turn; every
 * stdout line must still be an MCP frame. No provider, credentials or network.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as waitFor } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { compileServerEntry } from "./compiled-entry.js";
import { readFixtureLog } from "./fixture-log.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/pi-extension-fixture", import.meta.url));
let entry = "";
const servers: ChildProcessWithoutNullStreams[] = [];

beforeAll(async () => { entry = await compileServerEntry(); }, 150_000);
afterEach(() => {
  for (const server of servers.splice(0)) if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
});
afterAll(removeTemporaryRoots);

interface ToolResult { structuredContent?: Record<string, unknown> }

async function startServer() {
  const root = await temporaryRoot("pi-session-mcp-extension-process-");
  const agentDir = join(root, "agent");
  const workspace = join(root, "workspace");
  await mkdir(join(agentDir, "npm", "node_modules"), { recursive: true });
  await mkdir(workspace);
  await cp(FIXTURE, join(agentDir, "npm", "node_modules", "pi-extension-fixture"), { recursive: true });
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({
    workspaces: { project: workspace },
    executionProfiles: {
      safe: {
        default: true, permissionProfile: "read-only", provider: "fixture-ext", model: "fixture-ext-model", thinkingLevel: "off",
        extensions: ["npm:pi-extension-fixture@1.0.0"],
      },
    },
  }));
  const eventLog = join(root, "extension.jsonl");
  const server = spawn(process.execPath, [entry], {
    cwd: workspace,
    env: { PATH: process.env.PATH ?? "", HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_SESSION_MCP_CONFIG: config, PI_EXTENSION_FIXTURE_LOG: eventLog },
    stdio: ["pipe", "pipe", "pipe"],
  });
  servers.push(server);
  let stderr = "";
  server.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  server.stdin.on("error", () => undefined);
  const foreignLines: string[] = [];
  const pending = new Map<number, (message: { result?: ToolResult }) => void>();
  createInterface({ input: server.stdout }).on("line", (line) => {
    let message: { id?: unknown; result?: ToolResult };
    try { message = JSON.parse(line) as typeof message; } catch { foreignLines.push(line); return; }
    if (typeof message.id === "number") pending.get(message.id)?.(message);
  });
  let nextId = 1;
  const send = (message: Record<string, unknown>) => { server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`); };
  const request = (method: string, params: Record<string, unknown>) => new Promise<{ result?: ToolResult }>((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ id, method, params });
  });
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "extension-test", version: "0.0.0" } });
  send({ method: "notifications/initialized" });
  return {
    eventLog,
    foreignLines,
    diagnostics: () => stderr.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>),
    callTool: async (name: string, args: Record<string, unknown>) => (await request("tools/call", { name, arguments: args })).result?.structuredContent ?? {},
  };
}

describe("allowlisted Pi extension in the server process", () => {
  it("keeps stdout to MCP frames while an extension writes to it", async () => {
    const harness = await startServer();
    expect(await harness.callTool("pi_capabilities_get", {})).toMatchObject({
      executionProfiles: [{ alias: "safe", extensions: ["npm:pi-extension-fixture@1.0.0"] }],
    });
    const started = await harness.callTool("pi_session_start", { workspace: "project" }) as { ok: boolean; session: { id: string } };
    expect(started).toMatchObject({ ok: true, session: { provider: "fixture-ext", state: "idle" } });
    const prompted = await harness.callTool("pi_session_prompt", { sessionId: started.session.id, prompt: "/fixture-cmd hello" }) as { turn: { turnId: string } };
    let turn: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 400; attempt++) {
      turn = (await harness.callTool("pi_turn_get", { sessionId: started.session.id, turnId: prompted.turn.turnId }) as { turn: Record<string, unknown> }).turn;
      if (turn.state !== "running") break;
      await waitFor(25);
    }
    expect(turn).toMatchObject({ state: "completed", assistantText: "FIXTURE-PONG" });
    expect(await harness.callTool("pi_session_close", { sessionId: started.session.id })).toMatchObject({ ok: true });

    const events = (await readFixtureLog<{ event: string }>(harness.eventLog)).map((record) => record.event);
    expect(events).toEqual(expect.arrayContaining(["load", "session_start", "stream", "session_shutdown"]));
    expect(events).not.toContain("command");
    expect(harness.foreignLines).toEqual([]);
    // The guard reports at most once per second.
    await waitFor(1_200);
    const suppressed = harness.diagnostics().filter((line) => line.event === "foreign_stdout_suppressed");
    expect(suppressed.length).toBeGreaterThan(0);
    expect(suppressed.every((line) => typeof line.bytes === "number" && typeof line.writes === "number")).toBe(true);
    expect(JSON.stringify(harness.diagnostics())).not.toContain("pi-extension-fixture:");
  }, 60_000);
});
```

- [ ] **Step 3: Run it**

Run: `npx vitest run test/process-extension.test.ts`
Expected: PASS. If `foreignLines` is not empty, the guard misses a write path. Fix that in `src/stdout-guard.ts`, never in the test.

- [ ] **Step 4: Run the full gate**

Run: `npm run typecheck && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/compiled-entry.ts test/process-extension.test.ts test/process-stdin-eof.test.ts
git commit -m "test: prove stdout stays MCP-only with an extension in the server process

Refs #34

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Fuzo8ySrHK1TLhaQ12LxaJ"
```

---

### Task 9: Governance and operator documentation

**Files:**
- Create: `docs/adr/0006-pi-extension-allowlist.md`
- Modify:
  - `docs/threat-model.md`
  - `docs/architecture.md` (section "Scope")
  - `docs/installation.md` (new section "Pi extensions")
  - `AGENTS.md`
  - `docs/acceptance.md`
  - `CHANGELOG.md`

**Interfaces:**
- Consumes: the behavior of Tasks 1-8.
- Produces: documentation only.

- [ ] **Step 1: Write ADR 0006**

Create `docs/adr/0006-pi-extension-allowlist.md`:

```markdown
# ADR 0006: Execution profiles may load pinned Pi extensions

**Status:** Accepted (2026-10-11). Issue #34. Design:
[Pi extensions design](../pi-extensions-design.md).

## Context

Embedded sessions loaded no Pi extensions. Providers that exist only as Pi
extensions, such as `cursor` from `pi-cursor-sdk`, were unusable through Pi
Session MCP although Pi had them installed and authenticated.

## Decision

An execution profile may name Pi extensions as
`npm:<name>@<exact version>`.
- The server resolves each one from Pi's user package install and never
  installs anything.
- A missing package or another installed version fails closed before a session
  exists.
- An extension loads with its full capabilities: providers, tools, hooks and
  system-prompt changes.
- In `read-only` profiles the model's tools stay `read`, `grep`, `find` and
  `ls`.
- In `coding` profiles every extension tool is active.
- An extension tool name that collides with another tool fails closed in both
  profiles.

A profile with extensions uses the Pi SDK session-lifecycle API with its own
model runtime per session:
- `createAgentSessionServices`, then the existing verification, then
  `createAgentSessionFromServices` and `bindExtensions`.
- Close goes through `AgentSessionRuntime.dispose()`, which emits
  `session_shutdown`.

Profiles without extensions keep the previous path. Client prompts are plain
text for every profile: they never dispatch extension commands, skills or
templates. An always-on stdout guard gives the MCP transport the only real
stdout writer.

## Consequences

- An allowlisted extension is trusted operator code with the user's full
  rights inside the server process. Version pinning prevents silent updates,
  not tampering with the installed package.
- Extensions may persist their own state; Pi Session MCP itself stays
  in-memory.
- A child process that an extension starts with inherited stdio can still
  write to the MCP stream directly. This is a documented residual risk.
- Doctor checks configured extensions offline by reading their manifests.
```

- [ ] **Step 2: Extend the threat model**

In `docs/threat-model.md`, under "Threats and mitigations", add a bullet in the style of the existing bullets:

```markdown
- **Allowlisted Pi extensions:** a profile's `extensions` load operator-trusted code into the server process with the user's full rights; it may start processes, use the network and write files (for example `pi-cursor-sdk` below `~/.pi/agent`, `~/.cursor/projects/` and `<workspace>/.pi/`). Mitigations:
  - Only exact `npm:<name>@<version>` specs from the operator's configuration load; the MCP client cannot name an extension.
  - Resolution never installs, and a different installed version fails closed.
  - `read-only` profiles never activate extension tools, and no extension tool may shadow a built-in or granted tool.
  - Client prompts never dispatch extension commands.
  - Each extension session gets its own model runtime, and close emits `session_shutdown`.
- **stdout corruption:** every write to stdout other than the MCP transport's, including `console.log` from extensions or the SDK, is dropped. stderr gets only `foreign_stdout_suppressed` with byte and write counts, never the content.
```

Under "Residual risks", append this paragraph:

```markdown
An allowlisted extension is trusted code; pinning its version does not detect
modification of the installed package directory. `read-only` limits the
model's tools, not extension code or hooks. A child process that an extension
starts with inherited stdio writes to the MCP stream directly; Node.js cannot
intercept file descriptor 1. Extensions may persist their own state outside Pi
Session MCP's in-memory boundary.
```

- [ ] **Step 3: Update architecture scope and AGENTS.md**

In `docs/architecture.md`, section "Scope", after the sentence that begins with "The product boundary is local stdio and in-memory-only operation …", add:

```markdown
Allowlisted Pi extensions may persist state of their own outside this boundary; Pi Session MCP itself keeps no state beyond process memory.
```

In `AGENTS.md`, after the "current product boundary" bullet, add:

```markdown
- Pi extensions load only from an execution profile's exact
  `npm:<name>@<version>` allowlist, resolved from Pi's install without
  installing. Client prompts never dispatch extension commands, and stdout stays
  reserved for MCP frames through the stdout guard. Extensions may persist their
  own state; Pi Session MCP itself stays in-memory.
```

- [ ] **Step 4: Add the operator section**

Append a section to `docs/installation.md` before the "Upgrade" section, or at the end if there is none. Use the anchor `pi-extensions`, which Task 1 links to:

````markdown
## Pi extensions

An execution profile can load Pi extensions that Pi has installed. Install them
with Pi (`pi install npm:<name>`; update with `pi update --extensions`), then
pin the installed version in the profile:

```json
"code-cursor": {
  "default": false,
  "permissionProfile": "coding",
  "provider": "cursor",
  "model": "<model id from Pi's cursor catalog>",
  "thinkingLevel": "high",
  "extensions": ["npm:pi-cursor-sdk@0.5.3"]
}
```

- **Version pin.** The server never installs or updates extensions. If Pi has
  another version installed, sessions of that profile fail with
  `extension_version_mismatch` and Doctor reports it. After `pi update
  --extensions`, update the pinned version and restart the client.
- **Full capabilities.** An extension loads with its providers, tools, hooks
  and system-prompt changes. In `read-only` profiles the model still gets only
  `read`, `grep`, `find` and `ls`; in `coding` profiles it also gets every
  extension tool. Extension commands never run from client prompts.
- **Trust.** Only list extensions you trust like any other program you run:
  they execute inside the server process with your rights.
- **Cursor sign-in limit.** Without a stored Cursor key, `pi-cursor-sdk`
  reports a placeholder key. Session start succeeds and the first prompt fails
  with `turn_failed`. Store the key with Pi first.
````

- [ ] **Step 5: Record the manual acceptance and the changelog**

In `docs/acceptance.md`, add a section before "Evidence rules":

```markdown
## Pi extension live check

Manual, on a machine with Pi, `pi-cursor-sdk@0.5.3` and a stored Cursor key. Run it from a working tree (`npm run build`, then `node dist/main.js`) with a temporary configuration whose profile names `"extensions": ["npm:pi-cursor-sdk@0.5.3"]` and a Cursor model from Pi's catalog.

1. `pi_session_start`, a prompt answered with "PONG", `pi_turn_get` completed, `pi_session_close`.
2. Two parallel sessions of that profile, each completing a prompt.
3. After close, no Cursor child process of the server remains.
4. stderr shows no `foreign_stdout_suppressed` storm and no stdout frame fails to parse.
5. Record how the Cursor local runtime starts its child processes (inherited or piped stdio).

Record date, versions and outcome under Status. No secret, path or prompt content goes into the record.
```

In `CHANGELOG.md`, under `## Unreleased`, add as the first bullet:

```markdown
- Execution profiles can load Pi extensions that Pi has installed, pinned as
  `npm:<name>@<exact version>` in a new `extensions` field. Such a session
  loads the extension with its providers, tools, hooks and system-prompt
  changes, in a model runtime of its own; `read-only` profiles never activate
  extension tools. New errors: `extension_not_installed`,
  `extension_version_mismatch`, `extension_load_failed`,
  `extension_tool_conflict`. Doctor checks configured extensions offline.
  `pi_capabilities_get` lists each profile's `extensions`. Client prompts no
  longer dispatch extension commands, and an always-on guard keeps stdout
  reserved for MCP frames. See ADR 0006 and #34.
```

- [ ] **Step 6: Run the full gate and a link check**

Run: `npm run typecheck && npx vitest run && grep -n "pi-extensions" docs/installation.md docs/adr/0006-pi-extension-allowlist.md`
Expected: PASS. The grep shows the `#pi-extensions` link target and the ADR link.

- [ ] **Step 7: Commit**

```bash
git add docs/adr/0006-pi-extension-allowlist.md docs/threat-model.md docs/architecture.md docs/installation.md AGENTS.md docs/acceptance.md CHANGELOG.md
git commit -m "docs: record the Pi extension allowlist and its trust boundary

Refs #34

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Fuzo8ySrHK1TLhaQ12LxaJ"
```

---

### Task 10: Working-tree live acceptance with pi-cursor-sdk (hub only)

This task uses real credentials and a real provider. The hub runs it itself and never delegates it to a subagent or an external model. Nothing secret, no path and no prompt content goes into any record.

**Files:**
- Modify: `docs/acceptance.md` (Status section)

- [ ] **Step 1: Build and prepare a temporary configuration**

Run:
- `npm run build`
- `pi --list-models cursor | head -20`

Pick one model id. Write a temporary config into the session scratchpad. It must have the `pi-session-mcp` workspace and the profile `code-cursor` (coding, `cursor`, the model id, a thinking level the model supports, `extensions: ["npm:pi-cursor-sdk@0.5.3"]`), plus a read-only default profile.

- [ ] **Step 2: Run the live check steps 1-5 from `docs/acceptance.md`**

Drive `node dist/main.js` over stdio with a small JSON-RPC client in the scratchpad, for example a variant of the earlier profile probe. The JSON-RPC client:
- prompts "Reply with exactly the word PONG",
- starts two sessions in parallel,
- closes both.

After close, check for leftover Cursor child processes with `ps -o pid,ppid,command --ppid <server pid>`. Note how the Cursor runtime's children were started.

- [ ] **Step 3: Record the outcome**

Add a dated line under "Status" in `docs/acceptance.md`, with:
- versions (Pi SDK 1.1.0, pi-cursor-sdk 0.5.3, Node),
- the outcome of each of the five steps,
- the observed child stdio mode.

Commit it as `docs: record the pi-cursor-sdk live check` with the trailers. If a step fails, stop: report the failure and record nothing.

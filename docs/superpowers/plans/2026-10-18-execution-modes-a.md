# Execution Modes, Plan A (modes, enforcement, reporting, setup) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-repository execution modes (`unset`, `host`, `container`, `read-only`) stored in `execution-modes.json`, enforced by the server for coding sessions, reported by `pi_capabilities_get` and Doctor, and set through `pi-session-mcp-setup --repo`.

**Architecture:** A new pure module loads and validates the modes file next to the configuration; `loadConfig` attaches the result to `AppConfig`; `pi_session_start` refuses coding profiles on `container` and `read-only` workspaces before any session is created; capabilities and Doctor project the modes; a new setup operation writes the modes file atomically under a lock. Plan B (container writer lifecycle: provisioning, collect, reset, wrapper, refusal server, registration) builds on this and is planned separately.

**Tech Stack:** Node.js >= 22.19.0, TypeScript strict ESM (`.js` import suffixes), zod (pinned), vitest, MCP SDK 2.3.1.

**Spec:** `docs/superpowers/specs/2026-10-18-execution-modes-design.md`

## Global Constraints

- Public MCP contract change (new error code, new capabilities field): ships as **0.9.0** with **ADR 0009**; no version bump in this plan (release follows the release procedure).
- `workspaces` in `pi-session-mcp.json` keeps its plain path form; modes live only in `execution-modes.json` in the configuration file's directory.
- An alias without a modes entry has mode `unset`, treated as `host` (today's behavior), with Doctor warning `workspace_mode_unset`.
- `host` requires `"acceptHostWrites": true`; `container` with a profile whose provider is `cursor` is invalid until a Cursor acceptance exists.
- Never a silent fallback from `container` to `host`.
- Doctor stays offline and never runs Git; it may run `podman info` locally.
- Setup defaults to dry-run; changes need `--apply`; it never restarts servers and reports `controllers_restart_required` when a mode changes.
- Reports (Doctor, setup, MCP) carry no paths, secrets or file contents.
- All tracked documentation in English.

## Review Focus

1. A modes file naming an alias that the configuration does not define → the server refuses to start with `invalid_execution_modes`; Doctor reports `config_invalid`. (Task 1)
2. A coding `pi_session_start` on a `container` or `read-only` workspace → `workspace_mode_forbids_coding`, no adapter `create` call, no session listed afterwards. (Task 2)
3. Read-only profiles on `container` and `read-only` workspaces keep working. (Task 2)
4. `podman` on `PATH` but `podman info` failing or reporting non-rootless → `container_runtime_unavailable`, not ok. (Task 4)
5. A hand-edited, invalid modes file → setup refuses (`modes_file_invalid`) and does not overwrite it. (Task 5)

---

### Task 1: Modes file model and loading

**Files:**
- Create: `src/execution-modes.ts`
- Modify: `src/config.ts` (`ConfigErrorCode`, `CONFIG_ERROR_MESSAGES`, `AppConfig`, `loadConfig`)
- Modify: `src/main.ts` (startup diagnostic code list, if it enumerates config codes)
- Test: `test/execution-modes.test.ts`

**Interfaces:**
- Produces:
  - `export type WorkspaceMode = "unset" | "host" | "container" | "read-only";`
  - `export interface ContainerSettings { readonly writers: number; readonly lifecycle: "persistent" | "ephemeral"; readonly profiles: readonly string[]; readonly image: string; readonly network: "pasta" | "none"; }`
  - `export interface WorkspaceModeEntry { readonly mode: WorkspaceMode; readonly container?: ContainerSettings; }`
  - `export const EXECUTION_MODES_FILE = "execution-modes.json";`
  - `export function executionModesPath(configPath: string): string` (same directory as the configuration file)
  - `export const executionModesSchema` (zod, `.strict()` everywhere)
  - `export function resolveExecutionModes(raw: unknown, workspaceAliases: ReadonlySet<string>, profiles: ReadonlyMap<string, { readonly permissionProfile: "read-only" | "coding"; readonly provider: string }>): ReadonlyMap<string, WorkspaceModeEntry>` (every configured alias present; missing → `{ mode: "unset" }`)
  - `export async function loadExecutionModes(configPath: string, workspaceAliases, profiles): Promise<ReadonlyMap<string, WorkspaceModeEntry>>` (absent file → all `unset`)
  - `export function codingAllowed(entry: WorkspaceModeEntry): boolean` (true for `unset` and `host`)
  - `ConfigErrorCode` gains `"invalid_execution_modes"`; `AppConfig` gains `readonly workspaceModes: ReadonlyMap<string, WorkspaceModeEntry>`.

File format (`schemaVersion` 1):

```json
{ "schemaVersion": 1, "workspaces": {
  "a": { "mode": "container", "writers": 1, "lifecycle": "persistent", "profiles": ["code"], "image": "node", "network": "pasta" },
  "b": { "mode": "host", "acceptHostWrites": true },
  "c": { "mode": "read-only" } } }
```

Container defaults: `writers` 1 (integer 1–16), `lifecycle` `persistent`, `image` `node`, `network` `pasta`; `profiles` required, non-empty, each a configured `coding` profile whose provider is not `cursor`.

- [ ] **Step 1: Write the failing tests** in `test/execution-modes.test.ts`:
  - `resolveExecutionModes(undefined-equivalent {schemaVersion:1, workspaces:{}}, aliases{a,b}, …)` → both `{ mode: "unset" }`.
  - container entry `{mode:"container", profiles:["code"]}` → `container` equals `{ writers: 1, lifecycle: "persistent", profiles: ["code"], image: "node", network: "pasta" }`.
  - each of these throws `ConfigError` with code `invalid_execution_modes`: unknown alias; `host` without `acceptHostWrites: true`; `acceptHostWrites: false`; container with empty `profiles`; container profile that is `read-only`; container profile with provider `cursor`; `writers: 0` and `writers: 17`; unknown key; `schemaVersion: 2`.
  - `loadExecutionModes` on a directory without the file → all `unset`; with invalid JSON → `invalid_execution_modes`.
  - `codingAllowed` true for `unset`/`host`, false for `container`/`read-only`.
  - `loadConfig` of a fixture config plus modes file → `workspaceModes.get("a").mode === "container"`.
- [ ] **Step 2: Run** `npx vitest run test/execution-modes.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `src/execution-modes.ts` and wire `loadExecutionModes(absoluteConfig, …)` into `loadConfig` after profiles are resolved; add the error code and message ("Execution modes file is invalid").
- [ ] **Step 4: Run** `npx vitest run test/execution-modes.test.ts test/config.test.ts && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(config): load per-repository execution modes`.

### Task 2: Server enforcement and capabilities

**Files:**
- Modify: `src/session-registry.ts` (`RegistryErrorCode`, messages)
- Modify: `src/server.ts` (`createServer` signature, `pi_session_start`, `capabilitiesSchema`)
- Modify: `src/capabilities.ts` (`projectCapabilities`)
- Modify: `src/main.ts` (pass `config.workspaceModes`)
- Modify: `docs/tool-contracts.md` (new code, new field)
- Test: `test/mcp-contract.test.ts`, `test/capabilities.test.ts`

**Interfaces:**
- Consumes: `WorkspaceModeEntry`, `codingAllowed` (Task 1).
- Produces:
  - `RegistryErrorCode` gains `"workspace_mode_forbids_coding"` with message `"The workspace's execution mode does not allow coding sessions on this server"`.
  - `createServer(registry, workspaces, executionProfiles, defaultExecutionProfile, configuration, workspaceModes: ReadonlyMap<string, WorkspaceModeEntry> = new Map())`.
  - `projectCapabilities(workspaces, executionProfiles, configuration, workspaceModes = new Map())` returns `workspaces: [{ alias, mode }]` where `mode` is the entry's mode or `"unset"`.

- [ ] **Step 1: Write the failing tests:**
  - `test/mcp-contract.test.ts` › "refuses a coding start on a container workspace without creating a session": fake adapter counting `create`; modes `{ a: container }`; `pi_session_start {workspace:"a", executionProfile:"code"}` → `structuredContent.error.code === "workspace_mode_forbids_coding"`, `isError: true`, adapter `create` count 0, `pi_session_list` empty.
  - same for `read-only` mode.
  - "allows read-only profiles on container and read-only workspaces": start with `review` → `ok: true`.
  - "unset and host keep today's behavior": coding start succeeds.
  - `test/capabilities.test.ts`: `workspaces` equals `[{ alias: "a", mode: "container" }, { alias: "b", mode: "unset" }]`.
- [ ] **Step 2: Run** `npx vitest run test/mcp-contract.test.ts test/capabilities.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement:** in `pi_session_start`, after resolving `configured`, throw `RegistryError("workspace_mode_forbids_coding")` when `configured.permissionProfile === "coding"` and `!codingAllowed(workspaceModes.get(workspace) ?? { mode: "unset" })`; extend `capabilitiesSchema` (`mode: z.enum(["unset","host","container","read-only"])`); update `docs/tool-contracts.md` (start error table: Operator needed class; capabilities field).
- [ ] **Step 4: Run** `npx vitest run test/mcp-contract.test.ts test/capabilities.test.ts test/mcp-sdk-integration.test.ts && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): enforce execution modes for coding sessions`.

### Task 3: Orchestration skill and start-error reference

**Files:**
- Modify: `skills/pi-session-orchestration/references/start-errors.md` (Operator needed: `workspace_mode_forbids_coding`)
- Modify: `skills/pi-session-orchestration/SKILL.md` (section 3: read `mode` from capabilities; for `container` workspaces use the repository's `pi-coding-*` server; never retry on the host server)
- Test: `test/orchestration-skill-start-codes.test.ts` (existing coverage test must pass with the new documented code), `test/skill-library.test.ts`

**Interfaces:**
- Consumes: the code from Task 2 as documented in `docs/tool-contracts.md`.

- [ ] **Step 1: Run** `npx vitest run test/orchestration-skill-start-codes.test.ts` after Task 2's doc change — Expected: FAIL (new code not classified).
- [ ] **Step 2: Add** the code to the Operator-needed line and the SKILL.md rule: "A coding start refused with `workspace_mode_forbids_coding` means the repository runs coding elsewhere; do not retry or switch profiles on this server."
- [ ] **Step 3: Run** `npx vitest run test/orchestration-skill-start-codes.test.ts test/skill-library.test.ts test/setup-skills.test.ts` — Expected: PASS.
- [ ] **Step 4: Commit** `docs(skill): classify workspace_mode_forbids_coding`.

### Task 4: Doctor checks

**Files:**
- Modify: `src/doctor.ts` (`DoctorCheckId`, `CHECK_ORDER`, `DoctorDependencies`, checks)
- Modify: `docs/doctor-design.md`
- Test: `test/doctor-modes.test.ts`

**Interfaces:**
- Consumes: `AppConfig.workspaceModes` (Task 1).
- Produces:
  - Check ids after `workspace_gitfile`: `workspace_mode_unset` (warning, only when a coding profile exists), `workspace_host_writes_accepted` (`ok` line per `host` alias, remediation-free, so the accepted risk is visible), `container_runtime_unavailable` (error per `container` alias).
  - `DoctorDependencies.containerRuntime?: () => Promise<boolean>`; default runs `podman info --format {{.Host.Security.Rootless}}` with a 10 s timeout, true only for exit 0 and trimmed output `true`; any spawn error → false.

- [ ] **Step 1: Write the failing tests** in `test/doctor-modes.test.ts` (injected `loadConfig`, `containerRuntime`):
  - unset alias + coding profile → one `workspace_mode_unset` warning, exit 1.
  - unset alias + only read-only profiles → no `workspace_mode_unset`.
  - host alias → `workspace_host_writes_accepted` with severity `ok`.
  - container alias + `containerRuntime → false` → `container_runtime_unavailable` error, exit 2; with `→ true` → `ok`.
  - default `containerRuntime` with a `PATH` lacking `podman` → false (no throw).
  - default `containerRuntime` with a fake `podman` on `PATH` that exits 1, and one that prints `false` → false.
  - output (JSON and human) contains no path.
- [ ] **Step 2: Run** `npx vitest run test/doctor-modes.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the checks and the default probe (spawn without shell, stdout capped at 4 KiB).
- [ ] **Step 4: Run** `npx vitest run test/doctor*.test.ts && npm run build:cli` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(doctor): report execution modes and the container runtime`.

### Task 5: Setup operation `--repo`

**Files:**
- Create: `src/setup-modes.ts`
- Modify: `src/setup-cli.ts` (`parseSetupArgs`, `SetupCliRequest`)
- Modify: `src/setup-main.ts` (dispatch, reportable targets)
- Test: `test/setup-modes.test.ts`, `test/setup-cli.test.ts`

**Interfaces:**
- Consumes: `executionModesSchema`, `executionModesPath`, `ContainerSettings` (Task 1); the same `containerRuntime` probe as Task 4 (export it from `src/doctor.ts` or a shared `src/container-runtime.ts`).
- Produces:
  - CLI: `--repo <alias> [--mode host|container|read-only] [--accept-host-writes] [--writers N] [--lifecycle persistent|ephemeral] [--profiles a,b] [--image <name|id>] [--network pasta|none]` with `--dry-run` (default) or `--apply`; not combinable with `--target` or `--customize-skill`.
  - `export interface ModeRequest { readonly alias: string; readonly mode?: "host" | "container" | "read-only"; readonly acceptHostWrites: boolean; readonly container?: Partial<ContainerSettings>; readonly apply: boolean; }`
  - `export async function changeExecutionMode(configPath: string, request: ModeRequest, dependencies?: { containerRuntime?: () => Promise<boolean> }): Promise<SetupResult>`; target `{ client: "modes", scope: "workspace", alias }`.
  - Finding codes: `mode_planned`, `mode_applied`, `mode_unchanged`, `mode_choice_required` (no `--mode` and Podman unusable), `host_ack_required`, `container_runtime_unavailable`, `alias_unknown`, `modes_file_invalid`, `controllers_restart_required` (status `ok`, after an applied change).
  - Without `--mode`: `container` when the runtime probe succeeds, else `mode_choice_required` (exit 1).
  - Write: under the same lock helper that guards the skill bases file (`src/override-lock.ts`), validate the whole new file with `executionModesSchema` + `resolveExecutionModes`, write to a temporary file in the same directory, `rename` over the target; never rewrite an existing invalid file.

- [ ] **Step 1: Write the failing tests** in `test/setup-modes.test.ts` (temp config dir):
  - dry-run `--mode read-only` → `mode_planned`, file unchanged.
  - apply `--mode host` without `--accept-host-writes` → `host_ack_required`, exit 1, no file.
  - apply `--mode host --accept-host-writes` → file contains `{ mode: "host", acceptHostWrites: true }`, findings include `controllers_restart_required`.
  - apply `--mode container --profiles code` with probe false → `container_runtime_unavailable`, exit 1, no file; with probe true → written with defaults.
  - no `--mode`, probe false → `mode_choice_required`; probe true → planned `container`.
  - unknown alias → `alias_unknown`.
  - existing invalid modes file → `modes_file_invalid`, bytes unchanged.
  - re-apply identical → `mode_unchanged`, file mtime unchanged.
  - `test/setup-cli.test.ts`: `--repo` with `--target` → usage error; `--writers 0` → usage error.
- [ ] **Step 2: Run** `npx vitest run test/setup-modes.test.ts test/setup-cli.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `src/setup-modes.ts`, the CLI parsing and dispatch.
- [ ] **Step 4: Run** `npx vitest run test/setup-modes.test.ts test/setup-cli.test.ts test/setup-main.test.ts && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(setup): set per-repository execution modes`.

### Task 6: Decision record and operator documentation

**Files:**
- Create: `docs/adr/0009-execution-modes.md` (Status: Accepted 2026-10-18; decision, contract change, compatibility via separate file, minor release 0.9.0, relation to ADR 0003 and 0008)
- Create: `docs/execution-modes.md` (one paragraph per mode with its risk in one sentence; choosing at installation; changing later; what Doctor, setup and the server report; the restart rule; Plan B pending for automated container writers, with a pointer to `isolation-setup.md` for the manual route)
- Modify: `docs/installation.md`, `docs/isolation-setup.md`, `docs/doctor-design.md` (links), `README.md` (one line), `CHANGELOG.md` (Unreleased), `docs/roadmap.md` (#79 status, new issue for Plan B)
- Test: the relative-link check (`python3 -I <scratch>/linkcheck.py <repo> origin/main` as used in Sprint 5) and `npx vitest run test/package-contents.test.ts`

- [ ] **Step 1: Write** the ADR and the operator page.
- [ ] **Step 2: Update** the linked pages and the changelog.
- [ ] **Step 3: Run** the link check and `git diff --check` — Expected: 0 broken links, clean.
- [ ] **Step 4: Run** the full suite once: `NODE_OPTIONS=--unhandled-rejections=strict npm test -- --maxWorkers=2`, `npm run build`, `npm run build:cli`, `npm run eval:schemas -- --check` — Expected: PASS.
- [ ] **Step 5: Commit** `docs: decide and document per-repository execution modes (ADR 0009)`.

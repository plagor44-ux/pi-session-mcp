# Agent-driven execution-profile setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a controlling agent set up execution profiles by itself: an offline model catalog (`--list-models`), a provider probe (`--probe-profile`), and a shipped controller skill `pi-session-profiles` that setup installs.

**Architecture:** Two new setup operations live in their own modules behind injectable interfaces (`ModelCatalog`, `PiSessionAdapter`). `setup-main.ts` dispatches them lazily to a probe entry that installs the stdout guard before the Pi SDK loads. The skill is a Markdown file under `skills/`, added to `CONTROLLER_SKILLS` so the existing installer handles it.

**Tech Stack:** TypeScript strict ESM on Node.js ≥ 22.19.0, Vitest, `@earendil-works/pi-coding-agent` 1.4.0 (`ModelRuntime` from the package root), zod.

**Spec:** `docs/superpowers/specs/2026-10-29-agent-profile-setup-design.md`

## Global Constraints

- Node.js 22.19.0 or newer, TypeScript strict mode, ESM, `.js` suffixes in relative imports.
- No new dependencies; any change to `package.json` dependencies is pinned exactly.
- CLI reports are sanitized: no secrets, no absolute paths, no configuration location, no environment values, no complete prompts, and never the probe's reply text.
- Pi stays behind `PiSessionAdapter`; catalog access stays behind `ModelCatalog`. Tests use fakes and need no provider credentials.
- Only documented package-root exports of the Pi SDK (`ModelRuntime`, `getAgentDir`).
- Doctor and `--verify` stay provider-free; only `--probe-profile … --apply` sends provider turns.
- No operator-specific names (hosts, machines, repositories, profile aliases, models, internal services) in any tracked file, including tests and examples. Use neutral aliases such as `review`, `code`, `my-project`, providers `example-provider`.
- All tracked documentation in English.
- One branch (`feat/139-agent-profile-setup`), one pull request; separate commits per issue; the PR names every issue.
- Inside a container writer a few lock and hook tests may time out; report them by file and test name instead of changing them.

## Review Focus

1. **An extension writes to stdout during a probe.** The report on stdout must stay valid JSON or clean human lines; the stray write is dropped by the stdout guard. → Task 4, `test/setup-probe-main.test.ts` "keeps the report intact when a profile writes to stdout".
2. **A provider never answers.** The probe must end after the turn deadline with `probe_timeout`, abort and dispose the session, remove the temporary directory, and go on with the next profile. → Task 3, "times out a silent turn and continues".
3. **Ctrl-C during a probe.** The session is aborted and disposed, the temporary directory removed, and the run exits 130 with `operation_interrupted`. → Task 3, "aborts and cleans up on interrupt".
4. **The model answers with something sensitive** (a path, a token-shaped string, a long text). Only `probe_unexpected_reply` appears; the text never reaches the report. → Task 3, "never reports the reply text".
5. **Odd alias input** (`--probe-profile a,a`, `--probe-profile A`, `--probe-profile ../x`, empty item). Duplicates are probed once; an alias that does not match `ALIAS_PATTERN` is a usage error and is never echoed. → Task 2, "rejects invalid probe aliases".

---

### Task 1: Offline model catalog and `--list-models` report

**Files:**
- Create: `src/model-catalog.ts`
- Create: `src/setup-probe-result.ts`
- Test: `test/model-catalog.test.ts`

**Interfaces:**
- Produces (in `src/model-catalog.ts`):
  - `export interface CatalogProvider { readonly id: string; readonly authConfigured: boolean; readonly models: readonly string[] }`
  - `export interface ModelCatalog { providers(): readonly CatalogProvider[] }`
  - `export async function createModelCatalog(): Promise<ModelCatalog>`: wraps `ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false })`; maps `getProviders()`, `getModels(id)` (model `id`s) and `checkAuth(id)` (bounded, reduced to a boolean; `hasConfiguredAuth` stays empty offline). Sorted by provider id, then model id.
  - `export const CATALOG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@\/-]{0,255}$/`
- Produces (in `src/setup-probe-result.ts`):
  - `export interface ModelCatalogReport { readonly schemaVersion: 1; readonly status: "ok" | "failed"; readonly code?: "catalog_unavailable"; readonly providers: readonly CatalogProvider[]; readonly omittedIds: number; readonly note: "extension_providers_not_listed"; readonly exitCode: 0 | 1 }`
  - `export function catalogReport(catalog: ModelCatalog | undefined): ModelCatalogReport`: `undefined` → `status: "failed"`, `code: "catalog_unavailable"`, exit 1. Drops any provider or model id not matching `CATALOG_ID_PATTERN` and counts it in `omittedIds`.
  - `export function formatCatalogHuman(report: ModelCatalogReport): string`: one line per provider, `<id> (auth: yes|no): <model>, <model>`, then the fixed note line `Providers registered only by Pi extensions are not listed.`

- [ ] **Step 1: Write the failing tests** in `test/model-catalog.test.ts`:
  - "reports providers, auth presence and models from a fake catalog": fake with `example-provider` (auth `true`, models `m-large`, `m-small`) and `other-provider` (auth `false`, no models) → `status: "ok"`, `exitCode: 0`, providers sorted, `authConfigured` as given, `note: "extension_providers_not_listed"`.
  - "omits ids that are not plain catalog ids": a model id `"/home/x"` and a provider id `"bad id"` are absent; `omittedIds === 2`.
  - "fails closed when the catalog cannot be created": `catalogReport(undefined)` → `status: "failed"`, `code: "catalog_unavailable"`, `exitCode: 1`, `providers: []`.
  - "human format has no path and states the extension note": output contains `auth: yes` and the note line; it does not match `/\/[A-Za-z0-9_.-]+\//`.
- [ ] **Step 2: Run** `npx vitest run test/model-catalog.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** `src/model-catalog.ts` and `src/setup-probe-result.ts` with the interfaces above. `createModelCatalog` reads nothing besides what `ModelRuntime` reads and never calls `getAuth` or `getAvailable`.
- [ ] **Step 4: Run** `npx vitest run test/model-catalog.test.ts` and `npm run typecheck`. Expected: PASS, no type errors.
- [ ] **Step 5: Commit** `feat: add an offline model catalog report (#139)`.

### Task 2: Parse `--list-models` and `--probe-profile`

**Files:**
- Modify: `src/setup-cli.ts` (`SetupCliRequest`, `parseSetupArgs`)
- Test: `test/setup-cli.test.ts`

**Interfaces:**
- Produces: `SetupCliRequest` gains `readonly listModels?: true` and `readonly probe?: { readonly profiles: readonly string[]; readonly apply: boolean }`. `profiles` is de-duplicated in first-seen order.

- [ ] **Step 1: Write the failing tests** in `test/setup-cli.test.ts`:
  - "parses --list-models": `["--list-models"]` → `{ listModels: true, json: false, targets: [] }`; with `--json` → `json: true`.
  - "parses --probe-profile as dry run and apply": `["--probe-profile", "review,code"]` → `probe: { profiles: ["review", "code"], apply: false }`; adding `--apply` → `apply: true`.
  - "rejects invalid probe aliases": each of `"review,review"` (→ accepted, `profiles: ["review"]`), `"A"`, `"../x"`, `"review,"`, `""` and a missing value throws for all but the first.
  - "rejects probe and catalog combinations": `--probe-profile` with any of `--target x:y:z`, `--repo a`, `--writer a-w1`, `--customize-skill s`, `--list-models`, `--verify`, `--rollback`, `--remove`, and `--list-models` with `--apply` or any of those, throw.
- [ ] **Step 2: Run** `npx vitest run test/setup-cli.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the two flags in `parseSetupArgs`. Validate each probe alias with `ALIAS_PATTERN` from `src/execution-profile.ts`; repeated flags throw `usage_invalid`.
- [ ] **Step 4: Run** `npx vitest run test/setup-cli.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: parse the model catalog and probe flags (#139)`.

### Task 3: Profile probe core

**Files:**
- Create: `src/profile-probe.ts`
- Modify: `src/setup-probe-result.ts` (probe report types and formatter)
- Test: `test/profile-probe.test.ts`

**Interfaces:**
- Consumes: `ModelCatalog` (Task 1), `PiSessionAdapter` / `PiSessionCreationError` (`src/pi-adapter.ts`), `loadConfig` and `AppConfig` (`src/config.ts`), `runDoctor` and `DoctorResult` (`src/doctor.ts`), `GLOBAL_ERRORS` (`src/setup-writers-common.ts`), `toResolvedExecutionProfile` (`src/execution-profile.ts`).
- Produces (in `src/setup-probe-result.ts`):
  - `export type ProbeCode = "probe_planned" | "probe_profile_unknown" | "probe_provider_unknown" | "probe_model_unknown" | "probe_auth_missing" | "probe_passed" | "probe_unexpected_reply" | "probe_turn_failed" | "probe_start_failed" | "probe_timeout"`
  - `export interface ProbeFinding { readonly profile: string; readonly status: "planned" | "ok" | "failed"; readonly code: ProbeCode; readonly startCode?: PiSessionCreationErrorCode; readonly providerTurn: boolean; readonly durationMs?: number }`
  - `export interface ProbeReport { readonly schemaVersion: 1; readonly operation: "dry-run" | "apply"; readonly status: "planned" | "ok" | "failed"; readonly refusal?: "doctor_failed" | "config_required" | "config_unusable" | "operation_interrupted"; readonly doctor: { readonly blocking: readonly string[]; readonly other: readonly string[] }; readonly findings: readonly ProbeFinding[]; readonly usage: "unknown"; readonly exitCode: 0 | 1 | 130 | 143 }`
  - `export function formatProbeHuman(report: ProbeReport): string`
- Produces (in `src/profile-probe.ts`):
  - `export const PROBE_PROMPT = "Reply with exactly the word PONG and nothing else."`
  - `export const PROBE_DEADLINES = { startMs: 60_000, turnMs: 120_000, cleanupMs: 10_000 } as const`
  - `export function isPong(reply: string): boolean`: `reply.trim().replace(/\.$/, "").toUpperCase() === "PONG"`.
  - `export interface ProbeDependencies { readonly configPath: string; readonly loadConfig: (path: string) => Promise<AppConfig>; readonly doctor: () => Promise<DoctorResult>; readonly catalog: () => Promise<ModelCatalog>; readonly adapter: () => Promise<PiSessionAdapter>; readonly makeTempDir: () => Promise<string>; readonly removeDir: (path: string) => Promise<void>; readonly now?: () => number; readonly deadlines?: typeof PROBE_DEADLINES; readonly signal?: AbortSignal }`
  - `export async function runProfileProbe(request: { profiles: readonly string[]; apply: boolean }, deps: ProbeDependencies): Promise<ProbeReport>`

Behaviour that `runProfileProbe` must have:
- Doctor gate: errors with an id in `GLOBAL_ERRORS`, or whose subject before the first `:` equals a requested profile alias, are `blocking` (by check id, de-duplicated). All other errors and every warning go to `other`. Any blocking entry → `refusal: "doctor_failed"`, no findings, exit 1, no catalog or adapter call.
- A config that fails to load after a clean Doctor → `refusal: "config_unusable"`, exit 1.
- Offline checks per profile in order: unknown alias, provider not in catalog, model not in provider, `authConfigured: false`. The first failing check is the finding; such a profile is not started.
- Dry run: profiles that pass the offline checks get `probe_planned`; `adapter` is never called.
- Apply: per passing profile, sequentially: `makeTempDir()` (mode 0700, created by the production dependency), `adapter.create({ cwd, workspace: "profile-probe", executionProfile: toResolvedExecutionProfile(profile), signal })` under `startMs`, `prompt(PROBE_PROMPT, preflight)` under `turnMs`, where `providerTurn` becomes `true` once `preflight(true)` is called; `abort()` on timeout; always `dispose()` under `cleanupMs` and `removeDir(cwd)` in `finally`.
- Outcome mapping: completed + `isPong` → `probe_passed`; completed otherwise → `probe_unexpected_reply`; `failed`/`aborted` → `probe_turn_failed`; `PiSessionCreationError` → `probe_start_failed` with `startCode`; other create error → `probe_start_failed` with `startCode: "pi_session_creation_failed"`; deadline → `probe_timeout`.
- `deps.signal` aborted → current session aborted and disposed, its directory removed, remaining profiles skipped, `refusal: "operation_interrupted"`, exit 130 (the caller maps SIGTERM to 143).
- `status`: `planned` for a clean dry run, `ok` if every apply finding is `probe_passed`, else `failed`; exit 0 only for `planned`/`ok`.

- [ ] **Step 1: Write the failing tests** in `test/profile-probe.test.ts`, using `FakeAdapter` from `test/fake-adapter.ts`, an in-memory `AppConfig` built with `loadConfig` from a temporary config file with neutral aliases, a fake catalog and a fake Doctor:
  - "plans offline without starting a session": dry run for `review` → `probe_planned`, `adapter` not called, `providerTurn: false`, exit 0.
  - "reports offline failures in order": unknown alias → `probe_profile_unknown`; unknown provider → `probe_provider_unknown`; unknown model → `probe_model_unknown`; no auth → `probe_auth_missing`; none of them creates a session.
  - "passes a PONG reply": `assistantText: " pong. "` → `probe_passed`, `providerTurn: true`, `durationMs` is a number, temp dir removed, handle disposed.
  - "never reports the reply text": `assistantText: "/home/user/.pi/agent/auth.json sk-abcdefghijklmnop"` → `probe_unexpected_reply`; `JSON.stringify(report)` contains neither `/home/` nor `sk-`.
  - "maps start refusals without a provider turn": `creationError: new PiSessionCreationError("unknown_model")` → `probe_start_failed`, `startCode: "unknown_model"`, `providerTurn: false`.
  - "times out a silent turn and continues": first profile never completes with `deadlines.turnMs = 20` → `probe_timeout`, `aborted === 1`, disposed, dir removed; second profile still `probe_passed`; status `failed`, exit 1.
  - "aborts and cleans up on interrupt": abort the signal while the first turn runs → `refusal: "operation_interrupted"`, exit 130, handle aborted and disposed, dir removed, second profile not created.
  - "gates on global and own Doctor errors only": a `config_invalid` error → `doctor_failed`; an `extension_missing` error with subject `review:pkg` while probing `review` → `doctor_failed`; the same error with subject `other:pkg` and a `workspace_gitfile` warning → not blocking, listed in `doctor.other`.
  - "probes each alias once in request order": two profiles, two `createInputs` in order, each with its own `cwd`.
- [ ] **Step 2: Run** `npx vitest run test/profile-probe.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `src/profile-probe.ts` and the probe types and `formatProbeHuman` in `src/setup-probe-result.ts` (one line per finding: `<profile>: <status> (<code>[ <startCode>])`, then `provider turns: <n>, usage: unknown`).
- [ ] **Step 4: Run** `npx vitest run test/profile-probe.test.ts` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: add the execution-profile probe (#139)`.

### Task 4: Wire both operations into `pi-session-mcp-setup`, with ADR and docs

**Files:**
- Create: `src/setup-probe-main.ts`
- Modify: `src/setup-main.ts` (dispatch before the `PI_SESSION_MCP_CONFIG` check for `--list-models`, after it for `--probe-profile`)
- Create: `docs/adr/0014-profile-probe-and-model-catalog.md`
- Modify: `AGENTS.md`, `docs/installation.md` (new section "Check profiles: model catalog and probe"), `docs/client-setup.md` (command list)
- Test: `test/setup-probe-main.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces (in `src/setup-probe-main.ts`, whose first import is `./stdout-guard-install.js`):
  - `export interface ProbeMainDependencies { readonly catalog?: () => Promise<ModelCatalog>; readonly adapter?: () => Promise<PiSessionAdapter>; readonly doctor?: () => Promise<DoctorResult>; readonly packageRoot?: string }`
  - `export async function runListModels(json: boolean, deps?: ProbeMainDependencies): Promise<number>`
  - `export async function runProbe(request: { profiles: readonly string[]; apply: boolean }, json: boolean, configPath: string, signal: AbortSignal, deps?: ProbeMainDependencies): Promise<number>`
  - Both write their report only through `stdoutGuard.transportStdout`. The production adapter is `new SdkPiSessionAdapter({ diagnosticSink: <stderr JSON writer>, protectedReadPaths: [dirname(configFile), dirname(await realpath(configFile))] })`, mirroring `src/main.ts`. The production Doctor call is `runDoctor({ packageRoot, configPath, loadConfig: () => loadConfig(configPath) })`. `makeTempDir` uses `mkdtemp(join(tmpdir(), "pi-session-mcp-probe-"))` and `chmod 0o700`.
- `setup-main.ts` imports `./setup-probe-main.js` with a dynamic `import()` only when `request.listModels` or `request.probe` is set, so ordinary setup runs never load the guard or the SDK. `--probe-profile` without `PI_SESSION_MCP_CONFIG` → a probe report with `refusal: "config_required"`, exit 1. The existing SIGINT/SIGTERM handling feeds the probe's `AbortSignal`.

- [ ] **Step 1: Write the failing tests** in `test/setup-probe-main.test.ts` (fake catalog, fake adapter, fake Doctor; stdout captured through the guard's transport):
  - "lists models as JSON": `runListModels(true, { catalog })` → exit 0, one JSON line that parses as `ModelCatalogReport`.
  - "requires a configuration for probes": `main(["--probe-profile", "review"])` with the variable unset → exit 1, report `refusal: "config_required"`.
  - "keeps the report intact when a profile writes to stdout": the fake adapter's `create` calls `process.stdout.write("noise")` and `console.log("noise")` → the captured stdout is exactly one JSON line without `noise`.
  - "reports contain no paths": a run against a config in a temporary directory → stdout does not contain that directory, `/tmp/`, `/home/` or the config file name.
  - "ordinary setup runs do not load the probe entry": with `vi.mock("../src/setup-probe-main.js", factory)` whose factory increments a counter, `main(["--target", "codex:user:pi-session-mcp", "--dry-run"], { createSetup })` leaves the counter at 0.
- [ ] **Step 2: Run** `npx vitest run test/setup-probe-main.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `src/setup-probe-main.ts` and the dispatch in `src/setup-main.ts`.
- [ ] **Step 4: Write ADR 0014** (context: the running server reads its configuration once and a controller cannot reconnect its own server; decision: the opt-in provider probe with fixed prompt and private temporary directory, the offline catalog through `ModelRuntime` behind `ModelCatalog`; consequences: Doctor and `--verify` stay provider-free; the temporary directory is not a workspace alias and never an argument). Add to `AGENTS.md` under Rules: one bullet stating that `--probe-profile … --apply` is the only setup operation that uses a provider, with a fixed prompt, no reply text in output and fakes in tests; and widen the #142 `ModelRuntime` note by exactly the offline catalog (`getProviders`, `getModels`, `checkAuth`, no network, no refresh). Document both commands, their findings table (copied from the spec), exit codes, and the container note (the probe proves the profile on the host; writer acceptance stays with `container_profile_refused` and provisioning) in `docs/installation.md`.
- [ ] **Step 5: Run** `npx vitest run test/setup-probe-main.test.ts test/setup-main.test.ts test/setup-cli.test.ts`, `npm run typecheck` and `npm run build`. Expected: PASS.
- [ ] **Step 6: Commit** `feat: add --list-models and --probe-profile to setup (#139)`.

### Task 5: The `pi-session-profiles` controller skill, installed by setup

**Files:**
- Create: `skills/pi-session-profiles/SKILL.md`
- Modify: `src/skill-library.ts:18` (`CONTROLLER_SKILLS`)
- Modify: `docs/skills.md` (section "Install the orchestration skill into Codex and Claude Code" becomes "Install the controller skills …" with both directories per target), `docs/client-setup.md`
- Test: `test/setup-skills.test.ts`, `test/skill-library.test.ts`, plus whichever existing setup tests assert exactly one skill finding per target (find them with `grep -rn "pi-session-orchestration" test/`)

**Interfaces:**
- Consumes: the commands from Task 4 by name.
- Produces: `CONTROLLER_SKILLS = Object.freeze(["pi-session-orchestration", "pi-session-profiles"])`.

Skill content requirements (from the spec, Part B):
- Front matter `name: pi-session-profiles` and a `description` that triggers on creating, changing, tuning, renaming or retiring an execution profile or changing which profiles a container repository selects, for the controlling agent only, not inside a Pi worker.
- The nine steps of Part B in order, with the commands `pi-session-mcp-doctor --json`, `pi-session-mcp-setup --list-models`, `pi-session-mcp-setup --probe-profile <aliases>` (dry run, then `--apply`), the writer commands from `docs/execution-modes.md` and the `--repo … --mode container --profiles … --apply` request.
- The three stop conditions plus refused writer steps, verbatim in meaning; the probe budget (one provider turn per changed profile; `providerTurn: false` failures are free).
- Never: read Pi credential or model files, print environment values, hand-edit `execution-modes.json`, run `--collect --apply`, or guess the configuration path.
- The closing rule: running controllers see changes after an MCP reconnect; follow the operator's own instructions for anything beyond this machine.
- Links to the docs by their package-relative names (`docs/installation.md`, `docs/skills.md`, `docs/execution-modes.md`, `docs/pi-extensions-design.md`).
- Neutral examples only.

- [ ] **Step 1: Write the failing tests:**
  - `test/skill-library.test.ts` "ships both controller skills": `CONTROLLER_SKILLS` equals `["pi-session-orchestration", "pi-session-profiles"]` and `resolveLibrarySkill("pi-session-profiles")` resolves to the shipped tree.
  - `test/skill-library.test.ts` "the profiles skill names its commands and stop rules": the shipped `SKILL.md` contains `--list-models`, `--probe-profile`, `providerTurn`, `execution-modes.json` and does not match `/\/home\/|\/Users\/|~\//`.
  - `test/setup-skills.test.ts` "installs both controller skills per target": an apply for one target reports one finding with alias `pi-session-orchestration` and one with alias `pi-session-profiles`, both `skill_installed`; a remove reports `skill_removed` for both.
  - A worker profile that selects `builtin:pi-session-profiles` is refused the same way as `builtin:pi-session-orchestration` (extend the existing test for the orchestration case).
  - "customizes the profiles skill": `--customize-skill pi-session-profiles` dry run plans the override copy exactly as it does for `pi-session-orchestration` (extend the existing customize test).
- [ ] **Step 2: Run** `npx vitest run test/skill-library.test.ts test/setup-skills.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Write** `skills/pi-session-profiles/SKILL.md` and change `CONTROLLER_SKILLS`. Update existing tests that pinned one skill finding per target to expect two.
- [ ] **Step 4: Run** `npx vitest run test/skill-library.test.ts test/setup-skills*.test.ts test/setup-main.test.ts`, then update `docs/skills.md` and `docs/client-setup.md`.
- [ ] **Step 5: Commit** `feat: ship the pi-session-profiles controller skill (#139)`.

### Task 6: Roadmap entry and full gate

**Files:**
- Modify: `docs/roadmap.md` ("Current state": one bullet for 2026-10-29 naming #139, the two commands, the skill and ADR 0014, unreleased)

- [ ] **Step 1: Add** the roadmap bullet.
- [ ] **Step 2: Run** `npm run typecheck`, `npm run build`, `npm test`. Expected: all pass; record counts. Any timeout in lock or hook tests inside a container writer is reported by file and test name, not changed.
- [ ] **Step 3: Scan** the diff for operator-specific names: `git diff main --stat` and a review of every added example and test fixture for hostnames, real profile aliases, real model ids and internal services. Expected: only neutral names.
- [ ] **Step 4: Commit** `docs: record agent-driven profile setup in the roadmap (#139)`.

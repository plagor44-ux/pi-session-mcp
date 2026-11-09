# Guided installation and tier routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command installs and verifies Pi Session MCP for any user, and an optional tier routing picks profiles at session start and improves its order within a tier from the session history.

**Architecture:** A new `src/routing/` module owns the operator's `routing.json`, pure selection and learning, and new tables in the history store; `pi_session_start` calls it only when a start asks for routing. A new `src/guided/` module turns prompts or an answers file into one validated answers object, builds a pure merge plan, then drives the existing Doctor, probe, mode and client setup code. Routing is built first because the installer writes its file.

**Tech Stack:** TypeScript strict ESM, Node.js 22.19+, `node:sqlite`, zod, Vitest, POSIX `sh` for `install.sh`.

**Spec:** `docs/superpowers/specs/2026-11-09-guided-install-and-tier-routing-design.md`

## Global Constraints

- Node.js 22.19.0 or newer, TypeScript strict mode, ESM, `.js` suffixes in relative imports, exact dependency pins (no new dependency is expected).
- MCP stdout carries only frames. Diagnostics go to stderr, structured, with no secrets or complete prompts.
- CLI reports are sanitized: no secrets, paths or complete prompts. Doctor stays offline.
- Tests use fakes and need no provider credentials. Pi stays behind `PiSessionAdapter`.
- The guided setup never asks for, prints or stores a provider credential.
- With `mode: off`, sessions and results behave as today; the capabilities schema change is additive.
- An explicit `executionProfile` is never refused by routing, except together with `tier`.
- Tracked documentation is English and names no operator-specific hosts, services or paths.
- Tiers ascending: `low`, `medium`, `hightech`, `ultra`. Learning only reorders within one tier and role.
- Defaults: floors `code` `medium`, `review` `medium`, `explore` `low`, `risk: high` `hightech`; `minSamples` 8, `margin` 0.1, `explorationRate` 0.1, `explorationBudgetUsd` 5 per week; suspension 3 of the last 10 sessions for 24 hours; weights `accepted` 1, `reworked` 0.5, `rejected` 0; 200 outcomes retained per cell.
- All work lands on one branch, `feat/guided-install-tier-routing`, in one pull request, with the spec and this plan as its first commit.

## Review Focus

1. A config holding fields the installer does not know (extensions, MCP grants, skill catalogs): every field survives a merge unchanged. Pinned in Task 8.
2. Ctrl-C or a crash during probes: the live config stays untouched and the next run is not blocked by a stale candidate. Pinned in Task 9.
3. `routing.json` naming a profile later removed from the config: routing goes inactive with a diagnostic, Doctor reports an error, and explicit starts still work. Pinned in Tasks 1 and 4.
4. Claude Code and Codex servers refreshing the same history at once: exactly one refresh runs and one version is written. Pinned in Task 5.
5. A locked or corrupt history during selection: the start succeeds using the `routing.json` order. Pinned in Task 4.

---

### Task 1: Routing configuration

**Files:**
- Create: `src/routing/config.ts`
- Test: `test/routing-config.test.ts`

**Interfaces:**
- Produces, from `src/routing/config.ts`:
  - `TIERS = ["low","medium","hightech","ultra"] as const`, `ROLES = ["code","review","explore"] as const`, types `Tier`, `Role`, `RoutingMode = "off"|"manual"|"auto"`, `FAMILY_PATTERN = /^[a-z][a-z0-9-]{0,31}$/`
  - `tierRank(tier: Tier): number`
  - `interface RoutingConfig { mode: RoutingMode; tiers: Readonly<Record<Tier, Readonly<Record<Role, readonly string[]>>>>; families: ReadonlyMap<string,string>; floors: { code: Tier; review: Tier; explore: Tier; riskHigh: Tier; workspaces: ReadonlyMap<string,Tier> }; learning: { minSamples: number; margin: number; explorationRate: number; explorationBudgetUsd: number } }`
  - `ROUTING_OFF: RoutingConfig`
  - `routingConfigPath(configPath: string): string`, the file `routing.json` in the configuration's directory
  - `parseRoutingConfig(input: unknown, profiles: ReadonlyMap<string, ConfiguredExecutionProfile>, workspaces: ReadonlyMap<string,string>): RoutingConfig`
  - `loadRoutingConfig(configPath, profiles, workspaces): Promise<RoutingConfig>`; a missing file yields `ROUTING_OFF`
  - `class RoutingConfigError extends Error { code: "routing_config_invalid" }`
  - `writeRoutingDocument(configPath: string, document: unknown): Promise<void>`, 0600, atomic rename

- [ ] **Step 0: Create the branch** `feat/guided-install-tier-routing` and commit the spec and this plan as `docs: add the guided install and tier routing design`.
- [ ] **Step 1: Write the failing tests** in `test/routing-config.test.ts`

```ts
it("returns ROUTING_OFF when routing.json is absent", ...)   // expect(config).toBe(ROUTING_OFF); expect(config.mode).toBe("off")
it("applies the default floors and learning limits", ...)    // floors.code "medium", floors.riskHigh "hightech", learning { minSamples: 8, margin: 0.1, explorationRate: 0.1, explorationBudgetUsd: 5 }
it.each([
  ["an alias missing from the configuration"],               // tiers.medium.code: ["gone"]; pins Review Focus 3
  ["a read-only profile in a code cell"],
  ["a coding profile in a review cell"],
  ["one alias in two tiers"],
  ["a tiered alias without a family"],
  ["a family that fails FAMILY_PATTERN"],
  ["an unknown top-level key"],
  ["a workspace floor for an unknown workspace"],
])("refuses %s", ...)                                        // rejects with code "routing_config_invalid"; message contains no path
it("allows one read-only alias in review and explore of the same tier", ...)
```

- [ ] **Step 2: Run** `npx vitest run test/routing-config.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `src/routing/config.ts`** with a strict zod schema. `tiers` may omit a tier or role, which means an empty list. Bounds: `minSamples` integer 1 to 1000, `margin` and `explorationRate` 0 to 1, `explorationBudgetUsd` at least 0.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(routing): add the routing configuration`.

### Task 2: Routing tables in the history store

**Files:**
- Modify: `src/history/constants.ts:2`, `src/history/schema.ts:100`
- Create: `src/routing/store.ts`
- Modify tests: `test/history-store.test.ts:76-92`, `test/doctor-history.test.ts:83-87`
- Test: `test/routing-store.test.ts`

**Interfaces:**
- Consumes: `HistoryStore` from `src/history/store.ts`; `Tier`, `Role`.
- Produces, from `src/routing/store.ts`:
  - `ROUTING_CELL_RETENTION = 200`
  - `type DecisionOrigin = "floor"|"raised"|"lower_tier_review"|"explicit"|"default"`
  - `interface DecisionInput { sessionRef: string; decidedAt: string; tier: Tier|null; role: Role|null; risk: "normal"|"high"; profile: string; family: string|null; origin: DecisionOrigin; exploration: boolean; sameFamilyOverride: boolean }`
  - `interface RoutingStore { recordDecision(input: DecisionInput): void; currentOrder(tier: Tier, role: Role): readonly string[]|undefined; suspendedProfiles(now: Date): ReadonlySet<string>; explorationSpend(since: Date): { knownUsd: number; costUnknown: boolean; pending: number } }`
  - `createRoutingStore(store: HistoryStore): RoutingStore`

Migration index 1 adds, with no foreign key to `sessions`:

| Table | Columns |
| --- | --- |
| `routing_decisions` | `id` PK, `session_ref`, `decided_at`, `tier`, `role`, `risk`, `profile`, `family`, `origin`, `exploration`, `same_family_override`, `turns`, `failed_turns`, `cost_usd`, `verdict`, `settled` |
| `routing_cells` | `tier`, `role`, `order_json`, `frozen`; PK (`tier`, `role`) |
| `routing_versions` | `id` PK, `tier`, `role`, `kind` (`reorder`/`suspend`), `profile`, `before_json`, `after_json`, `reason`, `state` (`proposed`/`applied`/`rolled_back`/`superseded`), `created_at` |
| `routing_suspensions` | `profile` PK, `until`, `reason` |
| `routing_meta` | `key` PK, `value` |

- [ ] **Step 1: Write the failing tests**

```ts
it("migrates a version 1 file to version 2 and keeps its sessions", ...)   // user_version 2, an existing sessions row is still there
it("keeps routing rows when prune deletes the session", ...)               // insert session + decision with session_ref; DELETE FROM sessions; count(routing_decisions) === 1
it("keeps at most 200 decisions per cell", ...)                            // 205 records in one cell: count 200, the oldest 5 gone; another cell untouched
it("stores no workspace or task column", ...)                              // PRAGMA table_info(routing_decisions) names contain neither "workspace" nor "task"
it("returns undefined for a cell without a stored order", ...)
it("reports only unexpired suspensions", ...)
it("sums exploration spend and counts rows that are not settled", ...)     // { knownUsd: 1.5, costUnknown: false, pending: 1 }; a settled row with NULL cost sets costUnknown true
```

Change `test/history-store.test.ts` to expect version 2, and use `PRAGMA user_version = 3` where both history test files simulate a newer file.

- [ ] **Step 2: Run** `npx vitest run test/routing-store.test.ts test/history-store.test.ts test/doctor-history.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the migration, set `HISTORY_SCHEMA_VERSION = 2`, and implement `createRoutingStore` with prepared statements. `recordDecision` trims the cell in the same `transaction`. Rows with a null tier or role are not trimmed by cell; they are trimmed to the latest 200 overall.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(history): add routing tables that survive prune`.

### Task 3: Profile selection

**Files:**
- Create: `src/routing/select.ts`
- Test: `test/routing-select.test.ts`

**Interfaces:**
- Consumes: `RoutingConfig`, `Tier`, `Role`, `tierRank`; `ConfiguredExecutionProfile`; `WorkspaceModeEntry`, `codingAllowed`.
- Produces, from `src/routing/select.ts`:
  - `type RoutingErrorCode = "routing_off"|"routing_profile_conflict"|"routing_role_required"|"routing_tier_below_floor"|"routing_no_candidate"|"routing_same_family"|"routing_author_required"`
  - `class RoutingError extends Error { code: RoutingErrorCode }`
  - `interface RoutingRequest { workspace: string; executionProfile?: string; tier?: Tier; role?: Role; risk?: "normal"|"high"; shell?: boolean; authorFamily?: string; allowSameFamily?: boolean }`
  - `interface SelectionContext { config: RoutingConfig; profiles: ReadonlyMap<string, ConfiguredExecutionProfile>; defaultProfile: string; workspaceMode: WorkspaceModeEntry; relay: boolean; order(tier: Tier, role: Role): readonly string[]|undefined; suspended: ReadonlySet<string>; exploration: { allowed: boolean; rate: number; random(): number } }`
  - `interface RoutedStart { alias: string; decision?: Omit<DecisionInput, "sessionRef"|"decidedAt">; result?: { tier: Tier; role: Role; profile: string; reason: "floor"|"raised"|"lower_tier_review"; exploration: boolean } }`
  - `floorFor(config: RoutingConfig, role: Role, risk: "normal"|"high", workspace: string): Tier`, the highest of the role, risk and workspace floors
  - `routeStart(request: RoutingRequest, context: SelectionContext): RoutedStart`

Paths through `routeStart`:

| Request | Mode | Result |
| --- | --- | --- |
| `executionProfile` and `tier` | any | `routing_profile_conflict` |
| `executionProfile` | `off` | alias, no decision |
| `executionProfile` | on | alias, decision origin `explicit`; `tier` and `role` are set only if `role` was given and the alias is in that role's list |
| neither `tier` nor `role` | `off` | default alias, no decision |
| neither `tier` nor `role` | on | default alias, decision origin `default` |
| `tier` or `role` | `off` | `routing_off` |
| `tier` without `role` | on | `routing_role_required` |
| `role` with or without `tier` | on | selection below |

`risk`, `shell`, `authorFamily` and `allowSameFamily` have no effect outside the selection path.

Selection: `order` is the stored order intersected with the `routing.json` list, with listed aliases missing from it appended. Candidates are filtered by workspace (`codingAllowed` for `code`; a container workspace admits only `container.profiles`; a snapshot workspace admits only profiles without extensions, granted tools or MCP servers), by `shell` (requires `shell: "sandboxed"`), and by `suspended`. For `review`, an `authorFamily` removes that family. If that empties the list and `allowSameFamily` is true, the unfiltered list is used and the override recorded.

- [ ] **Step 1: Write the failing tests**, one `it` per row of the path table, plus:

```ts
it("uses the floor when tier is omitted", ...)                     // role code → tier "medium", reason "floor"
it("uses hightech for risk high", ...)
it("honours a raised workspace floor", ...)
it("records a tier above the floor as raised", ...)
it("refuses a tier below the floor", ...)                          // routing_tier_below_floor
it("refuses review without authorFamily or allowSameFamily", ...)  // routing_author_required
it("never returns the author's family without the override", ...)  // only family openai in tier, authorFamily openai, tier equals floor → routing_same_family
it("falls back one tier for a review above the floor", ...)        // hightech has only openai, medium has glm, floor medium → medium, reason "lower_tier_review"
it("does not fall back below the floor", ...)                      // routing_same_family
it("uses the same family with the override and records it", ...)   // sameFamilyOverride true
it("prefers another family even with the override", ...)
it("follows the stored order and appends new aliases", ...)
it("drops stored aliases that left routing.json", ...)
it("skips suspended profiles", ...)
it("admits only a container workspace's profiles", ...)
it("explores only when allowed and random is below rate", ...)     // exploration true, profile is the second candidate
it("never explores with risk high", ...)
it("never explores with one candidate", ...)
it("returns routing_no_candidate for an empty cell", ...)
```

- [ ] **Step 2: Run** `npx vitest run test/routing-select.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `src/routing/select.ts`.** Exploration picks uniformly among the candidates after the first, using `random()` a second time.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(routing): select profiles by tier, floor and family`.

### Task 4: Session start, capabilities and Doctor

**Files:**
- Create: `src/routing/runtime.ts`
- Modify: `src/tool-schemas.ts:24,46`, `src/server.ts:16-65`, `src/capabilities.ts:29-46`, `src/main.ts:28-48,119-142`, `src/client-adapters/mcp-verifier.ts:100-109`, `src/doctor.ts:671`
- Modify fixtures: `test/fixtures/fake-writer-server.mjs`, and every expected capabilities object in `test/capabilities.test.ts`, `test/config.test.ts`, `test/client-adapters.test.ts`, `test/mcp-contract.test.ts`, `test/setup-verify-server.test.ts`, `test/history-sentinel-e2e.test.ts`; check `scripts/install-smoke.mjs` and `scripts/setup-acceptance.mjs`
- Modify docs: `docs/tool-contracts.md`, `skills/pi-session-orchestration/SKILL.md`
- Test: `test/routing-runtime.test.ts`, `test/routing-mcp.test.ts`, `test/doctor-routing.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 3.
- Produces:
  - `interface RoutingRuntime { readonly config: RoutingConfig; route(request: RoutingRequest, input: { defaultProfile: string; profiles: ReadonlyMap<string, ConfiguredExecutionProfile>; workspaceMode: WorkspaceModeEntry; relay: boolean }): RoutedStart; afterStart(sessionId: string, routed: RoutedStart): void; capabilities(): { mode: RoutingMode; tiers?: Record<Tier, Record<Role, string[]>>; families?: Record<string,string> } }`
  - `createRoutingRuntime(options: { config: RoutingConfig; store?: HistoryStore; now?: () => Date; random?: () => number; diagnostic?: (code: string) => void; refresh?: () => void }): RoutingRuntime`
  - `createServer(..., options: { history?; innerHistory?; routing?: RoutingRuntime })`; a missing runtime behaves as `mode: off`
  - `projectCapabilities(..., routing = { mode: "off" })`

Schema additions: input fields `tier`, `role`, `risk`, `shell`, `authorFamily` (matches `FAMILY_PATTERN`), `allowSameFamily`. A new `startSuccessSchema = successSchema.extend({ routing: routingResultSchema.optional() })` is used only by `pi_session_start`, so the relay's parsing of inner servers is unchanged. `capabilitiesSchema` gains a required strict `routing` block. Published `tiers` lists are sorted alphabetically because the current order is not published.

Server flow: on the explicit or default path the existing check order stays unchanged. `routing.route` runs first, then the existing checks on the resolved alias, then `registry.start`, then `routing.afterStart`. `safe` projects `RoutingError` with its code. `route` reads the order and suspensions inside `try`; on any store failure it uses the `routing.json` order, no suspensions and no exploration, and reports a diagnostic. `afterStart` never throws.

`main.ts` loads routing only when `relay` is true. A `RoutingConfigError` writes the diagnostic `{ level: "warn", event: "routing_inactive", stage: "startup", code: "routing_config_invalid" }` and uses `ROUTING_OFF`. Exploration needs `mode: auto` and an open history.

Doctor adds three checks: error `routing_config_invalid`, error `routing_history_required` (`auto` without `history.enabled`), warning `routing_single_family` (a review list in a tier with fewer than two families).

- [ ] **Step 1: Write the failing tests**

```ts
// test/routing-mcp.test.ts, using InMemoryTransport and FakeAdapter as in mcp-contract.test.ts
it("starts with an explicit profile in every mode", ...)            // it.each off/manual/auto; ok true, no routing key
it("starts a call without routing arguments as today when routing is on", ...)
it("returns the routing block for a tier start", ...)               // routing: { tier: "medium", role: "code", profile: "...", reason: "floor", exploration: false }
it("projects routing errors with their code", ...)                  // routing_off when no runtime is given
it("publishes mode off and no tiers without a runtime", ...)        // routing: { mode: "off" }
it("publishes sorted tiers and families when on", ...)
// test/routing-runtime.test.ts
it("uses the routing.json order when the store throws", ...)        // pins Review Focus 5; store.db closed; route returns the first listed alias; diagnostic called
it("does not explore without a store", ...)
it("records a decision after a start and never throws", ...)
it("records nothing in mode off", ...)
// test/doctor-routing.test.ts
it("reports routing_config_invalid for an unknown alias", ...)      // pins Review Focus 3
it("reports routing_history_required for auto without history", ...)
it("warns routing_single_family", ...)
```

- [ ] **Step 2: Run** `npx vitest run test/routing-mcp.test.ts test/routing-runtime.test.ts test/doctor-routing.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the runtime, schemas, server flow, capabilities, verifier key list, `main.ts` wiring and Doctor checks. Add the `routing` block to the fixtures listed above.
- [ ] **Step 4: Document** the arguments, result, error codes and capabilities block in `docs/tool-contracts.md`. In `skills/pi-session-orchestration/SKILL.md`, state when to use `tier` and `role`, what counts as high risk (security, isolation, boundaries, migrations, irreversible changes), which `authorFamily` to pass, and that every finished session needs a verdict.
- [ ] **Step 5: Run** `npx vitest run test/routing-mcp.test.ts test/routing-runtime.test.ts test/doctor-routing.test.ts test/mcp-contract.test.ts test/capabilities.test.ts test/config.test.ts test/client-adapters.test.ts test/setup-verify-server.test.ts test/history-sentinel-e2e.test.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(routing): route session starts by tier`.

### Task 5: Learning

**Files:**
- Create: `src/routing/learn.ts`
- Modify: `src/routing/runtime.ts` (schedule the refresh), `src/routing/store.ts` (reads and writes the refresh needs)
- Test: `test/routing-learn.test.ts`

**Interfaces:**
- Consumes: `RoutingConfig`, `HistoryStore`, `routing_*` tables.
- Produces, from `src/routing/learn.ts`:
  - `wilsonLowerBound(score: number, samples: number, z = 1.96): number`; 0 for 0 samples
  - `interface CellStat { profile: string; samples: number; meanScore: number; medianCostUsd: number|null }`
  - `nextSwap(order: readonly CellStat[], limits: { minSamples: number; margin: number }): readonly string[]|undefined`, the new order or `undefined`
  - `refreshRouting(input: { store: HistoryStore; config: RoutingConfig; now: Date; deadlineMs?: number }): { outcomes: number; changes: number; proposals: number }`
  - `maybeRefreshRouting(input): boolean`, which claims `routing_meta.last_refresh_at` with a conditional `UPDATE` inside `store.transaction`, at most once per 24 hours
  - `explorationAllowed(spend: { knownUsd: number; costUnknown: boolean; pending: number }, budgetUsd: number): boolean`, false when `costUnknown`, when `pending >= 3`, or when `knownUsd >= budgetUsd`

**Algorithm.** `nextSwap` considers only profiles with at least `minSamples`; the others keep their index. Walk neighbouring eligible profiles `a` before `b`, and swap their positions on the first pair where `bound(b) - bound(a) > margin`. If no pair qualifies, swap on the first pair where the bounds differ by at most `margin`, both medians are known and `median(b) < median(a)`. At most one swap per call.

`refreshRouting` runs three steps, checking `deadlineMs` (default 2000) between rows:
1. Settle up to 500 unsettled decisions from the last 30 days, joining `sessions.public_session_id = session_ref`. Take the latest verdict by `verdicts.id`, the turn counts, and `SUM(json_extract(redacted_json, '$.message.usage.cost.total'))` over assistant entries; a sum of 0 or NULL stores NULL. A row is settled when the session is closed and has a verdict. A decision whose session has no turns scores nothing.
2. Suspend each tiered profile with at least 3 distinct sessions with a turn in state `failed` among its last 10 sessions that had a turn, across all history for that profile. A deadline stop is state `aborted` and does not count. Never suspend the last unsuspended candidate of any cell it is listed in. `auto` writes the suspension and a `suspend` version in state `applied`; `manual` writes it in state `proposed`.
3. For each unfrozen cell, build `CellStat` rows from the retained decisions and call `nextSwap`. `auto` writes `routing_cells` and an `applied` version; `manual` writes a `proposed` version and marks older `proposed` versions of that cell `superseded`.

- [ ] **Step 1: Write the failing tests**

```ts
it("computes the Wilson bound", ...)                 // toBeCloseTo: (1, 8) → 0.6756; (0.5, 8) → 0.2152; (1, 0) → 0
it("does not reorder below minSamples", ...)         // replayed fixture with 7 verdicts each → undefined
it("swaps when the bound exceeds the margin", ...)
it("does not swap at exactly the margin", ...)
it("puts the cheaper profile first within the margin", ...)
it("leaves an under-sampled profile in place", ...)  // [a(8), x(2), b(8)], b better → [b, x, a]
it("makes one change per cell per refresh", ...)
it("is stable after a swap", ...)                    // a second refresh on the same data → 0 changes
it("uses the latest verdict of a session", ...)      // accepted then rejected → score 0
it("counts failed sessions, not failed turns", ...)  // one session with 3 failed turns → no suspension; 3 sessions → suspended
it("ignores deadline stops for suspension", ...)
it("never suspends the last candidate", ...)
it("only proposes in manual mode", ...)              // routing_cells unchanged; one version in state "proposed"
it("skips a frozen cell", ...)
it("runs one refresh when two servers race", ...)    // pins Review Focus 4; two maybeRefreshRouting calls: [true, false]; one version row
it("refreshes again after 24 hours only", ...)
it("stops exploration over budget, unknown cost or 3 pending", ...)
```

- [ ] **Step 2: Run** `npx vitest run test/routing-learn.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `src/routing/learn.ts`.** Make `maybeRefreshRouting` the default for the runtime's `refresh` option, and have `afterStart` schedule it with `setImmediate`, inside `try`, when the mode is on and a store is open. Set `exploration.allowed` in `route` from `explorationAllowed` over the last 7 days.
- [ ] **Step 4: Run** the same command plus `test/routing-runtime.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(routing): learn the order within a tier from verdicts`.

### Task 6: Routing command

**Files:**
- Create: `src/routing/cli.ts`, `src/routing-main.ts`
- Modify: `package.json` (`bin`), `test/package-contents.test.ts`
- Test: `test/routing-cli.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 5.
- Produces: `runRoutingCli(argv: readonly string[], io: { stdout(text: string): void; stderr(text: string): void; home?: string; now?: () => Date; configPath?: string }): Promise<0|1|64>`; binary `pi-session-mcp-routing` at `dist/routing-main.js`. The configuration path comes from `io.configPath`, then `PI_SESSION_MCP_CONFIG`, then `~/.config/pi-session-mcp/pi-session-mcp.json`.

Commands: `status [--json]`, `mode <off|manual|auto>`, `proposals`, `apply <id>`, `rollback <tier> <role>`, `unfreeze <tier> <role>`, `refresh`. `mode` changes only that field and prints that running clients need a reconnect. `apply` on a `suspend` proposal suspends the profile for 24 hours from that moment.

- [ ] **Step 1: Write the failing tests**

```ts
it("shows order, samples against minSamples, coverage and bypasses", ...) // status --json: cells[0].samples, verdictCoverage, bypassShare
it("changes only the mode", ...)                                          // other fields deep-equal; stdout contains "reconnect"
it("refuses auto without history", ...)                                   // exit 1, code routing_history_required
it("refuses mode without routing.json", ...)                              // exit 1, code routing_not_configured
it("applies a proposal", ...)                                             // routing_cells updated, state "applied"
it("applies a suspend proposal for 24 hours", ...)
it("rolls back and freezes the cell", ...)                                // order restored, frozen 1, state "rolled_back"
it("unfreezes a cell", ...)
it("prints no path", ...)                                                 // no output contains the temporary root
it("returns 64 for unknown commands and arguments", ...)
```

Add to `test/package-contents.test.ts`: `expect(manifest.bin["pi-session-mcp-routing"]).toBe("dist/routing-main.js")`.

- [ ] **Step 2: Run** `npx vitest run test/routing-cli.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the command, following the structure of `src/history/cli.ts` and `src/history-main.ts`.
- [ ] **Step 4: Run** `npx vitest run test/routing-cli.test.ts test/package-contents.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(routing): add the routing command`.

### Task 7: Catalog prices and profile proposals

**Files:**
- Modify: `src/model-catalog.ts:11-13,32-37,65-77`, `AGENTS.md:22-32`
- Create: `src/guided/propose.ts`
- Test: `test/model-catalog.test.ts`, `test/guided-propose.test.ts`

**Interfaces:**
- Consumes: `CatalogProvider`, `Tier`, `Role`.
- Produces:
  - `interface PricedModelCatalog extends ModelCatalog { outputPrice(providerId: string, modelId: string): number|undefined }`, returned by `createModelCatalog`; `ModelCatalog` and `CatalogProvider` are unchanged, so `--list-models` output stays the same
  - `CatalogRuntime.getModels` returns `{ id: string; cost?: { output?: unknown } }`
  - From `src/guided/propose.ts`: `tierForOutputPrice(usd: number|undefined): Tier|undefined`; `familyOfModel(modelId: string, providerId: string): string`; `interface ProfileProposal { alias: string; provider: string; model: string; role: Role; tier: Tier; family: string; thinkingLevel: "low"|"medium"|"high" }`; `proposeProfiles(catalog: PricedModelCatalog): readonly ProfileProposal[]`

Rules: aliases are `<role>-<tier>-<family>`. Only providers with configured authentication count. Within one tier, role and family take the highest output price, ties by descending model id. At most four per tier and role, highest price first, ties by family. Thinking: `code` medium, `review` high, `explore` low; `explore` only for `low`. `familyOfModel` maps `glm`, `deepseek`, `grok` → `xai`, `claude` → `anthropic`, `gpt`/`o1`/`o3`/`o4` → `openai`, `gemini` → `google`, `mistral`/`devstral`/`codestral`/`ministral`/`magistral` → `mistral`, and otherwise the provider id, lowercased and fitted to `FAMILY_PATTERN`.

- [ ] **Step 1: Write the failing tests**

```ts
it.each([[30,"ultra"],[29.99,"hightech"],[3.5,"hightech"],[3.49,"medium"],[1.5,"medium"],[1.49,"low"],[0,undefined],[undefined,undefined],[NaN,undefined]])("maps %s to %s", ...)
it("reads output prices and leaves providers() unchanged", ...)          // outputPrice("p","m") === 2.1; Object.keys(providers()[0]) equals ["id","authConfigured","models"]
it("treats a non-numeric price as unknown", ...)
it("ignores providers without authentication", ...)
it("gives no proposal for a model without a price", ...)
it("proposes one per tier, role and family at the highest price", ...)
it("proposes explore only for low", ...)
it("caps a tier and role at four", ...)
it("produces aliases that match ALIAS_PATTERN", ...)
```

- [ ] **Step 2: Run** `npx vitest run test/model-catalog.test.ts test/guided-propose.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both, and record the narrow exception in `AGENTS.md`: the catalog may also read each model's output price, offline, for the guided setup's tier proposal only (maintainer-approved 2026-11-09).
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(setup): propose profiles and tiers from catalog prices`.

### Task 8: Guided answers and merge plan

**Files:**
- Create: `src/guided/answers.ts`, `src/guided/plan.ts`
- Test: `test/guided-plan.test.ts`

**Interfaces:**
- Consumes: `RoutingMode`, `Tier`, `Role`, `ModeRequest`, `SetupTarget`.
- Produces:
  - `parseGuidedAnswers(input: unknown): GuidedAnswers`, strict, with error code `answers_invalid`
  - `interface GuidedAnswers { schemaVersion: 1; approveProbes: boolean; allowConfigChange: boolean; profiles: readonly { alias: string; provider: string; model: string; role: Role; thinkingLevel: ThinkingLevel; tier: Tier|null; family: string|null }[]; defaultProfile: string; workspaces: readonly { alias: string; path: string; mode: "host"|"container"|"read-only"; acceptHostWrites?: boolean; container?: Partial<ContainerSettings> }[]; history: { enabled: boolean }; routing: { mode: RoutingMode }; clients: { claudeCode: boolean; codex: boolean } }`
  - `interface GuidedPlan { nextConfig: Record<string, unknown>; configChanged: boolean; newProfiles: readonly string[]; routingDocument: unknown|undefined; routingChanged: boolean; modeRequests: readonly ModeRequest[]; targets: readonly SetupTarget[] }`
  - `buildGuidedPlan(answers: GuidedAnswers, existing: { config?: unknown; routing?: unknown }): GuidedPlan`, which throws `GuidedPlanError` with code `config_change_not_allowed`, `profile_alias_conflict`, `workspace_alias_conflict`, `host_writes_not_accepted`, `routing_requires_history`, `probes_not_approved` or `default_profile_unknown`

The plan works on the raw parsed JSON. It adds profiles and workspaces, and `history.enabled`. It sets `events.delivery` to `spool` when Claude Code is selected. It leaves every existing profile and every field it does not own unchanged. Each tiered profile is appended to its role's list. A `code` profile is written with `permissionProfile: coding`, `review` and `explore` profiles with `read-only`, and new profiles carry no `maxTurnSeconds`. The registration targets are `claude-code:user:pi-session-mcp` and `codex:user:pi-session-mcp`.

- [ ] **Step 1: Write the failing tests**

```ts
it("refuses unknown keys and does not echo their values", ...)        // { apiKey: "SECRET" } → answers_invalid; message lacks "SECRET"
it("builds a fresh configuration", ...)
it("preserves fields it does not know", ...)                          // pins Review Focus 1; extensions, mcpServers, skillCatalog, redactPaths deep-equal
it("reports no change on a second plan", ...)                         // plan applied then re-planned: configChanged false, routingChanged false, newProfiles []
it("refuses a change to an existing file without allowConfigChange", ...)
it("refuses an alias that exists with other content", ...)
it("reuses an alias with identical content", ...)
it("refuses host mode without acceptHostWrites", ...)
it("refuses auto without history", ...)
it("refuses new profiles without approveProbes", ...)
it("sets spool delivery only for Claude Code", ...)
```

- [ ] **Step 2: Run** `npx vitest run test/guided-plan.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both modules.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(setup): plan a guided install as a merge`.

### Task 9: Guided run

**Files:**
- Create: `src/guided/run.ts`, `src/guided/prompts.ts`, `src/setup-guided-main.ts`
- Modify: `src/setup-cli.ts:13-25,26-146,147`, `src/setup-main.ts:26-30`
- Test: `test/guided-run.test.ts`, `test/guided-prompts.test.ts`, `test/setup-cli.test.ts`

**Interfaces:**
- Consumes: Tasks 7, 8; `runProfileProbe`; `runDoctor`; `changeWriterMode`; `createProductionSetup`.
- Produces:
  - `SetupCliRequest.guided?: { apply: boolean; answersPath?: string; configPath?: string }`, from `--guided`, `--answers <file>`, `--config <path>`. Those two flags need `--guided`; only `--dry-run`, `--apply` and `--json` may accompany it.
  - `interface GuidedDependencies { configPath: string; optionalFeatures(): Promise<{ podman: boolean; bubblewrap: boolean }>; catalog(): Promise<PricedModelCatalog>; doctor(configPath: string): Promise<{ ok: boolean }>; probe(profiles: readonly string[], configPath: string): Promise<ProbeReport>; changeMode(request: ModeRequest, configPath: string): Promise<SetupResult>; registrations(operation: "dry-run"|"apply"|"verify", targets: readonly SetupTarget[]): Promise<SetupResult>; signal?: AbortSignal; now?: () => Date }`
  - `runGuided(request: { apply: boolean; answers: GuidedAnswers }, deps: GuidedDependencies): Promise<SetupResult>`, with findings of target `{ client: "guided", scope: <step>, alias: <name> }`
  - `collectGuidedAnswers(prompter: Prompter, catalog: PricedModelCatalog, existing: { config?: unknown }): Promise<GuidedAnswers>`; `interface Prompter { text(question: string, fallback?: string): Promise<string>; confirm(question: string, fallback: boolean): Promise<boolean>; choose<T extends string>(question: string, options: readonly T[], fallback: T): Promise<T> }`
  - `runGuidedMain(request, json, signal): Promise<number>` in `src/setup-guided-main.ts`

Order in `runGuided` with `apply`:
1. Report unavailable optional features: `podman_unavailable` (container writers) and `bubblewrap_unavailable` (the sandbox shell) as findings that do not stop the run. If a live config exists, run `registrations("dry-run")`. `release_binding_mismatch` stops with `upgrade_required`; another divergent finding stops with `registration_divergent`.
2. Refuse with `provider_login_required` when a profile's provider has no authentication.
3. Create the candidate with `O_EXCL` beside the live file, recording the process id. A candidate whose process is gone is replaced; one with a live process stops with `guided_in_progress`.
4. Run Doctor on the candidate, then probe `newProfiles`. A failed profile is removed from the candidate and from the routing document, reported as `profile_dropped`, and Doctor runs again. A failed default profile stops with `default_profile_failed`.
5. Back up the live file as `<name>.bak-guided-<timestamp>`, replace it atomically, and write `routing.json`.
6. Run each mode request, then `registrations("apply")`, then Doctor and `registrations("verify")`.
7. Remove the candidate in `finally`. An abort reports `operation_interrupted` with exit code 130 or 143.

A dry run performs steps 1 and 2 and reports the plan without writing or spending. Prompts go to stderr, so `--json` stdout stays clean. Interactive login guidance prints the literal command text `"$(npm root -g)/pi-session-mcp/node_modules/.bin/pi"`, so no resolved path is printed. `--guided` without a terminal and without `--answers` fails with `usage_invalid`. An unreadable or invalid answers file fails with `answers_invalid` and exit code 1. The configuration path is `--config`, then `PI_SESSION_MCP_CONFIG`, then the default path.

- [ ] **Step 1: Write the failing tests**

```ts
// test/guided-run.test.ts, all dependencies faked, temporary configuration directory
it("installs from answers and verifies", ...)                 // call order: doctor, probe, changeMode, registrations apply, verify; status ok
it("reports missing optional features and continues", ...)    // podman_unavailable finding, status ok
it("changes nothing on a second run", ...)                    // no probe, config bytes identical, findings all unchanged
it("writes and spends nothing in a dry run", ...)
it("keeps the live config when a probe fails", ...)           // default profile fails: live bytes identical, default_profile_failed
it("drops a failing profile from config and routing", ...)
it("stops on a foreign registration", ...)                    // registration_divergent, no live write
it("stops with upgrade_required on a release mismatch", ...)
it("stops with provider_login_required", ...)                 // output holds the provider id and no secret or path
it("leaves no candidate after an abort", ...)                 // pins Review Focus 2; live bytes identical, exit 130
it("replaces a stale candidate", ...)                         // candidate with a dead pid does not block
it("refuses a live candidate", ...)                           // guided_in_progress
// test/guided-prompts.test.ts
it("turns confirmed proposals into valid answers", ...)
it("warns when a tier has fewer than two families", ...)
it("states the number of provider turns before probing", ...)
it("says the history stores redacted content locally and that auto requires it", ...)
// test/setup-cli.test.ts
it("parses --guided with --answers and --config", ...)
it("fails with usage_invalid without a terminal or answers", ...)  // main(["--guided"]) with a non-TTY stdin → exit 64
it.each([[ "--answers","a.json" ],[ "--config","c.json" ],[ "--guided","--verify" ],[ "--guided","--repo","a" ]])("refuses %s", ...)
```

- [ ] **Step 2: Run** `npx vitest run test/guided-run.test.ts test/guided-prompts.test.ts test/setup-cli.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the three modules, and in `setup-main.ts` dispatch `request.guided` before the `PI_SESSION_MCP_CONFIG` check at line 30. Build the real dependencies in `src/setup-guided-main.ts` from the existing functions, using `node:readline/promises` on stderr for the terminal `Prompter`.
- [ ] **Step 4: Run** the same command plus `test/setup-main.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(setup): add the guided installation`.

### Task 10: Install script, documentation and release gate

**Files:**
- Create: `install.sh`, `docs/agent-install.md`, `docs/adr/0020-tier-routing.md`, `test/install-script.test.ts`
- Modify: `package.json` (`files`), `docs/installation.md`, `docs/releasing.md`, `README.md`, `CHANGELOG.md`, `skills/pi-session-profiles/SKILL.md`, `test/package-contents.test.ts`

**Interfaces:**
- Consumes: the `--guided` command from Task 9.
- Produces: `install.sh`, a POSIX `sh` script holding `VERSION="<package version>"`.

The script checks the platform (Linux or Darwin) and Node.js 22.19 or newer, and reads the installed version with `npm ls -g --depth=0 --json pi-session-mcp`. A different installed version stops with `upgrade_required` and a pointer to the upgrade section. Otherwise it runs `npm install -g pi-session-mcp@$VERSION` unless that version is present, then `exec pi-session-mcp-setup --guided --apply "$@"`.

- [ ] **Step 1: Write the failing tests** in `test/install-script.test.ts`, with fake `node`, `npm` and `pi-session-mcp-setup` executables on `PATH`

```ts
it("pins the package version", ...)                  // VERSION in install.sh equals package.json version
it("installs that exact version, then runs setup", ...) // npm log contains install -g pi-session-mcp@<version>; setup log contains --guided --apply
it("skips npm install at the same version", ...)
it("stops with upgrade_required on another version", ...) // exit 1, npm install not called, setup not called
it("stops on an unsupported Node.js version", ...)   // exit 1, stderr contains node_version_unsupported
it("passes arguments through", ...)                  // --answers a.json reaches setup
```

Add to `test/package-contents.test.ts`: `install.sh`, `docs/agent-install.md` and `docs/adr/0020-tier-routing.md` are packed.

- [ ] **Step 2: Run** `npx vitest run test/install-script.test.ts`. Expected: FAIL.
- [ ] **Step 3: Write `install.sh`** and add it to `files`.
- [ ] **Step 4: Write the documents.**
  - `docs/agent-install.md`: the commands, the answers file format, when to stop and ask the owner (missing login, existing configuration, divergent registration, spending on probes, host writes), and how to report the outcome.
  - `docs/adr/0020-tier-routing.md`: server-side selection, the storage in the history file amending ADR 0019, and that a downgrade below this release makes the history unavailable until the release returns.
  - `docs/installation.md`: the guided path first, and login and upgrade limits.
  - `docs/releasing.md`: update `VERSION` in `install.sh` and attach the script with its SHA-256 to the release.
  - `README.md`: the quick start. `CHANGELOG.md`: `Unreleased`. `skills/pi-session-profiles/SKILL.md`: profiles in `routing.json`.
- [ ] **Step 5: Run the full gate**: `npm run typecheck && npm run build && npm test`. Expected: all pass; report any container-writer timeouts by file and test name.
- [ ] **Step 6: Negative check on the built package.** Run `node dist/setup-main.js --guided --answers /nonexistent --json`. Expected: exit 1 with `answers_invalid`, no file created under the configuration directory.
- [ ] **Step 7: Commit** `docs: document the guided installation and tier routing`.

# Pi Extension Ablation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure, per worker profile, whether adding one pinned Pi extension makes first-turn worker results pass a deterministic oracle more often at no more than 25 % extra catalog cost, and record every attempt as evidence.

**Architecture:** A new evaluation module `eval/extensions/` drives the real pi-session-mcp stack in process (`loadConfig` → `SdkPiSessionAdapter` → `SessionRegistry` → `createServer` over an in-memory MCP transport), one run per child process under `strace`. Worker usage comes from the public `AgentSession` captured through the adapter's existing injection seams (`createSession`, `extensionSdk.createRuntime`), so product sources stay unchanged. A wave orchestrator applies the spec's stop rules and budget; a reporter applies the pre-registered recommendation rule.

**Tech Stack:** Node.js ≥ 22.19 (evaluation host runs Node 26), TypeScript strict ESM, zod, vitest 5.0.3, `@earendil-works/pi-coding-agent` 1.3.0 root exports, `@modelcontextprotocol/client` `InMemoryTransport`, `strace`, `git`, `codegraph`.

**Spec:** [`docs/superpowers/specs/2026-10-19-extension-ablation-design.md`](../specs/2026-10-19-extension-ablation-design.md), as amended in Task 1.

## Global Constraints

- Product sources (`src/`, `skills/`, `package.json` dependencies) stay unchanged. No new MCP field, no runtime change, no release.
- Evaluation code may import product modules from `src/` (as `eval/profiles/cli.ts` already does) and only package-root exports of the Pi SDK.
- No new dependency. Every existing pin stays exact.
- **Budget: at most USD 10 in total**, counted as catalog cost from measured usage, subscription runs included.
- Per-run timeout **15 minutes**; wave runtime limit **4 hours**; parallelism 1; no retries within an approval.
- Extension pins: `npm:pi-lens@4.4.3`, `npm:pi-cache-optimizer@2.9.3`. Nothing else is installed.
- Profiles under test: `review-grok`, `review`, `code`, `code-deepseek`, copied verbatim from the production config except `workspaces` and the R65 `envFrom` opt-out (spec Amendments 2026-10-21).
- Credentials: copied with `selectBoundaryCredentials` (OAuth refresh token emptied), never printed, never archived.
- Tracked evidence never contains credentials, full prompts, full assistant texts or absolute paths. Prompts and texts live only under the ignored `eval/results/`.
- All tracked documentation is written in English.
- One branch (`eval/extension-ablation-design`), one PR at the end, one commit per task.

## Review Focus

1. An OAuth access token expires mid-wave (refresh token emptied). Expected: the wave stops with an auth stop before the run, or the failed run is classified as a provider/auth error, never scored as a worker `turn_failed`. Tests: Task 3 `classifyProviderError`, Task 6 expiry pre-check.
2. An extension or `codegraph` writes a cache directory inside the clone. Expected: paths pre-registered in the task's `scopeIgnore` do not count as out-of-scope edits. Anything else does. Test: Task 5 `changedPaths` ignore case. The list is fixed before approval by the provider-free dry load re-run with the final tasks in Task 10 Step 5 (the re-run of the Task 9 dry load).
3. A worker's `bash` does `cd /elsewhere && touch x`. Expected: the trace parser resolves relative writes against the tracked per-process cwd, or counts them as unresolved, which stops the wave. Test: Task 4 chdir/fork cases.
4. A run hangs or the wave gets SIGINT. Expected: the process group is killed, the residual-process check runs, every attempt record is still written, and nothing is overwritten. Test: Task 6 hanging fake runner.
5. A run produces no assistant message (immediate provider failure). Expected: cost `null`, not `0`; the budget estimate for that profile is unchanged. Test: Task 2 ledger case, Task 3 collector case.

---

### Task 1: Amend the spec with the decisions taken since approval

**Files:**
- Modify: `docs/superpowers/specs/2026-10-19-extension-ablation-design.md`
- Create: `docs/superpowers/plans/2026-10-20-extension-ablation.md` (this file)

- [ ] **Step 1: Add an "Amendments (2026-10-20)" section at the end of the spec** with these points, each with its evidence:
  - `openwiki@0.7.2` (latest on npm) registers only `openwiki_begin`, `openwiki_submit_plan`, `openwiki_next_page`, `openwiki_inspect_page_claims`, `openwiki_submit_page` and `openwiki_finish` (`dist/integrations/pi/openwiki.js`). It has no retrieval tool and no context hook. Operator decision 2026-10-20: replace that pairing with `pi-lens@4.4.3` on `code` and `code-deepseek`.
  - New priority order: (1) `pi-lens` on `code-deepseek`, (2) `pi-lens` on `code`, (3) `pi-lens` on `review-grok` and `review`, (4) `pi-cache-optimizer` on `code` and `review`. Calibration runs on pairing 1.
  - The `pi-lens` review pairing is unblocked: v0.10.0 (ADR 0010) shipped `grantedExtensionTools`. Granted set on review profiles: `symbol_search`, `project_report`, `read_symbol`, `read_enclosing`, `module_report`. Left out: `ast_grep_search`, `ast_grep_outline`, `ast_grep_replace`, `lsp_navigation` and `lens_diagnostic_mark` (situational in 4.4.3, inactive until `pi_lens_activate_tools`, which is not granted; see the spec Amendments 2026-10-21), `pi_lens_activate_tools`, `lens_diagnostics` (LSP spawning is off in untrusted projects) and `effective_config`. Coding profiles activate the registered tools that are not situational (product behaviour); the situational pi-lens tools stay inactive until `pi_lens_activate_tools`, which is active there, so coding arm B can activate the AST tools mid-session.
  - "Warming disabled" means `PI_CACHE_OPTIMIZER_NO_ZERO_PRICE_WARMING=1`, the extension's only warming lever. Pi's own `cacheWarming` stays at its default `streaming` in both arms, because that is production behaviour and only one variable changes.
  - `pi-lens` safety: untrusted projects already block tool install and LSP spawn (`isToolInstallAllowedByTrust`, `isLspSpawnAllowedByTrust`). Both arms additionally set `PI_LENS_DISABLE_TOOL_INSTALL=1`, `PI_LENS_DISABLE_LSP_INSTALL=1` and `PI_LENS_HOME` inside the run scope.
  - Usage source: the public `AgentSession` captured through the adapter seams. Per run, `getSessionStats()` (one turn per session, so it is the run total, including warming refreshes) is the cost of record. The sum of assistant `usage` is a cross-check.
  - Clones get a `codegraph` index (`codegraph init -y`), because every profile under test configures the `codegraph` MCP server.
  - Writes outside the clone are detected primarily by the `strace` write audit; before/after hashes guard the production config, the Pi install and the client registrations. Hashing the operator's repositories would misfire on concurrent work.
  - Budget estimate before each run: the most expensive run observed so far, as in the spec, but at least USD 1.00 for a profile with no observed run yet. This is stricter than the spec, never looser. Calibration counts as the first task pair of the wave.
  - Before each run, the wave stops with an auth stop if a needed OAuth access token expires within 20 minutes (`expiresWithin` from `src/writer-credentials.ts`), instead of letting the run fail.
  - Arm B session-start failures (`extension_load_failed`, `extension_tool_missing`) are harness failures and stop the wave.
- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-10-19-extension-ablation-design.md docs/superpowers/plans/2026-10-20-extension-ablation.md
git commit -m "docs: amend the extension ablation design and plan its implementation"
```

### Task 2: Schemas, run matrix and budget ledger

**Files:**
- Create: `eval/extensions/schemas.ts`, `eval/extensions/matrix.ts`, `eval/extensions/budget.ts`
- Modify: `tsconfig.eval.json` (add `"eval/extensions/**/*.ts"` to `include`)
- Test: `test/extension-ablation-matrix.test.ts`

**Interfaces:**
- Produces:
  - `type ProfileId = "review-grok" | "review" | "code" | "code-deepseek"`; `type ExtensionId = "pi-lens" | "pi-cache-optimizer"`; `type Arm = "A" | ExtensionId`.
  - `interface Pairing { id: string; extension: ExtensionId; profile: ProfileId; priority: 1|2|3|4; grantedExtensionTools?: string[] }`.
  - `interface TaskSpec { id: string; kind: "review" | "implementation"; repo: string /* alias of the source repo */; baseCommit: string; promptRef: string /* path under eval/results, untracked */; promptHash: string; sourceSession: string /* transcript session id */; allowedPaths: string[]; scopeIgnore: string[]; oracle: ReviewOracle | ImplementationOracle }` (oracle types from Task 5, declared here as zod schemas).
  - `interface RunSpec { runId: string; taskId: string; profile: ProfileId; arm: Arm; ordinal: number; pairings: string[] /* pairings this run serves */ }`.
  - `const PAIRINGS: readonly Pairing[]` with ids `pl-code-deepseek` (1), `pl-code` (2), `pl-review-grok` (3), `pl-review` (3), `co-code` (4), `co-review` (4). The two review pairings carry `grantedExtensionTools` with the five names fixed in Task 1.
  - `buildMatrix(tasks: TaskSpec[], pairings: readonly Pairing[]): RunSpec[]`
  - `trimMatrix(tasks: TaskSpec[], pairings: readonly Pairing[], projectedUsd: (runs: RunSpec[]) => number, remainingUsd: number): { pairings: Pairing[]; tasksPerPairing: Record<string, string[]>; runs: RunSpec[] }`
  - `class BudgetLedger { constructor(limitUsd: number); record(profile: ProfileId, costUsd: number | null): void; estimate(profile: ProfileId): number; allows(profile: ProfileId): boolean; get spentUsd(): number }`; `BUDGET_USD = 10`, `INITIAL_RUN_ESTIMATE_USD = 1`.

- [ ] **Step 1: Write the failing tests**

```ts
it("pairs review tasks with review profiles and implementation tasks with coding profiles", () => {
  const runs = buildMatrix([review("R1"), impl("I1")], PAIRINGS);
  expect(new Set(runs.filter(r => r.taskId === "R1").map(r => r.profile))).toEqual(new Set(["review-grok", "review"]));
  expect(new Set(runs.filter(r => r.taskId === "I1").map(r => r.profile))).toEqual(new Set(["code-deepseek", "code"]));
});
it("shares one arm-A run per task and profile across pairings", () => {
  const runs = buildMatrix([review("R1")], PAIRINGS);
  const a = runs.filter(r => r.profile === "review" && r.arm === "A");
  expect(a).toHaveLength(1);
  expect(a[0]!.pairings.sort()).toEqual(["co-review", "pl-review"]);
});
it("orders by pairing priority and alternates arm A position per task", () => {
  const runs = buildMatrix([impl("I1"), impl("I2")], PAIRINGS);
  expect(runs[0]!.profile).toBe("code-deepseek");
  const cd = runs.filter(r => r.profile === "code-deepseek");
  expect(cd.map(r => r.arm)).toEqual(["A", "pi-lens", "pi-lens", "A"]);
});
it("trims tasks from the lowest priority first, never below 3, then drops whole pairings", () => {
  const tasks = ["I1","I2","I3","I4","R1","R2","R3","R4"].map(id => id[0] === "I" ? impl(id) : review(id));
  const t = trimMatrix(tasks, PAIRINGS, (runs) => runs.length * 0.5, 10);   // full matrix: 40 runs = USD 20
  expect(t.pairings.map(p => p.id)).toEqual(["pl-code-deepseek", "pl-code", "pl-review-grok"]);
  expect(Object.values(t.tasksPerPairing)).toEqual([["I1","I2","I3"], ["I1","I2","I3"], ["R1","R2","R3"]]);
  expect(t.runs).toHaveLength(18);
});
it("grants the pre-registered pi-lens tools on review profiles only", () => {
  const granted = ["symbol_search", "project_report", "read_symbol", "read_enclosing", "module_report"];
  expect(PAIRINGS.find(p => p.id === "pl-review")!.grantedExtensionTools).toEqual(granted);
  expect(PAIRINGS.find(p => p.id === "pl-code")!.grantedExtensionTools).toBeUndefined();
});
it("ledger: null cost keeps the estimate; the most expensive observed run drives it", () => {
  const l = new BudgetLedger(10);
  expect(l.estimate("code")).toBe(1);
  l.record("code-deepseek", 0.02); l.record("code-deepseek", null);
  expect(l.estimate("code-deepseek")).toBe(0.02);
  expect(l.estimate("code")).toBe(1);
  l.record("code", 0.4);
  expect(l.estimate("code-deepseek")).toBe(0.4);
  expect(l.spentUsd).toBeCloseTo(0.42);
  l.record("code", 9.3);
  expect(l.allows("review")).toBe(false);   // 9.72 + max(1, 9.3) > 10
});
```

Estimate rule, exactly: `estimate(p) = observed(p) ? maxObservedOverall : max(INITIAL_RUN_ESTIMATE_USD, maxObservedOverall)`, where `observed(p)` means at least one non-null cost was recorded for `p`; `allows(p) = spentUsd + estimate(p) <= limitUsd`.

Trim rule, exactly: each pairing uses the first N tasks of its kind in task-list order, so arm-A runs stay shared. (1) While over budget and some pairing has more than 3 tasks, remove the last task of the lowest-priority such pairing (ties: the later one in `PAIRINGS`). (2) While still over budget, drop the lowest-priority pairing (same tie rule).

- [ ] **Step 2: Run** `npx vitest run test/extension-ablation-matrix.test.ts` — Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the schemas with zod (`.strict()` objects, as in `eval/profiles/schemas.ts`), `PAIRINGS`, `buildMatrix`, `trimMatrix` and `BudgetLedger`. `runId` = `${String(ordinal).padStart(3,"0")}-${taskId}-${profile}-${arm}`. Execution order key: (lowest priority among the run's `pairings`, the profile's first position in `PAIRINGS`, task index, arm position). Arm position puts A first for even task indexes and last for odd ones, among runs with the same key prefix. A `co-*` B run therefore follows its already-run arm A; the cache-read share per arm (Task 7) makes that visible.
- [ ] **Step 4: Run** the test file and `npx tsc -p tsconfig.eval.json --noEmit` — Expected: PASS, no type errors.
- [ ] **Step 5: Commit** `feat(eval): add the extension ablation run matrix and budget ledger`.

### Task 3: Usage capture and the in-process run unit

**Files:**
- Create: `eval/extensions/usage.ts`, `eval/extensions/seams.ts`, `eval/extensions/run-one.ts`
- Test: `test/extension-ablation-run-one.test.ts`

**Interfaces:**
- Consumes: `RunSpec`, `TaskSpec` (Task 2).
- Produces:
  - `interface RunUsage { session: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; costUsd: number } | null; assistant: { messages: number; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number }; providerError: ProviderErrorClass | null }`
  - `type ProviderErrorClass = "auth" | "quota" | "rate_limit" | "other"`; `classifyProviderError(stopReason: string | undefined, errorMessage: string | undefined): ProviderErrorClass | null`. Returns `null` unless `stopReason === "error"`. Patterns: `auth` = `/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid.{0,20}(token|key)|expired/i`; `quota` = `/quota|insufficient|billing|credit|payment/i`; `rate_limit` = `/\b429\b|rate.?limit|too many requests/i`; otherwise `other`. The message itself is never stored.
  - `class UsageCollector { attach(session: AgentSession): () => void; finish(session: AgentSession | undefined): RunUsage }`. Assistant usage is summed per field from `message_end` events with `role === "assistant"`. `reasoning` is never added to `output`; `cacheWrite1h` is never added to `cacheWrite`.
  - `createCapturingAdapter(onSession: (session: AgentSession) => void, options?: Pick<SdkPiSessionAdapterOptions, "modelRuntimeFactory" | "resolveExtension" | "diagnosticSink">): SdkPiSessionAdapter`. It wraps `createSession` (arm A path) and `extensionSdk.createRuntime` (arm B path, using `runtime.session`) and calls `onSession` once per created session. It uses only the default root exports, as in `docs/evaluation/permission-gates-2026-10-17/permission-gate-worker.mjs`.
  - `interface RunOutput { runId: string; terminal: "completed" | "failed" | "aborted" | "timeout" | "start_failed"; startErrorCode: string | null; usage: RunUsage; durationMs: number; sessionsLeft: number; assistantTextRef: string | null }`
  - `runOne(input: { configPath: string; workspaceAlias: "clone"; profile: ProfileId; promptText: string; turnTimeoutMs: number; privateDir: string }, deps?: { adapterOptions?: Parameters<typeof createCapturingAdapter>[1] }): Promise<RunOutput>`. The CLI entry (`node run-one.js <input.json>`) writes `run-output.json` next to the input and exits 0 whenever a `RunOutput` was written.

- [ ] **Step 1: Write the failing tests.** Use a scripted `ModelRuntime` as in `eval/profiles/token-filter-calibration.ts` (`runtimeFor`), passed through `adapterOptions.modelRuntimeFactory`, with a temporary config written for a read-only and a coding profile with `skills: ["pi-session-review"]` and `skillCatalog: { "pi-session-review": "builtin:pi-session-review" }`.

```ts
it("returns the completed text by reference and sums assistant usage", async () => {
  const out = await runOne(input("read-only"), { adapterOptions: scripted([{ text: "ok", usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 0, cost: { total: 0.001 } } }]) });
  expect(out.terminal).toBe("completed");
  expect(out.usage.assistant).toMatchObject({ messages: 1, input: 10, output: 5, cacheRead: 3 });
  expect(out.usage.session?.costUsd).toBeCloseTo(0.001);
  expect(out.sessionsLeft).toBe(0);
  expect(await readFile(join(privateDir, out.assistantTextRef!), "utf8")).toBe("ok");
});
it("reports cost null when no assistant message was observed", async () => {
  const out = await runOne(input("read-only"), { adapterOptions: scripted([{ throws: true }]) });
  expect(out.terminal).toBe("failed");
  expect(out.usage.session).toBeNull();     // no assistant message: no cost of record
});
it("classifies provider errors without storing the message", () => {
  expect(classifyProviderError("error", "HTTP 401 Unauthorized")).toBe("auth");
  expect(classifyProviderError("error", "You exceeded your current quota")).toBe("quota");
  expect(classifyProviderError("error", "429 Too Many Requests")).toBe("rate_limit");
  expect(classifyProviderError("stop", "401")).toBeNull();
});
it("maps a session-start failure to start_failed with the product error code", async () => {
  const out = await runOne(input("read-only", { extensions: ["npm:pi-lens@4.4.3"] }), { adapterOptions: { ...scripted([]), resolveExtension: async () => { throw new PiExtensionError("extension_not_installed"); } } });
  expect(out).toMatchObject({ terminal: "start_failed", startErrorCode: "extension_not_installed" });
});
it("starts a coding profile with a builtin skill", async () => {
  const out = await runOne(input("coding"), { adapterOptions: scripted([{ text: "done" }]) });
  expect(out.terminal).toBe("completed");   // skill_load_failed would mean the builtin skill did not resolve
});
```

The `session` figure rule: `null` when `assistant.messages === 0`; otherwise taken from `getSessionStats()` (`tokens.*`, `cost`).

- [ ] **Step 2: Run** `npx vitest run test/extension-ablation-run-one.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** `runOne` calls `loadConfig(configPath)`, builds `new SessionRegistry(createCapturingAdapter(...), config.workspaces)` and `createServer(registry, config.workspaces, config.executionProfiles, config.defaultExecutionProfile, config.configuration, config.workspaceModes)`, connects a `Client` over `InMemoryTransport.createLinkedPair()`, then calls `pi_session_start` → `pi_session_prompt` → polls `pi_turn_get` every 250 ms until terminal or `turnTimeoutMs` (then `pi_session_abort`, terminal `timeout`) → `pi_session_close` → `pi_session_list`, and finally `registry.shutdown()`. The provider error class comes from the last assistant message seen by the collector (`stopReason`, `errorMessage`). The assistant text goes to `privateDir/<runId>.txt` (mode 0600). A `pi_session_start` domain error yields `start_failed` with its `code`.
- [ ] **Step 4: Run** the test file and the type check — Expected: PASS.
- [ ] **Step 5: Commit** `feat(eval): capture worker usage through the adapter seams`.

### Task 4: Trace audit and production guard

**Files:**
- Create: `eval/extensions/trace.ts`, `eval/extensions/guard.ts`
- Test: `test/extension-ablation-trace.test.ts`

**Interfaces:**
- Produces:
  - `STRACE_ARGS = ["-f", "-qq", "-e", "trace=connect,openat,open,creat,rename,renameat,renameat2,unlink,unlinkat,mkdir,mkdirat,symlink,symlinkat,link,linkat,truncate,chdir,fchdir,clone,clone3,fork,vfork", "-y"]`. The caller appends `-o <log> --`.
  - `interface TraceContext { rootPid: number; initialCwd: string; allowedWriteRoots: string[]; providerAddresses: ReadonlySet<string>; dnsAddresses: ReadonlySet<string> }`
  - `interface TraceFindings { outsideWrites: string[]; unresolvedWrites: number; unexpectedConnects: { family: "inet" | "inet6"; address: string; port: number }[]; connects: number }`
  - `parseStraceLog(text: string, ctx: TraceContext): TraceFindings`. A write is: `openat`/`open` with `O_WRONLY|O_RDWR|O_CREAT|O_TRUNC` in the flags, or any of `creat rename* unlink* mkdir* symlink* link* truncate`. Paths resolve against the dirfd path printed by `-y`, else against the pid's tracked cwd. A child inherits its parent's cwd at `clone`/`fork`/`vfork` return; `chdir`/`fchdir` update it. Unknown cwd → `unresolvedWrites++`. `AF_UNIX` and `AF_NETLINK` connects are ignored; inet connects to `dnsAddresses` port 53 are expected; everything else not in `providerAddresses` is unexpected. Writes to `/dev/null`, `/dev/tty`, `/dev/pts/*` and `/proc/self/*` are allowed.
  - `interface GuardSnapshot { files: Record<string, string /* sha256 or "absent" */> }`; `guardSnapshot(home: string): Promise<GuardSnapshot>` hashes `~/.config/pi-session-mcp/pi-session-mcp.json`, `~/.pi/agent/settings.json`, `~/.pi/agent/mcp.json`, a tree digest of `~/.pi/agent/npm` (via `digest(snapshot(...))` from `eval/profiles/files.ts`), the JSON of `mcpServers` entries whose key starts with `pi-` in `~/.claude.json`, and the `[mcp_servers.pi-*]` tables of `~/.codex/config.toml` as text. `guardDiff(before, after): string[]` lists the changed keys.

- [ ] **Step 1: Write the failing tests** with literal strace lines (one fixture string per case):

```ts
it("flags an absolute write outside the allowed roots", () => {
  const f = parseStraceLog(`100 openat(AT_FDCWD</clone>, "/home/u/repo/x", O_WRONLY|O_CREAT, 0644) = 3</home/u/repo/x>\n`, ctx({ allowed: ["/scope"] }));
  expect(f.outsideWrites).toEqual(["/home/u/repo/x"]);
});
it("resolves relative writes after chdir in a forked child", () => {
  const log = ["100 clone3({...}) = 101", "101 chdir(\"/elsewhere\") = 0", "101 openat(AT_FDCWD, \"x\", O_WRONLY|O_CREAT, 0644) = 3"].join("\n");
  expect(parseStraceLog(log, ctx({ initialCwd: "/scope/clone", allowed: ["/scope"] })).outsideWrites).toEqual(["/elsewhere/x"]);
});
it("counts a relative write of an untracked pid as unresolved", () => {
  expect(parseStraceLog(`555 openat(AT_FDCWD, "y", O_RDWR) = 3\n`, ctx({})).unresolvedWrites).toBe(1);
});
it("ignores reads, unix sockets and DNS; reports other inet destinations", () => {
  const log = ["100 openat(AT_FDCWD, \"/etc/hosts\", O_RDONLY|O_CLOEXEC) = 3", "100 connect(4, {sa_family=AF_UNIX, sun_path=\"/run/x\"}, 110) = 0",
    "100 connect(5, {sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr(\"127.0.0.53\")}, 16) = 0",
    "100 connect(6, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr(\"203.0.113.9\")}, 16) = -1 EINPROGRESS"].join("\n");
  const f = parseStraceLog(log, ctx({ provider: ["198.51.100.1"], dns: ["127.0.0.53"] }));
  expect(f.outsideWrites).toEqual([]);
  expect(f.unexpectedConnects).toEqual([{ family: "inet", address: "203.0.113.9", port: 443 }]);
});
it("guardDiff names changed targets only", () => {
  expect(guardDiff({ files: { a: "1", b: "2" } }, { files: { a: "1", b: "3" } })).toEqual(["b"]);
});
```

- [ ] **Step 2: Run** `npx vitest run test/extension-ablation-trace.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `parseStraceLog` as a line parser (pid prefix, syscall name, quoted path arguments, dirfd `<path>` annotations from `-y`, return value) and `guardSnapshot`/`guardDiff`. Unfinished/resumed line pairs (`<unfinished ...>` / `<... openat resumed>`) are joined per pid before parsing.
- [ ] **Step 4: Run** the tests — Expected: PASS.
- [ ] **Step 5: Commit** `feat(eval): audit writes and connections of ablation runs`.

### Task 5: Task oracles

**Files:**
- Create: `eval/extensions/oracles.ts`
- Test: `test/extension-ablation-oracles.test.ts`

**Interfaces:**
- Produces:
  - `interface Anchor { file: string /* repo-relative */; terms: string[] /* all must appear */ }`
  - `interface ReviewOracle { kind: "review"; findings: { id: string; critical: boolean; anchors: Anchor[] /* any anchor hits */ }[]; falseFindings: { id: string; anchors: Anchor[] }[] }`
  - `interface ImplementationOracle { kind: "implementation"; command: string[] /* argv, no shell */; timeoutMs: number; setup?: string[][] /* argv list, e.g. ["npm","ci","--ignore-scripts"] */ }`
  - `scoreReview(text: string, oracle: ReviewOracle): { accepted: boolean; criticalHit: number; criticalTotal: number; recall: number; falseFindings: string[] }`. An anchor hits when one block of the text (split on blank lines and on list-item starts) contains the file's basename or repo-relative path and every term, case-insensitive. `accepted` = all critical findings hit and no false finding hit.
  - `changedPaths(clone: string, scopeIgnore: string[]): Promise<string[]>` from `git status --porcelain=v1 -z --untracked-files=all --ignored=matching`, minus paths under any `scopeIgnore` prefix and minus `.codegraph/`.
  - `scoreImplementation(clone: string, task: { allowedPaths: string[]; scopeIgnore: string[]; oracle: ImplementationOracle }): Promise<{ accepted: boolean; testsPassed: boolean; outOfScope: string[] }>`. Scope is computed **before** setup and test commands run.

- [ ] **Step 1: Write the failing tests** with a temporary git repository:

```ts
it("accepts a review that hits every critical finding in one block", () => {
  const o: ReviewOracle = { kind: "review", findings: [{ id: "f1", critical: true, anchors: [{ file: "src/a.ts", terms: ["race", "lock"] }] }, { id: "f2", critical: false, anchors: [{ file: "b.md", terms: ["typo"] }] }], falseFindings: [{ id: "x1", anchors: [{ file: "src/a.ts", terms: ["sql injection"] }] }] };
  expect(scoreReview("- src/a.ts: race when the lock is released early", o)).toMatchObject({ accepted: true, criticalHit: 1, recall: 0.5, falseFindings: [] });
  expect(scoreReview("src/a.ts has a race.\n\nThe lock is fine.", o).accepted).toBe(false);   // terms split across blocks
  expect(scoreReview("- src/a.ts: race, lock\n- src/a.ts: SQL injection", o).falseFindings).toEqual(["x1"]);
});
it("computes scope before tests and honours scopeIgnore", async () => {
  // repo with a.ts committed; worker changed a.ts, created .pi-lens/cache.json and b.ts
  const r = await scoreImplementation(repo, { allowedPaths: ["a.ts"], scopeIgnore: [".pi-lens/"], oracle: { kind: "implementation", command: ["node", "-e", "process.exit(0)"], timeoutMs: 10_000 } });
  expect(r).toEqual({ accepted: false, testsPassed: true, outOfScope: ["b.ts"] });
});
it("fails on a non-zero or timed-out test command", async () => {
  const r = await scoreImplementation(repo, { allowedPaths: ["a.ts"], scopeIgnore: [], oracle: { kind: "implementation", command: ["node", "-e", "setTimeout(()=>{}, 60000)"], timeoutMs: 500 } });
  expect(r.testsPassed).toBe(false);
});
```

- [ ] **Step 2: Run** `npx vitest run test/extension-ablation-oracles.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** Commands run with `execFile` (no shell), `cwd` = clone, a minimal environment (`PATH`, `HOME` = run scope home, `CI=1`), the timeout, and a process-group kill on timeout.
- [ ] **Step 4: Run** the tests — Expected: PASS.
- [ ] **Step 5: Commit** `feat(eval): add review and implementation oracles for the ablation`.

### Task 6: Run scope, wave orchestrator, CLI and build wrapper

**Files:**
- Create: `eval/extensions/workspace.ts`, `eval/extensions/wave.ts`, `eval/extensions/cli.ts`, `scripts/extension-ablation.mjs`
- Modify: `package.json` (script `"eval:extensions": "node scripts/extension-ablation.mjs"` only)
- Test: `test/extension-ablation-wave.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces:
  - `interface RunScope { root: string; clone: string; home: string; agentDir: string; configPath: string; env: Record<string, string> }`
  - `prepareRunScope(input: { waveDir: string; run: RunSpec; task: TaskSpec; sourceRepoPath: string; extensionTemplate: string; hostAuth: unknown; productionProfile: unknown; pairing?: Pairing }): Promise<RunScope>`. Steps: `git clone --no-hardlinks --quiet <source> <root>/clone`, `git checkout --quiet <baseCommit>`, append `.codegraph/` to `.git/info/exclude`, `codegraph init -y <clone>`. The agent dir gets `writeBoundaryCredentials(agentDir, selectBoundaryCredentials(hostAuth, [provider]))` and, for arm B, a copy of the extension template's `npm/` tree. The config contains `workspaces: { clone }`, the production `skillCatalog`, the production profile under its own alias with `default: true` for read-only profiles; a coding profile is added next to a read-only copy of itself named `<alias>-ro` (default), because exactly one read-only default is required. Arm B adds `extensions: ["npm:<pin>"]` and, on review profiles, `grantedExtensionTools`. There is no `execution-modes.json` (production has none). `env` = `{ HOME, PI_CODING_AGENT_DIR: agentDir, TMPDIR, XDG_CONFIG_HOME, XDG_CACHE_HOME, XDG_DATA_HOME, XDG_STATE_HOME, PI_LENS_HOME, PI_LENS_DISABLE_TOOL_INSTALL: "1", PI_LENS_DISABLE_LSP_INSTALL: "1", PI_CACHE_OPTIMIZER_NO_ZERO_PRICE_WARMING: "1", PATH }`, all inside `root`, identical for both arms.
  - `type StopReason = "outside_write" | "unresolved_write" | "guard_changed" | "harness_failure" | "cleanup_failure" | "provider_error" | "credential_expiring" | "budget" | "wave_timeout" | "interrupted"`
  - `interface RunRecord { runId: string; taskId: string; profile: ProfileId; arm: Arm; pairings: string[]; outcome: "scored" | "stopped" | "not_run"; terminal: RunOutput["terminal"] | null; accepted: boolean | null; review?: ReturnType<typeof scoreReview>; implementation?: Awaited<ReturnType<typeof scoreImplementation>>; usage: RunUsage | null; durationMs: number | null; trace: TraceFindings | null; stopReason: StopReason | null }`
  - `runWave(input: { approval: Approval; tasks: TaskSpec[]; waveDir: string; signal?: AbortSignal }, deps?: { spawnRun?: (scope: RunScope, runInput: string, log: string) => ChildProcess; now?: () => number }): Promise<{ records: RunRecord[]; stopReason: StopReason | null; spentUsd: number }>`
  - `interface Approval { approved: true; approvedAt: string; budgetUsd: 10; sourceCommit: string; tasksDigest: string; matrixDigest: string; routes: { profile: ProfileId; provider: string; model: string; thinkingLevel: string }[] }`, validated by `validateApproval(raw: unknown, current: { sourceCommit: string; tasks: TaskSpec[]; runs: RunSpec[] }): Approval`. It throws `approval_binding_changed` on any mismatch.
  - CLI modes: `--plan --tasks <file>` (prints matrix, trimmed projection and approval template; no model), `--scan --out <file>` (Task 8), `--dry-load --tasks <file>` (Task 9, provider-free), `--preflight --approval <file> --tasks <file>`, `--wave --approval <file> --tasks <file> [--out <dir>]`, `--report <waveDir>` (Task 7).

Wave loop, exactly:
1. Before the first run: `guardSnapshot` (G0), wave clock start.
2. Per run: stop if wave time ≥ 4 h (`wave_timeout`), on abort (`interrupted`) or if `!ledger.allows(profile)` (`budget`). Stop with `credential_expiring` if `expiresWithin(hostAuth, [provider], 20, now)`. Then `prepareRunScope`, write the run input (prompt from `promptRef` with the source repo path rewritten to the clone path) and spawn `strace <STRACE_ARGS> -o <log> -- node <build>/eval/extensions/run-one.js <input>` detached, with `env` = scope env. Kill the process group at 15 min + 30 s (inner turn timeout: 14 min).
3. After exit: the residual check (`ps -o pid= -g <pgid>` empty) failing → `cleanup_failure`; `sessionsLeft > 0` → `cleanup_failure`; `start_failed` or a missing `run-output.json` → `harness_failure`; a provider error class other than `null`/`"other"` → `provider_error`. `parseStraceLog` with `allowedWriteRoots: [scope.root, waveDir]`: `outsideWrites` non-empty → `outside_write`, `unresolvedWrites > 0` → `unresolved_write`. `guardDiff(G0, guardSnapshot())` non-empty → `guard_changed`. Otherwise score with the task oracle; `failed`/`timeout` terminals are scored as not accepted.
4. Ledger records `usage.session?.costUsd ?? null` **for every executed run, stopped ones included**.
5. Write `runs/<runId>.json` (flag `wx`) for every run, executed or `not_run`. Remove the run scope only when the run was scored and accepted; otherwise keep it under `waveDir/private/` and record nothing path-bearing in tracked files.

- [ ] **Step 1: Write the failing tests** with an injected `spawnRun` that runs a fake script writing a prepared `run-output.json` and strace log:

```ts
it("stops on an outside write and records the remaining runs as not_run", async () => {
  const r = await runWave(waveInput(3), { spawnRun: fake([{ trace: outsideWriteLog }]) });
  expect(r.stopReason).toBe("outside_write");
  expect(r.records.map(x => x.outcome)).toEqual(["stopped", "not_run", "not_run"]);
});
it("scores turn_failed and continues", async () => {
  const r = await runWave(waveInput(2), { spawnRun: fake([{ output: { terminal: "failed" } }, { output: completed }]) });
  expect(r.stopReason).toBeNull();
  expect(r.records[0]).toMatchObject({ outcome: "scored", accepted: false });
});
it("stops on a provider auth error instead of scoring it", async () => {
  const r = await runWave(waveInput(2), { spawnRun: fake([{ output: { terminal: "failed", providerError: "auth" } }]) });
  expect(r.stopReason).toBe("provider_error");
});
it("kills a hanging run at the run timeout, checks residuals and keeps the record", async () => {
  const r = await runWave(waveInput(1, { runTimeoutMs: 300 }), { spawnRun: fake([{ hang: true }]) });
  expect(r.records[0]!.terminal).toBe("timeout");
  expect(existsSync(join(waveDir, "runs", r.records[0]!.runId + ".json"))).toBe(true);
});
it("stops before a run the budget cannot cover", async () => {
  const r = await runWave(waveInput(3), { spawnRun: fake([{ output: { ...completed, cost: 9.5 } }]) });
  expect(r.stopReason).toBe("budget");
  expect(r.spentUsd).toBeCloseTo(9.5);
});
it("stops before a run whose OAuth credential expires within 20 minutes", async () => {
  const r = await runWave(waveInput(1, { hostAuth: { openai: { type: "oauth", access: "x", refresh: "y", expires: Date.now() + 5 * 60_000 } } }), { spawnRun: fake([]) });
  expect(r.stopReason).toBe("credential_expiring");
  expect(r.records[0]!.outcome).toBe("not_run");
});
it("rejects an approval whose bindings changed", () => {
  expect(() => validateApproval({ ...approval, tasksDigest: "sha256:0" }, current)).toThrow("approval_binding_changed");
});
```

Make the run and wave timeouts injectable through `waveInput` options with the 15 min / 4 h defaults, so the tests run fast.

- [ ] **Step 2: Run** `npx vitest run test/extension-ablation-wave.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `workspace.ts`, `wave.ts` and `cli.ts`. `scripts/extension-ablation.mjs` copies `scripts/profile-evaluation.mjs` but launches `eval/extensions/cli.js` and also symlinks `<repo>/skills` to `<build>/skills`, so `builtin:` skills resolve in the build. `--preflight` runs one PONG prompt (`Reply with exactly: PONG`) per approved route through `runOne` with arm A, records its cost in the ledger file `waveDir/ledger.json`, and fails the route on any terminal other than `completed`. A failed route is reported and its pairings are excluded from the wave by editing the task/pairing selection, which needs a new approval.
- [ ] **Step 4: Run** the tests, `npx tsc -p tsconfig.eval.json --noEmit` and `npm run eval:extensions -- --plan --tasks test/fixtures/extension-ablation/tasks.json` — Expected: PASS; `--plan` prints a JSON matrix with `approved: false`.
- [ ] **Step 5: Commit** `feat(eval): orchestrate extension ablation waves with stop rules`.

### Task 7: Report, recommendation and evidence integrity

**Files:**
- Create: `eval/extensions/report.ts`
- Test: `test/extension-ablation-report.test.ts`

**Interfaces:**
- Consumes: `RunRecord`, `PAIRINGS`.
- Produces:
  - `recommend(a: { accepted: number; costUsd: number }, b: { accepted: number; costUsd: number }, perTask: { a: boolean; b: boolean }[]): "enable" | "do-not-enable" | "inconclusive"`. Enable iff `b.accepted >= a.accepted`, at least one task has `b && !a`, and `b.costUsd <= 1.25 * a.costUsd`. Do not enable iff `b.accepted < a.accepted`. Inconclusive otherwise.
  - `summarize(records: RunRecord[]): { pairings: { id: string; tasks: string[]; complete: boolean; a: {...}; b: {...}; recommendation: ReturnType<typeof recommend> | "not-run"; cacheReadShare: { a: number; b: number } }[]; spentUsd: number; stopReason: StopReason | null }`. Only tasks with both arms scored count; a pairing with fewer than 3 such tasks gets `"inconclusive"` and `complete: false`.
  - `writeEvidence(waveDir: string, evidenceDir: string): Promise<void>`. It copies `runs/*.json` and the sanitized `trace-summary.json` and writes `summary.json` plus `integrity.json` (`{ kind: "extension-ablation-evidence-integrity", source_binding, files: [{ path, hash }] }`, as in `docs/evaluation/extension-functions-2026-10-17/integrity.json`). It refuses (throws `evidence_contains_private_data`) if any copied file contains the wave's absolute root, the home path, an `auth.json` key name such as `"access"` or `"refresh"`, or a string longer than 2,000 characters.

- [ ] **Step 1: Write the failing tests**

```ts
it("applies the pre-registered rule", () => {
  expect(recommend({ accepted: 2, costUsd: 1 }, { accepted: 3, costUsd: 1.2 }, [{ a: false, b: true }, { a: true, b: true }, { a: true, b: true }])).toBe("enable");
  expect(recommend({ accepted: 2, costUsd: 1 }, { accepted: 3, costUsd: 1.3 }, [{ a: false, b: true }, { a: true, b: true }, { a: true, b: true }])).toBe("inconclusive");
  expect(recommend({ accepted: 3, costUsd: 1 }, { accepted: 2, costUsd: 0.5 }, [])).toBe("do-not-enable");
  expect(recommend({ accepted: 3, costUsd: 1 }, { accepted: 3, costUsd: 0.9 }, [{ a: true, b: true }])).toBe("inconclusive");
});
it("marks a pairing with fewer than three paired tasks inconclusive", () => { /* two paired tasks → complete false, "inconclusive" */ });
it("refuses evidence that leaks private data", async () => { /* a run JSON containing the home path → throws evidence_contains_private_data */ });
```

- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement.** **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(eval): report extension ablation results with the pre-registered rule`.

### Task 8: Transcript candidate scanner

**Files:**
- Create: `eval/extensions/scan.ts`
- Test: `test/extension-ablation-scan.test.ts`, fixture `test/fixtures/extension-ablation/transcript.jsonl` (synthetic)

**Interfaces:**
- Produces: `scanTranscripts(dir: string): Promise<Candidate[]>` with `interface Candidate { transcript: string /* file name */; sessionId: string; workspace: string; executionProfile: string; firstPromptAt: string; firstPromptHash: string; followUps: number; firstTerminal: "completed" | "failed" | "aborted" | "unknown" }`. It reads Claude Code JSONL lines and pairs `tool_use` blocks named `mcp__pi-session-mcp__pi_session_start` and `…pi_session_prompt` with their `tool_result`s by `tool_use_id`. Prompt text is never returned, only its hash; `--scan` writes the candidates to the ignored `eval/results/`.

- [ ] **Step 1: Write the failing test** on the synthetic transcript (two sessions, one with a follow-up): it expects two candidates with `followUps` `[0, 1]`, profiles `["review-grok", "code"]` and no prompt text in the serialized output.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Run the full gate:** `npm run typecheck && npx tsc -p tsconfig.eval.json --noEmit && npm test` — Expected: everything passes; the existing suite is unchanged.
- [ ] **Step 6: Commit** `feat(eval): scan controller transcripts for ablation task candidates`.

### Task 9: Extension template and provider-free dry load (operator gate: network for npm only)

Paths below use `$EVAL` for the evaluation's working directory, which lies **outside the repository and outside every configured workspace** (the CLI refuses a wave directory inside either): `EVAL=~/.cache/pi-session-mcp/extension-ablation/<date>`. Prompts stay under `eval/results/extension-ablation-<date>/prompts/` because task files may only name prompts there; `eval/results/` is ignored by git.

**Files:**
- Create: `docs/evaluation/extension-ablation-2026-10-20/setup.md`

- [ ] **Step 1: Install the template** under `$EVAL/template/npm`: `npm install --prefix $EVAL/template/npm --ignore-scripts --no-audit --no-fund --save-exact pi-lens@4.4.3 pi-cache-optimizer@2.9.3`. Record the resolved top-level versions and the lockfile hash in `setup.md`. This is the only network operation outside the wave.
- [ ] **Step 2: Run** `npm run eval:extensions -- --dry-load --tasks <tasks.json> --template $EVAL/template --out $EVAL/dry-load`. (`--out` must not exist; the repository must be clean, as for `--plan`.) Per arm B profile, this creates a session in the same bubblewrap and strace shape as a run, with a fixture model runtime: no prompt and no provider. It records the active tool names, confirms every granted tool is active on the review profiles and lists any files created inside a scratch clone. It fails on any outbound connect.
- [ ] **Step 3: Verify** `extension_tool_missing` did not occur, and record the active tool lists and any clone-local paths in `setup.md`. Every clone-local path the extension created goes into each task's `scopeIgnore` before approval.
- [ ] **Step 4: Commit** `docs: record the extension ablation setup and dry load`.

### Task 10: Curate 6–8 tasks with verified oracles

**Files:**
- Create: `docs/evaluation/extension-ablation-2026-10-20/tasks.json` (tracked: ids, repo alias, base commit, prompt hash, source session id, allowed paths, scope ignore, oracle, optional `dependencies` (R68); an oracle's `timeoutMs` is at most 10 minutes), `eval/results/extension-ablation-<date>/prompts/*.txt` (untracked)
- Modify: `docs/evaluation/extension-ablation-2026-10-20/setup.md` (result of the dry load with the final tasks)

- [ ] **Step 1: Run** `npm run eval:extensions -- --scan --transcripts <dir of Claude Code JSONL files> --out eval/results/extension-ablation-<date>/candidates.json`. Pick 3–4 review and 3–4 implementation candidates whose original outcome is unambiguous. Reviews: the known findings come from later rounds in the same transcript. Implementations: decisive tests exist at the original solution commit.
- [ ] **Step 2: Check each implementation oracle against history:** at `baseCommit` the decisive command fails; at the original solution commit it passes and the scope check passes. A task that fails either check is dropped.
- [ ] **Step 3: Check each review oracle against history:** anchors are written from the later-round findings before any live run. Scoring the original first-round review text must reproduce what the transcript shows (accepted or not). Drop any task where that needs judgment.
- [ ] **Step 4: Check the replay constraints:** the original first prompt is copied verbatim except for repo path rewrites; the base commit is the commit before the original solution; the repository is one the recorded session already sent to the same provider.
- [ ] **Step 4a: Prepare `--deps` for every task that declares `dependencies` (R68):** build `$EVAL/deps/<taskId>/` outside the repository, the workspaces and `$EVAL` waves: `mounts/<path>/` (the installed dependency, a real directory), `lock/<lockfile>` (byte-equal to the lockfile at the task's base commit) and, if the content points to absolute paths such as a venv's interpreter, `runtime/` at the path the content references (build the venv with `$EVAL/deps/<taskId>/runtime/…` as its interpreter, using the real path without symlinks). The harness checks the lock copy, the mount and that `<path>` is not tracked at the base commit before each scope is used, and binds the mount read-only. Tasks without `dependencies` need nothing.
- [ ] **Step 5: Re-run the dry load with the final tasks file:** `npm run eval:extensions -- --dry-load --tasks docs/evaluation/extension-ablation-2026-10-20/tasks.json --template $EVAL/template --deps $EVAL/deps --out <fresh dir under $EVAL>`. Copy every clone-local path the run reports into the tasks' (untracked) `tasks.json` `scopeIgnore` before approval. Do not edit tracked files yet: Step 6 refuses with `source_dirty` on any tracked change. The Task 9 dry load used two provisional tasks (R63).
- [ ] **Step 6: Create the ledger and see the matrix:** `npm run eval:extensions -- --plan --tasks docs/evaluation/extension-ablation-2026-10-20/tasks.json --ledger $EVAL/ledger.json`. The first `--plan --ledger <new path>` creates the evaluation's one budget ledger (this is the only command that may create it); its random id goes into the approval template. Record the matrix size and the USD projection (initial estimate) in the README draft.
- [ ] **Step 7: Commit** (first record the Step 5 dry-load result in `docs/evaluation/extension-ablation-2026-10-20/setup.md`) `docs: pre-register the extension ablation tasks and oracles`.

### Task 11: Approval, preflight, calibration and wave (operator gate: live spend)

One ledger (`$EVAL/ledger.json`) carries all spend of the evaluation: preflights, every wave and every re-approval. Preflight costs count toward the budget but never raise the per-run estimate. The CLI needs `--ledger`, `--out` (and `--template` for a wave, and `--deps $EVAL/deps` on every `--wave` while a pending task declares dependencies) in every live step, a clean repository (also: no untracked file under a bound path), `prlimit`, `strace` and `bwrap` on the PATH and Yama `ptrace_scope >= 1`.

**Files:**
- Create: `docs/evaluation/extension-ablation-2026-10-20/approval.json` (and further approvals if the run list changes), `docs/evaluation/extension-ablation-2026-10-20/evidence/` (written by `--report`)

- [ ] **Step 1: Write the approval** from `--plan --tasks … --ledger $EVAL/ledger.json` (add `--trim` if the projection exceeds the budget; `--pairings a,b` selects pairings). The template carries the explicit, ordered run list, the ledger id, the routes and the bindings (source commit, tasks digest, matrix digest over the run list). Ask the operator to approve it (`approved: true`, `approvedAt`, budget USD 10). Nothing live runs before this. Wave and preflight run exactly the approved list and never recompute it.
- [ ] **Step 2: Run** `npm run eval:extensions -- --preflight --approval … --tasks … --out $EVAL/wave-1 --ledger $EVAL/ledger.json`. Expected: one PONG per route. A route fails on any terminal other than `completed`, and also when a completed PONG has no session cost (`usage_missing`), which would mean cost accounting does not work for that route. A failing route (for example `xai` with an emptied refresh token, which failed in the v0.10.0 acceptance) is reported. Its pairings are removed from the plan, which means a new approval.
- [ ] **Step 3: Calibrate:** `npm run eval:extensions -- --wave --approval … --tasks … --template $EVAL/template --deps $EVAL/deps --out $EVAL/wave-1 --ledger $EVAL/ledger.json --max-runs 2`. The first two runs of the approved list are the first task pair of `pl-code-deepseek`. The wave pauses cleanly after them (`paused: true`, `status.json`, no `not_run` records).
- [ ] **Step 4: Re-project:** `npm run eval:extensions -- --plan --tasks … --ledger $EVAL/ledger.json --trim --exclude-wave $EVAL/wave-1`. Pass the same `--pairings` as the approved plan, if it used any. Run ids and ordinals are those of the full matrix (all pairings, untrimmed), so a re-plan is a subsequence of the same list and never renumbers. `--exclude-wave` (repeatable, `--plan` only, needs `--ledger`; the wave's `approval.json` must name the ledger's id) leaves out every run that already executed (a record that is not `not_run`, or a run entry in the ledger) before trimming, so the projection from the observed costs covers only what remains. The plan reports the executed runs per wave and `resumable`. If it names `$EVAL/wave-1` (the remaining list is exactly the wave's approved runs without a record, and the wave is paused), continue the same wave under the same approval: `… --wave … --deps $EVAL/deps --out $EVAL/wave-1 --resume` (same ledger; the guarded files are checked against the baseline recorded when the wave started). If `resumable` is null, write a new approval from that plan and start a **fresh** wave in a new `--out` (`$EVAL/wave-2`) with a fresh preflight there; a paused wave cannot be resumed under a different approval. Only the priority order and the 3-task floor decide what gets cut.
- [ ] **Step 5: On any stop or crash** (`status.json` says `stopped`, or `running` because the invocation died), keep every attempt. Do not retry within the approval and do not resume (`wave_stopped`, `resume_invalid`); report the stop reason. Re-plan (with the same `--pairings` as the approved plan, if any) with `--exclude-wave` over every earlier wave directory that holds an `approval.json` (a preflight-only directory is not a wave and is not passed), write a new approval from that plan and use a new `--out`; that is the only way on. The `not_run` slots of the stopped wave stay in the new list, and a run that was charged but left no record is not run again.
- [ ] **Step 6: Write the evidence:** `npm run eval:extensions -- --report --wave $EVAL/wave-1 [--wave $EVAL/wave-2 …] --ledger $EVAL/ledger.json --evidence docs/evaluation/extension-ablation-2026-10-20/evidence`. `--wave` may be given more than once. Their records are merged per run id: an executed record replaces a `not_run` record of the same run id from another wave, several `not_run` records collapse to one, and two executed records for one run id (or one run id with a different task, profile or arm) are refused (`duplicate_run_record`). Each wave directory's `approval.json` is copied, and the evidence is refused (`approval_source_mismatch`) unless the bound code at report time equals the code the wave ran.
- [ ] **Step 7: Commit** `docs: record the extension ablation wave`.

### Task 12: Write up and open the PR

**Files:**
- Create: `docs/evaluation/extension-ablation-2026-10-20/README.md`
- Modify: `docs/evaluation/README.md` (index entry)

- [ ] **Step 1: Write the README.** It covers: method, routes, task list (hashes only), every attempt with its outcome and stop reason, and per pairing the acceptance and catalog cost side by side, the cache-read share per arm, unexpected connections (counts per pairing and arm from `summary.json`) and the recommendation per profile. It states the credential type of each route (`authType` per run: a subscription login or an API key, so quota use is recorded even though it is not priced), that one run per task and arm is indicative, not significant, and that no saving, ranking or success rate beyond the observed one is claimed. It also lists the documented limits: abstract-namespace Unix sockets stay reachable because the network namespace is shared (detected, a stop), the home directory is hidden and the root is read-only, `providerError: "other"` is a scored failure, a preflight is untraced, and the ledger is identified by its id, not its path: a copy at another path would pass the checks, so the operator keeps exactly one ledger file.
- [ ] **Step 2: Run the gate** (`npm run typecheck`, `npx tsc -p tsconfig.eval.json --noEmit`, `npm test`) and `git diff --check`. Verify `integrity.json` hashes with a one-off `sha256sum` loop.
- [ ] **Step 3: Commit, push the branch and open one PR** naming the spec, the amendment and the evidence folder. Changing production profiles stays a separate operator decision.

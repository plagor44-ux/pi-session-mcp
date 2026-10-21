import { randomBytes } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { link, mkdir, readFile, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import { z } from "zod";
import { join } from "node:path";
import { expiresWithin, selectBoundaryCredentials } from "../../src/writer-credentials.js";
import { approvalSchema, parseProductionConfig, routesOf, validateApproval, type Approval, type ProductionConfig } from "./approval.js";
import { auditLog, readVerifiedOutput } from "./audit.js";
import { assertDependencyDir, checkTaskDependencies } from "./dependencies.js";
import { WaveDirGuard, removeTree } from "./evidence.js";
import { classifyRun, fixedCode, mergeTrace, summarizeTrace, type RunRecord, type StopReason } from "./classify.js";
import { guardDiff, guardSnapshot, type GuardSnapshot } from "./guard.js";
import { PersistedLedger, validSessionCost } from "./ledger-file.js";
import { resolveAuditAddresses, type AuditAddresses } from "./network.js";
import { scoreImplementation, scoreReview, type ImplementationScore } from "./oracles.js";
import { RUN_KEY_BYTES, canonicalJson } from "./output-mac.js";
import { containmentSelfTest } from "./containment.js";
import { planSandbox, sandboxed, type SandboxPlan } from "./sandbox.js";
import type { RunOneInput, RunOutput } from "./run-one.js";
import type { RunSpec, TaskSpec } from "./schemas.js";
import { BUILD_ROOT, assertHostSafe, exitedCleanly, groupIsEmpty, killProcessGroup, spawnTracedRunOne, startWithKey, supervise, type Supervised } from "./supervise.js";
import { resolveTools, assertWaveDirOutsideSources, realHome, type ToolPaths } from "./tools.js";
import { STRACE_ARGS, type TraceFindings } from "./trace.js";
import { pairingOf, prepareRunScope, privateRunDir, renderPrompt, scopeRoot, type RunScope, type ScopeInput } from "./workspace.js";

export type { Approval } from "./approval.js";
export type { RunRecord, StopReason, TraceSummary } from "./classify.js";
export type { RunScope } from "./workspace.js";

const RUN_TIMEOUT_MS = 15 * 60_000;
const KILL_GRACE_MS = 30_000;
const WAVE_TIMEOUT_MS = 4 * 60 * 60_000;
const CREDENTIAL_MARGIN_MINUTES = 20;

export interface WaveInput {
  approval: Approval;
  tasks: TaskSpec[];
  waveDir: string;
  /** The one budget ledger of the whole evaluation: preflight, waves and re-approvals share it (R37). */
  ledgerPath: string;
  signal?: AbortSignal | undefined;
  hostAuth: unknown;
  /** The production configuration: `workspaces` (absolute paths by repo alias), `executionProfiles` and `skillCatalog`. */
  productionConfig: unknown;
  extensionTemplate: string;
  /** End the wave cleanly (`paused`, no stop reason, no `not_run` records) after this many executed runs (calibration). */
  maxRuns?: number | undefined;
  /** Continue a paused wave in `waveDir`, which must hold the same approval; a stopped wave cannot be resumed. */
  resume?: boolean | undefined;
  /** Root of the evaluated repository, against which `promptRef` is resolved. */
  repoRoot?: string | undefined;
  /** The operator's dependency directory (R68); required when a pending run's task declares dependencies. */
  depsDir?: string | undefined;
  runTimeoutMs?: number | undefined;
  killGraceMs?: number | undefined;
  turnTimeoutMs?: number | undefined;
  waveTimeoutMs?: number | undefined;
}

export interface WaveDeps {
  spawnRun?: ((scope: RunScope, runInput: string, log: string) => ChildProcess) | undefined;
  prepareScope?: ((input: ScopeInput) => Promise<RunScope>) | undefined;
  guard?: (() => Promise<GuardSnapshot>) | undefined;
  residualCheck?: ((pgid: number) => Promise<boolean>) | undefined;
  scoreImplementation?: typeof scoreImplementation | undefined;
  /** Absolute paths of strace, prlimit, git and codegraph (R44); the default resolves them once from the supervisor's PATH. */
  resolveTools?: (() => Promise<ToolPaths>) | undefined;
  /** Provider and DNS addresses for the connect audit; the default resolves the approved routes' endpoints. */
  resolveAddresses?: ((routes: Approval["routes"]) => Promise<AuditAddresses>) | undefined;
  /** Host safety checks (`prlimit` present, Yama ptrace_scope >= 1); defaults to the real probes. */
  hostCheck?: (() => Promise<void>) | undefined;
  /** The bubblewrap containment self-test (R46); the default runs the real one through the production command shape. */
  containmentCheck?: ((tools: ToolPaths, plan: SandboxPlan) => Promise<void>) | undefined;
  /** The host-dependent part of the sandbox (R48, R49); the default inspects the host once. */
  planSandbox?: ((tools: ToolPaths) => Promise<SandboxPlan>) | undefined;
  /** The read-only dependency checks of the pending tasks (R68), before any run starts; the default reads the workspaces' git. */
  checkDependencies?: typeof checkTaskDependencies | undefined;
  now?: (() => number) | undefined;
}

/** Only fixed codes reach the record; an error message may carry command lines and paths. */
const failureCode = (error: unknown): string => fixedCode(error instanceof Error ? error.message : "") ?? "wave_step_failed";

const baseOf = (run: RunSpec, authType: RunRecord["authType"]): Pick<RunRecord, "runId" | "taskId" | "profile" | "arm" | "pairings" | "authType"> =>
  ({ runId: run.runId, taskId: run.taskId, profile: run.profile, arm: run.arm, pairings: [...run.pairings], authType });

const notRun = (run: RunSpec, stopReason: StopReason | null, authType: RunRecord["authType"]): RunRecord => ({
  ...baseOf(run, authType), outcome: "not_run", terminal: null, accepted: null, usage: null, durationMs: null, trace: null, stopReason,
  harnessError: null, assistantTextTruncated: null, assistantTextSha256: null,
});

const failedRun = (run: RunSpec, harnessError: string, authType: RunRecord["authType"]): RunRecord => ({ ...notRun(run, "harness_failure", authType), outcome: "stopped", harnessError });

/** `waveDir/status.json`: how the last invocation ended, or `running` while it is still going (or crashed). Only a `paused` wave can be resumed. */
export const statusSchema = z.object({ state: z.enum(["running", "paused", "stopped", "complete"]), stopReason: z.string().nullable(), executedRuns: z.number().int().min(0), recordedRuns: z.number().int().min(0) }).strict();
const storedRecordSchema = z.object({ stopReason: z.string().nullable() }).passthrough();
const guardFileSchema = z.object({ files: z.record(z.string(), z.string()) }).strict();

async function readJsonFile(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")) as unknown; } catch (error) {
    void error;
    throw new Error("resume_invalid");
  }
}

export interface WaveResult { records: RunRecord[]; stopReason: StopReason | null; spentUsd: number; paused: boolean }

export async function runWave(input: WaveInput, deps: WaveDeps = {}): Promise<WaveResult> {
  const now = deps.now ?? Date.now;
  const config = parseProductionConfig(input.productionConfig);
  const runs = input.approval.runs;
  validateApproval(input.approval, {
    sourceCommit: input.approval.sourceCommit, tasks: input.tasks, routes: routesOf(config, runs.map((r) => r.profile)),
  });
  await (deps.hostCheck ?? assertHostSafe)();
  const tools = await (deps.resolveTools ?? resolveTools)();
  // Broad on purpose: no configured workspace, and not the evaluation repository itself, may contain the wave directory or sit inside it.
  await assertWaveDirOutsideSources(input.waveDir, [...Object.values(config.workspaces), input.repoRoot ?? process.cwd()]);
  const plan = await (deps.planSandbox ?? ((t: ToolPaths) => planSandbox({ tools: t, repoRoot: input.repoRoot ?? process.cwd(), buildRoot: BUILD_ROOT })))(tools);
  await (deps.containmentCheck ?? containmentSelfTest)(tools, plan);
  const tasks = new Map(input.tasks.map((t) => [t.id, t]));
  for (const run of runs) {
    const task = tasks.get(run.taskId);
    if (!task || config.workspaces[task.repo] === undefined || config.executionProfiles[run.profile] === undefined) throw new Error("run_inputs_missing");
  }

  // Nothing of an earlier attempt may be overwritten or mixed in: refuse before anything starts. A resumed wave keeps the records it
  // already has; for the runs that still have to run, nothing may exist, and an unfinished private directory or scope is refused too.
  const resume = input.resume === true;
  let done = new Set<string>();
  if (resume) {
    const status = statusSchema.safeParse(await readJsonFile(join(input.waveDir, "status.json")));
    if (!status.success) throw new Error("resume_invalid");
    if (status.data.state === "stopped") throw new Error("wave_stopped");
    if (status.data.state === "complete") throw new Error("wave_complete");
    // A crashed invocation leaves `running`: what it did is unknown, so it is continued only through a new plan and approval (R61).
    if (status.data.state !== "paused") throw new Error("resume_invalid");
    const stored = approvalSchema.safeParse(await readJsonFile(join(input.waveDir, "approval.json")));
    if (!stored.success || canonicalJson(stored.data) !== canonicalJson(input.approval)) throw new Error("resume_approval_mismatch");
    const names = (await readdir(join(input.waveDir, "runs"))).filter((name) => name.endsWith(".json"));
    done = new Set(names.map((name) => name.slice(0, -5)));
    // A stale `paused` must not hide a stop: any record with a stop reason means the wave stopped.
    for (const name of names) {
      const record = storedRecordSchema.safeParse(await readJsonFile(join(input.waveDir, "runs", name)));
      if (!record.success) throw new Error("resume_invalid");
      if (record.data.stopReason !== null) throw new Error("wave_stopped");
    }
  } else if (existsSync(join(input.waveDir, "approval.json")) || existsSync(join(input.waveDir, "status.json"))) throw new Error("output_exists");
  const pending = runs.filter((run) => !done.has(run.runId));
  const pendingTasks = pending.map((run) => tasks.get(run.taskId)!);
  const depsSources = [...Object.values(config.workspaces), input.repoRoot ?? process.cwd(), input.waveDir];
  await assertDependencyDir(input.depsDir, pendingTasks, depsSources);
  // A wrong lock or a missing mount of a later task is found before the first run is paid for; each scope checks again.
  await (deps.checkDependencies ?? checkTaskDependencies)({ depsDir: input.depsDir, tasks: pendingTasks, workspaces: config.workspaces, git: tools.git, sources: depsSources });
  for (const run of pending) {
    if ([join(input.waveDir, "runs", `${run.runId}.json`), privateRunDir(input.waveDir, run.runId), scopeRoot(input.waveDir, run.runId)].some((path) => existsSync(path))) {
      throw new Error("output_exists");
    }
  }
  const runTimeoutMs = input.runTimeoutMs ?? RUN_TIMEOUT_MS;
  const killGraceMs = input.killGraceMs ?? KILL_GRACE_MS;
  const turnTimeoutMs = input.turnTimeoutMs ?? Math.max(1_000, runTimeoutMs - 60_000);
  const waveTimeoutMs = input.waveTimeoutMs ?? WAVE_TIMEOUT_MS;
  const repoRoot = input.repoRoot ?? process.cwd();
  const guard = deps.guard ?? (() => guardSnapshot(realHome()));
  const residualCheck = deps.residualCheck ?? groupIsEmpty;
  const prepareScope = deps.prepareScope ?? prepareRunScope;
  const spawnRun = deps.spawnRun ?? ((scope: RunScope, runInput: string, log: string) => spawnTracedRunOne(tools, plan, scope, runInput, log));
  const score = deps.scoreImplementation ?? scoreImplementation;

  // Everything below works on the real path, and the wave directory, `private` and `scopes` are pinned by device and inode.
  await mkdir(input.waveDir, { recursive: true, mode: 0o700 });
  const waveDir = await realpath(input.waveDir);
  const dirGuard = await WaveDirGuard.capture(waveDir);
  await mkdir(join(waveDir, "runs"), { recursive: true, mode: 0o700 });
  // The ledger is the evaluation's one budget: it must exist and be the approval's (R55), and this process holds it exclusively.
  const ledger = await PersistedLedger.openLocked(input.ledgerPath, input.approval.ledgerId);
  try {
  // No run is executed twice: a pending run the ledger already charged (another wave ran it, or a crash left a charge) refuses the invocation (G1).
  if (pending.some((run) => ledger.hasRunEntry(run.runId))) throw new Error("run_already_charged");
  const addresses = await (deps.resolveAddresses ?? resolveAuditAddresses)(input.approval.routes);
  const savedGuard = resume ? guardFileSchema.safeParse(await readJsonFile(join(waveDir, "guard.json"))) : null;
  if (savedGuard !== null && !savedGuard.success) throw new Error("resume_invalid");
  const current = await guard();
  const g0 = savedGuard?.success ? savedGuard.data : current;
  if (!resume) {
    await writeFile(join(waveDir, "guard.json"), `${JSON.stringify(current, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    // The approval this wave ran under; the report copies it and checks the code at report time against it (I6b).
    await writeFile(join(waveDir, "approval.json"), `${JSON.stringify(input.approval, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  const waveStart = now();
  const authTypes = new Map<string, RunRecord["authType"]>();
  for (const profile of new Set(runs.map((r) => r.profile))) {
    const provider = config.executionProfiles[profile]!.provider;
    const type = typeof provider === "string" ? Object.values(selectBoundaryCredentials(input.hostAuth, [provider]))[0] : undefined;
    const kind = typeof type === "object" && type !== null ? (type as { type?: unknown }).type : undefined;
    authTypes.set(profile, kind === "oauth" || kind === "api_key" ? kind : null);
  }
  const authOf = (run: RunSpec): RunRecord["authType"] => authTypes.get(run.profile) ?? null;

  // Atomic and never overwriting: the record is written beside `runs/` and linked in, which fails if the file exists (A1).
  const writeRecord = async (record: RunRecord): Promise<void> => {
    const temporary = join(waveDir, `.record-${randomBytes(8).toString("hex")}.tmp`);
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    try { await link(temporary, join(waveDir, "runs", `${record.runId}.json`)); } finally { await unlink(temporary).catch(() => undefined); }
  };

  async function execute(run: RunSpec, task: TaskSpec, productionConfig: ProductionConfig): Promise<RunRecord> {
    const privateRun = privateRunDir(waveDir, run.runId);
    await mkdir(privateRun, { recursive: true, mode: 0o700 });
    const key = randomBytes(RUN_KEY_BYTES);
    let scope: RunScope | undefined;
    let output: RunOutput | null = null;
    let text: string | null = null;
    let tampered = false;
    let trace: TraceFindings | null = null;
    let waveFailure: string | null = null;
    let executed = false;
    let supervised: Supervised = { timedOut: false, interrupted: false, exitCode: null, signal: null };
    let residualClean = true;
    const oracleHome = join(privateRun, "oracle-home");
    let record: RunRecord | undefined;
    let finalizeError: unknown;
    try {
      try {
        const source = productionConfig.workspaces[task.repo]!;
        scope = await prepareScope({
          waveDir, run, task, sourceRepoPath: source, extensionTemplate: input.extensionTemplate, hostAuth: input.hostAuth,
          productionProfile: productionConfig.executionProfiles[run.profile]!, skillCatalog: productionConfig.skillCatalog, pairing: pairingOf(run), tools,
          ...(input.depsDir === undefined ? {} : { depsDir: input.depsDir }),
        });
        const runOneInput: RunOneInput = {
          runId: run.runId, configPath: scope.configPath, workspaceAlias: "clone", profile: run.profile,
          promptText: await renderPrompt(repoRoot, task, source, scope.clone), turnTimeoutMs, privateDir: scope.privateDir,
        };
        const inputPath = join(scope.root, "run-input.json");
        await writeFile(inputPath, JSON.stringify(runOneInput), { mode: 0o600 });
        const log = join(privateRun, "strace.log");
        if (input.signal?.aborted) supervised = { ...supervised, interrupted: true };
        else {
          const child = spawnRun(scope, inputPath, log);
          executed = true;
          startWithKey(child, key);
          supervised = await supervise(child, runTimeoutMs + killGraceMs, input.signal);
          if (child.pid !== undefined) residualClean = await residualCheck(child.pid);
          killProcessGroup(child.pid);
          const verified = await readVerifiedOutput(scope.root, scope.privateDir, run.runId, key);
          if (supervised.timedOut || supervised.interrupted) {
            // A killed run's output is not believed either way; the stop reason is the timeout or the interrupt.
          } else if (verified.present && !exitedCleanly(supervised)) {
            // N1: the run unit exits 0 after writing its output; a signal or another status means the file may not be its own.
            tampered = true;
          } else {
            ({ output, text, tampered } = verified);
          }
          trace = await auditLog(log, [scope.root], scope.root, addresses);
        }
      } catch (error) { waveFailure = failureCode(error); }
      if (tampered) waveFailure ??= "output_integrity";

      if (executed) {
        // No trusted output (missing, forged, killed, bad exit status) or a session cost the ledger would reject: the estimate stands in (R41).
        // A trusted output with a valid session total is charged as measured. One without (none, or an invalid cost, R62c) that shows tokens
        // in its session or assistant usage is a real billed response whose session stats failed: it charges the assistant cost sum, at
        // least the estimate (I3, M2). One without a session total and without any token anywhere (nothing at all, or a synthesized failure
        // message) billed nothing: the cost is null (R11b).
        const sessionCost = validSessionCost(output?.usage.session);
        const session = output?.usage.session;
        const assistant = output?.usage.assistant;
        const tokens = (usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null | undefined): number =>
          usage == null ? 0 : usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
        if (output !== null && sessionCost !== null) await ledger.record(run.runId, run.profile, sessionCost);
        else if (output !== null && !(tokens(assistant) > 0) && !(tokens(session) > 0)) await ledger.record(run.runId, run.profile, null);
        else await ledger.recordEstimate(run.runId, run.profile, validSessionCost(assistant) ?? 0);
      }
      const facts = { output, timedOut: supervised.timedOut, interrupted: supervised.interrupted, residualClean, trace, guardChanged: false, integrityFailed: tampered, waveFailure };
      let verdict = classifyRun(facts);
      let interruptedInOracle = false;
      const terminal = output?.terminal ?? (supervised.timedOut ? "timeout" : null);

      // Candidate code runs again in the oracle, so its commands are traced and audited like the run itself.
      let implementation: ImplementationScore | undefined;
      if (scope && verdict.stopReason === null && terminal === "completed" && task.oracle.kind === "implementation") {
        await mkdir(oracleHome, { recursive: true, mode: 0o700 });
        const sandboxRoot = scope.root;
        const dependencyBinds = scope.dependencyBinds;
        let sequence = 0;
        const oracleLogs: string[] = [];
        try {
          implementation = await score(scope.clone, {
            allowedPaths: task.allowedPaths, scopeIgnore: task.scopeIgnore, baseCommit: task.baseCommit, oracle: task.oracle,
          }, {
            gitDir: scope.baseGitDir, home: oracleHome, ...(input.signal === undefined ? {} : { signal: input.signal }),
            wrap: (argv) => {
              // Outside the scope root, so the worker's candidate code cannot touch the log.
              const path = join(privateRun, `oracle-${sequence += 1}.strace`);
              oracleLogs.push(path);
              return [tools.strace, ...STRACE_ARGS, "-o", path, "--", ...sandboxed(tools, plan, sandboxRoot, argv, [oracleHome], dependencyBinds)];
            },
          });
        } catch (error) {
          if (error instanceof Error && error.message === "scope_unreadable") implementation = { accepted: false, testsPassed: false, outOfScope: ["<unreadable>"] };
          else waveFailure = "oracle_failed";
        }
        interruptedInOracle = input.signal?.aborted === true;
        for (const path of oracleLogs) {
          const found = await auditLog(path, [scope.root, oracleHome], scope.clone, addresses);
          if (found) trace = trace ? mergeTrace(trace, found) : found;
          else waveFailure ??= "trace_missing";
        }
      }
      let guardChanged = false;
      try { guardChanged = guardDiff(g0, await guard()).length > 0; } catch { waveFailure ??= "guard_unreadable"; }
      verdict = classifyRun({ ...facts, interrupted: facts.interrupted || interruptedInOracle, trace, guardChanged, waveFailure });

      const base = {
        ...baseOf(run, authOf(run)), terminal, usage: output?.usage ?? null, durationMs: output?.durationMs ?? null,
        trace: trace ? summarizeTrace(trace) : null, harnessError: verdict.harnessError,
        assistantTextTruncated: output?.assistantTextTruncated ?? null, assistantTextSha256: output?.assistantTextSha256 ?? null,
      };
      if (verdict.stopReason !== null) {
        record = { ...base, outcome: "stopped", accepted: null, stopReason: verdict.stopReason };
      } else if (terminal !== "completed") {
        record = { ...base, outcome: "scored", accepted: false, stopReason: null };
      } else if (task.oracle.kind === "review") {
        const review = scoreReview(text ?? "", task.oracle);
        record = { ...base, outcome: "scored", accepted: review.accepted && text !== null && text !== "", review, stopReason: null };
      } else {
        const result = implementation ?? { accepted: false, testsPassed: false, outOfScope: [] };
        // The out-of-scope paths are worker-controlled strings; only their number reaches the record.
        record = { ...base, outcome: "scored", accepted: result.accepted, implementation: { accepted: result.accepted, testsPassed: result.testsPassed, outOfScopeCount: result.outOfScope.length }, stopReason: null };
      }
    } finally {
      // R42: nothing derived from the worker is kept. The scope, the private directory (logs, trace, pristine clone, oracle home) and
      // every file in them are removed without following links; the sanitized record written by the caller is the evidence.
      try {
        // Every ancestor must still be the directory pinned at the start; otherwise nothing is removed.
        await dirGuard.assertIntact();
        await removeTree(privateRun);
        if (scope) await removeTree(scope.root);
      } catch (error) { finalizeError ??= error; }
    }
    if (finalizeError !== undefined && record !== undefined) {
      record = { ...record, outcome: "stopped", accepted: null, stopReason: "harness_failure", harnessError: failureCode(finalizeError) };
    }
    return record!;
  }

  const records: RunRecord[] = [];
  let stopReason: StopReason | null = null;
  let paused = false;
  let executedRuns = 0;
  const persist = async (record: RunRecord): Promise<void> => {
    records.push(record);
    try { await writeRecord(record); } catch { stopReason ??= "harness_failure"; }
  };
  // A resumed wave whose guarded files changed while it was paused stops before its first run.
  let startStop: StopReason | null = savedGuard?.success && guardDiff(savedGuard.data, current).length > 0 ? "guard_changed" : null;
  // From here on the invocation is `running`: if it dies before the final write below, the wave cannot be resumed on a stale `paused` (R61).
  const writeStatus = (state: z.infer<typeof statusSchema>["state"], reason: StopReason | null, executed: number, recorded: number): Promise<void> =>
    writeFile(join(waveDir, "status.json"), `${JSON.stringify({ state, stopReason: reason, executedRuns: executed, recordedRuns: recorded }, null, 2)}\n`, { mode: 0o600 });
  await writeStatus("running", null, 0, done.size);
  for (const run of pending) {
    if (stopReason !== null) { await persist(notRun(run, null, authOf(run))); continue; }
    if (input.maxRuns !== undefined && executedRuns >= input.maxRuns) { paused = true; break; }
    const task = tasks.get(run.taskId)!;
    const provider = config.executionProfiles[run.profile]!.provider;
    let before: StopReason | null = startStop;
    startStop = null;
    if (before !== null) { /* decided above */ }
    else if (now() - waveStart >= waveTimeoutMs) before = "wave_timeout";
    else if (input.signal?.aborted) before = "interrupted";
    else if (!ledger.ledger.allows(run.profile)) before = "budget";
    else if (typeof provider === "string" && expiresWithin(input.hostAuth, [provider], CREDENTIAL_MARGIN_MINUTES, now())) before = "credential_expiring";
    if (before !== null) {
      stopReason = before;
      await persist(notRun(run, before, authOf(run)));
      continue;
    }
    if (ledger.hasRunEntry(run.runId)) throw new Error("run_already_charged");
    let record: RunRecord;
    try {
      await dirGuard.assertIntact();
      record = await execute(run, task, config);
    } catch (error) { record = failedRun(run, failureCode(error), authOf(run)); }
    executedRuns += 1;
    stopReason = record.stopReason;
    await persist(record);
  }
  const state = stopReason !== null ? "stopped" : paused ? "paused" : "complete";
  await writeStatus(state, stopReason, executedRuns, done.size + records.length);
  return { records, stopReason, spentUsd: ledger.ledger.spentUsd, paused };
  } finally {
    await ledger.release();
  }
}

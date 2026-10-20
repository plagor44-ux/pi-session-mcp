import { randomBytes } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { expiresWithin } from "../../src/writer-credentials.js";
import { parseProductionConfig, routesOf, validateApproval, type Approval, type ProductionConfig } from "./approval.js";
import { auditLog, readVerifiedOutput } from "./audit.js";
import { classifyRun, fixedCode, mergeTrace, summarizeTrace, type RunRecord, type StopReason } from "./classify.js";
import { guardDiff, guardSnapshot, type GuardSnapshot } from "./guard.js";
import { PersistedLedger, isValidCost } from "./ledger-file.js";
import { PAIRINGS, buildMatrix } from "./matrix.js";
import { resolveAuditAddresses, type AuditAddresses } from "./network.js";
import { scoreImplementation, scoreReview, type ImplementationScore } from "./oracles.js";
import { RUN_KEY_BYTES } from "./output-mac.js";
import type { RunOneInput, RunOutput } from "./run-one.js";
import type { RunSpec, TaskSpec } from "./schemas.js";
import { groupIsEmpty, killProcessGroup, spawnTracedRunOne, startWithKey, supervise, type Supervised } from "./supervise.js";
import { STRACE_ARGS, type TraceFindings } from "./trace.js";
import { pairingOf, prepareRunScope, privateRunDir, renderPrompt, scopeRoot, scrubCredentials, type RunScope, type ScopeInput } from "./workspace.js";

export type { Approval } from "./approval.js";
export type { RunRecord, StopReason, TraceSummary } from "./classify.js";
export type { RunScope } from "./workspace.js";

export const RUN_TIMEOUT_MS = 15 * 60_000;
export const KILL_GRACE_MS = 30_000;
export const WAVE_TIMEOUT_MS = 4 * 60 * 60_000;
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
  /** The runs to execute; defaults to the full matrix. Its digest must match the approval either way. */
  runs?: RunSpec[] | undefined;
  /** Root of the evaluated repository, against which `promptRef` is resolved. */
  repoRoot?: string | undefined;
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
  /** Provider and DNS addresses for the connect audit; the default resolves the approved routes' endpoints. */
  resolveAddresses?: ((routes: Approval["routes"]) => Promise<AuditAddresses>) | undefined;
  now?: (() => number) | undefined;
}

/** Only fixed codes reach the record; an error message may carry command lines and paths. */
const failureCode = (error: unknown): string => fixedCode(error instanceof Error ? error.message : "") ?? "wave_step_failed";

const baseOf = (run: RunSpec): Pick<RunRecord, "runId" | "taskId" | "profile" | "arm" | "pairings"> =>
  ({ runId: run.runId, taskId: run.taskId, profile: run.profile, arm: run.arm, pairings: [...run.pairings] });

const notRun = (run: RunSpec, stopReason: StopReason | null): RunRecord => ({
  ...baseOf(run), outcome: "not_run", terminal: null, accepted: null, usage: null, durationMs: null, trace: null, stopReason,
  harnessError: null, assistantTextTruncated: null,
});

const failedRun = (run: RunSpec, harnessError: string): RunRecord => ({ ...notRun(run, "harness_failure"), outcome: "stopped", harnessError });

export async function runWave(input: WaveInput, deps: WaveDeps = {}): Promise<{ records: RunRecord[]; stopReason: StopReason | null; spentUsd: number }> {
  const now = deps.now ?? Date.now;
  const config = parseProductionConfig(input.productionConfig);
  const runs = input.runs ?? buildMatrix(input.tasks, PAIRINGS);
  validateApproval(input.approval, {
    sourceCommit: input.approval.sourceCommit, tasks: input.tasks, runs, routes: routesOf(config, runs.map((r) => r.profile)),
  });
  const tasks = new Map(input.tasks.map((t) => [t.id, t]));
  for (const run of runs) {
    const task = tasks.get(run.taskId);
    if (!task || config.workspaces[task.repo] === undefined || config.executionProfiles[run.profile] === undefined) throw new Error("run_inputs_missing");
  }

  const { waveDir } = input;
  // Nothing of an earlier attempt may be overwritten or mixed in: refuse before anything starts.
  for (const run of runs) {
    if ([join(waveDir, "runs", `${run.runId}.json`), privateRunDir(waveDir, run.runId), scopeRoot(waveDir, run.runId)].some((path) => existsSync(path))) {
      throw new Error("output_exists");
    }
  }
  const runTimeoutMs = input.runTimeoutMs ?? RUN_TIMEOUT_MS;
  const killGraceMs = input.killGraceMs ?? KILL_GRACE_MS;
  const turnTimeoutMs = input.turnTimeoutMs ?? Math.max(1_000, runTimeoutMs - 60_000);
  const waveTimeoutMs = input.waveTimeoutMs ?? WAVE_TIMEOUT_MS;
  const repoRoot = input.repoRoot ?? process.cwd();
  const guard = deps.guard ?? (() => guardSnapshot(homedir()));
  const residualCheck = deps.residualCheck ?? groupIsEmpty;
  const prepareScope = deps.prepareScope ?? prepareRunScope;
  const spawnRun = deps.spawnRun ?? spawnTracedRunOne;
  const score = deps.scoreImplementation ?? scoreImplementation;

  await mkdir(join(waveDir, "runs"), { recursive: true, mode: 0o700 });
  const ledger = await PersistedLedger.open(input.ledgerPath);
  const addresses = await (deps.resolveAddresses ?? resolveAuditAddresses)(input.approval.routes);
  const g0 = await guard();
  const waveStart = now();

  const writeRecord = (record: RunRecord): Promise<void> =>
    writeFile(join(waveDir, "runs", `${record.runId}.json`), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });

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
    let supervised: Supervised = { timedOut: false, interrupted: false };
    let residualClean = true;
    try {
      const source = productionConfig.workspaces[task.repo]!;
      scope = await prepareScope({
        waveDir, run, task, sourceRepoPath: source, extensionTemplate: input.extensionTemplate, hostAuth: input.hostAuth,
        productionProfile: productionConfig.executionProfiles[run.profile]!, skillCatalog: productionConfig.skillCatalog, pairing: pairingOf(run),
      });
      const runOneInput: RunOneInput = {
        runId: run.runId, configPath: scope.configPath, workspaceAlias: "clone", profile: run.profile,
        promptText: await renderPrompt(repoRoot, task, source, scope.clone), turnTimeoutMs, privateDir: scope.privateDir,
      };
      const inputPath = join(scope.root, "run-input.json");
      await writeFile(inputPath, JSON.stringify(runOneInput), { mode: 0o600 });
      const log = join(privateRun, "strace.log");
      if (input.signal?.aborted) supervised = { timedOut: false, interrupted: true };
      else {
        const child = spawnRun(scope, inputPath, log);
        executed = true;
        startWithKey(child, key);
        supervised = await supervise(child, runTimeoutMs + killGraceMs, input.signal);
        if (child.pid !== undefined) residualClean = await residualCheck(child.pid);
        killProcessGroup(child.pid);
        const verified = await readVerifiedOutput(scope.root, scope.privateDir, run.runId, key);
        ({ output, text, tampered } = verified);
        trace = await auditLog(log, [scope.root], scope.root, addresses);
      }
    } catch (error) { waveFailure = failureCode(error); }
    if (tampered) waveFailure ??= "output_integrity";

    if (executed) {
      // A cost the ledger would reject is recorded as unobserved, once.
      const cost = output?.usage.session?.costUsd ?? null;
      if (!isValidCost(cost)) waveFailure ??= "invalid_cost";
      await ledger.record(run.runId, run.profile, isValidCost(cost) ? cost : null);
    }
    const facts = { output, timedOut: supervised.timedOut, interrupted: supervised.interrupted, residualClean, trace, guardChanged: false, integrityFailed: tampered, waveFailure };
    let verdict = classifyRun(facts);
    const terminal = output?.terminal ?? (supervised.timedOut ? "timeout" : null);

    // Candidate code runs again in the oracle, so its commands are traced and audited like the run itself.
    let implementation: ImplementationScore | undefined;
    const oracleHome = join(privateRun, "oracle-home");
    if (scope && verdict.stopReason === null && terminal === "completed" && task.oracle.kind === "implementation") {
      await mkdir(oracleHome, { recursive: true, mode: 0o700 });
      let sequence = 0;
      const oracleLogs: string[] = [];
      try {
        implementation = await score(scope.clone, {
          allowedPaths: task.allowedPaths, scopeIgnore: task.scopeIgnore, baseCommit: task.baseCommit, oracle: task.oracle,
        }, {
          gitDir: scope.baseGitDir, home: oracleHome,
          wrap: (argv) => {
            // Outside the scope root, so the worker's candidate code cannot touch the log.
            const path = join(privateRun, `oracle-${sequence += 1}.strace`);
            oracleLogs.push(path);
            return ["strace", ...STRACE_ARGS, "-o", path, "--", ...argv];
          },
        });
      } catch (error) {
        if (error instanceof Error && error.message === "scope_unreadable") implementation = { accepted: false, testsPassed: false, outOfScope: ["<unreadable>"] };
        else waveFailure = "oracle_failed";
      }
      for (const path of oracleLogs) {
        const found = await auditLog(path, [scope.root, oracleHome], scope.clone, addresses);
        if (found) trace = trace ? mergeTrace(trace, found) : found;
        else waveFailure ??= "trace_missing";
      }
    }
    let guardChanged = false;
    try { guardChanged = guardDiff(g0, await guard()).length > 0; } catch { waveFailure ??= "guard_unreadable"; }
    verdict = classifyRun({ ...facts, trace, guardChanged, waveFailure });

    const base = {
      ...baseOf(run), terminal, usage: output?.usage ?? null, durationMs: output?.durationMs ?? null,
      trace: trace ? summarizeTrace(trace) : null, harnessError: verdict.harnessError,
      assistantTextTruncated: output?.assistantTextTruncated ?? null,
    };
    let record: RunRecord;
    if (verdict.stopReason !== null) {
      record = { ...base, outcome: "stopped", accepted: null, stopReason: verdict.stopReason };
    } else if (terminal !== "completed") {
      record = { ...base, outcome: "scored", accepted: false, stopReason: null };
    } else if (task.oracle.kind === "review") {
      const review = scoreReview(text ?? "", task.oracle);
      record = { ...base, outcome: "scored", accepted: review.accepted && text !== null && text !== "", review, stopReason: null };
    } else {
      const result = implementation ?? { accepted: false, testsPassed: false, outOfScope: [] };
      record = { ...base, outcome: "scored", accepted: result.accepted, implementation: result, stopReason: null };
    }

    // Persisting and cleaning up: a failure here turns the run into a harness failure, never into a lost loop.
    try {
      if (trace) await writeFile(join(privateRun, "trace.json"), `${JSON.stringify(trace, null, 2)}\n`, { mode: 0o600 });
      if (text !== null) await writeFile(join(privateRun, "assistant.txt"), text, { mode: 0o600 });
      await rm(oracleHome, { recursive: true, force: true });
      if (scope) {
        if (!executed || (record.outcome === "scored" && record.accepted === true)) {
          await rm(scope.root, { recursive: true, force: true });
          await rm(scope.baseGitDir, { recursive: true, force: true });
        } else {
          // A kept scope never carries credentials.
          try { await scrubCredentials(scope.agentDir); } catch (error) { await rm(scope.root, { recursive: true, force: true }); throw error; }
          await rename(scope.root, join(privateRun, "scope"));
        }
      }
    } catch (error) {
      record = { ...record, outcome: "stopped", accepted: null, stopReason: "harness_failure", harnessError: failureCode(error) };
    }
    return record;
  }

  const records: RunRecord[] = [];
  let stopReason: StopReason | null = null;
  const persist = async (record: RunRecord): Promise<void> => {
    records.push(record);
    try { await writeRecord(record); } catch { stopReason ??= "harness_failure"; }
  };
  for (const run of runs) {
    if (stopReason !== null) { await persist(notRun(run, null)); continue; }
    const task = tasks.get(run.taskId)!;
    const provider = config.executionProfiles[run.profile]!.provider;
    let before: StopReason | null = null;
    if (now() - waveStart >= waveTimeoutMs) before = "wave_timeout";
    else if (input.signal?.aborted) before = "interrupted";
    else if (!ledger.ledger.allows(run.profile)) before = "budget";
    else if (typeof provider === "string" && expiresWithin(input.hostAuth, [provider], CREDENTIAL_MARGIN_MINUTES, now())) before = "credential_expiring";
    if (before !== null) {
      stopReason = before;
      await persist(notRun(run, before));
      continue;
    }
    let record: RunRecord;
    try { record = await execute(run, task, config); } catch (error) { record = failedRun(run, failureCode(error)); }
    stopReason = record.stopReason;
    await persist(record);
  }
  return { records, stopReason, spentUsd: ledger.ledger.spentUsd };
}

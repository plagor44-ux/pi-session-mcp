import { execFile, spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expiresWithin } from "../../src/writer-credentials.js";
import { parseProductionConfig, routesOf, validateApproval, type Approval, type ProductionConfig } from "./approval.js";
import { classifyRun, mergeTrace, runOutputSchema, summarizeTrace, type RunRecord, type StopReason } from "./classify.js";
import { guardDiff, guardSnapshot, type GuardSnapshot } from "./guard.js";
import { PersistedLedger } from "./ledger-file.js";
import { PAIRINGS, buildMatrix } from "./matrix.js";
import { scoreImplementation, scoreReview, type ImplementationScore } from "./oracles.js";
import type { RunOneInput, RunOutput } from "./run-one.js";
import type { RunSpec, TaskSpec } from "./schemas.js";
import { STRACE_ARGS, parseStraceLog, type TraceFindings } from "./trace.js";
import { pairingOf, prepareRunScope, privateRunDir, renderPrompt, type RunScope, type ScopeInput } from "./workspace.js";

export type { Approval } from "./approval.js";
export type { RunRecord, StopReason, TraceSummary } from "./classify.js";
export type { RunScope } from "./workspace.js";

const execFileAsync = promisify(execFile);

export const RUN_TIMEOUT_MS = 15 * 60_000;
export const KILL_GRACE_MS = 30_000;
export const WAVE_TIMEOUT_MS = 4 * 60 * 60_000;
const CREDENTIAL_MARGIN_MINUTES = 20;
const EXIT_WAIT_AFTER_KILL_MS = 5_000;

export interface WaveInput {
  approval: Approval;
  tasks: TaskSpec[];
  waveDir: string;
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
  now?: (() => number) | undefined;
}

/** The traced worker: `strace` as the process group leader, the run unit below it, cwd = the scope root. */
export function spawnTracedRunOne(scope: RunScope, runInput: string, log: string): ChildProcess {
  const stderr = openSync(join(scope.root, "run-one.stderr"), "a", 0o600);
  try {
    return spawn("strace", [...STRACE_ARGS, "-o", log, "--", process.execPath, fileURLToPath(new URL("./run-one.js", import.meta.url)), runInput], {
      cwd: scope.root, env: scope.env, detached: true, stdio: ["ignore", "ignore", stderr],
    });
  } finally { closeSync(stderr); }
}

export function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try { process.kill(-pid, "SIGKILL"); } catch { /* already exited or no group */ }
}

/** True once no non-zombie process is left in the group; ps exits 1 when it selects nothing. */
export async function groupIsEmpty(pgid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let stdout: string;
    try { stdout = (await execFileAsync("ps", ["-o", "pid=,stat=", "-g", String(pgid)], { encoding: "utf8" })).stdout; } catch (error) {
      if ((error as { code?: unknown }).code !== 1) return false;
      stdout = "";
    }
    const live = stdout.split("\n").map((line) => /^\s*\d+\s+(\S+)/.exec(line)?.[1]).filter((stat) => stat !== undefined && !stat.startsWith("Z"));
    if (live.length === 0) return true;
    await sleep(100);
  }
  return false;
}

export interface Supervised { timedOut: boolean; interrupted: boolean }

/** Waits for the group leader to exit; kills the whole group at the deadline or on abort. */
export function supervise(child: ChildProcess, timeoutMs: number, signal: AbortSignal | undefined): Promise<Supervised> {
  return new Promise((resolve) => {
    const state = { timedOut: false, interrupted: false };
    let done = false;
    let hard: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer); clearTimeout(hard); signal?.removeEventListener("abort", onAbort);
      resolve(state);
    };
    const stop = (): void => {
      killProcessGroup(child.pid);
      hard ??= setTimeout(finish, EXIT_WAIT_AFTER_KILL_MS);
    };
    const onAbort = (): void => { state.interrupted = true; stop(); };
    const timer = setTimeout(() => { state.timedOut = true; stop(); }, timeoutMs);
    child.once("exit", finish);
    child.once("error", finish);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    if (child.exitCode !== null || child.signalCode !== null) finish();
  });
}

/** Parses a strace log; null when it is missing or has no line, which means nothing can be audited. */
async function auditLog(path: string, roots: string[], initialCwd: string): Promise<TraceFindings | null> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch { return null; }
  const first = /^(?:\[pid\s+(\d+)\]|(\d+))\s/m.exec(text);
  if (!first) return null;
  return parseStraceLog(text, {
    rootPid: Number(first[1] ?? first[2]), initialCwd, allowedWriteRoots: roots, providerAddresses: new Set(), dnsAddresses: new Set(),
  });
}

export async function readOutput(path: string): Promise<RunOutput | null> {
  try {
    const parsed = runOutputSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

/** Only fixed codes reach the record; an error message may carry command lines and paths. */
const failureCode = (error: unknown): string => {
  const message = error instanceof Error ? error.message : "";
  return /^[a-z][a-z0-9_]{0,60}$/.test(message) ? message : "wave_step_failed";
};

const baseOf = (run: RunSpec): Pick<RunRecord, "runId" | "taskId" | "profile" | "arm" | "pairings"> =>
  ({ runId: run.runId, taskId: run.taskId, profile: run.profile, arm: run.arm, pairings: [...run.pairings] });

const notRun = (run: RunSpec, stopReason: StopReason | null): RunRecord => ({
  ...baseOf(run), outcome: "not_run", terminal: null, accepted: null, usage: null, durationMs: null, trace: null, stopReason,
  harnessError: null, assistantTextTruncated: null,
});

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
  const ledger = await PersistedLedger.open(waveDir);
  const g0 = await guard();
  const waveStart = now();

  const writeRecord = (record: RunRecord): Promise<void> =>
    writeFile(join(waveDir, "runs", `${record.runId}.json`), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });

  async function execute(run: RunSpec, task: TaskSpec, productionConfig: ProductionConfig): Promise<RunRecord> {
    const privateRun = privateRunDir(waveDir, run.runId);
    await mkdir(privateRun, { recursive: true, mode: 0o700 });
    let scope: RunScope | undefined;
    let output: RunOutput | null = null;
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
      const child = spawnRun(scope, inputPath, log);
      executed = true;
      supervised = await supervise(child, runTimeoutMs + killGraceMs, input.signal);
      if (child.pid !== undefined) residualClean = await residualCheck(child.pid);
      killProcessGroup(child.pid);
      output = await readOutput(join(scope.root, "run-output.json"));
      trace = await auditLog(log, [scope.root], scope.root);
    } catch (error) { waveFailure = failureCode(error); }

    if (executed) {
      try { await ledger.record(run.runId, run.profile, output?.usage.session?.costUsd ?? null); } catch {
        await ledger.record(run.runId, run.profile, null);
        waveFailure ??= "invalid_cost";
      }
    }
    const facts = { output, timedOut: supervised.timedOut, interrupted: supervised.interrupted, residualClean, trace, guardChanged: false, waveFailure };
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
        const found = await auditLog(path, [scope.root, oracleHome], scope.clone);
        if (found) trace = trace ? mergeTrace(trace, found) : found;
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
      const ref = output?.assistantTextRef;
      const text = ref && scope ? await readFile(join(scope.privateDir, ref), "utf8").catch(() => "") : "";
      const review = scoreReview(text, task.oracle);
      record = { ...base, outcome: "scored", accepted: review.accepted && text !== "", review, stopReason: null };
    } else {
      const result = implementation ?? { accepted: false, testsPassed: false, outOfScope: [] };
      record = { ...base, outcome: "scored", accepted: result.accepted, implementation: result, stopReason: null };
    }

    if (trace) await writeFile(join(privateRun, "trace.json"), `${JSON.stringify(trace, null, 2)}\n`, { mode: 0o600 });
    if (scope && output?.assistantTextRef) await copyFile(join(scope.privateDir, output.assistantTextRef), join(privateRun, "assistant.txt")).catch(() => undefined);
    await rm(oracleHome, { recursive: true, force: true }).catch(() => undefined);
    if (scope) {
      if (record.outcome === "scored" && record.accepted === true) {
        await rm(scope.root, { recursive: true, force: true }).catch(() => undefined);
        await rm(scope.baseGitDir, { recursive: true, force: true }).catch(() => undefined);
      } else await rename(scope.root, join(privateRun, "scope")).catch(() => undefined);
    }
    return record;
  }

  const records: RunRecord[] = [];
  let stopReason: StopReason | null = null;
  for (const run of runs) {
    if (stopReason === null) {
      const task = tasks.get(run.taskId)!;
      const provider = config.executionProfiles[run.profile]!.provider;
      if (now() - waveStart >= waveTimeoutMs) stopReason = "wave_timeout";
      else if (input.signal?.aborted) stopReason = "interrupted";
      else if (!ledger.ledger.allows(run.profile)) stopReason = "budget";
      else if (typeof provider === "string" && expiresWithin(input.hostAuth, [provider], CREDENTIAL_MARGIN_MINUTES, now())) stopReason = "credential_expiring";
      if (stopReason !== null) {
        const record = notRun(run, stopReason);
        records.push(record);
        await writeRecord(record);
        continue;
      }
      const record = await execute(run, task, config);
      records.push(record);
      await writeRecord(record);
      stopReason = record.stopReason;
      continue;
    }
    const record = notRun(run, null);
    records.push(record);
    await writeRecord(record);
  }
  return { records, stopReason, spentUsd: ledger.ledger.spentUsd };
}

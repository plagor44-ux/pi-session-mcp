import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { isEntryPoint } from "../../src/entry-point.js";
import { approvalSchema, matrixDigest, parseProductionConfig, routesOf, tasksDigest, validateApproval, type Approval, type ProductionConfig } from "./approval.js";
import { sourceIsDirty } from "./bound.js";
import { isAuditStop } from "./classify.js";
import { BUDGET_USD, INITIAL_RUN_ESTIMATE_USD } from "./budget.js";
import { fileHostCredentials } from "./credentials.js";
import { dryLoad, type DryLoadDeps } from "./dry-load.js";
import { PersistedLedger } from "./ledger-file.js";
import { PAIRINGS, buildMatrix, trimMatrix } from "./matrix.js";
import { assertPreflightPassed, runPreflight } from "./preflight.js";
import { readApproval, readRuns, writeEvidence } from "./report.js";
import { readRegularFile } from "./safe-read.js";
import { scanTranscripts, writeScan } from "./scan.js";
import { taskSpecSchema, type Pairing, type RunSpec, type TaskSpec } from "./schemas.js";
import { runWave, statusSchema } from "./wave.js";

const execFileAsync = promisify(execFile);

const MODES = ["--plan", "--preflight", "--wave", "--report", "--scan", "--dry-load"] as const;
type Mode = typeof MODES[number];
/** `--report` reads a finished wave, so `--wave` is its value option there and not a mode. */
const REPORT_MODES: readonly string[] = ["--plan", "--preflight", "--report"];
const VALUE_OPTIONS = ["--tasks", "--approval", "--out", "--pairings", "--ledger", "--config", "--auth", "--template", "--preflight-dir", "--wave", "--evidence", "--transcripts", "--max-runs", "--exclude-wave", "--deps"] as const;

export interface ParsedArgs {
  mode: Mode;
  options: Partial<Record<typeof VALUE_OPTIONS[number], string>>;
  trim: boolean;
  /** Every `--wave` of a `--report`, in the order given; their records are merged. */
  waves: string[];
  /** Every `--exclude-wave` of a `--plan`: wave directories whose executed runs the plan leaves out (R59). */
  excludeWaves: string[];
  maxRuns?: number;
  resume: boolean;
  /** `--report` only (R89): record the bound paths that changed since each wave's commit instead of refusing. */
  allowSourceDrift: boolean;
}

export function parseArgs(args: string[]): ParsedArgs {
  const modeNames: readonly string[] = args.includes("--report") ? REPORT_MODES : MODES.filter((m) => m !== "--report");
  const modes = args.filter((a) => modeNames.includes(a));
  if (modes.length !== 1) throw new Error(modes.length === 0 ? "mode_required" : "choose_one_mode");
  const mode = modes[0] as Mode;
  const options: ParsedArgs["options"] = {};
  const waves: string[] = [];
  const excludeWaves: string[] = [];
  let trim = false;
  let resume = false;
  let allowSourceDrift = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (modeNames.includes(arg)) continue;
    if (arg === "--trim") { trim = true; continue; }
    if (arg === "--resume") { resume = true; continue; }
    if (arg === "--allow-source-drift") { allowSourceDrift = true; continue; }
    const next = args[i + 1];
    if (!(VALUE_OPTIONS as readonly string[]).includes(arg) || next === undefined || next.startsWith("--")) throw new Error("invalid_argument");
    if (arg === "--wave" && mode === "--report") { waves.push(next); i += 1; continue; }
    if (arg === "--exclude-wave") {
      if (mode !== "--plan") throw new Error("invalid_argument");
      excludeWaves.push(next); i += 1; continue;
    }
    if (options[arg as typeof VALUE_OPTIONS[number]] !== undefined) throw new Error("invalid_argument");
    options[arg as typeof VALUE_OPTIONS[number]] = next;
    i += 1;
  }
  let maxRuns: number | undefined;
  if (options["--max-runs"] !== undefined) {
    if (!/^[1-9][0-9]{0,3}$/.test(options["--max-runs"])) throw new Error("invalid_argument");
    maxRuns = Number(options["--max-runs"]);
  }
  const result = (): ParsedArgs => ({ mode, options, trim, waves, excludeWaves, resume, allowSourceDrift, ...(maxRuns === undefined ? {} : { maxRuns }) });
  if (mode === "--report") {
    if (waves.length === 0) throw new Error("wave_required");
    if (!options["--ledger"]) throw new Error("ledger_required");
    if (!options["--evidence"]) throw new Error("evidence_required");
    if (Object.keys(options).length !== 2 || trim || resume) throw new Error("invalid_argument");
    return result();
  }
  if (allowSourceDrift) throw new Error("invalid_argument");
  if (options["--evidence"]) throw new Error("invalid_argument");
  if (options["--wave"]) throw new Error("invalid_argument");
  if (mode === "--scan") {
    if (!options["--transcripts"]) throw new Error("transcripts_required");
    if (!options["--out"]) throw new Error("out_required");
    if (Object.keys(options).length !== 2 || trim || resume) throw new Error("invalid_argument");
    return result();
  }
  if (options["--transcripts"]) throw new Error("invalid_argument");
  if (!options["--tasks"]) throw new Error("tasks_required");
  if (mode === "--dry-load") {
    if (!options["--template"]) throw new Error("template_required");
    if (!options["--out"]) throw new Error("out_required");
    if (Object.keys(options).some((key) => !["--tasks", "--template", "--out", "--config", "--deps"].includes(key)) || trim || resume) throw new Error("invalid_argument");
    return result();
  }
  // Dependencies (R68) are mounted by the modes that start a scope; the plan and the preflight start none.
  if (options["--deps"] !== undefined && mode !== "--wave") throw new Error("invalid_argument");
  // The run list is decided at `--plan` time and carried by the approval (R56): trimming and pairing selection belong to the plan only.
  if (mode !== "--plan" && (trim || options["--pairings"] !== undefined)) throw new Error("invalid_argument");
  if (mode !== "--wave" && (resume || maxRuns !== undefined)) throw new Error("invalid_argument");
  if (mode !== "--plan" && !options["--approval"]) throw new Error("approval_required");
  if (mode !== "--plan" && !options["--out"]) throw new Error("out_required");
  if (mode !== "--plan" && !options["--ledger"]) throw new Error("ledger_required");
  if (mode === "--plan" && options["--approval"]) throw new Error("invalid_argument");
  if (excludeWaves.length > 0 && !options["--ledger"]) throw new Error("ledger_required");
  if (new Set(excludeWaves.map((dir) => resolve(dir))).size !== excludeWaves.length) throw new Error("invalid_argument");
  if (mode === "--wave" && !options["--template"]) throw new Error("template_required");
  if (mode !== "--wave" && options["--preflight-dir"]) throw new Error("invalid_argument");
  return result();
}

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8")) as unknown;

async function loadTasks(path: string): Promise<TaskSpec[]> {
  return z.array(taskSpecSchema).min(1).parse(await readJson(path));
}

/**
 * The commit an approval binds to. A tracked change anywhere, an untracked file under a bound path, or no repository refuses
 * (`source_dirty`, `source_unavailable`), because the bound code would not be what runs.
 */
export async function sourceCommit(cwd?: string): Promise<string> {
  const run = async (args: string[]): Promise<string> => {
    try { return (await execFileAsync("git", args, { encoding: "utf8", ...(cwd === undefined ? {} : { cwd }) })).stdout; } catch { throw new Error("source_unavailable"); }
  };
  if (sourceIsDirty(await run(["status", "--porcelain", "-z", "--untracked-files=all"]))) throw new Error("source_dirty");
  return (await run(["rev-parse", "HEAD"])).trim();
}

/** The production configuration with its workspace paths made absolute, as the config loader would resolve them. */
async function loadProductionConfig(path: string | undefined): Promise<ProductionConfig> {
  const file = resolve(path ?? process.env.PI_SESSION_MCP_CONFIG ?? join(homedir(), ".config", "pi-session-mcp", "pi-session-mcp.json"));
  const config = parseProductionConfig(await readJson(file));
  return { ...config, workspaces: Object.fromEntries(Object.entries(config.workspaces).map(([alias, path]) => [alias, resolve(dirname(file), path)])) };
}

function selectedPairings(csv: string | undefined): readonly Pairing[] {
  if (csv === undefined) return PAIRINGS;
  const ids = csv.split(",");
  if (ids.some((id) => !PAIRINGS.some((p) => p.id === id))) throw new Error("unknown_pairing");
  return PAIRINGS.filter((p) => ids.includes(p.id));
}

interface Projection { projectedUsd: (runs: RunSpec[]) => number; remainingUsd: number }

/** Initial estimate per run, or the ledger's own estimates and remaining budget once a ledger is given. */
function projectionOf(persisted: PersistedLedger | undefined): Projection {
  if (persisted === undefined) return { projectedUsd: (runs) => runs.length * INITIAL_RUN_ESTIMATE_USD, remainingUsd: BUDGET_USD };
  const { ledger } = persisted;
  return { projectedUsd: (runs) => runs.reduce((sum, run) => sum + ledger.estimate(run.profile), 0), remainingUsd: BUDGET_USD - ledger.spentUsd };
}

/**
 * An earlier wave a `--plan` leaves out: its approval, the run ids it has a record for, those among them that executed, and those among
 * the executed that were stopped by the trace audit (R85).
 */
interface ExcludedWave { dir: string; approval: Approval; recorded: Set<string>; executed: Set<string>; auditStopped: Set<string> }

/** Reads each wave with the report's safe readers; its approval must name the ledger (`ledger_mismatch`) and the current tasks (`tasks_changed`). */
async function loadExcludedWaves(dirs: string[], ledger: PersistedLedger, tasks: TaskSpec[]): Promise<ExcludedWave[]> {
  const waves: ExcludedWave[] = [];
  for (const arg of dirs) {
    const dir = resolve(arg);
    const { approval } = await readApproval(dir);
    if (approval.ledgerId !== ledger.id) throw new Error("ledger_mismatch");
    // Run ids name tasks by id; waves planned over other task content do not describe these runs.
    if (approval.tasksDigest !== tasksDigest(tasks)) throw new Error("tasks_changed");
    const records = (await readRuns(dir)).map((run) => run.record);
    waves.push({
      dir, approval, recorded: new Set(records.map((r) => r.runId)), executed: new Set(records.filter((r) => r.outcome !== "not_run").map((r) => r.runId)),
      auditStopped: new Set(records.filter((r) => r.outcome === "stopped" && isAuditStop(r.stopReason)).map((r) => r.runId)),
    });
  }
  return waves;
}

async function waveIsPaused(dir: string): Promise<boolean> {
  try { return statusSchema.parse(JSON.parse((await readRegularFile(join(dir, "status.json"), 64 * 1024)).toString("utf8"))).state === "paused"; } catch { return false; }
}

/**
 * The run list `--plan` puts into the approval: a subsequence of the canonical matrix (R58), the full matrix of the selected pairings or its
 * budget-trimmed version with `--trim`. Slots that already ran (a record that is not `not_run` in an excluded wave, or a run charge in the
 * ledger) are left out before trimming, so the projection covers what remains (R59). The exception (R85): a slot whose every executed record
 * in the excluded waves was stopped by the trace audit is planned again; its earlier charge stays in the ledger and in the remaining budget,
 * and the approval names the slot with its number of charges in `replannedStopped` so the wave may run it despite them, once. The ledger must
 * agree with the records: a slot is planned again only when it holds exactly one run charge per excluded wave that stopped it by the audit; any
 * other count (a wave left out of `--exclude-wave` that already ran it, a charge without a record) keeps it excluded (`notReplanned`).
 */
async function plannedRuns(tasks: TaskSpec[], parsed: ParsedArgs, ledger: PersistedLedger | undefined, excluded: ExcludedWave[]) {
  const pairings = selectedPairings(parsed.options["--pairings"]);
  const projection = projectionOf(ledger);
  const replanned = new Map<string, number>();
  const notReplanned: { runId: string; reason: string }[] = [];
  const skip = new Set(excluded.length === 0 ? [] : buildMatrix(tasks, pairings).map((r) => r.runId).filter((id) => {
    const ran = excluded.filter((wave) => wave.executed.has(id));
    if (ran.length > 0 && ran.every((wave) => wave.auditStopped.has(id))) {
      const charges = ledger!.runEntryCount(id);
      if (charges === ran.length) { replanned.set(id, charges); return false; }
      notReplanned.push({ runId: id, reason: "ledger_charges_differ_from_records" });
      return true;
    }
    return ran.length > 0 || ledger!.hasRunEntry(id);
  }));
  const full = buildMatrix(tasks, pairings, skip);
  const trimmed = trimMatrix(tasks, pairings, projection.projectedUsd, projection.remainingUsd, skip);
  return { full, trimmed, runs: parsed.trim ? trimmed.runs : full, projection, skip, replanned, notReplanned };
}

const write = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); };

/** The plan: the matrix, its trimmed projection and the approval template (with the run list and the ledger id). No model is used. */
export async function buildPlan(parsed: ParsedArgs, options: { sourceCwd?: string } = {}): Promise<Record<string, unknown>> {
  const tasks = await loadTasks(parsed.options["--tasks"]!);
  // Only `--plan --ledger <path>` may create the ledger; its id goes into the approval and ties all later steps to it (R55).
  let ledger: PersistedLedger | undefined;
  if (parsed.options["--ledger"] !== undefined) {
    const path = resolve(parsed.options["--ledger"]);
    // With --exclude-wave the ledger must already be the evaluation's: a wrong path must not create a second one (M6).
    if (parsed.excludeWaves.length > 0) ledger = await PersistedLedger.openExisting(path);
    else {
      ledger = await PersistedLedger.open(path);
      if (!existsSync(path)) await ledger.save();
    }
  }
  const excluded = ledger === undefined ? [] : await loadExcludedWaves(parsed.excludeWaves, ledger, tasks);
  const { trimmed, runs, projection, skip, replanned, notReplanned } = await plannedRuns(tasks, parsed, ledger, excluded);
  const replannedStopped = runs.filter((run) => replanned.has(run.runId)).map((run) => ({ runId: run.runId, charges: replanned.get(run.runId)! }));
  const { projectedUsd, remainingUsd } = projection;
  let routes: unknown = [];
  let routesNote: string | undefined;
  try { routes = routesOf(await loadProductionConfig(parsed.options["--config"]), runs.map((r) => r.profile)); } catch { routesNote = "production_config_unavailable"; }
  let exclusion: Record<string, unknown> | undefined;
  if (excluded.length > 0) {
    // Only the directory's name is printed, never a path (M4). The last wave given is the resume candidate: only when the list left is exactly its runs without a record, and it is paused.
    const last = excluded[excluded.length - 1]!;
    const unrecorded = last.approval.runs.filter((run) => !last.recorded.has(run.runId));
    const resumable = unrecorded.length > 0 && matrixDigest(unrecorded) === matrixDigest(runs) && await waveIsPaused(last.dir) ? basename(last.dir) : null;
    exclusion = {
      waves: excluded.map((wave) => ({ wave: basename(wave.dir), executed: wave.executed.size })),
      ledgerOnly: [...skip].filter((id) => !excluded.some((wave) => wave.executed.has(id))).length, removed: skip.size, resumable, replannedStopped: replannedStopped.map(({ runId }) => runId), notReplanned,
    };
  }
  return {
    approved: false,
    tasks: tasks.length,
    ...(exclusion === undefined ? {} : { exclusion }),
    matrix: { count: runs.length, projectedUsd: projectedUsd(runs), runs: runs.map(({ runId, ordinal, taskId, profile, arm, pairings: ids }) => ({ runId, ordinal, taskId, profile, arm, pairings: ids })) },
    trimmed: {
      remainingUsd, pairings: trimmed.pairings.map((p) => p.id), tasksPerPairing: trimmed.tasksPerPairing,
      count: trimmed.runs.length, projectedUsd: projectedUsd(trimmed.runs), matrixDigest: matrixDigest(trimmed.runs),
    },
    approvalTemplate: {
      approved: false, approvedAt: null, budgetUsd: BUDGET_USD, sourceCommit: await sourceCommit(options.sourceCwd),
      tasksDigest: tasksDigest(tasks), matrixDigest: matrixDigest(runs), ledgerId: ledger?.id ?? null, runs, routes, ...(routesNote === undefined ? {} : { routesNote }),
      ...(replannedStopped.length === 0 ? {} : { replannedStopped }),
    },
  };
}

async function plan(parsed: ParsedArgs): Promise<void> { write(await buildPlan(parsed)); }

/** Everything a live mode needs: the approval is validated against what would run now, and its own run list is the list that runs (R56). */
async function liveInputs(parsed: ParsedArgs) {
  const tasks = await loadTasks(parsed.options["--tasks"]!);
  const productionConfig = await loadProductionConfig(parsed.options["--config"]);
  const raw = await readJson(parsed.options["--approval"]!);
  const shape = approvalSchema.safeParse(raw);
  if (!shape.success) throw new Error("approval_invalid");
  const approval = validateApproval(raw, {
    sourceCommit: await sourceCommit(), tasks, routes: routesOf(productionConfig, shape.data.runs.map((r) => r.profile)),
  });
  const authPath = resolve(parsed.options["--auth"] ?? join(homedir(), ".pi", "agent", "auth.json"));
  const hostAuth = await readJson(authPath);
  // OAuth credentials are refreshed in this file through the Pi SDK before each route and run (R86).
  const hostCredentials = fileHostCredentials(authPath);
  const waveDir = resolve(parsed.options["--out"]!);
  await mkdir(waveDir, { recursive: true, mode: 0o700 });
  return { tasks, runs: approval.runs, productionConfig, approval, hostAuth, hostCredentials, waveDir, ledgerPath: resolve(parsed.options["--ledger"]!) };
}

/**
 * Runs `body` with an abort signal tied to SIGINT and SIGTERM. The listeners stay for the whole body and `stop` is idempotent, so a second
 * Ctrl-C (or the wrapper's forward) cannot fall back to the default action and kill the CLI while a detached worker is still running.
 */
export async function withAbort<T>(body: (signal: AbortSignal) => Promise<T>, emitter: Pick<NodeJS.EventEmitter, "on" | "off"> = process): Promise<T> {
  const controller = new AbortController();
  const stop = (): void => { if (!controller.signal.aborted) controller.abort(); };
  emitter.on("SIGINT", stop);
  emitter.on("SIGTERM", stop);
  try { return await body(controller.signal); } finally { emitter.off("SIGINT", stop); emitter.off("SIGTERM", stop); }
}

async function preflight(parsed: ParsedArgs): Promise<void> {
  const { approval, hostAuth, hostCredentials, productionConfig, waveDir, ledgerPath } = await liveInputs(parsed);
  const result = await withAbort((signal) => runPreflight({ approval, waveDir, ledgerPath, hostAuth, hostCredentials, productionConfig, signal }));
  write(result);
  if (result.routes.some((r) => !r.ok)) process.exitCode = 1;
}

async function wave(parsed: ParsedArgs): Promise<void> {
  const { tasks, approval, hostAuth, hostCredentials, productionConfig, waveDir, ledgerPath } = await liveInputs(parsed);
  await assertPreflightPassed(resolve(parsed.options["--preflight-dir"] ?? parsed.options["--out"]!), approval, ledgerPath);
  const result = await withAbort((signal) => runWave({
    approval, tasks, waveDir, ledgerPath, hostAuth, hostCredentials, productionConfig, extensionTemplate: resolve(parsed.options["--template"]!), signal,
    ...(parsed.options["--deps"] === undefined ? {} : { depsDir: resolve(parsed.options["--deps"]) }),
    ...(parsed.maxRuns === undefined ? {} : { maxRuns: parsed.maxRuns }), resume: parsed.resume,
  }));
  write({
    stopReason: result.stopReason, paused: result.paused, spentUsd: result.spentUsd, runs: result.records.length,
    // Review acceptance is descriptive only (R83): only implementation runs are counted as accepted here.
    scored: result.records.filter((r) => r.outcome === "scored").length, implementationAccepted: result.records.filter((r) => r.implementation?.accepted === true).length,
  });
  if (result.stopReason !== null) process.exitCode = 1;
}

async function report(parsed: ParsedArgs): Promise<void> {
  const summary = await writeEvidence(parsed.waves.map((wave) => resolve(wave)), resolve(parsed.options["--evidence"]!), resolve(parsed.options["--ledger"]!), { allowSourceDrift: parsed.allowSourceDrift });
  process.stdout.write(`${JSON.stringify({
    spentUsd: summary.spentUsd, budgetSpend: summary.budgetSpend, waveSpend: summary.waveSpend, stopReason: summary.stopReason,
    pairings: summary.pairings.map((p) => ({ id: p.id, pairedTasks: p.tasks.length, complete: p.complete, recommendation: p.recommendation })),
  })}\n`);
}

/** Candidates are private: they go to the ignored `eval/results/` only, and the console gets counts. */
export async function scanCommand(parsed: ParsedArgs, resultsRoot = resolve("eval", "results")): Promise<void> {
  const result = await scanTranscripts(resolve(parsed.options["--transcripts"]!));
  await writeScan(result, parsed.options["--out"]!, resultsRoot);
  write({ candidates: result.candidates.length, skippedLines: result.skippedLines });
}

/**
 * Provider-free load of every arm-B extension from the template (R5). The report is private (paths in `cloneWrites`): it goes into the
 * fresh `--out` directory, and the console gets counts and codes only. Like `--plan`, it refuses a dirty tracked tree.
 */
export async function dryLoadCommand(parsed: ParsedArgs, options: { sourceCwd?: string; deps?: DryLoadDeps } = {}): Promise<void> {
  const tasks = await loadTasks(parsed.options["--tasks"]!);
  await sourceCommit(options.sourceCwd);
  const productionConfig = await loadProductionConfig(parsed.options["--config"]);
  const waveDir = resolve(parsed.options["--out"]!);
  if (existsSync(waveDir)) throw new Error("output_exists");
  const depsDir = parsed.options["--deps"] === undefined ? undefined : resolve(parsed.options["--deps"]);
  const report = await withAbort((signal) => dryLoad({ templateDir: resolve(parsed.options["--template"]!), tasks, productionConfig, waveDir, depsDir }, { ...options.deps, signal }));
  await writeFile(join(waveDir, "dry-load.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  write({
    ok: report.pairs.every((p) => p.ok),
    pairs: report.pairs.map((p) => ({ pairing: p.pairing, ok: p.ok, failure: p.failure, activeTools: p.activeTools.length, grantedOk: p.grantedOk, cloneWrites: p.cloneWrites.length, trace: p.trace, unexpectedConnects: p.unexpectedConnects.length })),
  });
  if (!report.pairs.every((p) => p.ok)) process.exitCode = 1;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.mode === "--dry-load") await dryLoadCommand(parsed);
  else if (parsed.mode === "--scan") await scanCommand(parsed);
  else if (parsed.mode === "--plan") await plan(parsed);
  else if (parsed.mode === "--preflight") await preflight(parsed);
  else if (parsed.mode === "--report") await report(parsed);
  else await wave(parsed);
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  await main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    process.stderr.write(`${JSON.stringify({ event: "extension_ablation_stopped", code: /^[a-z][a-z0-9_]{0,60}$/.test(message) ? message : "invalid_input_or_failed_gate" })}\n`);
    process.exitCode = 1;
  });
}

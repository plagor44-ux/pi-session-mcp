import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { isEntryPoint } from "../../src/entry-point.js";
import { matrixDigest, parseProductionConfig, routesOf, tasksDigest, validateApproval, type ProductionConfig } from "./approval.js";
import { BUDGET_USD, INITIAL_RUN_ESTIMATE_USD } from "./budget.js";
import { PersistedLedger } from "./ledger-file.js";
import { PAIRINGS, buildMatrix, trimMatrix } from "./matrix.js";
import { runPreflight } from "./preflight.js";
import { taskSpecSchema, type Pairing, type RunSpec, type TaskSpec } from "./schemas.js";
import { runWave } from "./wave.js";

const execFileAsync = promisify(execFile);

const MODES = ["--plan", "--preflight", "--wave"] as const;
type Mode = typeof MODES[number];
const VALUE_OPTIONS = ["--tasks", "--approval", "--out", "--pairings", "--ledger", "--config", "--auth", "--template"] as const;
const FLAG_OPTIONS = ["--trim"] as const;

export interface ParsedArgs { mode: Mode; options: Partial<Record<typeof VALUE_OPTIONS[number], string>>; trim: boolean }

export function parseArgs(args: string[]): ParsedArgs {
  const modes = args.filter((a) => (MODES as readonly string[]).includes(a));
  if (modes.length !== 1) throw new Error(modes.length === 0 ? "mode_required" : "choose_one_mode");
  const options: ParsedArgs["options"] = {};
  let trim = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if ((MODES as readonly string[]).includes(arg)) continue;
    if ((FLAG_OPTIONS as readonly string[]).includes(arg)) { trim = true; continue; }
    const next = args[i + 1];
    if (!(VALUE_OPTIONS as readonly string[]).includes(arg) || next === undefined || next.startsWith("--") || options[arg as typeof VALUE_OPTIONS[number]] !== undefined) {
      throw new Error("invalid_argument");
    }
    options[arg as typeof VALUE_OPTIONS[number]] = next;
    i += 1;
  }
  const mode = modes[0] as Mode;
  if (!options["--tasks"]) throw new Error("tasks_required");
  if (mode !== "--plan" && !options["--approval"]) throw new Error("approval_required");
  if (mode === "--wave" && !options["--template"]) throw new Error("template_required");
  return { mode, options, trim };
}

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8")) as unknown;

async function loadTasks(path: string): Promise<TaskSpec[]> {
  return z.array(taskSpecSchema).min(1).parse(await readJson(path));
}

async function sourceCommit(): Promise<string> {
  try { return (await execFileAsync("git", ["rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim(); } catch { return "unknown"; }
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

/** Initial estimate per run, or the ledger's own estimates and remaining budget once a ledger file exists. */
async function projection(ledgerDir: string | undefined): Promise<Projection> {
  if (ledgerDir === undefined) return { projectedUsd: (runs) => runs.length * INITIAL_RUN_ESTIMATE_USD, remainingUsd: BUDGET_USD };
  const { ledger } = await PersistedLedger.open(ledgerDir);
  return { projectedUsd: (runs) => runs.reduce((sum, run) => sum + ledger.estimate(run.profile), 0), remainingUsd: BUDGET_USD - ledger.spentUsd };
}

async function selection(tasks: TaskSpec[], parsed: ParsedArgs): Promise<RunSpec[]> {
  const pairings = selectedPairings(parsed.options["--pairings"]);
  if (!parsed.trim) return buildMatrix(tasks, pairings);
  const { projectedUsd, remainingUsd } = await projection(parsed.options["--ledger"]);
  return trimMatrix(tasks, pairings, projectedUsd, remainingUsd).runs;
}

const write = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); };

async function plan(parsed: ParsedArgs): Promise<void> {
  const tasks = await loadTasks(parsed.options["--tasks"]!);
  const pairings = selectedPairings(parsed.options["--pairings"]);
  const { projectedUsd, remainingUsd } = await projection(parsed.options["--ledger"]);
  const full = buildMatrix(tasks, pairings);
  const trimmed = trimMatrix(tasks, pairings, projectedUsd, remainingUsd);
  const runs = parsed.trim ? trimmed.runs : full;
  let routes: unknown = [];
  let routesNote: string | undefined;
  try { routes = routesOf(await loadProductionConfig(parsed.options["--config"]), runs.map((r) => r.profile)); } catch { routesNote = "production_config_unavailable"; }
  write({
    approved: false,
    tasks: tasks.length,
    matrix: { count: runs.length, projectedUsd: projectedUsd(runs), runs: runs.map(({ runId, taskId, profile, arm, pairings: ids }) => ({ runId, taskId, profile, arm, pairings: ids })) },
    trimmed: {
      remainingUsd, pairings: trimmed.pairings.map((p) => p.id), tasksPerPairing: trimmed.tasksPerPairing,
      count: trimmed.runs.length, projectedUsd: projectedUsd(trimmed.runs), matrixDigest: matrixDigest(trimmed.runs),
    },
    approvalTemplate: {
      approved: false, approvedAt: null, budgetUsd: BUDGET_USD, sourceCommit: await sourceCommit(),
      tasksDigest: tasksDigest(tasks), matrixDigest: matrixDigest(runs), routes, ...(routesNote === undefined ? {} : { routesNote }),
    },
  });
}

/** Everything a live mode needs, with the approval validated against what would run now. */
async function liveInputs(parsed: ParsedArgs) {
  const tasks = await loadTasks(parsed.options["--tasks"]!);
  const runs = await selection(tasks, parsed);
  const productionConfig = await loadProductionConfig(parsed.options["--config"]);
  const approval = validateApproval(await readJson(parsed.options["--approval"]!), {
    sourceCommit: await sourceCommit(), tasks, runs, routes: routesOf(productionConfig, runs.map((r) => r.profile)),
  });
  const hostAuth = await readJson(parsed.options["--auth"] ?? join(homedir(), ".pi", "agent", "auth.json"));
  const waveDir = resolve(parsed.options["--out"] ?? join("eval", "results", "extension-ablation", `wave-${new Date().toISOString().replace(/[:.]/g, "-")}`));
  await mkdir(waveDir, { recursive: true, mode: 0o700 });
  return { tasks, runs, productionConfig, approval, hostAuth, waveDir };
}

async function withAbort<T>(body: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try { return await body(controller.signal); } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}

async function preflight(parsed: ParsedArgs): Promise<void> {
  const { approval, hostAuth, productionConfig, waveDir } = await liveInputs(parsed);
  const result = await withAbort((signal) => runPreflight({ approval, waveDir, hostAuth, productionConfig, signal }));
  write(result);
  if (result.routes.some((r) => !r.ok)) process.exitCode = 1;
}

async function wave(parsed: ParsedArgs): Promise<void> {
  const { tasks, runs, approval, hostAuth, productionConfig, waveDir } = await liveInputs(parsed);
  const result = await withAbort((signal) => runWave({
    approval, tasks, runs, waveDir, hostAuth, productionConfig, extensionTemplate: resolve(parsed.options["--template"]!), signal,
  }));
  write({
    stopReason: result.stopReason, spentUsd: result.spentUsd, runs: result.records.length,
    scored: result.records.filter((r) => r.outcome === "scored").length, accepted: result.records.filter((r) => r.accepted === true).length,
  });
  if (result.stopReason !== null) process.exitCode = 1;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.mode === "--plan") await plan(parsed);
  else if (parsed.mode === "--preflight") await preflight(parsed);
  else await wave(parsed);
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  await main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    process.stderr.write(`${JSON.stringify({ event: "extension_ablation_stopped", code: /^[a-z][a-z0-9_]{0,60}$/.test(message) ? message : "invalid_input_or_failed_gate" })}\n`);
    process.exitCode = 1;
  });
}

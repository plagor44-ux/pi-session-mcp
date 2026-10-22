import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { digest, hash } from "../profiles/files.js";
import { approvalSchema, type Approval } from "./approval.js";
import { BOUND_PATH, BOUND_PATHSPECS, dirtyBoundPaths } from "./bound.js";
import { isAuditStop, type RunRecord, type StopReason } from "./classify.js";
import { ledgerFileSchema } from "./ledger-file.js";
import { MAX_REPLICATES, PAIRINGS, replicateOf, taskKind } from "./matrix.js";
import { armSchema, profileIdSchema, type Pairing } from "./schemas.js";
import { readRegularFile } from "./safe-read.js";
import { realHome } from "./tools.js";

export type Recommendation = "enable" | "do-not-enable" | "inconclusive";

const MIN_PAIRED_TASKS = 3;
const MAX_COST_RATIO = 1.25;
const MAX_STRING_CHARS = 2_000;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_LEDGER_BYTES = 4 * 1024 * 1024;
const FORBIDDEN_KEYS = new Set(["access", "refresh", "key"]);
/** A path-like segment anywhere in a string: a slash that starts the string or follows whitespace, a quote or a separator. */
const PATH_LIKE = /(^|[\s"'=:(,])\/[A-Za-z0-9._-]/;
const exec = promisify(execFile);

/**
 * The pre-registered rule for an implementation pairing: `do-not-enable` when B accepts fewer tasks than A; `enable` when B accepts at least as
 * many as A, is strictly better on at least one task (accepted where A was not) and costs at most 1.25 times A; `inconclusive` otherwise.
 */
export function recommend(
  a: { accepted: number; costUsd: number }, b: { accepted: number; costUsd: number }, perTask: { a: boolean; b: boolean }[],
): Recommendation {
  if (b.accepted < a.accepted) return "do-not-enable";
  if (perTask.some((task) => task.b && !task.a) && b.costUsd <= MAX_COST_RATIO * a.costUsd) return "enable";
  return "inconclusive";
}

/** The fields of a run record the report reads; a full `RunRecord` satisfies it. */
export type SummaryRecord = Pick<RunRecord, "runId" | "taskId" | "profile" | "arm" | "pairings" | "outcome" | "accepted" | "stopReason"> & {
  usage: { session: { input: number; cacheRead: number; costUsd: number } | null } | null;
  /** The record's replicate (R90); absent for a plan without replicates, read as 1. */
  replicate?: number | undefined;
  /** The number of destinations outside the provider and DNS allowlists; the record itself keeps only the first few. */
  trace?: { unexpectedConnectCount?: number | undefined } | null | undefined;
  /** What the report reads of a review score (R78): the false findings it hit and whether the verdict matched. */
  review?: { falseFindings: string[]; verdictMatched?: boolean | undefined; criticalHit?: number | undefined; criticalTotal?: number | undefined; recall?: number | undefined; accepted?: boolean | undefined } | undefined;
};

const STOP_REASONS = [
  "outside_write", "unresolved_write", "unresolved_egress", "output_integrity", "guard_changed", "harness_failure", "cleanup_failure",
  "provider_error", "credential_expiring", "budget", "wave_timeout", "interrupted",
] as const;
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
/** Compile-time check: the list above is exactly `StopReason`, so a new stop reason cannot be silently rejected when records are read. */
export type StopReasonListMatches = Assert<Equal<typeof STOP_REASONS[number], StopReason>>;

/** The replicate a run id names (R90): its `-r<k>` suffix, or none. */
const RUN_ID_REPLICATE = /-r([1-9])$/;
const summaryRecordSchema = z.object({
  runId: z.string().min(1), taskId: z.string().min(1), profile: profileIdSchema, arm: armSchema, replicate: z.number().int().min(1).max(MAX_REPLICATES).optional(), pairings: z.array(z.string()),
  outcome: z.enum(["scored", "stopped", "not_run"]), accepted: z.boolean().nullable(),
  usage: z.object({ session: z.object({ input: z.number(), cacheRead: z.number(), costUsd: z.number() }).nullable() }).nullable(),
  stopReason: z.enum(STOP_REASONS).nullable(),
  trace: z.object({ unexpectedConnectCount: z.number().int().min(0).optional() }).nullable().optional(),
  review: z.object({
    falseFindings: z.array(z.string()), verdictMatched: z.boolean().optional(), criticalHit: z.number().optional(), criticalTotal: z.number().optional(),
    recall: z.number().optional(), accepted: z.boolean().optional(),
  }).optional(),
}).refine((record) => {
  const suffix = RUN_ID_REPLICATE.exec(record.runId)?.[1];
  return (suffix === undefined ? undefined : Number(suffix)) === record.replicate;
});
const parseSummaryRecord = (value: unknown): SummaryRecord => summaryRecordSchema.parse(value);

export interface ArmTotals {
  accepted: number; costUsd: number; scored: number; unexpectedConnects: number;
  /** Scored runs with a review score that hit any false finding (R78); report-only, not part of the acceptance. */
  falseFindingRuns: number;
  /** Scored runs with a review score whose text did not match the task's verdict pattern (R78). */
  verdictMissed: number;
}
/**
 * What a review pairing reports per arm (R83): cost, network and the oracle's numbers as description. There is no acceptance count among the
 * totals; `oracleAccepted` is what the keyword oracle computed, not an outcome that decides anything.
 */
export interface ReviewArmTotals {
  costUsd: number; scored: number; unexpectedConnects: number;
  /** Scored runs with a review score (a run that did not complete has none). */
  reviewScored: number;
  /** Sum over those runs of the critical findings hit and of the critical findings the oracle has. */
  criticalHitSum: number; criticalTotalSum: number;
  /** Mean over those runs of criticalHit / criticalTotal (a run counts 0 when the oracle has no critical finding). */
  criticalHitMean: number;
  /** Runs whose text matched the task's verdict pattern. */
  verdictMatched: number;
  /** Mean recall over those runs. */
  recallMean: number;
  /** Runs that hit any false finding. */
  falseFindingRuns: number;
  /** Runs the keyword oracle accepted (verdict matched and every critical finding hit); descriptive only. */
  oracleAccepted: number;
}
/** One arm of one task in a replicated plan (R92): the runs scored, those accepted, and whether more than half of the N runs were accepted. */
export interface ReplicatedArm { scored: number; accepted: number; solved: boolean }
/**
 * What a replicated plan (R90, R92) adds to a pairing that has runs in the evidence. An implementation pairing reports every task of the pairing
 * with both arms' counts (also for unpaired runs) and whether it counted (both arms have all N runs scored); the totals and the recommendation
 * are taken over the counted tasks. A review pairing, descriptive only, lists the (task, replicate) units scored in both arms.
 */
export interface ReplicatedResult {
  /** The replicates the plan asked for (N): `accepted` is read as `k of N`. */
  replicates: number;
  /** Implementation pairings: every task of the pairing, in task-id order. */
  perTask?: { taskId: string; a: ReplicatedArm; b: ReplicatedArm; counted: boolean }[];
  /** Implementation pairings: the tasks that do not count because an arm lacks scored runs; the pairing is then incomplete. */
  incompleteTasks?: string[];
  /** Implementation pairings: per arm, the counted tasks it solved. */
  solvedTasks?: { a: number; b: number };
  /** Review pairings: the (task, replicate) units scored in both arms, in task-id then replicate order. */
  units?: { taskId: string; replicate: number }[];
}
interface PairingBase {
  id: string;
  /** The tasks scored in both arms, in task-id order; with replicates, the tasks that counted (R92). */
  tasks: string[];
  /** At least three tasks were scored in both arms; with replicates, every task of the pairing counted and at least three did (R92). */
  complete: boolean;
  cacheReadShare: { a: number; b: number };
  /** Only for a plan with replicates (R90); a plan without them has exactly the fields it always had. */
  replicated?: ReplicatedResult;
}
export interface ImplementationPairingResult extends PairingBase { kind: "implementation"; a: ArmTotals; b: ArmTotals; recommendation: Recommendation | "not-run" }
/** Review pairings are descriptive (R83): a review run is scored and reported, but its acceptance never yields a recommendation. */
export interface ReviewPairingResult extends PairingBase { kind: "review"; a: ReviewArmTotals; b: ReviewArmTotals; recommendation: "descriptive" }
export type PairingResult = ImplementationPairingResult | ReviewPairingResult;
export interface Spend { observedUsd: number; estimatedUsd: number }
export interface ReportSpend { budget: Spend; wave: Spend }
/** What `--allow-source-drift` records per wave (R89): the commit its approval named and the bound paths that differ between it and HEAD. */
export interface SourceDrift { wave: number; sourceCommit: string; boundPathsChangedSinceSource: string[]; allowSourceDrift: true }
export interface ReportSummary {
  pairings: PairingResult[];
  /** Everything charged against the budget so far (`budgetSpend`, observed plus estimated). */
  spentUsd: number;
  /** All ledger entries: preflight, earlier waves and this wave. */
  budgetSpend: Spend;
  /** Only the ledger entries of runs that have a record in this wave. */
  waveSpend: Spend;
  stopReason: StopReason | null;
  /** Every stop reason recorded in any wave before the merge, by the 1-based index of its `--wave` argument; a superseded `not_run` stop survives here. */
  waveStops: { wave: number; runId: string; stopReason: StopReason }[];
  /** Only with `--allow-source-drift`: per wave, by its 1-based position among the `--wave` arguments, what changed since the code it ran. */
  sourceDrift?: SourceDrift[];
}

const costOf = (record: SummaryRecord): number => record.usage?.session?.costUsd ?? 0;

function totals(records: SummaryRecord[]): { arm: ArmTotals; input: number; cacheRead: number } {
  const arm: ArmTotals = { accepted: 0, costUsd: 0, scored: records.length, unexpectedConnects: 0, falseFindingRuns: 0, verdictMissed: 0 };
  let input = 0;
  let cacheRead = 0;
  for (const record of records) {
    if (record.accepted === true) arm.accepted += 1;
    if ((record.review?.falseFindings.length ?? 0) > 0) arm.falseFindingRuns += 1;
    if (record.review?.verdictMatched === false) arm.verdictMissed += 1;
    arm.costUsd += costOf(record);
    arm.unexpectedConnects += record.trace?.unexpectedConnectCount ?? 0;
    input += record.usage?.session?.input ?? 0;
    cacheRead += record.usage?.session?.cacheRead ?? 0;
  }
  return { arm, input, cacheRead };
}

function reviewTotals(records: SummaryRecord[], arm: ArmTotals): ReviewArmTotals {
  const scored = records.filter((record) => record.review !== undefined);
  const sum = (pick: (review: NonNullable<SummaryRecord["review"]>) => number): number => scored.reduce((total, record) => total + pick(record.review!), 0);
  const mean = (value: number): number => (scored.length === 0 ? 0 : value / scored.length);
  const ratio = (review: NonNullable<SummaryRecord["review"]>): number => ((review.criticalTotal ?? 0) > 0 ? (review.criticalHit ?? 0) / review.criticalTotal! : 0);
  return {
    costUsd: arm.costUsd, scored: arm.scored, unexpectedConnects: arm.unexpectedConnects, reviewScored: scored.length,
    criticalHitSum: sum((review) => review.criticalHit ?? 0), criticalTotalSum: sum((review) => review.criticalTotal ?? 0), criticalHitMean: mean(sum(ratio)),
    verdictMatched: scored.filter((record) => record.review!.verdictMatched === true).length, recallMean: mean(sum((review) => review.recall ?? 0)),
    falseFindingRuns: arm.falseFindingRuns, oracleAccepted: scored.filter((record) => record.review!.accepted === true).length,
  };
}

function assertNoDuplicates(records: readonly SummaryRecord[]): void {
  const ids = new Set<string>();
  const slots = new Set<string>();
  for (const record of records) {
    const slot = `${record.taskId}\u0000${record.profile}\u0000${record.arm}\u0000${replicateOf(record)}`;
    if (ids.has(record.runId) || slots.has(slot)) throw new Error("duplicate_run_record");
    ids.add(record.runId);
    slots.add(slot);
  }
}

const share = (t: { input: number; cacheRead: number }): number => (t.input + t.cacheRead > 0 ? t.cacheRead / (t.input + t.cacheRead) : 0);
const byTaskId = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

/** An implementation pairing of a plan with `replicates` > 1 (R92): `own` are the records of its two arms, whatever their outcome. */
function replicatedImplementation(pairing: Pairing, own: readonly SummaryRecord[], replicates: number): ImplementationPairingResult {
  const scoredRuns = (taskId: string, arm: SummaryRecord["arm"]): SummaryRecord[] =>
    own.filter((r) => r.taskId === taskId && r.arm === arm && r.outcome === "scored" && r.accepted !== null);
  const side = (runs: SummaryRecord[]): ReplicatedArm => {
    const accepted = runs.filter((r) => r.accepted === true).length;
    return { scored: runs.length, accepted, solved: 2 * accepted > replicates };
  };
  const perTask = [...new Set(own.map((r) => r.taskId))].sort(byTaskId).map((taskId) => {
    const a = side(scoredRuns(taskId, "A"));
    const b = side(scoredRuns(taskId, pairing.extension));
    return { taskId, a, b, counted: a.scored === replicates && b.scored === replicates };
  });
  const counted = perTask.filter((task) => task.counted);
  const runsOf = (arm: SummaryRecord["arm"]): SummaryRecord[] => counted.flatMap((task) => scoredRuns(task.taskId, arm));
  const a = totals(runsOf("A"));
  const b = totals(runsOf(pairing.extension));
  const solved = { a: counted.filter((task) => task.a.solved).length, b: counted.filter((task) => task.b.solved).length };
  const complete = counted.length === perTask.length && counted.length >= MIN_PAIRED_TASKS;
  const hasScored = perTask.some((task) => task.a.scored > 0 || task.b.scored > 0);
  const recommendation = !hasScored ? "not-run" : !complete ? "inconclusive"
    : recommend({ accepted: solved.a, costUsd: a.arm.costUsd }, { accepted: solved.b, costUsd: b.arm.costUsd }, counted.map((task) => ({ a: task.a.solved, b: task.b.solved })));
  return {
    id: pairing.id, tasks: counted.map((task) => task.taskId), cacheReadShare: { a: share(a), b: share(b) },
    replicated: { replicates, perTask, incompleteTasks: perTask.filter((task) => !task.counted).map((task) => task.taskId), solvedTasks: solved },
    kind: "implementation", a: a.arm, b: b.arm, complete, recommendation,
  };
}

/**
 * Per pairing, only tasks scored in both arms count (R6). For an implementation pairing, fewer than three such tasks is inconclusive and
 * incomplete, none at all is not run. A review pairing is descriptive (R83): it has the recommendation `descriptive` in every case and
 * reports the oracle's numbers per arm without any decision. `spend` defaults to the cost observed in the records; the ledger adds the estimates charged for runs without trusted output.
 * The cache-read share uses Pi's token split, where `input` excludes cache reads.
 *
 *
 * With `replicates` N > 1 (R90, R92) an implementation pairing is decided per task: an arm solves a task when more than N/2 of its N runs were
 * accepted, a task counts only when both arms have all N runs scored, and `recommend()` runs over the solved flags of the counted tasks
 * (`accepted` is the number of solved tasks, the cost that of the counted tasks' runs). The pairing is complete only when every task of the
 * pairing counted and at least three did, and inconclusive otherwise. A review pairing stays descriptive over the (task, replicate) units
 * scored in both arms. `replicated` is added to pairings that have runs; with one replicate nothing changes.
 */
export function summarize(records: readonly SummaryRecord[], spend?: ReportSpend, replicates = 1): ReportSummary {
  assertNoDuplicates(records);
  const unitKey = (taskId: string, replicate: number): string => `${taskId}\u0000${replicate}`;
  const pairings = PAIRINGS.map((pairing): PairingResult => {
    const own = records.filter((r) => r.profile === pairing.profile && r.pairings.includes(pairing.id) && (r.arm === "A" || r.arm === pairing.extension));
    if (replicates > 1 && own.length > 0 && taskKind(pairing.profile) === "implementation") return replicatedImplementation(pairing, own, replicates);
    const scoredBy = (arm: SummaryRecord["arm"]): Map<string, SummaryRecord> => new Map(records
      .filter((r) => r.outcome === "scored" && r.accepted !== null && r.arm === arm && r.profile === pairing.profile && r.pairings.includes(pairing.id))
      .map((r) => [unitKey(r.taskId, replicateOf(r)), r]));
    const armA = scoredBy("A");
    const armB = scoredBy(pairing.extension);
    const paired = [...armA.keys()].filter((key) => armB.has(key)).map((key) => ({ taskId: armA.get(key)!.taskId, replicate: replicateOf(armA.get(key)!), key }))
      .sort((x, y) => (x.taskId < y.taskId ? -1 : x.taskId > y.taskId ? 1 : x.replicate - y.replicate));
    const tasks = [...new Set(paired.map((unit) => unit.taskId))];
    const a = totals(paired.map((unit) => armA.get(unit.key)!));
    const b = totals(paired.map((unit) => armB.get(unit.key)!));
    const base = { id: pairing.id, tasks, cacheReadShare: { a: share(a), b: share(b) } };
    const units = paired.map(({ taskId, replicate }) => ({ taskId, replicate }));
    const replicated = (): { replicated?: ReplicatedResult } => (replicates > 1 && own.length > 0 ? { replicated: { replicates, units } } : {});
    if (taskKind(pairing.profile) === "review") {
      // R83: no recommendation of any kind, whatever the oracle accepted.
      return {
        ...base, ...replicated(), kind: "review", complete: tasks.length >= MIN_PAIRED_TASKS, recommendation: "descriptive",
        a: reviewTotals(paired.map((unit) => armA.get(unit.key)!), a.arm), b: reviewTotals(paired.map((unit) => armB.get(unit.key)!), b.arm),
      };
    }
    const perUnit = paired.map((unit) => ({ a: armA.get(unit.key)!.accepted === true, b: armB.get(unit.key)!.accepted === true }));
    const impl = { ...base, kind: "implementation" as const, a: a.arm, b: b.arm };
    if (tasks.length === 0) return { ...impl, complete: false, recommendation: "not-run" };
    if (tasks.length < MIN_PAIRED_TASKS) return { ...impl, complete: false, recommendation: "inconclusive" };
    return { ...impl, complete: true, recommendation: recommend(a.arm, b.arm, perUnit) };
  });
  const observed: Spend = { observedUsd: records.reduce((sum, r) => sum + costOf(r), 0), estimatedUsd: 0 };
  const { budget, wave } = spend ?? { budget: observed, wave: observed };
  const ordered = [...records].sort((x, y) => (x.runId < y.runId ? -1 : x.runId > y.runId ? 1 : 0));
  return {
    pairings, spentUsd: budget.observedUsd + budget.estimatedUsd, budgetSpend: budget, waveSpend: wave,
    stopReason: ordered.find((r) => r.stopReason !== null)?.stopReason ?? null, waveStops: [],
  };
}

/** Validates the very bytes that are copied, then splits the entries into observed and estimated, for the budget and for this wave. */
function ledgerSpend(bytes: Buffer, waveRunIds: ReadonlySet<string>): ReportSpend & { ledgerId: string } {
  let parsed;
  try { parsed = ledgerFileSchema.safeParse(JSON.parse(bytes.toString("utf8"))); } catch { throw new Error("ledger_file_invalid"); }
  if (!parsed.success) throw new Error("ledger_file_invalid");
  const spend: ReportSpend & { ledgerId: string } = { budget: { observedUsd: 0, estimatedUsd: 0 }, wave: { observedUsd: 0, estimatedUsd: 0 }, ledgerId: parsed.data.ledgerId };
  for (const entry of parsed.data.entries) {
    const field = entry.estimated === true ? "estimatedUsd" : "observedUsd";
    spend.budget[field] += entry.costUsd ?? 0;
    if (waveRunIds.has(entry.runId)) spend.wave[field] += entry.costUsd ?? 0;
  }
  return spend;
}

async function readLedger(path: string, waveRunIds: ReadonlySet<string>): Promise<{ bytes: Buffer; spend: ReportSpend & { ledgerId: string } }> {
  let bytes: Buffer;
  try { bytes = await readRegularFile(path, MAX_LEDGER_BYTES); } catch (error) {
    throw new Error((error as NodeJS.ErrnoException).code === "ENOENT" ? "ledger_missing" : "ledger_unreadable");
  }
  return { bytes, spend: ledgerSpend(bytes, waveRunIds) };
}

interface WaveRun { name: string; bytes: Buffer; record: SummaryRecord }

/** The sanitized records of a wave directory, read as regular files within the size cap and checked against the schema. */
export async function readRuns(waveDir: string): Promise<WaveRun[]> {
  let names: string[];
  try { names = (await readdir(join(waveDir, "runs"))).filter((name) => name.endsWith(".json")).sort(); } catch { throw new Error("runs_missing"); }
  const runs: WaveRun[] = [];
  for (const name of names) {
    const bytes = await readRegularFile(join(waveDir, "runs", name), MAX_RECORD_BYTES);
    let record: SummaryRecord;
    try { record = parseSummaryRecord(JSON.parse(bytes.toString("utf8"))); } catch { throw new Error("run_record_invalid"); }
    if (`${record.runId}.json` !== name) throw new Error("run_record_invalid");
    runs.push({ name, bytes, record });
  }
  return runs;
}

/** The approval a wave ran under (`approval.json`, written by the wave); the evidence carries a copy and binds it to the code (I6b). */
export async function readApproval(waveDir: string): Promise<{ bytes: Buffer; approval: Approval }> {
  let bytes: Buffer;
  try { bytes = await readRegularFile(join(waveDir, "approval.json"), MAX_RECORD_BYTES); } catch (error) {
    throw new Error((error as NodeJS.ErrnoException).code === "ENOENT" ? "approval_missing" : "approval_invalid");
  }
  let parsed;
  try { parsed = approvalSchema.safeParse(JSON.parse(bytes.toString("utf8"))); } catch { throw new Error("approval_invalid"); }
  if (!parsed.success) throw new Error("approval_invalid");
  return { bytes, approval: parsed.data };
}

/**
 * Merges the records of several waves per run id (R60). A run id keeps its task, profile, arm and replicate across waves; at most one wave holds a
 * final record for it (scored, or stopped for a reason other than the trace audit), and that one replaces the `not_run` records other
 * waves wrote for the slot. A record stopped by the trace audit is not final (R85): the slot may be planned again, and a final record of the
 * same run id from any other wave replaces it, whatever the order of the waves (the stop itself stays in `waveStops`); among audit stops the
 * later wave given wins. A run id appears once per wave.
 */
function mergeRuns(waves: readonly WaveRun[][]): WaveRun[] {
  const merged = new Map<string, WaveRun>();
  for (const runs of waves) {
    const inWave = new Set<string>();
    for (const run of runs) {
      const { runId } = run.record;
      if (inWave.has(runId)) throw new Error("duplicate_run_record");
      inWave.add(runId);
      const prior = merged.get(runId)?.record;
      if (prior === undefined) { merged.set(runId, run); continue; }
      const same = prior.taskId === run.record.taskId && prior.profile === run.record.profile && prior.arm === run.record.arm && prior.replicate === run.record.replicate;
      const isFinal = (record: SummaryRecord): boolean => record.outcome !== "not_run" && !(record.outcome === "stopped" && isAuditStop(record.stopReason));
      if (!same || (isFinal(prior) && isFinal(run.record))) throw new Error("duplicate_run_record");
      // A final record wins over an audit stop and an audit stop over a `not_run` slot, in whichever wave each one is.
      const rank = (record: SummaryRecord): number => (isFinal(record) ? 2 : record.outcome === "not_run" ? 0 : 1);
      if (rank(run.record) > rank(prior) || (rank(run.record) === 1 && rank(prior) === 1)) merged.set(runId, run);
    }
  }
  return [...merged.values()];
}

/** True when a parsed value holds a forbidden key, an over-long string or a path-like segment in any string or key. */
function leaks(value: unknown): boolean {
  if (typeof value === "string") return value.length > MAX_STRING_CHARS || PATH_LIKE.test(value);
  if (Array.isArray(value)) return value.some(leaks);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(([key, inner]) => FORBIDDEN_KEYS.has(key) || leaks(key) || leaks(inner));
  }
  return false;
}

async function assertNoPrivateData(files: Map<string, Buffer>, waveDirs: readonly string[]): Promise<void> {
  const needles = new Set([...waveDirs, realHome()]);
  for (const waveDir of waveDirs) {
    try { needles.add(await realpath(waveDir)); } catch { /* the wave directory was read above, so it exists */ }
  }
  for (const bytes of files.values()) {
    const text = bytes.toString("utf8");
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error("evidence_contains_private_data"); }
    if ([...needles].some((needle) => needle.length > 1 && text.includes(needle)) || leaks(parsed)) throw new Error("evidence_contains_private_data");
  }
}

async function absent(path: string): Promise<boolean> {
  try { await lstat(path); return false; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

const json = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

/**
 * The commit and a digest of the bound sources (profiles evaluation plus the ablation code). Evidence from a tree that differs from
 * the commit under a bound path would claim code that did not run, so any change there refuses with `source_dirty`.
 */
async function boundSource(root: string): Promise<{ commit: string; digest: `sha256:${string}` }> {
  const git = async (args: string[]): Promise<string> => {
    try { return (await exec("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).stdout; } catch { throw new Error("source_unavailable"); }
  };
  if (dirtyBoundPaths(await git(["status", "--porcelain", "-z", "--untracked-files=all"])).length > 0) throw new Error("source_dirty");
  const commit = (await git(["rev-parse", "HEAD"])).trim();
  const listed = (await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).split("\0").filter((p) => BOUND_PATH.test(p)).sort();
  const records: [string, string][] = [];
  for (const path of listed) records.push([path, hash(await readFile(join(root, path)))]);
  return { commit, digest: digest(records) };
}

/**
 * The code the wave ran is the code the evidence claims: nothing under a bound path may differ between the commit the approval named
 * and HEAD (`git diff --quiet`); an unknown commit counts as a difference (`approval_source_mismatch`).
 */
async function assertBoundCodeUnchanged(root: string, commit: string): Promise<void> {
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error("approval_source_mismatch");
  try { await exec("git", ["diff", "--quiet", "--end-of-options", commit, "HEAD", "--", ...BOUND_PATHSPECS], { cwd: root }); } catch { throw new Error("approval_source_mismatch"); }
}

/**
 * `--allow-source-drift` (R89): instead of refusing a difference, the repo-relative bound paths that changed between the approval's commit and
 * HEAD are listed. The commit must exist and be an ancestor of HEAD (`approval_source_unknown` otherwise), so the evidence still describes
 * code that HEAD contains; what changed since is recorded, not judged.
 */
async function boundPathsChangedSince(root: string, commit: string): Promise<string[]> {
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error("approval_source_unknown");
  try {
    await exec("git", ["cat-file", "-e", "--end-of-options", `${commit}^{commit}`], { cwd: root });
    await exec("git", ["merge-base", "--is-ancestor", "--end-of-options", commit, "HEAD"], { cwd: root });
  } catch { throw new Error("approval_source_unknown"); }
  try {
    const { stdout } = await exec("git", ["diff", "--name-only", "-z", "--end-of-options", commit, "HEAD", "--", ...BOUND_PATHSPECS], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return stdout.split("\0").filter((path) => path !== "").sort();
  } catch { throw new Error("source_unavailable"); }
}

/** Removes the directories this call created, innermost first, and stops at the first one that is not empty. */
async function removeCreatedParents(parent: string, firstCreated: string | undefined): Promise<void> {
  if (firstCreated === undefined) return;
  for (let dir = parent; ; dir = dirname(dir)) {
    try { await rmdir(dir); } catch { return; }
    if (dir === firstCreated) return;
  }
}

/**
 * Copies the wave's sanitized `runs/*.json` and the budget ledger into a new evidence directory and adds `summary.json` and
 * `integrity.json`. Everything is built in memory and checked for private data first; the directory appears only complete.
 * `evidenceDir` must not exist. Returns the summary that was written.
 */
export async function writeEvidence(
  waveDirs: string | readonly string[], evidenceDir: string, ledgerPath: string, options: { repoRoot: string; allowSourceDrift?: boolean },
): Promise<ReportSummary> {
  const waves = (typeof waveDirs === "string" ? [waveDirs] : [...waveDirs]).map((dir) => resolve(dir));
  if (waves.length === 0 || new Set(waves).size !== waves.length) throw new Error("wave_required");
  const target = resolve(evidenceDir);
  if (!(await absent(target))) throw new Error("evidence_dir_exists");
  // Several wave directories (an earlier wave and its re-approved successor) are merged per run id (R60).
  const perWave: WaveRun[][] = [];
  const approvals: { bytes: Buffer; approval: Approval }[] = [];
  for (const wave of waves) {
    perWave.push(await readRuns(wave));
    approvals.push(await readApproval(wave));
  }
  const waveStops = perWave.flatMap((wave, index) => wave.filter((run) => run.record.stopReason !== null)
    .map((run) => ({ wave: index + 1, runId: run.record.runId, stopReason: run.record.stopReason! })));
  const runs = mergeRuns(perWave);
  const summarized = runs.map((r) => r.record);
  assertNoDuplicates(summarized);
  const ledger = await readLedger(resolve(ledgerPath), new Set(summarized.map((r) => r.runId)));
  // The repository the evidence is bound to: the caller names it. The module itself lives in a disposable build, which is not a repository.
  const root = options.repoRoot;
  const sourceDrift: SourceDrift[] = [];
  for (const [index, { approval }] of approvals.entries()) {
    if (approval.ledgerId !== ledger.spend.ledgerId) throw new Error("ledger_mismatch");
    if (options.allowSourceDrift === true) {
      sourceDrift.push({ wave: index + 1, sourceCommit: approval.sourceCommit, boundPathsChangedSinceSource: await boundPathsChangedSince(root, approval.sourceCommit), allowSourceDrift: true });
    } else await assertBoundCodeUnchanged(root, approval.sourceCommit);
  }
  // Waves of one evaluation share one replicate count (R90): run ids of different counts would merge into slots that are not one plan's.
  const counts = new Set(approvals.map(({ approval }) => approval.replicates ?? 1));
  if (counts.size !== 1) throw new Error("replicates_mixed");
  const replicates = [...counts][0]!;
  const summary: ReportSummary = { ...summarize(summarized, ledger.spend, replicates), waveStops, ...(options.allowSourceDrift === true ? { sourceDrift } : {}) };

  const files = new Map<string, Buffer>();
  for (const run of runs) files.set(`runs/${run.name}`, run.bytes);
  approvals.forEach(({ bytes }, index) => files.set(`approvals/approval-${index + 1}.json`, bytes));
  files.set("ledger.json", ledger.bytes);
  files.set("summary.json", json(summary));
  const binding = await boundSource(root);
  files.set("integrity.json", json({
    kind: "extension-ablation-evidence-integrity", source_binding: binding, ...(options.allowSourceDrift === true ? { source_drift: sourceDrift } : {}),
    files: [...files.entries()].sort(([x], [y]) => (x < y ? -1 : 1)).map(([path, bytes]) => ({ path, hash: hash(bytes) })),
  }));
  await assertNoPrivateData(files, waves);

  // Only now does anything appear on disk. The target is created without `recursive`, so "must not exist" is decided by the
  // kernel at creation time; the files are staged beside it and renamed in.
  const parent = dirname(target);
  const firstCreated = await mkdir(parent, { recursive: true });
  const staging = `${target}.tmp-${randomUUID()}`;
  let targetCreated = false;
  try {
    for (const [path, bytes] of files) {
      await mkdir(dirname(join(staging, path)), { recursive: true });
      await writeFile(join(staging, path), bytes, { flag: "wx" });
    }
    try { await mkdir(target); } catch (error) {
      throw new Error((error as NodeJS.ErrnoException).code === "EEXIST" ? "evidence_dir_exists" : "evidence_write_failed");
    }
    targetCreated = true;
    for (const name of await readdir(staging)) await rename(join(staging, name), join(target, name));
    await rm(staging, { recursive: true, force: true });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (targetCreated) await rm(target, { recursive: true, force: true });
    await removeCreatedParents(parent, firstCreated);
    throw error;
  }
  return summary;
}

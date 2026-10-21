import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { digest, hash } from "../profiles/files.js";
import { approvalSchema, type Approval } from "./approval.js";
import { BOUND_PATH, BOUND_PATHSPECS, dirtyBoundPaths } from "./bound.js";
import { isAuditStop, type RunRecord, type StopReason } from "./classify.js";
import { ledgerFileSchema } from "./ledger-file.js";
import { PAIRINGS, taskKind } from "./matrix.js";
import { armSchema, profileIdSchema } from "./schemas.js";
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
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The pre-registered rule: enable only when B loses nothing, wins at least one task A lost, and costs at most 1.25 times A. */
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

const summaryRecordSchema = z.object({
  runId: z.string().min(1), taskId: z.string().min(1), profile: profileIdSchema, arm: armSchema, pairings: z.array(z.string()),
  outcome: z.enum(["scored", "stopped", "not_run"]), accepted: z.boolean().nullable(),
  usage: z.object({ session: z.object({ input: z.number(), cacheRead: z.number(), costUsd: z.number() }).nullable() }).nullable(),
  stopReason: z.enum(STOP_REASONS).nullable(),
  trace: z.object({ unexpectedConnectCount: z.number().int().min(0).optional() }).nullable().optional(),
  review: z.object({
    falseFindings: z.array(z.string()), verdictMatched: z.boolean().optional(), criticalHit: z.number().optional(), criticalTotal: z.number().optional(),
    recall: z.number().optional(), accepted: z.boolean().optional(),
  }).optional(),
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
interface PairingBase {
  id: string;
  /** The tasks scored in both arms, in task-id order. */
  tasks: string[];
  /** At least three tasks were scored in both arms. */
  complete: boolean;
  cacheReadShare: { a: number; b: number };
}
export interface ImplementationPairingResult extends PairingBase { kind: "implementation"; a: ArmTotals; b: ArmTotals; recommendation: Recommendation | "not-run" }
/** Review pairings are descriptive (R83): a review run is scored and reported, but its acceptance never yields a recommendation. */
export interface ReviewPairingResult extends PairingBase { kind: "review"; a: ReviewArmTotals; b: ReviewArmTotals; recommendation: "descriptive" }
export type PairingResult = ImplementationPairingResult | ReviewPairingResult;
export interface Spend { observedUsd: number; estimatedUsd: number }
export interface ReportSpend { budget: Spend; wave: Spend }
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
    const slot = `${record.taskId}\u0000${record.profile}\u0000${record.arm}`;
    if (ids.has(record.runId) || slots.has(slot)) throw new Error("duplicate_run_record");
    ids.add(record.runId);
    slots.add(slot);
  }
}

/**
 * Per pairing, only tasks scored in both arms count (R6). For an implementation pairing, fewer than three such tasks is inconclusive and
 * incomplete, none at all is not run. A review pairing is descriptive (R83): it has the recommendation `descriptive` in every case and
 * reports the oracle's numbers per arm without any decision. `spend` defaults to the cost observed in the records; the ledger adds the estimates charged for runs without trusted output.
 * The cache-read share uses Pi's token split, where `input` excludes cache reads.
 */
export function summarize(records: readonly SummaryRecord[], spend?: ReportSpend): ReportSummary {
  assertNoDuplicates(records);
  const pairings = PAIRINGS.map((pairing): PairingResult => {
    const scoredBy = (arm: SummaryRecord["arm"]): Map<string, SummaryRecord> => new Map(records
      .filter((r) => r.outcome === "scored" && r.accepted !== null && r.arm === arm && r.profile === pairing.profile && r.pairings.includes(pairing.id))
      .map((r) => [r.taskId, r]));
    const armA = scoredBy("A");
    const armB = scoredBy(pairing.extension);
    const tasks = [...armA.keys()].filter((id) => armB.has(id)).sort();
    const a = totals(tasks.map((id) => armA.get(id)!));
    const b = totals(tasks.map((id) => armB.get(id)!));
    const share = (t: { input: number; cacheRead: number }): number => (t.input + t.cacheRead > 0 ? t.cacheRead / (t.input + t.cacheRead) : 0);
    const base = { id: pairing.id, tasks, cacheReadShare: { a: share(a), b: share(b) } };
    if (taskKind(pairing.profile) === "review") {
      // R83: no recommendation of any kind, whatever the oracle accepted.
      return {
        ...base, kind: "review", complete: tasks.length >= MIN_PAIRED_TASKS, recommendation: "descriptive",
        a: reviewTotals(tasks.map((id) => armA.get(id)!), a.arm), b: reviewTotals(tasks.map((id) => armB.get(id)!), b.arm),
      };
    }
    const impl = { ...base, kind: "implementation" as const, a: a.arm, b: b.arm };
    if (tasks.length === 0) return { ...impl, complete: false, recommendation: "not-run" };
    if (tasks.length < MIN_PAIRED_TASKS) return { ...impl, complete: false, recommendation: "inconclusive" };
    const perTask = tasks.map((id) => ({ a: armA.get(id)!.accepted === true, b: armB.get(id)!.accepted === true }));
    return { ...impl, complete: true, recommendation: recommend(a.arm, b.arm, perTask) };
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
 * Merges the records of several waves per run id (R60). A run id keeps its task, profile and arm across waves; at most one wave holds a
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
      const same = prior.taskId === run.record.taskId && prior.profile === run.record.profile && prior.arm === run.record.arm;
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
  try { await exec("git", ["diff", "--quiet", commit, "HEAD", "--", ...BOUND_PATHSPECS], { cwd: root }); } catch { throw new Error("approval_source_mismatch"); }
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
export async function writeEvidence(waveDirs: string | readonly string[], evidenceDir: string, ledgerPath: string, options: { repoRoot?: string } = {}): Promise<ReportSummary> {
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
  const root = options.repoRoot ?? REPO_ROOT;
  for (const { approval } of approvals) {
    if (approval.ledgerId !== ledger.spend.ledgerId) throw new Error("ledger_mismatch");
    await assertBoundCodeUnchanged(root, approval.sourceCommit);
  }
  const summary: ReportSummary = { ...summarize(summarized, ledger.spend), waveStops };

  const files = new Map<string, Buffer>();
  for (const run of runs) files.set(`runs/${run.name}`, run.bytes);
  approvals.forEach(({ bytes }, index) => files.set(`approvals/approval-${index + 1}.json`, bytes));
  files.set("ledger.json", ledger.bytes);
  files.set("summary.json", json(summary));
  const binding = await boundSource(root);
  files.set("integrity.json", json({
    kind: "extension-ablation-evidence-integrity", source_binding: binding,
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

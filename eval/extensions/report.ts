import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { digest, hash } from "../profiles/files.js";
import type { RunRecord, StopReason } from "./classify.js";
import { ledgerFileSchema } from "./ledger-file.js";
import { PAIRINGS } from "./matrix.js";
import { armSchema, profileIdSchema } from "./schemas.js";
import { readRegularFile } from "./safe-read.js";

export type Recommendation = "enable" | "do-not-enable" | "inconclusive";

const MIN_PAIRED_TASKS = 3;
const MAX_COST_RATIO = 1.25;
const MAX_STRING_CHARS = 2_000;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_LEDGER_BYTES = 4 * 1024 * 1024;
const FORBIDDEN_KEYS = new Set(["access", "refresh", "key"]);
/** A path-like segment anywhere in a string: a slash that starts the string or follows whitespace, a quote or a separator. */
const PATH_LIKE = /(^|[\s"'=:(,])\/[A-Za-z0-9._-]/;
/** What the evidence is bound to: the profile evaluation's sources plus the ablation code itself. */
const BOUND_PATH = /^(src\/|eval\/(profiles|fixtures|extensions)\/|test\/|scripts\/|package(-lock)?\.json$|tsconfig.*\.json$)/;
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
});
const parseSummaryRecord = (value: unknown): SummaryRecord => summaryRecordSchema.parse(value);

export interface ArmTotals { accepted: number; costUsd: number; scored: number }
export interface PairingResult {
  id: string;
  /** The tasks scored in both arms, in task-id order. */
  tasks: string[];
  complete: boolean;
  a: ArmTotals;
  b: ArmTotals;
  recommendation: Recommendation | "not-run";
  cacheReadShare: { a: number; b: number };
}
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
}

const costOf = (record: SummaryRecord): number => record.usage?.session?.costUsd ?? 0;

function totals(records: SummaryRecord[]): { arm: ArmTotals; input: number; cacheRead: number } {
  const arm: ArmTotals = { accepted: 0, costUsd: 0, scored: records.length };
  let input = 0;
  let cacheRead = 0;
  for (const record of records) {
    if (record.accepted === true) arm.accepted += 1;
    arm.costUsd += costOf(record);
    input += record.usage?.session?.input ?? 0;
    cacheRead += record.usage?.session?.cacheRead ?? 0;
  }
  return { arm, input, cacheRead };
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
 * Per pairing, only tasks scored in both arms count (R6). Fewer than three such tasks is inconclusive and incomplete, none at all is
 * not run. `spend` defaults to the cost observed in the records; the ledger adds the estimates charged for runs without trusted output.
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
    const base = { id: pairing.id, tasks, a: a.arm, b: b.arm, cacheReadShare: { a: share(a), b: share(b) } };
    if (tasks.length === 0) return { ...base, complete: false, recommendation: "not-run" };
    if (tasks.length < MIN_PAIRED_TASKS) return { ...base, complete: false, recommendation: "inconclusive" };
    const perTask = tasks.map((id) => ({ a: armA.get(id)!.accepted === true, b: armB.get(id)!.accepted === true }));
    return { ...base, complete: true, recommendation: recommend(a.arm, b.arm, perTask) };
  });
  const observed: Spend = { observedUsd: records.reduce((sum, r) => sum + costOf(r), 0), estimatedUsd: 0 };
  const { budget, wave } = spend ?? { budget: observed, wave: observed };
  const ordered = [...records].sort((x, y) => (x.runId < y.runId ? -1 : x.runId > y.runId ? 1 : 0));
  return {
    pairings, spentUsd: budget.observedUsd + budget.estimatedUsd, budgetSpend: budget, waveSpend: wave,
    stopReason: ordered.find((r) => r.stopReason !== null)?.stopReason ?? null,
  };
}

/** Validates the very bytes that are copied, then splits the entries into observed and estimated, for the budget and for this wave. */
function ledgerSpend(bytes: Buffer, waveRunIds: ReadonlySet<string>): ReportSpend {
  let parsed;
  try { parsed = ledgerFileSchema.safeParse(JSON.parse(bytes.toString("utf8"))); } catch { throw new Error("ledger_file_invalid"); }
  if (!parsed.success) throw new Error("ledger_file_invalid");
  const spend: ReportSpend = { budget: { observedUsd: 0, estimatedUsd: 0 }, wave: { observedUsd: 0, estimatedUsd: 0 } };
  for (const entry of parsed.data.entries) {
    const field = entry.estimated === true ? "estimatedUsd" : "observedUsd";
    spend.budget[field] += entry.costUsd ?? 0;
    if (waveRunIds.has(entry.runId)) spend.wave[field] += entry.costUsd ?? 0;
  }
  return spend;
}

async function readLedger(path: string, waveRunIds: ReadonlySet<string>): Promise<{ bytes: Buffer; spend: ReportSpend }> {
  let bytes: Buffer;
  try { bytes = await readRegularFile(path, MAX_LEDGER_BYTES); } catch (error) {
    throw new Error((error as NodeJS.ErrnoException).code === "ENOENT" ? "ledger_missing" : "ledger_unreadable");
  }
  return { bytes, spend: ledgerSpend(bytes, waveRunIds) };
}

async function readRuns(waveDir: string): Promise<{ name: string; bytes: Buffer; record: SummaryRecord }[]> {
  let names: string[];
  try { names = (await readdir(join(waveDir, "runs"))).filter((name) => name.endsWith(".json")).sort(); } catch { throw new Error("runs_missing"); }
  const runs = [];
  for (const name of names) {
    const bytes = await readRegularFile(join(waveDir, "runs", name), MAX_RECORD_BYTES);
    let record: SummaryRecord;
    try { record = parseSummaryRecord(JSON.parse(bytes.toString("utf8"))); } catch { throw new Error("run_record_invalid"); }
    if (`${record.runId}.json` !== name) throw new Error("run_record_invalid");
    runs.push({ name, bytes, record });
  }
  return runs;
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

async function assertNoPrivateData(files: Map<string, Buffer>, waveDir: string): Promise<void> {
  const needles = new Set([waveDir, userInfo().homedir]);
  try { needles.add(await realpath(waveDir)); } catch { /* the wave directory was read above, so it exists */ }
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
  const tokens = (await git(["status", "--porcelain", "-z", "--untracked-files=all"])).split("\0").filter((t) => t !== "");
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const paths = [token.slice(3)];
    if (/[RC]/.test(token.slice(0, 2))) { i += 1; if (tokens[i] !== undefined) paths.push(tokens[i]!); }
    if (paths.some((path) => BOUND_PATH.test(path))) throw new Error("source_dirty");
  }
  const commit = (await git(["rev-parse", "HEAD"])).trim();
  const listed = (await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).split("\0").filter((p) => BOUND_PATH.test(p)).sort();
  const records: [string, string][] = [];
  for (const path of listed) records.push([path, hash(await readFile(join(root, path)))]);
  return { commit, digest: digest(records) };
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
export async function writeEvidence(waveDir: string, evidenceDir: string, ledgerPath: string, options: { repoRoot?: string } = {}): Promise<ReportSummary> {
  const wave = resolve(waveDir);
  const target = resolve(evidenceDir);
  if (!(await absent(target))) throw new Error("evidence_dir_exists");
  const runs = await readRuns(wave);
  const ledger = await readLedger(resolve(ledgerPath), new Set(runs.map((r) => r.record.runId)));
  const summary = summarize(runs.map((r) => r.record), ledger.spend);

  const files = new Map<string, Buffer>();
  for (const run of runs) files.set(`runs/${run.name}`, run.bytes);
  files.set("ledger.json", ledger.bytes);
  files.set("summary.json", json(summary));
  const binding = await boundSource(options.repoRoot ?? REPO_ROOT);
  files.set("integrity.json", json({
    kind: "extension-ablation-evidence-integrity", source_binding: binding,
    files: [...files.entries()].sort(([x], [y]) => (x < y ? -1 : 1)).map(([path, bytes]) => ({ path, hash: hash(bytes) })),
  }));
  await assertNoPrivateData(files, wave);

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

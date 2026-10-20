import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { hash, sourceBinding } from "../profiles/files.js";
import type { RunRecord, StopReason } from "./classify.js";
import { PersistedLedger } from "./ledger-file.js";
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

const summaryRecordSchema = z.object({
  runId: z.string().min(1), taskId: z.string().min(1), profile: profileIdSchema, arm: armSchema, pairings: z.array(z.string()),
  outcome: z.enum(["scored", "stopped", "not_run"]), accepted: z.boolean().nullable(),
  usage: z.object({ session: z.object({ input: z.number(), cacheRead: z.number(), costUsd: z.number() }).nullable() }).nullable(),
  stopReason: z.enum([
    "outside_write", "unresolved_write", "unresolved_egress", "output_integrity", "guard_changed", "harness_failure", "cleanup_failure",
    "provider_error", "credential_expiring", "budget", "wave_timeout", "interrupted",
  ]).nullable(),
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
export interface ReportSummary { pairings: PairingResult[]; spentUsd: number; spend: Spend; stopReason: StopReason | null }

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

/**
 * Per pairing, only tasks scored in both arms count (R6). Fewer than three such tasks is inconclusive and incomplete, none at all is
 * not run. `spend` defaults to the cost observed in the records; the ledger adds the estimates charged for runs without trusted output.
 */
export function summarize(records: readonly SummaryRecord[], spend?: Spend): ReportSummary {
  const pairings = PAIRINGS.map((pairing): PairingResult => {
    const scoredBy = (arm: SummaryRecord["arm"]): Map<string, SummaryRecord> => new Map(records
      .filter((r) => r.outcome === "scored" && r.accepted !== null && r.arm === arm && r.profile === pairing.profile && r.pairings.includes(pairing.id))
      .map((r) => [r.taskId, r]));
    const armA = scoredBy("A");
    const armB = scoredBy(pairing.extension);
    const tasks = [...armA.keys()].filter((id) => armB.has(id)).sort();
    const a = totals(tasks.map((id) => armA.get(id)!));
    const b = totals(tasks.map((id) => armB.get(id)!));
    const share = (t: { input: number; cacheRead: number }): number => (t.input > 0 ? t.cacheRead / t.input : 0);
    const base = { id: pairing.id, tasks, a: a.arm, b: b.arm, cacheReadShare: { a: share(a), b: share(b) } };
    if (tasks.length === 0) return { ...base, complete: false, recommendation: "not-run" };
    if (tasks.length < MIN_PAIRED_TASKS) return { ...base, complete: false, recommendation: "inconclusive" };
    const perTask = tasks.map((id) => ({ a: armA.get(id)!.accepted === true, b: armB.get(id)!.accepted === true }));
    return { ...base, complete: true, recommendation: recommend(a.arm, b.arm, perTask) };
  });
  const observed = spend ?? { observedUsd: records.reduce((sum, r) => sum + costOf(r), 0), estimatedUsd: 0 };
  const ordered = [...records].sort((x, y) => (x.runId < y.runId ? -1 : x.runId > y.runId ? 1 : 0));
  return {
    pairings, spend: observed, spentUsd: observed.observedUsd + observed.estimatedUsd,
    stopReason: ordered.find((r) => r.stopReason !== null)?.stopReason ?? null,
  };
}

const ledgerSpendSchema = z.object({
  entries: z.array(z.object({ costUsd: z.number().min(0).nullable(), estimated: z.literal(true).optional() }).passthrough()),
}).passthrough();

/** Observed and estimated spend, separately, from a ledger file that has passed the ledger's own strict validation. */
function ledgerSpend(bytes: Buffer): Spend {
  const parsed = ledgerSpendSchema.parse(JSON.parse(bytes.toString("utf8")));
  const spend: Spend = { observedUsd: 0, estimatedUsd: 0 };
  for (const entry of parsed.entries) {
    if (entry.estimated === true) spend.estimatedUsd += entry.costUsd ?? 0;
    else spend.observedUsd += entry.costUsd ?? 0;
  }
  return spend;
}

async function readLedger(path: string): Promise<{ bytes: Buffer; spend: Spend }> {
  let bytes: Buffer;
  try { bytes = await readRegularFile(path, MAX_LEDGER_BYTES); } catch (error) {
    throw new Error((error as NodeJS.ErrnoException).code === "ENOENT" ? "ledger_missing" : "ledger_unreadable");
  }
  await PersistedLedger.open(path);
  return { bytes, spend: ledgerSpend(bytes) };
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

/** True when a parsed value holds a forbidden key, an over-long string or an absolute path anywhere. */
function leaks(value: unknown): boolean {
  if (typeof value === "string") return value.length > MAX_STRING_CHARS || value.startsWith("/");
  if (Array.isArray(value)) return value.some(leaks);
  if (value !== null && typeof value === "object") return Object.entries(value).some(([key, inner]) => FORBIDDEN_KEYS.has(key) || leaks(inner));
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
 * Copies the wave's sanitized `runs/*.json` and the budget ledger into a new evidence directory and adds `summary.json` and
 * `integrity.json`. Everything is built in memory and checked for private data first; the directory appears only complete.
 * `evidenceDir` must not exist. Returns the summary that was written.
 */
export async function writeEvidence(waveDir: string, evidenceDir: string, ledgerPath: string, options: { repoRoot?: string } = {}): Promise<ReportSummary> {
  const wave = resolve(waveDir);
  const target = resolve(evidenceDir);
  if (!(await absent(target))) throw new Error("evidence_dir_exists");
  const runs = await readRuns(wave);
  const ledger = await readLedger(resolve(ledgerPath));
  const summary = summarize(runs.map((r) => r.record), ledger.spend);

  const files = new Map<string, Buffer>();
  for (const run of runs) files.set(`runs/${run.name}`, run.bytes);
  files.set("ledger.json", ledger.bytes);
  files.set("summary.json", json(summary));
  const binding = await sourceBinding(options.repoRoot ?? REPO_ROOT);
  const integrity = json({
    kind: "extension-ablation-evidence-integrity", source_binding: binding,
    files: [...files.entries()].sort(([x], [y]) => (x < y ? -1 : 1)).map(([path, bytes]) => ({ path, hash: hash(bytes) })),
  });
  files.set("integrity.json", integrity);
  await assertNoPrivateData(files, wave);

  const staging = `${target}.tmp-${randomUUID()}`;
  try {
    for (const [path, bytes] of files) {
      await mkdir(dirname(join(staging, path)), { recursive: true });
      await writeFile(join(staging, path), bytes, { flag: "wx" });
    }
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return summary;
}

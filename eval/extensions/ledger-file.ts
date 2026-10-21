import { randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { BUDGET_USD, BudgetLedger } from "./budget.js";
import { profileIdSchema, type ProfileId } from "./schemas.js";

const entrySchema = z.object({
  runId: z.string().min(1), profile: profileIdSchema, costUsd: z.number().min(0).nullable(),
  /** Set when the run left no trusted output and the profile's current estimate stands in for its cost (R41). */
  estimated: z.literal(true).optional(),
  /** A preflight PONG: spend only, never an observation that moves the per-profile estimate (R54). */
  kind: z.literal("preflight").optional(),
}).strict();
/** The ledger file as `PersistedLedger` writes and replays it; the report validates the bytes it copies with the same schema. */
export const ledgerFileSchema = z.object({ ledgerId: z.string().uuid(), limitUsd: z.literal(BUDGET_USD), spentUsd: z.number().min(0), entries: z.array(entrySchema) }).strict();
/** A cost the ledger would reject; callers record null for it instead of recording twice. */
export const isValidCost = (cost: number | null): boolean => cost === null || (Number.isFinite(cost) && cost >= 0);
/** The measured session cost of a trusted output, or null when there is none or it is invalid; callers then treat the session as missing (R62c). */
export const validSessionCost = (session: { costUsd: number } | null | undefined): number | null =>
  session != null && Number.isFinite(session.costUsd) && session.costUsd >= 0 ? session.costUsd : null;
type LedgerEntry = z.infer<typeof entrySchema>;

/** A ledger together with the entries that built it, so the file can be rewritten and replayed. */
export class PersistedLedger {
  readonly ledger = new BudgetLedger(BUDGET_USD);
  private readonly entries: LedgerEntry[] = [];
  /** Random id given at creation; approvals, the preflight and the report name it, so one evaluation keeps one ledger (R37b, R55). */
  id: string = randomUUID();
  private locked = false;
  constructor(private readonly path: string) {}

  /**
   * Replays an existing file so all spend of the evaluation counts against one budget (R37). A missing file is a fresh ledger with a new
   * id that exists only in memory until `save()`; only `--plan --ledger <new path>` creates one, everything else uses `openExisting`.
   */
  static async open(path: string): Promise<PersistedLedger> {
    const persisted = new PersistedLedger(path);
    let raw: string;
    try { raw = await readFile(persisted.path, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return persisted;
      throw error;
    }
    const parsed = ledgerFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error("ledger_file_invalid");
    persisted.id = parsed.data.ledgerId;
    for (const entry of parsed.data.entries) persisted.replay(entry);
    return persisted;
  }

  /** The ledger of an approved evaluation: it must exist (`ledger_missing`) and carry the approval's id (`ledger_mismatch`). */
  static async openExisting(path: string, expectedId?: string): Promise<PersistedLedger> {
    try { await readFile(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("ledger_missing");
      throw error;
    }
    const persisted = await PersistedLedger.open(path);
    if (expectedId !== undefined && persisted.id !== expectedId) throw new Error("ledger_mismatch");
    return persisted;
  }

  /**
   * `openExisting` under the exclusive lock: the lock is taken first and the file is read and checked while holding it, so no entry another
   * holder commits in between can be missed. The lock is released again when reading or checking fails.
   */
  static async openLocked(path: string, expectedId: string): Promise<PersistedLedger> {
    // A missing ledger is refused before the lock (which creates the parent directory), so nothing is left behind.
    try { await access(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("ledger_missing");
      throw error;
    }
    const probe = new PersistedLedger(path);
    await probe.lock();
    try { const persisted = await PersistedLedger.openExisting(path, expectedId); persisted.locked = true; return persisted; } catch (error) {
      await probe.release();
      throw error;
    }
  }

  /**
   * Takes the exclusive lock file `<ledger>.lock` (`open` with `wx`). A lock that is already there, held by another process or left by a
   * crash, is refused with `ledger_locked`; the operator removes a stale one. `release()` removes it again.
   */
  async lock(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    try { await (await open(`${this.path}.lock`, "wx", 0o600)).close(); } catch (error) {
      throw new Error((error as NodeJS.ErrnoException).code === "EEXIST" ? "ledger_locked" : "ledger_lock_failed");
    }
    this.locked = true;
  }

  async release(): Promise<void> {
    if (!this.locked) return;
    this.locked = false;
    await rm(`${this.path}.lock`, { force: true });
  }

  private replay(entry: LedgerEntry): void {
    if (entry.kind === "preflight") this.ledger.recordSpendOnly(entry.costUsd ?? 0);
    else this.ledger.record(entry.profile, entry.costUsd);
    this.entries.push(entry);
  }

  /** Saves the file with the new entry first and only then updates the in-memory state, so a failed save leaves both unchanged. */
  private async commit(entry: LedgerEntry): Promise<void> {
    if (!isValidCost(entry.costUsd)) throw new Error("invalid_cost");
    await this.write([...this.entries, entry]);
    this.replay(entry);
  }

  async record(runId: string, profile: ProfileId, costUsd: number | null): Promise<void> {
    await this.commit({ runId, profile, costUsd });
  }

  /**
   * An executed run without a trusted output charges the profile's current estimate, flagged (R41), or `atLeast` when the run unit
   * reported assistant usage that is higher (I3): a real cost is never lost.
   */
  async recordEstimate(runId: string, profile: ProfileId, atLeast = 0): Promise<void> {
    await this.commit({ runId, profile, costUsd: Math.max(this.ledger.estimate(profile), atLeast), estimated: true });
  }

  /** A preflight PONG: its cost (or the estimate, flagged, when it left no trusted output) is spend only (R54). */
  async recordPreflight(runId: string, profile: ProfileId, costUsd: number | null): Promise<void> {
    if (costUsd === null) await this.commit({ runId, profile, costUsd: this.ledger.estimate(profile), estimated: true, kind: "preflight" });
    else await this.commit({ runId, profile, costUsd, kind: "preflight" });
  }

  hasEntry(runId: string): boolean { return this.entries.some((entry) => entry.runId === runId); }

  /** True when a run (not a preflight PONG) was charged under this id, whether or not it left a record. */
  hasRunEntry(runId: string): boolean { return this.entries.some((entry) => entry.runId === runId && entry.kind !== "preflight"); }

  async save(): Promise<void> { await this.write(this.entries); }

  private async write(entries: readonly LedgerEntry[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const spentUsd = entries.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0);
    await writeFile(temporary, `${JSON.stringify({ ledgerId: this.id, limitUsd: BUDGET_USD, spentUsd, entries }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

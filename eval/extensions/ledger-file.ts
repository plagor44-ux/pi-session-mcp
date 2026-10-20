import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { BUDGET_USD, BudgetLedger } from "./budget.js";
import { profileIdSchema, type ProfileId } from "./schemas.js";

const entrySchema = z.object({
  runId: z.string().min(1), profile: profileIdSchema, costUsd: z.number().min(0).nullable(),
  /** Set when the run left no trusted output and the profile's current estimate stands in for its cost (R41). */
  estimated: z.literal(true).optional(),
}).strict();
/** The ledger file as `PersistedLedger` writes and replays it; the report validates the bytes it copies with the same schema. */
export const ledgerFileSchema = z.object({ ledgerId: z.string().uuid(), limitUsd: z.literal(BUDGET_USD), spentUsd: z.number().min(0), entries: z.array(entrySchema) }).strict();
/** A cost the ledger would reject; callers record null for it instead of recording twice. */
export const isValidCost = (cost: number | null): boolean => cost === null || (Number.isFinite(cost) && cost >= 0);
export type LedgerEntry = z.infer<typeof entrySchema>;

/** A ledger together with the entries that built it, so the file can be rewritten and replayed. */
export class PersistedLedger {
  readonly ledger = new BudgetLedger(BUDGET_USD);
  private readonly entries: LedgerEntry[] = [];
  /** Random id given at creation; the preflight records it so a wave can only continue the ledger its preflight wrote to (R37b). */
  id: string = randomUUID();
  constructor(private readonly path: string) {}

  /** Replays an earlier file (preflight, earlier waves, re-approvals) so all spend of the evaluation counts against one budget (R37). */
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
    for (const entry of parsed.data.entries) persisted.add(entry);
    return persisted;
  }

  private add(entry: LedgerEntry): void {
    this.ledger.record(entry.profile, entry.costUsd);
    this.entries.push(entry);
  }

  /** The cost is validated by the ledger before anything is stored, so a rejected cost leaves no entry; a failed save throws after the entry exists. */
  async record(runId: string, profile: ProfileId, costUsd: number | null): Promise<void> {
    this.add({ runId, profile, costUsd });
    await this.save();
  }

  /** An executed run without a trusted output: the profile's current estimate is charged and flagged, never dropped (R41). */
  async recordEstimate(runId: string, profile: ProfileId): Promise<void> {
    this.add({ runId, profile, costUsd: this.ledger.estimate(profile), estimated: true });
    await this.save();
  }

  hasEntry(runId: string): boolean { return this.entries.some((entry) => entry.runId === runId); }

  async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ ledgerId: this.id, limitUsd: BUDGET_USD, spentUsd: this.ledger.spentUsd, entries: this.entries }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

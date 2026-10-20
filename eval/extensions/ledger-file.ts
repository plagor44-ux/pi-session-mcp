import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { BUDGET_USD, BudgetLedger } from "./budget.js";
import { profileIdSchema, type ProfileId } from "./schemas.js";

const entrySchema = z.object({ runId: z.string().min(1), profile: profileIdSchema, costUsd: z.number().min(0).nullable() }).strict();
const ledgerFileSchema = z.object({ limitUsd: z.literal(BUDGET_USD), spentUsd: z.number().min(0), entries: z.array(entrySchema) }).strict();
export type LedgerEntry = z.infer<typeof entrySchema>;

/** A ledger together with the entries that built it, so the file can be rewritten and replayed. */
export class PersistedLedger {
  readonly ledger = new BudgetLedger(BUDGET_USD);
  private readonly entries: LedgerEntry[] = [];
  constructor(private readonly path: string) {}

  /** Replays an earlier file (for example the preflight's) so its spend counts against the same budget. */
  static async open(waveDir: string): Promise<PersistedLedger> {
    const persisted = new PersistedLedger(join(waveDir, "ledger.json"));
    let raw: string;
    try { raw = await readFile(persisted.path, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return persisted;
      throw error;
    }
    const parsed = ledgerFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error("ledger_file_invalid");
    for (const entry of parsed.data.entries) persisted.add(entry);
    return persisted;
  }

  private add(entry: LedgerEntry): void {
    this.ledger.record(entry.profile, entry.costUsd);
    this.entries.push(entry);
  }

  /** Records first, then writes the whole file; the cost is validated by the ledger before anything is stored. */
  async record(runId: string, profile: ProfileId, costUsd: number | null): Promise<void> {
    this.add({ runId, profile, costUsd });
    await this.save();
  }

  async save(): Promise<void> {
    await mkdir(join(this.path, ".."), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ limitUsd: BUDGET_USD, spentUsd: this.ledger.spentUsd, entries: this.entries }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { applyEvents, renderTaskMarkdown, validateLedger } from "./ledger.js";
import type { EventOutcome, LedgerEvent, RunLedger } from "./ledger.js";

/** Carries a stable code only; messages never contain paths. */
export class LedgerError extends Error {
  constructor(readonly code: string) { super(code); this.name = "LedgerError"; }
}
export interface LedgerStoreOptions { lockRetryMs?: number; lockTimeoutMs?: number }
export interface ApplyOptions { expectedRevision?: number }
export interface ApplyStoreResult { revision: number; outcomes: EventOutcome[] }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const errno = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | undefined)?.code;

export class LedgerStore {
  readonly #dir: string;
  readonly #retryMs: number;
  readonly #timeoutMs: number;
  constructor(dir: string, options: LedgerStoreOptions = {}) {
    this.#dir = dir;
    this.#retryMs = Math.max(1, options.lockRetryMs ?? 10);
    this.#timeoutMs = options.lockTimeoutMs ?? 5000;
  }
  get #run(): string { return join(this.#dir, "run.json"); }
  get #task(): string { return join(this.#dir, "task.md"); }
  get #lock(): string { return join(this.#dir, "run.json.lock"); }

  async init(ledger: RunLedger): Promise<void> {
    const v = validateLedger(ledger);
    if (!v.ok) throw new LedgerError("ledger_invalid");
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    await this.#locked(async () => {
      if (await readFile(this.#run).then(() => true, (e: unknown) => { if (errno(e) === "ENOENT") return false; throw e; })) throw new LedgerError("ledger_exists");
      await this.#write(ledger);
    });
  }

  async read(): Promise<RunLedger> {
    let text: string;
    try { text = await readFile(this.#run, "utf8"); } catch (e) { throw new LedgerError(errno(e) === "ENOENT" ? "ledger_missing" : "ledger_unreadable"); }
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new LedgerError("ledger_invalid"); }
    if (!validateLedger(value).ok) throw new LedgerError("ledger_invalid");
    return value as RunLedger;
  }

  /** Read a consistent snapshot under the same lock as writers; never creates a ledger directory. */
  async readLocked(): Promise<RunLedger> {
    return this.#locked(() => this.read());
  }

  async apply(events: readonly LedgerEvent[], options: ApplyOptions = {}): Promise<ApplyStoreResult> {
    return this.#locked(async () => {
      const current = await this.read();
      if (options.expectedRevision !== undefined && options.expectedRevision !== current.revision) throw new LedgerError("revision_conflict");
      const { ledger, outcomes } = applyEvents(current, events);
      if (!outcomes.some((o) => o.outcome === "applied")) return { revision: current.revision, outcomes };
      ledger.revision = current.revision + 1;
      if (!validateLedger(ledger).ok) throw new LedgerError("ledger_invalid");
      await this.#write(ledger);
      return { revision: ledger.revision, outcomes };
    });
  }

  // Exclusive create is the lock. A stale lock file is never broken automatically.
  async #locked<T>(fn: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + this.#timeoutMs;
    let delay = this.#retryMs;
    for (;;) {
      try {
        const handle = await open(this.#lock, "wx", 0o600);
        // The exclusive create succeeded, so this file is ours: a failed pid write must not leave it behind as a stale lock.
        try { await handle.writeFile(String(process.pid)); } catch (writeError) { await handle.close().catch(() => undefined); await rm(this.#lock, { force: true }); throw writeError; }
        await handle.close();
        break;
      } catch (e) {
        if (errno(e) === "ENOENT") throw new LedgerError("ledger_missing");
        if (errno(e) !== "EEXIST") throw new LedgerError("ledger_unreadable");
        if (Date.now() + delay > deadline) throw new LedgerError("ledger_locked");
        await sleep(delay);
        delay = Math.min(delay * 2, Math.max(100, this.#retryMs));
      }
    }
    try { return await fn(); } finally { await rm(this.#lock, { force: true }); }
  }

  async #write(ledger: RunLedger): Promise<void> {
    await this.#atomic(this.#run, JSON.stringify(ledger, null, 2) + "\n");
    await this.#atomic(this.#task, renderTaskMarkdown(ledger));
  }

  async #atomic(target: string, content: string): Promise<void> {
    const tmp = join(this.#dir, `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
    try {
      const handle = await open(tmp, "wx", 0o600);
      try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
      await rename(tmp, target);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    const dir = await open(this.#dir, "r").catch(() => undefined);
    if (dir) { await dir.sync().catch(() => undefined); await dir.close(); }
  }
}

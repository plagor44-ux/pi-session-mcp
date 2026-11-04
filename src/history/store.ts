import { closeSync, lstatSync, mkdirSync, openSync, type Stats } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { GAP_CODES, HISTORY_BUSY_TIMEOUT_MS, HISTORY_SCHEMA_VERSION, type GapCode } from "./constants.js";
import { MIGRATIONS } from "./schema.js";
import { loadSqlite } from "./sqlite.js";

export type { GapCode } from "./constants.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

/** A history failure with a stable gap code. Carries no path and no SQL text. */
export class HistoryStoreError extends Error {
  constructor(readonly code: GapCode) {
    super(code);
    this.name = "HistoryStoreError";
  }
}

export interface HistoryStore {
  readonly db: DatabaseSync;
  readonly readOnly: boolean;
  /** Runs `fn` inside `BEGIN IMMEDIATE … COMMIT`; rolls back and rethrows on failure. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

/**
 * The fixed location of the history file (design call 12): the account's home directory from the
 * password database plus `.local/state/pi-session-mcp/history/`. `HOME` and `XDG_STATE_HOME` do not
 * move it, so servers started by different controllers and the CLI open the same file.
 */
export function historyLocation(home: string = userInfo().homedir): { directory: string; file: string } {
  const directory = join(home, ".local", "state", "pi-session-mcp", "history");
  return { directory, file: join(directory, "history.sqlite") };
}

/** Maps a SQLite or store failure to a gap code. Extended result codes are reduced to their primary code. */
export function classifyStoreError(error: unknown): GapCode {
  if (error instanceof HistoryStoreError) return error.code;
  const errcode = typeof error === "object" && error !== null ? (error as { errcode?: unknown }).errcode : undefined;
  if (typeof errcode !== "number") return "history_unavailable";
  switch (errcode & 0xff) {
    case 5: case 6: return "history_locked";
    case 13: return "history_full";
    case 11: case 26: return "history_corrupt";
    default: return "history_unavailable";
  }
}

export function isGapCode(value: unknown): value is GapCode {
  return typeof value === "string" && (GAP_CODES as readonly string[]).includes(value);
}

function lstatOrUndefined(path: string): Stats | undefined {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function private_(stats: Stats, uid: number | undefined): boolean {
  return uid !== undefined && stats.uid === uid && (stats.mode & 0o077) === 0;
}

function verifyLocation(directory: string, file: string, uid: number | undefined, readOnly: boolean): void {
  let dir = lstatOrUndefined(directory);
  if (dir === undefined) {
    if (readOnly) throw new HistoryStoreError("history_unavailable");
    mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
    dir = lstatSync(directory);
  }
  if (!dir.isDirectory() || !private_(dir, uid)) throw new HistoryStoreError("history_unavailable");
  let stats = lstatOrUndefined(file);
  if (stats === undefined) {
    if (readOnly) throw new HistoryStoreError("history_unavailable");
    // `wx` refuses to follow or replace anything that appeared in between.
    closeSync(openSync(file, "wx", FILE_MODE));
    stats = lstatSync(file);
  }
  if (!stats.isFile() || !private_(stats, uid)) throw new HistoryStoreError("history_unavailable");
  for (const suffix of ["-wal", "-shm"]) {
    const side = lstatOrUndefined(file + suffix);
    if (side !== undefined && (!side.isFile() || !private_(side, uid))) throw new HistoryStoreError("history_unavailable");
  }
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
  return typeof row?.user_version === "number" ? row.user_version : 0;
}

function migrate(db: DatabaseSync): void {
  if (MIGRATIONS.length !== HISTORY_SCHEMA_VERSION) throw new HistoryStoreError("history_unavailable");
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = userVersion(db);
    if (current > HISTORY_SCHEMA_VERSION) throw new HistoryStoreError("history_unavailable");
    for (let version = current; version < HISTORY_SCHEMA_VERSION; version += 1) db.exec(MIGRATIONS[version]!);
    if (current !== HISTORY_SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${HISTORY_SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* no transaction left */ }
    throw error;
  }
}

/**
 * Opens the history file at its fixed location. A writable open creates the directory (0700) and
 * the file (0600) when missing; both opens refuse anything that is not a plain directory or file
 * owned by `uid` without group or other access, including the WAL and shared-memory files. A file
 * whose schema is newer than this binary is never written. Rejects only with `HistoryStoreError`.
 */
export async function openHistoryStore(options: { home?: string; uid?: number; readOnly?: boolean } = {}): Promise<HistoryStore> {
  const readOnly = options.readOnly === true;
  const uid = options.uid ?? process.getuid?.();
  const { directory, file } = historyLocation(options.home);
  let db: DatabaseSync | undefined;
  try {
    verifyLocation(directory, file, uid, readOnly);
    const { DatabaseSync: Database } = await loadSqlite();
    db = new Database(file, { readOnly });
    db.exec(`PRAGMA busy_timeout = ${HISTORY_BUSY_TIMEOUT_MS}`);
    if (readOnly) {
      if (userVersion(db) !== HISTORY_SCHEMA_VERSION) throw new HistoryStoreError("history_unavailable");
    } else {
      // Check before switching the journal mode, so a newer file is not touched at all.
      if (userVersion(db) > HISTORY_SCHEMA_VERSION) throw new HistoryStoreError("history_unavailable");
      db.exec("PRAGMA journal_mode = WAL");
      migrate(db);
    }
    db.exec("PRAGMA foreign_keys = ON");
    verifyLocation(directory, file, uid, true);
    return createStore(db, readOnly);
  } catch (error) {
    try { db?.close(); } catch { /* already closed */ }
    throw error instanceof HistoryStoreError ? error : new HistoryStoreError(classifyStoreError(error));
  }
}

function createStore(db: DatabaseSync, readOnly: boolean): HistoryStore {
  return {
    db,
    readOnly,
    transaction<T>(fn: () => T): T {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* the failure ended the transaction */ }
        throw error;
      }
    },
    close(): void {
      if (db.isOpen) db.close();
    },
  };
}

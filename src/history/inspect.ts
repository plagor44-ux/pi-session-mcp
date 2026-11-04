import { lstat } from "node:fs/promises";
import { loadSqlite } from "./sqlite.js";
import { historyLocation } from "./store.js";

/**
 * Offline facts about the history file for Doctor. `storage` covers ownership, modes and
 * symbolic links of the directory, the file and its WAL companions; the other fields are present
 * only when the file exists and its storage is sound.
 */
export interface HistoryInspection {
  readonly storage: "missing" | "ok" | "symlink" | "not_regular" | "bad_owner" | "bad_mode" | "unreadable";
  readonly schemaVersion?: number;
  readonly integrity?: "ok" | "failed";
  readonly recentGaps?: number;
}

const GAP_WINDOW_MS = 7 * 86_400_000;

function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"; }

async function entryProblem(path: string, kind: "directory" | "file", uid: number | undefined): Promise<HistoryInspection["storage"] | "absent"> {
  let info;
  try { info = await lstat(path); } catch (error) { return isMissing(error) ? "absent" : "unreadable"; }
  if (info.isSymbolicLink()) return "symlink";
  if (kind === "directory" ? !info.isDirectory() : !info.isFile()) return "not_regular";
  if (uid !== undefined && info.uid !== uid) return "bad_owner";
  if ((info.mode & (kind === "directory" ? 0o077 : 0o177)) !== 0) return "bad_mode";
  return "ok";
}

/** Reads the history file read-only; never creates it. `now` sets the seven-day gap window. */
export async function inspectHistory(home: string, uid: number | undefined, now: () => number = Date.now): Promise<HistoryInspection> {
  const { directory, file } = historyLocation(home);
  const directoryProblem = await entryProblem(directory, "directory", uid);
  if (directoryProblem === "absent") return { storage: "missing" };
  if (directoryProblem !== "ok") return { storage: directoryProblem };
  const fileProblem = await entryProblem(file, "file", uid);
  if (fileProblem === "absent") return { storage: "missing" };
  if (fileProblem !== "ok") return { storage: fileProblem };
  for (const companion of [`${file}-wal`, `${file}-shm`]) {
    const problem = await entryProblem(companion, "file", uid);
    if (problem !== "absent" && problem !== "ok") return { storage: problem };
  }
  let db;
  try {
    const { DatabaseSync } = await loadSqlite();
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    return { storage: "ok", integrity: "failed" };
  }
  try {
    const schemaVersion = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    let integrity: "ok" | "failed" = "failed";
    try {
      const rows = db.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
      integrity = rows.length === 1 && Object.values(rows[0]!)[0] === "ok" ? "ok" : "failed";
    } catch { integrity = "failed"; }
    if (integrity !== "ok" || schemaVersion < 1) return { storage: "ok", schemaVersion, integrity };
    let recentGaps: number | undefined;
    try {
      recentGaps = Number((db.prepare("SELECT count(*) AS n FROM gaps WHERE recorded_at >= ?").get(new Date(now() - GAP_WINDOW_MS).toISOString()) as { n: number }).n);
    } catch { recentGaps = undefined; }
    return { storage: "ok", schemaVersion, integrity, ...(recentGaps === undefined ? {} : { recentGaps }) };
  } catch {
    return { storage: "ok", integrity: "failed" };
  } finally {
    try { db.close(); } catch { /* read-only connection */ }
  }
}

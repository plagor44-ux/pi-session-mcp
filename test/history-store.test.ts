import { chmodSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { HISTORY_SCHEMA_VERSION } from "../src/history/constants.js";
import { loadSqlite } from "../src/history/sqlite.js";
import { classifyStoreError, historyLocation, HistoryStoreError, openHistoryStore, type HistoryStore } from "../src/history/store.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

const open: HistoryStore[] = [];
afterEach(() => { for (const store of open.splice(0)) { try { store.close(); } catch { /* already closed */ } } });

async function openStore(home: string, readOnly = false): Promise<HistoryStore> {
  const store = await openHistoryStore({ home, readOnly });
  open.push(store);
  return store;
}

async function rejectionCode(promise: Promise<unknown>): Promise<string | undefined> {
  try { await promise; } catch (error) { return error instanceof HistoryStoreError ? error.code : `not a HistoryStoreError: ${String(error)}`; }
  return undefined;
}

describe("history store", () => {
  it("creates directory 0700 and file 0600 at the fixed location", async () => {
    const home = await temporaryRoot("history-store-");
    const location = historyLocation(home);
    expect(location.file.endsWith(join(".local", "state", "pi-session-mcp", "history", "history.sqlite"))).toBe(true);
    expect(location.directory).toBe(join(home, ".local", "state", "pi-session-mcp", "history"));
    await openStore(home);
    expect(lstatSync(location.directory).mode & 0o777).toBe(0o700);
    expect(lstatSync(location.file).mode & 0o777).toBe(0o600);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(location.file + suffix)) expect(lstatSync(location.file + suffix).mode & 0o777).toBe(0o600);
    }
  });

  it("ignores HOME and XDG_STATE_HOME", async () => {
    const other = await temporaryRoot("history-env-");
    vi.stubEnv("HOME", other);
    vi.stubEnv("XDG_STATE_HOME", other);
    try {
      expect(historyLocation().file).toBe(join(userInfo().homedir, ".local", "state", "pi-session-mcp", "history", "history.sqlite"));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses a group-readable directory", async () => {
    const home = await temporaryRoot("history-mode-");
    const { directory } = historyLocation(home);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o750);
    expect(await rejectionCode(openHistoryStore({ home }))).toBe("history_unavailable");
  });

  it("refuses a symlinked file", async () => {
    const home = await temporaryRoot("history-link-");
    const { directory, file } = historyLocation(home);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = join(home, "elsewhere.sqlite");
    writeFileSync(target, "", { mode: 0o600 });
    symlinkSync(target, file);
    expect(await rejectionCode(openHistoryStore({ home }))).toBe("history_unavailable");
  });

  it("refuses a file owned by another uid", async () => {
    const home = await temporaryRoot("history-uid-");
    const own = process.getuid?.() ?? 0;
    expect(await rejectionCode(openHistoryStore({ home, uid: own + 1 }))).toBe("history_unavailable");
  });

  it("migrates an empty file to user_version 1", async () => {
    const home = await temporaryRoot("history-migrate-");
    const store = await openStore(home);
    expect(HISTORY_SCHEMA_VERSION).toBe(1);
    expect(store.db.prepare("PRAGMA user_version").get()).toEqual(expect.objectContaining({ user_version: 1 }));
    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
    expect(tables).toEqual(expect.arrayContaining(["entries", "gaps", "instances", "sessions", "turns", "verdicts"]));
    store.close();
    // A second open of a current file is a no-op migration.
    const again = await openStore(home);
    expect(again.db.prepare("PRAGMA user_version").get()).toEqual(expect.objectContaining({ user_version: 1 }));
  });

  it("refuses a newer schema without writing", async () => {
    const home = await temporaryRoot("history-newer-");
    const store = await openStore(home);
    store.db.exec("PRAGMA user_version = 2");
    store.close();
    const { file } = historyLocation(home);
    const before = readFileSync(file);
    expect(await rejectionCode(openHistoryStore({ home }))).toBe("history_unavailable");
    expect(await rejectionCode(openHistoryStore({ home, readOnly: true }))).toBe("history_unavailable");
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("two connections write concurrently", async () => {
    const home = await temporaryRoot("history-concurrent-");
    const first = await openStore(home);
    const second = await openStore(home);
    const insert = (store: HistoryStore, n: number) => store.transaction(() => {
      store.db.prepare("INSERT INTO gaps (session_id, code, recorded_at) VALUES (NULL, 'history_locked', ?)").run(`t${n}`);
    });
    for (let n = 0; n < 50; n += 1) { insert(first, n); insert(second, n + 50); }
    expect(first.db.prepare("SELECT count(*) AS n FROM gaps").get()).toEqual(expect.objectContaining({ n: 100 }));
  });

  it("read-only open does not migrate or write", async () => {
    const home = await temporaryRoot("history-ro-");
    (await openStore(home)).close();
    const store = await openStore(home, true);
    expect(() => store.db.exec("INSERT INTO gaps (session_id, code, recorded_at) VALUES (NULL, 'history_locked', 'x')")).toThrow();
    const { file } = historyLocation(home);
    if (existsSync(file + "-shm")) expect(lstatSync(file + "-shm").mode & 0o777).toBe(0o600);
  });

  it("read-only open of a missing file is history_unavailable and creates nothing", async () => {
    const home = await temporaryRoot("history-ro-missing-");
    expect(await rejectionCode(openHistoryStore({ home, readOnly: true }))).toBe("history_unavailable");
    expect(existsSync(historyLocation(home).directory)).toBe(false);
  });

  it("classifyStoreError maps SQLite codes", () => {
    const cases: Array<[unknown, string]> = [
      [{ errcode: 5 }, "history_locked"],
      [{ errcode: 261 }, "history_locked"],
      [{ errcode: 6 }, "history_locked"],
      [{ errcode: 13 }, "history_full"],
      [{ errcode: 11 }, "history_corrupt"],
      [{ errcode: 26 }, "history_corrupt"],
      [{ errcode: 14 }, "history_unavailable"],
      [new Error("other"), "history_unavailable"],
      [new HistoryStoreError("history_relay_invalid"), "history_relay_invalid"],
      [undefined, "history_unavailable"],
    ];
    for (const [error, code] of cases) expect(classifyStoreError(error)).toBe(code);
  });

  it("loadSqlite filters only the SQLite experimental warning", async () => {
    const original = process.emitWarning;
    const seen: string[] = [];
    const spy = vi.fn((warning: string | Error) => { seen.push(typeof warning === "string" ? warning : warning.message); });
    process.emitWarning = spy as unknown as typeof process.emitWarning;
    try {
      const sqlite = await loadSqlite(() => {
        process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");
        process.emitWarning("Something else", "ExperimentalWarning");
        process.emitWarning("SQLite is fine", "DeprecationWarning");
      });
      expect(typeof sqlite.DatabaseSync).toBe("function");
      expect(seen).toEqual(["Something else", "SQLite is fine"]);
      expect(process.emitWarning).toBe(spy);
    } finally {
      process.emitWarning = original;
    }
  });
});

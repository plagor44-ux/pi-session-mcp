import { mkdirSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../src/history/schema.js";
import { loadSqlite } from "../src/history/sqlite.js";
import { historyLocation, openHistoryStore, type HistoryStore } from "../src/history/store.js";
import { createRoutingStore, type DecisionInput } from "../src/routing/store.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);
const opened: HistoryStore[] = [];
afterEach(() => { for (const store of opened.splice(0)) store.close(); });
async function fresh(): Promise<HistoryStore> {
  const store = await openHistoryStore({ home: await temporaryRoot("routing-store-") });
  opened.push(store);
  return store;
}
const decision = (sessionRef: string, overrides: Partial<DecisionInput> = {}): DecisionInput => ({
  sessionRef, decidedAt: "2026-11-09T00:00:00.000Z", tier: "medium", role: "code", risk: "normal",
  profile: "profile", family: "family", origin: "floor", exploration: false, sameFamilyOverride: false, ...overrides,
});
function insertSession(store: HistoryStore): void {
  store.db.exec(`INSERT INTO instances (id, pid, package_version, started_at) VALUES ('i', 1, '1', 'now');
    INSERT INTO sessions (id, instance_id, public_session_id, workspace, execution_profile, package_version, configuration_fingerprint, created_at, capture_source)
    VALUES ('s', 'i', 'public', 'workspace', 'profile', '1', 'fingerprint', 'now', 'host')`);
}

describe("routing store", () => {
  it("migrates a version 1 file to version 2 and keeps its sessions", async () => {
    const home = await temporaryRoot("routing-migrate-");
    const { directory, file } = historyLocation(home);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(file);
    db.exec(MIGRATIONS[0]!);
    db.exec("PRAGMA user_version = 1");
    db.exec(`INSERT INTO instances (id, pid, package_version, started_at) VALUES ('i', 1, '1', 'now');
      INSERT INTO sessions (id, instance_id, public_session_id, workspace, execution_profile, package_version, configuration_fingerprint, created_at, capture_source)
      VALUES ('s', 'i', 'public', 'workspace', 'profile', '1', 'fingerprint', 'now', 'host')`);
    db.close();
    // SQLite creates the file with the process umask, so make it private like the history store.
    const { chmodSync } = await import("node:fs");
    chmodSync(file, 0o600);
    const store = await openHistoryStore({ home });
    opened.push(store);
    expect(store.db.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 2 });
    expect(store.db.prepare("SELECT id FROM sessions").get()).toMatchObject({ id: "s" });
  });

  it("keeps routing rows when prune deletes the session", async () => {
    const store = await fresh(); insertSession(store);
    createRoutingStore(store).recordDecision(decision("s"));
    store.db.exec("DELETE FROM sessions WHERE id = 's'");
    expect(store.db.prepare("SELECT count(*) AS n FROM routing_decisions").get()).toMatchObject({ n: 1 });
  });

  it("keeps at most 200 decisions per cell", async () => {
    const store = await fresh(); const routing = createRoutingStore(store);
    routing.recordDecision(decision("other", { role: "review" }));
    for (let i = 0; i < 205; i++) routing.recordDecision(decision(`s${i}`));
    const rows = store.db.prepare("SELECT session_ref FROM routing_decisions WHERE role = 'code' ORDER BY id").all();
    expect(rows).toHaveLength(200);
    expect(rows[0]).toMatchObject({ session_ref: "s5" });
    expect(store.db.prepare("SELECT count(*) AS n FROM routing_decisions WHERE role = 'review'").get()).toMatchObject({ n: 1 });
  });

  it("trims decisions with a null tier or role together", async () => {
    const store = await fresh(); const routing = createRoutingStore(store);
    for (let i = 0; i < 205; i++) routing.recordDecision(decision(`n${i}`, i % 2 ? { tier: null } : { role: null }));
    expect(store.db.prepare("SELECT count(*) AS n, min(id) AS first FROM routing_decisions").get()).toMatchObject({ n: 200, first: 6 });
  });

  it("keeps assigned decisions out of the unassigned pool", async () => {
    const store = await fresh(); const routing = createRoutingStore(store);
    for (let i = 0; i < 5; i++) routing.recordDecision(decision(`a${i}`));
    for (let i = 0; i < 205; i++) routing.recordDecision(decision(`n${i}`, { role: null }));
    expect(store.db.prepare("SELECT count(*) AS n FROM routing_decisions WHERE tier IS NOT NULL AND role IS NOT NULL").get()).toMatchObject({ n: 5 });
    expect(store.db.prepare("SELECT count(*) AS n FROM routing_decisions WHERE role IS NULL").get()).toMatchObject({ n: 200 });
  });

  it("stores no workspace or task column", async () => {
    const store = await fresh();
    const names = store.db.prepare("PRAGMA table_info(routing_decisions)").all().map((row) => row.name);
    expect(names).not.toContain("workspace"); expect(names).not.toContain("task");
  });

  it("returns undefined for a cell without a stored order", async () => {
    const store = await fresh(); const routing = createRoutingStore(store);
    expect(routing.currentOrder("low", "explore")).toBeUndefined();
    store.db.prepare("INSERT INTO routing_cells (tier, role, order_json, frozen) VALUES (?, ?, ?, 0)").run("low", "explore", '["a","b"]');
    expect(routing.currentOrder("low", "explore")).toEqual(["a", "b"]);
  });

  it("reports only unexpired suspensions", async () => {
    const store = await fresh();
    const insert = store.db.prepare("INSERT INTO routing_suspensions (profile, until, reason) VALUES (?, ?, 'failure')");
    insert.run("expired", "2026-11-08T00:00:00.000Z"); insert.run("equal", "2026-11-09T00:00:00.000Z"); insert.run("active", "2026-11-10T00:00:00.000Z");
    expect(createRoutingStore(store).suspendedProfiles(new Date("2026-11-09T00:00:00.000Z"))).toEqual(new Set(["active"]));
  });

  it("sums exploration spend and counts rows that are not settled", async () => {
    const store = await fresh(); const routing = createRoutingStore(store);
    routing.recordDecision(decision("paid", { exploration: true }));
    routing.recordDecision(decision("pending", { exploration: true }));
    routing.recordDecision(decision("other"));
    store.db.exec("UPDATE routing_decisions SET settled = 1, cost_usd = 1.5 WHERE session_ref = 'paid'");
    expect(routing.explorationSpend(new Date("2026-11-01T00:00:00.000Z"))).toEqual({ knownUsd: 1.5, costUnknown: false, pending: 1 });
    store.db.exec("UPDATE routing_decisions SET settled = 1 WHERE session_ref = 'pending'");
    expect(routing.explorationSpend(new Date("2026-11-01T00:00:00.000Z"))).toEqual({ knownUsd: 1.5, costUnknown: true, pending: 0 });
    expect(routing.explorationSpend(new Date("2026-12-01T00:00:00.000Z"))).toEqual({ knownUsd: 0, costUnknown: false, pending: 0 });
  });
});

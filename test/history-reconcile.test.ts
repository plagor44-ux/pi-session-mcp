import { readFileSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { defaultIsAlive, procStartOf, reconcileInstances } from "../src/history/reconcile.js";
import { openHistoryStore, type HistoryStore } from "../src/history/store.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);
const stores: HistoryStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

async function seeded(options: { pid: number; procStart: string | null; ended?: boolean }) {
  const home = await temporaryRoot("history-reconcile-");
  const store = await openHistoryStore({ home });
  stores.push(store);
  store.db.prepare("INSERT INTO instances (id, pid, proc_start, package_version, started_at, ended_at) VALUES ('i1', ?, ?, 'v', 't0', ?)").run(options.pid, options.procStart, options.ended ? "t9" : null);
  const session = store.db.prepare(`INSERT INTO sessions (id, instance_id, public_session_id, workspace, execution_profile, package_version, configuration_fingerprint, created_at, capture_source, closed_at)
    VALUES (?, 'i1', ?, 'repo', 'review', 'v', 'f', 't1', 'host', ?)`);
  session.run("open", "p-open", null);
  session.run("closed", "p-closed", "t5");
  store.db.prepare("INSERT INTO turns (session_id, turn_id, started_at, state, recorded) VALUES ('open', 'done', 't2', 'completed', 1)").run();
  store.db.prepare("INSERT INTO turns (session_id, turn_id, started_at, state, recorded) VALUES ('open', 'pending', 't3', 'running', 0)").run();
  return store;
}

const rows = (store: HistoryStore, sql: string) => store.db.prepare(sql).all() as Array<Record<string, unknown>>;

describe("history crash reconciliation", () => {
  it("marks sessions of a dead instance incomplete and the open turn unrecorded", async () => {
    const store = await seeded({ pid: 4_000_000, procStart: "1" });
    expect(reconcileInstances(store, () => false)).toBe(1);
    expect(rows(store, "SELECT id, completeness FROM sessions ORDER BY id")).toEqual([{ id: "closed", completeness: "complete" }, { id: "open", completeness: "incomplete" }]);
    expect(rows(store, "SELECT turn_id, state FROM turns ORDER BY turn_id")).toEqual([{ turn_id: "done", state: "completed" }, { turn_id: "pending", state: "unrecorded" }]);
    expect(rows(store, "SELECT ended_at IS NOT NULL AS ended FROM instances")).toEqual([{ ended: 1 }]);
    // A second run finds nothing left to do.
    expect(reconcileInstances(store, () => false)).toBe(0);
  });

  it("leaves sessions of a live instance alone", async () => {
    const store = await seeded({ pid: process.pid, procStart: null });
    expect(reconcileInstances(store, () => true)).toBe(0);
    expect(rows(store, "SELECT completeness FROM sessions WHERE id = 'open'")).toEqual([{ completeness: "complete" }]);
    expect(rows(store, "SELECT ended_at FROM instances")).toEqual([{ ended_at: null }]);
  });

  it("treats an instance that recorded its end as dead even if the pid is alive", async () => {
    const store = await seeded({ pid: process.pid, procStart: null, ended: true });
    expect(reconcileInstances(store, () => true)).toBe(1);
    expect(rows(store, "SELECT completeness FROM sessions WHERE id = 'open'")).toEqual([{ completeness: "incomplete" }]);
  });

  it.runIf(process.platform === "linux")("treats a reused pid with another proc start as dead", () => {
    const own = procStartOf(process.pid);
    expect(own).toBe(readFileSync("/proc/self/stat", "utf8").slice(readFileSync("/proc/self/stat", "utf8").lastIndexOf(")") + 2).split(" ")[19]);
    expect(defaultIsAlive(process.pid, own)).toBe(true);
    expect(defaultIsAlive(process.pid, "0")).toBe(false);
    expect(defaultIsAlive(4_000_000, null)).toBe(false);
  });
});

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { compilePathRule } from "../src/history/path-rule.js";
import { createHistoryRecorder, type HistoryRecorder } from "../src/history/recorder.js";
import { Redactor } from "../src/history/redact.js";
import { openHistoryStore, type HistoryStore } from "../src/history/store.js";
import type { HistoryPage } from "../src/pi-adapter.js";
import type { SessionView, TurnView } from "../src/session-registry.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

const stores: HistoryStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) { try { store.close(); } catch { /* closed */ } } });

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const view: SessionView = {
  id: SESSION_ID, workspace: "repo", executionProfile: "review", profile: "read-only", provider: "p", model: "m", thinkingLevel: "high",
  state: "idle", createdAt: "2026-11-04T10:00:00.000Z", updatedAt: "2026-11-04T10:00:00.000Z",
};
const turn = (n: number, state: TurnView["state"] = "completed"): TurnView => ({
  turnId: `2222222${n}-2222-4222-8222-222222222222`, sessionId: SESSION_ID, state,
  startedAt: "2026-11-04T10:00:01.000Z", updatedAt: "2026-11-04T10:00:02.000Z", completedAt: "2026-11-04T10:00:02.000Z",
  ...(state === "completed" ? { completion: "stop" as const } : {}),
});
const entry = (id: string, text = `text ${id}`) => ({ type: "message", id, parentId: null, timestamp: "2026-11-04T10:00:01.500Z", message: { role: "assistant", content: [{ type: "text", text }] } });
const header = { type: "session", version: 3, id: "sdk-1", timestamp: "2026-11-04T10:00:00.000Z", cwd: "/private/path" };

/** A reader over a fixed entry list that pages like the host handle. */
function reader(all: unknown[], calls: number[] = []) {
  return async (cursor: number): Promise<HistoryPage> => {
    calls.push(cursor);
    return { ...(cursor === 0 ? { header } : {}), entries: all.slice(cursor), next: all.length, more: false };
  };
}

async function setup(options: { wrap?: (store: HistoryStore) => HistoryStore } = {}) {
  const home = await temporaryRoot("history-recorder-");
  const store = await openHistoryStore({ home });
  stores.push(store);
  const diagnostics: string[] = [];
  const used = options.wrap ? options.wrap(store) : store;
  const recorder = createHistoryRecorder({
    store: used,
    redactorFor: () => new Redactor({ knownValues: [], pathRule: compilePathRule([]) }),
    configurationFingerprint: `sha256:${"a".repeat(64)}`,
    packageVersion: "0.0.0-test",
    instance: { pid: process.pid, procStart: null },
    diagnostic: (code) => diagnostics.push(code),
  });
  return { store, recorder, diagnostics, home };
}

const rows = (store: HistoryStore, sql: string, ...params: Array<string | number | null>) => store.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

function start(recorder: HistoryRecorder, overrides: Partial<{ task: string; source: "host" | "writer-relay" }> = {}) {
  recorder.sessionStarted({ view, sdkSessionId: "sdk-1", source: overrides.source ?? "host", ...(overrides.task === undefined ? {} : { task: overrides.task }) });
}

describe("history recorder", () => {
  it("writes session metadata, turn and entries in order", async () => {
    const { store, recorder } = await setup();
    start(recorder, { task: "#215" });
    const all = [entry("a"), entry("b"), entry("c")];
    const calls: number[] = [];
    recorder.turnStarted(SESSION_ID, { ...turn(1), state: "running" });
    recorder.turnEnded(SESSION_ID, turn(1), reader(all, calls));
    all.push(entry("d"), entry("e"), entry("f"));
    recorder.turnStarted(SESSION_ID, { ...turn(2), state: "running" });
    recorder.turnEnded(SESSION_ID, turn(2), reader(all, calls));
    await recorder.settle(SESSION_ID, 5_000);
    recorder.sessionClosed({ ...view, state: "closed" });
    expect(calls).toEqual([0, 3]);
    const [session] = rows(store, "SELECT * FROM sessions");
    expect(session).toMatchObject({
      public_session_id: SESSION_ID, workspace: "repo", execution_profile: "review", permission_profile: "read-only", provider: "p", model: "m",
      thinking_level: "high", task: "#215", capture_source: "host", completeness: "complete", sdk_session_id: "sdk-1", entry_cursor: 6,
      package_version: "0.0.0-test", final_state: "closed",
    });
    expect(session!.closed_at).toEqual(expect.any(String));
    expect(JSON.parse(String(session!.header_json))).toMatchObject({ type: "session", version: 3, id: "sdk-1" });
    expect(String(session!.header_json)).not.toContain("/private/path");
    const turns = rows(store, "SELECT turn_id, state, recorded, entry_count, completion FROM turns ORDER BY started_at, turn_id");
    expect(turns).toEqual([
      { turn_id: turn(1).turnId, state: "completed", recorded: 1, entry_count: 3, completion: "stop" },
      { turn_id: turn(2).turnId, state: "completed", recorded: 1, entry_count: 3, completion: "stop" },
    ]);
    const entries = rows(store, "SELECT position, pi_entry_id, turn_id, role, entry_type FROM entries ORDER BY position");
    expect(entries.map((row) => row.pi_entry_id)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(entries.map((row) => row.position)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(entries[3]).toMatchObject({ turn_id: turn(2).turnId, role: "assistant", entry_type: "message" });
  });

  it("stores only redacted entry JSON and counts the replacements", async () => {
    const { store, recorder } = await setup();
    start(recorder);
    const secret = `ghp_${"Qx7".repeat(12)}`;
    recorder.turnEnded(SESSION_ID, turn(1), reader([entry("a", `token ${secret}`)]));
    await recorder.settle(SESSION_ID, 5_000);
    const [row] = rows(store, "SELECT redacted_json, redactions FROM entries");
    expect(String(row!.redacted_json)).not.toContain(secret);
    expect(JSON.parse(String(row!.redactions))).toEqual({ github_token: 1 });
  });

  it("is idempotent on duplicate Pi entry ids", async () => {
    const { store, recorder } = await setup();
    start(recorder);
    recorder.turnEnded(SESSION_ID, turn(1), reader([entry("a"), entry("b"), entry("a")]));
    await recorder.settle(SESSION_ID, 5_000);
    expect(rows(store, "SELECT pi_entry_id FROM entries ORDER BY position").map((row) => row.pi_entry_id)).toEqual(["a", "b"]);
  });

  it("records a gap when a write fails and continues", async () => {
    let failNext = false;
    const { store, recorder } = await setup({
      wrap: (real) => ({
        db: real.db, readOnly: false, close: () => real.close(),
        transaction<T>(fn: () => T): T {
          if (failNext) { failNext = false; throw Object.assign(new Error("database is locked"), { errcode: 5 }); }
          return real.transaction(fn);
        },
      }),
    });
    start(recorder);
    await recorder.settle(SESSION_ID, 5_000);
    failNext = true;
    const all = [entry("a")];
    recorder.turnEnded(SESSION_ID, turn(1), reader(all));
    all.push(entry("b"));
    recorder.turnEnded(SESSION_ID, turn(2), reader(all));
    await recorder.settle(SESSION_ID, 5_000);
    expect(rows(store, "SELECT code, first_turn_id, last_turn_id FROM gaps")).toEqual([{ code: "history_locked", first_turn_id: turn(1).turnId, last_turn_id: turn(1).turnId }]);
    expect(rows(store, "SELECT completeness FROM sessions")).toEqual([{ completeness: "has_gaps" }]);
    expect(rows(store, "SELECT pi_entry_id, turn_id FROM entries")).toEqual([{ pi_entry_id: "b", turn_id: turn(2).turnId }]);
    expect(rows(store, "SELECT turn_id, recorded FROM turns WHERE recorded = 1")).toEqual([{ turn_id: turn(2).turnId, recorded: 1 }]);
  });

  it("emits one diagnostic when no gap can be written", async () => {
    const { store, recorder, diagnostics } = await setup();
    start(recorder);
    await recorder.settle(SESSION_ID, 5_000);
    store.close();
    recorder.turnEnded(SESSION_ID, turn(1), reader([entry("a", "ENTRY_TEXT_SENTINEL")]));
    await recorder.settle(SESSION_ID, 5_000);
    expect(diagnostics).toEqual(["history_unavailable"]);
  });

  it.each([
    ["an entry without an id", { entries: [{ type: "message", parentId: null, timestamp: "t" }], next: 1, more: false }],
    ["a next that does not match the entries", { entries: [entry("a")], next: 5, more: false }],
    ["a header of another session", { header: { ...header, id: "other" }, entries: [entry("a")], next: 1, more: false }],
    ["a non-array entries field", { entries: "x", next: 0, more: false }],
  ])("rejects %s as history_relay_invalid", async (_label, page) => {
    const { store, recorder } = await setup();
    start(recorder, { source: "writer-relay" });
    recorder.turnEnded(SESSION_ID, turn(1), async () => page as unknown as HistoryPage);
    await recorder.settle(SESSION_ID, 5_000);
    expect(rows(store, "SELECT code FROM gaps")).toEqual([{ code: "history_relay_invalid" }]);
    expect(rows(store, "SELECT count(*) AS n FROM entries")).toEqual([{ n: 0 }]);
    expect(rows(store, "SELECT capture_source, completeness FROM sessions")).toEqual([{ capture_source: "writer-relay", completeness: "has_gaps" }]);
  });

  it("settle gives up after its deadline and records a gap for the pending turn", async () => {
    const { store, recorder } = await setup();
    start(recorder);
    recorder.turnEnded(SESSION_ID, turn(1), () => new Promise<HistoryPage>(() => undefined));
    const started = performance.now();
    await recorder.settle(SESSION_ID, 100);
    expect(performance.now() - started).toBeLessThan(1_000);
    recorder.sessionClosed({ ...view, state: "closed" });
    expect(rows(store, "SELECT code, first_turn_id FROM gaps")).toEqual([{ code: "history_unavailable", first_turn_id: turn(1).turnId }]);
    expect(rows(store, "SELECT closed_at IS NOT NULL AS closed, completeness FROM sessions")).toEqual([{ closed: 1, completeness: "has_gaps" }]);
  });

  it("flush ends the instance and marks sessions without a recorded close incomplete", async () => {
    const { store, recorder } = await setup();
    start(recorder);
    await recorder.flush(1_000);
    expect(rows(store, "SELECT ended_at IS NOT NULL AS ended FROM instances")).toEqual([{ ended: 1 }]);
    expect(rows(store, "SELECT completeness FROM sessions")).toEqual([{ completeness: "incomplete" }]);
  });

  it("never throws, even for an unknown session or after the store closed", async () => {
    const { store, recorder } = await setup();
    store.close();
    expect(() => start(recorder)).not.toThrow();
    expect(() => recorder.turnStarted("unknown", turn(1))).not.toThrow();
    expect(() => recorder.turnEnded("unknown", turn(1), reader([]))).not.toThrow();
    expect(() => recorder.sessionClosed(view)).not.toThrow();
    await expect(recorder.settle("unknown", 10)).resolves.toBeUndefined();
    await expect(recorder.flush(10)).resolves.toBeUndefined();
  });
});

import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
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

async function setup(options: { wrap?: (store: HistoryStore) => HistoryStore; turnBufferBytes?: number; redactorFor?: () => Redactor } = {}) {
  const home = await temporaryRoot("history-recorder-");
  const store = await openHistoryStore({ home });
  stores.push(store);
  const diagnostics: string[] = [];
  const used = options.wrap ? options.wrap(store) : store;
  const recorder = createHistoryRecorder({
    store: used,
    redactorFor: options.redactorFor ?? (() => new Redactor({ knownValues: [], pathRule: compilePathRule([]) })),
    configurationFingerprint: `sha256:${"a".repeat(64)}`,
    packageVersion: "0.0.0-test",
    instance: { pid: process.pid, procStart: null },
    diagnostic: (code) => diagnostics.push(code),
    ...(options.turnBufferBytes === undefined ? {} : { turnBufferBytes: options.turnBufferBytes }),
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

  it("records a gap when the redactor fails mid-run and repairs it on the next read", async () => {
    let failRedactor = false;
    const { store, recorder } = await setup({
      redactorFor: () => {
        if (failRedactor) throw Object.assign(new Error("store"), { code: "provider_store_unavailable" });
        return new Redactor({ knownValues: [], pathRule: compilePathRule([]) });
      },
    });
    start(recorder);
    await recorder.settle(SESSION_ID, 5_000);
    failRedactor = true;
    const all = [entry("a")];
    recorder.turnEnded(SESSION_ID, turn(1), reader(all));
    await recorder.settle(SESSION_ID, 5_000);
    expect(rows(store, "SELECT code, first_turn_id FROM gaps")).toEqual([{ code: "history_unavailable", first_turn_id: turn(1).turnId }]);
    expect(rows(store, "SELECT completeness FROM sessions")).toEqual([{ completeness: "has_gaps" }]);
    expect(rows(store, "SELECT turn_id, recorded FROM turns")).toEqual([{ turn_id: turn(1).turnId, recorded: 0 }]);
    failRedactor = false;
    all.push({ ...entry("b"), timestamp: "2026-11-04T10:00:03.000Z" });
    recorder.turnEnded(SESSION_ID, { ...turn(2), completedAt: "2026-11-04T10:00:04.000Z" }, reader(all));
    await recorder.settle(SESSION_ID, 5_000);
    expect(rows(store, "SELECT code FROM gaps")).toEqual([]);
    expect(rows(store, "SELECT completeness FROM sessions")).toEqual([{ completeness: "complete" }]);
    expect(rows(store, "SELECT pi_entry_id, turn_id FROM entries ORDER BY position")).toEqual([
      { pi_entry_id: "a", turn_id: turn(1).turnId }, { pi_entry_id: "b", turn_id: turn(2).turnId },
    ]);
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

  it("rejects a host header of another session as history_unavailable", async () => {
    const { store, recorder } = await setup();
    start(recorder);
    recorder.turnEnded(SESSION_ID, turn(1), async () => ({ header: { ...header, id: "other" }, entries: [entry("a")], next: 1, more: false }));
    await recorder.settle(SESSION_ID, 5_000);
    expect(rows(store, "SELECT code FROM gaps")).toEqual([{ code: "history_unavailable" }]);
    expect(rows(store, "SELECT count(*) AS n FROM entries")).toEqual([{ n: 0 }]);
  });

  it("accepts a relayed header whose id is the inner Pi session id", async () => {
    const { store, recorder } = await setup();
    start(recorder, { source: "writer-relay" });
    recorder.turnEnded(SESSION_ID, turn(1), async () => ({ header: { ...header, id: "pi-inner" }, entries: [entry("a")], next: 1, more: false }));
    await recorder.settle(SESSION_ID, 5_000);
    expect(rows(store, "SELECT count(*) AS n FROM gaps")).toEqual([{ n: 0 }]);
    expect(JSON.parse(String(rows(store, "SELECT header_json FROM sessions")[0]!.header_json))).toMatchObject({ id: "pi-inner" });
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

  it("never stores a recognizable secret in metadata columns", async () => {
    const github = `ghp_${"A1b2C3d4".repeat(5)}`;
    const apiKey = `sk-${"Zx9".repeat(8)}`;
    const aws = "AKIAABCDEFGHIJKLMNOP";
    const slack = "xoxb-123456789012-abcdef";
    const { store, recorder } = await setup();
    recorder.sessionStarted({ view, sdkSessionId: aws, source: "writer-relay" });
    const page: HistoryPage = {
      header: { ...header, id: aws },
      entries: [
        { ...entry(github), parentId: null },
        { ...entry("child"), parentId: github },
        { type: "message", id: "tr", parentId: apiKey, timestamp: "2026-11-04T10:00:01.500Z", message: { role: "toolResult", toolCallId: "c", toolName: slack, content: [{ type: "text", text: "ok" }], isError: false } },
      ],
      next: 3, more: false,
    };
    recorder.turnEnded(SESSION_ID, turn(1), async () => page);
    await recorder.settle(SESSION_ID, 5_000);
    recorder.sessionClosed({ ...view, state: "closed" });
    const stored = JSON.stringify([rows(store, "SELECT * FROM sessions"), rows(store, "SELECT * FROM entries"), rows(store, "SELECT * FROM turns")]);
    for (const secret of [github, apiKey, aws, slack]) expect(stored).not.toContain(secret);
    // The parent link survives as the same surrogate.
    const links = rows(store, "SELECT pi_entry_id, parent_id FROM entries ORDER BY position");
    expect(links[1]!.parent_id).toBe(links[0]!.pi_entry_id);
    expect(rows(store, "SELECT count(*) AS n FROM gaps")).toEqual([{ n: 0 }]);
  });

  it("records a gap that could not be written once the store is writable again", async () => {
    let locked = false;
    const lockedError = () => Object.assign(new Error("database is locked"), { errcode: 5 });
    const { store, recorder, diagnostics } = await setup({
      wrap: (real) => {
        const db = new Proxy(real.db, {
          get(target, property) {
            if (property === "prepare" && locked) return () => { throw lockedError(); };
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
          },
        });
        return {
          db, readOnly: false, close: () => real.close(),
          transaction<T>(fn: () => T): T { if (locked) throw lockedError(); return real.transaction(fn); },
        };
      },
    });
    start(recorder);
    await recorder.settle(SESSION_ID, 5_000);
    locked = true;
    const all = [entry("a")];
    recorder.turnEnded(SESSION_ID, turn(1), reader(all));
    await recorder.settle(SESSION_ID, 5_000);
    expect(diagnostics).toEqual(["history_locked"]);
    locked = false;
    all.push(entry("b"));
    recorder.turnEnded(SESSION_ID, turn(2), reader(all));
    await recorder.settle(SESSION_ID, 5_000);
    recorder.sessionClosed({ ...view, state: "closed" });
    expect(rows(store, "SELECT code, first_turn_id FROM gaps")).toEqual([{ code: "history_locked", first_turn_id: turn(1).turnId }]);
    expect(rows(store, "SELECT completeness, final_state FROM sessions")).toEqual([{ completeness: "has_gaps", final_state: "closed" }]);
  });

  it("keeps the truncation flag of an entry the relay already cut", async () => {
    const { store, recorder } = await setup();
    start(recorder, { source: "writer-relay" });
    recorder.turnEnded(SESSION_ID, turn(1), async () => ({ entries: [entry("a"), entry("b", "[TRUNCATED:2097152]")], truncated: [1], next: 2, more: false }));
    await recorder.settle(SESSION_ID, 5_000);
    expect(rows(store, "SELECT pi_entry_id, truncated FROM entries ORDER BY position")).toEqual([{ pi_entry_id: "a", truncated: 0 }, { pi_entry_id: "b", truncated: 1 }]);
  });

  it.each([
    ["an index outside the page", [2]],
    ["a negative index", [-1]],
    ["a non-array value", "1"],
  ])("rejects a relay truncation list with %s", async (_label, truncated) => {
    const { store, recorder } = await setup();
    start(recorder, { source: "writer-relay" });
    recorder.turnEnded(SESSION_ID, turn(1), async () => ({ entries: [entry("a"), entry("b")], truncated, next: 2, more: false }) as unknown as HistoryPage);
    await recorder.settle(SESSION_ID, 5_000);
    expect(rows(store, "SELECT code FROM gaps")).toEqual([{ code: "history_relay_invalid" }]);
  });

  describe("a failed page read", () => {
    const later = (id: string, second: number) => ({ ...entry(id), timestamp: `2026-11-04T10:00:${String(second).padStart(2, "0")}.000Z` });
    const ended = (n: number, second: number): TurnView => ({ ...turn(n), completedAt: `2026-11-04T10:00:${String(second).padStart(2, "0")}.000Z` });
    const failing = async (): Promise<HistoryPage> => { throw new Error("read failed"); };

    it("is repaired by the next read: entries keep their turn and the gap goes", async () => {
      const { store, recorder, diagnostics } = await setup();
      start(recorder, { source: "writer-relay" });
      recorder.turnEnded(SESSION_ID, ended(1, 2), failing);
      await recorder.settle(SESSION_ID, 5_000);
      expect(rows(store, "SELECT code, first_turn_id FROM gaps")).toEqual([{ code: "history_relay_invalid", first_turn_id: turn(1).turnId }]);
      expect(rows(store, "SELECT completeness FROM sessions")).toEqual([{ completeness: "has_gaps" }]);
      recorder.turnEnded(SESSION_ID, ended(2, 6), reader([later("a", 1), later("b", 2), later("c", 5)]));
      await recorder.settle(SESSION_ID, 5_000);
      expect(rows(store, "SELECT pi_entry_id, turn_id FROM entries ORDER BY position")).toEqual([
        { pi_entry_id: "a", turn_id: turn(1).turnId }, { pi_entry_id: "b", turn_id: turn(1).turnId }, { pi_entry_id: "c", turn_id: turn(2).turnId },
      ]);
      expect(rows(store, "SELECT turn_id, entry_count, recorded FROM turns ORDER BY started_at, turn_id")).toEqual([
        { turn_id: turn(1).turnId, entry_count: 2, recorded: 1 }, { turn_id: turn(2).turnId, entry_count: 1, recorded: 1 },
      ]);
      expect(rows(store, "SELECT count(*) AS n FROM gaps")).toEqual([{ n: 0 }]);
      expect(rows(store, "SELECT completeness FROM sessions")).toEqual([{ completeness: "complete" }]);
      expect(diagnostics).toEqual([]);
    });

    it("removes a gap written before the session row existed once its entries arrive", async () => {
      let refuseSession = true;
      const { store, recorder } = await setup({
        wrap: (real) => ({
          db: new Proxy(real.db, {
            get(target, property) {
              const value = Reflect.get(target, property, target) as unknown;
              if (property !== "prepare") return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
              return (sql: string) => {
                if (refuseSession && sql.startsWith("INSERT INTO sessions")) throw Object.assign(new Error("database is locked"), { errcode: 5 });
                return target.prepare(sql);
              };
            },
          }),
          readOnly: false, close: () => real.close(),
          transaction: <T,>(fn: () => T): T => real.transaction(fn),
        }),
      });
      start(recorder, { source: "writer-relay" });
      recorder.turnEnded(SESSION_ID, ended(1, 2), failing);
      await recorder.settle(SESSION_ID, 5_000);
      expect(rows(store, "SELECT session_id, first_turn_id FROM gaps WHERE first_turn_id IS NOT NULL")).toEqual([{ session_id: null, first_turn_id: turn(1).turnId }]);
      refuseSession = false;
      recorder.turnEnded(SESSION_ID, ended(2, 6), reader([later("a", 1)]));
      await recorder.settle(SESSION_ID, 5_000);
      expect(rows(store, "SELECT turn_id FROM entries")).toEqual([{ turn_id: turn(1).turnId }]);
      expect(rows(store, "SELECT count(*) AS n FROM gaps WHERE first_turn_id IS NOT NULL")).toEqual([{ n: 0 }]);
    });

    it("gives an entry with an unreadable timestamp to the later turn", async () => {
      const { store, recorder } = await setup();
      start(recorder, { source: "writer-relay" });
      recorder.turnEnded(SESSION_ID, ended(1, 2), failing);
      recorder.turnEnded(SESSION_ID, ended(2, 6), reader([{ ...entry("a"), timestamp: "2026" + "1104" }]));
      await recorder.settle(SESSION_ID, 5_000);
      expect(rows(store, "SELECT turn_id FROM entries")).toEqual([{ turn_id: turn(2).turnId }]);
    });

    it("keeps the gaps while reads keep failing", async () => {
      const { store, recorder } = await setup();
      start(recorder, { source: "writer-relay" });
      recorder.turnEnded(SESSION_ID, ended(1, 2), failing);
      recorder.turnEnded(SESSION_ID, ended(2, 4), failing);
      await recorder.settle(SESSION_ID, 5_000);
      recorder.sessionClosed({ ...view, state: "closed" });
      expect(rows(store, "SELECT code FROM gaps")).toEqual([{ code: "history_relay_invalid" }, { code: "history_relay_invalid" }]);
      expect(rows(store, "SELECT completeness FROM sessions")).toEqual([{ completeness: "has_gaps" }]);
    });

    it("keeps its gap when the repairing write fails, because the entries are then lost", async () => {
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
      start(recorder, { source: "writer-relay" });
      recorder.turnEnded(SESSION_ID, ended(1, 2), failing);
      await recorder.settle(SESSION_ID, 5_000);
      failNext = true;
      const all = [later("a", 1), later("c", 5)];
      recorder.turnEnded(SESSION_ID, ended(2, 6), reader(all));
      await recorder.settle(SESSION_ID, 5_000);
      all.push(later("d", 7));
      const calls: number[] = [];
      recorder.turnEnded(SESSION_ID, ended(3, 8), reader(all, calls));
      await recorder.settle(SESSION_ID, 5_000);
      expect(calls).toEqual([2]);
      expect(rows(store, "SELECT code, first_turn_id FROM gaps ORDER BY id")).toEqual([
        { code: "history_relay_invalid", first_turn_id: turn(1).turnId }, { code: "history_locked", first_turn_id: turn(2).turnId },
      ]);
      expect(rows(store, "SELECT pi_entry_id, turn_id FROM entries")).toEqual([{ pi_entry_id: "d", turn_id: turn(3).turnId }]);
      expect(rows(store, "SELECT completeness FROM sessions")).toEqual([{ completeness: "has_gaps" }]);
    });
  });

  describe("a turn longer than the write buffer", () => {
    const filler = (id: string) => entry(id, "x".repeat(600));
    function paged(all: unknown[], calls: number[] = [], bad?: number) {
      return async (cursor: number): Promise<HistoryPage> => {
        calls.push(cursor);
        if (cursor === bad) return { entries: "nope", next: 0, more: false } as unknown as HistoryPage;
        return { entries: all.slice(cursor, cursor + 1), next: cursor + 1, more: cursor + 1 < all.length };
      };
    }
    const counting = (seen: { transactions: number }) => (real: HistoryStore): HistoryStore => ({
      db: real.db, readOnly: false, close: () => real.close(),
      transaction<T>(fn: () => T): T { seen.transactions += 1; return real.transaction(fn); },
    });

    it("is written in several transactions and loses nothing", async () => {
      const seen = { transactions: 0 };
      const { store, recorder } = await setup({ wrap: counting(seen), turnBufferBytes: 1_000 });
      start(recorder, { source: "writer-relay" });
      await recorder.settle(SESSION_ID, 5_000);
      const all = ["a", "b", "c", "d", "e"].map(filler);
      recorder.turnEnded(SESSION_ID, turn(1), paged(all));
      await recorder.settle(SESSION_ID, 5_000);
      expect(seen.transactions).toBeGreaterThan(1);
      expect(rows(store, "SELECT pi_entry_id, position FROM entries ORDER BY position")).toEqual(["a", "b", "c", "d", "e"].map((pi_entry_id, position) => ({ pi_entry_id, position })));
      expect(rows(store, "SELECT entry_count, recorded FROM turns")).toEqual([{ entry_count: 5, recorded: 1 }]);
      expect(rows(store, "SELECT entry_cursor, completeness FROM sessions")).toEqual([{ entry_cursor: 5, completeness: "complete" }]);
    });

    it("stays one transaction below the buffer", async () => {
      const seen = { transactions: 0 };
      const { recorder } = await setup({ wrap: counting(seen) });
      start(recorder, { source: "writer-relay" });
      await recorder.settle(SESSION_ID, 5_000);
      recorder.turnEnded(SESSION_ID, turn(1), paged(["a", "b", "c"].map(filler)));
      await recorder.settle(SESSION_ID, 5_000);
      expect(seen.transactions).toBe(1);
    });

    it("keeps what it wrote when a later page fails, and the next read continues there", async () => {
      const { store, recorder } = await setup({ turnBufferBytes: 1_000 });
      start(recorder, { source: "writer-relay" });
      const all = ["a", "b", "c", "d"].map(filler);
      recorder.turnEnded(SESSION_ID, turn(1), paged(all, [], 3));
      await recorder.settle(SESSION_ID, 5_000);
      const written = rows(store, "SELECT pi_entry_id FROM entries ORDER BY position").map((row) => row.pi_entry_id);
      expect(written.length).toBeGreaterThan(0);
      expect(written.length).toBeLessThan(4);
      expect(rows(store, "SELECT code FROM gaps")).toEqual([{ code: "history_relay_invalid" }]);
      expect(rows(store, "SELECT entry_count, recorded FROM turns")).toEqual([{ entry_count: written.length, recorded: 0 }]);
      const calls: number[] = [];
      recorder.turnEnded(SESSION_ID, { ...turn(2), completedAt: "2026-11-04T10:00:09.000Z" }, paged(all, calls));
      await recorder.settle(SESSION_ID, 5_000);
      expect(calls[0]).toBe(written.length);
      expect(rows(store, "SELECT pi_entry_id, turn_id FROM entries ORDER BY position").map((row) => row.pi_entry_id)).toEqual(["a", "b", "c", "d"]);
      expect(rows(store, "SELECT DISTINCT turn_id FROM entries")).toEqual([{ turn_id: turn(1).turnId }]);
      expect(rows(store, "SELECT count(*) AS n FROM gaps")).toEqual([{ n: 0 }]);
    });

    it("does not keep a page's raw content while it buffers the turn", async () => {
      setFlagsFromString("--expose-gc");
      const collect = runInNewContext("gc") as () => void;
      const { recorder } = await setup();
      start(recorder, { source: "writer-relay" });
      let raw: WeakRef<object> | undefined;
      let released: boolean | undefined;
      const imagePage = (cursor: number): HistoryPage => {
        const message = { role: "user", content: [{ type: "image", data: "A".repeat(4_096), mimeType: "image/png" }] };
        if (cursor === 1) raw = new WeakRef(message);
        return { entries: [{ type: "message", id: `i${cursor}`, parentId: null, timestamp: "2026-11-04T10:00:01.500Z", message }], next: cursor + 1, more: cursor < 2 };
      };
      recorder.turnEnded(SESSION_ID, turn(1), async (cursor) => {
        if (cursor === 2) {
          await new Promise((done) => setImmediate(done));
          collect();
          await new Promise((done) => setImmediate(done));
          collect();
          released = raw!.deref() === undefined;
        }
        return imagePage(cursor);
      });
      await recorder.settle(SESSION_ID, 5_000);
      expect(released).toBe(true);
    });

    it("rolls the tool-call index back with the cursor, so a reread keeps the path rule", async () => {
      const call = (id: string, path: string, pad = "") => ({ type: "message", id, parentId: null, timestamp: "2026-11-04T10:00:01.500Z", message: { role: "assistant", content: [{ type: "text", text: pad }, { type: "toolCall", id: "c", name: "read", arguments: { path } }] } });
      const result = { type: "message", id: "r", parentId: null, timestamp: "2026-11-04T10:00:01.500Z", message: { role: "toolResult", toolCallId: "c", toolName: "read", content: [{ type: "text", text: "UNRECOGNIZABLE_VALUE_ZZZ" }], isError: false } };
      const all = [call("protected", ".env", "x".repeat(1_200)), result, call("reuse", "README.md")];
      const { store, recorder } = await setup({ turnBufferBytes: 1_000 });
      start(recorder, { source: "writer-relay" });
      recorder.turnEnded(SESSION_ID, turn(1), paged([...all, call("unread", "notes.txt")], [], 3));
      await recorder.settle(SESSION_ID, 5_000);
      expect(rows(store, "SELECT pi_entry_id FROM entries")).toEqual([{ pi_entry_id: "protected" }]);
      recorder.turnEnded(SESSION_ID, { ...turn(2), completedAt: "2026-11-04T10:00:09.000Z" }, async (cursor) => ({ entries: all.slice(cursor), next: all.length, more: false }));
      await recorder.settle(SESSION_ID, 5_000);
      const stored = rows(store, "SELECT redacted_json, dropped_by_path FROM entries WHERE pi_entry_id = 'r'");
      expect(stored).toHaveLength(1);
      expect(stored[0]!.dropped_by_path).toBe(1);
      expect(String(stored[0]!.redacted_json)).not.toContain("UNRECOGNIZABLE_VALUE_ZZZ");
    });

    it("stops a page source that never ends at the per-turn bound", async () => {
      const { store, recorder } = await setup();
      start(recorder, { source: "writer-relay" });
      let calls = 0;
      recorder.turnEnded(SESSION_ID, turn(1), async (cursor) => { calls += 1; return { entries: [entry(`e${cursor}`)], next: cursor + 1, more: true }; });
      await recorder.settle(SESSION_ID, 30_000);
      expect(calls).toBe(4_096);
      expect(rows(store, "SELECT code FROM gaps")).toEqual([{ code: "history_relay_invalid" }]);
    });
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

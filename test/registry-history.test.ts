import { afterAll, afterEach, describe, expect, it } from "vitest";
import { HISTORY_RELAY_PAGE_BYTES, HISTORY_SETTLE_DEADLINE_MS } from "../src/history/constants.js";
import { compilePathRule } from "../src/history/path-rule.js";
import { createHistoryRecorder, type HistoryRecorder } from "../src/history/recorder.js";
import { Redactor } from "../src/history/redact.js";
import { openHistoryStore, type HistoryStore } from "../src/history/store.js";
import { SessionRegistry } from "../src/session-registry.js";
import { FakeAdapter } from "./fake-adapter.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const profile = { alias: "safe", permissionProfile: "read-only" as const, provider: "fake-provider", model: "fake-model", thinkingLevel: "off" as const };
const entry = (id: string) => ({ type: "message", id, parentId: null, timestamp: "2026-11-04T10:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text: id }] } });

async function setup(history?: HistoryRecorder) {
  let store: HistoryStore | undefined;
  let recorder = history;
  if (recorder === undefined) {
    store = await openHistoryStore({ home: await temporaryRoot("registry-history-") });
    const opened = store;
    cleanups.push(() => opened.close());
    recorder = createHistoryRecorder({
      store, redactorFor: () => new Redactor({ knownValues: [], pathRule: compilePathRule([]) }),
      configurationFingerprint: `sha256:${"a".repeat(64)}`, packageVersion: "0.0.0-test",
      instance: { pid: process.pid, procStart: null }, diagnostic: () => undefined,
    });
  }
  const adapter = new FakeAdapter();
  const registry = new SessionRegistry(adapter, new Map([["repo", "/safe/repo"]]), { abortDeadlineMs: 200, closeCleanupDeadlineMs: 200, history: recorder });
  cleanups.push(() => registry.shutdown());
  const rows = (sql: string) => store!.db.prepare(sql).all() as Array<Record<string, unknown>>;
  return { adapter, registry, store, rows, recorder };
}

async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const end = performance.now() + ms;
  while (!check()) { if (performance.now() > end) throw new Error("condition not reached"); await new Promise((resolve) => setTimeout(resolve, 5)); }
}

describe("registry history capture", () => {
  it("records a completed turn with its entries and the session close", async () => {
    const s = await setup();
    const session = await s.registry.start("repo", profile, { task: "sprint-18/pkg-2" });
    const handle = s.adapter.handles[0]!;
    handle.history.push(entry("a"), entry("b"));
    const { turn } = await s.registry.prompt(session.id, "go");
    handle.complete("done");
    await until(() => s.rows("SELECT * FROM entries").length === 2);
    await s.registry.close(session.id);
    expect(s.rows("SELECT task, closed_at IS NOT NULL AS closed, final_state, completeness FROM sessions")).toEqual([{ task: "sprint-18/pkg-2", closed: 1, final_state: "closed", completeness: "complete" }]);
    expect(s.rows("SELECT turn_id, state, recorded FROM turns")).toEqual([{ turn_id: turn.turnId, state: "completed", recorded: 1 }]);
  });

  it("aborted and deadline turns are recorded", async () => {
    const s = await setup();
    const session = await s.registry.start("repo", profile);
    const { turn: aborted } = await s.registry.prompt(session.id, "go");
    await s.registry.abort(session.id);
    const deadlineSession = await s.registry.start("repo", { ...profile, maxTurnSeconds: 1 });
    const { turn: deadline } = await s.registry.prompt(deadlineSession.id, "go");
    await until(() => s.rows("SELECT * FROM turns WHERE recorded = 1").length === 2, 4_000);
    const turns = Object.fromEntries(s.rows("SELECT turn_id, state, abort_reason FROM turns").map((row) => [row.turn_id, row]));
    expect(turns[aborted.turnId]).toMatchObject({ state: "aborted", abort_reason: null });
    expect(turns[deadline.turnId]).toMatchObject({ state: "aborted", abort_reason: "deadline" });
  });

  it("history failure never changes the turn outcome", async () => {
    const thrower = (): never => { throw new Error("history broke"); };
    const broken: HistoryRecorder = {
      sessionStarted: thrower, turnStarted: thrower, turnEnded: thrower, sessionClosed: thrower,
      settle: () => Promise.reject(new Error("history broke")), flush: () => Promise.reject(new Error("history broke")),
    };
    const outcomes = [];
    for (const history of [broken, undefined]) {
      const adapter = new FakeAdapter();
      const registry = new SessionRegistry(adapter, new Map([["repo", "/safe/repo"]]), history === undefined ? {} : { history });
      const session = await registry.start("repo", profile);
      const { turn } = await registry.prompt(session.id, "go");
      adapter.handles[0]!.complete("same text");
      await until(() => registry.getTurn(session.id, turn.turnId).state !== "running");
      const { turnId: _turnId, sessionId: _sessionId, startedAt: _s, updatedAt: _u, completedAt: _c, ...result } = registry.getTurn(session.id, turn.turnId);
      const closed = await registry.close(session.id);
      await registry.shutdown();
      outcomes.push({ result, closed: closed.state });
    }
    expect(outcomes[0]).toEqual(outcomes[1]);
    expect(outcomes[0]).toMatchObject({ result: { state: "completed", assistantText: "same text" }, closed: "closed" });
  });

  it("close waits for a pending write up to the settle deadline", async () => {
    const s = await setup();
    const session = await s.registry.start("repo", profile);
    const handle = s.adapter.handles[0]!;
    handle.history.push(entry("slow"));
    let release!: () => void;
    handle.historyGate = new Promise<void>((resolve) => { release = resolve; });
    await s.registry.prompt(session.id, "go");
    handle.complete();
    setTimeout(() => release(), 200);
    await s.registry.close(session.id);
    expect(s.rows("SELECT pi_entry_id FROM entries")).toEqual([{ pi_entry_id: "slow" }]);
    expect(s.rows("SELECT count(*) AS n FROM gaps")).toEqual([{ n: 0 }]);
  });

  it("close returns within the settle deadline when a history read never resolves", async () => {
    const s = await setup();
    const session = await s.registry.start("repo", profile);
    const handle = s.adapter.handles[0]!;
    handle.historyGate = new Promise<void>(() => undefined);
    await s.registry.prompt(session.id, "go");
    handle.complete();
    const started = performance.now();
    const closed = await s.registry.close(session.id);
    expect(performance.now() - started).toBeLessThan(HISTORY_SETTLE_DEADLINE_MS + 500);
    expect(closed.state).toBe("closed");
    expect(s.rows("SELECT code FROM gaps")).toEqual([{ code: "history_unavailable" }]);
    expect(s.rows("SELECT closed_at IS NOT NULL AS closed, completeness FROM sessions")).toEqual([{ closed: 1, completeness: "has_gaps" }]);
  }, HISTORY_SETTLE_DEADLINE_MS + 5_000);

  it("shutdown records the aborted turn and the close", async () => {
    const s = await setup();
    const session = await s.registry.start("repo", profile);
    const handle = s.adapter.handles[0]!;
    handle.history.push(entry("mid"));
    const { turn } = await s.registry.prompt(session.id, "go");
    await s.registry.shutdown();
    expect(s.rows("SELECT closed_at IS NOT NULL AS closed, completeness FROM sessions")).toEqual([{ closed: 1, completeness: expect.stringMatching(/^(complete|has_gaps)$/) }]);
    expect(s.rows("SELECT turn_id, state FROM turns")).toEqual([{ turn_id: turn.turnId, state: "aborted" }]);
    expect(s.rows("SELECT ended_at IS NOT NULL AS ended FROM instances")).toEqual([{ ended: 1 }]);
  });

  it("records a gap for a turn of a handle without readHistory", async () => {
    const s = await setup();
    const session = await s.registry.start("repo", profile);
    const handle = s.adapter.handles[0]!;
    (handle as { readHistory?: unknown }).readHistory = undefined;
    await s.registry.prompt(session.id, "go");
    handle.complete();
    await s.registry.close(session.id);
    expect(s.rows("SELECT recorded FROM turns")).toEqual([{ recorded: 0 }]);
    expect(s.rows("SELECT count(*) AS n FROM entries")).toEqual([{ n: 0 }]);
    expect(s.rows("SELECT code FROM gaps")).toEqual([{ code: "history_unavailable" }]);
    expect(s.rows("SELECT completeness FROM sessions")).toEqual([{ completeness: "has_gaps" }]);
  });
  it("historyPage pages by byte budget", async () => {
    const adapter = new FakeAdapter();
    const registry = new SessionRegistry(adapter, new Map([["repo", "/safe/repo"]]));
    const session = await registry.start("repo", profile);
    adapter.handles[0]!.history.push(...Array.from({ length: 30 }, (_, n) => ({ ...entry(`e${n}`), blob: "y".repeat(40 * 1024) })));
    const seen: string[] = [];
    let cursor = 0;
    for (let guard = 0; guard < 30; guard += 1) {
      const page = await registry.historyPage(session.id, cursor, HISTORY_RELAY_PAGE_BYTES);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(HISTORY_RELAY_PAGE_BYTES);
      expect(page.next).toBe(cursor + page.entries.length);
      seen.push(...page.entries.map((value) => (value as { id: string }).id));
      cursor = page.next;
      if (!page.more) break;
    }
    expect(seen).toEqual(Array.from({ length: 30 }, (_, n) => `e${n}`));
    await registry.shutdown();
  });

  it("historyPage truncates one oversized entry instead of failing", async () => {
    const adapter = new FakeAdapter();
    const registry = new SessionRegistry(adapter, new Map([["repo", "/safe/repo"]]));
    const session = await registry.start("repo", profile);
    adapter.handles[0]!.history.push({ ...entry("big"), blob: "z".repeat(2 * 1024 * 1024) }, entry("after"));
    const first = await registry.historyPage(session.id, 0, HISTORY_RELAY_PAGE_BYTES);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(HISTORY_RELAY_PAGE_BYTES);
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0]).toMatchObject({ id: "big", type: "message" });
    expect(JSON.stringify(first.entries[0])).toContain("[TRUNCATED:");
    expect(first).toMatchObject({ next: 1, more: true });
    const second = await registry.historyPage(session.id, first.next, HISTORY_RELAY_PAGE_BYTES);
    expect(second.entries.map((value) => (value as { id: string }).id)).toEqual(["after"]);
    expect(second.more).toBe(false);
    await registry.shutdown();
  });
});

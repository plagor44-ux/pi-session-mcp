import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { applyEvent, applyEvents, createLedger, renderTaskMarkdown, validateEvent, validateLedger } from "../eval/bridge/ledger.js";
import type { EventSource, LedgerEvent, LedgerEventType, RunLedger } from "../eval/bridge/ledger.js";
import { runCli } from "../eval/bridge/ledger-cli.js";
import { LedgerStore } from "../eval/bridge/ledger-store.js";

const run = promisify(execFile);
const BASE = Date.parse("2026-10-21T10:00:00.000Z");
const ts = (k: number): string => new Date(BASE + k * 1000).toISOString();
const sha = (text: string): `sha256:${string}` => `sha256:${createHash("sha256").update(text).digest("hex")}`;
function deepFreeze<T>(v: T): T {
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v)) deepFreeze(x); }
  return v;
}

type Fields = Record<string, unknown> & { type: LedgerEventType };
// Drives the pure reducer one event at a time over deep-frozen ledgers, so any mutation of an input throws.
class Sim {
  ledger = deepFreeze(createLedger({ runId: "run1", controllerLabel: "ctl", at: ts(0) }));
  clock = 0;
  send(rest: Fields, source: EventSource = "bridge"): { outcome: string; code?: string } {
    const event = { eventId: `e${++this.clock}`, at: ts(this.clock), source, ...rest } as unknown as LedgerEvent;
    return this.raw(event);
  }
  raw(event: LedgerEvent): { outcome: string; code?: string } {
    const before = JSON.stringify(this.ledger);
    const r = applyEvent(this.ledger, event);
    expect(JSON.stringify(this.ledger)).toBe(before);
    expect(r.ledger).not.toBe(this.ledger);
    this.ledger = deepFreeze(r.ledger);
    return r.code === undefined ? { outcome: r.outcome } : { outcome: r.outcome, code: r.code };
  }
  task(taskId: string): { outcome: string } { return this.send({ type: "task_declared", taskId, label: `Task ${taskId}`, baseCommit: "abc1234", dependsOn: [], changeScope: ["src/a.ts"] }, "controller"); }
  connect(instanceId: string): void { this.send({ type: "instance_connected", instanceId }); }
  start(taskId: string, attemptId: string, instanceId: string, sessionId: string): { outcome: string; code?: string } {
    return this.send({ type: "attempt_started", taskId, attemptId, instanceId, sessionId, workspaceAlias: "ws-a", profileAlias: "code", deadlineAt: ts(1000) }, "controller");
  }
  turn(sessionId: string, turnId: string, kind: "initial" | "follow_up" = "initial"): { outcome: string; code?: string } { return this.send({ type: "turn_started", sessionId, turnId, kind }); }
  term(sessionId: string, turnId: string, runtime: "completed" | "failed" | "aborted", via: "bridge" | "poll" | "close" = "bridge"): { outcome: string; code?: string } {
    return this.send({ type: "turn_terminal", sessionId, turnId, runtime, via, terminalAt: ts(this.clock + 1) });
  }
  consume(sessionId: string, turnId: string, text: string): { outcome: string; code?: string } {
    return this.send({ type: "result_consumed", sessionId, turnId, textSha256: sha(text), textBytes: Buffer.byteLength(text), truncated: false }, "controller");
  }
  decide(taskId: string, outcome: "accepted" | "rejected", source: EventSource = "controller"): { outcome: string; code?: string } {
    return this.send({ type: "decision", taskId, outcome, evidence: ["tests:green"] }, source);
  }
  t(taskId: string) { return this.ledger.tasks.find((x) => x.taskId === taskId)!; }
  latestTurn(taskId: string) { return this.t(taskId).attempts.at(-1)!.turns.at(-1)!; }
}
// Instance i1 with tasks T1..Tn, each with a session s<k> and a running initial turn u<k>.
function fleet(n: number): Sim {
  const s = new Sim();
  s.connect("i1");
  for (let k = 1; k <= n; k++) { s.task(`T${k}`); s.start(`T${k}`, `a${k}`, "i1", `s${k}-aaaa-bbbb`); s.turn(`s${k}-aaaa-bbbb`, `u${k}-cccc-dddd`); }
  return s;
}

describe("ledger reducer", () => {
  it("keeps concurrent tasks apart when they finish in different orders", () => {
    const s = fleet(3);
    s.send({ type: "turn_observed", sessionId: "s2-aaaa-bbbb", turnId: "u2-cccc-dddd", activityAt: ts(50) });
    s.term("s3-aaaa-bbbb", "u3-cccc-dddd", "completed", "poll");
    s.term("s1-aaaa-bbbb", "u1-cccc-dddd", "failed");
    s.consume("s3-aaaa-bbbb", "u3-cccc-dddd", "result three");
    s.term("s2-aaaa-bbbb", "u2-cccc-dddd", "completed");
    s.consume("s2-aaaa-bbbb", "u2-cccc-dddd", "result two, longer");
    expect(s.t("T1").work).toBe("blocked");
    expect(s.latestTurn("T1")).toMatchObject({ runtime: "failed", terminalVia: "bridge" });
    expect(s.latestTurn("T1").result).toBeUndefined();
    expect(s.t("T2").work).toBe("awaiting_review");
    expect(s.t("T3").work).toBe("awaiting_review");
    expect(s.latestTurn("T2").result).toMatchObject({ textSha256: sha("result two, longer"), textBytes: 18, truncated: false });
    expect(s.latestTurn("T3").result).toMatchObject({ textSha256: sha("result three"), textBytes: 12 });
    expect(s.latestTurn("T3").terminalVia).toBe("poll");
    expect(s.latestTurn("T2").lastActivityAt).toBe(ts(50));
    expect(s.latestTurn("T3").lastActivityAt).toBeUndefined();
    expect(s.consume("s2-aaaa-bbbb", "u3-cccc-dddd", "x")).toEqual({ outcome: "rejected", code: "unknown_turn" });
  });

  it("never accepts a task without a consumed result, a controller decision, or a completed turn", () => {
    const s = fleet(2);
    s.term("s1-aaaa-bbbb", "u1-cccc-dddd", "completed");
    expect(s.t("T1").work).toBe("awaiting_review");
    expect(s.decide("T1", "accepted")).toEqual({ outcome: "rejected", code: "result_not_consumed" });
    s.consume("s1-aaaa-bbbb", "u1-cccc-dddd", "done");
    expect(s.decide("T1", "accepted", "worker")).toEqual({ outcome: "rejected", code: "not_controller" });
    expect(s.decide("T1", "accepted", "hook")).toEqual({ outcome: "rejected", code: "not_controller" });
    expect(s.decide("T1", "accepted", "bridge")).toEqual({ outcome: "rejected", code: "not_controller" });
    expect(s.t("T1")).toMatchObject({ work: "awaiting_review" });
    expect(s.t("T1").decision).toBeUndefined();
    expect(s.decide("T1", "accepted")).toEqual({ outcome: "applied" });
    expect(s.t("T1")).toMatchObject({ work: "accepted", decision: { outcome: "accepted", evidence: ["tests:green"] } });
    // A failed turn stays blocked and cannot be reviewed.
    s.term("s2-aaaa-bbbb", "u2-cccc-dddd", "failed");
    expect(s.decide("T2", "accepted")).toEqual({ outcome: "rejected", code: "not_reviewable" });
    expect(s.t("T2").work).toBe("blocked");
    // A completed task whose follow-up fails is no longer reviewable either.
    s.start("T2", "a2b", "i1", "s2b-aaaa");
    s.turn("s2b-aaaa", "u2b-cccc");
    s.term("s2b-aaaa", "u2b-cccc", "completed");
    s.consume("s2b-aaaa", "u2b-cccc", "ok");
    s.turn("s2b-aaaa", "u2c-cccc", "follow_up");
    s.term("s2b-aaaa", "u2c-cccc", "failed");
    expect(s.decide("T2", "rejected")).toEqual({ outcome: "rejected", code: "not_reviewable" });
    expect(s.t("T2").work).toBe("blocked");
    expect(s.decide("nope", "accepted")).toEqual({ outcome: "rejected", code: "unknown_task" });
  });

  it("keeps terminal states sticky and honours late terminals only after an unconfirmed abort", () => {
    const s = fleet(5);
    // failed, then a late completed: conflict; the same failed again: stale
    s.term("s1-aaaa-bbbb", "u1-cccc-dddd", "failed");
    expect(s.term("s1-aaaa-bbbb", "u1-cccc-dddd", "completed")).toEqual({ outcome: "rejected", code: "terminal_conflict" });
    expect(s.term("s1-aaaa-bbbb", "u1-cccc-dddd", "failed")).toEqual({ outcome: "ignored_stale" });
    expect(s.send({ type: "turn_observed", sessionId: "s1-aaaa-bbbb", turnId: "u1-cccc-dddd" })).toEqual({ outcome: "ignored_stale" });
    expect(s.latestTurn("T1").runtime).toBe("failed");
    expect(s.t("T1").work).toBe("blocked");
    // aborted: sticky, late completed conflicts
    s.term("s2-aaaa-bbbb", "u2-cccc-dddd", "aborted", "close");
    expect(s.term("s2-aaaa-bbbb", "u2-cccc-dddd", "completed")).toEqual({ outcome: "rejected", code: "terminal_conflict" });
    expect(s.send({ type: "abort_unconfirmed", sessionId: "s2-aaaa-bbbb", turnId: "u2-cccc-dddd" })).toEqual({ outcome: "ignored_stale" });
    expect(s.latestTurn("T2")).toMatchObject({ runtime: "aborted", terminalVia: "close" });
    // abort_unconfirmed: blocked, then a late completed is applied
    expect(s.send({ type: "abort_unconfirmed", sessionId: "s3-aaaa-bbbb", turnId: "u3-cccc-dddd" })).toEqual({ outcome: "applied" });
    expect(s.latestTurn("T3").runtime).toBe("abort_unconfirmed");
    expect(s.latestTurn("T3").terminalAt).toBeUndefined();
    expect(s.t("T3").work).toBe("blocked");
    expect(s.send({ type: "abort_unconfirmed", sessionId: "s3-aaaa-bbbb", turnId: "u3-cccc-dddd" })).toEqual({ outcome: "ignored_stale" });
    expect(s.term("s3-aaaa-bbbb", "u3-cccc-dddd", "completed", "poll")).toEqual({ outcome: "applied" });
    expect(s.latestTurn("T3")).toMatchObject({ runtime: "completed", terminalVia: "poll" });
    expect(s.t("T3").work).toBe("awaiting_review");
    // abort_unconfirmed then aborted
    s.send({ type: "abort_unconfirmed", sessionId: "s4-aaaa-bbbb", turnId: "u4-cccc-dddd" });
    expect(s.term("s4-aaaa-bbbb", "u4-cccc-dddd", "aborted")).toEqual({ outcome: "applied" });
    expect(s.t("T4").work).toBe("blocked");
    // abort_unconfirmed on a completed turn changes nothing
    s.term("s5-aaaa-bbbb", "u5-cccc-dddd", "completed");
    expect(s.send({ type: "abort_unconfirmed", sessionId: "s5-aaaa-bbbb", turnId: "u5-cccc-dddd" })).toEqual({ outcome: "ignored_stale" });
    expect(s.latestTurn("T5").runtime).toBe("completed");
    expect(s.t("T5").work).toBe("awaiting_review");
  });

  it("leaves a silent running turn running and never moves timestamps backwards", () => {
    const s = fleet(1);
    const before = JSON.stringify(s.ledger);
    expect(JSON.stringify(applyEvents(s.ledger, []).ledger)).toBe(before);
    expect(s.latestTurn("T1")).toMatchObject({ runtime: "running" });
    expect(s.latestTurn("T1").terminalAt).toBeUndefined();
    expect(s.t("T1").work).toBe("running");
    // an observation long after the attempt deadline still does not invent a hang
    s.send({ type: "turn_observed", sessionId: "s1-aaaa-bbbb", turnId: "u1-cccc-dddd", activityAt: ts(5000) }); // activity far in the future
    expect(s.latestTurn("T1").runtime).toBe("running");
    expect(s.latestTurn("T1").lastActivityAt).toBe(ts(5000));
    const observed = s.latestTurn("T1").observedAt, updated = s.ledger.updatedAt;
    s.raw({ eventId: "old", at: ts(1), source: "bridge", type: "turn_observed", sessionId: "s1-aaaa-bbbb", turnId: "u1-cccc-dddd", activityAt: ts(2) });
    expect(s.latestTurn("T1").lastActivityAt).toBe(ts(5000));
    expect(s.latestTurn("T1").observedAt).toBe(observed);
    expect(s.ledger.updatedAt).toBe(updated);
  });

  it("marks everything of an ended instance unresolved and rejects later events for it", () => {
    const s = new Sim();
    s.connect("i1"); s.connect("i2");
    s.task("A"); s.task("B"); s.task("C"); s.task("D");
    s.start("A", "aa", "i1", "sA-1111"); s.turn("sA-1111", "tA-1111");
    s.start("B", "ab", "i1", "sB-1111"); s.turn("sB-1111", "tB-1111");
    s.start("C", "ac", "i2", "sC-1111"); s.turn("sC-1111", "tC-1111");
    s.start("D", "ad", "i1", "sD-1111"); s.turn("sD-1111", "tD-1111"); s.term("sD-1111", "tD-1111", "completed");
    s.send({ type: "question_opened", requestId: "q1", sessionId: "sA-1111", turnId: "tA-1111", recipient: "controller", kind: "input", deadlineAt: ts(900) });
    s.send({ type: "question_opened", requestId: "q2", sessionId: "sC-1111", turnId: "tC-1111", recipient: "human", kind: "confirm", deadlineAt: ts(900) });
    expect(s.latestTurn("A").runtime).toBe("awaiting_input");
    expect(s.send({ type: "instance_ended", instanceId: "i1", reason: "lost" })).toEqual({ outcome: "applied" });
    expect(s.ledger.instances.find((i) => i.instanceId === "i1")).toMatchObject({ endReason: "lost" });
    expect(s.latestTurn("A").runtime).toBe("unresolved");
    expect(s.latestTurn("B").runtime).toBe("unresolved");
    expect(s.latestTurn("D").runtime).toBe("completed");
    expect(s.t("A").work).toBe("blocked");
    expect(s.t("B").work).toBe("blocked");
    // D's completed result was never consumed and is lost with the connection, so D cannot be reviewed
    expect(s.t("D").work).toBe("blocked");
    expect(s.t("A").attempts[0]!.cleanup).toBe("unknown");
    expect(s.ledger.questions.find((q) => q.requestId === "q1")).toMatchObject({ state: "cancelled" });
    expect(s.ledger.questions.find((q) => q.requestId === "q1")!.resolvedAt).toBeDefined();
    // the other instance is untouched
    expect(s.latestTurn("C").runtime).toBe("awaiting_input");
    expect(s.t("C").work).toBe("running");
    expect(s.t("C").attempts[0]!.cleanup).toBe("open");
    expect(s.ledger.questions.find((q) => q.requestId === "q2")).toMatchObject({ state: "open" });
    // later events for the ended instance
    const rejected = { outcome: "rejected", code: "instance_ended" };
    expect(s.term("sA-1111", "tA-1111", "completed")).toEqual(rejected);
    expect(s.send({ type: "turn_observed", sessionId: "sB-1111", turnId: "tB-1111" })).toEqual(rejected);
    expect(s.send({ type: "question_resolved", requestId: "q1", state: "answered" })).toEqual(rejected);
    expect(s.consume("sD-1111", "tD-1111", "late")).toEqual(rejected);
    expect(s.send({ type: "session_closed", sessionId: "sB-1111", outcome: "closed" })).toEqual(rejected);
    expect(s.start("A", "aa2", "i1", "sA-2222")).toEqual(rejected);
    expect(s.send({ type: "instance_ended", instanceId: "i1", reason: "eof" })).toEqual({ outcome: "ignored_stale" });
    expect(s.send({ type: "instance_ended", instanceId: "nope", reason: "eof" })).toEqual({ outcome: "rejected", code: "unknown_instance" });
    expect(s.latestTurn("A").runtime).toBe("unresolved");
    // a retry has to go to a new instance and a new session; the old attempt stays as it was
    s.connect("i3");
    expect(s.start("A", "aa2", "i3", "sA-2222")).toEqual({ outcome: "applied" });
    expect(s.t("A").attempts).toHaveLength(2);
    expect(s.t("A").attempts[0]!.turns[0]!.runtime).toBe("unresolved");
    expect(s.t("A").work).toBe("running");
    expect(s.send({ type: "instance_connected", instanceId: "i1" })).toEqual({ outcome: "rejected", code: "instance_exists" });
  });

  it("keeps a consumed completed task reviewable after its instance ends", () => {
    const s = new Sim();
    s.connect("i1"); s.task("E");
    s.start("E", "ae", "i1", "sE-1111"); s.turn("sE-1111", "tE-1111"); s.term("sE-1111", "tE-1111", "completed");
    expect(s.consume("sE-1111", "tE-1111", "kept result")).toEqual({ outcome: "applied" });
    expect(s.send({ type: "instance_ended", instanceId: "i1", reason: "eof" })).toEqual({ outcome: "applied" });
    expect(s.t("E").work).toBe("awaiting_review");
    expect(s.send({ type: "decision", taskId: "E", outcome: "accepted", evidence: ["checks.log"] }, "controller")).toEqual({ outcome: "applied" });
  });

  it("keeps history for follow-up turns and for retries as new attempts", () => {
    const s = fleet(1);
    const sid = "s1-aaaa-bbbb";
    expect(s.turn(sid, "u9", "follow_up")).toEqual({ outcome: "rejected", code: "turn_active" });
    expect(s.turn(sid, "u1b-cccc", "initial")).toEqual({ outcome: "rejected", code: "bad_kind" });
    expect(s.start("T1", "a1x", "i1", "sX-9999")).toEqual({ outcome: "rejected", code: "not_startable" });
    s.term(sid, "u1-cccc-dddd", "completed");
    s.consume(sid, "u1-cccc-dddd", "first answer");
    expect(s.turn(sid, "u1-cccc-dddd", "follow_up")).toEqual({ outcome: "rejected", code: "turn_exists" });
    expect(s.turn(sid, "u1f-cccc", "follow_up")).toEqual({ outcome: "applied" });
    expect(s.t("T1").work).toBe("running");
    expect(s.turn(sid, "u1g-cccc", "follow_up")).toEqual({ outcome: "rejected", code: "turn_active" });
    s.term(sid, "u1f-cccc", "failed");
    expect(s.t("T1").work).toBe("blocked");
    const attempt1 = JSON.stringify(s.t("T1").attempts[0]);
    expect(s.t("T1").attempts[0]!.turns.map((t) => [t.turnId, t.kind, t.runtime])).toEqual([["u1-cccc-dddd", "initial", "completed"], ["u1f-cccc", "follow_up", "failed"]]);
    expect(s.start("T1", "a1r", "i1", sid)).toEqual({ outcome: "rejected", code: "session_exists" });
    expect(s.start("T1", "a1", "i1", "s-retry-1")).toEqual({ outcome: "rejected", code: "attempt_exists" });
    expect(s.start("T1", "a1r", "i1", "s-retry-1")).toEqual({ outcome: "applied" });
    expect(s.turn("s-retry-1", "u-retry-1")).toEqual({ outcome: "applied" });
    expect(s.turn(sid, "u1h-cccc", "follow_up")).toEqual({ outcome: "rejected", code: "stale_attempt" });
    s.term("s-retry-1", "u-retry-1", "completed");
    // a late event for the first attempt cannot change the second or the task
    s.send({ type: "turn_observed", sessionId: sid, turnId: "u1f-cccc" });
    expect(s.t("T1").work).toBe("awaiting_review");
    expect(s.t("T1").attempts).toHaveLength(2);
    expect(JSON.stringify(s.t("T1").attempts[0])).toBe(attempt1);
    expect(s.t("T1").attempts[1]).toMatchObject({ attemptId: "a1r", sessionId: "s-retry-1" });
  });

  it("ignores duplicates and stale events without resetting terminal states", () => {
    const s = fleet(1);
    const done = { eventId: "fixed-done", at: ts(70), source: "bridge", type: "turn_terminal", sessionId: "s1-aaaa-bbbb", turnId: "u1-cccc-dddd", runtime: "failed", via: "bridge", terminalAt: ts(70) } as const;
    expect(s.raw(done as unknown as LedgerEvent)).toEqual({ outcome: "applied" });
    const snapshot = JSON.stringify(s.ledger);
    expect(s.raw(done as unknown as LedgerEvent)).toEqual({ outcome: "duplicate" });
    expect(JSON.stringify(s.ledger)).toBe(snapshot);
    s.send({ type: "turn_observed", sessionId: "s1-aaaa-bbbb", turnId: "u1-cccc-dddd" });
    s.send({ type: "turn_started", sessionId: "s1-aaaa-bbbb", turnId: "u1-cccc-dddd", kind: "initial" });
    expect(s.latestTurn("T1")).toMatchObject({ runtime: "failed", terminalAt: ts(70) });
    expect(JSON.stringify(s.ledger)).toBe(snapshot);
    // a duplicate inside one batch
    const { outcomes } = applyEvents(s.ledger, [
      { eventId: "x1", at: ts(80), source: "bridge", type: "instance_connected", instanceId: "i9" },
      { eventId: "x1", at: ts(80), source: "bridge", type: "instance_connected", instanceId: "i9" },
    ]);
    expect(outcomes).toEqual([{ eventId: "x1", outcome: "applied" }, { eventId: "x1", outcome: "duplicate" }]);
  });

  it("keeps only the newest 1000 applied event ids and tracks updatedAt as a maximum", () => {
    let l = createLedger({ runId: "r", controllerLabel: "c", at: ts(0) });
    const events: LedgerEvent[] = [];
    for (let i = 0; i < 1100; i++) events.push({ eventId: `id${i}`, at: ts(i === 500 ? 1 : i + 10), source: "bridge", type: "instance_connected", instanceId: `inst${i}` });
    const r = applyEvents(l, events);
    l = r.ledger;
    expect(r.outcomes.every((o) => o.outcome === "applied")).toBe(true);
    expect(l.appliedEventIds).toHaveLength(1000);
    expect(l.appliedEventIds[0]).toBe("id100");
    expect(l.appliedEventIds.at(-1)).toBe("id1099");
    expect(l.updatedAt).toBe(ts(1109));
    const old = applyEvent(l, { eventId: "late", at: ts(2), source: "bridge", type: "instance_connected", instanceId: "late" });
    expect(old.ledger.updatedAt).toBe(ts(1109));
    expect(old.ledger.appliedEventIds.at(-1)).toBe("late");
  });

  it("guards result consumption and session close", () => {
    const s = fleet(1);
    const sid = "s1-aaaa-bbbb", tid = "u1-cccc-dddd";
    expect(s.consume(sid, tid, "early")).toEqual({ outcome: "rejected", code: "not_completed" });
    s.term(sid, tid, "completed");
    expect(s.send({ type: "session_closed", sessionId: sid, outcome: "closed" })).toEqual({ outcome: "rejected", code: "result_not_consumed" });
    expect(s.t("T1").attempts[0]!.cleanup).toBe("open");
    expect(s.consume(sid, tid, "answer")).toEqual({ outcome: "applied" });
    expect(s.consume(sid, tid, "answer")).toEqual({ outcome: "ignored_stale" });
    expect(s.consume(sid, tid, "different")).toEqual({ outcome: "rejected", code: "result_conflict" });
    expect(s.latestTurn("T1").result?.textSha256).toBe(sha("answer"));
    expect(s.send({ type: "session_closed", sessionId: sid, outcome: "close_failed" })).toEqual({ outcome: "applied" });
    expect(s.t("T1").attempts[0]!.cleanup).toBe("close_failed");
    expect(s.send({ type: "session_closed", sessionId: sid, outcome: "closed" })).toEqual({ outcome: "applied" });
    expect(s.send({ type: "session_closed", sessionId: sid, outcome: "closed" })).toEqual({ outcome: "ignored_stale" });
    expect(s.send({ type: "session_closed", sessionId: "nope", outcome: "closed" })).toEqual({ outcome: "rejected", code: "unknown_session" });
    expect(s.t("T1").work).toBe("awaiting_review");
  });

  it("runs the question lifecycle on the turn state", () => {
    const s = fleet(1);
    const open = (id: string) => s.send({ type: "question_opened", requestId: id, sessionId: "s1-aaaa-bbbb", turnId: "u1-cccc-dddd", recipient: "controller", kind: "select", deadlineAt: ts(900) });
    expect(open("q1")).toEqual({ outcome: "applied" });
    expect(open("q1")).toEqual({ outcome: "rejected", code: "request_exists" });
    expect(open("q2")).toEqual({ outcome: "applied" });
    expect(s.ledger.questions[0]).toMatchObject({ instanceId: "i1", sessionId: "s1-aaaa-bbbb", turnId: "u1-cccc-dddd", attemptId: "a1", state: "open" });
    expect(s.latestTurn("T1").runtime).toBe("awaiting_input");
    expect(s.send({ type: "question_resolved", requestId: "q1", state: "answered" })).toEqual({ outcome: "applied" });
    expect(s.latestTurn("T1").runtime).toBe("awaiting_input");
    expect(s.send({ type: "question_resolved", requestId: "q1", state: "expired" })).toEqual({ outcome: "ignored_stale" });
    expect(s.ledger.questions[0]!.state).toBe("answered");
    expect(s.send({ type: "question_resolved", requestId: "q2", state: "refused" })).toEqual({ outcome: "applied" });
    expect(s.latestTurn("T1").runtime).toBe("running");
    expect(s.send({ type: "question_resolved", requestId: "zzz", state: "answered" })).toEqual({ outcome: "rejected", code: "unknown_request" });
    expect(open("q3")).toEqual({ outcome: "applied" });
    s.term("s1-aaaa-bbbb", "u1-cccc-dddd", "aborted", "close");
    expect(s.ledger.questions[2]).toMatchObject({ state: "cancelled" });
    expect(open("q4")).toEqual({ outcome: "rejected", code: "not_running" });
  });

  it("rejects malformed events without changing the ledger", () => {
    const s = fleet(1);
    const snapshot = JSON.stringify(s.ledger);
    const base = { eventId: "bad1", at: ts(5), source: "bridge" };
    const cases: unknown[] = [
      { ...base, type: "turn_observed", sessionId: "s1-aaaa-bbbb", turnId: "u1-cccc-dddd", assistantText: "x" },
      { ...base, type: "turn_observed", sessionId: "s1-aaaa-bbbb" },
      { ...base, type: "nope" },
      { ...base, type: "turn_observed", sessionId: "/etc/passwd", turnId: "t" },
      { ...base, source: "root", type: "instance_connected", instanceId: "i7" },
      { ...base, at: "yesterday", type: "instance_connected", instanceId: "i7" },
      { ...base, type: "result_consumed", sessionId: "s1-aaaa-bbbb", turnId: "u1-cccc-dddd", textSha256: "sha256:abc", textBytes: 1, truncated: false },
      { ...base, type: "decision", taskId: "T1", outcome: "accepted", evidence: ["a\nb"] },
      "text",
      null,
    ];
    for (const c of cases) {
      expect(s.raw(c as LedgerEvent)).toEqual({ outcome: "rejected", code: "invalid_event" });
      expect(validateEvent(c).ok).toBe(false);
    }
    expect(JSON.stringify(s.ledger)).toBe(snapshot);
  });
});

describe("validateLedger", () => {
  function sample(): RunLedger {
    const s = fleet(2);
    s.term("s1-aaaa-bbbb", "u1-cccc-dddd", "completed");
    s.consume("s1-aaaa-bbbb", "u1-cccc-dddd", "text");
    s.decide("T1", "accepted");
    s.send({ type: "question_opened", requestId: "q1", sessionId: "s2-aaaa-bbbb", turnId: "u2-cccc-dddd", recipient: "human", kind: "confirm", deadlineAt: ts(900) });
    return structuredClone(s.ledger) as RunLedger;
  }
  const mutate = (fn: (l: any) => void): unknown => { const l = sample(); fn(l); return l; }; // eslint-disable-line @typescript-eslint/no-explicit-any

  it("accepts ledgers produced by the reducer", () => {
    expect(validateLedger(sample())).toEqual({ ok: true });
    expect(validateLedger(createLedger({ runId: "r1", controllerLabel: "ctl", at: ts(0) }))).toEqual({ ok: true });
  });
  it("rejects absolute paths, home paths, drive letters and dot-dot segments", () => {
    expect(validateLedger(mutate((l) => { l.tasks[0].changeScope = ["/etc/passwd"]; }))).toEqual({ ok: false, code: "absolute_path", path: "tasks[0].changeScope[0]" });
    expect(validateLedger(mutate((l) => { l.tasks[0].changeScope = ["~/secret"]; }))).toMatchObject({ ok: false, code: "absolute_path" });
    expect(validateLedger(mutate((l) => { l.tasks[0].changeScope = ["C:\\Users\\x"]; }))).toMatchObject({ ok: false, code: "absolute_path" });
    expect(validateLedger(mutate((l) => { l.tasks[0].decision.evidence = ["\\\\host\\share"]; }))).toMatchObject({ ok: false, code: "absolute_path" });
    expect(validateLedger(mutate((l) => { l.tasks[0].changeScope = ["src/../../x"]; }))).toEqual({ ok: false, code: "dotdot_segment", path: "tasks[0].changeScope[0]" });
    expect(validateLedger(mutate((l) => { l.tasks[0].decision.evidence = ["..\\x"]; }))).toMatchObject({ ok: false, code: "dotdot_segment" });
    expect(validateLedger(mutate((l) => { l.tasks[0].changeScope = ["src/a..b.ts"]; }))).toEqual({ ok: true });
  });
  it("rejects long strings, line breaks and bad labels", () => {
    expect(validateLedger(mutate((l) => { l.tasks[0].label = "x".repeat(201); }))).toEqual({ ok: false, code: "string_too_long", path: "tasks[0].label" });
    expect(validateLedger(mutate((l) => { l.tasks[0].decision.evidence = ["ok\nsecond line"]; }))).toEqual({ ok: false, code: "line_break", path: "tasks[0].decision.evidence[0]" });
    expect(validateLedger(mutate((l) => { l.tasks[0].decision.evidence = ["a\rb"]; }))).toMatchObject({ ok: false, code: "line_break" });
    expect(validateLedger(mutate((l) => { l.controllerLabel = "two\nlines"; }))).toMatchObject({ ok: false, code: "line_break" });
    expect(validateLedger(mutate((l) => { l.tasks[0].label = "a/b"; }))).toMatchObject({ ok: false, code: "bad_pattern" });
    expect(validateLedger(mutate((l) => { l.tasks[0].attempts[0].sessionId = "has space"; }))).toMatchObject({ ok: false, code: "bad_pattern" });
    expect(validateLedger(mutate((l) => { l.tasks[0].attempts[0].turns[0].result.textSha256 = "sha256:zz"; }))).toMatchObject({ ok: false, code: "bad_pattern" });
    expect(validateLedger(mutate((l) => { l.updatedAt = "now"; }))).toMatchObject({ ok: false, code: "bad_pattern" });
  });
  it("rejects unknown keys at every level and wrong types", () => {
    expect(validateLedger(mutate((l) => { l.assistantText = "x"; }))).toEqual({ ok: false, code: "unknown_key", path: "assistantText" });
    expect(validateLedger(mutate((l) => { l.tasks[0].prompt = "x"; }))).toEqual({ ok: false, code: "unknown_key", path: "tasks[0].prompt" });
    expect(validateLedger(mutate((l) => { l.tasks[0].attempts[0].turns[0].assistantText = "x"; }))).toEqual({ ok: false, code: "unknown_key", path: "tasks[0].attempts[0].turns[0].assistantText" });
    expect(validateLedger(mutate((l) => { l.tasks[0].attempts[0].turns[0].result.text = "x"; }))).toMatchObject({ ok: false, code: "unknown_key" });
    expect(validateLedger(mutate((l) => { l.questions[0].text = "x"; }))).toMatchObject({ ok: false, code: "unknown_key" });
    expect(validateLedger(mutate((l) => { l.instances[0].secret = "x"; }))).toMatchObject({ ok: false, code: "unknown_key" });
    expect(validateLedger(mutate((l) => { delete l.runId; }))).toEqual({ ok: false, code: "missing_key", path: "runId" });
    expect(validateLedger(mutate((l) => { l.schemaVersion = 2; }))).toMatchObject({ ok: false, code: "bad_value" });
    expect(validateLedger(mutate((l) => { l.local = false; }))).toMatchObject({ ok: false, code: "bad_value" });
    expect(validateLedger(mutate((l) => { l.revision = -1; }))).toMatchObject({ ok: false, code: "bad_value" });
    expect(validateLedger(mutate((l) => { l.tasks[0].work = "done"; }))).toMatchObject({ ok: false, code: "bad_enum" });
    expect(validateLedger(JSON.parse('{"__proto__": {}, "x": 1}'))).toMatchObject({ ok: false, code: "unknown_key" });
    for (const v of [null, [], "x", 3]) expect(validateLedger(v)).toMatchObject({ ok: false, code: "bad_type" });
  });
});

describe("task.md projection and canaries", () => {
  it("renders a deterministic table and the open questions without any text", () => {
    const s = fleet(3);
    s.term("s1-aaaa-bbbb", "u1-cccc-dddd", "completed");
    s.consume("s1-aaaa-bbbb", "u1-cccc-dddd", "héllo wörld");
    s.term("s2-aaaa-bbbb", "u2-cccc-dddd", "failed");
    s.send({ type: "question_opened", requestId: "req-7", sessionId: "s3-aaaa-bbbb", turnId: "u3-cccc-dddd", recipient: "human", kind: "confirm", deadlineAt: "2026-10-21T11:00:00.000Z" });
    s.send({ type: "question_opened", requestId: "req-8", sessionId: "s3-aaaa-bbbb", turnId: "u3-cccc-dddd", recipient: "controller", kind: "input", deadlineAt: "2026-10-21T12:00:00.000Z" });
    s.send({ type: "question_resolved", requestId: "req-8", state: "answered" });
    const md = renderTaskMarkdown(s.ledger);
    expect(renderTaskMarkdown(structuredClone(s.ledger) as RunLedger)).toBe(md);
    const lines = md.split("\n");
    expect(lines[0]).toBe(`<!-- generated from run.json revision ${s.ledger.revision}; do not edit -->`);
    const rows = lines.filter((l) => /^\| T\d /.test(l));
    expect(rows).toHaveLength(3);
    const cells = (row: string) => row.slice(2, -2).split(" | ");
    const bytes = Buffer.byteLength("héllo wörld");
    const want = createHash("sha256").update("héllo wörld").digest("hex").slice(0, 12);
    expect(cells(rows[0]!)).toEqual(["T1", "Task T1", "awaiting_review", "a1 (#1)", "s1-aaaa-", "u1-cccc-", "completed", `sha256:${want} ${bytes}B`, "open"]);
    expect(cells(rows[1]!)).toEqual(["T2", "Task T2", "blocked", "a2 (#1)", "s2-aaaa-", "u2-cccc-", "failed", "-", "open"]);
    expect(cells(rows[2]!)[2]).toBe("running");
    expect(cells(rows[2]!)[6]).toBe("awaiting_input");
    expect(md).toContain("- req-7 | human | confirm | deadline 2026-10-21T11:00:00.000Z");
    expect(md).not.toContain("req-8");
    expect(md).not.toContain("héllo");
    const pending = new Sim();
    pending.task("P1");
    const emptyMd = renderTaskMarkdown(pending.ledger);
    expect(emptyMd).toContain("| P1 | Task P1 | pending | - | - | - | - | - | - |");
    expect(emptyMd).toContain("None.");
  });

  const CANARIES = { prompt: "CANARY-PROMPT-7f3a", answer: "CANARY-ANSWER-91bc", assistant: "CANARY-ASSISTANT-c0de", question: "CANARY-QUESTION-5d2e" };
  let dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))); dirs = []; });
  const tmp = async (): Promise<string> => { const d = await mkdtemp(join(tmpdir(), "ledger-test-")); dirs.push(d); return d; };

  it("never writes prompt, answer, question or assistant text to run.json or task.md", async () => {
    const dir = join(await tmp(), "run");
    const store = new LedgerStore(dir);
    await store.init(createLedger({ runId: "canary-run", controllerLabel: "ctl", at: ts(0) }));
    const assistantText = `${CANARIES.assistant} line one`;
    const batch: unknown[] = [
      { eventId: "c1", at: ts(1), source: "controller", type: "task_declared", taskId: "T1", label: "Task one", baseCommit: "abc1234", dependsOn: [], changeScope: ["src/a.ts"] },
      { eventId: "c2", at: ts(2), source: "bridge", type: "instance_connected", instanceId: "i1" },
      { eventId: "c3", at: ts(3), source: "controller", type: "attempt_started", taskId: "T1", attemptId: "a1", instanceId: "i1", sessionId: "s1", workspaceAlias: "ws", profileAlias: "code", deadlineAt: ts(900) },
      { eventId: "c4", at: ts(4), source: "bridge", type: "turn_started", sessionId: "s1", turnId: "t1", kind: "initial" },
      { eventId: "c5", at: ts(5), source: "bridge", type: "question_opened", requestId: "r1", sessionId: "s1", turnId: "t1", recipient: "controller", kind: "input", deadlineAt: ts(60) },
      { eventId: "c6", at: ts(6), source: "controller", type: "question_resolved", requestId: "r1", state: "answered" },
      { eventId: "c7", at: ts(7), source: "bridge", type: "turn_terminal", sessionId: "s1", turnId: "t1", runtime: "completed", via: "bridge", terminalAt: ts(7) },
      { eventId: "c8", at: ts(8), source: "controller", type: "result_consumed", sessionId: "s1", turnId: "t1", textSha256: sha(assistantText), textBytes: Buffer.byteLength(assistantText), truncated: false },
      // attempts to smuggle text: every one of these must be refused as a whole event
      { eventId: "x1", at: ts(9), source: "bridge", type: "turn_observed", sessionId: "s1", turnId: "t1", assistantText: CANARIES.assistant },
      { eventId: "x2", at: ts(9), source: "bridge", type: "question_opened", requestId: "r2", sessionId: "s1", turnId: "t1", recipient: "human", kind: "input", deadlineAt: ts(60), text: CANARIES.question },
      { eventId: "x3", at: ts(9), source: "controller", type: "question_resolved", requestId: "r1", state: "answered", answer: CANARIES.answer },
      { eventId: "x4", at: ts(9), source: "controller", type: "decision", taskId: "T1", outcome: "accepted", evidence: [CANARIES.prompt + "\nsecond line"] },
      { eventId: "x5", at: ts(9), source: "controller", type: "task_declared", taskId: "T2", label: `x ${"y".repeat(150)}`, baseCommit: "abc1234", dependsOn: [], changeScope: ["/home/user/" + CANARIES.prompt] },
    ];
    const { outcomes } = await store.apply(batch as LedgerEvent[]);
    expect(outcomes.slice(0, 8).every((o) => o.outcome === "applied")).toBe(true);
    expect(outcomes.slice(8)).toEqual(["x1", "x2", "x3", "x4", "x5"].map((eventId) => ({ eventId, outcome: "rejected", code: "invalid_event" })));
    const runBytes = await readFile(join(dir, "run.json"), "utf8");
    const taskBytes = await readFile(join(dir, "task.md"), "utf8");
    const parsed = JSON.parse(runBytes) as RunLedger;
    expect(parsed.tasks[0]!.attempts[0]!.turns[0]!.result).toEqual({ consumedAt: ts(8), textSha256: sha(assistantText), textBytes: Buffer.byteLength(assistantText), truncated: false });
    for (const canary of Object.values(CANARIES)) {
      expect(runBytes).not.toContain(canary);
      expect(taskBytes).not.toContain(canary);
      expect(JSON.stringify(outcomes)).not.toContain(canary);
    }
    expect(runBytes).not.toContain("line one");
    expect(parsed.appliedEventIds).toEqual(["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"]);
    expect(parsed.tasks).toHaveLength(1);
  });

  describe("LedgerStore", () => {
    const declare = (id: string, at = 1): LedgerEvent => ({ eventId: `ev-${id}`, at: ts(at), source: "controller", type: "task_declared", taskId: id, label: `Task ${id}`, baseCommit: "abc1234", dependsOn: [], changeScope: [] });
    async function fresh(options?: { lockRetryMs?: number; lockTimeoutMs?: number }): Promise<{ dir: string; store: LedgerStore }> {
      const dir = join(await tmp(), "run");
      const store = new LedgerStore(dir, options);
      await store.init(createLedger({ runId: "store-run", controllerLabel: "ctl", at: ts(0) }));
      return { dir, store };
    }

    it("creates private files, refuses to re-init and bumps the revision only when something applied", async () => {
      const { dir, store } = await fresh();
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(dir, "run.json"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(dir, "task.md"))).mode & 0o777).toBe(0o600);
      await expect(store.init(createLedger({ runId: "other", controllerLabel: "ctl", at: ts(0) }))).rejects.toMatchObject({ code: "ledger_exists" });
      expect(JSON.parse(await readFile(join(dir, "run.json"), "utf8")).runId).toBe("store-run");
      expect((await store.apply([declare("A")])).revision).toBe(1);
      const again = await store.apply([declare("A")]);
      expect(again.revision).toBe(1);
      expect(again.outcomes).toEqual([{ eventId: "ev-A", outcome: "duplicate" }]);
      const rejected = await store.apply([{ ...declare("A", 2), eventId: "ev-A2" }, declare("B")]);
      expect(rejected.outcomes).toEqual([{ eventId: "ev-A2", outcome: "rejected", code: "task_exists" }, { eventId: "ev-B", outcome: "applied" }]);
      const onDisk = JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as RunLedger;
      expect(onDisk.revision).toBe(2);
      expect(onDisk.tasks.map((t) => t.taskId)).toEqual(["A", "B"]);
      expect((await readFile(join(dir, "task.md"), "utf8")).split("\n")[0]).toBe("<!-- generated from run.json revision 2; do not edit -->");
      expect((await readdir(dir)).sort()).toEqual(["run.json", "task.md"]);
      expect((await new LedgerStore(dir).read()).revision).toBe(2);
    });

    it("does not lose updates when many stores write the same directory at once", async () => {
      const { dir } = await fresh({ lockTimeoutMs: 20_000 });
      const stores = Array.from({ length: 12 }, () => new LedgerStore(dir, { lockTimeoutMs: 20_000 }));
      const batches = stores.map((_, i) => [declare(`P${i}a`, i + 1), declare(`P${i}b`, i + 1)]);
      const results = await Promise.all(stores.map((st, i) => st.apply(batches[i]!)));
      expect(results.map((r) => r.revision).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
      const onDisk = JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as RunLedger;
      expect(onDisk.revision).toBe(12);
      const expected = batches.flat().map((e) => e.eventId).sort();
      expect([...onDisk.appliedEventIds].sort()).toEqual(expected);
      expect(onDisk.tasks.map((t) => t.taskId).sort()).toEqual(batches.flat().map((e) => (e as { taskId: string }).taskId).sort());
      expect(new Set(onDisk.tasks.map((t) => t.taskId)).size).toBe(24);
      expect((await readFile(join(dir, "task.md"), "utf8")).split("\n")[0]).toBe("<!-- generated from run.json revision 12; do not edit -->");
      expect((await readdir(dir)).sort()).toEqual(["run.json", "task.md"]);
    });

    it("does not lose updates across OS processes that follow the same lock protocol", async () => {
      const { dir, store } = await fresh();
      const child = fileURLToPath(new URL("./fixtures/bridge/ledger-lock-child.mjs", import.meta.url));
      await Promise.all(Array.from({ length: 8 }, (_, i) => run(process.execPath, [child, dir, `c${i}`, "15"], { timeout: 60_000 })));
      const onDisk = await store.read();
      expect(onDisk.revision).toBe(8 * 15);
      expect(onDisk.appliedEventIds).toHaveLength(8 * 15);
      expect(new Set(onDisk.appliedEventIds).size).toBe(8 * 15);
      for (let i = 0; i < 8; i++) for (let j = 0; j < 15; j++) expect(onDisk.appliedEventIds).toContain(`c${i}-${j}`);
      expect((await readdir(dir)).sort()).toEqual(["run.json", "task.md"]);
    }, 90_000);

    it("turns a stale read-modify-write into revision_conflict and writes nothing", async () => {
      const { dir, store } = await fresh();
      await store.apply([declare("A")]);
      const before = await readFile(join(dir, "run.json"), "utf8");
      await expect(store.apply([declare("B")], { expectedRevision: 0 })).rejects.toMatchObject({ code: "revision_conflict" });
      expect(await readFile(join(dir, "run.json"), "utf8")).toBe(before);
      await expect(readFile(join(dir, "run.json.lock"))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await store.apply([declare("B")], { expectedRevision: 1 })).revision).toBe(2);
    });

    it("reports ledger_locked within the timeout and never breaks the lock", async () => {
      const { dir } = await fresh({ lockRetryMs: 5, lockTimeoutMs: 200 });
      const lock = join(dir, "run.json.lock");
      await writeFile(lock, "99999999");
      const before = await readFile(join(dir, "run.json"), "utf8");
      const started = Date.now();
      await expect(new LedgerStore(dir, { lockRetryMs: 5, lockTimeoutMs: 200 }).apply([declare("A")])).rejects.toMatchObject({ code: "ledger_locked" });
      const waited = Date.now() - started;
      expect(waited).toBeGreaterThanOrEqual(100);
      expect(waited).toBeLessThan(3000);
      expect(await readFile(lock, "utf8")).toBe("99999999");
      expect(await readFile(join(dir, "run.json"), "utf8")).toBe(before);
    });

    it("refuses a tampered run.json and writes nothing", async () => {
      const { dir, store } = await fresh();
      await store.apply([declare("A")]);
      const tampered = { ...JSON.parse(await readFile(join(dir, "run.json"), "utf8")), assistantText: CANARIES.assistant };
      await writeFile(join(dir, "run.json"), JSON.stringify(tampered));
      const bytes = await readFile(join(dir, "run.json"), "utf8");
      await expect(store.read()).rejects.toMatchObject({ code: "ledger_invalid" });
      await expect(store.apply([declare("B")])).rejects.toMatchObject({ code: "ledger_invalid" });
      expect(await readFile(join(dir, "run.json"), "utf8")).toBe(bytes);
      expect((await readdir(dir)).sort()).toEqual(["run.json", "task.md"]);
      await expect(new LedgerStore(join(dir, "missing")).read()).rejects.toMatchObject({ code: "ledger_missing" });
      await expect(store.init({ ...createLedger({ runId: "x", controllerLabel: "c", at: ts(0) }), prompt: "p" } as unknown as RunLedger)).rejects.toMatchObject({ code: "ledger_invalid" });
    });
  });

  describe("ledger-cli", () => {
    it("inits, applies from stdin, renders, and prints neither paths nor text", async () => {
      const dir = join(await tmp(), "cli-run");
      const none = async (): Promise<string> => "";
      expect(await runCli(["init", "--dir", dir, "--run-id", "r-cli", "--controller", "ctl"], none)).toMatchObject({ code: 0, stderr: "" });
      expect((await runCli(["init", "--dir", dir, "--run-id", "r-cli", "--controller", "ctl"], none))).toMatchObject({ code: 2, stdout: "" });
      const ok = [
        { eventId: "k1", at: ts(1), source: "controller", type: "task_declared", taskId: "T1", label: "Task one", baseCommit: "abc1234", dependsOn: [], changeScope: [] },
        { eventId: "k2", at: ts(2), source: "bridge", type: "instance_connected", instanceId: "i1" },
      ];
      const first = await runCli(["apply", "--dir", dir], async () => JSON.stringify(ok));
      expect(first.code).toBe(0);
      expect(JSON.parse(first.stdout)).toEqual({ revision: 1, outcomes: [{ eventId: "k1", outcome: "applied" }, { eventId: "k2", outcome: "applied" }] });
      const single = await runCli(["apply", "--dir", dir], async () => JSON.stringify(ok[0]));
      expect(JSON.parse(single.stdout)).toEqual({ revision: 1, outcomes: [{ eventId: "k1", outcome: "duplicate" }] });
      const bad = await runCli(["apply", "--dir", dir], async () => JSON.stringify([{ eventId: "k3", at: ts(3), source: "worker", type: "decision", taskId: "T1", outcome: "accepted", evidence: [] }]));
      expect(bad.code).toBe(2);
      expect(JSON.parse(bad.stdout).outcomes).toEqual([{ eventId: "k3", outcome: "rejected", code: "not_controller" }]);
      const md = await runCli(["render", "--dir", dir], none);
      expect(md.code).toBe(0);
      expect(md.stdout.split("\n")[0]).toBe("<!-- generated from run.json revision 1; do not edit -->");
      expect(md.stdout).toContain("| T1 | Task one | pending |");
      for (const r of [first, single, bad, md]) { expect(r.stdout).not.toContain(dir); expect(r.stderr).not.toContain(dir); }
      expect(await runCli(["apply", "--dir", dir], async () => "not json")).toMatchObject({ code: 64 });
      expect(await runCli(["apply"], none)).toMatchObject({ code: 64 });
      expect(await runCli(["frobnicate", "--dir", dir], none)).toMatchObject({ code: 64 });
      expect(await runCli(["apply", "--dir", dir, "--extra", "x"], none)).toMatchObject({ code: 64 });
      expect(await runCli([], none)).toMatchObject({ code: 64 });
      const missing = await runCli(["render", "--dir", join(dir, "nope")], none);
      expect(missing).toMatchObject({ code: 2, stdout: "" });
      expect(JSON.parse(missing.stderr)).toEqual({ error: "ledger_missing" });
    });
  });
});

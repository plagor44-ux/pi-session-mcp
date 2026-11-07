import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runHistoryCli } from "../src/history/cli.js";
import { compilePathRule } from "../src/history/path-rule.js";
import { createHistoryRecorder } from "../src/history/recorder.js";
import { reconcileInstances } from "../src/history/reconcile.js";
import { Redactor } from "../src/history/redact.js";
import { historyLocation, openHistoryStore } from "../src/history/store.js";
import type { SessionView, TurnView } from "../src/session-registry.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

const SECRET = `ghp_${"Zq9".repeat(12)}`;
const LONG = `${"long text ".repeat(40)}end-of-long-text`;
const at = (second: number) => `2026-11-04T10:00:${String(second).padStart(2, "0")}.000Z`;
const ids = { a: "aaaaaaaa-0000-4000-8000-000000000001", b: "bbbbbbbb-0000-4000-8000-000000000002", c: "cccccccc-0000-4000-8000-000000000003", d: "dddddddd-0000-4000-8000-000000000004" };

function view(id: string, overrides: Partial<SessionView> = {}): SessionView {
  return { id, workspace: "repo", executionProfile: "review", profile: "read-only", provider: "p", model: "m", thinkingLevel: "high", state: "idle", createdAt: "2026-11-04T10:00:00.000Z", updatedAt: "2026-11-04T10:00:00.000Z", ...overrides };
}
function turn(sessionId: string, n: number): TurnView {
  return { turnId: `${n}${n}${n}${n}${n}${n}${n}${n}-1111-4111-8111-111111111111`, sessionId, state: "completed", startedAt: at(1), updatedAt: at(9), completedAt: at(9), completion: "stop" };
}
const timeline = [
  { type: "message", id: "u1", parentId: null, timestamp: at(1), message: { role: "user", content: "please inspect the configuration" } },
  { type: "message", id: "a1", parentId: "u1", timestamp: at(2), message: { role: "assistant", content: [{ type: "text", text: "Reading it." }, { type: "toolCall", id: "call-1", name: "read", arguments: { path: ".env" } }] } },
  { type: "message", id: "r1", parentId: "a1", timestamp: at(3), message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "API=value" }], isError: false } },
  { type: "message", id: "a2", parentId: "r1", timestamp: at(4), message: { role: "assistant", content: [{ type: "text", text: `${LONG} token ${SECRET} \u001b[31mred \u009b32mcsi` }] } },
];

/** Builds a history file through the real recorder: three sessions with different metadata. */
async function fixture(options: { truncated?: boolean } = {}) {
  const home = await temporaryRoot("history-cli-");
  const store = await openHistoryStore({ home });
  const recorder = createHistoryRecorder({
    store, redactorFor: () => new Redactor({ knownValues: [], pathRule: compilePathRule([]) }),
    configurationFingerprint: `sha256:${"a".repeat(64)}`, packageVersion: "0.0.0-test",
    instance: { pid: process.pid, procStart: null }, diagnostic: () => undefined,
  });
  const sessions: Array<[string, Partial<SessionView>, string | undefined, unknown[]]> = [
    [ids.a, {}, "#215", options.truncated ? [...timeline, { type: "message", id: "big", parentId: "a2", timestamp: at(5), message: { role: "assistant", content: [{ type: "text", text: "x".repeat(1_200_000) }] } }] : timeline],
    [ids.b, { workspace: "other", executionProfile: "code", profile: "coding", createdAt: "2026-10-01T09:00:00.000Z" }, "#99", timeline.slice(0, 1)],
    [ids.c, { createdAt: "2026-11-02T08:00:00.000Z" }, undefined, timeline.slice(0, 2)],
  ];
  for (const [id, overrides, task, entries] of sessions) {
    recorder.sessionStarted({ view: view(id, overrides), sdkSessionId: `sdk-${id.slice(0, 1)}`, source: "host", ...(task === undefined ? {} : { task }) });
    recorder.turnEnded(id, turn(id, 1), async (cursor) => ({ ...(cursor === 0 ? { header: { type: "session", version: 3, id: `sdk-${id.slice(0, 1)}`, timestamp: at(0), cwd: "/private/cwd" } } : {}), entries: entries.slice(cursor), next: entries.length, more: false }));
    await recorder.settle(id, 5_000);
    recorder.sessionClosed(view(id, { ...overrides, state: "closed" }));
  }
  store.db.prepare("UPDATE sessions SET closed_at = ? WHERE public_session_id = ?").run("2026-10-01T10:00:00.000Z", ids.b);
  store.close();
  return { home, file: historyLocation(home).file };
}

async function run(home: string, ...argv: string[]) {
  let stdout = "", stderr = "";
  const code = await runHistoryCli(argv, { stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; }, home, now: () => new Date("2026-11-04T12:00:00.000Z") });
  return { code, stdout, stderr };
}
const listedIds = (stdout: string) => stdout.trim().split("\n").slice(1).map((line) => line.split("\t")[1]);

describe("pi-session-mcp-history", () => {
  it("list filters by workspace, profile, task, since and verdict", async () => {
    const { home } = await fixture();
    expect(listedIds((await run(home, "list")).stdout)).toEqual(["aaaaaaaa", "cccccccc", "bbbbbbbb"]);
    expect(listedIds((await run(home, "list", "--workspace", "other")).stdout)).toEqual(["bbbbbbbb"]);
    expect(listedIds((await run(home, "list", "--profile", "review")).stdout)).toEqual(["aaaaaaaa", "cccccccc"]);
    expect(listedIds((await run(home, "list", "--task", "#215")).stdout)).toEqual(["aaaaaaaa"]);
    expect(listedIds((await run(home, "list", "--since", "2026-11-01")).stdout)).toEqual(["aaaaaaaa", "cccccccc"]);
    expect((await run(home, "verdict", ids.c, "rejected", "--reason", "Missed the edge case.")).code).toBe(0);
    expect(listedIds((await run(home, "list", "--verdict", "rejected")).stdout)).toEqual(["cccccccc"]);
    expect(listedIds((await run(home, "list", "--profile", "review", "--since", "2026-11-03")).stdout)).toEqual(["aaaaaaaa"]);
    const listed = await run(home, "list");
    expect(listed.stdout.split("\n")[0]).toBe("created\tsession\tworkspace\tprofile\ttask\tturns\tcompleteness\tverdict");
    expect(listed.stdout).toContain("2026-11-04 10:00\taaaaaaaa\trepo\treview\t#215\t1\tcomplete\t-");
  });

  it("show renders a timeline with tool names and the path-rule marker", async () => {
    const { home } = await fixture();
    const shown = await run(home, "show", ids.a);
    expect(shown.code).toBe(0);
    const lines = shown.stdout.trim().split("\n");
    expect(lines).toContain("10:00:01  message  user  please inspect the configuration");
    expect(lines).toContain("10:00:02  message  read  Reading it. read(.env)");
    expect(lines.find((line) => line.startsWith("10:00:03"))).toBe("10:00:03  message  read  content not stored (path rule)");
    const long = lines.find((line) => line.startsWith("10:00:04"))!;
    expect(long.length).toBeLessThanOrEqual("10:00:04  message  assistant  ".length + 160);
    expect(long).not.toContain(SECRET);
    expect(shown.stdout).not.toContain("\u001b");
    // The history id works as well as the public session id, and so does a unique prefix.
    expect((await run(home, "show", "aaaaaaaa")).stdout).toBe(shown.stdout);
  });

  it("show --full prints the full redacted text and no sentinel", async () => {
    const { home } = await fixture();
    const full = await run(home, "show", ids.a, "--full");
    expect(full.code).toBe(0);
    expect(full.stdout).toContain("end-of-long-text");
    expect(full.stdout).not.toContain(SECRET);
    expect(full.stdout).not.toContain("\u001b");
  });

  it("export writes Pi JSONL v3 and parses back", async () => {
    const { home } = await fixture();
    const exported = await run(home, "export", ids.a, "--format", "jsonl");
    expect(exported.code).toBe(0);
    expect(exported.stderr).toBe("");
    const lines = exported.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines[0]).toEqual({ type: "session", version: 3, id: "sdk-a", timestamp: at(0), cwd: "repo" });
    expect(lines.slice(1).map((line) => line.id)).toEqual(["u1", "a1", "r1", "a2"]);
    expect(exported.stdout).not.toContain(SECRET);
    const out = join(home, "export.jsonl");
    expect((await run(home, "export", ids.a, "--format", "jsonl", "--out", out)).code).toBe(0);
    expect(await readFile(out, "utf8")).toBe(exported.stdout);
    expect((await run(home, "export", ids.a, "--format", "jsonl", "--out", out)).code).toBe(1);
    expect((await run(home, "export", ids.a, "--format", "csv")).code).toBe(64);
    const lossy = await fixture({ truncated: true });
    const lossyExport = await run(lossy.home, "export", ids.a, "--format", "jsonl");
    expect(lossyExport.code).toBe(0);
    expect(lossyExport.stderr).toContain("export is lossy");
  });

  it("verdict is append-only and list shows the latest", async () => {
    const { home } = await fixture();
    expect((await run(home, "verdict", ids.a, "rejected", "--reason", "First look.")).code).toBe(0);
    expect((await run(home, "verdict", ids.a, "accepted", "--reason", "Reworked and fine.")).code).toBe(0);
    const query = await run(home, "query", "SELECT verdict, reason, source FROM verdicts ORDER BY id", "--json");
    expect(query.stdout.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      { verdict: "rejected", reason: "First look.", source: "controller" },
      { verdict: "accepted", reason: "Reworked and fine.", source: "controller" },
    ]);
    expect((await run(home, "list", "--task", "#215")).stdout).toContain("\taccepted\n");
  });

  it("verdict rejects an unknown value and a multi-line reason with 64", async () => {
    const { home } = await fixture();
    expect((await run(home, "verdict", ids.a, "great", "--reason", "x")).code).toBe(64);
    expect((await run(home, "verdict", ids.a, "accepted", "--reason", "line one\nline two")).code).toBe(64);
    expect((await run(home, "verdict", ids.a, "accepted", "--reason", "")).code).toBe(64);
    expect((await run(home, "verdict", ids.a, "accepted", "--reason", "x".repeat(501))).code).toBe(64);
    expect((await run(home, "verdict", ids.a, "accepted")).code).toBe(64);
    expect((await run(home, "verdict", "dddddddd-0000-4000-8000-000000000004", "accepted", "--reason", "x")).code).toBe(1);
  });

  it("prune dry run deletes nothing; apply deletes old sessions only", async () => {
    const { home } = await fixture();
    const dry = await run(home, "prune", "--older-than", "30d");
    expect(dry).toMatchObject({ code: 0 });
    expect(dry.stdout).toContain("1 session");
    expect(listedIds((await run(home, "list")).stdout)).toHaveLength(3);
    expect((await run(home, "prune", "--older-than", "30d", "--apply")).code).toBe(0);
    expect(listedIds((await run(home, "list")).stdout)).toEqual(["aaaaaaaa", "cccccccc"]);
    expect((await run(home, "query", "SELECT count(*) AS n FROM entries WHERE session_id NOT IN (SELECT id FROM sessions)")).stdout).toBe("n\n0\n");
    expect((await run(home, "prune", "--older-than", "thirty")).code).toBe(64);
  });

  it("JSON output escapes DEL and C1 controls and stays equal when parsed", async () => {
    const { home } = await fixture();
    const query = await run(home, "query", "SELECT char(155) || '[31m' || char(127) AS v", "--json");
    expect(query.stdout).not.toMatch(/[\u007f-\u009f]/);
    expect(JSON.parse(query.stdout)).toEqual({ v: "\u009b[31m\u007f" });
    const exported = await run(home, "export", ids.a, "--format", "jsonl");
    expect(exported.stdout).not.toMatch(/[\u007f-\u009f]/);
    expect(exported.stdout).toContain("\\u009b32mcsi");
    const lines = exported.stdout.trim().split("\n").map((line) => JSON.parse(line) as { id?: string; message?: { content?: Array<{ text?: string }> } });
    expect(lines.find((line) => line.id === "a2")!.message!.content![0]!.text).toContain("\u009b32mcsi");
  });

  it("query allows SELECT and WITH, refuses INSERT, PRAGMA, ATTACH and two statements", async () => {
    const { home, file } = await fixture();
    expect(await run(home, "query", "  -- count\n SELECT count(*) AS n FROM sessions;")).toMatchObject({ code: 0, stdout: "n\n3\n" });
    expect(await run(home, "query", "WITH s AS (SELECT workspace FROM sessions) SELECT count(*) AS n FROM s")).toMatchObject({ code: 0, stdout: "n\n3\n" });
    const before = readFileSync(file);
    for (const sql of [
      "INSERT INTO verdicts (session_id, verdict, reason, recorded_at, source) VALUES ('x', 'accepted', 'r', 't', 's')",
      "PRAGMA user_version = 9", "ATTACH DATABASE 'other.db' AS other", "SELECT 1; DELETE FROM sessions",
      "WITH s AS (SELECT 1) DELETE FROM sessions", "/* SELECT */ DELETE FROM sessions",
    ]) {
      expect((await run(home, "query", sql)).code, sql).toBe(1);
    }
    expect(readFileSync(file).equals(before)).toBe(true);
    expect((await run(home, "query", "SELECT 'a;b' AS v")).stdout).toBe("v\na;b\n");
  });

  it("missing history file prints a hint and exits 1", async () => {
    const home = await temporaryRoot("history-cli-empty-");
    const result = await run(home, "list");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("~/.local/state/pi-session-mcp/history/");
    expect(result.stderr).not.toContain(home);
    expect(existsSync(historyLocation(home).file)).toBe(false);
  });

  it("unknown command and missing arguments exit 64", async () => {
    const { home } = await fixture();
    expect((await run(home)).code).toBe(64);
    expect((await run(home, "frobnicate")).code).toBe(64);
    expect((await run(home, "show")).code).toBe(64);
    expect((await run(home, "list", "--workspace")).code).toBe(64);
    expect((await run(home, "list", "--bogus", "x")).code).toBe(64);
    expect((await run(home, "query")).code).toBe(64);
    const help = await run(home, "--help");
    expect(help.code).toBe(0);
    for (const command of ["list", "show", "export", "verdict", "prune", "reconcile", "query"]) expect(help.stdout).toContain(command);
  });

  it("reconcile marks sessions of dead instances incomplete", async () => {
    const { home } = await fixture();
    const reconciled = await run(home, "reconcile");
    expect(reconciled.code).toBe(0);
    expect(reconciled.stdout).toMatch(/^\d+ sessions? marked incomplete\n$/);
  });
});

const PRUNE_NOW = new Date("2030-01-01T00:00:00.000Z");
const LIVE_PID = 4_000_000;

async function runPrune(home: string, ...argv: string[]) {
  let stdout = "", stderr = "";
  const code = await runHistoryCli(argv, { stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; }, home, now: () => PRUNE_NOW });
  return { code, stdout, stderr };
}

/**
 * Records one instance per session through the real recorder, optionally backdates its close or its
 * instance end, then reconciles with an injected liveness check: only `live: true` stays alive.
 */
async function pruneFixture(specs: Array<{ id: string; createdAt: string; closedAt?: string; endedAt?: string; live?: boolean }>) {
  const home = await temporaryRoot("history-prune-");
  const store = await openHistoryStore({ home });
  for (const [index, spec] of specs.entries()) {
    const pid = spec.live === true ? LIVE_PID : LIVE_PID + index + 1;
    const recorder = createHistoryRecorder({
      store, redactorFor: () => new Redactor({ knownValues: [], pathRule: compilePathRule([]) }),
      configurationFingerprint: `sha256:${"a".repeat(64)}`, packageVersion: "0.0.0-test",
      instance: { pid, procStart: null }, diagnostic: () => undefined,
    });
    recorder.sessionStarted({ view: view(spec.id, { createdAt: spec.createdAt }), sdkSessionId: `sdk-${spec.id.slice(0, 1)}`, source: "host" });
    recorder.turnEnded(spec.id, turn(spec.id, 1), async () => ({ entries: timeline.slice(0, 2), next: 2, more: false }));
    await recorder.settle(spec.id, 5_000);
    if (spec.closedAt !== undefined) recorder.sessionClosed(view(spec.id, { createdAt: spec.createdAt, state: "closed" }));
    store.db.prepare("UPDATE sessions SET closed_at = ? WHERE public_session_id = ?").run(spec.closedAt ?? null, spec.id);
    if (spec.endedAt !== undefined) store.db.prepare("UPDATE instances SET ended_at = ? WHERE pid = ?").run(spec.endedAt, pid);
  }
  reconcileInstances(store, (pid) => pid === LIVE_PID);
  store.close();
  return home;
}

describe("prune after crash reconciliation", () => {
  it("deletes old closed and old reconciled sessions, keeps recent and running ones", async () => {
    const home = await pruneFixture([
      { id: ids.a, createdAt: "2020-01-01T00:00:00.000Z", closedAt: "2020-01-02T00:00:00.000Z" },
      { id: ids.b, createdAt: "2020-01-01T00:00:00.000Z", endedAt: "2020-01-03T00:00:00.000Z" },
      { id: ids.c, createdAt: "2020-01-01T00:00:00.000Z", endedAt: "2029-12-20T00:00:00.000Z" },
      { id: ids.d, createdAt: "2020-01-01T00:00:00.000Z", live: true },
    ]);
    expect((await run(home, "verdict", ids.b, "accepted", "--reason", "Checked before the crash.")).code).toBe(0);
    expect((await run(home, "query", "SELECT public_session_id, completeness FROM sessions ORDER BY public_session_id", "--json")).stdout.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      { public_session_id: ids.a, completeness: "complete" },
      { public_session_id: ids.b, completeness: "incomplete" },
      { public_session_id: ids.c, completeness: "incomplete" },
      { public_session_id: ids.d, completeness: "complete" },
    ]);

    const dry = await runPrune(home, "prune", "--older-than", "30d");
    expect(dry).toMatchObject({ code: 0, stdout: "2 sessions ended before 2029-12-02 would be deleted; rerun with --apply\n" });
    expect((await run(home, "query", "SELECT count(*) AS n FROM sessions")).stdout).toBe("n\n4\n");

    const applied = await runPrune(home, "prune", "--older-than", "30d", "--apply");
    expect(applied).toMatchObject({ code: 0, stdout: "2 sessions deleted\n" });
    expect((await run(home, "query", "SELECT public_session_id FROM sessions ORDER BY public_session_id", "--json")).stdout.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      { public_session_id: ids.c },
      { public_session_id: ids.d },
    ]);
    // Dependent rows of the deleted sessions are gone; the surviving sessions keep theirs.
    for (const table of ["turns", "entries", "verdicts", "gaps"]) {
      expect((await run(home, "query", `SELECT count(*) AS n FROM ${table} WHERE session_id IS NOT NULL AND session_id NOT IN (SELECT id FROM sessions)`)).stdout).toBe("n\n0\n");
    }
    expect((await run(home, "query", "SELECT count(*) AS n FROM entries")).stdout).toBe("n\n4\n");
    expect((await run(home, "query", "SELECT count(*) AS n FROM turns")).stdout).toBe("n\n2\n");
    expect((await run(home, "query", "SELECT count(*) AS n FROM verdicts")).stdout).toBe("n\n0\n");
  });

  it("issue #258 repro: a session left open by a crashed server is pruned", async () => {
    const home = await pruneFixture([
      { id: ids.a, createdAt: "2020-01-01T00:00:00.000Z", closedAt: "2020-01-01T12:00:00.000Z" },
      { id: ids.b, createdAt: "2020-01-01T00:00:00.000Z" },
    ]);
    expect((await run(home, "query", "SELECT public_session_id, completeness, closed_at FROM sessions ORDER BY public_session_id", "--json")).stdout.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      { public_session_id: ids.a, completeness: "complete", closed_at: "2020-01-01T12:00:00.000Z" },
      { public_session_id: ids.b, completeness: "incomplete", closed_at: null },
    ]);
    const applied = await runPrune(home, "prune", "--older-than", "30d", "--apply");
    expect(applied).toMatchObject({ code: 0, stdout: "2 sessions deleted\n" });
    expect((await run(home, "query", "SELECT count(*) AS n FROM sessions")).stdout).toBe("n\n0\n");
    expect((await run(home, "query", "SELECT count(*) AS n FROM entries WHERE session_id NOT IN (SELECT id FROM sessions)")).stdout).toBe("n\n0\n");
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { claimsRoot, eventsRoot, serializeTurnEvent, turnEventFileName, TURN_EVENT_MAX_BYTES, type TurnEvent } from "../src/turn-events.js";
import {
  CLAIM_MAX_AGE_MS, DEFAULT_BUDGET_MS, cleanupOldClaims, formatBudgetWake, formatTerminalWake, newSpoolCache, parseBudgetArgs, parseHookInput,
  payloadCandidates, releaseClaim, scanTurnEvents, tryClaim, waitForTurn, type WaitResult,
} from "../src/wake-hook.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

const SESSION = "11111111-1111-4111-8111-111111111111", TURN = "22222222-2222-4222-8222-222222222222", OTHER_TURN = "44444444-4444-4444-8444-444444444444";
const INSTANCE = "inst-0123456789abcdef", INSTANCE_B = "inst-fedcba9876543210";
const target = { sessionId: SESSION, turnId: TURN };

const running = { ok: true, turn: { turnId: TURN, sessionId: SESSION, state: "running" } };
const promptPayload = { ok: true, session: { id: SESSION, workspace: "w", executionProfile: "p", state: "running" }, turn: { turnId: TURN, sessionId: SESSION, state: "running" } };
const hookInput = (tool: string, response: unknown, server = "pi-session-mcp") => JSON.stringify({ tool_name: `mcp__${server}__${tool}`, tool_input: {}, tool_response: response, tool_use_id: "toolu_unit" });
const shapes = (payload: unknown): unknown[] => [payload, JSON.stringify(payload), [{ type: "text", text: JSON.stringify(payload) }], { content: [{ type: "text", text: "x" }], structuredContent: payload }, { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false }];

describe("hook input parsing", () => {
  it("reads session and turn from every response shape of pi_session_prompt", () => {
    for (const response of shapes(promptPayload)) expect(parseHookInput(hookInput("pi_session_prompt", response))).toEqual(target);
  });
  it("re-arms on a pi_turn_get that still shows the turn running, in every shape", () => {
    for (const response of shapes(running)) expect(parseHookInput(hookInput("pi_turn_get", response))).toEqual(target);
  });
  it("accepts writer registrations and rejects look-alike server names", () => {
    expect(parseHookInput(hookInput("pi_session_prompt", promptPayload, "pi-coding-review-w1"))).toEqual(target);
    expect(parseHookInput(hookInput("pi_turn_get", running, "pi-coding-code_x-y-w16"))).toEqual(target);
    for (const server of ["pi-coding-review-w0", "pi-coding-review-w17", "pi-coding-Review-w1", "pi-coding--w1", "pi-coding-review", "pi-session-mcp2", "other", "pi-eval", "pi-coding-review-w1x", `pi-coding-${"a".repeat(65)}-w1`]) {
      expect(parseHookInput(hookInput("pi_session_prompt", promptPayload, server)), server).toBeUndefined();
    }
  });
  it("arms only on the two read tools of the product servers", () => {
    for (const tool of ["pi_session_start", "pi_session_close", "pi_session_abort", "pi_session_status", "eval_question_answer", "pi_turn_get_x", "xpi_turn_get"]) {
      expect(parseHookInput(hookInput(tool, promptPayload)), tool).toBeUndefined();
    }
    expect(parseHookInput(JSON.stringify({ tool_name: "pi_session_prompt", tool_response: promptPayload }))).toBeUndefined();
    expect(parseHookInput(JSON.stringify({ tool_name: "mcp__pi-session-mcp__pi_session_prompt__x", tool_response: promptPayload }))).toBeUndefined();
  });
  it("requires ok:true and a running turn", () => {
    expect(parseHookInput(hookInput("pi_session_prompt", { ...promptPayload, ok: false }))).toBeUndefined();
    const { ok: _ok, ...noOk } = promptPayload;
    expect(parseHookInput(hookInput("pi_session_prompt", noOk))).toBeUndefined();
    expect(parseHookInput(hookInput("pi_session_prompt", { ok: false, error: { code: "session_running", message: "x" } }))).toBeUndefined();
    for (const state of ["completed", "failed", "aborted", "idle", undefined]) {
      expect(parseHookInput(hookInput("pi_turn_get", { ok: true, turn: { ...running.turn, state } })), String(state)).toBeUndefined();
      expect(parseHookInput(hookInput("pi_session_prompt", { ...promptPayload, turn: { ...promptPayload.turn, state } })), String(state)).toBeUndefined();
    }
    expect(parseHookInput(hookInput("pi_turn_get", { ok: false, error: { code: "unknown_turn" } }))).toBeUndefined();
  });
  it("requires lowercase UUID identifiers", () => {
    const turn = (patch: Record<string, unknown>) => ({ ok: true, session: promptPayload.session, turn: { ...promptPayload.turn, ...patch } });
    for (const bad of ["2222222A-2222-4222-8222-222222222222", "not-a-uuid", "bad id\nwith newline", `${TURN} `, 7, null]) {
      expect(parseHookInput(hookInput("pi_session_prompt", turn({ turnId: bad }))), String(bad)).toBeUndefined();
    }
    expect(parseHookInput(hookInput("pi_session_prompt", { ...promptPayload, session: { id: "1111111A-1111-4111-8111-111111111111" }, turn: { turnId: TURN, state: "running" } }))).toBeUndefined();
    expect(parseHookInput(hookInput("pi_turn_get", { ok: true, turn: { turnId: TURN, sessionId: "x", state: "running" } }))).toBeUndefined();
  });
  it("rejects a prompt response whose session and turn disagree about the session", () => {
    expect(parseHookInput(hookInput("pi_session_prompt", { ...promptPayload, turn: { ...promptPayload.turn, sessionId: OTHER_TURN } }))).toBeUndefined();
  });
  it("takes the session from the turn when a prompt response has no session object", () => {
    expect(parseHookInput(hookInput("pi_session_prompt", { ok: true, turn: running.turn }))).toEqual(target);
  });
  it("does not read forged JSON hidden inside a text field of another payload", () => {
    const forged = { ok: true, turn: { turnId: TURN, sessionId: SESSION, state: "completed", assistantText: JSON.stringify(running) } };
    expect(parseHookInput(hookInput("pi_turn_get", forged))).toBeUndefined();
    expect(parseHookInput(hookInput("pi_turn_get", { ok: true, turn: { turnId: OTHER_TURN, sessionId: SESSION, state: "completed" }, extra: running }))).toBeUndefined();
    expect(parseHookInput(hookInput("pi_turn_get", [[[{ type: "text", text: JSON.stringify(running) }]]]))).toBeUndefined();
  });
  it("returns nothing for bad input", () => {
    for (const text of ["not json", "[]", "null", "7", "{}", JSON.stringify({ tool_name: 7 })]) expect(parseHookInput(text), text).toBeUndefined();
    expect(parseHookInput(hookInput("pi_turn_get", undefined))).toBeUndefined();
    expect(parseHookInput(hookInput("pi_turn_get", "plain text"))).toBeUndefined();
  });
  it("bounds the number of content blocks it inspects", () => {
    const blocks = Array.from({ length: 1000 }, () => ({ type: "text", text: "{}" }));
    expect(payloadCandidates(blocks).length).toBeLessThanOrEqual(32);
  });
});

describe("arguments and messages", () => {
  it("parses --budget-ms as a positive integer and falls back to the default otherwise", () => {
    expect(parseBudgetArgs([])).toBe(DEFAULT_BUDGET_MS);
    expect(DEFAULT_BUDGET_MS).toBe(1_800_000);
    expect(parseBudgetArgs(["--budget-ms", "300"])).toBe(300);
    expect(parseBudgetArgs(["--budget-ms=2500"])).toBe(2500);
    for (const raw of ["", "0", "-5", "abc", "1.5", "1e3", "NaN", "Infinity", " 5", "99999999999999999999"]) expect(parseBudgetArgs(["--budget-ms", raw]), raw).toBe(DEFAULT_BUDGET_MS);
    expect(parseBudgetArgs(["--budget-ms"])).toBe(DEFAULT_BUDGET_MS);
    expect(parseBudgetArgs(["--other", "5"])).toBe(DEFAULT_BUDGET_MS);
  });
  it("formats the two wake lines with identifiers and a state only", () => {
    expect(formatTerminalWake({ session: SESSION, turn: TURN, state: "failed" })).toBe(`pi-session-mcp: turn ${TURN} of session ${SESSION} is failed. Read it once with pi_turn_get.`);
    expect(formatBudgetWake(TURN)).toBe(`pi-session-mcp: no event for turn ${TURN} within the wait budget; it may still be running. Read it once with pi_turn_get to re-arm.`);
  });
});

// ---- spool fixtures

let counter = 0;
const terminal = (patch: Partial<Extract<TurnEvent, { kind: "turn_terminal" }>> = {}): Extract<TurnEvent, { kind: "turn_terminal" }> =>
  ({ v: 1, seq: patch.seq ?? 1, at: patch.at ?? new Date(Date.UTC(2026, 9, 21, 10, 0, 0, 0) + (counter++) * 1000).toISOString(), instance: INSTANCE, kind: "turn_terminal", session: SESSION, turn: TURN, state: "completed", via: "registry", ...patch });
const ended = (patch: Partial<Extract<TurnEvent, { kind: "instance_ended" }>> = {}): TurnEvent =>
  ({ v: 1, seq: patch.seq ?? 2, at: new Date(Date.UTC(2026, 9, 21, 11, 0, 0, 0) + (counter++) * 1000).toISOString(), instance: INSTANCE, kind: "instance_ended", reason: "eof", ...patch });

async function fixture() {
  const xdg = await temporaryRoot("wake-hook-");
  const env = { XDG_RUNTIME_DIR: xdg } as NodeJS.ProcessEnv;
  const events = eventsRoot(env)!, claims = claimsRoot(env)!;
  mkdirSync(events, { recursive: true, mode: 0o700 });
  const put = (event: TurnEvent, dir: string = join(events, event.instance)) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, turnEventFileName(event));
    writeFileSync(path, serializeTurnEvent(event), { mode: 0o600 });
    return path;
  };
  return { xdg, env, events, claims, put };
}
const wait = (f: { events: string; claims: string }, extra: Partial<Parameters<typeof waitForTurn>[0]> = {}) =>
  waitForTurn({ eventsRoot: f.events, claimsDir: f.claims, ...target, budgetMs: 5000, pollMs: 20, ...extra });
const later = (ms: number, fn: () => void) => new Promise<void>((resolve) => setTimeout(() => { fn(); resolve(); }, ms));

describe("scanTurnEvents", () => {
  it("reads events of instance directories and of writer subdirectories, ordered by time and sequence", async () => {
    const f = await fixture();
    const a = terminal({ seq: 2, at: "2026-10-21T10:00:02.000Z" }), b = terminal({ seq: 1, at: "2026-10-21T10:00:01.000Z", instance: INSTANCE_B });
    const c = terminal({ seq: 1, at: "2026-10-21T10:00:00.000Z", instance: "inst-aaaaaaaaaaaaaaaa", turn: OTHER_TURN });
    f.put(a); f.put(b); f.put(c, join(f.events, "writer-review-w1", c.instance));
    const { events, directories } = scanTurnEvents(f.events);
    expect(events).toEqual([c, b, a]);
    expect(directories).toHaveLength(3);
  });
  it("returns nothing for a missing root and ignores a root that is a link", async () => {
    const f = await fixture();
    expect(scanTurnEvents(join(f.xdg, "absent")).events).toEqual([]);
    f.put(terminal());
    const link = join(f.xdg, "link-to-events");
    symlinkSync(f.events, link);
    expect(scanTurnEvents(link).events).toEqual([]);
  });
  it("never follows links: not for event files, instance directories or writer directories", async () => {
    const f = await fixture();
    const outside = join(f.xdg, "outside");
    mkdirSync(outside);
    const real = terminal({ instance: INSTANCE_B });
    writeFileSync(join(outside, turnEventFileName(real)), serializeTurnEvent(real));
    const dir = join(f.events, INSTANCE);
    mkdirSync(dir);
    symlinkSync(join(outside, turnEventFileName(real)), join(dir, "00000001-turn_terminal.json"));
    symlinkSync(outside, join(f.events, INSTANCE_B)); // instance dir link
    symlinkSync(outside, join(f.events, "writer-code-w2")); // writer dir link
    mkdirSync(join(f.events, "writer-code-w3"));
    symlinkSync(outside, join(f.events, "writer-code-w3", INSTANCE_B)); // instance dir link below a writer
    expect(scanTurnEvents(f.events).events).toEqual([]);
  });
  it("ignores oversized files, non-regular entries, bad names, invalid JSON, wrong writer names and a directory that does not carry the event's instance", async () => {
    const f = await fixture();
    const good = f.put(terminal({ seq: 1 }));
    expect(good).toContain(INSTANCE);
    const dir = join(f.events, INSTANCE);
    const padded = JSON.stringify({ ...JSON.parse(serializeTurnEvent(terminal({ seq: 2 }))), pad: "x".repeat(TURN_EVENT_MAX_BYTES) });
    writeFileSync(join(dir, "00000002-turn_terminal.json"), padded);
    mkdirSync(join(dir, "00000003-turn_terminal.json")); // a directory with an event name
    writeFileSync(join(dir, "4-turn_terminal.json"), serializeTurnEvent(terminal({ seq: 4 })));
    writeFileSync(join(dir, "00000005-other.json"), serializeTurnEvent(terminal({ seq: 5 })));
    writeFileSync(join(dir, "00000006-turn_terminal.json.tmp"), serializeTurnEvent(terminal({ seq: 6 })));
    writeFileSync(join(dir, "00000007-turn_terminal.json"), "{not json");
    writeFileSync(join(dir, "00000008-turn_terminal.json"), JSON.stringify({ ...JSON.parse(serializeTurnEvent(terminal({ seq: 8 }))), extra: 1 }));
    f.put(terminal({ seq: 9 }), join(f.events, "writer-Bad_Name-w1", INSTANCE));
    f.put(terminal({ seq: 10 }), join(f.events, "writer-code-w17", INSTANCE));
    f.put(terminal({ seq: 11 }), join(f.events, "writer-code-w1", "inst-short"));
    f.put(terminal({ seq: 12 }), join(f.events, "other", INSTANCE));
    f.put(terminal({ seq: 13, instance: INSTANCE_B }), join(f.events, INSTANCE)); // forged: directory and instance differ
    expect(scanTurnEvents(f.events).events.map((e) => e.seq)).toEqual([1]);
  });
  it("caps the entries read per directory and the directories per scan", async () => {
    const f = await fixture();
    for (let seq = 1; seq <= 6; seq += 1) f.put(terminal({ seq }));
    expect(scanTurnEvents(f.events, newSpoolCache(), { entriesPerDirectory: 3 }).events).toHaveLength(3);
    for (let i = 0; i < 5; i += 1) f.put(terminal({ seq: 1, instance: `inst-${String(i).repeat(16)}` }));
    const limited = scanTurnEvents(f.events, newSpoolCache(), { directories: 2 });
    expect(limited.directories).toHaveLength(2);
    expect(scanTurnEvents(f.events).directories).toHaveLength(6);
  });
  it("counts writer directories and their instance directories against the directory cap", async () => {
    const f = await fixture();
    for (let i = 0; i < 4; i += 1) f.put(terminal({ seq: 1, instance: `inst-${String(i).repeat(16)}` }), join(f.events, "writer-code-w1", `inst-${String(i).repeat(16)}`));
    expect(scanTurnEvents(f.events, newSpoolCache(), { directories: 3 }).directories.length).toBeLessThanOrEqual(3);
  });
  it("caches parsed files by path, size and mtime, and rereads a changed file", async () => {
    const f = await fixture();
    const path = f.put(terminal({ seq: 1 }));
    const cache = newSpoolCache();
    expect(scanTurnEvents(f.events, cache).events.map((e) => (e as { state?: string }).state)).toEqual(["completed"]);
    expect(cache.files.size).toBe(1);
    if (process.getuid?.() !== 0) {
      chmodSync(path, 0); // an unreadable file still answers from the cache while path, size and mtime are unchanged
      expect(scanTurnEvents(f.events, cache).events.map((e) => (e as { state?: string }).state)).toEqual(["completed"]);
      chmodSync(path, 0o600);
    }
    writeFileSync(path, serializeTurnEvent(terminal({ seq: 1, state: "aborted", via: "close" })));
    expect(scanTurnEvents(f.events, cache).events.map((e) => (e as { state?: string }).state)).toEqual(["aborted"]);
  });
});

describe("claims", () => {
  it("creates the claims directory with mode 0700 and claims exclusively with mode 0600", async () => {
    const f = await fixture();
    const event = terminal();
    const first = tryClaim(f.claims, event);
    expect(first).toBe(join(f.claims, `${INSTANCE}-1`));
    expect(tryClaim(f.claims, event)).toBeUndefined();
    expect(statSync(f.claims).mode & 0o777).toBe(0o700);
    expect(statSync(first!).mode & 0o777).toBe(0o600);
    releaseClaim(first);
    expect(tryClaim(f.claims, event)).toBe(first);
  });
  it("refuses a claims directory that others can write or that is not a directory", async () => {
    const f = await fixture();
    mkdirSync(f.claims, { mode: 0o700 }); chmodSync(f.claims, 0o770);
    expect(() => tryClaim(f.claims, terminal())).toThrow();
    const g = await fixture();
    mkdirSync(join(g.xdg, "pi-session-mcp"), { recursive: true }); writeFileSync(g.claims, "not a directory");
    expect(() => tryClaim(g.claims, terminal())).toThrow();
  });
  it("removes claim files older than 24 hours, keeps fresh claims and non-files", async () => {
    const f = await fixture();
    mkdirSync(f.claims, { recursive: true, mode: 0o700 });
    const old = join(f.claims, `${INSTANCE}-1`), fresh = join(f.claims, `${INSTANCE}-2`), dir = join(f.claims, "old-dir");
    for (const p of [old, fresh]) writeFileSync(p, "");
    mkdirSync(dir);
    const past = new Date(Date.now() - CLAIM_MAX_AGE_MS - 60_000);
    utimesSync(old, past, past); utimesSync(dir, past, past);
    expect(cleanupOldClaims(f.claims)).toBe(1);
    expect(readdirSync(f.claims).sort()).toEqual([`${INSTANCE}-2`, "old-dir"]);
    expect(cleanupOldClaims(join(f.xdg, "absent"))).toBe(0);
  });
  it("bounds the number of claim entries a cleanup looks at", async () => {
    const f = await fixture();
    mkdirSync(f.claims, { recursive: true, mode: 0o700 });
    const past = new Date(Date.now() - CLAIM_MAX_AGE_MS - 60_000);
    for (let i = 1; i <= 5; i += 1) { const p = join(f.claims, `${INSTANCE}-${i}`); writeFileSync(p, ""); utimesSync(p, past, past); }
    expect(cleanupOldClaims(f.claims, Date.now(), CLAIM_MAX_AGE_MS, 2)).toBe(2);
    expect(readdirSync(f.claims)).toHaveLength(3);
  });
  it("keeps claims outside the events root and refuses a claims directory below it", async () => {
    const f = await fixture();
    expect(f.claims.startsWith(`${f.events}/`)).toBe(false);
    expect(f.events.startsWith(`${f.claims}/`)).toBe(false);
    f.put(terminal());
    expect(await wait(f, { claimsDir: join(f.events, "claims") })).toEqual({ action: "silent", reason: "claims_unsafe" });
    expect(await wait(f, { claimsDir: f.events })).toEqual({ action: "silent", reason: "claims_unsafe" });
    expect(existsSync(join(f.events, "claims"))).toBe(false);
  });
});

describe("waitForTurn (in process)", () => {
  it("wakes on a terminal event written after the wait started and records the claim outside the events root", async () => {
    const f = await fixture();
    let held: string | undefined;
    const [result] = await Promise.all([wait(f, { onClaim: (p) => { held = p; } }), later(100, () => f.put(terminal({ state: "failed" })))]);
    expect(result).toEqual({ action: "wake", reason: "terminal", message: formatTerminalWake({ session: SESSION, turn: TURN, state: "failed" }), claimPath: join(f.claims, `${INSTANCE}-1`) });
    expect(held).toBe(join(f.claims, `${INSTANCE}-1`));
    expect(readdirSync(f.claims)).toEqual([`${INSTANCE}-1`]);
  });
  it("wakes at once for an event already in the spool, also from a writer directory", async () => {
    const f = await fixture();
    f.put(terminal({ instance: INSTANCE_B }), join(f.events, "writer-code-w1", INSTANCE_B));
    const started = Date.now();
    const result = await wait(f);
    expect(result).toMatchObject({ action: "wake", reason: "terminal", message: expect.stringContaining("is completed.") });
    expect(Date.now() - started).toBeLessThan(1000);
  });
  it("ignores other turns, other sessions and instance_ended events", async () => {
    const f = await fixture();
    f.put(terminal({ seq: 1, turn: OTHER_TURN })); f.put(terminal({ seq: 2, session: OTHER_TURN })); f.put(ended({ seq: 3 }));
    const result = await wait(f, { budgetMs: 200 });
    expect(result).toMatchObject({ action: "wake", reason: "budget" });
    expect(existsSync(f.claims) ? readdirSync(f.claims) : []).toEqual([]);
  });
  it("lets exactly one of several concurrent waiters win the claim; the others stay silent", async () => {
    const f = await fixture();
    const waiters = [wait(f), wait(f), wait(f), wait(f)];
    await later(100, () => f.put(terminal()));
    const results: WaitResult[] = await Promise.all(waiters);
    expect(results.filter((r) => r.action === "wake")).toHaveLength(1);
    expect(results.filter((r) => r.action === "silent")).toEqual(Array(3).fill({ action: "silent", reason: "lost_claim" }));
    expect(readdirSync(f.claims)).toHaveLength(1);
  });
  it("reports a lost claim as silent when the event was already claimed", async () => {
    const f = await fixture();
    f.put(terminal());
    expect(tryClaim(f.claims, terminal())).toBeDefined();
    expect(await wait(f)).toEqual({ action: "silent", reason: "lost_claim" });
  });
  it("ends silently with a reason code when the claim cannot be written", async () => {
    const f = await fixture();
    f.put(terminal());
    mkdirSync(join(f.xdg, "pi-session-mcp"), { recursive: true }); writeFileSync(f.claims, "not a directory");
    expect(await wait(f)).toMatchObject({ action: "silent", reason: "claim_error", code: expect.stringMatching(/^[A-Z0-9_]+$/) });
  });
  it("wakes with the budget line when the budget ends, without a claim", async () => {
    const f = await fixture();
    const started = Date.now();
    const result = await wait(f, { budgetMs: 150 });
    expect(result).toEqual({ action: "wake", reason: "budget", message: formatBudgetWake(TURN) });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(existsSync(f.claims)).toBe(false);
  });
  it("ends silently when the parent disappears", async () => {
    const f = await fixture();
    let alive = true;
    const started = Date.now();
    const [result] = await Promise.all([wait(f, { isParentAlive: () => alive, parentCheckMs: 30, budgetMs: 10_000 }), later(100, () => { alive = false; })]);
    expect(result).toEqual({ action: "silent", reason: "parent_gone" });
    expect(Date.now() - started).toBeLessThan(2000);
  });
  it("stops when aborted", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const [result] = await Promise.all([wait(f, { signal: controller.signal, budgetMs: 10_000 }), later(100, () => controller.abort())]);
    expect(result).toEqual({ action: "silent", reason: "aborted" });
  });
  it("finds an event that appears in a directory created after the wait started", async () => {
    const f = await fixture();
    const [result] = await Promise.all([wait(f, { budgetMs: 10_000 }), later(150, () => f.put(terminal({ instance: INSTANCE_B }), join(f.events, "writer-code-w4", INSTANCE_B)))]);
    expect(result).toMatchObject({ action: "wake", reason: "terminal" });
  });
});

// ---- compiled program

const REPOSITORY = fileURLToPath(new URL("..", import.meta.url));
const COMPILED = join(REPOSITORY, "dist", "wake-main.js");
const exec = promisify(execFile);
let compiledReady = false;

beforeAll(async () => {
  // dist is a build artifact: rebuild when it is absent or older than the sources it is built from.
  const sources = ["src/wake-main.ts", "src/wake-hook.ts", "src/turn-events.ts", "src/entry-point.ts"].map((p) => join(REPOSITORY, p));
  const fresh = existsSync(COMPILED) && sources.every((p) => statSync(p).mtimeMs <= statSync(COMPILED).mtimeMs);
  if (!fresh) {
    try { await exec(process.execPath, [join(REPOSITORY, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"], { cwd: REPOSITORY, timeout: 120_000 }); } catch { /* the compiled tests skip */ }
  }
  compiledReady = existsSync(COMPILED);
}, 150_000);

interface Exit { code: number | null; signal: NodeJS.Signals | null; stderr: string; stdout: string }
function runWaiter(xdg: string | undefined, stdin: string, args: string[] = [], options: { nodeArgs?: string[]; env?: Record<string, string> } = {}) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", ...(xdg === undefined ? {} : { XDG_RUNTIME_DIR: xdg }), ...options.env };
  const child = spawn(process.execPath, [...(options.nodeArgs ?? []), COMPILED, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "", stdout = "";
  child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
  child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
  child.stdin.end(stdin);
  return { child, done: new Promise<Exit>((resolve) => child.once("close", (code, signal) => resolve({ code, signal, stderr, stdout }))) };
}
const armInput = hookInput("pi_session_prompt", [{ type: "text", text: JSON.stringify(promptPayload) }]);

describe("compiled pi-session-mcp-wake process", () => {
  const needBuild = (): void => { if (!compiledReady) throw new Error("dist/wake-main.js could not be built"); };

  it("has a node shebang and is registered as a package bin", () => {
    needBuild();
    expect(readFileSync(COMPILED, "utf8").split("\n")[0]).toBe("#!/usr/bin/env node");
    const manifest = JSON.parse(readFileSync(join(REPOSITORY, "package.json"), "utf8")) as { bin: Record<string, string>; files: string[] };
    expect(manifest.bin["pi-session-mcp-wake"]).toBe("dist/wake-main.js");
    expect(manifest.files).toContain("dist/");
  });
  it("exits 2 with exactly one stderr line, nothing on stdout, when the turn's event arrives", async () => {
    needBuild();
    const f = await fixture();
    const waiter = runWaiter(f.xdg, armInput, ["--budget-ms", "20000"]);
    await later(500, () => f.put(terminal()));
    const exit = await waiter.done;
    expect(exit).toMatchObject({ code: 2, stdout: "", stderr: `pi-session-mcp: turn ${TURN} of session ${SESSION} is completed. Read it once with pi_turn_get.\n` });
    expect(readdirSync(f.claims)).toEqual([`${INSTANCE}-1`]);
    expect(statSync(f.claims).mode & 0o777).toBe(0o700);
  });
  it("wakes at once for a pi_turn_get that shows the turn running when the event is already there", async () => {
    needBuild();
    const f = await fixture();
    f.put(terminal({ state: "aborted", via: "close" }));
    const exit = await runWaiter(f.xdg, hookInput("pi_turn_get", { content: [{ type: "text", text: "x" }], structuredContent: running }, "pi-coding-review-w2")).done;
    expect(exit).toMatchObject({ code: 2, stderr: `pi-session-mcp: turn ${TURN} of session ${SESSION} is aborted. Read it once with pi_turn_get.\n` });
  });
  it("exits 0 silently when nothing arms: other tool, failed prompt, bad JSON, no runtime directory, relative runtime directory", async () => {
    needBuild();
    const f = await fixture();
    f.put(terminal());
    const cases: Array<[string | undefined, string]> = [
      [f.xdg, hookInput("pi_session_start", promptPayload)], [f.xdg, hookInput("pi_session_prompt", { ok: false })], [f.xdg, "not json"], [f.xdg, ""],
      [undefined, armInput], ["relative/dir", armInput],
    ];
    for (const [xdg, input] of cases) expect(await runWaiter(xdg, input).done, String(xdg)).toMatchObject({ code: 0, stderr: "", stdout: "" });
    expect(existsSync(f.claims)).toBe(false);
  });
  it("exits 0 silently, without a stack trace, when the claim cannot be written", async () => {
    needBuild();
    const f = await fixture();
    f.put(terminal());
    writeFileSync(f.claims, "not a directory");
    expect(await runWaiter(f.xdg, armInput).done).toMatchObject({ code: 0, stderr: "", stdout: "" });
  });
  it("with several concurrent processes on one turn exactly one exits 2", async () => {
    needBuild();
    const f = await fixture();
    const waiters = [0, 1, 2].map(() => runWaiter(f.xdg, armInput, ["--budget-ms", "20000"]));
    await later(700, () => f.put(terminal()));
    const exits = await Promise.all(waiters.map((w) => w.done));
    expect(exits.map((e) => e.code).sort()).toEqual([0, 0, 2]);
    expect(exits.filter((e) => e.code === 2).map((e) => e.stderr)).toEqual([`pi-session-mcp: turn ${TURN} of session ${SESSION} is completed. Read it once with pi_turn_get.\n`]);
    expect(readdirSync(f.claims)).toHaveLength(1);
  });
  it("wakes with the budget line and exit 2 when --budget-ms ends", async () => {
    needBuild();
    const f = await fixture();
    const exit = await runWaiter(f.xdg, armInput, ["--budget-ms", "400"]).done;
    expect(exit).toMatchObject({ code: 2, stdout: "", stderr: `pi-session-mcp: no event for turn ${TURN} within the wait budget; it may still be running. Read it once with pi_turn_get to re-arm.\n` });
  });
  it("treats an invalid budget as the default instead of waking or exiting at once", async () => {
    needBuild();
    const f = await fixture();
    const runs = ["abc", "0", "-3"].map((raw) => runWaiter(f.xdg, armInput, ["--budget-ms", raw]));
    let early = 0;
    for (const run of runs) void run.done.then(() => { early += 1; });
    await later(900, () => undefined);
    expect(early).toBe(0);
    for (const run of runs) run.child.kill("SIGKILL");
    await Promise.all(runs.map((run) => run.done));
  });
  it("removes claims older than 24 hours on a run and leaves fresh ones", async () => {
    needBuild();
    const f = await fixture();
    mkdirSync(f.claims, { recursive: true, mode: 0o700 });
    const old = join(f.claims, `${INSTANCE_B}-9`), fresh = join(f.claims, `${INSTANCE_B}-10`);
    writeFileSync(old, ""); writeFileSync(fresh, "");
    const past = new Date(Date.now() - CLAIM_MAX_AGE_MS - 60_000);
    utimesSync(old, past, past);
    await runWaiter(f.xdg, armInput, ["--budget-ms", "200"]).done;
    expect(readdirSync(f.claims)).toEqual([`${INSTANCE_B}-10`]);
  });
  it("releases a claim it holds but has not delivered when SIGTERM arrives, and exits 143", async () => {
    needBuild();
    const f = await fixture();
    f.put(terminal());
    // The preload swallows the stderr write and its callback, so the process stays between "claimed" and "delivered".
    const preload = join(f.xdg, "hold-stderr.mjs");
    await writeFile(preload, "process.stderr.write = () => true;\nsetInterval(() => undefined, 1000);\n");
    const waiter = runWaiter(f.xdg, armInput, [], { nodeArgs: ["--import", preload] });
    const claim = join(f.claims, `${INSTANCE}-1`);
    const end = Date.now() + 10_000;
    while (Date.now() < end && !existsSync(claim)) await later(50, () => undefined);
    expect(existsSync(claim)).toBe(true);
    waiter.child.kill("SIGTERM");
    const exit = await waiter.done;
    expect(exit.code).toBe(143);
    expect(await readdir(f.claims)).toEqual([]);
    // A later waiter can report the event again.
    expect(await runWaiter(f.xdg, armInput).done).toMatchObject({ code: 2 });
  });
  it("exits 0 within about three seconds after its parent process is gone", async () => {
    needBuild();
    const f = await fixture();
    const input = join(f.xdg, "input.json"), pidFile = join(f.xdg, "pid");
    await writeFile(input, armInput);
    // The shell starts the waiter in the background, stays one second so the waiter records its parent, then exits and orphans it.
    const shell = spawn("sh", ["-c", `"${process.execPath}" "${COMPILED}" --budget-ms 60000 < "${input}" > /dev/null 2>&1 & echo $! > "${pidFile}"; sleep 1`], {
      env: { PATH: process.env.PATH ?? "", XDG_RUNTIME_DIR: f.xdg }, stdio: "ignore",
    });
    await new Promise<void>((resolve) => shell.once("close", () => resolve()));
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(Number.isInteger(pid) && pid > 1).toBe(true);
    const alive = (): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const end = Date.now() + 4000;
    while (Date.now() < end && alive()) await later(100, () => undefined);
    const gone = !alive();
    if (!gone) process.kill(pid, "SIGKILL");
    expect(gone).toBe(true);
    expect(await stat(f.events).then(() => true)).toBe(true);
  });
});

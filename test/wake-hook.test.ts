import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { claimsRoot, eventsRoot, serializeTurnEvent, turnEventFileName, writerEventsDir, TURN_EVENT_MAX_BYTES, type TurnEvent } from "../src/turn-events.js";
import {
  CLAIM_MAX_AGE_MS, DEFAULT_BUDGET_MS, cleanupOldClaims, formatBudgetWake, formatTerminalWake, newSpoolCache, parseBudgetArgs, parseHookInput,
  payloadCandidates, releaseClaim, scanTurnEvents, tryClaim, waitForTurn, claimKey, CACHE_MAX_ENTRIES, SCAN_MAX_INSTANCE_DIRECTORIES, acquireWaiterLock, releaseWaiterLock, waiterLockName, NO_SPOOL_GRACE_MS, CAPPED_SCAN_GAP_MS, MIN_SCAN_GAP_MS, isSupportedPlatform, SCAN_MAX_ENTRIES_PER_SCAN, SCAN_MAX_BYTES_PER_SCAN, isNoSpace, type WaitResult, type WakeNamespace,
} from "../src/wake-hook.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

const SESSION = "11111111-1111-4111-8111-111111111111", TURN = "22222222-2222-4222-8222-222222222222", OTHER_TURN = "44444444-4444-4444-8444-444444444444";
const INSTANCE = "inst-0123456789abcdef", INSTANCE_B = "inst-fedcba9876543210";
const target = { sessionId: SESSION, turnId: TURN, namespace: { kind: "host" } as WakeNamespace };
const writerTarget = (name: string) => ({ sessionId: SESSION, turnId: TURN, namespace: { kind: "writer", name } as WakeNamespace });

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
  it("ignores writer registrations and rejects look-alike server names", () => {
    expect(parseHookInput(hookInput("pi_session_prompt", promptPayload, "pi-coding-review-w1"))).toBeUndefined();
    expect(parseHookInput(hookInput("pi_turn_get", running, "pi-coding-code_x-y-w16"))).toBeUndefined();
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

describe("unsupported platforms", () => {
  it("judges the platform and the proc handle directory", () => {
    expect(isSupportedPlatform("darwin")).toBe(false);
    expect(isSupportedPlatform("win32")).toBe(false);
    expect(isSupportedPlatform("linux", "/nonexistent/proc/self/fd")).toBe(false);
    if (process.platform === "linux") expect(isSupportedPlatform("linux")).toBe(true);
  });
  it("makes the program exit 0 at once, silently, without reading anything", async () => {
    const { main } = await import("../src/wake-main.js");
    const writes: string[] = [];
    const stderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => { writes.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      for (const dependencies of [{ platform: "darwin" }, { platform: "win32" }, { platform: "linux", procFd: "/nonexistent/proc/self/fd" }]) {
        const codes: number[] = [];
        await main(["--budget-ms", "100"], { XDG_RUNTIME_DIR: "/nonexistent" }, { ...dependencies, exit: (code) => { codes.push(code); } });
        expect(codes, JSON.stringify(dependencies)).toEqual([0]);
      }
    } finally { process.stderr.write = stderr; }
    expect(writes).toEqual([]);
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
  const home = join(xdg, "home");
  const wdir = (name: string): string => writerEventsDir(home, name)!;
  return { xdg, env, events, claims, put, home, wdir };
}
const scan = (f: { events: string; home: string }, namespace: WakeNamespace, cache = newSpoolCache(), limits: Parameters<typeof scanTurnEvents>[3] = {}) => scanTurnEvents(f.events, namespace, cache, { home: f.home, ...limits });
const wait = (f: { events: string; claims: string; home: string }, extra: Partial<Parameters<typeof waitForTurn>[0]> = {}) =>
  waitForTurn({ eventsRoot: f.events, claimsDir: f.claims, home: f.home, ...target, budgetMs: 5000, pollMs: 20, ...extra });
const later = (ms: number, fn: () => void) => new Promise<void>((resolve) => setTimeout(() => { fn(); resolve(); }, ms));

// Event delivery is Linux-first (ADR 0011): everything that reads a spool or runs the program is Linux-only.
const linuxOnly = describe.runIf(process.platform === "linux");
const HOST: WakeNamespace = { kind: "host" };
const W1: WakeNamespace = { kind: "writer", name: "code-w1" };
const states = (events: TurnEvent[]) => events.map((e) => (e as { state?: string }).state);

linuxOnly("scanTurnEvents", () => {
  it("reads only the requested namespace, ordered by time and sequence", async () => {
    const f = await fixture();
    const a = terminal({ seq: 2, at: "2026-10-21T10:00:02.000Z" }), b = terminal({ seq: 1, at: "2026-10-21T10:00:01.000Z", instance: INSTANCE_B });
    const c = terminal({ seq: 1, at: "2026-10-21T10:00:00.000Z", instance: "inst-aaaaaaaaaaaaaaaa" });
    const d = terminal({ seq: 1, instance: "inst-bbbbbbbbbbbbbbbb" });
    f.put(a); f.put(b); f.put(c, join(f.wdir("code-w1"), c.instance)); f.put(d, join(f.wdir("code-w2"), d.instance));
    const host = scan(f, HOST);
    expect(host.events).toEqual([b, a]);
    expect(host.directories).toHaveLength(3);
    expect(scan(f, W1).events).toEqual([c]);
    expect(scan(f, { kind: "writer", name: "code-w2" }).events).toEqual([d]);
    expect(scan(f, { kind: "writer", name: "code-w3" }).events).toEqual([]);
    expect(scan(f, { kind: "writer", name: "Bad Name" }).events).toEqual([]);
  });
  it("does not even list another writer's directory", async () => {
    const f = await fixture();
    const other = join(f.wdir("code-w2"));
    f.put(terminal({ instance: INSTANCE_B }), join(other, INSTANCE_B));
    const result = scan(f, W1);
    expect(result.directories).toEqual([]);
    chmodSync(other, 0); // an unreadable foreign directory is no obstacle if it is never touched
    try { expect(scan(f, HOST).events).toEqual([]); expect(scan(f, W1).events).toEqual([]); } finally { chmodSync(other, 0o700); }
  });
  it("returns nothing for a missing root or namespace, and for a root that is a link", async () => {
    const f = await fixture();
    expect(scanTurnEvents(join(f.xdg, "absent"), HOST).events).toEqual([]);
    f.put(terminal());
    const link = join(f.xdg, "link-to-events");
    symlinkSync(f.events, link);
    expect(scanTurnEvents(link, HOST).events).toEqual([]);
    expect(scan(f, W1).events).toEqual([]);
  });
  describe("reads through directory handles", () => {
    const limits = {};
    it("never follows links: not for event files, instance directories, writer directories or a link as the root", async () => {
      const f = await fixture();
      const outside = join(f.xdg, "outside");
      mkdirSync(outside);
      const real = terminal({ instance: INSTANCE_B });
      writeFileSync(join(outside, turnEventFileName(real)), serializeTurnEvent(real));
      const dir = join(f.events, INSTANCE);
      mkdirSync(dir);
      symlinkSync(join(outside, turnEventFileName(real)), join(dir, "00000001-turn_terminal.json"));
      symlinkSync(outside, join(f.events, INSTANCE_B)); // instance dir link
      mkdirSync(dirname(f.wdir("code-w2")), { recursive: true });
      symlinkSync(outside, f.wdir("code-w2")); // the writer's events directory is a link
      mkdirSync(f.wdir("code-w3"), { recursive: true });
      symlinkSync(outside, join(f.wdir("code-w3"), INSTANCE_B)); // instance dir link below a writer
      expect(scan(f, HOST, newSpoolCache(), limits).events).toEqual([]);
      expect(scan(f, { kind: "writer", name: "code-w2" }, newSpoolCache(), limits).events).toEqual([]);
      expect(scan(f, { kind: "writer", name: "code-w3" }, newSpoolCache(), limits).events).toEqual([]);
    });
    it("ignores oversized files, non-regular entries, bad names, invalid JSON and a directory that does not carry the event's instance", async () => {
      const f = await fixture();
      f.put(terminal({ seq: 1 }));
      const dir = join(f.events, INSTANCE);
      writeFileSync(join(dir, "00000002-turn_terminal.json"), JSON.stringify({ ...JSON.parse(serializeTurnEvent(terminal({ seq: 2 }))), pad: "x".repeat(TURN_EVENT_MAX_BYTES) }));
      mkdirSync(join(dir, "00000003-turn_terminal.json")); // a directory with an event name
      writeFileSync(join(dir, "4-turn_terminal.json"), serializeTurnEvent(terminal({ seq: 4 })));
      writeFileSync(join(dir, "00000005-other.json"), serializeTurnEvent(terminal({ seq: 5 })));
      writeFileSync(join(dir, "00000006-turn_terminal.json.tmp"), serializeTurnEvent(terminal({ seq: 6 })));
      writeFileSync(join(dir, "00000007-turn_terminal.json"), "{not json");
      writeFileSync(join(dir, "00000008-turn_terminal.json"), JSON.stringify({ ...JSON.parse(serializeTurnEvent(terminal({ seq: 8 }))), extra: 1 }));
      f.put(terminal({ seq: 13, instance: INSTANCE_B }), join(f.events, INSTANCE)); // forged: directory and instance differ
      f.put(terminal({ seq: 9 }), join(f.events, "writer-Bad_Name-w1", INSTANCE)); // never read: not a valid writer name
      expect(scan(f, HOST, newSpoolCache(), limits).events.map((e) => e.seq)).toEqual([1]);
    });
    it("caps the entries read per directory", async () => {
      const f = await fixture();
      for (let seq = 1; seq <= 6; seq += 1) f.put(terminal({ seq }));
      expect(scan(f, HOST, newSpoolCache(), { ...limits, entriesPerDirectory: 3 }).events).toHaveLength(3);
    });
    it("reads at most the newest instance directories of a namespace", async () => {
      const f = await fixture();
      const names = Array.from({ length: 5 }, (_, i) => `inst-${String(i).repeat(16)}`);
      names.forEach((instance, i) => {
        f.put(terminal({ seq: 1, instance }), join(f.wdir("code-w1"), instance));
        const when = new Date(Date.UTC(2026, 9, 21, 10, i, 0)); utimesSync(join(f.wdir("code-w1"), instance), when, when);
      });
      const result = scan(f, W1, newSpoolCache(), { ...limits, instanceDirectories: 2 });
      expect(result.events.map((e) => e.instance).sort()).toEqual([names[3]!, names[4]!]);
      expect(SCAN_MAX_INSTANCE_DIRECTORIES).toBe(64);
    });
    it("lets a worker that floods its own writer namespace affect neither the host nor another writer", async () => {
      const f = await fixture();
      const real = terminal({ seq: 1 });
      f.put(real);
      const mine = terminal({ seq: 1, instance: "inst-aaaaaaaaaaaaaaaa" });
      f.put(mine, join(f.wdir("code-w2"), mine.instance));
      for (let i = 0; i < 100; i += 1) { const dir = join(f.wdir("code-w1"), `inst-${i.toString(16).padStart(16, "0")}`); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "00000001-turn_terminal.json"), "{}"); }
      for (let i = 0; i < 100; i += 1) mkdirSync(join(f.wdir("code-w1"), `junk-${i}`));
      expect(scan(f, HOST, newSpoolCache(), limits).events).toEqual([real]);
      expect(scan(f, { kind: "writer", name: "code-w2" }, newSpoolCache(), limits).events).toEqual([mine]);
      expect(scan(f, W1, newSpoolCache(), limits).directories.length).toBeLessThanOrEqual(1 + SCAN_MAX_INSTANCE_DIRECTORIES);
    });
    it("rejects a directory owned by someone else", async () => {
      if (typeof process.getuid !== "function" || process.getuid() === 0) return;
      const f = await fixture();
      f.put(terminal());
      const getuid = process.getuid;
      process.getuid = () => getuid.call(process) + 1;
      try { expect(scan(f, HOST, newSpoolCache(), limits).events).toEqual([]); } finally { process.getuid = getuid; }
    });
  });
  it("closes every directory handle it opened", async () => {
    const f = await fixture();
    for (const instance of [INSTANCE, INSTANCE_B]) f.put(terminal({ instance }));
    const count = () => readdirSync("/proc/self/fd").length;
    if (!existsSync("/proc/self/fd")) return;
    scan(f, HOST);
    const before = count();
    for (let i = 0; i < 20; i += 1) scan(f, HOST);
    expect(count()).toBe(before);
  });
  it("rebuilds the cache from the files of each scan and caps it, so it cannot grow under churn", async () => {
    const f = await fixture();
    const cache = newSpoolCache();
    const path = f.put(terminal({ seq: 1 }));
    expect(states(scan(f, HOST, cache).events)).toEqual(["completed"]);
    expect(cache.files.size).toBe(1);
    for (let i = 0; i < 5; i += 1) { // each rewrite changes size and mtime: the old key must not stay behind
      writeFileSync(path, serializeTurnEvent(terminal({ seq: 1, state: i % 2 ? "failed" : "aborted", via: "close" })) + " ".repeat(i + 1));
      scan(f, HOST, cache);
      expect(cache.files.size).toBe(1);
    }
    rmSync(path);
    scan(f, HOST, cache);
    expect(cache.files.size).toBe(0);
    for (let seq = 1; seq <= 6; seq += 1) f.put(terminal({ seq }));
    expect(scan(f, HOST, cache, { cacheEntries: 4 }).events).toHaveLength(6); // uncached files are still read
    expect(cache.files.size).toBe(4);
    expect(CACHE_MAX_ENTRIES).toBe(4096);
  });
  it("answers from the cache while the file is unchanged, and rereads a replaced or rewritten one", async () => {
    const f = await fixture();
    const path = f.put(terminal({ seq: 1 }));
    const cache = newSpoolCache();
    expect(states(scan(f, HOST, cache).events)).toEqual(["completed"]);
    expect(cache.reads).toBe(1);
    for (let i = 0; i < 3; i += 1) expect(states(scan(f, HOST, cache).events)).toEqual(["completed"]);
    expect(cache.reads).toBe(1);
    writeFileSync(path, serializeTurnEvent(terminal({ seq: 1, state: "aborted", via: "close" })));
    expect(states(scan(f, HOST, cache).events)).toEqual(["aborted"]);
    expect(cache.reads).toBe(2);
    // replaced by another file of the same name (new inode)
    const replacement = `${path}.new`;
    writeFileSync(replacement, serializeTurnEvent(terminal({ seq: 1, state: "failed", via: "close" })));
    renameSync(replacement, path);
    expect(states(scan(f, HOST, cache).events)).toEqual(["failed"]);
    expect(cache.reads).toBe(3);
  });
  it("caches negative results too, so unparseable, oversized and non-regular entries are not read again", async () => {
    const f = await fixture();
    f.put(terminal({ seq: 1 }));
    const dir = join(f.events, INSTANCE);
    writeFileSync(join(dir, "00000002-turn_terminal.json"), "{not json");
    writeFileSync(join(dir, "00000003-turn_terminal.json"), JSON.stringify({ pad: "x".repeat(TURN_EVENT_MAX_BYTES) }));
    mkdirSync(join(dir, "00000004-turn_terminal.json"));
    symlinkSync(join(dir, "00000001-turn_terminal.json"), join(dir, "00000005-turn_terminal.json"));
    const cache = newSpoolCache();
    expect(scan(f, HOST, cache).events).toHaveLength(1);
    expect(cache.reads).toBe(2); // the valid and the unparseable file; the others are never opened
    expect(cache.files.size).toBe(5);
    for (let i = 0; i < 3; i += 1) scan(f, HOST, cache);
    expect(cache.reads).toBe(2);
  });
  it("bounds the work of one scan: names listed and lstat'ed over all directories, and reports that a cap was hit", async () => {
    const f = await fixture();
    for (const instance of [INSTANCE, INSTANCE_B, "inst-cccccccccccccccc"]) for (let seq = 1; seq <= 4; seq += 1) f.put(terminal({ seq, instance }));
    const full = scan(f, HOST);
    expect(full).toMatchObject({ capped: false, namespaceFound: true, instanceDirectoryCount: 3 });
    expect(full.events).toHaveLength(12);
    const limited = scan(f, HOST, newSpoolCache(), { entriesPerScan: 10 });
    expect(limited.capped).toBe(true);
    expect(limited.events.length).toBeLessThan(12);
    expect(SCAN_MAX_ENTRIES_PER_SCAN).toBe(2048);
    expect(scan(f, HOST, newSpoolCache(), { entriesPerDirectory: 2 }).capped).toBe(true);
    expect(scan(f, HOST, newSpoolCache(), { instanceDirectories: 2 }).capped).toBe(true);
  });
  it("reads a writer's events from its state directory under the home, and never from the old runtime location", async () => {
    const f = await fixture();
    const wanted = terminal({ seq: 1, instance: INSTANCE_B });
    f.put(wanted, join(f.wdir("code-w1"), wanted.instance));
    expect(f.wdir("code-w1")).toBe(join(f.home, ".local", "state", "pi-session-mcp", "writers", "code-w1", "events"));
    expect(scan(f, W1).events).toEqual([wanted]);
    // the same writer's events under the old location below the events root are ignored
    const old = terminal({ seq: 2, instance: "inst-dddddddddddddddd" });
    f.put(old, join(f.events, "writer-code-w1", old.instance));
    expect(scan(f, W1).events).toEqual([wanted]);
    expect(scan(f, HOST).events).toEqual([]); // and the host does not read a writer directory
    const g = await fixture();
    g.put(old, join(g.events, "writer-code-w1", old.instance));
    expect(scan(g, W1)).toMatchObject({ events: [], namespaceFound: false });
    // another home is another spool; a home that is not absolute reads nothing
    expect(scanTurnEvents(f.events, W1, newSpoolCache(), { home: g.home }).events).toEqual([]);
    expect(scanTurnEvents(f.events, W1, newSpoolCache(), { home: "relative/home" })).toMatchObject({ events: [], namespaceFound: false });
  });
  it("retains only events of the armed session and turn, in the result and in the cache", async () => {
    const f = await fixture();
    f.put(terminal({ seq: 1 }));
    f.put(terminal({ seq: 2, turn: OTHER_TURN })); f.put(terminal({ seq: 3, session: OTHER_TURN })); f.put(ended({ seq: 4 }));
    const cache = newSpoolCache();
    const result = scan(f, HOST, cache, { retain: target });
    expect(result.events.map((e) => e.seq)).toEqual([1]);
    expect([...cache.files.values()].filter((value) => value !== null).map((value) => value!.seq)).toEqual([1]);
    expect(cache.files.size).toBe(4); // the others are kept as misses, so they are not read again
    const reads = cache.reads;
    scan(f, HOST, cache, { retain: target });
    expect(cache.reads).toBe(reads);
    expect(scan(f, HOST).events).toHaveLength(4); // without a filter everything is kept
  });
  it("reads at most a byte budget per scan, reports the cap, and makes progress over scans through the cache", async () => {
    const f = await fixture();
    const size = Buffer.byteLength(serializeTurnEvent(terminal({ seq: 1 })));
    for (let seq = 1; seq <= 6; seq += 1) f.put(terminal({ seq, turn: seq === 6 ? TURN : OTHER_TURN }));
    const cache = newSpoolCache();
    const limits = { retain: target, bytesPerScan: size * 3 + 1 };
    const first = scan(f, HOST, cache, limits);
    expect(first.capped).toBe(true);
    expect(cache.reads).toBe(3);
    const second = scan(f, HOST, cache, limits); // the three cached files cost nothing, so the rest fits
    expect(second.capped).toBe(false);
    expect(cache.reads).toBe(6);
    expect(second.events.map((e) => e.seq)).toEqual([6]);
    expect(SCAN_MAX_BYTES_PER_SCAN).toBe(256 * 1024);
  });
  it("reports whether the namespace and an instance directory exist", async () => {
    const f = await fixture();
    expect(scan(f, W1)).toMatchObject({ namespaceFound: false, instanceDirectoryCount: 0 });
    mkdirSync(f.wdir("code-w1"), { recursive: true });
    expect(scan(f, W1)).toMatchObject({ namespaceFound: true, instanceDirectoryCount: 0 });
    expect(scan(f, HOST)).toMatchObject({ namespaceFound: true, instanceDirectoryCount: 0 });
  });
});

linuxOnly("claims", () => {
  it("creates the claims directory with mode 0700 and claims exclusively with mode 0600", async () => {
    const f = await fixture();
    const event = terminal();
    const first = tryClaim(f.claims, event, HOST);
    expect(first).toBe(join(f.claims, `host-${INSTANCE}-1`));
    expect(tryClaim(f.claims, event, HOST)).toBeUndefined();
    expect(statSync(f.claims).mode & 0o777).toBe(0o700);
    expect(statSync(first!).mode & 0o777).toBe(0o600);
    releaseClaim(first);
    expect(tryClaim(f.claims, event, HOST)).toBe(first);
  });
  it("puts the namespace into the claim key, so one namespace never takes or blocks a claim of another", async () => {
    const f = await fixture();
    const event = terminal();
    expect(claimKey(HOST, event)).toBe(`host-${INSTANCE}-1`);
    expect(claimKey(W1, event)).toBe(`writer-code-w1-${INSTANCE}-1`);
    const keys = [tryClaim(f.claims, event, HOST), tryClaim(f.claims, event, W1), tryClaim(f.claims, event, { kind: "writer", name: "code-w2" })];
    expect(keys.every((k) => k !== undefined)).toBe(true);
    expect(new Set(keys).size).toBe(3);
    expect(tryClaim(f.claims, event, W1)).toBeUndefined();
  });
  it("refuses claim keys built from unvalidated parts", () => {
    expect(() => claimKey({ kind: "writer", name: "../x" }, terminal())).toThrow();
    expect(() => claimKey({ kind: "writer", name: "code-w1/../.." }, terminal())).toThrow();
    expect(() => claimKey(HOST, { instance: "inst-../../x", seq: 1 })).toThrow();
    expect(() => claimKey(HOST, { instance: INSTANCE, seq: 0 })).toThrow();
  });
  it("refuses a claims directory that others can write or that is not a directory", async () => {
    const f = await fixture();
    mkdirSync(f.claims, { mode: 0o700 });
    for (const mode of [0o770, 0o750, 0o705, 0o701, 0o740, 0o702]) { chmodSync(f.claims, mode); expect(() => tryClaim(f.claims, terminal(), HOST), mode.toString(8)).toThrow(); }
    chmodSync(f.claims, 0o700);
    expect(tryClaim(f.claims, terminal(), HOST)).toBeDefined();
    const g = await fixture();
    mkdirSync(join(g.xdg, "pi-session-mcp"), { recursive: true }); writeFileSync(g.claims, "not a directory");
    expect(() => tryClaim(g.claims, terminal(), HOST)).toThrow();
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

linuxOnly("waitForTurn (in process)", () => {
  it("wakes on a terminal event written after the wait started and records the claim outside the events root", async () => {
    const f = await fixture();
    let held: string | undefined;
    const [result] = await Promise.all([wait(f, { onClaim: (p) => { held = p; } }), later(100, () => f.put(terminal({ state: "failed" })))]);
    expect(result).toEqual({ action: "wake", reason: "terminal", message: formatTerminalWake({ session: SESSION, turn: TURN, state: "failed" }), claimPath: join(f.claims, `host-${INSTANCE}-1`) });
    expect(held).toBe(join(f.claims, `host-${INSTANCE}-1`));
    expect(readdirSync(f.claims)).toEqual([`host-${INSTANCE}-1`]);
  });
  it("wakes at once for an event already in the spool", async () => {
    const f = await fixture();
    f.put(terminal({ instance: INSTANCE_B }));
    const started = Date.now();
    const result = await wait(f);
    expect(result).toMatchObject({ action: "wake", reason: "terminal", message: expect.stringContaining("is completed.") });
    expect(Date.now() - started).toBeLessThan(1000);
  });
  it("wakes a writer controller only for events of exactly that writer's namespace", async () => {
    const f = await fixture();
    f.put(terminal({ instance: INSTANCE_B }), join(f.wdir("code-w2"), INSTANCE_B)); // another writer
    f.put(terminal({ instance: INSTANCE_B }), join(f.events, INSTANCE_B)); // the host
    expect(await wait(f, { namespace: W1, budgetMs: 250 })).toMatchObject({ action: "wake", reason: "budget" });
    f.put(terminal({ instance: "inst-cccccccccccccccc" }), join(f.wdir("code-w1"), "inst-cccccccccccccccc"));
    const result = await wait(f, { namespace: W1 });
    expect(result).toMatchObject({ action: "wake", reason: "terminal", claimPath: join(f.claims, "writer-code-w1-inst-cccccccccccccccc-1") });
  });
  it("ends silently, without a claim, for a terminal event produced by close", async () => {
    const f = await fixture();
    f.put(terminal({ state: "aborted", via: "close" }));
    expect(await wait(f)).toEqual({ action: "silent", reason: "closed" });
    expect(existsSync(f.claims) ? readdirSync(f.claims) : []).toEqual([]);
    const [later_] = await Promise.all([wait(f, { namespace: W1 }), later(100, () => f.put(terminal({ state: "failed", via: "close" }), join(f.wdir("code-w1"), INSTANCE)))]);
    expect(later_).toEqual({ action: "silent", reason: "closed" });
    expect(existsSync(f.claims) ? readdirSync(f.claims) : []).toEqual([]);
  });
  it("does not let a host waiter take an event that only a writer namespace holds", async () => {
    const f = await fixture();
    f.put(terminal(), join(f.wdir("code-w1"), INSTANCE));
    expect(await wait(f, { budgetMs: 250 })).toMatchObject({ action: "wake", reason: "budget" });
    expect(existsSync(f.claims) ? readdirSync(f.claims) : []).toEqual([]);
  });
  it("lets a forged event in a writer namespace neither take nor block the host's claim", async () => {
    const f = await fixture();
    f.put(terminal(), join(f.wdir("code-w1"), INSTANCE)); // same instance and seq as the real event
    expect(await wait(f, { namespace: W1 })).toMatchObject({ action: "wake", reason: "terminal" }); // the worker's own wake
    f.put(terminal());
    const host = await wait(f);
    expect(host).toMatchObject({ action: "wake", reason: "terminal", claimPath: join(f.claims, `host-${INSTANCE}-1`) });
    expect(readdirSync(f.claims).sort()).toEqual([`host-${INSTANCE}-1`, `writer-code-w1-${INSTANCE}-1`]);
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
    expect(tryClaim(f.claims, terminal(), HOST)).toBeDefined();
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
  it("wakes a writer controller from the state directory under the home, and not for an event in the old runtime location", async () => {
    const f = await fixture();
    f.put(terminal({ instance: INSTANCE_B }), join(f.events, "writer-code-w1", INSTANCE_B)); // old location
    expect(await wait(f, { namespace: W1, graceMs: 200, budgetMs: 10_000 })).toEqual({ action: "silent", reason: "no_spool" });
    const [result] = await Promise.all([wait(f, { namespace: W1, graceMs: 1500 }), later(150, () => f.put(terminal({ instance: INSTANCE_B }), join(f.wdir("code-w1"), INSTANCE_B)))]);
    expect(result).toMatchObject({ action: "wake", reason: "terminal", claimPath: join(f.claims, `writer-code-w1-${INSTANCE_B}-1`) });
  });
  it("refuses a claims directory inside a writer's spool", async () => {
    const f = await fixture();
    f.put(terminal(), join(f.wdir("code-w1"), INSTANCE));
    expect(await wait(f, { namespace: W1, claimsDir: join(f.wdir("code-w1"), "claims") })).toEqual({ action: "silent", reason: "claims_unsafe" });
  });
  it("recognizes a full runtime directory by its error code only", () => {
    expect(isNoSpace(Object.assign(new Error("x"), { code: "ENOSPC" }))).toBe(true);
    expect(isNoSpace(Object.assign(new Error("x"), { code: "EDQUOT" }))).toBe(true);
    for (const code of ["EACCES", "EEXIST", "ENOTDIR", undefined]) expect(isNoSpace(Object.assign(new Error("x"), { code }))).toBe(false);
    expect(isNoSpace(undefined)).toBe(false);
  });
  it("does not conclude no_spool from a flooded writer spool: junk names beside an instance directory, or more junk than can be listed", async () => {
    const f = await fixture();
    const spool = f.wdir("code-w1");
    mkdirSync(spool, { recursive: true });
    for (let i = 0; i < 3000; i += 1) writeFileSync(join(spool, `junk-${i}`), "");
    mkdirSync(join(spool, INSTANCE_B));
    expect(scan(f, W1)).toMatchObject({ namespaceFound: true, instanceDirectoryCount: 1 }); // the junk does not eat the listing budget
    expect(await wait(f, { namespace: W1, graceMs: 200, budgetMs: 900 })).toMatchObject({ action: "wake", reason: "budget" });
    f.put(terminal({ instance: INSTANCE_B }), join(spool, INSTANCE_B));
    expect(await wait(f, { namespace: W1, graceMs: 200, budgetMs: 5000 })).toMatchObject({ action: "wake", reason: "terminal" });
    // more junk than the per-directory cap: the listing is incomplete, so the spool may exist and the wait goes on
    const g = await fixture();
    const big = g.wdir("code-w1");
    mkdirSync(big, { recursive: true });
    for (let i = 0; i < 300; i += 1) writeFileSync(join(big, `junk-${i}`), "");
    expect(await wait(g, { namespace: W1, graceMs: 200, budgetMs: 900, limits: { entriesPerDirectory: 100 } })).toMatchObject({ action: "wake", reason: "budget" });
    // a complete listing without any instance directory still ends the wait
    const h = await fixture();
    mkdirSync(h.wdir("code-w1"), { recursive: true });
    writeFileSync(join(h.wdir("code-w1"), "junk"), "");
    expect(await wait(h, { namespace: W1, graceMs: 200, budgetMs: 5000 })).toEqual({ action: "silent", reason: "no_spool" });
  });
  it("ends silently with no_spool when the armed namespace has no instance directory after the grace period", async () => {
    const f = await fixture();
    const started = Date.now();
    expect(await wait(f, { graceMs: 300, budgetMs: 10_000 })).toEqual({ action: "silent", reason: "no_spool" });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await wait(f, { namespace: W1, graceMs: 200, budgetMs: 10_000 })).toEqual({ action: "silent", reason: "no_spool" }); // writer-code-w1 missing
    mkdirSync(f.wdir("code-w1"), { recursive: true }); // the directory alone is no spool
    expect(await wait(f, { namespace: W1, graceMs: 200, budgetMs: 10_000 })).toEqual({ action: "silent", reason: "no_spool" });
    f.put(terminal({ instance: INSTANCE_B }), join(f.wdir("code-w2"), INSTANCE_B)); // another namespace does not count
    expect(await wait(f, { namespace: W1, graceMs: 200, budgetMs: 10_000 })).toEqual({ action: "silent", reason: "no_spool" });
    expect(NO_SPOOL_GRACE_MS).toBe(2000);
  });
  it("keeps waiting when the spool shows up within the grace period, and never gives up once it has seen one", async () => {
    const f = await fixture();
    const [woke] = await Promise.all([wait(f, { graceMs: 1500, budgetMs: 10_000 }), later(200, () => f.put(terminal()))]);
    expect(woke).toMatchObject({ action: "wake", reason: "terminal" });
    const g = await fixture();
    g.put(terminal({ turn: OTHER_TURN })); // a spool exists, but not for this turn
    expect(await wait(g, { graceMs: 100, budgetMs: 500 })).toMatchObject({ action: "wake", reason: "budget" });
  });
  it("slows its scans to one per second once a cap was hit (injected clock and delay, no wall time)", async () => {
    const f = await fixture();
    for (let seq = 1; seq <= 5; seq += 1) f.put(terminal({ seq, turn: OTHER_TURN }));
    const run = async (limits: NonNullable<Parameters<typeof scanTurnEvents>[3]>, budgetMs: number) => {
      let t = 1_000_000;
      const sleeps: number[] = [];
      const result = await wait(f, { limits, graceMs: 1_000_000, budgetMs, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } });
      return { result, sleeps };
    };
    const capped = await run({ entriesPerDirectory: 2 }, 3500); // 5 files, 2 listed: the listing is capped
    expect(capped.result).toMatchObject({ action: "wake", reason: "budget" });
    expect(capped.sleeps.length).toBeGreaterThan(0);
    expect(capped.sleeps.every((ms) => ms === CAPPED_SCAN_GAP_MS)).toBe(true);
    const free = await run({}, 100);
    expect(free.result).toMatchObject({ action: "wake", reason: "budget" });
    expect(free.sleeps.length).toBeGreaterThan(0);
    expect(free.sleeps.every((ms) => ms === MIN_SCAN_GAP_MS)).toBe(true);
  });
  it("finds an event that appears in a directory created after the wait started", async () => {
    const f = await fixture();
    const [result] = await Promise.all([wait(f, { namespace: { kind: "writer", name: "code-w4" }, budgetMs: 10_000 }), later(150, () => f.put(terminal({ instance: INSTANCE_B }), join(f.wdir("code-w4"), INSTANCE_B)))]);
    expect(result).toMatchObject({ action: "wake", reason: "terminal" });
  });
});

linuxOnly("per-turn waiter lock", () => {
  const dead = () => false, alive = () => true;
  it("names the lock by namespace, session and turn with validated parts", () => {
    expect(waiterLockName(HOST, SESSION, TURN)).toBe(`wait-host-${SESSION}-${TURN}`);
    expect(waiterLockName(W1, SESSION, TURN)).toBe(`wait-writer-code-w1-${SESSION}-${TURN}`);
    expect(() => waiterLockName({ kind: "writer", name: "../x" }, SESSION, TURN)).toThrow();
    expect(() => waiterLockName(HOST, "../x", TURN)).toThrow();
  });
  it("takes the lock with the pid in it and refuses a second waiter of the same turn while the first is alive", async () => {
    const f = await fixture();
    mkdirSync(f.claims, { recursive: true, mode: 0o700 });
    const path = acquireWaiterLock(f.claims, HOST, SESSION, TURN, { pid: 4242, isAlive: alive });
    expect(path).toBe(join(f.claims, `wait-host-${SESSION}-${TURN}`));
    expect(readFileSync(path!, "utf8")).toBe("4242");
    expect(statSync(path!).mode & 0o777).toBe(0o600);
    expect(acquireWaiterLock(f.claims, HOST, SESSION, TURN, { pid: 4243, isAlive: alive })).toBeUndefined();
    expect(readFileSync(path!, "utf8")).toBe("4242");
  });
  it("gives other turns, sessions and namespaces their own lock", async () => {
    const f = await fixture();
    mkdirSync(f.claims, { recursive: true, mode: 0o700 });
    const options = { isAlive: alive };
    const locks = [acquireWaiterLock(f.claims, HOST, SESSION, TURN, options), acquireWaiterLock(f.claims, HOST, SESSION, OTHER_TURN, options), acquireWaiterLock(f.claims, W1, SESSION, TURN, options), acquireWaiterLock(f.claims, HOST, OTHER_TURN, TURN, options)];
    expect(locks.every((l) => l !== undefined) && new Set(locks).size === 4).toBe(true);
  });
  it("replaces a stale lock: owner dead, owner too old, or content unusable", async () => {
    const f = await fixture();
    mkdirSync(f.claims, { recursive: true, mode: 0o700 });
    const path = join(f.claims, waiterLockName(HOST, SESSION, TURN));
    writeFileSync(path, "4242");
    expect(acquireWaiterLock(f.claims, HOST, SESSION, TURN, { pid: 7, isAlive: dead })).toBe(path);
    expect(readFileSync(path, "utf8")).toBe("7");
    const past = new Date(Date.now() - 10_000);
    utimesSync(path, past, past);
    expect(acquireWaiterLock(f.claims, HOST, SESSION, TURN, { pid: 8, isAlive: alive, maxAgeMs: 5000 })).toBe(path); // alive pid, but older than the longest wait: a reused pid
    expect(readFileSync(path, "utf8")).toBe("8");
    writeFileSync(path, "not a pid"); utimesSync(path, past, past);
    expect(acquireWaiterLock(f.claims, HOST, SESSION, TURN, { pid: 9, isAlive: alive })).toBe(path);
    writeFileSync(path, ""); // a lock still being written is young and counts as held
    expect(acquireWaiterLock(f.claims, HOST, SESSION, TURN, { pid: 10, isAlive: alive })).toBeUndefined();
  });
  it("sees a really dead and a really live process correctly", async () => {
    const f = await fixture();
    mkdirSync(f.claims, { recursive: true, mode: 0o700 });
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    await new Promise((resolve) => child.once("close", resolve));
    writeFileSync(join(f.claims, waiterLockName(HOST, SESSION, TURN)), String(child.pid));
    expect(acquireWaiterLock(f.claims, HOST, SESSION, TURN)).toBeDefined();
    expect(acquireWaiterLock(f.claims, HOST, SESSION, TURN)).toBeUndefined(); // now held by this very process
  });
  it("releases only a lock that still names its own pid", async () => {
    const f = await fixture();
    mkdirSync(f.claims, { recursive: true, mode: 0o700 });
    const path = acquireWaiterLock(f.claims, HOST, SESSION, TURN, { pid: 11 })!;
    releaseWaiterLock(path, 12);
    expect(existsSync(path)).toBe(true);
    releaseWaiterLock(path, 11);
    expect(existsSync(path)).toBe(false);
    releaseWaiterLock(path, 11); releaseWaiterLock(undefined);
  });
});

// ---- compiled program

const REPOSITORY = fileURLToPath(new URL("..", import.meta.url));
const COMPILED = join(REPOSITORY, "dist", "wake-main.js");
const exec = promisify(execFile);
let compiledReady = false;

beforeAll(async () => {
  if (process.platform !== "linux") return;
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
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", ...(xdg === undefined ? {} : { XDG_RUNTIME_DIR: xdg, HOME: join(xdg, "home") }), ...options.env };
  const child = spawn(process.execPath, [...(options.nodeArgs ?? []), COMPILED, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "", stdout = "";
  child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
  child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
  child.stdin.end(stdin);
  return { child, done: new Promise<Exit>((resolve) => child.once("close", (code, signal) => resolve({ code, signal, stderr, stdout }))) };
}
const armFor = (turnId: string) => hookInput("pi_session_prompt", { ...promptPayload, turn: { ...promptPayload.turn, turnId } });
const armInput = hookInput("pi_session_prompt", [{ type: "text", text: JSON.stringify(promptPayload) }]);

linuxOnly("compiled pi-session-mcp-wake process", () => {
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
    expect(readdirSync(f.claims)).toEqual([`host-${INSTANCE}-1`]);
    expect(statSync(f.claims).mode & 0o777).toBe(0o700);
  });
  it("wakes at once for a pi_turn_get that shows the turn running when the event is already there", async () => {
    needBuild();
    const f = await fixture();
    f.put(terminal({ state: "aborted", via: "registry" }));
    const exit = await runWaiter(f.xdg, hookInput("pi_turn_get", { content: [{ type: "text", text: "x" }], structuredContent: running })).done;
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
    f.put(terminal({ turn: OTHER_TURN })); // a spool exists, so no_spool does not apply
    const turns = ["aaaaaaaa-0000-4000-8000-000000000001", "aaaaaaaa-0000-4000-8000-000000000002", "aaaaaaaa-0000-4000-8000-000000000003"];
    const runs = ["abc", "0", "-3"].map((raw, i) => runWaiter(f.xdg, armFor(turns[i]!), ["--budget-ms", raw]));
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
    const claim = join(f.claims, `host-${INSTANCE}-1`);
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
    f.put(terminal({ turn: OTHER_TURN })); // a spool exists, so the exit below is the parent check and not no_spool
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
    expect(readdirSync(f.claims).filter((n) => n.startsWith("wait-"))).toEqual([]);
  });
  it("exits 0 silently, leaving no lock, when the armed namespace has no spool after the grace period", async () => {
    needBuild();
    const f = await fixture();
    const started = Date.now();
    const host = await runWaiter(f.xdg, armInput, ["--budget-ms", "60000"]).done;
    expect(host).toMatchObject({ code: 0, stderr: "", stdout: "" });
    expect(Date.now() - started).toBeLessThan(6000);
    f.put(terminal()); // the host has a spool, but the armed writer does not
    const writer = await runWaiter(f.xdg, hookInput("pi_session_prompt", promptPayload, "pi-coding-review-w2"), ["--budget-ms", "60000"]).done;
    expect(writer).toMatchObject({ code: 0, stderr: "", stdout: "" });
    expect(readdirSync(f.claims).filter((n) => !n.startsWith("wait-"))).toEqual([]);
    expect(readdirSync(f.claims)).toEqual([]);
  });
  it("lets only one process wait for a turn: a second arm for the same turn exits 0 at once, and the lock is gone after the wake", async () => {
    needBuild();
    const f = await fixture();
    f.put(terminal({ turn: OTHER_TURN }));
    const first = runWaiter(f.xdg, armInput, ["--budget-ms", "20000"]);
    const lock = join(f.claims, waiterLockName(HOST, SESSION, TURN));
    const end = Date.now() + 5000;
    while (Date.now() < end && !existsSync(lock)) await later(30, () => undefined);
    expect(readFileSync(lock, "utf8")).toBe(String(first.child.pid));
    const started = Date.now();
    const second = await runWaiter(f.xdg, armInput, ["--budget-ms", "20000"]).done;
    expect(second).toMatchObject({ code: 0, stderr: "", stdout: "" });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(first.child.exitCode).toBeNull();
    // An obsolete writer tool does not arm a waiter or consume its event.
    f.put(terminal({ instance: INSTANCE_B }), join(f.wdir("review-w2"), INSTANCE_B));
    const writer = await runWaiter(f.xdg, hookInput("pi_session_prompt", promptPayload, "pi-coding-review-w2"), []).done;
    expect(writer.code).toBe(0);
    f.put(terminal());
    const exit = await first.done;
    expect(exit.code).toBe(2);
    expect(existsSync(lock)).toBe(false);
    // after the wake a re-arm is possible again
    expect(existsSync(join(f.claims, `host-${INSTANCE}-1`))).toBe(true);
  });
  it("removes the waiter lock on a budget wake, on SIGTERM and replaces a lock whose owner died", async () => {
    needBuild();
    const f = await fixture();
    f.put(terminal({ turn: OTHER_TURN }));
    const budget = await runWaiter(f.xdg, armInput, ["--budget-ms", "300"]).done;
    expect(budget.code).toBe(2);
    expect(readdirSync(f.claims)).toEqual([]);
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    await new Promise((resolve) => child.once("close", resolve));
    writeFileSync(join(f.claims, waiterLockName(HOST, SESSION, TURN)), String(child.pid)); // stale lock of a dead process
    const waiter = runWaiter(f.xdg, armInput, ["--budget-ms", "20000"]);
    const lock = join(f.claims, waiterLockName(HOST, SESSION, TURN));
    const end = Date.now() + 5000;
    while (Date.now() < end && readFileSync(lock, "utf8") !== String(waiter.child.pid)) await later(30, () => undefined);
    expect(readFileSync(lock, "utf8")).toBe(String(waiter.child.pid));
    waiter.child.kill("SIGTERM");
    expect((await waiter.done).code).toBe(143);
    expect(existsSync(lock)).toBe(false);
  });
  it("exits 0 silently, leaving neither claim nor lock, on an event produced by close", async () => {
    needBuild();
    const f = await fixture();
    f.put(terminal({ state: "aborted", via: "close" }));
    expect(await runWaiter(f.xdg, armInput, ["--budget-ms", "20000"]).done).toMatchObject({ code: 0, stderr: "", stdout: "" });
    expect(readdirSync(f.claims)).toEqual([]);
    // a registry event of the same turn would wake; the close one must not have consumed anything
    const g = await fixture();
    const waiter = runWaiter(g.xdg, armInput, ["--budget-ms", "20000"]);
    await later(400, () => g.put(terminal({ state: "failed", via: "close" })));
    expect(await waiter.done).toMatchObject({ code: 0, stderr: "" });
    expect(readdirSync(g.claims)).toEqual([]);
  });
  it("keeps waiting and ends with the budget wake when the runtime directory is full (ENOSPC on claim and on lock)", async () => {
    needBuild();
    const f = await fixture();
    f.put(terminal());
    // The preload makes every exclusive create below the claims directory fail as on a full tmpfs.
    const preload = join(f.xdg, "full-claims.mjs");
    await writeFile(preload, [
      'import fs from "node:fs";', 'import { syncBuiltinESMExports } from "node:module";',
      "const open = fs.openSync;",
      'fs.openSync = (path, flags, ...rest) => { if (flags === "wx" && String(path).includes("/claims/")) throw Object.assign(new Error("full"), { code: "ENOSPC" }); return open(path, flags, ...rest); };',
      "syncBuiltinESMExports();", "",
    ].join("\n"));
    const exit = await runWaiter(f.xdg, armInput, ["--budget-ms", "800"], { nodeArgs: ["--import", preload] }).done;
    expect(exit).toMatchObject({ code: 2, stdout: "", stderr: `pi-session-mcp: no event for turn ${TURN} within the wait budget; it may still be running. Read it once with pi_turn_get to re-arm.\n` });
    expect(readdirSync(f.claims)).toEqual([]);
    // any other claim error stays silent
    const g = await fixture();
    g.put(terminal());
    writeFileSync(g.claims, "not a directory");
    expect(await runWaiter(g.xdg, armInput, ["--budget-ms", "800"]).done).toMatchObject({ code: 0, stderr: "" });
  });
  it("ignores writer tools even when the writer's state directory holds an event", async () => {
    needBuild();
    const f = await fixture();
    f.put(terminal({ state: "failed" }), join(f.wdir("review-w2"), INSTANCE));
    const exit = await runWaiter(f.xdg, hookInput("pi_session_prompt", promptPayload, "pi-coding-review-w2"), ["--budget-ms", "10000"]).done;
    expect(exit).toMatchObject({ code: 0, stderr: "" });
    expect(existsSync(f.claims) ? readdirSync(f.claims) : []).toEqual([]);
  });
  it("lets an in-process waiter and a process race for one event: exactly one wakes", async () => {
    needBuild();
    const f = await fixture();
    f.put(terminal({ turn: OTHER_TURN }));
    const proc = runWaiter(f.xdg, armInput, ["--budget-ms", "20000"]);
    const inProcess = wait(f, { budgetMs: 20_000 });
    await later(600, () => f.put(terminal()));
    const [exit, result] = await Promise.all([proc.done, inProcess]);
    expect([exit.code === 2, result.action === "wake"].filter(Boolean)).toHaveLength(1);
  });
});

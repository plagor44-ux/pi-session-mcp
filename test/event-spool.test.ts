import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EventSpoolError, SPOOL_RETAINED_EVENTS, TurnEventSpool, type EventSpoolDiagnostic } from "../src/event-spool.js";
import { SessionRegistry } from "../src/session-registry.js";
import { parseTurnEvent, TURN_EVENT_FILE_PATTERN, type TurnEvent } from "../src/turn-events.js";
import { FakeAdapter } from "./fake-adapter.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

const SESSION = "11111111-1111-4111-8111-111111111111";
const TURN = "22222222-2222-4222-8222-222222222222";
const turn = (state: "completed" | "failed" | "aborted" = "completed", via: "registry" | "close" = "registry") =>
  ({ kind: "turn_terminal" as const, session: SESSION, turn: TURN, state, via });
const profile = { alias: "safe", permissionProfile: "read-only" as const, provider: "fake-provider", model: "fake-model", thinkingLevel: "off" as const };
const flush = async (): Promise<void> => { for (let i = 0; i < 3; i += 1) await new Promise<void>((resolve) => setImmediate(resolve)); };
const mode = (path: string): number => lstatSync(path).mode & 0o777;

async function openSpool(options: { diagnostic?: (d: EventSpoolDiagnostic) => void } = {}) {
  const root = await temporaryRoot("pi-session-mcp-spool-");
  const dir = join(root, "run", "events");
  const spool = TurnEventSpool.open(dir, options);
  const instance = readdirSync(dir)[0]!;
  return { root, dir, spool, instance, instanceDir: join(dir, instance) };
}
const eventFiles = (instanceDir: string): string[] => readdirSync(instanceDir).filter((name) => TURN_EVENT_FILE_PATTERN.test(name)).sort();
const readEvents = (instanceDir: string): TurnEvent[] => eventFiles(instanceDir).map((name) => {
  const parsed = parseTurnEvent(readFileSync(join(instanceDir, name), "utf8"));
  expect(parsed, name).toBeDefined();
  return parsed!;
});

describe("TurnEventSpool.open", () => {
  it("creates the root recursively and the instance directory, both 0700", async () => {
    const { root, dir, instance, instanceDir } = await openSpool();
    expect(instance).toMatch(/^inst-[0-9a-f]{16}$/);
    expect(mode(dir)).toBe(0o700); expect(mode(join(root, "run"))).toBe(0o700); expect(mode(instanceDir)).toBe(0o700);
    expect(readdirSync(instanceDir)).toEqual([]);
  });

  it("gives every open its own instance directory", async () => {
    const { dir } = await openSpool();
    TurnEventSpool.open(dir);
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it("reuses an existing private root", async () => {
    const root = await temporaryRoot("pi-session-mcp-spool-");
    const dir = join(root, "events"); mkdirSync(dir, { mode: 0o700 });
    expect(() => TurnEventSpool.open(dir)).not.toThrow();
  });

  it.each([["group", 0o750], ["other", 0o705], ["group write", 0o770]])("refuses an existing root with %s access", async (_label, bits) => {
    const root = await temporaryRoot("pi-session-mcp-spool-");
    const dir = join(root, "events"); mkdirSync(dir); chmodSync(dir, bits);
    expect(() => TurnEventSpool.open(dir)).toThrow(EventSpoolError);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a root owned by another user", async () => {
    const root = await temporaryRoot("pi-session-mcp-spool-");
    const dir = join(root, "events"); mkdirSync(dir, { mode: 0o700 });
    expect(() => TurnEventSpool.open(dir, { uid: (process.getuid?.() ?? 0) + 1 })).toThrow(EventSpoolError);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a symlink root, even to a private directory", async () => {
    const root = await temporaryRoot("pi-session-mcp-spool-");
    const target = join(root, "target"); mkdirSync(target, { mode: 0o700 });
    const link = join(root, "events"); symlinkSync(target, link);
    expect(() => TurnEventSpool.open(link)).toThrow(EventSpoolError);
    expect(readdirSync(target)).toEqual([]);
  });

  it("refuses a regular file, a relative path and an empty path", async () => {
    const root = await temporaryRoot("pi-session-mcp-spool-");
    const file = join(root, "file"); writeFileSync(file, "x");
    expect(() => TurnEventSpool.open(file)).toThrow(EventSpoolError);
    expect(() => TurnEventSpool.open("relative/events")).toThrow(EventSpoolError);
    expect(() => TurnEventSpool.open("")).toThrow(EventSpoolError);
  });

  it("throws a sanitized typed error with a stable code and no path", async () => {
    const root = await temporaryRoot("pi-session-mcp-spool-");
    const file = join(root, "SECRET_PATH_MARKER"); writeFileSync(file, "x");
    let thrown: unknown;
    try { TurnEventSpool.open(join(file, "events")); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(EventSpoolError);
    expect(thrown).toMatchObject({ code: "event_spool_unavailable", message: "Event spool is unavailable" });
    expect(JSON.stringify(thrown) + String((thrown as Error).stack?.split("\n")[0])).not.toContain("SECRET_PATH_MARKER");
  });
});

describe("TurnEventSpool.write", () => {
  it("writes atomic 0600 files named by sequence and kind, with monotonic seq from 1", async () => {
    const { spool, instance, instanceDir } = await openSpool();
    spool.write(turn("completed")); spool.write(turn("failed")); spool.write(turn("aborted", "close"));
    expect(eventFiles(instanceDir)).toEqual(["00000001-turn_terminal.json", "00000002-turn_terminal.json", "00000003-turn_terminal.json"]);
    expect(readdirSync(instanceDir).filter((name) => name.startsWith("."))).toEqual([]);
    for (const name of eventFiles(instanceDir)) expect(mode(join(instanceDir, name))).toBe(0o600);
    const events = readEvents(instanceDir);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events.every((e) => e.v === 1 && e.instance === instance)).toBe(true);
    expect(events.map((e) => e.kind === "turn_terminal" && [e.state, e.via])).toEqual([["completed", "registry"], ["failed", "registry"], ["aborted", "close"]]);
    for (const e of events) expect(new Date(e.at).toISOString()).toBe(e.at);
  });

  it("does not leave a matching file before the rename (temporary names are ignored by the pattern)", async () => {
    const { spool, instanceDir } = await openSpool();
    expect(TURN_EVENT_FILE_PATTERN.test(".tmp-1-deadbeef")).toBe(false);
    spool.write(turn());
    for (const name of readdirSync(instanceDir)) expect(TURN_EVENT_FILE_PATTERN.test(name)).toBe(true);
  });

  it("counts failures without throwing and reports exactly one sanitized diagnostic", async () => {
    const diagnostics: EventSpoolDiagnostic[] = [];
    const { spool, dir, instanceDir } = await openSpool({ diagnostic: (d) => diagnostics.push(d) });
    spool.write(turn()); expect(spool.failures).toBe(0);
    rmSync(dir, { recursive: true }); // the root is gone, so the instance directory cannot be recreated
    expect(() => spool.write(turn())).not.toThrow();
    expect(() => spool.write(turn())).not.toThrow();
    expect(spool.failures).toBe(2);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toEqual({ level: "warn", event: "event_spool_write_failed", stage: "event_spool", code: "ENOENT" });
    expect(JSON.stringify(diagnostics)).not.toContain(instanceDir);
    mkdirSync(dir, { mode: 0o700 });
    spool.write(turn());
    expect(spool.failures).toBe(2);
    expect(eventFiles(instanceDir)).toEqual(["00000004-turn_terminal.json"]);
    expect(diagnostics).toHaveLength(1);
  });

  it("survives a throwing diagnostic sink", async () => {
    const { spool, dir } = await openSpool({ diagnostic: () => { throw new Error("sink"); } });
    rmSync(dir, { recursive: true });
    expect(() => spool.write(turn())).not.toThrow();
    expect(spool.failures).toBe(1);
  });
});

describe("TurnEventSpool retention and recovery", () => {
  it("keeps exactly the newest files after more writes than the retention limit", async () => {
    const { spool, instanceDir } = await openSpool();
    const total = SPOOL_RETAINED_EVENTS + 5;
    for (let i = 0; i < total; i += 1) spool.write(turn());
    const seqs = readEvents(instanceDir).map((e) => e.seq);
    expect(seqs).toHaveLength(SPOOL_RETAINED_EVENTS);
    expect(seqs[0]).toBe(total - SPOOL_RETAINED_EVENTS + 1);
    expect(seqs.at(-1)).toBe(total);
    expect(readdirSync(instanceDir).filter((name) => name.startsWith("."))).toEqual([]);
    expect(spool.failures).toBe(0);
  });

  it("does not fail when an older file is already gone", async () => {
    const { spool, instanceDir } = await openSpool();
    spool.write(turn()); rmSync(join(instanceDir, "00000001-turn_terminal.json"));
    for (let i = 0; i < SPOOL_RETAINED_EVENTS; i += 1) spool.write(turn());
    expect(spool.failures).toBe(0);
    expect(eventFiles(instanceDir)).toHaveLength(SPOOL_RETAINED_EVENTS);
  });

  it("recreates a pruned instance directory once and lands the write", async () => {
    const diagnostics: EventSpoolDiagnostic[] = [];
    const { spool, instanceDir } = await openSpool({ diagnostic: (d) => diagnostics.push(d) });
    spool.write(turn());
    rmSync(instanceDir, { recursive: true });
    spool.write(turn("failed"));
    expect(spool.failures).toBe(0); expect(diagnostics).toEqual([]);
    expect(mode(instanceDir)).toBe(0o700);
    expect(readEvents(instanceDir).map((e) => [e.seq, e.kind === "turn_terminal" && e.state])).toEqual([[2, "failed"]]);
  });

  it("counts a failure when the root is gone, so the directory cannot be recreated", async () => {
    const diagnostics: EventSpoolDiagnostic[] = [];
    const { spool, dir } = await openSpool({ diagnostic: (d) => diagnostics.push(d) });
    rmSync(dir, { recursive: true });
    expect(() => spool.write(turn())).not.toThrow();
    expect(spool.failures).toBe(1); expect(diagnostics).toHaveLength(1);
  });

  it("does not recreate the directory under a root that others can enter", async () => {
    const { spool, dir, instanceDir } = await openSpool();
    rmSync(instanceDir, { recursive: true });
    chmodSync(dir, 0o755);
    spool.write(turn());
    expect(spool.failures).toBe(1);
    expect(existsSync(instanceDir)).toBe(false);
  });
});

describe("TurnEventSpool.close", () => {
  /** Opens a spool whose close captures the instance directory just before it is removed. */
  async function capturing() {
    const captured: { names: string[]; events: TurnEvent[] } = { names: [], events: [] };
    const root = await temporaryRoot("pi-session-mcp-spool-");
    const dir = join(root, "events");
    const spool = TurnEventSpool.open(dir, {
      removeInstance: (path) => { captured.names = eventFiles(path); captured.events = readEvents(path); rmSync(path, { recursive: true, force: true }); },
    });
    return { spool, dir, captured };
  }

  it.each(["eof", "signal", "shutdown"] as const)("writes instance_ended last (%s) and removes the instance directory", async (reason) => {
    const { spool, dir, captured } = await capturing();
    spool.write(turn()); spool.write(turn("failed"));
    spool.close(reason);
    expect(captured.names).toEqual(["00000001-turn_terminal.json", "00000002-turn_terminal.json", "00000003-instance_ended.json"]);
    expect(captured.events.at(-1)).toMatchObject({ kind: "instance_ended", reason, seq: 3 });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("is idempotent and stops accepting writes", async () => {
    const diagnostics: EventSpoolDiagnostic[] = [];
    let removals = 0;
    const root = await temporaryRoot("pi-session-mcp-spool-");
    const dir = join(root, "events");
    const spool = TurnEventSpool.open(dir, { diagnostic: (d) => diagnostics.push(d), removeInstance: (path) => { removals += 1; rmSync(path, { recursive: true, force: true }); } });
    spool.close("eof"); spool.close("signal");
    expect(() => spool.write(turn())).not.toThrow();
    expect(removals).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
    expect(spool.failures).toBe(0); expect(diagnostics).toEqual([]);
  });

  it("never throws when removal fails or the directory is already gone", async () => {
    const root = await temporaryRoot("pi-session-mcp-spool-");
    const failing = TurnEventSpool.open(join(root, "a"), { removeInstance: () => { throw new Error("EBUSY"); } });
    expect(() => failing.close("shutdown")).not.toThrow();
    const gone = TurnEventSpool.open(join(root, "b"));
    rmSync(join(root, "b"), { recursive: true });
    expect(() => gone.close("shutdown")).not.toThrow();
    expect(gone.failures).toBe(1);
  });
});

describe("registry with spool", () => {
  async function wired() {
    const root = await temporaryRoot("pi-session-mcp-spool-");
    const dir = join(root, "events");
    const captured: { events: TurnEvent[]; raw: string[] } = { events: [], raw: [] };
    const spool = TurnEventSpool.open(dir, {
      removeInstance: (path) => {
        captured.events = readEvents(path);
        captured.raw = eventFiles(path).map((name) => readFileSync(join(path, name), "utf8"));
        rmSync(path, { recursive: true, force: true });
      },
    });
    const adapter = new FakeAdapter();
    const registry = new SessionRegistry(adapter, new Map([["repo", join(root, "CANARY_PATH_workspace")]]), {
      onTurnTerminal: (event) => spool.write({ kind: "turn_terminal", session: event.sessionId, turn: event.turnId, state: event.state, via: event.via }),
    });
    const start = async (): Promise<string> => (await registry.start("repo", profile)).id;
    return { root, dir, spool, adapter, registry, start, captured };
  }

  it("writes one file per turn in settlement order with the correct ids, even when completion order is reversed", async () => {
    const { registry, adapter, start, spool, captured } = await wired();
    const a = await start(), b = await start();
    const ta = await registry.prompt(a, "CANARY_PROMPT_1"), tb = await registry.prompt(b, "CANARY_PROMPT_2");
    adapter.handles[1]!.complete("CANARY_TEXT_b"); await flush();
    adapter.handles[0]!.complete("CANARY_TEXT_a"); await flush();
    await registry.shutdown(); spool.close("eof");
    expect(captured.events.map((e) => e.kind === "turn_terminal" ? [e.seq, e.session, e.turn, e.state, e.via] : [e.seq, e.kind])).toEqual([
      [1, b, tb.turn.turnId, "completed", "registry"], [2, a, ta.turn.turnId, "completed", "registry"], [3, "instance_ended"],
    ]);
  });

  it("writes close-generated terminals before instance_ended and nothing twice", async () => {
    const { registry, adapter, start, spool, captured } = await wired();
    const a = await start(), b = await start(), c = await start();
    const ta = await registry.prompt(a, "x"), tb = await registry.prompt(b, "x"); await registry.prompt(c, "x");
    adapter.handles[2]!.complete("done"); await flush();
    await registry.close(a); await registry.close(a);
    adapter.handles[0]!.complete("late"); await flush();
    await registry.shutdown();
    spool.close("signal");
    const kinds = captured.events.map((e) => e.kind === "turn_terminal" ? `${e.state}/${e.via}/${e.turn}` : `${e.kind}/${e.reason}`);
    expect(kinds).toEqual([
      expect.stringMatching(/^completed\/registry\//), `aborted/close/${ta.turn.turnId}`, `aborted/close/${tb.turn.turnId}`, "instance_ended/signal",
    ]);
    expect(captured.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it("holds only allowed keys: no prompt, answer, text or path appears in any file", async () => {
    const { registry, adapter, start, spool, captured, root } = await wired();
    const ids = [await start(), await start(), await start()];
    for (const id of ids) await registry.prompt(id, "CANARY_PROMPT_7f3a");
    adapter.handles[0]!.complete("CANARY_TEXT_c0de"); adapter.handles[1]!.fail(); await flush();
    await registry.shutdown(); spool.close("shutdown");
    expect(captured.raw).toHaveLength(4);
    for (const text of captured.raw) {
      expect(text).not.toMatch(/CANARY/); expect(text).not.toContain(root); expect(text).not.toContain("fake-model");
      const keys = Object.keys(JSON.parse(text) as Record<string, unknown>);
      expect(keys.sort()).toEqual((text.includes("turn_terminal") ? ["v", "seq", "at", "instance", "kind", "session", "turn", "state", "via"] : ["v", "seq", "at", "instance", "kind", "reason"]).sort());
      expect(parseTurnEvent(text)).toBeDefined();
    }
  });
});

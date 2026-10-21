import { describe, expect, it } from "vitest";
import {
  CONTAINER_EVENTS_DIR, EVENTS_DIR_ENV, TURN_EVENT_FILE_PATTERN, TURN_EVENT_MAX_BYTES, TURN_EVENT_VERSION,
  claimsRoot, eventsRoot, parseTurnEvent, serializeTurnEvent, turnEventFileName, writerEventsDir, type TurnEvent,
} from "../src/turn-events.js";

const terminal: TurnEvent = {
  v: 1, seq: 7, at: "2026-10-21T12:00:00.123Z", instance: "inst-0123456789abcdef", kind: "turn_terminal",
  session: "0f8fad5b-d9cb-469f-a165-70867728950e", turn: "7c9e6679-7425-40de-944b-e07fc1f90ae7", state: "completed", via: "registry",
};
const ended: TurnEvent = { v: 1, seq: 8, at: "2026-10-21T12:00:01.000Z", instance: "inst-0123456789abcdef", kind: "instance_ended", reason: "eof" };
const raw = (event: object) => JSON.stringify(event);

describe("turn event contract", () => {
  it("exposes the version and size cap", () => {
    expect(TURN_EVENT_VERSION).toBe(1);
    expect(TURN_EVENT_MAX_BYTES).toBe(1024);
  });

  it.each([terminal, ended])("round-trips a $kind event", (event) => {
    expect(parseTurnEvent(serializeTurnEvent(event))).toEqual(event);
  });

  it("serializes with a stable key order regardless of object construction order", () => {
    const shuffled = { via: "registry", state: "completed", turn: terminal.kind === "turn_terminal" ? terminal.turn : "", session: terminal.kind === "turn_terminal" ? terminal.session : "", kind: "turn_terminal", instance: terminal.instance, at: terminal.at, seq: 7, v: 1 } as TurnEvent;
    expect(serializeTurnEvent(shuffled)).toBe(serializeTurnEvent(terminal));
    expect(Object.keys(JSON.parse(serializeTurnEvent(terminal)))).toEqual(["v", "seq", "at", "instance", "kind", "session", "turn", "state", "via"]);
    expect(Object.keys(JSON.parse(serializeTurnEvent(ended)))).toEqual(["v", "seq", "at", "instance", "kind", "reason"]);
  });

  it("accepts every state, via and reason", () => {
    for (const state of ["completed", "failed", "aborted"] as const) for (const via of ["registry", "close"] as const) {
      expect(parseTurnEvent(raw({ ...terminal, state, via }))).toMatchObject({ state, via });
    }
    for (const reason of ["eof", "signal", "shutdown"] as const) expect(parseTurnEvent(raw({ ...ended, reason }))).toMatchObject({ reason });
  });

  const rejected: ReadonlyArray<readonly [string, object]> = [
    ["wrong version", { ...terminal, v: 2 }],
    ["string version", { ...terminal, v: "1" }],
    ["zero seq", { ...terminal, seq: 0 }],
    ["negative seq", { ...terminal, seq: -1 }],
    ["fractional seq", { ...terminal, seq: 1.5 }],
    ["unsafe seq", { ...terminal, seq: Number.MAX_SAFE_INTEGER + 1 }],
    ["string seq", { ...terminal, seq: "7" }],
    ["unknown kind", { ...terminal, kind: "turn_started" }],
    ["missing kind", (({ kind: _kind, ...rest }) => rest)(terminal)],
    ["offset time", { ...terminal, at: "2026-10-21T12:00:00.123+00:00" }],
    ["time without milliseconds", { ...terminal, at: "2026-10-21T12:00:00Z" }],
    ["impossible date", { ...terminal, at: "2026-02-30T00:00:00.000Z" }],
    ["numeric time", { ...terminal, at: 1_700_000_000_000 }],
    ["uppercase instance", { ...terminal, instance: "inst-0123456789ABCDEF" }],
    ["short instance", { ...terminal, instance: "inst-0123456789abcde" }],
    ["instance without prefix", { ...terminal, instance: "0123456789abcdef" }],
    ["instance with path", { ...terminal, instance: "inst-0123456789abcdef/../x" }],
    ["uppercase session", { ...terminal, session: "0F8FAD5B-D9CB-469F-A165-70867728950E" }],
    ["non-uuid session", { ...terminal, session: "session-1" }],
    ["non-uuid turn", { ...terminal, turn: "../etc/passwd" }],
    ["unknown state", { ...terminal, state: "running" }],
    ["unknown via", { ...terminal, via: "hook" }],
    ["unknown reason", { ...ended, reason: "crash" }],
    ["extra key on turn_terminal", { ...terminal, text: "answer" }],
    ["extra key on instance_ended", { ...ended, session: terminal.kind === "turn_terminal" ? terminal.session : "" }],
    ["reason on turn_terminal", { ...terminal, reason: "eof" }],
    ["missing session", (({ session: _session, ...rest }) => rest)(terminal)],
    ["missing via", (({ via: _via, ...rest }) => rest)(terminal)],
    ["missing reason", (({ reason: _reason, ...rest }) => rest)(ended)],
  ];
  it.each(rejected)("rejects %s", (_label, event) => {
    expect(parseTurnEvent(raw(event))).toBeUndefined();
  });

  it("enforces the byte cap on the serialized text", () => {
    const text = serializeTurnEvent(terminal);
    const padded = (extra: number) => text.slice(0, -1) + " ".repeat(extra) + "}";
    const room = TURN_EVENT_MAX_BYTES - Buffer.byteLength(text, "utf8");
    expect(parseTurnEvent(padded(room))).toEqual(terminal);
    expect(parseTurnEvent(padded(room + 1))).toBeUndefined();
    expect(parseTurnEvent("x".repeat(TURN_EVENT_MAX_BYTES * 4))).toBeUndefined();
  });

  it.each([
    "", " ", "null", "true", "7", '"text"', "[]", "[1,2]", "{", "{}", "{\"v\":1}", "undefined", "\u0000", "{\"v\":1,\"v\":1}",
    "x".repeat(5000), "{".repeat(5000), "[".repeat(100_000),
  ])("returns undefined without throwing for garbage %#", (text) => {
    expect(() => parseTurnEvent(text)).not.toThrow();
    expect(parseTurnEvent(text)).toBeUndefined();
  });

  it("returns undefined for non-string input instead of throwing", () => {
    expect(parseTurnEvent(undefined as unknown as string)).toBeUndefined();
    expect(parseTurnEvent(null as unknown as string)).toBeUndefined();
    expect(parseTurnEvent(7 as unknown as string)).toBeUndefined();
  });

  it("ignores inherited and prototype keys", () => {
    expect(parseTurnEvent('{"__proto__":{"kind":"instance_ended"},"v":1}')).toBeUndefined();
  });

  it("names files by zero-padded sequence and kind", () => {
    expect(turnEventFileName(terminal)).toBe("00000007-turn_terminal.json");
    expect(turnEventFileName(ended)).toBe("00000008-instance_ended.json");
    expect(turnEventFileName({ ...ended, seq: 123_456_789 })).toBe("123456789-instance_ended.json");
    for (const event of [terminal, ended]) expect(TURN_EVENT_FILE_PATTERN.test(turnEventFileName(event))).toBe(true);
  });

  it.each(["", "7-turn_terminal.json", "00000007-turn_started.json", "00000007-turn_terminal.json.tmp", "../00000007-turn_terminal.json", "0000000a-turn_terminal.json", ".00000007-turn_terminal.json"])(
    "does not match the file name %j", (name) => { expect(TURN_EVENT_FILE_PATTERN.test(name)).toBe(false); },
  );
});

describe("spool paths", () => {
  it("derives the roots from an absolute XDG_RUNTIME_DIR", () => {
    const env = { XDG_RUNTIME_DIR: "/run/user/1000" };
    expect(eventsRoot(env)).toBe("/run/user/1000/pi-session-mcp/events");
    expect(claimsRoot(env)).toBe("/run/user/1000/pi-session-mcp/claims");
    expect(writerEventsDir(env, "repo-w1")).toBe("/run/user/1000/pi-session-mcp/events/writer-repo-w1");
  });

  it("normalizes a trailing slash", () => {
    expect(eventsRoot({ XDG_RUNTIME_DIR: "/run/user/1000/" })).toBe("/run/user/1000/pi-session-mcp/events");
  });

  it.each([undefined, "", "run/user/1000", "./run", "~/run", "/run/user/\u00001000"])("has no roots for XDG_RUNTIME_DIR %j", (value) => {
    const env = value === undefined ? {} : { XDG_RUNTIME_DIR: value };
    expect(eventsRoot(env)).toBeUndefined();
    expect(claimsRoot(env)).toBeUndefined();
    expect(writerEventsDir(env, "repo-w1")).toBeUndefined();
  });

  it.each(["", "..", "../x", "repo", "Repo-w1", "repo-w1/..", "repo/w1-w1", "repo-w"])("rejects the writer name %j", (name) => {
    expect(writerEventsDir({ XDG_RUNTIME_DIR: "/run/user/1000" }, name)).toBeUndefined();
  });

  it("exposes the explicit directory variable and the container mount", () => {
    expect(EVENTS_DIR_ENV).toBe("PI_SESSION_MCP_EVENTS_DIR");
    expect(CONTAINER_EVENTS_DIR).toBe("/pi/events");
  });
});

import { isAbsolute, join } from "node:path";
import { WRITER_NAME_PATTERN } from "./writer-state.js";

/**
 * The turn-event file contract shared by the server's spool writer and the wake hook program.
 * An event is content-free: identifiers, a state and a time, never prompts, answers or paths.
 * The parser is the trust boundary for files that a container writer may have forged.
 */
export const TURN_EVENT_VERSION = 1;
export const TURN_EVENT_MAX_BYTES = 1024;

export type TurnEvent =
  | { v: 1; seq: number; at: string; instance: string; kind: "turn_terminal"; session: string; turn: string; state: "completed" | "failed" | "aborted"; via: "registry" | "close" }
  | { v: 1; seq: number; at: string; instance: string; kind: "instance_ended"; reason: "eof" | "signal" | "shutdown" };

export const TURN_EVENT_FILE_PATTERN = /^\d{8}-(turn_terminal|instance_ended)\.json$/;
/** An explicit absolute spool directory; set inside writer containers, where no runtime directory exists. */
export const EVENTS_DIR_ENV = "PI_SESSION_MCP_EVENTS_DIR";
/** Where a container writer sees its dedicated spool mount. */
export const CONTAINER_EVENTS_DIR = "/pi/events";

const INSTANCE_PATTERN = /^inst-[0-9a-f]{16}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TURN_KEYS = ["v", "seq", "at", "instance", "kind", "session", "turn", "state", "via"] as const;
const ENDED_KEYS = ["v", "seq", "at", "instance", "kind", "reason"] as const;

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}

/** Millisecond ISO-8601 UTC as `Date#toISOString` writes it; the round trip also rejects impossible dates. */
function isIsoUtc(value: unknown): value is string {
  return typeof value === "string" && AT_PATTERN.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** Strict parse of one event file's text; anything unexpected yields `undefined`. Never throws. */
export function parseTurnEvent(text: string): TurnEvent | undefined {
  try {
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > TURN_EVENT_MAX_BYTES) return undefined;
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const x = value as Record<string, unknown>;
    if (x.v !== TURN_EVENT_VERSION || typeof x.seq !== "number" || !Number.isSafeInteger(x.seq) || x.seq < 1) return undefined;
    if (!isIsoUtc(x.at) || typeof x.instance !== "string" || !INSTANCE_PATTERN.test(x.instance)) return undefined;
    const base = { v: 1 as const, seq: x.seq, at: x.at, instance: x.instance };
    if (x.kind === "turn_terminal") {
      if (!hasExactKeys(x, TURN_KEYS)) return undefined;
      if (typeof x.session !== "string" || !UUID_PATTERN.test(x.session) || typeof x.turn !== "string" || !UUID_PATTERN.test(x.turn)) return undefined;
      if (x.state !== "completed" && x.state !== "failed" && x.state !== "aborted") return undefined;
      if (x.via !== "registry" && x.via !== "close") return undefined;
      return { ...base, kind: "turn_terminal", session: x.session, turn: x.turn, state: x.state, via: x.via };
    }
    if (x.kind === "instance_ended") {
      if (!hasExactKeys(x, ENDED_KEYS)) return undefined;
      if (x.reason !== "eof" && x.reason !== "signal" && x.reason !== "shutdown") return undefined;
      return { ...base, kind: "instance_ended", reason: x.reason };
    }
    return undefined;
  } catch { return undefined; }
}

/** Stable key order, so equal events serialize to equal bytes. */
export function serializeTurnEvent(event: TurnEvent): string {
  const { v, seq, at, instance } = event;
  return JSON.stringify(event.kind === "turn_terminal"
    ? { v, seq, at, instance, kind: event.kind, session: event.session, turn: event.turn, state: event.state, via: event.via }
    : { v, seq, at, instance, kind: event.kind, reason: event.reason });
}

export function turnEventFileName(event: TurnEvent): string {
  return `${String(event.seq).padStart(8, "0")}-${event.kind}.json`;
}

function runtimeRoot(env: NodeJS.ProcessEnv): string | undefined {
  const runtime = env.XDG_RUNTIME_DIR;
  return runtime !== undefined && runtime.length > 0 && !runtime.includes("\0") && isAbsolute(runtime) ? join(runtime, "pi-session-mcp") : undefined;
}

/** `$XDG_RUNTIME_DIR/pi-session-mcp/events`, or `undefined` without an absolute runtime directory. Pure; no file system access. */
export function eventsRoot(env: NodeJS.ProcessEnv): string | undefined {
  const root = runtimeRoot(env);
  return root === undefined ? undefined : join(root, "events");
}

/** The host directory in which wake hooks claim events, next to the events root. */
export function claimsRoot(env: NodeJS.ProcessEnv): string | undefined {
  const root = runtimeRoot(env);
  return root === undefined ? undefined : join(root, "claims");
}

/** The per-writer spool directory under the events root; `undefined` for an unusable root or a malformed writer name. */
export function writerEventsDir(env: NodeJS.ProcessEnv, writerName: string): string | undefined {
  const root = eventsRoot(env);
  return root === undefined || !WRITER_NAME_PATTERN.test(writerName) ? undefined : join(root, `writer-${writerName}`);
}

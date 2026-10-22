import type { Arm } from "./approval.js";

// Stream-json bookkeeping for one controller run. Only allowlisted fields are kept: counts, labels, numbers, millisecond
// offsets. No assistant, tool, hook or user text is ever stored.
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const safeLabel = (v: unknown): string | null => (typeof v === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(v) ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

export interface Usage { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; output_tokens: number }
export interface ResultRow { t_ms: number; subtype: string | null; is_error: boolean | null; num_turns: number | null; duration_ms: number | null; usage: Usage; total_cost_usd: number | null }
export interface HookRow { t_ms: number; subtype: string; hook_event: string | null; outcome: string | null; exit_code: number | null }
export interface WakeRow { exit_at_ms: number; request_at_ms: number; delay_ms: number; delivery: "own_request" | "with_tool_result" }
export interface ServerCounters { tools: Record<string, number>; pi_turn_get: { running: number; terminal: number; error: number }; open_sessions: number; closes: number; spool_failures: number }

export const emptyUsage = (): Usage => ({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 });
export function readUsage(value: unknown): Usage {
  const u = isObject(value) ? value : {};
  return { input_tokens: count(u.input_tokens), cache_read_input_tokens: count(u.cache_read_input_tokens), cache_creation_input_tokens: count(u.cache_creation_input_tokens), output_tokens: count(u.output_tokens) };
}
export function sumUsage(rows: ReadonlyArray<{ usage: Usage }>): Usage {
  const total = emptyUsage();
  for (const { usage } of rows) for (const key of Object.keys(total) as Array<keyof Usage>) total[key] += usage[key];
  return total;
}
/** Plain arithmetic from the pre-registration: input minus cache read minus cache creation. */
/**
 * Anthropic usage reports `input_tokens` without the cache parts, so input not served from the cache is `input_tokens` plus
 * `cache_creation_input_tokens`. (The Codex M1 arithmetic, input minus cached, does not apply here.)
 */
export const uncachedInput = (usage: Usage): number => usage.input_tokens + usage.cache_creation_input_tokens;

export function parseCounters(text: string): ServerCounters | null {
  try {
    const raw = JSON.parse(text) as unknown;
    if (!isObject(raw) || !isObject(raw.tools) || !isObject(raw.pi_turn_get)) return null;
    const tools: Record<string, number> = {};
    for (const [name, value] of Object.entries(raw.tools)) { const label = safeLabel(name); if (label && typeof value === "number") tools[label] = value; }
    const get = raw.pi_turn_get;
    return { tools, pi_turn_get: { running: count(get.running), terminal: count(get.terminal), error: count(get.error) }, open_sessions: count(raw.open_sessions), closes: count(raw.closes), spool_failures: count(raw.spool_failures) };
  } catch { return null; }
}

export type EndDecision = { end: true; reason: "all_sessions_closed" | "no_open_session" } | { end: false };
/**
 * Evaluated after every `result` event. All sessions closed (and at least one close seen) ends the run in both arms. A result
 * while sessions are open is the expected idle point of arm C and keeps stdin open; a result with no open session ends it.
 */
export function decideEnd(_arm: Arm, counters: ServerCounters | null): EndDecision {
  if (counters !== null && counters.open_sessions === 0 && counters.closes >= 1) return { end: true, reason: "all_sessions_closed" };
  // No session is open (or the server never wrote counters: no tool call at all), so nothing can wake the controller again,
  // e.g. after an API error on the first request. The server writes counters by atomic rename, so null means never written.
  if (counters === null || counters.open_sessions === 0) return { end: true, reason: "no_open_session" };
  return { end: false };
}

export class StreamTracker {
  lines = 0; jsonErrors = 0;
  readonly types: Record<string, number> = {}; readonly systemSubtypes: Record<string, number> = {};
  readonly results: ResultRow[] = []; readonly hooks: HookRow[] = []; readonly wakes: WakeRow[] = [];
  readonly toolUses: Record<string, number> = {}; readonly assistantAt = new Map<string, number>();
  mcpStatuses: string[] = [];
  /** Waiter exits with code 2 whose wake did not lead to a model request before the stream ended. */
  waiterExit2 = 0; private pending: { at: number; idle: boolean } | undefined; private idle = false;
  constructor(private readonly clock: () => number) {}

  get modelRequests(): number { return this.assistantAt.size; }
  get unansweredWakes(): number { return this.pending ? 1 : 0; }

  /** Returns true when the line was a `result` event. */
  ingestLine(line: string): boolean {
    this.lines += 1;
    let parsed: unknown;
    try { parsed = JSON.parse(line) as unknown; } catch { this.jsonErrors += 1; return false; }
    return this.ingest(parsed);
  }
  ingest(event: unknown): boolean {
    if (!isObject(event)) return false;
    const t = this.clock();
    const type = safeLabel(event.type) ?? "other", subtype = safeLabel(event.subtype);
    this.types[type] = (this.types[type] ?? 0) + 1;
    if (type === "system" && subtype) {
      this.systemSubtypes[subtype] = (this.systemSubtypes[subtype] ?? 0) + 1;
      if (subtype === "init" && Array.isArray(event.mcp_servers)) this.mcpStatuses = event.mcp_servers.map((s) => safeLabel(isObject(s) ? s.status : null) ?? "other");
      if (subtype.startsWith("hook_")) {
        const exit = num(event.exit_code);
        this.hooks.push({ t_ms: t, subtype, hook_event: safeLabel(event.hook_event ?? event.hook_event_name), outcome: safeLabel(event.outcome), exit_code: exit });
        if (subtype === "hook_response" && exit === 2) { this.waiterExit2 += 1; this.pending = { at: t, idle: this.idle }; }
      }
      return false;
    }
    if (type === "assistant" && isObject(event.message)) {
      const id = safeLabel(event.message.id);
      if (id !== null && !this.assistantAt.has(id)) this.assistantAt.set(id, t);
      const content = Array.isArray(event.message.content) ? event.message.content : [];
      for (const block of content) if (isObject(block) && block.type === "tool_use") { const name = safeLabel(block.name) ?? "other"; this.toolUses[name] = (this.toolUses[name] ?? 0) + 1; }
      if (this.pending) {
        this.wakes.push({ exit_at_ms: this.pending.at, request_at_ms: t, delay_ms: t - this.pending.at, delivery: this.pending.idle ? "own_request" : "with_tool_result" });
        this.pending = undefined;
      }
      this.idle = false;
      return false;
    }
    if (type === "result") {
      this.results.push({ t_ms: t, subtype, is_error: typeof event.is_error === "boolean" ? event.is_error : null, num_turns: num(event.num_turns), duration_ms: num(event.duration_ms),
        usage: readUsage(event.usage), total_cost_usd: num(event.total_cost_usd) });
      this.idle = true;
      return true;
    }
    return false;
  }
}

const sumOrNull = (values: Array<number | null>): number | null => (values.some((v) => v !== null) ? values.reduce<number>((a, v) => a + (v ?? 0), 0) : null);
export function summarizeStream(tracker: StreamTracker): Record<string, unknown> {
  const rows = tracker.results;
  return {
    lines: tracker.lines, json_errors: tracker.jsonErrors, types: tracker.types, system_subtypes: tracker.systemSubtypes, mcp_statuses: tracker.mcpStatuses,
    results: rows, result_count: rows.length,
    sums: { num_turns: sumOrNull(rows.map((r) => r.num_turns)), duration_ms: sumOrNull(rows.map((r) => r.duration_ms)), usage: sumUsage(rows), uncached_input_tokens: uncachedInput(sumUsage(rows)),
      total_cost_usd_sum: sumOrNull(rows.map((r) => r.total_cost_usd)), total_cost_usd_last: rows.at(-1)?.total_cost_usd ?? null },
    model_requests: tracker.modelRequests, tool_uses: tracker.toolUses,
    hooks: tracker.hooks,
    wakes: { waiter_exit_2: tracker.waiterExit2, started: tracker.wakes.filter((w) => w.delivery === "own_request").length, with_tool_result: tracker.wakes.filter((w) => w.delivery === "with_tool_result").length, unanswered: tracker.unansweredWakes, rows: tracker.wakes },
  };
}

/** Delay from a bridge event (epoch ms) to the first assistant message that arrived at or after it, or null. */
export function eventToNextAssistantMs(eventAtMs: number, assistantArrivalsMs: number[]): number | null {
  const next = assistantArrivalsMs.filter((t) => t >= eventAtMs).sort((a, b) => a - b)[0];
  return next === undefined ? null : next - eventAtMs;
}

// ---------------------------------------------------------------- output allowlist
const ABSOLUTE_PATH = /(^|[\s"'=:])\/(?:tmp|home|var|usr|etc|proc|root|opt|run)\//;
/**
 * Throws `output_validation_failed` when any string in `value` holds a forbidden needle (temporary root, receipt text, a
 * credential path or value) or looks like an absolute path or contains `/home/`. Keys are checked as well.
 */
export function assertOutputClean(value: unknown, forbidden: ReadonlyArray<string | undefined>): void {
  const needles = forbidden.filter((n): n is string => typeof n === "string" && n.length > 0);
  const check = (text: string): void => {
    if (text.includes("/home/") || ABSOLUTE_PATH.test(text)) throw new Error("output_validation_failed");
    for (const needle of needles) if (text.includes(needle)) throw new Error("output_validation_failed");
  };
  const visit = (v: unknown, depth: number): void => {
    if (depth > 20) throw new Error("output_validation_failed");
    if (typeof v === "string") check(v);
    else if (Array.isArray(v)) for (const item of v) visit(item, depth + 1);
    else if (isObject(v)) for (const [key, item] of Object.entries(v)) { check(key); visit(item, depth + 1); }
  };
  visit(value, 0);
}

/** Keys the result file may contain at its top level. */
export const RESULT_TOP_KEYS = [
  "schema_version", "dry_run", "case", "arm", "seq", "started_at", "ended_at", "wall_ms", "tooling", "approval", "prompts", "run", "stream", "server", "bridge", "fake_api", "oracle", "cleanup", "checks", "outcome",
] as const;
export function assertTopLevelAllowlist(result: Record<string, unknown>): void {
  const allowed = new Set<string>(RESULT_TOP_KEYS);
  for (const key of Object.keys(result)) if (!allowed.has(key)) throw new Error("output_validation_failed");
}

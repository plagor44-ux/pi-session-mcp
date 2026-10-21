import { createHash } from "node:crypto";
import { appendFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { payloadsOf } from "./hook-waiter.js";
import { createLedger } from "./ledger.js";
import type { LedgerEvent, RunLedger, TerminalRuntime } from "./ledger.js";
import { LedgerError, LedgerStore } from "./ledger-store.js";

// Synchronous PostToolUse hook: projects Pi tool results into the ledger, no model call. Only hashes of results are kept.
// The hook always exits 0; failures are counted in hook-errors.jsonl inside the ledger directory.
export interface ProjectionOptions { instance: string; now: () => Date; baseCommit?: string; deadlineMs?: number }
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const sha = (text: string): `sha256:${string}` => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
const label = (...parts: Array<string | undefined>): string => {
  const text = parts.filter(Boolean).join(" ").replace(/[^A-Za-z0-9 ._:@+-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 100);
  return text || "task";
};

/** Deterministic per hook invocation, so a retried hook produces the same event IDs (duplicates). */
function idBase(hook: Record<string, unknown>): string {
  const given = str(hook.tool_use_id);
  if (given && /^[A-Za-z0-9._:-]{1,60}$/.test(given)) return given;
  return `h${createHash("sha256").update(JSON.stringify([hook.tool_name, hook.tool_input, hook.tool_response])).digest("hex").slice(0, 24)}`;
}
function find<T>(response: unknown, pick: (payload: Record<string, unknown>) => T | undefined): T | undefined {
  for (const payload of payloadsOf(response)) { const value = pick(payload); if (value !== undefined) return value; }
  return undefined;
}
const sessionOf = (ledger: RunLedger | undefined, sessionId: string) => {
  for (const task of ledger?.tasks ?? []) for (const attempt of task.attempts) if (attempt.sessionId === sessionId) return { task, attempt };
  return undefined;
};

/** Pure projection of one hook input (plus a ledger snapshot for turn kind and the running turn) into ledger events. */
export function projectHook(hook: unknown, ledger: RunLedger | undefined, options: ProjectionOptions): LedgerEvent[] {
  if (!isObject(hook)) return [];
  const tool = str(hook.tool_name)?.replace(/^.*__/, "") ?? "", input = isObject(hook.tool_input) ? hook.tool_input : {}, base = idBase(hook);
  const at = options.now().toISOString();
  const common = (type: string) => ({ eventId: `${base}.${type}`.slice(0, 100), at, source: "hook" as const });
  const events: LedgerEvent[] = [{ ...common("instance_connected"), eventId: `ic.${options.instance}`.slice(0, 100), type: "instance_connected", instanceId: options.instance }];
  const response = hook.tool_response;
  if (tool === "pi_session_start") {
    const session = find(response, (p) => (isObject(p.session) && str(p.session.id) ? p.session : undefined));
    const id = str(session?.id);
    if (!session || !id) return events;
    const workspace = str(session.workspace) ?? "workspace", profile = str(session.executionProfile) ?? "profile";
    events.push({ ...common("task_declared"), type: "task_declared", taskId: `t-${id.slice(0, 8)}`, label: label(workspace, profile), baseCommit: options.baseCommit ?? "0000000", dependsOn: [], changeScope: [] });
    events.push({
      ...common("attempt_started"), type: "attempt_started", taskId: `t-${id.slice(0, 8)}`, attemptId: `a-${id.slice(0, 8)}`, instanceId: options.instance, sessionId: id,
      workspaceAlias: label(workspace), profileAlias: label(profile), deadlineAt: new Date(options.now().getTime() + (options.deadlineMs ?? 3_600_000)).toISOString(),
    });
  } else if (tool === "pi_session_prompt") {
    const hit = find(response, (p) => (isObject(p.turn) && str(p.turn.turnId) && (isObject(p.session) ? str(p.session.id) : str(p.turn.sessionId)) ? p : undefined));
    const turn = hit && isObject(hit.turn) ? hit.turn : undefined, sessionId = (hit && isObject(hit.session) ? str(hit.session.id) : undefined) ?? str(turn?.sessionId);
    const turnId = str(turn?.turnId);
    if (!turnId || !sessionId) return events;
    const known = sessionOf(ledger, sessionId);
    events.push({ ...common("turn_started"), type: "turn_started", sessionId, turnId, kind: known && known.attempt.turns.length > 0 ? "follow_up" : "initial" });
  } else if (tool === "pi_turn_get") {
    const turn = find(response, (p) => (isObject(p.turn) && str(p.turn.state) && str(p.turn.turnId) && str(p.turn.sessionId) ? p.turn : undefined));
    const state = str(turn?.state), sessionId = str(turn?.sessionId), turnId = str(turn?.turnId);
    if (!turn || !state || !sessionId || !turnId) return events;
    if (state === "running") events.push({ ...common("turn_observed"), type: "turn_observed", sessionId, turnId });
    else if (state === "completed" || state === "failed" || state === "aborted") {
      const completedAt = str(turn.completedAt);
      events.push({ ...common("turn_terminal"), type: "turn_terminal", sessionId, turnId, runtime: state as TerminalRuntime, via: "poll", terminalAt: completedAt && !Number.isNaN(Date.parse(completedAt)) ? completedAt : at });
      if (state === "completed" && typeof turn.assistantText === "string") {
        events.push({ ...common("result_consumed"), type: "result_consumed", sessionId, turnId, textSha256: sha(turn.assistantText), textBytes: Buffer.byteLength(turn.assistantText, "utf8"), truncated: turn.truncated === true });
      }
    }
  } else if (tool === "pi_session_abort") {
    const code = find(response, (p) => (isObject(p.error) ? str(p.error.code) : undefined));
    const sessionId = str(input.sessionId), attempt = sessionId ? sessionOf(ledger, sessionId)?.attempt : undefined;
    const running = attempt?.turns.findLast((t) => t.runtime === "running" || t.runtime === "awaiting_input");
    if (code === "abort_timeout" && sessionId && running) events.push({ ...common("abort_unconfirmed"), type: "abort_unconfirmed", sessionId, turnId: running.turnId });
  } else if (tool === "pi_session_close") {
    const sessionId = str(input.sessionId);
    const ok = find(response, (p) => (typeof p.ok === "boolean" ? p.ok : undefined));
    if (sessionId && ok !== undefined) events.push({ ...common("session_closed"), type: "session_closed", sessionId, outcome: ok ? "closed" : "close_failed" });
  }
  return events;
}

export interface HookRun { events: number; outcomes: Array<{ type: string; outcome: string; code?: string }>; error?: string }
/** Applies one hook invocation under the store's lock. Never throws. */
export const HOOK_LOCK_TIMEOUT_MS = 1000; // a stale lock costs a synchronous hook at most about this long, then it is skipped and counted
export async function runLedgerHook(text: string, env: { dir: string; instance: string; runId?: string; now?: () => Date; baseCommit?: string; lockTimeoutMs?: number }): Promise<HookRun> {
  const store = new LedgerStore(env.dir, { lockTimeoutMs: env.lockTimeoutMs ?? HOOK_LOCK_TIMEOUT_MS });
  const record = (file: string, value: unknown): void => { try { appendFileSync(join(env.dir, file), `${JSON.stringify(value)}\n`); } catch { /* counting is best effort */ } };
  try {
    let hook: unknown;
    try { hook = JSON.parse(text); } catch { throw new LedgerError("hook_input_invalid"); }
    const now = env.now ?? (() => new Date());
    let ledger: RunLedger | undefined;
    try { ledger = await store.read(); } catch (error) {
      if (!(error instanceof LedgerError) || error.code !== "ledger_missing") throw error;
      try { await store.init(createLedger({ runId: env.runId ?? "run-hook", controllerLabel: "claude-hook", at: now().toISOString() })); } catch (initError) {
        if (!(initError instanceof LedgerError) || initError.code !== "ledger_exists") throw initError;
      }
      ledger = await store.read();
    }
    const events = projectHook(hook, ledger, { instance: env.instance, now, ...(env.baseCommit ? { baseCommit: env.baseCommit } : {}) });
    const result = await store.apply(events);
    const outcomes = result.outcomes.map((o, i) => ({ type: events[i]!.type, outcome: o.outcome, ...(o.code ? { code: o.code } : {}) }));
    for (const o of outcomes) record("hook-outcomes.jsonl", o);
    return { events: events.length, outcomes };
  } catch (error) {
    const code = error instanceof LedgerError ? error.code : "internal_error";
    record("hook-errors.jsonl", { code, ...(code === "ledger_locked" ? { skipped: true } : {}) });
    return { events: 0, outcomes: [], error: code };
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
function isEntryPoint(argvPath: string): boolean {
  try { return realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (process.argv[1] && isEntryPoint(process.argv[1])) {
  const dir = process.env.BRIDGE_LEDGER_DIR, instance = process.env.BRIDGE_LEDGER_INSTANCE ?? "ctl-local";
  if (dir) await runLedgerHook(await readStdin(), { dir, instance, ...(process.env.BRIDGE_LEDGER_RUN ? { runId: process.env.BRIDGE_LEDGER_RUN } : {}) });
  process.exit(0);
}

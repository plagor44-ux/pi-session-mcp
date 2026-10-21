import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BridgeEvent } from "./bridge.js";

// asyncRewake hook command. No model call: it waits for one content-free spool event of one turn, claims it, and exits 2
// with a single short line on stderr. The line carries IDs and a state only, never prompt, answer or assistant text.
export type BudgetPolicy = "wake" | "silent";
export interface HookTarget { sessionId: string; turnId: string }
export interface ParsedHook { toolName: string; target: HookTarget | undefined }
export type WakeReason = "terminal" | "question" | "budget";
export type SilentReason = "budget_silent" | "parent_gone" | "turn_done" | "no_turn" | "turn_unobserved" | "claim_error";
export type WaitResult = { action: "wake"; reason: WakeReason; message: string; event?: BridgeEvent } | { action: "silent"; reason: SilentReason; code?: string };
export interface WaitOptions {
  spoolBase: string; sessionId: string; turnId: string; budgetMs: number; onBudget: BudgetPolicy;
  pollMs?: number; parentCheckMs?: number; isParentAlive?: () => boolean; now?: () => number; signal?: AbortSignal;
  /** Test seam: runs right before a question claim, after the spool was read. */
  beforeClaim?: () => void;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const safeId = (v: unknown): string | undefined => (typeof v === "string" && SAFE_ID.test(v) ? v : undefined);

/** Every JSON object reachable in a tool_response: plain object, JSON string, or an array of content blocks (bounded). */
export function payloadsOf(response: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6 || out.length >= 200) return;
    if (typeof value === "string") {
      const text = value.trim();
      if (text.startsWith("{") || text.startsWith("[")) { try { visit(JSON.parse(text) as unknown, depth + 1); } catch { /* not JSON */ } }
      return;
    }
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    if (isObject(value)) { out.push(value); for (const item of Object.values(value)) visit(item, depth + 1); }
  };
  visit(response, 0);
  return out;
}

/** Pure: finds the (session, turn) a hook input refers to. `pi_session_prompt`: session.id + turn.turnId; `pi_turn_get`: a turn that is still `running`; `eval_question_answer`: sessionId + turnId. */
export function parseHookInput(text: string): ParsedHook {
  let input: unknown;
  try { input = JSON.parse(text); } catch { return { toolName: "", target: undefined }; }
  if (!isObject(input)) return { toolName: "", target: undefined };
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  const payloads = payloadsOf(input.tool_response);
  let target: HookTarget | undefined;
  if (toolName.endsWith("pi_session_prompt")) {
    for (const payload of payloads) {
      const turn = isObject(payload.turn) ? payload.turn : undefined, session = isObject(payload.session) ? payload.session : undefined;
      const turnId = safeId(turn?.turnId), sessionId = safeId(session?.id) ?? safeId(turn?.sessionId);
      if (turnId && sessionId) { target = { sessionId, turnId }; break; }
    }
  } else if (toolName.endsWith("pi_turn_get")) {
    for (const payload of payloads) {
      const turn = isObject(payload.turn) ? payload.turn : undefined;
      const turnId = safeId(turn?.turnId), sessionId = safeId(turn?.sessionId);
      if (turn?.state === "running" && turnId && sessionId) { target = { sessionId, turnId }; break; }
    }
  } else if (toolName.endsWith("eval_question_answer")) {
    for (const payload of payloads) {
      const turnId = safeId(payload.turnId), sessionId = safeId(payload.sessionId);
      if (turnId && sessionId) { target = { sessionId, turnId }; break; }
    }
  }
  return { toolName, target };
}

export function formatWake(event: BridgeEvent | { kind: "budget"; sessionId: string; turnId: string }): string {
  if (event.kind === "turn_terminal") return `pi-bridge: turn ${event.turnId} of session ${event.sessionId} is ${event.state}. Read it once with pi_turn_get.`;
  if (event.kind === "question_opened") return `pi-bridge: worker question ${event.requestId} (session ${event.sessionId}, turn ${event.turnId}) awaits the controller. Call eval_question_get, then eval_question_answer.`;
  if (event.kind === "budget") return `pi-bridge: no event for turn ${event.turnId} within the wait budget; it may still be running.`;
  return "";
}

const SPOOL_FILE = /^\d{8}-[a-z_]+\.json$/;
function instanceDirs(base: string): string[] {
  try { return readdirSync(base).filter((name) => name !== "claims" && !name.startsWith(".")).map((name) => join(base, name)).filter((dir) => { try { return statSync(dir).isDirectory(); } catch { return false; } }); } catch { return []; }
}
/** All parseable spool events below a spool base (one directory per instance). `cache` avoids rereading immutable files. */
export function readSpoolEvents(base: string, cache: Map<string, BridgeEvent | null> = new Map()): BridgeEvent[] {
  const events: BridgeEvent[] = [];
  for (const dir of instanceDirs(base)) {
    let names: string[];
    try { names = readdirSync(dir).filter((name) => SPOOL_FILE.test(name)); } catch { continue; }
    for (const name of names) {
      const path = join(dir, name);
      let event = cache.get(path);
      if (event === undefined) {
        try { event = JSON.parse(readFileSync(path, "utf8")) as BridgeEvent; } catch { event = null; }
        if (event !== null) cache.set(path, event);
      }
      if (event) events.push(event);
    }
  }
  return events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.seq - b.seq);
}
export function claimCount(base: string): number {
  try { return readdirSync(join(base, "claims")).length; } catch { return 0; }
}
/** The claim this process holds until its wake is delivered by exit 2; released if the client kills the hook first. */
let heldClaim: string | undefined;
export function releaseHeldClaim(): void {
  if (heldClaim === undefined) return;
  try { unlinkSync(heldClaim); } catch { /* already gone */ }
  heldClaim = undefined;
}
/** Exactly one waiter wins an event: exclusive create of the claim file. */
export function tryClaim(base: string, event: BridgeEvent): boolean {
  const dir = join(base, "claims"), path = join(dir, `${event.instanceId}-${event.seq}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { closeSync(openSync(path, "wx", 0o600)); heldClaim = path; return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/** BRIDGE_WAIT_BUDGET_MS: anything but a positive finite number (empty, text, zero, negative) means the default. */
export const DEFAULT_BUDGET_MS = 120_000;
export function parseBudget(raw: string | undefined): number {
  const value = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_BUDGET_MS;
}

const ofTurn = (event: BridgeEvent, sessionId: string, turnId: string): boolean => "turnId" in event && event.turnId === turnId && event.sessionId === sessionId;

/** Waits for the first unclaimed turn_terminal or controller question_opened of one turn. */
export async function waitForEvent(options: WaitOptions): Promise<WaitResult> {
  const now = options.now ?? Date.now, pollMs = options.pollMs ?? 200, parentCheckMs = options.parentCheckMs ?? 1000;
  const deadline = now() + options.budgetMs;
  const cache = new Map<string, BridgeEvent | null>();
  const watchers = new Map<string, FSWatcher>();
  let poke: (() => void) | undefined;
  const nudge = (): void => { poke?.(); };
  const watchDir = (dir: string): void => {
    if (watchers.has(dir)) return;
    try { const watcher = watch(dir, nudge); watcher.on("error", () => undefined); watchers.set(dir, watcher); } catch { /* polling is the fallback */ }
  };
  let nextParentCheck = now() + parentCheckMs;
  let claimError: WaitResult = { action: "silent", reason: "claim_error" };
  const claim = (event: BridgeEvent): boolean | "error" => {
    try { return tryClaim(options.spoolBase, event); } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      claimError = { action: "silent", reason: "claim_error", ...(typeof code === "string" && /^[A-Z0-9_]{1,20}$/.test(code) ? { code } : {}) };
      return "error";
    }
  };
  try {
    for (;;) {
      if (options.signal?.aborted) return { action: "silent", reason: "parent_gone" };
      watchDir(options.spoolBase); for (const dir of instanceDirs(options.spoolBase)) watchDir(dir);
      const events = readSpoolEvents(options.spoolBase, cache).filter((event) => ofTurn(event, options.sessionId, options.turnId));
      const resolved = new Set(events.flatMap((event) => (event.kind === "question_resolved" ? [event.requestId] : [])));
      for (const event of events) {
        if (event.kind === "turn_terminal") {
          const claimed = claim(event);
          if (claimed === "error") return claimError;
          if (claimed) return { action: "wake", reason: "terminal", message: formatWake(event), event };
          return { action: "silent", reason: "turn_done" }; // another waiter reported the final event of this turn
        }
        if (event.kind === "turn_unobserved") return { action: "silent", reason: "turn_unobserved" }; // close removed the turn unread: nothing to wake for
        if (event.kind === "question_opened" && event.recipient === "controller" && !resolved.has(event.requestId)) {
          options.beforeClaim?.();
          // The question may have been resolved since the spool was read; a wake for it would send the controller to a dead request.
          if (readSpoolEvents(options.spoolBase, cache).some((e) => e.kind === "question_resolved" && e.requestId === event.requestId)) continue;
          const claimed = claim(event);
          if (claimed === "error") return claimError;
          if (claimed) return { action: "wake", reason: "question", message: formatWake(event), event };
        }
      }
      const t = now();
      if (t >= nextParentCheck) {
        nextParentCheck = t + parentCheckMs;
        if (options.isParentAlive && !options.isParentAlive()) return { action: "silent", reason: "parent_gone" };
      }
      if (t >= deadline) {
        if (options.onBudget === "silent") return { action: "silent", reason: "budget_silent" };
        return { action: "wake", reason: "budget", message: formatWake({ kind: "budget", sessionId: options.sessionId, turnId: options.turnId }) };
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.max(1, Math.min(pollMs, deadline - t, nextParentCheck - t)));
        function done(): void { clearTimeout(timer); poke = undefined; resolve(); }
        poke = done;
      });
    }
  } finally { for (const watcher of watchers.values()) watcher.close(); }
}

/** Process-level parent check: the original parent must still be the parent and must still exist. */
export function parentAliveCheck(original: number = process.ppid): () => boolean {
  return () => {
    if (process.ppid !== original) return false;
    try { process.kill(original, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
function logReason(reason: string, code: number): void {
  const path = process.env.BRIDGE_WAITER_LOG;
  if (!path) return;
  try { appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, reason, exit: code })}\n`); } catch { /* best effort */ }
}
/** Exit-code path of the hook. With a line the exit happens after stderr is flushed, so callers must `return` right after. */
function finish(code: number, reason: string, line?: string): void {
  logReason(reason, code);
  if (line === undefined) process.exit(code);
  process.stderr.write(`${line}\n`, () => process.exit(code));
}
export async function main(): Promise<void> {
  // The client sends SIGTERM when the hook timeout expires; record that instead of vanishing silently.
  // A wake that was claimed but not yet delivered is released, so a later waiter of the same turn can still report it.
  process.once("SIGTERM", () => { releaseHeldClaim(); logReason("sigterm", 143); process.exit(143); });
  const parentAlive = parentAliveCheck(); // records the original parent before anything else
  try {
    const base = process.env.BRIDGE_SPOOL_BASE;
    const budgetMs = parseBudget(process.env.BRIDGE_WAIT_BUDGET_MS), onBudget: BudgetPolicy = process.env.BRIDGE_ON_BUDGET === "silent" ? "silent" : "wake";
    const parsed = parseHookInput(await readStdin());
    if (!base || !parsed.target) return finish(0, "no_turn");
    const result = await waitForEvent({ spoolBase: base, sessionId: parsed.target.sessionId, turnId: parsed.target.turnId, budgetMs, onBudget, isParentAlive: parentAlive });
    if (result.action === "wake") return finish(2, `wake_${result.reason}`, result.message);
    return finish(0, result.code ? `${result.reason}:${result.code}` : result.reason);
  } catch { return finish(0, "internal_error"); } // a hook must never print a stack trace or fail the host
}

function isEntryPoint(argvPath: string): boolean {
  try { return realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (process.argv[1] && isEntryPoint(process.argv[1])) await main().catch(() => process.exit(0));

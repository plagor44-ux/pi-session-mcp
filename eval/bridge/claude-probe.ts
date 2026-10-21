import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, inflateSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { ownedTemporary } from "../profiles/files.js";
import { classifyRequest, writeMessagesResponse, type SyntheticCall } from "../profiles/token-claude-projection.js";
import type { BridgeEvent } from "./bridge.js";
import { claimCount, readSpoolEvents } from "./hook-waiter.js";

// Provider-free host-adapter probe for Claude Code. Everything talks to a loopback fake Messages API with a dummy key,
// and the caller (cli.ts) runs this inside a fresh user+network namespace. Result files hold allowlisted fields only:
// counts, ordinals, millisecond offsets, states and labels. No body, prompt, answer or assistant text, no absolute path.
export const REQUIRED_CLIENT_VERSION = "2.1.303 (Claude Code)";
const SERVER_NAME = "pi-eval", PFX = `mcp__${SERVER_NAME}__`, MODEL = "claude-sonnet-5-5", DUMMY_KEY = "sk-ant-synthetic-loopback-dummy-0000";
const CANARIES = { prompt: "CANARY_PROMPT_probe_7f3a", question: "CANARY_QUESTION_probe_55aa", text: "CANARY_TEXT_probe_c0de" } as const;
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const ANSWER_DIGEST = `answer-digest:${sha256("beta")}`;
const MAX_REQUESTS = 40, BODY_CAP = 4 * 1024 * 1024;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const safeLabel = (v: unknown, pattern = /^[A-Za-z0-9_.:-]{1,80}$/): string | null => (typeof v === "string" && pattern.test(v) ? v : null);

// ---------------------------------------------------------------- fake model script
type Act = { call: { name: string; input: Record<string, unknown> } } | { text: string };
interface Out { act: Act; ok: boolean; note?: string }
interface Wake { kind: "terminal" | "question" | "budget"; sessionId: string; turnId: string; requestId?: string; state?: string }
interface ParsedReq {
  role: "main" | "auxiliary"; requestClass: string | null; results: Array<{ name: string; json: unknown }>; wakes: Wake[]; markerInLast: boolean; markerTotal: number;
  /** Where the marker sits among the fresh user messages (after the last assistant message). */
  markerPlaces: string[];
  /** Every message (role and distance from the end) or the system field that holds the marker anywhere in the body. */
  markerAnywhere: string[];
  /** Debug only (never written to result files): the last user message's strings that contain the marker. */
  markerTexts: string[];
}
interface Ctx { req: ParsedReq; kv: Record<string, string | undefined>; handled: Set<string> }
type Step = (ctx: Ctx) => Out;

const callOut = (name: string, input: Record<string, unknown>, ok = true, note?: string): Out => ({ act: { call: { name: `${PFX}${name}`, input } }, ok, ...(note ? { note } : {}) });
const textOut = (text: string, ok = true, note?: string): Out => ({ act: { text }, ok, ...(note ? { note } : {}) });
const result = (ctx: Ctx, tool: string): Record<string, any> | undefined => { const hit = ctx.req.results.find((r) => r.name === `${PFX}${tool}`); return isObject(hit?.json) ? hit.json as Record<string, any> : undefined; };
const takeWake = (ctx: Ctx, kind: Wake["kind"]): Wake | undefined => {
  const wake = ctx.req.wakes.find((w) => w.kind === kind && !ctx.handled.has(`${w.kind}:${w.requestId ?? w.turnId}`));
  if (wake) ctx.handled.add(`${wake.kind}:${wake.requestId ?? wake.turnId}`);
  return wake;
};
const WAKE_PATTERNS: Array<[RegExp, (m: RegExpExecArray) => Wake]> = [
  [/pi-bridge: turn (\S+) of session (\S+) is (\w+)\./g, (m) => ({ kind: "terminal", turnId: m[1]!, sessionId: m[2]!, state: m[3]! })],
  [/pi-bridge: worker question (\S+) \(session ([^,]+), turn ([^)]+)\) awaits/g, (m) => ({ kind: "question", requestId: m[1]!, sessionId: m[2]!, turnId: m[3]! })],
  [/pi-bridge: no event for turn (\S+) within/g, (m) => ({ kind: "budget", turnId: m[1]!, sessionId: "" })],
];

function textOf(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => (isObject(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []));
}
export function parseRequest(body: unknown, role: "main" | "auxiliary", requestClass: string | null): ParsedReq {
  const messages = isObject(body) && Array.isArray(body.messages) ? body.messages : [];
  const names = new Map<string, string>();
  for (const message of messages) if (isObject(message) && Array.isArray(message.content)) for (const block of message.content) if (isObject(block) && block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") names.set(block.id, block.name);
  // Only messages after the last assistant message are new to this request; older wake texts stay in history and are not counted again.
  let freshStart = 0;
  messages.forEach((message, index) => { if (isObject(message) && message.role === "assistant") freshStart = index + 1; });
  const results: ParsedReq["results"] = [], wakes: Wake[] = [], markerPlaces: ParsedReq["markerPlaces"] = [], markerTexts: string[] = [];
  let markerInLast = false;
  messages.forEach((message, index) => {
    if (index < freshStart || !isObject(message) || (message.role !== "user" && message.role !== "system")) return;
    const fromEnd = messages.length - 1 - index;
    const scan = (text: string, place: "text_block" | "tool_result"): void => {
      const where = message.role === "system" ? "system_message" : place;
      if (!text.includes("pi-bridge:")) return;
      markerInLast = true; markerTexts.push(text);
      const label = `fresh_${String(message.role)}_minus${fromEnd}:${where}`; if (!markerPlaces.includes(label)) markerPlaces.push(label);
      for (const [pattern, make] of WAKE_PATTERNS) { pattern.lastIndex = 0; for (let m = pattern.exec(text); m; m = pattern.exec(text)) wakes.push(make(m)); }
    };
    const blocks = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
    for (const block of blocks) {
      if (!isObject(block)) continue;
      if (block.type === "tool_result") {
        const text = textOf(block.content).join("");
        let json: unknown; try { json = JSON.parse(text); } catch { json = undefined; }
        results.push({ name: typeof block.tool_use_id === "string" ? names.get(block.tool_use_id) ?? "unknown" : "unknown", json });
        scan(text, "tool_result");
      } else for (const text of textOf(block.type === "text" ? block.text : undefined)) scan(text, "text_block");
    }
  });
  const markerAnywhere = messages.flatMap((message, index) => (JSON.stringify(message).includes("pi-bridge:") ? [`${isObject(message) ? String(message.role) : "?"}@-${messages.length - 1 - index}`] : []));
  if (isObject(body) && JSON.stringify(body.system ?? null).includes("pi-bridge:")) markerAnywhere.push("system");
  const markerTotal = JSON.stringify(body ?? null).split("pi-bridge:").length - 1;
  return { role, requestClass, results, wakes, markerInLast, markerTotal, markerPlaces, markerAnywhere, markerTexts };
}

const START = (): Out => callOut("pi_session_start", { workspace: "fixture", executionProfile: "fixture" });
const learnSession = (ctx: Ctx, tag = "sid"): string | undefined => { const id = result(ctx, "pi_session_start")?.session?.id; if (typeof id === "string") ctx.kv[tag] = id; return typeof id === "string" ? id : undefined; };
const learnTurn = (ctx: Ctx, tag = "tid"): string | undefined => { const id = result(ctx, "pi_session_prompt")?.turn?.turnId; if (typeof id === "string") ctx.kv[tag] = id; return typeof id === "string" ? id : undefined; };

function startAndPrompt(): Step[] {
  return [
    () => START(),
    (c) => { const sid = learnSession(c); return callOut("pi_session_prompt", { sessionId: sid ?? "missing", prompt: `${CANARIES.prompt} run the scripted worker task` }, sid !== undefined); },
    (c) => textOut("The worker runs in the background; waiting for its event.", learnTurn(c) !== undefined),
  ];
}
const completionTail = (tid: string, sid: string, expectedState = "completed"): Step[] => [
  (c) => {
    const wake = takeWake(c, "terminal");
    if (!wake) return textOut("Unexpected: no terminal wake.", false, "no_wake");
    const ok = wake.turnId === c.kv[tid] && wake.sessionId === c.kv[sid] && wake.state === expectedState;
    return callOut("pi_turn_get", { sessionId: wake.sessionId, turnId: wake.turnId }, ok, ok ? undefined : "wake_mismatch");
  },
  (c) => { const turn = result(c, "pi_turn_get")?.turn; const ok = turn?.state === "completed" && turn?.turnId === c.kv[tid]; return callOut("pi_session_close", { sessionId: c.kv[sid] ?? "missing" }, ok, ok ? undefined : "turn_mismatch"); },
  () => textOut("Closed the session. Done."),
];

// After the script (or for scenarios that expect no wake) a stray terminal wake is still handled so the client can settle.
function fallback(ctx: Ctx): Out {
  const wake = takeWake(ctx, "terminal");
  if (wake) return callOut("pi_turn_get", { sessionId: wake.sessionId, turnId: wake.turnId }, true, "fallback_get");
  if (result(ctx, "pi_turn_get")) return callOut("pi_session_close", { sessionId: result(ctx, "pi_turn_get")?.turn?.sessionId ?? "missing" }, true, "fallback_close");
  return textOut("Nothing further.", true, "fallback_text");
}

// ---------------------------------------------------------------- scenarios
interface WorkerSession { steps: Array<Record<string, unknown>> }
type Finish = { kind: "script_done"; extraMs: number } | { kind: "events_then_quiet"; events: number; quietMs: number } | { kind: "client_exit"; extraMs: number };
export interface Scenario {
  id: string; title: string; mode: "stream" | "oneshot"; hook: "asyncRewake" | "async"; hookTimeoutS: number; budgetMs: number; onBudget: "wake" | "silent";
  trigger: "event" | "supervisor"; sessions: WorkerSession[]; script: Step[]; finish: Finish; maxMs: number; expect: string;
  /** stream-json input with stdin closed right after the first message (separates "stdin closed" from "positional prompt"). */
  closeStdinAfterFirst?: boolean;
}
const complete = (afterMs: number): WorkerSession => ({ steps: [{ sleepMs: afterMs }, { complete: CANARIES.text }] });
export const SCENARIOS: Scenario[] = [
  { id: "S1", title: "completion rewake", mode: "stream", hook: "asyncRewake", hookTimeoutS: 60, budgetMs: 40_000, onBudget: "wake", trigger: "event", sessions: [complete(3000)],
    script: [...startAndPrompt(), ...completionTail("tid", "sid")], finish: { kind: "script_done", extraMs: 3500 }, maxMs: 30_000, expect: "one wake after the terminal event, then pi_turn_get and close" },
  { id: "S2", title: "two concurrent turns", mode: "stream", hook: "asyncRewake", hookTimeoutS: 60, budgetMs: 40_000, onBudget: "wake", trigger: "event", sessions: [complete(3000), complete(6000)],
    script: [
      () => START(), (c) => { learnSession(c, "sidA"); return START(); },
      (c) => { learnSession(c, "sidB"); return callOut("pi_session_prompt", { sessionId: c.kv.sidA ?? "missing", prompt: `${CANARIES.prompt} first` }); },
      (c) => { learnTurn(c, "tidA"); return callOut("pi_session_prompt", { sessionId: c.kv.sidB ?? "missing", prompt: `${CANARIES.prompt} second` }); },
      (c) => textOut("Both workers run in the background.", learnTurn(c, "tidB") !== undefined),
      ...completionTail("tidA", "sidA"), ...completionTail("tidB", "sidB"),
    ], finish: { kind: "script_done", extraMs: 3500 }, maxMs: 40_000, expect: "two wakes, in completion order, each followed by pi_turn_get of the matching turn" },
  { id: "S3", title: "controller question round trip", mode: "stream", hook: "asyncRewake", hookTimeoutS: 60, budgetMs: 40_000, onBudget: "wake", trigger: "event",
    sessions: [{ steps: [{ sleepMs: 2000 }, { ask: { recipient: "controller", kind: "select", prompt: `${CANARIES.question} which option?`, options: ["alpha", "beta"] }, deadlineMs: 40_000 }, { complete: ANSWER_DIGEST }] }],
    script: [
      ...startAndPrompt(),
      (c) => {
        const wake = takeWake(c, "question");
        if (!wake?.requestId) return textOut("Unexpected: no question wake.", false, "no_wake");
        c.kv.rid = wake.requestId;
        return callOut("eval_question_get", { requestId: wake.requestId }, wake.turnId === c.kv.tid && wake.sessionId === c.kv.sid, "question_wake");
      },
      (c) => {
        const q = result(c, "eval_question_get")?.question;
        const ok = Array.isArray(q?.options) && q.options.includes("beta") && q?.kind === "select";
        return callOut("eval_question_answer", { requestId: c.kv.rid ?? "missing", value: "beta" }, ok, ok ? undefined : "question_mismatch");
      },
      (c) => textOut("Answered the worker question.", result(c, "eval_question_answer")?.result === "accepted"),
      (c) => {
        const wake = takeWake(c, "terminal");
        if (!wake) return textOut("Unexpected: no terminal wake.", false, "no_wake");
        return callOut("pi_turn_get", { sessionId: wake.sessionId, turnId: wake.turnId }, wake.turnId === c.kv.tid && wake.state === "completed");
      },
      (c) => { const ok = result(c, "pi_turn_get")?.turn?.assistantText === ANSWER_DIGEST; return callOut("pi_session_close", { sessionId: c.kv.sid ?? "missing" }, ok, ok ? undefined : "digest_mismatch"); },
      () => textOut("Closed the session. Done."),
    ], finish: { kind: "script_done", extraMs: 3500 }, maxMs: 40_000, expect: "question wake, answer accepted, worker continues with the digest, terminal wake, pi_turn_get shows the digest" },
  { id: "S4", title: "control: plain async hook", mode: "stream", hook: "async", hookTimeoutS: 60, budgetMs: 40_000, onBudget: "wake", trigger: "event", sessions: [complete(3000)],
    script: startAndPrompt(), finish: { kind: "events_then_quiet", events: 1, quietMs: 10_000 }, maxMs: 45_000, expect: "no wake request after the spool event" },
  { id: "S5", title: "one-shot -p teardown", mode: "oneshot", hook: "asyncRewake", hookTimeoutS: 60, budgetMs: 40_000, onBudget: "wake", trigger: "event", sessions: [complete(8000)],
    script: startAndPrompt(), finish: { kind: "client_exit", extraMs: 0 }, maxMs: 40_000, expect: "client exits without a wake request; no hook or server process survives" },
  { id: "S6", title: "hook timeout shorter than the worker", mode: "stream", hook: "asyncRewake", hookTimeoutS: 4, budgetMs: 40_000, onBudget: "wake", trigger: "event", sessions: [complete(15_000)],
    script: startAndPrompt(), finish: { kind: "events_then_quiet", events: 1, quietMs: 5000 }, maxMs: 40_000, expect: "recorded only (wake or not, hook outcome); no leftover process" },
  { id: "S8", title: "diagnostic: stream-json input, stdin closed after the first message", mode: "stream", closeStdinAfterFirst: true, hook: "asyncRewake", hookTimeoutS: 60, budgetMs: 40_000, onBudget: "wake", trigger: "event", sessions: [complete(6000)],
    script: startAndPrompt(), finish: { kind: "client_exit", extraMs: 0 }, maxMs: 40_000, expect: "recorded only (does the client wait for the hook when stdin is closed?); no leftover process" },
];

// ---------------------------------------------------------------- helpers
export interface LeftoverProcess { pid: number; kind: string }
async function processesReferencing(root: string): Promise<LeftoverProcess[]> {
  const found: LeftoverProcess[] = [];
  for (const name of (await readdir("/proc")).filter((value) => /^\d+$/.test(value))) {
    if (Number(name) === process.pid) continue;
    const cmdline = await readFile(`/proc/${name}/cmdline`, "latin1").catch(() => ""), environ = await readFile(`/proc/${name}/environ`, "latin1").catch(() => "");
    if (!cmdline.includes(root) && !environ.includes(root)) continue;
    const kind = cmdline.includes("hook-waiter") ? "hook-waiter" : cmdline.includes("hook-ledger") ? "hook-ledger" : cmdline.includes("server-main") ? "server-main" : /claude/.test(cmdline.split("\0")[0] ?? "") || cmdline.includes("claude") ? "claude" : "other";
    found.push({ pid: Number(name), kind });
  }
  return found;
}
const histogram = (kinds: string[]): Record<string, number> => { const out: Record<string, number> = {}; for (const kind of kinds) out[kind] = (out[kind] ?? 0) + 1; return out; };
async function readJsonLines(path: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).flatMap((line) => { try { const v = JSON.parse(line) as unknown; return isObject(v) ? [v] : []; } catch { return []; } });
}
async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) { const path = join(dir, entry.name); if (entry.isDirectory()) out.push(...await listFiles(path)); else out.push(path); }
  return out;
}
/** True when the promise settled within `ms`. */
const bound = (promise: Promise<unknown>, ms: number): Promise<boolean> => Promise.race([promise.then(() => true, () => true), sleep(ms).then(() => false)]);
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void { if (child.pid) { try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } } } }

// ---------------------------------------------------------------- one Claude scenario
interface ReqRec {
  i: number; t_ms: number; role: string; request_class: string | null; marker_in_last_user: boolean; marker_places: string[]; marker_anywhere: string[]; marker_total: number; wake_kind: string | null; wake_delivery: "own_request" | "with_tool_result" | null;
  scripted: string; step: number | null; step_ok: boolean | null; note: string | null; wake_ref: { kind: string; turn: string | null; question: string | null } | null;
}
export interface ProbeOptions { out: string; clientVersion?: string; only?: string[] }
type Reportable = Extract<BridgeEvent, { kind: "turn_terminal" | "question_opened" }>;
const reportable = (events: BridgeEvent[]): Reportable[] => events.filter((e): e is Reportable => e.kind === "turn_terminal" || (e.kind === "question_opened" && e.recipient === "controller"));

async function runClaudeScenario(sc: Scenario, version: string): Promise<{ row: Record<string, unknown>; root: string }> {
  const buildDir = dirname(fileURLToPath(import.meta.url));
  const temp = await ownedTemporary();
  const root = temp.root, home = join(root, "home"), configDir = join(home, "claude-config"), workspace = join(root, "workspace"), scratch = join(root, "tmp");
  const spool = join(root, "spool"), ledger = join(root, "ledger"), counterFile = join(root, "counters.json"), waiterLog = join(root, "waiters.log");
  const requests: ReqRec[] = [];
  const kv: Ctx["kv"] = {}, handled = new Set<string>();
  const ordinals = { session: new Map<string, string>(), turn: new Map<string, string>(), question: new Map<string, string>() };
  const ord = (kind: keyof typeof ordinals, id: string | undefined | null): string | null => {
    if (!id) return null;
    const map = ordinals[kind], prefix = kind === "session" ? "s" : kind === "turn" ? "t" : "q";
    if (!map.has(id)) map.set(id, `${prefix}${map.size + 1}`);
    return map.get(id)!;
  };
  const st = { stepIndex: 0, scriptDone: false, invalid: false, httpUnexpected: 0, toolCalls: 0, exitCode: null as number | null, exitSignal: null as string | null, exitAt: null as number | null, stdinEndedAt: null as number | null, exited: false };
  const wallStart = Date.now();
  const rel = (): number => Date.now() - wallStart;
  const stream = { lines: 0, json_errors: 0, types: {} as Record<string, number>, system_subtypes: {} as Record<string, number>, results: [] as Array<Record<string, unknown>>,
    hook_events: [] as Array<Record<string, unknown>>, hook_event_keys: new Set<string>(), mcp_statuses: [] as string[] };
  let fake: Server | undefined, child: ChildProcess | undefined;
  let timedOut = false;
  let leftoverAtExit: LeftoverProcess[] = [], leftoverAfterGrace: LeftoverProcess[] = [], groupAliveAfterExit = false, tempRemoved = false;
  const collected: Record<string, unknown> = {};
  try {
    for (const dir of [configDir, workspace, scratch, spool, join(home, ".config"), join(home, ".local/share"), join(home, ".cache"), join(home, ".local/state")]) await mkdir(dir, { recursive: true });
    const evalConfig = join(root, "bridge-eval.json"), mcpConfig = join(root, "mcp.json"), settingsFile = join(root, "settings.json");
    await writeFile(evalConfig, JSON.stringify({ workspaceDir: workspace, spoolBase: spool, counterFile, trigger: sc.trigger, supervisorIntervalMs: 1000, sessions: sc.sessions }), { mode: 0o600 });
    await writeFile(mcpConfig, JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: process.execPath, args: [join(buildDir, "server-main.js")], env: { BRIDGE_EVAL_CONFIG: evalConfig } } } }), { mode: 0o600 });
    const tools = ["pi_session_start", "pi_session_prompt", "pi_turn_get", "pi_session_close", "pi_session_get", "pi_session_list", "pi_session_abort", "pi_capabilities_get", "eval_question_get", "eval_question_answer"].map((t) => `${PFX}${t}`);
    const waiterHook: Record<string, unknown> = { type: "command", command: `${process.execPath} ${join(buildDir, "hook-waiter.js")}`, timeout: sc.hookTimeoutS, ...(sc.hook === "asyncRewake" ? { asyncRewake: true } : { async: true }) };
    await writeFile(settingsFile, JSON.stringify({ hooks: { PostToolUse: [
      { matcher: `${PFX}pi_session_prompt|${PFX}eval_question_answer`, hooks: [waiterHook] },
      { matcher: `${PFX}pi_.*`, hooks: [{ type: "command", command: `${process.execPath} ${join(buildDir, "hook-ledger.js")}`, timeout: 20 }] },
    ] } }), { mode: 0o600 });

    // ---- fake Messages API
    fake = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1"), method = request.method ?? "";
      if (method === "HEAD" && url.pathname === "/api/hello") { response.writeHead(404); response.end(); return; }
      if (method === "POST" && url.pathname === "/v1/messages/count_tokens") { request.resume(); response.writeHead(404); response.end(); return; }
      if (method !== "POST" || url.pathname !== "/v1/messages") { st.httpUnexpected++; request.resume(); response.writeHead(404); response.end(); return; }
      try {
        const chunks: Buffer[] = []; let wire = 0;
        for await (const chunk of request) { wire += Buffer.byteLength(chunk); if (wire > BODY_CAP) { st.invalid = true; response.writeHead(413); response.end(); return; } chunks.push(Buffer.from(chunk)); }
        let raw = Buffer.concat(chunks);
        const encoding = String(request.headers["content-encoding"] ?? "identity");
        if (encoding === "gzip") raw = gunzipSync(raw, { maxOutputLength: BODY_CAP }); else if (encoding === "deflate") raw = inflateSync(raw, { maxOutputLength: BODY_CAP }); else if (encoding !== "identity") throw new Error("unsupported_encoding");
        const body = JSON.parse(raw.toString("utf8")) as unknown, klass = classifyRequest(request.headers, body);
        if (request.headers["x-api-key"] !== DUMMY_KEY || request.headers.authorization !== undefined) st.invalid = true;
        const parsed = parseRequest(body, klass.role, klass.request_class);
        const rec: ReqRec = { i: requests.length + 1, t_ms: rel(), role: klass.role, request_class: klass.request_class, marker_in_last_user: parsed.markerInLast, marker_places: parsed.markerPlaces, marker_anywhere: parsed.markerAnywhere, marker_total: parsed.markerTotal,
          wake_kind: parsed.wakes[0]?.kind ?? null, wake_delivery: parsed.wakes[0] ? (parsed.results.length > 0 ? "with_tool_result" : "own_request") : null, scripted: "text", step: null, step_ok: null, note: null,
          wake_ref: parsed.wakes[0] ? { kind: parsed.wakes[0].kind, turn: ord("turn", parsed.wakes[0].turnId), question: ord("question", parsed.wakes[0].requestId) } : null };
        requests.push(rec);
        if (process.env.BRIDGE_PROBE_DEBUG_DIR && parsed.markerTotal > 0) appendFileSync(join(process.env.BRIDGE_PROBE_DEBUG_DIR, `${sc.id}-req-${rec.i}.txt`), `${JSON.stringify({ anywhere: parsed.markerAnywhere, fresh: parsed.markerTexts, raw: (isObject(body) && Array.isArray(body.messages) ? body.messages : []).filter((m) => JSON.stringify(m).includes("pi-bridge:")).map((m) => JSON.stringify(m).slice(0, 700)) })}\n`);
        if (klass.role !== "main" || requests.filter((r) => r.role === "main").length > MAX_REQUESTS) { writeMessagesResponse(response, rec.i); return; }
        const ctx: Ctx = { req: parsed, kv, handled };
        const index = st.stepIndex++, out = index < sc.script.length ? sc.script[index]!(ctx) : fallback(ctx);
        rec.step = index; rec.step_ok = out.ok; rec.note = out.note ?? null;
        for (const id of [kv.sid, kv.sidA, kv.sidB]) ord("session", id);
        for (const id of [kv.tid, kv.tidA, kv.tidB]) ord("turn", id);
        ord("question", kv.rid);
        if (index === sc.script.length - 1) st.scriptDone = true;
        if ("call" in out.act) {
          rec.scripted = `tool_use:${out.act.call.name.slice(PFX.length)}`; st.toolCalls++;
          const call: SyntheticCall = { id: `toolu_probe_${rec.i}`, name: out.act.call.name, input: out.act.call.input };
          writeMessagesResponse(response, rec.i, call);
        } else writeMessagesResponse(response, rec.i);
      } catch { st.invalid = true; if (!response.headersSent) response.writeHead(400); response.end(); }
    });
    fake.listen(0, "127.0.0.1"); await once(fake, "listening");
    const address = fake.address(); if (!address || typeof address === "string") throw new Error("listener_failed");

    // ---- client
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, CLAUDE_CONFIG_DIR: configDir, TMPDIR: scratch, CLAUDE_CODE_TMPDIR: scratch,
      XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_CACHE_HOME: join(home, ".cache"), XDG_STATE_HOME: join(home, ".local/state"),
      ANTHROPIC_API_KEY: DUMMY_KEY, ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1", ENABLE_TOOL_SEARCH: "false",
      BRIDGE_SPOOL_BASE: spool, BRIDGE_WAIT_BUDGET_MS: String(sc.budgetMs), BRIDGE_ON_BUDGET: sc.onBudget, BRIDGE_WAITER_LOG: waiterLog,
      BRIDGE_LEDGER_DIR: ledger, BRIDGE_LEDGER_INSTANCE: `ctl-${sc.id.toLowerCase()}`, BRIDGE_LEDGER_RUN: `run-${sc.id.toLowerCase()}`,
    };
    const common = ["--settings", settingsFile, "--output-format", "stream-json", "--verbose", "--include-hook-events", "--strict-mcp-config", "--mcp-config", mcpConfig,
      "--allowedTools", tools.join(","), "--model", MODEL, "--no-session-persistence", "--tools", ""];
    const firstPrompt = `${CANARIES.prompt} start the scripted worker and wait for its event`;
    const argv = sc.mode === "oneshot" ? ["-p", firstPrompt, ...common] : ["-p", "--input-format", "stream-json", ...common];
    const spawned = spawn("claude", argv, { cwd: workspace, env, stdio: ["pipe", "pipe", "ignore"], detached: true });
    child = spawned;
    const closed = new Promise<void>((resolve) => spawned.once("close", (code, sig) => { st.exitCode = code; st.exitSignal = sig; st.exitAt = rel(); st.exited = true; resolve(); }));
    spawned.on("error", () => { st.invalid = true; });
    spawned.stdin!.on("error", () => undefined);
    let pending = "";
    spawned.stdout!.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      for (let i = pending.indexOf("\n"); i >= 0; i = pending.indexOf("\n")) {
        const line = pending.slice(0, i); pending = pending.slice(i + 1);
        if (!line) continue;
        stream.lines++;
        let event: Record<string, unknown>;
        try { const v = JSON.parse(line) as unknown; if (!isObject(v)) continue; event = v; } catch { stream.json_errors++; continue; }
        const type = safeLabel(event.type) ?? "other", subtype = safeLabel(event.subtype);
        stream.types[type] = (stream.types[type] ?? 0) + 1;
        if (type === "system" && subtype) stream.system_subtypes[subtype] = (stream.system_subtypes[subtype] ?? 0) + 1;
        if (type === "system" && subtype === "init" && Array.isArray(event.mcp_servers)) stream.mcp_statuses = event.mcp_servers.map((s) => safeLabel(isObject(s) ? s.status : null) ?? "other");
        if (type === "system" && subtype && subtype.startsWith("hook_")) {
          for (const key of Object.keys(event)) stream.hook_event_keys.add(key);
          stream.hook_events.push({ t_ms: rel(), subtype, hook_event: safeLabel(event.hook_event ?? event.hook_event_name), hook_name: safeLabel(event.hook_name),
            outcome: safeLabel(event.outcome), exit_code: typeof event.exit_code === "number" ? event.exit_code : null });
        }
        if (type === "result") stream.results.push({ t_ms: rel(), subtype: safeLabel(event.subtype), is_error: typeof event.is_error === "boolean" ? event.is_error : null, num_turns: typeof event.num_turns === "number" ? event.num_turns : null });
      }
    });
    if (sc.mode === "stream") { spawned.stdin!.write(`${JSON.stringify({ type: "user", message: { role: "user", content: firstPrompt } })}\n`); if (sc.closeStdinAfterFirst) spawned.stdin!.end(); } else spawned.stdin!.end();

    // ---- drive until the scenario's finish condition, always bounded
    const deadline = Date.now() + sc.maxMs;
    const terminalEvents = (): BridgeEvent[] => reportable(readSpoolEvents(spool));
    let doneAt: number | null = null, quietBase: number | null = null;
    while (Date.now() < deadline && !st.exited) {
      await sleep(100);
      if (sc.finish.kind === "script_done") { if (st.scriptDone) { doneAt ??= Date.now(); if (Date.now() - doneAt >= sc.finish.extraMs) break; } }
      else if (sc.finish.kind === "events_then_quiet") {
        const events = terminalEvents();
        if (events.length >= sc.finish.events) { quietBase ??= Date.now(); if (Date.now() - quietBase >= sc.finish.quietMs) break; }
      }
    }
    if (!st.exited && Date.now() >= deadline) timedOut = true;
    if (!st.exited) {
      if (sc.mode === "stream") { st.stdinEndedAt = rel(); try { spawned.stdin!.end(); } catch { /* closed */ } }
      if (!(await bound(closed, 10_000))) { timedOut = true; signalGroup(spawned, "SIGTERM"); if (!(await bound(closed, 4000))) { signalGroup(spawned, "SIGKILL"); await bound(closed, 3000); } }
    }
    // Hook and server processes may live a moment after the client; poll a short grace period before judging.
    leftoverAtExit = await processesReferencing(root);
    try { process.kill(-spawned.pid!, 0); groupAliveAfterExit = true; } catch { groupAliveAfterExit = false; }
    leftoverAfterGrace = leftoverAtExit;
    for (const end = Date.now() + 3000; leftoverAfterGrace.length > 0 && Date.now() < end;) { await sleep(150); leftoverAfterGrace = await processesReferencing(root); }
    // A leftover fails the scenario; it is still terminated before its temporary root is removed.
    for (const p of leftoverAfterGrace) { try { process.kill(p.pid, "SIGKILL"); } catch { /* gone */ } }
    signalGroup(spawned, "SIGKILL");

    // ---- collect (allowlisted fields only)
    const events = readSpoolEvents(spool);
    const spoolFiles = await listFiles(spool), ledgerFiles = await listFiles(ledger);
    let canaryInSpool = false, canaryInLedger = false;
    for (const file of spoolFiles) { const text = await readFile(file, "latin1").catch(() => ""); if (Object.values(CANARIES).some((c) => text.includes(c)) || text.includes(ANSWER_DIGEST)) canaryInSpool = true; }
    for (const file of ledgerFiles) { const text = await readFile(file, "latin1").catch(() => ""); if (Object.values(CANARIES).some((c) => text.includes(c)) || text.includes(ANSWER_DIGEST)) canaryInLedger = true; }
    const instances = new Map<string, string>(); const inst = (id: string): string => { if (!instances.has(id)) instances.set(id, `i${instances.size + 1}`); return instances.get(id)!; };
    const spoolRows = events.map((e) => ({
      instance: inst(e.instanceId), seq: e.seq, at_ms: Date.parse(e.at) - wallStart, kind: e.kind,
      state: e.kind === "turn_terminal" || e.kind === "question_resolved" ? e.state : null, via: e.kind === "turn_terminal" ? e.via : null, reason: e.kind === "instance_ended" ? e.reason : null,
      recipient: e.kind === "question_opened" ? e.recipient : null, question_kind: e.kind === "question_opened" ? e.questionKind : null,
      session: "sessionId" in e ? ord("session", e.sessionId) : null, turn: "turnId" in e ? ord("turn", e.turnId) : null, question: "requestId" in e ? ord("question", e.requestId) : null,
    }));
    const wakeReqs = requests.filter((r) => r.wake_kind !== null);
    const perEvent = reportable(events).map((e) => {
      const key = e.kind === "turn_terminal" ? { kind: "terminal", id: e.turnId } : { kind: "question", id: e.requestId };
      const matching = wakeReqs.filter((r) => r.wake_ref?.kind === key.kind && (key.kind === "terminal" ? r.wake_ref.turn === ord("turn", key.id) : r.wake_ref.question === ord("question", key.id)));
      const at = Date.parse(e.at) - wallStart;
      return { kind: e.kind, seq: e.seq, at_ms: at, via: e.kind === "turn_terminal" ? e.via : null, wakes: matching.length, delay_ms: matching[0] ? matching[0].t_ms - at : null };
    });
    const counters = JSON.parse(await readFile(counterFile, "utf8").catch(() => "null")) as unknown;
    const outcomes = await readJsonLines(join(ledger, "hook-outcomes.jsonl")), hookErrors = await readJsonLines(join(ledger, "hook-errors.jsonl")), waiters = await readJsonLines(waiterLog);
    const runJson = JSON.parse(await readFile(join(ledger, "run.json"), "utf8").catch(() => "null")) as unknown;
    const run = isObject(runJson) ? runJson : undefined;
    const attempts = Array.isArray(run?.tasks) ? (run.tasks as Array<Record<string, any>>).flatMap((t) => t.attempts as Array<Record<string, any>>) : [];
    const turns = attempts.flatMap((a) => a.turns as Array<Record<string, any>>);
    collected.counters = isObject(counters) ? { tools: counters.tools, pi_turn_get: counters.pi_turn_get } : null;
    collected.spool = { events: spoolRows, instance_dirs: instances.size, claims: claimCount(spool), canary_in_spool: canaryInSpool };
    collected.waiters = { started: waiters.length, by_reason: histogram(waiters.map((w) => String(w.reason))), exit_codes: histogram(waiters.map((w) => String(w.exit))) };
    collected.per_event = perEvent;
    collected.ledger = {
      revision: typeof run?.revision === "number" ? run.revision : null, outcomes_total: outcomes.length, outcomes: histogram(outcomes.map((o) => String(o.outcome))),
      rejected_codes: histogram(outcomes.filter((o) => o.outcome === "rejected").map((o) => String(o.code))), hook_errors: hookErrors.length, tasks: Array.isArray(run?.tasks) ? run.tasks.length : 0,
      task_work: histogram(Array.isArray(run?.tasks) ? (run.tasks as Array<Record<string, any>>).map((t) => String(t.work)) : []), turn_runtime: histogram(turns.map((t) => String(t.runtime))),
      results_consumed: turns.filter((t) => t.result).length, cleanup: histogram(attempts.map((a) => String(a.cleanup))), canary_in_ledger: canaryInLedger,
    };
  } catch { st.invalid = true; }
  finally {
    if (child) signalGroup(child, "SIGKILL");
    if (fake) { fake.closeAllConnections(); await new Promise<void>((resolve) => fake!.close(() => resolve())); }
    await temp.remove().catch(() => undefined);
    tempRemoved = !(await readdir(root).then(() => true, () => false));
  }

  const main = requests.filter((r) => r.role === "main"), wakeRequests = requests.filter((r) => r.wake_kind !== null);
  const perEvent = (collected.per_event ?? []) as Array<{ wakes: number; delay_ms: number | null; kind: string; at_ms: number; via: string | null }>;
  const lastRequestAt = requests.at(-1)?.t_ms ?? 0;
  const relevant = perEvent.filter((e) => e.at_ms <= lastRequestAt);
  const counters = (collected.counters ?? {}) as { tools?: Record<string, number>; pi_turn_get?: { running: number; terminal: number } };
  const base = {
    tooling: { client_version: version, node: process.versions.node }, scenario: sc.id, title: sc.title, mode: sc.mode, hook_kind: sc.hook, hook_timeout_s: sc.hookTimeoutS, expectation: sc.expect,
    exit_code: st.exitCode, exit_signal: st.exitSignal, timed_out: timedOut, exit_at_ms: st.exitAt, stdin_ended_at_ms: st.stdinEndedAt, harness_invalid: st.invalid, http_unexpected: st.httpUnexpected,
    requests: { total: requests.length, main: main.length, auxiliary: requests.length - main.length, list: requests, scripted_tool_calls: st.toolCalls },
    wakes: { requests: wakeRequests.length, by_kind: histogram(wakeRequests.map((r) => String(r.wake_kind))), by_delivery: histogram(wakeRequests.map((r) => String(r.wake_delivery))), events_before_last_request: relevant.length,
      missing: relevant.filter((e) => e.wakes === 0).length, duplicate: relevant.filter((e) => e.wakes > 1).length, delays_ms: perEvent.map((e) => e.delay_ms) },
    stream: { ...stream, hook_event_keys: [...stream.hook_event_keys].sort() },
    leftover: { at_exit: leftoverAtExit.length, at_exit_kinds: histogram(leftoverAtExit.map((p) => p.kind)), after_grace: leftoverAfterGrace.length, after_grace_kinds: histogram(leftoverAfterGrace.map((p) => p.kind)), group_alive_after_exit: groupAliveAfterExit },
    temp_removed: tempRemoved, step_failures: requests.filter((r) => r.step_ok === false).length,
    ...collected,
  };
  const stepsOk = base.step_failures === 0 && requests.some((r) => r.step !== null);
  const clean = !st.invalid && !timedOut && tempRemoved && leftoverAfterGrace.length === 0 && st.exitCode === 0;
  const tc = counters.pi_turn_get;
  const checks: Record<string, boolean> = { clean_teardown: clean };
  const wakes = wakeRequests.length, ownWakes = wakeRequests.filter((r) => r.wake_delivery === "own_request").length;
  if (sc.id === "S1") Object.assign(checks, { one_wake: wakes === 1, wake_is_own_request: ownWakes === 1, steps_ok: stepsOk, no_missing_or_duplicate: base.wakes.missing === 0 && base.wakes.duplicate === 0, one_terminal_read: tc?.terminal === 1 });
  if (sc.id === "S2") Object.assign(checks, { two_wakes: wakes === 2, wakes_are_own_requests: ownWakes === 2, steps_ok: stepsOk, no_missing_or_duplicate: base.wakes.missing === 0 && base.wakes.duplicate === 0, two_terminal_reads: tc?.terminal === 2 });
  if (sc.id === "S3") Object.assign(checks, { question_and_terminal_wake: wakeRequests.map((r) => r.wake_kind).join(",") === "question,terminal", steps_ok: stepsOk, no_missing_or_duplicate: base.wakes.missing === 0 && base.wakes.duplicate === 0, one_terminal_read: tc?.terminal === 1 });
  if (sc.id === "S4") Object.assign(checks, { no_wake: wakes === 0, spool_event_seen: perEvent.some((e) => e.kind === "turn_terminal") });
  if (sc.id === "S5") Object.assign(checks, { no_wake_own_request: ownWakes === 0, no_wake_text_in_any_request: wakes === 0, client_did_not_wait_for_worker: st.exitAt !== null && st.exitAt < 8000 });
  if (sc.id === "S6" || sc.id === "S8") Object.assign(checks, { recorded_only: true });
  return { row: { ...base, checks, passed_expectation: Object.values(checks).every(Boolean) }, root };
}

// ---------------------------------------------------------------- X6: two server processes, no shared registry (non-Claude)
async function runCrossProcess(): Promise<{ row: Record<string, unknown>; root: string }> {
  const buildDir = dirname(fileURLToPath(import.meta.url));
  const temp = await ownedTemporary(), root = temp.root, workspace = join(root, "workspace"), spool = join(root, "spool");
  await mkdir(workspace, { recursive: true }); await mkdir(spool, { recursive: true });
  const configPath = join(root, "bridge-eval.json");
  await writeFile(configPath, JSON.stringify({ workspaceDir: workspace, spoolBase: spool, trigger: "event", sessions: [{ steps: [{ hang: true }] }] }), { mode: 0o600 });
  const out: Record<string, unknown> = { scenario: "X6", title: "two server processes, same aliases, no shared registry" };
  let tempRemoved = false, leftover: LeftoverProcess[] = [], invalid = false;
  const clients: Client[] = [], transports: StdioClientTransport[] = [];
  const parse = (r: unknown): Record<string, any> | undefined => {
    const content = isObject(r) && Array.isArray(r.content) ? r.content : [];
    const text = content.flatMap((b) => (isObject(b) && typeof b.text === "string" ? [b.text] : []))[0];
    try { return text ? JSON.parse(text) as Record<string, any> : undefined; } catch { return undefined; }
  };
  const pids: number[] = [];
  try {
    for (let n = 0; n < 2; n++) {
      const transport = new StdioClientTransport({ command: process.execPath, args: [join(buildDir, "server-main.js")], env: { BRIDGE_EVAL_CONFIG: configPath }, stderr: "ignore" });
      const client = new Client({ name: `probe-x6-${n}`, version: "1.0.0" }, { capabilities: {} });
      client.onerror = () => undefined;
      await client.connect(transport, { timeout: 15_000 });
      clients.push(client); transports.push(transport); if (transport.pid) pids.push(transport.pid);
    }
    const started = parse(await clients[0]!.callTool({ name: "pi_session_start", arguments: { workspace: "fixture", executionProfile: "fixture" } }));
    const sessionId = started?.session?.id as string | undefined;
    const second = parse(await clients[1]!.callTool({ name: "pi_session_get", arguments: { sessionId: sessionId ?? "00000000-0000-4000-8000-000000000000" } }));
    const list2 = parse(await clients[1]!.callTool({ name: "pi_session_list", arguments: {} }));
    const list1 = parse(await clients[0]!.callTool({ name: "pi_session_list", arguments: {} }));
    const closed = parse(await clients[0]!.callTool({ name: "pi_session_close", arguments: { sessionId: sessionId ?? "00000000-0000-4000-8000-000000000000" } }));
    Object.assign(out, {
      started_in_first: started?.ok === true, second_get_ok: second?.ok, second_get_error: second?.error?.code ?? null, second_list_count: Array.isArray(list2?.sessions) ? list2.sessions.length : null,
      first_list_count: Array.isArray(list1?.sessions) ? list1.sessions.length : null, first_close_ok: closed?.ok === true,
    });
  } catch { invalid = true; }
  finally {
    for (const c of clients) { try { await bound(c.close(), 8000); } catch { /* best effort */ } }
    for (const t of transports) { try { await bound(t.close(), 4000); } catch { /* best effort */ } }
    for (const end = Date.now() + 4000;;) { leftover = await processesReferencing(root); if (leftover.length === 0 || Date.now() > end) break; await sleep(150); }
    for (const p of leftover) { try { process.kill(p.pid, "SIGKILL"); } catch { /* gone */ } }
    const dirs = await readdir(spool).catch(() => [] as string[]);
    const spoolEvents = readSpoolEvents(spool);
    Object.assign(out, { instance_dirs: dirs.length, spool_kinds: histogram(spoolEvents.map((e) => e.kind)), instance_end_reasons: histogram(spoolEvents.flatMap((e) => (e.kind === "instance_ended" ? [e.reason] : []))), server_pids_started: pids.length });
    await temp.remove().catch(() => undefined);
    tempRemoved = !(await readdir(root).then(() => true, () => false));
  }
  const checks = { two_instances: out.instance_dirs === 2, unknown_session_in_second: out.second_get_error === "unknown_session", second_list_empty: out.second_list_count === 0, first_list_had_session: out.first_list_count === 1,
    first_close_ok: out.first_close_ok === true, no_leftover: leftover.length === 0, temp_removed: tempRemoved, harness_ok: !invalid };
  return { row: { ...out, leftover_after_grace: leftover.length, temp_removed: tempRemoved, harness_invalid: invalid, checks, passed_expectation: Object.values(checks).every(Boolean) }, root };
}

// ---------------------------------------------------------------- driver
export function clientVersion(): string {
  const result = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent-probe-home", DISABLE_AUTOUPDATER: "1" } });
  return result.status === 0 ? result.stdout.trim() : "unavailable";
}
/** Throws when the result holds the temporary root, a canary, or anything that looks like an absolute path. */
export function assertClean(value: unknown, forbidden: string[]): void {
  const text = JSON.stringify(value);
  for (const needle of forbidden) if (needle && text.includes(needle)) throw new Error("output_validation_failed");
  if (/["\s]\/(tmp|home|var|usr|etc|proc|root|opt|run)\//.test(text) || Object.values(CANARIES).some((c) => text.includes(c)) || text.includes(ANSWER_DIGEST)) throw new Error("output_validation_failed");
}

export async function runProbe(options: ProbeOptions): Promise<Record<string, unknown>> {
  if (process.platform !== "linux") throw new Error("unsupported_probe_platform");
  const loopbackOnly = Object.values(networkInterfaces()).flat().every((i) => i?.internal === true);
  if (!loopbackOnly) throw new Error("network_namespace_not_isolated");
  const required = options.clientVersion ?? REQUIRED_CLIENT_VERSION, version = clientVersion();
  if (version !== required) throw new Error("unsupported_client_version");
  await mkdir(options.out, { recursive: true });
  const wanted = (id: string): boolean => !options.only || options.only.includes(id);
  const started_at = new Date().toISOString(), rows: Array<Record<string, unknown>> = [];
  const skipped = [{ scenario: "S7", reason: "no supported switch disables the registry's event-driven reconcile (settlement schedules it internally); a supervisor-only arm cannot be isolated without editing private state, so the detection-delay comparison is not run" }];
  const emit = async (id: string, { row, root }: { row: Record<string, unknown>; root: string }): Promise<void> => {
    let written = row;
    try { assertClean(row, [root, basename(root)]); } catch { written = { scenario: id, error: "output_validation_failed", passed_expectation: false }; }
    await writeFile(join(options.out, `${id}.json`), `${JSON.stringify(written, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    rows.push(written);
  };
  for (const sc of SCENARIOS) if (wanted(sc.id)) await emit(sc.id, await runClaudeScenario(sc, version));
  if (wanted("X6")) await emit("X6", await runCrossProcess());
  const summary = {
    schema_version: "bridge-host-probe-1", client_version: version, node: process.versions.node, started_at, ended_at: new Date().toISOString(), skipped,
    scenarios: rows.map((r) => ({ scenario: r.scenario, passed_expectation: r.passed_expectation, checks: r.checks ?? null, exit_code: r.exit_code ?? null, requests: isObject(r.requests) ? r.requests.total : null,
      wakes: isObject(r.wakes) ? r.wakes.requests : null, missing: isObject(r.wakes) ? r.wakes.missing : null, duplicate: isObject(r.wakes) ? r.wakes.duplicate : null, delays_ms: isObject(r.wakes) ? r.wakes.delays_ms : null,
      leftover_after_grace: isObject(r.leftover) ? r.leftover.after_grace : r.leftover_after_grace ?? null, counters: r.counters ?? null, ledger: isObject(r.ledger) ? { revision: r.ledger.revision, outcomes: r.ledger.outcomes } : null })),
  };
  assertClean(summary, []);
  await writeFile(join(options.out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return summary;
}

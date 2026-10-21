import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, inflateSync } from "node:zlib";
import { ownedTemporary } from "../profiles/files.js";
import { classifyRequest, writeMessagesResponse, type SyntheticCall } from "../profiles/token-claude-projection.js";
import { MemoryOwnershipStore } from "../../src/setup-ownership.js";
import { installWakeHook, runWakeHook, WAKE_MATCHER, WAKE_TIMEOUT_MARGIN_SECONDS, type WakeHookRoots } from "../../src/setup-hooks.js";
import { TURN_EVENT_FILE_PATTERN, claimsRoot, eventsRoot, parseTurnEvent, type TurnEvent } from "../../src/turn-events.js";
import { assertClean, clientVersion } from "./claude-probe.js";

// Provider-free acceptance probe for the product implementation of ADR 0011 (turn events, wake hook, setup). L3: a real
// Claude Code client with a scripted fake model on a loopback Messages API (dummy key), against
//   - a product-wired server (product-server-main.ts: product config, TurnEventSpool, createServer, scripted worker adapter), and
//   - the hook that the PRODUCT setup function (src/setup-hooks.ts) wrote into the client's user settings file.
// cli.ts runs this inside a fresh user+network namespace. Result files hold allowlisted fields only: counts, ordinals,
// millisecond offsets, states and labels. No prompt, answer or assistant text, no absolute path, no key.
const SERVER_NAME = "pi-session-mcp", PFX = `mcp__${SERVER_NAME}__`, MODEL = "claude-sonnet-5-5", DUMMY_KEY = "sk-ant-synthetic-loopback-dummy-0000";
const CANARY_PROMPT = "CANARY_PROMPT_product_probe_91bd";
const MAX_REQUESTS = 40, BODY_CAP = 4 * 1024 * 1024;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const safeLabel = (v: unknown, pattern = /^[A-Za-z0-9_.:-]{1,80}$/): string | null => (typeof v === "string" && pattern.test(v) ? v : null);
const histogram = (kinds: string[]): Record<string, number> => { const o: Record<string, number> = {}; for (const k of kinds) o[k] = (o[k] ?? 0) + 1; return o; };
const bound = (p: Promise<unknown>, ms: number): Promise<boolean> => Promise.race([p.then(() => true, () => true), sleep(ms).then(() => false)]);
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void { if (child.pid) { try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } } } }
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// ---------------------------------------------------------------- fake model script
type Act = { call: { name: string; input: Record<string, unknown> } } | { text: string };
interface Out { act: Act; ok: boolean; note?: string; done?: boolean }
interface Wake { kind: "terminal" | "budget"; sessionId: string; turnId: string; state?: string }
interface ParsedReq {
  role: "main" | "auxiliary"; requestClass: string | null; results: Array<{ name: string; json: unknown }>; wakes: Wake[];
  markerFresh: boolean; markerTotal: number; markerPlaces: string[];
}
interface Ctx { req: ParsedReq; kv: Record<string, string | undefined>; handled: Set<string> }
type Step = (ctx: Ctx) => Out;

const callOut = (name: string, input: Record<string, unknown>, ok = true, note?: string): Out => ({ act: { call: { name: `${PFX}${name}`, input } }, ok, ...(note ? { note } : {}) });
const textOut = (text: string, ok = true, note?: string, done = false): Out => ({ act: { text }, ok, ...(note ? { note } : {}), ...(done ? { done } : {}) });
const result = (ctx: Ctx, tool: string): Record<string, any> | undefined => { const hit = ctx.req.results.find((r) => r.name === `${PFX}${tool}`); return isObject(hit?.json) ? hit.json as Record<string, any> : undefined; };
const takeWake = (ctx: Ctx, kind: Wake["kind"]): Wake | undefined => {
  const wake = ctx.req.wakes.find((w) => w.kind === kind && !ctx.handled.has(`${w.kind}:${w.turnId}`));
  if (wake) ctx.handled.add(`${wake.kind}:${wake.turnId}`);
  return wake;
};
// The two wake texts of src/wake-hook.ts (formatTerminalWake, formatBudgetWake).
const WAKE_PATTERNS: Array<[RegExp, (m: RegExpExecArray) => Wake]> = [
  [/pi-session-mcp: turn (\S+) of session (\S+) is (\w+)\./g, (m) => ({ kind: "terminal", turnId: m[1]!, sessionId: m[2]!, state: m[3]! })],
  [/pi-session-mcp: no event for turn (\S+) within/g, (m) => ({ kind: "budget", turnId: m[1]!, sessionId: "" })],
];
const MARKER = /pi-session-mcp: (?:turn |no event for turn )/g;

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
  const results: ParsedReq["results"] = [], wakes: Wake[] = [], markerPlaces: string[] = [];
  let markerFresh = false;
  messages.forEach((message, index) => {
    if (index < freshStart || !isObject(message) || (message.role !== "user" && message.role !== "system")) return;
    const fromEnd = messages.length - 1 - index;
    const scan = (text: string, place: "text_block" | "tool_result"): void => {
      MARKER.lastIndex = 0;
      if (!MARKER.test(text)) return;
      markerFresh = true;
      const label = `fresh_${String(message.role)}_minus${fromEnd}:${message.role === "system" ? "system_message" : place}`; if (!markerPlaces.includes(label)) markerPlaces.push(label);
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
  const markerTotal = (JSON.stringify(body ?? null).match(MARKER) ?? []).length;
  return { role, requestClass, results, wakes, markerFresh, markerTotal, markerPlaces };
}

const CAPS = (): Out => callOut("pi_capabilities_get", {});
const START = (c: Ctx, expectedDelivery: string): Out => {
  const delivery = result(c, "pi_capabilities_get")?.events?.delivery;
  c.kv.capsDelivery = typeof delivery === "string" ? delivery : "missing";
  return callOut("pi_session_start", { workspace: "fixture", executionProfile: "scripted" }, delivery === expectedDelivery, delivery === expectedDelivery ? undefined : "capabilities_mismatch");
};
const learnSession = (ctx: Ctx, tag = "sid"): string | undefined => { const id = result(ctx, "pi_session_start")?.session?.id; if (typeof id === "string") ctx.kv[tag] = id; return typeof id === "string" ? id : undefined; };
const learnTurn = (ctx: Ctx, tag = "tid"): string | undefined => { const id = result(ctx, "pi_session_prompt")?.turn?.turnId; if (typeof id === "string") ctx.kv[tag] = id; return typeof id === "string" ? id : undefined; };

function startAndPrompt(expectedDelivery: string): Step[] {
  return [
    () => CAPS(),
    (c) => START(c, expectedDelivery),
    (c) => { const sid = learnSession(c); return callOut("pi_session_prompt", { sessionId: sid ?? "missing", prompt: `${CANARY_PROMPT} run the scripted worker task` }, sid !== undefined); },
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
  (c) => { const turn = result(c, "pi_turn_get")?.turn; const ok = turn?.state === expectedState && turn?.turnId === c.kv[tid]; return callOut("pi_session_close", { sessionId: c.kv[sid] ?? "missing" }, ok, ok ? undefined : "turn_mismatch"); },
  () => textOut("Closed the session.", true, undefined, false),
];
const lastDone = (steps: Step[]): Step[] => steps.map((step, i) => (i === steps.length - 1 ? (c) => ({ ...step(c), done: true }) : step));

// After the script, a stray terminal wake is still read so that the client can settle.
function fallback(ctx: Ctx): Out {
  const wake = takeWake(ctx, "terminal");
  if (wake) return callOut("pi_turn_get", { sessionId: wake.sessionId, turnId: wake.turnId }, true, "fallback_get");
  return textOut("Nothing further.", true, "fallback_text", true);
}

// ---------------------------------------------------------------- scenarios
type Finish = { kind: "script_done"; extraMs: number };
export interface Scenario {
  id: string; title: string; delivery: "spool" | "off"; hookBudgetMs: number; sessions: Array<{ steps: Array<Record<string, unknown>> }>;
  script: Step[]; finish: Finish; maxMs: number; expect: string;
}
const complete = (afterMs: number) => ({ steps: [{ sleepMs: afterMs }, { complete: "scripted-result" }] });
const readTurn = (w: Wake, expectedState: string, c: Ctx): Out => callOut("pi_turn_get", { sessionId: w.sessionId, turnId: w.turnId }, w.turnId === c.kv.tid && w.state === expectedState, w.state === expectedState ? undefined : "wake_mismatch");
// Waits for the terminal wake, tolerant of where the client delivers it (own request, or together with a tool result); reads the turn; closes the session.
const abortedReactor: Step = (c) => {
  if (result(c, "pi_session_close")) return textOut("Closed the session.", true, undefined, true);
  if (result(c, "pi_turn_get")?.turn?.state === "aborted") return callOut("pi_session_close", { sessionId: c.kv.sid ?? "missing" });
  const wake = takeWake(c, "terminal");
  return wake ? readTurn(wake, "aborted", c) : textOut("Waiting for the abort event.");
};
// Budget-wake script: arm, budget wake, re-arm with pi_turn_get (running), abort -> the re-armed hook wakes on the aborted terminal.
const budgetTail: Step[] = [
  (c) => {
    const wake = takeWake(c, "budget");
    if (!wake) return textOut("Unexpected: no budget wake.", false, "no_wake");
    const ok = wake.turnId === c.kv.tid;
    return callOut("pi_turn_get", { sessionId: c.kv.sid ?? "missing", turnId: wake.turnId }, ok, ok ? undefined : "wake_mismatch");
  },
  (c) => { const ok = result(c, "pi_turn_get")?.turn?.state === "running"; return callOut("pi_session_abort", { sessionId: c.kv.sid ?? "missing" }, ok, ok ? undefined : "turn_not_running"); },
  ...Array.from({ length: 6 }, () => abortedReactor),
];
// Observation: close a session whose turn is still running. The close generates the terminal event (via close); the wake is delivered, but the session is gone.
const closeRunningTail: Step[] = [
  (c) => { learnTurn(c); return callOut("pi_session_close", { sessionId: c.kv.sid ?? "missing" }); },
  ...Array.from({ length: 6 }, (): Step => (c) => {
    const read = result(c, "pi_turn_get");
    if (read) { c.kv.readAfterClose = read.ok === true ? "ok" : safeLabel(read.error?.code) ?? "unlabelled"; return textOut("Read the closed turn.", true, undefined, true); }
    const wake = takeWake(c, "terminal");
    return wake ? readTurn(wake, "aborted", c) : textOut("Waiting for the close event.");
  }),
];
export const SCENARIOS: Scenario[] = [
  { id: "P1", title: "completion wake with spool delivery", delivery: "spool", hookBudgetMs: 120_000, sessions: [complete(3000)],
    script: lastDone([...startAndPrompt("spool"), ...completionTail("tid", "sid")]), finish: { kind: "script_done", extraMs: 3500 }, maxMs: 30_000,
    expect: "capabilities report spool; one wake after the terminal event whose text names the turn; pi_turn_get once; close" },
  { id: "P2", title: "two concurrent turns", delivery: "spool", hookBudgetMs: 120_000, sessions: [complete(3000), complete(6000)],
    script: lastDone([
      () => CAPS(), (c) => { const d = result(c, "pi_capabilities_get")?.events?.delivery; c.kv.capsDelivery = typeof d === "string" ? d : "missing"; return callOut("pi_session_start", { workspace: "fixture", executionProfile: "scripted" }, d === "spool"); },
      (c) => { learnSession(c, "sidA"); return callOut("pi_session_start", { workspace: "fixture", executionProfile: "scripted" }); },
      (c) => { learnSession(c, "sidB"); return callOut("pi_session_prompt", { sessionId: c.kv.sidA ?? "missing", prompt: `${CANARY_PROMPT} first` }); },
      (c) => { learnTurn(c, "tidA"); return callOut("pi_session_prompt", { sessionId: c.kv.sidB ?? "missing", prompt: `${CANARY_PROMPT} second` }); },
      (c) => textOut("Both workers run in the background.", learnTurn(c, "tidB") !== undefined),
      ...completionTail("tidA", "sidA"), ...completionTail("tidB", "sidB"),
    ]), finish: { kind: "script_done", extraMs: 3500 }, maxMs: 40_000, expect: "two wakes in completion order, each followed by pi_turn_get of the matching turn" },
  { id: "P3", title: "budget wake, re-arm, abort wake", delivery: "spool", hookBudgetMs: 4000, sessions: [{ steps: [{ hang: true }] }],
    script: [...startAndPrompt("spool"), ...budgetTail], finish: { kind: "script_done", extraMs: 3500 }, maxMs: 40_000,
    expect: "hook budget 4 s: budget wake while running; pi_turn_get (running) re-arms; close aborts and the re-armed hook wakes on the aborted terminal" },
  { id: "P4", title: "delivery off", delivery: "off", hookBudgetMs: 120_000, sessions: [complete(2000)],
    script: lastDone(startAndPrompt("off")), finish: { kind: "script_done", extraMs: 6000 }, maxMs: 30_000,
    expect: "capabilities report off; setup reports hook_not_enabled and writes nothing; no spool directory; no wake" },
  { id: "P6", title: "observation: close of a running turn", delivery: "spool", hookBudgetMs: 120_000, sessions: [{ steps: [{ hang: true }] }],
    script: [...startAndPrompt("spool").slice(0, 3), ...closeRunningTail], finish: { kind: "script_done", extraMs: 3500 }, maxMs: 30_000,
    expect: "recorded: the close writes a terminal event (via close) and the armed hook wakes; the later pi_turn_get result is only labelled" },
];

// ---------------------------------------------------------------- helpers
export interface LeftoverProcess { pid: number; kind: string }
async function processesReferencing(root: string): Promise<LeftoverProcess[]> {
  const found: LeftoverProcess[] = [];
  for (const name of (await readdir("/proc")).filter((v) => /^\d+$/.test(v))) {
    if (Number(name) === process.pid) continue;
    const cmdline = await readFile(`/proc/${name}/cmdline`, "latin1").catch(() => ""), environ = await readFile(`/proc/${name}/environ`, "latin1").catch(() => "");
    if (!cmdline.includes(root) && !environ.includes(root)) continue;
    const kind = cmdline.includes("wake-main") ? "wake-main" : cmdline.includes("product-server-main") ? "product-server-main" : cmdline.includes("claude") ? "claude" : "other";
    found.push({ pid: Number(name), kind });
  }
  return found;
}
interface SpoolSeen { instance: string; seq: number; at_ms: number; seen_ms: number; kind: string; state: string | null; via: string | null; reason: string | null; session: string | null; turn: string | null }
interface SpoolWatch { rootExisted: boolean; rootModeOk: boolean | null; instancesMax: number; claimsDirSeen: boolean; claimsMax: number; seen: Map<string, SpoolSeen>; raw: TurnEvent[] }

/** Polls the host spool and claims directories read-only (the probe's own observation, independent of the product reader). */
async function pollSpool(env: NodeJS.ProcessEnv, watch: SpoolWatch, rel: () => number, wallStart: number, ord: (kind: "session" | "turn", id: string) => string | null): Promise<void> {
  const events = eventsRoot(env), claims = claimsRoot(env);
  if (events) {
    const rootStat = await lstat(events).catch(() => undefined);
    if (rootStat) { watch.rootExisted = true; watch.rootModeOk = rootStat.isDirectory() && (rootStat.mode & 0o777) === 0o700; }
    const instances = (await readdir(events).catch(() => [] as string[])).filter((n) => /^inst-[0-9a-f]{16}$/.test(n));
    watch.instancesMax = Math.max(watch.instancesMax, instances.length);
    for (const inst of instances) {
      for (const file of (await readdir(join(events, inst)).catch(() => [] as string[])).filter((n) => TURN_EVENT_FILE_PATTERN.test(n))) {
        const key = `${inst}/${file}`;
        if (watch.seen.has(key)) continue;
        const event = parseTurnEvent(await readFile(join(events, inst, file), "utf8").catch(() => ""));
        if (!event) continue;
        watch.raw.push(event);
        watch.seen.set(key, {
          instance: `i${new Set([...watch.seen.values()].map((s) => s.instance)).size + 1}`, seq: event.seq, at_ms: Date.parse(event.at) - wallStart, seen_ms: rel(), kind: event.kind,
          state: event.kind === "turn_terminal" ? event.state : null, via: event.kind === "turn_terminal" ? event.via : null, reason: event.kind === "instance_ended" ? event.reason : null,
          session: event.kind === "turn_terminal" ? ord("session", event.session) : null, turn: event.kind === "turn_terminal" ? ord("turn", event.turn) : null,
        });
      }
    }
  }
  if (claims) {
    const stat = await lstat(claims).catch(() => undefined);
    if (stat) { watch.claimsDirSeen = true; watch.claimsMax = Math.max(watch.claimsMax, (await readdir(claims).catch(() => [] as string[])).length); }
  }
}

// ---------------------------------------------------------------- settings file check (setup's output is what the client reads)
const OTHER_ENTRY = { matcher: "NoSuchTool", hooks: [{ type: "command", command: "true", timeout: 5 }] };
const SEED = { cleanupPeriodDays: 31, hooks: { PostToolUse: [OTHER_ENTRY] } };
async function inspectSettings(file: string, budgetMs: number): Promise<Record<string, unknown>> {
  const bytes = await readFile(file, "utf8").catch(() => undefined);
  if (bytes === undefined) return { file_present: false };
  let doc: unknown; try { doc = JSON.parse(bytes); } catch { return { file_present: true, parseable: false }; }
  if (!isObject(doc)) return { file_present: true, parseable: false };
  const hooks = isObject(doc.hooks) ? doc.hooks : {}, list = Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse as unknown[] : [];
  const wake = list.filter((e) => isObject(e) && Array.isArray(e.hooks) && e.hooks.some((h) => isObject(h) && typeof h.command === "string" && h.command.includes("/dist/wake-main.js")));
  const entry = isObject(wake[0]) ? wake[0] : undefined, hook = entry && Array.isArray(entry.hooks) && isObject(entry.hooks[0]) ? entry.hooks[0] : undefined;
  const command = typeof hook?.command === "string" ? hook.command : "";
  return {
    file_present: true, parseable: true, wake_entries: wake.length, post_tool_use_entries: list.length,
    other_entry_preserved: JSON.stringify(list[0]) === JSON.stringify(OTHER_ENTRY), other_keys_preserved: doc.cleanupPeriodDays === SEED.cleanupPeriodDays,
    matcher_is_product: entry?.matcher === WAKE_MATCHER, async_rewake: hook?.asyncRewake === true, type_command: hook?.type === "command",
    command_uses_exec_path: command.startsWith(`${process.execPath} `), command_program_is_package_dist: command.includes(` ${packageRoot}/dist/wake-main.js `),
    command_budget_matches: command.endsWith(` --budget-ms ${budgetMs}`), timeout_covers_budget: hook?.timeout === Math.ceil(budgetMs / 1000) + WAKE_TIMEOUT_MARGIN_SECONDS,
  };
}

// ---------------------------------------------------------------- one scenario
interface ReqRec {
  i: number; t_ms: number; role: string; request_class: string | null; marker_in_fresh: boolean; marker_places: string[]; marker_total: number; wake_kind: string | null;
  wake_delivery: "own_request" | "with_tool_result" | null; scripted: string; step: number | null; step_ok: boolean | null; note: string | null; wake_ref: { kind: string; turn: string | null; state: string | null } | null;
}
async function runScenario(sc: Scenario, version: string): Promise<{ row: Record<string, unknown>; root: string }> {
  const buildDir = dirname(fileURLToPath(import.meta.url));
  const temp = await ownedTemporary();
  const root = temp.root, home = join(root, "home"), configDir = join(home, "claude-config"), workspace = join(root, "workspace"), scratch = join(root, "tmp"), runtime = join(root, "run");
  const settingsFile = join(configDir, "settings.json"), counterFile = join(root, "counters.json");
  const requests: ReqRec[] = [];
  const kv: Ctx["kv"] = {}, handled = new Set<string>();
  const ordinals = { session: new Map<string, string>(), turn: new Map<string, string>() };
  const ord = (kind: "session" | "turn", id: string | undefined | null): string | null => {
    if (!id) return null;
    const map = ordinals[kind], prefix = kind === "session" ? "s" : "t";
    if (!map.has(id)) map.set(id, `${prefix}${map.size + 1}`);
    return map.get(id)!;
  };
  const st = { stepIndex: 0, scriptDone: false, invalid: false, httpUnexpected: 0, toolCalls: 0, exitCode: null as number | null, exitSignal: null as string | null, exitAt: null as number | null, exited: false, stdinEndedAt: null as number | null };
  const wallStart = Date.now();
  const rel = (): number => Date.now() - wallStart;
  const stream = { lines: 0, json_errors: 0, types: {} as Record<string, number>, system_subtypes: {} as Record<string, number>, results: [] as Array<Record<string, unknown>>,
    hook_events: [] as Array<Record<string, unknown>>, mcp_statuses: [] as string[] };
  const watch: SpoolWatch = { rootExisted: false, rootModeOk: null, instancesMax: 0, claimsDirSeen: false, claimsMax: 0, seen: new Map(), raw: [] };
  const setup: Record<string, unknown> = {};
  let fake: Server | undefined, child: ChildProcess | undefined;
  let timedOut = false, groupAliveAfterExit = false, tempRemoved = false;
  let leftoverAtExit: LeftoverProcess[] = [], leftoverAfterGrace: LeftoverProcess[] = [];
  const collected: Record<string, unknown> = {};
  const clientEnvForPaths: NodeJS.ProcessEnv = { XDG_RUNTIME_DIR: runtime };
  try {
    for (const dir of [configDir, workspace, scratch, join(home, ".config"), join(home, ".local/share"), join(home, ".cache"), join(home, ".local/state")]) await mkdir(dir, { recursive: true });
    await mkdir(runtime, { mode: 0o700 }); chmodSync(runtime, 0o700); // the runtime directory of the namespace's user: events and claims roots resolve below it
    const serverConfig = join(root, "pi-session-mcp.json"), scriptFile = join(root, "script.json"), mcpConfig = join(root, "mcp.json");
    await writeFile(serverConfig, JSON.stringify({
      ...(sc.delivery === "spool" ? { events: { delivery: "spool" } } : {}),
      workspaces: { fixture: workspace },
      executionProfiles: { scripted: { default: true, permissionProfile: "read-only", provider: "scripted", model: "scripted", thinkingLevel: "off" } },
    }), { mode: 0o600 });
    await writeFile(scriptFile, JSON.stringify({ counterFile, sessions: sc.sessions }), { mode: 0o600 });
    // A registration carries only the configuration path (plus the probe's script file); the runtime directory comes from the inherited environment.
    await writeFile(mcpConfig, JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: process.execPath, args: [join(buildDir, "product-server-main.js")], env: { PI_SESSION_MCP_CONFIG: serverConfig, PRODUCT_PROBE_SCRIPT: scriptFile } } } }), { mode: 0o600 });

    // ---- setup: the PRODUCT hook installer writes the user-scope settings the client will read (no --settings flag)
    await writeFile(settingsFile, `${JSON.stringify(SEED, null, 2)}\n`, { mode: 0o600 });
    const seedBytes = await readFile(settingsFile, "utf8");
    const ownership = new MemoryOwnershipStore();
    const hookEnv = { CLAUDE_CONFIG_DIR: configDir };
    const roots: WakeHookRoots = { packageRoot, home, cwd: workspace, env: hookEnv, nodePath: process.execPath, budgetMs: sc.hookBudgetMs };
    const install = (apply: boolean) => installWakeHook({ scope: "user", cwd: workspace, home, env: hookEnv, ownership, apply, packageRoot, delivery: sc.delivery === "spool", nodePath: process.execPath, budgetMs: sc.hookBudgetMs });
    const finding = (f: { status: string; code: string }) => ({ status: f.status, code: f.code });
    setup.dry_run = finding(await install(false));
    setup.dry_run_wrote_nothing = (await readFile(settingsFile, "utf8")) === seedBytes;
    setup.apply = finding(await install(true));
    setup.verify = finding({ ...(await runWakeHook({ operation: "verify", scope: "user", roots, enabled: sc.delivery === "spool", ownership })) });
    setup.reapply = finding(await install(true));
    setup.settings_after_setup = await inspectSettings(settingsFile, sc.hookBudgetMs);
    setup.settings_bytes_unchanged = (await readFile(settingsFile, "utf8")) === seedBytes;

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
        const first = parsed.wakes[0];
        const rec: ReqRec = { i: requests.length + 1, t_ms: rel(), role: klass.role, request_class: klass.request_class, marker_in_fresh: parsed.markerFresh, marker_places: parsed.markerPlaces, marker_total: parsed.markerTotal,
          wake_kind: first?.kind ?? null, wake_delivery: first ? (parsed.results.length > 0 ? "with_tool_result" : "own_request") : null, scripted: "text", step: null, step_ok: null, note: null,
          wake_ref: first ? { kind: first.kind, turn: ord("turn", first.turnId), state: first.state ?? null } : null };
        requests.push(rec);
        if (klass.role !== "main" || requests.filter((r) => r.role === "main").length > MAX_REQUESTS) { writeMessagesResponse(response, rec.i); return; }
        const ctx: Ctx = { req: parsed, kv, handled };
        const index = st.stepIndex++, out = index < sc.script.length ? sc.script[index]!(ctx) : fallback(ctx);
        rec.step = index; rec.step_ok = out.ok; rec.note = out.note ?? null;
        for (const id of [kv.sid, kv.sidA, kv.sidB]) ord("session", id);
        for (const id of [kv.tid, kv.tidA, kv.tidB]) ord("turn", id);
        if (out.done === true) st.scriptDone = true;
        if ("call" in out.act) {
          rec.scripted = `tool_use:${out.act.call.name.slice(PFX.length)}`; st.toolCalls++;
          const call: SyntheticCall = { id: `toolu_probe_${rec.i}`, name: out.act.call.name, input: out.act.call.input };
          writeMessagesResponse(response, rec.i, call);
        } else writeMessagesResponse(response, rec.i);
      } catch { st.invalid = true; if (!response.headersSent) response.writeHead(400); response.end(); }
    });
    fake.listen(0, "127.0.0.1"); await once(fake, "listening");
    const address = fake.address(); if (!address || typeof address === "string") throw new Error("listener_failed");

    // ---- client: no --settings flag; hooks come from CLAUDE_CONFIG_DIR/settings.json written above
    const tools = ["pi_session_start", "pi_session_prompt", "pi_turn_get", "pi_session_close", "pi_session_get", "pi_session_list", "pi_session_abort", "pi_capabilities_get"].map((t) => `${PFX}${t}`);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, CLAUDE_CONFIG_DIR: configDir, TMPDIR: scratch, CLAUDE_CODE_TMPDIR: scratch, XDG_RUNTIME_DIR: clientEnvForPaths.XDG_RUNTIME_DIR!,
      XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_CACHE_HOME: join(home, ".cache"), XDG_STATE_HOME: join(home, ".local/state"),
      ANTHROPIC_API_KEY: DUMMY_KEY, ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1", ENABLE_TOOL_SEARCH: "false",
    };
    const argv = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-hook-events", "--strict-mcp-config", "--mcp-config", mcpConfig,
      "--allowedTools", tools.join(","), "--model", MODEL, "--no-session-persistence", "--tools", ""];
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
          stream.hook_events.push({ t_ms: rel(), subtype, hook_event: safeLabel(event.hook_event ?? event.hook_event_name), hook_name: safeLabel(event.hook_name),
            outcome: safeLabel(event.outcome), exit_code: typeof event.exit_code === "number" ? event.exit_code : null });
        }
        if (type === "result") stream.results.push({ t_ms: rel(), subtype: safeLabel(event.subtype), is_error: typeof event.is_error === "boolean" ? event.is_error : null, num_turns: typeof event.num_turns === "number" ? event.num_turns : null });
      }
    });
    spawned.stdin!.write(`${JSON.stringify({ type: "user", message: { role: "user", content: `${CANARY_PROMPT} start the scripted worker and wait for its event` } })}\n`);

    // ---- drive until the script is done (plus a settle time that exposes duplicate wakes), always bounded
    const deadline = Date.now() + sc.maxMs;
    let doneAt: number | null = null;
    while (Date.now() < deadline && !st.exited) {
      await sleep(100);
      await pollSpool(clientEnvForPaths, watch, rel, wallStart, ord);
      if (st.scriptDone) { doneAt ??= Date.now(); if (Date.now() - doneAt >= sc.finish.extraMs) break; }
    }
    if (!st.exited && Date.now() >= deadline) timedOut = true;
    if (!st.exited) {
      st.stdinEndedAt = rel(); try { spawned.stdin!.end(); } catch { /* closed */ }
      for (let end = Date.now() + 10_000; !st.exited && Date.now() < end;) { await pollSpool(clientEnvForPaths, watch, rel, wallStart, ord); await sleep(100); }
      if (!st.exited) { timedOut = true; signalGroup(spawned, "SIGTERM"); if (!(await bound(closed, 4000))) { signalGroup(spawned, "SIGKILL"); await bound(closed, 3000); } }
    }
    await pollSpool(clientEnvForPaths, watch, rel, wallStart, ord);
    leftoverAtExit = await processesReferencing(root);
    try { process.kill(-spawned.pid!, 0); groupAliveAfterExit = true; } catch { groupAliveAfterExit = false; }
    leftoverAfterGrace = leftoverAtExit;
    for (const end = Date.now() + 3000; leftoverAfterGrace.length > 0 && Date.now() < end;) { await sleep(150); await pollSpool(clientEnvForPaths, watch, rel, wallStart, ord); leftoverAfterGrace = await processesReferencing(root); }
    for (const p of leftoverAfterGrace) { try { process.kill(p.pid, "SIGKILL"); } catch { /* gone */ } }
    signalGroup(spawned, "SIGKILL");

    // ---- collect (allowlisted fields only)
    setup.settings_after_run = await inspectSettings(settingsFile, sc.hookBudgetMs);
    const events = watch.raw.filter((e): e is Extract<TurnEvent, { kind: "turn_terminal" }> => e.kind === "turn_terminal");
    const wakeReqs = requests.filter((r) => r.wake_kind !== null);
    collected.per_event = events.map((e) => {
      const matching = wakeReqs.filter((r) => r.wake_ref?.kind === "terminal" && r.wake_ref.turn === ord("turn", e.turn));
      const at = Date.parse(e.at) - wallStart;
      return { seq: e.seq, state: e.state, via: e.via, at_ms: at, wakes: matching.length, delay_ms: matching[0] ? matching[0].t_ms - at : null };
    });
    const counters = JSON.parse(await readFile(counterFile, "utf8").catch(() => "null")) as unknown;
    collected.counters = isObject(counters) ? counters : null;
    const eventsDir = eventsRoot(clientEnvForPaths), claimsDir = claimsRoot(clientEnvForPaths);
    const remainingInstances = eventsDir ? (await readdir(eventsDir).catch(() => [] as string[])).filter((n) => n.startsWith("inst-")).length : null;
    const rootStat = eventsDir ? await lstat(eventsDir).catch(() => undefined) : undefined;
    collected.spool = {
      events_root_existed: watch.rootExisted, events_root_mode_0700: watch.rootModeOk, instance_dirs_max: watch.instancesMax, instance_dirs_after_exit: remainingInstances, events_root_present_at_end: rootStat !== undefined,
      claims_dir_seen: watch.claimsDirSeen, claims_max: watch.claimsMax, claims_dir_present_at_end: claimsDir ? (await lstat(claimsDir).catch(() => undefined)) !== undefined : null,
      events: [...watch.seen.values()].sort((a, b) => a.at_ms - b.at_ms || a.seq - b.seq),
    };
  } catch { st.invalid = true; }
  finally {
    if (child) signalGroup(child, "SIGKILL");
    if (fake) { fake.closeAllConnections(); await new Promise<void>((resolve) => fake!.close(() => resolve())); }
    await temp.remove().catch(() => undefined);
    tempRemoved = !(await readdir(root).then(() => true, () => false));
  }

  const main = requests.filter((r) => r.role === "main"), wakeRequests = requests.filter((r) => r.wake_kind !== null);
  const perEvent = (collected.per_event ?? []) as Array<{ wakes: number; delay_ms: number | null; state: string; via: string }>;
  const counters = (collected.counters ?? {}) as { tools?: Record<string, number>; pi_turn_get?: { running: number; terminal: number; error: number }; spool_failures?: number; delivery?: string; spool_opened?: boolean; xdg_runtime_dir_set?: boolean; shutdown?: string };
  const spoolInfo = (collected.spool ?? {}) as Record<string, any>;
  const base = {
    tooling: { client_version: version, node: process.versions.node }, scenario: sc.id, title: sc.title, delivery: sc.delivery, hook_budget_ms: sc.hookBudgetMs, expectation: sc.expect,
    exit_code: st.exitCode, exit_signal: st.exitSignal, timed_out: timedOut, exit_at_ms: st.exitAt, stdin_ended_at_ms: st.stdinEndedAt, harness_invalid: st.invalid, http_unexpected: st.httpUnexpected,
    setup, caps_delivery_seen_by_client: kv.capsDelivery ?? null, read_after_close: kv.readAfterClose ?? null,
    requests: { total: requests.length, main: main.length, auxiliary: requests.length - main.length, list: requests, scripted_tool_calls: st.toolCalls },
    wakes: { requests: wakeRequests.length, by_kind: histogram(wakeRequests.map((r) => String(r.wake_kind))), by_delivery: histogram(wakeRequests.map((r) => String(r.wake_delivery))), kinds_in_order: wakeRequests.map((r) => String(r.wake_kind)),
      missing: perEvent.filter((e) => e.wakes === 0).length, duplicate: perEvent.filter((e) => e.wakes > 1).length, delays_ms: perEvent.map((e) => e.delay_ms) },
    stream, leftover: { at_exit: leftoverAtExit.length, at_exit_kinds: histogram(leftoverAtExit.map((p) => p.kind)), after_grace: leftoverAfterGrace.length, after_grace_kinds: histogram(leftoverAfterGrace.map((p) => p.kind)), group_alive_after_exit: groupAliveAfterExit },
    temp_removed: tempRemoved, step_failures: requests.filter((r) => r.step_ok === false).length,
    ...collected,
  };
  const stepsOk = base.step_failures === 0 && requests.some((r) => r.step !== null) && st.scriptDone;
  const clean = !st.invalid && !timedOut && tempRemoved && leftoverAfterGrace.length === 0 && st.exitCode === 0;
  const checks: Record<string, boolean> = { clean_teardown: clean, mcp_connected: stream.mcp_statuses.length === 1 && stream.mcp_statuses[0] === "connected", steps_ok: stepsOk };
  const setupOk = (key: string, status: string, code: string): boolean => { const v = setup[key] as { status?: string; code?: string } | undefined; return v?.status === status && v?.code === code; };
  const tc = counters.pi_turn_get, wakes = wakeRequests.length, ownWakes = wakeRequests.filter((r) => r.wake_delivery === "own_request").length;
  const settingsAfter = (setup.settings_after_run ?? {}) as Record<string, unknown>, settingsSetup = (setup.settings_after_setup ?? {}) as Record<string, unknown>;
  const hookEntryChecks = (): Record<string, boolean> => ({
    setup_dry_run_planned: setupOk("dry_run", "planned", "hook_add_planned") && setup.dry_run_wrote_nothing === true,
    setup_apply_added: setupOk("apply", "ok", "hook_added"), setup_verify_verified: setupOk("verify", "ok", "hook_verified"), setup_reapply_idempotent: setupOk("reapply", "unchanged", "hook_already_equivalent"),
    settings_entry_exact: settingsSetup.wake_entries === 1 && settingsSetup.matcher_is_product === true && settingsSetup.async_rewake === true && settingsSetup.command_uses_exec_path === true
      && settingsSetup.command_program_is_package_dist === true && settingsSetup.command_budget_matches === true && settingsSetup.timeout_covers_budget === true,
    settings_other_content_preserved: settingsSetup.other_entry_preserved === true && settingsSetup.other_keys_preserved === true && settingsSetup.post_tool_use_entries === 2,
    settings_intact_after_run: settingsAfter.wake_entries === 1 && settingsAfter.other_entry_preserved === true && settingsAfter.other_keys_preserved === true,
  });
  const spoolCommon = (): Record<string, boolean> => ({
    server_spool_open: counters.delivery === "spool" && counters.spool_opened === true, no_spool_failures: counters.spool_failures === 0,
    events_root_private: spoolInfo.events_root_existed === true && spoolInfo.events_root_mode_0700 === true, instance_dir_removed_at_exit: spoolInfo.instance_dirs_after_exit === 0,
    no_missing_or_duplicate: base.wakes.missing === 0 && base.wakes.duplicate === 0, claims_seen: spoolInfo.claims_max >= 1,
  });
  if (sc.id === "P1") Object.assign(checks, hookEntryChecks(), spoolCommon(), {
    caps_report_spool: kv.capsDelivery === "spool", one_wake: wakes === 1, wake_is_terminal_own_request: ownWakes === 1 && wakeRequests[0]?.wake_kind === "terminal",
    wake_names_the_turn: wakeRequests[0]?.wake_ref?.turn === "t1" && wakeRequests[0]?.wake_ref?.state === "completed", one_terminal_read: tc?.terminal === 1 && tc.running === 0 && counters.tools?.pi_turn_get === 1,
    one_completed_spool_event: perEvent.length === 1 && perEvent[0]!.state === "completed" && perEvent[0]!.via === "registry",
  });
  if (sc.id === "P2") Object.assign(checks, hookEntryChecks(), spoolCommon(), {
    caps_report_spool: kv.capsDelivery === "spool", two_wakes: wakes === 2, wakes_are_terminal_own_requests: ownWakes === 2 && wakeRequests.every((r) => r.wake_kind === "terminal"),
    wakes_match_turns_in_order: wakeRequests[0]?.wake_ref?.turn === "t1" && wakeRequests[1]?.wake_ref?.turn === "t2", two_terminal_reads: tc?.terminal === 2 && tc.running === 0,
    two_completed_spool_events: perEvent.length === 2 && perEvent.every((e) => e.state === "completed"),
  });
  if (sc.id === "P3") Object.assign(checks, hookEntryChecks(), spoolCommon(), {
    caps_report_spool: kv.capsDelivery === "spool", budget_then_terminal_wakes: wakeRequests.map((r) => r.wake_kind).join(",") === "budget,terminal", wakes_are_own_requests: ownWakes === 2,
    terminal_wake_is_aborted_turn: wakeRequests[1]?.wake_ref?.turn === "t1" && wakeRequests[1]?.wake_ref?.state === "aborted", one_running_read_one_terminal_read: tc?.running === 1 && tc.terminal === 1 && tc.error === 0,
    one_aborted_spool_event_via_registry: perEvent.length === 1 && perEvent[0]!.state === "aborted" && perEvent[0]!.via === "registry",
    budget_wake_near_budget: (() => { const first = wakeRequests[0], prompt = requests.find((r) => r.scripted === "tool_use:pi_session_prompt"); return !!first && !!prompt && first.t_ms - prompt.t_ms >= 3500 && first.t_ms - prompt.t_ms <= 9000; })(),
  });
  if (sc.id === "P6") Object.assign(checks, hookEntryChecks(), {
    server_spool_open: counters.delivery === "spool" && counters.spool_opened === true, no_spool_failures: counters.spool_failures === 0,
    one_terminal_wake: wakes === 1 && wakeRequests[0]?.wake_kind === "terminal" && wakeRequests[0]?.wake_ref?.state === "aborted",
    one_aborted_spool_event_via_close: perEvent.length === 1 && perEvent[0]!.state === "aborted" && perEvent[0]!.via === "close" && base.wakes.missing === 0 && base.wakes.duplicate === 0,
    read_after_close_labelled: kv.readAfterClose !== undefined,
  });
  if (sc.id === "P4") Object.assign(checks, {
    setup_dry_run_not_enabled: setupOk("dry_run", "unchanged", "hook_not_enabled"), setup_apply_not_enabled: setupOk("apply", "unchanged", "hook_not_enabled"), setup_verify_not_enabled: setupOk("verify", "unchanged", "hook_not_enabled"),
    settings_bytes_unchanged: setup.settings_bytes_unchanged === true && settingsAfter.wake_entries === 0 && settingsAfter.other_entry_preserved === true,
    caps_report_off: kv.capsDelivery === "off", server_spool_not_opened: counters.delivery === "off" && counters.spool_opened === false,
    no_spool_directory: spoolInfo.events_root_existed === false && spoolInfo.events_root_present_at_end === false && spoolInfo.instance_dirs_max === 0 && spoolInfo.claims_dir_seen === false && spoolInfo.claims_dir_present_at_end === false,
    no_wake: wakes === 0 && requests.every((r) => !r.marker_in_fresh), no_turn_read: (counters.tools?.pi_turn_get ?? 0) === 0, worker_was_prompted: (counters.tools?.pi_session_prompt ?? 0) === 1,
  });
  return { row: { ...base, checks, passed_expectation: Object.values(checks).every(Boolean) }, root };
}

// ---------------------------------------------------------------- driver
export interface ProductProbeOptions { out: string; only?: string[] }
export async function runProductProbe(options: ProductProbeOptions): Promise<Record<string, unknown>> {
  if (process.platform !== "linux") throw new Error("unsupported_probe_platform");
  if (!Object.values(networkInterfaces()).flat().every((i) => i?.internal === true)) throw new Error("network_namespace_not_isolated");
  const version = clientVersion();
  if (version === "unavailable") throw new Error("client_unavailable");
  await mkdir(options.out, { recursive: true });
  const wanted = (id: string): boolean => !options.only || options.only.includes(id);
  const started_at = new Date().toISOString(), rows: Array<Record<string, unknown>> = [];
  const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { version?: string };
  const forbiddenGlobal = [DUMMY_KEY, "sk-ant", CANARY_PROMPT, process.execPath, packageRoot, options.out, "/home/", "/tmp/", "claude-config"];
  for (const sc of SCENARIOS) {
    if (!wanted(sc.id)) continue;
    const { row, root } = await runScenario(sc, version);
    let written = row;
    try { assertClean(row, [root, basename(root), ...forbiddenGlobal]); } catch { written = { scenario: sc.id, error: "output_validation_failed", passed_expectation: false }; }
    await writeFile(join(options.out, `${sc.id}.json`), `${JSON.stringify(written, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    rows.push(written);
  }
  const summary = {
    schema_version: "product-probe-1", client_version: version, node: process.versions.node, package_version: pkg.version ?? null, started_at, ended_at: new Date().toISOString(),
    skipped: [] as string[], all_passed: rows.length > 0 && rows.every((r) => r.passed_expectation === true),
    scenarios: rows.map((r) => ({ scenario: r.scenario, passed_expectation: r.passed_expectation, checks: r.checks ?? null, exit_code: r.exit_code ?? null,
      requests: isObject(r.requests) ? r.requests.total : null, wakes: isObject(r.wakes) ? r.wakes.requests : null, wake_kinds: isObject(r.wakes) ? r.wakes.kinds_in_order : null, delays_ms: isObject(r.wakes) ? r.wakes.delays_ms : null,
      server_counters: isObject(r.counters) ? { tools: r.counters.tools, pi_turn_get: r.counters.pi_turn_get, spool_failures: r.counters.spool_failures } : null,
      leftover_after_grace: isObject(r.leftover) ? r.leftover.after_grace : null, temp_removed: r.temp_removed ?? null })),
  };
  assertClean(summary, forbiddenGlobal);
  await writeFile(join(options.out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return summary;
}

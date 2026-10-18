import { createServer, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { access, mkdir, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { gunzipSync, inflateSync } from "node:zlib";
import { sourceBinding, digest, hash, snapshot, ownedTemporary } from "./files.js";
import { runOwnedController } from "./token-live.js";
import { ERROR_MARKER, MARKER, decodedObjects } from "./token-client-projection.js";

// Provider-free Claude Code projection probe on a declared synthetic route:
// a loopback Messages-API fake, a disposable client home, and the existing MCP
// fixture server. The frame proxy is not used: Claude Code 2.1.301 opens MCP
// with a server/discover request that the proxy's strict allowlist treats as a
// fatal frame (preserved in attempt-1; the proxy has since been taught that one
// method, but this probe still launches the fixture server directly). Only sizes,
// counts, booleans, safe labels and hashes leave this module; no body, prompt,
// header or tool data.
// Opt-in non-bare variant: the same probe without `--bare` (which disables tool
// search), in the identical scrubbed environment, normal scenario only.

const CLIENT_VERSION = "2.1.301 (Claude Code)", SERVER_NAME = "pi-projection", MODEL = "claude-sonnet-5-5";
const DUMMY_KEY = "sk-ant-synthetic-loopback-dummy-0000";
const MAX_REQUESTS = 12, BODY_CAP = 4 * 1024 * 1024, RUN_TIMEOUT_MS = 90_000;
export type ClaudeScenario = "normal" | "domain-error";
export type ToolSearchSetting = "false" | "true";
export type ClientMode = "bare" | "non-bare";
type Suffix = "pi_capabilities_get" | "pi_session_start";
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const count = (value: string, needle: string) => value.split(needle).length - 1;
const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "");
const safeLabel = (value: unknown, pattern = /^[a-z0-9_.-]{1,40}$/): string | null => typeof value === "string" && pattern.test(value) ? value : null;
const TOOL_KEYS = ["name", "description", "input_schema", "outputSchema", "output_schema", "defer_loading", "cache_control", "type", "strict", "eager_input_streaming", "input_examples", "allowed_callers"];
const deepHasKey = (value: unknown, pattern: RegExp, depth = 0): boolean => depth <= 24 && (Array.isArray(value) ? value.some(v => deepHasKey(v, pattern, depth + 1))
  : Object.entries(object(value)).some(([key, v]) => pattern.test(key) || deepHasKey(v, pattern, depth + 1)));
const isToolSearch = (tool: Record<string, unknown>) => /^tool_?search/i.test(String(tool.name ?? "")) || /^tool_search/i.test(String(tool.type ?? ""));

export function projectToolsEntry(tools: unknown, suffix: string, schemaMarker: string) {
  const list = (Array.isArray(tools) ? tools : []).map(object), entry = list.find(t => typeof t.name === "string" && t.name.endsWith(suffix));
  const wholeBytes = bytesOf(Array.isArray(tools) ? tools : []);
  const base = { tools_count: list.length, tools_bytes: wholeBytes, defer_loading_count: list.filter(t => t.defer_loading === true).length,
    tool_search_tool_present: list.some(isToolSearch), schema_marker_hits_whole_tools: count(JSON.stringify(tools ?? []), schemaMarker) };
  if (!entry) return { ...base, fixture_present: false as const };
  return { ...base, fixture_present: true as const, fixture: {
    entry_bytes: bytesOf(entry), name_bytes: Buffer.byteLength(String(entry.name)), description_bytes: Buffer.byteLength(typeof entry.description === "string" ? entry.description : ""),
    input_schema_bytes: bytesOf(entry.input_schema ?? null), keys: Object.keys(entry).filter(k => TOOL_KEYS.includes(k)).sort(), other_key_count: Object.keys(entry).filter(k => !TOOL_KEYS.includes(k)).length,
    output_schema_key_present: deepHasKey(entry, /^output_?schema$/i), schema_marker_hits_entry: count(JSON.stringify(entry), schemaMarker), defer_loading: entry.defer_loading === true,
  } };
}

export function projectToolResults(body: unknown, suffix: string) {
  const messages = Array.isArray(object(body).messages) ? object(body).messages as unknown[] : [], names = new Map<string, string>();
  const results: Array<ReturnType<typeof projectToolResult>> = [];
  for (const raw of messages) {
    const content = object(raw).content;
    if (!Array.isArray(content)) continue;
    for (const block of content.map(object)) {
      if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") names.set(block.id, block.name);
      if (block.type === "tool_result") results.push(projectToolResult(block, names, suffix));
    }
  }
  return results;
}
function projectToolResult(block: Record<string, unknown>, names: Map<string, string>, suffix: string) {
  const name = typeof block.tool_use_id === "string" ? names.get(block.tool_use_id) : undefined, content = block.content;
  const texts = Array.isArray(content) ? content.map(object).filter(b => b.type === "text" && typeof b.text === "string").map(b => b.text as string) : typeof content === "string" ? [content] : [];
  const serialized = JSON.stringify(content ?? null) ?? "null";
  return {
    tool: name === undefined ? "unknown" as const : name.endsWith(suffix) ? "fixture" as const : "other" as const, is_error: block.is_error === true,
    content_kind: typeof content === "string" ? "string" as const : Array.isArray(content) ? "array" as const : "absent" as const,
    block_count: Array.isArray(content) ? content.length : 0, text_block_count: texts.length, non_text_block_count: Array.isArray(content) ? content.length - texts.length : 0,
    serialized_bytes: Buffer.byteLength(serialized), marker_hits: count(serialized, MARKER), error_marker_hits: count(serialized, ERROR_MARKER),
    structured_key_present: decodedObjects(content).some(v => Object.hasOwn(v, "structuredContent") || Object.hasOwn(v, "structured_content")),
    equal_text_blocks: texts.length >= 2 && new Set(texts.map(t => hash(t))).size < texts.length,
  };
}

export function classifyRequest(headers: Record<string, string | string[] | undefined>, body: unknown): { role: "main" | "auxiliary"; request_class: string | null; model_matches: boolean } {
  const b = object(body), tools = Array.isArray(b.tools) ? b.tools : [], model_matches = b.model === MODEL;
  const header = headers["x-claude-code-request-class"], request_class = safeLabel(Array.isArray(header) ? header[0] : header);
  const role = request_class !== null ? (request_class === "main" || request_class === "repl_main_thread" ? "main" : "auxiliary") : model_matches && tools.length > 0 ? "main" : "auxiliary";
  return { role, request_class, model_matches };
}

export interface SyntheticCall { id: string; name: string; input: Record<string, unknown> }
/** Documented Messages streaming sequence; text turn when no call is given. */
export function messagesSseEvents(index: number, call?: SyntheticCall): Array<{ event: string; data: Record<string, unknown> }> {
  const usage = { input_tokens: 0, output_tokens: 0 };
  const events: Array<{ event: string; data: Record<string, unknown> }> = [{ event: "message_start", data: { type: "message_start", message: { id: `msg_fixture_${index}`, type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage } } }];
  if (call) {
    events.push({ event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: call.id, name: call.name, input: {} } } });
    events.push({ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } } });
    events.push({ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } });
    events.push({ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 0 } } });
  } else {
    events.push({ event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
    events.push({ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Synthetic calibration finished." } } });
    events.push({ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } });
    events.push({ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } } });
  }
  events.push({ event: "message_stop", data: { type: "message_stop" } });
  return events;
}
export function writeMessagesResponse(response: ServerResponse, index: number, call?: SyntheticCall) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const { event, data } of messagesSseEvents(index, call)) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  response.end();
}

export interface FakeRequestMetric {
  path: "messages" | "messages_beta"; wire_bytes: number; body_bytes: number; role: "main" | "auxiliary"; request_class: string | null; model_matches: boolean;
  messages_count: number; system_bytes: number; stream: boolean; max_tokens_present: boolean; tool_results: ReturnType<typeof projectToolResults>;
  projection: ReturnType<typeof projectToolsEntry>; credential_header_present: boolean; credential_matches_dummy: boolean; authorization_header_present: boolean; beta_header_present: boolean;
  scripted_response: "tool_use" | "tool_search" | "text";
}
export interface FakeMessagesOptions { suffix: Suffix; args: Record<string, unknown>; schemaMarker: string; maxRequests?: number; bodyCap?: number }
/** Loopback Messages fake. 404 for count_tokens and HEAD /api/hello; other routes are counted as unexpected. */
export function createFakeMessagesServer(options: FakeMessagesOptions) {
  const state = { requests: [] as FakeRequestMetric[], auxiliary_http: { count_tokens: 0, hello_head: 0, unexpected: 0 }, invalid: false };
  const cap = options.maxRequests ?? MAX_REQUESTS, bodyCap = options.bodyCap ?? BODY_CAP;
  let toolCalled = false, searched = false, callOrdinal = 0;
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1"), method = request.method ?? "";
    if (method === "HEAD" && url.pathname === "/api/hello") { state.auxiliary_http.hello_head++; response.writeHead(404); response.end(); return; }
    if (method === "POST" && url.pathname === "/v1/messages/count_tokens") { state.auxiliary_http.count_tokens++; request.resume(); response.writeHead(404); response.end(); return; }
    if (method !== "POST" || url.pathname !== "/v1/messages" || state.requests.length >= cap) { state.auxiliary_http.unexpected++; if (method === "POST") state.invalid = true; request.resume(); response.writeHead(method === "POST" ? 400 : 404); response.end(); return; }
    const chunks: Buffer[] = []; let wire = 0;
    try {
      for await (const chunk of request) { wire += Buffer.byteLength(chunk); if (wire > bodyCap) { state.invalid = true; response.writeHead(413); response.end(); return; } chunks.push(Buffer.from(chunk)); }
      let raw = Buffer.concat(chunks);
      const encoding = String(request.headers["content-encoding"] ?? "identity");
      // The cap applies to the decoded body too, so a small compressed body cannot expand without bound.
      if (encoding === "gzip") raw = gunzipSync(raw, { maxOutputLength: bodyCap }); else if (encoding === "deflate") raw = inflateSync(raw, { maxOutputLength: bodyCap }); else if (encoding !== "identity") throw new Error("unsupported_encoding");
      const body = JSON.parse(raw.toString("utf8")) as unknown, b = object(body), klass = classifyRequest(request.headers, body);
      const key = request.headers["x-api-key"], projection = projectToolsEntry(b.tools, options.suffix, options.schemaMarker);
      const metric: FakeRequestMetric = { path: url.searchParams.get("beta") === "true" ? "messages_beta" : "messages", wire_bytes: wire, body_bytes: raw.length, ...klass,
        messages_count: Array.isArray(b.messages) ? b.messages.length : 0, system_bytes: bytesOf(b.system ?? null), stream: b.stream === true, max_tokens_present: typeof b.max_tokens === "number",
        tool_results: projectToolResults(body, options.suffix), projection, credential_header_present: key !== undefined, credential_matches_dummy: key === DUMMY_KEY,
        authorization_header_present: request.headers.authorization !== undefined, beta_header_present: request.headers["anthropic-beta"] !== undefined, scripted_response: "text" };
      state.requests.push(metric);
      if (klass.role !== "main") { writeMessagesResponse(response, state.requests.length); return; }
      const tools = (Array.isArray(b.tools) ? b.tools : []).map(object), target = tools.find(t => typeof t.name === "string" && t.name.endsWith(options.suffix));
      if (!toolCalled && target) {
        toolCalled = true; metric.scripted_response = "tool_use";
        writeMessagesResponse(response, state.requests.length, { id: `toolu_fixture_${++callOrdinal}`, name: String(target.name), input: options.args });
        return;
      }
      const search = tools.find(isToolSearch);
      if (!toolCalled && !searched && search) {
        searched = true; metric.scripted_response = "tool_search";
        writeMessagesResponse(response, state.requests.length, { id: `toolu_fixture_${++callOrdinal}`, name: String(search.name), input: { query: `select:mcp__${SERVER_NAME}__${options.suffix}`, max_results: 1 } });
        return;
      }
      writeMessagesResponse(response, state.requests.length);
    } catch { state.invalid = true; if (!response.headersSent) response.writeHead(400); response.end(); }
  });
  return { server, state };
}

/** Own-user processes whose command line or environment still mention the owned temporary root. */
async function processesReferencing(root: string): Promise<number[]> {
  const found: number[] = [];
  for (const name of (await readdir("/proc")).filter(value => /^\d+$/.test(value))) {
    if (Number(name) === process.pid) continue;
    for (const file of ["cmdline", "environ"]) {
      const text = await readFile(`/proc/${name}/${file}`, "latin1").catch(() => "");
      if (text.includes(root)) { found.push(Number(name)); break; }
    }
  }
  return found;
}

const hexLoopback = (address: string) => /^[0-9A-F]{8}$/i.test(address) ? address.slice(6, 8) === "7F"
  : /^[0-9A-F]{32}$/i.test(address) ? address === "00000000000000000000000001000000" || (address.toUpperCase().startsWith("0000000000000000FFFF0000") && address.slice(30, 32).toUpperCase() === "7F") : false;
const hexUnspecified = (address: string) => /^0+$/.test(address);
/** Counts connected sockets (tcp/udp, v4/v6) of the given inodes by remote address class; remote addresses are never kept. */
export function classifySockets(table: string, inodes: ReadonlySet<string>): { loopback: number; non_loopback: number } {
  const out = { loopback: 0, non_loopback: 0 };
  for (const row of table.split("\n").slice(1)) {
    const cols = row.trim().split(/\s+/);
    if (cols.length < 10 || !inodes.has(cols[9]!)) continue;
    const remote = (cols[2] ?? "").split(":")[0] ?? "";
    if (hexUnspecified(remote)) continue;
    if (hexLoopback(remote)) out.loopback++; else out.non_loopback++;
  }
  return out;
}
async function socketInodes(pids: number[]): Promise<Set<string>> {
  const inodes = new Set<string>();
  for (const pid of pids) for (const fd of await readdir(`/proc/${pid}/fd`).catch(() => [] as string[])) {
    const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => "");
    const match = /^socket:\[(\d+)\]$/.exec(target);
    if (match) inodes.add(match[1]!);
  }
  return inodes;
}
/** Samples the sockets of every process that references the owned root; a sample can miss short-lived sockets. */
function startSocketSampler(root: string) {
  const seen = { samples: 0, loopback_connections_seen: 0, non_loopback_connections_seen: 0 };
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      try {
        const inodes = await socketInodes(await processesReferencing(root));
        if (inodes.size > 0) for (const table of ["tcp", "tcp6", "udp", "udp6"]) {
          const c = classifySockets(await readFile(`/proc/net/${table}`, "utf8").catch(() => ""), inodes);
          seen.loopback_connections_seen += c.loopback; seen.non_loopback_connections_seen += c.non_loopback;
        }
        seen.samples++;
      } catch { /* a failed sample is simply not counted */ }
      await new Promise(resolve => setTimeout(resolve, 60));
    }
  })();
  return { stop: async () => { stopped = true; await loop; return seen; } };
}
async function countFiles(dir: string): Promise<number> {
  let n = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) n += entry.isDirectory() ? await countFiles(join(dir, entry.name)) : 1;
  return n;
}

type Row = Awaited<ReturnType<typeof runClaudeCase>>;
const suffixFor = (scenario: ClaudeScenario): Suffix => scenario === "normal" ? "pi_capabilities_get" : "pi_session_start";

async function runClaudeCase(build: string, scenario: ClaudeScenario, toolSearch: ToolSearchSetting, repetition: number, pilot: boolean, mode: ClientMode = "bare") {
  const temp = await ownedTemporary(), home = join(temp.root, "home"), configDir = join(home, "claude-config"), workspace = join(temp.root, "workspace");
  const scratch = join(temp.root, "tmp"), suffix = suffixFor(scenario);
  const args = suffix === "pi_session_start" ? { workspace: "missing_probe", executionProfile: "fixture" } : {};
  const fake = createFakeMessagesServer({ suffix, args, schemaMarker: scenario === "normal" ? "reloadPolicy" : "createdAt" });
  const stream = { lines: 0, json_errors: 0, event_types: {} as Record<string, number>, result_subtype: null as string | null, result_is_error: null as boolean | null, num_turns: null as number | null, mcp_statuses: [] as string[] };
  let exit_code: number | null = null, timed_out = false, process_cleanup = false, stdout_bytes = 0, line_integrity = false;
  let duration_ms = 0, invalid = false, temp_removed = false, leftover_processes = -1;
  let sockets: { samples: number; loopback_connections_seen: number; non_loopback_connections_seen: number } | null = null, config_dir_files = -1, home_files = -1;
  try {
    for (const dir of [configDir, workspace, scratch, join(home, ".config"), join(home, ".local/share"), join(home, ".cache"), join(home, ".local/state")]) await mkdir(dir, { recursive: true });
    const config = join(temp.root, "config.json"), mcpConfig = join(temp.root, "mcp.json");
    await writeFile(config, JSON.stringify({ workspace }), { mode: 0o600 });
    await writeFile(mcpConfig, JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: process.execPath, args: [join(build, "eval/profiles/token-projection-server.js")], env: { PI_SESSION_MCP_CONFIG: config } } } }), { mode: 0o600 });
    fake.server.listen(0, "127.0.0.1"); await once(fake.server, "listening");
    const address = fake.server.address(); if (!address || typeof address === "string") throw new Error("listener_failed");
    // Environment is built from scratch: nothing inherited except PATH.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, CLAUDE_CONFIG_DIR: configDir, TMPDIR: scratch, CLAUDE_CODE_TMPDIR: scratch,
      XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_CACHE_HOME: join(home, ".cache"), XDG_STATE_HOME: join(home, ".local/state"),
      ANTHROPIC_API_KEY: DUMMY_KEY, ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1", ENABLE_TOOL_SEARCH: toolSearch,
    };
    const tool = `mcp__${SERVER_NAME}__${suffix}`;
    const argv = [...mode === "bare" ? ["--bare"] : [], "-p", "--strict-mcp-config", "--mcp-config", mcpConfig, "--output-format", "stream-json", "--verbose", "--model", MODEL, "--allowedTools", tool, "--no-session-persistence", "--max-turns", "3",
      "This is a deterministic local client calibration. Call the one allowed MCP tool once, then answer briefly."];
    const began = performance.now();
    const sampler = mode === "non-bare" ? startSocketSampler(temp.root) : null;
    const result = await runOwnedController("claude", argv, { cwd: workspace, env }, "", RUN_TIMEOUT_MS, line => {
      stream.lines++;
      try {
        const event = object(JSON.parse(line.toString("utf8"))), type = safeLabel(event.type);
        if (type) stream.event_types[type] = (stream.event_types[type] ?? 0) + 1;
        if (event.type === "system" && event.subtype === "init" && Array.isArray(event.mcp_servers)) stream.mcp_statuses = event.mcp_servers.map(s => safeLabel(object(s).status) ?? "other");
        if (event.type === "result") { stream.result_subtype = safeLabel(event.subtype); stream.result_is_error = typeof event.is_error === "boolean" ? event.is_error : null; stream.num_turns = typeof event.num_turns === "number" ? event.num_turns : null; }
      } catch { stream.json_errors++; }
    });
    duration_ms = performance.now() - began;
    sockets = sampler ? await sampler.stop() : null;
    if (mode === "non-bare") { config_dir_files = await countFiles(configDir); home_files = await countFiles(home); }
    const r = result as unknown as Record<string, unknown>;
    exit_code = typeof r.exit_code === "number" ? r.exit_code : null; timed_out = r.timed_out === true; process_cleanup = r.process_group_cleanup_observed === true;
    stdout_bytes = typeof r.stdout_bytes === "number" ? r.stdout_bytes : 0; line_integrity = r.line_integrity_passed === true;
    let leftovers: number[] = [];
    for (const deadline = Date.now() + 3000; (leftovers = await processesReferencing(temp.root)).length > 0 && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 100));
    // A leftover fails the case; it is still terminated before its temporary root is removed.
    leftover_processes = leftovers.length;
    for (const pid of leftovers) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  } catch { invalid = true; }
  finally {
    fake.server.closeAllConnections(); await new Promise<void>(resolve => fake.server.close(() => resolve()));
    await temp.remove();
    temp_removed = await access(temp.root).then(() => false, () => true);
  }
  const requests = fake.state.requests, main = requests.filter(r => r.role === "main"), first = main[0] ?? null;
  const post = main.find(r => r.tool_results.some(t => t.tool === "fixture")) ?? null, fixtureResult = post?.tool_results.find(t => t.tool === "fixture") ?? null;
  const tool_calls_scripted = requests.filter(r => r.scripted_response === "tool_use").length;
  const technical = !invalid && !fake.state.invalid && exit_code === 0 && !timed_out && process_cleanup && line_integrity && leftover_processes === 0 && tool_calls_scripted === 1
    && temp_removed && requests.length > 0 && requests.every(r => r.credential_matches_dummy && !r.authorization_header_present) && fixtureResult !== null && stream.result_is_error === false;
  // Isolation facts only: every request reached the loopback fake with the dummy key and no Authorization header.
  const isolation_ok = !invalid && !fake.state.invalid && requests.length > 0 && requests.every(r => r.credential_matches_dummy && !r.authorization_header_present)
    && fake.state.auxiliary_http.unexpected === 0 && process_cleanup && leftover_processes === 0 && temp_removed && (sockets === null || sockets.non_loopback_connections_seen === 0);
  return { scenario, tool_search: toolSearch, repetition, pilot, client_mode: mode, exit_code, timed_out, process_cleanup, line_integrity, leftover_processes, temp_removed, stdout_bytes, duration_ms, stream,
    tool_calls_scripted, request_count: requests.length, main_request_count: main.length, auxiliary_request_count: requests.length - main.length, auxiliary_http: fake.state.auxiliary_http,
    sockets, config_dir_files, home_files, isolation_ok,
    requests, first_main_request_index: first ? requests.indexOf(first) : null, post_tool_request_index: post ? requests.indexOf(post) : null, fake_invalid: fake.state.invalid, invalid, passed: technical };
}

/** Declared test-only route; no external provider/auth and no semantic token usage. */
export async function measureClaudeProjection(root: string, build: string, output: string, options: { mode?: ClientMode } = {}) {
  const mode: ClientMode = options.mode ?? "bare";
  // The leftover-process check scans /proc; without it cleanup cannot be shown, so other platforms are refused up front.
  if (process.platform !== "linux") throw new Error("unsupported_probe_platform");
  const binding = await sourceBinding(root), started_at = new Date().toISOString();
  const buildBinding = async () => digest([await snapshot(join(build, "src")), await snapshot(join(build, "eval/profiles")), hash(await readFile(join(build, "package.json")).catch(() => Buffer.alloc(0)))]);
  const build_digest = await buildBinding();
  const versionHome = await ownedTemporary();
  let version: string;
  try {
    const out = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: versionHome.root, CLAUDE_CONFIG_DIR: join(versionHome.root, "c"), DISABLE_AUTOUPDATER: "1" } });
    version = out.status === 0 ? out.stdout.trim() : "unavailable";
  } finally { await versionHome.remove(); }
  if (version !== CLIENT_VERSION) throw new Error("unsupported_fixture_client");
  // One pilot; the bounded repetitions run only after it passed. The non-bare pilot gates on isolation facts
  // (it sets tool search on, the setting under test) so that a non-passing tool-search flow is still measured.
  const rows: Row[] = [await runClaudeCase(build, "normal", mode === "bare" ? "false" : "true", 0, true, mode)];
  const variants: Array<[ClaudeScenario, ToolSearchSetting]> = mode === "bare" ? [["normal", "false"], ["normal", "true"], ["domain-error", "false"]] : [["normal", "false"], ["normal", "true"]];
  if (mode === "bare" ? rows[0]!.passed : rows[0]!.isolation_ok && rows[0]!.exit_code === 0) for (const [scenario, toolSearch] of variants) for (let repetition = 1; repetition <= 3; repetition++) rows.push(await runClaudeCase(build, scenario, toolSearch, repetition, false, mode));
  const source_unchanged = digest(binding) === digest(await sourceBinding(root));
  const build_unchanged = build_digest === await buildBinding();
  const summarize = (row: Row) => {
    const first = row.first_main_request_index === null ? null : row.requests[row.first_main_request_index]!, post = row.post_tool_request_index === null ? null : row.requests[row.post_tool_request_index]!;
    const result = post?.tool_results.find(t => t.tool === "fixture") ?? null, p = first?.projection;
    return { scenario: row.scenario, tool_search: row.tool_search, repetition: row.repetition, pilot: row.pilot, client_mode: row.client_mode, technical_pass: row.passed, isolation_ok: row.isolation_ok,
      q1: p && p.fixture_present ? { fixture_tool_present: true, output_schema_key_present: p.fixture.output_schema_key_present, schema_marker_hits_entry: p.fixture.schema_marker_hits_entry,
        schema_marker_hits_whole_tools: p.schema_marker_hits_whole_tools, name_bytes: p.fixture.name_bytes, description_bytes: p.fixture.description_bytes, input_schema_bytes: p.fixture.input_schema_bytes, entry_bytes: p.fixture.entry_bytes, keys: p.fixture.keys, other_key_count: p.fixture.other_key_count }
        : { fixture_tool_present: false },
      q2: result ? { marker_hits: result.marker_hits, error_marker_hits: result.error_marker_hits, is_error: result.is_error, content_kind: result.content_kind, block_count: result.block_count, text_block_count: result.text_block_count,
        serialized_bytes: result.serialized_bytes, structured_key_present: result.structured_key_present, equal_text_blocks: result.equal_text_blocks, server_representations: "content_text_equals_structured_json_by_fixture_construction" } : null,
      q3: first ? { first_request_body_bytes: first.body_bytes, tools_count: first.projection.tools_count, tools_bytes: first.projection.tools_bytes, defer_loading_count: first.projection.defer_loading_count,
        tool_search_tool_present: first.projection.tool_search_tool_present, fixture_in_first_tools: first.projection.fixture_present, fixture_defer_loading: p && p.fixture_present ? p.fixture.defer_loading : null } : null,
      requests: { total: row.request_count, main: row.main_request_count, auxiliary: row.auxiliary_request_count, classes: row.requests.map(r => r.request_class), paths: row.requests.map(r => r.path), scripted: row.requests.map(r => r.scripted_response),
        any_authorization_header: row.requests.some(r => r.authorization_header_present), all_dummy_key: row.requests.every(r => r.credential_matches_dummy), count_tokens: row.auxiliary_http.count_tokens, hello_head: row.auxiliary_http.hello_head, unexpected_http: row.auxiliary_http.unexpected },
      isolation: { socket_samples: row.sockets?.samples ?? null, loopback_connections_seen: row.sockets?.loopback_connections_seen ?? null, non_loopback_connections_seen: row.sockets?.non_loopback_connections_seen ?? null, config_dir_files: mode === "non-bare" ? row.config_dir_files : null, home_files: mode === "non-bare" ? row.home_files : null } };
  };
  const result = { schema_version: "token-claude-projection-1", binding, build_digest, node: process.versions.node, fixture_digest: hash(await readFile(join(build, "eval/profiles/token-projection-server.js"))),
    route: "synthetic-loopback-messages", authentication: "fixed-dummy-api-key-disposable-client-home", client_version: CLIENT_VERSION, client_mode: mode, started_at, ended_at: new Date().toISOString(),
    source_unchanged, build_unchanged, rows, summaries: rows.map(summarize), model_usage: null, money: null, real_cloud_projection: null, os_egress_containment: null,
    metric_semantics: { bytes: "direct-observation-of-serialized-utf8", marker_hits: "occurrences-in-tool_result-content-serialization", request_bytes: "whole-http-json-body-not-token-usage", model_usage: "unknown-no-model-executed", money: "unknown-no-meter-or-tariff", tool_search: "ENABLE_TOOL_SEARCH-env-forced-on-synthetic-route" },
    harness_status: rows.length === (mode === "bare" ? 10 : 7) && rows.every(r => r.passed) && source_unchanged && build_unchanged ? "PASS" : "INCONCLUSIVE" };
  await writeFile(join(output, "claude-projection.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return result;
}

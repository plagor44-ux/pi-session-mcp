import { readFile, writeFile, appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
const scenario = JSON.parse(await readFile(process.argv[2], "utf8"));
let lease;
if (scenario.lease) {
  const { acquireWriterLease } = await import("../../dist/writer-lease.js");
  try { lease = await acquireWriterLease(scenario.home, scenario.name, { waitMs: 0 }); }
  catch (error) { scenario.refuse = error.code; }
}
const metadata = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
const id = randomUUID(), turnId = randomUUID();
const session = { id, workspace: "repo", executionProfile: "code", profile: "coding", provider: "p", model: "m", thinkingLevel: "off", state: "idle", createdAt: "0", updatedAt: "0" };
let polls = 0, aborted = false;
const running = () => ({ turnId, sessionId: id, startedAt: "0", updatedAt: scenario.activity ? String(Math.floor(polls / 2)) : "0", state: "running" });
const completed = () => ({ ...running(), state: "completed", completedAt: "1", assistantText: scenario.oversized ? "x".repeat(600000) : "done", truncated: !!scenario.truncated, ...(scenario.missingCompletion ? {} : { completion: scenario.completion ?? "stop" }) });
// `history: "noTool"` models an inner server that predates `pi_history_read`.
const tools = ["pi_capabilities_get", "pi_session_start", "pi_session_prompt", "pi_turn_get", "pi_session_abort", "pi_session_close", ...(scenario.history === "noTool" ? [] : ["pi_history_read"])].map(name => ({ name, inputSchema: { type: "object" } }));
// The real server's input schemas are strict; reject what it would reject.
const required = { pi_session_start: ["workspace", "executionProfile"], pi_session_prompt: ["sessionId", "prompt"], pi_turn_get: ["sessionId", "turnId"], pi_session_abort: ["sessionId"], pi_session_close: ["sessionId"], pi_history_read: ["sessionId"] };
const historyEntries = [1, 2].map(n => ({ type: "message", id: `e${n}`, parentId: n === 1 ? null : "e1", timestamp: "2026-11-04T10:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text: scenario.history === "oversized" ? "x".repeat(600000) : `entry ${n}` }] } }));
function historyPage(cursor) {
  if (scenario.history === "malformed") return { ok: true, sessionId: id, entries: "nope", next: 0, more: false };
  const header = { type: "session", version: 3, id: "pi-inner", timestamp: "2026-11-04T10:00:00.000Z", cwd: "/workspace" };
  // `history: "cut"` models an inner server that had to truncate the second entry to fit its page.
  const cut = scenario.history === "cut" && cursor <= 1 ? { truncated: [1 - cursor] } : {};
  return { ok: true, sessionId: scenario.history === "mismatch" ? randomUUID() : id, ...(cursor === 0 ? { header } : {}), entries: historyEntries.slice(cursor), ...cut, next: historyEntries.length, more: false };
}
async function call(name, args = {}) {
  if (scenario.log) await appendFile(scenario.log, name + "\n");
  if ((required[name] ?? []).some((key) => typeof args[key] !== "string") || (args.sessionId !== undefined && args.sessionId !== id) || (args.turnId !== undefined && args.turnId !== turnId)) return { ok: false, error: { code: "invalid_arguments", message: "Refused" } };
  if (scenario.refuse) return { ok: false, error: { code: scenario.refuse, message: "Refused" } };
  if (name === "pi_capabilities_get") return { ok: true, server: { name: metadata.name, version: metadata.version }, configuration: { fingerprint: "sha256:" + "a".repeat(64), reloadPolicy: "restart-required" }, events: { delivery: "off" }, history: { enabled: false }, workspaces: [{ alias: "repo", mode: "host" }], executionProfiles: scenario.missingProfile ? [] : [{ alias: "code", default: true, permissionProfile: "coding", provider: "p", model: scenario.drift ? "other" : "m", thinkingLevel: "off", extensions: [], grantedExtensionTools: [], shell: "none", skills: [], maxTurnSeconds: null, ...(scenario.profile ?? {}) }] };
  if (name === "pi_session_start") {
    if (scenario.uncollected) return { ok: false, error: { code: "writer_uncollected", message: "Refused" } };
    if (scenario.moveState) { const state = JSON.parse(await readFile(scenario.moveState, "utf8")); state.base.ref = "refs/heads/other"; await writeFile(scenario.moveState, JSON.stringify(state)); }
    if (scenario.exitIdle) setTimeout(() => process.exit(0), 100);
    return { ok: true, session };
  }
  if (name === "pi_session_close" && scenario.slowClose) await new Promise(resolve => setTimeout(resolve, scenario.slowClose));
  if (name === "pi_session_prompt") {
    if (scenario.promptError) return { ok: false, error: { code: scenario.promptError === true ? "prompt_rejected" : scenario.promptError, message: "Refused" } };
    if (scenario.slowPrompt) await new Promise(resolve => setTimeout(resolve, scenario.slowPrompt));
    if (scenario.exitMidTurn) setTimeout(() => process.exit(0), 20);
    return { ok: true, session: { ...session, state: "running" }, turn: running() };
  }
  if (name === "pi_turn_get") {
    polls++;
    if (scenario.invalid) return { ok: true, turn: { state: "completed" } };
    return { ok: true, turn: aborted ? (scenario.completeDuringAbort ? completed() : { ...running(), state: "aborted", completedAt: "1" }) : (polls >= (scenario.polls ?? 1) ? completed() : running()) };
  }
  // `history: "slow"` answers after the host's local read timeout has passed.
  if (name === "pi_history_read" && scenario.history === "slow") await new Promise(done => setTimeout(done, 300));
  if (name === "pi_history_read") return typeof args.cursor === "number" ? historyPage(args.cursor) : { ok: false, error: { code: "invalid_arguments", message: "Refused" } };
  if (name === "pi_session_abort") aborted = true;
  return { ok: true, session };
}
const input = createInterface({ input: process.stdin });
input.on("line", async line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === "initialize") result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } };
  else if (request.method === "tools/list") result = { tools };
  else if (request.method === "tools/call") result = { content: [], structuredContent: await call(request.params.name, request.params.arguments) };
  else result = {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
});
input.on("close", async () => { await lease?.release(); process.exit(0); });

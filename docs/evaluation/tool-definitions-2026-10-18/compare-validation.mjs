// Drives the built server (dist/server.js) in memory with a counting fake adapter and records the exact JSON-RPC
// response of 156 input cases (26 values x 6 UUID fields) plus whether any call touched session state.
// usage: node compare-validation.mjs <checkoutRoot-with-dist-and-node_modules> <out.json>
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const root = process.argv[2], out = process.argv[3];
const { createServer } = await import(pathToFileURL(join(root, "dist/server.js")).href);
const { SessionRegistry } = await import(pathToFileURL(join(root, "dist/session-registry.js")).href);
const { InMemoryTransport } = await import(pathToFileURL(join(root, "node_modules/@modelcontextprotocol/client/dist/index.mjs")).href);
const calls = [];
const adapter = { async create(input) { calls.push("create"); return {
  sdkSessionId: "fake", appliedSelection: { provider: "p", model: "m", thinkingLevel: "off" },
  prompt(_t, preflight) { calls.push("prompt"); preflight(true); return new Promise(() => {}); },
  async abort() { calls.push("abort"); }, dispose() { calls.push("dispose"); } }; } };
const workspaces = new Map([["repo", "/safe/repo"]]);
const profile = { alias: "safe", default: true, permissionProfile: "read-only", provider: "p", model: "m", thinkingLevel: "off" };
const registry = new SessionRegistry(adapter, workspaces, {});
const server = createServer(registry, workspaces, new Map([["safe", profile]]), "safe", { fingerprint: "sha256:" + "0".repeat(64), reloadPolicy: "restart-required" });
const [ct, st] = InMemoryTransport.createLinkedPair();
const inbox = []; ct.onmessage = m => inbox.push(m);
await server.connect(st); await ct.start();
let id = 0;
const rpc = async (method, params) => { const n = ++id; await ct.send({ jsonrpc: "2.0", id: n, method, params }); for (let i = 0; i < 500 && !inbox.find(m => m.id === n); i++) await new Promise(r => setTimeout(r, 2)); return JSON.stringify(inbox.find(m => m.id === n)); };
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } });
await ct.send({ jsonrpc: "2.0", method: "notifications/initialized" });
const call = (name, args) => rpc("tools/call", { name, arguments: args });
// one live session + running turn so that side effects would be visible
const started = JSON.parse(JSON.parse(await call("pi_session_start", { workspace: "repo" })).result.content[0].text);
const sid = started.session.id;
const prompted = JSON.parse(JSON.parse(await call("pi_session_prompt", { sessionId: sid, prompt: "x" })).result.content[0].text);
const tid = prompted.turn.turnId;
const res = async (n, a) => JSON.stringify(JSON.parse(await call(n, a)).result);
const snapshot = async () => ({ list: await res("pi_session_list", {}), turn: await res("pi_turn_get", { sessionId: sid, turnId: tid }), session: await res("pi_session_get", { sessionId: sid }), calls: calls.length });
const normalize = s => s.replaceAll(sid, "<SID>").replaceAll(tid, "<TID>").replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<TS>");
const unknownA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", unknownB = "bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb";
const values = [
  ["unknown valid v4", unknownA], ["unknown valid v8 variant b", unknownB], ["nil", "00000000-0000-0000-0000-000000000000"],
  ["max", "ffffffff-ffff-ffff-ffff-ffffffffffff"], ["uppercase unknown", unknownA.toUpperCase()],
  ["mixed case unknown", "AAAAAAAA-aaaa-4AAA-8aaa-aaaaaaaaaaaa"], ["version nibble 0", "aaaaaaaa-aaaa-0aaa-8aaa-aaaaaaaaaaaa"],
  ["version nibble 9", "aaaaaaaa-aaaa-9aaa-8aaa-aaaaaaaaaaaa"], ["variant nibble 7", "aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa"],
  ["variant nibble c", "aaaaaaaa-aaaa-4aaa-caaa-aaaaaaaaaaaa"], ["too short", unknownA.slice(0, -1)], ["too long", unknownA + "a"],
  ["no hyphens", unknownA.replaceAll("-", "")], ["braces", "{" + unknownA + "}"], ["non-hex", "gggggggg-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
  ["leading space", " " + unknownA], ["trailing newline", unknownA + "\n"], ["empty", ""], ["plain text", "not-a-uuid"],
  ["number", 1], ["null", null], ["boolean", true], ["object", {}], ["array", [unknownA]],
  ["missing", undefined], ["nil-like upper", "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"],
];
const fields = [["pi_session_get", "sessionId"], ["pi_session_prompt", "sessionId"], ["pi_session_abort", "sessionId"], ["pi_session_close", "sessionId"], ["pi_turn_get", "sessionId"], ["pi_turn_get", "turnId"]];
const results = []; let sideEffects = 0;
for (const [tool, field] of fields) for (const [label, value] of values) {
  const args = { sessionId: field === "turnId" ? sid : unknownA, turnId: unknownB, prompt: "p" };
  if (tool !== "pi_session_prompt") delete args.prompt;
  if (tool !== "pi_turn_get") delete args.turnId;
  if (value === undefined) delete args[field]; else args[field] = value;
  const before = await snapshot(); const response = await call(tool, args); const after = await snapshot();
  const touched = JSON.stringify(before) !== JSON.stringify(after); if (touched) sideEffects++;
  results.push({ tool, field, label, args: normalize(JSON.stringify(args)), response: normalize(response), sideEffect: touched });
}
// valid known ids still work (read paths only; no close/abort of the live session before the end)
const known = [await call("pi_session_get", { sessionId: sid }), await call("pi_turn_get", { sessionId: sid, turnId: tid })].map(normalize);
const toolsList = await rpc("tools/list", {});
writeFileSync(out, JSON.stringify({ results, known, sideEffects, toolsList: JSON.parse(toolsList).result.tools.map(t => ({ name: t.name, inputSchema: t.inputSchema, outputSchema: t.outputSchema, annotations: t.annotations })) }, null, 1));
console.log(JSON.stringify({ cases: results.length, sideEffects, adapterCalls: calls.length }));
await registry.shutdown(); process.exit(0);

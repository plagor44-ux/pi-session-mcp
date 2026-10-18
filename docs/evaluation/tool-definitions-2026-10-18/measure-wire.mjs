// Measures tools/list wire bytes and the eight pi tool definitions of a BUILT checkout (dist/main.js).
// usage: node measure-wire.mjs <checkoutRoot> <outJson>
// Provider-free: the server never starts a Pi session; the configuration lives in a disposable temporary directory.
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = process.argv[2], out = process.argv[3];
const temp = mkdtempSync(join(tmpdir(), "tool-definitions-"));
const dir = join(temp, "ws"); mkdirSync(dir);
const cfg = join(temp, "config.json");
writeFileSync(cfg, JSON.stringify({ workspaces: { project: dir }, executionProfiles: { ro: { default: true, permissionProfile: "read-only", provider: "example-provider", model: "example-model", thinkingLevel: "low", skills: [] } } }));
const child = spawn(process.execPath, [join(root, "dist/main.js")], { env: { PATH: process.env.PATH, PI_SESSION_MCP_CONFIG: cfg }, stdio: ["pipe", "pipe", "inherit"] });
let buf = Buffer.alloc(0); const frames = [];
child.stdout.on("data", d => { buf = Buffer.concat([buf, d]); let i; while ((i = buf.indexOf(10)) >= 0) { frames.push(buf.subarray(0, i + 1)); buf = buf.subarray(i + 1); } });
const send = m => child.stdin.write(JSON.stringify(m) + "\n");
const wait = async n => { while (frames.length < n) await new Promise(r => setTimeout(r, 20)); };
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "m", version: "1" } } });
await wait(1);
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
await wait(2);
child.stdin.end();
const frame = frames[1]; const tools = JSON.parse(frame.toString()).result.tools;
const B = v => Buffer.byteLength(JSON.stringify(v));
const per = tools.map(t => ({ name: t.name, description_bytes: Buffer.byteLength(t.description), input_schema_bytes: B(t.inputSchema), projected_bytes: B({ name: t.name, description: t.description, inputSchema: t.inputSchema }), full_definition_bytes: B(t) }));
const res = { initialize_frame_bytes: frames[0].length, tools_list_frame_bytes: frame.length, tools_array_bytes: B(tools),
  projected_name_description_inputSchema_total: per.reduce((n, p) => n + p.projected_bytes, 0),
  projected_array_bytes: B(tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))),
  description_total: per.reduce((n, p) => n + p.description_bytes, 0), per };
writeFileSync(out, JSON.stringify(res, null, 2)); console.log(JSON.stringify({ ...res, per: undefined }));

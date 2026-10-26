// Saves the built server's tools/list for the six mocked tools as the eval suite's _tools.json,
// so eval runs show the model the real tool descriptions and input schemas.
// usage: npm run build && node eval/controller-skill/capture-tools.mjs
// Provider-free: the server never starts a Pi session; the configuration lives in a disposable temporary directory.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const out = join(here, "plugin/evals/mocks/pi-session-mcp/_tools.json");
const MOCKED = ["pi_capabilities_get", "pi_session_start", "pi_session_prompt", "pi_turn_get", "pi_session_abort", "pi_session_close"];

const temp = mkdtempSync(join(tmpdir(), "controller-skill-tools-"));
const workspace = join(temp, "ws");
mkdirSync(workspace);
const config = join(temp, "config.json");
writeFileSync(config, JSON.stringify({ workspaces: { project: workspace }, executionProfiles: { ro: { default: true, permissionProfile: "read-only", provider: "example-provider", model: "example-model", thinkingLevel: "low", skills: [] } } }));
const child = spawn(process.execPath, [join(root, "dist/main.js")], { env: { PATH: process.env.PATH, PI_SESSION_MCP_CONFIG: config }, stdio: ["pipe", "pipe", "inherit"] });
let buffer = Buffer.alloc(0);
const frames = [];
child.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  let index;
  while ((index = buffer.indexOf(10)) >= 0) { frames.push(JSON.parse(buffer.subarray(0, index).toString())); buffer = buffer.subarray(index + 1); }
});
const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
const response = async (id) => {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const frame = frames.find((candidate) => candidate.id === id);
    if (frame) return frame;
    if (Date.now() > deadline) throw new Error("tools_list_timeout");
    await new Promise((settle) => setTimeout(settle, 20));
  }
};
try {
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "capture-tools", version: "1" } } });
  await response(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools = (await response(2)).result.tools.filter((tool) => MOCKED.includes(tool.name));
  if (tools.length !== MOCKED.length) throw new Error("tools_missing");
  writeFileSync(out, JSON.stringify({ tools }, null, 2) + "\n");
  console.log(JSON.stringify({ written: "plugin/evals/mocks/pi-session-mcp/_tools.json", tools: tools.map((tool) => tool.name) }));
} finally {
  child.stdin.end();
  child.kill();
  rmSync(temp, { recursive: true, force: true });
}

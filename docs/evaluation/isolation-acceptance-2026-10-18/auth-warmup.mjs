#!/usr/bin/env node
// Refreshes the host's openai login through Pi's own locked credential store when it expires within 20 minutes:
// it starts and closes one session of the released server (no model request). The host file is never written here.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const home = process.env.HOME;
try {
  const e = JSON.parse(readFileSync(join(home, ".pi/agent/auth.json"), "utf8")).openai;
  const expires = e.expires > 1e12 ? e.expires / 1000 : e.expires;
  if (expires - Date.now() / 1000 > Number(process.env.PI_WRITER_WARMUP_MINUTES ?? 20) * 60) process.exit(0);
} catch { process.exit(0); }
const server = spawn(process.execPath, [join(home, ".local/lib/node_modules/pi-session-mcp/dist/main.js")], {
  stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, PI_SESSION_MCP_CONFIG: join(home, "pi-writers/auth-warmup.json") },
});
const timer = setTimeout(() => server.kill("SIGTERM"), 20_000);
let buffer = "";
const send = (message) => server.stdin.write(JSON.stringify(message) + "\n");
server.stdout.on("data", (chunk) => {
  buffer += chunk;
  for (let i; (i = buffer.indexOf("\n")) >= 0;) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    let message; try { message = JSON.parse(line); } catch { continue; }
    if (message.id === 1) { send({ jsonrpc: "2.0", method: "notifications/initialized" }); send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "pi_session_start", arguments: { workspace: "warmup" } } }); }
    else if (message.id === 2) {
      const id = message.result?.structuredContent?.session?.id;
      if (id) send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "pi_session_close", arguments: { sessionId: id } } });
      else server.stdin.end();
    } else if (message.id === 3) server.stdin.end();
  }
});
server.on("close", () => { clearTimeout(timer); process.exit(0); });
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pi-writer-auth-warmup", version: "1" } } });

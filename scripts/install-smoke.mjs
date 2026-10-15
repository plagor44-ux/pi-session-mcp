#!/usr/bin/env node
// Install smoke: starts the server of an installed Pi Session MCP package root and checks
// that it answers the MCP handshake, announces its own name and version, lists exactly the
// eight tools, and exits on stdin EOF. It never starts a session and needs no provider.
//
// Usage: node scripts/install-smoke.mjs --package-root <dir>
//
// <dir> is a package root with dist/main.js, package.json and pi-session-mcp.example.json,
// for example <prefix>/lib/node_modules/pi-session-mcp after an `npm install -g --prefix`.
//
// stdout carries exactly one JSON line: {"ok":bool,"code":"...","version":...}. On a failed
// check, at most the last 20 lines of the server's stderr go to stderr with absolute paths
// replaced by <path>.
//
// Exit status: 0 passed, 1 a check failed, 2 usage error.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const EXPECTED_TOOLS = ["pi_capabilities_get", "pi_session_start", "pi_session_list", "pi_session_get", "pi_session_prompt", "pi_session_abort", "pi_session_close", "pi_turn_get"];
const PROTOCOL_VERSION = "2025-03-26";
const SERVER_NAME = "pi-session-mcp";
const SHUTDOWN_TIMEOUT_MS = 15_000;
const OVERALL_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BYTES = 1_048_576;
const MAX_STDERR_BYTES = 262_144;
const STDERR_LINES = 20;

function report(ok, code, version, exitCode) {
  process.stdout.write(`${JSON.stringify({ ok, code, version })}\n`);
  process.exitCode = exitCode;
}

function usage() {
  process.stderr.write("usage: node scripts/install-smoke.mjs --package-root <dir>\n");
  report(false, "usage", null, 2);
}

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--package-root" || args[1].length === 0) {
  usage();
} else {
  await smoke(resolve(args[1]));
}

async function smoke(root) {
  let version;
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    version = typeof manifest.version === "string" && manifest.version.length > 0 ? manifest.version : undefined;
  } catch {
    version = undefined;
  }
  if (version === undefined) {
    process.stderr.write("install-smoke: <path>/package.json is missing or has no version\n");
    report(false, "package_invalid", null, 1);
    return;
  }

  const child = spawn(process.execPath, [join(root, "dist", "main.js")], {
    env: { ...process.env, PI_SESSION_MCP_CONFIG: join(root, "pi-session-mcp.example.json") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.on("error", () => {});

  let stdoutBuffer = "";
  let stderrBuffer = "";
  let exited = false;
  const frames = [];
  const waiters = [];
  const wake = () => { for (const waiter of waiters.splice(0)) waiter(); };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    let newline;
    while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line.length > 0) frames.push(line);
    }
    if (stdoutBuffer.length > MAX_STDOUT_BYTES) { stdoutBuffer = ""; frames.push("<oversized>"); }
    wake();
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderrBuffer = (stderrBuffer + chunk).slice(-MAX_STDERR_BYTES); });
  child.on("error", () => { exited = true; wake(); });
  child.on("close", () => { exited = true; wake(); });

  const deadline = Date.now() + OVERALL_TIMEOUT_MS;
  // Resolves on the next stdout data or process event, or after `ms`.
  const nextEvent = (ms) => new Promise((done) => {
    const timer = setTimeout(done, ms);
    waiters.push(() => { clearTimeout(timer); done(); });
  });
  const send = (message) => { child.stdin.write(`${JSON.stringify(message)}\n`); };

  // Resolves with the response to `id`, or with a failure marker. Frames with another id
  // (notifications, log lines) are skipped; a non-JSON line on stdout is a protocol violation.
  async function response(id) {
    for (;;) {
      while (frames.length > 0) {
        const line = frames.shift();
        let message;
        try { message = JSON.parse(line); } catch { return { failure: "stdout_invalid" }; }
        if (message && typeof message === "object" && message.id === id) return { message };
      }
      if (exited) return { failure: "server_exited" };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { failure: "timeout" };
      await nextEvent(remaining);
    }
  }

  async function run() {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "pi-session-mcp-install-smoke", version: "1" } } });
    const initialized = await response(1);
    if (initialized.failure) return initialized.failure === "stdout_invalid" ? "initialize_invalid" : initialized.failure;
    const info = initialized.message.result?.serverInfo;
    if (!info || typeof info !== "object" || info.name !== SERVER_NAME || info.version !== version) return "initialize_invalid";

    send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const listed = await response(2);
    if (listed.failure) return listed.failure === "stdout_invalid" ? "tools_invalid" : listed.failure;
    const tools = listed.message.result?.tools;
    const names = Array.isArray(tools) ? tools.map((tool) => (tool && typeof tool === "object" ? tool.name : undefined)) : [];
    if (names.length !== EXPECTED_TOOLS.length || new Set(names).size !== names.length || !EXPECTED_TOOLS.every((name) => names.includes(name))) return "tools_invalid";

    child.stdin.end();
    const shutdownBy = Math.min(Date.now() + SHUTDOWN_TIMEOUT_MS, deadline);
    while (!exited) {
      const remaining = shutdownBy - Date.now();
      if (remaining <= 0) return Date.now() >= deadline ? "timeout" : "shutdown_timeout";
      await nextEvent(remaining);
    }
    return "smoke_passed";
  }

  const code = await run();
  if (!exited) child.kill("SIGKILL");

  if (code === "smoke_passed") {
    report(true, code, version, 0);
    return;
  }
  const tail = stderrBuffer.split("\n").filter((line) => line.length > 0).slice(-STDERR_LINES);
  if (tail.length > 0) process.stderr.write(`${tail.map((line) => line.replace(/\/\S+/g, "<path>")).join("\n")}\n`);
  report(false, code, version, 1);
}

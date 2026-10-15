#!/usr/bin/env node
// Install smoke: starts the server of an installed Pi Session MCP package root and checks
// that it answers the MCP handshake, announces its own name and version, lists exactly the
// eight tools, and exits by itself with status 0 after stdin EOF. It never starts a session
// and needs no provider.
//
// Usage: node scripts/install-smoke.mjs --package-root <dir>
//
// <dir> is a package root with dist/main.js, package.json and pi-session-mcp.example.json,
// for example <prefix>/lib/node_modules/pi-session-mcp after an `npm install -g --prefix`.
//
// stdout carries exactly one JSON line: {"ok":bool,"code":"...","version":...}. Codes:
// smoke_passed, usage, package_invalid, server_exited, initialize_invalid, tools_invalid,
// stdout_invalid (invalid or oversized stdout during shutdown), shutdown_timeout (still
// running after EOF), shutdown_failed (exited with a nonzero status or a signal) and timeout.
//
// The server runs in its own process group. On every outcome the whole group is killed, its
// pipes are destroyed and the smoke ends with an explicit process.exit, so that no inherited
// pipe or descendant keeps the smoke alive.
//
// On a failed check, at most the last 20 lines of the server's stderr go to stderr, with the
// package root, the home directory and other absolute paths replaced by <path>. That tail is
// a maintainer diagnostic of a server whose stderr is designed to be secret-free (structured
// logs without secrets or complete prompts); the replacement is not a sanitizer for
// arbitrary output, so do not run the smoke against a server that is not.
//
// Test hooks, not an interface: INSTALL_SMOKE_TIMEOUT_MS overrides the overall timeout and
// INSTALL_SMOKE_SHUTDOWN_MS the wait for the exit after EOF. Both must be positive
// integers; any other value is ignored.
//
// Exit status: 0 passed, 1 a check failed, 2 usage error.
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const EXPECTED_TOOLS = ["pi_capabilities_get", "pi_session_start", "pi_session_list", "pi_session_get", "pi_session_prompt", "pi_session_abort", "pi_session_close", "pi_turn_get"];
const PROTOCOL_VERSION = "2025-03-26";
const SERVER_NAME = "pi-session-mcp";
const MAX_STDOUT_BYTES = 1_048_576;
const MAX_STDERR_BYTES = 262_144;
const STDERR_LINES = 20;
const KILL_WAIT_MS = 2_000;
const DRAIN_GRACE_MS = 300;

function positiveInteger(name, fallback) {
  const raw = process.env[name];
  return typeof raw === "string" && /^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : fallback;
}
const OVERALL_TIMEOUT_MS = positiveInteger("INSTALL_SMOKE_TIMEOUT_MS", 30_000);
const SHUTDOWN_TIMEOUT_MS = positiveInteger("INSTALL_SMOKE_SHUTDOWN_MS", 15_000);

function write(stream, text) {
  return new Promise((done) => { stream.write(text, () => done()); });
}

async function finish(ok, code, version, exitCode) {
  await write(process.stdout, `${JSON.stringify({ ok, code, version })}\n`);
  process.exit(exitCode);
}

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--package-root" || args[1].length === 0) {
  await write(process.stderr, "usage: node scripts/install-smoke.mjs --package-root <dir>\n");
  await finish(false, "usage", null, 2);
} else {
  await smoke(resolve(args[1]));
}

function literalPaths(root) {
  const paths = new Set();
  for (const path of [root, homedir()]) {
    if (path.length > 1) paths.add(path);
    try { const real = realpathSync(path); if (real.length > 1) paths.add(real); } catch { /* not resolvable */ }
  }
  // Longest first, so a root below the home directory is replaced as a whole.
  return [...paths].sort((a, b) => b.length - a.length);
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
    await write(process.stderr, "install-smoke: <path>/package.json is missing or has no version\n");
    await finish(false, "package_invalid", null, 1);
    return;
  }

  const child = spawn(process.execPath, [join(root, "dist", "main.js")], {
    env: { ...process.env, PI_SESSION_MCP_CONFIG: join(root, "pi-session-mcp.example.json") },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  const killGroup = () => {
    if (child.pid === undefined) return;
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* ESRCH: the group is gone */ }
  };
  process.on("exit", killGroup);
  for (const [signal, status] of [["SIGINT", 130], ["SIGTERM", 143]]) process.on(signal, () => { killGroup(); process.exit(status); });
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on("error", () => {});

  let stdoutBuffer = "";
  let pendingBytes = 0; // bytes of the partial line plus all queued frames
  let overflow = false;
  let stderrBuffer = "";
  let exitInfo; // { code, signal } once the server process has exited
  let drained = false; // stdout and stderr ended, or the exit was seen and the grace period passed
  let closed = false;
  const frames = []; // { text, bytes }
  const waiters = [];
  const wake = () => { for (const waiter of waiters.splice(0)) waiter(); };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (overflow) return;
    stdoutBuffer += chunk;
    pendingBytes += Buffer.byteLength(chunk);
    let newline;
    while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
      const raw = stdoutBuffer.slice(0, newline + 1);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      const line = raw.trim();
      if (line.length > 0) frames.push({ text: line, bytes: Buffer.byteLength(raw) });
      else pendingBytes -= Buffer.byteLength(raw);
    }
    if (pendingBytes > MAX_STDOUT_BYTES) { overflow = true; stdoutBuffer = ""; frames.length = 0; pendingBytes = 0; }
    wake();
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderrBuffer = (stderrBuffer + chunk).slice(-MAX_STDERR_BYTES); });
  child.on("error", () => { exitInfo ??= { code: null, signal: null }; drained = true; wake(); });
  child.on("exit", (code, signal) => {
    exitInfo = { code, signal };
    // Output the server wrote just before exiting may still be in the pipes.
    setTimeout(() => { drained = true; wake(); }, DRAIN_GRACE_MS).unref();
    wake();
  });
  child.on("close", () => { closed = true; drained = true; wake(); });

  const deadline = Date.now() + OVERALL_TIMEOUT_MS;
  // Resolves on the next stdout data or process event, or after `ms`.
  const nextEvent = (ms) => new Promise((done) => {
    const timer = setTimeout(done, ms);
    waiters.push(() => { clearTimeout(timer); done(); });
  });
  const send = (message) => { child.stdin.write(`${JSON.stringify(message)}\n`); };
  const isJson = (text) => { try { JSON.parse(text); return true; } catch { return false; } };

  // Resolves with the response to `id`, or with a failure marker. Frames with another id
  // (notifications, log lines) are skipped; a non-JSON line or an oversized stdout is a
  // protocol violation.
  async function response(id) {
    for (;;) {
      if (overflow) return { failure: "stdout_invalid" };
      while (frames.length > 0) {
        const frame = frames.shift();
        pendingBytes -= frame.bytes;
        let message;
        try { message = JSON.parse(frame.text); } catch { return { failure: "stdout_invalid" }; }
        if (message && typeof message === "object" && message.id === id) return { message };
      }
      if (drained) return { failure: "server_exited" };
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
    while (exitInfo === undefined) {
      if (overflow || frames.some((frame) => !isJson(frame.text))) return "stdout_invalid";
      const remaining = shutdownBy - Date.now();
      if (remaining <= 0) return Date.now() >= deadline ? "timeout" : "shutdown_timeout";
      await nextEvent(remaining);
    }
    // The server exited; its last output may still be in flight, but never past the deadline.
    while (!drained && Date.now() < deadline) await nextEvent(Math.max(1, deadline - Date.now()));
    if (overflow || frames.some((frame) => !isJson(frame.text))) return "stdout_invalid";
    return exitInfo.code === 0 && exitInfo.signal === null ? "smoke_passed" : "shutdown_failed";
  }

  const code = await run();
  killGroup();
  if (code !== "smoke_passed" && child.pid !== undefined && !closed) {
    // Killing the group closes every pipe holder; wait briefly for the final stderr output.
    await new Promise((done) => {
      const timer = setTimeout(done, KILL_WAIT_MS);
      child.once("close", () => { clearTimeout(timer); done(); });
    });
  }
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy();

  if (code === "smoke_passed") {
    await finish(true, code, version, 0);
    return;
  }
  // Literal paths first: the package root and the home directory may contain spaces.
  let text = stderrBuffer;
  for (const path of literalPaths(root)) text = text.split(path).join("<path>");
  const tail = text.split("\n").filter((line) => line.length > 0).slice(-STDERR_LINES);
  if (tail.length > 0) await write(process.stderr, `${tail.map((line) => line.replace(/\/\S+/g, "<path>")).join("\n")}\n`);
  await finish(false, code, version, 1);
}

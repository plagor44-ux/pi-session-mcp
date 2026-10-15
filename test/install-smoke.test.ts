/**
 * Process-level evidence for scripts/install-smoke.mjs against throwaway package roots.
 *
 * Each root holds a package.json, the example configuration and a fake `dist/main.js`
 * that speaks just enough MCP over stdio. The suite is hermetic: no provider, no network,
 * no real server and no installed package.
 */
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

const REPOSITORY = fileURLToPath(new URL("..", import.meta.url));
const SMOKE = join(REPOSITORY, "scripts", "install-smoke.mjs");
const VERSION = "9.9.9";
const TOOLS = ["pi_capabilities_get", "pi_session_start", "pi_session_list", "pi_session_get", "pi_session_prompt", "pi_session_abort", "pi_session_close", "pi_turn_get"];

// FAKE_MODE selects the behavior:
//   ok               compliant server that exits by itself on stdin EOF
//   wrong-version    announces another version
//   wrong-tools      lists seven tools
//   duplicate-tools  lists eight entries with one name twice
//   extra-tools      lists nine tools
//   noise            prints a non-JSON line on stdout before answering
//   flood            writes more than 1 MiB of stdout without a newline
//   crash            fails at startup with a path in its stderr
//   ignore-eof       keeps running after stdin EOF
//   exit-failure     exits with code 1 on stdin EOF
//   no-initialize    never answers initialize
//   grandchild       like ok, but a descendant inherits stdout and stderr and outlives the
//                    server (its pid goes to FAKE_PIDFILE)
const FAKE_SERVER = `
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const mode = process.env.FAKE_MODE;
if (mode === "crash") {
  console.error("Error [ERR_MODULE_NOT_FOUND]: Cannot find module '" + import.meta.dirname + "/missing.js' imported from " + import.meta.filename);
  await import("./missing.js");
}
if (!existsSync(process.env.PI_SESSION_MCP_CONFIG ?? "")) process.exit(3);
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const names = ${JSON.stringify(TOOLS)};
const tools = mode === "wrong-tools" ? names.slice(0, 7)
  : mode === "duplicate-tools" ? [...names.slice(0, 7), names[0]]
  : mode === "extra-tools" ? [...names, "pi_extra_tool"]
  : names;
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
if (mode === "grandchild") {
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });
  holder.unref();
  writeFileSync(process.env.FAKE_PIDFILE, String(holder.pid));
}
if (mode === "noise") process.stdout.write("this is not json\\n");
if (mode === "flood") process.stdout.write("x".repeat(1_100_000));
if (mode === "ignore-eof") setInterval(() => {}, 1000);
const lines = createInterface({ input: process.stdin });
if (mode === "exit-failure") lines.on("close", () => process.exit(1));
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (mode === "no-initialize") return;
  if (message.method === "initialize") {
    reply(message.id, { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "pi-session-mcp", version: mode === "wrong-version" ? "0.0.1" : version } });
  } else if (message.method === "tools/list") {
    reply(message.id, { tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })) });
  }
});
`;

interface SmokeRun { code: number | null; stdout: string; stderr: string }

afterAll(removeTemporaryRoots);

async function packageRoot(options: { directory?: string; manifest?: boolean } = {}): Promise<string> {
  const base = await temporaryRoot("pi-session-mcp-install-smoke-");
  const root = options.directory ? join(base, options.directory) : base;
  await mkdir(join(root, "dist"), { recursive: true });
  if (options.manifest === false) return root;
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "pi-session-mcp", version: VERSION, type: "module" }));
  await copyFile(join(REPOSITORY, "pi-session-mcp.example.json"), join(root, "pi-session-mcp.example.json"));
  await writeFile(join(root, "dist", "main.js"), FAKE_SERVER);
  return root;
}

function runSmoke(args: readonly string[], mode?: string, extraEnv: Record<string, string> = {}): Promise<SmokeRun> {
  return new Promise((resolve) => {
    execFile(process.execPath, [SMOKE, ...args], {
      env: { PATH: process.env.PATH ?? "", ...(mode ? { FAKE_MODE: mode } : {}), ...extraEnv }, timeout: 40_000, killSignal: "SIGKILL",
    }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : null) : 0, stdout, stderr });
    });
  });
}

// A killed orphan can linger as a zombie until its new parent reaps it; that is not alive.
async function isAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return true;
  }
}

function singleLine(run: SmokeRun): { ok: boolean; code: string; version: string | null } {
  expect(run.stdout.endsWith("\n")).toBe(true);
  expect(run.stdout.trimEnd().split("\n")).toHaveLength(1);
  return JSON.parse(run.stdout) as { ok: boolean; code: string; version: string | null };
}

describe("install smoke", () => {
  it("passes for a compliant server and reports the package version", async () => {
    const root = await packageRoot();
    const run = await runSmoke(["--package-root", root], "ok");
    expect(run.code).toBe(0);
    expect(singleLine(run)).toEqual({ ok: true, code: "smoke_passed", version: VERSION });
  }, 45_000);

  it("reports a server that exits at startup and strips absolute paths from its stderr", async () => {
    const root = await packageRoot();
    const run = await runSmoke(["--package-root", root], "crash");
    expect(run.code).toBe(1);
    expect(singleLine(run)).toEqual({ ok: false, code: "server_exited", version: VERSION });
    expect(run.stderr).toContain("ERR_MODULE_NOT_FOUND");
    expect(run.stderr).toContain("<path>");
    expect(run.stderr).not.toContain(root);
    expect(run.stderr.trimEnd().split("\n").length).toBeLessThanOrEqual(20);
  }, 45_000);

  it("rejects a server that announces another version", async () => {
    const root = await packageRoot();
    const run = await runSmoke(["--package-root", root], "wrong-version");
    expect(run.code).toBe(1);
    expect(singleLine(run)).toEqual({ ok: false, code: "initialize_invalid", version: VERSION });
  }, 45_000);

  it("rejects a server that lists the wrong tools", async () => {
    const root = await packageRoot();
    const run = await runSmoke(["--package-root", root], "wrong-tools");
    expect(run.code).toBe(1);
    expect(singleLine(run)).toEqual({ ok: false, code: "tools_invalid", version: VERSION });
  }, 45_000);

  it("rejects non-JSON noise on stdout", async () => {
    const root = await packageRoot();
    const run = await runSmoke(["--package-root", root], "noise");
    expect(run.code).toBe(1);
    expect(singleLine(run)).toEqual({ ok: false, code: "initialize_invalid", version: VERSION });
  }, 15_000);

  it("rejects a server that floods stdout without a newline", async () => {
    const root = await packageRoot();
    const run = await runSmoke(["--package-root", root], "flood");
    expect(run.code).toBe(1);
    expect(singleLine(run)).toEqual({ ok: false, code: "initialize_invalid", version: VERSION });
  }, 15_000);

  it("rejects a server that lists a tool twice", async () => {
    const root = await packageRoot();
    const run = await runSmoke(["--package-root", root], "duplicate-tools");
    expect(run.code).toBe(1);
    expect(singleLine(run)).toEqual({ ok: false, code: "tools_invalid", version: VERSION });
  }, 15_000);

  it("rejects a server that lists an extra tool", async () => {
    const root = await packageRoot();
    const run = await runSmoke(["--package-root", root], "extra-tools");
    expect(run.code).toBe(1);
    expect(singleLine(run)).toEqual({ ok: false, code: "tools_invalid", version: VERSION });
  }, 15_000);

  it("reports a missing package.json as package_invalid", async () => {
    const root = await packageRoot({ manifest: false });
    const run = await runSmoke(["--package-root", root], "ok");
    expect(run.code).toBe(1);
    expect(singleLine(run)).toEqual({ ok: false, code: "package_invalid", version: null });
    expect(run.stderr).toContain("<path>/package.json");
    expect(run.stderr).not.toContain(root);
  }, 15_000);

  it("strips a package root that contains a space from the stderr tail", async () => {
    const root = await packageRoot({ directory: "root with a space" });
    const run = await runSmoke(["--package-root", root], "crash");
    expect(run.code).toBe(1);
    expect(singleLine(run)).toEqual({ ok: false, code: "server_exited", version: VERSION });
    expect(run.stderr).toContain("ERR_MODULE_NOT_FOUND");
    expect(run.stderr).not.toContain(root);
    expect(run.stderr).not.toContain("with a space");
    expect(run.stderr).not.toContain("install-smoke-");
  }, 15_000);

  it("reports shutdown_timeout for a server that ignores stdin EOF", async () => {
    const root = await packageRoot();
    const started = Date.now();
    const run = await runSmoke(["--package-root", root], "ignore-eof", { INSTALL_SMOKE_SHUTDOWN_MS: "1500" });
    expect(run.code).toBe(1);
    expect(singleLine(run)).toEqual({ ok: false, code: "shutdown_timeout", version: VERSION });
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);

  it("reports timeout for a server that never answers initialize", async () => {
    const root = await packageRoot();
    const started = Date.now();
    const run = await runSmoke(["--package-root", root], "no-initialize", { INSTALL_SMOKE_TIMEOUT_MS: "2000" });
    expect(run.code).toBe(1);
    expect(singleLine(run)).toEqual({ ok: false, code: "timeout", version: VERSION });
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);

  it("reports shutdown_failed for a server that exits with a nonzero code on EOF", async () => {
    const root = await packageRoot();
    const run = await runSmoke(["--package-root", root], "exit-failure");
    expect(run.code).toBe(1);
    expect(singleLine(run)).toEqual({ ok: false, code: "shutdown_failed", version: VERSION });
  }, 15_000);

  it("ignores invalid override values", async () => {
    const root = await packageRoot();
    const run = await runSmoke(["--package-root", root], "ok", { INSTALL_SMOKE_TIMEOUT_MS: "0", INSTALL_SMOKE_SHUTDOWN_MS: "soon" });
    expect(run.code).toBe(0);
    expect(singleLine(run)).toEqual({ ok: true, code: "smoke_passed", version: VERSION });
  }, 15_000);

  // The server exits 0 on EOF while a descendant keeps its stdout and stderr pipes open.
  // The server's own exit decides: the smoke passes, kills the whole process group and ends
  // promptly instead of waiting for the pipes to close.
  it("ends promptly and kills a descendant that holds the server's pipes", async () => {
    const root = await packageRoot();
    const pidFile = join(root, "holder.pid");
    const started = Date.now();
    const run = await runSmoke(["--package-root", root], "grandchild", { FAKE_PIDFILE: pidFile });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(run.code).toBe(0);
    expect(singleLine(run)).toEqual({ ok: true, code: "smoke_passed", version: VERSION });
    const holder = Number((await readFile(pidFile, "utf8")).trim());
    expect(Number.isInteger(holder) && holder > 0).toBe(true);
    for (let attempt = 0; attempt < 30 && await isAlive(holder); attempt += 1) await new Promise((done) => setTimeout(done, 100));
    expect(await isAlive(holder)).toBe(false);
  }, 15_000);

  it("fails with a usage error without --package-root", async () => {
    const run = await runSmoke([]);
    expect(run.code).toBe(2);
    expect(singleLine(run)).toEqual({ ok: false, code: "usage", version: null });
    expect(run.stderr).toContain("usage:");
  });
});

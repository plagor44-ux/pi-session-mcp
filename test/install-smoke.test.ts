/**
 * Process-level evidence for scripts/install-smoke.mjs against throwaway package roots.
 *
 * Each root holds a package.json, the example configuration and a fake `dist/main.js`
 * that speaks just enough MCP over stdio. The suite is hermetic: no provider, no network,
 * no real server and no installed package.
 */
import { execFile } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

const REPOSITORY = fileURLToPath(new URL("..", import.meta.url));
const SMOKE = join(REPOSITORY, "scripts", "install-smoke.mjs");
const VERSION = "9.9.9";
const TOOLS = ["pi_capabilities_get", "pi_session_start", "pi_session_list", "pi_session_get", "pi_session_prompt", "pi_session_abort", "pi_session_close", "pi_turn_get"];

// FAKE_MODE selects the behavior: ok, wrong-version, wrong-tools or crash.
const FAKE_SERVER = `
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const mode = process.env.FAKE_MODE;
if (mode === "crash") {
  console.error("Error [ERR_MODULE_NOT_FOUND]: Cannot find module '" + import.meta.dirname + "/missing.js' imported from " + import.meta.filename);
  await import("./missing.js");
}
if (!existsSync(process.env.PI_SESSION_MCP_CONFIG ?? "")) process.exit(3);
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const tools = ${JSON.stringify(TOOLS)}.slice(0, mode === "wrong-tools" ? 7 : 8);
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    reply(message.id, { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "pi-session-mcp", version: mode === "wrong-version" ? "0.0.1" : version } });
  } else if (message.method === "tools/list") {
    reply(message.id, { tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })) });
  }
});
`;

interface SmokeRun { code: number | null; stdout: string; stderr: string }

afterAll(removeTemporaryRoots);

async function packageRoot(): Promise<string> {
  const root = await temporaryRoot("pi-session-mcp-install-smoke-");
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "pi-session-mcp", version: VERSION, type: "module" }));
  await copyFile(join(REPOSITORY, "pi-session-mcp.example.json"), join(root, "pi-session-mcp.example.json"));
  await writeFile(join(root, "dist", "main.js"), FAKE_SERVER);
  return root;
}

function runSmoke(args: readonly string[], mode?: string): Promise<SmokeRun> {
  return new Promise((resolve) => {
    execFile(process.execPath, [SMOKE, ...args], {
      env: { PATH: process.env.PATH ?? "", ...(mode ? { FAKE_MODE: mode } : {}) }, timeout: 40_000, killSignal: "SIGKILL",
    }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : null) : 0, stdout, stderr });
    });
  });
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

  it("fails with a usage error without --package-root", async () => {
    const run = await runSmoke([]);
    expect(run.code).toBe(2);
    expect(singleLine(run)).toEqual({ ok: false, code: "usage", version: null });
    expect(run.stderr).toContain("usage:");
  });
});

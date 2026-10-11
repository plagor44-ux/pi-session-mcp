/**
 * Process-level evidence for allowlisted Pi extensions and the stdout guard.
 *
 * Starts the compiled `main.js` with a temporary Pi agent directory that contains the
 * fixture extension. The fixture writes to stdout at load and during a turn; every
 * stdout line must still be an MCP frame. No provider, credentials or network.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as waitFor } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { compileServerEntry } from "./compiled-entry.js";
import { readFixtureLog } from "./fixture-log.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/pi-extension-fixture", import.meta.url));
let entry = "";
const servers: ChildProcessWithoutNullStreams[] = [];

beforeAll(async () => { entry = await compileServerEntry(); }, 150_000);
afterEach(() => {
  for (const server of servers.splice(0)) if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
});
afterAll(removeTemporaryRoots);

interface ToolResult { structuredContent?: Record<string, unknown> }

async function startServer() {
  const root = await temporaryRoot("pi-session-mcp-extension-process-");
  const agentDir = join(root, "agent");
  const workspace = join(root, "workspace");
  await mkdir(join(agentDir, "npm", "node_modules"), { recursive: true });
  await mkdir(workspace);
  await cp(FIXTURE, join(agentDir, "npm", "node_modules", "pi-extension-fixture"), { recursive: true });
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({
    workspaces: { project: workspace },
    executionProfiles: {
      safe: {
        default: true, permissionProfile: "read-only", provider: "fixture-ext", model: "fixture-ext-model", thinkingLevel: "off",
        extensions: ["npm:pi-extension-fixture@1.0.0"],
      },
    },
  }));
  const eventLog = join(root, "extension.jsonl");
  const server = spawn(process.execPath, [entry], {
    cwd: workspace,
    env: { PATH: process.env.PATH ?? "", HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_SESSION_MCP_CONFIG: config, PI_EXTENSION_FIXTURE_LOG: eventLog },
    stdio: ["pipe", "pipe", "pipe"],
  });
  servers.push(server);
  let stderr = "";
  server.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  server.stdin.on("error", () => undefined);
  const foreignLines: string[] = [];
  const pending = new Map<number, (message: { result?: ToolResult }) => void>();
  createInterface({ input: server.stdout }).on("line", (line) => {
    let message: { id?: unknown; result?: ToolResult };
    try { message = JSON.parse(line) as typeof message; } catch { foreignLines.push(line); return; }
    if (typeof message.id === "number") pending.get(message.id)?.(message);
  });
  let nextId = 1;
  const send = (message: Record<string, unknown>) => { server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`); };
  const request = (method: string, params: Record<string, unknown>) => new Promise<{ result?: ToolResult }>((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ id, method, params });
  });
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "extension-test", version: "0.0.0" } });
  send({ method: "notifications/initialized" });
  return {
    eventLog,
    foreignLines,
    diagnostics: () => stderr.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>),
    callTool: async (name: string, args: Record<string, unknown>) => (await request("tools/call", { name, arguments: args })).result?.structuredContent ?? {},
  };
}

describe("allowlisted Pi extension in the server process", () => {
  it("keeps stdout to MCP frames while an extension writes to it", async () => {
    const harness = await startServer();
    expect(await harness.callTool("pi_capabilities_get", {})).toMatchObject({
      executionProfiles: [{ alias: "safe", extensions: ["npm:pi-extension-fixture@1.0.0"] }],
    });
    const started = await harness.callTool("pi_session_start", { workspace: "project" }) as { ok: boolean; session: { id: string } };
    expect(started).toMatchObject({ ok: true, session: { provider: "fixture-ext", state: "idle" } });
    const prompted = await harness.callTool("pi_session_prompt", { sessionId: started.session.id, prompt: "/fixture-cmd hello" }) as { turn: { turnId: string } };
    let turn: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 400; attempt++) {
      turn = (await harness.callTool("pi_turn_get", { sessionId: started.session.id, turnId: prompted.turn.turnId }) as { turn: Record<string, unknown> }).turn;
      if (turn.state !== "running") break;
      await waitFor(25);
    }
    expect(turn).toMatchObject({ state: "completed", assistantText: "FIXTURE-PONG" });
    expect(await harness.callTool("pi_session_close", { sessionId: started.session.id })).toMatchObject({ ok: true });

    const events = (await readFixtureLog<{ event: string }>(harness.eventLog)).map((record) => record.event);
    expect(events).toEqual(expect.arrayContaining(["load", "session_start", "stream", "session_shutdown"]));
    expect(events).not.toContain("command");
    expect(harness.foreignLines).toEqual([]);
    // The guard reports at most once per second.
    await waitFor(1_200);
    const suppressed = harness.diagnostics().filter((line) => line.event === "foreign_stdout_suppressed");
    expect(suppressed.length).toBeGreaterThan(0);
    expect(suppressed.every((line) => typeof line.bytes === "number" && typeof line.writes === "number")).toBe(true);
    expect(JSON.stringify(harness.diagnostics())).not.toContain("pi-extension-fixture:");
  }, 60_000);
});

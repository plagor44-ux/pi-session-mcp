/**
 * Process-level shutdown evidence for the server entry point.
 *
 * The suite compiles the current sources into a temporary directory and starts the
 * real `main.js` with real stdio pipes. CI runs the tests before `npm run build`, so
 * an existing `dist/` may be stale. A temporary Pi agent directory defines a
 * placeholder provider on loopback: session creation never contacts it, and the
 * running-turn case points it at a local server that holds the request. No real
 * provider and no credentials are involved. Sessions use the real stdio MCP fixture
 * as their external MCP server.
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as waitFor } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFixtureLog } from "./fixture-log.js";
import { cleanupFixtureProcesses, readTextIfPresent, signalFixtureProcess, stopFixtureProcess, waitForProcessTerminated } from "./process-fixture.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

const REPOSITORY = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-stdio-server.mjs", import.meta.url));
const LOG_VARIABLE = "PI_SESSION_MCP_TEST_MCP_LOG";
/**
 * Below the 15,000 ms process deadline and above the stdio client's 2,000 ms EOF
 * window before SIGTERM. An exit within it and no `shutdown_failed` diagnostic mean
 * the bounded shutdown completed instead of timing out.
 */
const EXIT_BOUND_MS = 8_000;
const TEST_TIMEOUT_MS = 30_000;
const execFileAsync = promisify(execFile);
/** Termination checks read `/proc`, as in the other process-level tests. */
const describeOnLinux = describe.skipIf(process.platform !== "linux");

interface Recorded { event: string; pid?: number; code?: number }
interface Exit { code: number | null; signal: NodeJS.Signals | null }
interface ToolResult { structuredContent?: Record<string, unknown> }
interface Harness {
  readonly server: ChildProcessWithoutNullStreams;
  readonly logPath: string;
  readonly exited: Promise<Exit>;
  diagnostics(): unknown[];
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

let entry = "";
const servers: ChildProcessWithoutNullStreams[] = [];
const fixtureLogs: string[] = [];
const providers: Server[] = [];

beforeAll(async () => {
  const root = await temporaryRoot("pi-session-mcp-entry-build-");
  // The compiled entry imports `../package.json` and the installed packages.
  await symlink(join(REPOSITORY, "package.json"), join(root, "package.json"));
  await symlink(join(REPOSITORY, "node_modules"), join(root, "node_modules"), "dir");
  await execFileAsync(process.execPath, [
    join(REPOSITORY, "node_modules", "typescript", "bin", "tsc"),
    "-p", join(REPOSITORY, "tsconfig.build.json"), "--outDir", join(root, "out"), "--declaration", "false",
  ], { cwd: REPOSITORY, timeout: 120_000 });
  entry = join(root, "out", "main.js");
}, 150_000);

afterEach(async () => {
  // A failing assertion must not leave the server or its MCP child running.
  const pids = new Set<number>();
  for (const logPath of fixtureLogs.splice(0)) {
    for (const record of await readFixtureLog<Recorded>(logPath)) if (record.pid !== undefined) pids.add(record.pid);
  }
  await cleanupFixtureProcesses([
    ...servers.splice(0).map((server) => async () => {
      if (server.exitCode === null && server.signalCode === null) await stopFixtureProcess(server.pid!);
    }),
    ...[...pids].map((pid) => async () => stopFixtureChild(pid)),
  ]);
  await Promise.all(providers.splice(0).map((provider) => {
    provider.closeAllConnections();
    return new Promise<void>((resolve) => provider.close(() => resolve()));
  }));
});
afterAll(removeTemporaryRoots);

/** Kill a recorded PID only while it still runs the fixture script, never a reused PID. */
async function stopFixtureChild(pid: number): Promise<void> {
  let commandLine: string | undefined;
  try { commandLine = await readTextIfPresent(`/proc/${pid}/cmdline`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
  if (commandLine?.includes(FIXTURE)) await stopFixtureProcess(pid);
}

/** A loopback endpoint that accepts the model request and never answers it. */
async function holdingProvider(): Promise<{ baseUrl: string; requests: IncomingMessage[] }> {
  const requests: IncomingMessage[] = [];
  const provider = createServer((request) => { requests.push(request); });
  providers.push(provider);
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  return { baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`, requests };
}

async function startServer(options: { baseUrl?: string; fixtureEnv?: Record<string, string> } = {}): Promise<Harness> {
  const root = await temporaryRoot("pi-session-mcp-eof-");
  const agentDir = join(root, "agent");
  const workspace = join(root, "workspace");
  await mkdir(agentDir);
  await mkdir(workspace);
  await writeFile(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      fixture: {
        // Port 9 (discard) is never contacted unless a test prompts without a holding provider.
        baseUrl: options.baseUrl ?? "http://127.0.0.1:9/v1",
        api: "openai-completions", apiKey: "placeholder", models: [{ id: "fixture-model" }],
      },
    },
  }));
  const logPath = join(root, "mcp.jsonl");
  fixtureLogs.push(logPath);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "", HOME: root, PI_CODING_AGENT_DIR: agentDir,
    PI_SESSION_MCP_CONFIG: join(root, "config.json"), [LOG_VARIABLE]: logPath,
  };
  const envFrom: Record<string, string> = { MCP_FIXTURE_LOG: LOG_VARIABLE };
  for (const [name, value] of Object.entries(options.fixtureEnv ?? {})) {
    env[`PI_SESSION_MCP_TEST_${name}`] = value;
    envFrom[name] = `PI_SESSION_MCP_TEST_${name}`;
  }
  await writeFile(env.PI_SESSION_MCP_CONFIG!, JSON.stringify({
    workspaces: { project: workspace },
    executionProfiles: {
      safe: {
        default: true, permissionProfile: "read-only", provider: "fixture", model: "fixture-model", thinkingLevel: "off",
        mcpServers: { knowledge: { command: process.execPath, args: [FIXTURE], envFrom, tools: { echo: { name: "echo_note", readOnly: true } } } },
      },
    },
  }));

  const server = spawn(process.execPath, [entry], { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] });
  servers.push(server);
  const exited = once(server, "exit").then(([code, signal]) => ({ code, signal }) as Exit);
  let stderr = "";
  server.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  // A client that closes its end of stdin may still see a late write fail.
  server.stdin.on("error", () => undefined);
  const pending = new Map<number, (message: { result?: ToolResult }) => void>();
  createInterface({ input: server.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as { id?: unknown; result?: ToolResult };
    if (typeof message.id === "number") pending.get(message.id)?.(message);
  });
  let nextId = 1;
  const send = (message: Record<string, unknown>) => { server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`); };
  const request = (method: string, params: Record<string, unknown>) => new Promise<{ result?: ToolResult }>((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ id, method, params });
  });

  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "eof-test", version: "0.0.0" } });
  send({ method: "notifications/initialized" });
  return {
    server, logPath, exited,
    diagnostics: () => stderr.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as unknown),
    callTool: async (name, args) => (await request("tools/call", { name, arguments: args })).result ?? {},
  };
}

async function startSession(harness: Harness): Promise<void> {
  const started = await harness.callTool("pi_session_start", { workspace: "project" });
  expect(started.structuredContent).toMatchObject({ ok: true, session: { state: "idle" } });
}

async function waitForRecord(logPath: string, event: string): Promise<Recorded> {
  const deadline = Date.now() + EXIT_BOUND_MS;
  for (;;) {
    const record = (await readFixtureLog<Recorded>(logPath)).find((candidate) => candidate.event === event);
    if (record) return record;
    if (Date.now() >= deadline) throw new Error(`fixture event ${event} not observed`);
    await waitFor(25);
  }
}

async function exitWithinBound(harness: Harness): Promise<Exit | "still_running"> {
  return Promise.race([harness.exited, waitFor(EXIT_BOUND_MS, "still_running" as const)]);
}

/** The server exited by itself with `code` after a completed cleanup, and the MCP child is gone. */
async function expectCleanShutdown(harness: Harness, code: number, childPid: number): Promise<void> {
  expect(await exitWithinBound(harness)).toEqual({ code, signal: null });
  expect(harness.diagnostics()).not.toContainEqual(expect.objectContaining({ event: "shutdown_failed" }));
  await waitForProcessTerminated(childPid);
}

describeOnLinux("server entry point on stdin EOF", () => {
  it("closes an idle session and its MCP child, then exits", async () => {
    const harness = await startServer();
    await startSession(harness);
    const child = await waitForRecord(harness.logPath, "connected");

    harness.server.stdin.end();

    await expectCleanShutdown(harness, 0, child.pid!);
    // One connection, closed once: the child saw EOF and exited normally.
    const records = await readFixtureLog<Recorded>(harness.logPath);
    expect(records.filter((record) => record.event === "connected")).toHaveLength(1);
    expect(records.filter((record) => record.event === "exit")).toEqual([{ event: "exit", pid: child.pid, code: 0 }]);
  }, TEST_TIMEOUT_MS);

  it("aborts a running turn before it closes the session", async () => {
    const provider = await holdingProvider();
    const harness = await startServer({ baseUrl: provider.baseUrl });
    const started = await harness.callTool("pi_session_start", { workspace: "project" });
    const sessionId = (started.structuredContent as { session: { id: string } }).session.id;
    const prompted = await harness.callTool("pi_session_prompt", { sessionId, prompt: "synthetic prompt" });
    expect(prompted.structuredContent).toMatchObject({ ok: true, turn: { state: "running" } });
    for (const deadline = Date.now() + EXIT_BOUND_MS; provider.requests.length === 0;) {
      if (Date.now() >= deadline) throw new Error("model request not observed");
      await waitFor(25);
    }
    const child = await waitForRecord(harness.logPath, "connected");

    harness.server.stdin.end();

    await expectCleanShutdown(harness, 0, child.pid!);
    const records = await readFixtureLog<Recorded>(harness.logPath);
    expect(records.filter((record) => record.event === "exit")).toEqual([{ event: "exit", pid: child.pid, code: 0 }]);
  }, TEST_TIMEOUT_MS);

  it("cancels a session start that is still waiting for its MCP server", async () => {
    // The child holds `initialize` beyond the test, so the start cannot finish on its own.
    const harness = await startServer({ fixtureEnv: { MCP_FIXTURE_DELAY_INIT_MS: "20000" } });
    void harness.callTool("pi_session_start", { workspace: "project" });
    const child = await waitForRecord(harness.logPath, "connected");

    harness.server.stdin.end();

    await expectCleanShutdown(harness, 0, child.pid!);
  }, TEST_TIMEOUT_MS);

  it("exits when stdin ends before the client sends anything", async () => {
    const root = await temporaryRoot("pi-session-mcp-eof-");
    await writeFile(join(root, "config.json"), JSON.stringify({
      workspaces: { project: root },
      executionProfiles: { safe: { default: true, permissionProfile: "read-only", provider: "fixture", model: "fixture-model", thinkingLevel: "off" } },
    }));
    const server = spawn(process.execPath, [entry], {
      cwd: root, env: { PATH: process.env.PATH ?? "", HOME: root, PI_SESSION_MCP_CONFIG: join(root, "config.json") }, stdio: ["pipe", "pipe", "pipe"],
    });
    servers.push(server);
    const exited = once(server, "exit").then(([code, signal]) => ({ code, signal }) as Exit);
    server.stdin.end();
    expect(await Promise.race([exited, waitFor(EXIT_BOUND_MS, "still_running" as const)])).toEqual({ code: 0, signal: null });
  }, TEST_TIMEOUT_MS);
});

describeOnLinux("server entry point on stdin EOF racing a signal", () => {
  // The child ignores EOF, so closing its connection takes the stdio client's 2,000 ms
  // EOF window plus SIGTERM. `eof-ignored` marks that shutdown is in progress.
  const slowClose = { MCP_FIXTURE_IGNORE_EOF: "1" };

  it("keeps the EOF shutdown and its exit status when SIGTERM arrives during it", async () => {
    const harness = await startServer({ fixtureEnv: slowClose });
    await startSession(harness);
    const child = await waitForRecord(harness.logPath, "connected");

    harness.server.stdin.end();
    await waitForRecord(harness.logPath, "eof-ignored");
    signalFixtureProcess(harness.server.pid!, "SIGTERM");

    await expectCleanShutdown(harness, 0, child.pid!);
  }, TEST_TIMEOUT_MS);

  it("keeps the signal shutdown and its exit status when stdin ends during it", async () => {
    const harness = await startServer({ fixtureEnv: slowClose });
    await startSession(harness);
    const child = await waitForRecord(harness.logPath, "connected");

    signalFixtureProcess(harness.server.pid!, "SIGTERM");
    await waitForRecord(harness.logPath, "eof-ignored");
    harness.server.stdin.end();

    await expectCleanShutdown(harness, 143, child.pid!);
  }, TEST_TIMEOUT_MS);
});

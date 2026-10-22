/**
 * Process-level evidence for the turn-event spool wiring in the server entry point.
 *
 * The suite starts the compiled `main.js` with real stdio pipes and a placeholder provider that
 * never answers (no credentials, no real provider). Spool contents are read while the server
 * runs; after every shutdown path the spool root must hold no instance directory.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as waitFor } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseTurnEvent, TURN_EVENT_FILE_PATTERN } from "../src/turn-events.js";
import { compileServerEntry } from "./compiled-entry.js";
import { processInspectionSupported, signalFixtureProcess, stopFixtureProcess } from "./process-fixture.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

const EXIT_BOUND_MS = 8_000;
const TEST_TIMEOUT_MS = 30_000;
const describeWithProcessInspection = describe.skipIf(!processInspectionSupported);

interface Exit { code: number | null; signal: NodeJS.Signals | null }
interface ToolResult { structuredContent?: Record<string, unknown> }
interface Harness {
  readonly server: ChildProcessWithoutNullStreams;
  readonly spool: string;
  readonly exited: Promise<Exit>;
  stderr(): string;
  diagnostics(): Array<Record<string, unknown>>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

let entry = "";
const servers: ChildProcessWithoutNullStreams[] = [];
const providers: Server[] = [];

beforeAll(async () => { entry = await compileServerEntry(); }, 150_000);
afterEach(async () => {
  for (const server of servers.splice(0)) if (server.exitCode === null && server.signalCode === null) await stopFixtureProcess(server.pid!);
  await Promise.all(providers.splice(0).map((provider) => { provider.closeAllConnections(); return new Promise<void>((resolve) => provider.close(() => resolve())); }));
});
afterAll(removeTemporaryRoots);

async function holdingProvider(): Promise<{ baseUrl: string; requests: IncomingMessage[] }> {
  const requests: IncomingMessage[] = [];
  const provider = createServer((request) => { requests.push(request); });
  providers.push(provider);
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  return { baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`, requests };
}

interface StartOptions { baseUrl?: string; delivery?: "spool"; events?: Record<string, string | undefined>; initialize?: boolean }

async function startServer(options: StartOptions = {}): Promise<Harness> {
  const root = await temporaryRoot("pi-session-mcp-spool-proc-");
  const agentDir = join(root, "agent");
  const workspace = join(root, "workspace");
  const spool = join(root, "spool");
  await mkdir(agentDir); await mkdir(workspace);
  await writeFile(join(agentDir, "models.json"), JSON.stringify({
    providers: { fixture: { baseUrl: options.baseUrl ?? "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "placeholder", models: [{ id: "fixture-model" }] } },
  }));
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_SESSION_MCP_CONFIG: join(root, "config.json") };
  for (const [name, value] of Object.entries(options.events ?? { PI_SESSION_MCP_EVENTS_DIR: spool })) if (value !== undefined) env[name] = value;
  await writeFile(env.PI_SESSION_MCP_CONFIG!, JSON.stringify({
    ...(options.delivery ? { events: { delivery: options.delivery } } : {}),
    workspaces: { project: workspace },
    executionProfiles: { safe: { default: true, permissionProfile: "read-only", provider: "fixture", model: "fixture-model", thinkingLevel: "off" } },
  }));
  const server = spawn(process.execPath, [entry], { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] });
  servers.push(server);
  const exited = once(server, "exit").then(([code, signal]) => ({ code, signal }) as Exit);
  let stderr = "";
  server.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
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
  const harness: Harness = {
    server, spool, exited, stderr: () => stderr,
    diagnostics: () => stderr.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>),
    callTool: async (name, args) => (await request("tools/call", { name, arguments: args })).result ?? {},
  };
  if (options.initialize === false) return harness;
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "spool-test", version: "0.0.0" } });
  send({ method: "notifications/initialized" });
  return harness;
}

const exitWithinBound = (harness: Harness): Promise<Exit | "still_running"> => Promise.race([harness.exited, waitFor(EXIT_BOUND_MS, "still_running" as const)]);

async function instanceDirectories(spool: string): Promise<string[]> {
  try { return (await readdir(spool)).filter((name) => /^inst-[0-9a-f]{16}$/.test(name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

async function waitFor_<T>(probe: () => Promise<T | undefined>, label: string): Promise<T> {
  for (const deadline = Date.now() + EXIT_BOUND_MS;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`timeout waiting for ${label}`);
    await waitFor(25);
  }
}

describeWithProcessInspection("server entry point with turn-event delivery", () => {
  it("publishes a turn_terminal event for an aborted turn and removes the spool on stdin EOF", async () => {
    const provider = await holdingProvider();
    const harness = await startServer({ delivery: "spool", baseUrl: provider.baseUrl });
    const capabilities = await harness.callTool("pi_capabilities_get", {});
    expect(capabilities.structuredContent).toMatchObject({ events: { delivery: "spool" } });
    const instance = (await waitFor_(async () => (await instanceDirectories(harness.spool))[0], "instance directory"));
    const started = await harness.callTool("pi_session_start", { workspace: "project" });
    const sessionId = (started.structuredContent as { session: { id: string } }).session.id;
    const prompted = await harness.callTool("pi_session_prompt", { sessionId, prompt: "CANARY_PROMPT_7f3a" });
    const turnId = (prompted.structuredContent as { turn: { turnId: string } }).turn.turnId;
    await waitFor_(async () => (provider.requests.length > 0 ? true : undefined), "model request");
    expect((await readdir(join(harness.spool, instance))).filter((name) => TURN_EVENT_FILE_PATTERN.test(name))).toEqual([]);

    await harness.callTool("pi_session_abort", { sessionId });
    const names = await waitFor_(async () => {
      const found = (await readdir(join(harness.spool, instance))).filter((name) => TURN_EVENT_FILE_PATTERN.test(name));
      return found.length > 0 ? found : undefined;
    }, "turn_terminal file");
    expect(names).toEqual(["00000001-turn_terminal.json"]);
    const text = await readFile(join(harness.spool, instance, names[0]!), "utf8");
    expect(text).not.toContain("CANARY_PROMPT");
    expect(parseTurnEvent(text)).toMatchObject({ kind: "turn_terminal", session: sessionId, turn: turnId, state: "aborted", via: "registry", instance });

    harness.server.stdin.end();
    expect(await exitWithinBound(harness)).toEqual({ code: 0, signal: null });
    expect(await instanceDirectories(harness.spool)).toEqual([]);
    expect(harness.diagnostics()).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it("removes the instance directory on SIGTERM", async () => {
    const harness = await startServer({ delivery: "spool" });
    await waitFor_(async () => (await instanceDirectories(harness.spool))[0], "instance directory");
    signalFixtureProcess(harness.server.pid!, "SIGTERM");
    expect(await exitWithinBound(harness)).toEqual({ code: 143, signal: null });
    expect(await instanceDirectories(harness.spool)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it("resolves the directory from XDG_RUNTIME_DIR when no explicit directory is set", async () => {
    const runtime = await temporaryRoot("pi-session-mcp-spool-xdg-");
    const harness = await startServer({ delivery: "spool", events: { XDG_RUNTIME_DIR: runtime } });
    const events = join(runtime, "pi-session-mcp", "events");
    await waitFor_(async () => (await instanceDirectories(events))[0], "instance directory");
    harness.server.stdin.end();
    expect(await exitWithinBound(harness)).toEqual({ code: 0, signal: null });
    expect(await instanceDirectories(events)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it.each([
    ["neither an explicit directory nor a runtime directory", {}],
    ["a relative explicit directory", { PI_SESSION_MCP_EVENTS_DIR: "relative/events" }],
  ])("fails startup with event_spool_unavailable for %s", async (_label, events) => {
    const harness = await startServer({ delivery: "spool", events, initialize: false });
    expect(await exitWithinBound(harness)).toEqual({ code: 1, signal: null });
    expect(harness.diagnostics()).toEqual([{ level: "error", event: "startup_failed", stage: "startup", code: "event_spool_unavailable" }]);
  }, TEST_TIMEOUT_MS);

  it("changes nothing when delivery is off: no directory, no diagnostic", async () => {
    const harness = await startServer({});
    const capabilities = await harness.callTool("pi_capabilities_get", {});
    expect(capabilities.structuredContent).toMatchObject({ events: { delivery: "off" } });
    harness.server.stdin.end();
    expect(await exitWithinBound(harness)).toEqual({ code: 0, signal: null });
    expect(await instanceDirectories(harness.spool)).toEqual([]);
    await expect(readdir(harness.spool)).rejects.toMatchObject({ code: "ENOENT" });
    expect(harness.diagnostics()).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

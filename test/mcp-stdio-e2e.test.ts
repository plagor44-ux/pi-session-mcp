/**
 * Real-stdio end-to-end evidence for the session MCP bridge.
 *
 * Everything here uses the installed official SDKs over real child processes:
 * `createStdioMcpConnection` (real `Client` + `StdioClientTransport`) and the real
 * `createAgentSession` from Pi. Only the model runtime is scripted, so the tests stay
 * provider-free while transport, discovery, Pi argument validation and Pi tool
 * execution remain the production paths.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as waitFor } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "vitest";
import type { ModelRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ResolvedExecutionProfile } from "../src/execution-profile.js";
import { createStdioMcpConnection } from "../src/mcp-stdio-client.js";
import { connectSessionMcpTools } from "../src/mcp-session-tools.js";
import { SdkPiSessionAdapter } from "../src/sdk-pi-adapter.js";
import { SessionRegistry } from "../src/session-registry.js";
import type { McpServers } from "../src/mcp-config.js";
import { declaredTools, type DeclaringMessage } from "./model-context.js";

const SERVER = fileURLToPath(new URL("./fixtures/mcp-stdio-server.mjs", import.meta.url));
const NODE = process.execPath;
const LOG_HOST_VARIABLE = "PI_SESSION_MCP_TEST_MCP_LOG";
const temporaries: string[] = [];
const fixtureLogs: string[] = [];
const activeClosers: Array<() => Promise<void>> = [];

afterEach(async () => {
  // A failing assertion must not leave an MCP child running for the rest of the job.
  while (activeClosers.length > 0) {
    const close = activeClosers.pop()!;
    try { await close(); } catch { /* best effort */ }
  }
  for (const logPath of fixtureLogs.splice(0)) {
    for (const record of await records(logPath)) {
      if (record.pid === undefined) continue;
      try { process.kill(record.pid, 0); process.kill(record.pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
  delete process.env[LOG_HOST_VARIABLE];
  for (const key of Object.keys(process.env)) if (key.startsWith("PI_SESSION_MCP_TEST_MCP_FIXTURE_")) delete process.env[key];
  while (temporaries.length > 0) await rm(temporaries.pop()!, { recursive: true, force: true });
});

interface Recorded {
  event: string; name?: string; args?: Record<string, unknown>; pid?: number; bytes?: number;
  released?: boolean; configured?: boolean; waitedMs?: number;
}

/**
 * The fixture cannot see `process.env` directly: `envFrom` forwards one named host
 * variable. The log path is therefore handed over through a host variable.
 */
async function scratchFixture(
  tools: Record<string, { name: string; readOnly: boolean }>,
  fixtureEnv: ReadonlyArray<readonly [string, string]> = [],
): Promise<{ log: string; logPath: string; servers: McpServers }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-session-mcp-mcp-"));
  temporaries.push(dir);
  const logPath = join(dir, "calls.jsonl");
  fixtureLogs.push(logPath);
  process.env[LOG_HOST_VARIABLE] = logPath;
  const envFrom: Record<string, string> = { MCP_FIXTURE_LOG: LOG_HOST_VARIABLE };
  for (const [childName, value] of fixtureEnv) {
    const hostName = `PI_SESSION_MCP_TEST_${childName}`;
    process.env[hostName] = value;
    envFrom[childName] = hostName;
  }
  return {
    log: dir,
    logPath,
    servers: { knowledge: { command: NODE, args: [SERVER], envFrom, tools } },
  };
}

async function records(logPath: string): Promise<Recorded[]> {
  const text = await readFile(logPath, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Recorded);
}

/**
 * Real OS process observation. No fake timer can stand in for the kernel reaping a
 * child, so this deliberately polls the recorded pid until it is gone.
 */
async function terminatedWithin(pid: number, milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() >= deadline) return false;
    await waitFor(25);
  }
}

/**
 * Invokes a bridged tool through the production 5-argument `execute` signature.
 * The bridge implementation consumes only the first three; Pi supplies the rest.
 */
function callBridgeTool(tool: ToolDefinition, args: Record<string, unknown>, signal: AbortSignal | undefined) {
  return tool.execute("verify-call", args as never, signal, undefined, undefined as never);
}

function profile(mcpServers: McpServers): ResolvedExecutionProfile {
  return { alias: "verify", permissionProfile: "read-only", provider: "scripted", model: "scripted", thinkingLevel: "off", mcpServers };
}

function assistantMessage(content: unknown[], stopReason: string): unknown {
  return {
    role: "assistant", content, api: "scripted", provider: "scripted", model: "scripted",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 1 },
    stopReason, timestamp: Date.now(),
  };
}

/** Minimal async-iterable event stream matching the Agent's consumption contract. */
function streamOf(final: unknown): unknown {
  let sent = false;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<unknown>> {
          if (sent) return { value: undefined, done: true };
          sent = true;
          return { value: { type: "start", partial: final }, done: false };
        },
      };
    },
    async result(): Promise<unknown> { return final; },
  };
}

/** A promise with external resolvers; the project's ES2023 target predates `Promise.withResolvers`. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = () => { settle(undefined); }; });
  return { promise, resolve };
}

interface Step { tool?: { name: string; arguments: Record<string, unknown> }; text?: string }

/** The subset of Pi's model context that a scripted test needs to inspect. */
interface CapturedMessage extends DeclaringMessage { role?: string; toolName?: string; isError?: boolean; content?: unknown }
interface CapturedContext { messages?: CapturedMessage[] }

/**
 * Scripted provider replaying a queue of assistant messages. Records the tool
 * inventory and the context the model was offered on every call. `onCall` runs
 * before a call's stream is returned, so a test can hold or pace a real
 * agent-loop step.
 */
function scriptedRuntime(
  script: Step[],
  options: { onCall?: (call: number) => void | Promise<void> } = {},
): { runtime: ModelRuntime; toolsSeen: string[][]; contextsSeen: CapturedContext[] } {
  const toolsSeen: string[][] = [];
  const contextsSeen: CapturedContext[] = [];
  // Pi's tools inspect the model's input modalities (the read tool checks `input.includes("image")`),
  // so a scripted model without `input` makes those tools throw instead of running.
  const model = { provider: "scripted", id: "scripted", input: ["text"] };
  let calls = 0;
  const runtime = {
    getProvider: () => ({ id: "scripted" }),
    getModel: () => model,
    checkAuth: async () => true,
    getAuth: async () => ({ token: "synthetic" }),
    getAvailable: async () => [model],
    getAvailableSnapshot: () => [model],
    hasConfiguredAuth: () => true,
    streamSimple: async (_model: unknown, context: CapturedContext) => {
      const call = calls++;
      await options.onCall?.(call);
      toolsSeen.push(declaredTools(context.messages));
      contextsSeen.push(context);
      const step = script[call] ?? { text: "done" };
      if (step.tool) {
        const invocation = { type: "toolCall", id: `call_${call + 1}`, name: step.tool.name, arguments: step.tool.arguments };
        return streamOf(assistantMessage([invocation], "toolUse"));
      }
      return streamOf(assistantMessage([{ type: "text", text: step.text ?? "done" }], "stop"));
    },
  } as unknown as ModelRuntime;
  return { runtime, toolsSeen, contextsSeen };
}

async function openSession(
  servers: McpServers,
  log: string,
  options?: { startupMs?: number; callMs?: number; closeMs?: number },
) {
  const session = await connectSessionMcpTools(servers, "read-only", log, createStdioMcpConnection, options ?? {});
  activeClosers.push(() => session.close());
  return session;
}

function adapterFor(runtime: ModelRuntime): SdkPiSessionAdapter {
  return new SdkPiSessionAdapter({ modelRuntimeFactory: async () => runtime, mcpConnectionFactory: createStdioMcpConnection });
}

/** Bounded condition wait: every wait in this file carries its own deadline. */
async function waitUntil(condition: () => boolean, milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  for (;;) {
    if (condition()) return true;
    if (Date.now() >= deadline) return false;
    await waitFor(5);
  }
}

/** Awaits a barrier that must open; a stuck barrier fails the test instead of stalling the run. */
async function within<T>(promise: Promise<T>, milliseconds: number, what: string): Promise<T> {
  // The platform clock is the only clock this file has: these barriers belong to real child
  // processes, so fake timers cannot stand in for them.
  const deadlineReached = new AbortController();
  const deadline = waitFor(milliseconds, undefined, { signal: deadlineReached.signal }).then(() => {
    throw new Error(`timed out after ${milliseconds}ms waiting for ${what}`);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    deadlineReached.abort();
  }
}

/** Waits for a record written by the real child process, never for a fixed sleep. */
async function waitForRecord(logPath: string, event: string, milliseconds: number): Promise<Recorded> {
  const deadline = Date.now() + milliseconds;
  for (;;) {
    const found = (await records(logPath)).find((record) => record.event === event);
    if (found) return found;
    if (Date.now() >= deadline) throw new Error(`no '${event}' record from the fixture child within ${milliseconds}ms`);
    await waitFor(10);
  }
}

describe("real stdio MCP bridge inside a real Pi session", () => {
  it("activates granted tools, offers them to the model and reaches the child process", async () => {
    const { log, logPath, servers } = await scratchFixture({
      echo: { name: "echo_note", readOnly: true },
      inspect: { name: "artifact_inspect", readOnly: true },
      paged: { name: "paged_note", readOnly: true },
    });
    const { runtime, toolsSeen } = scriptedRuntime([
      { tool: { name: "mcp_knowledge_echo", arguments: { note: "hello" } } },
      { tool: { name: "mcp_knowledge_inspect", arguments: { artifact: { id: "a1", tags: ["t1"] }, options: { deep: true } } } },
      { tool: { name: "mcp_knowledge_paged", arguments: { note: "second-page" } } },
      { text: "finished" },
    ]);
    const handle = await adapterFor(runtime).create({ cwd: log, executionProfile: profile(servers) });
    try {
      assert.equal((await handle.prompt("exercise the granted tools", () => undefined)).status, "completed");

      // Built-ins plus exactly the granted MCP tools, including the later catalog page.
      assert.deepEqual(toolsSeen[0], ["find", "grep", "ls", "mcp_knowledge_echo", "mcp_knowledge_inspect", "mcp_knowledge_paged", "read"].sort());
      assert.ok(!toolsSeen[0]!.includes("mcp_knowledge_secret_admin"), "ungranted tool must not be offered to the model");

      // Every call really crossed the process boundary with Pi-validated arguments.
      const calls = (await records(logPath)).filter((record) => record.event === "tools/call");
      assert.deepEqual(calls.map((call) => call.name), ["echo_note", "artifact_inspect", "paged_note"]);
      assert.deepEqual(calls[1]!.args, { artifact: { id: "a1", tags: ["t1"] }, options: { deep: true } });
    } finally {
      await handle.dispose();
    }
  }, 60_000);

  it("never forwards invalid arguments to the external server", async () => {
    const { log, logPath, servers } = await scratchFixture({ inspect: { name: "artifact_inspect", readOnly: true } });
    const { runtime, toolsSeen } = scriptedRuntime([
      { tool: { name: "mcp_knowledge_inspect", arguments: { artifact: "not-an-object" } } },
      { tool: { name: "mcp_knowledge_inspect", arguments: { artifact: { id: "a1", unexpected: true } } } },
      { tool: { name: "mcp_knowledge_inspect", arguments: {} } },
      { text: "finished" },
    ]);
    const handle = await adapterFor(runtime).create({ cwd: log, executionProfile: profile(servers) });
    try {
      await handle.prompt("send malformed arguments", () => undefined);
      assert.ok(toolsSeen.length >= 4, "the model kept being offered the tool after rejections");
      assert.deepEqual((await records(logPath)).filter((record) => record.event === "tools/call"), []);
    } finally {
      await handle.dispose();
    }
  }, 60_000);

  it("refuses a model-issued call to an ungranted tool without contacting the server", async () => {
    const { log, logPath, servers } = await scratchFixture({ echo: { name: "echo_note", readOnly: true } });
    const { runtime } = scriptedRuntime([
      { tool: { name: "mcp_knowledge_secret_admin", arguments: { note: "ungranted" } } },
      { text: "finished" },
    ]);
    const handle = await adapterFor(runtime).create({ cwd: log, executionProfile: profile(servers) });
    try {
      assert.equal((await handle.prompt("try an ungranted tool", () => undefined)).status, "completed");
      assert.deepEqual((await records(logPath)).filter((record) => record.event === "tools/call"), [],
        "an ungranted tool name must never reach the external server");
    } finally {
      await handle.dispose();
    }
  }, 60_000);

  it("fails closed on a missing grant and terminates the child it already started", async () => {
    const { log, logPath, servers } = await scratchFixture({ echo: { name: "echo_note", readOnly: true }, ghost: { name: "does_not_exist", readOnly: true } });
    await assert.rejects(
      () => adapterFor(scriptedRuntime([]).runtime).create({ cwd: log, executionProfile: profile(servers) }),
      { code: "external_mcp_grant_tool_missing" },
    );
    const started = (await records(logPath)).find((record) => record.event === "connected");
    assert.ok(started?.pid, "the fixture child started before the grant check failed");
    assert.ok(await terminatedWithin(started.pid!, 5_000), "the started child must not survive a failed session start");
  }, 60_000);
  it("classifies real empty, looping and capability-less discovery and reaps each child", async () => {
    for (const scenario of [
      { env: [["MCP_FIXTURE_EMPTY_TOOLS", "1"]] as const, code: "external_mcp_no_tools" },
      { env: [["MCP_FIXTURE_CURSOR_LOOP", "1"]] as const, code: "external_mcp_unavailable" },
      { env: [["MCP_FIXTURE_NO_TOOLS_CAPABILITY", "1"]] as const, code: "external_mcp_unavailable" },
    ]) {
      const { log, logPath, servers } = await scratchFixture(
        { echo: { name: "echo_note", readOnly: true } },
        scenario.env,
      );
      await assert.rejects(
        () => adapterFor(scriptedRuntime([]).runtime).create({ cwd: log, executionProfile: profile(servers) }),
        { code: scenario.code },
      );
      const started = (await records(logPath)).find((record) => record.pid !== undefined);
      assert.ok(started?.pid, "the fixture child must reach the real stdio handshake");
      assert.ok(await terminatedWithin(started.pid, 5_000), "failed discovery must reap its child process");
    }
  }, 60_000);

  it("closes one session without disturbing a second real session", async () => {
    const { log, logPath, servers } = await scratchFixture({ echo: { name: "echo_note", readOnly: true } });
    const runtime = scriptedRuntime([{ tool: { name: "mcp_knowledge_echo", arguments: { note: "second" } } }, { text: "finished" }]).runtime;
    const adapter = adapterFor(runtime);
    const first = await adapter.create({ cwd: log, executionProfile: profile(servers) });
    const second = await adapter.create({ cwd: log, executionProfile: profile(servers) });
    const children = (await records(logPath)).filter((record) => record.event === "connected");
    assert.equal(children.length, 2, "each session owns its own child process");

    await first.dispose();
    assert.ok(await terminatedWithin(children[0]!.pid!, 5_000), "the closed session's child must exit");

    assert.equal((await second.prompt("still usable", () => undefined)).status, "completed");
    const calls = (await records(logPath)).filter((record) => record.event === "tools/call");
    assert.deepEqual(calls.map((call) => call.name), ["echo_note"]);
    assert.ok(children[1]!.pid !== children[0]!.pid);
    await second.dispose();
    assert.ok(await terminatedWithin(children[1]!.pid!, 5_000), "the second session's child must exit after its own close");
  }, 60_000);
});

describe("real stdio transport, error and lifecycle behavior", () => {
  it("reports an MCP isError result as a failed tool execution", async () => {
    const { log, servers } = await scratchFixture({ failure: { name: "fail_note", readOnly: true } });
    const session = await openSession(servers, log);
    try {
      const tool = session.tools.find((candidate) => candidate.name === "mcp_knowledge_failure");
      assert.ok(tool, "the granted tool is exposed");
      await assert.rejects(() => callBridgeTool(tool, { note: "x" }, undefined), /External MCP operation failed/);
    } finally {
      await session.close();
    }
  }, 30_000);

  it("rejects structured output that violates a manually discovered tool schema", async () => {
    const { log, logPath, servers } = await scratchFixture(
      { inspect: { name: "artifact_inspect", readOnly: true } },
      [["MCP_FIXTURE_PAGE_SIZE", "1"], ["MCP_FIXTURE_INVALID_STRUCTURED_OUTPUT", "1"]],
    );
    const session = await openSession(servers, log);
    try {
      const tool = session.tools.find((candidate) => candidate.name === "mcp_knowledge_inspect");
      assert.ok(tool);
      await assert.rejects(
        () => callBridgeTool(tool, { artifact: { id: "a1" } }, undefined),
        /External MCP operation failed/,
      );
      assert.deepEqual((await records(logPath)).filter((record) => record.event === "tools/call").map((record) => record.name), ["artifact_inspect"]);
    } finally {
      await session.close();
    }
  }, 30_000);

  it("sanitizes a server-side JSON-RPC error instead of relaying its message", async () => {
    const { log, servers } = await scratchFixture({ broken: { name: "error_note", readOnly: true } });
    const session = await openSession(servers, log);
    try {
      const tool = session.tools.find((candidate) => candidate.name === "mcp_knowledge_broken");
      assert.ok(tool);
      const error = await callBridgeTool(tool, { note: "x" }, undefined).then(
        () => undefined,
        (cause: unknown) => cause as Error,
      );
      assert.ok(error, "a protocol error must not become a successful result");
      assert.equal(error.message, "External MCP operation failed");
      assert.ok(!JSON.stringify({ message: error.message, stack: error.stack }).includes("SYNTHETIC_SERVER_ERROR_MARKER"),
        "the raw server message must not leak through the failure");
    } finally {
      await session.close();
    }
  }, 30_000);

  it("fails the call and reaps the child when the server dies mid-request", async () => {
    const { log, logPath, servers } = await scratchFixture({ crash: { name: "crash_note", readOnly: true } });
    const session = await openSession(servers, log);
    const pid = (await records(logPath)).find((record) => record.event === "connected")?.pid;
    assert.ok(pid);
    try {
      const tool = session.tools.find((candidate) => candidate.name === "mcp_knowledge_crash");
      assert.ok(tool);
      await assert.rejects(() => callBridgeTool(tool, { note: "x" }, undefined), /External MCP operation failed/);
    } finally {
      await session.close();
    }
    assert.ok(await terminatedWithin(pid, 5_000), "the crashed child must not linger");
  }, 30_000);

  it("ends only the local wait on cancellation and keeps the child alive", async () => {
    const { log, logPath, servers } = await scratchFixture({ slow: { name: "slow_note", readOnly: true } });
    const session = await openSession(servers, log, { callMs: 8_000 });
    const pid = (await records(logPath)).find((record) => record.event === "connected")?.pid;
    assert.ok(pid);
    try {
      const tool = session.tools.find((candidate) => candidate.name === "mcp_knowledge_slow");
      assert.ok(tool);
      const controller = new AbortController();
      const started = Date.now();
      const pending = callBridgeTool(tool, { note: "x" }, controller.signal);
      void waitFor(50).then(() => controller.abort());
      await assert.rejects(() => pending, /External MCP operation failed/);
      assert.ok(Date.now() - started < 5_000, "cancellation must not wait for the remote call to finish");
      // The server is still running: cancellation is not a rollback of remote work.
      assert.doesNotThrow(() => process.kill(pid, 0), "the child must survive a local-only cancellation");
    } finally {
      await session.close();
    }
    assert.ok(await terminatedWithin(pid, 5_000), "closing still terminates the child");
  }, 30_000);

  it("bounds a call by its own deadline and still admits later calls", async () => {
    const { log, servers } = await scratchFixture({
      slow: { name: "slow_note", readOnly: true },
      echo: { name: "echo_note", readOnly: true },
    });
    const session = await openSession(servers, log, { callMs: 250 });
    try {
      const slow = session.tools.find((candidate) => candidate.name === "mcp_knowledge_slow");
      const echo = session.tools.find((candidate) => candidate.name === "mcp_knowledge_echo");
      assert.ok(slow && echo);
      await assert.rejects(() => callBridgeTool(slow, { note: "x" }, undefined), /External MCP operation failed/);
      const result = await callBridgeTool(echo, { note: "after-timeout" }, undefined);
      assert.deepEqual(result.content[0], { type: "text", text: "note:after-timeout" });
    } finally {
      await session.close();
    }
  }, 30_000);

  it("fails a session whose server misses the startup budget and reaps the child", async () => {
    // Timing assumption: the fixture must record its pid before the budget
    // expires, and the controller must reject before the delayed `initialize` answer.
    // Controller and child are scheduled independently: timeout handling can be delayed
    // while the child's initialize timer completes. A 30 s delay gives a nominal 27 s
    // margin around the 3 s budget; verify this ordering in reserved-load runs.
    // PID recording needed up to 1.13 s with four CPU hogs per core (measured 2026-09-30),
    // so 300 ms raced the child's startup; 3 s preserves that startup margin.
    const { log, logPath, servers } = await scratchFixture(
      { echo: { name: "echo_note", readOnly: true } },
      [["MCP_FIXTURE_DELAY_INIT_MS", "30000"]],
    );
    await assert.rejects(
      () => openSession(servers, log, { startupMs: 3_000 }),
      /External MCP operation failed/,
    );
    const pid = (await records(logPath)).find((record) => record.event === "connected")?.pid;
    assert.ok(pid, "the fixture records its pid as soon as the transport connects");
    assert.ok(await terminatedWithin(pid, 5_000), "the child must be reaped after the startup budget expires");
  }, 30_000);

  it("escalates to SIGKILL for a child that ignores EOF and SIGTERM", async () => {
    const { log, logPath, servers } = await scratchFixture(
      { echo: { name: "echo_note", readOnly: true } },
      [["MCP_FIXTURE_IGNORE_EOF", "1"], ["MCP_FIXTURE_IGNORE_SIGTERM", "1"]],
    );
    const session = await openSession(servers, log);
    const pid = (await records(logPath)).find((record) => record.event === "connected")?.pid;
    assert.ok(pid, "the stubborn child started");
    await session.close();
    const events = (await records(logPath)).map((record) => record.event);
    assert.ok(events.includes("eof-ignored"), "stdin EOF must not end a stubborn child");
    assert.ok(events.includes("sigterm-ignored"), "SIGTERM must have been delivered and ignored");
    // A SIGKILL ends the process without running its exit handler, so an absent
    // `exit` record distinguishes escalation from a cooperative exit.
    assert.ok(!events.includes("exit"), "the child must end by SIGKILL, not by a clean exit");
    assert.ok(await terminatedWithin(pid, 10_000), "the escalation path must still end the child");
  }, 30_000);

  it("closes cleanly while a call is still running", async () => {
    const { log, logPath, servers } = await scratchFixture({ slow: { name: "slow_note", readOnly: true } });
    const session = await openSession(servers, log, { callMs: 8_000 });
    const pid = (await records(logPath)).find((record) => record.event === "connected")?.pid;
    assert.ok(pid);
    const tool = session.tools.find((candidate) => candidate.name === "mcp_knowledge_slow");
    assert.ok(tool);
    const pending = callBridgeTool(tool, { note: "x" }, undefined);
    pending.catch(() => undefined);
    await waitFor(50);
    await session.close();
    await assert.rejects(() => pending, /External MCP operation failed/);
    await assert.rejects(() => callBridgeTool(tool, { note: "late" }, undefined), /External MCP operation failed/);
    assert.ok(await terminatedWithin(pid, 10_000), "shutdown ends the child");
  }, 30_000);
});

describe("data flow across real process boundaries", () => {
  it("drains child stderr instead of copying it into controller output", async () => {
    const { log, logPath, servers } = await scratchFixture({ echo: { name: "echo_note", readOnly: true } });
    const captured: string[] = [];
    const originalOut = process.stdout.write.bind(process.stdout);
    const originalErr = process.stderr.write.bind(process.stderr);
    const capture = (chunk: unknown): boolean => { captured.push(String(chunk)); return true; };
    process.stdout.write = capture as typeof process.stdout.write;
    process.stderr.write = capture as typeof process.stderr.write;
    try {
      const session = await openSession(servers, log);
      const tool = session.tools.find((candidate) => candidate.name === "mcp_knowledge_echo");
      assert.ok(tool);
      await callBridgeTool(tool, { note: "x" }, undefined);
      await session.close();
    } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    }
    const emitted = (await records(logPath)).filter((record) => record.event === "stderr_marker");
    assert.ok(emitted.length >= 1 && emitted.every((record) => (record.bytes ?? 0) > 0),
      "the child really wrote the marker to its own stderr");
    assert.equal(captured.join("").includes("MCP_FIXTURE_STDERR_MARKER"), false,
      "child diagnostics must not be relayed into controller output");
    // Residual gap: this observes the parent's write streams. A transport configured
    // with `stderr: "inherit"` would bypass them straight to the parent's fd 2, which
    // is not observable from inside this process. The piping itself is asserted by
    // inspection of src/mcp-stdio-client.ts, not here.
  }, 30_000);

  it("rejects a missing envFrom source without starting a child process", async () => {
    const { log, logPath, servers } = await scratchFixture({ echo: { name: "echo_note", readOnly: true } });
    delete process.env[LOG_HOST_VARIABLE];
    const missing: McpServers = {
      knowledge: { ...servers.knowledge!, envFrom: { MCP_FIXTURE_LOG: "PI_SESSION_MCP_ABSENT_SOURCE" } },
    };
    const error = await connectSessionMcpTools(missing, "read-only", log, createStdioMcpConnection).then(
      () => undefined,
      (cause: unknown) => cause as Error,
    );
    assert.ok(error, "a missing environment source must fail the session");
    assert.equal(error.message, "External MCP operation failed");
    assert.equal(error.message.includes("PI_SESSION_MCP_ABSENT_SOURCE"), false, "the variable name must not leak");
    assert.deepEqual(await records(logPath), [], "no child process may be started");
  }, 30_000);
});

describe("running-turn liveness in a real embedded session", () => {
  /**
   * This exercises the real embedded Pi event path together with the real stdio MCP bridge.
   *
   * An earlier version of this test slept before the first model step and asserted
   * `updatedAt > startedAt`, which the assistant-message emission alone can satisfy, so the
   * advance it observed was not attributable to the completed tool execution. Every phase
   * boundary here is instead an explicit barrier: an external tool stays in flight until the
   * harness releases it, so the running stamp read while it is held provably excludes the
   * tool's completion, and the advance observed while the following model step is held
   * provably comes from nothing but that completion.
   */
  it("advances a running turn only when a held real tool execution completes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-session-mcp-activity-"));
    temporaries.push(cwd);
    const marker = "SECRET_WORKSPACE_NOTE_MARKER";
    const argumentMarker = "SECRET_HELD_TOOL_ARGUMENT_MARKER";
    await writeFile(join(cwd, "note.txt"), `${marker}\n`);
    const releaseHeldTool = join(cwd, "release-held-tool");
    const { logPath, servers } = await scratchFixture(
      { hold: { name: "hold_note", readOnly: true } },
      [["MCP_FIXTURE_HOLD_RELEASE_FILE", releaseHeldTool]],
    );

    const modelStepAfterTool = deferred();
    const releaseModelStep = deferred();
    let turnStartedAt: string | undefined;
    const { runtime, contextsSeen } = scriptedRuntime(
      [
        { tool: { name: "read", arguments: { path: "note.txt" } } },
        { tool: { name: "mcp_knowledge_hold", arguments: { note: argumentMarker } } },
        { text: "first turn" },
        { text: "second turn" },
      ],
      {
        onCall: async (call) => {
          // The turn start stamp is read in whole milliseconds: wait for that millisecond on a
          // deadline instead of hoping that a fixed sleep is long enough.
          if (call === 0) await waitUntil(() => {
            const startedAt = turnStartedAt;
            return startedAt !== undefined && Date.now() > Date.parse(startedAt);
          }, 5_000);
          // Hold the model step that follows the released tool, so the running view is observed
          // after the tool completed and before any later assistant emission.
          if (call === 2) { modelStepAfterTool.resolve(); await releaseModelStep.promise; }
        },
      },
    );

    const registry = new SessionRegistry(adapterFor(runtime), new Map([["repo", cwd]]));
    const session = await registry.start("repo", profile(servers));
    const terminalState = async (turnId: string) => {
      let turn = registry.getTurn(session.id, turnId);
      const deadline = Date.now() + 20_000;
      while (turn.state === "running" && Date.now() < deadline) { await waitFor(2); turn = registry.getTurn(session.id, turnId); }
      return turn;
    };
    try {
      const accepted = await registry.prompt(session.id, "read the note and then call the held tool");
      turnStartedAt = accepted.turn.startedAt;

      // Barrier 1: the assistant's tool request has ended and the external tool is in flight.
      await waitForRecord(logPath, "hold-start", 30_000);
      const inFlight = registry.getTurn(session.id, accepted.turn.turnId);
      assert.equal(inFlight.state, "running");
      const inFlightStamp = inFlight.updatedAt;
      assert.ok(Date.parse(inFlightStamp) > Date.parse(accepted.turn.startedAt),
        `the running stamp must already be past the turn start before the held tool completes (${inFlightStamp} vs ${accepted.turn.startedAt})`);

      // Barrier 2: release the held tool. Pi then reaches its next model step, which stays held,
      // so the running view can be read after tool_execution_end and before any later event.
      await writeFile(releaseHeldTool, "released\n");
      await within(modelStepAfterTool.promise, 30_000, "the model step after the released tool");
      const holdEnd = (await records(logPath)).find((record) => record.event === "hold-end");
      assert.ok(holdEnd, "the held call must record its own end");
      assert.equal(holdEnd.released, true, "the held call ended because the harness released it, not on its budget");

      const polled: string[] = [];
      for (let poll = 0; poll < 3; poll += 1) {
        const running = registry.getTurn(session.id, accepted.turn.turnId);
        assert.equal(running.state, "running");
        assert.equal(running.turnId, accepted.turn.turnId);
        assert.deepEqual(Object.keys(running).sort(), ["sessionId", "startedAt", "state", "turnId", "updatedAt"],
          "the running view carries no progress content or new fields");
        polled.push(running.updatedAt);
        await waitFor(2);
      }
      const completedToolStamp = polled[0]!;
      assert.ok(polled.every((stamp) => stamp === completedToolStamp), "polling a running turn never mutates its stamps");
      assert.ok(Date.parse(completedToolStamp) > Date.parse(inFlightStamp),
        `the completed external tool execution must advance the running stamp beyond the stamp read while it was held (held=${inFlightStamp}, completed=${completedToolStamp}, startedAt=${accepted.turn.startedAt})`);

      // Barrier 3: release the held model step and observe the terminal transition.
      releaseModelStep.resolve();
      const terminal = await terminalState(accepted.turn.turnId);
      assert.equal(terminal.state, "completed");
      assert.equal(terminal.assistantText, "first turn");
      assert.deepEqual(Object.keys(terminal).sort(),
        ["assistantText", "completedAt", "sessionId", "startedAt", "state", "truncated", "turnId", "updatedAt"]);
      assert.ok(Date.parse(terminal.completedAt!) >= Date.parse(completedToolStamp));

      // Positive control for the negative assertions below: the marker really was transported
      // through the read tool into the next model step, so its absence from the turn view is not
      // the vacuous result of a file nobody read.
      const nextContext = contextsSeen[1];
      assert.ok(nextContext, "the model step after the read received a context");
      const readResult = (nextContext.messages ?? []).find((message) =>
        message.role === "toolResult" && message.toolName === "read" && JSON.stringify(message.content).includes(marker));
      assert.ok(readResult, "the sensitive marker must arrive as a real read tool result");
      assert.equal(readResult.isError, false, "the transported read result must not be a failure");
      assert.equal(JSON.stringify(terminal).includes(marker), false, "the read tool result must not reach the turn view");
      assert.equal(JSON.stringify(terminal).includes(argumentMarker), false, "tool arguments must not reach the turn view");

      // The real child process served exactly the held call, with the arguments the model sent.
      const fixtureCalls = (await records(logPath)).filter((record) => record.event === "tools/call");
      assert.deepEqual(fixtureCalls.map((record) => record.name), ["hold_note"]);
      assert.equal(JSON.stringify(fixtureCalls).includes(argumentMarker), true,
        "the held call crossed the process boundary with its arguments");

      const second = await registry.prompt(session.id, "read it again");
      const secondTerminal = await terminalState(second.turn.turnId);
      assert.equal(secondTerminal.state, "completed");
      assert.equal(secondTerminal.assistantText, "second turn");
      assert.equal(JSON.stringify(secondTerminal).includes(marker), false);
      assert.ok(Date.parse(secondTerminal.updatedAt) >= Date.parse(second.turn.startedAt));
    } finally {
      // Whatever failed above, leave no barrier closed and no session or child process behind.
      releaseModelStep.resolve();
      await writeFile(releaseHeldTool, "cleanup\n").catch(() => undefined);
      await registry.close(session.id);
    }
  }, 60_000);
});

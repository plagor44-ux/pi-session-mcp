import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { AgentSession, CreateAgentSessionOptions, CreateAgentSessionResult, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { configSchema } from "../src/config.js";
import type { ResolvedExecutionProfile } from "../src/execution-profile.js";
import type { McpConnection } from "../src/mcp-session-tools.js";
import { projectCapabilities } from "../src/capabilities.js";
import { PROFILE_TOOLS, SdkPiSessionAdapter, type SdkPiAdapterDiagnostic } from "../src/sdk-pi-adapter.js";

const profile: ResolvedExecutionProfile = { alias: "knowledge", permissionProfile: "read-only", provider: "fake", model: "fake", thinkingLevel: "off", mcpServers: {
  knowledge: { command: process.execPath, args: ["/operator/SECRET-server.mjs"], envFrom: { TOKEN: "SECRET_ENV_NAME" }, tools: { search: { name: "search_knowledge", readOnly: true } } },
} };
function fixture() {
  const model = { provider: "fake", id: "fake" } as NonNullable<CreateAgentSessionOptions["model"]>;
  const runtime = {
    getProvider: () => ({ id: "fake" }), getModel: () => model, checkAuth: async () => true,
    getAuth: async () => ({ token: "SECRET" }), getAvailable: async () => [model],
  } as unknown as ModelRuntime;
  const state = { connections: 0, closed: 0, disposed: 0, active: [...PROFILE_TOOLS["read-only"], "mcp_knowledge_search"], options: undefined as CreateAgentSessionOptions | undefined };
  const diagnostics: SdkPiAdapterDiagnostic[] = [];
  const connection: McpConnection = {
    async connect() {}, async listTools() { return { tools: [{ name: "search_knowledge", inputSchema: { type: "object" } }] }; },
    async callTool() { return { content: [{ type: "text", text: "found" }] }; }, async close() { state.closed++; },
  };
  const session = {
    sessionId: "fake", model, thinkingLevel: "off", getActiveToolNames: () => state.active,
    subscribe: () => () => undefined, prompt: async () => undefined, abort: async () => undefined,
    dispose: () => { state.disposed++; },
  } as unknown as AgentSession;
  const options = {
    modelRuntimeFactory: async () => runtime,
    createSession: async (value: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => { state.options = value; return { session } as CreateAgentSessionResult; },
    mcpConnectionFactory: () => { state.connections++; return connection; },
    diagnosticSink: (value: SdkPiAdapterDiagnostic) => { diagnostics.push(value); },
  };
  return { runtime, state, diagnostics, connection, session, options };
}
const create = (adapter: SdkPiSessionAdapter, executionProfile = profile) => adapter.create({ cwd: process.cwd(), executionProfile });

describe("MCP config and SDK adapter wiring (provider-free)", () => {
  it("accepts explicit read grants while preserving the ordinary config", () => {
    const { alias: _alias, ...configured } = profile;
    const value = { workspaces: { project: "." }, executionProfiles: { knowledge: { ...configured, default: true } } };
    assert.equal(configSchema.safeParse(value).success, true);
    const write = { ...value, executionProfiles: { knowledge: { ...value.executionProfiles.knowledge, mcpServers: { knowledge: { ...profile.mcpServers!.knowledge, tools: { remove: { name: "remove", readOnly: false } } } } } } };
    assert.equal(configSchema.safeParse(write).success, false);
    assert.equal(configSchema.safeParse({ workspaces: { project: "." }, executionProfiles: { safe: { default: true, permissionProfile: "read-only", provider: "fake", model: "fake", thinkingLevel: "off" } } }).success, true);
  });
  it("does not expose MCP configuration through capabilities", () => {
    const capabilities = projectCapabilities(
      new Map([["project", "/SECRET/workspace"]]),
      new Map([[profile.alias, { ...profile, default: true }]]),
      { fingerprint: "sha256:0000000000000000000000000000000000000000000000000000000000000000", reloadPolicy: "restart-required" },
    );
    assert.equal(JSON.stringify(capabilities).includes("SECRET"), false);
    assert.equal(JSON.stringify(capabilities).includes("mcpServers"), false);
  });
  it("registers and explicitly activates granted tools before returning a handle", async () => {
    const f = fixture(); const handle = await create(new SdkPiSessionAdapter(f.options));
    assert.deepEqual(f.state.options!.tools, [...PROFILE_TOOLS["read-only"], "mcp_knowledge_search"]);
    assert.deepEqual(f.state.options!.customTools!.map((tool) => tool.name), ["mcp_knowledge_search"]);
    assert.equal(f.state.options!.resourceLoader!.getExtensions().extensions.length, 0);
    const result = await f.state.options!.customTools![0]!.execute("call", {}, undefined, undefined, {} as never);
    assert.deepEqual(result.content, [{ type: "text", text: "found" }]);
    await handle.dispose(); assert.equal(f.state.closed, 1); assert.equal(f.state.disposed, 1);
    await handle.dispose(); assert.equal(f.state.closed, 1); assert.equal(f.state.disposed, 1);
  });
  it("shares disposal across a re-entrant subscription cleanup", async () => {
    const f = fixture(); const handle = await create(new SdkPiSessionAdapter(f.options));
    let reentrant: void | Promise<void>;
    f.session.subscribe = () => () => { reentrant = handle.dispose(); };
    const prompt = handle.prompt("test", () => undefined);
    const closing = handle.dispose(); assert.equal(closing, reentrant!);
    await closing; await prompt; assert.equal(f.state.closed, 1); assert.equal(f.state.disposed, 1);
  });
  it("leaves an unconfigured session unchanged and creates no external client", async () => {
    const f = fixture(); const { mcpServers: _servers, ...ordinary } = profile;
    const handle = await create(new SdkPiSessionAdapter(f.options), ordinary);
    assert.equal(f.state.connections, 0); assert.equal(f.state.options!.customTools, undefined);
    assert.deepEqual(f.state.options!.tools, PROFILE_TOOLS["read-only"]); await handle.dispose();
  });
  it("fails closed if the SDK omits or adds an active tool", async () => {
    for (const active of [
      [...PROFILE_TOOLS["read-only"]],
      [...PROFILE_TOOLS["read-only"], "mcp_knowledge_search", "unexpected_tool"],
    ]) {
      const f = fixture(); f.state.active = active;
      await assert.rejects(create(new SdkPiSessionAdapter(f.options)), { code: "external_mcp_activation_mismatch" });
      assert.equal(f.state.closed, 1); assert.equal(f.state.disposed, 1);
      assert.equal(f.diagnostics[0]?.code, "external_mcp_activation_mismatch");
    }
  });
  it("cleans external connections when SDK creation rejects", async () => {
    const f = fixture();
    await assert.rejects(create(new SdkPiSessionAdapter({ ...f.options, createSession: async () => { throw new Error("SECRET"); } })), { code: "pi_session_creation_failed" });
    assert.equal(f.state.closed, 1);
  });
  it("cleans external connections on model postcheck failure", async () => {
    const f = fixture(); Object.defineProperty(f.session, "model", { value: { provider: "fake", id: "wrong" } });
    await assert.rejects(create(new SdkPiSessionAdapter(f.options)), { code: "execution_selection_mismatch" });
    assert.equal(f.state.closed, 1); assert.equal(f.state.disposed, 1);
  });
  it("maps trusted discovery classifications with bounded local diagnostics", async () => {
    const empty = fixture();
    empty.connection.listTools = async () => ({ tools: [] });
    await assert.rejects(create(new SdkPiSessionAdapter(empty.options)), { code: "external_mcp_no_tools" });
    assert.deepEqual(empty.diagnostics[0], {
      level: "error",
      event: "pi_session_creation_failed",
      stage: "mcp_tools",
      code: "external_mcp_no_tools",
      executionProfile: "knowledge",
      provider: "fake",
      model: "fake",
      thinkingLevel: "off",
      serverAlias: "knowledge",
      discoveredToolCount: 0,
    });
    assert.equal(empty.state.options, undefined); assert.equal(empty.state.closed, 1);

    const missing = fixture();
    missing.connection.listTools = async () => ({
      tools: [{ name: "different_tool", inputSchema: { type: "object" } }],
    });
    await assert.rejects(create(new SdkPiSessionAdapter(missing.options)), { code: "external_mcp_grant_tool_missing" });
    assert.deepEqual(missing.diagnostics[0], {
      level: "error",
      event: "pi_session_creation_failed",
      stage: "mcp_tools",
      code: "external_mcp_grant_tool_missing",
      executionProfile: "knowledge",
      provider: "fake",
      model: "fake",
      thinkingLevel: "off",
      serverAlias: "knowledge",
      toolAlias: "search",
      discoveredToolCount: 1,
    });
    assert.equal(missing.state.options, undefined); assert.equal(missing.state.closed, 1);
  });
  it("sanitizes foreign MCP startup errors and does not create a partial SDK session", async () => {
    const f = fixture();
    f.connection.connect = async () => {
      throw Object.assign(new Error("SECRET /private/path"), {
        code: "external_mcp_no_tools",
        cause: { token: "SECRET_CAUSE" },
        stderr: "SECRET_CHILD_STDERR",
      });
    };
    await assert.rejects(create(new SdkPiSessionAdapter(f.options)), { code: "external_mcp_unavailable" });
    assert.equal(f.state.options, undefined); assert.equal(f.state.closed, 1);
    assert.deepEqual(f.diagnostics[0], {
      level: "error",
      event: "pi_session_creation_failed",
      stage: "mcp_tools",
      code: "external_mcp_unavailable",
      executionProfile: "knowledge",
      provider: "fake",
      model: "fake",
      thinkingLevel: "off",
      serverAlias: "knowledge",
    });
    assert.equal(JSON.stringify(f.diagnostics).includes("SECRET"), false);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { configuredMcpToolNames, isMcpServers, snapshotMcpServers, type McpServers } from "../src/mcp-config.js";
import { toResolvedExecutionProfile } from "../src/execution-profile.js";
import {
  classifyMcpStartupError,
  connectSessionMcpTools,
  type McpCallResult,
  type McpConnection,
  type McpConnectionFactory,
  type McpRemoteTool,
  type McpStartupFailure,
} from "../src/mcp-session-tools.js";

const schema = { type: "object" as const, properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false };
const remote: McpRemoteTool = { name: "search_knowledge", description: "Search knowledge", inputSchema: schema };
const configured = (): McpServers => ({ knowledge: {
  command: "/usr/bin/node", args: ["/operator/server.mjs"], envFrom: { API_KEY: "KNOWLEDGE_API_KEY" },
  tools: { search: { name: remote.name, readOnly: true } },
} });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function fixture() {
  const calls: { name: string; args: Record<string, unknown>; signal: AbortSignal }[] = [];
  let closed = 0;
  const connection: McpConnection = {
    async connect() {},
    async listTools() { return { tools: [remote, { ...remote, name: "delete_knowledge" }] }; },
    async callTool(name, args, signal) { calls.push({ name, args, signal }); return { content: [{ type: "text", text: "found" }] }; },
    async close() { closed++; },
  };
  return { connection, calls, closed: () => closed };
}
function execute(tool: ToolDefinition, signal?: AbortSignal) {
  return tool.execute("call-1", { query: "test" }, signal, undefined, {} as Parameters<ToolDefinition["execute"]>[4]);
}
async function rejectedStartup(operation: Promise<unknown>): Promise<McpStartupFailure> {
  try {
    await operation;
    assert.fail("MCP startup unexpectedly succeeded");
  } catch (error) {
    const classified = classifyMcpStartupError(error);
    assert.ok(classified, "startup failure must carry a trusted classification");
    return classified;
  }
}

const sourceTooLargeMessage = JSON.stringify({
  code: "SOURCE_TOO_LARGE",
  message: "Requested source exceeds the response limit; increase maxBytes.",
});
const resultLimitMessage = "External MCP result exceeds the bridge limit of 262144 bytes; request less data.";
async function assertToolFailure(result: McpCallResult, message: string): Promise<void> {
  const f = fixture();
  f.connection.callTool = async () => result;
  const session = await connectSessionMcpTools(configured(), "read-only", "/workspace", () => f.connection);
  try { await assert.rejects(execute(session.tools[0]!), { message }); }
  finally { await session.close(); }
}

describe("external MCP error projection", () => {
  it("preserves SOURCE_TOO_LARGE from JSON text using only the controller message", async () => {
    await assertToolFailure({
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ code: "SOURCE_TOO_LARGE", message: "ordinary leakmarker" }) }],
    }, sourceTooLargeMessage);
  });
  it("preserves SOURCE_TOO_LARGE from structured content using only the controller message", async () => {
    await assertToolFailure({
      isError: true,
      content: [],
      structuredContent: { code: "SOURCE_TOO_LARGE", message: "ordinary leakmarker" },
    }, sourceTooLargeMessage);
  });
  it("accepts matching representations and escaped keys in either order", async () => {
    const structuredContent = { code: "SOURCE_TOO_LARGE", message: "ordinary leakmarker" };
    await assertToolFailure({
      isError: true,
      content: [{ type: "text", text: ' \n{ "message" : "ordinary leakmarker", "co\\u0064e" : "SOURCE_TOO_LARGE" }\t' }],
      structuredContent,
    }, sourceTooLargeMessage);
  });
  it("bounds the complete UTF-8 result envelope, including JSON-text whitespace", async () => {
    const result = {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ code: "SOURCE_TOO_LARGE", message: "ordinary leakmarker" }) }],
    };
    const block = result.content[0]!;
    block.text += " ".repeat(1024 - Buffer.byteLength(JSON.stringify(result), "utf8"));
    assert.equal(Buffer.byteLength(JSON.stringify(result), "utf8"), 1024);
    await assertToolFailure(result, sourceTooLargeMessage);
    block.text += " ";
    assert.equal(Buffer.byteLength(JSON.stringify(result), "utf8"), 1025);
    await assertToolFailure(result, "External MCP operation failed");
  });
  it("counts Unicode message characters and enforces bytes across both representations", async () => {
    const structuredContent = { code: "SOURCE_TOO_LARGE", message: "😀".repeat(200) };
    await assertToolFailure({ isError: true, content: [], structuredContent }, sourceTooLargeMessage);
    const both = { isError: true, content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
    assert.ok(Buffer.byteLength(JSON.stringify(both), "utf8") > 1024);
    await assertToolFailure(both, "External MCP operation failed");
  });
  it.each([
    ["non-JSON text", "SOURCE_TOO_LARGE ordinary leakmarker"],
    ["JSON array", '["SOURCE_TOO_LARGE","ordinary leakmarker"]'],
    ["extra field", '{"code":"SOURCE_TOO_LARGE","message":"ordinary leakmarker","details":"marker"}'],
    ["duplicate code", '{"code":"UNKNOWN","code":"SOURCE_TOO_LARGE","message":"ordinary leakmarker"}'],
    ["escaped duplicate code", '{"code":"UNKNOWN","co\\u0064e":"SOURCE_TOO_LARGE","message":"ordinary leakmarker"}'],
    ["duplicate message", '{"code":"SOURCE_TOO_LARGE","message":"first","message":"ordinary leakmarker"}'],
    ["escaped duplicate message", '{"code":"SOURCE_TOO_LARGE","message":"first","messa\\u0067e":"ordinary leakmarker"}'],
    ["two duplicate members", '{"co\\u0064e":"SOURCE_TOO_LARGE","code":"SOURCE_TOO_LARGE"}'],
    ["malformed JSON", '{"code":"SOURCE_TOO_LARGE","message":"ordinary leakmarker",}'],
    ["nested value", '{"code":"SOURCE_TOO_LARGE","message":{"text":"ordinary leakmarker"}}'],
    ["numeric message", '{"code":"SOURCE_TOO_LARGE","message":12}'],
    ["unknown code", '{"code":"UNKNOWN","message":"ordinary leakmarker"}'],
    ["lowercase code", '{"code":"source_too_large","message":"ordinary leakmarker"}'],
    ["non-JSON whitespace", '\u00a0{"code":"SOURCE_TOO_LARGE","message":"ordinary leakmarker"}'],
    ["comment", '{"code":"SOURCE_TOO_LARGE",/* marker */"message":"ordinary leakmarker"}'],
  ])("rejects %s without forwarding foreign text", async (_name, text) => {
    await assertToolFailure({ isError: true, content: [{ type: "text", text }] }, "External MCP operation failed");
  });
  it.each([
    ["null", null],
    ["array", ["SOURCE_TOO_LARGE", "ordinary leakmarker"]],
    ["missing message", { code: "SOURCE_TOO_LARGE" }],
    ["non-string code", { code: 12, message: "ordinary leakmarker" }],
    ["non-string message", { code: "SOURCE_TOO_LARGE", message: false }],
    ["empty message", { code: "SOURCE_TOO_LARGE", message: "" }],
    ["long message", { code: "SOURCE_TOO_LARGE", message: "x".repeat(201) }],
    ["extra field", { code: "SOURCE_TOO_LARGE", message: "ordinary leakmarker", details: "marker" }],
    ["unknown code", { code: "UNKNOWN", message: "ordinary leakmarker" }],
  ])("rejects structured %s", async (_name, structuredContent) => {
    await assertToolFailure({ isError: true, content: [], structuredContent }, "External MCP operation failed");
  });
  it.each([
    "line\nmarker", "carriage\rmarker", "tab\tmarker", "nul\0marker", "delete\u007fmarker",
    "control\u0085marker", "bidi\u202emarker", "separator\u2028marker",
    "/private/marker", "relative ./marker", "C:\\private\\marker", "C:marker",
    "\\\\server\\share", "https://example.org/marker", "mailto:user@example.org", "www.example.org", "example.org",
  ])("rejects unsafe message %j in either representation", async (message) => {
    const structuredContent = { code: "SOURCE_TOO_LARGE", message };
    await assertToolFailure({ isError: true, content: [], structuredContent }, "External MCP operation failed");
    await assertToolFailure({ isError: true, content: [{ type: "text", text: JSON.stringify(structuredContent) }] }, "External MCP operation failed");
  });
  it("rejects ambiguous, extra and malformed blocks or representations", async () => {
    const value = { code: "SOURCE_TOO_LARGE", message: "ordinary leakmarker" };
    const block = { type: "text", text: JSON.stringify(value) };
    const cases: unknown[] = [
      { isError: true, content: [] },
      { isError: true, content: [block, block] },
      { isError: true, content: [{ type: "image", data: "marker" }], structuredContent: value },
      { isError: true, content: [{ ...block, annotations: { priority: 1 } }] },
      { isError: true, content: [block], structuredContent: { ...value, message: "different leakmarker" } },
      { isError: true, content: [block], structuredContent: { ...value, code: "UNKNOWN" } },
      { isError: true, content: [{ type: "text", text: "ordinary leakmarker" }], structuredContent: value },
      { isError: true, content: [block], structuredContent: { ...value, extra: "marker" } },
      { isError: true, content: [block], _meta: { extra: "marker" } },
      { isError: true, structuredContent: value },
      null,
    ];
    for (const result of cases) await assertToolFailure(result as McpCallResult, "External MCP operation failed");
  });
  it("does not classify successful content as an error without isError exactly true", async () => {
    for (const isError of [undefined, false]) {
      const f = fixture();
      const content = [{ type: "text", text: JSON.stringify({ code: "SOURCE_TOO_LARGE", message: "ordinary success marker" }) }];
      f.connection.callTool = async () => ({ content, isError } as McpCallResult);
      const session = await connectSessionMcpTools(configured(), "read-only", "/workspace", () => f.connection);
      try { assert.deepEqual((await execute(session.tools[0]!)).content, content); }
      finally { await session.close(); }
    }
  });
  it.each(["true", "", 1, 0, null])("rejects malformed isError flag %j without forwarding its content", async (isError) => {
    await assertToolFailure({
      isError,
      content: [{ type: "text", text: JSON.stringify({ code: "SOURCE_TOO_LARGE", message: "ordinary leakmarker" }) }],
    } as unknown as McpCallResult, "External MCP operation failed");
  });
  it("sanitizes transport errors even when their fields imitate the controller projection", async () => {
    for (const error of [
      Object.assign(new Error(sourceTooLargeMessage), { code: "SOURCE_TOO_LARGE", name: "McpToolError", cause: "foreign leakmarker" }),
      { code: "SOURCE_TOO_LARGE", message: sourceTooLargeMessage },
    ]) {
      const f = fixture();
      f.connection.callTool = async () => { throw error; };
      const session = await connectSessionMcpTools(configured(), "read-only", "/workspace", () => f.connection);
      try { await assert.rejects(execute(session.tools[0]!), { message: "External MCP operation failed" }); }
      finally { await session.close(); }
    }
  });
  it("does not trust a controller error replayed as a later transport exception", async () => {
    const f = fixture();
    f.connection.callTool = async () => ({ isError: true, content: [], structuredContent: { code: "SOURCE_TOO_LARGE", message: "ordinary leakmarker" } });
    const session = await connectSessionMcpTools(configured(), "read-only", "/workspace", () => f.connection);
    try {
      let captured: unknown;
      await assert.rejects(execute(session.tools[0]!), (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, sourceTooLargeMessage);
        captured = error;
        return true;
      });
      f.connection.callTool = async () => { throw captured; };
      await assert.rejects(execute(session.tools[0]!), { message: "External MCP operation failed" });
    } finally { await session.close(); }
  });
  it.each(["abort", "close", "timeout"] as const)("keeps %s authoritative over a late safe error", async (mode) => {
    const f = fixture(), entered = deferred<AbortSignal>(), late = deferred<McpCallResult>();
    f.connection.callTool = async (_name, _args, signal) => { entered.resolve(signal); return late.promise; };
    const session = await connectSessionMcpTools(configured(), "read-only", "/workspace", () => f.connection, { callMs: 20 });
    const caller = new AbortController();
    const rejected = assert.rejects(execute(session.tools[0]!, caller.signal), { message: "External MCP operation failed" });
    try {
      const signal = await entered.promise;
      if (mode === "abort") caller.abort();
      if (mode === "close") await session.close();
      await rejected;
      assert.equal(signal.aborted, true);
      late.resolve({ isError: true, content: [], structuredContent: { code: "SOURCE_TOO_LARGE", message: "ordinary leakmarker" } });
      await tick();
    } finally {
      late.resolve({ isError: true, content: [], structuredContent: { code: "SOURCE_TOO_LARGE", message: "ordinary leakmarker" } });
      await session.close();
    }
  });
  it("rejects synchronously cancelled safe error answers", async () => {
    const f = fixture(), caller = new AbortController();
    f.connection.callTool = async () => {
      caller.abort();
      return { isError: true, content: [], structuredContent: { code: "SOURCE_TOO_LARGE", message: "ordinary leakmarker" } };
    };
    const session = await connectSessionMcpTools(configured(), "read-only", "/workspace", () => f.connection);
    try { await assert.rejects(execute(session.tools[0]!, caller.signal), { message: "External MCP operation failed" }); }
    finally { await session.close(); }
  });
});

describe("external MCP success result limit", () => {
  it.each(["text", "structured", "combined"] as const)("accepts %s at the exact serialized envelope cap and rejects the next byte", async (representation) => {
    const result = representation === "structured"
      ? { content: [], structuredContent: { text: "OVERSIZED_FOREIGN_MARKER" } }
      : {
        content: [{ type: "text", text: "OVERSIZED_FOREIGN_MARKER" }],
        ...(representation === "combined" ? { structuredContent: { count: 1 } } : {}),
      };
    const value = representation === "structured" ? result.structuredContent! as { text: string } : result.content[0]!;
    value.text += "x".repeat(262144 - Buffer.byteLength(JSON.stringify(result), "utf8"));
    assert.equal(Buffer.byteLength(JSON.stringify(result), "utf8"), 262144);
    const f = fixture();
    f.connection.callTool = async () => result;
    const session = await connectSessionMcpTools(configured(), "read-only", "/workspace", () => f.connection);
    try {
      const accepted = await execute(session.tools[0]!);
      if (representation === "structured") {
        assert.deepEqual(accepted.content, [{ type: "text", text: JSON.stringify(result.structuredContent) }]);
      } else assert.deepEqual(accepted.content, result.content);
      value.text += "x";
      assert.equal(Buffer.byteLength(JSON.stringify(result), "utf8"), 262145);
      await assert.rejects(execute(session.tools[0]!), { message: resultLimitMessage });
    } finally { await session.close(); }
  });
  it.each(["😀", "\n"])("measures serialized UTF-8 bytes for %j rather than text characters", async (character) => {
    const text = "OVERSIZED_FOREIGN_MARKER /private/path " + character.repeat(character === "😀" ? 65536 : 131072);
    assert.ok(text.length < 262144);
    const result = { content: [{ type: "text", text }] };
    assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") > 262144);
    await assertToolFailure(result, resultLimitMessage);
  });
  it("allows a smaller request to succeed on the same granted tool after an oversized result", async () => {
    const f = fixture(), queries: unknown[] = [];
    f.connection.callTool = async (_name, args) => {
      queries.push(args.query);
      return args.query === "smaller" ? { content: [{ type: "text", text: "small safe result" }] }
        : { content: [], structuredContent: { text: "OVERSIZED_FOREIGN_MARKER" + "x".repeat(262144) } };
    };
    const session = await connectSessionMcpTools(configured(), "read-only", "/workspace", () => f.connection);
    try {
      await assert.rejects(execute(session.tools[0]!), { message: resultLimitMessage });
      const small = await session.tools[0]!.execute("call-2", { query: "smaller" }, undefined, undefined, {} as Parameters<ToolDefinition["execute"]>[4]);
      assert.deepEqual(small.content, [{ type: "text", text: "small safe result" }]);
      assert.deepEqual(queries, ["test", "smaller"]);
    } finally { await session.close(); }
  });
  it("keeps oversized remote errors generic rather than reporting the success limit", async () => {
    await assertToolFailure({
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ code: "SOURCE_TOO_LARGE", message: "OVERSIZED_FOREIGN_MARKER" }) + " ".repeat(262144) }],
    }, "External MCP operation failed");
  });
  it("sanitizes foreign transport lookalikes and a replayed result-limit error", async () => {
    const f = fixture();
    f.connection.callTool = async () => ({ content: [{ type: "text", text: "x".repeat(262144) }] });
    const session = await connectSessionMcpTools(configured(), "read-only", "/workspace", () => f.connection);
    try {
      let captured: unknown;
      await assert.rejects(execute(session.tools[0]!), (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, resultLimitMessage);
        assert.ok(Buffer.byteLength(error.message, "utf8") < 100);
        assert.deepEqual(Object.keys(error), []);
        captured = error;
        return true;
      });
      for (const foreign of [captured, Object.assign(new Error(resultLimitMessage), { name: "McpToolError", cause: "OVERSIZED_FOREIGN_MARKER" })]) {
        f.connection.callTool = async () => { throw foreign; };
        await assert.rejects(execute(session.tools[0]!), { message: "External MCP operation failed" });
      }
    } finally { await session.close(); }
  });
  it("keeps cancellation authoritative if it occurs during result serialization", async () => {
    const f = fixture(), caller = new AbortController();
    let serialized = false;
    f.connection.callTool = async () => ({ content: [], toJSON() {
      serialized = true;
      caller.abort();
      return { content: [{ type: "text", text: "OVERSIZED_FOREIGN_MARKER" + "x".repeat(262144) }] };
    } });
    const session = await connectSessionMcpTools(configured(), "read-only", "/workspace", () => f.connection);
    try {
      await assert.rejects(execute(session.tools[0]!, caller.signal), { message: "External MCP operation failed" });
      assert.equal(serialized, true);
      assert.equal(caller.signal.aborted, true);
    } finally { await session.close(); }
  });
  it.each(["abort", "close", "timeout"] as const)("keeps %s authoritative over a late oversized success", async (mode) => {
    const f = fixture(), entered = deferred<AbortSignal>(), late = deferred<McpCallResult>();
    f.connection.callTool = async (_name, _args, signal) => { entered.resolve(signal); return late.promise; };
    const session = await connectSessionMcpTools(configured(), "read-only", "/workspace", () => f.connection, { callMs: 20 });
    const caller = new AbortController();
    const rejected = assert.rejects(execute(session.tools[0]!, caller.signal), { message: "External MCP operation failed" });
    const oversized = { content: [{ type: "text", text: "OVERSIZED_FOREIGN_MARKER" + "x".repeat(262144) }] };
    try {
      const signal = await entered.promise;
      if (mode === "abort") caller.abort();
      if (mode === "close") await session.close();
      await rejected;
      assert.equal(signal.aborted, true);
      late.resolve(oversized);
      await tick();
    } finally {
      late.resolve(oversized);
      await session.close();
    }
  });
});

describe("explicit session MCP policy", () => {
  it("keeps omitted configuration empty without constructing a client", async () => {
    let created = 0;
    const session = await connectSessionMcpTools({}, "read-only", "/workspace", () => { created++; throw new Error(); });
    assert.deepEqual(session.tools, []); assert.equal(created, 0); await session.close();
  });
  it("validates commands, grants, strict fields, environment references and bounds", () => {
    assert.equal(isMcpServers(configured(), "read-only"), true);
    assert.equal(isMcpServers(configured(), "invalid" as never), false);
    for (const command of ["node", "./node", "https://server", "/bad\0command"]) {
      assert.equal(isMcpServers({ knowledge: { ...configured().knowledge, command } }), false);
    }
    assert.equal(isMcpServers({ knowledge: { ...configured().knowledge, env: { API_KEY: "SECRET" } } }), false);
    assert.equal(isMcpServers({ knowledge: { ...configured().knowledge, envFrom: { API_KEY: "secret-value" } } }), false);
    assert.equal(isMcpServers({ knowledge: { ...configured().knowledge, tools: {} } }), false);
    assert.equal(isMcpServers({ knowledge: { ...configured().knowledge, tools: { search: { name: remote.name } } } }), false);
    assert.equal(isMcpServers(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`s${i}`, configured().knowledge]))), false);
    assert.equal(isMcpServers({ knowledge: { ...configured().knowledge, tools: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`t${i}`, { name: `t${i}`, readOnly: true }])) } }), false);
  });
  it("does not trust readOnlyHint and rejects write grants before any process creation", async () => {
    const value = { knowledge: { ...configured().knowledge!, tools: { remove: { name: "delete_knowledge", readOnly: false } } } };
    assert.equal(isMcpServers(value, "coding"), true);
    let created = 0;
    await assert.rejects(connectSessionMcpTools(value, "read-only", "/workspace", () => { created++; return fixture().connection; }), /External MCP operation failed/);
    assert.equal(created, 0);
  });
  it("rejects composite-name collisions and duplicate remote grants", () => {
    assert.equal(isMcpServers({ a_b: { ...configured().knowledge, tools: { c: { name: "one", readOnly: true } } }, a: { ...configured().knowledge, tools: { b_c: { name: "two", readOnly: true } } } }), false);
    assert.equal(isMcpServers({ a: { ...configured().knowledge, tools: { b: { name: "one", readOnly: true }, c: { name: "one", readOnly: true } } } }), false);
  });
  it("deep-freezes snapshots and never projects commands or environment references into tool names", () => {
    const source = configured(); const copy = snapshotMcpServers(source);
    assert.notEqual(copy, source);
    for (const item of [copy, copy.knowledge, copy.knowledge!.tools, copy.knowledge!.tools.search, copy.knowledge!.args, copy.knowledge!.envFrom]) assert.equal(Object.isFrozen(item), true);
    assert.deepEqual(configuredMcpToolNames(copy), ["mcp_knowledge_search"]);
    const resolved = toResolvedExecutionProfile({ alias: "safe", default: true, permissionProfile: "read-only", provider: "fake", model: "fake", thinkingLevel: "off", mcpServers: source });
    assert.notEqual(resolved.mcpServers, source); assert.equal(Object.isFrozen(resolved.mcpServers), true);
  });
});

describe("session-owned MCP bridge", () => {
  it("exposes only granted names and preserves the remote JSON Schema", async () => {
    const f = fixture();
    const session = await connectSessionMcpTools(configured(), "read-only", "/workspace", (server, cwd) => {
      assert.equal(cwd, "/workspace"); assert.equal(server.command, "/usr/bin/node"); return f.connection;
    });
    assert.deepEqual(session.tools.map((tool) => tool.name), ["mcp_knowledge_search"]);
    assert.deepEqual(session.tools[0]!.parameters, schema);
    assert.notEqual(session.tools[0]!.parameters, schema);
    const result = await execute(session.tools[0]!);
    assert.deepEqual(result.content, [{ type: "text", text: "found" }]);
    assert.deepEqual(f.calls[0]!.args, { query: "test" }); assert.equal(f.calls[0]!.name, "search_knowledge");
    await session.close();
  });
  it("discovers allowlisted tools on later pages", async () => {
    const f = fixture(); const cursors: (string | undefined)[] = [];
    f.connection.listTools = async (cursor) => { cursors.push(cursor); return cursor === undefined ? { tools: [], nextCursor: "page2" } : { tools: [remote] }; };
    const session = await connectSessionMcpTools(configured(), "read-only", "/workspace", () => f.connection);
    assert.deepEqual(cursors, [undefined, "page2"]); assert.equal(session.tools.length, 1); await session.close();
  });
  it("distinguishes a complete empty catalog from a missing grant", async () => {
    const empty = fixture();
    empty.connection.listTools = async () => ({ tools: [] });
    assert.deepEqual(
      await rejectedStartup(connectSessionMcpTools(configured(), "read-only", "/workspace", () => empty.connection)),
      { code: "external_mcp_no_tools", serverAlias: "knowledge", discoveredToolCount: 0 },
    );
    assert.equal(empty.closed(), 1);

    const missing = fixture();
    missing.connection.listTools = async () => ({ tools: [{ ...remote, name: "different_tool" }] });
    assert.deepEqual(
      await rejectedStartup(connectSessionMcpTools(configured(), "read-only", "/workspace", () => missing.connection)),
      {
        code: "external_mcp_grant_tool_missing",
        serverAlias: "knowledge",
        toolAlias: "search",
        discoveredToolCount: 1,
      },
    );
    assert.equal(missing.closed(), 1);
  });
  it("classifies malformed and bounded discovery failures as unavailable", async () => {
    for (const mode of ["schema", "cursor", "duplicate", "malformed-page", "page-limit", "tool-limit"] as const) {
      const f = fixture();
      let pageIndex = 0;
      f.connection.listTools = async () => {
        if (mode === "schema") {
          return { tools: [{ ...remote, inputSchema: { type: "array" } as unknown as McpRemoteTool["inputSchema"] }] };
        }
        if (mode === "cursor") return { tools: [], nextCursor: "same" };
        if (mode === "duplicate") return { tools: [remote, remote] };
        if (mode === "malformed-page") return null as never;
        if (mode === "page-limit") {
          const current = pageIndex++;
          return { tools: current === 0 ? [remote] : [], nextCursor: String(current + 1) };
        }
        return {
          tools: Array.from({ length: 513 }, (_, index) => ({
            ...remote,
            name: `tool_${index}`,
          })),
        };
      };
      assert.deepEqual(
        await rejectedStartup(connectSessionMcpTools(configured(), "read-only", "/workspace", () => f.connection)),
        { code: "external_mcp_unavailable", serverAlias: "knowledge" },
      );
      assert.equal(f.closed(), 1);
    }
  });
  it("cleans earlier and failing servers without starting any later server", async () => {
    const a = fixture(), b = fixture();
    b.connection.connect = async () => {
      throw Object.assign(new Error("SECRET /private/path"), {
        code: "external_mcp_no_tools",
        cause: { token: "SECRET_CAUSE" },
      });
    };
    let created = 0;
    const factory: McpConnectionFactory = () => ++created === 1 ? a.connection : b.connection;
    const servers = { first: configured().knowledge!, second: configured().knowledge!, third: configured().knowledge! };
    const classified = await rejectedStartup(connectSessionMcpTools(servers, "read-only", "/workspace", factory));
    assert.deepEqual(classified, { code: "external_mcp_unavailable", serverAlias: "second" });
    assert.equal(JSON.stringify(classified).includes("SECRET"), false);
    assert.equal(created, 2); assert.equal(a.closed(), 1); assert.equal(b.closed(), 1);
  });
  it("does not turn MCP isError or transport failures into successful results", async () => {
    for (const transportFailure of [false, true]) {
      const f = fixture();
      f.connection.callTool = async () => { if (transportFailure) throw new Error("SECRET /private/path"); return { content: [{ type: "text", text: "SECRET" }], isError: true }; };
      const session = await connectSessionMcpTools(configured(), "read-only", "/workspace", () => f.connection);
      await assert.rejects(execute(session.tools[0]!), { message: "External MCP operation failed" }); await session.close();
    }
  });
  it("preserves structured data and represents unsupported content explicitly as JSON text", async () => {
    const f = fixture();
    const result: McpCallResult = { content: [{ type: "resource_link", uri: "knowledge:123", name: "entry" }], structuredContent: { count: 1 } };
    f.connection.callTool = async () => result;
    const session = await connectSessionMcpTools(configured(), "read-only", "/workspace", () => f.connection);
    const actual = await execute(session.tools[0]!);
    assert.deepEqual(JSON.parse((actual.content[0] as { text: string }).text), result.content[0]);
    assert.deepEqual(actual.details, { server: "knowledge", tool: "search", structuredContent: { count: 1 } }); await session.close();
  });
  it("rejects oversized successful results with a bounded controller diagnostic", async () => {
    await assertToolFailure({ content: [{ type: "text", text: "OVERSIZED_FOREIGN_MARKER /private/path " + "x".repeat(256 * 1024) }] }, resultLimitMessage);
  });
  it("forwards caller cancellation and rejects even an uncooperative call promptly", async () => {
    const f = fixture(); const entered = deferred<AbortSignal>();
    f.connection.callTool = async (_name, _args, signal) => { entered.resolve(signal); return new Promise(() => undefined); };
    const session = await connectSessionMcpTools(configured(), "read-only", "/workspace", () => f.connection);
    const caller = new AbortController(); const pending = execute(session.tools[0]!, caller.signal);
    const rejected = assert.rejects(pending); const signal = await entered.promise;
    caller.abort(); await rejected; assert.equal(signal.aborted, true); await session.close();
  });
  it("cancels calls and closes idempotently, refusing any subsequent tool execution", async () => {
    const f = fixture(); const entered = deferred<AbortSignal>();
    f.connection.callTool = async (_name, _args, signal) => { entered.resolve(signal); return new Promise(() => undefined); };
    const session = await connectSessionMcpTools(configured(), "read-only", "/workspace", () => f.connection);
    const rejected = assert.rejects(execute(session.tools[0]!)); const signal = await entered.promise;
    assert.equal(session.close(), session.close()); await session.close(); await rejected;
    assert.equal(signal.aborted, true); assert.equal(f.closed(), 1); await assert.rejects(execute(session.tools[0]!));
  });
  it("rejects pre-aborted calls without forwarding them", async () => {
    const f = fixture(); const session = await connectSessionMcpTools(configured(), "read-only", "/workspace", () => f.connection);
    const caller = new AbortController(); caller.abort(); await assert.rejects(execute(session.tools[0]!, caller.signal));
    assert.equal(f.calls.length, 0); await session.close();
  });
  it("bounds startup and cleans a late connection without starting the next server", async () => {
    const f = fixture(); const connected = deferred<void>(); let created = 0; let signal: AbortSignal | undefined;
    f.connection.connect = async (value) => { signal = value; await connected.promise; };
    await assert.rejects(connectSessionMcpTools({ first: configured().knowledge!, second: configured().knowledge! }, "read-only", "/workspace", () => { created++; return f.connection; }, { startupMs: 10, closeMs: 10 }));
    assert.equal(signal?.aborted, true); assert.equal(f.closed(), 1);
    connected.resolve(); await tick(); assert.equal(f.closed(), 2); assert.equal(created, 1);
  });
  it("bounds tool calls and observes late rejection", async () => {
    const f = fixture(); const late = deferred<McpCallResult>(); let signal: AbortSignal | undefined;
    f.connection.callTool = async (_name, _args, value) => { signal = value; return late.promise; };
    const session = await connectSessionMcpTools(configured(), "read-only", "/workspace", () => f.connection, { callMs: 10 });
    await assert.rejects(execute(session.tools[0]!)); assert.equal(signal?.aborted, true);
    late.reject(new Error("late SECRET")); await tick(); await session.close();
  });
  it("bounds uncooperative cleanup", async () => {
    const f = fixture(); f.connection.close = async () => new Promise(() => undefined);
    const session = await connectSessionMcpTools(configured(), "read-only", "/workspace", () => f.connection, { closeMs: 10 });
    await session.close(); await assert.rejects(execute(session.tools[0]!));
  });
  it("shuts down pending connections before SDK construction can settle", async () => {
    const f = fixture(); const connected = deferred<void>(); const entered = deferred<void>();
    f.connection.connect = async () => { entered.resolve(); await connected.promise; };
    const shutdown = new AbortController();
    const pending = connectSessionMcpTools(configured(), "read-only", "/workspace", () => f.connection, { signal: shutdown.signal });
    const rejected = assert.rejects(pending); await entered.promise; shutdown.abort(); await tick();
    assert.equal(f.closed(), 1); connected.resolve(); await rejected; assert.equal(f.closed(), 2);
  });
  it("keeps the shutdown signal attached to active connections", async () => {
    const f = fixture(); const shutdown = new AbortController();
    const session = await connectSessionMcpTools(configured(), "read-only", "/workspace", () => f.connection, { signal: shutdown.signal });
    shutdown.abort(); await session.close(); assert.equal(f.closed(), 1); await assert.rejects(execute(session.tools[0]!));
  });
  it("never spawns a server after shutdown was already requested", async () => {
    const shutdown = new AbortController(); shutdown.abort(); let created = 0;
    await assert.rejects(connectSessionMcpTools(configured(), "read-only", "/workspace", () => { created++; return fixture().connection; }, { signal: shutdown.signal }));
    assert.equal(created, 0);
  });
  it("cleans a late failed connection after shutdown", async () => {
    const f = fixture(); const connected = deferred<void>(); const entered = deferred<void>();
    f.connection.connect = async () => { entered.resolve(); await connected.promise; };
    const shutdown = new AbortController();
    const pending = connectSessionMcpTools(configured(), "read-only", "/workspace", () => f.connection, { signal: shutdown.signal });
    const rejected = assert.rejects(pending); await entered.promise; shutdown.abort(); await tick();
    assert.equal(f.closed(), 1); connected.reject(new Error("late SECRET")); await rejected; assert.equal(f.closed(), 2);
  });
  it("refuses connection admission if shutdown races the factory", async () => {
    const f = fixture(); let connected = 0; f.connection.connect = async () => { connected++; };
    const shutdown = new AbortController();
    await assert.rejects(connectSessionMcpTools(configured(), "read-only", "/workspace", () => { shutdown.abort(); return f.connection; }, { signal: shutdown.signal }));
    assert.equal(connected, 0); assert.equal(f.closed(), 1);
  });
  it("joins an in-progress close when cancellation and initialization race", async () => {
    const f = fixture(); const connected = deferred<void>(), entered = deferred<void>(), closing = deferred<void>(); let closes = 0;
    f.connection.connect = async () => { entered.resolve(); await connected.promise; };
    f.connection.close = async () => { closes++; await closing.promise; };
    const shutdown = new AbortController();
    const pending = connectSessionMcpTools(configured(), "read-only", "/workspace", () => f.connection, { signal: shutdown.signal });
    const rejected = assert.rejects(pending); await entered.promise; shutdown.abort(); await tick();
    connected.reject(new Error("cancelled")); await tick(); assert.equal(closes, 1);
    closing.resolve(); await rejected; assert.equal(closes, 1);
  });
  it("does not share connections across sessions", async () => {
    const a = fixture(), b = fixture(); let created = 0;
    const factory: McpConnectionFactory = () => ++created === 1 ? a.connection : b.connection;
    const first = await connectSessionMcpTools(configured(), "read-only", "/workspace", factory);
    const second = await connectSessionMcpTools(configured(), "read-only", "/workspace", factory);
    await first.close(); assert.equal(a.closed(), 1); assert.equal(b.closed(), 0);
    await execute(second.tools[0]!); assert.equal(b.calls.length, 1); await second.close();
  });
});

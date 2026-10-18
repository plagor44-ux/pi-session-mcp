import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { classifyRequest, createFakeMessagesServer, messagesSseEvents, projectToolResults, projectToolsEntry } from "../eval/profiles/token-claude-projection.js";

const tool = "mcp__pi-projection__pi_capabilities_get";

describe("synthetic Claude Messages boundary", () => {
  it("emits the documented streaming sequence for a tool call and a text turn", () => {
    const call = messagesSseEvents(1, { id: "toolu_x", name: tool, input: { a: 1 } });
    expect(call.map(e => e.event)).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    expect((call[1]!.data.content_block as { type: string }).type).toBe("tool_use");
    expect(JSON.parse((call[2]!.data.delta as { partial_json: string }).partial_json)).toEqual({ a: 1 });
    expect((call[4]!.data.delta as { stop_reason: string }).stop_reason).toBe("tool_use");
    const text = messagesSseEvents(2);
    expect((text[4]!.data.delta as { stop_reason: string }).stop_reason).toBe("end_turn");
    expect((text[2]!.data.delta as { type: string }).type).toBe("text_delta");
  });

  it("projects tool entries to sizes and booleans without payload", () => {
    const entry = { name: tool, description: "abc", input_schema: { type: "object" }, outputSchema: { properties: { reloadPolicy: {} } } };
    const projected = projectToolsEntry([{ name: "Read", description: "x" }, entry, { name: "ToolSearch", defer_loading: false }], "pi_capabilities_get", "reloadPolicy");
    expect(projected.fixture_present).toBe(true);
    if (!projected.fixture_present) return;
    expect(projected.fixture).toMatchObject({ name_bytes: tool.length, description_bytes: 3, output_schema_key_present: true, schema_marker_hits_entry: 1, defer_loading: false });
    expect(projected).toMatchObject({ tools_count: 3, tool_search_tool_present: true, defer_loading_count: 0, schema_marker_hits_whole_tools: 1 });
    expect(JSON.stringify(projected)).not.toContain("abc");
    const bare = projectToolsEntry([{ name: tool, input_schema: {}, defer_loading: true }], "pi_capabilities_get", "reloadPolicy");
    expect(bare).toMatchObject({ fixture_present: true, defer_loading_count: 1 });
    if (bare.fixture_present) expect(bare.fixture.output_schema_key_present).toBe(false);
    expect(projectToolsEntry([], "pi_capabilities_get", "reloadPolicy").fixture_present).toBe(false);
  });

  it("counts markers in tool_result blocks only and keeps no raw text", () => {
    const text = JSON.stringify({ ok: true, workspaces: [{ alias: "token_probe_marker_74ac" }] });
    const body = { messages: [
      { role: "user", content: "token_probe_marker_74ac in a prompt is not a tool result" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: tool, input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text }, { type: "text", text }] }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: "unknown_workspace" }] },
    ] };
    const results = projectToolResults(body, "pi_capabilities_get");
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ tool: "fixture", marker_hits: 2, text_block_count: 2, equal_text_blocks: true, is_error: false, content_kind: "array" });
    expect(results[1]).toMatchObject({ tool: "unknown", is_error: true, error_marker_hits: 1, marker_hits: 0, content_kind: "string" });
    expect(JSON.stringify(results)).not.toContain("token_probe_marker");
  });

  it("classifies auxiliary requests separately", () => {
    expect(classifyRequest({}, { model: "claude-sonnet-5-5", tools: [{}] }).role).toBe("main");
    expect(classifyRequest({}, { model: "claude-haiku-5-5", tools: [] }).role).toBe("auxiliary");
    expect(classifyRequest({ "x-claude-code-request-class": "title_gen" }, { model: "claude-sonnet-5-5", tools: [{}] })).toMatchObject({ role: "auxiliary", request_class: "title_gen" });
    expect(classifyRequest({ "x-claude-code-request-class": "Bad Value!" }, { model: "claude-sonnet-5-5", tools: [{}] }).request_class).toBeNull();
  });
});

describe("loopback Messages fake", () => {
  const servers: Array<{ close: () => void }> = [];
  afterEach(() => { for (const s of servers.splice(0)) s.close(); });
  async function start(maxRequests?: number) {
    const fake = createFakeMessagesServer({ suffix: "pi_capabilities_get", args: {}, schemaMarker: "reloadPolicy", ...maxRequests ? { maxRequests } : {} });
    fake.server.listen(0, "127.0.0.1"); await new Promise<void>(resolve => fake.server.once("listening", () => resolve()));
    servers.push({ close: () => { fake.server.closeAllConnections(); fake.server.close(); } });
    return { fake, base: `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}` };
  }
  const post = (base: string, path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "k" }, body: JSON.stringify(body) });

  it("scripts a tool call, then text, and 404s the auxiliary routes", async () => {
    const { fake, base } = await start();
    const first = await post(base, "/v1/messages?beta=true", { model: "claude-sonnet-5-5", stream: true, max_tokens: 1, messages: [{ role: "user", content: "hi" }], tools: [{ name: tool, input_schema: {} }] });
    expect(first.status).toBe(200); expect(first.headers.get("content-type")).toBe("text/event-stream");
    expect(await first.text()).toContain('"stop_reason":"tool_use"');
    const second = await post(base, "/v1/messages", { model: "claude-sonnet-5-5", messages: [{ role: "user", content: "hi" }], tools: [{ name: tool, input_schema: {} }] });
    expect(await second.text()).toContain('"stop_reason":"end_turn"');
    expect((await post(base, "/v1/messages/count_tokens", {})).status).toBe(404);
    expect((await fetch(base + "/api/hello", { method: "HEAD" })).status).toBe(404);
    const aux = await post(base, "/v1/messages", { model: "claude-haiku-5-5", messages: [] });
    expect(await aux.text()).toContain('"stop_reason":"end_turn"');
    expect(fake.state.requests.map(r => [r.path, r.role, r.scripted_response, r.credential_header_present])).toEqual([["messages_beta", "main", "tool_use", true], ["messages", "main", "text", true], ["messages", "auxiliary", "text", true]]);
    expect(fake.state.auxiliary_http).toEqual({ count_tokens: 1, hello_head: 1, unexpected: 0 });
    expect(fake.state.invalid).toBe(false);
    expect(JSON.stringify(fake.state)).not.toContain('"hi"');
  });

  it("scripts a tool search call when the fixture tool is deferred, and caps requests", async () => {
    const { fake, base } = await start(2);
    const search = await post(base, "/v1/messages", { model: "claude-sonnet-5-5", messages: [], tools: [{ name: "ToolSearch", input_schema: {} }] });
    expect(await search.text()).toContain("select:mcp__pi-projection__pi_capabilities_get");
    expect(fake.state.requests[0]!.scripted_response).toBe("tool_search");
    await post(base, "/v1/messages", { model: "claude-sonnet-5-5", messages: [], tools: [] });
    expect((await post(base, "/v1/messages", { model: "claude-sonnet-5-5", messages: [], tools: [] })).status).toBe(400);
    expect(fake.state.invalid).toBe(true);
  });

  it("applies the body cap to the decoded body of a compressed request", async () => {
    const fake = createFakeMessagesServer({ suffix: "pi_capabilities_get", args: {}, schemaMarker: "reloadPolicy", bodyCap: 64 * 1024 });
    fake.server.listen(0, "127.0.0.1"); await new Promise<void>(resolve => fake.server.once("listening", () => resolve()));
    servers.push({ close: () => { fake.server.closeAllConnections(); fake.server.close(); } });
    const base = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
    const bomb = gzipSync(JSON.stringify({ model: "claude-sonnet-5-5", messages: [], pad: "a".repeat(1024 * 1024) }));
    expect(bomb.length).toBeLessThan(64 * 1024);
    const response = await fetch(base + "/v1/messages", { method: "POST", headers: { "content-type": "application/json", "content-encoding": "gzip", "x-api-key": "k" }, body: bomb });
    expect(response.status).toBe(400);
    expect(fake.state.invalid).toBe(true);
    expect(fake.state.requests).toHaveLength(0);
  });
});

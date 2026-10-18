import { describe, expect, it } from "vitest";
import { decodedObjects, piSchemaKeys, piToolsBytes, projectedOutputs, projectedTool } from "../eval/profiles/token-client-projection.js";

describe("synthetic Codex request boundary", () => {
  it("preserves the namespace required by current Responses tools", () => {
    expect(projectedTool({ tools: [{ type: "namespace", name: "mcp__fixture", tools: [{ type: "function", name: "pi_turn_get" }] }] }, "pi_turn_get"))
      .toEqual({ name: "pi_turn_get", namespace: "mcp__fixture" });
    expect(projectedTool({ tools: [{ type: "function", name: "mcp__fixture__pi_turn_get" }] }, "pi_turn_get"))
      .toEqual({ name: "mcp__fixture__pi_turn_get" });
    expect(projectedTool({ tools: [] }, "pi_turn_get")).toBeUndefined();
  });
  it("counts only actual function outputs and exports no raw payload", () => {
    const output = { content: [{ type: "text", text: "token_probe_marker_74ac" }], structuredContent: { error: { code: "unknown_workspace" } } };
    const metrics = projectedOutputs({ input: [{ type: "message", content: "token_probe_marker_74ac" }, { type: "function_call_output", output }] });
    expect(metrics).toEqual([{ serialized_bytes: Buffer.byteLength(JSON.stringify(output)), marker_hits: 1, error_marker_hits: 1, plaintext_tool_echo_hits: 0, plaintext_thinking_echo_hits: 0, structured_key_present: true }]);
    expect(JSON.stringify(metrics)).not.toContain("token_probe_marker");
  });
  it("decodes only transient synthetic JSON for the next scripted tool call", () => {
    const wrapped = [{ type: "input_text", text: 'Tool result:\n```json\n{"ok":true,"sessions":[]}\n```' }];
    expect(decodedObjects(wrapped).some(v => Array.isArray(v.sessions) && v.sessions.length === 0)).toBe(true);
    expect(decodedObjects("unparseable")).toEqual([]);
  });
  it("sizes only the pi tool entries and counts their schema keys", () => {
    const pi = { type: "namespace", name: "mcp__pi", tools: [{ name: "pi_turn_get", parameters: { properties: { id: { type: "string", format: "uuid", pattern: "x" } } } }] };
    const other = { type: "function", name: "shell", parameters: { properties: { cmd: { type: "string", pattern: "y" } } } };
    expect(piToolsBytes({ tools: [other, pi] })).toBe(Buffer.byteLength(JSON.stringify(pi)));
    expect(piSchemaKeys({ tools: [other, pi] })).toEqual({ pattern: 1, format: 1 });
    expect(piToolsBytes({ tools: [other] })).toBeNull();
    expect(piSchemaKeys({})).toBeNull();
  });
});

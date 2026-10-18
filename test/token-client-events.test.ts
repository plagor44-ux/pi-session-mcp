import { describe, expect, it } from "vitest";
import { measureCodexEvent } from "../eval/profiles/token-client-events.js";

describe("Codex documented event metric allowlist", () => {
  it("keeps usage detail fields separate and never invents missing usage", () => {
    expect(measureCodexEvent({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20, reasoning_output_tokens: 5 }, private: "/private/token" })).toMatchObject({ input_tokens: 100, cached_input_tokens: 80, output_tokens: 20, reasoning_output_tokens: 5 });
    expect(measureCodexEvent({ type: "turn.completed" }).input_tokens).toBeNull();
    expect(measureCodexEvent({ type: "turn.completed", usage: { input_tokens: -1, cached_input_tokens: "10", output_tokens: Infinity } })).toMatchObject({ input_tokens: null, cached_input_tokens: null, output_tokens: null });
    expect(measureCodexEvent({ type: "error", usage: { input_tokens: 1 } }).input_tokens).toBeNull();
  });
  it.each(["normal", "domain-error", "truncated"])("separates %s item display from actual model projection", mode => {
    const result = { content: [{ type: "text", text: "SYNTHETIC_PRIVATE" }], structured_content: { ok: mode !== "domain-error", turn: { truncated: mode === "truncated" } } };
    const metrics = measureCodexEvent({ type: "item.completed", item: { type: "mcp_tool_call", result, arguments: { prompt: "SYNTHETIC_PRIVATE" } } });
    expect(metrics.model_injection_copies).toBeNull();
    expect(metrics.domain_error).toBe(mode === "domain-error");
    expect(metrics.registry_truncated).toBe(mode === "truncated");
    expect(metrics.content_bytes).toBe(Buffer.byteLength(JSON.stringify(result.content)));
    expect(JSON.stringify(metrics)).not.toContain("SYNTHETIC_PRIVATE");
  });
  it("keeps a failed tool item separate from an observed Pi domain error", () => {
    const metrics = measureCodexEvent({ type: "item.completed", item: { type: "mcp_tool_call", status: "failed", error: { message: "PRIVATE" } } });
    expect(metrics).toMatchObject({ domain_error: null, tool_failed: true, structured_bytes: null, registry_truncated: null });
    expect(JSON.stringify(metrics)).not.toContain("PRIVATE");
  });
});

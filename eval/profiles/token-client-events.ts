// Documented Codex exec --json events. Tool-item output is observational UI/event
// evidence, never proof that this same value was injected into an inference request.
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" ? v as Record<string, unknown> : {};
const count = (v: unknown): number | null => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
export function measureCodexEvent(event: unknown) {
  const e = record(event), item = record(e.item), usage = record(e.usage), result = record(item.result);
  const isUsage = e.type === "turn.completed";
  const isTool = e.type === "item.completed" && item.type === "mcp_tool_call";
  const structured = record(result.structured_content), state = record(structured.turn);
  return {
    kind: isUsage ? "usage-event" as const : isTool ? "tool-item-event" as const : "other-event" as const,
    input_tokens: isUsage ? count(usage.input_tokens) : null,
    output_tokens: isUsage ? count(usage.output_tokens) : null,
    cached_input_tokens: isUsage ? count(usage.cached_input_tokens) : null,
    reasoning_output_tokens: isUsage ? count(usage.reasoning_output_tokens) : null,
    // No total: cache/reasoning are overlapping detail fields, not additive usage.
    content_bytes: isTool && result.content !== undefined ? Buffer.byteLength(JSON.stringify(result.content)) : null,
    structured_bytes: isTool && result.structured_content !== undefined ? Buffer.byteLength(JSON.stringify(result.structured_content)) : null,
    domain_error: isTool && typeof structured.ok === "boolean" ? structured.ok === false : null,
    tool_failed: isTool ? item.status === "failed" || item.error != null : null,
    registry_truncated: isTool && typeof state.truncated === "boolean" ? state.truncated : null,
    model_injection_copies: null,
    injection_reason: "inference-request-boundary-not-observed" as const,
  };
}

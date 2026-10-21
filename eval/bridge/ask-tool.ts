import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AskOutcome, QuestionSpec } from "./questions.js";

// Evaluation-only worker tool. It does not exist in the product.
export type AskFunction = (spec: QuestionSpec, signal: AbortSignal | undefined) => Promise<AskOutcome>;
export const ASK_TOOL_NAME = "ask_controller";
export const ASK_REFUSAL_TEXT = "The controller did not answer. Continue without an answer.";
const CANCELLED = Symbol("cancelled");

export function createAskControllerTool(ask: AskFunction): ToolDefinition {
  return defineTool({
    name: ASK_TOOL_NAME, label: "Ask controller",
    description: "Ask the controller one structured question and wait for the answer. Use kind input for free text, select for one of the given options, confirm for yes or no.",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("input"), Type.Literal("select"), Type.Literal("confirm")]),
      prompt: Type.String({ minLength: 1, maxLength: 2000 }),
      options: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 20 })),
    }),
    async execute(_id, params, signal) {
      const reply = (text: string, status: string) => ({ content: [{ type: "text" as const, text }], details: { status } });
      if (signal?.aborted) return reply(ASK_REFUSAL_TEXT, "cancelled");
      if (params.kind === "select" && !params.options?.length) return reply(ASK_REFUSAL_TEXT, "refused");
      const spec: QuestionSpec = { recipient: "controller", kind: params.kind, prompt: params.prompt, ...(params.options ? { options: params.options } : {}) };
      // The SDK does not race the signal against execute(), so the tool does.
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<typeof CANCELLED>((resolve) => { onAbort = () => resolve(CANCELLED); signal?.addEventListener("abort", onAbort, { once: true }); });
      try {
        const outcome = await Promise.race([ask(spec, signal).catch((): AskOutcome => ({ status: "refused", code: "ask_failed" })), aborted]);
        if (outcome === CANCELLED || outcome.status !== "answered") return reply(ASK_REFUSAL_TEXT, outcome === CANCELLED ? "cancelled" : outcome.status);
        return reply(String(outcome.value), "answered");
      } finally { if (onAbort) signal?.removeEventListener("abort", onAbort); }
    },
  });
}

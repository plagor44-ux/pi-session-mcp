import type { AgentSession } from "@earendil-works/pi-coding-agent";

export type ProviderErrorClass = "auth" | "quota" | "rate_limit" | "other";

export interface RunUsage {
  /**
   * The SDK session totals, side usage included. Null when there is no captured session or the stats
   * report zero tokens and zero cost (nothing was billed): no cost of record.
   */
  readonly session: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; costUsd: number } | null;
  /** Independent sum over observed assistant `message_end` events. */
  readonly assistant: { messages: number; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number };
  readonly providerError: ProviderErrorClass | null;
}

/** Classifies a failed assistant message by pattern. The message itself is never stored. */
export function classifyProviderError(stopReason: string | undefined, errorMessage: string | undefined): ProviderErrorClass | null {
  if (stopReason !== "error") return null;
  const message = errorMessage ?? "";
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid.{0,20}(token|key)|expired/i.test(message)) return "auth";
  if (/quota|insufficient|billing|credit|payment/i.test(message)) return "quota";
  if (/\b429\b|rate.?limit|too many requests/i.test(message)) return "rate_limit";
  return "other";
}

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/**
 * Sums assistant usage from the public session event stream as a cross-check on the SDK session stats.
 * `reasoning` is a subset of `output` and `cacheWrite1h` a subset of `cacheWrite` in the SDK's `Usage`,
 * so neither is added again.
 */
export class UsageCollector {
  private messages = 0;
  private input = 0;
  private output = 0;
  private cacheRead = 0;
  private cacheWrite = 0;
  private costUsd = 0;
  private lastStopReason: string | undefined;
  private lastErrorMessage: string | undefined;

  attach(session: AgentSession): () => void {
    return session.subscribe((event) => {
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      const message = event.message;
      const usage = message.usage as Partial<Record<"input" | "output" | "cacheRead" | "cacheWrite", number>> & { cost?: { total?: number } } | undefined;
      this.messages += 1;
      this.input += count(usage?.input);
      this.output += count(usage?.output);
      this.cacheRead += count(usage?.cacheRead);
      this.cacheWrite += count(usage?.cacheWrite);
      this.costUsd += count(usage?.cost?.total);
      this.lastStopReason = message.stopReason;
      this.lastErrorMessage = message.errorMessage;
    });
  }

  finish(session: AgentSession | undefined): RunUsage {
    const assistant = { messages: this.messages, input: this.input, output: this.output, cacheRead: this.cacheRead, cacheWrite: this.cacheWrite, costUsd: this.costUsd };
    let figures: RunUsage["session"] = null;
    if (session !== undefined) {
      const stats = session.getSessionStats();
      if (stats.tokens.total !== 0 || stats.cost !== 0) figures = { ...stats.tokens, costUsd: stats.cost };
    }
    return { session: figures, assistant, providerError: classifyProviderError(this.lastStopReason, this.lastErrorMessage) };
  }
}

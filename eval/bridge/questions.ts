import { randomUUID } from "node:crypto";
import type { EventBridge, QuestionKind, QuestionRecipient, QuestionResolvedState } from "./bridge.js";

// Local prototype broker. Question text lives in memory only; events and the ledger never carry it.
export interface QuestionCorrelation { sessionId: string; turnId: string; attemptId: string; }
export interface QuestionSpec { recipient: QuestionRecipient; kind: QuestionKind; prompt: string; options?: string[]; maxBytes?: number; }
export type AskOutcome = { status: "answered"; value: string | boolean } | { status: "expired" | "cancelled" | "refused"; code: string };
export type AnswerResult = "accepted" | "unknown_request" | "wrong_instance" | "already_resolved" | "expired" | "invalid_answer";
export interface OpenQuestion extends QuestionCorrelation { requestId: string; instanceId: string; recipient: QuestionRecipient; kind: QuestionKind; prompt: string; options?: string[]; maxBytes: number; openedAt: string; deadlineAt: string; }
export interface QuestionBrokerOptions { instanceId: string; bridge: EventBridge; maxOpenPerSession?: number; maxOpenPerInstance?: number; now?: () => number; }
export const DEFAULT_QUESTION_MAX_BYTES = 2000;
const MAX_PROMPT_BYTES = 4000;
const MAX_REMEMBERED = 1000;
const MAX_TIMER_MS = 2_147_483_647;

interface Pending { question: OpenQuestion; deadlineMs: number; timer: ReturnType<typeof setTimeout> | undefined; settle(outcome: AskOutcome, state: QuestionResolvedState): void; }

export class QuestionBroker {
  private readonly open = new Map<string, Pending>(); private readonly resolved = new Map<string, { state: QuestionResolvedState; sessionId: string; turnId: string }>();
  private readonly instanceId: string; private readonly bridge: EventBridge; private readonly maxPerSession: number; private readonly maxPerInstance: number; private readonly now: () => number;
  constructor(options: QuestionBrokerOptions) {
    this.instanceId = options.instanceId; this.bridge = options.bridge; this.maxPerSession = options.maxOpenPerSession ?? 1; this.maxPerInstance = options.maxOpenPerInstance ?? 4; this.now = options.now ?? Date.now;
  }
  /** Cancels waiting questions of a turn when it ends, and all of them when the instance ends. */
  attach(): () => void {
    return this.bridge.subscribe((event) => {
      if (event.kind === "turn_terminal" || event.kind === "turn_unobserved") this.cancelTurn(event.sessionId, event.turnId, event.kind);
      else if (event.kind === "instance_ended") this.cancelAll("instance_ended");
    });
  }
  ask(correlation: QuestionCorrelation, spec: QuestionSpec, opts: { deadlineMs: number; signal?: AbortSignal }): Promise<AskOutcome> {
    const requestId = randomUUID(), openedMs = this.now(), deadlineMs = Number.isFinite(opts.deadlineMs) && opts.deadlineMs > 0 ? opts.deadlineMs : 0;
    const question: OpenQuestion = {
      requestId, instanceId: this.instanceId, sessionId: correlation.sessionId, turnId: correlation.turnId, attemptId: correlation.attemptId,
      recipient: spec.recipient, kind: spec.kind, prompt: spec.prompt, ...(spec.options ? { options: [...spec.options] } : {}),
      maxBytes: spec.maxBytes ?? DEFAULT_QUESTION_MAX_BYTES, openedAt: new Date(openedMs).toISOString(), deadlineAt: new Date(openedMs + deadlineMs).toISOString(),
    };
    return new Promise<AskOutcome>((resolve) => {
      let done = false;
      const onAbort = (): void => pending.settle({ status: "cancelled", code: "aborted" }, "cancelled");
      const pending: Pending = {
        question, deadlineMs, timer: undefined,
        settle: (outcome, state) => {
          if (done) return;
          done = true;
          if (pending.timer !== undefined) clearTimeout(pending.timer);
          opts.signal?.removeEventListener("abort", onAbort);
          this.open.delete(requestId);
          this.remember(requestId, state, question.sessionId, question.turnId);
          this.bridge.emit({ kind: "question_resolved", requestId, sessionId: question.sessionId, turnId: question.turnId, state });
          resolve(outcome);
        },
      };
      const opened = (): void => { this.bridge.emit({ kind: "question_opened", requestId, sessionId: question.sessionId, turnId: question.turnId, recipient: question.recipient, questionKind: question.kind, deadlineAt: question.deadlineAt }); };
      const refusal = this.refusal(question, deadlineMs);
      if (refusal) { opened(); pending.settle({ status: "refused", code: refusal }, "refused"); return; }
      this.open.set(requestId, pending);
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      pending.timer = setTimeout(() => pending.settle({ status: "expired", code: "deadline" }, "expired"), Math.min(deadlineMs, MAX_TIMER_MS));
      pending.timer.unref();
      opened();
      if (opts.signal?.aborted) onAbort();
    });
  }
  get(requestId: string, instanceId: string): OpenQuestion | { error: "unknown_request" | "wrong_instance" | "already_resolved" | "expired" } {
    const pending = this.open.get(requestId);
    if (!pending) { const state = this.resolved.get(requestId)?.state; return { error: state === undefined ? "unknown_request" : state === "expired" ? "expired" : "already_resolved" }; }
    if (instanceId !== this.instanceId) return { error: "wrong_instance" };
    return { ...pending.question, ...(pending.question.options ? { options: [...pending.question.options] } : {}) };
  }
  /** Session and turn of a request this broker knows, open or resolved, so a rejected answer can still name its turn. */
  turnOf(requestId: string): { sessionId: string; turnId: string } | undefined {
    const known = this.open.get(requestId)?.question ?? this.resolved.get(requestId);
    return known ? { sessionId: known.sessionId, turnId: known.turnId } : undefined;
  }
  answer(requestId: string, instanceId: string, value: unknown): AnswerResult {
    const pending = this.open.get(requestId);
    if (!pending) { const state = this.resolved.get(requestId)?.state; return state === undefined ? "unknown_request" : instanceId !== this.instanceId ? "wrong_instance" : state === "expired" ? "expired" : "already_resolved"; }
    if (instanceId !== this.instanceId) return "wrong_instance";
    if (this.now() >= Date.parse(pending.question.deadlineAt)) { pending.settle({ status: "expired", code: "deadline" }, "expired"); return "expired"; }
    if (!this.valid(pending.question, value)) return "invalid_answer";
    pending.settle({ status: "answered", value: value as string | boolean }, "answered");
    return "accepted";
  }
  cancelTurn(sessionId: string, turnId: string, code: string): number {
    const matches = [...this.open.values()].filter((p) => p.question.sessionId === sessionId && p.question.turnId === turnId);
    for (const pending of matches) pending.settle({ status: "cancelled", code }, "cancelled");
    return matches.length;
  }
  cancelAll(code: string): number {
    const all = [...this.open.values()];
    for (const pending of all) pending.settle({ status: "cancelled", code }, "cancelled");
    return all.length;
  }
  openCount(): number { return this.open.size; }
  private refusal(question: OpenQuestion, deadlineMs: number): string | undefined {
    const open = [...this.open.values()];
    if (open.filter((p) => p.question.sessionId === question.sessionId).length >= this.maxPerSession || open.length >= this.maxPerInstance) return "question_limit";
    if (!question.prompt || Buffer.byteLength(question.prompt, "utf8") > MAX_PROMPT_BYTES || !Number.isInteger(question.maxBytes) || question.maxBytes <= 0) return "invalid_question";
    if (question.kind === "select" && (!question.options || question.options.length === 0 || question.options.some((o) => typeof o !== "string"))) return "invalid_question";
    if (deadlineMs <= 0) return "invalid_question";
    return undefined;
  }
  private valid(question: OpenQuestion, value: unknown): boolean {
    if (question.kind === "confirm") return typeof value === "boolean";
    if (typeof value !== "string") return false;
    if (question.kind === "select") return question.options?.includes(value) ?? false;
    return Buffer.byteLength(value, "utf8") <= question.maxBytes;
  }
  private remember(requestId: string, state: QuestionResolvedState, sessionId: string, turnId: string): void {
    this.resolved.set(requestId, { state, sessionId, turnId });
    while (this.resolved.size > MAX_REMEMBERED) this.resolved.delete(this.resolved.keys().next().value!);
  }
}

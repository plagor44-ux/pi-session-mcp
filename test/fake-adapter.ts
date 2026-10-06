import type { PiSessionAdapter, PiSessionHandle, PiTurnOutcome } from "../src/pi-adapter.js";
import type { ResolvedExecutionProfile } from "../src/execution-profile.js";

export type FakePlan = { accepted?: boolean; manualPreflight?: boolean; assistantText?: string; synchronous?: boolean; rejectDetail?: string; prompts?: FakePlan[]; creationError?: Error; creationGate?: Promise<void> };

export class FakeAdapter implements PiSessionAdapter {
  handles: FakeHandle[] = [];
  createInputs: Array<{ cwd: string; executionProfile: ResolvedExecutionProfile }> = [];
  plans: FakePlan[] = [];
  async create(input: { cwd: string; executionProfile: ResolvedExecutionProfile }): Promise<PiSessionHandle> {
    this.createInputs.push(input);
    const plan = this.plans.shift() ?? {};
    await plan.creationGate;
    if (plan.creationError) throw plan.creationError;
    const handle = new FakeHandle(plan, input.executionProfile); this.handles.push(handle); return handle;
  }
}
export class FakeHandle implements PiSessionHandle {
  readonly sdkSessionId = "fake"; aborted = 0; disposed = false; disposeCalls = 0;
  private settle!: (value: PiTurnOutcome) => void;
  private reject!: (reason?: unknown) => void;
  private activePlan: FakePlan;
  abortGate?: Promise<void>;
  abortError?: Error;
  abortSettlesPrompt = true;
  disposeError?: Error;
  preflight?: (accepted: boolean) => void;
  onActivity: (() => void) | undefined;
  readonly appliedSelection;
  constructor(readonly plan: FakePlan = {}, executionProfile: ResolvedExecutionProfile) {
    this.activePlan = plan;
    this.appliedSelection = {
      provider: executionProfile.provider, model: executionProfile.model, thinkingLevel: executionProfile.thinkingLevel,
    };
  }
  prompt(_text: string, preflight: (accepted: boolean) => void, onActivity?: () => void): Promise<PiTurnOutcome> {
    this.activePlan = this.plan.prompts?.shift() ?? this.plan;
    const completion = new Promise<PiTurnOutcome>((resolve, reject) => { this.settle = resolve; this.reject = reject; });
    completion.catch(() => undefined);
    this.preflight = preflight;
    this.onActivity = onActivity;
    const accepted = this.activePlan.accepted ?? true;
    if (!this.activePlan.manualPreflight) preflight(accepted);
    if (this.activePlan.rejectDetail) this.reject(new Error(this.activePlan.rejectDetail));
    else if (!accepted) this.fail();
    else if (this.activePlan.synchronous) this.complete(this.activePlan.assistantText ?? "sync result");
    return completion;
  }
  complete(assistantText = this.activePlan.assistantText ?? "completed result"): void { this.settle({ status: "completed", assistantText }); }
  fail(): void { this.settle({ status: "failed" }); }
  rejectPrompt(reason: unknown): void { this.reject(reason); }
  signalPreflight(accepted = this.activePlan.accepted ?? true): void { this.preflight?.(accepted); }
  /** Simulates one completed tool execution or completed assistant message for the running prompt. */
  reportActivity(): void { this.onActivity?.(); }
  async abort(): Promise<void> { this.aborted += 1; await this.abortGate; if (this.abortError) throw this.abortError; if (this.abortSettlesPrompt) this.settle({ status: "aborted" }); }
  dispose(): void { this.disposeCalls += 1; this.disposed = true; if (this.disposeError) throw this.disposeError; }
}

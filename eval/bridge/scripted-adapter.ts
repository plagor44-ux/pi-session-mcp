import type { PiAppliedSelection, PiSessionAdapter, PiSessionHandle, PiTurnOutcome, TurnCompletion } from "../../src/pi-adapter.js";
import type { ResolvedExecutionProfile } from "../../src/execution-profile.js";
import type { AskOutcome, QuestionSpec } from "./questions.js";

// Deterministic adapter for tests and an evaluation stdio server. No Pi, no provider, no network.
export type ScriptStep =
  | { activity: number } // calls onActivity n times: models agent_end/retry activity, never a terminal signal
  | { sleepMs: number }
  | { ask: QuestionSpec; deadlineMs: number }
  | { complete: string; completion?: TurnCompletion }
  | { fail: true }
  | { hang: true }; // settles only on abort or release()
export type PromptPlan = ScriptStep[];
export interface ScriptedSessionPlan { prompts?: PromptPlan[]; abortHangs?: boolean; creationError?: Error; acceptPreflight?: boolean; }
export interface ScriptedAskContext { handle: ScriptedHandle; spec: QuestionSpec; deadlineMs: number; signal: AbortSignal; }
export type ScriptedAsker = (context: ScriptedAskContext) => Promise<AskOutcome>;

export class ScriptedAdapter implements PiSessionAdapter {
  handles: ScriptedHandle[] = []; plans: ScriptedSessionPlan[] = [];
  constructor(public asker?: ScriptedAsker) {}
  async create(input: { cwd: string; executionProfile: ResolvedExecutionProfile }): Promise<PiSessionHandle> {
    const plan = this.plans.shift() ?? {};
    if (plan.creationError) throw plan.creationError;
    const handle = new ScriptedHandle(plan, input.executionProfile, `scripted-${this.handles.length + 1}`, (context) => this.asker ? this.asker(context) : Promise.resolve<AskOutcome>({ status: "refused", code: "no_asker" }));
    this.handles.push(handle);
    return handle;
  }
}

interface RunState { controller: AbortController; settle(outcome: PiTurnOutcome): void; done: boolean; }

export class ScriptedHandle implements PiSessionHandle {
  readonly appliedSelection: PiAppliedSelection; aborts = 0; disposed = false; prompts = 0; askOutcomes: AskOutcome[] = [];
  private readonly timers = new Set<ReturnType<typeof setTimeout>>(); private readonly queue: PromptPlan[];
  private run: RunState | undefined;
  private abortRelease: (() => void) | undefined;
  constructor(private readonly plan: ScriptedSessionPlan, executionProfile: ResolvedExecutionProfile, readonly sdkSessionId: string, private readonly asker: ScriptedAsker) {
    this.appliedSelection = { provider: executionProfile.provider, model: executionProfile.model, thinkingLevel: executionProfile.thinkingLevel };
    this.queue = [...(plan.prompts ?? [])];
  }
  prompt(_text: string, preflight: (accepted: boolean) => void, onActivity?: () => void): Promise<PiTurnOutcome> {
    this.prompts += 1;
    const plan = this.queue.shift() ?? [{ complete: "scripted" }], controller = new AbortController();
    let settle!: (outcome: PiTurnOutcome) => void;
    const completion = new Promise<PiTurnOutcome>((resolve) => { settle = resolve; });
    const run: RunState = { controller, done: false, settle: (outcome: PiTurnOutcome) => { if (run.done) return; run.done = true; if (this.run === run) this.run = undefined; settle(outcome); } };
    this.run = run;
    const accepted = this.plan.acceptPreflight ?? true;
    preflight(accepted);
    if (!accepted) run.settle({ status: "failed" }); else void this.execute(plan, run, onActivity);
    return completion;
  }
  /** Settles the running prompt with `outcome` and releases a hanging abort (models the adapter finally finishing). */
  release(outcome: PiTurnOutcome = { status: "aborted" }): void { this.run?.settle(outcome); this.abortRelease?.(); this.abortRelease = undefined; }
  abort(): Promise<void> {
    this.aborts += 1;
    if (this.plan.abortHangs) return new Promise<void>((resolve) => { this.abortRelease = resolve; });
    const run = this.run;
    run?.controller.abort(); run?.settle({ status: "aborted" });
    return Promise.resolve();
  }
  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.run?.controller.abort(); this.run?.settle({ status: "aborted" });
    this.abortRelease?.(); this.abortRelease = undefined;
  }
  private async execute(plan: PromptPlan, run: RunState, onActivity: (() => void) | undefined): Promise<void> {
    for (const step of plan) {
      if (run.done) return;
      if ("activity" in step) { for (let i = 0; i < step.activity; i += 1) { try { onActivity?.(); } catch { /* best effort, like the SDK adapter */ } } }
      else if ("sleepMs" in step) await this.sleep(step.sleepMs, run);
      else if ("ask" in step) {
        const outcome = await this.asker({ handle: this, spec: step.ask, deadlineMs: step.deadlineMs, signal: run.controller.signal }).catch((): AskOutcome => ({ status: "refused", code: "ask_failed" }));
        this.askOutcomes.push(outcome);
      }
      else if ("complete" in step) return run.settle({ status: "completed", assistantText: step.complete, completion: step.completion ?? "stop" });
      else if ("fail" in step) return run.settle({ status: "failed" });
      else if ("hang" in step) return; // only abort/release()/dispose() settle it
    }
    run.settle({ status: "completed", assistantText: "scripted", completion: "stop" });
  }
  private sleep(ms: number, run: { controller: AbortController }): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => { clearTimeout(timer); this.timers.delete(timer); run.controller.signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, ms); timer.unref(); this.timers.add(timer);
      run.controller.signal.addEventListener("abort", done, { once: true });
    });
  }
}

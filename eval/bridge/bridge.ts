import { AsyncLocalStorage } from "node:async_hooks";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PiSessionAdapter, PiSessionHandle, PiAppliedSelection, PiTurnOutcome } from "../../src/pi-adapter.js";
import type { ResolvedExecutionProfile } from "../../src/execution-profile.js";
import { SessionRegistry, type PromptResult, type SessionRegistryOptions, type SessionView, type TurnState } from "../../src/session-registry.js";

// Local prototype events: IDs, states, timestamps and codes only. No prompt, question, answer or assistant text.
export type TurnTerminalState = "completed" | "failed" | "aborted";
export type QuestionRecipient = "controller" | "human";
export type QuestionKind = "input" | "select" | "confirm";
export type QuestionResolvedState = "answered" | "expired" | "cancelled" | "refused";
export type InstanceEndReason = "closed" | "eof" | "server_exit";
export interface TurnRef { sessionId: string; turnId: string; }
interface BridgeBase { seq: number; at: string; instanceId: string; }
export type BridgeEvent = BridgeBase & (
  | { kind: "turn_terminal"; sessionId: string; turnId: string; state: TurnTerminalState; via: "bridge" | "close" }
  | { kind: "question_opened"; requestId: string; sessionId: string; turnId: string; recipient: QuestionRecipient; questionKind: QuestionKind; deadlineAt: string }
  | { kind: "question_resolved"; requestId: string; sessionId: string; turnId: string; state: QuestionResolvedState }
  | { kind: "instance_ended"; reason: InstanceEndReason }
);
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type BridgeEventInput = DistributiveOmit<BridgeEvent, keyof BridgeBase>;
export type BridgeListener = (event: BridgeEvent) => void;
export const BRIDGE_EVENT_KEYS: Readonly<Record<BridgeEvent["kind"], readonly string[]>> = {
  turn_terminal: ["seq", "at", "instanceId", "kind", "sessionId", "turnId", "state", "via"],
  question_opened: ["seq", "at", "instanceId", "kind", "requestId", "sessionId", "turnId", "recipient", "questionKind", "deadlineAt"],
  question_resolved: ["seq", "at", "instanceId", "kind", "requestId", "sessionId", "turnId", "state"],
  instance_ended: ["seq", "at", "instanceId", "kind", "reason"],
};

/** Assigns a monotonic seq. Listener failures never reach the emitter; re-entrant emits are queued so every listener sees seq order. */
export class EventBridge {
  private seq = 0; private readonly listeners = new Set<BridgeListener>(); private readonly queue: BridgeEvent[] = []; private draining = false;
  constructor(readonly instanceId: string, private readonly clock: () => string = () => new Date().toISOString()) {}
  subscribe(listener: BridgeListener): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  emit(event: BridgeEventInput): BridgeEvent {
    const full = { seq: ++this.seq, at: this.clock(), instanceId: this.instanceId, ...event } as BridgeEvent;
    this.queue.push(full);
    if (!this.draining) {
      this.draining = true;
      try { for (let next = this.queue.shift(); next; next = this.queue.shift()) for (const listener of [...this.listeners]) { try { listener(next); } catch { /* A sink failure must not disturb emission or the registry. */ } } } finally { this.draining = false; }
    }
    return full;
  }
}

const spoolName = (event: BridgeEvent): string => `${String(event.seq).padStart(8, "0")}-${event.kind}.json`;
/** One file per event: temp file plus rename, so a reader never sees a partial event. Mode 0600, directory 0700. */
export class SpoolSink {
  constructor(readonly dir: string) { const fresh = !existsSync(dir); mkdirSync(dir, { recursive: true, mode: 0o700 }); if (fresh) chmodSync(dir, 0o700); }
  write(event: BridgeEvent): void {
    const name = spoolName(event), temp = join(this.dir, `.${name}.tmp`);
    writeFileSync(temp, `${JSON.stringify(event)}\n`, { mode: 0o600, flag: "w" });
    chmodSync(temp, 0o600);
    renameSync(temp, join(this.dir, name));
  }
  attach(bridge: EventBridge): () => void { return bridge.subscribe((event) => this.write(event)); }
}
export function readSpool(dir: string): BridgeEvent[] {
  return readdirSync(dir).filter((name) => /^\d{8}-[a-z_]+\.json$/.test(name))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as BridgeEvent).sort((a, b) => a.seq - b.seq);
}

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(reason: Error): void; }
function deferred<T>(): Deferred<T> { let resolve!: (value: T) => void, reject!: (reason: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); promise.catch(() => undefined); return { promise, resolve, reject }; }
const refKey = (ref: TurnRef): string => `${ref.sessionId}/${ref.turnId}`;
const MAX_EMITTED_KEYS = 10_000;

/** Wraps one adapter handle: every prompt/abort settlement pokes the registry, and the prompt learns its public ids. */
class TapHandle implements PiSessionHandle {
  prompts = 0; sessionId: string | undefined; current: Deferred<TurnRef> | undefined;
  /** Mapped adapter outcome of the latest prompt. Used only when close removed the turn before the read model could be read. */
  lastOutcome: TurnTerminalState | undefined;
  constructor(readonly inner: PiSessionHandle, private readonly hooks: { settled(): void; aborting(): void }) {}
  get sdkSessionId(): string { return this.inner.sdkSessionId; }
  get appliedSelection(): PiAppliedSelection { return this.inner.appliedSelection; }
  prompt(text: string, preflight: (accepted: boolean) => void, onActivity?: () => void): Promise<PiTurnOutcome> {
    this.prompts += 1; this.current = deferred<TurnRef>(); this.lastOutcome = undefined;
    let operation: Promise<PiTurnOutcome>;
    try { operation = Promise.resolve(this.inner.prompt(text, preflight, onActivity)); } catch (error) { this.lastOutcome = "failed"; this.hooks.settled(); throw error; }
    return operation.then(
      (outcome) => { this.lastOutcome = outcome.status; this.hooks.settled(); return outcome; },
      (error: unknown) => { this.lastOutcome = "failed"; this.hooks.settled(); throw error; },
    );
  }
  async abort(): Promise<void> { this.hooks.aborting(); try { await this.inner.abort(); } finally { this.hooks.settled(); } }
  dispose(): void | Promise<void> { return this.inner.dispose(); }
}
class TapAdapter implements PiSessionAdapter {
  readonly taps = new WeakMap<PiSessionHandle, TapHandle>(); settled: () => void = () => undefined; aborting: (tap: TapHandle) => void = () => undefined;
  constructor(private readonly inner: PiSessionAdapter, private readonly slot: AsyncLocalStorage<{ tap?: TapHandle }>) {}
  async create(input: { cwd: string; executionProfile: ResolvedExecutionProfile; signal?: AbortSignal }): Promise<PiSessionHandle> {
    const handle = await this.inner.create(input);
    const tap: TapHandle = new TapHandle(handle, { settled: () => this.settled(), aborting: () => this.aborting(tap) });
    this.taps.set(handle, tap);
    const store = this.slot.getStore(); if (store) store.tap = tap;
    return tap;
  }
}

/**
 * Emits `turn_terminal` from the registry read model only. It wraps the adapter so that each settlement of a
 * handle's prompt() or abort() schedules a reconciliation after the registry's own handlers ran; the reconciliation
 * reads `getTurn` for every tracked turn. It never reads SDK state and never uses activity for a terminal decision.
 */
export class BridgedRegistry extends SessionRegistry {
  private readonly slot: AsyncLocalStorage<{ tap?: TapHandle }>; private readonly tapAdapter: TapAdapter;
  private readonly taps = new Map<string, TapHandle>(); private readonly tracked = new Map<string, TurnRef>(); private readonly emitted = new Set<string>();
  private readonly closing = new Map<string, number>(); private scheduled = false; private ended = false;
  constructor(adapter: PiSessionAdapter, workspaces: ReadonlyMap<string, string>, options: SessionRegistryOptions, readonly bridge: EventBridge) {
    const slot = new AsyncLocalStorage<{ tap?: TapHandle }>(), tapAdapter = new TapAdapter(adapter, slot);
    super(tapAdapter, workspaces, options);
    this.slot = slot; this.tapAdapter = tapAdapter;
    tapAdapter.settled = () => this.schedule();
    tapAdapter.aborting = () => this.reconcile();
  }
  /** Resolves with the public ids of the prompt currently running on `handle` (the adapter-side handle), once the registry accepted it. */
  correlation(handle: PiSessionHandle): Promise<TurnRef> {
    const tap = this.tapAdapter.taps.get(handle) ?? (handle instanceof TapHandle ? handle : undefined);
    return tap?.current?.promise ?? Promise.reject(new Error("no_prompt"));
  }
  override async start(workspace: string, executionProfile: ResolvedExecutionProfile): Promise<SessionView> {
    // The handle is created deep inside the registry; the async context lets this call find it without a global slot.
    const store: { tap?: TapHandle } = {};
    const view = await this.slot.run(store, () => super.start(workspace, executionProfile));
    if (store.tap) { store.tap.sessionId = view.id; this.taps.set(view.id, store.tap); }
    return view;
  }
  override async prompt(id: string, text: string): Promise<PromptResult> {
    const tap = this.taps.get(id), before = tap?.prompts ?? 0;
    let result: PromptResult;
    try { result = await super.prompt(id, text); } catch (error) {
      if (tap && tap.prompts > before) tap.current?.reject(new Error("prompt_not_admitted"));
      throw error;
    }
    const ref = { sessionId: result.session.id, turnId: result.turn.turnId };
    if (!this.emitted.has(refKey(ref))) this.tracked.set(refKey(ref), ref);
    if (tap && tap.prompts > before) tap.current?.resolve(ref);
    this.reconcile();
    return result;
  }
  override async abort(id: string): Promise<SessionView> {
    try { return await super.abort(id); } finally { this.reconcile(); }
  }
  override async close(id: string): Promise<SessionView> {
    this.reconcile(); // Terminal-but-unemitted turns must go out before close removes the turn data.
    const open = [...this.tracked.values()].filter((ref) => ref.sessionId === id);
    this.closing.set(id, (this.closing.get(id) ?? 0) + 1);
    let view: SessionView;
    try { view = await super.close(id); } finally { const n = (this.closing.get(id) ?? 1) - 1; if (n > 0) this.closing.set(id, n); else this.closing.delete(id); }
    const fallback = this.taps.get(id)?.lastOutcome ?? "aborted";
    for (const ref of open) this.emitTerminal(ref, fallback, "close");
    this.taps.delete(id);
    return view;
  }
  override async shutdown(): Promise<void> {
    try { await super.shutdown(); } finally { this.endInstance("server_exit"); }
  }
  /** Marks the end of this instance's lifetime once, e.g. `eof` when the controller connection ended. */
  endInstance(reason: "closed" | "eof" | "server_exit"): void { if (this.ended) return; this.ended = true; this.bridge.emit({ kind: "instance_ended", reason }); }
  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => { this.scheduled = false; this.reconcile(); });
  }
  private reconcile(): void {
    for (const ref of [...this.tracked.values()]) {
      let state: TurnState;
      try { state = this.getTurn(ref.sessionId, ref.turnId).state; } catch { continue; }
      if (state !== "running") this.emitTerminal(ref, state, this.closing.has(ref.sessionId) ? "close" : "bridge");
    }
  }
  private emitTerminal(ref: TurnRef, state: TurnTerminalState, via: "bridge" | "close"): void {
    const key = refKey(ref);
    if (this.emitted.has(key)) return;
    this.emitted.add(key); this.tracked.delete(key);
    while (this.emitted.size > MAX_EMITTED_KEYS) this.emitted.delete(this.emitted.values().next().value!);
    this.bridge.emit({ kind: "turn_terminal", sessionId: ref.sessionId, turnId: ref.turnId, state, via });
  }
}

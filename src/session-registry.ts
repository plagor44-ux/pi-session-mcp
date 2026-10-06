import { randomUUID } from "node:crypto";
import { PiSessionCreationError, type PiAppliedSelection, type PiSessionAdapter, type PiSessionHandle, type PiTurnOutcome } from "./pi-adapter.js";
import type { PermissionProfile, ResolvedExecutionProfile, ThinkingLevel } from "./execution-profile.js";
export type SessionState = "idle" | "running" | "failed" | "closing" | "closed";
export type TurnState = "running" | "completed" | "failed" | "aborted";
export interface SessionView {
  id: string; workspace: string; executionProfile: string; profile: PermissionProfile;
  provider: string; model: string; thinkingLevel: ThinkingLevel;
  state: SessionState; createdAt: string; updatedAt: string; lastError?: string;
}
/**
 * `updatedAt` is the registry's own last-activity stamp: while a turn runs it advances on a
 * completed tool execution or completed assistant message, then freezes at the terminal
 * transition. It is a liveness lower bound, not a progress count, and does not prove that a
 * silent turn is healthy.
 */
export interface TurnView { turnId: string; sessionId: string; state: TurnState; startedAt: string; updatedAt: string; completedAt?: string; assistantText?: string; truncated?: boolean; error?: { code: "turn_failed"; message: "Pi turn failed" }; }
export interface PromptResult { session: SessionView; turn: TurnView; }
interface TurnEntry extends TurnView { terminal: boolean; abortPromise?: Promise<void> | undefined; }
interface Entry extends SessionView { handle: PiSessionHandle; turn?: TurnEntry | undefined; turnPromise?: Promise<PiTurnOutcome> | undefined; abortPromise?: Promise<void> | undefined; operation: Promise<void>; disposed: boolean; turns: Map<string, TurnEntry>; order: string[]; }
export type RegistryErrorCode = "unknown_workspace" | "unknown_session" | "session_running" | "prompt_rejected" | "prompt_timeout" | "abort_failed" | "abort_timeout" | "unknown_turn" | "unknown_execution_profile" | "server_stopping";
const REGISTRY_ERROR_MESSAGES: Record<RegistryErrorCode, string> = {
  unknown_workspace: "Unknown workspace",
  unknown_session: "Unknown session",
  session_running: "Session already has a running turn",
  prompt_rejected: "Pi rejected the prompt during preflight",
  prompt_timeout: "Pi prompt preflight timed out",
  abort_failed: "Pi abort failed",
  abort_timeout: "Pi abort timed out",
  unknown_turn: "Unknown turn",
  unknown_execution_profile: "Unknown execution profile",
  server_stopping: "Server is shutting down",
};
export class RegistryError extends Error {
  constructor(readonly code: RegistryErrorCode) { super(REGISTRY_ERROR_MESSAGES[code]); this.name = "RegistryError"; }
}
export const MAX_TURNS_PER_SESSION = 20;
export const MAX_TURN_TEXT_BYTES = 64 * 1024;
export const MAX_CLOSED_TOMBSTONES = 100;
export const PREFLIGHT_DEADLINE_MS = 5_000;
export const ABORT_DEADLINE_MS = 5_000;
export const CLOSE_CLEANUP_DEADLINE_MS = 5_000;
export const SHUTDOWN_DEADLINE_MS = 12_000;
const stamp = () => new Date().toISOString();
export interface SessionRegistryOptions { preflightDeadlineMs?: number; abortDeadlineMs?: number; closeCleanupDeadlineMs?: number; shutdownDeadlineMs?: number; }
function normalize(text: string): { text: string; truncated: boolean } { const value = text.trim(); if (Buffer.byteLength(value, "utf8") <= MAX_TURN_TEXT_BYTES) return { text: value, truncated: false }; let out = ""; let size = 0; for (const c of value) { const n = Buffer.byteLength(c, "utf8"); if (size + n > MAX_TURN_TEXT_BYTES) break; out += c; size += n; } return { text: out, truncated: true }; }
export class SessionRegistry {
  private readonly sessions = new Map<string, Entry>(); private readonly closed = new Map<string, SessionView>();
  private readonly pendingStarts = new Set<Promise<SessionView>>();
  private readonly options: Required<SessionRegistryOptions>;
  private stopping = false;
  private readonly shutdownController = new AbortController();
  constructor(private readonly adapter: PiSessionAdapter, private readonly workspaces: ReadonlyMap<string, string>, options: SessionRegistryOptions = {}) {
    this.options = { preflightDeadlineMs: options.preflightDeadlineMs ?? PREFLIGHT_DEADLINE_MS, abortDeadlineMs: options.abortDeadlineMs ?? ABORT_DEADLINE_MS, closeCleanupDeadlineMs: options.closeCleanupDeadlineMs ?? CLOSE_CLEANUP_DEADLINE_MS, shutdownDeadlineMs: options.shutdownDeadlineMs ?? SHUTDOWN_DEADLINE_MS };
  }
  async start(workspace: string, executionProfile: ResolvedExecutionProfile): Promise<SessionView> {
    if (this.stopping) throw new RegistryError("server_stopping");
    const cwd = this.workspaces.get(workspace);
    if (!cwd) throw new RegistryError("unknown_workspace");
    // Track registration and orphan cleanup too, not just the raw adapter promise.
    const start = this.createAndRegister(cwd, workspace, executionProfile);
    this.pendingStarts.add(start);
    try { return await start; } finally { this.pendingStarts.delete(start); }
  }
  private async createAndRegister(cwd: string, workspace: string, executionProfile: ResolvedExecutionProfile): Promise<SessionView> {
    const handle = await Promise.resolve().then(() => this.adapter.create({ cwd, executionProfile, signal: this.shutdownController.signal }));
    try {
      if (this.stopping) throw new RegistryError("server_stopping");
      this.verifySelection(handle.appliedSelection, executionProfile);
      const time = stamp();
      const entry: Entry = {
        id: randomUUID(), workspace, executionProfile: executionProfile.alias, profile: executionProfile.permissionProfile,
        provider: handle.appliedSelection.provider, model: handle.appliedSelection.model,
        thinkingLevel: handle.appliedSelection.thinkingLevel, state: "idle", createdAt: time, updatedAt: time,
        handle, operation: Promise.resolve(), disposed: false, turns: new Map(), order: [],
      };
      this.sessions.set(entry.id, entry);
      return this.view(entry);
    } catch (error) {
      await this.disposeHandle(handle);
      throw error;
    }
  }
  list(): SessionView[] { return [...this.sessions.values()].map((e) => this.view(e)); }
  get(id: string): SessionView { return this.view(this.require(id)); }
  getTurn(sessionId: string, turnId: string): TurnView {
    const entry = this.require(sessionId);
    const turn = entry.turns.get(turnId);
    if (!turn) throw new RegistryError("unknown_turn");
    return this.turnView(turn);
  }
  async prompt(id: string, text: string): Promise<PromptResult> {
    const entry = this.require(id);
    return this.serial(entry, async () => {
      if (entry.state === "running" || entry.abortPromise) throw new RegistryError("session_running");
      if (entry.state === "closing" || entry.state === "closed") throw new RegistryError("unknown_session");
      const previous = { state: entry.state, updatedAt: entry.updatedAt, lastError: entry.lastError };
      const time = stamp();
      const turn: TurnEntry = { turnId: randomUUID(), sessionId: id, state: "running", startedAt: time, updatedAt: time, terminal: false };
      entry.turn = turn;
      entry.state = "running";
      entry.updatedAt = time;
      delete entry.lastError;

      let accepted: boolean | undefined;
      let signaled = false;
      let signal!: (value: boolean) => void;
      const preflight = new Promise<boolean>((resolve) => {
        signal = (value) => {
          if (signaled) return;
          signaled = true;
          accepted = value;
          resolve(value);
        };
      });
      let pendingActivityAt: string | undefined;
      const onActivity = (): void => {
        if (accepted !== true || this.stopping || entry.disposed || entry.turn !== turn || turn.terminal) return;
        if (entry.turns.has(turn.turnId)) {
          this.recordActivity(entry, turn);
        } else {
          const time = stamp();
          if (pendingActivityAt === undefined || time > pendingActivityAt) pendingActivityAt = time;
        }
      };
      const publishAcceptedTurn = (): void => {
        this.publishTurn(entry, turn);
        if (pendingActivityAt !== undefined) this.recordActivity(entry, turn, pendingActivityAt);
      };

      let operation: Promise<PiTurnOutcome>;
      try {
        operation = Promise.resolve(entry.handle.prompt(text, signal, onActivity));
      } catch {
        if (accepted === true) {
          publishAcceptedTurn();
          this.failTurn(entry, turn);
          return { session: this.view(entry), turn: this.turnView(turn) };
        }
        this.restorePreflight(entry, turn, undefined, previous);
        throw new RegistryError("prompt_rejected");
      }
      entry.turnPromise = operation;
      void operation.then(() => undefined, () => undefined);

      type Admission = { kind: "preflight"; value: boolean } | { kind: "operation" } | { kind: "timeout" };
      const result = await this.withTimeout<Exclude<Admission, { kind: "timeout" }>, Admission>(Promise.race([
        preflight.then((value) => ({ kind: "preflight" as const, value })),
        operation.then(() => ({ kind: "operation" as const }), () => ({ kind: "operation" as const })),
      ]), this.options.preflightDeadlineMs, { kind: "timeout" });

      if (result.kind === "timeout") {
        this.quarantineTimedOutPreflight(entry, turn, operation, previous);
        throw new RegistryError("prompt_timeout");
      }
      if (result.kind === "operation" || result.value === false) {
        this.restorePreflight(entry, turn, operation, previous);
        throw new RegistryError("prompt_rejected");
      }

      publishAcceptedTurn();
      void operation.then((outcome) => this.completeTurn(entry, turn, outcome), () => this.failTurn(entry, turn));
      return { session: this.view(entry), turn: this.turnView(turn) };
    });
  }
  async abort(id: string): Promise<SessionView> {
    const entry = this.require(id);
    const operation = this.serial(entry, async () => {
      const turn = entry.turn;
      if (entry.state !== "running" || !turn || turn.terminal) return undefined;
      return { turn, abortPromise: this.beginAbort(entry, turn) };
    }).then(async (prepared) => {
      if (!prepared) return this.view(entry);
      try {
        await prepared.abortPromise;
      } catch {
        throw new RegistryError("abort_failed");
      }
      if (entry.turns.has(prepared.turn.turnId) && entry.turn === prepared.turn && !prepared.turn.terminal && !entry.disposed) {
        this.completeTurn(entry, prepared.turn, { status: "aborted" });
      }
      return this.view(entry);
    });
    type AbortResult = { kind: "completed"; session: SessionView } | { kind: "failed" } | { kind: "timeout" };
    const result = await this.withTimeout<Exclude<AbortResult, { kind: "timeout" }>, AbortResult>(operation.then(
      (session) => ({ kind: "completed" as const, session }),
      () => ({ kind: "failed" as const }),
    ), this.options.abortDeadlineMs, { kind: "timeout" });
    if (result.kind === "timeout") throw new RegistryError("abort_timeout");
    if (result.kind === "failed") throw new RegistryError("abort_failed");
    return result.session;
  }
  async close(id: string): Promise<SessionView> {
    const existing = this.sessions.get(id);
    if (!existing) {
      const closed = this.closed.get(id);
      if (closed) return { ...closed };
      throw new RegistryError("unknown_session");
    }
    return this.serial(existing, async () => {
      if (existing.disposed) return this.view(existing);
      existing.state = "closing";
      existing.updatedAt = stamp();
      const turn = existing.turn;
      if (turn && !turn.terminal) {
        turn.terminal = true;
        turn.state = "aborted";
        const time = this.advance(turn.updatedAt);
        turn.updatedAt = time;
        turn.completedAt = time;
        const abortPromise = this.beginAbort(existing, turn);
        await this.withTimeout(abortPromise.then(() => undefined, () => undefined), this.options.closeCleanupDeadlineMs, undefined);
      }
      existing.turn = undefined;
      existing.turnPromise = undefined;
      existing.turns.clear();
      existing.order.length = 0;
      await this.dispose(existing);
      existing.state = "closed";
      existing.updatedAt = stamp();
      const view = this.view(existing);
      this.rememberClosed(id, view);
      this.sessions.delete(id);
      return view;
    });
  }
  async shutdown(): Promise<void> {
    this.stopping = true;
    this.shutdownController.abort();
    const cleanup = Promise.all([
      Promise.allSettled([...this.sessions.keys()].map((id) => this.close(id))),
      Promise.allSettled([...this.pendingStarts]),
    ]).then(() => undefined);
    await this.withTimeout(cleanup, this.options.shutdownDeadlineMs, undefined);
  }
  private require(id: string): Entry { const entry = this.sessions.get(id); if (!entry) throw new RegistryError("unknown_session"); return entry; }
  private verifySelection(applied: PiAppliedSelection, expected: ResolvedExecutionProfile): void {
    if (applied.provider !== expected.provider || applied.model !== expected.model || applied.thinkingLevel !== expected.thinkingLevel) {
      throw new PiSessionCreationError("execution_selection_mismatch");
    }
  }
  private completeTurn(entry: Entry, turn: TurnEntry, outcome: PiTurnOutcome): void { if (turn.terminal || entry.disposed) return; turn.terminal = true; turn.updatedAt = this.advance(turn.updatedAt); turn.completedAt = turn.updatedAt; if (outcome.status === "completed") { const normalized = normalize(outcome.assistantText); turn.state = "completed"; turn.assistantText = normalized.text; turn.truncated = normalized.truncated; } else if (outcome.status === "aborted") turn.state = "aborted"; else { turn.state = "failed"; turn.error = { code: "turn_failed", message: "Pi turn failed" }; entry.lastError = "Pi turn failed"; } if (entry.turn === turn) entry.turn = undefined; if (entry.turnPromise) entry.turnPromise = undefined; entry.state = turn.state === "failed" ? "failed" : "idle"; entry.updatedAt = turn.updatedAt; }
  private failTurn(entry: Entry, turn: TurnEntry): void { if (turn.terminal) return; turn.terminal = true; turn.state = "failed"; turn.updatedAt = this.advance(turn.updatedAt); turn.completedAt = turn.updatedAt; turn.error = { code: "turn_failed", message: "Pi turn failed" }; if (entry.turn === turn) entry.turn = undefined; if (entry.turnPromise) entry.turnPromise = undefined; entry.state = "failed"; entry.updatedAt = turn.updatedAt; entry.lastError = "Pi turn failed"; }
  /**
   * Liveness only. A completed tool execution or assistant message advances this turn,
   * never another turn or the session. Activity after accepted preflight but before
   * publication is stamped and applied only if the turn is published; callbacks before
   * acceptance or after terminal cleanup cannot publish or revive a turn.
   */
  private recordActivity(entry: Entry, turn: TurnEntry, observedAt?: string): void {
    if (this.stopping || entry.disposed) return;
    if (entry.turn !== turn || !entry.turns.has(turn.turnId)) return;
    if (entry.state !== "running" || turn.state !== "running" || turn.terminal) return;
    const time = this.advance(turn.updatedAt, observedAt);
    // Sub-millisecond activity is simply the same stamp; a timestamp never moves backwards.
    if (time === turn.updatedAt) return;
    turn.updatedAt = time;
  }
  /** The registry's own clock: never earlier than `current`, even across a wall-clock step. */
  private advance(current: string, observedAt = stamp()): string { return observedAt > current ? observedAt : current; }
  private publishTurn(entry: Entry, turn: TurnEntry): void { if (entry.turns.has(turn.turnId)) return; entry.turns.set(turn.turnId, turn); entry.order.push(turn.turnId); this.trim(entry); }
  private restorePreflight(entry: Entry, turn: TurnEntry, operation: Promise<PiTurnOutcome> | undefined, previous: { state: SessionState; updatedAt: string; lastError: string | undefined }): void { turn.terminal = true; if (entry.turn === turn) entry.turn = undefined; if (!operation || entry.turnPromise === operation) entry.turnPromise = undefined; entry.state = previous.state; entry.updatedAt = previous.updatedAt; if (previous.lastError === undefined) delete entry.lastError; else entry.lastError = previous.lastError; }
  private trim(entry: Entry): void { while (entry.order.length > MAX_TURNS_PER_SESSION) { const old = entry.order.shift(); if (old) entry.turns.delete(old); } }
  private beginAbort(entry: Entry, turn: TurnEntry): Promise<void> {
    if (turn.abortPromise) return turn.abortPromise;
    const pending = Promise.resolve().then(() => entry.handle.abort());
    turn.abortPromise = pending;
    entry.abortPromise = pending;
    void pending.then(
      () => {
        if (entry.abortPromise === pending) entry.abortPromise = undefined;
        if (entry.turns.has(turn.turnId) && entry.turn === turn && !turn.terminal && !entry.disposed) {
          this.completeTurn(entry, turn, { status: "aborted" });
        }
      },
      () => {
        if (entry.abortPromise === pending) entry.abortPromise = undefined;
        if (turn.abortPromise === pending) turn.abortPromise = undefined;
      },
    );
    return pending;
  }
  private quarantineTimedOutPreflight(
    entry: Entry,
    turn: TurnEntry,
    operation: Promise<PiTurnOutcome>,
    previous: { state: SessionState; updatedAt: string; lastError: string | undefined },
  ): void {
    let promptSettled = false;
    let abortSettled = false;
    const releaseIfSafe = (): void => {
      if (turn.terminal || entry.disposed || entry.turn !== turn) return;
      if (abortSettled && promptSettled) this.restorePreflight(entry, turn, operation, previous);
    };
    void operation.then(
      () => { promptSettled = true; releaseIfSafe(); },
      () => { promptSettled = true; releaseIfSafe(); },
    );
    const abortPromise = this.beginAbort(entry, turn);
    void abortPromise.then(
      () => { abortSettled = true; releaseIfSafe(); },
      () => { abortSettled = true; releaseIfSafe(); },
    );
  }
  private async dispose(entry: Entry): Promise<void> {
    if (entry.disposed) return;
    entry.disposed = true;
    await this.disposeHandle(entry.handle);
  }
  private async disposeHandle(handle: PiSessionHandle): Promise<void> {
    try {
      const cleanup = Promise.resolve(handle.dispose()).then(() => undefined, () => undefined);
      await this.withTimeout(cleanup, this.options.closeCleanupDeadlineMs, undefined);
    } catch { /* Cleanup errors must never expose adapter internals. */ }
  }
  private rememberClosed(id: string, view: SessionView): void { this.closed.set(id, view); while (this.closed.size > MAX_CLOSED_TOMBSTONES) this.closed.delete(this.closed.keys().next().value!); }
  private turnView({ terminal: _terminal, abortPromise: _abortPromise, ...turn }: TurnEntry): TurnView { return { ...turn }; }
  private view({ handle: _handle, turn: _turn, turnPromise: _turnPromise, abortPromise: _abortPromise, operation: _operation, disposed: _disposed, turns: _turns, order: _order, ...view }: Entry): SessionView { return { ...view }; }
  private async withTimeout<T>(promise: Promise<T>, milliseconds: number, fallback: T): Promise<T>;
  private async withTimeout<T, F>(promise: Promise<T>, milliseconds: number, fallback: F): Promise<T | F>;
  private async withTimeout<T>(promise: Promise<T>, milliseconds: number, fallback: T): Promise<T> { if (milliseconds <= 0) return fallback; let timer: ReturnType<typeof setTimeout> | undefined; const timeout = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), milliseconds); }); try { return await Promise.race([promise, timeout]); } finally { if (timer !== undefined) clearTimeout(timer); } }
  private async serial<T>(entry: Entry, action: () => Promise<T>): Promise<T> { const previous = entry.operation; let release!: () => void; entry.operation = new Promise<void>((resolve) => { release = resolve; }); await previous.catch(() => undefined); try { return await action(); } finally { release(); } }
}

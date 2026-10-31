import { RegistryError, type PromptResult, type SessionRegistry, type TurnTerminalNotice } from "../../src/session-registry.js";

export const MAX_TURN_SECONDS_MIN = 60;
export const MAX_TURN_SECONDS_MAX = 86_400;

export function parseMaxTurnSeconds(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < MAX_TURN_SECONDS_MIN || value > MAX_TURN_SECONDS_MAX) {
    throw new Error("invalid_max_turn_seconds");
  }
  return value;
}

export type ExpiryOutcome = "aborted" | "settled_first" | "abort_failed" | "abort_timeout";
type Expiry = { sessionId: string; turnId: string; outcome: ExpiryOutcome };
type Deadline = {
  sessionId: string;
  turnId: string;
  at: number;
  timer?: ReturnType<typeof setTimeout>;
  terminal?: TurnTerminalNotice;
};

/** Development-only external experiment: callers must route onTurnTerminal to notice. */
export class DeadlineSupervisor {
  private readonly milliseconds: number;
  private readonly now: () => number;
  private readonly deadlines = new Map<string, Deadline>();
  private readonly uncertain = new Set<string>();
  private readonly outcomes: Expiry[] = [];

  constructor(private readonly registry: SessionRegistry, options: { maxTurnSeconds: number; now?: () => number }) {
    const seconds = parseMaxTurnSeconds(options.maxTurnSeconds);
    if (seconds === undefined) throw new Error("invalid_max_turn_seconds");
    this.milliseconds = seconds * 1000;
    this.now = options.now ?? (() => performance.now());
  }

  async prompt(sessionId: string, text: string): Promise<PromptResult> {
    if (!this.usable(sessionId)) throw new Error("turn_deadline_uncertain");
    const result = await this.registry.prompt(sessionId, text);
    const at = this.now() + this.milliseconds;
    // A synchronous completion can notify before registry.prompt resolves. Read the
    // registry, not the returned snapshot, before creating a timer for that turn.
    if (this.registry.getTurn(sessionId, result.turn.turnId).state !== "running") return result;
    const deadline: Deadline = { sessionId, turnId: result.turn.turnId, at };
    this.deadlines.set(deadline.turnId, deadline);
    this.arm(deadline);
    return result;
  }

  notice(event: TurnTerminalNotice): void {
    const deadline = this.deadlines.get(event.turnId);
    if (!deadline || deadline.sessionId !== event.sessionId) return;
    deadline.terminal = { ...event };
    this.clear(deadline);
    this.deadlines.delete(event.turnId);
  }

  expiries(): ReadonlyArray<Expiry> { return this.outcomes.map((outcome) => ({ ...outcome })); }

  /** Deadline safety only; registry admission still decides whether a session exists/is idle. */
  usable(sessionId: string): boolean { return !this.uncertain.has(sessionId); }

  private clear(deadline: Deadline): void {
    if (deadline.timer !== undefined) clearTimeout(deadline.timer);
    delete deadline.timer;
  }

  private arm(deadline: Deadline): void {
    deadline.timer = setTimeout(() => {
      this.clear(deadline);
      // Timer time and the injected monotonic clock must agree. Never use Date.
      if (this.now() < deadline.at) { this.arm(deadline); return; }
      void this.expire(deadline).catch(() => {
        this.clear(deadline);
        this.deadlines.delete(deadline.turnId);
        this.uncertain.add(deadline.sessionId);
        this.outcomes.push({ sessionId: deadline.sessionId, turnId: deadline.turnId, outcome: "abort_failed" });
      });
    }, Math.max(0, deadline.at - this.now()));
  }

  private async expire(deadline: Deadline): Promise<void> {
    const { sessionId, turnId } = deadline;
    try {
      if (this.registry.getTurn(sessionId, turnId).state !== "running") {
        this.deadlines.delete(turnId);
        return;
      }
    } catch (error) {
      // Close removes the read model; it also emits a terminal notice first.
      if (error instanceof RegistryError && error.code === "unknown_session") {
        this.deadlines.delete(turnId);
        return;
      }
      throw error;
    }
    let outcome: ExpiryOutcome;
    try {
      await this.registry.abort(sessionId);
      // A close notice cannot prove that this expiry cancelled anything, even
      // though today's close marks the turn aborted before abort has settled.
      outcome = deadline.terminal?.state === "aborted" && deadline.terminal.via === "registry"
        ? "aborted" : "settled_first";
    } catch (error) {
      outcome = error instanceof RegistryError && error.code === "abort_timeout" ? "abort_timeout" : "abort_failed";
      this.uncertain.add(sessionId);
    } finally {
      this.clear(deadline);
      this.deadlines.delete(turnId);
    }
    this.outcomes.push({ sessionId, turnId, outcome });
  }
}

/**
 * Ctrl-C handling for guided setup (ADR 0022). The terminal sends SIGINT to the whole foreground process group,
 * so while a credential command (`auth set` or `auth login`) runs as a child on the owner's terminal, the child
 * handles it and guided setup drops it: the interrupt ends only that command, and the interview continues.
 * Anywhere else it aborts the run with 130. This module has no imports, so `setup-main` registers the handler
 * before it loads the guided module.
 */
export interface GuidedInterrupts {
  /** SIGINT handler: aborts the controller with 130 unless a credential command runs. */
  readonly interrupt: () => void;
  /** Runs `run` with interrupts dropped; overlapping calls nest. */
  readonly defer: <T>(run: () => Promise<T>) => Promise<T>;
}

export function guidedInterrupts(controller: AbortController): GuidedInterrupts {
  let running = 0;
  return Object.freeze({
    interrupt: (): void => { if (running === 0) controller.abort(130); },
    defer: async <T>(run: () => Promise<T>): Promise<T> => {
      running += 1;
      try { return await run(); }
      finally { running -= 1; }
    },
  });
}

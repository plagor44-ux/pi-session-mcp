export const PROCESS_SHUTDOWN_TIMEOUT_MS = 15_000;

export type ShutdownResult = "completed" | "failed" | "timed_out";

export interface TerminationHooks {
  readonly report: (result: ShutdownResult) => void;
  readonly terminate: (code: number) => void;
}

/** Bounds how long the signal handler waits; it does not prove SDK/provider termination. */
export async function shutdownWithDeadline(
  registryShutdown: () => Promise<void>,
  transportClose: () => Promise<void>,
  timeoutMs = PROCESS_SHUTDOWN_TIMEOUT_MS,
): Promise<ShutdownResult> {
  let timer: NodeJS.Timeout | undefined;
  let transportPromise: Promise<void> | undefined;
  const closeTransport = (): Promise<void> => {
    transportPromise ??= Promise.resolve().then(transportClose);
    return transportPromise;
  };
  const operation = (async (): Promise<ShutdownResult> => {
    let failed = false;
    try {
      await registryShutdown();
    } catch {
      failed = true;
    }
    try {
      await closeTransport();
    } catch {
      failed = true;
    }
    return failed ? "failed" : "completed";
  })();
  const deadline = new Promise<ShutdownResult>((resolve) => {
    timer = setTimeout(() => {
      void closeTransport().catch(() => undefined);
      resolve("timed_out");
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Reports the bounded result and then applies the explicit process-termination policy. */
export async function shutdownAndTerminate(
  registryShutdown: () => Promise<void>,
  transportClose: () => Promise<void>,
  exitCode: number,
  hooks: TerminationHooks,
  timeoutMs = PROCESS_SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  const result = await shutdownWithDeadline(registryShutdown, transportClose, timeoutMs);
  try {
    hooks.report(result);
  } catch {
    // Reporting must not prevent the terminal process policy.
  } finally {
    hooks.terminate(exitCode);
  }
}

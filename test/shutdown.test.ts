import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { PROCESS_SHUTDOWN_TIMEOUT_MS, shutdownAndTerminate, shutdownWithDeadline } from "../src/shutdown.js";

describe("process shutdown deadline", () => {
  it("closes the transport after registry cleanup", async () => {
    const order: string[] = [];
    await expect(shutdownWithDeadline(
      async () => { order.push("registry"); },
      async () => { order.push("transport"); },
    )).resolves.toBe("completed");
    expect(order).toEqual(["registry", "transport"]);
  });

  it("returns a bounded timeout while observing late cleanup rejection", async () => {
    vi.useFakeTimers();
    try {
      let reject!: (reason?: unknown) => void;
      const pending = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
      const shutdown = shutdownWithDeadline(() => pending, async () => undefined);
      await vi.advanceTimersByTimeAsync(PROCESS_SHUTDOWN_TIMEOUT_MS);
      await expect(shutdown).resolves.toBe("timed_out");
      reject(new Error("private late shutdown detail"));
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sanitizes synchronous cleanup failure to a stable result", async () => {
    const transport = vi.fn(async () => undefined);
    await expect(shutdownWithDeadline(
      async () => { throw new Error("private registry detail"); },
      transport,
    )).resolves.toBe("failed");
    expect(transport).toHaveBeenCalledOnce();
  });

  it("attempts transport cleanup once at timeout and again observes late registry settlement", async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      const transport = vi.fn(async () => undefined);
      const shutdown = shutdownWithDeadline(() => pending, transport);
      await vi.advanceTimersByTimeAsync(PROCESS_SHUTDOWN_TIMEOUT_MS);
      await expect(shutdown).resolves.toBe("timed_out");
      expect(transport).toHaveBeenCalledOnce();
      release();
      await Promise.resolve();
      expect(transport).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies explicit process termination after the bounded signal deadline", async () => {
    vi.useFakeTimers();
    try {
      const results: string[] = [];
      const exitCodes: number[] = [];
      const shutdown = shutdownAndTerminate(
        () => new Promise<void>(() => undefined),
        async () => undefined,
        143,
        { report: (result) => { results.push(result); }, terminate: (code) => { exitCodes.push(code); } },
      );
      await vi.advanceTimersByTimeAsync(PROCESS_SHUTDOWN_TIMEOUT_MS);
      await shutdown;
      expect(results).toEqual(["timed_out"]);
      expect(exitCodes).toEqual([143]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminates a child process with an open event-loop handle after bounded cleanup", async () => {
    const moduleUrl = pathToFileURL(resolve("src/shutdown.ts")).href;
    const script = `
      import { shutdownAndTerminate } from ${JSON.stringify(moduleUrl)};
      setInterval(() => undefined, 1_000);
      process.once("SIGTERM", () => {
        void shutdownAndTerminate(
          () => new Promise(() => undefined),
          async () => undefined,
          143,
          { report: () => undefined, terminate: (code) => process.exit(code) },
          25,
        );
      });
      process.stdout.write("ready\\n");
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        child.once("error", rejectReady);
        child.stdout.once("data", () => resolveReady());
      });
      child.kill("SIGTERM");
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
        const timeout = setTimeout(() => rejectExit(new Error("child process did not terminate")), 2_000);
        child.once("exit", (code, signal) => {
          clearTimeout(timeout);
          resolveExit({ code, signal });
        });
      });
      expect(exit).toEqual({ code: 143, signal: null });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
});

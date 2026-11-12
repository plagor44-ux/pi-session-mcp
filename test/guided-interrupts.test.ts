import { describe, expect, it, vi } from "vitest";
import { guidedInterrupts } from "../src/guided/interrupts.js";
import { main } from "../src/setup-main.js";

const observed = vi.hoisted(() => ({ during: undefined as boolean | undefined, after: undefined as unknown }));
// Stands in for the guided interview: one Ctrl-C while a credential command runs, one after it.
vi.mock("../src/setup-guided-main.js", () => ({
  runGuidedMain: async (_request: unknown, _json: boolean, signal: AbortSignal, injected: { deferInterrupts?: <T>(run: () => Promise<T>) => Promise<T> } = {}) => {
    await (injected.deferInterrupts ?? (<T>(run: () => Promise<T>) => run()))(async () => { process.emit("SIGINT"); });
    observed.during = signal.aborted;
    process.emit("SIGINT");
    observed.after = signal.reason;
    return 0;
  },
}));

// The handlers are used unbound, as `process.on("SIGINT", gate.interrupt)` calls them.
describe("guided interrupts", () => {
  it("aborts the run with 130 on an interrupt outside a credential command", () => {
    const controller = new AbortController();
    const { interrupt } = guidedInterrupts(controller);
    interrupt();
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe(130);
  });

  it("drops an interrupt while a credential command runs and honours the next one", async () => {
    const controller = new AbortController();
    const { interrupt, defer } = guidedInterrupts(controller);
    expect(await defer(async () => { interrupt(); return 7; })).toBe(7);
    expect(controller.signal.aborted).toBe(false);
    interrupt();
    expect(controller.signal.reason).toBe(130);
  });

  it("restores interrupt handling when the command fails", async () => {
    const failure = new Error("command failed");
    for (const run of [async (): Promise<never> => { throw failure; }, (): Promise<never> => { throw failure; }]) {
      const controller = new AbortController();
      const { interrupt, defer } = guidedInterrupts(controller);
      await expect(defer(run)).rejects.toBe(failure);
      expect(controller.signal.aborted).toBe(false);
      interrupt();
      expect(controller.signal.reason).toBe(130);
    }
  });

  it("keeps deferring while an overlapping command still runs", async () => {
    const controller = new AbortController();
    const { interrupt, defer } = guidedInterrupts(controller);
    let release!: () => void;
    const longer = defer(() => new Promise<void>((resolve) => { release = resolve; }));
    await defer(async () => {});
    interrupt();
    expect(controller.signal.aborted).toBe(false);
    release();
    await longer;
    interrupt();
    expect(controller.signal.reason).toBe(130);
  });

  it("setup-main leaves a Ctrl-C to the credential command and aborts the guided run otherwise", async () => {
    const before = process.listenerCount("SIGINT");
    expect(await main(["--guided"])).toBe(0);
    expect(observed.during).toBe(false);
    expect(observed.after).toBe(130);
    expect(process.listenerCount("SIGINT")).toBe(before);
  });
});

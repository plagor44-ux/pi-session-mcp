import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installStdoutGuard } from "../src/stdout-guard.js";

afterEach(() => { vi.useRealTimers(); });

function harness(intervalMs = 60_000) {
  const written: Buffer[] = [];
  const stream = new Writable({ write(chunk, _encoding, callback) { written.push(Buffer.from(chunk as Buffer)); callback(); } }) as unknown as NodeJS.WriteStream;
  const reports: string[] = [];
  const fakeConsole = { log: vi.fn(), info: vi.fn(), debug: vi.fn() };
  let exitFlush: (() => void) | undefined;
  const guard = installStdoutGuard({ stream, console: fakeConsole, report: (line) => { reports.push(line); }, intervalMs, onExit: (flush) => { exitFlush = flush; } });
  return { guard, stream, written, reports, fakeConsole, exit: () => exitFlush?.() };
}

const transportWrite = (guard: ReturnType<typeof installStdoutGuard>, text: string) => new Promise<void>((resolve, reject) => {
  guard.transportStdout.write(text, (error) => { if (error) reject(error); else resolve(); });
});

describe("stdout guard", () => {
  it("lets only the transport reach stdout and reports foreign output without content", async () => {
    const h = harness();
    await transportWrite(h.guard, '{"jsonrpc":"2.0"}\n');
    h.stream.write("foreign text\n");
    h.fakeConsole.log("secret prompt", 42);
    expect(Buffer.concat(h.written).toString("utf8")).toBe('{"jsonrpc":"2.0"}\n');
    h.guard.flush();
    expect(h.reports).toHaveLength(1);
    expect(JSON.parse(h.reports[0]!)).toEqual({
      level: "warning", event: "foreign_stdout_suppressed",
      bytes: Buffer.byteLength("foreign text\n") + Buffer.byteLength("secret prompt 42\n"), writes: 2,
    });
    expect(h.reports[0]).not.toContain("secret");
  });

  it("completes foreign writes and counts Buffer bytes", async () => {
    const h = harness();
    const done = vi.fn();
    expect(h.stream.write(Buffer.from([1, 2, 3]), done)).toBe(true);
    const doneWithEncoding = vi.fn();
    h.stream.write("ab", "utf8", doneWithEncoding);
    await new Promise((resolve) => setImmediate(resolve));
    expect(done).toHaveBeenCalledTimes(1);
    expect(doneWithEncoding).toHaveBeenCalledTimes(1);
    h.guard.flush();
    expect(JSON.parse(h.reports[0]!)).toMatchObject({ bytes: 5, writes: 2 });
  });

  it("reports at most once per interval and flushes on exit", async () => {
    vi.useFakeTimers();
    const h = harness(1_000);
    h.stream.write("a");
    h.fakeConsole.info("b");
    expect(h.reports).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.reports).toHaveLength(1);
    expect(JSON.parse(h.reports[0]!)).toMatchObject({ writes: 2 });
    h.fakeConsole.debug("c");
    h.exit();
    expect(h.reports).toHaveLength(2);
    h.guard.flush();
    expect(h.reports).toHaveLength(2);
  });

  it("forwards stdout errors to the transport stream", async () => {
    const h = harness();
    const onError = vi.fn();
    h.guard.transportStdout.on("error", onError);
    const failure = Object.assign(new Error("hidden"), { code: "EPIPE" });
    h.stream.emit("error", failure);
    // `destroy(error)` emits the error on a later tick.
    await new Promise((resolve) => setImmediate(resolve));
    expect(onError).toHaveBeenCalledWith(failure);
  });
});

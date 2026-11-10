import { PassThrough, Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { readProviderKey } from "../src/provider-key-input.js";

describe("provider key input", () => {
  it("reads stdin and strips only one trailing newline", async () => {
    expect(await readProviderKey(Readable.from(["sk-test-SENTINEL\n\n"]), true)).toBe("sk-test-SENTINEL\n");
  });
  it("uses raw mode and restores it after entry and cancellation", async () => {
    for (const [text, expected] of [["sk-test-SENTINEL\r", "sk-test-SENTINEL"], ["partial\u0003", undefined]] as const) {
      const stream = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: vi.fn() });
      const result = readProviderKey(stream, false);
      stream.write(text);
      expect(await result).toBe(expected);
      expect(stream.setRawMode.mock.calls).toEqual([[true], [false]]);
    }
  });
  it.each(["SIGINT", "SIGTERM"] as const)("cancels on %s and restores raw mode", async (signal) => {
    const stream = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: vi.fn() });
    const before = process.listenerCount(signal);
    const result = readProviderKey(stream, false);
    stream.write("partial");
    await new Promise(resolve => setImmediate(resolve));
    process.emit(signal, signal);
    expect(await result).toBeUndefined();
    expect(stream.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(process.listenerCount(signal)).toBe(before);
  });
  it("restores raw mode when the process exits during the prompt", async () => {
    const stream = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: vi.fn() });
    const before = process.listeners("exit");
    const result = readProviderKey(stream, false);
    const added = process.listeners("exit").filter(listener => !before.includes(listener));
    expect(added).toHaveLength(1);
    (added[0] as () => void)();
    expect(stream.setRawMode.mock.calls).toEqual([[true], [false]]);
    stream.write("\u0003"); expect(await result).toBeUndefined();
    expect(process.listeners("exit").filter(listener => !before.includes(listener))).toHaveLength(0);
  });
  it("refuses a non-terminal and handles closed input", async () => {
    expect(await readProviderKey(Readable.from([]), false)).toBeUndefined();
    const stream = new PassThrough(); stream.destroy();
    expect(await readProviderKey(stream, true)).toBeUndefined();
  });
});

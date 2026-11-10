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
  it("refuses a non-terminal and handles closed input", async () => {
    expect(await readProviderKey(Readable.from([]), false)).toBeUndefined();
    const stream = new PassThrough(); stream.destroy();
    expect(await readProviderKey(stream, true)).toBeUndefined();
  });
});

import type { ReadStream } from "node:tty";
import type { Readable } from "node:stream";

/** Read a credential without echoing it. A cancelled or closed terminal returns no value. */
export async function readProviderKey(input: Readable & Partial<Pick<ReadStream, "isTTY" | "isRaw" | "setRawMode">>, fromStdin: boolean): Promise<string | undefined> {
  if (!fromStdin && (!input.isTTY || !input.setRawMode)) return undefined;
  if (input.readableEnded || input.destroyed) return undefined;
  const raw = !fromStdin;
  const wasRaw = input.isRaw ?? false;
  return new Promise((resolve) => {
    let value = "";
    let settled = false;
    const finish = (result: string | undefined): void => {
      if (settled) return;
      settled = true;
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("close", onClose);
      input.off("error", onClose);
      if (raw) {
        try { input.setRawMode!(wasRaw); } catch { result = undefined; }
      }
      input.pause();
      resolve(result);
    };
    const onData = (chunk: Buffer | string): void => {
      const text = chunk.toString();
      if (raw) {
        for (const char of text) {
          if (char === "\u0003" || char === "\u0004") return finish(undefined);
          if (char === "\r" || char === "\n") return finish(value || undefined);
          if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
          else value += char;
        }
      } else value += text;
      if (value.length > 65536) finish(undefined);
    };
    const onEnd = (): void => {
      if (raw) finish(undefined);
      else finish(value.replace(/\r?\n$/, "") || undefined);
    };
    const onClose = (): void => finish(undefined);
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("close", onClose);
    input.once("error", onClose);
    try { if (raw) input.setRawMode!(true); input.resume(); } catch { finish(undefined); }
  });
}

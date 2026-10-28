import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ReadBuffer, serializeMessage, type Transport } from "@modelcontextprotocol/client";

/** A launcher is a lease guardian: EOF requests cleanup; killing it would break that contract. */
/** A frame carries a result twice (text content and structured content); 2 MiB covers both at the relay's size bound. */
export class ChildStdioTransport implements Transport {
  onclose: Transport["onclose"];
  onerror: Transport["onerror"];
  onmessage: Transport["onmessage"];
  private child?: ChildProcessWithoutNullStreams;
  private closed = false;
  private started = false;
  private readonly buffer = new ReadBuffer({ maxBufferSize: 2_097_152 });
  private pending = Buffer.alloc(0);

  constructor(private readonly command: string, private readonly env: Record<string, string>, private readonly args: readonly string[] = []) {}

  async start(): Promise<void> {
    if (this.started || this.closed) throw new Error("Transport cannot start");
    this.started = true;
    const child = this.child = spawn(this.command, [...this.args], { detached: true, stdio: ["pipe", "pipe", "pipe"], env: { ...this.env }, shell: false });
    child.stderr.on("data", () => undefined);
    child.stdin.on("error", () => this.onerror?.(new Error("Writer input failed")));
    child.on("error", () => this.onerror?.(new Error("Writer process failed")));
    child.on("close", () => this.finish());
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.closed) return;
      try {
        this.pending = Buffer.concat([this.pending, chunk]);
        let newline: number;
        while ((newline = this.pending.indexOf(10)) !== -1) {
          if (newline > 2_097_152) throw new Error();
          const line = this.pending.subarray(0, newline + 1);
          this.pending = this.pending.subarray(newline + 1);
          // ReadBuffer silently skips JSON syntax errors; detect them before decoding.
          JSON.parse(line.toString("utf8"));
          this.buffer.append(line);
          const message = this.buffer.readMessage();
          if (message === null) throw new Error();
          this.onmessage?.(message);
        }
        if (this.pending.length > 2_097_152) throw new Error();
      } catch {
        this.onerror?.(new Error("Invalid writer frame"));
        void this.close();
      }
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () => reject(new Error("Writer spawn failed")));
    });
  }

  async send(message: Parameters<Transport["send"]>[0]): Promise<void> {
    if (this.closed || !this.child) throw new Error("Writer transport is closed");
    await new Promise<void>((resolve, reject) => {
      this.child!.stdin.write(serializeMessage(message), error => error ? reject(new Error("Writer send failed")) : resolve());
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.child?.stdin.end();
    // Keep draining diagnostics/output while the guardian cleans up, without keeping the host alive.
    this.child?.unref();
    (this.child?.stdout as (NodeJS.ReadableStream & { unref?: () => void }) | undefined)?.unref?.();
    (this.child?.stderr as (NodeJS.ReadableStream & { unref?: () => void }) | undefined)?.unref?.();
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer.clear();
    this.pending = Buffer.alloc(0);
    this.onclose?.();
  }
}

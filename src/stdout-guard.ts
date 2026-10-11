import { Writable } from "node:stream";
import { format } from "node:util";

export interface StdoutGuardOptions {
  readonly stream?: NodeJS.WriteStream;
  readonly console?: Pick<Console, "log" | "info" | "debug">;
  readonly report?: (line: string) => void;
  readonly intervalMs?: number;
  readonly onExit?: (flush: () => void) => void;
}

export interface StdoutGuard {
  /** The only writer that reaches the real stdout: hand it to the MCP transport. */
  readonly transportStdout: Writable;
  /** Writes the pending suppression counts to stderr. */
  flush(): void;
}

type WriteCallback = (error?: Error | null) => void;

/**
 * Reserves stdout for MCP frames. Any other write, an extension's `console.log`
 * included, is dropped; stderr gets only a byte and write count, never the content,
 * because the content may hold prompts or secrets.
 */
export function installStdoutGuard(options: StdoutGuardOptions = {}): StdoutGuard {
  const stream = options.stream ?? process.stdout;
  const target = options.console ?? console;
  const report = options.report ?? ((line: string) => { process.stderr.write(line); });
  const intervalMs = options.intervalMs ?? 1_000;
  const realWrite = stream.write.bind(stream) as typeof stream.write;
  const realEnd = stream.end.bind(stream) as typeof stream.end;
  let bytes = 0;
  let writes = 0;
  let timer: NodeJS.Timeout | undefined;

  const flush = (): void => {
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (writes === 0) return;
    report(JSON.stringify({ level: "warning", event: "foreign_stdout_suppressed", bytes, writes }) + "\n");
    bytes = 0;
    writes = 0;
  };
  const suppress = (chunk: unknown, encoding?: unknown): void => {
    bytes += typeof chunk === "string"
      ? Buffer.byteLength(chunk, typeof encoding === "string" ? encoding as BufferEncoding : "utf8")
      : chunk instanceof Uint8Array ? chunk.byteLength : 0;
    writes += 1;
    if (!timer) {
      timer = setTimeout(flush, intervalMs);
      timer.unref();
    }
  };

  stream.write = ((chunk: unknown, encodingOrCallback?: unknown, callback?: unknown): boolean => {
    suppress(chunk, encodingOrCallback);
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    if (typeof done === "function") queueMicrotask(() => { (done as WriteCallback)(); });
    return true;
  }) as typeof stream.write;
  // A foreign `end` must neither leak content nor close the real stdout, which would break every later frame.
  stream.end = ((...args: unknown[]): NodeJS.WriteStream => {
    const [first, second] = args;
    if (typeof first === "string" || first instanceof Uint8Array) suppress(first, second);
    const done = args.find((arg) => typeof arg === "function");
    if (typeof done === "function") queueMicrotask(() => { (done as WriteCallback)(); });
    return stream;
  }) as typeof stream.end;
  for (const method of ["log", "info", "debug"] as const) {
    target[method] = (...args: unknown[]): void => { suppress(`${format(...args)}\n`); };
  }

  // Write-through, not a buffering wrapper: queued frames must reach stdout before `process.exit`,
  // and a wrapper `Writable` would hold all but one of them until a later tick.
  const transportStdout = new Proxy(stream, {
    get(target, property) {
      if (property === "write") return realWrite;
      if (property === "end") return realEnd;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as Writable;
  (options.onExit ?? ((exitFlush: () => void) => { process.once("exit", exitFlush); }))(flush);
  return { transportStdout, flush };
}

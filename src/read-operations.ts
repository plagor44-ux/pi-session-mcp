import { access, open, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import {
  createReadToolDefinition,
  detectSupportedImageMimeTypeFromFile,
  type ReadOperations,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

/**
 * Every hook of an SDK operations interface, decided: guarded here, or named in `Omitted` and left out.
 * A hook that a later SDK adds, optional or not, is missing from the object below and fails the typecheck
 * (and therefore the Pi SDK canary) instead of going unnoticed. The check goes by hook name: an existing hook
 * whose parameters change still compiles.
 */
export type Decided<Operations, Omitted extends keyof Operations = never> = Required<Omit<Operations, Omitted>> & { [Hook in Omitted]?: never };

/**
 * Streams a local file as the SDK's own `read` does: a regular file up to the size it had when opened, a
 * file reporting size 0 (such as /proc files) and other file types until EOF. Unlike the SDK's stream, it
 * refuses a signal that is already aborted before it creates the stream: Node destroys a stream created on
 * an aborted signal with an `AbortError` that no listener catches, and that error ends the process (#273,
 * #298). The handle is closed on every exit.
 */
export async function* streamLocalFile(path: string, signal: AbortSignal | undefined): AsyncGenerator<Uint8Array> {
  signal?.throwIfAborted();
  const handle = await open(path, "r");
  try {
    const stats = await handle.stat();
    const end = stats.isFile() && stats.size > 0 ? stats.size - 1 : undefined;
    // The abort may land while the file opens: refuse it here, synchronously before the stream exists.
    signal?.throwIfAborted();
    yield* handle.createReadStream({ end, signal, autoClose: false });
  } finally {
    await handle.close();
  }
}

/** The SDK's default read operations, except that the stream refuses an aborted signal. */
export function localReadOperations(): Decided<ReadOperations> {
  return {
    access: (path) => access(path, constants.R_OK),
    readFile: (path) => readFile(path),
    createReadStream: (path, { signal }) => streamLocalFile(path, signal),
    detectImageMimeType: (path) => detectSupportedImageMimeTypeFromFile(path),
  };
}

/**
 * The `read` definition of a coding session: the SDK's own tool over `localReadOperations`. Registered as
 * an SDK custom tool, it replaces the built-in `read`, whose stream would end the server on an abort that
 * lands while it opens its file (#298). Paths are not confined: a coding session reads what the built-in reads.
 * Image resizing keeps the factory default, which the server's in-memory session settings also select for the
 * built-in.
 */
export function createCodingReadTool(cwd: string): ToolDefinition {
  return createReadToolDefinition(cwd, { operations: localReadOperations() }) as unknown as ToolDefinition;
}

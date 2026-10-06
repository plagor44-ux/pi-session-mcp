import { readFile } from "node:fs/promises";

/**
 * Parse newline-delimited JSON written by the stdio fixtures. The fixture appends
 * whole lines, but a concurrent reader can observe a prefix of a long line before
 * the write completes, so only newline-terminated lines count; the rest is read
 * on the next poll.
 */
export function parseCompleteLines<T>(data: string): T[] {
  const complete = data.endsWith("\n") ? data : data.slice(0, data.lastIndexOf("\n") + 1);
  return complete.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as T);
}

/** Read and parse a fixture log; a log that does not exist yet is empty. */
export async function readFixtureLog<T>(logPath: string): Promise<T[]> {
  const data = await readFile(logPath, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });
  return parseCompleteLines<T>(data);
}

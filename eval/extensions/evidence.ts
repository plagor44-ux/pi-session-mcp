import { lstat, rm, unlink } from "node:fs/promises";

/*
 * R42: nothing derived from a worker is kept. The only surviving evidence of an attempt is the sanitized `runs/<runId>.json`
 * (counts, scores, usage, codes and hashes). Patches, assistant text, traces, logs and scopes can carry credentials the worker read
 * (binary or attribute-encoded content defeats any redaction) and worker-controlled strings (paths, names), so `private/<runId>/` is
 * deleted entirely once the verdict is computed, for every run.
 */

/**
 * Removes a directory tree without ever following a link: the path itself is `lstat`ed and unlinked when it is not a real directory
 * (a planted symlink, a FIFO, a file); a real directory is removed recursively, which does not follow symlinks inside it either.
 * Nothing at all is done for a path that does not exist.
 */
export async function removeTree(path: string): Promise<void> {
  let info;
  try { info = await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!info.isDirectory()) { await unlink(path); return; }
  await rm(path, { recursive: true, force: true });
}

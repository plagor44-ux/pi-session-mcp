import { lstat, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/*
 * R42: nothing derived from a worker is kept. The only surviving evidence of an attempt is the sanitized `runs/<runId>.json`
 * (counts, scores, usage, codes and hashes). Patches, assistant text, traces, logs and scopes can carry credentials the worker read
 * (binary or attribute-encoded content defeats any redaction) and worker-controlled strings (paths, names), so `private/<runId>/` is
 * deleted entirely once the verdict is computed, for every run.
 */

/** One kept diagnostic line is cut at this length. */
export const MAX_DIAGNOSTIC_LINE_CHARS = 1000;

/**
 * R84: the one exception to the rule above. When a run is stopped by the trace audit, the raw log lines that caused the stop (the
 * evidence of `parseStraceLog`) are kept in `<waveDir>/diagnostics/<runId>.txt` (`wx`, mode 0600), each line cut at 1000 characters, so
 * the event can be attributed. They hold paths and addresses and stay in the private wave directory: the report never reads or copies
 * `diagnostics/`, and no record carries them. Nothing else of a run is kept.
 */
export async function writeDiagnostics(waveDir: string, runId: string, evidenceLines: readonly string[]): Promise<void> {
  if (evidenceLines.length === 0) return;
  const directory = join(waveDir, "diagnostics");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entries = evidenceLines.map((entry) => entry.split("\n").map((line) => line.slice(0, MAX_DIAGNOSTIC_LINE_CHARS)).join("\n"));
  await writeFile(join(directory, `${runId}.txt`), `${entries.join("\n--\n")}\n`, { flag: "wx", mode: 0o600 });
}

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

/**
 * `removeTree` only `lstat`s the last component, so a worker that swaps an intermediate directory (`private`, `scopes`) for a symlink
 * could redirect a later removal. The guard records the device and inode of the wave directory and its `private` and `scopes`
 * directories at the start and requires all three to be unchanged real directories before every creation or removal below them.
 */
export class WaveDirGuard {
  private constructor(private readonly entries: { path: string; dev: number; ino: number }[]) {}

  static async capture(waveDir: string): Promise<WaveDirGuard> {
    const entries: { path: string; dev: number; ino: number }[] = [];
    for (const path of [waveDir, join(waveDir, "private"), join(waveDir, "scopes")]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const info = await lstat(path);
      if (!info.isDirectory()) throw new Error("wave_dir_tampered");
      entries.push({ path, dev: info.dev, ino: info.ino });
    }
    return new WaveDirGuard(entries);
  }

  /** Throws `wave_dir_tampered` unless every recorded path is still the same real directory. */
  async assertIntact(): Promise<void> {
    for (const entry of this.entries) {
      let info;
      try { info = await lstat(entry.path); } catch { throw new Error("wave_dir_tampered"); }
      if (!info.isDirectory() || info.dev !== entry.dev || info.ino !== entry.ino) throw new Error("wave_dir_tampered");
    }
  }
}

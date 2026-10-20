import { spawn } from "node:child_process";

export interface HelperResult { stdout: string; stderr: string }
export interface HelperFailure extends Error { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
export type HelperRunner = (file: string, args: readonly string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; maxBuffer?: number }) => Promise<HelperResult>;

/**
 * Runs a helper (ps, git, codegraph) in its own process group (N3): a terminal Ctrl-C goes to the foreground group and must not kill a
 * helper in the middle of a check. Resolves with the output on exit code 0; rejects with `code`/`signal` otherwise.
 */
export const runHelper: HelperRunner = (file, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(file, [...args], { ...(options.cwd === undefined ? {} : { cwd: options.cwd }), ...(options.env === undefined ? {} : { env: options.env }), detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const limit = options.maxBuffer ?? 256 * 1024 * 1024;
  let stdout = "", stderr = "", overflow = false;
  child.stdout.on("data", (chunk: Buffer) => { if (stdout.length + chunk.length > limit) overflow = true; else stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 1_000_000) stderr += chunk.toString("utf8"); });
  child.once("error", (error) => reject(Object.assign(error, { code: null, signal: null, stdout, stderr })));
  child.once("close", (code, signal) => {
    if (code === 0 && !overflow) { resolve({ stdout, stderr }); return; }
    reject(Object.assign(new Error(overflow ? "helper_output_too_large" : "helper_failed"), { code, signal, stdout, stderr }));
  });
});

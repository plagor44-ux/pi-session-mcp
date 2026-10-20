import { execFile, spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { encodeKey } from "./output-mac.js";
import { STRACE_ARGS } from "./trace.js";
import type { RunScope } from "./workspace.js";

const execFileAsync = promisify(execFile);
const EXIT_WAIT_AFTER_KILL_MS = 5_000;

/**
 * The traced worker: `strace` as the process group leader, the run unit below it, cwd = the scope root. stdin is a pipe so the
 * supervisor can hand over the per-run key (R35); stderr goes to a file in the scope.
 */
export function spawnTracedRunOne(scope: RunScope, runInput: string, log: string): ChildProcess {
  const stderr = openSync(join(scope.root, "run-one.stderr"), "a", 0o600);
  try {
    return spawn("strace", [...STRACE_ARGS, "-o", log, "--", process.execPath, fileURLToPath(new URL("./run-one.js", import.meta.url)), runInput], {
      cwd: scope.root, env: scope.env, detached: true, stdio: ["pipe", "ignore", stderr],
    });
  } finally { closeSync(stderr); }
}

/** The run unit without `strace` (the preflight PONG touches no repository). */
export function spawnRunOne(scope: RunScope, runInput: string): ChildProcess {
  return spawn(process.execPath, [fileURLToPath(new URL("./run-one.js", import.meta.url)), runInput], {
    cwd: scope.root, env: scope.env, detached: true, stdio: ["pipe", "ignore", "ignore"],
  });
}

/** Writes the key to the child's stdin and closes it. The key never goes into env, argv or a file. */
export function startWithKey(child: ChildProcess, key: Uint8Array): void {
  const stdin = child.stdin;
  if (!stdin) return;
  stdin.on("error", () => undefined);
  stdin.end(encodeKey(key));
}

export function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try { process.kill(-pid, "SIGKILL"); } catch { /* already exited or no group */ }
}

/** True once no non-zombie process is left in the group; ps exits 1 when it selects nothing. */
export async function groupIsEmpty(pgid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let stdout: string;
    try { stdout = (await execFileAsync("ps", ["-o", "pid=,stat=", "-g", String(pgid)], { encoding: "utf8" })).stdout; } catch (error) {
      if ((error as { code?: unknown }).code !== 1) return false;
      stdout = "";
    }
    const live = stdout.split("\n").map((line) => /^\s*\d+\s+(\S+)/.exec(line)?.[1]).filter((stat) => stat !== undefined && !stat.startsWith("Z"));
    if (live.length === 0) return true;
    await sleep(100);
  }
  return false;
}

export interface Supervised { timedOut: boolean; interrupted: boolean }

/** Waits for the group leader to exit; kills the whole group at the deadline or on abort. */
export function supervise(child: ChildProcess, timeoutMs: number, signal: AbortSignal | undefined): Promise<Supervised> {
  return new Promise((resolve) => {
    const state = { timedOut: false, interrupted: false };
    let done = false;
    let hard: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer); clearTimeout(hard); signal?.removeEventListener("abort", onAbort);
      resolve(state);
    };
    const stop = (): void => {
      killProcessGroup(child.pid);
      hard ??= setTimeout(finish, EXIT_WAIT_AFTER_KILL_MS);
    };
    const onAbort = (): void => { state.interrupted = true; stop(); };
    const timer = setTimeout(() => { state.timedOut = true; stop(); }, timeoutMs);
    child.once("exit", finish);
    child.once("error", finish);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    if (child.exitCode !== null || child.signalCode !== null) finish();
  });
}

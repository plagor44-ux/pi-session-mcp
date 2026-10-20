import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runHelper, type HelperRunner } from "./helpers.js";
import { encodeKey } from "./output-mac.js";
import { STRACE_ARGS } from "./trace.js";
import { sandboxed, type SandboxPlan } from "./sandbox.js";
import { resolveTool, type ToolPaths } from "./tools.js";
import type { RunScope } from "./workspace.js";

const EXIT_WAIT_AFTER_KILL_MS = 5_000;
/** A hard core limit of 0 for the run unit and everything below it: a core dump of the run unit would expose its MAC key (N1). */
export const CORE_LIMIT = "--core=0:0";

/** The run unit's own command line: no inspector can open (`--disable-sigusr1`, R44). */
/** The build the run unit loads from (`<build>/eval/extensions/run-one.js`); it lives under /tmp, which the sandbox replaces, so it is bound back read-only. */
export const BUILD_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const runOneArgs = (runInput: string): string[] => ["--disable-sigusr1", fileURLToPath(new URL("./run-one.js", import.meta.url)), runInput];

/**
 * `prlimit` (hard core limit 0), then `strace` as the process group leader, then bubblewrap around the workload, by default the run unit
 * (R46); every executable is an absolute path (R44). `workload` replaces the run unit (the containment self-test).
 */
export function tracedCommand(
  tools: Pick<ToolPaths, "strace" | "prlimit" | "bwrap">, plan: SandboxPlan, scopeRoot: string, log: string, runInput: string,
  options: { workload?: string[]; extraWritable?: string[] } = {},
): { file: string; args: string[] } {
  const workload = options.workload ?? [process.execPath, ...runOneArgs(runInput)];
  return { file: tools.prlimit, args: [CORE_LIMIT, "--", tools.strace, ...STRACE_ARGS, "-o", log, "--", ...sandboxed(tools, plan, scopeRoot, workload, options.extraWritable)] };
}

/** The untraced preflight command, inside the same sandbox. */
export function untracedCommand(tools: Pick<ToolPaths, "prlimit" | "bwrap">, plan: SandboxPlan, scopeRoot: string, runInput: string): { file: string; args: string[] } {
  return { file: tools.prlimit, args: [CORE_LIMIT, "--", ...sandboxed(tools, plan, scopeRoot, [process.execPath, ...runOneArgs(runInput)])] };
}

/**
 * The traced worker: cwd = the scope root. stdin is a pipe so the supervisor can hand over the per-run key (R35); stderr goes to a file
 * in the scope.
 */
export function spawnTracedRunOne(tools: Pick<ToolPaths, "strace" | "prlimit" | "bwrap">, plan: SandboxPlan, scope: RunScope, runInput: string, log: string): ChildProcess {
  const stderr = openSync(join(scope.root, "run-one.stderr"), "a", 0o600);
  try {
    const { file, args } = tracedCommand(tools, plan, scope.root, log, runInput);
    return spawn(file, args, { cwd: scope.root, env: scope.env, detached: true, stdio: ["pipe", "ignore", stderr] });
  } finally { closeSync(stderr); }
}

/** The run unit without `strace` (the preflight PONG touches no repository). */
export function spawnRunOne(tools: Pick<ToolPaths, "prlimit" | "bwrap">, plan: SandboxPlan, scope: RunScope, runInput: string): ChildProcess {
  const { file, args } = untracedCommand(tools, plan, scope.root, runInput);
  return spawn(file, args, { cwd: scope.root, env: scope.env, detached: true, stdio: ["pipe", "ignore", "ignore"] });
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

/**
 * True once no non-zombie process is left in the group; ps exits 1 when it selects nothing. A ps that cannot complete (killed by a
 * signal, not runnable) is retried once and then counts as not clean (N3).
 */
export async function groupIsEmpty(pgid: number, run: HelperRunner = runHelper): Promise<boolean> {
  let failures = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let stdout: string;
    try { stdout = (await run("ps", ["-o", "pid=,stat=", "-g", String(pgid)])).stdout; } catch (error) {
      const failure = error as { code?: unknown; signal?: unknown; stdout?: unknown };
      if (failure.code === 1 && failure.signal === null) stdout = "";
      else {
        failures += 1;
        if (failures > 1) return false;
        await sleep(100);
        continue;
      }
    }
    const live = stdout.split("\n").map((line) => /^\s*\d+\s+(\S+)/.exec(line)?.[1]).filter((stat) => stat !== undefined && !stat.startsWith("Z"));
    if (live.length === 0) return true;
    await sleep(100);
  }
  return false;
}

/** The host must keep the run unit's memory and MAC key out of reach (N1, R40): `prlimit` present and Yama ptrace_scope at least 1. */
export interface HostProbes {
  readPtraceScope: () => Promise<string>;
  hasPrlimit: () => Promise<boolean>;
}
const defaultProbes: HostProbes = {
  readPtraceScope: () => readFile("/proc/sys/kernel/yama/ptrace_scope", "utf8"),
  hasPrlimit: async () => resolveTool("prlimit", process.env.PATH ?? "").then(() => true, () => false),
};

export async function assertHostSafe(probes: HostProbes = defaultProbes): Promise<void> {
  if (!await probes.hasPrlimit()) throw new Error("prlimit_missing");
  let scope: number;
  try { scope = Number((await probes.readPtraceScope()).trim()); } catch { throw new Error("ptrace_scope_unsafe"); }
  if (!Number.isInteger(scope) || scope < 1) throw new Error("ptrace_scope_unsafe");
}

export interface Supervised {
  timedOut: boolean;
  interrupted: boolean;
  /** The group leader's exit code and signal; both null when it did not report one (killed after the grace period). */
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

/** The leader (strace returns the tracee's status) exited with code 0 and no signal, as `run-one` does after writing its output. */
export const exitedCleanly = (s: Supervised): boolean => !s.timedOut && !s.interrupted && s.exitCode === 0 && s.signal === null;

/** Waits for the group leader to exit; kills the whole group at the deadline or on abort. */
export function supervise(child: ChildProcess, timeoutMs: number, signal: AbortSignal | undefined): Promise<Supervised> {
  return new Promise((resolve) => {
    const state: Supervised = { timedOut: false, interrupted: false, exitCode: null, signal: null };
    let done = false;
    let hard: NodeJS.Timeout | undefined;
    const finish = (code: number | null = null, exitSignal: NodeJS.Signals | null = null): void => {
      if (done) return;
      state.exitCode = code; state.signal = exitSignal;
      done = true;
      clearTimeout(timer); clearTimeout(hard); signal?.removeEventListener("abort", onAbort);
      resolve(state);
    };
    const stop = (): void => {
      killProcessGroup(child.pid);
      hard ??= setTimeout(() => finish(), EXIT_WAIT_AFTER_KILL_MS);
    };
    const onAbort = (): void => { state.interrupted = true; stop(); };
    const timer = setTimeout(() => { state.timedOut = true; stop(); }, timeoutMs);
    child.once("exit", (code, exitSignal) => finish(code, exitSignal));
    child.once("error", () => finish());
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    if (child.exitCode !== null || child.signalCode !== null) finish(child.exitCode, child.signalCode);
  });
}

import { spawn, type ChildProcess } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CommandResult, CommandRunner } from "./client-adapters/types.js";
import type { McpStdioProcess } from "./client-adapters/mcp-verifier.js";

export interface ProcessRunnerOptions { readonly timeoutMs?: number; readonly maxOutputBytes?: number; readonly env?: NodeJS.ProcessEnv; readonly signal?: AbortSignal; }
export interface SetupGuardian {
  readonly runner: CommandRunner;
  readonly signal: AbortSignal;
  release(): Promise<void>;
}
const DEFAULT_TIMEOUT = 10_000;
const DEFAULT_MAX = 65_536;
const ABORT_GROUP_CLEANUP_TIMEOUT = 2_000;
const GUARDIAN_START_TIMEOUT = 5_000;

/** Kill a detached process and every descendant in its process group. */
function terminateProcessGroup(child: import("node:child_process").ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, signal); return; } catch { /* already exited or no group */ }
  }
  try { child.kill(signal); } catch { /* already exited */ }
}
type ProcessGroupState = "alive" | "gone" | "unknown";
function processGroupState(child: import("node:child_process").ChildProcess): ProcessGroupState {
  if (child.pid === undefined || process.platform !== "linux") return "unknown";
  const group = child.pid;
  try {
    for (const entry of readdirSync("/proc", { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      try { const stat = readProcStat(Number(entry.name)); if (stat.pgrp === group && stat.state !== "Z") return "alive"; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "unknown"; }
    }
  } catch { return "unknown"; }
  return "gone";
}
function readProcStat(pid: number): { readonly pgrp: number; readonly state: string } {
  const line = readFileSync(`/proc/${pid}/stat`, "utf8").trim();
  const close = line.lastIndexOf(") ");
  const state = line[close + 2];
  if (close < 3 || !state || !/^[A-Za-z]$/.test(state) || line[close + 3] !== " ") throw new Error("process_stat_invalid");
  const fields = line.slice(close + 4).trim().split(/\s+/);
  const pgrp = Number(fields[1]);
  if (!Number.isSafeInteger(pgrp) || pgrp < 0) throw new Error("process_group_invalid");
  return { pgrp, state };
}
const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Runs only an explicit executable/argv pair, with bounded output and termination. */
export function createProcessRunner(options: ProcessRunnerOptions = {}): CommandRunner {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT; const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX;
  return { run(command, args, signal): Promise<CommandResult> { const effectiveSignal = options.signal && signal ? AbortSignal.any([options.signal, signal]) : options.signal ?? signal; if (process.platform !== "linux") return Promise.resolve({ exitCode: 126, stdout: "", stderr: "" }); return new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], env: options.env, detached: process.platform !== "win32" }); let stdout = ""; let stderr = ""; let overflow = false; let aborted = false;
    const collect = (part: "stdout" | "stderr") => (chunk: Buffer): void => { const value = chunk.toString("utf8"); const current = part === "stdout" ? stdout : stderr; if (Buffer.byteLength(current + value, "utf8") > maxOutputBytes) { overflow = true; return; } if (part === "stdout") stdout += value; else stderr += value; };
    child.stdout.on("data", collect("stdout")); child.stderr.on("data", collect("stderr")); let done = false; let timedOut = false; let killTimer: NodeJS.Timeout | undefined; let hardTimer: NodeJS.Timeout | undefined; let groupPoll: NodeJS.Timeout | undefined; let groupDeadline = 0;
    const finish = (exitCode: number): void => { if (done) return; done = true; effectiveSignal?.removeEventListener("abort", abort); clearTimeout(timer); if (!timedOut && killTimer) clearTimeout(killTimer); if (!timedOut && hardTimer) clearTimeout(hardTimer); if (groupPoll) clearTimeout(groupPoll); resolve({ exitCode, stdout: overflow ? Buffer.from(stdout).subarray(0, maxOutputBytes).toString("utf8") : stdout, stderr: overflow ? "output_limit" : stderr }); };
    const finishAfterGroup = (successCode: number): void => {
      if (done) return;
      if (processGroupState(child) === "gone") { finish(successCode); return; }
      if (Date.now() >= groupDeadline) { finish(126); return; }
      groupPoll = setTimeout(() => finishAfterGroup(successCode), 10);
    };
    const abort = (): void => { if (done) return; aborted = true; groupDeadline = Date.now() + ABORT_GROUP_CLEANUP_TIMEOUT; terminateProcessGroup(child, "SIGTERM"); killTimer = setTimeout(() => { terminateProcessGroup(child, "SIGKILL"); finishAfterGroup(125); }, 100); };
    effectiveSignal?.addEventListener("abort", abort, { once: true });
    if (effectiveSignal?.aborted) abort();
    const timer = setTimeout(() => {
      timedOut = true;
      groupDeadline = Date.now() + ABORT_GROUP_CLEANUP_TIMEOUT;
      terminateProcessGroup(child, "SIGTERM");
      killTimer = setTimeout(() => {
        terminateProcessGroup(child, "SIGKILL");
        hardTimer = setTimeout(() => finishAfterGroup(124), 100);
      }, 100);
    }, timeoutMs);
    child.on("error", () => { if (!timedOut) { if (aborted) finishAfterGroup(125); else finish(127); } }); child.on("close", (code) => { if (!timedOut) { if (aborted) finishAfterGroup(125); else finish(code ?? 1); } });
  }); } };
}

export interface McpLauncherOptions { readonly nodePath: string; readonly entryPath: string; readonly configPath: string; readonly timeoutMs?: number; readonly maxFrameBytes?: number; }
/** Starts the local MCP server with only the controlled configuration environment. */
export function createMcpStdioLauncher(options: McpLauncherOptions): (signal: AbortSignal) => Promise<McpStdioProcess> {
  return async (signal) => {
    const child = spawn(options.nodePath, [options.entryPath], { stdio: ["pipe", "pipe", "pipe"], env: { PI_SESSION_MCP_CONFIG: options.configPath }, detached: process.platform !== "win32" });
    const max = options.maxFrameBytes ?? DEFAULT_MAX; let buffer = ""; let closed = false; let overflow = false;
    child.stdout.on("data", (chunk: Buffer) => { if (overflow) return; buffer += chunk.toString("utf8"); if (Buffer.byteLength(buffer, "utf8") > max) { overflow = true; buffer = ""; } });
    child.stderr.on("data", () => { /* Consume diagnostics without exposing them. */ });
    child.on("error", () => { closed = true; });
    child.on("close", () => { closed = true; });
    const abort = (): void => { if (!closed) terminateProcessGroup(child, "SIGTERM"); };
    signal.addEventListener("abort", abort, { once: true });
    const waitForClose = async (milliseconds: number): Promise<boolean> => {
      if (closed) return true;
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(closed), milliseconds);
        child.once("close", () => { clearTimeout(timer); resolve(true); });
      });
    };
    return {
      write(frame: string): Promise<void> {
        if (closed || overflow || Buffer.byteLength(frame, "utf8") > max) return Promise.reject(new Error("mcp_write_unavailable"));
        return new Promise<void>((resolve, reject) => child.stdin.write(frame, (error) => error ? reject(new Error("mcp_write_failed")) : resolve()));
      },
      async read(): Promise<string | null> {
        const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT);
        while (!overflow && !closed && buffer.indexOf("\n") < 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
        if (overflow) return null;
        const newline = buffer.indexOf("\n");
        if (newline >= 0) { const line = buffer.slice(0, newline + 1); buffer = buffer.slice(newline + 1); return line; }
        if (closed && buffer.length > 0) { const tail = buffer; buffer = ""; return tail; }
        return null;
      },
      async kill(): Promise<void> {
        signal.removeEventListener("abort", abort);
        if (!closed) child.stdin.end();
        terminateProcessGroup(child, "SIGTERM");
        await delay(100);
        terminateProcessGroup(child, "SIGKILL");
        const childClosed = await waitForClose(1_000);
        const groupDeadline = Date.now() + 1_000;
        while (processGroupState(child) === "alive" && Date.now() < groupDeadline) await delay(10);
        if (!childClosed || processGroupState(child) !== "gone") throw new Error("mcp_process_cleanup_failed");
      },
    };
  };
}

/**
 * Acquires the Linux kernel fence and starts the transaction guardian. The
 * guardian inherits the locked file description, so parent death cannot release
 * the fence while a client mutation or descendant is still live.
 */
export async function acquireSetupGuardian(lockFd: number, timeoutMs: number, signal?: AbortSignal, validateFence?: () => Promise<void>): Promise<SetupGuardian> {
  if (process.platform !== "linux") throw new Error("platform_unsupported");
  const flockPath = ["/usr/bin/flock", "/bin/flock"].find((candidate) => {
    try {
      const file = statSync(candidate);
      return file.isFile() && file.uid === 0 && (file.mode & 0o022) === 0 && (file.mode & 0o111) !== 0;
    } catch { return false; }
  });
  if (!flockPath) throw new Error("ownership_lock_unavailable");
  const modulePath = fileURLToPath(import.meta.url);
  const guardianPath = fileURLToPath(new URL(modulePath.endsWith(".ts") ? "./setup-command-guardian.ts" : "./setup-command-guardian.js", import.meta.url));
  try { if (!lstatSync(guardianPath).isFile()) throw new Error("guardian_invalid"); }
  catch { throw new Error("ownership_lock_unavailable"); }
  const waitSeconds = String(Math.ceil(Math.max(1_000, Math.min(timeoutMs, 120_000)) / 1_000));
  let locker: ChildProcess;
  try {
    locker = spawn(flockPath, ["-E", "75", "-w", waitSeconds, "3"], {
      stdio: ["ignore", "ignore", "ignore", lockFd],
      detached: true,
    });
  } catch { throw new Error("ownership_lock_unavailable"); }
  const stopAcquisition = (): void => { if (locker.pid !== undefined) { try { process.kill(-locker.pid, "SIGKILL"); } catch { /* already gone */ } } };
  if (signal?.aborted) stopAcquisition();
  signal?.addEventListener("abort", stopAcquisition, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      locker.once("error", () => reject(new Error("ownership_lock_unavailable")));
      locker.once("close", (code) => code === 0 ? resolve() : reject(new Error(code === 75 ? "ownership_lock_busy" : signal?.aborted ? "operation_aborted" : "ownership_lock_unavailable")));
    });
  } finally { signal?.removeEventListener("abort", stopAcquisition); }
  if (signal?.aborted) throw new Error("operation_aborted");
  try { await validateFence?.(); }
  catch { throw new Error("ownership_lock_unavailable"); }

  let child: ChildProcess;
  try { child = spawn(process.execPath, [guardianPath, String(process.pid)], { stdio: ["ignore", "ignore", "ignore", lockFd, "ipc"], detached: true }); }
  catch { throw new Error("ownership_lock_unavailable"); }
  const stopGuardianStart = (): void => { if (child.pid !== undefined) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } } };
  signal?.addEventListener("abort", stopGuardianStart, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => { stopGuardianStart(); settle(new Error("ownership_lock_unavailable")); }, GUARDIAN_START_TIMEOUT);
      const settle = (error?: Error): void => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(); };
      child.once("error", () => settle(new Error("ownership_lock_unavailable")));
      child.once("close", () => settle(new Error(signal?.aborted ? "operation_aborted" : "ownership_lock_unavailable")));
      child.on("message", (message: unknown) => { if (message && typeof message === "object" && (message as { type?: unknown }).type === "ready") settle(); });
    });
  } finally { signal?.removeEventListener("abort", stopGuardianStart); }

  const compromised = new AbortController();
  let nextId = 1;
  let pending: { readonly id: number; readonly resolve: (result: CommandResult) => void; readonly signal?: AbortSignal; readonly abort: () => void } | undefined;
  let released = false;
  let unsafe = false;
  const safeResult = (message: unknown): CommandResult | undefined => {
    if (!message || typeof message !== "object") return undefined;
    const value = message as Record<string, unknown>;
    if (value.type !== "result" || !Number.isSafeInteger(value.id) || !Number.isSafeInteger(value.exitCode) || typeof value.stdout !== "string" || typeof value.stderr !== "string") return undefined;
    if ((value.stdout as string).length > DEFAULT_MAX || (value.stderr as string).length > DEFAULT_MAX) return undefined;
    return { exitCode: value.exitCode as number, stdout: value.stdout as string, stderr: value.stderr as string };
  };
  const failPending = (): void => {
    if (!pending) return;
    pending.signal?.removeEventListener("abort", pending.abort);
    const resolve = pending.resolve;
    pending = undefined;
    unsafe = true;
    compromised.abort();
    resolve({ exitCode: 126, stdout: "", stderr: "" });
  };
  child.on("message", (message: unknown) => {
    const result = safeResult(message);
    if (!result || !pending || (message as { id: number }).id !== pending.id) return;
    pending.signal?.removeEventListener("abort", pending.abort);
    const resolve = pending.resolve;
    pending = undefined;
    if (result.exitCode === 126) { unsafe = true; compromised.abort(); }
    resolve(result);
  });
  child.once("error", failPending);
  child.once("close", () => { if (!released) { unsafe = true; compromised.abort(); failPending(); } });

  const runner: CommandRunner = {
    run(command, args, runSignal): Promise<CommandResult> {
      if (released || unsafe || pending || runSignal?.aborted || !child.connected) return Promise.resolve({ exitCode: 126, stdout: "", stderr: "" });
      const id = nextId++;
      return new Promise((resolve) => {
        const abort = (): void => { if (child.connected) child.send({ type: "abort", id }, undefined, undefined, () => undefined); };
        pending = { id, resolve, ...(runSignal ? { signal: runSignal } : {}), abort };
        runSignal?.addEventListener("abort", abort, { once: true });
        child.send({ type: "run", id, command, args: [...args], timeoutMs: DEFAULT_TIMEOUT, maxOutputBytes: DEFAULT_MAX }, undefined, undefined, (error) => { if (error) failPending(); });
      });
    },
  };

  return {
    runner,
    signal: compromised.signal,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      if (pending) pending.abort();
      if (!unsafe && child.connected) {
        child.send({ type: "shutdown" }, undefined, undefined, () => undefined);
        const closed = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 5_000);
          child.once("close", () => { clearTimeout(timer); resolve(true); });
        });
        if (closed) return;
      }
      if (child.connected) child.disconnect();
      child.unref();
    },
  };
}

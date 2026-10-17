import { spawn, type ChildProcess } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { checkSchema, statusSchema } from "./schemas.js";
import type { evaluateTask } from "./oracles.js";

type OracleResult = Awaited<ReturnType<typeof evaluateTask>>;
const OUTPUT_LIMIT = 64 * 1024;
const TERMINATE_MS = 750;
const KILL_MS = 1500;

interface ProcEntry { pid: number; ppid: number; pgrp: number; state: string; start: string }

function procEntry(text: string, pid: number): ProcEntry | undefined {
  const close = text.lastIndexOf(")");
  if (close < 0) return undefined;
  const fields = text.slice(close + 2).split(" ");
  const pgrp = Number(fields[2]); // /proc stat field 5, after pid and comm
  const state = fields[0];
  const ppid = Number(fields[1]);
  const start = fields[19]; // field 22, process start time
  if (!Number.isInteger(pgrp) || !Number.isInteger(ppid) || !state || !start) return undefined;
  return { pid, ppid, pgrp, state, start };
}

async function procTable(): Promise<Map<number, ProcEntry>> {
  const pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name)).map(Number);
  const entries = await Promise.all(pids.map(async (pid) => {
    try { return procEntry(await readFile(`/proc/${pid}/stat`, "utf8"), pid); }
    catch { return undefined; }
  }));
  return new Map(entries.filter((entry): entry is ProcEntry => entry !== undefined).map((entry) => [entry.pid, entry]));
}

async function waitForExit(condition: () => Promise<boolean>, milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() >= deadline) return false;
    await delay(25);
  }
}

function stableError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function workerResult(raw: string): OracleResult {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw stableError("oracle_invalid_response"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw stableError("oracle_invalid_response");
  const value = parsed as Record<string, unknown>;
  const checks = Array.isArray(value.checks) ? value.checks.map((check) => {
    const parsed = checkSchema.parse(check);
    return { id: parsed.id, status: parsed.status, exit_code: parsed.exit_code, ...(parsed.reason === undefined ? {} : { reason: parsed.reason }) };
  }) : [];
  const result = {
    status: statusSchema.parse(value.status),
    checks,
    metrics: typeof value.metrics === "object" && value.metrics !== null && !Array.isArray(value.metrics)
      ? value.metrics as Record<string, number | null>
      : {},
  };
  if (!Array.isArray(value.checks)) throw stableError("oracle_invalid_response");
  for (const metric of Object.values(result.metrics)) {
    if (metric !== null && (typeof metric !== "number" || !Number.isFinite(metric))) throw stableError("oracle_invalid_response");
  }
  return result;
}

/**
 * Runs the independent oracle outside the controller process. Candidate tests and
 * browser children inherit the worker's detached Unix process group, which is
 * terminated and observed before this function returns.
 */
export async function evaluateBounded(
  root: string,
  taskId: string,
  workspace: string,
  receipt: unknown,
  artifactRoot: string | undefined,
  view: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<OracleResult> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw stableError("oracle_invalid_timeout");
  if (signal?.aborted) throw stableError("oracle_aborted");
  if (process.platform !== "linux") {
    return { status: "INCONCLUSIVE", checks: [{ id: "oracle-process-cleanup", status: "INCONCLUSIVE", exit_code: null }], metrics: {} };
  }

  const buildRoot = process.env.PI_PROFILE_EVAL_BUILD ?? join(root, ".profile-eval");
  const worker = join(buildRoot, "eval", "profiles", "oracle-worker.js");
  const input = JSON.stringify({ taskId, workspace, receipt, ...(artifactRoot === undefined ? {} : { artifactRoot }), ...(view === undefined ? {} : { view }) });
  if (Buffer.byteLength(input, "utf8") > 1024 * 1024) throw stableError("oracle_input_limit");

  const child: ChildProcess = spawn(process.execPath, [worker], {
    cwd: root,
    detached: true,
    stdio: ["pipe", "pipe", "ignore"],
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      ...(process.env.PI_PROFILE_EVAL_CHROMIUM_EXECUTABLE===undefined?{}:{PI_PROFILE_EVAL_CHROMIUM_EXECUTABLE:process.env.PI_PROFILE_EVAL_CHROMIUM_EXECUTABLE}),
      ...(process.env.PLAYWRIGHT_BROWSERS_PATH === undefined ? {} : { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }),
    },
  });
  const pgid = child.pid;
  if (!pgid) throw stableError("oracle_worker_start_failed");
  const owned = new Map<number, ProcEntry>();
  const groups = new Set<number>([pgid]);
  let scanFailed = false;
  let scanInProgress: Promise<void> | undefined;
  const scan = async () => {
    try {
      const table = await procTable();
      const rootIdentity = table.get(pgid);
      if (rootIdentity && !owned.has(pgid)) owned.set(pgid, rootIdentity);
      else if(rootIdentity && owned.get(pgid)?.start!==rootIdentity.start)scanFailed=true;
      for (let changed = true; changed;) {
        changed = false;
        for (const entry of table.values()) {
          const parent = owned.get(entry.ppid);
          if (parent && table.get(parent.pid)?.start === parent.start && !owned.has(entry.pid)) {
            owned.set(entry.pid, entry); groups.add(entry.pgrp); changed = true;
          }
          // A fast candidate child may be reparented before the next lineage scan.
          // Membership in an already-owned process group still identifies it.
          if (groups.has(entry.pgrp) && !owned.has(entry.pid)) {
            owned.set(entry.pid, entry); changed = true;
          }
        }
      }
    } catch { scanFailed = true; }
  };
  const scanTimer = setInterval(() => {
    if (!scanInProgress) scanInProgress = scan().finally(() => { scanInProgress = undefined; });
  }, 40);
  // Do not await process-table IO before installing exit/abort listeners: a short
  // worker or an early abort can otherwise finish in that observation window.
  scanInProgress=scan().finally(()=>{scanInProgress=undefined;});

  const output: Buffer[] = [];
  let outputBytes = 0;
  let overflow = false;
  let rejectOutputLimit!: (error: Error) => void;
  const outputLimit = new Promise<never>((_, reject) => { rejectOutputLimit = reject; });
  child.stdout!.on("data", (chunk: Buffer | string) => {
    const bytes = Buffer.from(chunk);
    outputBytes += bytes.byteLength;
    if (outputBytes > OUTPUT_LIMIT) {
      if (!overflow) rejectOutputLimit(stableError("oracle_output_limit"));
      overflow = true;
      return;
    }
    output.push(bytes);
  });
  child.stdin!.on("error", () => undefined);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", () => reject(stableError("oracle_worker_start_failed")));
    child.once("close", (code, signalCode) => resolve({ code, signal: signalCode }));
  });
  let rejectAbort!: (error: Error) => void;
  const abortError = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(stableError("oracle_aborted"));
  signal?.addEventListener("abort", onAbort, { once: true });
  if(signal?.aborted)onAbort();
  const timerError = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(stableError("oracle_timeout")), timeoutMs);
    timer.unref();
    void exited.then(() => clearTimeout(timer), () => clearTimeout(timer));
  });
  // Race the process and limits; all late process settlement remains observed.
  let failure: unknown;
  let result: OracleResult | undefined;
  try {
    child.stdin!.end(input);
    const exit = await Promise.race([exited, abortError, timerError, outputLimit]);
    if (overflow) throw stableError("oracle_output_limit");
    if (exit.code !== 0) throw stableError("oracle_worker_failed");
    result = workerResult(Buffer.concat(output).toString("utf8"));
  } catch (error) {
    failure = error instanceof Error && typeof (error as Error & { code?: unknown }).code === "string"
      ? error
      : stableError("oracle_worker_failed");
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }

  // The worker may exit while candidate tests or a browser remain. Sample and
  // retain observed descendants, including children that created another group.
  clearInterval(scanTimer);
  if (scanInProgress) await scanInProgress;
  await scan();
  const activeOwned = async () => {
    await scan();
    let table: Map<number, ProcEntry>;
    try { table = await procTable(); } catch { scanFailed = true; return []; }
    return [...owned.values()].filter((old) => {
      const current = table.get(old.pid);
      return current?.start === old.start && current.state !== "Z";
    });
  };
  const signalOwned = async (signalName: NodeJS.Signals) => {
    const active = await activeOwned();
    const activeGroups = new Set(active.map((entry) => entry.pgrp));
    // The original group may contain a child that raced the first /proc sample.
    if (groups.has(pgid)) activeGroups.add(pgid);
    for (const group of activeGroups) {
      try { process.kill(-group, signalName); } catch { /* group already gone */ }
    }
    return active;
  };
  await signalOwned("SIGTERM");
  let remaining = await waitForExit(async () => (await activeOwned()).length === 0, TERMINATE_MS);
  if (!remaining) {
    await signalOwned("SIGKILL");
    remaining = await waitForExit(async () => (await activeOwned()).length === 0, KILL_MS);
  }
  clearInterval(scanTimer);
  if (scanInProgress) await scanInProgress;
  if (!remaining || scanFailed) throw stableError("oracle_cleanup_unverified");
  if (failure !== undefined) throw failure;
  return result ?? { status: "INCONCLUSIVE", checks: [{ id: "oracle-result", status: "INCONCLUSIVE", exit_code: null }], metrics: {} };
}

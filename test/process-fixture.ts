import { execFile, spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, openSync, readSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { expect } from "vitest";

type TextReader = (path: string, encoding: "utf8") => Promise<string>;
const ZOMBIE_STAT = /^\d+ \(.*\) Z /;

/** Process inspection in these fixtures uses `/proc` on Linux and `ps` on macOS. */
export const processInspectionSupported = process.platform === "linux" || process.platform === "darwin";

/** From XNU `bsd/sys/fcntl.h`, as in src/setup-platform.ts. */
const DARWIN_O_NONBLOCK = 0x4;
const DARWIN_O_EXLOCK = 0x20;

function darwinProcessField(pid: number, field: "stat=" | "command="): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    execFile("/bin/ps", ["-o", field, "-p", String(pid)], { env: { LC_ALL: "C" }, encoding: "utf8" }, (error, stdout) => {
      if (!error) { resolve(stdout.trim()); return; }
      // ps exits 1 with no output when the PID does not exist.
      if (error.code === 1 && stdout.trim() === "") { resolve(undefined); return; }
      reject(error);
    });
  });
}

/** The first state letter of a process (`Z` for a zombie), or undefined when it is gone. */
export async function processState(pid: number): Promise<string | undefined> {
  if (process.platform === "darwin") return (await darwinProcessField(pid, "stat="))?.[0];
  const stat = await readTextIfPresent(`/proc/${pid}/stat`);
  return stat === undefined ? undefined : stat[stat.lastIndexOf(") ") + 2];
}

/** The command line of a process, or undefined when it is gone. */
export async function processCommandLine(pid: number): Promise<string | undefined> {
  if (process.platform === "darwin") return darwinProcessField(pid, "command=");
  return readTextIfPresent(`/proc/${pid}/cmdline`);
}

/** True while another open file description holds the setup lock file. */
export function isLockHeld(path: string): boolean {
  if (process.platform === "darwin") {
    let fd: number;
    try { fd = openSync(path, constants.O_RDWR | DARWIN_O_EXLOCK | DARWIN_O_NONBLOCK); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EAGAIN" || code === "EWOULDBLOCK") return true;
      throw error;
    }
    closeSync(fd);
    return false;
  }
  const flockPath = existsSync("/usr/bin/flock") ? "/usr/bin/flock" : "/bin/flock";
  const status = spawnSync(flockPath, ["-n", path, "/bin/true"], { stdio: "ignore" }).status;
  if (status !== 0 && status !== 1) throw new Error("fixture_lock_probe_failed");
  return status === 1;
}

/** One complete kernel sample, without libuv yields between open/read/close. */
export async function readProcStatText(path: string, encoding: "utf8"): Promise<string> {
  const buffer = Buffer.alloc(8_192);
  const fd = openSync(path, "r");
  let readFailure: unknown;
  try {
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytesRead === 0 || bytesRead === buffer.length) throw new Error("fixture_proc_stat_incomplete");
    const stat = buffer.subarray(0, bytesRead).toString(encoding);
    const close = stat.lastIndexOf(") ");
    const fields = stat.slice(close + 2, -1).split(" ");
    // Linux stat has 52 fields: PID, comm, state and 49 numeric fields.
    // Reject an incomplete/malformed sample rather than obtaining another one.
    if (!/^\d+ \(/.test(stat) || close < 3 || !stat.endsWith("\n") || fields.length < 50
      || !/^[A-Za-z]$/.test(fields[0]!) || fields.slice(1).some((field) => !/^-?\d+$/.test(field))) {
      throw new Error("fixture_proc_stat_invalid");
    }
    return stat;
  } catch (error) { readFailure = error; throw error; }
  finally {
    try { closeSync(fd); }
    catch (error) {
      // A close error, even ENOENT, cannot prove the process was absent.
      throw new AggregateError(readFailure === undefined ? [error] : [readFailure, error], "fixture_proc_stat_close_failed");
    }
  }
}

export async function readTextIfPresent(path: string, readText: TextReader = readFile): Promise<string | undefined> {
  try { return await readText(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Proves the process stopped executing; it does not prove reaping or fence release. */
export async function expectProcessTerminated(pid: number, readText?: TextReader): Promise<void> {
  expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
  if (readText === undefined && process.platform === "darwin") {
    const state = await processState(pid);
    if (state !== undefined) expect(state).toBe("Z");
    return;
  }
  const stat = await readTextIfPresent(`/proc/${pid}/stat`, readText ?? readProcStatText);
  // Keep the assertion outside the read catch so a live process always fails.
  if (stat !== undefined) expect(stat).toMatch(ZOMBIE_STAT);
}

export async function readPidIfPresent(path: string): Promise<number | undefined> {
  const text = await readTextIfPresent(path);
  if (text === undefined) return undefined;
  const pid = Number(text);
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("fixture_pid_invalid");
  return pid;
}

export async function waitForPidFile(path: string, timeoutMs = 5_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  do {
    const pid = await readPidIfPresent(path);
    if (pid !== undefined) return pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new Error("fixture_pid_not_ready");
}

export function signalFixtureProcess(pid: number, signal: NodeJS.Signals, group = false): void {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("fixture_pid_invalid");
  try { process.kill(group ? -pid : pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

export async function waitForProcessTerminated(pid: number, readText?: TextReader, timeoutMs = 5_000): Promise<void> {
  expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
  const deadline = Date.now() + timeoutMs;
  if (readText === undefined && process.platform === "darwin") {
    while (true) {
      const state = await processState(pid);
      if (state === undefined || state === "Z") return;
      if (Date.now() >= deadline) { expect(state).toBe("Z"); return; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  const reader = readText ?? readProcStatText;
  while (true) {
    let stat: string | undefined;
    try { stat = await readTextIfPresent(`/proc/${pid}/stat`, reader); }
    catch (error) {
      // Reaping can invalidate an already opened /proc file. ESRCH is unknown,
      // so cleanup must obtain a later Z/ENOENT sample within the same bound.
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ESRCH" || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
      continue;
    }
    // Preserve this determinate sample; a redundant read can race with reaping.
    if (stat === undefined || ZOMBIE_STAT.test(stat)) return;
    if (Date.now() >= deadline) { expect(stat).toMatch(ZOMBIE_STAT); return; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Kill only fixture-owned PIDs/groups, including when the tested assertion fails. */
export async function stopFixtureProcess(pid: number, group = false): Promise<void> {
  signalFixtureProcess(pid, "SIGKILL", group);
  await waitForProcessTerminated(pid);
}

/** Let the guardian clean its detached command before it releases the fence. */
export async function stopFixtureGuardian(pid: number, resumeSignal: "SIGCONT" | "SIGUSR2"): Promise<void> {
  await cleanupFixtureProcesses([
    async () => signalFixtureProcess(pid, resumeSignal),
    async () => signalFixtureProcess(pid, "SIGTERM"),
    async () => waitForProcessTerminated(pid),
  ]);
}

export async function cleanupFixtureProcesses(actions: readonly (() => Promise<void>)[]): Promise<void> {
  const results = await Promise.allSettled(actions.map(async (action) => action()));
  const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason as unknown] : []);
  if (errors.length > 0) throw new AggregateError(errors, "fixture_cleanup_failed");
}

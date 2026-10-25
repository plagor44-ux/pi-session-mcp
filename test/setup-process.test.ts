import { execPath } from "node:process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs, { existsSync } from "node:fs";
import { open, readFile, realpath, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";
import { createCommandMcpStdioLauncher, createMcpStdioLauncher, createProcessRunner } from "../src/setup-process.js";
import { currentSetupPlatform } from "../src/setup-platform.js";
import { cleanupFixtureProcesses, expectProcessTerminated, readPidIfPresent, readProcStatText, signalFixtureProcess, stopFixtureProcess, processState, waitForPidFile, waitForProcessTerminated } from "./process-fixture.js";

afterAll(removeTemporaryRoots);

function descendantScript(pidFile: string, parentPidFile: string, exitOnTerm = false): string {
  const child = `const fs=require('node:fs'); process.on('SIGTERM',()=>{}); fs.writeFileSync(${JSON.stringify(`${pidFile}.tmp`)},String(process.pid)); fs.renameSync(${JSON.stringify(`${pidFile}.tmp`)},${JSON.stringify(pidFile)}); setInterval(()=>{},1000);`;
  return [
    "const {spawn}=require('node:child_process'); const fs=require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(`${parentPidFile}.tmp`)},String(process.pid)); fs.renameSync(${JSON.stringify(`${parentPidFile}.tmp`)},${JSON.stringify(parentPidFile)}); spawn(process.execPath,['-e',${JSON.stringify(child)}]);`,
    exitOnTerm ? "process.on('SIGTERM',()=>process.exit(0));" : "",
    "setTimeout(()=>{},10000);",
  ].join(" ");
}

async function cleanupDescendants(parentPidFile: string, pidFile: string): Promise<void> {
  await cleanupFixtureProcesses([
    async () => { const pid = await readPidIfPresent(parentPidFile); if (pid !== undefined) await stopFixtureProcess(pid, true); },
    async () => { const pid = await readPidIfPresent(pidFile); if (pid !== undefined) await stopFixtureProcess(pid); },
  ]);
}

describe.skipIf(!currentSetupPlatform())("setup process runner", () => {
  it("launches arbitrary stdio argv with the exact no-refresh environment", async () => {
    const launch = createCommandMcpStdioLauncher([execPath, "-e", "process.stdin.on('data',()=>process.stdout.write(JSON.stringify({refresh:process.env.PI_WRITER_NO_CREDENTIAL_REFRESH,unexpected:process.env.UNEXPECTED_SECRET})+'\\n'))"], { PI_WRITER_NO_CREDENTIAL_REFRESH: "1" });
    const child = await launch(new AbortController().signal);
    try {
      await child.write("request\n");
      expect(JSON.parse((await child.read())!)).toEqual({ refresh: "1" });
    } finally { await child.kill(); }
  });
  it("honors per-command cwd and merges per-command environment", async () => {
    const cwd = await temporaryRoot("setup-process-cwd-");
    const runner = createProcessRunner({ env: { BASE: "base", OVERRIDE: "old" } });
    const pwd = await runner.run("/bin/pwd", [], undefined, { cwd });
    expect(pwd.exitCode).toBe(0);
    // macOS temporary roots live behind the /var -> /private/var symlink; pwd prints the real path.
    expect(pwd.stdout.trim()).toBe(await realpath(cwd));
    const env = await runner.run(execPath, ["-e", "process.stdout.write(process.env.BASE + ':' + process.env.OVERRIDE)"], undefined, { env: { OVERRIDE: "new" } });
    expect(env.stdout).toBe("base:new");
  });

  it("guardian honors an existing absolute cwd and rejects a missing directory at spawn", async () => {
    const directory = await temporaryRoot("setup-guardian-cwd-");
    const handle = await open(join(directory, "lock"), "w+");
    const child = spawn(execPath, [join(process.cwd(), "src/setup-command-guardian.ts"), String(process.pid)], { stdio: ["ignore", "ignore", "ignore", handle.fd, "ipc"] });
    try {
      await once(child, "message");
      const request = { type: "run", id: 1, command: "/bin/pwd", args: [], timeoutMs: 1000, maxOutputBytes: 4096, cwd: directory };
      const result = once(child, "message");
      child.send(request);
      expect((await result)[0]).toMatchObject({ type: "result", id: 1, exitCode: 0, stdout: `${await realpath(directory)}\n` });
      const missing = once(child, "message");
      child.send({ ...request, id: 2, cwd: join(directory, "missing") });
      expect((await missing)[0]).toMatchObject({ type: "result", id: 2, exitCode: 127 });
      const closed = once(child, "close");
      child.send({ type: "shutdown" });
      await closed;
    } finally { child.kill("SIGKILL"); await handle.close(); }
  });

  it.each([{ cwd: "relative" }, { cwd: "/", env: {} }, { cwd: `/${"x".repeat(4096)}` }])("guardian rejects invalid options %j", async (options) => {
    const directory = await temporaryRoot("setup-guardian-protocol-");
    const handle = await open(join(directory, "lock"), "w+");
    const child = spawn(execPath, [join(process.cwd(), "src/setup-command-guardian.ts"), String(process.pid)], { stdio: ["ignore", "ignore", "ignore", handle.fd, "ipc"] });
    try {
      const closed = once(child, "close");
      await once(child, "message");
      const marker = join(directory, "spawned");
      child.send({ type: "run", id: 1, command: execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`], timeoutMs: 1000, maxOutputBytes: 1024, ...options });
      await closed;
      expect(existsSync(marker)).toBe(false);
    } finally { child.kill("SIGKILL"); await handle.close(); }
  });
  it("captures a short-lived process exit without using a real client", async () => {
    const result = await createProcessRunner({ timeoutMs: 1_000 }).run(execPath, ["-e", "process.stdout.write('SAFE_STDOUT'); process.stderr.write('SAFE_STDERR'); process.exitCode=7"]);
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe("SAFE_STDOUT");
    expect(result.stderr).toBe("SAFE_STDERR");
  });

  it("terminates a short-lived timeout process within its bound", async () => {
    const started = Date.now();
    const result = await createProcessRunner({ timeoutMs: 30 }).run(execPath, ["-e", "setTimeout(() => {}, 10_000)"]);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.exitCode).not.toBe(0);
  });

  it("terminates an in-flight process when its transaction is aborted", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const resultPromise = createProcessRunner({ timeoutMs: 10_000 }).run(execPath, ["-e", "setTimeout(() => {}, 10_000)"], controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    const result = await resultPromise;
    expect(result.exitCode).toBe(125);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("escalates abort to SIGKILL and waits for descendants", async () => {
    const directory = await temporaryRoot("pi-session-mcp-process-abort-group-");
    const pidFile = join(directory, "child.pid");
    const parentPidFile = join(directory, "parent.pid");
    const script = descendantScript(pidFile, parentPidFile, true);
    const controller = new AbortController();
    const resultPromise = createProcessRunner({ timeoutMs: 10_000 }).run(execPath, ["-e", script], controller.signal);
    try {
      // The child records readiness after installing its SIGTERM handler. Poll only
      // ENOENT within a wall-clock bound, rather than 100 scheduling-dependent tries.
      const childPid = await waitForPidFile(pidFile);
      controller.abort();
      const result = await resultPromise;
      expect(result.exitCode).toBe(125);
      await expectProcessTerminated(childPid);
    } finally {
      controller.abort();
      try { await resultPromise; }
      finally { await cleanupDescendants(parentPidFile, pidFile); }
    }
  }, 30_000);

  it("terminates descendants with the timed-out process group", async () => {
    const directory = await temporaryRoot("pi-session-mcp-process-");
    const pidFile = join(directory, "child.pid");
    const parentPidFile = join(directory, "parent.pid");
    const script = descendantScript(pidFile, parentPidFile);
    // Timing assumption: the fixture must start its child and record the pid
    // before the runner's budget kills the group; the parent itself would run for 10 s.
    // A 300 ms budget raced startup under load. The 2 s budget also includes child
    // readiness: the child writes its pid only after installing its SIGTERM handler.
    // The pid file outlives the group, so it is read once the runner has settled.
    const controller = new AbortController();
    const resultPromise = createProcessRunner({ timeoutMs: 2_000 }).run(execPath, ["-e", script], controller.signal);
    try {
      const result = await resultPromise;
      expect(result.exitCode).toBe(124);
      const childPid = Number(await readFile(pidFile, "utf8"));
      await expectProcessTerminated(childPid);
    } finally {
      controller.abort();
      try { await resultPromise; }
      finally { await cleanupDescendants(parentPidFile, pidFile); }
    }
  }, 30_000);

  it("rejects a real living descendant in the shared termination assertion", async () => {
    const child = spawn(execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      await once(child, "spawn");
      expect(child.pid).toBeTypeOf("number");
      const pid = child.pid!;
      const state = await processState(pid);
      expect(state).toBeDefined();
      expect(state).not.toBe("Z");
      await expect(expectProcessTerminated(pid)).rejects.toMatchObject({ name: "AssertionError" });
    } finally {
      child.kill("SIGKILL");
      await closed;
    }
  });

  it("cleans a living fixture even when another cleanup step rejects", async () => {
    const child = spawn(execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const error = Object.assign(new Error("unreadable"), { code: "EACCES" });
    try {
      await once(child, "spawn");
      await expect(cleanupFixtureProcesses([
        async () => { throw error; },
        async () => { child.kill("SIGKILL"); await closed; },
      ])).rejects.toMatchObject({ name: "AggregateError", errors: [error] });
      expect(child.signalCode).toBe("SIGKILL");
    } finally {
      child.kill("SIGKILL");
      await closed;
    }
  });
});

describe.skipIf(process.platform !== "linux")("Linux /proc fixture", () => {
  it("preserves one complete kernel stat sample through actual owned reaping", async () => {
    const directory = await temporaryRoot("pi-session-mcp-proc-sample-");
    const marker = join(directory, "child.pid");
    const childScript = `const fs=require('node:fs');process.on('SIGTERM',()=>process.exit(0));fs.writeFileSync(${JSON.stringify(`${marker}.tmp`)},String(process.pid));fs.renameSync(${JSON.stringify(`${marker}.tmp`)},${JSON.stringify(marker)});setInterval(()=>{},1000);`;
    const parentScript = `const {spawn}=require('node:child_process');const fs=require('node:fs');let child;process.on('SIGTERM',()=>child?.kill('SIGKILL'));child=spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});child.on('close',()=>process.exit(0));const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)})){clearInterval(timer);process.kill(process.pid,'SIGSTOP');}},10);`;
    const parent = spawn(execPath, ["-e", parentScript], { stdio: "ignore", detached: true });
    let parentClosed = false;
    const closed = new Promise<void>((resolve) => parent.once("close", () => { parentClosed = true; resolve(); }));
    let childPid: number | undefined;
    let stale: Awaited<ReturnType<typeof open>> | undefined;
    const nativeOpen = fs.openSync;
    const nativeRead = fs.readSync;
    const nativeClose = fs.closeSync;
    try {
      await once(parent, "spawn");
      childPid = await waitForPidFile(marker);
      let stopped = false;
      const stoppedDeadline = Date.now() + 5_000;
      do {
        const stat = await readFile(`/proc/${parent.pid}/stat`, "utf8");
        stopped = stat[stat.lastIndexOf(") ") + 2] === "T";
        if (!stopped) await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      } while (!stopped && Date.now() < stoppedDeadline);
      expect(stopped).toBe(true);
      signalFixtureProcess(childPid, "SIGTERM");
      await waitForProcessTerminated(childPid);
      const statPath = `/proc/${childPid}/stat`;
      // Hold another real FD across reaping to demonstrate why a later read is unknown.
      stale = await open(statPath, "r");
      let sampleFd: number | undefined;
      let actualSample: string | undefined;
      let openCalls = 0;
      let readCalls = 0;
      let closeCalls = 0;
      vi.spyOn(fs, "openSync").mockImplementation((...args) => {
        const fd = Reflect.apply(nativeOpen, fs, args) as number;
        if (args[0] === statPath) { sampleFd = fd; openCalls++; }
        return fd;
      });
      vi.spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
        const bytesRead = Reflect.apply(nativeRead, fs, args) as number;
        if (args[0] === sampleFd) {
          readCalls++;
          actualSample = (args[1] as Buffer).subarray(0, bytesRead).toString("utf8");
          signalFixtureProcess(parent.pid!, "SIGCONT");
          // The independent owner reaps its child while this reader holds its sample.
          const reapedDeadline = Date.now() + 5_000;
          while (fs.existsSync(statPath)) {
            if (Date.now() >= reapedDeadline) throw new Error("fixture_child_not_reaped");
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
          }
        }
        return bytesRead;
      }) as typeof fs.readSync);
      vi.spyOn(fs, "closeSync").mockImplementation((fd) => { if (fd === sampleFd) closeCalls++; nativeClose(fd); });
      // Documented synchronization instruments real built-in operations, without
      // replacing any kernel bytes, state or read error.
      syncBuiltinESMExports();
      const sample = await readProcStatText(statPath, "utf8");
      expect(sample).toBe(actualSample);
      expect(sample).toMatch(new RegExp(`^${childPid} \\(.*\\) Z `));
      expect({ openCalls, readCalls, closeCalls }).toEqual({ openCalls: 1, readCalls: 1, closeCalls: 1 });
      await closed;
      await expect(readFile(statPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      const buffer = Buffer.alloc(8_192);
      // This actual stale-FD read is an error, never proof of absence/termination.
      await expect(expectProcessTerminated(childPid, async () => {
        const { bytesRead } = await stale!.read(buffer, 0, buffer.length, 0);
        return buffer.subarray(0, bytesRead).toString("utf8");
      })).rejects.toMatchObject({ code: "ESRCH", syscall: "read" });
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
      try { await stale?.close(); }
      finally {
        await cleanupFixtureProcesses([
          async () => {
            if (parent.pid !== undefined) {
              signalFixtureProcess(parent.pid, "SIGCONT");
              if (!parentClosed) signalFixtureProcess(parent.pid, "SIGTERM");
            }
            const cleanupDeadline = Date.now() + 5_000;
            while (!parentClosed) {
              if (Date.now() >= cleanupDeadline) {
                if (parent.pid !== undefined) signalFixtureProcess(parent.pid, "SIGKILL", true);
                throw new Error("fixture_owner_cleanup_failed");
              }
              await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
            }
            await closed;
          },
          async () => { const pid = childPid ?? await readPidIfPresent(marker); if (pid !== undefined) signalFixtureProcess(pid, "SIGKILL"); },
        ]);
      }
    }
  }, 15_000);

  it.each([
    ["empty", ""],
    ["incomplete", "123 (fixture) Z 1 123"],
    ["malformed", "123 (fixture) Z 1 123\n"],
    ["buffer full", "x".repeat(8_192)],
  ])("rejects an %s stat sample instead of reading again", async (_name, text) => {
    const directory = await temporaryRoot("pi-session-mcp-proc-invalid-");
    const path = join(directory, "invalid.stat");
    await writeFile(path, text);
    await expect(readProcStatText(path, "utf8")).rejects.toThrow(/^fixture_proc_stat_(incomplete|invalid)$/);
  });

  it.each(["EACCES", "EIO", "ESRCH"])("propagates actual-reader %s failures and closes its FD", async (code) => {
    const error = Object.assign(new Error("unreadable"), { code });
    const close = vi.spyOn(fs, "closeSync");
    vi.spyOn(fs, "readSync").mockImplementation(() => { throw error; });
    syncBuiltinESMExports();
    try {
      await expect(expectProcessTerminated(process.pid)).rejects.toBe(error);
      expect(close).toHaveBeenCalledTimes(1);
    } finally { vi.restoreAllMocks(); syncBuiltinESMExports(); }
  });

  it.each(["EIO", "ENOENT"])("rejects %s from close rather than calling a live process absent", async (code) => {
    const error = Object.assign(new Error("close_failed"), { code });
    const nativeClose = fs.closeSync;
    vi.spyOn(fs, "closeSync").mockImplementation((fd) => { nativeClose(fd); throw error; });
    syncBuiltinESMExports();
    try {
      await expect(expectProcessTerminated(process.pid)).rejects.toMatchObject({ name: "AggregateError", errors: [error] });
    } finally { vi.restoreAllMocks(); syncBuiltinESMExports(); }
  });

  it("accepts a zombie or an ENOENT stat in the termination assertion", async () => {
    await expectProcessTerminated(123, async () => "123 (fixture) Z 1 123");
    await expectProcessTerminated(123, async () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); });
  });

  it.each(["EACCES", "EIO", "ESRCH"])("rejects unexpected %s stat errors in the termination assertion", async (code) => {
    const error = Object.assign(new Error("unreadable"), { code });
    await expect(expectProcessTerminated(123, async () => { throw error; })).rejects.toBe(error);
  });

  it.each(["zombie", "absent"])("preserves a determinate %s cleanup sample when a later read would fail", async (state) => {
    let sampled = false;
    await waitForProcessTerminated(123, async () => {
      if (sampled) throw Object.assign(new Error("reaped during read"), { code: "ESRCH" });
      sampled = true;
      if (state === "absent") throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return "123 (fixture) Z 1 123";
    });
  });

  it.each(["zombie", "absent"])("requires a determinate %s sample after transient cleanup ESRCH", async (state) => {
    let invalidated = false;
    let determinate = false;
    await waitForProcessTerminated(123, async () => {
      if (!invalidated) { invalidated = true; throw Object.assign(new Error("reaped during read"), { code: "ESRCH" }); }
      determinate = true;
      if (state === "absent") throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return "123 (fixture) Z 1 123";
    });
    expect(determinate).toBe(true);
  });

  it("rejects persistent cleanup ESRCH instead of treating it as termination", async () => {
    const error = Object.assign(new Error("indeterminate"), { code: "ESRCH" });
    await expect(waitForProcessTerminated(123, async () => { throw error; }, 20)).rejects.toBe(error);
  });

  it.each(["EACCES", "EIO"])("rejects %s during cleanup polling", async (code) => {
    const error = Object.assign(new Error("unreadable"), { code });
    await expect(waitForProcessTerminated(123, async () => { throw error; })).rejects.toBe(error);
  });
});

describe("setup process runner platform gate", () => {
  it("returns 126 without spawning on an unsupported platform", async () => {
    const marker = join(await temporaryRoot("pi-session-mcp-platform-gate-"), "spawned");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const result = await createProcessRunner({ timeoutMs: 1_000 }).run(execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'')`]);
      expect(result).toEqual({ exitCode: 126, stdout: "", stderr: "" });
      expect(existsSync(marker)).toBe(false);
    } finally { vi.restoreAllMocks(); }
  });
});

describe.skipIf(!currentSetupPlatform())("verified MCP server shutdown grace (#125)", () => {
  async function serverScript(body: string): Promise<{ entry: string; marker: string; config: string }> {
    const root = await temporaryRoot("pi-session-mcp-shutdown-grace-");
    const entry = join(root, "server.cjs");
    const marker = join(root, "cleaned-up");
    await writeFile(entry, body.replaceAll("MARKER", JSON.stringify(marker)));
    return { entry, marker, config: join(root, "config.json") };
  }

  it("lets a server that needs longer than the old 100 ms finish its shutdown before any SIGKILL", async () => {
    // Stand-in for a server that removes its spool instance directory only after a slow registry shutdown.
    const { entry, marker, config } = await serverScript([
      "let stopping = false;",
      "const stop = () => { if (stopping) return; stopping = true; setTimeout(() => { require('node:fs').writeFileSync(MARKER, 'done'); process.exit(0); }, 400); };",
      "process.on('SIGTERM', stop); process.stdin.on('end', stop); process.stdin.resume(); console.log('ready');",
    ].join("\n"));
    const child = await createMcpStdioLauncher({ nodePath: execPath, entryPath: entry, configPath: config })(new AbortController().signal);
    await child.read(); // Signals are only handled once the script has installed its handlers.
    await child.kill();
    expect(existsSync(marker)).toBe(true);
  });

  it("returns as soon as the server exits, without waiting out the grace", async () => {
    const { entry, config } = await serverScript("process.on('SIGTERM', () => process.exit(0)); process.stdin.on('end', () => process.exit(0)); process.stdin.resume(); console.log('ready');");
    const child = await createMcpStdioLauncher({ nodePath: execPath, entryPath: entry, configPath: config, shutdownGraceMs: 10_000 })(new AbortController().signal);
    await child.read(); // Signals are only handled once the script has installed its handlers.
    const started = Date.now();
    await child.kill();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("still SIGKILLs a server that ignores termination once the grace has passed", async () => {
    const { entry, marker, config } = await serverScript("process.on('SIGTERM', () => {}); process.stdin.on('data', () => {}); console.log('ready'); setInterval(() => {}, 1000); setTimeout(() => require('node:fs').writeFileSync(MARKER, 'survived'), 3000);");
    const grace = 300;
    const child = await createMcpStdioLauncher({ nodePath: execPath, entryPath: entry, configPath: config, shutdownGraceMs: grace })(new AbortController().signal);
    await child.read(); // Signals are only handled once the script has installed its handlers.
    const started = Date.now();
    await child.kill();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(grace - 50);
    expect(elapsed).toBeLessThan(grace + 2_500);
    await new Promise((resolve) => setTimeout(resolve, 3_200));
    expect(existsSync(marker)).toBe(false);
  });

  it("gives a writer wrapper's server the same grace before any SIGKILL", async () => {
    const { entry, marker } = await serverScript([
      "let stopping = false;",
      "const stop = () => { if (stopping) return; stopping = true; setTimeout(() => { require('node:fs').writeFileSync(MARKER, 'done'); process.exit(0); }, 400); };",
      "process.on('SIGTERM', stop); process.stdin.on('end', stop); process.stdin.resume(); console.log('ready');",
    ].join("\n"));
    const child = await createCommandMcpStdioLauncher([execPath, entry], {})(new AbortController().signal);
    await child.read(); // Signals are only handled once the script has installed its handlers.
    await child.kill();
    expect(existsSync(marker)).toBe(true);
  });
});

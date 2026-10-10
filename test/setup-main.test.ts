import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";
import { main, type SetupMainDependencies } from "../src/setup-main.js";
import { DurableOwnershipStore } from "../src/setup-ownership.js";
import { currentSetupPlatform } from "../src/setup-platform.js";
import { SetupOrchestrator, result } from "../src/setup.js";
import { cleanupFixtureProcesses, expectProcessTerminated, isLockHeld, processState, readPidIfPresent, signalFixtureProcess, stopFixtureGuardian, stopFixtureProcess, waitForPidFile } from "./process-fixture.js";

describe("setup executable", () => {
  const originalConfig = process.env.PI_SESSION_MCP_CONFIG;
  afterAll(removeTemporaryRoots);
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalConfig === undefined) delete process.env.PI_SESSION_MCP_CONFIG;
    else process.env.PI_SESSION_MCP_CONFIG = originalConfig;
  });

  it("returns a strict sanitized misuse result", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((value: string | Uint8Array) => { writes.push(String(value)); return true; }) as typeof process.stdout.write);
    expect(await main(["--json", "--unsupported"])).toBe(64);
    expect(JSON.parse(writes.join(""))).toMatchObject({ schemaVersion: 1, status: "failed", exitCode: 64, findings: [{ code: "usage_invalid" }] });
  });

  it("requires configuration without exposing an environment value", async () => {
    delete process.env.PI_SESSION_MCP_CONFIG;
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((value: string | Uint8Array) => { writes.push(String(value)); return true; }) as typeof process.stdout.write);
    expect(await main(["--json", "--dry-run", "--target", "codex:user:pi-session-mcp"])).toBe(1);
    const output = writes.join("");
    expect(JSON.parse(output)).toMatchObject({ schemaVersion: 1, operation: "dry-run", exitCode: 1, findings: [{ code: "config_required" }] });
    expect(output).not.toMatch(/PI_SESSION_MCP_CONFIG|\/home\/|SECRET/);
  });

  it("classifies release initialization failure as operational, not CLI misuse", async () => {
    process.env.PI_SESSION_MCP_CONFIG = "/SECRET/config.json";
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((value: string | Uint8Array) => { writes.push(String(value)); return true; }) as typeof process.stdout.write);
    const createSetup = async (): Promise<never> => { throw new Error("RAW_RELEASE_FAILURE"); };
    expect(await main(["--json", "--apply", "--target", "codex:user:pi-session-mcp"], { createSetup })).toBe(1);
    const output = writes.join("");
    expect(JSON.parse(output)).toMatchObject({ operation: "apply", exitCode: 1, findings: [{ code: "release_unavailable" }] });
    expect(output).not.toMatch(/SECRET|RAW_RELEASE|config\.json/);
  });

  it.each(["win32", "freebsd"] as const)("fails closed on %s before creating setup or spawning a client", async (platform) => {
    process.env.PI_SESSION_MCP_CONFIG = "/SECRET/config.json";
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((value: string | Uint8Array) => { writes.push(String(value)); return true; }) as typeof process.stdout.write);
    const createSetup = vi.fn(async (): Promise<never> => { throw new Error("must_not_start"); });
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    expect(await main(["--json", "--apply", "--target", "codex:user:pi-session-mcp"], { createSetup })).toBe(1);
    expect(createSetup).not.toHaveBeenCalled();
    const output = writes.join("");
    expect(JSON.parse(output)).toMatchObject({ operation: "apply", exitCode: 1, findings: [{ code: "platform_unsupported" }] });
    expect(output).not.toMatch(/SECRET|config\.json/);
  });

  it("accepts darwin as a setup platform", async () => {
    process.env.PI_SESSION_MCP_CONFIG = "/SECRET/config.json";
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((value: string | Uint8Array) => { writes.push(String(value)); return true; }) as typeof process.stdout.write);
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const createSetup = vi.fn(async () => ({ run: async () => result("dry-run", []) }) as unknown as SetupOrchestrator);
    expect(await main(["--json", "--dry-run", "--target", "codex:user:pi-session-mcp"], { createSetup })).toBe(0);
    expect(createSetup).toHaveBeenCalledOnce();
    expect(JSON.parse(writes.join(""))).toMatchObject({ operation: "dry-run", exitCode: 0 });
  });

  it.skipIf(!currentSetupPlatform()).each([{ signal: "SIGINT", exitCode: 130 }, { signal: "SIGTERM", exitCode: 143 }] as const)("awaits $signal cleanup and returns only a stable sanitized result", async ({ signal: processSignal, exitCode }) => {
    process.env.PI_SESSION_MCP_CONFIG = "/SECRET/config.json";
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((value: string | Uint8Array) => { writes.push(String(value)); return true; }) as typeof process.stdout.write);
    let signalAborted: boolean | undefined;
    const createSetup = async (...args: Parameters<NonNullable<SetupMainDependencies["createSetup"]>>): Promise<SetupOrchestrator> => {
      const signal = args[4];
      process.emit(processSignal);
      signalAborted = signal?.aborted;
      return { run: async () => result("apply", []) } as unknown as SetupOrchestrator;
    };
    const actualExitCode = await main(["--json", "--apply", "--target", "codex:user:pi-session-mcp"], { createSetup });
    expect(actualExitCode).toBe(exitCode);
    expect(signalAborted).toBe(true);
    const output = writes.join("");
    expect(JSON.parse(output)).toMatchObject({ operation: "apply", exitCode, findings: [{ code: "operation_interrupted" }] });
    expect(output).not.toMatch(/SECRET|config\.json/);
  });

  it.skipIf(!currentSetupPlatform()).each([{ signal: "SIGINT", exitCode: 130 }, { signal: "SIGTERM", exitCode: 143 }] as const)("holds the fence while $signal cleans a stubborn real process group", async ({ signal: processSignal, exitCode }) => {
    const directory = await temporaryRoot("pi-session-mcp-main-signal-");
    const ownershipPath = join(directory, "ownership.json");
    const marker = join(directory, "helper.pid");
    const mutationMarker = join(directory, "mutation.pid");
    const guardianMarker = join(directory, "guardian.pid");
    const cleanupMarker = join(directory, "cleanup.started");
    const termMarker = join(directory, "helper.sigterm");
    const preloadPath = join(directory, "pause-owned-guardian.mjs");
    const guardianEntry = fileURLToPath(new URL("../src/setup-command-guardian.ts", import.meta.url));
    // Test-only execution barrier: after real abort IPC and real group SIGTERM,
    // stop this exact guardian before its kill grace timer is armed. Gate the
    // instrumentation by the owned lock inode and actual mutation group PID.
    await writeFile(preloadPath, [
      "import { fstatSync, statSync, readFileSync, writeFileSync, renameSync } from 'node:fs';",
      `if (process.argv[1] === ${JSON.stringify(guardianEntry)}) {`,
      `const linked = statSync(${JSON.stringify(`${ownershipPath}.flock`)}); const held = fstatSync(3);`,
      "if (linked.isFile() && held.isFile() && linked.dev === held.dev && linked.ino === held.ino) {",
      "const kill = process.kill.bind(process); let aborted = false; let paused = false;",
      "process.on('message', message => { if (message?.type === 'abort') aborted = true; });",
      "process.kill = (pid, signal) => { const delivered = kill(pid, signal);",
      "if (aborted && !paused && signal === 'SIGTERM') {",
      `const group = Number(readFileSync(${JSON.stringify(mutationMarker)}, 'utf8'));`,
      "if (Number.isSafeInteger(group) && group > 1 && pid === -group) { paused = true;",
      `writeFileSync(${JSON.stringify(`${cleanupMarker}.tmp`)}, String(group)); renameSync(${JSON.stringify(`${cleanupMarker}.tmp`)}, ${JSON.stringify(cleanupMarker)});`,
      "kill(process.pid, 'SIGSTOP'); } } return delivered; }; } }",
    ].join("\n"));
    const helperScript = `const fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(`${termMarker}.tmp`)},String(process.pid));fs.renameSync(${JSON.stringify(`${termMarker}.tmp`)},${JSON.stringify(termMarker)});});fs.writeFileSync(${JSON.stringify(`${marker}.tmp`)},String(process.pid));fs.renameSync(${JSON.stringify(`${marker}.tmp`)},${JSON.stringify(marker)});setInterval(()=>{},1000);`;
    const mutation = [
      "const {spawn}=require('node:child_process');const fs=require('node:fs');process.on('SIGTERM',()=>{});",
      `fs.writeFileSync(${JSON.stringify(`${guardianMarker}.tmp`)},String(process.ppid));fs.renameSync(${JSON.stringify(`${guardianMarker}.tmp`)},${JSON.stringify(guardianMarker)});`,
      `fs.writeFileSync(${JSON.stringify(`${mutationMarker}.tmp`)},String(process.pid));fs.renameSync(${JSON.stringify(`${mutationMarker}.tmp`)},${JSON.stringify(mutationMarker)});spawn(process.execPath,['-e',${JSON.stringify(helperScript)}],{stdio:'ignore'});`,
      "setInterval(()=>{},1000);",
    ].join(" ");
    process.env.PI_SESSION_MCP_CONFIG = "/SECRET/config.json";
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((value: string | Uint8Array) => { writes.push(String(value)); return true; }) as typeof process.stdout.write);
    let helperPid: number | undefined;
    let guardianPid: number | undefined;
    let mutationPid: number | undefined;
    let cleanupGroupPid: number | undefined;
    let termAcknowledgement: number | undefined;
    let runnerExitCode: number | undefined;
    let lockWasHeld: boolean | undefined;
    let helperWasLive = false;
    let helperStayedLive = false;
    let guardianWasStopped = false;
    let startupFailure: unknown;
    let fixtureFailure: unknown;
    const originalNodeOptions = process.env.NODE_OPTIONS;
    const createSetup = async (...args: Parameters<NonNullable<SetupMainDependencies["createSetup"]>>): Promise<SetupOrchestrator> => {
      const signal = args[4];
      return { run: async () => new DurableOwnershipStore(ownershipPath, { ...(signal ? { signal } : {}) }).transaction(async (access) => {
        const running = access.mutationRunner!.run(process.execPath, ["-e", mutation], access.signal?.());
        try {
          // Independent ownership markers let every failure path resume the guardian.
          guardianPid = await waitForPidFile(guardianMarker);
          mutationPid = await waitForPidFile(mutationMarker);
          helperPid = await waitForPidFile(marker);
          let observationFailure: unknown;
          try {
            process.emit(processSignal);
            cleanupGroupPid = await waitForPidFile(cleanupMarker);
            termAcknowledgement = await waitForPidFile(termMarker);
            const stoppedDeadline = Date.now() + 5_000;
            do {
              guardianWasStopped = (await processState(guardianPid)) === "T";
              if (!guardianWasStopped) await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
            } while (!guardianWasStopped && Date.now() < stoppedDeadline);
            const helperState = await processState(helperPid);
            helperWasLive = helperState !== undefined && helperState !== "Z";
            lockWasHeld = isLockHeld(`${ownershipPath}.flock`);
            const afterProbe = await processState(helperPid);
            helperStayedLive = afterProbe !== undefined && afterProbe !== "Z";
          } catch (error) { observationFailure = error; throw error; }
          finally {
            try { signalFixtureProcess(guardianPid, "SIGCONT"); }
            catch (error) { if (observationFailure !== undefined) throw new AggregateError([observationFailure, error], "fixture_observation_cleanup_failed"); throw error; }
          }
          runnerExitCode = (await running).exitCode;
          return result("apply", []);
        } catch (error) { fixtureFailure = error; throw error; }
      }).catch((error: unknown) => { if (!signal?.aborted) startupFailure = error; throw error; }) } as unknown as SetupOrchestrator;
    };
    try {
      process.env.NODE_OPTIONS = [originalNodeOptions, "--unhandled-rejections=strict", `--import=${pathToFileURL(preloadPath).href}`].filter(Boolean).join(" ");
      const actualExitCode = await main(["--json", "--apply", "--target", "codex:user:pi-session-mcp"], { createSetup });
      // Assert outside main's sanitizing catch so it cannot swallow test failures.
      if (startupFailure !== undefined) throw startupFailure;
      if (fixtureFailure !== undefined) throw fixtureFailure;
      expect(actualExitCode).toBe(exitCode);
      expect(runnerExitCode).toBe(125);
      expect(cleanupGroupPid).toBe(mutationPid);
      expect(termAcknowledgement).toBe(helperPid);
      expect(guardianWasStopped).toBe(true);
      expect(helperWasLive).toBe(true);
      expect(helperStayedLive).toBe(true);
      expect(lockWasHeld).toBe(true);
      const output = writes.join("");
      expect(JSON.parse(output)).toMatchObject({ operation: "apply", exitCode, findings: [{ code: "operation_interrupted" }] });
      expect(output).not.toMatch(/SECRET|config\.json|mutation_failed/);
      await expectProcessTerminated(helperPid!);
    } finally {
      try {
        await cleanupFixtureProcesses([
          async () => { const pid = guardianPid ?? await readPidIfPresent(guardianMarker); if (pid !== undefined) await stopFixtureGuardian(pid, "SIGCONT"); },
          async () => { const pid = mutationPid ?? await readPidIfPresent(mutationMarker); if (pid !== undefined) await stopFixtureProcess(pid, true); },
          async () => { const pid = helperPid ?? await readPidIfPresent(marker); if (pid !== undefined) await stopFixtureProcess(pid); },
        ]);
      } finally {
        if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
        else process.env.NODE_OPTIONS = originalNodeOptions;
      }
    }
  }, 15_000);
});

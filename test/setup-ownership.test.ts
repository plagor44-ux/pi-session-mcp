import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";
import { DurableOwnershipStore, type OwnershipRecord } from "../src/setup-ownership.js";
import { cleanupFixtureProcesses, expectProcessTerminated, readPidIfPresent, readTextIfPresent, signalFixtureProcess, stopFixtureGuardian, stopFixtureProcess, waitForPidFile } from "./process-fixture.js";

afterAll(removeTemporaryRoots);

describe.skipIf(process.platform !== "linux")("durable setup ownership", () => {
  it("persists only bounded path-free ownership data with restrictive modes", async () => {
    const directory = await temporaryRoot("pi-session-mcp-owned-");
    const path = join(directory, "state", "ownership.json");
    const store = new DurableOwnershipStore(path);
    const record: OwnershipRecord = {
      target: { client: "codex", scope: "user", alias: "pi-session-mcp" },
      fingerprint: "a".repeat(64), previous: "absent", phase: "owned", transactionId: randomUUID(),
    };
    await store.put(record);
    expect(await store.get(record.target)).toEqual(record);
    const serialized = await readFile(path, "utf8");
    expect(serialized).not.toMatch(/PI_SESSION_MCP_CONFIG|\/home\/|\.\.\/|SECRET/);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, "state"))).mode & 0o777).toBe(0o700);
  });

  it("rejects invalid records before writing state", async () => {
    const directory = await temporaryRoot("pi-session-mcp-owned-invalid-");
    const store = new DurableOwnershipStore(join(directory, "ownership.json"));
    const invalid = {
      target: { client: "codex", scope: "project", alias: "pi-session-mcp" },
      fingerprint: "not-a-fingerprint", previous: "absent", phase: "owned", transactionId: "not-a-uuid",
    } as unknown as OwnershipRecord;
    await expect(store.put(invalid)).rejects.toThrow("ownership_invalid");
  });

  it("acquires a kernel lease lock", async () => {
    const directory = await temporaryRoot("pi-session-mcp-owned-stale-");
    const path = join(directory, "state", "ownership.json");
    const store = new DurableOwnershipStore(path);
    const record: OwnershipRecord = { target: { client: "codex", scope: "user", alias: "pi-session-mcp" }, fingerprint: "c".repeat(64), previous: "absent", phase: "owned", transactionId: randomUUID() };
    await expect(store.put(record)).resolves.toBeUndefined();
    expect(await store.get(record.target)).toEqual(record);
  });

  it("serializes two concurrent kernel lease holders", async () => {
    const directory = await temporaryRoot("pi-session-mcp-owned-stale-race-");
    const path = join(directory, "ownership.json");
    let active = 0;
    let maximum = 0;
    const exercise = async (store: DurableOwnershipStore): Promise<void> => store.transaction(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 75));
      active -= 1;
    });
    await Promise.all([exercise(new DurableOwnershipStore(path)), exercise(new DurableOwnershipStore(path))]);
    expect(maximum).toBe(1);
  });

  it("holds one lock across the full ownership transaction", async () => {
    const directory = await temporaryRoot("pi-session-mcp-owned-transaction-");
    const path = join(directory, "ownership.json");
    const firstStore = new DurableOwnershipStore(path);
    let secondOpened!: () => void;
    const secondLockOpened = new Promise<void>((resolve) => { secondOpened = resolve; });
    const secondStore = new DurableOwnershipStore(path, { afterLockOpen: secondOpened });
    const target = { client: "codex", scope: "user", alias: "pi-session-mcp" } as const;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let pendingWritten!: () => void;
    const firstPendingWritten = new Promise<void>((resolve) => { pendingWritten = resolve; });
    const pending: OwnershipRecord = { target, fingerprint: "d".repeat(64), previous: "absent", phase: "pending", transactionId: randomUUID() };
    const first = firstStore.transaction(async (access) => { await access.put(pending); pendingWritten(); await gate; await access.put({ ...pending, phase: "owned" }); });
    let observed: Promise<OwnershipRecord["phase"] | undefined> | undefined;
    try {
      // File creation precedes acquisition; readiness requires the successful write.
      // Racing the transaction also propagates a failure before either readiness ack.
      await Promise.race([firstPendingWritten, first]);
      observed = secondStore.transaction(async (access) => (await access.get(target))?.phase);
      await Promise.race([secondLockOpened, observed]);
      // The second descriptor is open while the first transaction still holds its gate.
      const flockPath = existsSync("/usr/bin/flock") ? "/usr/bin/flock" : "/bin/flock";
      expect(spawnSync(flockPath, ["-n", `${path}.flock`, "/bin/true"], { stdio: "ignore" }).status).toBe(1);
      release();
      await first;
      await expect(observed).resolves.toBe("owned");
    } finally {
      release();
      const settled = await Promise.allSettled(observed === undefined ? [first] : [first, observed]);
      const failures = settled.flatMap((entry) => entry.status === "rejected" ? [entry.reason as unknown] : []);
      if (failures.length > 0) throw new AggregateError(failures, "fixture_transaction_cleanup_failed");
    }
  });

  it("rejects a lock inode replaced while acquisition is waiting", async () => {
    const directory = await temporaryRoot("pi-session-mcp-owned-inode-");
    const path = join(directory, "ownership.json");
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
    const first = new DurableOwnershipStore(path).transaction(async () => { firstEntered(); await firstGate; });
    await entered;
    let secondOpened!: () => void;
    const opened = new Promise<void>((resolve) => { secondOpened = resolve; });
    let resumeSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => { resumeSecond = resolve; });
    const second = new DurableOwnershipStore(path, { afterLockOpen: async () => { secondOpened(); await secondGate; } }).transaction(async () => undefined);
    await opened;
    await unlink(`${path}.flock`);
    await writeFile(`${path}.flock`, "", { mode: 0o600 });
    resumeSecond();
    releaseFirst();
    await first;
    await expect(second).rejects.toThrow("ownership_lock_unavailable");
  });

  it("rejects a lock inode replaced after the lock file was opened", async () => {
    const directory = await temporaryRoot("pi-session-mcp-owned-replaced-");
    const path = join(directory, "ownership.json");
    const store = new DurableOwnershipStore(path, { afterLockOpen: async () => { await unlink(`${path}.flock`); await writeFile(`${path}.flock`, "", { mode: 0o600 }); } });
    await expect(store.transaction(async () => undefined)).rejects.toThrow("ownership_lock_unavailable");
  });

  it("refuses a symlinked lock file", async () => {
    const directory = await temporaryRoot("pi-session-mcp-owned-symlink-");
    const path = join(directory, "ownership.json");
    await writeFile(join(directory, "elsewhere"), "", { mode: 0o600 });
    await symlink(join(directory, "elsewhere"), `${path}.flock`);
    await expect(new DurableOwnershipStore(path).transaction(async () => undefined)).rejects.toThrow("ownership_lock_unavailable");
  });

  it("stops waiting for a held lock when aborted", async () => {
    const directory = await temporaryRoot("pi-session-mcp-owned-abort-");
    const path = join(directory, "ownership.json");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const holding = new Promise<void>((resolve) => { entered = resolve; });
    const first = new DurableOwnershipStore(path).transaction(async () => { entered(); await gate; });
    try {
      await holding;
      const controller = new AbortController();
      const started = Date.now();
      const second = new DurableOwnershipStore(path, { signal: controller.signal, acquireTimeoutMs: 10_000 }).transaction(async () => undefined);
      setTimeout(() => controller.abort(), 100);
      await expect(second).rejects.toThrow("operation_aborted");
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      release();
      await first;
    }
  });

  it("keeps the kernel fence through parent SIGKILL until guardian cleanup", async () => {
    const directory = await temporaryRoot("pi-session-mcp-owned-guardian-");
    const path = join(directory, "ownership.json");
    const marker = join(directory, "helper.pid");
    const guardianMarker = join(directory, "guardian.pid");
    const mutationMarker = join(directory, "mutation.pid");
    const moduleUrl = pathToFileURL(resolve("src/setup-process.ts")).href;
    const helperScript = `const fs=require('node:fs'); process.on('SIGTERM',()=>{}); fs.writeFileSync(${JSON.stringify(`${marker}.tmp`)},String(process.pid)); fs.renameSync(${JSON.stringify(`${marker}.tmp`)},${JSON.stringify(marker)}); setInterval(()=>{},1000);`;
    const mutation = [
      "const {spawn}=require('node:child_process'); const fs=require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(`${mutationMarker}.tmp`)},String(process.pid)); fs.renameSync(${JSON.stringify(`${mutationMarker}.tmp`)},${JSON.stringify(mutationMarker)}); spawn(process.execPath,['-e',${JSON.stringify(helperScript)}],{stdio:'ignore'});`,
      "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);",
    ].join(" ");
    const harness = [
      "import { constants } from 'node:fs'; import { open } from 'node:fs/promises';",
      `import { acquireSetupGuardian } from ${JSON.stringify(moduleUrl)};`,
      `const handle=await open(${JSON.stringify(`${path}.flock`)},constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW,0o600);`,
      "const guardian=await acquireSetupGuardian(handle.fd,5000);",
      "const fs=await import('node:fs'); const child=fs.readdirSync('/proc').filter(value=>/^\\d+$/.test(value)).map(Number).find(pid=>{try{const line=fs.readFileSync(`/proc/${pid}/stat`,'utf8');const close=line.lastIndexOf(') ');return Number(line.slice(close+4).trim().split(/\\s+/)[0])===process.pid;}catch{return false;}});",
      `fs.writeFileSync(${JSON.stringify(`${guardianMarker}.tmp`)},String(child)); fs.renameSync(${JSON.stringify(`${guardianMarker}.tmp`)},${JSON.stringify(guardianMarker)});`,
      `const output=await guardian.runner.run(process.execPath,['-e',${JSON.stringify(mutation)}]);process.exitCode=output.exitCode;`,
    ].join("\n");
    const parent = spawn(process.execPath, ["--input-type=module", "-e", harness], { stdio: "ignore", detached: true });
    const parentClosed = new Promise<void>((resolveClose) => parent.once("close", () => resolveClose()));
    let helperPid: number | undefined;
    let guardianPid: number | undefined;
    let mutationPid: number | undefined;
    try {
      guardianPid = await waitForPidFile(guardianMarker);
      mutationPid = await waitForPidFile(mutationMarker);
      helperPid = await waitForPidFile(marker);
      expect(parent.pid).toBeTypeOf("number");
      signalFixtureProcess(guardianPid, "SIGSTOP");
      let guardianStopped = false;
      const stoppedDeadline = Date.now() + 5_000;
      do {
        const line = await readTextIfPresent(`/proc/${guardianPid}/stat`);
        guardianStopped = line !== undefined && line[line.lastIndexOf(") ") + 2] === "T";
        if (!guardianStopped) await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      } while (!guardianStopped && Date.now() < stoppedDeadline);
      expect(guardianStopped).toBe(true);
      signalFixtureProcess(parent.pid!, "SIGKILL");
      await parentClosed;
      try {
        const helperStat = await readFile(`/proc/${helperPid}/stat`, "utf8");
        expect(helperStat[helperStat.lastIndexOf(") ") + 2]).not.toBe("Z");
        const flockPath = existsSync("/usr/bin/flock") ? "/usr/bin/flock" : "/bin/flock";
        const competing = spawnSync(flockPath, ["-n", `${path}.flock`, "/bin/true"], { stdio: "ignore" });
        expect(competing.status).toBe(1);
      } finally {
        signalFixtureProcess(guardianPid, "SIGCONT");
      }
      const second = new DurableOwnershipStore(path, { acquireTimeoutMs: 10_000 });
      await expect(second.transaction(async () => undefined)).resolves.toBeUndefined();
      await expectProcessTerminated(helperPid);
    } finally {
      await cleanupFixtureProcesses([
        async () => { if (parent.pid !== undefined) await stopFixtureProcess(parent.pid, true); await parentClosed; },
        async () => {
          const pid = guardianPid ?? await readPidIfPresent(guardianMarker);
          if (pid !== undefined) {
            await stopFixtureGuardian(pid, "SIGCONT");
          }
        },
        async () => { const pid = mutationPid ?? await readPidIfPresent(mutationMarker); if (pid !== undefined) await stopFixtureProcess(pid, true); },
        async () => { const pid = helperPid ?? await readPidIfPresent(marker); if (pid !== undefined) await stopFixtureProcess(pid); },
      ]);
    }
  }, 25_000);

  it("retains the fence after indeterminate cleanup reports exit 126", async () => {
    const directory = await temporaryRoot("pi-session-mcp-owned-unknown-");
    const path = join(directory, "ownership.json");
    const guardianMarker = join(directory, "guardian.pid");
    const mutationMarker = join(directory, "mutation.started");
    const resultMarker = join(directory, "result.code");
    const moduleUrl = pathToFileURL(resolve("src/setup-process.ts")).href;
    const mutation = `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(`${mutationMarker}.tmp`)},String(process.pid));fs.renameSync(${JSON.stringify(`${mutationMarker}.tmp`)},${JSON.stringify(mutationMarker)});setInterval(()=>{},1000);`;
    const harness = [
      "import { constants } from 'node:fs'; import { open } from 'node:fs/promises'; const fs=await import('node:fs');",
      `import { acquireSetupGuardian } from ${JSON.stringify(moduleUrl)};`,
      `const handle=await open(${JSON.stringify(`${path}.flock`)},constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW,0o600);`,
      "const guardian=await acquireSetupGuardian(handle.fd,5000);",
      "const child=fs.readdirSync('/proc').filter(value=>/^\\d+$/.test(value)).map(Number).find(pid=>{try{const line=fs.readFileSync(`/proc/${pid}/stat`,'utf8');const close=line.lastIndexOf(') ');return Number(line.slice(close+4).trim().split(/\\s+/)[0])===process.pid;}catch{return false;}});",
      `fs.writeFileSync(${JSON.stringify(`${guardianMarker}.tmp`)},String(child)); fs.renameSync(${JSON.stringify(`${guardianMarker}.tmp`)},${JSON.stringify(guardianMarker)});`,
      "const controller=new AbortController(); process.on('SIGTERM',()=>controller.abort());",
      `const output=await guardian.runner.run(process.execPath,['-e',${JSON.stringify(mutation)}],controller.signal);`,
      `fs.writeFileSync(${JSON.stringify(`${resultMarker}.tmp`)},String(output.exitCode)); fs.renameSync(${JSON.stringify(`${resultMarker}.tmp`)},${JSON.stringify(resultMarker)}); await guardian.release(); await handle.close();`,
    ].join("\n");
    const parent = spawn(process.execPath, ["--input-type=module", "-e", harness], { stdio: "ignore", detached: true });
    const parentClosed = new Promise<void>((resolveClose) => parent.once("close", () => resolveClose()));
    let guardianPid: number | undefined;
    let mutationPid: number | undefined;
    try {
      guardianPid = await waitForPidFile(guardianMarker);
      mutationPid = await waitForPidFile(mutationMarker);
      signalFixtureProcess(guardianPid, "SIGUSR1");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      expect(parent.pid).toBeTypeOf("number");
      signalFixtureProcess(parent.pid!, "SIGTERM");
      let reported: number | undefined;
      const reportDeadline = Date.now() + 5_000;
      do {
        const report = await readTextIfPresent(resultMarker);
        if (report !== undefined) reported = Number(report);
        else await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      } while (reported === undefined && Date.now() < reportDeadline);
      expect(reported).toBe(126);
      await parentClosed;
      const flockPath = existsSync("/usr/bin/flock") ? "/usr/bin/flock" : "/bin/flock";
      expect(spawnSync(flockPath, ["-n", `${path}.flock`, "/bin/true"], { stdio: "ignore" }).status).toBe(1);
      signalFixtureProcess(guardianPid, "SIGUSR2");
      await expect(new DurableOwnershipStore(path, { acquireTimeoutMs: 10_000 }).transaction(async () => undefined)).resolves.toBeUndefined();
    } finally {
      await cleanupFixtureProcesses([
        async () => { if (parent.pid !== undefined) await stopFixtureProcess(parent.pid, true); await parentClosed; },
        async () => {
          const pid = guardianPid ?? await readPidIfPresent(guardianMarker);
          if (pid !== undefined) {
            await stopFixtureGuardian(pid, "SIGUSR2");
          }
        },
        async () => { const pid = mutationPid ?? await readPidIfPresent(mutationMarker); if (pid !== undefined) await stopFixtureProcess(pid, true); },
      ]);
    }
  }, 25_000);

  it.each(["missing", "unreadable"])("lets the guardian clean its detached command with a %s mutation marker", async (markerState) => {
    const directory = await temporaryRoot("pi-session-mcp-owned-cleanup-marker-");
    const lockPath = join(directory, "ownership.flock");
    const guardianMarker = join(directory, "guardian.pid");
    const mutationMarker = join(directory, "mutation.pid");
    const oracleMarker = join(directory, "owned-oracle.pid");
    if (markerState === "unreadable") await mkdir(mutationMarker);
    const moduleUrl = pathToFileURL(resolve("src/setup-process.ts")).href;
    const mutation = `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(`${oracleMarker}.tmp`)},String(process.pid));fs.renameSync(${JSON.stringify(`${oracleMarker}.tmp`)},${JSON.stringify(oracleMarker)});setInterval(()=>{},1000);`;
    const harness = [
      "import { constants } from 'node:fs'; import { open } from 'node:fs/promises'; const fs=await import('node:fs');",
      `import { acquireSetupGuardian } from ${JSON.stringify(moduleUrl)};`,
      `const handle=await open(${JSON.stringify(lockPath)},constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW,0o600);`,
      "const guardian=await acquireSetupGuardian(handle.fd,5000);",
      "const child=fs.readdirSync('/proc').filter(value=>/^\\d+$/.test(value)).map(Number).find(pid=>{try{const line=fs.readFileSync(`/proc/${pid}/stat`,'utf8');const close=line.lastIndexOf(') ');return Number(line.slice(close+4).trim().split(/\\s+/)[0])===process.pid;}catch{return false;}});",
      `fs.writeFileSync(${JSON.stringify(`${guardianMarker}.tmp`)},String(child));fs.renameSync(${JSON.stringify(`${guardianMarker}.tmp`)},${JSON.stringify(guardianMarker)});`,
      `await guardian.runner.run(process.execPath,['-e',${JSON.stringify(mutation)}]);`,
    ].join("\n");
    const parent = spawn(process.execPath, ["--input-type=module", "-e", harness], { stdio: "ignore", detached: true });
    const parentClosed = new Promise<void>((resolveClose) => parent.once("close", () => resolveClose()));
    let guardianPid: number | undefined;
    let oraclePid: number | undefined;
    try {
      guardianPid = await waitForPidFile(guardianMarker);
      oraclePid = await waitForPidFile(oracleMarker);
      if (markerState === "missing") await expect(waitForPidFile(mutationMarker, 50)).rejects.toThrow("fixture_pid_not_ready");
      else await expect(waitForPidFile(mutationMarker)).rejects.toMatchObject({ code: "EISDIR" });
      // The production-shaped cleanup deliberately has no access to the oracle PID.
      await cleanupFixtureProcesses([
        async () => { if (parent.pid !== undefined) await stopFixtureProcess(parent.pid, true); await parentClosed; },
        async () => stopFixtureGuardian(guardianPid!, "SIGUSR2"),
      ]);
      await expectProcessTerminated(oraclePid);
    } finally {
      // The independent oracle also owns emergency cleanup when the assertion fails.
      await cleanupFixtureProcesses([
        async () => { if (parent.pid !== undefined) await stopFixtureProcess(parent.pid, true); await parentClosed; },
        async () => { const pid = guardianPid ?? await readPidIfPresent(guardianMarker); if (pid !== undefined) await stopFixtureGuardian(pid, "SIGUSR2"); },
        async () => { const pid = oraclePid ?? await readPidIfPresent(oracleMarker); if (pid !== undefined) await stopFixtureProcess(pid, true); },
      ]);
    }
  }, 20_000);

});

describe("durable setup ownership platform gate", () => {
  it("fails closed on an unsupported platform before touching the filesystem", async () => {
    const directory = await temporaryRoot("pi-session-mcp-owned-platform-");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      await expect(new DurableOwnershipStore(join(directory, "state", "ownership.json")).transaction(async () => undefined)).rejects.toThrow("platform_unsupported");
      expect(existsSync(join(directory, "state"))).toBe(false);
    } finally { vi.restoreAllMocks(); }
  });
});

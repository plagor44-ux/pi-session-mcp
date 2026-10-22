import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";
import {
  assertSupportedFilesystem, createProcessTable, currentSetupPlatform, DARWIN_O_EXLOCK, DARWIN_O_NONBLOCK,
  isTrustedSystemBinary, openLockedDarwin, parsePsTable,
} from "../src/setup-platform.js";

afterAll(removeTemporaryRoots);

describe("setup platform detection", () => {
  it.each([["linux", "linux"], ["darwin", "darwin"], ["win32", undefined], ["freebsd", undefined]] as const)("maps %s to %s", (input, expected) => {
    expect(currentSetupPlatform(input)).toBe(expected);
  });
});

describe("trusted system binary", () => {
  const stats = (overrides: Partial<{ isFile: () => boolean; uid: number; mode: number }>) => ({ isFile: () => true, uid: 0, mode: 0o100755, ...overrides });
  it("accepts a root-owned executable that only root can write", () => {
    expect(isTrustedSystemBinary("/bin/ps", () => stats({}))).toBe(true);
  });
  it.each([
    ["not root-owned", { uid: 501 }],
    ["group-writable", { mode: 0o100775 }],
    ["world-writable", { mode: 0o100757 }],
    ["not executable", { mode: 0o100644 }],
    ["not a regular file", { isFile: () => false }],
  ] as const)("rejects a binary that is %s", (_name, overrides) => {
    expect(isTrustedSystemBinary("/bin/ps", () => stats(overrides))).toBe(false);
  });
  it("rejects a missing binary", () => {
    expect(isTrustedSystemBinary("/bin/ps", () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); })).toBe(false);
  });
});

describe("ps table parser", () => {
  it("parses pid, process group and state, including zombie suffixes", () => {
    expect(parsePsTable("    1     1 Ss\n 4242  4242 S+\n 4243  4242 Z+\n 4244  4242 Zs\n")).toEqual([
      { pid: 1, group: 1, state: "Ss" }, { pid: 4242, group: 4242, state: "S+" },
      { pid: 4243, group: 4242, state: "Z+" }, { pid: 4244, group: 4242, state: "Zs" },
    ]);
  });
  it.each([
    ["empty output", ""],
    ["a header line", "  PID  PGID STAT\n    1     1 Ss\n"],
    ["a missing column", "    1     1\n"],
    ["an extra column", "    1     1 Ss extra\n"],
    ["a blank line inside", "    1     1 Ss\n\n    2     2 S\n"],
    ["a negative pid", "   -1     1 S\n"],
  ])("rejects %s", (_name, text) => {
    expect(parsePsTable(text)).toBeUndefined();
  });
});

describe("macOS process table", () => {
  const table = (stdout: string | undefined, exitCode = 0) => createProcessTable("darwin", {
    selfPid: 100,
    runPs: async () => stdout === undefined ? undefined : { exitCode, stdout },
  });
  it("reports a group with a live member as alive", async () => {
    expect(await table("  100   100 S\n  200   200 S\n  201   200 Z\n").groupState(200)).toBe("alive");
  });
  it("reports a group whose members are all zombies as gone", async () => {
    expect(await table("  100   100 S\n  201   200 Z\n  202   200 Z+\n  203   200 Zs\n").groupState(200)).toBe("gone");
  });
  it("reports a group without members as gone", async () => {
    expect(await table("  100   100 S\n  300   300 S\n").groupState(200)).toBe("gone");
  });
  it.each([
    ["ps could not run", undefined, 0],
    ["ps exited non-zero", "  100   100 S\n", 1],
    ["the output is malformed", "  100   100 S\ngarbage\n", 0],
    ["the caller is missing", "  300   300 S\n", 0],
  ] as const)("is unknown and unreadable when %s", async (_name, stdout, exitCode) => {
    const subject = table(stdout, exitCode);
    expect(await subject.groupState(200)).toBe("unknown");
    expect(await subject.readable()).toBe(false);
  });
  it("is readable when the caller appears", async () => {
    expect(await table("  100   100 S\n").readable()).toBe(true);
  });
  it("polls at 50 ms on macOS and 10 ms on Linux", () => {
    expect(table("").pollMs).toBe(50);
    expect(createProcessTable("linux").pollMs).toBe(10);
  });
});

describe("Linux process table", () => {
  const stat = (pid: number, group: number | string, state = "S") => `${pid} (node (worker)) ${state} 1 ${group} ${group} 0 -1 4194304`;
  const errno = (code: string) => Object.assign(new Error(code), { code });
  /** Each pid answers its reads in order; the last answer repeats. */
  const table = (reads: Record<number, readonly (string | Error)[]>, names: readonly string[] = ["self", ...Object.keys(reads)]) => {
    const count = new Map<number, number>();
    return createProcessTable("linux", {
      selfPid: 100,
      procfs: {
        list: () => names,
        readStat: (pid) => {
          const answers = reads[pid] ?? [errno("ENOENT")];
          const index = Math.min(count.get(pid) ?? 0, answers.length - 1);
          count.set(pid, index + 1);
          const answer = answers[index]!;
          if (answer instanceof Error) throw answer;
          return answer;
        },
      },
    });
  };
  it("reports a group with a live member as alive and one with only zombies as gone", async () => {
    expect(await table({ 100: [stat(100, 100)], 200: [stat(200, 200)] }).groupState(200)).toBe("alive");
    expect(await table({ 100: [stat(100, 100)], 201: [stat(201, 200, "Z")] }).groupState(200)).toBe("gone");
  });
  it.each([
    ["vanished from /proc (ENOENT)", [errno("ENOENT")]],
    ["reaped between open and read (ESRCH)", [errno("ESRCH")]],
    ["reported with group -1 and then vanished", [stat(200, -1), errno("ESRCH")]],
  ] as const)("counts a process that %s as gone and stays readable", async (_name, reads) => {
    const subject = table({ 100: [stat(100, 100)], 200: reads });
    expect(await subject.groupState(200)).toBe("gone");
    expect(await table({ 100: [stat(100, 100)], 200: reads }).readable()).toBe(true);
  });
  it("reads a member again that first reports group -1 and finds it alive", async () => {
    expect(await table({ 100: [stat(100, 100)], 200: [stat(200, -1), stat(200, 200)] }).groupState(200)).toBe("alive");
  });
  it.each([
    ["group -1 on both reads", [stat(200, -1)]],
    ["a negative group other than -1", [stat(200, -2)]],
    ["a missing group field", ["200 (node) S 1"]],
    ["a malformed stat line", ["garbage"]],
    ["a read error other than ENOENT or ESRCH", [errno("EACCES")]],
  ] as const)("is unknown and unreadable for %s", async (_name, reads) => {
    expect(await table({ 100: [stat(100, 100)], 200: reads }).groupState(300)).toBe("unknown");
    expect(await table({ 100: [stat(100, 100)], 200: reads }).readable()).toBe(false);
  });
  it("is unknown and unreadable when /proc cannot be listed", async () => {
    const subject = createProcessTable("linux", { selfPid: 100, procfs: { list: () => { throw errno("EMFILE"); }, readStat: () => stat(100, 100) } });
    expect(await subject.groupState(200)).toBe("unknown");
    expect(await subject.readable()).toBe(false);
  });
  it("is unreadable when the caller is missing", async () => {
    expect(await table({ 300: [stat(300, 300)] }).readable()).toBe(false);
  });
});

describe.skipIf(!currentSetupPlatform())("live process table", () => {
  it("is readable and tracks a detached child's process group", async () => {
    const subject = createProcessTable(currentSetupPlatform()!);
    expect(await subject.readable()).toBe(true);
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
    const closed = once(child, "close");
    try {
      await once(child, "spawn");
      expect(await subject.groupState(child.pid!)).toBe("alive");
    } finally {
      process.kill(-child.pid!, "SIGKILL");
      await closed;
    }
    expect(await subject.groupState(child.pid!)).toBe("gone");
  });
});

describe.skipIf(currentSetupPlatform() !== "linux")("Linux process table under process churn", () => {
  // Processes that exit while /proc is listed must not make a scan indeterminate (#109).
  it("stays readable and determinate while short-lived processes come and go", async () => {
    const subject = createProcessTable("linux");
    // A reaped group makes groupState scan the whole table, past the churning entries.
    const reaped = spawn("/bin/true", [], { detached: true, stdio: "ignore" });
    await once(reaped, "close");
    const churn = spawn("/bin/sh", ["-c", "for i in 1 2; do (while :; do /bin/true; done) & done; wait"], { detached: true, stdio: "ignore" });
    const closed = once(churn, "close");
    let scans = 0; let unreadable = 0; let notAlive = 0; let notGone = 0;
    try {
      await once(churn, "spawn");
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        scans++;
        if (!(await subject.readable())) unreadable++;
        if ((await subject.groupState(churn.pid!)) !== "alive") notAlive++;
        if ((await subject.groupState(reaped.pid!)) !== "gone") notGone++;
      }
    } finally {
      process.kill(-churn.pid!, "SIGKILL");
      await closed;
    }
    expect(scans).toBeGreaterThan(10);
    expect({ unreadable, notAlive, notGone }).toEqual({ unreadable: 0, notAlive: 0, notGone: 0 });
  }, 30_000);
});

describe("filesystem rule", () => {
  const reader = (types: Record<string, number>) => async (path: string) => ({ type: types[path]! });
  it("accepts an ext4 directory on Linux", async () => {
    await expect(assertSupportedFilesystem("/state", "linux", reader({ "/state": 0xef53 }))).resolves.toBeUndefined();
  });
  it("rejects NFS on Linux", async () => {
    await expect(assertSupportedFilesystem("/state", "linux", reader({ "/state": 0x6969 }))).rejects.toThrow("ownership_filesystem_unsupported");
  });
  it("accepts a macOS directory with the filesystem type of the system volume", async () => {
    await expect(assertSupportedFilesystem("/state", "darwin", reader({ "/": 26, "/state": 26 }))).resolves.toBeUndefined();
  });
  it("rejects a macOS directory on another filesystem type", async () => {
    await expect(assertSupportedFilesystem("/state", "darwin", reader({ "/": 26, "/state": 28 }))).rejects.toThrow("ownership_filesystem_unsupported");
  });
  it("propagates a statfs failure", async () => {
    const failure = Object.assign(new Error("statfs failed"), { code: "EIO" });
    await expect(assertSupportedFilesystem("/state", "darwin", async () => { throw failure; })).rejects.toBe(failure);
  });
});

describe("macOS lock acquisition", () => {
  const handle = { close: async () => undefined } as unknown as FileHandle;
  const failure = (code: string) => Object.assign(new Error(code), { code });
  it("opens once with an exclusive, non-blocking, no-follow lock", async () => {
    let seen = 0;
    const result = await openLockedDarwin("/lock", { timeoutMs: 1_000, openFile: async (_path, flags, mode) => { seen = flags; expect(mode).toBe(0o600); return handle; } });
    expect(result).toBe(handle);
    for (const flag of [DARWIN_O_EXLOCK, DARWIN_O_NONBLOCK, constants.O_CREAT, constants.O_RDWR, constants.O_NOFOLLOW]) expect(seen & flag).toBe(flag);
  });
  it("retries a busy lock until it is free", async () => {
    let calls = 0;
    const result = await openLockedDarwin("/lock", { timeoutMs: 1_000, retryMs: 1, openFile: async () => { calls += 1; if (calls < 3) throw failure("EAGAIN"); return handle; } });
    expect(result).toBe(handle);
    expect(calls).toBe(3);
  });
  it.each(["EAGAIN", "EWOULDBLOCK"])("reports %s past the bound as busy", async (code) => {
    const started = Date.now();
    await expect(openLockedDarwin("/lock", { timeoutMs: 1_000, retryMs: 5, openFile: async () => { throw failure(code); } })).rejects.toThrow("ownership_lock_busy");
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
  });
  it.each(["EOPNOTSUPP", "ENOTSUP", "EACCES", "ELOOP"])("reports %s as unavailable without retrying", async (code) => {
    let calls = 0;
    await expect(openLockedDarwin("/lock", { timeoutMs: 1_000, openFile: async () => { calls += 1; throw failure(code); } })).rejects.toThrow("ownership_lock_unavailable");
    expect(calls).toBe(1);
  });
  it("stops waiting when aborted", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = openLockedDarwin("/lock", { timeoutMs: 10_000, retryMs: 1_000, signal: controller.signal, openFile: async () => { throw failure("EAGAIN"); } });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toThrow("operation_aborted");
    expect(Date.now() - started).toBeLessThan(1_000);
  });
  it("bounds a non-finite timeout at the maximum instead of waiting forever", async () => {
    const controller = new AbortController();
    let calls = 0;
    const pending = openLockedDarwin("/lock", { timeoutMs: Number.NaN, retryMs: 1, signal: controller.signal, openFile: async () => { calls += 1; throw Object.assign(new Error("busy"), { code: "EAGAIN" }); } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await expect(pending).rejects.toThrow("operation_aborted");
    expect(calls).toBeGreaterThan(1);
  });
  it("does not open after an abort", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(openLockedDarwin("/lock", { timeoutMs: 1_000, signal: controller.signal, openFile: async () => { calls += 1; return handle; } })).rejects.toThrow("operation_aborted");
    expect(calls).toBe(0);
  });
});

describe.skipIf(process.platform !== "darwin")("macOS kernel lock semantics", () => {
  it("excludes a second open file description until the first closes", async () => {
    const path = join(await temporaryRoot("pi-session-mcp-exlock-"), "ownership.json.flock");
    const first = await openLockedDarwin(path, { timeoutMs: 1_000 });
    try {
      await expect(openLockedDarwin(path, { timeoutMs: 1_000 })).rejects.toThrow("ownership_lock_busy");
    } finally { await first.close(); }
    const again = await openLockedDarwin(path, { timeoutMs: 1_000 });
    await again.close();
  });
  it("keeps the lock while a child holds the inherited descriptor", async () => {
    const path = join(await temporaryRoot("pi-session-mcp-exlock-child-"), "ownership.json.flock");
    const first = await openLockedDarwin(path, { timeoutMs: 1_000 });
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: ["ignore", "ignore", "ignore", first.fd] });
    const closed = once(child, "close");
    try {
      await once(child, "spawn");
      await first.close();
      await expect(openLockedDarwin(path, { timeoutMs: 1_000 })).rejects.toThrow("ownership_lock_busy");
    } finally {
      child.kill("SIGKILL");
      await closed;
    }
    const again = await openLockedDarwin(path, { timeoutMs: 1_000 });
    await again.close();
  });
  it("fsyncs a directory on the temporary volume", async () => {
    const handle = await open(await temporaryRoot("pi-session-mcp-dirsync-"), "r");
    try { await handle.sync(); } finally { await handle.close(); }
  });
  it("accepts the temporary directory under the filesystem rule", async () => {
    await expect(assertSupportedFilesystem(await temporaryRoot("pi-session-mcp-fsrule-"), "darwin")).resolves.toBeUndefined();
  });
});

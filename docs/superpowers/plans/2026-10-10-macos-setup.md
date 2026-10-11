# macOS Setup Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The `pi-session-mcp-setup` lifecycle (`--dry-run`, `--apply`,
`--verify`, `--rollback`, `--remove`) works on macOS with the same fence
guarantees as on Linux.

**Architecture:** A new module, `src/setup-platform.ts`, owns every
operating-system fact behind the setup fence:

- platform detection;
- a process table, from `/proc` on Linux and the trusted `/bin/ps` on macOS;
- the filesystem rule;
- the macOS lock, taken with `O_EXLOCK` at open time.

The runner, the MCP launcher, the guardian and the ownership store call this
module instead of reading `/proc` or `statfs` magic numbers themselves. Linux
behavior is unchanged.

**Tech Stack:** Node.js >= 22.19.0, TypeScript (strict, ESM, NodeNext),
Vitest 5, GitHub Actions.

**Spec:** `docs/macos-setup-design.md`. Tracking issue: #32.

## Global Constraints

- Node.js 22.19.0 or newer, TypeScript strict mode, ESM, and `.js` suffixes in
  every static relative import.
- Do not add, remove or change any dependency.
- `src/setup-platform.ts`, `src/setup-process.ts` and
  `src/setup-command-guardian.ts` are loaded by Node type stripping in
  source-mode tests. They may use only erasable TypeScript syntax:
  - no `enum`, `namespace` or parameter properties;
  - type-only imports written as `import type`;
  - no static relative runtime imports in `setup-process.ts` or the guardian
    (only `import type`).
- No new public result codes, statuses or exit codes. Exit codes stay 0, 1,
  64, 130 and 143. Results never contain paths, command arguments, command
  output or raw errors.
- Every platform other than `linux` and `darwin` fails closed with
  `platform_unsupported` before any client command is spawned.
- Linux behavior stays byte-for-byte equivalent:
  - the util-linux `flock -E 75 -w N 3` helper;
  - the `/proc` scan semantics;
  - the filesystem allowlist;
  - the poll intervals (10 ms in the runner, 25 ms in the guardian).
- macOS constants, from XNU `bsd/sys/fcntl.h`: `O_NONBLOCK = 0x4`,
  `O_EXLOCK = 0x20`.
- The macOS process scan is `/bin/ps -A -o pid=,pgid=,stat=`. It runs with:
  - an environment of only `{ LC_ALL: "C" }`;
  - a 2 000 ms timeout;
  - a 1 048 576-byte output cap;
  - a poll interval of 50 ms.
- The macOS lock retries every 50 ms. The acquisition bound is clamped to
  1 000–120 000 ms, the same clamp as the Linux `flock -w`.
- Tracked documentation is written in English.
- One branch (`feat/macos-setup`), one PR, separate commits per task. Every
  commit ends with:

  ```
  Refs #32

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01DZuLc1Pue1cyQxuzpxdGK1
  ```

- Quality gate before every commit: `npm run typecheck`, `npm test`,
  `npm run build`. All must pass on Linux.

## Review Focus

1. **`ps` reports a zombie with suffix flags** (`Z+`, `Zs`) in the group under
   test. It must count as gone, not alive; otherwise the fence is held
   forever. Pinned in Task 1 (`parsePsTable` and macOS table tests).
2. **The ownership lock path is a symlink.** Setup must fail closed with
   `ownership_lock_unavailable` on both platforms (`O_NOFOLLOW`). Pinned in
   Task 3 ("refuses a symlinked lock file").
3. **Ctrl-C while another setup holds the lock.** The waiting run must stop
   promptly with `operation_aborted` instead of waiting out the 30 s bound.
   Pinned in Task 3 ("stops waiting for a held lock when aborted") and Task 1
   (abort unit tests).
4. **The lock file is replaced after it was opened.** The fence must reject
   it on macOS too, because macOS has no waiting window with an open
   descriptor. Pinned in Task 3 ("rejects a lock inode replaced after the
   lock file was opened").
5. **`/bin/ps` is missing, untrusted, failing, malformed or does not list the
   caller.** The scan must be `unknown`, the guardian must not report ready,
   and an active fence must be retained. Pinned in Task 1 (macOS table
   tests); Task 2 keeps the guardian's ready path behind `readable()`.

---

### Task 1: Platform module

**Files:**
- Create: `src/setup-platform.ts`
- Test: `test/setup-platform.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (exact exports):
  - `type SetupPlatform = "linux" | "darwin"`
  - `type ProcessGroupState = "alive" | "gone" | "unknown"`
  - `interface ProcessEntry { readonly pid: number; readonly group: number; readonly state: string }`
  - `interface ProcessTable { groupState(group: number): Promise<ProcessGroupState>; readable(): Promise<boolean>; readonly pollMs: number }`
  - `interface PsOutput { readonly exitCode: number; readonly stdout: string }`
  - `interface ProcessTableDependencies { readonly runPs?: () => Promise<PsOutput | undefined>; readonly selfPid?: number }`
  - `currentSetupPlatform(platform?: NodeJS.Platform): SetupPlatform | undefined`
  - `isTrustedSystemBinary(path: string, statFile?: (path: string) => Pick<Stats, "isFile" | "uid" | "mode">): boolean`
  - `parsePsTable(output: string): readonly ProcessEntry[] | undefined`
  - `createProcessTable(platform: SetupPlatform, dependencies?: ProcessTableDependencies): ProcessTable`
  - `type StatfsReader = (path: string) => Promise<{ readonly type: number }>`
  - `assertSupportedFilesystem(path: string, platform: SetupPlatform, readStatfs?: StatfsReader): Promise<void>`
  - `DARWIN_O_NONBLOCK = 0x4`, `DARWIN_O_EXLOCK = 0x20`, `DARWIN_PS_PATH = "/bin/ps"`
  - `interface DarwinLockOptions { readonly timeoutMs: number; readonly signal?: AbortSignal; readonly retryMs?: number; readonly openFile?: (path: string, flags: number, mode: number) => Promise<FileHandle> }`
  - `openLockedDarwin(path: string, options: DarwinLockOptions): Promise<FileHandle>`

- [ ] **Step 1: Write the failing tests**

Create `test/setup-platform.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/setup-platform.test.ts`
Expected: FAIL. The module `../src/setup-platform.js` cannot be resolved.

- [ ] **Step 3: Implement `src/setup-platform.ts`**

```ts
import { execFile } from "node:child_process";
import { constants, readdirSync, readFileSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { open, statfs } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

/**
 * Operating-system facts behind the setup fence. This module has no relative
 * imports: the transaction guardian and source-mode harnesses load it through
 * Node type stripping, which cannot map a `.js` specifier to its `.ts` source.
 */
export type SetupPlatform = "linux" | "darwin";
export type ProcessGroupState = "alive" | "gone" | "unknown";
export interface ProcessEntry { readonly pid: number; readonly group: number; readonly state: string; }
export interface ProcessTable {
  /** "alive" if any non-zombie process has this process group ID. */
  groupState(group: number): Promise<ProcessGroupState>;
  /** True only if a scan is determinate and contains the calling process. */
  readable(): Promise<boolean>;
  /** Poll interval for cleanup loops. */
  readonly pollMs: number;
}
export interface PsOutput { readonly exitCode: number; readonly stdout: string; }
export interface ProcessTableDependencies {
  /** Test seam for the macOS `ps` call; undefined means it could not run. */
  readonly runPs?: () => Promise<PsOutput | undefined>;
  readonly selfPid?: number;
}

export function currentSetupPlatform(platform: NodeJS.Platform = process.platform): SetupPlatform | undefined {
  return platform === "linux" || platform === "darwin" ? platform : undefined;
}

/** A regular, root-owned executable that no group or other user can replace. */
export function isTrustedSystemBinary(path: string, statFile: (path: string) => Pick<Stats, "isFile" | "uid" | "mode"> = statSync): boolean {
  try {
    const file = statFile(path);
    return file.isFile() && file.uid === 0 && (file.mode & 0o022) === 0 && (file.mode & 0o111) !== 0;
  } catch { return false; }
}

function readLinuxProcessGroup(pid: number): { readonly group: number; readonly state: string } {
  const line = readFileSync(`/proc/${pid}/stat`, "utf8").trim();
  const close = line.lastIndexOf(") ");
  const state = line[close + 2];
  if (close < 3 || !state || !/^[A-Za-z]$/.test(state) || line[close + 3] !== " ") throw new Error("process_stat_invalid");
  const fields = line.slice(close + 4).trim().split(/\s+/);
  const group = Number(fields[1]);
  if (!Number.isSafeInteger(group) || group < 0) throw new Error("process_group_invalid");
  return { group, state };
}

function linuxGroupState(group: number): ProcessGroupState {
  let entries;
  try { entries = readdirSync("/proc", { withFileTypes: true }); }
  catch { return "unknown"; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const sample = readLinuxProcessGroup(Number(entry.name));
      if (sample.group === group && sample.state !== "Z") return "alive";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "unknown";
    }
  }
  return "gone";
}

function linuxTableReadable(selfPid: number): boolean {
  let sawSelf = false;
  try {
    for (const entry of readdirSync("/proc", { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      try {
        const pid = Number(entry.name);
        readLinuxProcessGroup(pid);
        if (pid === selfPid) sawSelf = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      }
    }
  } catch { return false; }
  return sawSelf;
}

export const DARWIN_PS_PATH = "/bin/ps";
const PS_ARGUMENTS = ["-A", "-o", "pid=,pgid=,stat="] as const;
const PS_TIMEOUT_MS = 2_000;
const PS_MAX_OUTPUT_BYTES = 1_048_576;

/** Parses `ps -A -o pid=,pgid=,stat=`; any unexpected line rejects the whole sample. */
export function parsePsTable(output: string): readonly ProcessEntry[] | undefined {
  const body = output.endsWith("\n") ? output.slice(0, -1) : output;
  if (body.length === 0) return undefined;
  const entries: ProcessEntry[] = [];
  for (const line of body.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) return undefined;
    const pid = Number(match[1]);
    const group = Number(match[2]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(group)) return undefined;
    entries.push({ pid, group, state: match[3]! });
  }
  return entries;
}

function runDarwinPs(): Promise<PsOutput | undefined> {
  if (!isTrustedSystemBinary(DARWIN_PS_PATH)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    try {
      execFile(DARWIN_PS_PATH, [...PS_ARGUMENTS], { env: { LC_ALL: "C" }, timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_OUTPUT_BYTES, encoding: "utf8" }, (error, stdout) => {
        // A non-zero exit, timeout, output overflow or spawn failure is indeterminate.
        resolve(error ? undefined : { exitCode: 0, stdout });
      });
    } catch { resolve(undefined); }
  });
}

export function createProcessTable(platform: SetupPlatform, dependencies: ProcessTableDependencies = {}): ProcessTable {
  const selfPid = dependencies.selfPid ?? process.pid;
  if (platform === "linux") {
    return { pollMs: 10, groupState: async (group) => linuxGroupState(group), readable: async () => linuxTableReadable(selfPid) };
  }
  const runPs = dependencies.runPs ?? runDarwinPs;
  const scan = async (): Promise<readonly ProcessEntry[] | undefined> => {
    const output = await runPs();
    if (!output || output.exitCode !== 0) return undefined;
    const entries = parsePsTable(output.stdout);
    // A sample without the caller cannot be a complete process table.
    return entries?.some((entry) => entry.pid === selfPid) ? entries : undefined;
  };
  return {
    pollMs: 50,
    async groupState(group) {
      const entries = await scan();
      if (!entries) return "unknown";
      return entries.some((entry) => entry.group === group && !entry.state.startsWith("Z")) ? "alive" : "gone";
    },
    async readable() { return (await scan()) !== undefined; },
  };
}

// Kernel flock and directory fsync semantics are accepted only on the local
// Linux filesystems covered by the setup test matrix.
const SUPPORTED_LINUX_FILESYSTEMS = new Set([
  0xef53, // ext2/3/4
  0x58465342, // XFS
  0x9123683e, // Btrfs
  0x01021994, // tmpfs
  0x794c7630, // overlayfs
  0x2fc12fc1, // ZFS
  0xf2f52010, // F2FS
  0x24051905, // UBIFS
  0xca451a4e, // bcachefs
]);

export type StatfsReader = (path: string) => Promise<{ readonly type: number }>;

export async function assertSupportedFilesystem(path: string, platform: SetupPlatform, readStatfs: StatfsReader = (target) => statfs(target)): Promise<void> {
  const filesystem = await readStatfs(path);
  if (platform === "linux") {
    if (!SUPPORTED_LINUX_FILESYSTEMS.has(filesystem.type)) throw new Error("ownership_filesystem_unsupported");
    return;
  }
  // macOS assigns f_type dynamically, so the directory must share the type of
  // `/`, the sealed APFS system volume on every macOS that Node.js 22 supports.
  if (filesystem.type !== (await readStatfs("/")).type) throw new Error("ownership_filesystem_unsupported");
}

/** From XNU `bsd/sys/fcntl.h`; Node's `fs.constants` does not export these. */
export const DARWIN_O_NONBLOCK = 0x4;
export const DARWIN_O_EXLOCK = 0x20;

export interface DarwinLockOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly retryMs?: number;
  readonly openFile?: (path: string, flags: number, mode: number) => Promise<FileHandle>;
}

/**
 * Opens the lock file with an exclusive lock on its open file description,
 * which has flock(2) semantics on macOS. A busy lock is retried until the
 * acquisition bound; a failed attempt holds no descriptor.
 */
export async function openLockedDarwin(path: string, options: DarwinLockOptions): Promise<FileHandle> {
  const openFile = options.openFile ?? ((target: string, flags: number, mode: number) => open(target, flags, mode));
  const flags = constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | DARWIN_O_EXLOCK | DARWIN_O_NONBLOCK;
  const deadline = Date.now() + Math.max(1_000, Math.min(options.timeoutMs, 120_000));
  const retryMs = options.retryMs ?? 50;
  while (true) {
    if (options.signal?.aborted) throw new Error("operation_aborted");
    try { return await openFile(path, flags, 0o600); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EAGAIN" && code !== "EWOULDBLOCK") throw new Error("ownership_lock_unavailable");
    }
    if (Date.now() >= deadline) throw new Error("ownership_lock_busy");
    await new Promise<void>((resolve) => {
      const done = (): void => { clearTimeout(timer); options.signal?.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, retryMs);
      options.signal?.addEventListener("abort", done, { once: true });
    });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/setup-platform.test.ts`
Expected: PASS on Linux. The two `macOS kernel lock semantics` and other
darwin-only tests are skipped; the `live process table` test runs.

- [ ] **Step 5: Run the quality gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: all exit 0. `dist/setup-platform.js` exists after the build.

- [ ] **Step 6: Commit**

```bash
git add src/setup-platform.ts test/setup-platform.test.ts
git commit  # subject: "feat: add the setup platform module for Linux and macOS", body per Global Constraints
```

---

### Task 2: Runner, launcher, guardian and release binding on the platform module

**Files:**
- Modify: `src/setup-process.ts` (whole file; the `/proc` code moves out)
- Modify: `src/setup-command-guardian.ts` (lines 1–4, 26–30, 70–113, 147–183, 223–228)
- Modify: `src/setup.ts:168` (the mandatory release artifacts)
- Test: `test/setup-release.test.ts`, `test/setup-process.test.ts`

**Interfaces:**
- Consumes from Task 1: `currentSetupPlatform`, `createProcessTable`,
  `isTrustedSystemBinary`, `ProcessTable`, `ProcessGroupState`.
- Produces: the unchanged exports `createProcessRunner`,
  `createMcpStdioLauncher` and `acquireSetupGuardian(lockFd: number,
  timeoutMs: number, signal?: AbortSignal, validateFence?: () => Promise<void>):
  Promise<SetupGuardian>`.
  - On Linux, `acquireSetupGuardian` runs the util-linux `flock` step on
    `lockFd`.
  - On macOS it skips that step. The caller must pass a descriptor from
    `openLockedDarwin`, which is already locked.
  - The lock step is derived from the platform; there is no lock-mode
    parameter, so a caller cannot select an unlocked mode by mistake.

- [ ] **Step 1: Write the failing tests**

In `test/setup-release.test.ts`, add this line to `releaseFixture()` after the
guardian line:

```ts
  await writeFile(join(root, "dist", "setup-platform.js"), "export const platform = true;\n");
```

Then add this test after "requires a regular non-symlink guardian in the
immutable runtime":

```ts
  it("requires a regular non-symlink platform module in the immutable runtime", async () => {
    const missing = await releaseFixture();
    await rm(join(missing, "dist", "setup-platform.js"));
    await expect(immutableReleaseBinding(missing)).rejects.toThrow("release_entry_missing");
    const linked = await releaseFixture();
    await rm(join(linked, "dist", "setup-platform.js"));
    await symlink("main.js", join(linked, "dist", "setup-platform.js"));
    await expect(immutableReleaseBinding(linked)).rejects.toThrow("release_symlink_invalid");
  });
```

In `test/setup-process.test.ts`, add `vi` to the vitest import if it is not
already imported. Then add this block after the existing `describe`:

```ts
describe("setup process runner platform gate", () => {
  it("returns 126 without spawning on an unsupported platform", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const result = await createProcessRunner({ timeoutMs: 1_000 }).run(execPath, ["-e", "require('node:fs').writeFileSync('must-not-exist','')"]);
      expect(result).toEqual({ exitCode: 126, stdout: "", stderr: "" });
    } finally { vi.restoreAllMocks(); }
  });
});
```

- [ ] **Step 2: Run the tests to verify the release test fails**

Run: `npx vitest run test/setup-release.test.ts test/setup-process.test.ts`
Expected:
- The new release test FAILS: `release_entry_missing` is not thrown for a
  missing `setup-platform.js`.
- The platform-gate test PASSES already. It is a regression pin.

- [ ] **Step 3: Require the platform module in the release binding**

In `src/setup.ts`, replace

```ts
  for (const required of ["main.js", "setup-command-guardian.js"] as const) {
```

with

```ts
  // The guardian loads setup-platform.js at runtime, so it is mandatory too.
  for (const required of ["main.js", "setup-command-guardian.js", "setup-platform.js"] as const) {
```

- [ ] **Step 4: Rewrite `src/setup-process.ts` on the platform module**

Replace lines 1–49 (the imports through the `delay` helper) with:

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { lstatSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CommandResult, CommandRunner } from "./client-adapters/types.js";
import type { McpStdioProcess } from "./client-adapters/mcp-verifier.js";
import type { ProcessGroupState, ProcessTable } from "./setup-platform.js";

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

type SetupPlatformModule = typeof import("./setup-platform.js");
let platformModule: Promise<SetupPlatformModule> | undefined;
/**
 * Source-mode harnesses import this file through Node type stripping, which
 * cannot map a static `./setup-platform.js` import to its `.ts` source.
 */
function loadSetupPlatform(): Promise<SetupPlatformModule> {
  platformModule ??= import(import.meta.url.endsWith(".ts") ? "./setup-platform.ts" : "./setup-platform.js") as Promise<SetupPlatformModule>;
  return platformModule;
}
async function currentProcessTable(): Promise<ProcessTable | undefined> {
  const platform = await loadSetupPlatform();
  const name = platform.currentSetupPlatform();
  return name ? platform.createProcessTable(name) : undefined;
}

/** Kill a detached process and every descendant in its process group. */
function terminateProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, signal); return; } catch { /* already exited or no group */ }
  }
  try { child.kill(signal); } catch { /* already exited */ }
}
const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
```

In `createProcessRunner`, change `run(command, args, signal): Promise<CommandResult> {`
into `async run(command, args, signal): Promise<CommandResult> {`. Then
replace

```ts
if (process.platform !== "linux") return Promise.resolve({ exitCode: 126, stdout: "", stderr: "" }); return new Promise((resolve) => {
```

with

```ts
const table = await currentProcessTable(); if (!table) return { exitCode: 126, stdout: "", stderr: "" }; return new Promise((resolve) => {
```

In the same function, replace the `finishAfterGroup` arrow (the current lines
59–64) with:

```ts
    let groupCheck = false;
    const finishAfterGroup = (successCode: number): void => {
      if (done || groupCheck) return;
      groupCheck = true;
      const group = child.pid;
      void (group === undefined ? Promise.resolve<ProcessGroupState>("unknown") : table.groupState(group)).then((state) => {
        groupCheck = false;
        if (done) return;
        if (state === "gone") { finish(successCode); return; }
        if (Date.now() >= groupDeadline) { finish(126); return; }
        groupPoll = setTimeout(() => finishAfterGroup(successCode), table.pollMs);
      });
    };
```

In `createMcpStdioLauncher`, make the first line of the returned async
function

```ts
    const table = await currentProcessTable();
```

and replace the last three lines of `kill()` (the `groupDeadline` line, the
`while` loop and the `if (!childClosed …)` line) with:

```ts
        const group = child.pid;
        const groupState = async (): Promise<ProcessGroupState> => table && group !== undefined ? table.groupState(group) : "unknown";
        const groupDeadline = Date.now() + 1_000;
        let state = await groupState();
        while (state === "alive" && Date.now() < groupDeadline) { await delay(table?.pollMs ?? 10); state = await groupState(); }
        if (!childClosed || state !== "gone") throw new Error("mcp_process_cleanup_failed");
```

Replace the JSDoc and opening of `acquireSetupGuardian` through the end of the
locker wait (the current lines 129–163) with:

```ts
/**
 * Starts the transaction guardian with the kernel fence held. On Linux the
 * trusted util-linux `flock` locks the caller's open file description first;
 * on macOS the caller passes a descriptor from `openLockedDarwin`, which is
 * locked at open time. The guardian inherits the locked file description, so
 * parent death cannot release the fence while a client mutation or
 * descendant is still live.
 */
export async function acquireSetupGuardian(lockFd: number, timeoutMs: number, signal?: AbortSignal, validateFence?: () => Promise<void>): Promise<SetupGuardian> {
  const platform = await loadSetupPlatform();
  const platformName = platform.currentSetupPlatform();
  if (!platformName) throw new Error("platform_unsupported");
  const flockPath = platformName === "linux" ? ["/usr/bin/flock", "/bin/flock"].find((candidate) => platform.isTrustedSystemBinary(candidate)) : undefined;
  if (platformName === "linux" && !flockPath) throw new Error("ownership_lock_unavailable");
  const modulePath = fileURLToPath(import.meta.url);
  const guardianPath = fileURLToPath(new URL(modulePath.endsWith(".ts") ? "./setup-command-guardian.ts" : "./setup-command-guardian.js", import.meta.url));
  try { if (!lstatSync(guardianPath).isFile()) throw new Error("guardian_invalid"); }
  catch { throw new Error("ownership_lock_unavailable"); }
  if (flockPath) {
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
  }
```

Keep everything from `if (signal?.aborted) throw new Error("operation_aborted");`
(the current line 164) to the end of the file unchanged.

- [ ] **Step 5: Move the guardian onto the platform module**

In `src/setup-command-guardian.ts`:

- Replace line 3, `import { readdirSync, readFileSync } from "node:fs";`, with:

```ts
import type { ProcessTable } from "./setup-platform.js";

type SetupPlatformModule = typeof import("./setup-platform.js");
// Source-mode tests run this guardian through Node type stripping, which cannot
// map a static `./setup-platform.js` import to its `.ts` source.
const platform = await (import(import.meta.url.endsWith(".ts") ? "./setup-platform.ts" : "./setup-platform.js") as Promise<SetupPlatformModule>);
const platformName = platform.currentSetupPlatform();
const table: ProcessTable | undefined = platformName ? platform.createProcessTable(platformName) : undefined;
```

- After `const RETRY_MS = 25;`, add:

```ts
// Each macOS scan starts `ps`, so cleanup loops poll no faster than the table allows.
const CLEANUP_RETRY_MS = Math.max(RETRY_MS, table?.pollMs ?? RETRY_MS);
```

- Delete `readProcessGroup`, `processTableReadable` and the synchronous
  `groupState` (the current lines 70–113), and add:

```ts
async function groupState(group: number): Promise<GroupState> {
  if (forceUnknownForSourceTest || !table) return "unknown";
  return table.groupState(group);
}
```

- In `cleanup` and `terminateActive`, change `const state = groupState(execution.group);`
  to `const state = await groupState(execution.group);`. Change both
  `setTimeout(resolve, RETRY_MS)` calls inside those loops to
  `setTimeout(resolve, CLEANUP_RETRY_MS)`. `parentWatch` keeps `RETRY_MS`.
- Replace the `child.once("close", …)` handler in `start` with:

```ts
  child.once("close", (code) => {
    if (execution.cleanupStarted) return;
    void groupState(execution.group).then((state) => {
      if (execution.cleanupStarted) return;
      if (state === "gone") {
        finish(code ?? 1);
        active = undefined;
        if (shuttingDown || !process.connected) exitWhenSafe();
      } else void cleanup(code ?? 1);
    });
  });
```

- Replace the final readiness block (the current lines 223–228) with:

```ts
if (table && await table.readable()) send({ type: "ready" });
else {
  clearInterval(parentWatch);
  if (process.connected) process.disconnect();
  process.exitCode = 69;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/setup-release.test.ts test/setup-process.test.ts test/setup-ownership.test.ts test/setup-main.test.ts`
Expected: PASS on Linux, including the real guardian tests in
`setup-ownership.test.ts` and the stubborn-group signal tests in
`setup-main.test.ts`.

If a dynamic import of `./setup-platform.ts` fails under Vitest:
- Report the exact error.
- Do not switch to a static import.
- Do not change the specifier to a file URL without recording why.

- [ ] **Step 7: Run the quality gate and verify the built guardian**

Run: `npm run typecheck && npm test && npm run build && node -e "import('./dist/setup-platform.js').then(m=>console.log(typeof m.createProcessTable))"`
Expected: all exit 0, and the last command prints `function`.

- [ ] **Step 8: Commit**

```bash
git add src/setup-process.ts src/setup-command-guardian.ts src/setup.ts test/setup-release.test.ts test/setup-process.test.ts
git commit  # subject: "refactor: read the process table through the platform module", body per Global Constraints
```

---

### Task 3: Ownership store and setup entry on macOS

**Files:**
- Modify: `src/setup-ownership.ts` (lines 1–7 imports, `withLock` lines 62–96, lines 128–175)
- Modify: `src/setup-main.ts:20`
- Test: `test/setup-ownership.test.ts`, `test/setup-main.test.ts`

**Interfaces:**
- Consumes from Task 1: `currentSetupPlatform`, `assertSupportedFilesystem`,
  `openLockedDarwin`, `SetupPlatform`.
- Consumes from Task 2: `acquireSetupGuardian`. On macOS it requires a
  descriptor that is already locked.
- Produces: the unchanged `DurableOwnershipStore` API. On macOS it locks at
  open time and maps the outcomes as follows:
  - `ownership_lock_busy` and `operation_aborted` propagate unchanged;
  - every other lock failure becomes `ownership_lock_unavailable`.

- [ ] **Step 1: Write the failing tests**

In `test/setup-main.test.ts`, replace the test `it.each(["win32", "darwin"] as const)("fails closed on %s …`
so that it reads `it.each(["win32", "freebsd"] as const)`; keep its body
unchanged. Then add after it:

```ts
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
```

In `test/setup-ownership.test.ts`:
- Add `symlink` to the `node:fs/promises` import.
- Add `vi` to the vitest import.
- Add these tests inside the existing `describe` block, after "rejects a lock
  inode replaced while acquisition is waiting":

```ts
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
```

Add a second `describe` at the end of the file. It is not skipped on any
platform:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/setup-main.test.ts test/setup-ownership.test.ts`
Expected:
- "accepts darwin as a setup platform" FAILS: the result is `platform_unsupported`
  with exit code 1.
- The three new ownership tests PASS on Linux already. They are regression
  pins that must keep passing, and they run on macOS after Task 4.
- The platform-gate test PASSES.

- [ ] **Step 3: Accept darwin in the setup entry point**

In `src/setup-main.ts`, add `import { currentSetupPlatform } from "./setup-platform.js";`
after the `./setup-process.js` import. Replace

```ts
  if (process.platform !== "linux") return write(cliFailure(operation, request.targets, "platform_unsupported", 1), request.json);
```

with

```ts
  if (!currentSetupPlatform()) return write(cliFailure(operation, request.targets, "platform_unsupported", 1), request.json);
```

- [ ] **Step 4: Lock and check the filesystem through the platform module**

In `src/setup-ownership.ts`:

- Change the second import line to
  `import { chmod, lstat, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";`
  (`statfs` is no longer used here).
- Add after the `./setup-process.js` import:

```ts
import { assertSupportedFilesystem, currentSetupPlatform, openLockedDarwin, type SetupPlatform } from "./setup-platform.js";
```

- In `withLock`, replace the first three lines:

```ts
    if (process.platform !== "linux") throw new Error("platform_unsupported");
    const directory = dirname(this.path);
    await ensureOwnershipDirectory(directory);
```

with

```ts
    const platform = currentSetupPlatform();
    if (!platform) throw new Error("platform_unsupported");
    const directory = dirname(this.path);
    await ensureOwnershipDirectory(directory, platform);
```

- Replace the block from `const lockPath = \`${this.path}.flock\`;` through
  the `catch` that throws `ownership_lock_unavailable` (the current lines
  73–84) with:

```ts
    const lockPath = `${this.path}.flock`;
    const acquireTimeoutMs = this.options.acquireTimeoutMs ?? 30_000;
    let lockHandle;
    try {
      // macOS takes the kernel lock at open time; on Linux the trusted flock
      // locks this same open file description in acquireSetupGuardian.
      lockHandle = platform === "darwin"
        ? await openLockedDarwin(lockPath, { timeoutMs: acquireTimeoutMs, signal: controller.signal })
        : await open(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      await lockHandle.chmod(0o600);
      await lockHandle.sync();
      await syncDirectory(directory);
      const [descriptor, linked] = await Promise.all([lockHandle.stat(), stat(lockPath)]);
      if (!descriptor.isFile() || !linked.isFile() || descriptor.dev !== linked.dev || descriptor.ino !== linked.ino) throw new Error("ownership_lock_invalid");
      await this.options.afterLockOpen?.();
    }
    catch (error) {
      this.options.signal?.removeEventListener("abort", abort);
      await lockHandle?.close().catch(() => undefined);
      const code = (error as Error).message;
      throw new Error(["ownership_lock_busy", "operation_aborted"].includes(code) ? code : "ownership_lock_unavailable");
    }
```

- In the following `acquireSetupGuardian(...)` call, replace
  `this.options.acquireTimeoutMs ?? 30_000` with `acquireTimeoutMs`.
- Delete `SUPPORTED_LOCAL_FILESYSTEMS`, its comment, and the local
  `assertSupportedFilesystem` function (the current lines 128–140 and
  172–175).
- Change `async function ensureOwnershipDirectory(directory: string): Promise<void> {`
  to `async function ensureOwnershipDirectory(directory: string, platform: SetupPlatform): Promise<void> {`.
  Change both calls inside it, `await assertSupportedFilesystem(cursor);` and
  `await assertSupportedFilesystem(directory);`, to pass `platform` as the
  second argument.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/setup-main.test.ts test/setup-ownership.test.ts test/setup-lifecycle.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the quality gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: all exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/setup-ownership.ts src/setup-main.ts test/setup-ownership.test.ts test/setup-main.test.ts
git commit  # subject: "feat: take the setup lock and filesystem rule on macOS", body per Global Constraints
```

---

### Task 4: Platform-neutral process fixture, runner and lifecycle tests

**Files:**
- Modify: `test/process-fixture.ts`
- Modify: `test/setup-process.test.ts` (split the `describe` at line 32)
- Modify: `test/setup-lifecycle.test.ts:36`

**Interfaces:**
- Consumes from Task 1: `currentSetupPlatform`.
- Produces new test-fixture exports:
  - `processInspectionSupported: boolean`
  - `processState(pid: number): Promise<string | undefined>`: the first state
    letter, or undefined when the process is gone;
  - `processCommandLine(pid: number): Promise<string | undefined>`
  - `isLockHeld(path: string): boolean`
  - `expectProcessTerminated(pid, readText?)` and
    `waitForProcessTerminated(pid, readText?, timeoutMs?)`: without an injected
    reader they use `ps` on macOS; with an injected reader they keep the Linux
    `/proc` text logic.

- [ ] **Step 1: Add the platform helpers to `test/process-fixture.ts`**

Replace the import lines with:

```ts
import { execFile, spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, openSync, readSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { expect } from "vitest";
```

Add after the `ZOMBIE_STAT` constant:

```ts
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
```

Replace `expectProcessTerminated` with:

```ts
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
```

Replace the signature and first two lines of `waitForProcessTerminated` with
the following. The existing `/proc` loop stays below it unchanged, except
that `readText` becomes `reader`:

```ts
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
```

In the remaining loop, change `readTextIfPresent(\`/proc/${pid}/stat\`, readText)`
to `readTextIfPresent(\`/proc/${pid}/stat\`, reader)`.

- [ ] **Step 2: Split `test/setup-process.test.ts` by platform**

- Add the imports
  `import { currentSetupPlatform } from "../src/setup-platform.js";` and
  `processState` (from `./process-fixture.js`).
- Change line 32 to
  `describe.skipIf(!currentSetupPlatform())("setup process runner", () => {`.
- In "rejects a real living descendant in the shared termination assertion",
  replace

  ```ts
      expect(await readFile(`/proc/${pid}/stat`, "utf8")).not.toMatch(/^\d+ \(.*\) Z /);
  ```

  with

  ```ts
      const state = await processState(pid);
      expect(state).toBeDefined();
      expect(state).not.toBe("Z");
  ```

- Close this `describe` after that test with `});`.
- Open `describe.skipIf(process.platform !== "linux")("Linux /proc fixture", () => {`
  before "preserves one complete kernel stat sample through actual owned
  reaping". Everything from that test down to "rejects %s during cleanup
  polling" stays in this Linux block.
- Move "cleans a living fixture even when another cleanup step rejects" into
  the "setup process runner" block. It has no `/proc` dependency.

- [ ] **Step 3: Run the lifecycle store test on every setup platform**

In `test/setup-lifecycle.test.ts`:
- Add `import { currentSetupPlatform } from "../src/setup-platform.js";`.
- Change `it.skipIf(process.platform !== "linux")` (line 36) to
  `it.skipIf(!currentSetupPlatform())`.

- [ ] **Step 4: Run the affected tests**

Run: `npx vitest run test/setup-process.test.ts test/setup-lifecycle.test.ts test/setup-ownership.test.ts test/setup-main.test.ts`
Expected: PASS on Linux with the same number of executed tests as before,
plus the tests added in Tasks 2–3.

- [ ] **Step 5: Run the quality gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add test/process-fixture.ts test/setup-process.test.ts test/setup-lifecycle.test.ts
git commit  # subject: "test: inspect processes with ps on macOS in the setup fixtures", body per Global Constraints
```

---

### Task 5: Ownership and signal integration tests on macOS

**Files:**
- Modify: `test/setup-ownership.test.ts`
- Modify: `test/setup-main.test.ts` (the two signal tests, lines 63–198)

**Interfaces:**
- Consumes from Task 1: `currentSetupPlatform`, `openLockedDarwin` (by URL,
  in raw-Node harnesses).
- Consumes from Task 4: `processState`, `isLockHeld`.

- [ ] **Step 1: Add shared harness helpers to `test/setup-ownership.test.ts`**

- Add `import { currentSetupPlatform } from "../src/setup-platform.js";`.
- Add `isLockHeld` and `processState` to the `./process-fixture.js` import.
- Remove `spawnSync` and `existsSync` once they are unused.
- After `afterAll(removeTemporaryRoots);`, add:

```ts
const processModuleUrl = pathToFileURL(resolve("src/setup-process.ts")).href;
const platformModuleUrl = pathToFileURL(resolve("src/setup-platform.ts")).href;

/**
 * A raw-Node harness that holds the fence through a real guardian. macOS locks
 * at open time; Linux locks the same open file description through flock.
 */
function guardianHarness(lockPath: string, body: readonly string[]): string {
  return [
    "import { constants } from 'node:fs'; import { open } from 'node:fs/promises'; const fs=await import('node:fs');",
    `import { acquireSetupGuardian } from ${JSON.stringify(processModuleUrl)};`,
    `import { openLockedDarwin } from ${JSON.stringify(platformModuleUrl)};`,
    `const handle=process.platform==='darwin'?await openLockedDarwin(${JSON.stringify(lockPath)},{timeoutMs:5000}):await open(${JSON.stringify(lockPath)},constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW,0o600);`,
    "const guardian=await acquireSetupGuardian(handle.fd,5000);",
    ...body,
  ].join("\n");
}

/** A mutation-side statement that records its parent, the guardian, in `marker`. */
function recordGuardian(marker: string): string {
  return `fs.writeFileSync(${JSON.stringify(`${marker}.tmp`)},String(process.ppid));fs.renameSync(${JSON.stringify(`${marker}.tmp`)},${JSON.stringify(marker)});`;
}
```

- Change the suite gate to
  `describe.skipIf(!currentSetupPlatform())("durable setup ownership", () => {`.
- In "persists only bounded path-free ownership data with restrictive modes",
  extend the regex to `/PI_SESSION_MCP_CONFIG|\/home\/|\/Users\/|\/private\/|\.\.\/|SECRET/`.

- [ ] **Step 2: Make the lock-wait tests platform-aware**

In "holds one lock across the full ownership transaction", replace

```ts
      await Promise.race([secondLockOpened, observed]);
      // The second descriptor is open while the first transaction still holds its gate.
      const flockPath = existsSync("/usr/bin/flock") ? "/usr/bin/flock" : "/bin/flock";
      expect(spawnSync(flockPath, ["-n", `${path}.flock`, "/bin/true"], { stdio: "ignore" }).status).toBe(1);
```

with

```ts
      if (process.platform === "darwin") {
        // macOS takes the lock at open time, so the waiting store has no descriptor yet.
        let settled = false;
        void observed.then(() => { settled = true; }, () => { settled = true; });
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
        expect(settled).toBe(false);
      } else {
        // The second descriptor is open while the first transaction still holds its gate.
        await Promise.race([secondLockOpened, observed]);
      }
      expect(isLockHeld(`${path}.flock`)).toBe(true);
```

Change "rejects a lock inode replaced while acquisition is waiting" to
`it.skipIf(process.platform !== "linux")(…)`. Add this comment directly above
it:

```ts
  // Only Linux has a descriptor while it waits; macOS waits before open. The
  // replaced-after-open case below covers both platforms.
```

- [ ] **Step 3: Rewrite the three guardian harness tests**

In "keeps the kernel fence through parent SIGKILL until guardian cleanup":

- Delete the `moduleUrl` line.
- Prefix `mutation` with the guardian record, so its first two elements are:

```ts
      "const {spawn}=require('node:child_process'); const fs=require('node:fs');",
      recordGuardian(guardianMarker),
```

- Replace the `harness` definition with:

```ts
    const harness = guardianHarness(`${path}.flock`, [
      `const output=await guardian.runner.run(process.execPath,['-e',${JSON.stringify(mutation)}]);process.exitCode=output.exitCode;`,
    ]);
```

- Replace the guardian-stopped loop body with:

```ts
        guardianStopped = (await processState(guardianPid)) === "T";
```

- Replace the `helperStat`, `flockPath` and `competing` lines with:

```ts
        expect(await processState(helperPid)).not.toBe("Z");
        expect(await processState(helperPid)).toBeDefined();
        expect(isLockHeld(`${path}.flock`)).toBe(true);
```

In "retains the fence after indeterminate cleanup reports exit 126":

- Delete the `moduleUrl` line.
- Insert `${recordGuardian(guardianMarker)}` into `mutation` directly after
  `process.on('SIGTERM',()=>{});`.
- Replace the `harness` definition with:

```ts
    const harness = guardianHarness(`${path}.flock`, [
      "const controller=new AbortController(); process.on('SIGTERM',()=>controller.abort());",
      `const output=await guardian.runner.run(process.execPath,['-e',${JSON.stringify(mutation)}],controller.signal);`,
      `fs.writeFileSync(${JSON.stringify(`${resultMarker}.tmp`)},String(output.exitCode)); fs.renameSync(${JSON.stringify(`${resultMarker}.tmp`)},${JSON.stringify(resultMarker)}); await guardian.release(); await handle.close();`,
    ]);
```

- Replace the `flockPath` line and the `spawnSync` assertion with
  `expect(isLockHeld(\`${path}.flock\`)).toBe(true);`.

In "lets the guardian clean its detached command with a %s mutation marker":

- Delete the `moduleUrl` line.
- Insert `${recordGuardian(guardianMarker)}` into `mutation` directly after
  `process.on('SIGTERM',()=>{});`.
- Replace the `harness` definition with:

```ts
    const harness = guardianHarness(lockPath, [
      `await guardian.runner.run(process.execPath,['-e',${JSON.stringify(mutation)}]);`,
    ]);
```

- [ ] **Step 4: Run the signal tests on macOS too**

In `test/setup-main.test.ts`:

- Add `import { currentSetupPlatform } from "../src/setup-platform.js";`.
- Add `isLockHeld` and `processState` to the `./process-fixture.js` import.
- Remove the now-unused `spawnSync`, `existsSync`, `readFile` and
  `readTextIfPresent` imports.
- Change both `it.skipIf(process.platform !== "linux").each(` to
  `it.skipIf(!currentSetupPlatform()).each(`.
- In "holds the fence while $signal cleans a stubborn real process group":
  - Rename `let competingStatus: number | null | undefined;` to
    `let lockWasHeld: boolean | undefined;`.
  - Replace the observation block, from the `stoppedDeadline` loop through
    `helperStayedLive = …`, with:

```ts
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
```

  - Replace `expect(competingStatus).toBe(1);` with `expect(lockWasHeld).toBe(true);`.

- [ ] **Step 5: Run the affected tests**

Run: `npx vitest run test/setup-ownership.test.ts test/setup-main.test.ts`
Expected: PASS on Linux, with no test newly skipped on Linux.

- [ ] **Step 6: Run the quality gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: all exit 0.

- [ ] **Step 7: Commit**

```bash
git add test/setup-ownership.test.ts test/setup-main.test.ts
git commit  # subject: "test: run the setup fence integration tests on macOS", body per Global Constraints
```

---

### Task 6: Server stdin-EOF lifecycle on macOS

**Files:**
- Modify: `test/process-stdin-eof.test.ts` (lines 24, 38–39, 88–93, 197, 259)

**Interfaces:**
- Consumes from Task 4: `processInspectionSupported`, `processCommandLine`,
  and the platform-aware `waitForProcessTerminated`.

- [ ] **Step 1: Change the gate and the command-line probe**

- Add `processCommandLine` and `processInspectionSupported` to the
  `./process-fixture.js` import.
- Remove `readTextIfPresent` from it if it becomes unused.
- Replace lines 38–39 with:

```ts
/** Termination checks use `/proc` on Linux and `ps` on macOS, as in the other process-level tests. */
const describeWithProcessInspection = describe.skipIf(!processInspectionSupported);
```

- Rename both uses of `describeOnLinux(` (lines 197 and 259) to
  `describeWithProcessInspection(`.
- In `stopFixtureChild`, replace
  `try { commandLine = await readTextIfPresent(\`/proc/${pid}/cmdline\`); }`
  with `try { commandLine = await processCommandLine(pid); }`.

- [ ] **Step 2: Run the tests**

Run: `npx vitest run test/process-stdin-eof.test.ts`
Expected: PASS on Linux with the same test count as before.

- [ ] **Step 3: Run the quality gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: all exit 0.

- [ ] **Step 4: Commit**

```bash
git add test/process-stdin-eof.test.ts
git commit  # subject: "test: check the server's stdin-EOF exit on macOS", body per Global Constraints
```

---

### Task 7: CI on Linux and macOS

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:** The ruleset "Protect main" requires a status check named
exactly `verify`. The matrix job is therefore named `test`, and a job named
`verify` aggregates it.

- [ ] **Step 1: Replace the `jobs:` section**

```yaml
jobs:
  test:
    name: test (${{ matrix.os }})
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-15, macos-26]
    runs-on: ${{ matrix.os }}
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22.19.0
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm run build:cli
      - run: npm test
      - run: npm run build

  # The "Protect main" ruleset requires a check named "verify"; it passes only
  # when every platform in the matrix passed.
  verify:
    needs: test
    if: always()
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - env:
          RESULT: ${{ needs.test.result }}
        run: test "$RESULT" = success
```

- [ ] **Step 2: Validate the YAML locally**

Run: `node -e "const t=require('node:fs').readFileSync('.github/workflows/ci.yml','utf8'); if(!/needs: test/.test(t)||!/macos-26/.test(t)) process.exit(1)"`
Expected: exit 0.

If `actionlint` is installed, also run `actionlint .github/workflows/ci.yml`.
Expected: no findings.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit  # subject: "ci: test on macOS 15 and 26 next to Linux", body per Global Constraints
```

---

### Task 8: Documentation, ADR 0005 and the agent rule

**Files:**
- Create: `docs/adr/0005-macos-setup-platform.md`
- Modify:
  - `AGENTS.md` (lines 18–23);
  - `README.md` (Status section);
  - `docs/installation.md` (Requirements, "Register without setup");
  - `docs/client-setup-design.md` (platform paragraph and ownership paragraphs);
  - `docs/threat-model.md` ("Concurrent setup corruption", "Unsupported
    process-group guarantees");
  - `docs/acceptance.md` (Level 2: a macOS section);
  - `docs/macos-setup-design.md` (status line);
  - `CHANGELOG.md` (Unreleased).

**Interfaces:** Documentation only. Every statement must match the code from
Tasks 1–7 and must not claim acceptance on real hardware.

The session owner writes this task, not an implementer subagent, because the
wording is judgment-heavy and must match the verified code and evidence.

- [ ] **Step 1: Write ADR 0005**

Create `docs/adr/0005-macos-setup-platform.md` in the style of ADR 0004:

- **Status:** Accepted (date of the commit).
- **Context:**
  - #28 hit the ADR 0003 trigger "repeated setup friction beyond version
    drift";
  - the macOS facts from the design (no `flock(1)`, no `/proc`, dynamic
    `f_type`).
- **Decision:** approach A as implemented. Name the module, the three
  primitives, the unchanged public codes, the `verify` aggregator check, and
  the condition that macOS counts as accepted only after Level-2 evidence
  from real hardware.
- **Rejected alternatives:**
  - a `lockf(1)` helper with `/sbin/mount` parsing, because the fd mode on
    macOS 15 and the `mount` format are unverified;
  - a weaker macOS profile, because it breaks the fence guarantee.
- **Revisit triggers:**
  - the `ps` output format changes;
  - the `O_EXLOCK` semantics change;
  - the minimum macOS version supported by Node.js changes;
  - a request for Intel Macs in CI or for another platform.

- [ ] **Step 2: Update the agent rule**

In `AGENTS.md`, replace the bullet that starts "Mutating setup is Linux-only"
(through "An indeterminate scan retains the fence.") with:

```markdown
- Mutating setup runs on Linux and macOS only. Linux requires a supported
  local-filesystem kernel `flock`, a trusted fixed util-linux binary, and
  readable `/proc`; macOS requires an `O_EXLOCK` lock on the APFS volume type
  of `/` and the trusted system `/bin/ps`. On both, keep the stable lock inode
  and guardian-held fence until a determinate process-table scan confirms no
  non-zombie mutating client process-group member remains. A zombie is
  terminated and holds no file descriptors; this is a termination guarantee,
  not a PID-reaping guarantee. An indeterminate scan retains the fence.
```

- [ ] **Step 3: Update README, installation guide and CHANGELOG**

- **README Status:** replace the "Linux only" bullet with:
  - **Linux and macOS**, Node.js 22.19.0 or newer.
  - macOS is CI-tested on macOS 15 and 26 (Apple silicon). Intel Macs are
    expected to work but are untested. Level-2 setup acceptance on macOS is
    pending until the evidence is recorded in
    [Acceptance](docs/acceptance.md).
  - Other platforms refuse with `platform_unsupported`.
- **`docs/installation.md` Requirements:**
  - Linux or macOS;
  - the ownership directory `~/.local/state/pi-session-mcp/` must be on a
    supported local filesystem: on macOS the APFS volume type of `/`, so an
    external exFAT/HFS+ or network home fails closed;
  - the server and `setup` work on both.
- **`docs/installation.md` "Register without setup":** remove the macOS
  special case. The section stays as the general alternative for clients or
  environments without `setup`, and it keeps the statement that its checks
  are weaker than `--verify`.
- **`CHANGELOG.md` Unreleased:** add a first bullet. It says that `setup` now
  supports macOS with the same fence; it names `O_EXLOCK`, `/bin/ps` and the
  APFS rule; it says that public codes, statuses and exit codes are unchanged
  and that CI runs on Linux, macOS 15 and macOS 26. Reword the existing
  macOS bullet so that it no longer says macOS support is planned.

- [ ] **Step 4: Update design, threat model and acceptance**

- **`docs/client-setup-design.md`:**
  - the platform paragraph names both platforms and their requirements;
  - the ownership paragraphs say "a kernel lock (util-linux `flock` on Linux,
    `O_EXLOCK` at open on macOS)" and "a determinate process-table scan
    (`/proc` on Linux, `/bin/ps` on macOS)".
- **`docs/threat-model.md`:**
  - the same substitutions in "Concurrent setup corruption";
  - the macOS filesystem rule;
  - "Unsupported process-group guarantees" becomes: every platform other
    than Linux and macOS fails closed before client spawn.
- **`docs/acceptance.md` Level 2:** add a subsection "macOS". It contains the
  checklist from the design's "Acceptance on real hardware", with the
  corrected lock-contention expectation, and the evidence format: versions,
  exit codes, sanitized human and JSON results, and no paths.
- **`docs/macos-setup-design.md`:** status becomes "Implemented; Level-2
  acceptance on real hardware pending".

- [ ] **Step 5: Check the documentation for stale statements**

Run: `grep -rn "Linux only\|Linux-only\|macOS support is planned\|non-Linux" README.md AGENTS.md docs CHANGELOG.md`
Expected: no hits, except inside `CHANGELOG.md` history for released
versions and inside ADR 0003, which records history.

- [ ] **Step 6: Run the quality gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: all exit 0.

- [ ] **Step 7: Commit**

```bash
git add AGENTS.md README.md CHANGELOG.md docs/adr/0005-macos-setup-platform.md docs/installation.md docs/client-setup-design.md docs/threat-model.md docs/acceptance.md docs/macos-setup-design.md
git commit  # subject: "docs: support the setup lifecycle on macOS", body per Global Constraints
```

---

### After the tasks: delivery and evidence

These steps are not for implementer subagents; the session owner runs them.

1. **Whole-branch review** by the `reviewer` agent, plus a Codex review.
   Address the findings in follow-up commits.
2. **Ask the owner** before the first push. Then push `feat/macos-setup` and
   open one PR that references #32 and calls out the `AGENTS.md` rule change.
3. **Watch CI** on all three runners. Fix macOS-only failures in focused
   commits. Do not push while a CI run is still in progress unless it is
   necessary.
4. **The owner runs the Level-2 macOS checklist** on a Mac against the PR
   branch build. The evidence is committed to the PR before merge.

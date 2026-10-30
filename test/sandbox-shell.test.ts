import { EventEmitter } from "node:events";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  BWRAP_PATH, SYSTEMD_RUN_PATH, SANDBOX_LIMITS, SANDBOX_UNAVAILABLE_MESSAGE, scopeArgs, createSandboxedBashOperations, DEFAULT_COMMAND_TIMEOUT_SECONDS, PROBE_TIMEOUT_MS,
  endScope, probeSandbox, resolveWorktreeGitDir, sandboxArgs, validatedRuntimeDir, verifyScope, type RootEntry, type SandboxChild, type SandboxDependencies, type SandboxSpawn,
} from "../src/sandbox-shell.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

const MERGED: RootEntry[] = [
  { path: "/bin", kind: "symlink", target: "usr/bin" }, { path: "/lib", kind: "symlink", target: "usr/lib" },
  { path: "/lib64", kind: "symlink", target: "usr/lib" }, { path: "/sbin", kind: "symlink", target: "usr/bin" },
];
const SPLIT: RootEntry[] = [{ path: "/bin", kind: "directory" }, { path: "/lib", kind: "directory" }, { path: "/lib64", kind: "directory" }];

const FIXED_HEAD = [
  "--unshare-all", "--unshare-user", "--disable-userns", "--die-with-parent", "--new-session", "--clearenv",
  "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin", "--setenv", "HOME", "/tmp/home", "--ro-bind", "/usr", "/usr",
];
const FIXED_MIDDLE = ["--ro-bind", "/etc", "/etc", "--dev", "/dev", "--proc", "/proc", "--size", "536870912", "--tmpfs", "/tmp", "--dir", "/tmp/home"];

describe("scopeArgs", () => {
  it("wraps bubblewrap in the fixed limited scope", () => {
    expect(scopeArgs("unit", SANDBOX_LIMITS, ["arg"], 600)).toEqual([
      "--user", "--scope", "--quiet", "--collect", "--unit=unit", "--description=pi-session-mcp sandboxed shell",
      "-p", "MemoryMax=1073741824", "-p", "MemorySwapMax=0", "-p", "TasksMax=128", "-p", "RuntimeMaxSec=630",
      "--", BWRAP_PATH, "--info-fd", "3", "--block-fd", "4", "arg",
    ]);
  });

  it("rounds a fractional deadline up", () => {
    expect(scopeArgs("unit", SANDBOX_LIMITS, [], 0.05)).toContain("RuntimeMaxSec=31");
  });
});

describe("sandboxArgs", () => {
  it("produces the fixed argument list for a merged-/usr host", () => {
    expect(sandboxArgs({ workspace: "/w/ws", cwd: "/w/ws/src", rootEntries: MERGED, argv: ["/usr/bin/bash", "-c", "git log"] })).toEqual([
      ...FIXED_HEAD,
      "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib", "/lib64", "--symlink", "usr/bin", "/sbin",
      ...FIXED_MIDDLE,
      "--overlay-src", "/w/ws", "--tmp-overlay", "/w/ws",
      "--chdir", "/w/ws/src", "--", "/usr/bin/bash", "-c", "git log",
    ]);
  });

  it("binds the root directories read-only on a host without merged /usr and skips absent ones", () => {
    const args = sandboxArgs({ workspace: "/w/ws", cwd: "/w/ws", rootEntries: SPLIT, argv: ["/usr/bin/true"] });
    expect(args).toEqual([
      ...FIXED_HEAD,
      "--ro-bind", "/bin", "/bin", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64",
      ...FIXED_MIDDLE,
      "--overlay-src", "/w/ws", "--tmp-overlay", "/w/ws",
      "--chdir", "/w/ws", "--", "/usr/bin/true",
    ]);
    expect(args).not.toContain("/sbin");
  });

  it("adds the Git common directory as a second temporary overlay", () => {
    const args = sandboxArgs({ workspace: "/w/ws", gitCommonDir: "/w/main/.git", cwd: "/w/ws", rootEntries: MERGED, argv: ["/usr/bin/bash", "-c", "x"] });
    const overlay = args.indexOf("--overlay-src");
    expect(args.slice(overlay)).toEqual([
      "--overlay-src", "/w/ws", "--tmp-overlay", "/w/ws",
      "--overlay-src", "/w/main/.git", "--tmp-overlay", "/w/main/.git",
      "--chdir", "/w/ws", "--", "/usr/bin/bash", "-c", "x",
    ]);
  });

  it("never binds the operator's home or the workspace read-write", () => {
    const args = sandboxArgs({ workspace: "/w/ws", cwd: "/w/ws", rootEntries: MERGED, argv: ["/usr/bin/true"] });
    expect(args).not.toContain("--bind");
    expect(args).not.toContain("--share-net");
    expect(args.filter((arg) => arg === "--ro-bind")).toHaveLength(2);
  });

  it("keeps a command that looks like an option after the separator", () => {
    const args = sandboxArgs({ workspace: "/w/ws", cwd: "/w/ws", rootEntries: [], argv: ["/usr/bin/bash", "-c", "--bind / /"] });
    expect(args.slice(args.indexOf("--") + 1)).toEqual(["/usr/bin/bash", "-c", "--bind / /"]);
  });
});

describe("resolveWorktreeGitDir", () => {
  let root: string;
  let counter = 0;

  beforeAll(async () => { root = await temporaryRoot("sandbox-gitdir-"); });

  /** A main repository with one linked worktree, written the way `git worktree add` leaves them. */
  async function layout(options: { objects?: boolean; refs?: boolean; head?: boolean; backPointer?: string | false; commondir?: string | false; gitdirLine?: (gitdir: string) => string } = {}) {
    const base = join(root, `case-${counter++}`);
    const common = join(base, "main", ".git");
    const gitdir = join(common, "worktrees", "wt");
    const workspace = join(base, "wt");
    await mkdir(gitdir, { recursive: true });
    await mkdir(workspace, { recursive: true });
    if (options.head !== false) await writeFile(join(common, "HEAD"), "ref: refs/heads/main\n");
    if (options.objects !== false) await mkdir(join(common, "objects"));
    if (options.refs !== false) await mkdir(join(common, "refs"));
    if (options.backPointer !== false) await writeFile(join(gitdir, "gitdir"), `${options.backPointer ?? join(workspace, ".git")}\n`);
    if (options.commondir !== false) await writeFile(join(gitdir, "commondir"), `${options.commondir ?? "../.."}\n`);
    await writeFile(join(workspace, ".git"), `${(options.gitdirLine ?? ((value) => `gitdir: ${value}`))(gitdir)}\n`);
    return { base, common, gitdir, workspace };
  }

  it("accepts a linked worktree whose pointers agree", async () => {
    const { common, workspace } = await layout();
    await expect(resolveWorktreeGitDir(workspace)).resolves.toBe(common);
  });

  it("accepts a relative gitdir path and an absolute commondir", async () => {
    const relative = await layout({ gitdirLine: () => "gitdir: ../main/.git/worktrees/wt" });
    await expect(resolveWorktreeGitDir(relative.workspace)).resolves.toBe(relative.common);
    const absolute = await layout();
    await writeFile(join(absolute.gitdir, "commondir"), `${absolute.common}\n`);
    await expect(resolveWorktreeGitDir(absolute.workspace)).resolves.toBe(absolute.common);
  });

  it("returns nothing for a plain repository, a missing .git and unreadable content", async () => {
    const plain = join(root, "plain");
    await mkdir(join(plain, ".git"), { recursive: true });
    await expect(resolveWorktreeGitDir(plain)).resolves.toBeUndefined();
    const none = join(root, "none");
    await mkdir(none);
    await expect(resolveWorktreeGitDir(none)).resolves.toBeUndefined();
    await expect(resolveWorktreeGitDir(join(root, "missing"))).resolves.toBeUndefined();
    const garbage = await layout({ gitdirLine: () => "not a pointer" });
    await expect(resolveWorktreeGitDir(garbage.workspace)).resolves.toBeUndefined();
    const huge = await layout();
    await writeFile(join(huge.workspace, ".git"), `gitdir: ${"a".repeat(10_000)}\n`);
    await expect(resolveWorktreeGitDir(huge.workspace)).resolves.toBeUndefined();
  });

  it("rejects a .git symlink", async () => {
    const { workspace, base } = await layout();
    const linked = join(base, "linked");
    await mkdir(linked);
    await symlink(join(workspace, ".git"), join(linked, ".git"));
    await expect(resolveWorktreeGitDir(linked)).resolves.toBeUndefined();
  });

  it("rejects a missing or wrong back-pointer", async () => {
    const missing = await layout({ backPointer: false });
    await expect(resolveWorktreeGitDir(missing.workspace)).resolves.toBeUndefined();
    const wrong = await layout({ backPointer: "/somewhere/else/.git" });
    await expect(resolveWorktreeGitDir(wrong.workspace)).resolves.toBeUndefined();
  });

  it("rejects a gitdir that is not <common>/worktrees/<name>", async () => {
    const home = await layout();
    const fakeHome = join(home.base, "fake-home");
    await mkdir(fakeHome);
    await writeFile(join(home.workspace, ".git"), `gitdir: ${fakeHome}\n`);
    await expect(resolveWorktreeGitDir(home.workspace)).resolves.toBeUndefined();
    // A directory that mimics the files but does not sit below `worktrees`.
    const off = await layout();
    const shape = join(off.base, "elsewhere", "wt");
    await mkdir(shape, { recursive: true });
    await writeFile(join(shape, "gitdir"), `${join(off.workspace, ".git")}\n`);
    await writeFile(join(shape, "commondir"), "..\n");
    await writeFile(join(off.workspace, ".git"), `gitdir: ${shape}\n`);
    await expect(resolveWorktreeGitDir(off.workspace)).resolves.toBeUndefined();
  });

  it("rejects a commondir that does not resolve to the parent of worktrees", async () => {
    const wrong = await layout({ commondir: "../../.." });
    await expect(resolveWorktreeGitDir(wrong.workspace)).resolves.toBeUndefined();
    const missing = await layout({ commondir: false });
    await expect(resolveWorktreeGitDir(missing.workspace)).resolves.toBeUndefined();
  });

  it.each([{ head: false }, { objects: false }, { refs: false }])("rejects a common directory that lacks parts: %j", async (options) => {
    const { workspace } = await layout(options);
    await expect(resolveWorktreeGitDir(workspace)).resolves.toBeUndefined();
  });
});

/** A scripted child process: output and termination are driven by the test. */
const SCOPE = "/user.slice/app.slice/test-unit.scope";

/** A consistent limited scope for pids 4241 and 4242; `changes` replaces single files, an Error value makes a read fail. */
function scopeFiles(changes: Record<string, string | Error> = {}): (path: string) => Promise<string> {
  const files: Record<string, string | Error> = {
    "/proc/self/mounts": "proc /proc proc rw 0 0\ncgroup2 /sys/fs/cgroup cgroup2 rw,nosuid 0 0\n",
    "/proc/self/cgroup": "0::/user.slice/server.scope\n",
    "/proc/4241/cgroup": `0::${SCOPE}\n`,
    "/proc/4242/cgroup": `0::${SCOPE}\n`,
    [`/sys/fs/cgroup${SCOPE}/memory.max`]: `${SANDBOX_LIMITS.memoryBytes}\n`,
    [`/sys/fs/cgroup${SCOPE}/memory.swap.max`]: "0\n",
    [`/sys/fs/cgroup${SCOPE}/pids.max`]: `${SANDBOX_LIMITS.tasks}\n`,
    ...changes,
  };
  return async (path) => {
    const value = files[path];
    if (value === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    if (value instanceof Error) throw value;
    return value;
  };
}

function fakeChild() {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const info = new PassThrough();
  const block = new PassThrough();
  const released: string[] = [];
  // The order of kill and the block fd's close: closing fd 4 first would release bubblewrap.
  const events: string[] = [];
  block.on("data", (chunk) => released.push(chunk.toString()));
  // Record the close where the server asks for it: the stream's own close event comes a tick later.
  const destroy = block.destroy.bind(block);
  block.destroy = (error?: Error) => { events.push("block-closed"); return destroy(error); };
  const kill = vi.fn(() => { events.push("kill"); });
  const child = Object.assign(emitter, { pid: 4241, stdio: [null, stdout, stderr, info, block], stdout, stderr, kill }) as unknown as SandboxChild;
  return {
    child, kill, stdout, stderr, info, block, released, events,
    close: (code: number | null, signal: NodeJS.Signals | null = null) => { stdout.end(); stderr.end(); setImmediate(() => emitter.emit("close", code, signal)); },
    fail: () => emitter.emit("error", new Error("spawn failed")),
  };
}

type Fake = ReturnType<typeof fakeChild>;

/** `info` is what bubblewrap writes to fd 3: a string, `null` for end of file, or `false` for nothing at all. */
function harness(overrides: Partial<SandboxDependencies> = {}, info: string | null | false = '{"child-pid":4242}') {
  const children: Fake[] = [];
  const calls: { file: string; args: readonly string[]; options: unknown }[] = [];
  const spawn: SandboxSpawn = (file, args, options) => {
    calls.push({ file, args, options });
    const fake = fakeChild();
    children.push(fake);
    queueMicrotask(() => { if (info === null) fake.info.end(); else if (info !== false) fake.info.write(info); });
    return fake.child;
  };
  const dependencies: SandboxDependencies = {
    spawn, trusted: () => true, rootEntries: () => MERGED, gitCommonDir: async () => undefined,
    runtimeDir: () => "/run/user/test", unitName: () => "test-unit",
    endScope: (pids) => { children.at(-1)?.events.push(`scope:${pids.join(",")}`); },
    readText: scopeFiles(), ...overrides,
  };
  return { children, calls, dependencies };
}

describe("createSandboxedBashOperations", () => {
  let workspace: string;
  let outside: string;

  beforeAll(async () => {
    const base = await temporaryRoot("sandbox-exec-");
    workspace = join(base, "ws");
    outside = join(base, "outside");
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(workspace, "escape"));
  });

  const exec = (ops: ReturnType<typeof createSandboxedBashOperations>, command: string, cwd: string, extra: Record<string, unknown> = {}) =>
    ops.exec(command, cwd, { onData: () => undefined, ...extra } as never);

  it("runs bwrap with the fixed arguments, an empty environment and no stdin, ignoring the passed env", async () => {
    const h = harness();
    const ops = createSandboxedBashOperations(workspace, h.dependencies);
    const running = exec(ops, "echo hi", join(workspace, "src"), { env: { SECRET_TOKEN: "x", PI_SESSION_ID: "y" } });
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    h.children[0]!.close(0);
    await expect(running).resolves.toEqual({ exitCode: 0 });
    const call = h.calls[0]!;
    expect(call.file).toBe(SYSTEMD_RUN_PATH);
    expect(call.options).toEqual({ env: { XDG_RUNTIME_DIR: "/run/user/test" }, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });
    expect(call.args).toEqual(scopeArgs("test-unit", SANDBOX_LIMITS, sandboxArgs({ workspace, cwd: join(workspace, "src"), rootEntries: MERGED, argv: ["/usr/bin/bash", "-c", "echo hi"] }), DEFAULT_COMMAND_TIMEOUT_SECONDS));
    expect(JSON.stringify(call)).not.toMatch(/SECRET_TOKEN|PI_SESSION_ID/);
  });

  it("adds the worktree Git directory the resolver returns", async () => {
    const h = harness({ gitCommonDir: async () => "/main/.git" });
    const running = exec(createSandboxedBashOperations(workspace, h.dependencies), "git log", workspace);
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    h.children[0]!.close(0);
    await running;
    expect(h.calls[0]!.args.join(" ")).toContain("--overlay-src /main/.git --tmp-overlay /main/.git");
  });

  it("streams stdout and stderr to onData", async () => {
    const h = harness();
    const chunks: string[] = [];
    const running = createSandboxedBashOperations(workspace, h.dependencies).exec("x", workspace, { onData: (data) => chunks.push(data.toString()) });
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    h.children[0]!.stdout.write("out\n");
    h.children[0]!.stderr.write("err\n");
    h.children[0]!.close(3);
    await expect(running).resolves.toEqual({ exitCode: 3 });
    expect(chunks.sort()).toEqual(["err\n", "out\n"]);
  });

  it.each([
    [2, null, 2],
    [null, "SIGKILL", 128 + osConstants.signals.SIGKILL],
    [null, "SIGTERM", 128 + osConstants.signals.SIGTERM],
    [null, null, 1],
  ] as const)("maps exit %s / signal %s to %s", async (code, signal, expected) => {
    const h = harness();
    const running = exec(createSandboxedBashOperations(workspace, h.dependencies), "x", workspace);
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    h.children[0]!.close(code, signal);
    await expect(running).resolves.toEqual({ exitCode: expected });
  });

  it("kills the sandbox with SIGKILL on abort and reports the abort", async () => {
    const h = harness();
    const controller = new AbortController();
    const running = exec(createSandboxedBashOperations(workspace, h.dependencies), "sleep 100", workspace, { signal: controller.signal });
    const settled = expect(running).rejects.toThrow("aborted");
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    controller.abort();
    expect(h.children[0]!.kill).toHaveBeenCalledWith("SIGKILL");
    h.children[0]!.close(null, "SIGKILL");
    await settled;
  });

  it("refuses an already aborted call without spawning", async () => {
    const h = harness();
    await expect(exec(createSandboxedBashOperations(workspace, h.dependencies), "x", workspace, { signal: AbortSignal.abort() })).rejects.toThrow("aborted");
    expect(h.calls).toHaveLength(0);
  });

  it("kills the sandbox on timeout and reports it like the SDK", async () => {
    const h = harness();
    const running = exec(createSandboxedBashOperations(workspace, h.dependencies), "sleep 100", workspace, { timeout: 0.02 });
    const settled = expect(running).rejects.toThrow("timeout:0.02");
    await vi.waitFor(() => expect(h.children[0]?.kill).toHaveBeenCalledWith("SIGKILL"));
    h.children[0]!.close(null, "SIGKILL");
    await settled;
  });

  it("applies the default timeout when the call names none", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const h = harness();
      const running = exec(createSandboxedBashOperations(workspace, h.dependencies), "sleep 1000", workspace);
      const settled = expect(running).rejects.toThrow(`timeout:${DEFAULT_COMMAND_TIMEOUT_SECONDS}`);
      // `vi.waitFor` would advance the fake clock; poll with the real setImmediate instead.
      while (h.calls.length === 0) await new Promise((resolvePromise) => setImmediate(resolvePromise));
      await vi.advanceTimersByTimeAsync(DEFAULT_COMMAND_TIMEOUT_SECONDS * 1000 - 1);
      expect(h.children[0]!.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.children[0]!.kill).toHaveBeenCalledWith("SIGKILL");
      h.children[0]!.close(null, "SIGKILL");
      await vi.advanceTimersByTimeAsync(10);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it("exports a 600 second default", () => { expect(DEFAULT_COMMAND_TIMEOUT_SECONDS).toBe(600); });

  it.each([0, -1, Number.NaN])("rejects the invalid timeout %s without spawning", async (timeout) => {
    const h = harness();
    await expect(exec(createSandboxedBashOperations(workspace, h.dependencies), "x", workspace, { timeout })).rejects.toThrow(/Invalid timeout/);
    expect(h.calls).toHaveLength(0);
  });

  it.each([
    ["the parent of the workspace", () => join(workspace, "..")],
    ["an unrelated directory", () => "/etc"],
    ["a symlink leading out", () => join(workspace, "escape")],
    ["a missing directory", () => join(workspace, "missing")],
  ])("refuses a working directory outside the workspace: %s", async (_name, cwd) => {
    const h = harness();
    await expect(exec(createSandboxedBashOperations(workspace, h.dependencies), "x", cwd())).rejects.toThrow(/Working directory/);
    expect(h.calls).toHaveLength(0);
  });

  it("fails the command, never falling back to an unsandboxed shell, when the binary is untrusted", async () => {
    const h = harness({ trusted: () => false });
    await expect(exec(createSandboxedBashOperations(workspace, h.dependencies), "echo hi", workspace)).rejects.toThrow("Read-only shell sandbox is not available");
    expect(h.calls).toHaveLength(0);
  });

  it("fails the command when bubblewrap cannot be started", async () => {
    const h = harness();
    const running = exec(createSandboxedBashOperations(workspace, h.dependencies), "x", workspace);
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    h.children[0]!.fail();
    await expect(running).rejects.toThrow("Read-only shell sandbox is not available");
  });

  it("fails the command when the trust check itself throws", async () => {
    const h = harness({ trusted: () => { throw new Error("stat failed"); } });
    await expect(exec(createSandboxedBashOperations(workspace, h.dependencies), "x", workspace)).rejects.toThrow("Read-only shell sandbox is not available");
    expect(h.calls).toHaveLength(0);
  });
});

describe("probeSandbox", () => {
  let workspace: string;
  beforeAll(async () => { workspace = await temporaryRoot("sandbox-probe-"); });

  it("runs /usr/bin/true through the same arguments and reports success", async () => {
    const h = harness();
    const probing = probeSandbox(workspace, h.dependencies);
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    h.children[0]!.close(0);
    await expect(probing).resolves.toBe(true);
    expect(h.calls[0]!.file).toBe(SYSTEMD_RUN_PATH);
    expect(h.calls[0]!.args).toEqual(scopeArgs("test-unit", SANDBOX_LIMITS, sandboxArgs({ workspace, cwd: workspace, rootEntries: MERGED, argv: ["/usr/bin/true"] }), PROBE_TIMEOUT_MS / 1000));
  });

  it("reports failure for a non-zero exit, a spawn error and an untrusted binary", async () => {
    const failing = harness();
    const probing = probeSandbox(workspace, failing.dependencies);
    await vi.waitFor(() => expect(failing.calls).toHaveLength(1));
    failing.children[0]!.close(1);
    await expect(probing).resolves.toBe(false);

    const broken = harness();
    const brokenProbe = probeSandbox(workspace, broken.dependencies);
    await vi.waitFor(() => expect(broken.calls).toHaveLength(1));
    broken.children[0]!.fail();
    await expect(brokenProbe).resolves.toBe(false);

    const untrusted = harness({ trusted: () => false });
    await expect(probeSandbox(workspace, untrusted.dependencies)).resolves.toBe(false);
    expect(untrusted.calls).toHaveLength(0);
  });

  it("kills the probe and reports failure when the start is aborted", async () => {
    const h = harness();
    const controller = new AbortController();
    const probing = probeSandbox(workspace, h.dependencies, controller.signal);
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    controller.abort();
    await expect(probing).resolves.toBe(false);
    expect(h.children[0]!.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("does not spawn when the start is already aborted", async () => {
    const h = harness();
    await expect(probeSandbox(workspace, h.dependencies, AbortSignal.abort())).resolves.toBe(false);
    expect(h.calls).toHaveLength(0);
  });

  it("reports failure for a missing workspace", async () => {
    const h = harness();
    await expect(probeSandbox(join(workspace, "missing"), h.dependencies)).resolves.toBe(false);
    expect(h.calls).toHaveLength(0);
  });

  it("kills a hanging probe at the bound and reports failure", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const h = harness();
      const probing = probeSandbox(workspace, h.dependencies);
      await vi.waitFor(() => expect(h.calls).toHaveLength(1), { interval: 1 });
      await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
      await expect(probing).resolves.toBe(false);
      expect(h.children[0]!.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("verifyScope", () => {
  const input = { pid: 4241, childPid: 4242, unit: "test-unit", limits: SANDBOX_LIMITS };

  it("accepts both processes in the named scope with the exact limits", async () => {
    await expect(verifyScope(input, scopeFiles())).resolves.toBe(true);
    await expect(verifyScope({ ...input, limits: { memoryBytes: 67_108_864, tasks: 16 } }, scopeFiles({
      [`/sys/fs/cgroup${SCOPE}/memory.max`]: "67108864\n", [`/sys/fs/cgroup${SCOPE}/pids.max`]: "16\n",
    }))).resolves.toBe(true);
  });

  it.each([
    ["no cgroup2 mount", { "/proc/self/mounts": "cgroup /sys/fs/cgroup cgroup rw 0 0\n" }],
    ["unreadable mounts", { "/proc/self/mounts": new Error("EACCES") }],
    ["memory.max not in force", { [`/sys/fs/cgroup${SCOPE}/memory.max`]: "max\n" }],
    ["another memory.max", { [`/sys/fs/cgroup${SCOPE}/memory.max`]: "1073741823\n" }],
    ["swap not disabled", { [`/sys/fs/cgroup${SCOPE}/memory.swap.max`]: "max\n" }],
    ["pids.max not in force", { [`/sys/fs/cgroup${SCOPE}/pids.max`]: "max\n" }],
    ["another pids.max", { [`/sys/fs/cgroup${SCOPE}/pids.max`]: "127\n" }],
    ["missing controller file", { [`/sys/fs/cgroup${SCOPE}/pids.max`]: new Error("ENOENT") }],
    ["a scope of another unit", { "/proc/4241/cgroup": "0::/user.slice/app.slice/other.scope\n", "/proc/4242/cgroup": "0::/user.slice/app.slice/other.scope\n" }],
    ["the server's own cgroup", { "/proc/self/cgroup": `0::${SCOPE}\n` }],
    ["the processes in different cgroups", { "/proc/4242/cgroup": "0::/user.slice/app.slice/elsewhere/test-unit.scope\n" }],
    ["a dot-dot segment", { "/proc/4241/cgroup": "0::/user.slice/../test-unit.scope\n", "/proc/4242/cgroup": "0::/user.slice/../test-unit.scope\n" }],
    ["an empty segment", { "/proc/4241/cgroup": "0::/user.slice//test-unit.scope\n", "/proc/4242/cgroup": "0::/user.slice//test-unit.scope\n" }],
    ["a relative path", { "/proc/4241/cgroup": "0::user.slice/test-unit.scope\n", "/proc/4242/cgroup": "0::user.slice/test-unit.scope\n" }],
    ["a cgroup v1 line", { "/proc/4241/cgroup": `0::${SCOPE}\n1:memory:${SCOPE}\n` }],
    ["a vanished child", { "/proc/4242/cgroup": new Error("ENOENT") }],
  ])("refuses %s", async (_name, changes) => {
    await expect(verifyScope(input, scopeFiles(changes))).resolves.toBe(false);
  });
});

describe("endScope", () => {
  const io = (cgroups: Record<number, string>, options: { noKillFile?: boolean } = {}) => {
    const calls: string[] = [];
    return {
      calls,
      io: {
        read: (path: string) => { const pid = Number(/^\/proc\/(\d+)\/cgroup$/.exec(path)?.[1]); const text = cgroups[pid]; if (text === undefined) throw new Error("ENOENT"); return text; },
        write: (path: string, data: string) => { if (options.noKillFile) throw new Error("ENOENT"); calls.push(`write ${path} ${data}`); },
        kill: (pid: number) => { calls.push(`kill ${pid}`); },
      },
    };
  };

  it("kills the scope once through cgroup.kill and each PID inside it", () => {
    const fake = io({ 4241: `0::${SCOPE}\n`, 4242: `0::${SCOPE}\n` });
    endScope([4241, 4242], "test-unit", fake.io);
    expect(fake.calls).toEqual([`write /sys/fs/cgroup${SCOPE}/cgroup.kill 1`, "kill 4241", "kill 4242"]);
  });

  it("finds the scope through the child when the launcher is gone", () => {
    const fake = io({ 4242: `0::${SCOPE}\n` });
    endScope([4241, 4242], "test-unit", fake.io);
    expect(fake.calls).toEqual([`write /sys/fs/cgroup${SCOPE}/cgroup.kill 1`, "kill 4242"]);
  });

  it("still kills the PIDs in the scope without cgroup.kill", () => {
    const fake = io({ 4241: `0::${SCOPE}\n`, 4242: `0::${SCOPE}\n` }, { noKillFile: true });
    endScope([4241, 4242], "test-unit", fake.io);
    expect(fake.calls).toEqual(["kill 4241", "kill 4242"]);
  });

  it.each([
    ["another unit's scope", "0::/user.slice/app.slice/other-unit.scope\n"],
    ["the server's cgroup", "0::/user.slice/server.scope\n"],
    ["a path with ..", "0::/user.slice/../test-unit.scope\n"],
    ["a cgroup v1 line", "1:name=systemd:/test-unit.scope\n"],
  ])("leaves a PID in %s alone", (_name, cgroup) => {
    const fake = io({ 4241: cgroup });
    endScope([4241, undefined], "test-unit", fake.io);
    expect(fake.calls).toEqual([]);
  });

  it("ignores missing, invalid and init PIDs", () => {
    const fake = io({ 1: `0::${SCOPE}\n` });
    endScope([undefined, 0, 1, 1.5, 999999], "test-unit", fake.io);
    expect(fake.calls).toEqual([]);
  });
});

describe("validatedRuntimeDir", () => {
  const entry = (overrides: Partial<{ directory: boolean; link: boolean; socket: boolean; uid: number; mode: number }> = {}) => {
    const value = { directory: true, link: false, socket: false, uid: 1000, mode: 0o40700, ...overrides };
    return { isDirectory: () => value.directory, isSymbolicLink: () => value.link, isSocket: () => value.socket, uid: value.uid, mode: value.mode };
  };
  const stat = (dir: ReturnType<typeof entry> | Error, bus: ReturnType<typeof entry> | Error = entry({ directory: false, socket: true })) => (path: string) => {
    const value = path === "/run/user/1000" ? dir : path === "/run/user/1000/bus" ? bus : new Error("ENOENT");
    if (value instanceof Error) throw value;
    return value as never;
  };

  it("accepts the user's own closed runtime directory with a bus socket", () => {
    expect(validatedRuntimeDir(1000, stat(entry()))).toBe("/run/user/1000");
  });

  it.each([
    ["no UID", undefined, stat(entry())],
    ["a missing directory", 1000, stat(new Error("ENOENT"))],
    ["a file instead of a directory", 1000, stat(entry({ directory: false }))],
    ["a symbolic link", 1000, stat(entry({ link: true }))],
    ["another owner", 1000, stat(entry({ uid: 0 }))],
    ["group access", 1000, stat(entry({ mode: 0o40750 }))],
    ["access for others", 1000, stat(entry({ mode: 0o40701 }))],
    ["no bus", 1000, stat(entry(), new Error("ENOENT"))],
    ["a bus that is not a socket", 1000, stat(entry(), entry({ directory: false }))],
  ] as const)("refuses %s", (_name, uid, lstat) => {
    expect(validatedRuntimeDir(uid, lstat)).toBeUndefined();
  });
});

describe("limited scope gate", () => {
  let workspace: string;
  beforeAll(async () => { workspace = await temporaryRoot("sandbox-gate-"); });

  const run = (dependencies: SandboxDependencies, extra: Record<string, unknown> = {}) => {
    const output: string[] = [];
    const result = createSandboxedBashOperations(workspace, dependencies)
      .exec("echo PAYLOAD", workspace, { onData: (data: Buffer) => output.push(data.toString()), ...extra } as never);
    return { result, output };
  };

  it("releases bubblewrap with one byte on fd 4 only after the scope is verified", async () => {
    let verified = false;
    const files = scopeFiles();
    const h = harness({ readText: async (path) => { if (path.endsWith("/pids.max")) verified = true; return files(path); } });
    const { result } = run(h.dependencies);
    await vi.waitFor(() => expect(h.children[0]?.released).toEqual(["1"]));
    expect(verified).toBe(true);
    h.children[0]!.close(0);
    await expect(result).resolves.toEqual({ exitCode: 0 });
    expect(h.children[0]!.kill).not.toHaveBeenCalled();
  });

  it("keeps the launcher's diagnostics from the caller and passes the released command's output", async () => {
    const refused = harness({}, false);
    const first = run(refused.dependencies);
    await vi.waitFor(() => expect(refused.children).toHaveLength(1));
    refused.children[0]!.stderr.write("Failed to start transient scope unit: host detail\n");
    refused.children[0]!.info.end();
    await expect(first.result).rejects.toThrow(SANDBOX_UNAVAILABLE_MESSAGE);
    expect(first.output).toEqual([]);

    const released = harness();
    const second = run(released.dependencies);
    await vi.waitFor(() => expect(released.children[0]?.released).toEqual(["1"]));
    released.children[0]!.stdout.write("PAYLOAD\n");
    released.children[0]!.close(0);
    await expect(second.result).resolves.toEqual({ exitCode: 0 });
    expect(second.output.join("")).toBe("PAYLOAD\n");
  });

  it("gives up a probe whose setup never reports within the deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const h = harness({}, false);
      const probing = probeSandbox(workspace, h.dependencies);
      await vi.waitFor(() => expect(h.children).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
      await expect(probing).resolves.toBe(false);
      expect(h.children[0]!.released).toEqual([]);
      expect(h.children[0]!.events).toEqual(["kill", "scope:4241,", "block-closed"]);
    } finally { vi.useRealTimers(); }
  });

  it("releases bubblewrap when the child PID report arrives in pieces", async () => {
    const h = harness({}, false);
    const { result } = run(h.dependencies);
    await vi.waitFor(() => expect(h.children).toHaveLength(1));
    h.children[0]!.info.write('{"child-');
    h.children[0]!.info.write('pid":4242}');
    await vi.waitFor(() => expect(h.children[0]!.released).toEqual(["1"]));
    h.children[0]!.close(0);
    await expect(result).resolves.toEqual({ exitCode: 0 });
  });

  it("does not release bubblewrap when the launcher ends while the scope is verified", async () => {
    const files = scopeFiles();
    let closedDuringVerify = false;
    const h = harness({
      readText: async (path) => {
        if (path.endsWith("/pids.max")) {
          h.children[0]!.close(null, "SIGKILL");
          await new Promise((resolvePromise) => setImmediate(resolvePromise));
          closedDuringVerify = true;
        }
        return files(path);
      },
    });
    await expect(run(h.dependencies).result).rejects.toThrow(SANDBOX_UNAVAILABLE_MESSAGE);
    // The verification finishes after the command has failed; the gate must still not release.
    await vi.waitFor(() => expect(closedDuringVerify).toBe(true));
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    expect(h.children[0]!.released).toEqual([]);
  });

  it.each([
    ["an untrusted systemd-run", { trusted: (path: string) => path !== SYSTEMD_RUN_PATH }],
    ["an untrusted bubblewrap", { trusted: (path: string) => path !== BWRAP_PATH }],
    ["no usable user runtime directory", { runtimeDir: () => undefined }],
  ])("refuses before spawning with %s", async (_name, overrides) => {
    const h = harness(overrides);
    await expect(run(h.dependencies).result).rejects.toThrow(SANDBOX_UNAVAILABLE_MESSAGE);
    expect(h.calls).toHaveLength(0);
    await expect(probeSandbox(workspace, h.dependencies)).resolves.toBe(false);
    expect(h.calls).toHaveLength(0);
  });

  it.each([
    ["end of file before the child PID", null],
    ["an oversized report", `{"pad":"${"x".repeat(5000)}"}`],
    ["a report that is not an object", "[4242]"],
    ["no child PID", '{"pid":4242}'],
    ["a child PID of 1", '{"child-pid":1}'],
    ["a child PID that is not an integer", '{"child-pid":"4242"}'],
  ])("kills before closing fd 4 and never releases on %s", async (_name, info) => {
    const h = harness({}, info);
    const { result, output } = run(h.dependencies);
    await expect(result).rejects.toThrow(SANDBOX_UNAVAILABLE_MESSAGE);
    const child = h.children[0]!;
    expect(child.released).toEqual([]);
    await vi.waitFor(() => expect(child.events).toEqual(["kill", "scope:4241,", "block-closed"]));
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(output).toEqual([]);
  });

  it.each([
    ["an ignored memory limit", { [`/sys/fs/cgroup${SCOPE}/memory.max`]: "max\n" }],
    ["swap still allowed", { [`/sys/fs/cgroup${SCOPE}/memory.swap.max`]: "max\n" }],
    ["an ignored task limit", { [`/sys/fs/cgroup${SCOPE}/pids.max`]: "max\n" }],
    ["a process outside the scope", { "/proc/4241/cgroup": "0::/user.slice/server.scope\n" }],
    ["no cgroup v2", { "/proc/self/mounts": "proc /proc proc rw 0 0\n" }],
  ])("refuses the command and the probe on %s", async (_name, changes) => {
    const h = harness({ readText: scopeFiles(changes) });
    await expect(run(h.dependencies).result).rejects.toThrow(SANDBOX_UNAVAILABLE_MESSAGE);
    expect(h.children[0]!.released).toEqual([]);
    await vi.waitFor(() => expect(h.children[0]!.events).toEqual(["kill", "scope:4241,4242", "block-closed"]));
    await expect(probeSandbox(workspace, h.dependencies)).resolves.toBe(false);
    expect(h.children[1]!.released).toEqual([]);
    expect(h.children[1]!.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("refuses a child without a PID", async () => {
    const h = harness({ spawn: (...args) => Object.assign(h2.dependencies.spawn!(...args), { pid: undefined }) });
    const h2 = harness();
    await expect(run(h.dependencies).result).rejects.toThrow(SANDBOX_UNAVAILABLE_MESSAGE);
    expect(h2.children[0]!.released).toEqual([]);
    expect(h2.children[0]!.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("refuses a later command when the limits are lost after a successful probe", async () => {
    let lost = false;
    const good = scopeFiles();
    const bad = scopeFiles({ [`/sys/fs/cgroup${SCOPE}/memory.max`]: "max\n" });
    const h = harness({ readText: (path) => (lost ? bad : good)(path) });
    const probing = probeSandbox(workspace, h.dependencies);
    await vi.waitFor(() => expect(h.children[0]?.released).toEqual(["1"]));
    h.children[0]!.close(0);
    await expect(probing).resolves.toBe(true);
    lost = true;
    await expect(run(h.dependencies).result).rejects.toThrow(SANDBOX_UNAVAILABLE_MESSAGE);
    expect(h.children[1]!.released).toEqual([]);
  });

  it("reports an abort during setup as aborted and kills before closing fd 4", async () => {
    const h = harness({}, false);
    const controller = new AbortController();
    const { result } = run(h.dependencies, { signal: controller.signal });
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    controller.abort();
    await expect(result).rejects.toThrow("aborted");
    expect(h.children[0]!.released).toEqual([]);
    await vi.waitFor(() => expect(h.children[0]!.events).toEqual(["kill", "scope:4241,", "block-closed"]));
  });

  it("reports a timeout during setup as a timeout and kills", async () => {
    const h = harness({}, false);
    const { result } = run(h.dependencies, { timeout: 0.05 });
    await expect(result).rejects.toThrow("timeout:0.05");
    expect(h.children[0]!.released).toEqual([]);
    expect(h.children[0]!.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("ends a probe whose setup does not finish when it is aborted", async () => {
    const h = harness({}, false);
    const controller = new AbortController();
    const probing = probeSandbox(workspace, h.dependencies, controller.signal);
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    controller.abort();
    await expect(probing).resolves.toBe(false);
    expect(h.children[0]!.released).toEqual([]);
    expect(h.children[0]!.kill).toHaveBeenCalledWith("SIGKILL");
  });
});

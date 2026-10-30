import { EventEmitter } from "node:events";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  BWRAP_PATH, SYSTEMD_RUN_PATH, SANDBOX_LIMITS, scopeArgs, createSandboxedBashOperations, DEFAULT_COMMAND_TIMEOUT_SECONDS, PROBE_TIMEOUT_MS, probeSandbox, resolveWorktreeGitDir, sandboxArgs,
  type RootEntry, type SandboxChild, type SandboxDependencies, type SandboxSpawn,
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
    expect(scopeArgs("unit", SANDBOX_LIMITS, ["arg"])).toEqual([
      "--user", "--scope", "--quiet", "--collect", "--unit=unit", "-p", "MemoryMax=1073741824",
      "-p", "MemorySwapMax=0", "-p", "TasksMax=128", "--", BWRAP_PATH, "--info-fd", "3", "--block-fd", "4", "arg",
    ]);
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
function fakeChild() {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const info = new PassThrough();
  const block = new PassThrough();
  const released: string[] = [];
  block.on("data", (chunk) => released.push(chunk.toString()));
  const kill = vi.fn();
  const child = Object.assign(emitter, { pid: 4241, stdio: [null, stdout, stderr, info, block], stdout, stderr, kill }) as unknown as SandboxChild;
  return {
    child, kill, stdout, stderr, info, block, released,
    close: (code: number | null, signal: NodeJS.Signals | null = null) => { stdout.end(); stderr.end(); setImmediate(() => emitter.emit("close", code, signal)); },
    fail: () => emitter.emit("error", new Error("spawn failed")),
  };
}

type Fake = ReturnType<typeof fakeChild>;

function harness(overrides: Partial<SandboxDependencies> = {}) {
  const children: Fake[] = [];
  const calls: { file: string; args: readonly string[]; options: unknown }[] = [];
  const spawn: SandboxSpawn = (file, args, options) => {
    calls.push({ file, args, options });
    const fake = fakeChild();
    children.push(fake);
    queueMicrotask(() => fake.info.write('{"child-pid":4242}'));
    return fake.child;
  };
  const dependencies: SandboxDependencies = {
    spawn, trusted: () => true, rootEntries: () => MERGED, gitCommonDir: async () => undefined,
    runtimeDir: () => "/run/user/test", unitName: () => "test-unit",
    readText: async (path) => {
      if (path === "/proc/self/mounts") return "cgroup2 /sys/fs/cgroup cgroup2 rw 0 0\n";
      if (path === "/proc/self/cgroup") return "0::/user.slice/server.scope\n";
      if (path === "/proc/4241/cgroup" || path === "/proc/4242/cgroup") return "0::/user.slice/app.slice/test-unit.scope\n";
      if (path.endsWith("/memory.max")) return `${SANDBOX_LIMITS.memoryBytes}\n`;
      if (path.endsWith("/memory.swap.max")) return "0\n";
      if (path.endsWith("/pids.max")) return `${SANDBOX_LIMITS.tasks}\n`;
      throw new Error("unexpected path");
    }, ...overrides,
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
    expect(call.args).toEqual(scopeArgs("test-unit", SANDBOX_LIMITS, sandboxArgs({ workspace, cwd: join(workspace, "src"), rootEntries: MERGED, argv: ["/usr/bin/bash", "-c", "echo hi"] })));
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
    expect(h.calls[0]!.args).toEqual(scopeArgs("test-unit", SANDBOX_LIMITS, sandboxArgs({ workspace, cwd: workspace, rootEntries: MERGED, argv: ["/usr/bin/true"] })));
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

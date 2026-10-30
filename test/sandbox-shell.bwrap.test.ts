/**
 * The shell sandbox against the real bubblewrap, so the arguments of ADR 0013 are proven rather than assumed.
 * Opt-in by capability: every test is skipped unless `/usr/bin/bwrap` is a trusted system binary and a probe run
 * through the sandbox succeeds (unprivileged user namespaces, overlay support), and the Git tests also need `git`.
 */
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  BWRAP_PATH, createSandboxedBashOperations, probeSandbox, sandboxBinaryTrusted,
  SANDBOX_LIMITS, SANDBOX_MEMORY_BYTES, SANDBOX_TASKS, SANDBOX_UNAVAILABLE_MESSAGE, SYSTEMD_RUN_PATH,
  type SandboxDependencies, type SandboxLimits,
} from "../src/sandbox-shell.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

const run = promisify(execFile);
const probeRoot = await temporaryRoot("sandbox-real-probe-");
const available = sandboxBinaryTrusted() && await probeSandbox(probeRoot);
const gitAvailable = available && existsSync("/usr/bin/git");
const pythonAvailable = available && existsSync("/usr/bin/python3");
const systemctlAvailable = available && existsSync("/usr/bin/systemctl");

async function sh(workspace: string, command: string): Promise<{ exitCode: number | null; output: string }> {
  let output = "";
  const { exitCode } = await createSandboxedBashOperations(workspace).exec(command, workspace, {
    onData: (data) => { output += data.toString(); },
    env: { ...process.env, PI_SESSION_ID: "leak-probe" },
    timeout: 30,
  });
  return { exitCode, output };
}

interface SandboxRunOptions {
  readonly dependencies?: SandboxDependencies;
  readonly timeout?: number;
  readonly signal?: AbortSignal;
}

type SandboxRun =
  | { readonly ok: true; readonly exitCode: number | null; readonly output: string }
  | { readonly ok: false; readonly error: Error; readonly output: string };

/** Runs one command through the sandbox and keeps the output and either the exit code or the rejection. */
async function runSandbox(workspace: string, command: string, options: SandboxRunOptions = {}): Promise<SandboxRun> {
  let output = "";
  try {
    const { exitCode } = await createSandboxedBashOperations(workspace, options.dependencies ?? {}).exec(command, workspace, {
      onData: (data) => { output += data.toString(); },
      env: { ...process.env, PI_SESSION_ID: "leak-probe" },
      timeout: options.timeout ?? 30,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return { ok: true, exitCode, output };
  } catch (error) {
    return { ok: false, error: error as Error, output };
  }
}

function okRun(result: SandboxRun): { exitCode: number | null; output: string } {
  if (!result.ok) throw new Error(`sandbox call failed: ${result.error.message}`);
  return { exitCode: result.exitCode, output: result.output };
}

function failedRun(result: SandboxRun): Error {
  if (result.ok) throw new Error(`expected a rejection, got exit ${result.exitCode}`);
  return result.error;
}

const fileDigest = async (path: string): Promise<string> => createHash("sha256").update(await readFile(path)).digest("hex");

/** A stable listing of a tree: relative path, type, mode and content digest or link target. */
async function snapshot(root: string): Promise<string[]> {
  const entries: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const info = await lstat(path);
      const mode = (info.mode & 0o777).toString(8);
      if (info.isDirectory()) {
        entries.push(`d ${mode} ${name}`);
        await walk(path, name);
      } else if (info.isSymbolicLink()) {
        entries.push(`l ${mode} ${name} -> ${await readlink(path)}`);
      } else {
        entries.push(`f ${mode} ${name} ${await fileDigest(path)}`);
      }
    }
  };
  await walk(root, "");
  return entries.sort();
}

const git = (cwd: string, ...args: string[]) =>
  run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd });

/** A main repository with one linked worktree, the same layout the existing worktree test uses. */
async function linkedWorktree(prefix: string): Promise<{ main: string; linked: string }> {
  const base = await temporaryRoot(prefix);
  const main = join(base, "main");
  const linked = join(base, "linked");
  await mkdir(main);
  await git(main, "init", "-q", "-b", "main");
  await writeFile(join(main, "b.txt"), "from main\n");
  await git(main, "add", "b.txt");
  await git(main, "commit", "-q", "-m", "main commit");
  await git(main, "worktree", "add", "-q", "-b", "feature", linked);
  return { main, linked };
}

/** A command that writes `bytes` into the linked worktree's shared Git directory. */
const writeCommonDir = (bytes: number, name: string): string =>
  `target=$(git rev-parse --git-common-dir); case "$target" in /*) ;; *) target="$PWD/$target" ;; esac; echo "TARGET=$target"; head -c ${bytes} /dev/zero > "$target/${name}"`;

const listShellUnits = async (): Promise<string> => {
  const { stdout } = await run("/usr/bin/systemctl", ["--user", "list-units", "--all", "--no-legend", "pi-session-mcp-shell-*"], { timeout: 5_000 });
  return stdout.trim();
};

const expectNoShellUnits = async (): Promise<void> => {
  await vi.waitFor(async () => { expect(await listShellUnits()).toBe(""); }, { timeout: 10_000, interval: 250 });
};

/** Asserts the fail-closed contract: rejection, no payload output, and a false probe. */
async function expectUnavailable(workspace: string, dependencies: SandboxDependencies): Promise<void> {
  const marker = `PAYLOAD-RAN-${Math.random().toString(36).slice(2)}`;
  const result = await runSandbox(workspace, `echo ${marker}`, { dependencies, timeout: 10 });
  const error = failedRun(result);
  expect(error.message).toBe(SANDBOX_UNAVAILABLE_MESSAGE);
  expect(result.output).not.toContain(marker);
  await expect(probeSandbox(workspace, dependencies)).resolves.toBe(false);
}

describe.skipIf(!available)("real bubblewrap sandbox", () => {
  it("runs a command in the workspace as the current directory", async () => {
    const workspace = await temporaryRoot("sandbox-real-cwd-");
    await writeFile(join(workspace, "marker.txt"), "present");
    const result = await sh(workspace, "pwd; cat marker.txt");
    expect(result).toEqual({ exitCode: 0, output: `${workspace}\npresent` });
  });

  it("lets a write succeed inside the sandbox and leaves the host workspace untouched", async () => {
    const workspace = await temporaryRoot("sandbox-real-write-");
    await writeFile(join(workspace, "existing.txt"), "original");
    const result = await sh(workspace, "echo new > created.txt && echo changed > existing.txt && cat created.txt existing.txt && rm existing.txt && ls");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("new\nchanged\n");
    expect(existsSync(join(workspace, "created.txt"))).toBe(false);
    expect(await readFile(join(workspace, "existing.txt"), "utf8")).toBe("original");
  });

  it("has no network", async () => {
    const workspace = await temporaryRoot("sandbox-real-net-");
    expect((await sh(workspace, "timeout 5 bash -c 'echo > /dev/tcp/1.1.1.1/53'")).exitCode).not.toBe(0);
    expect((await sh(workspace, "getent hosts example.com")).exitCode).not.toBe(0);
    // Only the loopback interface exists in the new network namespace.
    const interfaces = await sh(workspace, "tail -n +3 /proc/net/dev | cut -d: -f1");
    expect(interfaces.output.trim()).toBe("lo");
  });

  it("does not show the operator's home directory", async () => {
    const workspace = await temporaryRoot("sandbox-real-home-");
    const home = homedir();
    // A workspace below the home directory legitimately exposes its own path.
    if (workspace.startsWith(`${home}/`)) return;
    expect((await sh(workspace, `test -e ${JSON.stringify(home)}`)).exitCode).not.toBe(0);
    expect((await sh(workspace, "echo $HOME")).output.trim()).toBe("/tmp/home");
  });

  it("starts with a cleared environment: neither the server's nor the tool's variables arrive", async () => {
    const workspace = await temporaryRoot("sandbox-real-env-");
    process.env.SANDBOX_LEAK_PROBE = "leaked";
    try {
      const result = await sh(workspace, "env | sort");
      expect(result.output).not.toMatch(/leaked|leak-probe|PI_SESSION_ID|SANDBOX_LEAK_PROBE/);
      expect(result.output).toContain("PATH=/usr/local/bin:/usr/bin:/bin");
    } finally {
      delete process.env.SANDBOX_LEAK_PROBE;
    }
  });

  describe("cleanup on timeout and abort", () => {
    const alive = (token: string): boolean => spawnSync("pgrep", ["-f", token]).status === 0;
    const settled = async (token: string): Promise<boolean> => {
      for (let attempt = 0; attempt < 40; attempt++) { if (!alive(token)) return true; await sleep(50); }
      return false;
    };
    /** Runs a script that starts a foreground, a backgrounded and a setsid sleeper, all marked by `token`. */
    const script = (token: string): string =>
      `sleep ${token}.1 & (setsid sleep ${token}.2 &) ; nohup sleep ${token}.3 >/dev/null 2>&1 & sleep ${token}.4`;
    const token = (): string => String(900_000 + Math.floor(Math.random() * 90_000));

    it.skipIf(spawnSync("pgrep", ["-V"]).error !== undefined)("returns promptly on timeout and leaves no sandbox process", async () => {
      const workspace = await temporaryRoot("sandbox-real-timeout-");
      const marker = token();
      const started = Date.now();
      await expect(createSandboxedBashOperations(workspace).exec(script(marker), workspace, { onData: () => undefined, timeout: 1 })).rejects.toThrow("timeout:1");
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(await settled(marker)).toBe(true);
    });

    it.skipIf(spawnSync("pgrep", ["-V"]).error !== undefined)("returns promptly on abort and leaves no sandbox process", async () => {
      const workspace = await temporaryRoot("sandbox-real-abort-");
      const marker = token();
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 700);
      const started = Date.now();
      await expect(createSandboxedBashOperations(workspace).exec(script(marker), workspace, { onData: () => undefined, signal: controller.signal })).rejects.toThrow("aborted");
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(await settled(marker)).toBe(true);
    });

    it("limits /tmp to 512 MiB", async () => {
      const workspace = await temporaryRoot("sandbox-real-tmp-");
      const result = await sh(workspace, "df -B1 --output=size /tmp | tail -n 1");
      expect(Number(result.output.trim())).toBe(536_870_912);
      expect((await sh(workspace, "head -c 600000000 /dev/zero > /tmp/big; echo $?")).output.trim()).not.toBe("0");
    });
  });

  it("maps a failing command to its exit code", async () => {
    const workspace = await temporaryRoot("sandbox-real-exit-");
    expect((await sh(workspace, "exit 7")).exitCode).toBe(7);
  });

  it.skipIf(!gitAvailable)("runs git log and git blame in a plain repository", async () => {
    const workspace = await temporaryRoot("sandbox-real-git-");
    await git(workspace, "init", "-q", "-b", "main");
    await writeFile(join(workspace, "a.txt"), "line one\n");
    await git(workspace, "add", "a.txt");
    await git(workspace, "commit", "-q", "-m", "first commit");
    const log = await sh(workspace, "git log --oneline");
    expect(log.exitCode).toBe(0);
    expect(log.output).toContain("first commit");
    const blame = await sh(workspace, "git blame a.txt");
    expect(blame.exitCode).toBe(0);
    expect(blame.output).toContain("line one");
    // A Git write only changes the temporary layer.
    expect((await sh(workspace, "git branch phantom && git branch --list phantom")).output).toContain("phantom");
    expect((await git(workspace, "branch", "--list", "phantom")).stdout.trim()).toBe("");
  });

  it.skipIf(!gitAvailable)("runs git log and git blame in a linked worktree through the main repository's Git directory", async () => {
    const base = await temporaryRoot("sandbox-real-worktree-");
    const main = join(base, "main");
    const linked = join(base, "linked");
    await mkdir(main);
    await git(main, "init", "-q", "-b", "main");
    await writeFile(join(main, "b.txt"), "from main\n");
    await git(main, "add", "b.txt");
    await git(main, "commit", "-q", "-m", "main commit");
    await git(main, "worktree", "add", "-q", "-b", "feature", linked);
    await writeFile(join(linked, "c.txt"), "from linked\n");
    await git(linked, "add", "c.txt");
    await git(linked, "commit", "-q", "-m", "linked commit");

    const log = await sh(linked, "git log --oneline");
    expect(log.exitCode).toBe(0);
    expect(log.output).toContain("linked commit");
    expect(log.output).toContain("main commit");
    const blame = await sh(linked, "git blame b.txt");
    expect(blame.exitCode).toBe(0);
    expect(blame.output).toContain("from main");
    // The main working tree is not mounted, only its Git directory.
    expect((await sh(linked, `test -e ${JSON.stringify(join(main, "b.txt"))}`)).exitCode).not.toBe(0);

    // A write to the shared Git directory vanishes with the command.
    await sh(linked, "git branch phantom");
    expect((await git(main, "branch", "--list", "phantom")).stdout.trim()).toBe("");
  });

  it("gives Git nothing to work with when the worktree pointer is not trusted", async () => {
    const workspace = await temporaryRoot("sandbox-real-badpointer-");
    const fakeHome = await temporaryRoot("sandbox-real-fakehome-");
    await writeFile(join(fakeHome, "secret.txt"), "private");
    await writeFile(join(workspace, ".git"), `gitdir: ${fakeHome}\n`);
    const result = await sh(workspace, `git log; cat ${JSON.stringify(join(fakeHome, "secret.txt"))}`);
    expect(result.output).not.toContain("private");
  });

  describe("resource limits", () => {
    const SMALL_MEMORY: SandboxLimits = { memoryBytes: 64 * 1024 * 1024, tasks: 64 };
    const SMALL_TASKS: SandboxLimits = { memoryBytes: 256 * 1024 * 1024, tasks: 16 };
    /** Allocates about 200 MB in the Bash process itself, without an extra interpreter. */
    const BASH_MEMORY_HOG = "printf -v x '%*s' 209715200 ''";

    it("documents the default limits of one GiB and 128 tasks", () => {
      expect(SANDBOX_LIMITS).toEqual({ memoryBytes: SANDBOX_MEMORY_BYTES, tasks: SANDBOX_TASKS });
      expect(SANDBOX_MEMORY_BYTES).toBe(1_073_741_824);
      expect(SANDBOX_TASKS).toBe(128);
    }, 5_000);

    it.skipIf(!gitAvailable)("runs Git commands and a test script under the default limits without changing the host workspace", async () => {
      const workspace = await temporaryRoot("sandbox-real-limits-normal-");
      await git(workspace, "init", "-q", "-b", "main");
      await writeFile(join(workspace, "a.txt"), "line one\n");
      await git(workspace, "add", "a.txt");
      await git(workspace, "commit", "-q", "-m", "first commit");
      await writeFile(join(workspace, "a.txt"), "line one\nline two\n");
      await writeFile(join(workspace, "test.sh"), "#!/bin/sh\nset -eu\ngrep -q 'line two' a.txt\ntest \"$(wc -l < a.txt)\" -eq 2\necho script-ok\n");
      await chmod(join(workspace, "test.sh"), 0o755);
      const before = await snapshot(workspace);

      const log = okRun(await runSandbox(workspace, "git log --oneline"));
      expect(log.exitCode).toBe(0);
      expect(log.output).toContain("first commit");
      const diff = okRun(await runSandbox(workspace, "git diff"));
      expect(diff.exitCode).toBe(0);
      expect(diff.output).toContain("line two");
      const blame = okRun(await runSandbox(workspace, "git blame a.txt"));
      expect(blame.exitCode).toBe(0);
      expect(blame.output).toContain("line one");
      const script = okRun(await runSandbox(workspace, "./test.sh"));
      expect(script).toEqual({ exitCode: 0, output: "script-ok\n" });

      expect(await snapshot(workspace)).toEqual(before);
    }, 60_000);

    it.skipIf(!pythonAvailable)("ends a Python allocation above the memory limit while a default-limit command succeeds", async () => {
      const workspace = await temporaryRoot("sandbox-real-limits-memory-python-");
      const [allocated, sentinel] = await Promise.all([
        runSandbox(workspace, 'python3 -c "b = bytearray(200 * 1024 * 1024)"', { dependencies: { limits: SMALL_MEMORY }, timeout: 30 }),
        runSandbox(workspace, "sleep 1; echo sentinel-ok", { timeout: 30 }),
      ]);
      expect(okRun(allocated).exitCode).not.toBe(0);
      expect(okRun(sentinel)).toEqual({ exitCode: 0, output: "sentinel-ok\n" });
    }, 60_000);

    it("ends a Bash allocation above the memory limit", async () => {
      const workspace = await temporaryRoot("sandbox-real-limits-memory-bash-");
      const [allocated, sentinel] = await Promise.all([
        runSandbox(workspace, BASH_MEMORY_HOG, { dependencies: { limits: SMALL_MEMORY }, timeout: 30 }),
        runSandbox(workspace, "sleep 1; echo sentinel-ok", { timeout: 30 }),
      ]);
      expect(okRun(allocated).exitCode).not.toBe(0);
      expect(okRun(sentinel)).toEqual({ exitCode: 0, output: "sentinel-ok\n" });
    }, 60_000);

    it("applies the memory limit to the scope and leaves swap at zero", async () => {
      const workspace = await temporaryRoot("sandbox-real-limits-swap-");
      const seen: { memory?: string; swap?: string } = {};
      const readText = async (path: string): Promise<string> => {
        const text = await readFile(path, "utf8");
        if (path.endsWith("/memory.max")) seen.memory = text.trim();
        if (path.endsWith("/memory.swap.max")) seen.swap = text.trim();
        return text;
      };
      const result = await runSandbox(workspace, "echo swap-probe", { dependencies: { limits: SMALL_MEMORY, readText }, timeout: 20 });
      expect(okRun(result)).toEqual({ exitCode: 0, output: "swap-probe\n" });
      expect(seen.swap).toBe("0");
      expect(seen.memory).toBe(String(SMALL_MEMORY.memoryBytes));
    }, 60_000);

    it("refuses more concurrent child processes than the task limit allows", async () => {
      const workspace = await temporaryRoot("sandbox-real-limits-pids-");
      // The subshell isolates Bash's fatal fork failure; the parent then counts the sleepers that are still alive.
      const command = "(for i in $(seq 40); do sleep 3 & done); n=0; for f in /proc/[0-9]*/comm; do read -r c < \"$f\" 2>/dev/null || continue; [ \"$c\" = sleep ] && n=$((n+1)); done; echo \"SLEEPS=$n\"; wait";
      const result = okRun(await runSandbox(workspace, command, { dependencies: { limits: SMALL_TASKS }, timeout: 30 }));
      expect(result.output).toContain("Resource temporarily unavailable");
      const match = /SLEEPS=(\d+)/.exec(result.output);
      expect(match).not.toBeNull();
      expect(Number(match![1])).toBeGreaterThan(0);
      expect(Number(match![1])).toBeLessThan(40);
    }, 60_000);

    it.skipIf(!pythonAvailable)("refuses more threads than the task limit allows", async () => {
      const workspace = await temporaryRoot("sandbox-real-limits-threads-");
      const script = [
        "import threading, time",
        "started = 0",
        "try:",
        "    for _ in range(40):",
        "        threading.Thread(target=time.sleep, args=(2,), daemon=True).start()",
        "        started += 1",
        "except RuntimeError as error:",
        "    print('thread-error', error)",
        "print('THREADS=' + str(started))",
      ].join("\n");
      const result = okRun(await runSandbox(workspace, `python3 - <<'PY'\n${script}\nPY`, { dependencies: { limits: SMALL_TASKS }, timeout: 30 }));
      const match = /THREADS=(\d+)/.exec(result.output);
      expect(match).not.toBeNull();
      expect(Number(match![1])).toBeLessThan(40);
    }, 60_000);

    it("bounds a large write into the workspace overlay", async () => {
      const workspace = await temporaryRoot("sandbox-real-limits-overlay-");
      await writeFile(join(workspace, "existing.txt"), "original");
      const before = await snapshot(workspace);
      const result = await runSandbox(workspace, "head -c 200000000 /dev/zero > big", { dependencies: { limits: SMALL_MEMORY }, timeout: 30 });
      expect(okRun(result).exitCode).not.toBe(0);
      expect(await snapshot(workspace)).toEqual(before);
      expect(existsSync(join(workspace, "big"))).toBe(false);
    }, 60_000);

    it.skipIf(!gitAvailable)("bounds a large write into the shared Git directory of a linked worktree", async () => {
      const { main, linked } = await linkedWorktree("sandbox-real-limits-gitdir-");
      const before = await snapshot(join(main, ".git"));
      const result = await runSandbox(linked, writeCommonDir(200_000_000, "big"), { dependencies: { limits: SMALL_MEMORY }, timeout: 30 });
      expect(okRun(result).exitCode).not.toBe(0);
      expect(result.output).toContain(`TARGET=${join(main, ".git")}`);
      expect(result.output).not.toContain("No such file or directory");
      expect(await snapshot(join(main, ".git"))).toEqual(before);
      expect(existsSync(join(main, ".git", "big"))).toBe(false);
    }, 60_000);

    it.skipIf(!gitAvailable)("bounds two medium writes together when each alone is below the limit", async () => {
      const { main, linked } = await linkedWorktree("sandbox-real-limits-combined-");
      const beforeWorkspace = await snapshot(linked);
      const beforeGit = await snapshot(join(main, ".git"));
      const command = `head -c 41943040 /dev/zero > workspace-big; ${writeCommonDir(41_943_040, "common-big")}`;
      const result = await runSandbox(linked, command, { dependencies: { limits: SMALL_MEMORY }, timeout: 30 });
      expect(okRun(result).exitCode).not.toBe(0);
      expect(result.output).toContain(`TARGET=${join(main, ".git")}`);
      expect(result.output).not.toContain("No such file or directory");
      expect(await snapshot(linked)).toEqual(beforeWorkspace);
      expect(await snapshot(join(main, ".git"))).toEqual(beforeGit);
    }, 60_000);

    it("keeps the temporary filesystem bound under the default limits", async () => {
      const workspace = await temporaryRoot("sandbox-real-limits-tmp-");
      const result = okRun(await runSandbox(workspace, "head -c 600000000 /dev/zero > /tmp/big 2>/tmp/head.err; echo write=$?; cat /tmp/head.err; echo still-running", { timeout: 60 }));
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("No space left on device");
      expect(result.output).toContain("still-running");
    }, 60_000);

    describe("fails closed before the payload runs", () => {
      it("refuses an untrusted systemd-run", async () => {
        const workspace = await temporaryRoot("sandbox-real-fail-systemd-run-");
        await expectUnavailable(workspace, { trusted: (path) => path !== SYSTEMD_RUN_PATH });
      }, 60_000);

      it("refuses an untrusted bubblewrap", async () => {
        const workspace = await temporaryRoot("sandbox-real-fail-bwrap-");
        await expectUnavailable(workspace, { trusted: (path) => path !== BWRAP_PATH });
      }, 60_000);

      it("refuses a missing runtime directory", async () => {
        const workspace = await temporaryRoot("sandbox-real-fail-runtime-");
        await expectUnavailable(workspace, { runtimeDir: () => undefined });
      }, 60_000);

      it("refuses a runtime directory without a systemd bus", async () => {
        const workspace = await temporaryRoot("sandbox-real-fail-bus-");
        const busless = await temporaryRoot("sandbox-real-fail-nobus-");
        await expectUnavailable(workspace, { runtimeDir: () => busless });
      }, 60_000);

      it("refuses an unapplied memory limit", async () => {
        const workspace = await temporaryRoot("sandbox-real-fail-memory-max-");
        await expectUnavailable(workspace, { readText: async (path) => path.endsWith("/memory.max") ? "max" : readFile(path, "utf8") });
      }, 60_000);

      it("refuses an unapplied task limit", async () => {
        const workspace = await temporaryRoot("sandbox-real-fail-pids-max-");
        await expectUnavailable(workspace, { readText: async (path) => path.endsWith("/pids.max") ? "max" : readFile(path, "utf8") });
      }, 60_000);

      it("refuses an unreadable cgroup mount table", async () => {
        const workspace = await temporaryRoot("sandbox-real-fail-mounts-");
        await expectUnavailable(workspace, {
          readText: async (path) => { if (path.endsWith("/mounts")) throw new Error("unreadable mount table"); return readFile(path, "utf8"); },
        });
      }, 60_000);
    });

    it("rejects after a successful probe when the verified precondition disappears", async () => {
      const workspace = await temporaryRoot("sandbox-real-lost-precondition-");
      await expect(probeSandbox(workspace)).resolves.toBe(true);
      const marker = `PAYLOAD-RAN-${Math.random().toString(36).slice(2)}`;
      const result = await runSandbox(workspace, `echo ${marker}`, {
        dependencies: { readText: async (path) => path.endsWith("/memory.max") ? "max" : readFile(path, "utf8") },
        timeout: 30,
      });
      expect(failedRun(result).message).toBe(SANDBOX_UNAVAILABLE_MESSAGE);
      expect(result.output).not.toContain(marker);
    }, 60_000);

    it("isolates concurrent calls with different limits and an abort", async () => {
      const workspace = await temporaryRoot("sandbox-real-limits-parallel-");
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), 700);
      const [allocated, normal, aborted, fourth] = await Promise.all([
        runSandbox(workspace, BASH_MEMORY_HOG, { dependencies: { limits: SMALL_MEMORY }, timeout: 30 }),
        runSandbox(workspace, "sleep 2; echo ok", { timeout: 30 }),
        runSandbox(workspace, "sleep 30", { timeout: 30, signal: controller.signal }),
        runSandbox(workspace, "sleep 1; echo fourth-ok", { timeout: 30 }),
      ]);
      clearTimeout(abortTimer);
      expect(okRun(allocated).exitCode).not.toBe(0);
      expect(okRun(normal)).toEqual({ exitCode: 0, output: "ok\n" });
      expect(failedRun(aborted).message).toBe("aborted");
      expect(okRun(fourth)).toEqual({ exitCode: 0, output: "fourth-ok\n" });
    }, 60_000);

    describe("scope lifecycle", () => {
      it.skipIf(!systemctlAvailable)("ends a running command on abort and collects its scope", async () => {
        const workspace = await temporaryRoot("sandbox-real-lifecycle-abort-");
        const controller = new AbortController();
        const abortTimer = setTimeout(() => controller.abort(), 700);
        const started = Date.now();
        const result = await runSandbox(workspace, "sleep 30", { timeout: 30, signal: controller.signal });
        clearTimeout(abortTimer);
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(failedRun(result).message).toBe("aborted");
        await expectNoShellUnits();
      }, 60_000);

      it.skipIf(!systemctlAvailable)("ends a running command on timeout and collects its scope", async () => {
        const workspace = await temporaryRoot("sandbox-real-lifecycle-timeout-");
        const started = Date.now();
        const result = await runSandbox(workspace, "sleep 30", { timeout: 1 });
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(failedRun(result).message).toBe("timeout:1");
        await expectNoShellUnits();
      }, 60_000);

      it.skipIf(!systemctlAvailable)("does not hang on a background child that holds stdout open", async () => {
        const workspace = await temporaryRoot("sandbox-real-lifecycle-stdout-");
        const started = Date.now();
        const result = await runSandbox(workspace, "(sleep 30 &) ; echo started", { timeout: 2 });
        expect(Date.now() - started).toBeLessThan(10_000);
        if (result.ok) {
          expect(okRun(result)).toEqual({ exitCode: 0, output: "started\n" });
        } else {
          expect(result.error.message).toBe("timeout:2");
        }
        await expectNoShellUnits();
      }, 60_000);
    });
  });
});

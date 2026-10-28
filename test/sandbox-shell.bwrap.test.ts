/**
 * The shell sandbox against the real bubblewrap, so the arguments of ADR 0013 are proven rather than assumed.
 * Opt-in by capability: every test is skipped unless `/usr/bin/bwrap` is a trusted system binary and a probe run
 * through the sandbox succeeds (unprivileged user namespaces, overlay support), and the Git tests also need `git`.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { createSandboxedBashOperations, probeSandbox, sandboxBinaryTrusted } from "../src/sandbox-shell.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

const run = promisify(execFile);
const probeRoot = await temporaryRoot("sandbox-real-probe-");
const available = sandboxBinaryTrusted() && await probeSandbox(probeRoot);
const gitAvailable = available && existsSync("/usr/bin/git");

async function sh(workspace: string, command: string): Promise<{ exitCode: number | null; output: string }> {
  let output = "";
  const { exitCode } = await createSandboxedBashOperations(workspace).exec(command, workspace, {
    onData: (data) => { output += data.toString(); },
    env: { ...process.env, PI_SESSION_ID: "leak-probe" },
    timeout: 30,
  });
  return { exitCode, output };
}

const git = (cwd: string, ...args: string[]) =>
  run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd });

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
});

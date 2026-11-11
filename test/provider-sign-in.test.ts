import { execFile, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { PI_SIGN_IN_STDIO, PI_SIGN_OUT_STDIO, bundledPiCli, runBundledPi, type BundledPiOptions } from "../src/provider-sign-in.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
const temporaryDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix)); directories.push(directory); return directory;
};

type Spawn = NonNullable<BundledPiOptions["spawn"]>;
/** A spawn that records its arguments and ends the child on the next tick, with exit status 0 or an `error` event. */
function fakeSpawn(end: "exit" | "error", onSpawn: () => void = () => {}): { spawn: Spawn; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const spawn = ((...args: unknown[]) => {
    calls.push(args);
    onSpawn();
    const child = new EventEmitter();
    setImmediate(() => { if (end === "exit") child.emit("exit", 0, null); else child.emit("error", new Error("spawn failed")); });
    return child as unknown as ChildProcess;
  }) as unknown as Spawn;
  return { spawn, calls };
}
const fakeCli = async (): Promise<string> => "/fake/cli.js";
const missingCli = async (): Promise<string> => { throw new Error("missing"); };

describe("runBundledPi", () => {
  it("joins Pi's sign-in stdout to stderr and gives its sign-out no streams", async () => {
    expect(PI_SIGN_IN_STDIO).toEqual(["inherit", 2, "inherit"]);
    expect(PI_SIGN_OUT_STDIO).toEqual(["ignore", "ignore", "ignore"]);
    const { spawn, calls } = fakeSpawn("exit");
    expect(await runBundledPi(["auth", "login", "openai"], "terminal", { cli: fakeCli, home: "/fake/home", spawn })).toBe(0);
    expect(await runBundledPi(["auth", "logout", "openai"], "silent", { cli: fakeCli, home: "/fake/home", spawn })).toBe(0);
    expect(await runBundledPi(["auth", "logout", "openai"], "silent", { cli: fakeCli, spawn })).toBe(0);
    expect(calls[0]).toEqual([process.execPath, ["/fake/cli.js", "auth", "login", "openai"], { cwd: "/fake/home", stdio: ["inherit", 2, "inherit"] }]);
    expect(calls[1]).toEqual([process.execPath, ["/fake/cli.js", "auth", "logout", "openai"], { cwd: "/fake/home", stdio: ["ignore", "ignore", "ignore"] }]);
    // Without a home, Pi runs in the account's home directory, never in the caller's working directory.
    expect(calls[2]![2]).toEqual({ cwd: userInfo().homedir, stdio: ["ignore", "ignore", "ignore"] });
    for (const call of calls) expect(call[2]).not.toHaveProperty("env");
  });

  it("returns the child's exit status, and 1 when it ends by a signal or cannot start", async () => {
    const dir = await temporaryDirectory("pi-sign-in-child-");
    const script = join(dir, "child.mjs");
    await writeFile(script, 'const [, , a, b, id] = process.argv; if (a !== "auth" || b !== "login") process.exit(9); if (id === "signal") process.kill(process.pid, "SIGKILL"); process.exit(id === "ok" ? 0 : 3);\n');
    const cli = async (): Promise<string> => script;
    expect(await runBundledPi(["auth", "login", "ok"], "silent", { cli, home: dir })).toBe(0);
    expect(await runBundledPi(["auth", "login", "other"], "silent", { cli, home: dir })).toBe(3);
    expect(await runBundledPi(["auth", "login", "signal"], "silent", { cli, home: dir })).toBe(1);
    expect(await runBundledPi(["auth", "login", "ok"], "silent", { cli: missingCli })).toBe(1);
    expect(await runBundledPi(["auth", "login", "ok"], "silent", { cli: fakeCli, spawn: fakeSpawn("error").spawn })).toBe(1);
  });

  it("ignores SIGINT only while the child runs", async () => {
    const before = process.listenerCount("SIGINT");
    let during = -1;
    const count = (): void => { during = process.listenerCount("SIGINT"); };
    expect(await runBundledPi(["auth", "login", "openai"], "terminal", { cli: fakeCli, spawn: fakeSpawn("exit", count).spawn })).toBe(0);
    expect(during).toBe(before + 1);
    expect(process.listenerCount("SIGINT")).toBe(before);
    during = -1;
    expect(await runBundledPi(["auth", "login", "openai"], "terminal", { cli: fakeCli, spawn: fakeSpawn("error", count).spawn })).toBe(1);
    expect(during).toBe(before + 1);
    expect(process.listenerCount("SIGINT")).toBe(before);
    const throwing = (() => { throw new Error("spawn failed"); }) as unknown as Spawn;
    expect(await runBundledPi(["auth", "login", "openai"], "terminal", { cli: fakeCli, spawn: throwing })).toBe(1);
    expect(process.listenerCount("SIGINT")).toBe(before);
    let added = 0;
    const watch = (event: string | symbol): void => { if (event === "SIGINT") added += 1; };
    process.on("newListener", watch);
    try {
      const unused = fakeSpawn("exit");
      expect(await runBundledPi(["auth", "login", "openai"], "terminal", { cli: missingCli, spawn: unused.spawn })).toBe(1);
      expect(unused.calls).toEqual([]);
    } finally { process.removeListener("newListener", watch); }
    expect(added).toBe(0);
  });
});

describe("bundledPiCli", () => {
  it("resolves the pi executable that the pinned SDK package declares", async () => {
    const cli = await bundledPiCli();
    expect(isAbsolute(cli)).toBe(true);
    expect(cli).toMatch(/[\\/]@earendil-works[\\/]pi-coding-agent[\\/]dist[\\/]bundle[\\/]cli\.js$/);
    expect(existsSync(cli)).toBe(true);
  });

  it("refuses a package whose declared pi leaves the package directory", async () => {
    const root = await temporaryDirectory("pi-sign-in-package-");
    const pkg = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
    await mkdir(join(pkg, "dist"), { recursive: true });
    await writeFile(join(pkg, "dist", "index.js"), "");
    const entry = (): string => pathToFileURL(join(pkg, "dist", "index.js")).href;
    const declare = (bin: unknown): Promise<void> => writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin }));
    await declare({ pi: "../../escape.js" });
    await expect(bundledPiCli(entry)).rejects.toThrow();
    await declare({ pi: join(root, "escape.js") });
    await expect(bundledPiCli(entry)).rejects.toThrow();
    await declare({ other: "dist/cli.js" });
    await expect(bundledPiCli(entry)).rejects.toThrow();
    await declare("dist/cli.js");
    await expect(bundledPiCli(entry)).rejects.toThrow();
    // Control: a declared pi inside the package resolves to its absolute path.
    await declare({ pi: "dist/cli.js" });
    await expect(bundledPiCli(entry)).resolves.toBe(join(pkg, "dist", "cli.js"));
    // A resolved entry with no such package.json above it also rejects.
    await mkdir(join(root, "stray"));
    await writeFile(join(root, "stray", "index.js"), "");
    await expect(bundledPiCli(() => pathToFileURL(join(root, "stray", "index.js")).href)).rejects.toThrow();
  });

  it("keeps the bundled CLI's auth login and logout command line", async () => {
    const tmp = await temporaryDirectory("pi-sign-in-help-");
    const { stdout } = await execFileAsync(process.execPath, [await bundledPiCli(), "auth", "--help"],
      { cwd: tmp, env: { ...process.env, HOME: tmp, PI_CODING_AGENT_DIR: join(tmp, "agent"), PI_OFFLINE: "1" }, timeout: 30_000 });
    expect(stdout).toContain("auth login <provider>");
    expect(stdout).toMatch(/auth login <provider>[^\n]*--no-browser/);
    expect(stdout).toContain("auth logout <provider>");
    expect(existsSync(join(tmp, "agent", "auth.json"))).toBe(false);
  }, 40_000);
});

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

// The maintainer script is plain ESM without declarations; the tests use its exports untyped on purpose.
const scriptUrl = new URL("../scripts/multi-session-acceptance.mjs", import.meta.url);
const scriptPath = fileURLToPath(scriptUrl);
const h: Record<string, any> = await import(/* @vite-ignore */ scriptUrl.href);
const fixtureDir = fileURLToPath(new URL("./fixtures/multi-session-acceptance/", import.meta.url));
const driverPath = join(fixtureDir, "supervise-driver.mjs");
const stubbornClient = join(fixtureDir, "stubborn-client.mjs");
const cliDriver = join(fixtureDir, "cli-driver.mjs");
const setupStub = join(fixtureDir, "setup-stub.mjs");
// The harness reads /proc and refuses to run elsewhere, so its supervision and run paths are tested on Linux only.
const notLinux = process.platform !== "linux";

afterAll(removeTemporaryRoots);

// Safety net: a launch that a test expects to be refused must never reach a real client or a model. Stand-ins
// named `claude` and `codex` come first on PATH for the whole file; tests that need a working client put their own before them.
let pathBeforeGuard: string | undefined;
beforeAll(async () => {
  const guard = join(await temporaryRoot("msa-guard-"), "bin");
  mkdirSync(guard, { recursive: true });
  for (const name of ["claude", "codex"]) writeFileSync(join(guard, name), "#!/bin/sh\nexit 97\n", { mode: 0o755 });
  pathBeforeGuard = process.env.PATH;
  process.env.PATH = `${guard}:${pathBeforeGuard ?? ""}`;
});
afterAll(() => { if (pathBeforeGuard === undefined) delete process.env.PATH; else process.env.PATH = pathBeforeGuard; });

interface Recorded { pid: number; start: string }
const readState = (path: string): { leader: Recorded; children: Recorded[] } => JSON.parse(readFileSync(path, "utf8"));
const recordedProcesses = (path: string): Recorded[] => { const state = readState(path); return [state.leader, ...state.children]; };
const stillAlive = (list: Recorded[]): Recorded[] => list.filter((p) => h.alive(p));
const killAll = (list: Recorded[]): void => { for (const p of stillAlive(list)) { try { process.kill(p.pid, "SIGKILL"); } catch { /* gone */ } } };

/** Spawns a Node child and resolves with its exit code, or null when it had to be killed after `limitMs`. */
function runNode(args: string[], options: { env?: NodeJS.ProcessEnv; limitMs: number }): Promise<{ code: number | null; stdout: string; stderr: string; wallMs: number }> {
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], env: options.env ?? process.env });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const watchdog = setTimeout(() => child.kill("SIGKILL"), options.limitMs);
    child.on("close", (code) => { clearTimeout(watchdog); done({ code, stdout, stderr, wallMs: Date.now() - started }); });
  });
}

// ---- D1: bounded process completion ------------------------------------------------------------
describe.skipIf(notLinux)("bounded supervision of the controller", () => {
  const leftovers: Recorded[] = [];
  afterEach(() => { killAll(leftovers.splice(0)); });

  async function drive(mode: string) {
    const dir = await temporaryRoot(`msa-${mode}-`);
    const result = await runNode([driverPath, mode, dir], { limitMs: 20_000 });
    const statePath = join(dir, "state.json");
    const processes = existsSync(statePath) ? recordedProcesses(statePath) : [];
    leftovers.push(...processes);
    // exit code 0 within the limit means the driver ended by itself: no timer, interval, listener or pipe kept it alive
    expect(result.code, `driver stderr: ${result.stderr}`).toBe(0);
    return { summary: JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}"), processes, wallMs: result.wallMs };
  }

  it("ends a client that ignores SIGTERM and whose descendants keep stdout open, and leaves none of its processes", async () => {
    const { summary, processes, wallMs } = await drive("ignore-term");
    expect(processes).toHaveLength(3);
    expect(summary.timedOut).toBe(true);
    expect(summary.spawnFailed).toBe(false);
    expect(summary.harnessAborted).toBe(false);
    expect(summary.unterminated).toBe(false);
    expect(summary.exitCode).toBe("SIGKILL");
    // 2.5 s timeout + 0.6 s grace, plus scheduling slack; far below the 20 s watchdog of the driver
    expect(summary.elapsedMs).toBeLessThan(8_000);
    expect(wallMs).toBeLessThan(15_000);
    // The detached descendant is found only through the recorded process tree.
    expect(summary.roles["client-descendant"]).toBe(2);
    // PID and start time: a reused PID with another start time does not count as alive.
    expect(stillAlive(processes)).toEqual([]);
  }, 40_000);

  it("kills a descendant that outlives a client which exited on SIGTERM", async () => {
    const { summary, processes } = await drive("exit-on-term");
    expect(summary.timedOut).toBe(true);
    expect(summary.exitCode).toBe("SIGTERM");
    expect(stillAlive(processes)).toEqual([]);
  }, 40_000);

  it("bounds the output drain when an inherited pipe stays open after a normal exit", async () => {
    const { summary, processes } = await drive("leaks-pipe");
    expect(summary.exitCode).toBe(0);
    expect(summary.timedOut).toBe(false);
    expect(summary.drainDestroyed).toBe(true);
    expect(summary.output).toBe("ready\n");
    expect(summary.elapsedMs).toBeLessThan(8_000);
    // A normal exit is not killed by the supervisor: the leftover is reported and removed by the caller.
    expect(stillAlive(processes).length).toBe(1);
  }, 40_000);

  it("classifies a spawn failure", async () => {
    const { summary } = await drive("spawn-failure");
    expect(summary.spawnFailed).toBe(true);
    expect(summary.timedOut).toBe(false);
    expect(summary.exitCode).toBeNull();
    expect(summary.elapsedMs).toBeLessThan(2_000);
  }, 40_000);

  it("classifies a signal delivered to the harness and terminates the own process group with the same escalation", async () => {
    const { summary, processes } = await drive("abort");
    expect(summary.harnessAborted).toBe(true);
    expect(summary.abortSignal).toBe("SIGTERM");
    expect(summary.timedOut).toBe(false);
    expect(summary.exitCode).toBe("SIGKILL");
    expect(stillAlive(processes)).toEqual([]);
  }, 40_000);

  it("leaves no pipe or process handle behind in the calling process", async () => {
    const count = (names: string[]) => process.getActiveResourcesInfo().filter((name) => names.includes(name)).length;
    // Timers of the test runner and of this loop are indistinguishable here; the driver tests cover them by the process ending by itself.
    const watched = ["PipeWrap", "ProcessWrap"];
    const before = count(watched);
    const result = await h.superviseProcess({ file: join(await temporaryRoot("msa-handles-"), "no-such-client"), budgets: { timeoutMs: 1_000 }, signals: new EventEmitter() });
    expect(result.spawnFailed).toBe(true);
    // libuv closes the pipe and process handles on a later loop turn; they must be gone shortly, with no timer left
    for (let waited = 0; waited < 1_000 && count(watched) > before; waited += 20) await new Promise((done) => setTimeout(done, 20));
    // handles of earlier tests may still be closing, so the count can only fall
    expect(count(watched)).toBeLessThanOrEqual(before);
  });

  it("registers its signal listeners on the given source and removes them", async () => {
    const signals = new EventEmitter();
    const dir = await temporaryRoot("msa-listeners-");
    const result = await h.superviseProcess({ file: process.execPath, args: [stubbornClient, join(dir, "state.json"), "leaks-pipe"], cwd: dir, budgets: { timeoutMs: 10_000, drainMs: 200 }, signals });
    leftovers.push(...recordedProcesses(join(dir, "state.json")));
    expect(result.exitCode).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  }, 20_000);

  it("keeps a server and a fixture that an earlier sweep established when a later sweep can no longer read them", async () => {
    // PIDs above the kernel's maximum never exist, so nothing here is alive or killed.
    const server = { pid: 4_194_399, ppid: 1, pgrp: 1, state: "S", start: "7", comm: "node", fixture: undefined, role: "server" };
    const sleeper = { pid: 4_194_398, ppid: 1, pgrp: 1, state: "S", start: "8", comm: "sleep", fixture: "wait", role: "client-descendant" };
    let sweeps = 0;
    // From the second sweep on, both look like exiting or zombie processes: no command line, environment or cwd.
    const scan = () => (sweeps++ === 0 ? [server, sleeper] : [{ ...server, state: "Z", role: "client-descendant" }, { ...sleeper, state: "Z", fixture: undefined }]);
    const result = await h.superviseProcess({ file: process.execPath, args: ["-e", "setTimeout(() => {}, 300)"], budgets: { timeoutMs: 10_000, intervalMs: 20 }, scan, signals: new EventEmitter() });
    expect(sweeps).toBeGreaterThan(2);
    expect(result.seen.get("4194399:7")).toMatchObject({ role: "server", state: "Z" });
    expect(result.seen.get("4194398:8")).toMatchObject({ role: "client-descendant", fixture: "wait" });
    expect(h.mergeSighting(undefined, server)).toBe(server);
  }, 20_000);

  it("keeps the ownership of a descendant that outlives the client and is then found only by its working directory", () => {
    const worker = { pid: 4_194_397, ppid: 4_194_396, pgrp: 4_194_396, state: "S", start: "9", comm: "sleep", fixture: "wait", role: "client-descendant" };
    const reparented = h.mergeSighting(worker, { ...worker, ppid: 1, role: "run-cwd" });
    expect(reparented).toMatchObject({ role: "client-descendant", ppid: 1, fixture: "wait" });
    // A process seen first only by its working directory and later inside the client's tree becomes the run's own.
    expect(h.mergeSighting({ ...worker, role: "run-cwd" }, worker).role).toBe("client-descendant");
  });

  it("takes a PID for the client only with the client's start time", async () => {
    const dir = await temporaryRoot("msa-root-");
    const info = { entry: join(dir, "no-such-entry.js") };
    const self = h.procInfo(process.pid);
    // This test process stands in for the client: with its own start time it is the root of the run's tree.
    expect(h.snapshot(process.pid, dir, info, self.start).find((p: Recorded) => p.pid === process.pid)?.role).toBe("client");
    // A reused PID has another start time: neither that process nor anything below it belongs to the run.
    expect(h.snapshot(process.pid, dir, info, `${self.start}0`).filter((p: { role: string }) => p.role === "client" || p.role === "client-descendant")).toEqual([]);
  });
});

describe("budget validation", () => {
  it("rejects --timeout-min values that are not a finite number above 0 within the bound", () => {
    expect(h.parseTimeoutMinutes(undefined)).toBe(25);
    expect(h.parseTimeoutMinutes("0.5")).toBe(0.5);
    expect(h.parseTimeoutMinutes("180")).toBe(180);
    for (const bad of ["", "0", "-1", "NaN", "Infinity", "1e9", "0x10", "abc", "181", "1 2", ".5"]) {
      expect(() => h.parseTimeoutMinutes(bad), bad).toThrow(h.HarnessFailure);
    }
  });

  it("rejects every internal budget that is not an integer inside its range", () => {
    expect(h.validateBudgets({ timeoutMs: 1_000 })).toMatchObject({ timeoutMs: 1_000, graceMs: 10_000 });
    for (const bad of [{ timeoutMs: 0 }, { timeoutMs: Number.NaN }, { timeoutMs: Infinity }, { timeoutMs: 2 ** 31 }, { timeoutMs: 1.5 },
      { graceMs: -1 }, { killWaitMs: Number.NaN }, { drainMs: "5" }, { intervalMs: 0 }]) {
      expect(() => h.validateBudgets({ timeoutMs: 1_000, ...bad }), JSON.stringify(bad)).toThrow(h.HarnessFailure);
    }
  });
});

// ---- D2: changes against a fixed fixture baseline ------------------------------------------------
const SLUG_OK = "export function slugify(text) {\n  return text.toLowerCase().replace(/[^a-z0-9]+/g, \"-\").replace(/^-+|-+$/g, \"\");\n}\n";
const STATS_OK = "export function mean(values) {\n  if (values.length === 0) throw new RangeError(\"empty\");\n  return values.reduce((sum, value) => sum + value, 0) / values.length;\n}\nexport function median(values) {\n  if (values.length === 0) throw new RangeError(\"empty\");\n  const sorted = [...values].sort((a, b) => a - b);\n  const mid = sorted.length >> 1;\n  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;\n}\n";
const RANGE_OK = "export function range(start, end, step = 1) {\n  if (step <= 0) throw new RangeError(\"step\");\n  const out = [];\n  for (let value = start; value < end; value += step) out.push(value);\n  return out;\n}\n";

async function fixtureWithBaseline(task: string) {
  const dir = join(await temporaryRoot(`msa-fixture-${task}-`), "fixture");
  mkdirSync(dir, { recursive: true });
  h.writeFixture(dir, h.FIXTURES[task]);
  return { dir, baseline: h.captureBaseline(dir) };
}
const compare = (dir: string, baseline: unknown, task: string) => h.compareToBaseline(dir, baseline, h.ALLOWED_CHANGES[task]);
const commitAll = (dir: string, message: string) => { h.git(dir, "add", "-A"); h.git(dir, "commit", "-q", "-m", message); };

describe("changes against the fixed baseline", () => {
  it("stores the initial commit and a manifest without .git, outside the workspace", async () => {
    const { dir, baseline } = await fixtureWithBaseline("slug");
    expect(baseline.commit).toBe(h.git(dir, "rev-parse", "HEAD").trim());
    expect(baseline.manifest.map((entry: { path: string }) => entry.path)).toEqual(["package.json", "src/slug.js", "test/slug.test.js"]);
    expect(baseline.manifest[0]).toMatchObject({ type: "file", mode: expect.any(Number), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(JSON.stringify(baseline)).not.toContain(".git/");
  });

  it("accepts the allowed files, uncommitted, staged or committed", async () => {
    const { dir, baseline } = await fixtureWithBaseline("slug");
    writeFileSync(join(dir, "src", "slug.js"), SLUG_OK);
    writeFileSync(join(dir, "HANDSHAKE.txt"), "handshake x\n");
    expect(compare(dir, baseline, "slug")).toMatchObject({ ok: true, disallowed: 0 });
    h.git(dir, "add", "src/slug.js");
    expect(compare(dir, baseline, "slug").ok).toBe(true);
    commitAll(dir, "worker commit of allowed files");
    const committed = compare(dir, baseline, "slug");
    expect(committed.ok).toBe(true);
    expect([...committed.changed].sort()).toEqual(["HANDSHAKE.txt", "src/slug.js"]);
  });

  it("rejects a committed change to a file that is not allowed, even when the tree and index are restored to the baseline", async () => {
    const { dir, baseline } = await fixtureWithBaseline("slug");
    writeFileSync(join(dir, "package.json"), "{ \"name\": \"tampered\" }\n");
    commitAll(dir, "tamper");
    // working tree and index back to the baseline; only HEAD still differs
    h.git(dir, "checkout", baseline.commit, "--", "package.json");
    expect(h.git(dir, "diff", "--name-only", baseline.commit)).toBe("");
    expect(h.git(dir, "diff", "--cached", "--name-only", baseline.commit)).toBe("");
    const result = compare(dir, baseline, "slug");
    expect(result.ok).toBe(false);
    expect(result.sources).toEqual({ workingTree: 0, index: 0, head: 1 });
    expect([...result.changed]).toEqual(["package.json"]);
  });

  it("rejects a clean committed change to a disallowed file in the oracle although the worker's own tests and the independent checks pass", async () => {
    const run = await buildRun();
    const dir = join(run.controller("claude"), "fixtures", "slug");
    writeFileSync(join(dir, "src", "slug.js"), SLUG_OK);
    writeFileSync(join(run.controller("claude"), "fixtures", "stats", "src", "stats.js"), STATS_OK);
    writeFileSync(join(dir, "package.json"), "{ \"name\": \"fixture-slug\", \"private\": true, \"type\": \"module\", \"scripts\": { \"test\": \"node --test\", \"extra\": \"true\" } }\n");
    commitAll(dir, "worker commit");
    expect(h.git(dir, "status", "--porcelain")).toBe("");
    const out = h.oracle(run.controller("claude"), "parallel", run.info, {}, run.baselineOf("claude"));
    expect(out.slug).toMatchObject({ onlyAllowedChanges: false, testsPass: true, businessChecks: true });
    expect(out.stats).toMatchObject({ onlyAllowedChanges: true, testsPass: true, businessChecks: true });
    expect(JSON.stringify(out)).not.toContain("package.json");
  });

  it("rejects an untracked extra file, a deletion, a rename and a mode change", async () => {
    const { dir, baseline } = await fixtureWithBaseline("range");
    writeFileSync(join(dir, "src", "range.js"), RANGE_OK);
    expect(compare(dir, baseline, "range").ok).toBe(true);

    writeFileSync(join(dir, "notes.txt"), "extra");
    expect(compare(dir, baseline, "range")).toMatchObject({ ok: false, disallowed: 1 });
    rmSync(join(dir, "notes.txt"));

    rmSync(join(dir, "package.json"));
    expect(compare(dir, baseline, "range")).toMatchObject({ ok: false, disallowed: 1 });
    h.git(dir, "checkout", "--", "package.json");

    renameSync(join(dir, "test", "range.test.js"), join(dir, "test", "renamed.test.js"));
    const renamed = compare(dir, baseline, "range");
    expect(renamed.ok).toBe(false);
    expect([...renamed.changed].sort()).toEqual(["src/range.js", "test/range.test.js", "test/renamed.test.js"]);
    renameSync(join(dir, "test", "renamed.test.js"), join(dir, "test", "range.test.js"));

    chmodSync(join(dir, "package.json"), 0o755);
    expect(compare(dir, baseline, "range")).toMatchObject({ ok: false, disallowed: 1 });
  });

  it("handles file names with spaces and newlines in the working tree, the index and HEAD", async () => {
    const { dir, baseline } = await fixtureWithBaseline("range");
    const odd = "odd name\nwith newline.txt";
    writeFileSync(join(dir, odd), "x");
    const untracked = compare(dir, baseline, "range");
    expect(untracked.ok).toBe(false);
    expect([...untracked.changed]).toEqual([odd]);
    h.git(dir, "add", "-A");
    expect(compare(dir, baseline, "range").sources.index).toBe(1);
    h.git(dir, "commit", "-q", "-m", "odd");
    rmSync(join(dir, odd));
    const committed = compare(dir, baseline, "range");
    expect(committed.ok).toBe(false);
    expect([...committed.changed]).toEqual([odd]);
    expect(committed.sources.head).toBe(1);
  });

  it("treats a missing or unreadable baseline, .git or base commit as a failure", async () => {
    const { dir, baseline } = await fixtureWithBaseline("range");
    writeFileSync(join(dir, "src", "range.js"), RANGE_OK);
    expect(compare(dir, undefined, "range")).toMatchObject({ ok: false, error: "baselineUnreadable" });
    expect(compare(dir, { ...baseline, commit: "--output=x" }, "range")).toMatchObject({ ok: false, error: "baselineUnreadable" });
    expect(compare(dir, { ...baseline, commit: "0".repeat(40) }, "range")).toMatchObject({ ok: false, error: "baseCommitMissing" });
    rmSync(join(dir, ".git"), { recursive: true, force: true });
    expect(compare(dir, baseline, "range")).toMatchObject({ ok: false, error: "gitMissing" });
    // a fresh repository without the base commit must not pass either
    h.git(dir, "init", "-q");
    expect(compare(dir, baseline, "range")).toMatchObject({ ok: false, error: "baseCommitMissing" });
  });

  it("fails the independent business checks for plausible wrong implementations", async () => {
    const wrong: Array<[string, string, string]> = [
      ["slug", "src/slug.js", "export function slugify(text) { return text.toLowerCase().replace(/[^a-z0-9]+/g, \"-\"); }\n"],
      ["stats", "src/stats.js", "export function mean(v) { return v.reduce((a, b) => a + b, 0) / v.length; }\nexport function median(v) { v.sort(); return v[v.length >> 1]; }\n"],
      ["range", "src/range.js", "export function range(start, end, step = 1) { const out = []; for (let v = start; v <= end; v += step) out.push(v); return out; }\n"],
    ];
    for (const [task, file, source] of wrong) {
      const { dir } = await fixtureWithBaseline(task);
      expect(h.runBusinessChecks(task, dir), `${task} before implementation`).toBe(false);
      writeFileSync(join(dir, file), source);
      expect(h.runBusinessChecks(task, dir), `${task} wrong`).toBe(false);
    }
    for (const [task, file, source] of [["slug", "src/slug.js", SLUG_OK], ["stats", "src/stats.js", STATS_OK], ["range", "src/range.js", RANGE_OK]] as const) {
      const { dir } = await fixtureWithBaseline(task);
      writeFileSync(join(dir, file), source);
      expect(h.runBusinessChecks(task, dir), `${task} correct`).toBe(true);
    }
  }, 60_000);

  it("covers the documented extra cases", () => {
    const cases = (task: string) => h.BUSINESS_CHECKS[task].cases as Array<{ fn: string; args: unknown[]; returns?: unknown }>;
    expect(cases("slug")).toContainEqual({ fn: "slugify", args: ["  Leading and trailing  "], returns: "leading-and-trailing" });
    expect(cases("stats")).toContainEqual({ fn: "median", args: [[5]], returns: 5 });
    expect(cases("stats")).toContainEqual({ fn: "median", args: [[1, 2, 3, 4, 5, 6]], returns: 3.5 });
    expect(cases("range")).toContainEqual({ fn: "range", args: [0, 10, 5], returns: [0, 5] });
    expect(cases("range")).toContainEqual({ fn: "range", args: [3, 1], returns: [] });
  });
});

// ---- synthetic run layout ------------------------------------------------------------------------
const EXTENSION = "pi-test-ext";
const put = (path: string, content: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, content); };
/**
 * A synthetic prepared run. `home` and `agentDir` live inside the temporary root, so no test reads the operator's
 * home or Pi directory; `context` is what the harness needs to recompute the bound resources.
 */
async function buildRun({ extensions = false }: { extensions?: boolean } = {}) {
  const root = realpathSync(await temporaryRoot("msa-run-"));
  const home = join(root, "home");
  const agentDir = join(root, "pi-agent");
  const codexHome = join(root, "codex-home");
  const etc = join(root, "etc-codex-skills");
  mkdirSync(home, { recursive: true });
  const candidate = join(root, "candidate");
  const run = join(root, "run");
  const priv = join(run, "private");
  put(join(candidate, "package.json"), "{ \"version\": \"0.0.0-test\" }\n");
  put(join(candidate, "dist", "main.js"), "// stub entry\n");
  put(join(candidate, "dist", "other.js"), "// stub module\n");
  for (const name of ["pi-session-orchestration", "pi-session-implementation", "pi-session-review"]) put(join(candidate, "skills", name, "SKILL.md"), `# ${name}\n`);
  if (extensions) {
    put(join(agentDir, "npm", "package.json"), `{ "dependencies": { "${EXTENSION}": "1.0.0" } }\n`);
    put(join(agentDir, "npm", "package-lock.json"), "{ \"lockfileVersion\": 3 }\n");
    put(join(agentDir, "npm", "node_modules", EXTENSION, "package.json"), `{ "name": "${EXTENSION}", "version": "1.0.0", "pi": { "extensions": ["index.js"] } }\n`);
    put(join(agentDir, "npm", "node_modules", EXTENSION, "index.js"), "export default () => {};\n");
    put(join(agentDir, "npm", "node_modules", "dep", "index.js"), "export const dep = 1;\n");
  }
  put(join(priv, "config.json"), "{ \"workspaces\": {} }\n");
  put(join(priv, "claude-mcp.json"), "{ \"mcpServers\": {} }\n");
  put(join(priv, "skills", "acceptance-handshake", "SKILL.md"), "# handshake\n");
  for (const dir of ["transcripts", "results", "reanalyses"]) mkdirSync(join(priv, dir), { recursive: true });
  for (const client of ["claude", "codex"]) {
    for (const task of Object.keys(h.FIXTURES)) {
      const dir = join(run, `controller-${client}`, "fixtures", task);
      mkdirSync(dir, { recursive: true });
      h.writeFixture(dir, h.FIXTURES[task]);
      mkdirSync(join(priv, "baselines", client), { recursive: true });
      writeFileSync(join(priv, "baselines", client, `${task}.json`), `${JSON.stringify(h.captureBaseline(dir), null, 2)}\n`);
    }
  }
  put(join(run, "controller-claude", ".claude", "skills", "pi-session-orchestration", "SKILL.md"), "# pi-session-orchestration\n");
  mkdirSync(join(run, "controller-codex", ".agents", "skills"), { recursive: true });
  symlinkSync(join(candidate, "skills", "pi-session-orchestration"), join(run, "controller-codex", ".agents", "skills", "pi-session-orchestration"));
  const token = "ACCEPTANCE-TOKEN-0123456789";
  const extensionList = extensions ? [{ name: EXTENSION, version: "1.0.0" }] : [];
  const context = { home, agentDir, codexHome, etcCodexSkills: etc, ancestorBoundary: root, extensions: extensionList };
  const info = {
    runId: "skills-test", candidate, entry: join(candidate, "dist", "main.js"), node: process.execPath, token, version: "0.0.0-test",
    sourceClean: true, entrySha256: "x", distSha256: h.distTreeSha256(candidate), harnessSha256: h.HARNESS_SHA256, configFingerprint: "sha256:test",
    claudeSkillSetup: { exitCode: 0, codes: [], installedAsCopy: true, matchesShipped: true },
    profile: { from: "p", provider: "synthetic", model: "m", thinkingLevel: "off" }, extensions: extensionList, agentDir, codexHome, preparedAt: new Date().toISOString(),
    controllerSkills: h.controllerSkillRecord(run, candidate),
    resources: h.computeResources(run, candidate, context),
  };
  writeFileSync(join(priv, "run.json"), `${JSON.stringify(info, null, 2)}\n`);
  return {
    root, candidate, run, priv, info, home, agentDir, codexHome, etc, context,
    controller: (client: string) => join(run, `controller-${client}`),
    baselineOf: (client: string) => (task: string) => JSON.parse(readFileSync(join(priv, "baselines", client, `${task}.json`), "utf8")),
  };
}

// ---- #67: every Codex skill source ----------------------------------------------------------------
type Run = Awaited<ReturnType<typeof buildRun>>;
const sources: Array<[string, string, (r: Run) => string]> = [
  ["codexHomeSkills", "$CODEX_HOME/skills", (r) => join(r.codexHome, "skills")],
  ["homeAgentsSkills", "the home's .agents/skills", (r) => join(r.home, ".agents", "skills")],
  ["etcCodexSkills", "/etc/codex/skills", (r) => r.etc],
  ["codexAncestorSkills", ".agents/skills of an ancestor of the controller directory", (r) => join(r.root, ".agents", "skills")],
  ["codexAncestorSkills", ".agents/skills of the run directory", (r) => join(r.run, ".agents", "skills")],
];
/** The prepared state includes whatever the test placed before this call, as if it had been there at prepare. */
const rerecord = (r: Run, extra: Record<string, unknown> = {}) => {
  r.info.resources = h.computeResources(r.run, r.candidate, { ...r.context, ...extra });
  writeFileSync(join(r.priv, "run.json"), `${JSON.stringify(r.info, null, 2)}\n`);
};
const orchestration = "pi-session-orchestration";
const codexValues = (r: Run) => ({ run: r.run, client: "codex", scenario: "parallel" });

// Controller skills that are not a direct child of the source, or that are only declared by their name.
const variants: Array<[string, string, (r: Run) => void]> = [
  ["a differing copy under the hidden .system directory of $CODEX_HOME", "codexHomeSkills", (r) => put(join(r.codexHome, "skills", ".system", orchestration, "SKILL.md"), "an older copy\n")],
  ["a differing copy nested below another skill", "homeAgentsSkills", (r) => put(join(r.home, ".agents", "skills", "bundle", "nested", orchestration, "SKILL.md"), "an older copy\n")],
  ["a differently named directory declaring the name", "etcCodexSkills", (r) => put(join(r.etc, "renamed", "SKILL.md"), `---\nname: ${orchestration}\ndescription: x\n---\nolder\n`)],
  ["a differently named directory declaring the quoted name", "codexAncestorSkills", (r) => put(join(r.root, ".agents", "skills", "renamed", "SKILL.md"), `---\nname: "${orchestration}"\n---\nolder\n`)],
  ["a symlinked copy that differs", "homeAgentsSkills", (r) => { put(join(r.root, "other-copy", "SKILL.md"), "other\n"); mkdirSync(join(r.home, ".agents", "skills"), { recursive: true }); symlinkSync(join(r.root, "other-copy"), join(r.home, ".agents", "skills", orchestration)); }],
  ["a differently named symlink to a copy that declares the name and differs", "codexHomeSkills", (r) => { put(join(r.root, "declared-copy", "SKILL.md"), `---\nname: ${orchestration}\n---\nolder\n`); mkdirSync(join(r.codexHome, "skills"), { recursive: true }); symlinkSync(join(r.root, "declared-copy"), join(r.codexHome, "skills", "alias")); }],
];

// ---- D3: bound resources and preserved findings --------------------------------------------------
describe("bound resources", () => {
  it("records a digest for every resource the acceptance relies on", async () => {
    const run = await buildRun();
    expect(Object.keys(run.info.resources).sort()).toEqual([
      "candidateBuild", "claudeMcpConfiguration", "codexAncestorSkills", "codexControllerSkill", "codexHomeSkills", "controllerSkill", "etcCodexSkills",
      "extensionNpmInstallation", "fixtureBaselines", "handshakeSkill", "harness", "homeAgentsSkills",
      "operatorClaudeSkill", "operatorCodexSkill", "overrideDirectory", "runConfiguration", "workerSkillImplementation", "workerSkillReview",
    ]);
    // A Codex skill source that does not exist is a stable value, not a failure.
    expect(run.info.resources).toMatchObject({ codexHomeSkills: "missing", homeAgentsSkills: "missing", etcCodexSkills: "missing" });
    expect(run.info.resources.codexAncestorSkills).toMatch(/^[0-9a-f]{64}$/);
    // Without extensions the extension binding is one stable value, whatever sits in the agent directory.
    expect(run.info.resources.extensionNpmInstallation).toBe("none");
    expect(h.changedResources(run.info.resources, h.computeResources(run.run, run.candidate, run.context))).toEqual([]);
  });

  const cases: Array<[string, string[], (r: Awaited<ReturnType<typeof buildRun>>) => void]> = [
    ["the installed Claude Code controller skill", ["controllerSkill"], (r) => appendFileSync(join(r.run, "controller-claude", ".claude", "skills", "pi-session-orchestration", "SKILL.md"), "x")],
    ["an added file in the controller skill copy", ["controllerSkill"], (r) => writeFileSync(join(r.run, "controller-claude", ".claude", "skills", "pi-session-orchestration", "extra.md"), "x")],
    ["the candidate skill the Codex link points to", ["codexControllerSkill"], (r) => appendFileSync(join(r.candidate, "skills", "pi-session-orchestration", "SKILL.md"), "x")],
    ["the Codex link target", ["codexControllerSkill"], (r) => { const link = join(r.run, "controller-codex", ".agents", "skills", "pi-session-orchestration"); rmSync(link); symlinkSync(join(r.candidate, "skills", "pi-session-review"), link); }],
    ["the shipped implementation worker skill", ["workerSkillImplementation"], (r) => appendFileSync(join(r.candidate, "skills", "pi-session-implementation", "SKILL.md"), "x")],
    ["the shipped review worker skill", ["workerSkillReview"], (r) => appendFileSync(join(r.candidate, "skills", "pi-session-review", "SKILL.md"), "x")],
    ["the handshake skill", ["handshakeSkill", "overrideDirectory"], (r) => appendFileSync(join(r.priv, "skills", "acceptance-handshake", "SKILL.md"), "x")],
    ["another file in the override directory", ["overrideDirectory"], (r) => writeFileSync(join(r.priv, "skills", "other.md"), "x")],
    ["the run configuration", ["runConfiguration"], (r) => appendFileSync(join(r.priv, "config.json"), " ")],
    ["the Claude Code MCP configuration", ["claudeMcpConfiguration"], (r) => appendFileSync(join(r.priv, "claude-mcp.json"), " ")],
    ["a fixture baseline", ["fixtureBaselines"], (r) => appendFileSync(join(r.priv, "baselines", "claude", "slug.json"), " ")],
    ["the candidate build", ["candidateBuild"], (r) => appendFileSync(join(r.candidate, "dist", "other.js"), "// changed\n")],
    ["a skill added to $CODEX_HOME/skills", ["codexHomeSkills"], (r) => put(join(r.codexHome, "skills", "other", "SKILL.md"), "x")],
    ["a bundled .system skill of $CODEX_HOME", ["codexHomeSkills"], (r) => put(join(r.codexHome, "skills", ".system", "bundled", "SKILL.md"), "x")],
    ["a skill added to the home's .agents/skills", ["homeAgentsSkills"], (r) => put(join(r.home, ".agents", "skills", "other", "SKILL.md"), "x")],
    ["a skill added to /etc/codex/skills", ["etcCodexSkills"], (r) => put(join(r.etc, "other", "SKILL.md"), "x")],
    ["a skill added to .agents/skills of an ancestor of the controller directory", ["codexAncestorSkills"], (r) => put(join(r.root, ".agents", "skills", "other", "SKILL.md"), "x")],
    ["a skill added to .agents/skills of the run directory", ["codexAncestorSkills"], (r) => put(join(r.run, ".agents", "skills", "other", "SKILL.md"), "x")],
  ];
  it("binds the operator's own controller skill copies, which a client could load instead", async () => {
    const run = await buildRun();
    const home = join(run.root, "home");
    const personal = join(home, ".claude", "skills", "pi-session-orchestration");
    expect(h.operatorControllerSkills(home)).toEqual({ operatorClaudeSkill: "missing", operatorCodexSkill: "missing" });
    mkdirSync(personal, { recursive: true });
    writeFileSync(join(personal, "SKILL.md"), "operator copy\n");
    const recorded = h.computeResources(run.run, run.candidate, { ...run.context, home });
    appendFileSync(join(personal, "SKILL.md"), "edited\n");
    expect(h.changedResources(recorded, h.computeResources(run.run, run.candidate, { ...run.context, home }))).toEqual(["operatorClaudeSkill"]);
  });

  it("names every source that holds a differing controller skill, and also refuses a copy with an extra file", async () => {
    const run = await buildRun();
    cpSync(join(run.candidate, "skills", orchestration), join(run.etc, orchestration), { recursive: true });
    writeFileSync(join(run.etc, orchestration, "extra.md"), "x");
    put(join(run.codexHome, "skills", orchestration, "SKILL.md"), "other\n");
    expect(h.differingCodexControllerSkills(run.run, run.candidate, run.context)).toEqual(["codexHomeSkills", "etcCodexSkills"]);
  });

  it.each(variants)("finds %s", async (_label, name, place) => {
    const run = await buildRun();
    place(run);
    expect(h.differingCodexControllerSkills(run.run, run.candidate, run.context)).toEqual([name]);
  });

  it("allows an equal symlinked copy, an equal copy under another name and unrelated skills", async () => {
    const run = await buildRun();
    cpSync(join(run.candidate, "skills", orchestration), join(run.root, "equal-copy"), { recursive: true });
    mkdirSync(join(run.home, ".agents", "skills"), { recursive: true });
    symlinkSync(join(run.root, "equal-copy"), join(run.home, ".agents", "skills", orchestration));
    mkdirSync(join(run.codexHome, "skills", ".system"), { recursive: true });
    symlinkSync(join(run.candidate, "skills", orchestration), join(run.codexHome, "skills", ".system", orchestration));
    put(join(run.etc, "unrelated", "SKILL.md"), "---\nname: something-else\n---\n");
    expect(h.differingCodexControllerSkills(run.run, run.candidate, run.context)).toEqual([]);
  });

  it("searches a source with link cycles to the end, and fails closed when a source cannot be searched completely", async () => {
    const run = await buildRun();
    put(join(run.etc, "a", "SKILL.md"), "x\n");
    symlinkSync(run.etc, join(run.etc, "a", "loop"));
    expect(h.findControllerSkills(run.etc)).toEqual({ found: [], sentinel: undefined });
    expect(h.findControllerSkills(run.etc, { limit: 1 }).sentinel).toBe("tooLarge");
    expect(h.findControllerSkills(join(run.root, "no-such-source"))).toEqual({ found: [], sentinel: undefined });
  });

  it("allows an equal copy of the controller skill, and none, in every source", async () => {
    const run = await buildRun();
    expect(h.differingCodexControllerSkills(run.run, run.candidate, run.context)).toEqual([]);
    for (const [, , dir] of sources) cpSync(join(run.candidate, "skills", orchestration), join(dir(run), orchestration), { recursive: true });
    expect(h.differingCodexControllerSkills(run.run, run.candidate, run.context)).toEqual([]);
  });

  it("ignores skills other than the controller skill when deciding on a refusal", async () => {
    const run = await buildRun();
    for (const [, , dir] of sources) put(join(dir(run), "unrelated", "SKILL.md"), "x\n");
    expect(h.differingCodexControllerSkills(run.run, run.candidate, run.context)).toEqual([]);
  });

  it("resolves CODEX_HOME once from the environment, its home form or the default", async () => {
    const run = await buildRun();
    const link = join(run.root, "codex-link");
    mkdirSync(run.codexHome, { recursive: true });
    symlinkSync(run.codexHome, link);
    expect(h.resolveCodexHome({ CODEX_HOME: link }, run.home)).toBe(run.codexHome);
    expect(h.resolveCodexHome({ CODEX_HOME: "~/elsewhere" }, run.home)).toBe(join(run.home, "elsewhere"));
    expect(h.resolveCodexHome({}, run.home)).toBe(join(run.home, ".codex"));
  });

  it("reads only inside the test's temporary root: every skill source the harness computes lies there", async () => {
    const run = await buildRun({ extensions: true });
    const everything = Object.values(h.codexSkillSources(run.run, run.context)).flat() as string[];
    expect(everything).toHaveLength(5);
    for (const dir of [...everything, run.home, run.agentDir, run.codexHome, run.etc]) expect(h.inside(dir, run.root), dir).toBe(true);
    // the search stops at the boundary, which is the last ancestor listed; without one it runs up to the file system root
    expect(h.codexAncestorSkillDirs(join(run.run, "controller-codex"), run.root).at(-1)).toBe(join(run.root, ".agents", "skills"));
    expect(h.codexAncestorSkillDirs(join(run.run, "controller-codex")).at(-1)).toBe(join("/", ".agents", "skills"));
    expect(h.codexSkillSources(run.run, { ...run.context, ancestorBoundary: undefined }).codexAncestorSkills.some((dir: string) => !h.inside(dir, run.root))).toBe(true);
  });

  it("records per client the controller skill kind and its digest without paths", async () => {
    const run = await buildRun();
    const tree = h.treeSha256(join(run.candidate, "skills", orchestration));
    expect(run.info.controllerSkills).toEqual({
      claude: { kind: "installed", treeSha256: h.treeSha256(join(run.run, "controller-claude", ".claude", "skills", orchestration)) },
      codex: { kind: "linked", treeSha256: tree },
    });
    expect(JSON.stringify(run.info.controllerSkills)).not.toContain(run.root);
    // a link that points elsewhere is not recorded as the candidate's skill
    const link = join(run.run, "controller-codex", ".agents", "skills", orchestration);
    rmSync(link);
    symlinkSync(join(run.candidate, "skills", "pi-session-review"), link);
    expect(h.controllerSkillRecord(run.run, run.candidate).codex).toEqual({ kind: "linked", treeSha256: "wrongTarget" });
  });

  it.each(cases)("reports %s by name", async (_label, expected, mutate) => {
    const run = await buildRun();
    mutate(run);
    expect(h.changedResources(run.info.resources, h.computeResources(run.run, run.candidate, run.context))).toEqual(expected);
  });
});

// ---- #66: the loaded extension package contents -----------------------------------------------------
describe("extension package binding", () => {
  const packageKey = `extension:${EXTENSION}`;
  const npm = (r: Run) => join(r.agentDir, "npm");
  const mutations: Array<[string, string[], (r: Run) => void]> = [
    ["a file of the extension package", [packageKey, "extensionNpmInstallation"], (r) => appendFileSync(join(npm(r), "node_modules", EXTENSION, "index.js"), "// changed\n")],
    ["a file added to the extension package", [packageKey, "extensionNpmInstallation"], (r) => writeFileSync(join(npm(r), "node_modules", EXTENSION, "extra.js"), "x")],
    ["a dependency file", ["extensionNpmInstallation"], (r) => appendFileSync(join(npm(r), "node_modules", "dep", "index.js"), "// changed\n")],
    ["the npm manifest", ["extensionNpmInstallation"], (r) => appendFileSync(join(npm(r), "package.json"), " ")],
    ["the npm lockfile", ["extensionNpmInstallation"], (r) => appendFileSync(join(npm(r), "package-lock.json"), " ")],
  ];

  it("binds each extension package and the npm installation under path-free keys", async () => {
    const run = await buildRun({ extensions: true });
    expect(Object.keys(run.info.resources).filter((name) => name.startsWith("extension")).sort()).toEqual([packageKey, "extensionNpmInstallation"]);
    expect(run.info.resources[packageKey]).toMatch(/^[0-9a-f]{64}$/);
    expect(run.info.resources.extensionNpmInstallation).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(run.info.resources)).not.toContain(run.agentDir);
  });

  it.each(mutations)("reports %s by name", async (_label, expected, mutate) => {
    const run = await buildRun({ extensions: true });
    mutate(run);
    expect(h.changedResources(run.info.resources, h.computeResources(run.run, run.candidate, run.context))).toEqual(expected);
  });

  it("binds the real package root when the package is a link, so a change behind the link is reported", async () => {
    const run = await buildRun({ extensions: true });
    const source = join(run.root, "extension-source");
    const installed = join(npm(run), "node_modules", EXTENSION);
    renameSync(installed, source);
    symlinkSync(source, installed);
    const recorded = h.computeResources(run.run, run.candidate, run.context);
    appendFileSync(join(source, "index.js"), "// changed behind the link\n");
    // the package root is bound by its real path, and the npm installation now binds the content behind the link too
    expect(h.changedResources(recorded, h.computeResources(run.run, run.candidate, run.context))).toEqual([packageKey, "extensionNpmInstallation"]);
  });

  it("reports an extension package that is gone as missing", async () => {
    const run = await buildRun({ extensions: true });
    rmSync(join(npm(run), "node_modules", EXTENSION), { recursive: true });
    const now = h.computeResources(run.run, run.candidate, run.context);
    expect(now[packageKey]).toBe("missing");
    expect(h.changedResources(run.info.resources, now)).toContain(packageKey);
  });

  it("resolves the agent directory once from the environment, its home form or the SDK default", async () => {
    const run = await buildRun({ extensions: true });
    const link = join(run.root, "agent-link");
    symlinkSync(run.agentDir, link);
    expect(h.resolveAgentDirectory({ PI_CODING_AGENT_DIR: link }, run.home)).toBe(run.agentDir);
    expect(h.resolveAgentDirectory({ PI_CODING_AGENT_DIR: "~/custom-agent" }, run.home)).toBe(join(run.home, "custom-agent"));
    expect(h.resolveAgentDirectory({}, run.home)).toBe(join(run.home, ".pi", "agent"));
    expect(h.resolveAgentDirectory({ PI_CODING_AGENT_DIR: "" }, run.home)).toBe(join(run.home, ".pi", "agent"));
  });
});

/** Runs the real `prepare` against a synthetic candidate with a stand-in setup and a fake `claude`; nothing leaves the temporary root. */
async function prepareRun(run: Run, { withExtensions, env, context = {} }: { withExtensions: boolean; env: Record<string, string>; context?: Record<string, unknown> }) {
  copyFileSync(setupStub, join(run.candidate, "dist", "setup-main.js"));
  const bin = join(run.root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const baseConfig = join(run.root, "base.json");
  writeFileSync(baseConfig, JSON.stringify({ executionProfiles: { source: { provider: "p", model: "m", thinkingLevel: "off", permissionProfile: "read-only", default: true, ...(withExtensions ? { extensions: [`npm:${EXTENSION}@1.0.0`] } : {}) } } }));
  const savedPath = process.env.PATH; const write = process.stdout.write.bind(process.stdout);
  let printed = "";
  process.env.PATH = `${bin}:${savedPath ?? ""}`;
  process.stdout.write = ((chunk: string) => { printed += chunk; return true; }) as typeof process.stdout.write;
  try {
    h.prepare({ candidate: run.candidate, "base-config": baseConfig, "from-profile": "source", "work-dir": join(run.root, "work"), ...(withExtensions ? { "with-extensions": true } : {}) },
      { env, home: run.home, temporaryDirs: [], etcCodexSkills: run.etc, ancestorBoundary: run.root, ...context });
  } finally { process.stdout.write = write; if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath; }
  const runDir = printed.trim();
  const priv = join(runDir, "private");
  const info = JSON.parse(readFileSync(join(priv, "run.json"), "utf8"));
  return { runDir, priv, info, setupEnv: JSON.parse(readFileSync(join(runDir, "setup-env.json"), "utf8")) };
}

// ---- #66, #67: content behind links -------------------------------------------------------------------
describe("binding digest", () => {
  const recompute = (r: Run) => h.computeResources(r.run, r.candidate, r.context);

  it("invalidates the run when a file changes behind a linked dependency outside the npm installation", async () => {
    const run = await buildRun({ extensions: true });
    const outside = join(run.root, "outside-dep");
    put(join(outside, "index.js"), "export const outside = 1;\n");
    symlinkSync(outside, join(run.agentDir, "npm", "node_modules", "linked-dep"));
    rerecord(run);
    expect(h.changedResources(run.info.resources, recompute(run))).toEqual([]);
    appendFileSync(join(outside, "index.js"), "// changed behind the link\n");
    expect(h.changedResources(run.info.resources, recompute(run))).toEqual(["extensionNpmInstallation"]);
  });

  it("invalidates the extension too when its own package links to content outside", async () => {
    const run = await buildRun({ extensions: true });
    const vendor = join(run.root, "vendor");
    put(join(vendor, "lib.js"), "export const lib = 1;\n");
    symlinkSync(vendor, join(run.agentDir, "npm", "node_modules", EXTENSION, "vendor"));
    rerecord(run);
    appendFileSync(join(vendor, "lib.js"), "// changed\n");
    expect(h.changedResources(run.info.resources, recompute(run))).toEqual([`extension:${EXTENSION}`, "extensionNpmInstallation"]);
  });

  it("invalidates the run when a file changes behind a linked skill in the home's .agents/skills", async () => {
    const run = await buildRun();
    const outside = join(run.root, "outside-skill");
    put(join(outside, "SKILL.md"), "---\nname: linked\n---\n");
    mkdirSync(join(run.home, ".agents", "skills"), { recursive: true });
    symlinkSync(outside, join(run.home, ".agents", "skills", "linked"));
    rerecord(run);
    appendFileSync(join(outside, "SKILL.md"), "changed\n");
    expect(h.changedResources(run.info.resources, recompute(run))).toEqual(["homeAgentsSkills"]);
  });

  it("binds a linked skill in each of the other Codex sources", async () => {
    for (const [name, , dir] of sources) {
      const run = await buildRun();
      const outside = join(run.root, "outside-skill");
      put(join(outside, "SKILL.md"), "x\n");
      mkdirSync(dir(run), { recursive: true });
      symlinkSync(outside, join(dir(run), "linked"));
      rerecord(run);
      appendFileSync(join(outside, "SKILL.md"), "changed\n");
      expect(h.changedResources(run.info.resources, recompute(run)), name).toEqual([name]);
    }
  });

  it("notices a dangling link that starts to resolve", async () => {
    const run = await buildRun({ extensions: true });
    const later = join(run.root, "later-dep");
    symlinkSync(later, join(run.agentDir, "npm", "node_modules", "later"));
    rerecord(run);
    put(join(later, "index.js"), "x");
    expect(h.changedResources(run.info.resources, recompute(run))).toEqual(["extensionNpmInstallation"]);
  });

  it("terminates on link cycles, outside and inside the root, and is stable", async () => {
    const run = await buildRun({ extensions: true });
    const npm = join(run.agentDir, "npm");
    const outside = join(run.root, "outside-cycle");
    put(join(outside, "a.js"), "a");
    symlinkSync(outside, join(outside, "self"));
    symlinkSync(npm, join(outside, "back-to-root"));
    symlinkSync(outside, join(npm, "node_modules", "cycle"));
    symlinkSync(npm, join(npm, "node_modules", "dep", "up"));
    const first = h.boundTreeSha256(npm);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(h.boundTreeSha256(npm)).toBe(first);
    // content behind the cycle is still bound
    appendFileSync(join(outside, "a.js"), "b");
    expect(h.boundTreeSha256(npm)).not.toBe(first);
  });

  it("needs only the text of a link that resolves inside the root", async () => {
    const run = await buildRun({ extensions: true });
    const npm = join(run.agentDir, "npm");
    symlinkSync("dep", join(npm, "node_modules", "alias"));
    const withAlias = h.boundTreeSha256(npm);
    expect(h.boundTreeSha256(npm)).toBe(withAlias);
    // the target is hashed as part of the root, once
    appendFileSync(join(npm, "node_modules", "dep", "index.js"), "// c\n");
    expect(h.boundTreeSha256(npm)).not.toBe(withAlias);
    // retargeting the link inside the root is a change as well
    const before = h.boundTreeSha256(npm);
    rmSync(join(npm, "node_modules", "alias"));
    symlinkSync(join("..", "node_modules", EXTENSION), join(npm, "node_modules", "alias"));
    expect(h.boundTreeSha256(npm)).not.toBe(before);
  });

  it("ends with a sentinel, never with an exception, for missing, wrong, unreadable and oversized trees", async () => {
    const root = realpathSync(await temporaryRoot("msa-bound-"));
    expect(h.boundTreeSha256(join(root, "nothing"))).toBe("missing");
    put(join(root, "file"), "x");
    expect(h.boundTreeSha256(join(root, "file"))).toBe("notDirectory");
    for (const name of ["a", "b", "c"]) put(join(root, "big", name), name);
    expect(h.boundTreeSha256(join(root, "big"), { limit: 2 })).toBe("tooLarge");
    expect(h.boundTreeSha256(join(root, "big"), { limit: 3 })).toMatch(/^[0-9a-f]{64}$/);
    symlinkSync(join(root, "gone"), join(root, "dangling-top"));
    expect(h.boundTreeSha256(join(root, "dangling-top"))).toMatch(/^[0-9a-f]{64}$/);
    if (process.getuid?.() !== 0) {
      put(join(root, "locked", "inner", "f"), "x");
      chmodSync(join(root, "locked", "inner"), 0);
      try { expect(h.boundTreeSha256(join(root, "locked"))).toBe("unreadable"); } finally { chmodSync(join(root, "locked", "inner"), 0o700); }
    }
  });
});

// ---- #66, #67: a binding that is not complete binds nothing -----------------------------------------
describe("incomplete bindings", () => {
  const notRoot = process.getuid?.() !== 0;
  const threeFiles = (dir: string) => { for (const name of ["a", "b", "c"]) put(join(dir, "skill", name), name); };

  it("treats only unreadable and tooLarge as incomplete, and keeps the determinate values legitimate", () => {
    expect(h.unboundResources({ a: "unreadable", b: "x", c: "missing" }, { a: "unreadable", b: "tooLarge", c: "none", d: "notDirectory", e: "0".repeat(64) })).toEqual(["a", "b"]);
    expect(h.unboundResources({ a: "missing", b: "none" }, { a: "missing", b: "none", c: "notDirectory", d: "unset" })).toEqual([]);
    expect(h.unboundResources(undefined, { a: "tooLarge" })).toEqual(["a"]);
  });

  it("keeps an incomplete value visible in every key, also in the composed ones", async () => {
    const run = await buildRun({ extensions: true });
    threeFiles(join(run.home, ".agents", "skills"));
    threeFiles(join(run.root, ".agents", "skills"));
    threeFiles(join(run.codexHome, "skills"));
    threeFiles(run.etc);
    const now = h.computeResources(run.run, run.candidate, { ...run.context, boundLimit: 1 });
    for (const key of ["extensionNpmInstallation", `extension:${EXTENSION}`, "codexHomeSkills", "homeAgentsSkills", "etcCodexSkills", "codexAncestorSkills"]) expect(now[key], key).toBe("tooLarge");
    expect(h.unboundResources(run.info.resources, now)).toEqual([`extension:${EXTENSION}`, "codexAncestorSkills", "codexHomeSkills", "etcCodexSkills", "extensionNpmInstallation", "homeAgentsSkills"].sort());
  });

  it.skipIf(!notRoot)("keeps an unreadable controller skill visible in the Codex link key", async () => {
    const run = await buildRun();
    const skill = join(run.candidate, "skills", "pi-session-orchestration");
    put(join(skill, "inner", "f"), "x");
    chmodSync(join(skill, "inner"), 0);
    try {
      const now = h.computeResources(run.run, run.candidate, run.context);
      expect(now.codexControllerSkill).toBe("unreadable");
      expect(h.unboundResources(run.info.resources, now)).toEqual(expect.arrayContaining(["codexControllerSkill"]));
    } finally { chmodSync(join(skill, "inner"), 0o700); }
  });

  it("an incomplete value stays equal while the content under it changes, and still cannot pass", async () => {
    const run = await buildRun();
    threeFiles(join(run.home, ".agents", "skills"));
    rerecord(run, { boundLimit: 1 });
    expect(run.info.resources.homeAgentsSkills).toBe("tooLarge");
    appendFileSync(join(run.home, ".agents", "skills", "skill", "a"), "changed under an incomplete binding\n");
    const now = h.computeResources(run.run, run.candidate, { ...run.context, boundLimit: 1 });
    expect(h.changedResources(run.info.resources, now)).toEqual([]);
    expect(h.unboundResources(run.info.resources, now)).toEqual(["homeAgentsSkills"]);
  });

  const passing = () => ({
    client: "claude", exitCode: 0, timedOut: false, spawnFailed: false, harnessAborted: false, resources: { changedAfterRun: [] }, unboundResources: [] as string[],
    processes: { serversObserved: 1, residualByRole: {} },
    transcript: { capabilitiesFirst: true, candidateConfirmed: true, acceptCodeSkills: ["implementation"], acceptCodeHandshakeSkills: ["implementation", "handshake"],
      structuralLeaks: 0, tokenInControllerPrompts: false, tokenInControllerTask: false, controllerTranscriptHasToken: false, privateMarkersInWorkerPrompts: false, controllerTouchedPrivate: false,
      sessionsStarted: 2, sessions: [{ workspace: "cc-slug", profile: "accept-code-handshake", closed: true, turns: ["completed"] }, { workspace: "cc-stats", profile: "accept-code", closed: true, turns: ["completed"] }], firstTurnsOverlap: true, followUpCompleted: true },
    oracle: { slug: { onlyAllowedChanges: true, changesWrittenDuringWorkerTurns: true, testsPass: true, businessChecks: true, addedTest: true, handshake: true, handshakeWrittenDuringFollowUp: true },
      stats: { onlyAllowedChanges: true, changesWrittenDuringWorkerTurns: true, testsPass: true, businessChecks: true } },
  });

  it("adds resourcesUnbound to the verdict for an unbound resource, or for a result that does not say", () => {
    expect(h.evaluateAcceptance(passing(), "parallel")).toEqual({ passed: true, failures: [] });
    expect(h.evaluateAcceptance({ ...passing(), unboundResources: ["homeAgentsSkills"] }, "parallel")).toEqual({ passed: false, failures: ["resourcesUnbound"] });
    const silent: Record<string, unknown> = passing();
    delete silent.unboundResources;
    expect(h.evaluateAcceptance(silent, "parallel").failures).toEqual(["resourcesUnbound"]);
  });

  async function prepareFails(context: Record<string, unknown>, place: (run: Run) => void): Promise<string> {
    const run = await buildRun();
    place(run);
    try { await prepareRun(run, { withExtensions: false, env: {}, context }); } catch (error) { return (error as Error).message; }
    return "";
  }

  it("refuses to prepare a run whose bound source is too large to bind, naming the key", async () => {
    const message = await prepareFails({ boundLimit: 1 }, (run) => threeFiles(join(run.home, ".agents", "skills")));
    expect(message).toContain('"homeAgentsSkills"');
    expect(message).toContain("cannot be read completely");
  }, 60_000);

  it.skipIf(!notRoot)("refuses to prepare a run whose bound source is unreadable, naming the key", async () => {
    let locked = "";
    try {
      const message = await prepareFails({}, (run) => { locked = join(run.home, ".agents", "skills", "locked"); put(join(locked, "f"), "x"); chmodSync(locked, 0); });
      expect(message).toContain('"homeAgentsSkills"');
    } finally { if (locked) chmodSync(locked, 0o700); }
  }, 60_000);
});

// ---- #66: prepare passes the bound agent directory to the server of both clients ---------------------
describe("prepare binds the agent directory", () => {
  it("gives both clients' servers the resolved PI_CODING_AGENT_DIR and binds the extension contents", async () => {
    const run = await buildRun({ extensions: true });
    const link = join(run.root, "agent-link");
    symlinkSync(run.agentDir, link);
    // Codex skill sources with content, so that a prepare which read other directories would record other digests.
    put(join(run.etc, "present", "SKILL.md"), "x\n");
    put(join(run.root, ".agents", "skills", "present", "SKILL.md"), "x\n");
    // The environment names a link; the prepared run records and passes the real directory.
    const prepared = await prepareRun(run, { withExtensions: true, env: { PI_CODING_AGENT_DIR: link, CODEX_HOME: join(run.root, "prepared-codex-home") } });
    expect(prepared.info.agentDir).toBe(run.agentDir);
    // CODEX_HOME is resolved once and recorded privately; the bound Codex skill sources use it
    expect(prepared.info.codexHome).toBe(join(run.root, "prepared-codex-home"));
    // prepare reads the injected system skills and stops the ancestor search at the injected boundary
    expect(prepared.info.resources.etcCodexSkills).toBe(h.boundTreeSha256(run.etc));
    expect(prepared.info.resources.etcCodexSkills).toMatch(/^[0-9a-f]{64}$/);
    for (const dir of Object.values(h.codexSkillSources(prepared.runDir, { ...run.context, codexHome: prepared.info.codexHome })).flat() as string[]) expect(h.inside(dir, run.root), dir).toBe(true);
    const claudeServer = JSON.parse(readFileSync(join(prepared.priv, "claude-mcp.json"), "utf8")).mcpServers["pi-candidate"];
    expect(claudeServer.env).toEqual({ PI_SESSION_MCP_CONFIG: join(prepared.priv, "config.json"), PI_CODING_AGENT_DIR: run.agentDir });
    const codexArgs: string[] = h.command("codex", prepared.info, prepared.priv, join(prepared.runDir, "controller-codex"), { scenario: "parallel" }).args;
    expect(codexArgs).toContain(`mcp_servers.pi-candidate.env={PI_SESSION_MCP_CONFIG=${JSON.stringify(join(prepared.priv, "config.json"))},PI_CODING_AGENT_DIR=${JSON.stringify(run.agentDir)}}`);
    // setup's Doctor looks at the same directory
    expect(prepared.setupEnv.PI_CODING_AGENT_DIR).toBe(run.agentDir);
    expect(prepared.info.extensions).toEqual([{ name: EXTENSION, version: "1.0.0" }]);
    expect(Object.keys(prepared.info.resources).filter((name) => name.startsWith("extension")).sort()).toEqual([`extension:${EXTENSION}`, "extensionNpmInstallation"]);
    expect(h.changedResources(prepared.info.resources, h.computeResources(prepared.runDir, prepared.info.candidate, { home: run.home, etcCodexSkills: run.etc, ancestorBoundary: run.root, agentDir: prepared.info.agentDir, codexHome: prepared.info.codexHome, extensions: prepared.info.extensions }))).toEqual([]);
    // the recorded directory is private: the evidence names neither it nor the run
    const out = join(run.root, "evidence.json");
    h.evidence({ run: prepared.runDir, out });
    const text = readFileSync(out, "utf8");
    for (const secret of [run.agentDir, prepared.info.codexHome, run.root, prepared.info.token]) expect(text).not.toContain(secret);
    expect(JSON.parse(text).resources.extensionNpmInstallation).toBe(prepared.info.resources.extensionNpmInstallation);
    // per client: the kind of controller skill and its digest
    const shipped = h.treeSha256(join(run.candidate, "skills", orchestration));
    expect(JSON.parse(text).controllerSkills).toEqual({ claude: { kind: "installed", treeSha256: shipped }, codex: { kind: "linked", treeSha256: shipped } });
  }, 60_000);

  it("passes the default agent directory to both clients without extensions and binds nothing of it", async () => {
    const run = await buildRun();
    const prepared = await prepareRun(run, { withExtensions: false, env: {} });
    const expected = join(run.home, ".pi", "agent");
    expect(prepared.info.agentDir).toBe(expected);
    expect(prepared.info.codexHome).toBe(join(run.home, ".codex"));
    expect(JSON.parse(readFileSync(join(prepared.priv, "claude-mcp.json"), "utf8")).mcpServers["pi-candidate"].env.PI_CODING_AGENT_DIR).toBe(expected);
    const codexArgs: string[] = h.command("codex", prepared.info, prepared.priv, join(prepared.runDir, "controller-codex"), { scenario: "parallel" }).args;
    expect(codexArgs.find((arg) => arg.startsWith("mcp_servers.pi-candidate.env="))).toContain(`PI_CODING_AGENT_DIR=${JSON.stringify(expected)}`);
    expect(prepared.info.resources.extensionNpmInstallation).toBe("none");
    expect(Object.keys(prepared.info.resources).filter((name) => name.startsWith("extension:"))).toEqual([]);
    // two coding profiles: the handshake skill is offered only on the second
    const profiles = JSON.parse(readFileSync(join(prepared.priv, "config.json"), "utf8")).executionProfiles;
    expect(Object.keys(profiles).sort()).toEqual(["accept-code", "accept-code-handshake", "accept-read"]);
    expect(profiles["accept-code"]).toMatchObject({ permissionProfile: "coding", default: false, skills: ["implementation"] });
    expect(profiles["accept-code-handshake"]).toMatchObject({ permissionProfile: "coding", default: false, skills: ["implementation", "handshake"] });
    expect(profiles["accept-read"]).toMatchObject({ default: true, skills: ["review"] });
    const { skills: _a, permissionProfile: _b, default: _c, ...codeProfile } = profiles["accept-code"];
    const { skills: _d, permissionProfile: _e, default: _f, ...handshakeProfile } = profiles["accept-code-handshake"];
    expect(handshakeProfile).toEqual(codeProfile);
    expect(prepared.setupEnv.PI_CODING_AGENT_DIR).toBeNull();
  }, 60_000);
});

// ---- #68: the handshake skill only for the slug task ----------------------------------------------------
describe("handshake profile split", () => {
  const info = { node: process.execPath, entry: "/entry.js", agentDir: "/agent" };
  const lineWith = (text: string, needle: string) => text.split("\n").find((line) => line.includes(needle)) ?? "";

  it("names the profile of each task in the controller prompt", () => {
    const text = h.command("claude", info, "/private", "/controller", { scenario: "parallel" }).args[1] as string;
    expect(lineWith(text, "- SLUG:")).toContain("`accept-code-handshake`");
    expect(lineWith(text, "- STATS:")).toContain("`accept-code`");
    expect(lineWith(text, "- STATS:")).not.toContain("accept-code-handshake");
    expect(lineWith(text, "Use the execution profile")).toContain("no other session uses `accept-code-handshake`");
    // the Codex controller gets the same task text
    const codex = h.command("codex", info, "/private", "/controller", { scenario: "parallel" }).args as string[];
    expect(codex.at(-1)).toContain("- SLUG: execution profile `accept-code-handshake`");
  });

  it("offers only accept-code to the tasks of the abort scenario", () => {
    for (const client of ["claude", "codex"]) {
      const args = h.command(client, info, "/private", "/controller", { scenario: "abort" }).args as string[];
      const text = (client === "claude" ? args[1] : args.at(-1)) as string;
      expect(text).toContain("Use the execution profile `accept-code` for every task.");
      expect(text).not.toContain("accept-code-handshake");
    }
  });

  it("mentions the handshake only in the parallel prompt, where SLUG and the handshake check name it", () => {
    for (const client of ["claude", "codex"]) {
      const args = h.command(client, info, "/private", "/controller", { scenario: "abort" }).args as string[];
      expect((client === "claude" ? args[1] : args.at(-1)) as string).not.toMatch(/handshake/i);
      const parallel = (client === "claude" ? h.command(client, info, "/private", "/controller", { scenario: "parallel" }).args[1] : (h.command(client, info, "/private", "/controller", { scenario: "parallel" }).args as string[]).at(-1)) as string;
      expect(lineWith(parallel, "- SLUG:")).toContain("`accept-code-handshake`");
      expect(parallel).toContain("The operator checks the handshake content; you only check that the file exists.");
      expect(parallel).toContain("complete the acceptance handshake");
      // the boundary sentence stays in both scenarios
      for (const text of [parallel, (client === "claude" ? args[1] : args.at(-1)) as string]) expect(text).toContain("Read files and run commands only inside ./fixtures");
    }
  });

  const capabilities = (code: string[] | undefined, handshake: string[] | undefined) => ({ tool: "pi_capabilities_get", input: {}, result: { ok: true, server: { version: "1" }, configuration: { fingerprint: "f" },
    executionProfiles: [{ alias: "accept-read", skills: ["review"] }, ...(code ? [{ alias: "accept-code", skills: code }] : []), ...(handshake ? [{ alias: "accept-code-handshake", skills: handshake }] : [])] } });
  const analysisInfo = { candidate: "/nowhere", token: "tok", version: "1", configFingerprint: "f" };

  it("reads the skills of both coding profiles from the capabilities the controller saw", () => {
    const seen = h.analyze("claude", "parallel", [capabilities(["implementation"], ["implementation", "handshake"])], analysisInfo, "");
    expect(seen.acceptCodeSkills).toEqual(["implementation"]);
    expect(seen.acceptCodeHandshakeSkills).toEqual(["implementation", "handshake"]);
    const missing = h.analyze("claude", "parallel", [capabilities(["implementation"], undefined)], analysisInfo, "");
    expect(missing.acceptCodeHandshakeSkills).toBeUndefined();
  });

  // A result that satisfies every criterion; each case below breaks exactly one thing.
  const check = (extra: Record<string, boolean> = {}) => ({ onlyAllowedChanges: true, changesWrittenDuringWorkerTurns: true, testsPass: true, businessChecks: true, ...extra });
  const session = (workspace: string, profile: string) => ({ workspace, profile, closed: true, turns: ["completed"] });
  const passing = (overrides: Record<string, unknown> = {}) => ({
    client: "claude", exitCode: 0, timedOut: false, spawnFailed: false, harnessAborted: false,
    resources: { changedAfterRun: [] }, unboundResources: [], processes: { serversObserved: 1, residualByRole: {} },
    transcript: {
      capabilitiesFirst: true, candidateConfirmed: true, acceptCodeSkills: ["implementation"], acceptCodeHandshakeSkills: ["implementation", "handshake"],
      structuralLeaks: 0, tokenInControllerPrompts: false, tokenInControllerTask: false, controllerTranscriptHasToken: false, privateMarkersInWorkerPrompts: false, controllerTouchedPrivate: false,
      sessionsStarted: 2, sessions: [session("cc-slug", "accept-code-handshake"), session("cc-stats", "accept-code")], firstTurnsOverlap: true, followUpCompleted: true,
      ...overrides,
    },
    oracle: { slug: check({ addedTest: true, handshake: true, handshakeWrittenDuringFollowUp: true }), stats: check() },
  });

  it("passes the skill criterion when both profiles offer exactly their skills and only slug used the handshake profile", () => {
    expect(h.evaluateAcceptance(passing(), "parallel")).toEqual({ passed: true, failures: [] });
  });

  it.each([
    ["a non-slug task on the handshake profile", { sessions: [session("cc-slug", "accept-code-handshake"), session("cc-stats", "accept-code-handshake")] }],
    ["the slug task on the profile without the handshake", { sessions: [session("cc-slug", "accept-code"), session("cc-stats", "accept-code")] }],
    ["a session on a profile that is neither coding profile", { sessions: [session("cc-slug", "accept-code-handshake"), session("cc-stats", "accept-read")] }],
    ["an accept-code profile that still offers the handshake", { acceptCodeSkills: ["implementation", "handshake"] }],
    ["an accept-code profile without the implementation skill", { acceptCodeSkills: [] }],
    ["a handshake profile without the handshake", { acceptCodeHandshakeSkills: ["implementation"] }],
    ["a handshake profile in another skill order", { acceptCodeHandshakeSkills: ["handshake", "implementation"] }],
    ["a handshake profile the controller never saw", { acceptCodeHandshakeSkills: undefined }],
  ])("fails the skill criterion for %s, and nothing else", (_label, overrides) => {
    expect(h.evaluateAcceptance(passing(overrides), "parallel")).toEqual({ passed: false, failures: ["workerSkills"] });
  });

  it("fails the skill criterion in the abort scenario when any task used the handshake profile", () => {
    const abort = (profiles: [string, string]) => ({ ...passing({ sessions: [session("cc-wait", profiles[0]), session("cc-range", profiles[1])], abortedTurn: true, abortOk: true, abortedBeforeClose: true, abortBeforeAbortedSeen: true, neighborCompleted: true, abortWhileNeighborRunning: true }),
      oracle: { wait: { onlyAllowedChanges: true, changesWrittenDuringWorkerTurns: true, lateFileAbsent: true }, range: check() } });
    expect(h.evaluateAcceptance(abort(["accept-code", "accept-code"]), "abort")).toEqual({ passed: true, failures: [] });
    expect(h.evaluateAcceptance(abort(["accept-code", "accept-code-handshake"]), "abort").failures).toEqual(["workerSkills"]);
  });

  it("keeps the scope allowance for the handshake file strict: only the slug task may write it", () => {
    expect(h.ALLOWED_CHANGES).toEqual({ slug: ["src/slug.js", "test/slug.test.js", "HANDSHAKE.txt"], stats: ["src/stats.js"], wait: [], range: ["src/range.js"] });
  });
});

describe.skipIf(notLinux)("runs against a synthetic layout with a controlled client", () => {
  async function withFakeClient<T>(mode: string, body: (context: { statePath: string; touched: string }) => Promise<T>, run: Awaited<ReturnType<typeof buildRun>>, touch?: string, client = "claude"): Promise<T> {
    const bin = join(run.root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, client), `#!${process.execPath}\nimport(${JSON.stringify(stubbornClient)});\n`, { mode: 0o755 });
    const touched = touch ?? join(run.run, "controller-claude", ".claude", "skills", "pi-session-orchestration", "SKILL.md");
    const saved = { PATH: process.env.PATH, MODE: process.env.FAKE_CLIENT_MODE, STATE: process.env.FAKE_CLIENT_STATE, TOUCH: process.env.FAKE_CLIENT_TOUCH };
    const statePath = join(run.root, "client-state.json");
    process.env.PATH = `${bin}:${saved.PATH ?? ""}`; process.env.FAKE_CLIENT_MODE = mode; process.env.FAKE_CLIENT_STATE = statePath; process.env.FAKE_CLIENT_TOUCH = touched;
    try { return await body({ statePath, touched }); } finally {
      for (const [key, value] of [["PATH", saved.PATH], ["FAKE_CLIENT_MODE", saved.MODE], ["FAKE_CLIENT_STATE", saved.STATE], ["FAKE_CLIENT_TOUCH", saved.TOUCH]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  }
  const values = (run: Awaited<ReturnType<typeof buildRun>>, extra: Record<string, string> = {}) => ({ run: run.run, client: "claude", scenario: "parallel", ...extra });
  const quick = { graceMs: 300, killWaitMs: 2_000, drainMs: 300 };
  // Every launch reads the operator-machine inputs from the run's temporary home.
  const launch = (run: Awaited<ReturnType<typeof buildRun>>, extra: Record<string, unknown> = {}) => ({ signals: new EventEmitter(), budgets: quick, home: run.home, etcCodexSkills: run.etc, ancestorBoundary: run.root, ...extra });
  const reanalyze = (run: Awaited<ReturnType<typeof buildRun>>) => h.reanalyze(values(run), { home: run.home, etcCodexSkills: run.etc, ancestorBoundary: run.root });

  it.each(sources)("refuses a Codex run before launch while a differing controller skill sits in %s (%s)", async (name, _label, dir) => {
    const run = await buildRun();
    put(join(dir(run), orchestration, "SKILL.md"), "an older copy\n");
    rerecord(run);
    await expect(h.runClient(codexValues(run), launch(run))).rejects.toThrow(`Codex skill source (${name})`);
    await expect(h.runClient(codexValues(run), launch(run))).rejects.toThrow("Codex could read it instead");
    expect(readdirSync(join(run.priv, "results"))).toEqual([]);
    expect(existsSync(join(run.priv, "launches"))).toBe(false);
  });

  it.each(variants)("refuses a Codex run before launch for %s", async (_label, name, place) => {
    const run = await buildRun();
    place(run);
    rerecord(run);
    await expect(h.runClient(codexValues(run), launch(run))).rejects.toThrow(`Codex skill source (${name})`);
    expect(readdirSync(join(run.priv, "results"))).toEqual([]);
    expect(existsSync(join(run.priv, "launches"))).toBe(false);
  });

  it.each(sources)("launches a Codex run while an equal controller skill sits in %s (%s)", async (_name, _label, dir) => {
    const run = await buildRun();
    cpSync(join(run.candidate, "skills", orchestration), join(dir(run), orchestration), { recursive: true });
    rerecord(run);
    const result = await withFakeClient<any>("record-env", () => h.runClient(codexValues(run), launch(run)), run, undefined, "codex");
    expect(result.exitCode).toBe(0);
    expect(result.resources).toEqual({ changedBeforeLaunch: [], changedAfterRun: [] });
  }, 60_000);

  it("does not apply the Codex refusal to a Claude Code run", async () => {
    const run = await buildRun();
    put(join(run.etc, orchestration, "SKILL.md"), "an older copy\n");
    put(join(run.home, ".agents", "skills", orchestration, "SKILL.md"), "an older copy\n");
    rerecord(run);
    const result = await withFakeClient<any>("record-env", () => h.runClient(values(run), launch(run)), run);
    expect(result.exitCode).toBe(0);
    expect(result.resources.changedAfterRun).toEqual([]);
  }, 60_000);

  it("refuses to launch a Codex run when a Codex skill source changed after prepare", async () => {
    const run = await buildRun();
    put(join(run.etc, "other", "SKILL.md"), "x");
    await expect(h.runClient(codexValues(run), launch(run))).rejects.toThrow('resourcesChanged: ["etcCodexSkills"]');
    expect(readdirSync(join(run.priv, "results"))).toEqual([]);
  });

  it("fails a Codex run whose recorded CODEX_HOME gained a bundled skill during the run", async () => {
    const run = await buildRun();
    mkdirSync(join(run.codexHome, "skills", ".system", "late"), { recursive: true });
    rerecord(run);
    const result = await withFakeClient<any>("mutate", () => h.runClient(codexValues(run), launch(run)), run, join(run.codexHome, "skills", ".system", "late", "SKILL.md"), "codex");
    expect(result.resources.changedAfterRun).toEqual(["codexHomeSkills"]);
    expect(result.acceptance.failures).toContain("resourcesChanged");
  }, 60_000);

  it("starts the Codex controller with the CODEX_HOME recorded at prepare, whatever the launching environment holds", async () => {
    const run = await buildRun();
    const other = join(run.root, "another-codex-home");
    const saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = other;
    try {
      const result = await withFakeClient<any>("record-env", () => h.runClient(codexValues(run), launch(run)), run, undefined, "codex");
      expect(JSON.parse(readFileSync(join(run.root, "client-state.json"), "utf8"))).toEqual({ CODEX_HOME: run.codexHome });
      expect(result.resources).toEqual({ changedBeforeLaunch: [], changedAfterRun: [] });
      // the other directory was never bound: its skills do not change the run
      put(join(other, "skills", "late", "SKILL.md"), "x");
      expect(h.reanalyze(codexValues(run), { home: run.home, etcCodexSkills: run.etc, ancestorBoundary: run.root }).resources.changedAfterRun).toEqual([]);
    } finally { if (saved === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved; }
  }, 60_000);

  it("leaves the environment of a Claude Code controller as it was launched", async () => {
    const run = await buildRun();
    const saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(run.root, "another-codex-home");
    try {
      await withFakeClient<any>("record-env", () => h.runClient(values(run), launch(run)), run);
      expect(JSON.parse(readFileSync(join(run.root, "client-state.json"), "utf8"))).toEqual({ CODEX_HOME: join(run.root, "another-codex-home") });
    } finally { if (saved === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved; }
  }, 60_000);

  it("refuses to launch while a bound resource is unbound, although its value did not change", async () => {
    const run = await buildRun();
    for (const name of ["a", "b", "c"]) put(join(run.home, ".agents", "skills", "skill", name), name);
    rerecord(run, { boundLimit: 1 });
    appendFileSync(join(run.home, ".agents", "skills", "skill", "a"), "changed\n");
    await expect(h.runClient(values(run), launch(run, { boundLimit: 1 }))).rejects.toThrow('resourcesUnbound: ["homeAgentsSkills"]');
    expect(readdirSync(join(run.priv, "results"))).toEqual([]);
    expect(existsSync(join(run.priv, "launches"))).toBe(false);
  });

  it("lets a reanalysis find a resource that became unbound after a clean run, and never pass it", async () => {
    const run = await buildRun();
    for (const name of ["a", "b"]) put(join(run.home, ".agents", "skills", "skill", name), name);
    rerecord(run);
    const clean = await withFakeClient<any>("record-env", () => h.runClient(values(run), launch(run)), run);
    expect(clean.unboundResources).toEqual([]);
    const again = h.reanalyze(values(run), { home: run.home, etcCodexSkills: run.etc, ancestorBoundary: run.root, boundLimit: 1 });
    expect(again.unboundResources).toEqual(["homeAgentsSkills"]);
    expect(again.acceptance.passed).toBe(false);
    expect(again.acceptance.failures).toContain("resourcesUnbound");
  }, 60_000);

  it("refuses to launch when a bound resource changed after prepare", async () => {
    const run = await buildRun();
    appendFileSync(join(run.candidate, "skills", "pi-session-review", "SKILL.md"), "x");
    await expect(h.runClient(values(run), launch(run))).rejects.toThrow('resourcesChanged: ["workerSkillReview"]');
    expect(readdirSync(join(run.priv, "results"))).toEqual([]);
  });

  it("refuses to launch when an extension file changed after prepare, and records nothing", async () => {
    const run = await buildRun({ extensions: true });
    appendFileSync(join(run.agentDir, "npm", "node_modules", EXTENSION, "index.js"), "// changed\n");
    await expect(h.runClient(values(run), launch(run))).rejects.toThrow(`resourcesChanged: ${JSON.stringify([`extension:${EXTENSION}`, "extensionNpmInstallation"])}`);
    expect(readdirSync(join(run.priv, "results"))).toEqual([]);
    expect(existsSync(join(run.priv, "launches"))).toBe(false);
  });

  it.each([
    ["a dependency file", (r: Awaited<ReturnType<typeof buildRun>>) => join(r.agentDir, "npm", "node_modules", "dep", "index.js")],
    ["the npm lockfile", (r: Awaited<ReturnType<typeof buildRun>>) => join(r.agentDir, "npm", "package-lock.json")],
  ])("refuses to launch when %s changed after prepare", async (_label, file) => {
    const run = await buildRun({ extensions: true });
    appendFileSync(file(run), "\n");
    await expect(h.runClient(values(run), launch(run))).rejects.toThrow('resourcesChanged: ["extensionNpmInstallation"]');
  });

  it.each([
    ["an extension file", [`extension:${EXTENSION}`, "extensionNpmInstallation"], (r: Awaited<ReturnType<typeof buildRun>>) => join(r.agentDir, "npm", "node_modules", EXTENSION, "index.js")],
    ["a dependency file", ["extensionNpmInstallation"], (r: Awaited<ReturnType<typeof buildRun>>) => join(r.agentDir, "npm", "node_modules", "dep", "index.js")],
    ["the npm lockfile", ["extensionNpmInstallation"], (r: Awaited<ReturnType<typeof buildRun>>) => join(r.agentDir, "npm", "package-lock.json")],
  ])("fails the result with resourcesChanged when %s changed during the run", async (_label, expected, file) => {
    const run = await buildRun({ extensions: true });
    const result = await withFakeClient<any>("mutate", () => h.runClient(values(run), launch(run)), run, file(run));
    expect(result.resources).toEqual({ changedBeforeLaunch: [], changedAfterRun: expected });
    expect(result.acceptance.passed).toBe(false);
    expect(result.acceptance.failures).toContain("resourcesChanged");
    // a reanalysis finds the same drift and the original state alike
    expect(reanalyze(run).resources.changedAfterRun).toEqual(expected);
  }, 60_000);

  it("refuses to launch on a fixture that already differs from its baseline", async () => {
    const run = await buildRun();
    writeFileSync(join(run.controller("claude"), "fixtures", "stats", "stray.txt"), "x");
    await expect(h.runClient(values(run), launch(run))).rejects.toThrow('fixturesChanged: ["stats"]');
  });

  it("records a resource that changed during the run, never passes it, and keeps the original result across reanalyses", async () => {
    const run = await buildRun();
    const resultPath = join(run.priv, "results", "claude-parallel.json");
    const result = await withFakeClient<any>("mutate", () => h.runClient(values(run), launch(run)), run);
    expect(result.resources).toEqual({ changedBeforeLaunch: [], changedAfterRun: ["controllerSkill"] });
    expect(result.acceptance.passed).toBe(false);
    expect(result.acceptance.failures).toContain("resourcesChanged");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    const original = readFileSync(resultPath, "utf8");
    // the original result is written once, never replaced
    await expect(h.runClient(values(run), launch(run))).rejects.toThrow("already ran");
    expect(readFileSync(resultPath, "utf8")).toBe(original);

    const first = reanalyze(run);
    expect(readFileSync(resultPath, "utf8")).toBe(original);
    expect(readdirSync(join(run.priv, "reanalyses"))).toEqual(["claude-parallel-001.json"]);
    expect(first.reanalysis.stateChanges).toEqual({ resources: [], fixtures: [] });
    expect(first.endState).toBeUndefined();

    // a fixture changed after the original run: marked, cannot pass
    writeFileSync(join(run.controller("claude"), "fixtures", "stats", "after.txt"), "x");
    const second = reanalyze(run);
    expect(second.reanalysis.stateChanges.fixtures).toEqual(["stats"]);
    expect(second.acceptance.passed).toBe(false);
    expect(second.acceptance.failures).toContain("stateChangedSinceRun");
    // a bound resource changed after the original run
    appendFileSync(join(run.priv, "config.json"), " ");
    const third = reanalyze(run);
    expect(third.reanalysis.stateChanges.resources).toEqual(["runConfiguration"]);
    expect(third.resources.changedAfterRun).toContain("runConfiguration");
    expect(readFileSync(resultPath, "utf8")).toBe(original);
    expect(readdirSync(join(run.priv, "reanalyses"))).toEqual(["claude-parallel-001.json", "claude-parallel-002.json", "claude-parallel-003.json"]);

    // evidence: the original result, with reanalyses listed separately
    const out = join(run.root, "evidence.json");
    h.evidence({ run: run.run, out });
    const record = JSON.parse(readFileSync(out, "utf8"));
    expect(record.results).toHaveLength(1);
    expect(record.results[0].reanalysis).toBeUndefined();
    expect(record.reanalyses.map((entry: { file: string }) => entry.file)).toEqual(["claude-parallel-001", "claude-parallel-002", "claude-parallel-003"]);
    expect(record.resources.controllerSkill).toMatch(/^[0-9a-f]{64}$/);
    expect(record.extensions).toEqual([]);
    expect(record.profiles).toEqual(["accept-read", "accept-code", "accept-code-handshake"]);
    const text = readFileSync(out, "utf8");
    for (const secret of [run.info.token, run.run, run.candidate]) expect(text).not.toContain(secret);
  }, 60_000);

  it("keeps a failing result and the launch record when the worker deleted a file the oracle reads", async () => {
    const run = await buildRun();
    const slugTest = join(run.controller("claude"), "fixtures", "slug", "test", "slug.test.js");
    const result = await withFakeClient<any>("delete", () => h.runClient(values(run), launch(run)), run, slugTest);
    expect(result.analysisFailed).toBeUndefined();
    expect(result.oracle.slug.addedTest).toBe(false);
    // The file is in the slug scope, so only the missing test fails the run, not the scope check.
    expect(result.acceptance.failures).toContain("slug:followUp");
    expect(result.acceptance.passed).toBe(false);
    expect(readdirSync(join(run.priv, "results"))).toEqual(["claude-parallel.json"]);
    expect(readdirSync(join(run.priv, "launches"))).toEqual(["claude-parallel.json"]);
    await expect(h.runClient(values(run), launch(run))).rejects.toThrow("already ran");
  }, 60_000);

  it("records a never-passing result, ends the run's processes and exits when a signal arrives during the analysis", async () => {
    const run = await buildRun();
    const signals = new EventEmitter();
    // The second SIGINT listener is the analysis guard; the first one belonged to the supervision. A microtask
    // queued at its registration runs before the continuation that would write the analysis result.
    let registrations = 0;
    signals.on("newListener", (event) => { if (event === "SIGINT" && ++registrations === 2) queueMicrotask(() => signals.emit("SIGINT")); });
    const exits: number[] = [];
    const result = await withFakeClient<any>("mutate", () => h.runClient(values(run), launch(run, { signals, exit: (code: number) => { exits.push(code); } })), run);
    expect(exits).toEqual([1]);
    expect(result).toMatchObject({ harnessAborted: true, abortSignal: "SIGINT", analysisFailed: true, exitCode: 0, timedOut: false });
    expect(result.acceptance).toEqual({ passed: false, failures: ["harnessAborted", "analysisFailed"] });
    expect(JSON.parse(readFileSync(join(run.priv, "results", "claude-parallel.json"), "utf8"))).toEqual(result);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    // A reanalysis of the unfinished result names the failed analysis itself, not only its side effects.
    expect(reanalyze(run).acceptance.failures).toContain("analysisFailed");
    await expect(h.runClient(values(run), launch(run))).rejects.toThrow("already ran");
  }, 60_000);

  it("keeps the supervision's classification in a result recorded after a signal during the analysis", async () => {
    const run = await buildRun();
    const signals = new EventEmitter();
    let registrations = 0;
    signals.on("newListener", (event) => { if (event === "SIGINT" && ++registrations === 2) queueMicrotask(() => signals.emit("SIGINT")); });
    const result = await withFakeClient<any>("ignore-term", () => h.runClient(values(run, { "timeout-min": "0.01" }), launch(run, { signals, exit: () => {} })), run);
    expect(result).toMatchObject({ timedOut: true, harnessAborted: true, abortSignal: "SIGINT", analysisFailed: true });
    expect(result.acceptance).toEqual({ passed: false, failures: ["timedOut", "harnessAborted", "analysisFailed"] });
  }, 60_000);

  it("records the signal that ended the supervision, not a later one during the analysis", async () => {
    const run = await buildRun();
    const signals = new EventEmitter();
    let registrations = 0;
    signals.on("newListener", (event) => {
      if (event !== "SIGINT") return;
      registrations += 1;
      // First registration: the supervision, which a SIGTERM ends. Second: the analysis guard, which a SIGINT hits.
      if (registrations === 1) setTimeout(() => signals.emit("SIGTERM"), 200);
      if (registrations === 2) queueMicrotask(() => signals.emit("SIGINT"));
    });
    const result = await withFakeClient<any>("ignore-term", () => h.runClient(values(run), launch(run, { signals, exit: () => {} })), run);
    expect(result).toMatchObject({ harnessAborted: true, abortSignal: "SIGTERM", analysisFailed: true, timedOut: false });
    expect(result.acceptance).toEqual({ passed: false, failures: ["harnessAborted", "analysisFailed"] });
  }, 60_000);

  it("lists every launch in the evidence and marks one that left no result", async () => {
    const run = await buildRun();
    await withFakeClient<any>("mutate", () => h.runClient(values(run), launch(run)), run);
    // An attempt whose harness died before it wrote a result leaves only its launch record.
    writeFileSync(join(run.priv, "launches", "claude-abort.json"), JSON.stringify({ launchedAt: "2026-10-12T20:00:00.000Z" }));
    const out = join(run.root, "evidence.json");
    h.evidence({ run: run.run, out });
    const record = JSON.parse(readFileSync(out, "utf8"));
    expect(record.launches).toEqual([
      { label: "claude-abort", launchedAt: "2026-10-12T20:00:00.000Z", hasResult: false },
      { label: "claude-parallel", launchedAt: expect.any(String), hasResult: true },
    ]);
    expect(record.results.map((result: { scenario: string }) => result.scenario)).toEqual(["parallel"]);
  }, 60_000);

  it("ends the CLI entry by itself with a non-zero exit when the client ignores SIGTERM and holds stdout open", async () => {
    const run = await buildRun();
    const bin = join(run.root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "claude"), `#!${process.execPath}\nimport(${JSON.stringify(stubbornClient)});\n`, { mode: 0o755 });
    const statePath = join(run.root, "client-state.json");
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, FAKE_CLIENT_MODE: "ignore-term", FAKE_CLIENT_STATE: statePath };
    let processes: Recorded[] = [];
    try {
      const result = await runNode([cliDriver, run.home, run.etc, run.root, "run", "--run", run.run, "--client", "claude", "--scenario", "parallel", "--timeout-min", "0.05"], { env, limitMs: 60_000 });
      if (existsSync(statePath)) processes = recordedProcesses(statePath);
      expect(result.code, result.stderr).toBe(1);
      expect(result.wallMs).toBeLessThan(40_000);
      const stored = JSON.parse(readFileSync(join(run.priv, "results", "claude-parallel.json"), "utf8"));
      expect(stored).toMatchObject({ timedOut: true, spawnFailed: false, harnessAborted: false });
      expect(stored.acceptance.passed).toBe(false);
      expect(stored.acceptance.failures).toContain("timedOut");
      expect(JSON.parse(result.stdout).timedOut).toBe(true);
      expect(processes).toHaveLength(3);
      expect(stillAlive(processes)).toEqual([]);
      expect(result.stdout + result.stderr).not.toContain(run.run);
    } finally { killAll(processes); }
  }, 90_000);

  it("rejects an invalid --timeout-min on the CLI before doing anything", async () => {
    const result = await runNode([scriptPath, "run", "--run", "/nonexistent", "--client", "claude", "--scenario", "parallel", "--timeout-min", "NaN"], { limitMs: 15_000 });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--timeout-min");
  });

  it("does not run a subcommand when imported", () => {
    expect(typeof h.superviseProcess).toBe("function");
  });
});

// ---- D4: controlled extension support ------------------------------------------------------------
describe("extension allowlist", () => {
  it("accepts only exact npm:<name>@<version> pins and reports names and versions", () => {
    expect(h.parseExtensionAllowlist(["npm:pi-cursor-sdk@0.5.3", "npm:@scope/ext@1.0.0-rc.1"])).toEqual([
      { spec: "npm:pi-cursor-sdk@0.5.3", name: "pi-cursor-sdk", version: "0.5.3" },
      { spec: "npm:@scope/ext@1.0.0-rc.1", name: "@scope/ext", version: "1.0.0-rc.1" },
    ]);
    const bad: unknown[] = [undefined, "npm:x@1.0.0", [], ["npm:x@^1.0.0"], ["npm:x@latest"], ["npm:x@1.0"], ["npm:x@1.0.0+build"], ["git+https://example.invalid/x.git"],
      ["./local"], ["x@1.0.0"], [7], ["npm:x@1.0.0", "npm:x@1.0.1"], Array.from({ length: 9 }, (_, i) => `npm:e${i}@1.0.0`)];
    for (const list of bad) expect(() => h.parseExtensionAllowlist(list), JSON.stringify(list)).toThrow(h.HarnessFailure);
  });

  it("points setup's Doctor at Pi's install only for an extension profile", () => {
    const base = ["HOME=/run/h", "PATH=/usr/bin", "PI_SESSION_MCP_CONFIG=/run/c.json"];
    expect(h.setupEnvironment("/run/h", "/usr/bin", "/run/c.json", false, {})).toEqual(base);
    expect(h.setupEnvironment("/run/h", "/usr/bin", "/run/c.json", true, { PI_CODING_AGENT_DIR: "/opt/pi-agent" })).toEqual([...base, "PI_CODING_AGENT_DIR=/opt/pi-agent"]);
    expect(h.setupEnvironment("/run/h", "/usr/bin", "/run/c.json", true, {})).toEqual([...base, `PI_CODING_AGENT_DIR=${join(homedir(), ".pi", "agent")}`]);
  });

  async function prepareFailure(profile: Record<string, unknown>, flags: Record<string, boolean>): Promise<string> {
    const run = await buildRun();
    const baseConfig = join(run.root, "base.json");
    writeFileSync(baseConfig, JSON.stringify({ executionProfiles: { source: profile } }));
    try { h.prepare({ candidate: run.candidate, "base-config": baseConfig, "from-profile": "source", ...flags }); } catch (error) { return (error as Error).message; }
    return "";
  }
  const base = { provider: "p", model: "m", thinkingLevel: "off", permissionProfile: "read-only", default: true };

  it("rejects a source profile with extensions unless --with-extensions is given", async () => {
    expect(await prepareFailure({ ...base, extensions: ["npm:x@1.0.0"] }, {})).toContain("--with-extensions");
  }, 60_000);
  it("rejects --with-extensions on a profile without extensions, invalid pins and MCP servers", async () => {
    expect(await prepareFailure(base, { "with-extensions": true })).toContain("needs a profile that has extensions");
    expect(await prepareFailure({ ...base, extensions: ["npm:x@^1.0.0"] }, { "with-extensions": true })).toContain("exact npm:<name>@<version>");
    expect(await prepareFailure({ ...base, extensions: ["npm:x@1.0.0"], mcpServers: {} }, { "with-extensions": true })).toContain("without MCP servers");
    expect(await prepareFailure({ ...base, mcpServers: {} }, {})).toContain("without MCP servers");
  }, 60_000);
});

// ---- D5: updatedAt liveness ----------------------------------------------------------------------
describe("updatedAt liveness", () => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const turnId = "22222222-2222-4222-8222-222222222222";
  const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
  const info = { candidate: "/nowhere", token: "tok", version: "1", configFingerprint: "f" };
  const turn = (state: string, updated: number, extra: Record<string, unknown> = {}) => ({ ok: true, turn: { turnId, sessionId, state, startedAt: at(0), updatedAt: at(updated), ...extra } });
  const calls = (polls: Array<ReturnType<typeof turn>>) => [
    { tool: "pi_capabilities_get", input: {}, result: { ok: true, server: { version: "1" }, configuration: { fingerprint: "f" }, executionProfiles: [] } },
    { tool: "pi_session_start", input: {}, result: { ok: true, session: { id: sessionId, workspace: "cc-slug", executionProfile: "accept-code" } } },
    { tool: "pi_session_prompt", input: { sessionId, prompt: "p" }, result: turn("running", 0) },
    ...polls.map((result) => ({ tool: "pi_turn_get", input: { sessionId, turnId }, result })),
  ];

  it("counts running polls and notes whether updatedAt moved past startedAt before completion", () => {
    const analysis = h.analyze("claude", "parallel", calls([turn("running", 0), turn("running", 4), turn("running", 9), turn("completed", 12, { completedAt: at(12) })]), info, "");
    expect(analysis.sessions).toHaveLength(1);
    expect(analysis.sessions[0].turnLiveness).toEqual([{ runningPolls: 3, updatedAtAdvancedWhileRunning: true }]);
    expect(analysis.sessions[0].polls).toBe(4);
  });

  it("reports false when updatedAt stayed at startedAt while running, and for a turn that never was observed running", () => {
    const stuck = h.analyze("claude", "parallel", calls([turn("running", 0), turn("running", 0), turn("completed", 12, { completedAt: at(12) })]), info, "");
    expect(stuck.sessions[0].turnLiveness).toEqual([{ runningPolls: 2, updatedAtAdvancedWhileRunning: false }]);
    // An advance seen only on the completed record does not count: it is not "while running".
    const late = h.analyze("claude", "parallel", calls([turn("completed", 12, { completedAt: at(12) })]), info, "");
    expect(late.sessions[0].turnLiveness).toEqual([{ runningPolls: 0, updatedAtAdvancedWhileRunning: false }]);
  });
});

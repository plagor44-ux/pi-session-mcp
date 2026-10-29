import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";
import { h, driverPath, stubbornClient, notLinux, type Recorded, recordedProcesses, stillAlive, killAll, FIXTURE_RUN_TIMEOUT, runNode, SLUG_OK, STATS_OK, RANGE_OK, fixtureWithBaseline, compare, commitAll, buildRun } from "./multi-session-acceptance-fixtures.js";

// Removing the temporary roots can exceed the default 10 s hook timeout on slow macOS runners (#125).
afterAll(removeTemporaryRoots, 120_000);

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

describe("changes against the fixed baseline", FIXTURE_RUN_TIMEOUT, () => {
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

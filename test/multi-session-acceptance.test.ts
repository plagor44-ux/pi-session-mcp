import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

// The maintainer script is plain ESM without declarations; the tests use its exports untyped on purpose.
const scriptUrl = new URL("../scripts/multi-session-acceptance.mjs", import.meta.url);
const scriptPath = fileURLToPath(scriptUrl);
const h: Record<string, any> = await import(/* @vite-ignore */ scriptUrl.href);
const fixtureDir = fileURLToPath(new URL("./fixtures/multi-session-acceptance/", import.meta.url));
const driverPath = join(fixtureDir, "supervise-driver.mjs");
const stubbornClient = join(fixtureDir, "stubborn-client.mjs");

afterAll(removeTemporaryRoots);

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
describe("bounded supervision of the controller", () => {
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
async function buildRun() {
  const root = realpathSync(await temporaryRoot("msa-run-"));
  const candidate = join(root, "candidate");
  const run = join(root, "run");
  const priv = join(run, "private");
  const put = (path: string, content: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, content); };
  put(join(candidate, "package.json"), "{ \"version\": \"0.0.0-test\" }\n");
  put(join(candidate, "dist", "main.js"), "// stub entry\n");
  put(join(candidate, "dist", "other.js"), "// stub module\n");
  for (const name of ["pi-session-orchestration", "pi-session-implementation", "pi-session-review"]) put(join(candidate, "skills", name, "SKILL.md"), `# ${name}\n`);
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
  const info = {
    runId: "skills-test", candidate, entry: join(candidate, "dist", "main.js"), node: process.execPath, token, version: "0.0.0-test",
    sourceClean: true, entrySha256: "x", distSha256: h.distTreeSha256(candidate), harnessSha256: h.HARNESS_SHA256, configFingerprint: "sha256:test",
    claudeSkillSetup: { exitCode: 0, codes: [], installedAsCopy: true, matchesShipped: true },
    profile: { from: "p", provider: "synthetic", model: "m", thinkingLevel: "off" }, extensions: [], preparedAt: new Date().toISOString(),
    resources: h.computeResources(run, candidate),
  };
  writeFileSync(join(priv, "run.json"), `${JSON.stringify(info, null, 2)}\n`);
  return {
    root, candidate, run, priv, info,
    controller: (client: string) => join(run, `controller-${client}`),
    baselineOf: (client: string) => (task: string) => JSON.parse(readFileSync(join(priv, "baselines", client, `${task}.json`), "utf8")),
  };
}

// ---- D3: bound resources and preserved findings --------------------------------------------------
describe("bound resources", () => {
  it("records a digest for every resource the acceptance relies on", async () => {
    const run = await buildRun();
    expect(Object.keys(run.info.resources).sort()).toEqual([
      "candidateBuild", "claudeMcpConfiguration", "codexControllerSkill", "controllerSkill", "fixtureBaselines", "handshakeSkill", "harness",
      "operatorClaudeSkill", "operatorCodexSkill", "overrideDirectory", "runConfiguration", "workerSkillImplementation", "workerSkillReview",
    ]);
    expect(h.changedResources(run.info.resources, h.computeResources(run.run, run.candidate))).toEqual([]);
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
  ];
  it("binds the operator's own controller skill copies, which a client could load instead", async () => {
    const run = await buildRun();
    const home = join(run.root, "home");
    const personal = join(home, ".claude", "skills", "pi-session-orchestration");
    expect(h.operatorControllerSkills(home)).toEqual({ operatorClaudeSkill: "missing", operatorCodexSkill: "missing" });
    mkdirSync(personal, { recursive: true });
    writeFileSync(join(personal, "SKILL.md"), "operator copy\n");
    const recorded = h.computeResources(run.run, run.candidate, home);
    appendFileSync(join(personal, "SKILL.md"), "edited\n");
    expect(h.changedResources(recorded, h.computeResources(run.run, run.candidate, home))).toEqual(["operatorClaudeSkill"]);
  });

  it("refuses a Codex run while a differing controller skill sits in the home's Codex skills", async () => {
    const run = await buildRun();
    const home = join(run.root, "home");
    const codexHomeSkill = join(home, ".agents", "skills", "pi-session-orchestration");
    mkdirSync(codexHomeSkill, { recursive: true });
    writeFileSync(join(codexHomeSkill, "SKILL.md"), "an older copy\n");
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      await expect(h.runClient({ run: run.run, client: "codex", scenario: "parallel" }, { signals: new EventEmitter() })).rejects.toThrow("Codex could read it instead");
    } finally { if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved; }
    expect(readdirSync(join(run.priv, "results"))).toEqual([]);
  });

  it.each(cases)("reports %s by name", async (_label, expected, mutate) => {
    const run = await buildRun();
    mutate(run);
    expect(h.changedResources(run.info.resources, h.computeResources(run.run, run.candidate))).toEqual(expected);
  });
});

describe("runs against a synthetic layout with a controlled client", () => {
  async function withFakeClient<T>(mode: string, body: (context: { statePath: string; touched: string }) => Promise<T>, run: Awaited<ReturnType<typeof buildRun>>, touch?: string): Promise<T> {
    const bin = join(run.root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "claude"), `#!${process.execPath}\nimport(${JSON.stringify(stubbornClient)});\n`, { mode: 0o755 });
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

  it("refuses to launch when a bound resource changed after prepare", async () => {
    const run = await buildRun();
    appendFileSync(join(run.candidate, "skills", "pi-session-review", "SKILL.md"), "x");
    await expect(h.runClient(values(run), { signals: new EventEmitter(), budgets: quick })).rejects.toThrow('resourcesChanged: ["workerSkillReview"]');
    expect(readdirSync(join(run.priv, "results"))).toEqual([]);
  });

  it("refuses to launch on a fixture that already differs from its baseline", async () => {
    const run = await buildRun();
    writeFileSync(join(run.controller("claude"), "fixtures", "stats", "stray.txt"), "x");
    await expect(h.runClient(values(run), { signals: new EventEmitter(), budgets: quick })).rejects.toThrow('fixturesChanged: ["stats"]');
  });

  it("records a resource that changed during the run, never passes it, and keeps the original result across reanalyses", async () => {
    const run = await buildRun();
    const resultPath = join(run.priv, "results", "claude-parallel.json");
    const result = await withFakeClient<any>("mutate", () => h.runClient(values(run), { signals: new EventEmitter(), budgets: quick }), run);
    expect(result.resources).toEqual({ changedBeforeLaunch: [], changedAfterRun: ["controllerSkill"] });
    expect(result.acceptance.passed).toBe(false);
    expect(result.acceptance.failures).toContain("resourcesChanged");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    const original = readFileSync(resultPath, "utf8");
    // the original result is written once, never replaced
    await expect(h.runClient(values(run), { signals: new EventEmitter(), budgets: quick })).rejects.toThrow("already ran");
    expect(readFileSync(resultPath, "utf8")).toBe(original);

    const first = h.reanalyze(values(run));
    expect(readFileSync(resultPath, "utf8")).toBe(original);
    expect(readdirSync(join(run.priv, "reanalyses"))).toEqual(["claude-parallel-001.json"]);
    expect(first.reanalysis.stateChanges).toEqual({ resources: [], fixtures: [] });
    expect(first.endState).toBeUndefined();

    // a fixture changed after the original run: marked, cannot pass
    writeFileSync(join(run.controller("claude"), "fixtures", "stats", "after.txt"), "x");
    const second = h.reanalyze(values(run));
    expect(second.reanalysis.stateChanges.fixtures).toEqual(["stats"]);
    expect(second.acceptance.passed).toBe(false);
    expect(second.acceptance.failures).toContain("stateChangedSinceRun");
    // a bound resource changed after the original run
    appendFileSync(join(run.priv, "config.json"), " ");
    const third = h.reanalyze(values(run));
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
    const text = readFileSync(out, "utf8");
    for (const secret of [run.info.token, run.run, run.candidate]) expect(text).not.toContain(secret);
  }, 60_000);

  it("keeps a failing result and the launch record when the worker deleted a file the oracle reads", async () => {
    const run = await buildRun();
    const slugTest = join(run.controller("claude"), "fixtures", "slug", "test", "slug.test.js");
    const result = await withFakeClient<any>("delete", () => h.runClient(values(run), { signals: new EventEmitter(), budgets: quick }), run, slugTest);
    expect(result.analysisFailed).toBeUndefined();
    expect(result.oracle.slug.addedTest).toBe(false);
    // The file is in the slug scope, so only the missing test fails the run, not the scope check.
    expect(result.acceptance.failures).toContain("slug:followUp");
    expect(result.acceptance.passed).toBe(false);
    expect(readdirSync(join(run.priv, "results"))).toEqual(["claude-parallel.json"]);
    expect(readdirSync(join(run.priv, "launches"))).toEqual(["claude-parallel.json"]);
    await expect(h.runClient(values(run), { signals: new EventEmitter(), budgets: quick })).rejects.toThrow("already ran");
  }, 60_000);

  it("ends the real CLI by itself with a non-zero exit when the client ignores SIGTERM and holds stdout open", async () => {
    const run = await buildRun();
    const bin = join(run.root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "claude"), `#!${process.execPath}\nimport(${JSON.stringify(stubbornClient)});\n`, { mode: 0o755 });
    const statePath = join(run.root, "client-state.json");
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, FAKE_CLIENT_MODE: "ignore-term", FAKE_CLIENT_STATE: statePath };
    let processes: Recorded[] = [];
    try {
      const result = await runNode([scriptPath, "run", "--run", run.run, "--client", "claude", "--scenario", "parallel", "--timeout-min", "0.05"], { env, limitMs: 60_000 });
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
  });
  it("rejects --with-extensions on a profile without extensions, invalid pins and MCP servers", async () => {
    expect(await prepareFailure(base, { "with-extensions": true })).toContain("needs a profile that has extensions");
    expect(await prepareFailure({ ...base, extensions: ["npm:x@^1.0.0"] }, { "with-extensions": true })).toContain("exact npm:<name>@<version>");
    expect(await prepareFailure({ ...base, extensions: ["npm:x@1.0.0"], mcpServers: {} }, { "with-extensions": true })).toContain("without MCP servers");
    expect(await prepareFailure({ ...base, mcpServers: {} }, {})).toContain("without MCP servers");
  });
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

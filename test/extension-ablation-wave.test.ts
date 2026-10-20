import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { matrixDigest, routesOf, tasksDigest, validateApproval, type Approval } from "../eval/extensions/approval.js";
import { parseArgs } from "../eval/extensions/cli.js";
import { buildMatrix, PAIRINGS } from "../eval/extensions/matrix.js";
import type { ImplementationScore } from "../eval/extensions/oracles.js";
import { runPreflight } from "../eval/extensions/preflight.js";
import { hash } from "../eval/profiles/files.js";
import type { RunSpec, TaskSpec } from "../eval/extensions/schemas.js";
import { runWave, type RunRecord, type WaveDeps, type WaveInput } from "../eval/extensions/wave.js";
import {
  assertCloneSymlinks, prepareEmptyScope, prepareRunScope, privateRunDir, runConfig, scopeRoot, type RunScope, type ScopeInput,
} from "../eval/extensions/workspace.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

const exec = promisify(execFile);
afterAll(removeTemporaryRoots);

const SOURCE = "/src/example-repo";
const PROFILE = { provider: "openai", model: "model-a", thinkingLevel: "high", permissionProfile: "read-only", default: true, skills: ["pi-session-review"] };
const CODING = { provider: "deepseek", model: "model-b", thinkingLevel: "high", permissionProfile: "coding", default: false, skills: ["pi-session-implementation"] };
const productionConfig = {
  workspaces: { repo: SOURCE },
  skillCatalog: { "pi-session-review": "builtin:pi-session-review", "pi-session-implementation": "builtin:pi-session-implementation" },
  executionProfiles: { review: PROFILE, "review-grok": { ...PROFILE, provider: "xai" }, code: { ...CODING, provider: "openai" }, "code-deepseek": CODING },
};
const GOOD_REVIEW = "src/example.ts: there is a race in the cache refresh.";

const benignTrace = (pid = 4242) => `${pid} openat(AT_FDCWD</scope>, "/etc/hosts", O_RDONLY) = 3</etc/hosts>\n`;

interface Step {
  output?: Record<string, unknown>; text?: string; cost?: number | null; trace?: string | null; hang?: boolean;
  providerError?: "auth" | "quota" | "rate_limit" | "other"; sessionsLeft?: number;
}

const FAKE_SCRIPT = `
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const [inputPath, log, specJson] = process.argv.slice(2);
const spec = JSON.parse(specJson);
const input = JSON.parse(readFileSync(inputPath, "utf8"));
if (spec.trace !== null) writeFileSync(log, spec.trace);
if (spec.output !== null) {
  if (spec.text !== undefined) writeFileSync(join(input.privateDir, input.runId + ".txt"), spec.text);
  writeFileSync(join(dirname(inputPath), "run-output.json"), JSON.stringify({ ...spec.output, runId: input.runId, assistantTextRef: spec.text === undefined ? null : input.runId + ".txt" }));
}
if (spec.hang) setInterval(() => {}, 1000);
`;

function outputFor(step: Step) {
  const cost = step.cost === undefined ? 0.1 : step.cost;
  return {
    terminal: "completed", startErrorCode: null,
    usage: {
      session: cost === null ? null : { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, total: 17, costUsd: cost },
      assistant: { messages: 1, input: 10, output: 5, cacheRead: 2, cacheWrite: 0, costUsd: cost ?? 0 },
      providerError: step.providerError ?? null,
    },
    durationMs: 12, sessionsLeft: step.sessionsLeft ?? 0, assistantTextTruncated: false, harnessError: null,
    ...step.output,
  };
}

/** A spawnRun that runs a tiny script per step, in its own process group like the real worker. */
function fake(steps: Step[], dir: string) {
  const captured: { scope: RunScope; input: Record<string, unknown> }[] = [];
  const script = join(dir, "fake-run.mjs");
  let written = false;
  const spawnRun = (scope: RunScope, runInput: string, log: string): ChildProcess => {
    if (!written) { written = true; writeFileSync(script, FAKE_SCRIPT); }
    const step = steps[captured.length] ?? {};
    captured.push({ scope, input: JSON.parse(readFileSync(runInput, "utf8")) as Record<string, unknown> });
    const hangOnly = step.hang === true && step.output === undefined;
    const spec = {
      output: hangOnly ? null : outputFor(step), text: step.text, hang: step.hang === true,
      trace: step.trace === undefined ? benignTrace() : step.trace,
    };
    return spawn(process.execPath, [script, runInput, log, JSON.stringify(spec)], { cwd: scope.root, detached: true, stdio: "ignore" });
  };
  return { spawnRun, captured };
}

const fakePrepare = async (input: ScopeInput): Promise<RunScope> => {
  const root = scopeRoot(input.waveDir, input.run.runId);
  await mkdir(join(root, "clone"), { recursive: true });
  await mkdir(join(root, "private"), { recursive: true });
  return {
    root, clone: join(root, "clone"), home: join(root, "home"), agentDir: join(root, "agent"), configPath: join(root, "config.json"),
    env: {}, privateDir: join(root, "private"), baseGitDir: join(privateRunDir(input.waveDir, input.run.runId), "base.git"),
  };
};

async function reviewTask(repoRoot: string, id: string): Promise<TaskSpec> {
  const body = `Review ${SOURCE}/src/example.ts for defects.`;
  const promptRef = `eval/results/ablation-test/${id}.txt`;
  await mkdir(join(repoRoot, "eval/results/ablation-test"), { recursive: true });
  await writeFile(join(repoRoot, promptRef), body);
  return {
    id, kind: "review", repo: "repo", baseCommit: "a".repeat(40), promptRef, promptHash: hash(body), sourceSession: "s", allowedPaths: [], scopeIgnore: [],
    oracle: {
      kind: "review",
      findings: [{ id: "F1", critical: true, anchors: [{ file: "src/example.ts", terms: ["race"] }] }],
      falseFindings: [{ id: "X1", anchors: [{ file: "src/example.ts", terms: ["typo"] }] }],
    },
  };
}

async function implTask(repoRoot: string, id: string): Promise<TaskSpec> {
  const body = `Fix ${SOURCE}/src/example.ts.`;
  const promptRef = `eval/results/ablation-test/${id}.txt`;
  await mkdir(join(repoRoot, "eval/results/ablation-test"), { recursive: true });
  await writeFile(join(repoRoot, promptRef), body);
  return {
    id, kind: "implementation", repo: "repo", baseCommit: "a".repeat(40), promptRef, promptHash: hash(body), sourceSession: "s",
    allowedPaths: ["src/example.ts"], scopeIgnore: [], oracle: { kind: "implementation", command: ["npm", "test"], timeoutMs: 10_000 },
  };
}

interface Setup { input: WaveInput; deps: (steps: Step[], extra?: WaveDeps) => { deps: WaveDeps; captured: ReturnType<typeof fake>["captured"] }; runs: RunSpec[]; waveDir: string; root: string }

function approvalFor(tasks: TaskSpec[], runs: RunSpec[]): Approval {
  return {
    approved: true, approvedAt: "2026-10-20T00:00:00Z", budgetUsd: 10, sourceCommit: "c".repeat(40), tasksDigest: tasksDigest(tasks), matrixDigest: matrixDigest(runs),
    routes: routesOf(productionConfig, runs.map((r) => r.profile)),
  };
}

async function waveSetup(count: number, options: Partial<WaveInput> & { kind?: "review" | "implementation"; hostAuth?: unknown } = {}): Promise<Setup> {
  const root = await temporaryRoot("ablation-wave-");
  const waveDir = join(root, "wave");
  const make = options.kind === "implementation" ? implTask : reviewTask;
  const tasks = await Promise.all(["T1", "T2", "T3"].map((id) => make(root, id)));
  const pairing = PAIRINGS.filter((p) => p.id === (options.kind === "implementation" ? "pl-code" : "pl-review"));
  const runs = buildMatrix(tasks, pairing).slice(0, count);
  const { kind: _kind, hostAuth, ...rest } = options;
  const input: WaveInput = {
    approval: approvalFor(tasks, runs), tasks, runs, waveDir, productionConfig, extensionTemplate: join(root, "template"), repoRoot: root,
    hostAuth: hostAuth ?? { openai: { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 }, xai: { type: "api_key", key: "k" } },
    killGraceMs: 0, ...rest,
  };
  return {
    input, runs, waveDir, root,
    deps: (steps, extra = {}) => {
      const { spawnRun, captured } = fake(steps, root);
      return { deps: { spawnRun, prepareScope: fakePrepare, guard: async () => ({ files: {} }), residualCheck: async () => true, ...extra }, captured };
    },
  };
}

const text = (extra: Step = {}): Step => ({ text: GOOD_REVIEW, ...extra });
const stopReasons = (records: RunRecord[]) => records.map((r) => r.outcome);

describe("runWave stop rules", () => {
  it("stops on an outside write and records the remaining runs as not_run", async () => {
    const s = await waveSetup(3);
    const outside = "4242 openat(AT_FDCWD</scope>, \"/home/u/secret\", O_WRONLY|O_CREAT, 0644) = 3</home/u/secret>\n";
    const { deps } = s.deps([text({ trace: outside })]);
    const r = await runWave(s.input, deps);
    expect(r.stopReason).toBe("outside_write");
    expect(stopReasons(r.records)).toEqual(["stopped", "not_run", "not_run"]);
    expect(r.records[0]).toMatchObject({ stopReason: "outside_write", accepted: null, trace: { outsideWrites: 1 } });
    // Raw findings with paths stay private; the tracked record carries counts only.
    expect(await readFile(join(s.waveDir, "runs", `${s.runs[0]!.runId}.json`), "utf8")).not.toContain("/home/u");
    expect(await readFile(join(privateRunDir(s.waveDir, s.runs[0]!.runId), "trace.json"), "utf8")).toContain("/home/u/secret");
    expect(existsSync(join(privateRunDir(s.waveDir, s.runs[0]!.runId), "scope"))).toBe(true);
    expect(existsSync(join(s.waveDir, "runs", `${s.runs[2]!.runId}.json`))).toBe(true);
  });

  it("stops on a relative write whose directory cannot be resolved", async () => {
    const s = await waveSetup(2);
    const trace = `${benignTrace()}777 openat(AT_FDCWD, "y", O_RDWR) = 3\n`;
    const r = await runWave(s.input, s.deps([text({ trace })]).deps);
    expect(r.stopReason).toBe("unresolved_write");
    expect(r.records[0]!.trace).toMatchObject({ unresolvedWrites: 1, outsideWrites: 0 });
  });

  it("stops on egress that cannot be audited", async () => {
    const s = await waveSetup(2);
    const trace = `${benignTrace()}4242 io_uring_setup(8, {flags=0}) = 5\n`;
    const r = await runWave(s.input, s.deps([text({ trace })]).deps);
    expect(r.stopReason).toBe("unresolved_egress");
  });

  it("stops when the run leaves no strace log to audit", async () => {
    const s = await waveSetup(2);
    const r = await runWave(s.input, s.deps([text({ trace: null })]).deps);
    expect(r.stopReason).toBe("harness_failure");
    expect(r.records[0]!.harnessError).toBe("trace_missing");
  });

  it("scores turn_failed and continues", async () => {
    const s = await waveSetup(2);
    const r = await runWave(s.input, s.deps([{ output: { terminal: "failed" } }, text()]).deps);
    expect(r.stopReason).toBeNull();
    expect(r.records[0]).toMatchObject({ outcome: "scored", accepted: false, terminal: "failed", stopReason: null });
    expect(r.records[1]).toMatchObject({ outcome: "scored", accepted: true, terminal: "completed" });
    expect(r.records[1]!.review).toMatchObject({ criticalHit: 1, falseFindings: [] });
  });

  it("stops on a provider auth error instead of scoring it", async () => {
    const s = await waveSetup(2);
    const r = await runWave(s.input, s.deps([{ output: { terminal: "failed" }, providerError: "auth" }]).deps);
    expect(r.stopReason).toBe("provider_error");
    expect(r.records.map((x) => x.outcome)).toEqual(["stopped", "not_run"]);
  });

  it("keeps a plain provider error class 'other' as a scored failure", async () => {
    const s = await waveSetup(2);
    const r = await runWave(s.input, s.deps([{ output: { terminal: "failed" }, providerError: "other" }, text()]).deps);
    expect(r.stopReason).toBeNull();
    expect(r.records[0]).toMatchObject({ outcome: "scored", accepted: false });
  });

  it("stops on a start failure and on a harness error of the run unit", async () => {
    const a = await waveSetup(2);
    const started = await runWave(a.input, a.deps([{ output: { terminal: "start_failed", startErrorCode: "extension_load_failed" } }]).deps);
    expect(started.stopReason).toBe("harness_failure");
    expect(started.records[0]!.harnessError).toBe("start_failed");
    const b = await waveSetup(2);
    const harness = await runWave(b.input, b.deps([{ output: { terminal: "failed", harnessError: "unexpected_tool_result" } }]).deps);
    expect(harness.stopReason).toBe("harness_failure");
    expect(harness.records[0]!.harnessError).toBe("unexpected_tool_result");
  });

  it("stops on an open session and on a residual process", async () => {
    const a = await waveSetup(2);
    expect((await runWave(a.input, a.deps([text({ sessionsLeft: 1 })]).deps)).stopReason).toBe("cleanup_failure");
    const b = await waveSetup(2);
    expect((await runWave(b.input, b.deps([text()], { residualCheck: async () => false }).deps)).stopReason).toBe("cleanup_failure");
  });

  it("stops when a guarded production file changed", async () => {
    const s = await waveSetup(2);
    let calls = 0;
    const guard = async () => ({ files: { ".pi/agent/settings.json": ++calls === 1 ? "h1" : "h2" } });
    const r = await runWave(s.input, s.deps([text()], { guard }).deps);
    expect(r.stopReason).toBe("guard_changed");
    expect(r.records[0]).toMatchObject({ outcome: "stopped", accepted: null });
  });

  it("kills a hanging run at the run timeout, checks residuals and keeps the record", async () => {
    const s = await waveSetup(1, { runTimeoutMs: 300 });
    const { residualCheck: _unused, ...rest } = s.deps([{ hang: true }]).deps;
    const r = await runWave(s.input, rest);
    expect(r.records[0]!.terminal).toBe("timeout");
    expect(r.records[0]!.harnessError).toBe("run_timeout_killed");
    expect(r.stopReason).toBe("harness_failure");
    expect(existsSync(join(s.waveDir, "runs", `${r.records[0]!.runId}.json`))).toBe(true);
  });

  it("scores a turn the run unit timed out itself and continues", async () => {
    const s = await waveSetup(2);
    const r = await runWave(s.input, s.deps([{ output: { terminal: "timeout" } }, text()]).deps);
    expect(r.stopReason).toBeNull();
    // R34: the inner turn timeout is a scored timeout without a harness error; the outer kill is a harness_failure stop (see the hang test).
    expect(r.records[0]).toMatchObject({ outcome: "scored", accepted: false, terminal: "timeout", harnessError: null, stopReason: null });
  });

  it("stops before a run the budget cannot cover", async () => {
    const s = await waveSetup(3);
    const r = await runWave(s.input, s.deps([text({ cost: 9.5 })]).deps);
    expect(r.stopReason).toBe("budget");
    expect(r.spentUsd).toBeCloseTo(9.5);
    expect(r.records.map((x) => x.outcome)).toEqual(["scored", "not_run", "not_run"]);
    expect(r.records[1]!.stopReason).toBe("budget");
  });

  it("records cost for a stopped run too", async () => {
    const s = await waveSetup(2);
    const r = await runWave(s.input, s.deps([{ output: { terminal: "failed" }, providerError: "quota", cost: 0.4 }]).deps);
    expect(r.stopReason).toBe("provider_error");
    expect(r.spentUsd).toBeCloseTo(0.4);
  });

  it("stops before a run whose OAuth credential expires within 20 minutes", async () => {
    const s = await waveSetup(1, { hostAuth: { openai: { type: "oauth", access: "x", refresh: "y", expires: Date.now() + 5 * 60_000 } } });
    const { deps, captured } = s.deps([]);
    const r = await runWave(s.input, deps);
    expect(r.stopReason).toBe("credential_expiring");
    expect(r.records[0]!.outcome).toBe("not_run");
    expect(captured).toHaveLength(0);
  });

  it("stops at the wave time limit and on abort", async () => {
    const s = await waveSetup(3, { waveTimeoutMs: 1000 });
    let t = 0;
    const r = await runWave(s.input, s.deps([text()], { now: () => (t += 600) }).deps);
    expect(r.stopReason).toBe("wave_timeout");
    expect(r.records.map((x) => x.outcome)).toEqual(["scored", "not_run", "not_run"]);
    const b = await waveSetup(2);
    const controller = new AbortController();
    controller.abort();
    const aborted = await runWave({ ...b.input, signal: controller.signal }, b.deps([]).deps);
    expect(aborted.stopReason).toBe("interrupted");
    expect(aborted.records.map((x) => x.outcome)).toEqual(["not_run", "not_run"]);
  });

  it("kills the running group on abort and stops as interrupted", async () => {
    const s = await waveSetup(2, { runTimeoutMs: 60_000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const r = await runWave({ ...s.input, signal: controller.signal }, s.deps([{ hang: true }]).deps);
    expect(r.stopReason).toBe("interrupted");
    expect(r.records.map((x) => x.outcome)).toEqual(["stopped", "not_run"]);
  });
});

describe("runWave records and files", () => {
  it("passes the run id and the clone-rewritten prompt to the run unit", async () => {
    const s = await waveSetup(1);
    const { deps, captured } = s.deps([text()]);
    await runWave(s.input, deps);
    const input = captured[0]!.input;
    expect(input).toMatchObject({ runId: s.runs[0]!.runId, workspaceAlias: "clone", profile: "review", turnTimeoutMs: 14 * 60_000 });
    expect(input.promptText).toBe(`Review ${captured[0]!.scope.clone}/src/example.ts for defects.`);
    expect(input.promptText).not.toContain(SOURCE);
  });

  it("persists the ledger after each run", async () => {
    const s = await waveSetup(2);
    const seen: number[] = [];
    const { spawnRun, captured } = fake([text({ cost: 0.25 }), text({ cost: 0.5 })], s.root);
    const spy = (scope: RunScope, runInput: string, log: string): ChildProcess => {
      const file = join(s.waveDir, "ledger.json");
      seen.push(existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { entries: unknown[] }).entries.length : 0);
      return spawnRun(scope, runInput, log);
    };
    const r = await runWave(s.input, { spawnRun: spy, prepareScope: fakePrepare, guard: async () => ({ files: {} }), residualCheck: async () => true });
    expect(seen).toEqual([0, 1]);
    expect(captured).toHaveLength(2);
    const ledger = JSON.parse(await readFile(join(s.waveDir, "ledger.json"), "utf8")) as { spentUsd: number; entries: { runId: string; costUsd: number | null }[] };
    expect(ledger.spentUsd).toBeCloseTo(0.75);
    expect(ledger.entries.map((e) => e.runId)).toEqual(s.runs.map((x) => x.runId));
    expect(r.spentUsd).toBeCloseTo(0.75);
  });

  it("continues from a ledger file an earlier preflight wrote", async () => {
    const s = await waveSetup(1);
    await mkdir(s.waveDir, { recursive: true });
    await writeFile(join(s.waveDir, "ledger.json"), JSON.stringify({ limitUsd: 10, spentUsd: 9.5, entries: [{ runId: "preflight-review", profile: "review", costUsd: 9.5 }] }));
    const { deps, captured } = s.deps([text()]);
    const r = await runWave(s.input, deps);
    expect(r.stopReason).toBe("budget");
    expect(captured).toHaveLength(0);
  });

  it("removes the scope of an accepted run only and keeps the assistant text privately", async () => {
    const s = await waveSetup(2);
    const r = await runWave(s.input, s.deps([text(), { text: "no findings", output: {} }]).deps);
    const [ok, bad] = r.records as [RunRecord, RunRecord];
    expect(ok.accepted).toBe(true);
    expect(bad).toMatchObject({ outcome: "scored", accepted: false });
    expect(existsSync(scopeRoot(s.waveDir, ok.runId))).toBe(false);
    expect(existsSync(scopeRoot(s.waveDir, bad.runId))).toBe(false);
    expect(await readFile(join(privateRunDir(s.waveDir, ok.runId), "assistant.txt"), "utf8")).toBe(GOOD_REVIEW);
    expect(existsSync(join(privateRunDir(s.waveDir, bad.runId), "scope", "clone"))).toBe(true);
    expect(existsSync(join(privateRunDir(s.waveDir, ok.runId), "scope"))).toBe(false);
  });

  it("writes every record exactly once", async () => {
    const s = await waveSetup(2);
    await runWave(s.input, s.deps([text()]).deps);
    expect((await readdir(join(s.waveDir, "runs"))).sort()).toEqual(s.runs.map((x) => `${x.runId}.json`).sort());
    await expect(runWave(s.input, s.deps([text()]).deps)).rejects.toThrow();
  });
});

describe("implementation oracle", () => {
  const score = (result: ImplementationScore): NonNullable<WaveDeps["scoreImplementation"]> => async () => result;

  it("scores an unreadable scope as not accepted and continues", async () => {
    const s = await waveSetup(2, { kind: "implementation" });
    const failing: WaveDeps["scoreImplementation"] = async () => { throw new Error("scope_unreadable"); };
    const r = await runWave(s.input, s.deps([text(), text()], { scoreImplementation: failing }).deps);
    expect(r.stopReason).toBeNull();
    expect(r.records[0]).toMatchObject({ outcome: "scored", accepted: false, implementation: { outOfScope: ["<unreadable>"], testsPassed: false } });
  });

  it("treats any other oracle failure as a harness failure", async () => {
    const s = await waveSetup(2, { kind: "implementation" });
    const failing: WaveDeps["scoreImplementation"] = async () => { throw new Error("base_has_submodules"); };
    const r = await runWave(s.input, s.deps([text()], { scoreImplementation: failing }).deps);
    expect(r.stopReason).toBe("harness_failure");
    expect(r.records[0]!.harnessError).toBe("oracle_failed");
  });

  it("scores an accepted implementation and skips the oracle for a failed turn", async () => {
    const s = await waveSetup(2, { kind: "implementation" });
    let calls = 0;
    const counting: WaveDeps["scoreImplementation"] = async (...args) => { calls += 1; return score({ accepted: true, testsPassed: true, outOfScope: [] })(...args); };
    const r = await runWave(s.input, s.deps([{ output: { terminal: "failed" } }, text()], { scoreImplementation: counting }).deps);
    expect(calls).toBe(1);
    expect(r.records.map((x) => x.accepted)).toEqual([false, true]);
  });

  it("audits the oracle's own strace log and stops on a write outside the scope", async () => {
    const s = await waveSetup(2, { kind: "implementation" });
    const tracing: WaveDeps["scoreImplementation"] = async (_clone, _task, options) => {
      const argv = options.wrap!(["npm", "test"]);
      expect(argv.slice(0, 1)).toEqual(["strace"]);
      expect(argv).toContain("--");
      const log = argv[argv.indexOf("-o") + 1]!;
      await writeFile(log, "9000 openat(AT_FDCWD</scope/clone>, \"/home/u/.npmrc\", O_WRONLY|O_CREAT, 0644) = 3</home/u/.npmrc>\n");
      return { accepted: true, testsPassed: true, outOfScope: [] };
    };
    const r = await runWave(s.input, s.deps([text()], { scoreImplementation: tracing }).deps);
    expect(r.stopReason).toBe("outside_write");
    expect(r.records[0]).toMatchObject({ outcome: "stopped", accepted: null, trace: { outsideWrites: 1 } });
    expect(await readFile(join(s.waveDir, "runs", `${r.records[0]!.runId}.json`), "utf8")).not.toContain(".npmrc");
  });

  it("allows the oracle to write into its own temporary home", async () => {
    const s = await waveSetup(1, { kind: "implementation" });
    const tracing: WaveDeps["scoreImplementation"] = async (_clone, _task, options) => {
      const argv = options.wrap!(["npm", "test"]);
      await writeFile(argv[argv.indexOf("-o") + 1]!, `9000 openat(AT_FDCWD</scope/clone>, "${options.home}/cache", O_WRONLY|O_CREAT, 0644) = 3<${options.home}/cache>\n`);
      return { accepted: true, testsPassed: true, outOfScope: [] };
    };
    const r = await runWave(s.input, s.deps([text()], { scoreImplementation: tracing }).deps);
    expect(r.stopReason).toBeNull();
    expect(r.records[0]).toMatchObject({ outcome: "scored", accepted: true });
  });
});

describe("approval", () => {
  it("rejects an approval whose bindings changed", async () => {
    const root = await temporaryRoot("ablation-approval-");
    const tasks = [await reviewTask(root, "A1")];
    const runs = buildMatrix(tasks, PAIRINGS);
    const approval = approvalFor(tasks, runs);
    const current = { sourceCommit: approval.sourceCommit, tasks, runs, routes: approval.routes };
    expect(validateApproval(approval, current)).toEqual(approval);
    expect(() => validateApproval({ ...approval, tasksDigest: "sha256:0" }, current)).toThrow("approval_binding_changed");
    expect(() => validateApproval({ ...approval, matrixDigest: "sha256:0" }, current)).toThrow("approval_binding_changed");
    expect(() => validateApproval({ ...approval, sourceCommit: "d".repeat(40) }, current)).toThrow("approval_binding_changed");
    expect(() => validateApproval({ ...approval, routes: approval.routes.map((r) => ({ ...r, model: "other" })) }, current)).toThrow("approval_binding_changed");
    expect(() => validateApproval({ ...approval, approved: false }, current)).toThrow("approval_invalid");
    expect(() => validateApproval({ ...approval, budgetUsd: 11 }, current)).toThrow("approval_invalid");
  });

  it("makes runWave refuse a changed matrix before anything runs", async () => {
    const s = await waveSetup(2);
    const { deps, captured } = s.deps([]);
    await expect(runWave({ ...s.input, runs: s.runs.slice(0, 1) }, deps)).rejects.toThrow("approval_binding_changed");
    expect(captured).toHaveLength(0);
  });
});

describe("run scope", () => {
  it("refuses a clone symlink that resolves outside the clone (R15)", async () => {
    const root = await temporaryRoot("ablation-symlink-");
    const outside = join(root, "outside");
    await mkdir(outside);
    const clone = join(root, "clone");
    await mkdir(join(clone, "src"), { recursive: true });
    await writeFile(join(clone, "src", "a.ts"), "x");
    await symlink("a.ts", join(clone, "src", "inside-link"));
    await symlink("missing.ts", join(clone, "src", "dangling-inside"));
    await assertCloneSymlinks(clone);
    await symlink(outside, join(clone, "escape"));
    await expect(assertCloneSymlinks(clone)).rejects.toThrow("clone_symlink_escape");
  });

  it("refuses an absolute and a dangling symlink to the outside", async () => {
    const root = await temporaryRoot("ablation-symlink2-");
    const clone = join(root, "clone");
    await mkdir(join(clone, "deep"), { recursive: true });
    await symlink("/etc/passwd", join(clone, "deep", "abs"));
    await expect(assertCloneSymlinks(clone)).rejects.toThrow("clone_symlink_escape");
    const second = join(root, "clone2");
    await mkdir(second);
    await symlink("../nowhere", join(second, "dangling-outside"));
    await expect(assertCloneSymlinks(second)).rejects.toThrow("clone_symlink_escape");
  });

  it("builds the run configuration with exactly one read-only default", () => {
    const review = runConfig("review", "A", PROFILE, "/c", { s: "builtin:s" }, undefined) as { executionProfiles: Record<string, { default: boolean }>; workspaces: unknown };
    expect(review.workspaces).toEqual({ clone: "/c" });
    expect(Object.keys(review.executionProfiles)).toEqual(["review"]);
    expect(review.executionProfiles.review!.default).toBe(true);
    const code = runConfig("code", "A", CODING, "/c", undefined, undefined) as { executionProfiles: Record<string, { default: boolean; permissionProfile: string }> };
    expect(Object.entries(code.executionProfiles).map(([k, v]) => [k, v.permissionProfile, v.default])).toEqual([["code", "coding", false], ["code-ro", "read-only", true]]);
  });

  it("adds the pin to arm B and the granted tools on review pairings only", () => {
    const pl = PAIRINGS.find((p) => p.id === "pl-review")!;
    const b = runConfig("review", "pi-lens", PROFILE, "/c", undefined, pl) as { executionProfiles: { review: Record<string, unknown> } };
    expect(b.executionProfiles.review.extensions).toEqual(["npm:pi-lens@4.4.3"]);
    expect(b.executionProfiles.review.grantedExtensionTools).toEqual(pl.grantedExtensionTools);
    const code = runConfig("code", "pi-lens", CODING, "/c", undefined, PAIRINGS.find((p) => p.id === "pl-code")!) as { executionProfiles: { code: Record<string, unknown> } };
    expect(code.executionProfiles.code.extensions).toEqual(["npm:pi-lens@4.4.3"]);
    expect(code.executionProfiles.code.grantedExtensionTools).toBeUndefined();
    expect(() => runConfig("review", "pi-lens", PROFILE, "/c", undefined, undefined)).toThrow("pairing_not_found");
  });

  it("clones at the base commit, keeps a pristine bare clone outside the root and isolates the environment", async () => {
    const root = await temporaryRoot("ablation-scope-");
    const source = join(root, "source");
    await mkdir(source);
    const git = (...args: string[]) => exec("git", ["-C", source, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args]);
    await git("init", "--quiet");
    await writeFile(join(source, "a.txt"), "base");
    await git("add", "."); await git("commit", "--quiet", "-m", "base");
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    await writeFile(join(source, "a.txt"), "later");
    await git("commit", "--quiet", "-am", "later");
    // A stand-in `codegraph` keeps the test independent of the installed index tool.
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "codegraph"), "#!/bin/sh\nmkdir -p \"$3/.codegraph\"\n");
    await chmod(join(bin, "codegraph"), 0o755);
    const template = join(root, "template");
    await mkdir(join(template, "npm", "node_modules", "pi-lens"), { recursive: true });
    await writeFile(join(template, "npm", "node_modules", "pi-lens", "index.js"), "x");
    const task = { ...(await reviewTask(root, "S1")), baseCommit: base };
    const run = buildMatrix([task], PAIRINGS.filter((p) => p.id === "pl-review")).find((x) => x.arm === "pi-lens")!;
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    let scope: RunScope;
    try {
      scope = await prepareRunScope({
        waveDir: join(root, "wave"), run, task, sourceRepoPath: source, extensionTemplate: template,
        hostAuth: { openai: { type: "oauth", access: "tok", refresh: "secret-refresh", expires: 1 }, xai: { type: "api_key", key: "other" } },
        productionProfile: PROFILE, skillCatalog: productionConfig.skillCatalog, pairing: PAIRINGS.find((p) => p.id === "pl-review"),
      });
    } finally { process.env.PATH = previousPath; }
    expect(await readFile(join(scope.clone, "a.txt"), "utf8")).toBe("base");
    expect(await readFile(join(scope.clone, ".git", "info", "exclude"), "utf8")).toContain(".codegraph/");
    expect(scope.baseGitDir.startsWith(scope.root)).toBe(false);
    expect((await exec("git", ["--git-dir", scope.baseGitDir, "cat-file", "-t", base])).stdout.trim()).toBe("commit");
    const auth = JSON.parse(await readFile(join(scope.agentDir, "auth.json"), "utf8")) as Record<string, { refresh?: string; access?: string }>;
    expect(Object.keys(auth)).toEqual(["openai"]);
    expect(auth.openai).toMatchObject({ access: "tok", refresh: "" });
    expect(existsSync(join(scope.agentDir, "npm", "node_modules", "pi-lens", "index.js"))).toBe(true);
    const config = JSON.parse(await readFile(scope.configPath, "utf8")) as { workspaces: { clone: string }; executionProfiles: Record<string, { extensions?: string[] }> };
    expect(config.workspaces.clone).toBe(scope.clone);
    expect(config.executionProfiles.review!.extensions).toEqual(["npm:pi-lens@4.4.3"]);
    for (const key of ["HOME", "PI_CODING_AGENT_DIR", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "PI_LENS_HOME"]) {
      expect(scope.env[key]!.startsWith(scope.root + "/")).toBe(true);
    }
    expect(scope.env).toMatchObject({ PI_LENS_DISABLE_TOOL_INSTALL: "1", PI_LENS_DISABLE_LSP_INSTALL: "1", PI_CACHE_OPTIMIZER_NO_ZERO_PRICE_WARMING: "1", UV_USE_IO_URING: "0" });
  });

  it("refuses a repository whose clone holds an escaping symlink", async () => {
    const root = await temporaryRoot("ablation-scope-link-");
    const source = join(root, "source");
    await mkdir(source);
    const git = (...args: string[]) => exec("git", ["-C", source, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args]);
    await git("init", "--quiet");
    await symlink("/etc", join(source, "link"));
    await git("add", "."); await git("commit", "--quiet", "-m", "link");
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    const task = { ...(await reviewTask(root, "S2")), baseCommit: base };
    const run = buildMatrix([task], PAIRINGS.filter((p) => p.id === "pl-review"))[0]!;
    await expect(prepareRunScope({
      waveDir: join(root, "wave"), run, task, sourceRepoPath: source, extensionTemplate: join(root, "t"), hostAuth: {}, productionProfile: PROFILE,
    })).rejects.toThrow("clone_symlink_escape");
  });
});

describe("preflight", () => {
  it("runs one PONG per route, records its cost and flags a route that did not complete", async () => {
    const root = await temporaryRoot("ablation-preflight-");
    const waveDir = join(root, "wave");
    const tasks = [await reviewTask(root, "P1")];
    const runs = buildMatrix(tasks, PAIRINGS.filter((p) => p.id === "pl-review" || p.id === "pl-review-grok"));
    const approval = approvalFor(tasks, runs);
    const { spawnRun, captured } = fake([{ cost: 0.01, text: "PONG" }, { output: { terminal: "failed" }, providerError: "auth", cost: null }], root);
    const result = await runPreflight({
      approval, waveDir, productionConfig,
      hostAuth: { openai: { type: "oauth", access: "a", refresh: "", expires: Date.now() + 3_600_000 }, xai: { type: "api_key", key: "k" } },
    }, { spawnRun: (scope, input) => spawnRun(scope, input, join(scope.root, "ignored.log")), residualCheck: async () => true });
    expect(captured.map((c) => c.input.promptText)).toEqual(["Reply with exactly: PONG", "Reply with exactly: PONG"]);
    expect(result.routes.map((r) => [r.profile, r.ok, r.failure])).toEqual([["review", true, null], ["review-grok", false, "auth"]]);
    expect(result.spentUsd).toBeCloseTo(0.01);
    const ledger = JSON.parse(await readFile(join(waveDir, "ledger.json"), "utf8")) as { entries: { runId: string }[] };
    expect(ledger.entries.map((e) => e.runId)).toEqual(["preflight-review", "preflight-review-grok"]);
    expect(JSON.parse(await readFile(join(waveDir, "preflight.json"), "utf8"))).toMatchObject({ routes: [{ ok: true }, { ok: false }] });
  });

  it("prepares an empty scope with credentials for the route's provider only", async () => {
    const root = await temporaryRoot("ablation-empty-scope-");
    const scope = await prepareEmptyScope({
      waveDir: root, name: "preflight-code", profile: "code", hostAuth: { openai: { type: "api_key", key: "k" }, xai: { type: "api_key", key: "z" } },
      productionProfile: { ...CODING, provider: "openai" }, skillCatalog: productionConfig.skillCatalog,
    });
    expect(Object.keys(JSON.parse(await readFile(join(scope.agentDir, "auth.json"), "utf8")) as object)).toEqual(["openai"]);
    expect(Object.keys((JSON.parse(await readFile(scope.configPath, "utf8")) as { executionProfiles: object }).executionProfiles)).toEqual(["code", "code-ro"]);
  });
});

describe("cli arguments", () => {
  it("accepts the live modes and rejects unknown modes and options", () => {
    expect(parseArgs(["--plan", "--tasks", "t.json"])).toMatchObject({ mode: "--plan", options: { "--tasks": "t.json" }, trim: false });
    expect(parseArgs(["--wave", "--approval", "a.json", "--tasks", "t.json", "--template", "x", "--trim"])).toMatchObject({ mode: "--wave", trim: true });
    expect(() => parseArgs(["--scan", "--tasks", "t.json"])).toThrow("mode_required");
    expect(() => parseArgs(["--plan", "--wave", "--tasks", "t.json"])).toThrow("choose_one_mode");
    expect(() => parseArgs(["--plan", "--tasks", "t.json", "--bogus", "x"])).toThrow("invalid_argument");
    expect(() => parseArgs(["--wave", "--tasks", "t.json"])).toThrow("approval_required");
    expect(() => parseArgs(["--wave", "--tasks", "t.json", "--approval", "a.json"])).toThrow("template_required");
    expect(() => parseArgs(["--plan"])).toThrow("tasks_required");
  });
});

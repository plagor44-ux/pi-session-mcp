import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";
import { matrixDigest, routesOf, tasksDigest, validateApproval, type Approval } from "../eval/extensions/approval.js";
import { parseArgs, sourceCommit, withAbort } from "../eval/extensions/cli.js";
import { buildMatrix, PAIRINGS } from "../eval/extensions/matrix.js";
import type { ImplementationScore } from "../eval/extensions/oracles.js";
import { runHelper } from "../eval/extensions/helpers.js";
import { readVerifiedOutput } from "../eval/extensions/audit.js";
import { WaveDirGuard, removeTree } from "../eval/extensions/evidence.js";
import { containmentSelfTest } from "../eval/extensions/containment.js";
import { EMPTY_PLAN, bwrapArgs, planSandbox, sandboxed, type SandboxPlan } from "../eval/extensions/sandbox.js";
import { assertWaveDirOutsideSources, resolveTool, resolveTools, type ToolPaths } from "../eval/extensions/tools.js";
import { encodeKey, macOf, sha256Hex } from "../eval/extensions/output-mac.js";
import { readRegularFile } from "../eval/extensions/safe-read.js";
import { BUILD_ROOT, CORE_LIMIT, assertHostSafe, groupIsEmpty, tracedCommand, untracedCommand } from "../eval/extensions/supervise.js";
import { dnsServers, modelHost } from "../eval/extensions/network.js";
import { assertPreflightPassed, runPreflight } from "../eval/extensions/preflight.js";
import { hash } from "../eval/profiles/files.js";
import type { RunSpec, TaskSpec } from "../eval/extensions/schemas.js";
import { runWave, type RunRecord, type WaveDeps, type WaveInput } from "../eval/extensions/wave.js";
import {
  assertCloneSymlinks, prepareEmptyScope, prepareRunScope, privateRunDir, renderPrompt, runConfig, scopeEnv, scopeRoot, type RunScope, type ScopeInput,
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

/** bwrap's setup processes (muted by the audit), then the workload `pid` (R46). */
const prelude = (pid: number) => `${pid - 2} clone(child_stack=NULL, flags=CLONE_NEWNS|CLONE_NEWIPC|CLONE_NEWUSER|CLONE_NEWPID|SIGCHLD) = ${pid - 1}\n${pid - 1} clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|CLONE_CHILD_SETTID|SIGCHLD, child_tidptr=0x7f0) = ${pid}\n`;
const benignTrace = (pid = 4242) => `${prelude(pid)}${pid} openat(AT_FDCWD</scope>, "/etc/hosts", O_RDONLY) = 3</etc/hosts>\n`;

interface Step {
  output?: Record<string, unknown>; text?: string; cost?: number | null; trace?: string | null; hang?: boolean;
  providerError?: "auth" | "quota" | "rate_limit" | "other"; sessionsLeft?: number;
  /** Breaks the signed output after signing: a forged cost, a replaced text file, or a stripped MAC. */
  tamper?: "cost" | "text" | "nomac";
  /** The fake worker's exit status after writing its (valid) output. */
  exitCode?: number; signal?: "SIGKILL" | "SIGABRT";
  /** A file the fake worker writes into the clone. */
  writeFile?: { name: string; content: string };
}

const FAKE_SCRIPT = `
import { createHash, createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const [inputPath, log, specJson] = process.argv.slice(2);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const key = Buffer.from(Buffer.concat(chunks).toString("utf8").trim(), "hex");
const spec = JSON.parse(specJson);
const input = JSON.parse(readFileSync(inputPath, "utf8"));
const canon = (v) => Array.isArray(v) ? "[" + v.map(canon).join(",") + "]"
  : v !== null && typeof v === "object" ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}" : JSON.stringify(v);
if (spec.trace !== null) writeFileSync(log, spec.trace);
if (spec.output !== null) {
  const ref = spec.text === undefined ? null : input.runId + ".txt";
  if (ref) writeFileSync(join(input.privateDir, ref), spec.text);
  const out = { ...spec.output, runId: input.runId, assistantTextRef: ref, assistantTextSha256: ref ? createHash("sha256").update(spec.text).digest("hex") : null, mac: null };
  const { mac: _m, ...rest } = out;
  out.mac = createHmac("sha256", key).update(canon(rest)).digest("hex");
  if (spec.tamper === "cost") out.usage.session.costUsd = 0;
  if (spec.tamper === "nomac") delete out.mac;
  if (spec.tamper === "text") writeFileSync(join(input.privateDir, ref), "forged text");
  writeFileSync(join(dirname(inputPath), "run-output.json"), JSON.stringify(out));
}
if (spec.writeFile) writeFileSync(join(dirname(inputPath), "clone", spec.writeFile.name), spec.writeFile.content);
if (spec.exitCode) process.exit(spec.exitCode);
if (spec.signal) process.kill(process.pid, spec.signal);
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
      output: hangOnly ? null : outputFor(step), text: step.text, hang: step.hang === true, tamper: step.tamper, exitCode: step.exitCode, signal: step.signal, writeFile: step.writeFile,
      trace: step.trace === undefined ? benignTrace() : step.trace,
    };
    return spawn(process.execPath, [script, runInput, log, JSON.stringify(spec)], { cwd: scope.root, detached: true, stdio: ["pipe", "ignore", "ignore"] });
  };
  return { spawnRun, captured };
}

const fakePrepare = async (input: ScopeInput): Promise<RunScope> => {
  const root = scopeRoot(input.waveDir, input.run.runId);
  await mkdir(join(root, "clone"), { recursive: true });
  await mkdir(join(root, "private"), { recursive: true });
  await mkdir(join(root, "agent", "npm", "node_modules", "pi-lens"), { recursive: true });
  await mkdir(join(privateRunDir(input.waveDir, input.run.runId), "base.git"), { recursive: true });
  await writeFile(join(privateRunDir(input.waveDir, input.run.runId), "base.git", "HEAD"), "ref: refs/heads/main");
  await writeFile(join(root, "agent", "auth.json"), "{\"openai\":{\"access\":\"tok\"}}");
  await writeFile(join(root, "agent", ".auth.json.lock"), "");
  await writeFile(join(root, "agent", "npm", "node_modules", "pi-lens", "author.js"), "x");
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
  // The evaluation repository is a sibling of the wave directory: a wave directory inside it is refused.
  const repo = join(root, "repo");
  const make = options.kind === "implementation" ? implTask : reviewTask;
  const tasks = await Promise.all(["T1", "T2", "T3"].map((id) => make(repo, id)));
  const pairing = PAIRINGS.filter((p) => p.id === (options.kind === "implementation" ? "pl-code" : "pl-review"));
  const runs = buildMatrix(tasks, pairing).slice(0, count);
  const { kind: _kind, hostAuth, ...rest } = options;
  const input: WaveInput = {
    approval: approvalFor(tasks, runs), tasks, runs, waveDir, ledgerPath: join(root, "ledger.json"), productionConfig, extensionTemplate: join(root, "template"), repoRoot: repo,
    hostAuth: hostAuth ?? { openai: { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 }, xai: { type: "api_key", key: "k" } },
    killGraceMs: 0, ...rest,
  };
  return {
    input, runs, waveDir, root,
    deps: (steps, extra = {}) => {
      const { spawnRun, captured } = fake(steps, root);
      return { deps: { spawnRun, prepareScope: fakePrepare, guard: async () => ({ files: {} }), residualCheck: async () => true, resolveAddresses: async () => noAddresses, hostCheck: async () => undefined, containmentCheck: async () => undefined, planSandbox: async () => EMPTY_PLAN, resolveTools: async () => TOOLS, ...extra }, captured };
    },
  };
}

const TOOLS: ToolPaths = { strace: "/opt/tools/bin/strace", prlimit: "/opt/tools/bin/prlimit", git: "/opt/tools/bin/git", codegraph: "/opt/tools/bin/codegraph", bwrap: "/opt/tools/bin/bwrap" };
const baseDeps = (): WaveDeps => ({ prepareScope: fakePrepare, guard: async () => ({ files: {} }), residualCheck: async () => true, resolveAddresses: async () => noAddresses, hostCheck: async () => undefined, containmentCheck: async () => undefined, planSandbox: async () => EMPTY_PLAN, resolveTools: async () => TOOLS });
/** Every directory below `dir` with the given name. */
async function findDirs(dir: string, name: string): Promise<string[]> {
  const found: string[] = [];
  if (!existsSync(dir)) return found;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    if (entry.name === name) found.push(path);
    found.push(...await findDirs(path, name));
  }
  return found;
}
async function findFiles(dir: string, pattern: RegExp): Promise<string[]> {
  const found: string[] = [];
  if (!existsSync(dir)) return found;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await findFiles(path, pattern));
    else if (pattern.test(entry.name)) found.push(path);
  }
  return found;
}
/** Real git and the stand-in codegraph in `bin` (or a path that does not exist), as absolute paths. */
const realTools = async (bin?: string): Promise<Pick<ToolPaths, "git" | "codegraph">> =>
  ({ git: await resolveTool("git", process.env.PATH ?? ""), codegraph: bin === undefined ? "/nonexistent/codegraph" : join(bin, "codegraph") });
const LEDGER_ID = "11111111-1111-4111-8111-111111111111";
const noAddresses = { providerAddresses: new Set<string>(), dnsAddresses: new Set<string>() };
const text = (extra: Step = {}): Step => ({ text: GOOD_REVIEW, ...extra });
const stopReasons = (records: RunRecord[]) => records.map((r) => r.outcome);

describe("runWave stop rules", () => {
  it("stops on an outside write and records the remaining runs as not_run", async () => {
    const s = await waveSetup(3);
    const outside = prelude(4242) + "4242 openat(AT_FDCWD</scope>, \"/home/u/secret\", O_WRONLY|O_CREAT, 0644) = 3</home/u/secret>\n";
    const { deps } = s.deps([text({ trace: outside })]);
    const r = await runWave(s.input, deps);
    expect(r.stopReason).toBe("outside_write");
    expect(stopReasons(r.records)).toEqual(["stopped", "not_run", "not_run"]);
    expect(r.records[0]).toMatchObject({ stopReason: "outside_write", accepted: null, trace: { outsideWrites: 1 } });
    // R42: the worker-controlled path is nowhere on disk; the record carries the count only.
    expect(await readFile(join(s.waveDir, "runs", `${s.runs[0]!.runId}.json`), "utf8")).not.toContain("/home/u");
    expect(existsSync(privateRunDir(s.waveDir, s.runs[0]!.runId))).toBe(false);
    for (const file of await findFiles(s.waveDir, /./)) expect(await readFile(file, "utf8")).not.toContain("/home/u/secret");
    expect(existsSync(scopeRoot(s.waveDir, s.runs[0]!.runId))).toBe(false);
    expect(existsSync(join(privateRunDir(s.waveDir, s.runs[0]!.runId), "scope"))).toBe(false);
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
      const file = s.input.ledgerPath;
      seen.push(existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { entries: unknown[] }).entries.length : 0);
      return spawnRun(scope, runInput, log);
    };
    const r = await runWave(s.input, { ...baseDeps(), spawnRun: spy });
    expect(seen).toEqual([0, 1]);
    expect(captured).toHaveLength(2);
    const ledger = JSON.parse(await readFile(s.input.ledgerPath, "utf8")) as { spentUsd: number; entries: { runId: string; costUsd: number | null }[] };
    expect(ledger.spentUsd).toBeCloseTo(0.75);
    expect(ledger.entries.map((e) => e.runId)).toEqual(s.runs.map((x) => x.runId));
    expect(r.spentUsd).toBeCloseTo(0.75);
  });

  it("continues from a ledger file an earlier preflight wrote", async () => {
    const s = await waveSetup(1);
    await writeFile(s.input.ledgerPath, JSON.stringify({ ledgerId: LEDGER_ID, limitUsd: 10, spentUsd: 9.5, entries: [{ runId: "preflight-review", profile: "review", costUsd: 9.5 }] }));
    const { deps, captured } = s.deps([text()]);
    const r = await runWave(s.input, deps);
    expect(r.stopReason).toBe("budget");
    expect(captured).toHaveLength(0);
  });

  it("keeps neither scope nor pristine clone for any run, accepted or not", async () => {
    const s = await waveSetup(2);
    const r = await runWave(s.input, s.deps([text(), { text: "no findings", output: {} }]).deps);
    const [ok, bad] = r.records as [RunRecord, RunRecord];
    expect(ok.accepted).toBe(true);
    expect(bad).toMatchObject({ outcome: "scored", accepted: false });
    expect(existsSync(scopeRoot(s.waveDir, ok.runId))).toBe(false);
    expect(existsSync(scopeRoot(s.waveDir, bad.runId))).toBe(false);
    // R38/R38b: no scope and no copy of the pristine bare clone is ever kept, accepted or not.
    expect(await findDirs(join(s.waveDir, "private"), "base.git")).toEqual([]);
    expect(existsSync(join(privateRunDir(s.waveDir, bad.runId), "scope"))).toBe(false);
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
    expect(r.records[0]).toMatchObject({ outcome: "scored", accepted: false, implementation: { outOfScopeCount: 1, testsPassed: false } });
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
      expect(argv.slice(0, 1)).toEqual([TOOLS.strace]);
      expect(argv).toContain("--");
      const log = argv[argv.indexOf("-o") + 1]!;
      await writeFile(log, prelude(9000) + "9000 openat(AT_FDCWD</scope/clone>, \"/home/u/.npmrc\", O_WRONLY|O_CREAT, 0644) = 3</home/u/.npmrc>\n");
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
      await writeFile(argv[argv.indexOf("-o") + 1]!, prelude(9000) + `9000 openat(AT_FDCWD</scope/clone>, "${options.home}/cache", O_WRONLY|O_CREAT, 0644) = 3<${options.home}/cache>\n`);
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
        productionProfile: PROFILE, skillCatalog: productionConfig.skillCatalog, pairing: PAIRINGS.find((p) => p.id === "pl-review"), tools: await realTools(bin),
      });
    } finally { process.env.PATH = previousPath; }
    expect(await readFile(join(scope.clone, "a.txt"), "utf8")).toBe("base");
    // I3: the clone's remotes point at the pristine bare clone outside the root, never at the real repository.
    const remotes = (await exec("git", ["-C", scope.clone, "remote", "-v"])).stdout.trim().split("\n");
    expect(remotes).toHaveLength(2);
    for (const line of remotes) expect(line).toMatch(new RegExp(`^origin\\t${scope.baseGitDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\((fetch|push)\\)$`));
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

  it("removes a failed scope with its credentials and its bare clone", async () => {
    const root = await temporaryRoot("ablation-scope-fail-");
    const source = join(root, "source");
    await mkdir(source);
    const git = (...args: string[]) => exec("git", ["-C", source, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args]);
    await git("init", "--quiet");
    await writeFile(join(source, "a.txt"), "base");
    await git("add", "."); await git("commit", "--quiet", "-m", "base");
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "codegraph"), "#!/bin/sh\nmkdir -p \"$3/.codegraph\"\n");
    await chmod(join(bin, "codegraph"), 0o755);
    const task = { ...(await reviewTask(root, "S3")), baseCommit: base };
    const run = buildMatrix([task], PAIRINGS.filter((p) => p.id === "pl-review")).find((x) => x.arm === "pi-lens")!;
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    try {
      // The extension template is missing, so the failure comes after the credentials were written.
      await expect(prepareRunScope({
        waveDir: join(root, "wave"), run, task, sourceRepoPath: source, extensionTemplate: join(root, "no-template"),
        hostAuth: { openai: { type: "oauth", access: "tok", refresh: "r", expires: 1 } }, productionProfile: PROFILE, pairing: PAIRINGS.find((p) => p.id === "pl-review"), tools: await realTools(bin),
      })).rejects.toThrow();
    } finally { process.env.PATH = previousPath; }
    expect(existsSync(scopeRoot(join(root, "wave"), run.runId))).toBe(false);
    expect(existsSync(join(privateRunDir(join(root, "wave"), run.runId), "base.git"))).toBe(false);
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
      waveDir: join(root, "wave"), run, task, sourceRepoPath: source, extensionTemplate: join(root, "t"), hostAuth: {}, productionProfile: PROFILE, tools: await realTools(),
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
      approval, waveDir, ledgerPath: join(root, "ledger.json"), productionConfig,
      hostAuth: { openai: { type: "oauth", access: "a", refresh: "", expires: Date.now() + 3_600_000 }, xai: { type: "api_key", key: "k" } },
    }, { spawnRun: (scope, input) => spawnRun(scope, input, join(scope.root, "ignored.log")), residualCheck: async () => true, checkRoute: async () => undefined });
    expect(captured.map((c) => c.input.promptText)).toEqual(["Reply with exactly: PONG", "Reply with exactly: PONG"]);
    expect(result.routes.map((r) => [r.profile, r.ok, r.failure])).toEqual([["review", true, null], ["review-grok", false, "auth"]]);
    expect(result.spentUsd).toBeCloseTo(0.01);
    const ledger = JSON.parse(await readFile(join(root, "ledger.json"), "utf8")) as { ledgerId: string; entries: { runId: string }[] };
    expect(ledger.entries.map((e) => e.runId)).toEqual(["preflight-review", "preflight-review-grok"]);
    expect(JSON.parse(await readFile(join(waveDir, "preflight.json"), "utf8"))).toMatchObject({ ledgerId: ledger.ledgerId, routes: [{ ok: true }, { ok: false }], binding: { matrixDigest: approval.matrixDigest } });
    // No scope is kept, only the verified output; no credentials anywhere under private/.
    expect(existsSync(scopeRoot(waveDir, "preflight-review-grok"))).toBe(false);
    expect(await findFiles(join(waveDir, "private"), /auth/i)).toEqual([]);
    await expect(assertPreflightPassed(waveDir, approval, join(root, "ledger.json"))).rejects.toThrow("preflight_failed");
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
    expect(parseArgs(["--wave", "--approval", "a.json", "--tasks", "t.json", "--template", "x", "--out", "w", "--ledger", "l.json", "--trim"])).toMatchObject({ mode: "--wave", trim: true });
    expect(() => parseArgs(["--scan", "--tasks", "t.json"])).toThrow("mode_required");
    expect(() => parseArgs(["--plan", "--wave", "--tasks", "t.json"])).toThrow("choose_one_mode");
    expect(() => parseArgs(["--plan", "--tasks", "t.json", "--bogus", "x"])).toThrow("invalid_argument");
    expect(() => parseArgs(["--wave", "--tasks", "t.json"])).toThrow("approval_required");
    expect(() => parseArgs(["--wave", "--tasks", "t.json", "--approval", "a.json"])).toThrow("out_required");
    expect(() => parseArgs(["--wave", "--tasks", "t.json", "--approval", "a.json", "--out", "w"])).toThrow("ledger_required");
    expect(() => parseArgs(["--preflight", "--tasks", "t.json", "--approval", "a.json", "--ledger", "l.json"])).toThrow("out_required");
    expect(() => parseArgs(["--wave", "--tasks", "t.json", "--approval", "a.json", "--out", "w", "--ledger", "l.json"])).toThrow("template_required");
    expect(parseArgs(["--wave", "--tasks", "t.json", "--approval", "a.json", "--out", "w", "--ledger", "l.json", "--template", "x", "--preflight-dir", "p"]).options["--preflight-dir"]).toBe("p");
    expect(() => parseArgs(["--preflight", "--tasks", "t.json", "--approval", "a.json", "--out", "w", "--ledger", "l.json", "--preflight-dir", "p"])).toThrow("invalid_argument");
    expect(() => parseArgs(["--plan"])).toThrow("tasks_required");
  });
});

describe("output integrity (R35)", () => {
  it.each([["cost", "a forged cost"], ["text", "a replaced text file"], ["nomac", "a missing MAC"]] as const)("stops on %s: %s", async (tamper, _why) => {
    const s = await waveSetup(2);
    const r = await runWave(s.input, s.deps([text({ tamper, cost: 0.3 })]).deps);
    expect(r.stopReason).toBe("output_integrity");
    expect(r.records.map((x) => x.outcome)).toEqual(["stopped", "not_run"]);
    // Nothing of a forged output is believed: no terminal, no usage, no score. Its cost is the profile's estimate, flagged (R41).
    expect(r.records[0]).toMatchObject({ accepted: null, usage: null, harnessError: "output_integrity" });
    expect(r.spentUsd).toBe(1);
    const ledger = JSON.parse(await readFile(s.input.ledgerPath, "utf8")) as { entries: { costUsd: number; estimated?: boolean }[] };
    expect(ledger.entries).toMatchObject([{ costUsd: 1, estimated: true }]);
  });

  it("accepts a correctly signed output and never puts the key into argv, env or a file", async () => {
    const s = await waveSetup(1);
    const { deps, captured } = s.deps([text()]);
    const r = await runWave(s.input, deps);
    expect(r.records[0]).toMatchObject({ outcome: "scored", accepted: true });
    expect(JSON.stringify(captured[0]!.scope.env)).toBe("{}");
    expect(captured[0]!.input).not.toHaveProperty("key");
  });
});

describe("interrupt handling (C1)", () => {
  it("survives two SIGINTs, kills the group, records the run as interrupted and the rest as not_run", async () => {
    const s = await waveSetup(3, { runTimeoutMs: 60_000 });
    const { spawnRun, captured } = fake([{ hang: true }], s.root);
    let pid: number | undefined;
    const spy = (scope: RunScope, runInput: string, log: string): ChildProcess => { const child = spawnRun(scope, runInput, log); pid = child.pid; return child; };
    const emitter = new EventEmitter();
    setTimeout(() => emitter.emit("SIGINT"), 300);
    setTimeout(() => emitter.emit("SIGINT"), 350);
    const r = await withAbort((signal) => runWave({ ...s.input, signal }, {
      ...baseDeps(), spawnRun: spy,
    }), emitter);
    expect(captured).toHaveLength(1);
    expect(r.stopReason).toBe("interrupted");
    expect(r.records.map((x) => x.outcome)).toEqual(["stopped", "not_run", "not_run"]);
    expect(r.records[0]).toMatchObject({ stopReason: "interrupted" });
    expect(() => process.kill(-pid!, 0)).toThrow();
    expect(emitter.listenerCount("SIGINT")).toBe(0);
    const ledger = JSON.parse(await readFile(s.input.ledgerPath, "utf8")) as { entries: { runId: string }[] };
    expect(ledger.entries.map((e) => e.runId)).toEqual([s.runs[0]!.runId]);
    for (const run of s.runs) expect(existsSync(join(s.waveDir, "runs", `${run.runId}.json`))).toBe(true);
  });

  it("does not spawn when the abort arrives between scope preparation and spawn", async () => {
    const s = await waveSetup(2);
    const controller = new AbortController();
    const { deps, captured } = s.deps([text()], { prepareScope: async (input) => { const scope = await fakePrepare(input); controller.abort(); return scope; } });
    const r = await runWave({ ...s.input, signal: controller.signal }, deps);
    expect(captured).toHaveLength(0);
    expect(r.stopReason).toBe("interrupted");
    expect(r.records.map((x) => x.outcome)).toEqual(["stopped", "not_run"]);
    // No run started, so no scope is kept.
    expect(existsSync(scopeRoot(s.waveDir, s.runs[0]!.runId))).toBe(false);
    expect(existsSync(join(privateRunDir(s.waveDir, s.runs[0]!.runId), "scope"))).toBe(false);
  });
});

describe("shared ledger and output safety (R37)", () => {
  it("refuses before any spawn when an output of a planned run already exists", async () => {
    for (const make of [
      (s: Setup) => mkdir(join(s.waveDir, "runs"), { recursive: true }).then(() => writeFile(join(s.waveDir, "runs", `${s.runs[1]!.runId}.json`), "{}")),
      (s: Setup) => mkdir(privateRunDir(s.waveDir, s.runs[1]!.runId), { recursive: true }),
      (s: Setup) => mkdir(scopeRoot(s.waveDir, s.runs[1]!.runId), { recursive: true }),
    ]) {
      const s = await waveSetup(2);
      await make(s);
      const { deps, captured } = s.deps([text()]);
      await expect(runWave(s.input, deps)).rejects.toThrow("output_exists");
      expect(captured).toHaveLength(0);
      expect(existsSync(s.input.ledgerPath)).toBe(false);
    }
  });

  it("counts a preflight's spend in the wave through the shared ledger file", async () => {
    const root = await temporaryRoot("ablation-shared-ledger-");
    const ledgerPath = join(root, "evaluation-ledger.json");
    const tasks = [await reviewTask(root, "P1")];
    const runs = buildMatrix(tasks, PAIRINGS.filter((p) => p.id === "pl-review"));
    const approval = approvalFor(tasks, runs);
    const { spawnRun } = fake([{ cost: 9.6, text: "PONG" }], root);
    const hostAuth = { openai: { type: "oauth", access: "a", refresh: "", expires: Date.now() + 3_600_000 } };
    const pre = await runPreflight({ approval, waveDir: join(root, "pre"), ledgerPath, productionConfig, hostAuth }, {
      spawnRun: (scope, input) => spawnRun(scope, input, join(scope.root, "x.log")), residualCheck: async () => true, checkRoute: async () => undefined,
    });
    expect(pre.routes.map((r) => r.ok)).toEqual([true]);
    const s = await waveSetup(1, { ledgerPath });
    const { deps, captured } = s.deps([text()]);
    const r = await runWave(s.input, deps);
    expect(r.stopReason).toBe("budget");
    expect(r.spentUsd).toBeCloseTo(9.6);
    expect(captured).toHaveLength(0);
  });

  it("refuses to preflight into an output directory that already holds a preflight", async () => {
    const root = await temporaryRoot("ablation-preflight-exists-");
    const tasks = [await reviewTask(root, "P1")];
    const approval = approvalFor(tasks, buildMatrix(tasks, PAIRINGS.filter((p) => p.id === "pl-review")));
    await mkdir(join(root, "wave"), { recursive: true });
    await writeFile(join(root, "wave", "preflight.json"), "{}");
    await expect(runPreflight({ approval, waveDir: join(root, "wave"), ledgerPath: join(root, "l.json"), productionConfig, hostAuth: {} })).rejects.toThrow("output_exists");
  });

  it("lets the wave start only on a passed preflight of the same approval and ledger", async () => {
    const root = await temporaryRoot("ablation-preflight-gate-");
    const tasks = [await reviewTask(root, "P1")];
    const approval = approvalFor(tasks, buildMatrix(tasks, PAIRINGS.filter((p) => p.id === "pl-review")));
    const ledgerPath = join(root, "ledger.json");
    await expect(assertPreflightPassed(root, approval, ledgerPath)).rejects.toThrow("preflight_missing");
    const binding = { sourceCommit: approval.sourceCommit, tasksDigest: approval.tasksDigest, matrixDigest: approval.matrixDigest };
    const passed = (ok: boolean) => approval.routes.map((r) => ({ profile: r.profile, ok, terminal: "completed", costUsd: 0.01, failure: null }));
    const write = (file: unknown) => writeFile(join(root, "preflight.json"), JSON.stringify(file));
    const writeLedger = (ledgerId: string, runs: string[]) => writeFile(ledgerPath, JSON.stringify({
      ledgerId, limitUsd: 10, spentUsd: 0.01 * runs.length, entries: runs.map((runId) => ({ runId, profile: "review", costUsd: 0.01 })),
    }));
    const entries = approval.routes.map((r) => `preflight-${r.profile}`);
    await write({ binding, ledgerId: LEDGER_ID, routes: passed(true), spentUsd: 0.01 });
    await writeLedger(LEDGER_ID, entries);
    await expect(assertPreflightPassed(root, approval, ledgerPath)).resolves.toBeUndefined();
    await write({ binding: { ...binding, matrixDigest: "sha256:0" }, ledgerId: LEDGER_ID, routes: passed(true), spentUsd: 0 });
    await expect(assertPreflightPassed(root, approval, ledgerPath)).rejects.toThrow("preflight_binding_changed");
    await write({ binding, ledgerId: LEDGER_ID, routes: passed(false), spentUsd: 0 });
    await expect(assertPreflightPassed(root, approval, ledgerPath)).rejects.toThrow("preflight_failed");
    // R37b: a different ledger file, or one without the preflight's entries, is refused.
    await write({ binding, ledgerId: LEDGER_ID, routes: passed(true), spentUsd: 0 });
    await writeLedger("22222222-2222-4222-8222-222222222222", entries);
    await expect(assertPreflightPassed(root, approval, ledgerPath)).rejects.toThrow("ledger_mismatch");
    await writeLedger(LEDGER_ID, ["something-else"]);
    await expect(assertPreflightPassed(root, approval, ledgerPath)).rejects.toThrow("ledger_mismatch");
    await rm(ledgerPath);
    await expect(assertPreflightPassed(root, approval, ledgerPath)).rejects.toThrow("ledger_mismatch");
  });

  it("rejects a malformed preflight file instead of throwing a TypeError", async () => {
    const root = await temporaryRoot("ablation-preflight-malformed-");
    const tasks = [await reviewTask(root, "P1")];
    const approval = approvalFor(tasks, buildMatrix(tasks, PAIRINGS.filter((p) => p.id === "pl-review")));
    for (const content of ["{", "null", "[]", JSON.stringify({ routes: "x" }), JSON.stringify({ binding: {}, ledgerId: "x", routes: [], spentUsd: 0 })]) {
      await writeFile(join(root, "preflight.json"), content);
      await expect(assertPreflightPassed(root, approval, join(root, "l.json"))).rejects.toThrow("preflight_invalid");
    }
  });
});

describe("credentials and traces stay out of kept evidence (I2, R35)", () => {
  it("keeps no worker-derived artefact: only the sanitized record survives (R42)", async () => {
    const s = await waveSetup(2);
    const r = await runWave(s.input, s.deps([{ output: { terminal: "failed" }, text: "partial" }, text()]).deps);
    for (const record of r.records) {
      expect(existsSync(scopeRoot(s.waveDir, record.runId))).toBe(false);
      expect(existsSync(privateRunDir(s.waveDir, record.runId))).toBe(false);
    }
    expect(await findDirs(s.waveDir, "base.git")).toEqual([]);
    expect(await findFiles(s.waveDir, /auth/i)).toEqual([]);
    const files = (await findFiles(s.waveDir, /./)).map((file) => file.slice(s.waveDir.length + 1)).sort();
    expect(files).toEqual(s.runs.map((run) => `runs/${run.runId}.json`).sort());
    // The text itself is gone; its hash is recorded.
    expect(r.records[1]!.assistantTextSha256).toBe(sha256Hex(GOOD_REVIEW));
    expect(r.records[0]!.assistantTextSha256).toBe(sha256Hex("partial"));
  });

  it("leaves a boundary key a worker copied into the clone nowhere on disk", async () => {
    const secret = "sk-test-boundary-secret-0123456789";
    const root = await temporaryRoot("ablation-redact-");
    const waveDir = join(root, "wave");
    const tasks = [await reviewTask(join(root, "repo"), "T1")];
    const runs = buildMatrix(tasks, PAIRINGS.filter((p) => p.id === "pl-review")).slice(0, 1);
    const hostAuth = { openai: { type: "api_key", key: secret } };
    const input: WaveInput = {
      approval: approvalFor(tasks, runs), tasks, runs, waveDir, ledgerPath: join(root, "ledger.json"), productionConfig,
      extensionTemplate: join(root, "t"), repoRoot: join(root, "repo"), hostAuth, killGraceMs: 0,
    };
    const { spawnRun } = fake([text({ writeFile: { name: "x.txt", content: secret } })], root);
    const r = await runWave(input, { ...baseDeps(), spawnRun });
    expect(existsSync(scopeRoot(waveDir, r.records[0]!.runId))).toBe(false);
    for (const file of await findFiles(waveDir, /./)) expect(await readFile(file, "utf8")).not.toContain(secret);
  });

  it("removes the scope even when a step after the spawn throws", async () => {
    const s = await waveSetup(2);
    const flaky = fake([text()], s.root);
    const r = await runWave(s.input, { ...baseDeps(), spawnRun: flaky.spawnRun, residualCheck: async () => { throw new Error("residual exploded"); } });
    expect(r.records[0]).toMatchObject({ outcome: "stopped", stopReason: "harness_failure" });
    expect(existsSync(scopeRoot(s.waveDir, s.runs[0]!.runId))).toBe(false);
    expect(existsSync(privateRunDir(s.waveDir, s.runs[0]!.runId))).toBe(false);
    const guarded = await waveSetup(2);
    let n = 0;
    const g = await runWave(guarded.input, { ...baseDeps(), spawnRun: fake([text()], guarded.root).spawnRun, guard: async () => { if (++n > 1) throw new Error("boom"); return { files: {} }; } });
    expect(g.records[0]).toMatchObject({ outcome: "stopped", stopReason: "harness_failure" });
    expect(existsSync(scopeRoot(guarded.waveDir, guarded.runs[0]!.runId))).toBe(false);
  });

  it("removes links without following them and tolerates a missing path (R42)", async () => {
    const root = await temporaryRoot("ablation-remove-tree-");
    const victim = join(root, "victim");
    await mkdir(victim);
    await writeFile(join(victim, "keep.txt"), "precious");
    // The private run path itself is a symlink to a directory outside.
    await symlink(victim, join(root, "private-link"));
    await removeTree(join(root, "private-link"));
    expect(existsSync(join(root, "private-link"))).toBe(false);
    expect(await readFile(join(victim, "keep.txt"), "utf8")).toBe("precious");
    // A symlink inside a real directory, to a directory and to a file.
    await mkdir(join(root, "dir", "sub"), { recursive: true });
    await symlink(victim, join(root, "dir", "sub", "to-dir"));
    await symlink(join(victim, "keep.txt"), join(root, "dir", "to-file"));
    await removeTree(join(root, "dir"));
    expect(existsSync(join(root, "dir"))).toBe(false);
    expect(await readFile(join(victim, "keep.txt"), "utf8")).toBe("precious");
    // A plain file or FIFO planted where the directory should be is unlinked, and a missing path is fine.
    await writeFile(join(root, "plain"), "x");
    await exec("mkfifo", [join(root, "fifo")]);
    await removeTree(join(root, "plain"));
    await removeTree(join(root, "fifo"));
    await removeTree(join(root, "nothing"));
    expect(existsSync(join(root, "plain")) || existsSync(join(root, "fifo"))).toBe(false);
  });

  it("records only counts for out-of-scope files and the hash of the text, never paths", async () => {
    const s = await waveSetup(1, { kind: "implementation" });
    const scored: WaveDeps["scoreImplementation"] = async () => ({ accepted: false, testsPassed: true, outOfScope: ["/home/u/evil name.txt", "src/other.ts"] });
    const r = await runWave(s.input, s.deps([text()], { scoreImplementation: scored }).deps);
    expect(r.records[0]).toMatchObject({ outcome: "scored", accepted: false, implementation: { accepted: false, testsPassed: true, outOfScopeCount: 2 } });
    const file = await readFile(join(s.waveDir, "runs", `${r.records[0]!.runId}.json`), "utf8");
    expect(file).not.toContain("evil name");
    expect(file).not.toContain("other.ts");
    expect(JSON.parse(file).implementation).not.toHaveProperty("outOfScope");
  });

  it("keeps every strace log outside the scope root and stops on a missing oracle log", async () => {
    const s = await waveSetup(1, { kind: "implementation" });
    const logs: string[] = [];
    const missing: WaveDeps["scoreImplementation"] = async (_clone, _task, options) => {
      logs.push(options.wrap!(["npm", "test"]).at(options.wrap!(["x"]).indexOf("-o") + 1)!);
      return { accepted: true, testsPassed: true, outOfScope: [] };
    };
    const { deps, captured } = s.deps([text()], { scoreImplementation: missing });
    const r = await runWave(s.input, deps);
    expect(r.stopReason).toBe("harness_failure");
    expect(r.records[0]).toMatchObject({ outcome: "stopped", harnessError: "trace_missing" });
    const root = captured[0]!.scope.root;
    expect(root.startsWith(join(s.waveDir, "private"))).toBe(false);
    expect(logs.every((path) => path.startsWith(privateRunDir(s.waveDir, r.records[0]!.runId)) && !path.startsWith(root))).toBe(true);
  });
});

describe("record safety (items 7 and 8)", () => {
  it("turns a post-processing failure into a harness_failure record and still writes the rest", async () => {
    const s = await waveSetup(2);
    const { spawnRun } = fake([{ output: { terminal: "failed" } }], s.root);
    // A read-only directory with content inside the private run directory makes its removal fail.
    const blocking = (scope: RunScope, runInput: string, log: string): ChildProcess => {
      const locked = join(privateRunDir(s.waveDir, s.runs[0]!.runId), "locked");
      mkdirSync(join(locked, "f"), { recursive: true });
      chmodSync(locked, 0o500);
      return spawnRun(scope, runInput, log);
    };
    const r = await runWave(s.input, { ...baseDeps(), spawnRun: blocking });
    chmodSync(join(privateRunDir(s.waveDir, s.runs[0]!.runId), "locked"), 0o700);
    expect(r.stopReason).toBe("harness_failure");
    expect(r.records.map((x) => x.outcome)).toEqual(["stopped", "not_run"]);
    expect(r.records[0]).toMatchObject({ stopReason: "harness_failure" });
    for (const run of s.runs) expect(existsSync(join(s.waveDir, "runs", `${run.runId}.json`))).toBe(true);
    const ledger = JSON.parse(await readFile(s.input.ledgerPath, "utf8")) as { entries: unknown[] };
    expect(ledger.entries).toHaveLength(1);
  });

  it("replaces a harness error string that is not a fixed code", async () => {
    const s = await waveSetup(1);
    const r = await runWave(s.input, s.deps([{ output: { terminal: "failed", harnessError: "ENOENT /home/u/secret failed" } }]).deps);
    expect(r.records[0]).toMatchObject({ stopReason: "harness_failure", harnessError: "invalid_harness_error" });
    expect(await readFile(join(s.waveDir, "runs", `${s.runs[0]!.runId}.json`), "utf8")).not.toContain("/home/u");
  });
});

describe("network audit addresses", () => {
  it("passes provider and DNS addresses to the connect audit", async () => {
    const s = await waveSetup(2);
    const connect = (ip: string, port: number) => `4242 connect(3, {sa_family=AF_INET, sin_port=htons(${port}), sin_addr=inet_addr("${ip}")}, 16) = 0\n`;
    const trace = benignTrace() + connect("203.0.113.9", 443) + connect("203.0.113.53", 53) + connect("198.51.100.7", 443);
    const addresses = { providerAddresses: new Set(["203.0.113.9"]), dnsAddresses: new Set(["203.0.113.53"]) };
    const r = await runWave(s.input, s.deps([text({ trace })], { resolveAddresses: async () => addresses }).deps);
    expect(r.records[0]!.trace).toMatchObject({ connects: 3, unexpectedConnects: [{ family: "inet", address: "198.51.100.7", port: 443 }] });
  });

  it("reads the model endpoint host from the pinned SDK catalog offline and the nameservers from resolv.conf", async () => {
    expect(await modelHost({ provider: "openai", model: "gpt-6.1-sol" })).toBe("api.openai.com");
    await expect(modelHost({ provider: "openai", model: "no-such-model" })).rejects.toThrow("provider_model_unknown");
    const root = await temporaryRoot("ablation-resolv-");
    await writeFile(join(root, "resolv.conf"), "# c\nnameserver 192.0.2.1\nnameserver fe80::1%eth0\nsearch x\n");
    expect([...await dnsServers(join(root, "resolv.conf"))].sort()).toEqual(["127.0.0.53", "192.0.2.1", "fe80::1"]);
    expect([...await dnsServers(join(root, "missing"))]).toEqual(["127.0.0.53"]);
  });

  it("fails a preflight route whose endpoint cannot be resolved", async () => {
    const root = await temporaryRoot("ablation-unresolved-");
    const tasks = [await reviewTask(root, "P1")];
    const approval = approvalFor(tasks, buildMatrix(tasks, PAIRINGS.filter((p) => p.id === "pl-review")));
    const { spawnRun, captured } = fake([], root);
    const r = await runPreflight({ approval, waveDir: join(root, "w"), ledgerPath: join(root, "l.json"), productionConfig, hostAuth: { openai: { type: "api_key", key: "k" } } }, {
      spawnRun: (scope, input) => spawnRun(scope, input, "x"), checkRoute: async () => { throw new Error("provider_host_unresolvable"); },
    });
    expect(r.routes).toMatchObject([{ ok: false, failure: "provider_host_unresolvable" }]);
    expect(captured).toHaveLength(0);
  });
});

describe("source binding and prompt rewrite (items 10 and 11)", () => {
  it("refuses a dirty tracked tree and a missing repository, and ignores untracked files", async () => {
    const root = await temporaryRoot("ablation-source-");
    const git = (...args: string[]) => exec("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args]);
    await git("init", "--quiet");
    await writeFile(join(root, "a.txt"), "1");
    await git("add", "."); await git("commit", "--quiet", "-m", "one");
    const head = (await git("rev-parse", "HEAD")).stdout.trim();
    await writeFile(join(root, "untracked.txt"), "x");
    expect(await sourceCommit(root)).toBe(head);
    await writeFile(join(root, "a.txt"), "2");
    await expect(sourceCommit(root)).rejects.toThrow("source_dirty");
    await expect(sourceCommit(await temporaryRoot("ablation-nogit-"))).rejects.toThrow("source_unavailable");
  });

  it("rewrites the configured, real and home-relative forms on path boundaries only", async () => {
    const root = await temporaryRoot("ablation-prompt-");
    const real = join(root, "repo");
    await mkdir(real);
    await symlink(real, join(root, "link"));
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      expect(homedir()).toBe(root);
      const clone = join(root, "wave", "scopes", "r1", "clone");
      const body = `A ${join(root, "link")}/a.ts, B ${real}/b.ts, C ~/repo/c.ts, D ${real}-other/d.ts, E x${real}/e.ts, F ${real}.`;
      const task = { ...(await reviewTask(root, "W1")), promptRef: "eval/results/ablation-test/W1.txt", promptHash: hash(body) };
      await writeFile(join(root, task.promptRef), body);
      const out = await renderPrompt(root, task, join(root, "link"), clone);
      expect(out).toBe(`A ${clone}/a.ts, B ${clone}/b.ts, C ${clone}/c.ts, D ${real}-other/d.ts, E x${real}/e.ts, F ${clone}.`);
    } finally { process.env.HOME = previousHome; }
  });

  it("does not report a leak when the clone itself lives below the source path", async () => {
    const root = await temporaryRoot("ablation-prompt-below-");
    const clone = join(root, "eval", "results", "wave", "scopes", "r1", "clone");
    const body = `see ${root}/src/a.ts`;
    const task = { ...(await reviewTask(root, "W2")), promptHash: hash(body) };
    await writeFile(join(root, task.promptRef), body);
    expect(await renderPrompt(root, task, root, clone)).toBe(`see ${clone}/src/a.ts`);
  });
});

describe("exit status and host safety (N1, R40)", () => {
  it.each([
    ["a signal after a valid output", { signal: "SIGKILL" as const }],
    ["a core-dump signal after a valid output", { signal: "SIGABRT" as const }],
    ["a non-zero exit after a valid output", { exitCode: 3 }],
  ])("does not trust the output of a worker that ends with %s", async (_name, ending) => {
    const s = await waveSetup(2);
    const r = await runWave(s.input, s.deps([text({ cost: 0.4, ...ending })]).deps);
    expect(r.stopReason).toBe("output_integrity");
    expect(r.records[0]).toMatchObject({ outcome: "stopped", accepted: null, usage: null, terminal: null, stopReason: "output_integrity" });
    // R41: the untrusted output's cost is not believed; the estimate is charged and flagged.
    expect(r.spentUsd).toBe(1);
  });

  it("refuses to start without prlimit or with a Yama ptrace_scope below 1", async () => {
    const ok = { hasPrlimit: async () => true, readPtraceScope: async () => "1\n" };
    await expect(assertHostSafe(ok)).resolves.toBeUndefined();
    await expect(assertHostSafe({ ...ok, readPtraceScope: async () => "3" })).resolves.toBeUndefined();
    await expect(assertHostSafe({ ...ok, readPtraceScope: async () => "0\n" })).rejects.toThrow("ptrace_scope_unsafe");
    await expect(assertHostSafe({ ...ok, readPtraceScope: async () => { throw Object.assign(new Error("x"), { code: "ENOENT" }); } })).rejects.toThrow("ptrace_scope_unsafe");
    await expect(assertHostSafe({ ...ok, readPtraceScope: async () => "garbage" })).rejects.toThrow("ptrace_scope_unsafe");
    await expect(assertHostSafe({ ...ok, hasPrlimit: async () => false })).rejects.toThrow("prlimit_missing");
  });

  it("runs the wave's host check before anything is prepared", async () => {
    const s = await waveSetup(1);
    const { deps, captured } = s.deps([text()], { hostCheck: async () => { throw new Error("ptrace_scope_unsafe"); } });
    await expect(runWave(s.input, deps)).rejects.toThrow("ptrace_scope_unsafe");
    expect(captured).toHaveLength(0);
    expect(existsSync(s.waveDir)).toBe(false);
  });

  it("sets a hard core limit of 0 with the flag the spawn uses", async () => {
    const { stdout } = await exec("prlimit", [CORE_LIMIT, "sh", "-c", "ulimit -Hc; ulimit -Sc"]);
    expect(stdout.trim().split("\n")).toEqual(["0", "0"]);
  });
});

describe("helper processes (N3)", () => {
  it("retries a ps that was killed by a signal once, and counts a second failure as not clean", async () => {
    const killed = Object.assign(new Error("helper_failed"), { code: null, signal: "SIGINT", stdout: "", stderr: "" });
    const calls: string[] = [];
    const flaky = (failures: number) => async (file: string, args: readonly string[]) => {
      calls.push(`${file} ${args.join(" ")}`);
      if (calls.length <= failures) throw killed;
      return { stdout: "", stderr: "" };
    };
    expect(await groupIsEmpty(4242, flaky(1))).toBe(true);
    expect(calls).toHaveLength(2);
    calls.length = 0;
    expect(await groupIsEmpty(4242, flaky(2))).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe("ps -o pid=,stat= -g 4242");
  });

  it("runs helpers in their own process group, so a terminal Ctrl-C does not reach them", async () => {
    const own = (await runHelper("ps", ["-o", "pgid=", "-p", String(process.pid)])).stdout.trim();
    const helper = (await runHelper("sh", ["-c", "ps -o pgid= -p $$"])).stdout.trim();
    expect(helper).not.toBe(own);
    await expect(runHelper("sh", ["-c", "exit 3"])).rejects.toMatchObject({ code: 3, signal: null });
    await expect(runHelper("sh", ["-c", "kill -INT $$"])).rejects.toMatchObject({ code: null, signal: "SIGINT" });
  });

  it("treats exit code 1 as an empty group and ignores zombies", async () => {
    expect(await groupIsEmpty(1, async () => { throw Object.assign(new Error("helper_failed"), { code: 1, signal: null }); })).toBe(true);
    expect(await groupIsEmpty(1, async () => ({ stdout: "  77 Z\n  78 Z+\n", stderr: "" }))).toBe(true);
  });
});

describe("safe reads from the scope (R39)", () => {
  const key = Buffer.alloc(32, 9);
  const signed = (extra: Record<string, unknown> = {}) => {
    const out: Record<string, unknown> = {
      runId: "r1", terminal: "completed", startErrorCode: null,
      usage: { session: null, assistant: { messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }, providerError: null },
      durationMs: 1, sessionsLeft: 0, assistantTextRef: null, assistantTextTruncated: false, assistantTextSha256: null, harnessError: null, mac: null, ...extra,
    };
    return JSON.stringify({ ...out, mac: macOf(out, key) });
  };

  it("reads a regular file within the cap and refuses a symlink, a FIFO and an oversize file", async () => {
    const root = await temporaryRoot("ablation-safe-read-");
    await writeFile(join(root, "ok"), "fine");
    expect((await readRegularFile(join(root, "ok"), 1024)).toString()).toBe("fine");
    await symlink(join(root, "ok"), join(root, "link"));
    await expect(readRegularFile(join(root, "link"), 1024)).rejects.toThrow("unsafe_read");
    await exec("mkfifo", [join(root, "fifo")]);
    await expect(readRegularFile(join(root, "fifo"), 1024)).rejects.toThrow("unsafe_read");
    await writeFile(join(root, "big"), Buffer.alloc(2 * 1024 * 1024));
    await expect(readRegularFile(join(root, "big"), 1024 * 1024)).rejects.toThrow("unsafe_read");
    await expect(readRegularFile(join(root, "missing"), 1024)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats a FIFO, a symlink and a 2 MiB file in place of the output or the text as tampering", async () => {
    const root = await temporaryRoot("ablation-verified-output-");
    const scope = join(root, "scope");
    const priv = join(scope, "private");
    await mkdir(priv, { recursive: true });
    await writeFile(join(scope, "run-output.json"), signed());
    expect(await readVerifiedOutput(scope, priv, "r1", key)).toMatchObject({ tampered: false, present: true });
    expect(await readVerifiedOutput(join(root, "none"), priv, "r1", key)).toMatchObject({ tampered: false, present: false });

    await rm(join(scope, "run-output.json"));
    await exec("mkfifo", [join(scope, "run-output.json")]);
    expect(await readVerifiedOutput(scope, priv, "r1", key)).toMatchObject({ tampered: true, output: null });

    await rm(join(scope, "run-output.json"));
    await writeFile(join(root, "elsewhere.json"), signed());
    await symlink(join(root, "elsewhere.json"), join(scope, "run-output.json"));
    expect(await readVerifiedOutput(scope, priv, "r1", key)).toMatchObject({ tampered: true, output: null });

    await rm(join(scope, "run-output.json"));
    await writeFile(join(scope, "run-output.json"), Buffer.concat([Buffer.from(signed()), Buffer.alloc(2 * 1024 * 1024, 32)]));
    expect(await readVerifiedOutput(scope, priv, "r1", key)).toMatchObject({ tampered: true });

    // The same guards apply to the assistant text the output points at.
    const text = "hello";
    await rm(join(scope, "run-output.json"));
    await writeFile(join(scope, "run-output.json"), signed({ assistantTextRef: "r1.txt", assistantTextSha256: sha256Hex(text) }));
    await exec("mkfifo", [join(priv, "r1.txt")]);
    expect(await readVerifiedOutput(scope, priv, "r1", key)).toMatchObject({ tampered: true });
    await rm(join(priv, "r1.txt"));
    await symlink(join(root, "elsewhere.json"), join(priv, "r1.txt"));
    expect(await readVerifiedOutput(scope, priv, "r1", key)).toMatchObject({ tampered: true });
    await rm(join(priv, "r1.txt"));
    await writeFile(join(priv, "r1.txt"), text);
    expect(await readVerifiedOutput(scope, priv, "r1", key)).toMatchObject({ tampered: false, text, raw: expect.any(String) });
  });

  it("refuses a strace log that is a symlink or a FIFO (as a missing trace)", async () => {
    const s = await waveSetup(2);
    const { spawnRun } = fake([text({ trace: null })], s.root);
    const planting = (scope: RunScope, runInput: string, log: string): ChildProcess => {
      execFileSync("mkfifo", [log]);
      return spawnRun(scope, runInput, log);
    };
    const r = await runWave(s.input, { ...baseDeps(), spawnRun: planting });
    expect(r.records[0]).toMatchObject({ stopReason: "harness_failure", harnessError: "trace_missing" });
  });
});

describe("estimates for untrusted runs (R41)", () => {
  it("charges the current estimate and flags it for a killed run, using the highest observed cost afterwards", async () => {
    const s = await waveSetup(3, { runTimeoutMs: 300 });
    const r = await runWave(s.input, s.deps([text({ cost: 0.5 }), { hang: true }, text({ cost: 0.1 })], { residualCheck: undefined }).deps);
    const ledger = JSON.parse(await readFile(s.input.ledgerPath, "utf8")) as { entries: { runId: string; costUsd: number; estimated?: boolean }[] };
    expect(ledger.entries[0]).toMatchObject({ costUsd: 0.5 });
    expect(ledger.entries[0]!.estimated).toBeUndefined();
    // After a 0.5 observation the estimate for that profile is 0.5.
    expect(ledger.entries[1]).toMatchObject({ runId: s.runs[1]!.runId, costUsd: 0.5, estimated: true });
    expect(r.stopReason).toBe("harness_failure");
    expect(r.spentUsd).toBeCloseTo(1);
  });
});

describe("source isolation (N5)", () => {
  async function gitSource(prefix: string) {
    const root = await temporaryRoot(prefix);
    const source = join(root, "source");
    await mkdir(source);
    const git = (...args: string[]) => exec("git", ["-C", source, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args]);
    await git("init", "--quiet");
    await writeFile(join(source, "a.txt"), "base");
    await git("add", "."); await git("commit", "--quiet", "-m", "base");
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "codegraph"), "#!/bin/sh\nmkdir -p \"$3/.codegraph\"\n");
    await chmod(join(bin, "codegraph"), 0o755);
    return { root, source, bin, git, base: (await git("rev-parse", "HEAD")).stdout.trim() };
  }
  const withPath = async <T>(bin: string, body: () => Promise<T>): Promise<T> => {
    const previous = process.env.PATH;
    process.env.PATH = `${bin}:${previous ?? ""}`;
    try { return await body(); } finally { process.env.PATH = previous; }
  };

  it("leaves no mention of the source path in the clone's .git or the pristine clone's config", async () => {
    const { root, source, bin, base } = await gitSource("ablation-isolation-");
    const task = { ...(await reviewTask(root, "I1")), baseCommit: base };
    const run = buildMatrix([task], PAIRINGS.filter((p) => p.id === "pl-review"))[0]!;
    const scope = await withPath(bin, async () => prepareRunScope({
      waveDir: join(root, "wave"), run, task, sourceRepoPath: source, extensionTemplate: join(root, "t"), hostAuth: {}, productionProfile: PROFILE, tools: await realTools(bin),
    }));
    const mentions = async (dir: string): Promise<string[]> => {
      const hits: string[] = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) hits.push(...await mentions(path));
        else if (entry.isFile() && (await readFile(path)).includes(source)) hits.push(path);
      }
      return hits;
    };
    expect(await mentions(join(scope.clone, ".git"))).toEqual([]);
    expect(await readFile(join(scope.baseGitDir, "config"), "utf8")).not.toContain(source);
    expect((await exec("git", ["-C", scope.clone, "reflog"])).stdout).toContain(base.slice(0, 7));
    expect(await readFile(join(scope.clone, "a.txt"), "utf8")).toBe("base");
  });

  it("refuses a source repository that borrows objects through alternates", async () => {
    const { root, source, bin, base } = await gitSource("ablation-alternates-");
    await writeFile(join(source, ".git", "objects", "info", "alternates"), "/nonexistent/objects\n");
    const task = { ...(await reviewTask(root, "I2")), baseCommit: base };
    const run = buildMatrix([task], PAIRINGS.filter((p) => p.id === "pl-review"))[0]!;
    await expect(withPath(bin, async () => prepareRunScope({
      waveDir: join(root, "wave"), run, task, sourceRepoPath: source, extensionTemplate: join(root, "t"), hostAuth: {}, productionProfile: PROFILE, tools: await realTools(bin),
    }))).rejects.toThrow("source_alternates");
    expect(existsSync(scopeRoot(join(root, "wave"), run.runId))).toBe(false);
  });
});

describe("hardening (R44)", () => {
  it("builds every command from absolute tool paths, inside bubblewrap, without an inspector", () => {
    const traced = tracedCommand(TOOLS, EMPTY_PLAN, "/scope", "/priv/strace.log", "/scope/run-input.json");
    expect(traced.file).toBe(TOOLS.prlimit);
    expect(traced.args.slice(0, 3)).toEqual([CORE_LIMIT, "--", TOOLS.strace]);
    const afterStrace = traced.args.slice(traced.args.indexOf("-o") + 2);
    expect(afterStrace.slice(0, 2)).toEqual(["--", TOOLS.bwrap]);
    // The build the run unit loads from lives under /tmp, which the sandbox hides: it is bound back read-only, after the tmpfs.
    const withBuild = tracedCommand(TOOLS, { ...EMPTY_PLAN, extraReadOnly: [BUILD_ROOT] }, "/scope", "/priv/strace.log", "/scope/run-input.json");
    const sandboxArgs = withBuild.args.slice(withBuild.args.indexOf("-o") + 2);
    const roAt = sandboxArgs.findIndex((arg, i) => arg === "--ro-bind" && sandboxArgs[i + 1] === BUILD_ROOT && sandboxArgs[i + 2] === BUILD_ROOT);
    expect(roAt).toBeGreaterThan(sandboxArgs.indexOf("--tmpfs"));
    const sandboxEnd = afterStrace.indexOf("--", 2);
    expect(afterStrace.slice(sandboxEnd + 1, sandboxEnd + 3)).toEqual([process.execPath, "--disable-sigusr1"]);
    expect(traced.args.at(-1)).toBe("/scope/run-input.json");
    const plain = untracedCommand(TOOLS, EMPTY_PLAN, "/scope", "/scope/run-input.json");
    expect(plain.file).toBe(TOOLS.prlimit);
    expect(plain.args.slice(0, 3)).toEqual([CORE_LIMIT, "--", TOOLS.bwrap]);
    expect(plain.args.slice(plain.args.indexOf("--", 2) + 1, plain.args.indexOf("--", 2) + 3)).toEqual([process.execPath, "--disable-sigusr1"]);
    expect(plain.args.at(-1)).toBe("/scope/run-input.json");
  });

  it("resolves tools once to absolute paths from the supervisor's PATH and fails closed", async () => {
    const present = new Set(["/opt/a/strace", "/opt/b/prlimit", "/opt/b/git", "/opt/b/codegraph", "/opt/b/bwrap", "/rel/strace"]);
    const exists = async (path: string) => present.has(path);
    expect(await resolveTools("/opt/a:/opt/b", exists)).toEqual({ strace: "/opt/a/strace", prlimit: "/opt/b/prlimit", git: "/opt/b/git", codegraph: "/opt/b/codegraph", bwrap: "/opt/b/bwrap" });
    // A relative PATH entry (the worker's cwd, for instance) is never used.
    await expect(resolveTools("rel:/opt/b", exists)).rejects.toThrow("strace_missing");
    present.delete("/opt/b/codegraph");
    await expect(resolveTools("/opt/a:/opt/b", exists)).rejects.toThrow("codegraph_missing");
    present.add("/opt/b/codegraph");
    present.delete("/opt/b/bwrap");
    await expect(resolveTools("/opt/a:/opt/b", exists)).rejects.toThrow("bwrap_missing");
  });

  it("hands the resolved tools to scope preparation, the oracle wrap and the spawn, and refuses when one is missing", async () => {
    const s = await waveSetup(1, { kind: "implementation" });
    const seen: ToolPaths[] = [];
    const wraps: string[][] = [];
    const scored: WaveDeps["scoreImplementation"] = async (_c, _t, options) => {
      const argv = options.wrap!(["npm", "test"]);
      wraps.push(argv);
      await writeFile(argv[argv.indexOf("-o") + 1]!, benignTrace());
      return { accepted: true, testsPassed: true, outOfScope: [] };
    };
    const { deps } = s.deps([text()], {
      scoreImplementation: scored, prepareScope: async (input) => { seen.push(input.tools as ToolPaths); return fakePrepare(input); },
    });
    await runWave(s.input, deps);
    expect(seen[0]).toMatchObject({ git: TOOLS.git, codegraph: TOOLS.codegraph });
    expect(wraps[0]![0]).toBe(TOOLS.strace);
    const missing = await waveSetup(1);
    const failing = missing.deps([text()], { resolveTools: async () => { throw new Error("strace_missing"); } });
    await expect(runWave(missing.input, failing.deps)).rejects.toThrow("strace_missing");
    expect(failing.captured).toHaveLength(0);
  });

  it("refuses a wave directory inside a source repository or containing one", async () => {
    const root = await temporaryRoot("ablation-wave-dir-");
    const source = join(root, "repo");
    await mkdir(join(source, "eval", "results"), { recursive: true });
    await assertWaveDirOutsideSources(join(root, "elsewhere", "wave"), [source]);
    await expect(assertWaveDirOutsideSources(join(source, "eval", "results", "wave"), [source])).rejects.toThrow("wave_dir_in_source");
    await expect(assertWaveDirOutsideSources(source, [source])).rejects.toThrow("wave_dir_in_source");
    await expect(assertWaveDirOutsideSources(root, [source])).rejects.toThrow("wave_dir_in_source");
    // A symlinked route into the repository does not hide it.
    await symlink(source, join(root, "alias"));
    await expect(assertWaveDirOutsideSources(join(root, "alias", "wave"), [source])).rejects.toThrow("wave_dir_in_source");
    await expect(assertWaveDirOutsideSources(join(root, "repo-two", "wave"), [source])).resolves.toBeUndefined();
  });

  it("makes runWave and runPreflight refuse that layout before anything starts", async () => {
    const s = await waveSetup(1);
    const inside = { ...productionConfig, workspaces: { repo: join(s.waveDir, "..") } };
    const { deps, captured } = s.deps([text()]);
    await expect(runWave({ ...s.input, productionConfig: inside }, deps)).rejects.toThrow("wave_dir_in_source");
    expect(captured).toHaveLength(0);
    expect(existsSync(s.waveDir)).toBe(false);
    const tasks = s.input.tasks;
    const approval = approvalFor(tasks, s.runs);
    await expect(runPreflight({ approval, waveDir: s.waveDir, ledgerPath: s.input.ledgerPath, productionConfig: inside, hostAuth: {} }, { hostCheck: async () => undefined, containmentCheck: async () => undefined, planSandbox: async () => EMPTY_PLAN, resolveTools: async () => TOOLS })).rejects.toThrow("wave_dir_in_source");
  });

  it("gives the scope no session bus and no runtime directory, whatever the supervisor has", async () => {
    const saved = { runtime: process.env.XDG_RUNTIME_DIR, bus: process.env.DBUS_SESSION_BUS_ADDRESS };
    process.env.XDG_RUNTIME_DIR = "/run/user/1000";
    process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/run/user/1000/bus";
    try {
      const env = scopeEnv("/scope", { home: "/scope/home", agentDir: "/scope/agent" });
      expect(env).not.toHaveProperty("XDG_RUNTIME_DIR");
      expect(env).not.toHaveProperty("DBUS_SESSION_BUS_ADDRESS");
      expect(Object.values(env).every((value) => !value.includes("/run/user"))).toBe(true);
    } finally {
      if (saved.runtime === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = saved.runtime;
      if (saved.bus === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = saved.bus;
    }
  });
});

describe("Unix socket stop and preflight charge", () => {
  it("stops a wave on a connect to the user bus", async () => {
    const s = await waveSetup(2);
    const trace = `${benignTrace()}4242 connect(3<socket:[1]>, {sa_family=AF_UNIX, sun_path="/run/user/1000/bus"}, 21) = 0\n`;
    const r = await runWave(s.input, s.deps([text({ trace })]).deps);
    expect(r.stopReason).toBe("unresolved_egress");
    expect(r.records[0]!.trace).toMatchObject({ unresolvedEgress: 1 });
  });

  it("charges the estimate when the preflight throws after the spawn", async () => {
    const root = await temporaryRoot("ablation-preflight-throw-");
    const tasks = [await reviewTask(root, "P1")];
    const approval = approvalFor(tasks, buildMatrix(tasks, PAIRINGS.filter((p) => p.id === "pl-review")));
    const { spawnRun } = fake([text()], root);
    const ledgerPath = join(root, "ledger.json");
    const r = await runPreflight({ approval, waveDir: join(root, "w"), ledgerPath, productionConfig, hostAuth: { openai: { type: "api_key", key: "k" } } }, {
      spawnRun: (scope, input) => spawnRun(scope, input, join(scope.root, "x.log")), checkRoute: async () => undefined, hostCheck: async () => undefined, containmentCheck: async () => undefined,
      resolveTools: async () => TOOLS, residualCheck: async () => { throw new Error("residual exploded"); },
    });
    expect(r.routes).toMatchObject([{ ok: false, failure: "preflight_step_failed" }]);
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as { entries: { runId: string; costUsd: number; estimated?: boolean }[] };
    expect(ledger.entries).toMatchObject([{ runId: "preflight-review", costUsd: 1, estimated: true }]);
    expect(existsSync(scopeRoot(join(root, "w"), "preflight-review"))).toBe(false);
  });
});

describe("bubblewrap containment (R46)", () => {
  const hasBwrap = existsSync("/usr/bin/bwrap");

  const HOME = "/home/op";
  const plan: SandboxPlan = {
    runReadOnly: ["/run/systemd/resolve"], varRunDirectory: false, home: HOME,
    homeReadOnly: [`${HOME}/repo/node_modules`, `${HOME}/.local/bin`], extraReadOnly: ["/tmp/build"],
  };

  it("builds the sandbox: /run and the home hidden, name resolution and needs bound back read-only, scope bind after the tmpfs mounts", () => {
    const args = bwrapArgs("/tmp/x/scope", plan, ["/tmp/x/oracle-home"]);
    expect(args.slice(0, 3)).toEqual(["--ro-bind", "/", "/"]);
    const at = (flag: string, value: string) => args.findIndex((arg, i) => arg === flag && args[i + 1] === value);
    const bind = (flag: string, path: string) => args.findIndex((arg, i) => arg === flag && args[i + 1] === path && args[i + 2] === path);
    const bindScope = bind("--bind", "/tmp/x/scope");
    expect(at("--tmpfs", "/tmp")).toBeGreaterThan(-1);
    expect(bindScope).toBeGreaterThan(at("--tmpfs", "/tmp"));
    expect(bind("--bind", "/tmp/x/oracle-home")).toBeGreaterThan(bindScope);
    // R48: all of /run is a tmpfs; no dedicated /run/user or /run/dbus entry is left to forget a sibling socket.
    expect(at("--tmpfs", "/run")).toBeGreaterThan(-1);
    expect(args.some((arg, i) => arg === "--tmpfs" && (args[i + 1] === "/run/user" || args[i + 1] === "/run/dbus"))).toBe(false);
    expect(bind("--ro-bind", "/run/systemd/resolve")).toBeGreaterThan(at("--tmpfs", "/run"));
    // R49: the home is a tmpfs, the needs are bound back read-only after it, the writable binds come last, then the home is remounted read-only.
    const home = at("--tmpfs", HOME);
    expect(home).toBeGreaterThan(at("--tmpfs", "/run"));
    expect(bind("--ro-bind", `${HOME}/repo/node_modules`)).toBeGreaterThan(home);
    expect(bind("--ro-bind", `${HOME}/.local/bin`)).toBeGreaterThan(home);
    expect(bindScope).toBeGreaterThan(bind("--ro-bind", `${HOME}/.local/bin`));
    expect(bind("--ro-bind", "/tmp/build")).toBeGreaterThan(at("--tmpfs", "/tmp"));
    expect(at("--remount-ro", HOME)).toBeGreaterThan(bind("--bind", "/tmp/x/oracle-home"));
    expect(args.filter((arg) => arg === "--bind")).toHaveLength(2);
    for (const flag of ["--dev", "--proc", "--die-with-parent", "--new-session", "--unshare-ipc", "--unshare-pid"]) expect(args).toContain(flag);
    expect(args).not.toContain("--share-net");
    expect(args).not.toContain("--unshare-net");
    expect(args.at(-1)).toBe("--");
    expect(sandboxed(TOOLS, plan, "/s", ["echo", "x"]).slice(0, 1)).toEqual([TOOLS.bwrap]);
    expect(sandboxed(TOOLS, plan, "/s", ["echo", "x"]).slice(-2)).toEqual(["echo", "x"]);
    expect(bwrapArgs("/s", { ...plan, varRunDirectory: true })).toContain("/var/run");
    expect(bwrapArgs("/s", { ...EMPTY_PLAN })).not.toContain("--remount-ro");
  });

  it("plans the host-dependent part: name resolution, the home with its needs, and a bundle's root", async () => {
    const root = await temporaryRoot("ablation-plan-");
    const home = join(root, "home");
    const repo = join(home, "repo");
    await mkdir(join(repo, "node_modules"), { recursive: true });
    await mkdir(join(repo, "skills"));
    const bundle = join(home, ".tools", "cg", "v1");
    await mkdir(join(bundle, "bin"), { recursive: true });
    await writeFile(join(bundle, "bin", "codegraph"), "#!/bin/sh\n");
    await mkdir(join(home, ".local", "bin"), { recursive: true });
    symlinkSync(join(bundle, "bin", "codegraph"), join(home, ".local", "bin", "codegraph"));
    await writeFile(join(home, ".local", "bin", "node"), "x");
    const planned = await planSandbox({ tools: { codegraph: join(home, ".local", "bin", "codegraph") }, repoRoot: repo, buildRoot: "/tmp/build", home, nodePath: join(home, ".local", "bin", "node") });
    expect(planned.home).toBe(await (await import("node:fs/promises")).realpath(home));
    expect(planned.homeReadOnly.sort()).toEqual([
      join(repo, "node_modules"), join(repo, "skills"), join(home, ".local", "bin"), join(bundle, "bin"), bundle,
    ].map((path) => path).sort());
    // A root directly below the home (`~/.local`) is never bound, however deep the binary sits.
    expect(planned.homeReadOnly).not.toContain(join(home, ".local"));
    expect(planned.extraReadOnly).toEqual(["/tmp/build"]);
    expect(planned.varRunDirectory).toBe(false);
  });

  const SOCKETS = ["/run/user/1000/bus", "/run/dbus/system_bus_socket", "/run/systemd/private", "/run/systemd/journal/socket", "/run/docker.sock"];
  const good = { home: "EROFS", ssh: "ENOENT", scope: true, oracleHome: true, tmp: true, sockets: Object.fromEntries(SOCKETS.map((p) => [p, "ENOENT"])) };
  /** A fake sandbox run: writes the strace log of a clean probe where `-o` says, then prints `result`. */
  const probe = (result: unknown, logText: (root: number) => string = () => `${benignTrace()}`) => async (_file: string, args: readonly string[]) => {
    const log = args[args.indexOf("-o") + 1]!;
    await writeFile(log, logText(4240));
    return { stdout: `noise\n${JSON.stringify(result)}\n`, stderr: "" };
  };
  const mutate = (patch: Record<string, unknown>) => ({ ...good, ...patch });

  it.each([
    ["a real home that could be written", mutate({ home: "created" })],
    ["a home failing with another error", mutate({ home: "EACCES" })],
    ["a readable .ssh", mutate({ ssh: true })],
    ["a .ssh failing differently", mutate({ ssh: "EACCES" })],
    ["a scope that cannot be written", mutate({ scope: "EROFS" })],
    ["an oracle home that cannot be written", mutate({ oracleHome: "EROFS" })],
    ["a /tmp that cannot be written", mutate({ tmp: "EROFS" })],
    ["a reachable user bus", mutate({ sockets: { ...good.sockets, "/run/user/1000/bus": "connected" } })],
    ["a reachable system bus", mutate({ sockets: { ...good.sockets, "/run/dbus/system_bus_socket": "connected" } })],
    ["a reachable docker socket", mutate({ sockets: { ...good.sockets, "/run/docker.sock": "connected" } })],
    ["a socket failing differently", mutate({ sockets: { ...good.sockets, "/run/systemd/private": "ECONNREFUSED" } })],
    ["a missing socket result", mutate({ sockets: {} })],
  ])("refuses with containment_failed for %s", async (_name, result) => {
    await expect(containmentSelfTest(TOOLS, EMPTY_PLAN, { run: probe(result), home: "/home/x", uid: 1000 })).rejects.toThrow("containment_failed");
  });

  it("refuses when the probe's own strace log shows an outside write or is missing", async () => {
    const outside = (root: number) => `${benignTrace()}${root + 2} openat(AT_FDCWD</scope>, "/home/x/leak", O_WRONLY|O_CREAT, 0644) = 3</home/x/leak>\n`;
    await expect(containmentSelfTest(TOOLS, EMPTY_PLAN, { run: probe(good, outside), home: "/home/x", uid: 1000 })).rejects.toThrow("containment_failed");
    await expect(containmentSelfTest(TOOLS, EMPTY_PLAN, { run: async () => ({ stdout: JSON.stringify(good), stderr: "" }), home: "/home/x", uid: 1000 })).rejects.toThrow("containment_failed");
  });

  it("refuses when a marker created in the sandbox's /tmp exists on the host afterwards", async () => {
    const leaking = async (_file: string, args: readonly string[]) => {
      await writeFile(args[args.indexOf("-o") + 1]!, benignTrace());
      const marker = args.find((arg) => arg.startsWith("/tmp/ablation-containment-marker-"))!;
      await writeFile(marker, "leaked");
      return { stdout: JSON.stringify(good), stderr: "" };
    };
    await expect(containmentSelfTest(TOOLS, EMPTY_PLAN, { run: leaking, home: "/home/x", uid: 1000 })).rejects.toThrow("containment_failed");
  });

  it("refuses when the sandbox does not start or prints garbage, and passes on the expected result through the production command", async () => {
    await expect(containmentSelfTest(TOOLS, EMPTY_PLAN, { run: async () => { throw Object.assign(new Error("helper_failed"), { code: 1 }); } })).rejects.toThrow("containment_failed");
    await expect(containmentSelfTest(TOOLS, EMPTY_PLAN, { run: async () => ({ stdout: "not json", stderr: "" }) })).rejects.toThrow("containment_failed");
    const seen: string[][] = [];
    const inner = probe(good);
    await containmentSelfTest(TOOLS, plan, { run: async (file, args) => { seen.push([file, ...args]); return inner(file, args); }, home: "/home/x", uid: 4242 });
    // The production shape: prlimit, then strace, then bubblewrap with the plan and the oracle-home bind.
    expect(seen[0]!.slice(0, 4)).toEqual([TOOLS.prlimit, CORE_LIMIT, "--", TOOLS.strace]);
    expect(seen[0]).toContain(TOOLS.bwrap);
    expect(seen[0]).toContain("--remount-ro");
    expect(seen[0]).toContain("/home/x");
    expect(seen[0]).toContain("4242");
    expect(seen[0]!.filter((arg) => arg === "--bind")).toHaveLength(2);
  });

  it("makes the wave refuse to start when the containment check fails, before anything exists", async () => {
    const s = await waveSetup(1);
    const { deps, captured } = s.deps([text()], { containmentCheck: async () => { throw new Error("containment_failed"); } });
    await expect(runWave(s.input, deps)).rejects.toThrow("containment_failed");
    expect(captured).toHaveLength(0);
    expect(existsSync(s.waveDir)).toBe(false);
  });

  it.skipIf(!hasBwrap)("really contains: the real self-test passes through the production shape; $HOME, host sockets and /tmp are sealed; the scope may sit below /tmp or $HOME; the sandbox dies with its leader", async () => {
    const real = { bwrap: "/usr/bin/bwrap", strace: "/usr/bin/strace", prlimit: "/usr/bin/prlimit", codegraph: "/nonexistent/codegraph" };
    const realPlan = await planSandbox({ tools: real, repoRoot: process.cwd(), buildRoot: BUILD_ROOT });
    await containmentSelfTest(real, realPlan);
    const run = (scope: string, script: string) => runHelper(real.bwrap, sandboxed(real, realPlan, scope, ["sh", "-c", script]).slice(1));
    // Below /tmp.
    const scope = await temporaryRoot("ablation-real-bwrap-");
    const marker = `.ablation-contain-${process.pid}`;
    await expect(run(scope, `echo x > "${homedir()}/${marker}"`)).rejects.toThrow();
    expect(existsSync(join(homedir(), marker))).toBe(false);
    await run(scope, `echo ok > "${scope}/inside" && test -d /run && test ! -e /run/docker.sock && test ! -e /run/dbus && test ! -e "${homedir()}/.ssh"`);
    expect(await readFile(join(scope, "inside"), "utf8")).toBe("ok\n");
    // Below the (hidden, read-only) home: the writable bind still works and is the only writable thing there.
    const homeScope = join(homedir(), `.ablation-scope-test-${process.pid}`);
    await mkdir(homeScope);
    try {
      await run(homeScope, `echo ok > "${homeScope}/inside" && ! (echo x > "${homedir()}/${marker}") 2>/dev/null`);
      expect(await readFile(join(homeScope, "inside"), "utf8")).toBe("ok\n");
      expect(existsSync(join(homedir(), marker))).toBe(false);
    } finally { await rm(homeScope, { recursive: true, force: true }); }
    // A background child does not survive the death of its leader: kill the process group like the supervisor does.
    const duration = String(40000 + (process.pid % 1000));
    const child = spawn(real.bwrap, sandboxed(real, realPlan, scope, ["sh", "-c", `sleep ${duration} & sleep ${duration}`]).slice(1), { detached: true, stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 800));
    const alive = async () => (await exec("ps", ["-eo", "args"])).stdout.split("\n").filter((line) => line.trim() === `sleep ${duration}`).length;
    expect(await alive()).toBeGreaterThan(0);
    process.kill(-child.pid!, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(await alive()).toBe(0);
  });
});

describe("pinned wave directories (item 3)", () => {
  it("removes nothing when private was swapped for a symlink, and the victim survives", async () => {
    const s = await waveSetup(2);
    const victimParent = join(s.root, "victim-parent");
    mkdirSync(join(victimParent, s.runs[0]!.runId), { recursive: true });
    writeFileSync(join(victimParent, s.runs[0]!.runId, "precious.txt"), "x");
    const { spawnRun } = fake([text()], s.root);
    const swapping = (scope: RunScope, runInput: string, log: string): ChildProcess => {
      renameSync(join(s.waveDir, "private"), join(s.waveDir, "private-moved"));
      symlinkSync(victimParent, join(s.waveDir, "private"));
      return spawnRun(scope, runInput, log);
    };
    const r = await runWave(s.input, { ...baseDeps(), spawnRun: swapping });
    expect(r.records[0]).toMatchObject({ outcome: "stopped", stopReason: "harness_failure", harnessError: "wave_dir_tampered" });
    expect(r.records[1]!.outcome).toBe("not_run");
    expect(existsSync(join(victimParent, s.runs[0]!.runId, "precious.txt"))).toBe(true);
  });

  it("detects a swapped intermediate directory with the guard itself", async () => {
    const root = await temporaryRoot("ablation-dir-guard-");
    const guard = await WaveDirGuard.capture(join(root, "wave"));
    await guard.assertIntact();
    renameSync(join(root, "wave", "scopes"), join(root, "wave", "scopes-old"));
    await expect(guard.assertIntact()).rejects.toThrow("wave_dir_tampered");
    symlinkSync(join(root, "wave", "scopes-old"), join(root, "wave", "scopes"));
    await expect(guard.assertIntact()).rejects.toThrow("wave_dir_tampered");
  });
});

describe("canonical paths and wave directory scope (items 4 and 6)", () => {
  it("judges a path under a non-existent top-level directory by its own name", async () => {
    await expect(assertWaveDirOutsideSources("/ablation-nx-top/wave", ["/ablation-nx-top"])).rejects.toThrow("wave_dir_in_source");
    // The old slicing turned "/xablation-home" into "/ablation-home" and refused it wrongly.
    await expect(assertWaveDirOutsideSources("/xablation-nx-top/wave", ["/ablation-nx-top"])).resolves.toBeUndefined();
  });

  it("also refuses a wave directory inside the evaluation repository when it is not a configured workspace", async () => {
    const s = await waveSetup(1);
    const { deps, captured } = s.deps([text()]);
    await expect(runWave({ ...s.input, repoRoot: s.root }, deps)).rejects.toThrow("wave_dir_in_source");
    expect(captured).toHaveLength(0);
    const approval = approvalFor(s.input.tasks, s.runs);
    await expect(runPreflight({ approval, waveDir: s.waveDir, ledgerPath: s.input.ledgerPath, productionConfig, hostAuth: {}, repoRoot: s.root }, {
      hostCheck: async () => undefined, containmentCheck: async () => undefined, planSandbox: async () => EMPTY_PLAN, resolveTools: async () => TOOLS,
    })).rejects.toThrow("wave_dir_in_source");
  });
});

describe("preflight cleanup and denied attempts", () => {
  it("fails the route with cleanup_failure when its scope cannot be removed, and keeps preflight.json failing", async () => {
    const root = await temporaryRoot("ablation-preflight-cleanup-");
    const waveDir = join(root, "w");
    const tasks = [await reviewTask(join(root, "repo"), "P1")];
    const approval = approvalFor(tasks, buildMatrix(tasks, PAIRINGS.filter((p) => p.id === "pl-review")));
    const { spawnRun } = fake([{ cost: 0.01, text: "PONG" }], root);
    const locking = (scope: RunScope, input: string): ChildProcess => {
      const locked = join(scope.root, "locked");
      mkdirSync(join(locked, "f"), { recursive: true });
      chmodSync(locked, 0o500);
      return spawnRun(scope, input, join(scope.root, "x.log"));
    };
    const result = await runPreflight({ approval, waveDir, ledgerPath: join(root, "l.json"), productionConfig, hostAuth: { openai: { type: "api_key", key: "k" } } }, {
      spawnRun: locking, checkRoute: async () => undefined, hostCheck: async () => undefined, containmentCheck: async () => undefined,
      resolveTools: async () => TOOLS, residualCheck: async () => true,
    });
    chmodSync(join(scopeRoot(waveDir, "preflight-review"), "locked"), 0o700);
    expect(result.routes).toMatchObject([{ profile: "review", ok: false, failure: "cleanup_failure" }]);
    await expect(assertPreflightPassed(waveDir, approval, join(root, "l.json"))).rejects.toThrow("preflight_failed");
  });

  it("records denied write attempts as a scored observation, not a stop", async () => {
    const s = await waveSetup(2);
    const denied = `${benignTrace()}4242 openat(AT_FDCWD</scope>, "/home/u/x", O_WRONLY|O_CREAT, 0644) = -1 EROFS (Read-only file system)\n`;
    const r = await runWave(s.input, s.deps([text({ trace: denied }), text()]).deps);
    expect(r.stopReason).toBeNull();
    expect(r.records[0]).toMatchObject({ outcome: "scored", trace: { deniedWriteAttempts: 1, outsideWrites: 0 } });
  });
});

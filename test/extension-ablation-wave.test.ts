import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { chmod, cp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import { homedir, userInfo } from "node:os";
import { afterAll, describe, expect, it, vi } from "vitest";
import { matrixDigest, routesOf, tasksDigest, validateApproval, type Approval } from "../eval/extensions/approval.js";
import { parseArgs, sourceCommit, withAbort } from "../eval/extensions/cli.js";
import { buildMatrix, PAIRINGS } from "../eval/extensions/matrix.js";
import type { ImplementationScore } from "../eval/extensions/oracles.js";
import { runHelper } from "../eval/extensions/helpers.js";
import { readVerifiedOutput } from "../eval/extensions/audit.js";
import { WaveDirGuard, removeTree } from "../eval/extensions/evidence.js";
import { HostCredentialError, fileHostCredentials, type HostCredentials } from "../eval/extensions/credentials.js";
import { ABSENT_PATHS, containmentSelfTest } from "../eval/extensions/containment.js";
import { ETC_ENTRIES, EMPTY_PLAN, bwrapArgs, planSandbox, sandboxed, type PlanHost, type SandboxPlan } from "../eval/extensions/sandbox.js";
import { dirtyBoundPaths, sourceIsDirty } from "../eval/extensions/bound.js";
import { assertWaveDirOutsideSources, realHome, resolveTool, resolveTools, type ToolPaths } from "../eval/extensions/tools.js";
import { encodeKey, macOf, sha256Hex } from "../eval/extensions/output-mac.js";
import { readRegularFile } from "../eval/extensions/safe-read.js";
import { BUILD_ROOT, CORE_LIMIT, assertHostSafe, groupIsEmpty, tracedCommand, untracedCommand } from "../eval/extensions/supervise.js";
import { dnsServers, modelHost } from "../eval/extensions/network.js";
import { assertPreflightPassed, runPreflight } from "../eval/extensions/preflight.js";
import { hash } from "../eval/profiles/files.js";
import type { RunSpec, TaskSpec } from "../eval/extensions/schemas.js";
import { buildPlan } from "../eval/extensions/cli.js";
import { MAX_UNEXPECTED_CONNECTS, mergeTrace, summarizeTrace } from "../eval/extensions/classify.js";
import { PersistedLedger } from "../eval/extensions/ledger-file.js";
import { scoreImplementation } from "../eval/extensions/oracles.js";
import { writeEvidence } from "../eval/extensions/report.js";
import { taskSpecSchema } from "../eval/extensions/schemas.js";
import { runWave, type RunRecord, type WaveDeps, type WaveInput } from "../eval/extensions/wave.js";
import {
  assertCloneSymlinks, prepareEmptyScope, prepareRunScope, privateRunDir, renderPrompt, runConfig, scopeEnv, scopeRoot, type RunScope, type ScopeInput,
} from "../eval/extensions/workspace.js";
import { realHostWith } from "./real-host.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

const exec = promisify(execFile);
afterAll(removeTemporaryRoots);

const SOURCE = "/src/example-repo";
const PROFILE = { provider: "openai", model: "model-a", thinkingLevel: "high", permissionProfile: "read-only", default: true, skills: ["pi-session-review"] };
const CODING = { provider: "deepseek", model: "model-b", thinkingLevel: "high", permissionProfile: "coding", default: false, skills: ["pi-session-implementation"] };
const OPT_OUT = { DO_NOT_TRACK: "DO_NOT_TRACK", CODEGRAPH_NO_UPDATE_CHECK: "CODEGRAPH_NO_UPDATE_CHECK", CODEGRAPH_TELEMETRY: "CODEGRAPH_TELEMETRY" };
const CODEGRAPH_SERVER = { command: "/usr/bin/codegraph", args: ["serve", "--mcp"], tools: { explore: { name: "codegraph_explore", readOnly: true } } };
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
  /** The assistant usage sum the run unit reports (default 0); it matters when the session total is null (`cost: null`). */
  assistantCost?: number;
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
      assistant: { messages: 1, input: 10, output: 5, cacheRead: 2, cacheWrite: 0, costUsd: cost ?? step.assistantCost ?? 0 },
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
      kind: "review", verdict: { pattern: "." },
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

function approvalFor(tasks: TaskSpec[], runs: RunSpec[], sourceCommit = "c".repeat(40)): Approval {
  return {
    approved: true, approvedAt: "2026-10-20T00:00:00Z", budgetUsd: 10, sourceCommit, tasksDigest: tasksDigest(tasks), matrixDigest: matrixDigest(runs),
    ledgerId: LEDGER_ID, runs, routes: routesOf(productionConfig, runs.map((r) => r.profile)),
  };
}

/** The ledger an approval's id names: the evaluation's one ledger exists before any preflight or wave (R55). */
async function seedLedger(path: string, entries: unknown[] = [], ledgerId: string = LEDGER_ID): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ ledgerId, limitUsd: 10, spentUsd: 0, entries }));
}

/** The seams that keep a preflight or wave test off the host: no strace, bwrap, codegraph, DNS or provider. */
const seams = () => ({
  hostCheck: async () => undefined, containmentCheck: async () => undefined, planSandbox: async () => EMPTY_PLAN, resolveTools: async () => TOOLS, checkRoute: async () => undefined,
});

async function waveSetup(count: number, options: Partial<WaveInput> & { kind?: "review" | "implementation"; hostAuth?: unknown; sourceCommit?: string } = {}): Promise<Setup> {
  const root = await temporaryRoot("ablation-wave-");
  const waveDir = join(root, "wave");
  // The evaluation repository is a sibling of the wave directory: a wave directory inside it is refused.
  const repo = join(root, "repo");
  const make = options.kind === "implementation" ? implTask : reviewTask;
  const tasks = await Promise.all(["T1", "T2", "T3"].map((id) => make(repo, id)));
  const pairing = PAIRINGS.filter((p) => p.id === (options.kind === "implementation" ? "pl-code" : "pl-review"));
  const runs = buildMatrix(tasks, pairing).slice(0, count);
  const { kind: _kind, hostAuth, sourceCommit, ...rest } = options;
  const input: WaveInput = {
    approval: approvalFor(tasks, runs, sourceCommit), tasks, waveDir, ledgerPath: join(root, "ledger.json"), productionConfig, extensionTemplate: join(root, "template"), repoRoot: repo,
    hostAuth: hostAuth ?? { openai: { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 }, xai: { type: "api_key", key: "k" } },
    killGraceMs: 0, ...rest,
  };
  if (!existsSync(input.ledgerPath)) await seedLedger(input.ledgerPath);
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
    // R42: the worker-controlled path is nowhere on disk but in the one kept diagnostics file (R84); the record carries the count only.
    expect(await readFile(join(s.waveDir, "runs", `${s.runs[0]!.runId}.json`), "utf8")).not.toContain("/home/u");
    expect(existsSync(privateRunDir(s.waveDir, s.runs[0]!.runId))).toBe(false);
    const diagnostics = await findFiles(join(s.waveDir, "diagnostics"), /./);
    expect(diagnostics).toEqual([join(s.waveDir, "diagnostics", `${s.runs[0]!.runId}.txt`)]);
    for (const file of (await findFiles(s.waveDir, /./)).filter((path) => !diagnostics.includes(path))) expect(await readFile(file, "utf8")).not.toContain("/home/u/secret");
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

  describe("abstract sockets bound inside the trace (R88)", () => {
    const line = (call: string, name: string, ret = "0") => `4242 ${call}(4<socket:[32553896]>, {sa_family=AF_UNIX, sun_path=@"${name}"}, 44) = ${ret}\n`;

    it("does not stop a run whose own processes bind and connect an abstract name, and stops for a name nobody bound", async () => {
      const s = await waveSetup(2);
      const own = `${benignTrace()}${line("bind", "mail-pdf-73342cfaea134cc4be84610388df1d0d")}${line("connect", "mail-pdf-73342cfaea134cc4be84610388df1d0d")}`;
      const ok = await runWave(s.input, s.deps([text({ trace: own }), text()]).deps);
      expect(ok.stopReason).toBeNull();
      expect(ok.records[0]).toMatchObject({ outcome: "scored", trace: { unresolvedEgress: 0 } });
      expect(existsSync(join(s.waveDir, "diagnostics"))).toBe(false);
      const t = await waveSetup(2);
      const foreign = `${benignTrace()}${line("bind", "mine")}${line("connect", "docker_cli_bda8b079f8fdef11b684b7c481c7a6ce")}`;
      const stopped = await runWave(t.input, t.deps([text({ trace: foreign })]).deps);
      expect(stopped.stopReason).toBe("unresolved_egress");
      expect(await readFile(join(t.waveDir, "diagnostics", `${stopped.records[0]!.runId}.txt`), "utf8")).toContain("docker_cli_bda8b079f8fdef11b684b7c481c7a6ce");
    });

    it("stops for a connect before the bind and for a name whose bind failed with EADDRINUSE", async () => {
      for (const trace of [
        `${benignTrace()}${line("connect", "svc")}${line("bind", "svc")}`,
        `${benignTrace()}${line("bind", "svc", "-1 EADDRINUSE (Address already in use)")}${line("connect", "svc")}`,
      ]) {
        const s = await waveSetup(2);
        expect((await runWave(s.input, s.deps([text({ trace })]).deps)).stopReason).toBe("unresolved_egress");
      }
    });

    it("judges the oracle's trace the same way", async () => {
      const s = await waveSetup(1, { kind: "implementation" });
      const scoring: WaveDeps["scoreImplementation"] = async (_clone, _task, options) => {
        const argv = options.wrap!(["npm", "test"]);
        await writeFile(argv[argv.indexOf("-o") + 1]!, prelude(9000) + (line("bind", "t") + line("connect", "t") + line("connect", "u")).replaceAll("4242", "9000"));
        return { accepted: true, testsPassed: true, outOfScope: [] };
      };
      const r = await runWave(s.input, s.deps([text()], { scoreImplementation: scoring }).deps);
      expect(r.stopReason).toBe("unresolved_egress");
      expect(r.records[0]!.trace).toMatchObject({ unresolvedEgress: 1 });
    });
  });

  describe("sockets in the sandbox's private /tmp (R87)", () => {
    const connect = (path: string) => `4242 connect(19<socket:[1234567]>, {sa_family=AF_UNIX, sun_path="${path}"}, 110) = 0\n`;
    const bound = { ...EMPTY_PLAN, extraReadOnly: ["/tmp/ablation-build-x"] };

    it("does not stop a run whose codegraph MCP server connects to its daemon socket in /tmp, and keeps no diagnostics", async () => {
      const s = await waveSetup(2);
      const r = await runWave(s.input, s.deps([text({ trace: `${benignTrace()}${connect("/tmp/codegraph-9ae10b5c0e7502a8.sock")}` }), text()]).deps);
      expect(r.stopReason).toBeNull();
      expect(r.records[0]).toMatchObject({ outcome: "scored", trace: { unresolvedEgress: 0 } });
      expect(existsSync(join(s.waveDir, "diagnostics"))).toBe(false);
    });

    it("does not stop a run for a name-resolution socket although the plan binds /run/systemd/resolve back in", async () => {
      const s = await waveSetup(2);
      const plan = { ...EMPTY_PLAN, runReadOnly: ["/run/systemd/resolve"], extraReadOnly: ["/tmp/ablation-build-x"] };
      const trace = `${benignTrace()}${connect("/run/systemd/resolve/io.systemd.Resolve")}`;
      const r = await runWave(s.input, s.deps([text({ trace }), text()], { planSandbox: async () => plan }).deps);
      expect(r.stopReason).toBeNull();
      expect(r.records[0]).toMatchObject({ outcome: "scored", trace: { unresolvedEgress: 0 } });
      expect(existsSync(join(s.waveDir, "diagnostics"))).toBe(false);
    });

    it("still stops for a socket below a host path the plan binds in, and for one outside /tmp", async () => {
      for (const path of ["/tmp/ablation-build-x/run/x.sock", "/run/user/1000/bus"]) {
        const s = await waveSetup(2);
        const r = await runWave(s.input, s.deps([text({ trace: `${benignTrace()}${connect(path)}` })], { planSandbox: async () => bound }).deps);
        expect(r.stopReason, path).toBe("unresolved_egress");
        expect(await readFile(join(s.waveDir, "diagnostics", `${r.records[0]!.runId}.txt`), "utf8")).toContain(path);
      }
    });

    it("judges the oracle's trace with the bound dependency mounts as host paths", async () => {
      const s = await waveSetup(1, { kind: "implementation" });
      const scoring: WaveDeps["scoreImplementation"] = async (_clone, _task, options) => {
        const argv = options.wrap!(["npm", "test"]);
        await writeFile(argv[argv.indexOf("-o") + 1]!, prelude(9000) + connect("/tmp/codegraph-1.sock").replace("4242", "9000") + connect("/tmp/ablation-build-x/x.sock").replace("4242", "9000"));
        return { accepted: true, testsPassed: true, outOfScope: [] };
      };
      const r = await runWave(s.input, s.deps([text()], { scoreImplementation: scoring, planSandbox: async () => bound }).deps);
      expect(r.stopReason).toBe("unresolved_egress");
      expect(r.records[0]!.trace).toMatchObject({ unresolvedEgress: 1 });
    });
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
    expect(r.records[1]!.review).toMatchObject({ criticalHit: 1, falseFindings: [], verdictMatched: true });
  });

  it("carries the verdict flag into the record and does not accept a review that omits the verdict (R78)", async () => {
    const s = await waveSetup(2);
    s.input.tasks = s.input.tasks.map((task) => (task.oracle.kind === "review" ? { ...task, oracle: { ...task.oracle, verdict: { pattern: "^verdict: ready$" } } } : task));
    s.input.approval = approvalFor(s.input.tasks, s.runs);
    const r = await runWave(s.input, s.deps([text({ text: `${GOOD_REVIEW}\nVerdict: ready` }), text()]).deps);
    expect(r.records[0]).toMatchObject({ outcome: "scored", accepted: true, review: { verdictMatched: true, criticalHit: 1 } });
    expect(r.records[1]).toMatchObject({ outcome: "scored", accepted: false, review: { verdictMatched: false, criticalHit: 1 } });
    // The record keeps the pattern's outcome only, never the pattern or the review text (record 0 holds the text with the verdict).
    for (const record of r.records) {
      const body = await readFile(join(s.waveDir, "runs", `${record.runId}.json`), "utf8");
      for (const leaked of ["Verdict: ready", "verdict: ready", "race in the cache refresh"]) expect(body).not.toContain(leaked);
    }
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

describe("task dependencies in a wave (R68)", () => {
  const DEPENDENCIES = [{ path: "backend/.venv", lockfile: "backend/uv.lock" }];
  const BINDS = [{ source: "/deps/T1/mounts/backend/.venv", target: "/scope/clone/backend/.venv" }, { source: "/deps/T1/runtime", target: "/deps/T1/runtime" }];

  async function dependentWave(count: number) {
    const s = await waveSetup(count, { kind: "implementation" });
    s.input.tasks = s.input.tasks.map((task) => ({ ...task, dependencies: DEPENDENCIES }));
    s.input.approval = approvalFor(s.input.tasks, s.runs);
    return s;
  }

  it("refuses to start without a deps directory when a pending run's task declares dependencies, before anything exists", async () => {
    const s = await dependentWave(1);
    const { deps, captured } = s.deps([text()]);
    await expect(runWave(s.input, deps)).rejects.toThrow("deps_missing");
    expect(captured).toHaveLength(0);
    expect(existsSync(s.waveDir)).toBe(false);
    // A wave without dependencies needs none.
    const plain = await waveSetup(1, { kind: "implementation" });
    await expect(runWave(plain.input, plain.deps([text()]).deps)).resolves.toMatchObject({ stopReason: null });
  });

  it("refuses a deps directory inside the evaluation repository, a workspace or the wave directory, or above one", async () => {
    const s = await dependentWave(1);
    const { deps } = s.deps([text()]);
    for (const dir of [join(s.root, "repo", "deps"), join(s.root, "repo"), "/src/example-repo/deps", "/src", join(s.waveDir, "deps"), s.root]) {
      await expect(runWave({ ...s.input, depsDir: dir }, deps)).rejects.toThrow("deps_dir_in_source");
    }
    expect(existsSync(s.waveDir)).toBe(false);
  });

  it("hands the deps directory to the scope and sandboxes the oracle with the scope's binds after the scope and oracle-home binds", async () => {
    const s = await dependentWave(1);
    const depsDir = join(s.root, "deps");
    const inputs: ScopeInput[] = [];
    let argv: string[] = [];
    const scoring: WaveDeps["scoreImplementation"] = async (_clone, _task, options) => {
      argv = options.wrap!(["env", "-C", "backend", ".venv/bin/python", "-m", "pytest"]);
      await writeFile(argv[argv.indexOf("-o") + 1]!, benignTrace());
      return { accepted: true, testsPassed: true, outOfScope: [] };
    };
    const { deps } = s.deps([text()], {
      prepareScope: async (input) => { inputs.push(input); return { ...await fakePrepare(input), dependencyBinds: BINDS }; }, scoreImplementation: scoring, checkDependencies: async () => undefined,
    });
    const result = await runWave({ ...s.input, depsDir }, deps);
    expect(result.stopReason).toBeNull();
    expect(inputs.map((input) => input.depsDir)).toEqual([depsDir]);
    const at = (flag: string, source: string, target: string) => argv.findIndex((arg, i) => arg === flag && argv[i + 1] === source && argv[i + 2] === target);
    const scopeBind = argv.findIndex((arg, i) => arg === "--bind" && argv[i + 1] === argv[i + 2] && argv[i + 1]!.includes("/scopes/"));
    const oracleHome = argv.findIndex((arg, i) => arg === "--bind" && argv[i + 1] === argv[i + 2] && argv[i + 1]!.endsWith("oracle-home"));
    expect(scopeBind).toBeGreaterThan(-1);
    expect(oracleHome).toBeGreaterThan(scopeBind);
    expect(at("--ro-bind", BINDS[0]!.source, BINDS[0]!.target)).toBeGreaterThan(oracleHome);
    expect(at("--ro-bind", BINDS[1]!.source, BINDS[1]!.target)).toBeGreaterThan(at("--ro-bind", BINDS[0]!.source, BINDS[0]!.target));
    expect(argv.slice(-6)).toEqual(["env", "-C", "backend", ".venv/bin/python", "-m", "pytest"]);
    // The record says nothing about where the dependencies are.
    const record = await readFile(join(s.waveDir, "runs", `${result.records[0]!.runId}.json`), "utf8");
    expect(record).not.toContain(depsDir);
    expect(record).not.toContain("/deps/");
  });

  it("refuses a deps directory that is not canonical (a link on its way), before anything exists", async () => {
    const s = await dependentWave(1);
    await mkdir(join(s.root, "real-deps"));
    await symlink(join(s.root, "real-deps"), join(s.root, "deps"));
    await expect(runWave({ ...s.input, depsDir: join(s.root, "deps") }, s.deps([text()]).deps)).rejects.toThrow("deps_dir_not_canonical");
    expect(existsSync(s.waveDir)).toBe(false);
  });

  it("checks the dependencies of every pending task before the first run: a wrong lock of a later task refuses the wave", async () => {
    const root = await temporaryRoot("ablation-wave-deps-");
    const source = join(root, "source");
    await mkdir(join(source, "backend"), { recursive: true });
    const git = (...args: string[]) => exec("git", ["-C", source, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args]);
    await git("init", "--quiet");
    await writeFile(join(source, "backend", "uv.lock"), "lock-v1\n");
    await git("add", "."); await git("commit", "--quiet", "-m", "base");
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    const s = await waveSetup(6, { kind: "implementation", productionConfig: { ...productionConfig, workspaces: { repo: source } } });
    // The wave directory and the evaluation repository are siblings of the source in the temporary root `waveSetup` made; the deps live in ours.
    s.input.tasks = s.input.tasks.map((task) => ({ ...task, baseCommit: base, dependencies: DEPENDENCIES }));
    s.input.approval = approvalFor(s.input.tasks, s.runs);
    const depsDir = join(root, "deps");
    for (const [id, lock] of [["T1", "lock-v1\n"], ["T2", "lock-v2\n"], ["T3", "lock-v1\n"]] as const) {
      await mkdir(join(depsDir, id, "mounts", "backend", ".venv"), { recursive: true });
      await mkdir(join(depsDir, id, "lock", "backend"), { recursive: true });
      await writeFile(join(depsDir, id, "lock", "backend", "uv.lock"), lock);
    }
    const { deps, captured } = s.deps([text()], { resolveTools: async () => ({ ...TOOLS, git: await resolveTool("git", process.env.PATH ?? "") }) });
    await expect(runWave({ ...s.input, depsDir }, deps)).rejects.toThrow("dependency_lock_mismatch");
    expect(captured).toHaveLength(0);
    expect(existsSync(s.waveDir)).toBe(false);
    // With the lock right, the up-front check passes and the scope check (fake here) is the only one left.
    await writeFile(join(depsDir, "T2", "lock", "backend", "uv.lock"), "lock-v1\n");
    await expect(runWave({ ...s.input, depsDir }, s.deps([text()], { resolveTools: async () => ({ ...TOOLS, git: await resolveTool("git", process.env.PATH ?? "") }) }).deps)).resolves.toMatchObject({ stopReason: null });
  });

  it("records a dependency check that fails as a fixed harness code and stops the wave", async () => {
    const s = await dependentWave(2);
    const { deps } = s.deps([text()], { prepareScope: async () => { throw new Error("dependency_lock_mismatch"); }, checkDependencies: async () => undefined });
    const result = await runWave({ ...s.input, depsDir: join(s.root, "deps") }, deps);
    expect(result.stopReason).toBe("harness_failure");
    expect(result.records.map((record) => [record.outcome, record.harnessError])).toEqual([["stopped", "dependency_lock_mismatch"], ["not_run", null]]);
  });
});

describe("approval", () => {
  it("rejects an approval whose bindings changed", async () => {
    const root = await temporaryRoot("ablation-approval-");
    const tasks = [await reviewTask(root, "A1")];
    const runs = buildMatrix(tasks, PAIRINGS);
    const approval = approvalFor(tasks, runs);
    const current = { sourceCommit: approval.sourceCommit, tasks, routes: approval.routes };
    expect(validateApproval(approval, current)).toEqual(approval);
    expect(() => validateApproval({ ...approval, tasksDigest: "sha256:0" }, current)).toThrow("approval_binding_changed");
    expect(() => validateApproval({ ...approval, matrixDigest: "sha256:0" }, current)).toThrow("approval_binding_changed");
    expect(() => validateApproval({ ...approval, sourceCommit: "d".repeat(40) }, current)).toThrow("approval_binding_changed");
    expect(() => validateApproval({ ...approval, routes: approval.routes.map((r) => ({ ...r, model: "other" })) }, current)).toThrow("approval_binding_changed");
    expect(() => validateApproval({ ...approval, approved: false }, current)).toThrow("approval_invalid");
    expect(() => validateApproval({ ...approval, budgetUsd: 11 }, current)).toThrow("approval_invalid");
    // R56: the approval's own run list is the list that runs; it must refer to known tasks, hold no duplicate and match its digest.
    const [first, ...rest] = approval.runs;
    expect(() => validateApproval({ ...approval, runs: [{ ...first!, taskId: "unknown" }, ...rest] }, current)).toThrow("approval_binding_changed");
    expect(() => validateApproval({ ...approval, runs: approval.runs.slice(0, 2) }, current)).toThrow("approval_binding_changed");
    expect(() => validateApproval({ ...approval, runs: [] }, current)).toThrow("approval_invalid");
    expect(() => validateApproval({ ...approval, ledgerId: "not-a-uuid" }, current)).toThrow("approval_invalid");
    const { ledgerId: _dropped, ...withoutLedger } = approval;
    expect(() => validateApproval(withoutLedger, current)).toThrow("approval_invalid");
  });

  it("makes runWave refuse a changed matrix before anything runs", async () => {
    const s = await waveSetup(2);
    const { deps, captured } = s.deps([]);
    // The approval's own list is the list that runs: a list that does not match its digest is refused.
    await expect(runWave({ ...s.input, approval: { ...s.input.approval, runs: s.runs.slice(0, 1) } }, deps)).rejects.toThrow("approval_binding_changed");
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

  it("forwards the telemetry and update-check opt-out to every MCP server and changes nothing else (R65)", () => {
    const profile = { ...PROFILE, mcpServers: {
      codegraph: CODEGRAPH_SERVER,
      other: { command: "/usr/bin/other", envFrom: { TOKEN: "HOST_TOKEN", DO_NOT_TRACK: "SOMETHING_ELSE" }, tools: { t: { name: "t", readOnly: true } } },
    } };
    const before = structuredClone(profile);
    const { executionProfiles } = runConfig("review", "A", profile, "/c", undefined, undefined) as { executionProfiles: { review: { mcpServers: Record<string, { envFrom: Record<string, string> }> } & Record<string, unknown> } };
    const { mcpServers, ...rest } = executionProfiles.review;
    expect(mcpServers.codegraph!.envFrom).toEqual(OPT_OUT);
    expect(mcpServers.other!.envFrom).toEqual({ TOKEN: "HOST_TOKEN", ...OPT_OUT });
    const { envFrom: _kept, ...otherRest } = mcpServers.other!;
    expect(otherRest).toEqual({ command: "/usr/bin/other", tools: { t: { name: "t", readOnly: true } } });
    expect(rest).toEqual({ ...PROFILE, default: true });
    expect(profile).toEqual(before);
    const code = runConfig("code", "A", { ...CODING, mcpServers: { codegraph: CODEGRAPH_SERVER } }, "/c", undefined, undefined) as { executionProfiles: Record<string, { mcpServers: Record<string, { envFrom: unknown }> }> };
    for (const entry of Object.values(code.executionProfiles)) expect(entry.mcpServers.codegraph!.envFrom).toEqual(OPT_OUT);
  });

  it("refuses an MCP server whose merged envFrom would exceed the product limit", () => {
    const envFrom = Object.fromEntries(Array.from({ length: 62 }, (_, i) => [`VAR_${i}`, `HOST_${i}`]));
    expect(() => runConfig("review", "A", { ...PROFILE, mcpServers: { codegraph: { ...CODEGRAPH_SERVER, envFrom } } }, "/c", undefined, undefined)).toThrow("mcp_env_from_overflow");
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
        productionProfile: { ...PROFILE, mcpServers: { codegraph: CODEGRAPH_SERVER } }, skillCatalog: productionConfig.skillCatalog, pairing: PAIRINGS.find((p) => p.id === "pl-review"), tools: await realTools(bin),
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
    const config = JSON.parse(await readFile(scope.configPath, "utf8")) as { workspaces: { clone: string }; executionProfiles: Record<string, { extensions?: string[]; mcpServers?: unknown }> };
    expect(config.workspaces.clone).toBe(scope.clone);
    // R65: the MCP child does not inherit the run environment, so the written configuration forwards the opt-out variables to it.
    expect(config.executionProfiles.review!.mcpServers).toEqual({ codegraph: { ...CODEGRAPH_SERVER, envFrom: OPT_OUT } });
    expect(config.executionProfiles.review!.extensions).toEqual(["npm:pi-lens@4.4.3"]);
    for (const key of ["HOME", "PI_CODING_AGENT_DIR", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "PI_LENS_HOME"]) {
      expect(scope.env[key]!.startsWith(scope.root + "/")).toBe(true);
    }
    expect(scope.env).toMatchObject({ PI_LENS_DISABLE_TOOL_INSTALL: "1", PI_LENS_DISABLE_LSP_INSTALL: "1", PI_CACHE_OPTIMIZER_NO_ZERO_PRICE_WARMING: "1", UV_USE_IO_URING: "0" });
    // R73: package managers fail fast offline, the same in every run and arm.
    expect(scope.env).toMatchObject({ GOPROXY: "off", GOTOOLCHAIN: "local", UV_OFFLINE: "1", UV_NO_SYNC: "1", UV_PYTHON_DOWNLOADS: "never", npm_config_offline: "true" });
    expect(scope.env).not.toHaveProperty("GOFLAGS");
    expect(scope.env).toMatchObject({ DO_NOT_TRACK: "1", CODEGRAPH_NO_UPDATE_CHECK: "1", CODEGRAPH_TELEMETRY: "0" });
  });

  it("never gives a run or the oracle the variables that point at a display server, a bus, an agent or the runtime directory (R88)", async () => {
    const names = ["DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "SSH_AUTH_SOCK", "XDG_RUNTIME_DIR"];
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    for (const name of names) process.env[name] = `host-${name}`;
    const root = await temporaryRoot("ablation-no-session-env-");
    const clone = join(root, "clone");
    await mkdir(clone);
    const git = (...args: string[]) => exec("git", ["-C", clone, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args]);
    await git("init", "--quiet");
    await writeFile(join(clone, "a.txt"), "base\n");
    await git("add", "a.txt"); await git("commit", "--quiet", "-m", "base");
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    try {
      const env = scopeEnv("/scope", { home: "/scope/home", agentDir: "/scope/agent" });
      for (const name of names) expect(env, name).not.toHaveProperty(name);
      expect(JSON.stringify(env)).not.toContain("host-");
      const score = await scoreImplementation(clone, {
        allowedPaths: ["env.txt"], scopeIgnore: [], baseCommit: base,
        oracle: { kind: "implementation", command: ["sh", "-c", "env > env.txt"], timeoutMs: 30_000 },
      }, { gitDir: join(clone, ".git"), home: join(root, "oracle-home") });
      expect(score.testsPassed).toBe(true);
    } finally {
      for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    }
    const seen = await readFile(join(clone, "env.txt"), "utf8");
    for (const name of names) expect(seen).not.toContain(`${name}=`);
    expect(seen).not.toContain("host-");
  });

  it("keeps the offline package-manager variables out of the oracle's own minimal environment (R73)", async () => {
    const root = await temporaryRoot("ablation-oracle-env-");
    const clone = join(root, "clone");
    await mkdir(clone);
    const git = (...args: string[]) => exec("git", ["-C", clone, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args]);
    await git("init", "--quiet");
    await writeFile(join(clone, "a.txt"), "base\n");
    await git("add", "a.txt"); await git("commit", "--quiet", "-m", "base");
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    const previous = { GOPROXY: process.env.GOPROXY, UV_OFFLINE: process.env.UV_OFFLINE };
    Object.assign(process.env, { GOPROXY: "host-value", UV_OFFLINE: "host-value" });
    try {
      const score = await scoreImplementation(clone, {
        allowedPaths: ["env.txt"], scopeIgnore: [], baseCommit: base,
        oracle: { kind: "implementation", command: ["sh", "-c", "env > env.txt"], timeoutMs: 30_000 },
      }, { gitDir: join(clone, ".git"), home: join(root, "oracle-home") });
      expect(score.testsPassed).toBe(true);
    } finally {
      for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    }
    const seen = (await readFile(join(clone, "env.txt"), "utf8")).split("\n").map((line) => line.split("=")[0]);
    for (const name of ["GOPROXY", "GOTOOLCHAIN", "GOFLAGS", "UV_OFFLINE", "UV_NO_SYNC", "UV_PYTHON_DOWNLOADS", "npm_config_offline"]) expect(seen).not.toContain(name);
    expect(seen).toEqual(expect.arrayContaining(["HOME", "TMPDIR", "CI"]));
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

/** R86: OAuth credentials are refreshed on the host before each route and run; the refresh is a fake seam, the real auth file is never touched. */
describe("host credential refresh (R86)", () => {
  const SECRET_REFRESH = "REFRESH-TOKEN-SECRET";
  const oauth = (access: string, expiresInMs: number) => ({ openai: { type: "oauth", access, refresh: SECRET_REFRESH, expires: Date.now() + expiresInMs } });

  /** A fake host: `refresh` is called with the provider, `fresh` replaces the stored auth at the n-th call (or the call fails). */
  function fakeHost(initial: unknown, behaviour: { fresh?: (n: number) => unknown; fail?: boolean } = {}) {
    const calls: string[] = [];
    let stored = initial;
    let reads = 0;
    const host: HostCredentials = {
      read: async () => { reads += 1; return stored; },
      refresh: async (provider) => {
        calls.push(provider);
        if (behaviour.fail) throw new Error(`refresh failed with ${SECRET_REFRESH}`);
        if (behaviour.fresh) stored = behaviour.fresh(calls.length);
      },
    };
    return { host, calls, reads: () => reads, stored: () => stored };
  }
  async function withStderr<T>(body: () => Promise<T>): Promise<{ result: T; stderr: string }> {
    let stderr = "";
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write);
    try { return { result: await body(), stderr }; } finally { spy.mockRestore(); }
  }
  /** The access token the scope was prepared with, per run. */
  const copied = (accesses: string[]): Partial<WaveDeps> => ({
    prepareScope: async (input) => {
      const entry = (input.hostAuth as { openai?: { access?: string } }).openai;
      accesses.push(entry?.access ?? "none");
      return fakePrepare(input);
    },
  });
  const everythingOnDisk = async (dir: string): Promise<string> => (await Promise.all((await findFiles(dir, /./)).map((file) => readFile(file, "utf8")))).join("\n");

  it("refreshes an OAuth provider once per run, reads the auth again and copies the re-read credential", async () => {
    const source = fakeHost(oauth("old-access", 3_600_000), { fresh: (n) => oauth(`fresh-access-${n}`, 3_600_000) });
    const s = await waveSetup(4, { hostAuth: oauth("old-access", 3_600_000), hostCredentials: source.host });
    const accesses: string[] = [];
    const { result, stderr } = await withStderr(() => runWave(s.input, s.deps(Array.from({ length: 4 }, () => text()), copied(accesses)).deps));
    expect(result.stopReason).toBeNull();
    expect(source.calls).toEqual(["openai", "openai", "openai", "openai"]);
    expect(source.reads()).toBe(4);
    expect(accesses).toEqual(["fresh-access-1", "fresh-access-2", "fresh-access-3", "fresh-access-4"]);
    expect(stderr).not.toContain("credential_refresh_failed");
    // Records keep the type of the credential only.
    expect(result.records.map((r) => r.authType)).toEqual(["oauth", "oauth", "oauth", "oauth"]);
    const disk = await everythingOnDisk(s.waveDir);
    for (const secret of [SECRET_REFRESH, "fresh-access", "old-access"]) { expect(disk).not.toContain(secret); expect(stderr).not.toContain(secret); }
  });

  it("never refreshes an API key", async () => {
    const source = fakeHost({ openai: { type: "api_key", key: "sk-api-key-secret" } });
    const s = await waveSetup(2, { hostAuth: { openai: { type: "api_key", key: "sk-api-key-secret" } }, hostCredentials: source.host });
    const { result } = await withStderr(() => runWave(s.input, s.deps([text(), text()]).deps));
    expect(result.stopReason).toBeNull();
    expect(source.calls).toEqual([]);
    expect(source.reads()).toBe(0);
    expect(result.records.map((r) => r.authType)).toEqual(["api_key", "api_key"]);
  });

  it("goes on after a failed refresh while the stored token is still valid, and leaves a secret-free event", async () => {
    const source = fakeHost(oauth("still-valid", 3_600_000), { fail: true });
    const s = await waveSetup(2, { hostAuth: oauth("still-valid", 3_600_000), hostCredentials: source.host });
    const accesses: string[] = [];
    const { result, stderr } = await withStderr(() => runWave(s.input, s.deps([text(), text()], copied(accesses)).deps));
    expect(result.stopReason).toBeNull();
    expect(accesses).toEqual(["still-valid", "still-valid"]);
    const events = stderr.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toEqual([
      { event: "credential_refresh_failed", provider: "openai", code: "refresh_failed" },
      { event: "credential_refresh_failed", provider: "openai", code: "refresh_failed" },
    ]);
    for (const secret of [SECRET_REFRESH, "still-valid"]) expect(stderr).not.toContain(secret);
  });

  it("stops with credential_expiring when the refresh fails and the token is too close to expiry", async () => {
    const source = fakeHost(oauth("about-to-expire", 5 * 60_000), { fail: true });
    const s = await waveSetup(3, { hostAuth: oauth("about-to-expire", 5 * 60_000), hostCredentials: source.host });
    const { result, stderr } = await withStderr(() => runWave(s.input, s.deps([text()]).deps));
    expect(result.stopReason).toBe("credential_expiring");
    expect(result.records.map((r) => r.outcome)).toEqual(["not_run", "not_run", "not_run"]);
    expect(source.calls).toEqual(["openai"]);
    expect(stderr).toContain("credential_refresh_failed");
    expect(stderr).not.toContain(SECRET_REFRESH);
    expect(await everythingOnDisk(s.waveDir)).not.toContain(SECRET_REFRESH);
  });

  it("runs when the refresh turns an expiring token into a valid one", async () => {
    const source = fakeHost(oauth("about-to-expire", 5 * 60_000), { fresh: () => oauth("renewed", 3_600_000) });
    const s = await waveSetup(2, { hostAuth: oauth("about-to-expire", 5 * 60_000), hostCredentials: source.host });
    const accesses: string[] = [];
    const { result } = await withStderr(() => runWave(s.input, s.deps([text(), text()], copied(accesses)).deps));
    expect(result.stopReason).toBeNull();
    expect(accesses).toEqual(["renewed", "renewed"]);
  });

  it("does not touch the credentials when no source is given", async () => {
    const s = await waveSetup(1, { hostAuth: oauth("as-given", 3_600_000) });
    const accesses: string[] = [];
    await withStderr(() => runWave(s.input, s.deps([text()], copied(accesses)).deps));
    expect(accesses).toEqual(["as-given"]);
  });

  it("refreshes before each OAuth route of the preflight and never for an API key route", async () => {
    const root = await temporaryRoot("ablation-preflight-refresh-");
    const tasks = [await reviewTask(root, "P1")];
    const runs = buildMatrix(tasks, PAIRINGS.filter((p) => p.id === "pl-review" || p.id === "pl-review-grok"));
    const approval = approvalFor(tasks, runs);
    await seedLedger(join(root, "ledger.json"));
    const expiring = { ...oauth("about-to-expire", 5 * 60_000), xai: { type: "api_key", key: "k" } };
    const source = fakeHost(expiring, { fresh: () => ({ ...oauth("renewed", 3_600_000), xai: { type: "api_key", key: "k" } }) });
    const { spawnRun } = fake([{ cost: 0.01, text: "PONG" }, { cost: 0.01, text: "PONG" }], root);
    const { result } = await withStderr(() => runPreflight({
      approval, waveDir: join(root, "wave"), ledgerPath: join(root, "ledger.json"), productionConfig, hostAuth: expiring, hostCredentials: source.host,
    }, { ...seams(), spawnRun: (scope, input) => spawnRun(scope, input, join(scope.root, "ignored.log")), residualCheck: async () => true }));
    expect(source.calls).toEqual(["openai"]);
    expect(result.routes.map((r) => [r.profile, r.ok, r.failure])).toEqual([["review", true, null], ["review-grok", true, null]]);
    // Without the refresh the same expiring token fails the route.
    const plain = await runPreflight({
      approval, waveDir: join(root, "wave-plain"), ledgerPath: join(root, "ledger.json"), productionConfig, hostAuth: expiring,
    }, { ...seams(), spawnRun: (scope, input) => spawnRun(scope, input, join(scope.root, "ignored.log")), residualCheck: async () => true });
    expect(plain.routes.find((r) => r.profile === "review")).toMatchObject({ ok: false, failure: "credential_expiring" });
  });

  /** A host whose reads fail as told: `failReads` is how many reads fail first, `Infinity` for all of them. */
  function flakyHost(stored: unknown, fresh: unknown | undefined, failReads: number, refreshFails = false) {
    let current = stored;
    let failed = 0;
    const signals: (AbortSignal | undefined)[] = [];
    const host: HostCredentials = {
      read: async () => { if (failed < failReads) { failed += 1; throw new SyntaxError(`unterminated ${SECRET_REFRESH}`); } return current; },
      refresh: async (_provider, signal) => { signals.push(signal); if (refreshFails) throw new Error(SECRET_REFRESH); if (fresh !== undefined) current = fresh; },
    };
    return { host, signals };
  }
  const eventsOf = (stderr: string) => stderr.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>);

  it("tries the re-read once more after a successful refresh and uses what it then reads", async () => {
    const { host } = flakyHost(oauth("old", 5 * 60_000), oauth("renewed", 3_600_000), 1);
    const s = await waveSetup(1, { hostAuth: oauth("old", 5 * 60_000), hostCredentials: host });
    const accesses: string[] = [];
    const { result, stderr } = await withStderr(() => runWave(s.input, s.deps([text()], copied(accesses)).deps));
    expect(result.stopReason).toBeNull();
    expect(accesses).toEqual(["renewed"]);
    expect(eventsOf(stderr)).toEqual([]);
  });

  it("stops as for an expiring credential when the auth stays unreadable after a successful refresh, even with a valid old token", async () => {
    const { host } = flakyHost(oauth("old", 3_600_000), oauth("renewed", 3_600_000), Infinity);
    const s = await waveSetup(2, { hostAuth: oauth("old", 3_600_000), hostCredentials: host });
    const { result, stderr } = await withStderr(() => runWave(s.input, s.deps([text()]).deps));
    expect(result.stopReason).toBe("credential_expiring");
    expect(result.records.map((r) => r.outcome)).toEqual(["not_run", "not_run"]);
    expect(eventsOf(stderr)).toEqual([{ event: "credential_refresh_failed", provider: "openai", code: "auth_unreadable" }]);
    expect(stderr).not.toContain(SECRET_REFRESH);
  });

  it("keeps the previous auth when the refresh failed and the file cannot be read either", async () => {
    const { host } = flakyHost(oauth("old", 3_600_000), undefined, Infinity, true);
    const s = await waveSetup(1, { hostAuth: oauth("old", 3_600_000), hostCredentials: host });
    const accesses: string[] = [];
    const { result, stderr } = await withStderr(() => runWave(s.input, s.deps([text()], copied(accesses)).deps));
    expect(result.stopReason).toBeNull();
    expect(accesses).toEqual(["old"]);
    expect(eventsOf(stderr).map((event) => event.code)).toEqual(["refresh_failed", "auth_unreadable"]);
    expect(stderr).not.toContain(SECRET_REFRESH);
  });

  it("reports a refresh that returned a token that expires too soon by its own code, and nothing of the message", async () => {
    const host: HostCredentials = { read: async () => oauth("short", 3_600_000), refresh: async () => { throw new HostCredentialError("refresh_too_short"); } };
    const s = await waveSetup(1, { hostAuth: oauth("short", 3_600_000), hostCredentials: host });
    const { result, stderr } = await withStderr(() => runWave(s.input, s.deps([text()]).deps));
    expect(result.stopReason).toBeNull();
    expect(eventsOf(stderr)).toEqual([{ event: "credential_refresh_failed", provider: "openai", code: "refresh_too_short" }]);
  });

  it("hands the abort signal of the wave and of the preflight to the refresh", async () => {
    const controller = new AbortController();
    const waveHost = flakyHost(oauth("old", 3_600_000), undefined, 0);
    const s = await waveSetup(1, { hostAuth: oauth("old", 3_600_000), hostCredentials: waveHost.host, signal: controller.signal });
    await withStderr(() => runWave(s.input, s.deps([text()]).deps));
    expect(waveHost.signals).toEqual([controller.signal]);
    const root = await temporaryRoot("ablation-preflight-signal-");
    const tasks = [await reviewTask(root, "P1")];
    const approval = approvalFor(tasks, buildMatrix(tasks, PAIRINGS.filter((p) => p.id === "pl-review")));
    await seedLedger(join(root, "ledger.json"));
    const preflightHost = flakyHost(oauth("old", 3_600_000), undefined, 0);
    const { spawnRun } = fake([{ cost: 0.01, text: "PONG" }], root);
    await withStderr(() => runPreflight({
      approval, waveDir: join(root, "wave"), ledgerPath: join(root, "ledger.json"), productionConfig, hostAuth: oauth("old", 3_600_000), hostCredentials: preflightHost.host, signal: controller.signal,
    }, { ...seams(), spawnRun: (scope, input) => spawnRun(scope, input, join(scope.root, "ignored.log")), residualCheck: async () => true }));
    expect(preflightHost.signals).toEqual([controller.signal]);
  });

  describe("the file credentials", () => {
    const authFile = async (expires: number) => {
      const root = await temporaryRoot("ablation-file-credentials-");
      const path = join(root, "auth.json");
      await writeFile(path, JSON.stringify({ openai: { type: "oauth", access: "a", refresh: "r", expires } }));
      return path;
    };

    it("does not keep a runtime whose creation was rejected, forwards the signal and the minimum validity", async () => {
      const path = await authFile(Date.now() + 3_600_000);
      let created = 0;
      const seen: unknown[] = [];
      const host = fileHostCredentials(path, async () => {
        created += 1;
        if (created === 1) throw new Error("sdk import failed");
        return { getAuth: async (_provider, overrides) => { seen.push(overrides); return undefined; } };
      });
      const controller = new AbortController();
      await expect(host.refresh("openai", controller.signal)).rejects.toMatchObject({ code: "refresh_failed" });
      await host.refresh("openai", controller.signal);
      await host.refresh("openai");
      expect(created).toBe(2);
      expect(seen).toEqual([{ minOAuthValidityMs: 30 * 60_000, signal: controller.signal }, { minOAuthValidityMs: 30 * 60_000 }]);
    });

    it("tells a refresh that returned a token which still expires too soon from other OAuth failures, by the stored expiry having moved", async () => {
      const path = await authFile(Date.now() + 60_000);
      const tooShort = fileHostCredentials(path, async () => ({
        getAuth: async () => {
          await writeFile(path, JSON.stringify({ openai: { type: "oauth", access: "b", refresh: "r2", expires: Date.now() + 120_000 } }));
          throw Object.assign(new Error("OAuth refresh returned a token that expires too soon"), { code: "oauth" });
        },
      }));
      await expect(tooShort.refresh("openai")).rejects.toMatchObject({ code: "refresh_too_short", message: "refresh_too_short" });
      const unchanged = fileHostCredentials(path, async () => ({ getAuth: async () => { throw Object.assign(new Error("endpoint down"), { code: "oauth" }); } }));
      await expect(unchanged.refresh("openai")).rejects.toMatchObject({ code: "refresh_failed", message: "refresh_failed" });
      const other = fileHostCredentials(path, async () => ({ getAuth: async () => { throw Object.assign(new Error("lock"), { code: "auth" }); } }));
      await expect(other.refresh("openai")).rejects.toMatchObject({ code: "refresh_failed" });
    });
  });

  it("refreshes a throwaway auth file through the Pi SDK without changing a valid credential, and reads it back", async () => {
    const root = await temporaryRoot("ablation-sdk-refresh-");
    const path = join(root, "auth.json");
    const content = { openai: { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 10 * 3_600_000 } };
    await writeFile(path, JSON.stringify(content));
    const host = fileHostCredentials(path);
    await host.refresh("openai");
    await host.refresh("provider-the-sdk-does-not-know");
    expect(await host.read()).toEqual(content);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(content);
  });
});

describe("preflight", () => {
  it("runs one PONG per route, records its cost and flags a route that did not complete", async () => {
    const root = await temporaryRoot("ablation-preflight-");
    const waveDir = join(root, "wave");
    const tasks = [await reviewTask(root, "P1")];
    const runs = buildMatrix(tasks, PAIRINGS.filter((p) => p.id === "pl-review" || p.id === "pl-review-grok"));
    const approval = approvalFor(tasks, runs);
    await seedLedger(join(root, "ledger.json"));
    const { spawnRun, captured } = fake([{ cost: 0.01, text: "PONG" }, { output: { terminal: "failed" }, providerError: "auth", cost: null }], root);
    const result = await runPreflight({
      approval, waveDir, ledgerPath: join(root, "ledger.json"), productionConfig,
      hostAuth: { openai: { type: "oauth", access: "a", refresh: "", expires: Date.now() + 3_600_000 }, xai: { type: "api_key", key: "k" } },
    }, { ...seams(), spawnRun: (scope, input) => spawnRun(scope, input, join(scope.root, "ignored.log")), residualCheck: async () => true });
    expect(captured.map((c) => c.input.promptText)).toEqual(["Reply with exactly: PONG", "Reply with exactly: PONG"]);
    expect(result.routes.map((r) => [r.profile, r.ok, r.failure])).toEqual([["review", true, null], ["review-grok", false, "auth"]]);
    expect(result.spentUsd).toBeCloseTo(0.01);
    const ledger = JSON.parse(await readFile(join(root, "ledger.json"), "utf8")) as { ledgerId: string; entries: { runId: string }[] };
    expect(ledger.entries.map((e) => e.runId)).toEqual(["preflight-review", "preflight-review-grok"]);
    expect(ledger.entries).toMatchObject([{ kind: "preflight", costUsd: 0.01 }, { kind: "preflight", costUsd: 0 }]);
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
    expect(parseArgs(["--plan", "--tasks", "t.json", "--trim", "--ledger", "l.json"])).toMatchObject({ mode: "--plan", trim: true, options: { "--ledger": "l.json" } });
    // R56: trimming and pairing selection belong to the plan; wave and preflight run the approval's list.
    const live = ["--approval", "a.json", "--tasks", "t.json", "--template", "x", "--out", "w", "--ledger", "l.json"];
    expect(() => parseArgs(["--wave", ...live, "--trim"])).toThrow("invalid_argument");
    expect(() => parseArgs(["--wave", ...live, "--pairings", "pl-code"])).toThrow("invalid_argument");
    expect(parseArgs(["--wave", ...live, "--max-runs", "2"])).toMatchObject({ mode: "--wave", maxRuns: 2, resume: false });
    expect(parseArgs(["--wave", ...live, "--resume"])).toMatchObject({ resume: true });
    for (const bad of ["0", "-1", "x", "1.5", "10000"]) expect(() => parseArgs(["--wave", ...live, "--max-runs", bad])).toThrow("invalid_argument");
    expect(() => parseArgs(["--preflight", ...live.filter((a) => a !== "--template" && a !== "x"), "--max-runs", "2"])).toThrow("invalid_argument");
    expect(() => parseArgs(["--preflight", ...live.filter((a) => a !== "--template" && a !== "x"), "--resume"])).toThrow("invalid_argument");
    expect(() => parseArgs(["--plan", "--tasks", "t.json", "--approval", "a.json"])).toThrow("invalid_argument");
    // `--report` takes --wave more than once.
    expect(parseArgs(["--report", "--wave", "w1", "--wave", "w2", "--ledger", "l.json", "--evidence", "e"]).waves).toEqual(["w1", "w2"]);
    expect(() => parseArgs(["--report", "--ledger", "l.json", "--evidence", "e"])).toThrow("wave_required");
    expect(() => parseArgs(["--report", "--wave", "w1", "--ledger", "l.json", "--ledger", "m.json", "--evidence", "e"])).toThrow("invalid_argument");
    expect(() => parseArgs(["--unknown-mode", "--tasks", "t.json"])).toThrow("mode_required");
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
      // Nothing was charged and no lock is left behind.
      expect(JSON.parse(await readFile(s.input.ledgerPath, "utf8")).entries).toEqual([]);
      expect(existsSync(`${s.input.ledgerPath}.lock`)).toBe(false);
    }
  });

  it("counts a preflight's spend in the wave through the shared ledger file", async () => {
    const root = await temporaryRoot("ablation-shared-ledger-");
    const ledgerPath = join(root, "evaluation-ledger.json");
    const tasks = [await reviewTask(root, "P1")];
    const runs = buildMatrix(tasks, PAIRINGS.filter((p) => p.id === "pl-review"));
    const approval = approvalFor(tasks, runs);
    await seedLedger(ledgerPath);
    const { spawnRun } = fake([{ cost: 9.6, text: "PONG" }], root);
    const hostAuth = { openai: { type: "oauth", access: "a", refresh: "", expires: Date.now() + 3_600_000 } };
    const pre = await runPreflight({ approval, waveDir: join(root, "pre"), ledgerPath, productionConfig, hostAuth }, {
      ...seams(), spawnRun: (scope, input) => spawnRun(scope, input, join(scope.root, "x.log")), residualCheck: async () => true,
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
    await expect(runPreflight({ approval, waveDir: join(root, "wave"), ledgerPath: join(root, "l.json"), productionConfig, hostAuth: {} }, seams())).rejects.toThrow("output_exists");
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
    // R55: a ledger file that is missing is refused, never silently created; one whose id differs from the approval's is a mismatch.
    await rm(ledgerPath);
    await expect(assertPreflightPassed(root, approval, ledgerPath)).rejects.toThrow("ledger_missing");
    await write({ binding, ledgerId: "33333333-3333-4333-8333-333333333333", routes: passed(true), spentUsd: 0 });
    await writeLedger("33333333-3333-4333-8333-333333333333", entries);
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
    // The records plus the wave's own bookkeeping (the approval it ran under, the guard baseline and how it ended).
    expect(files).toEqual([...s.runs.map((run) => `runs/${run.runId}.json`), "approval.json", "guard.json", "status.json"].sort());
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
      approval: approvalFor(tasks, runs), tasks, waveDir, ledgerPath: join(root, "ledger.json"), productionConfig,
      extensionTemplate: join(root, "t"), repoRoot: join(root, "repo"), hostAuth, killGraceMs: 0,
    };
    await seedLedger(input.ledgerPath);
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
    await seedLedger(join(root, "l.json"));
    const { spawnRun, captured } = fake([], root);
    const r = await runPreflight({ approval, waveDir: join(root, "w"), ledgerPath: join(root, "l.json"), productionConfig, hostAuth: { openai: { type: "api_key", key: "k" } } }, {
      ...seams(), spawnRun: (scope, input) => spawnRun(scope, input, "x"), checkRoute: async () => { throw new Error("provider_host_unresolvable"); },
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

  // A real-host test: it needs prlimit on the PATH and skips otherwise.
  it.skipIf(process.platform !== "linux" || !(process.env.PATH ?? "").split(":").some((dir) => dir.startsWith("/") && existsSync(join(dir, "prlimit"))))("sets a hard core limit of 0 with the flag the spawn uses", async () => {
    const { stdout } = await exec("prlimit", [CORE_LIMIT, "sh", "-c", "ulimit -Hc; ulimit -Sc"]);
    expect(stdout.trim().split("\n")).toEqual(["0", "0"]);
  }, 60_000);
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
    expect(await readVerifiedOutput(scope, priv, "r1", key)).toMatchObject({ tampered: false, text });
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
    await seedLedger(ledgerPath);
    const r = await runPreflight({ approval, waveDir: join(root, "w"), ledgerPath, productionConfig, hostAuth: { openai: { type: "api_key", key: "k" } } }, {
      ...seams(), spawnRun: (scope, input) => spawnRun(scope, input, join(scope.root, "x.log")), residualCheck: async () => { throw new Error("residual exploded"); },
    });
    expect(r.routes).toMatchObject([{ ok: false, failure: "preflight_step_failed" }]);
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as { entries: { runId: string; costUsd: number; estimated?: boolean }[] };
    expect(ledger.entries).toMatchObject([{ runId: "preflight-review", costUsd: 1, estimated: true, kind: "preflight" }]);
    expect(existsSync(scopeRoot(join(root, "w"), "preflight-review"))).toBe(false);
  });
});

describe("bubblewrap containment (R46)", () => {
  // The real-host test below needs bwrap, strace, prlimit and codegraph on the PATH and skips when any is missing.
  const onPath = (name: string): string => (process.env.PATH ?? "").split(":").filter((dir) => dir.startsWith("/")).map((dir) => join(dir, name)).find((path) => existsSync(path)) ?? "";
  // Linux with a bubblewrap that can create a user namespace; the self-test's DNS lookup also needs the network, so it is a real-host test.
  const hasBwrap = realHostWith("strace", "prlimit");
  const codegraphPath = onPath("codegraph");
  const hasCodegraph = codegraphPath !== "";

  const HOME = "/home/op";
  const plan: SandboxPlan = {
    rootLinks: [{ path: "/bin", target: "usr/bin" }, { path: "/lib", target: "usr/lib" }], rootReadOnly: ["/opt"],
    etcReadOnly: ["/etc/hosts", "/etc/ssl"], runReadOnly: ["/run/systemd/resolve"], home: HOME,
    homeReadOnly: [`${HOME}/repo/node_modules`, `${HOME}/.codegraph/v1/bin`], homeLinks: [{ path: `${HOME}/.local/bin/codegraph`, target: `${HOME}/.codegraph/v1/bin/codegraph` }],
    extraReadOnly: ["/tmp/build"],
  };

  it("builds the sandbox from an allowlist root: no bind of /, /run and the home hidden, needs bound back read-only, scope bind after the tmpfs mounts", () => {
    const args = bwrapArgs("/tmp/x/scope", plan, ["/tmp/x/oracle-home"]);
    const at = (flag: string, value: string) => args.findIndex((arg, i) => arg === flag && args[i + 1] === value);
    const bind = (flag: string, path: string) => args.findIndex((arg, i) => arg === flag && args[i + 1] === path && args[i + 2] === path);
    const link = (target: string, path: string) => args.findIndex((arg, i) => arg === "--symlink" && args[i + 1] === target && args[i + 2] === path);
    // R51: the host's root is never bound; the allowlist comes first, in order.
    expect(bind("--ro-bind", "/")).toBe(-1);
    expect(args.slice(0, 3)).toEqual(["--ro-bind", "/usr", "/usr"]);
    expect(link("usr/bin", "/bin")).toBeGreaterThan(bind("--ro-bind", "/usr"));
    expect(link("usr/lib", "/lib")).toBeGreaterThan(-1);
    expect(bind("--ro-bind", "/opt")).toBeGreaterThan(-1);
    const etc = at("--dir", "/etc");
    expect(etc).toBeGreaterThan(-1);
    expect(bind("--ro-bind", "/etc/hosts")).toBeGreaterThan(etc);
    expect(bind("--ro-bind", "/etc/ssl")).toBeGreaterThan(etc);
    expect(bind("--ro-bind", "/etc/hosts")).toBeLessThan(at("--tmpfs", "/tmp"));
    expect(at("--tmpfs", "/tmp")).toBeGreaterThan(-1);
    // /var holds nothing but an empty tmpfs /var/tmp, made inside a plain /var.
    expect(at("--dir", "/var")).toBeGreaterThan(-1);
    expect(at("--tmpfs", "/var/tmp")).toBeGreaterThan(at("--dir", "/var"));
    expect(args.some((arg, i) => arg === "--tmpfs" && args[i + 1] === "/var")).toBe(false);
    const bindScope = bind("--bind", "/tmp/x/scope");
    expect(bindScope).toBeGreaterThan(at("--tmpfs", "/tmp"));
    expect(bind("--bind", "/tmp/x/oracle-home")).toBeGreaterThan(bindScope);
    // R48: all of /run is a tmpfs; no dedicated /run/user or /run/dbus entry is left to forget a sibling socket.
    expect(at("--tmpfs", "/run")).toBeGreaterThan(-1);
    expect(args.some((arg, i) => arg === "--tmpfs" && (args[i + 1] === "/run/user" || args[i + 1] === "/run/dbus"))).toBe(false);
    expect(bind("--ro-bind", "/run/systemd/resolve")).toBeGreaterThan(at("--tmpfs", "/run"));
    // R49: the home is a tmpfs, the needs are bound back after it, the writable binds come next, then the home and the root are remounted read-only.
    const home = at("--tmpfs", HOME);
    expect(home).toBeGreaterThan(at("--tmpfs", "/run"));
    expect(bind("--ro-bind", `${HOME}/repo/node_modules`)).toBeGreaterThan(home);
    expect(bind("--ro-bind", `${HOME}/.codegraph/v1/bin`)).toBeGreaterThan(home);
    expect(link(`${HOME}/.codegraph/v1/bin/codegraph`, `${HOME}/.local/bin/codegraph`)).toBeGreaterThan(home);
    expect(bindScope).toBeGreaterThan(link(`${HOME}/.codegraph/v1/bin/codegraph`, `${HOME}/.local/bin/codegraph`));
    expect(bind("--ro-bind", "/tmp/build")).toBeGreaterThan(at("--tmpfs", "/tmp"));
    expect(at("--remount-ro", HOME)).toBeGreaterThan(bind("--bind", "/tmp/x/oracle-home"));
    expect(at("--remount-ro", "/")).toBeGreaterThan(at("--remount-ro", HOME));
    expect(args.filter((arg) => arg === "--bind")).toHaveLength(2);
    for (const flag of ["--dev", "--proc", "--die-with-parent", "--new-session", "--unshare-ipc", "--unshare-pid"]) expect(args).toContain(flag);
    expect(args).not.toContain("--share-net");
    expect(args).not.toContain("--unshare-net");
    expect(args.at(-1)).toBe("--");
    expect(sandboxed(TOOLS, plan, "/s", ["echo", "x"]).slice(0, 1)).toEqual([TOOLS.bwrap]);
    expect(sandboxed(TOOLS, plan, "/s", ["echo", "x"]).slice(-2)).toEqual(["echo", "x"]);
    // Without a home there is no home tmpfs and no home remount, but the root is still read-only; /var/run does not exist at all.
    const bare = bwrapArgs("/s", { ...EMPTY_PLAN });
    expect(bare).not.toContain("/var/run");
    expect(bare.filter((arg) => arg === "--remount-ro")).toHaveLength(1);
    expect(bare.slice(0, 3)).toEqual(["--ro-bind", "/usr", "/usr"]);
  });

  /** A host with a merged-usr root, a resolv.conf that is a plain file, and a user bundle of codegraph below the home. */
  const fakeHost = (over: Partial<PlanHost> & { present?: readonly string[]; realMap?: Record<string, string>; kinds?: Record<string, "link" | "dir" | "file"> } = {}): Partial<PlanHost> => {
    const present = new Set(over.present ?? ["/opt", ...ETC_ENTRIES.map((entry) => `/etc/${entry}`)]);
    const kinds = { "/bin": "link", "/lib": "link", "/lib64": "link", "/sbin": "link", "/etc/resolv.conf": "file", ...over.kinds };
    return {
      exists: async (path) => present.has(path),
      lstat: async (path) => {
        const kind = (kinds as Record<string, string | undefined>)[path];
        return kind === undefined ? null : { isSymbolicLink: () => kind === "link", isDirectory: () => kind === "dir" };
      },
      real: async (path) => over.realMap?.[path] ?? path,
      trackedSkills: async () => ["skills/a/SKILL.md", "skills/a/references/r.md", "skills/b/SKILL.md", "skills/loose.md"],
      ...(over.exists === undefined ? {} : { exists: over.exists }),
      ...(over.trackedSkills === undefined ? {} : { trackedSkills: over.trackedSkills }),
    };
  };
  const planOf = (input: Partial<Parameters<typeof planSandbox>[0]>, host: Partial<PlanHost>) =>
    planSandbox({ tools: { codegraph: "/usr/bin/codegraph" }, repoRoot: `${HOME}/repo`, buildRoot: "/tmp/build", home: HOME, nodePath: "/usr/bin/node", ...input }, host);

  it("plans the allowlist root: merged-usr links by lstat, /opt only when present, and the /etc entries that exist", async () => {
    const full = await planOf({}, fakeHost());
    expect(full.rootLinks).toEqual([{ path: "/bin", target: "usr/bin" }, { path: "/lib", target: "usr/lib" }, { path: "/lib64", target: "usr/lib" }, { path: "/sbin", target: "usr/bin" }]);
    expect(full.rootReadOnly).toEqual(["/opt"]);
    expect(full.etcReadOnly).toEqual(ETC_ENTRIES.map((entry) => `/etc/${entry}`));
    // The brief's list, once, in one place.
    expect([...ETC_ENTRIES]).toEqual([
      "resolv.conf", "hosts", "nsswitch.conf", "passwd", "group", "localtime", "ld.so.cache", "ld.so.conf", "ld.so.conf.d",
      "ssl", "ca-certificates", "pki", "os-release", "gitconfig", "mime.types", "protocols", "services",
    ]);
    // No /opt, no gitconfig/pki, a missing /lib64, and a real directory at /sbin (bound instead of linked).
    const sparse = await planOf({}, fakeHost({
      present: ["/etc/hosts", "/etc/resolv.conf", "/etc/ssl"], kinds: { "/lib64": undefined as never, "/sbin": "dir" },
    }));
    expect(sparse.etcReadOnly).toEqual(["/etc/resolv.conf", "/etc/hosts", "/etc/ssl"]);
    expect(sparse.rootReadOnly).toEqual(["/sbin"]);
    expect(sparse.rootLinks.map((link) => link.path)).toEqual(["/bin", "/lib"]);
  });

  it("brings a resolv.conf link's directory back only below /run, without repeating the systemd one", async () => {
    const link = { kinds: { "/etc/resolv.conf": "link" as const } };
    const nm = await planOf({}, fakeHost({ ...link, present: ["/run/systemd/resolve"], realMap: { "/etc/resolv.conf": "/run/NetworkManager/resolv.conf" } }));
    expect(nm.runReadOnly).toEqual(["/run/systemd/resolve", "/run/NetworkManager"]);
    const systemd = await planOf({}, fakeHost({ ...link, present: ["/run/systemd/resolve"], realMap: { "/etc/resolv.conf": "/run/systemd/resolve/stub-resolv.conf" } }));
    expect(systemd.runReadOnly).toEqual(["/run/systemd/resolve"]);
    const elsewhere = await planOf({}, fakeHost({ ...link, present: [], realMap: { "/etc/resolv.conf": "/var/lib/dns/resolv.conf" } }));
    expect(elsewhere.runReadOnly).toEqual([]);
  });

  it("binds back only what a run needs below the home: node_modules, tracked skills, codegraph's file and a bundle's bin, node and lib", async () => {
    const bundle = `${HOME}/.codegraph/versions/v1`;
    const planned = await planOf(
      { tools: { codegraph: `${HOME}/.local/bin/codegraph` } },
      fakeHost({ present: [`${bundle}/bin`, `${bundle}/node`, `${bundle}/lib`], realMap: { [`${HOME}/.local/bin/codegraph`]: `${bundle}/bin/codegraph` } }),
    );
    expect(planned.homeReadOnly).toEqual([
      `${HOME}/repo/node_modules`, `${HOME}/repo/skills/a`, `${HOME}/repo/skills/b`, `${HOME}/repo/skills/loose.md`, `${bundle}/bin`, `${bundle}/node`, `${bundle}/lib`,
    ]);
    // The link is recreated, so the launcher finds its bundle through it; neither ~/.local/bin nor the bundle root nor ~/.codegraph is bound.
    expect(planned.homeLinks).toEqual([{ path: `${HOME}/.local/bin/codegraph`, target: `${bundle}/bin/codegraph` }]);
    for (const wide of [`${HOME}/.local`, `${HOME}/.local/bin`, bundle, `${HOME}/.codegraph`, `${HOME}/repo`, `${HOME}/repo/skills`, HOME]) expect(planned.homeReadOnly).not.toContain(wide);
    expect(planned.extraReadOnly).toEqual(["/tmp/build"]);
    // A plain binary file directly below the home is bound as that file alone, never its directory.
    const plain = await planOf({ tools: { codegraph: `${HOME}/bin/codegraph` } }, fakeHost());
    expect(plain.homeReadOnly).toEqual([`${HOME}/repo/node_modules`, `${HOME}/repo/skills/a`, `${HOME}/repo/skills/b`, `${HOME}/repo/skills/loose.md`, `${HOME}/bin/codegraph`]);
    expect(plain.homeLinks).toEqual([]);
    // codegraph below /usr needs nothing.
    expect((await planOf({}, fakeHost())).homeReadOnly.some((path) => path.includes("codegraph"))).toBe(false);
  });

  it("binds the node binary's directory only when it is outside /usr and /opt", async () => {
    expect((await planOf({ nodePath: "/usr/bin/node" }, fakeHost())).extraReadOnly).toEqual(["/tmp/build"]);
    expect((await planOf({ nodePath: "/opt/node/bin/node" }, fakeHost())).extraReadOnly).toEqual(["/tmp/build"]);
    expect((await planOf({ nodePath: "/data/node/bin/node" }, fakeHost())).extraReadOnly).toEqual(["/tmp/build", "/data/node/bin"]);
    const inHome = await planOf({ nodePath: `${HOME}/.local/bin/node` }, fakeHost());
    expect(inHome.homeReadOnly).toContain(`${HOME}/.local/bin`);
    expect(inHome.extraReadOnly).toEqual(["/tmp/build"]);
  });

  it("lists the tracked skill directories through git, so an untracked session buffer stays hidden", async () => {
    const repo = await temporaryRoot("ablation-skills-");
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
    git("init", "-q");
    await mkdir(join(repo, "skills", "tracked", "references"), { recursive: true });
    await mkdir(join(repo, "skills", ".remember"), { recursive: true });
    await mkdir(join(repo, "node_modules"));
    await writeFile(join(repo, "skills", "tracked", "SKILL.md"), "x");
    await writeFile(join(repo, "skills", "tracked", "references", "r.md"), "x");
    await writeFile(join(repo, "skills", ".remember", "buffer.md"), "secret");
    git("add", "skills/tracked");
    const planned = await planSandbox({ tools: { codegraph: "/usr/bin/codegraph" }, repoRoot: repo, buildRoot: "/tmp/build", home: repo, nodePath: "/usr/bin/node" });
    const real = await (await import("node:fs/promises")).realpath(repo);
    expect(planned.homeReadOnly).toEqual([join(real, "node_modules"), join(real, "skills", "tracked")]);
    await expect(planSandbox({ tools: { codegraph: "/usr/bin/codegraph" }, repoRoot: join(repo, "missing"), buildRoot: "/tmp/build", home: repo })).rejects.toThrow("skills_listing_failed");
  });

  it("plans the real file system: the home with its needs, a bundle's bin and a link to the codegraph file", async () => {
    const root = await temporaryRoot("ablation-plan-");
    const home = join(root, "home");
    const repo = join(home, "repo");
    await mkdir(join(repo, "node_modules"), { recursive: true });
    await mkdir(join(repo, "skills", "a"), { recursive: true });
    const bundle = join(home, ".tools", "cg", "v1");
    await mkdir(join(bundle, "bin"), { recursive: true });
    await writeFile(join(bundle, "bin", "codegraph"), "#!/bin/sh\n");
    await mkdir(join(home, ".local", "bin"), { recursive: true });
    symlinkSync(join(bundle, "bin", "codegraph"), join(home, ".local", "bin", "codegraph"));
    await writeFile(join(home, ".local", "bin", "node"), "x");
    const planned = await planSandbox(
      { tools: { codegraph: join(home, ".local", "bin", "codegraph") }, repoRoot: repo, buildRoot: "/tmp/build", home, nodePath: join(home, ".local", "bin", "node") },
      { trackedSkills: async () => ["skills/a/SKILL.md"] },
    );
    const fsReal = (await import("node:fs/promises")).realpath;
    expect(planned.home).toBe(await fsReal(home));
    expect([...planned.homeReadOnly].sort()).toEqual([join(repo, "node_modules"), join(repo, "skills", "a"), join(home, ".local", "bin"), join(bundle, "bin")].sort());
    expect(planned.homeLinks).toEqual([{ path: join(home, ".local", "bin", "codegraph"), target: join(bundle, "bin", "codegraph") }]);
    expect(planned.homeReadOnly).not.toContain(join(home, ".local"));
    expect(planned.extraReadOnly).toEqual(["/tmp/build"]);
  });

  const SOCKETS = ["/run/user/1000/bus", "/run/dbus/system_bus_socket", "/run/systemd/private", "/run/systemd/journal/socket", "/run/docker.sock"];
  const good = {
    home: "EROFS", ssh: "ENOENT", entry: null, absent: Object.fromEntries(ABSENT_PATHS.map((p) => [p, "ENOENT"])), scope: true, oracleHome: true, tmp: true, dns: true, codegraph: true,
    sockets: Object.fromEntries(SOCKETS.map((p) => [p, "ENOENT"])),
  };
  /** A fake sandbox run: writes the strace log of a clean probe where `-o` says, then prints `result`. */
  const probe = (result: unknown, logText: (root: number) => string = () => `${benignTrace()}`) => async (_file: string, args: readonly string[]) => {
    const log = args[args.indexOf("-o") + 1]!;
    await writeFile(log, logText(4240));
    return { stdout: `noise\n${JSON.stringify(result)}\n`, stderr: "" };
  };
  const mutate = (patch: Record<string, unknown>): Record<string, unknown> => ({ ...good, ...patch });

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
    ["a provider host that does not resolve", mutate({ dns: false })],
    ["a missing DNS result", mutate({ dns: undefined })],
    ["a codegraph that does not run", mutate({ codegraph: "ENOENT" })],
    ["a codegraph that exits non-zero", mutate({ codegraph: "ERR_UNHANDLED" })],
    ["a missing absent-path result", mutate({ absent: {} })],
    ...ABSENT_PATHS.map((path): [string, Record<string, unknown>] => [`a visible ${path}`, mutate({ absent: { ...good.absent, [path]: true } })]),
    ["a host-home entry that is expected absent but reported present", mutate({ entry: true })],
  ])("refuses with containment_failed for %s", async (_name, result) => {
    await expect(containmentSelfTest(TOOLS, EMPTY_PLAN, { run: probe(result), home: "/home/x", uid: 1000 })).rejects.toThrow("containment_failed");
  });

  it("refuses when the probe's own strace log shows an outside write or is missing", async () => {
    const outside = (root: number) => `${benignTrace()}${root + 2} openat(AT_FDCWD</scope>, "/home/x/leak", O_WRONLY|O_CREAT, 0644) = 3</home/x/leak>\n`;
    await expect(containmentSelfTest(TOOLS, EMPTY_PLAN, { run: probe(good, outside), home: "/home/x", uid: 1000 })).rejects.toThrow("containment_failed");
    await expect(containmentSelfTest(TOOLS, EMPTY_PLAN, { run: async () => ({ stdout: JSON.stringify(good), stderr: "" }), home: "/home/x", uid: 1000 })).rejects.toThrow("containment_failed");
  });

  it("picks a real host-home entry that the plan does not bind back and requires it absent inside", async () => {
    const home = await temporaryRoot("ablation-home-");
    for (const name of [".hidden", "src", "Documents", "Music"]) await mkdir(join(home, name));
    const seen: string[][] = [];
    const run = async (file: string, args: readonly string[]) => { seen.push([file, ...args]); return probe({ ...good, entry: "ENOENT" })(file, args); };
    // "Documents" sorts first but holds a bind (the repository below it), and hidden entries are never picked.
    const bound = { ...EMPTY_PLAN, homeReadOnly: [join(home, "Documents", "repo", "node_modules")] };
    await containmentSelfTest(TOOLS, bound, { run, home, uid: 1000 });
    expect(seen[0]!.at(-2)).toBe("Music");
    // The entry being visible inside is a failure.
    await expect(containmentSelfTest(TOOLS, bound, { run: probe({ ...good, entry: true }), home, uid: 1000 })).rejects.toThrow("containment_failed");
    // Without a non-hidden free entry, .ssh is used when it exists; with none at all, nothing is expected.
    const sshHome = await temporaryRoot("ablation-home-ssh-");
    await mkdir(join(sshHome, ".ssh")); await mkdir(join(sshHome, ".config"));
    seen.length = 0;
    await containmentSelfTest(TOOLS, EMPTY_PLAN, { run, home: sshHome, uid: 1000 });
    expect(seen[0]!.at(-2)).toBe(".ssh");
    seen.length = 0;
    await containmentSelfTest(TOOLS, EMPTY_PLAN, { run: async (file, args) => { seen.push([file, ...args]); return probe(good)(file, args); }, home: "/home/x", uid: 1000 });
    expect(seen[0]!.at(-2)).toBe("");
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

  it("refuses when the probe's own log shows egress that cannot be audited, and accepts the name-resolution socket", async () => {
    const withTrace = (extra: string) => async (_file: string, args: readonly string[]) => {
      await writeFile(args[args.indexOf("-o") + 1]!, benignTrace() + extra);
      return { stdout: JSON.stringify(good), stderr: "" };
    };
    const resolver = { ...EMPTY_PLAN, runReadOnly: ["/run/systemd/resolve"] };
    await expect(containmentSelfTest(TOOLS, resolver, { run: withTrace('4242 connect(5<socket:[1]>, {sa_family=AF_UNIX, sun_path=@"x"}, 20) = 0\n'), home: "/home/x", uid: 1000 })).rejects.toThrow("containment_failed");
    await containmentSelfTest(TOOLS, resolver, { run: withTrace('4242 connect(5<socket:[1]>, {sa_family=AF_UNIX, sun_path="/run/systemd/resolve/io.systemd.Resolve"}, 42) = 0\n'), home: "/home/x", uid: 1000 });
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

  it.skipIf(!hasBwrap || !hasCodegraph)("really contains: the real self-test passes through the production shape; $HOME, host sockets, /mnt and the rest of the host root are sealed; /tmp is private; the scope may sit below /tmp or $HOME; the sandbox dies with its leader", async () => {
    const real = { bwrap: onPath("bwrap"), strace: onPath("strace"), prlimit: onPath("prlimit"), git: onPath("git"), codegraph: codegraphPath };
    const realPlan = await planSandbox({ tools: real, repoRoot: process.cwd(), buildRoot: BUILD_ROOT });
    await containmentSelfTest(real, realPlan);
    const run = (scope: string, script: string) => runHelper(real.bwrap, sandboxed(real, realPlan, scope, ["sh", "-c", script]).slice(1));
    // Below /tmp.
    const scope = await temporaryRoot("ablation-real-bwrap-");
    const marker = `.ablation-contain-${process.pid}`;
    await expect(run(scope, `echo x > "${homedir()}/${marker}"`)).rejects.toThrow();
    expect(existsSync(join(homedir(), marker))).toBe(false);
    await run(scope, `echo ok > "${scope}/inside" && test -d /run && test ! -e /run/docker.sock && test ! -e /run/dbus && test ! -e "${homedir()}/.ssh"`);
    // R51: nothing of the host root outside the allowlist exists, the root itself cannot be written, and the etc entries are the allowlisted ones.
    await run(scope, `${ABSENT_PATHS.map((path) => `test ! -e ${path}`).join(" && ")} && test ! -e /var/run && test ! -e /var/lib && ! (touch /root-probe) 2>/dev/null && test -e /etc/hosts && test ! -e /etc/shadow`);
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
  }, 60_000);
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
    await seedLedger(join(root, "l.json"));
    const result = await runPreflight({ approval, waveDir, ledgerPath: join(root, "l.json"), productionConfig, hostAuth: { openai: { type: "api_key", key: "k" } } }, {
      ...seams(), spawnRun: locking, residualCheck: async () => true,
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

describe("preflight spend and the cost of record (I2, I3)", () => {
  const entriesOf = async (path: string) => (JSON.parse(await readFile(path, "utf8")) as { entries: { runId: string; costUsd: number | null; estimated?: boolean; kind?: string }[] }).entries;

  it("keeps preflight costs out of the estimate: a later run without trusted output still charges the floor", async () => {
    const s = await waveSetup(2);
    const { spawnRun } = fake([{ cost: 0.01, text: "PONG" }], s.root);
    const pre = await runPreflight({ approval: s.input.approval, waveDir: join(s.root, "pre"), ledgerPath: s.input.ledgerPath, productionConfig, hostAuth: s.input.hostAuth }, {
      ...seams(), spawnRun: (scope, input) => spawnRun(scope, input, join(scope.root, "x.log")), residualCheck: async () => true,
    });
    expect(pre.routes.map((r) => r.ok)).toEqual([true]);
    // Before R54 this estimate would have been the PONG's USD 0.01.
    const r = await runWave(s.input, s.deps([text({ tamper: "cost" })]).deps);
    expect(r.stopReason).toBe("output_integrity");
    const entries = await entriesOf(s.input.ledgerPath);
    expect(entries[0]).toMatchObject({ runId: "preflight-review", costUsd: 0.01, kind: "preflight" });
    expect(entries[1]).toMatchObject({ runId: s.runs[0]!.runId, estimated: true });
    expect(entries[1]!.costUsd).toBeGreaterThanOrEqual(1);
    expect(r.spentUsd).toBeCloseTo(1.01);
  });

  it("replays a ledger with preflight entries to the same state", async () => {
    const path = join(await temporaryRoot("ablation-replay-"), "ledger.json");
    await seedLedger(path);
    const first = await PersistedLedger.openExisting(path, LEDGER_ID);
    await first.recordPreflight("preflight-review", "review", 0.4);
    await first.recordPreflight("preflight-code", "code", null);
    const second = await PersistedLedger.openExisting(path, LEDGER_ID);
    expect(second.ledger.spentUsd).toBeCloseTo(first.ledger.spentUsd);
    expect(second.ledger.estimate("review")).toBe(1);
    expect(second.ledger.estimate("code")).toBe(1);
    await second.record("001-t-review-A", "review", 0.2);
    expect((await PersistedLedger.openExisting(path)).ledger.estimate("review")).toBe(0.2);
  });

  it("charges the assistant usage sum, at least the estimate, when a trusted output has no session total but billed tokens", async () => {
    const s = await waveSetup(4);
    const none = { usage: { session: null, assistant: { messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }, providerError: null } };
    // A synthesized failure message: assistant messages, but not a single token, so nothing was billed (R11b).
    const synthesized = { usage: { session: null, assistant: { messages: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }, providerError: "other" } };
    const r = await runWave(s.input, s.deps([text({ cost: null, assistantCost: 1.5 }), text({ cost: null, assistantCost: 0.2 }), { text: GOOD_REVIEW, output: none }, { output: { terminal: "failed", ...synthesized } }]).deps);
    const entries = await entriesOf(s.input.ledgerPath);
    expect(entries[0]).toMatchObject({ runId: s.runs[0]!.runId, estimated: true, costUsd: 1.5 });
    expect(entries[1]).toMatchObject({ estimated: true });
    expect(entries[1]!.costUsd).toBeGreaterThanOrEqual(1);
    // Nothing billed at all (no session total, no assistant message): no cost of record.
    expect(entries[2]).toMatchObject({ runId: s.runs[2]!.runId, costUsd: null });
    expect(entries[2]!.estimated).toBeUndefined();
    // A zero-token failure message stays null as well and is not charged the estimate.
    expect(entries[3]).toMatchObject({ runId: s.runs[3]!.runId, costUsd: null });
    expect(entries[3]!.estimated).toBeUndefined();
    expect(r.records.map((x) => x.outcome)).toEqual(["scored", "scored", "scored", "scored"]);
  });

  it("fails a preflight route whose completed PONG has no session total (usage_missing)", async () => {
    const root = await temporaryRoot("ablation-usage-missing-");
    const tasks = [await reviewTask(join(root, "repo"), "P1")];
    const approval = approvalFor(tasks, buildMatrix(tasks, PAIRINGS.filter((p) => p.id === "pl-review")));
    await seedLedger(join(root, "l.json"));
    const { spawnRun } = fake([{ text: "PONG", cost: null, assistantCost: 0.07 }], root);
    const result = await runPreflight({ approval, waveDir: join(root, "w"), ledgerPath: join(root, "l.json"), productionConfig, hostAuth: { openai: { type: "api_key", key: "k" } } }, {
      ...seams(), spawnRun: (scope, input) => spawnRun(scope, input, join(scope.root, "x.log")), residualCheck: async () => true,
    });
    expect(result.routes).toMatchObject([{ profile: "review", ok: false, terminal: "completed", failure: "usage_missing" }]);
    // The assistant cost is still spend.
    expect(await entriesOf(join(root, "l.json"))).toMatchObject([{ kind: "preflight", costUsd: 0.07 }]);
    await expect(assertPreflightPassed(join(root, "w"), approval, join(root, "l.json"))).rejects.toThrow("preflight_failed");
  });
});

describe("one ledger across re-approvals (R55)", () => {
  it("refuses a missing ledger file and a ledger with another id, in the wave and in the preflight", async () => {
    const s = await waveSetup(1);
    await rm(s.input.ledgerPath);
    const { deps, captured } = s.deps([text()]);
    await expect(runWave(s.input, deps)).rejects.toThrow("ledger_missing");
    expect(existsSync(s.input.ledgerPath)).toBe(false);
    expect(captured).toHaveLength(0);
    await seedLedger(s.input.ledgerPath, [], "44444444-4444-4444-8444-444444444444");
    await expect(runWave(s.input, deps)).rejects.toThrow("ledger_mismatch");
    expect(existsSync(`${s.input.ledgerPath}.lock`)).toBe(false);
    await expect(runPreflight({ approval: s.input.approval, waveDir: join(s.root, "pre"), ledgerPath: s.input.ledgerPath, productionConfig, hostAuth: {} }, seams())).rejects.toThrow("ledger_mismatch");
    await rm(s.input.ledgerPath);
    await expect(runPreflight({ approval: s.input.approval, waveDir: join(s.root, "pre"), ledgerPath: s.input.ledgerPath, productionConfig, hostAuth: {} }, seams())).rejects.toThrow("ledger_missing");
    expect(existsSync(s.input.ledgerPath)).toBe(false);
  });

  it("lets only the plan create the ledger and records its id in the approval template", async () => {
    const root = await temporaryRoot("ablation-plan-ledger-");
    const repo = join(root, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) => exec("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args]);
    await git("init", "--quiet");
    await writeFile(join(repo, "a.txt"), "x");
    await git("add", "."); await git("commit", "--quiet", "-m", "base");
    const head = (await git("rev-parse", "HEAD")).stdout.trim();
    const tasks = [await reviewTask(join(root, "elsewhere"), "R1"), await implTask(join(root, "elsewhere"), "I1")];
    await writeFile(join(root, "tasks.json"), JSON.stringify(tasks));
    await writeFile(join(root, "config.json"), JSON.stringify(productionConfig));
    const ledgerPath = join(root, "new", "ledger.json");
    const args = ["--plan", "--tasks", join(root, "tasks.json"), "--config", join(root, "config.json"), "--ledger", ledgerPath];
    const first = await buildPlan(parseArgs(args), { sourceCwd: repo }) as { approvalTemplate: { ledgerId: string; runs: unknown[]; sourceCommit: string; matrixDigest: string } };
    expect(first.approvalTemplate.sourceCommit).toBe(head);
    expect(first.approvalTemplate.ledgerId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.approvalTemplate.runs.length).toBeGreaterThan(0);
    expect(JSON.parse(await readFile(ledgerPath, "utf8")).ledgerId).toBe(first.approvalTemplate.ledgerId);
    // A second plan against the same file reuses its id; without --ledger the template carries no id and cannot be approved.
    const again = await buildPlan(parseArgs(args), { sourceCwd: repo }) as typeof first;
    expect(again.approvalTemplate.ledgerId).toBe(first.approvalTemplate.ledgerId);
    const bare = await buildPlan(parseArgs(args.slice(0, -2)), { sourceCwd: repo }) as { approvalTemplate: { ledgerId: unknown; approved: boolean } };
    expect(bare.approvalTemplate).toMatchObject({ ledgerId: null, approved: false });
    // --trim puts the trimmed list into the template.
    const trimmed = await buildPlan(parseArgs([...args, "--trim"]), { sourceCwd: repo }) as typeof first;
    expect(trimmed.approvalTemplate.runs.length).toBeLessThanOrEqual(first.approvalTemplate.runs.length);
  });
});

describe("calibration, pause and resume (R56)", () => {
  it("pauses after --max-runs executed runs without a stop reason or not_run records, and writes status.json", async () => {
    const s = await waveSetup(4);
    const { deps, captured } = s.deps([text(), text(), text(), text()]);
    const r = await runWave({ ...s.input, maxRuns: 2 }, deps);
    expect(r.paused).toBe(true);
    expect(r.stopReason).toBeNull();
    expect(r.records.map((x) => x.outcome)).toEqual(["scored", "scored"]);
    expect(captured).toHaveLength(2);
    expect((await readdir(join(s.waveDir, "runs"))).sort()).toEqual(s.runs.slice(0, 2).map((x) => `${x.runId}.json`).sort());
    expect(JSON.parse(await readFile(join(s.waveDir, "status.json"), "utf8"))).toMatchObject({ state: "paused", stopReason: null, executedRuns: 2, recordedRuns: 2 });
    expect(existsSync(`${s.input.ledgerPath}.lock`)).toBe(false);
  });

  it("does not pause when --max-runs covers every run", async () => {
    const s = await waveSetup(2);
    const r = await runWave({ ...s.input, maxRuns: 2 }, s.deps([text(), text()]).deps);
    expect(r.paused).toBe(false);
    expect(JSON.parse(await readFile(join(s.waveDir, "status.json"), "utf8"))).toMatchObject({ state: "complete" });
  });

  it("resumes a paused wave with the runs that have no record yet, under the same approval and ledger", async () => {
    const s = await waveSetup(4);
    await runWave({ ...s.input, maxRuns: 2 }, s.deps([text(), text()]).deps);
    const approvalBefore = await readFile(join(s.waveDir, "approval.json"), "utf8");
    const resumed = s.deps([text(), text()]);
    const r = await runWave({ ...s.input, resume: true }, resumed.deps);
    expect(r.paused).toBe(false);
    expect(r.stopReason).toBeNull();
    expect(r.records.map((x) => x.runId)).toEqual(s.runs.slice(2).map((x) => x.runId));
    expect(resumed.captured).toHaveLength(2);
    expect((await readdir(join(s.waveDir, "runs"))).sort()).toEqual(s.runs.map((x) => `${x.runId}.json`).sort());
    expect(await readFile(join(s.waveDir, "approval.json"), "utf8")).toBe(approvalBefore);
    expect(JSON.parse(await readFile(join(s.waveDir, "status.json"), "utf8"))).toMatchObject({ state: "complete", recordedRuns: 4 });
    const ledger = await entriesOfLedger(s.input.ledgerPath);
    expect(ledger.map((e) => e.runId)).toEqual(s.runs.map((x) => x.runId));
  });

  it("resumes a paused wave repeatedly and honours --max-runs again", async () => {
    const s = await waveSetup(3);
    await runWave({ ...s.input, maxRuns: 1 }, s.deps([text()]).deps);
    const second = await runWave({ ...s.input, resume: true, maxRuns: 1 }, s.deps([text()]).deps);
    expect(second.paused).toBe(true);
    const third = await runWave({ ...s.input, resume: true }, s.deps([text()]).deps);
    expect(third.paused).toBe(false);
    expect((await readdir(join(s.waveDir, "runs"))).length).toBe(3);
  });

  it("refuses to resume a stopped wave, a complete one, a missing one and a different approval", async () => {
    const stopped = await waveSetup(3);
    const outside = `${benignTrace()}4242 openat(AT_FDCWD</scope>, "/home/u/x", O_WRONLY|O_CREAT, 0644) = 3</home/u/x>\n`;
    const first = await runWave(stopped.input, stopped.deps([text({ trace: outside })]).deps);
    expect(first.stopReason).toBe("outside_write");
    expect(JSON.parse(await readFile(join(stopped.waveDir, "status.json"), "utf8"))).toMatchObject({ state: "stopped", stopReason: "outside_write" });
    await expect(runWave({ ...stopped.input, resume: true }, stopped.deps([text()]).deps)).rejects.toThrow("wave_stopped");

    const complete = await waveSetup(1);
    await runWave(complete.input, complete.deps([text()]).deps);
    await expect(runWave({ ...complete.input, resume: true }, complete.deps([text()]).deps)).rejects.toThrow("wave_complete");

    const missing = await waveSetup(1);
    await expect(runWave({ ...missing.input, resume: true }, missing.deps([text()]).deps)).rejects.toThrow("resume_invalid");

    const paused = await waveSetup(3);
    await runWave({ ...paused.input, maxRuns: 1 }, paused.deps([text()]).deps);
    const other = { ...paused.input.approval, approvedAt: "2026-10-21T00:00:00Z" };
    const mismatched = paused.deps([text()]);
    await expect(runWave({ ...paused.input, approval: other, resume: true }, mismatched.deps)).rejects.toThrow("resume_approval_mismatch");
    expect(mismatched.captured).toHaveLength(0);
    // Without --resume an existing wave directory is refused, even a paused one.
    await expect(runWave(paused.input, paused.deps([text()]).deps)).rejects.toThrow("output_exists");
  });

  it("applies the same guard on resume: a guarded file that changed while the wave was paused stops it before the next run", async () => {
    const s = await waveSetup(3);
    let value = "h1";
    const guard = async () => ({ files: { ".pi/agent/settings.json": value } });
    await runWave({ ...s.input, maxRuns: 1 }, { ...s.deps([text()]).deps, guard });
    value = "h2";
    const resumed = s.deps([text()], { guard });
    const r = await runWave({ ...s.input, resume: true }, resumed.deps);
    expect(r.stopReason).toBe("guard_changed");
    expect(resumed.captured).toHaveLength(0);
    expect(r.records.map((x) => x.outcome)).toEqual(["not_run", "not_run"]);
  });

  it("refuses leftovers of a crashed run on resume and still checks the shared ledger", async () => {
    const s = await waveSetup(3);
    await runWave({ ...s.input, maxRuns: 1 }, s.deps([text()]).deps);
    mkdirSync(privateRunDir(s.waveDir, s.runs[1]!.runId), { recursive: true });
    await expect(runWave({ ...s.input, resume: true }, s.deps([text()]).deps)).rejects.toThrow("output_exists");
    await rm(privateRunDir(s.waveDir, s.runs[1]!.runId), { recursive: true });
    await rm(s.input.ledgerPath);
    await expect(runWave({ ...s.input, resume: true }, s.deps([text()]).deps)).rejects.toThrow("ledger_missing");
  });

  it("writes the approval the wave ran under", async () => {
    const s = await waveSetup(1);
    await runWave(s.input, s.deps([text()]).deps);
    expect(JSON.parse(await readFile(join(s.waveDir, "approval.json"), "utf8"))).toEqual(JSON.parse(JSON.stringify(s.input.approval)));
  });
});

async function entriesOfLedger(path: string) {
  return (JSON.parse(await readFile(path, "utf8")) as { entries: { runId: string }[] }).entries;
}

describe("records: auth type and capped connects", () => {
  it("records the credential type of the run's provider, also for runs that did not run", async () => {
    const s = await waveSetup(2, { hostAuth: { openai: { type: "oauth", access: "a", refresh: "", expires: Date.now() + 3_600_000 } } });
    const r = await runWave({ ...s.input, maxRuns: 1 }, s.deps([text()]).deps);
    expect(r.records[0]!.authType).toBe("oauth");
    const keyed = await waveSetup(1, { hostAuth: { openai: { type: "api_key", key: "k" } } });
    expect((await runWave(keyed.input, keyed.deps([text()]).deps)).records[0]!.authType).toBe("api_key");
    const expiring = await waveSetup(1, { hostAuth: { openai: { type: "oauth", access: "a", refresh: "", expires: Date.now() + 60_000 } } });
    const notRun = (await runWave(expiring.input, expiring.deps([]).deps)).records[0]!;
    expect(notRun).toMatchObject({ outcome: "not_run", authType: "oauth" });
    const unknown = await waveSetup(1, { hostAuth: {} });
    expect((await runWave(unknown.input, unknown.deps([text()]).deps)).records[0]!.authType).toBeNull();
  });

  it("keeps at most 50 evidence entries when traces are merged, the run's own lines first", () => {
    const trace = (prefix: string, count: number) => ({
      outsideWrites: [], unresolvedWrites: 0, deniedWriteAttempts: 0, unexpectedConnects: [], connects: 0, unresolvedEgress: 0,
      evidenceLines: Array.from({ length: count }, (_, i) => `${prefix}${i}`),
    });
    const merged = mergeTrace(trace("run-", 30), trace("oracle-", 30));
    expect(merged.evidenceLines).toHaveLength(50);
    expect(merged.evidenceLines.slice(0, 30)).toEqual(trace("run-", 30).evidenceLines);
    expect(merged.evidenceLines[30]).toBe("oracle-0");
    expect(merged.evidenceLines.at(-1)).toBe("oracle-19");
    expect(summarizeTrace(merged)).not.toHaveProperty("evidenceLines");
  });

  it("caps the unexpected connects in a record and keeps their number", () => {
    const connects = Array.from({ length: 25 }, (_, i) => ({ family: "inet" as const, address: `203.0.113.${i}`, port: 443 }));
    const summary = summarizeTrace({ outsideWrites: [], unresolvedWrites: 0, deniedWriteAttempts: 0, unexpectedConnects: connects, connects: 25, unresolvedEgress: 0, evidenceLines: [] });
    expect(summary.unexpectedConnects).toHaveLength(MAX_UNEXPECTED_CONNECTS);
    expect(MAX_UNEXPECTED_CONNECTS).toBe(20);
    expect(summary.unexpectedConnectCount).toBe(25);
    expect(summary.unexpectedConnects[0]).toEqual(connects[0]);
  });
});

describe("ledger lock and save order (item 11)", () => {
  it("takes an exclusive lock, refuses a second holder and a stale lock, and releases", async () => {
    const root = await temporaryRoot("ablation-ledger-lock-");
    const path = join(root, "ledger.json");
    await seedLedger(path);
    const first = await PersistedLedger.openExisting(path);
    await first.lock();
    expect(existsSync(`${path}.lock`)).toBe(true);
    const second = await PersistedLedger.openExisting(path);
    await expect(second.lock()).rejects.toThrow("ledger_locked");
    await first.release();
    expect(existsSync(`${path}.lock`)).toBe(false);
    await second.lock();
    await second.release();
    await second.release();
    // A stale lock (a crashed process) stays until the operator removes it; the wave refuses without touching anything.
    await writeFile(`${path}.lock`, "");
    const s = await waveSetup(1);
    await writeFile(`${s.input.ledgerPath}.lock`, "");
    const { deps, captured } = s.deps([text()]);
    await expect(runWave(s.input, deps)).rejects.toThrow("ledger_locked");
    expect(captured).toHaveLength(0);
    expect(existsSync(`${s.input.ledgerPath}.lock`)).toBe(true);
  });

  it("releases the lock when the wave fails and when the preflight finishes", async () => {
    const s = await waveSetup(1);
    const { deps } = s.deps([text()], { resolveAddresses: async () => { throw new Error("provider_host_unresolvable"); } });
    await expect(runWave(s.input, deps)).rejects.toThrow("provider_host_unresolvable");
    expect(existsSync(`${s.input.ledgerPath}.lock`)).toBe(false);
    const { spawnRun } = fake([{ cost: 0.01, text: "PONG" }], s.root);
    await runPreflight({ approval: s.input.approval, waveDir: join(s.root, "pre"), ledgerPath: s.input.ledgerPath, productionConfig, hostAuth: s.input.hostAuth }, {
      ...seams(), spawnRun: (scope, input) => spawnRun(scope, input, join(scope.root, "x.log")), residualCheck: async () => true,
    });
    expect(existsSync(`${s.input.ledgerPath}.lock`)).toBe(false);
  });

  it("saves before it updates the in-memory state, so a failed save changes neither", async () => {
    const root = await temporaryRoot("ablation-ledger-order-");
    const dir = join(root, "ro");
    const path = join(dir, "ledger.json");
    await seedLedger(path);
    const ledger = await PersistedLedger.openExisting(path);
    await ledger.record("001-a-review-A", "review", 0.25);
    chmodSync(dir, 0o500);
    try {
      await expect(ledger.record("002-a-review-A", "review", 0.5)).rejects.toThrow();
      expect(ledger.ledger.spentUsd).toBeCloseTo(0.25);
      expect(ledger.hasEntry("002-a-review-A")).toBe(false);
    } finally { chmodSync(dir, 0o700); }
    await ledger.record("002-a-review-A", "review", 0.5);
    expect(ledger.ledger.spentUsd).toBeCloseTo(0.75);
    // A cost the ledger would reject leaves no entry either.
    await expect(ledger.record("003-a-review-A", "review", -1)).rejects.toThrow("invalid_cost");
    expect(ledger.hasEntry("003-a-review-A")).toBe(false);
  });
});

describe("oracle deadline and abort (item 10)", () => {
  it("caps the oracle timeout at ten minutes in the task schema", async () => {
    const root = await temporaryRoot("ablation-oracle-cap-");
    const task = await implTask(root, "C1");
    expect(taskSpecSchema.safeParse(task).success).toBe(true);
    expect(taskSpecSchema.safeParse({ ...task, oracle: { ...task.oracle, timeoutMs: 600_000 } }).success).toBe(true);
    expect(taskSpecSchema.safeParse({ ...task, oracle: { ...task.oracle, timeoutMs: 600_001 } }).success).toBe(false);
  });

  it("passes the wave's signal to the oracle and stops as interrupted when it fires during scoring", async () => {
    const s = await waveSetup(2, { kind: "implementation" });
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const aborting: WaveDeps["scoreImplementation"] = async (_clone, _task, options) => {
      seen = options.signal;
      controller.abort();
      return { accepted: false, testsPassed: false, outOfScope: [] };
    };
    const { deps } = s.deps([text(), text()], { scoreImplementation: aborting });
    const r = await runWave({ ...s.input, signal: controller.signal }, deps);
    expect(seen).toBe(controller.signal);
    expect(r.stopReason).toBe("interrupted");
    expect(r.records.map((x) => x.outcome)).toEqual(["stopped", "not_run"]);
  });

  it("kills a running oracle command when the signal fires, without waiting for its deadline", async () => {
    const root = await temporaryRoot("ablation-oracle-abort-");
    const source = join(root, "source");
    mkdirSync(source);
    const git = (...args: string[]) => exec("git", ["-C", source, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args]);
    await git("init", "--quiet");
    await writeFile(join(source, "a.txt"), "base");
    await git("add", "."); await git("commit", "--quiet", "-m", "base");
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    const bare = join(root, "base.git");
    await exec("git", ["clone", "--bare", "--quiet", source, bare]);
    const clone = join(root, "clone");
    await exec("git", ["clone", "--quiet", bare, clone]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const started = Date.now();
    const result = await scoreImplementation(clone, {
      allowedPaths: [], scopeIgnore: [], baseCommit: base, oracle: { kind: "implementation", command: ["sleep", "30"], timeoutMs: 120_000 },
    }, { gitDir: bare, signal: controller.signal });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.testsPassed).toBe(false);
  });
});

describe("explicit exit of the run unit (item 12)", () => {
  it("ends run-one and the dry-load entry with an explicit process.exit once the output is written", async () => {
    for (const file of ["run-one.ts", "dry-load-entry.ts"]) {
      const source = await readFile(join(process.cwd(), "eval", "extensions", file), "utf8");
      const tail = source.slice(source.lastIndexOf("isEntryPoint(import.meta.url"));
      expect(tail).toMatch(/process\.exit\(code\)/);
      expect(tail).not.toMatch(/process\.exitCode\s*=/);
    }
  });
});

describe("end to end: wave output into the evidence (item 14)", () => {
  it("feeds real runWave records, ledger and approval into writeEvidence", async () => {
    const root = await temporaryRoot("ablation-e2e-");
    const repo = join(root, "bound-repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "src", "a.ts"), "export const a = 1;\n");
    const git = (...args: string[]) => exec("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args]);
    await git("init", "--quiet");
    await git("add", "."); await git("commit", "--quiet", "-m", "base");
    const head = (await git("rev-parse", "HEAD")).stdout.trim();

    const s = await waveSetup(6, { sourceCommit: head });
    // Three tasks, both arms: arm B finds the race that arm A misses on the first task.
    const steps = [text({ cost: 0.05 }), text({ cost: 0.07 }), text({ cost: 0.05 }), text({ cost: 0.06 }), text({ cost: 0.05 }), text({ cost: 0.08 })];
    const r = await runWave(s.input, s.deps(steps).deps);
    expect(r.stopReason).toBeNull();
    expect(r.records.every((x) => x.outcome === "scored")).toBe(true);

    const evidenceDir = join(root, "evidence");
    const summary = await writeEvidence([s.waveDir], evidenceDir, s.input.ledgerPath, { repoRoot: repo });
    const copied = (await readdir(join(evidenceDir, "runs"))).sort();
    expect(copied).toEqual(s.runs.map((x) => `${x.runId}.json`).sort());
    for (const name of copied) expect(await readFile(join(evidenceDir, "runs", name), "utf8")).toBe(await readFile(join(s.waveDir, "runs", name), "utf8"));
    expect(await readFile(join(evidenceDir, "approvals", "approval-1.json"), "utf8")).toBe(await readFile(join(s.waveDir, "approval.json"), "utf8"));
    expect(await readFile(join(evidenceDir, "ledger.json"), "utf8")).toBe(await readFile(s.input.ledgerPath, "utf8"));
    const integrity = JSON.parse(await readFile(join(evidenceDir, "integrity.json"), "utf8")) as { source_binding: { commit: string }; files: { path: string }[] };
    expect(integrity.source_binding.commit).toBe(head);
    expect(integrity.files.map((f) => f.path)).toEqual(expect.arrayContaining(["summary.json", "ledger.json", "approvals/approval-1.json"]));
    const pairingResult = summary.pairings.find((p) => p.id === "pl-review")!;
    expect(pairingResult).toMatchObject({ complete: true });
    expect(pairingResult.tasks).toHaveLength(3);
    // R78/R83: the review scores of the real records reach the summary as description; a review pairing has no recommendation.
    expect(pairingResult).toMatchObject({ kind: "review", recommendation: "descriptive" });
    for (const arm of [pairingResult.a, pairingResult.b]) {
      expect(arm).toMatchObject({ scored: 3, reviewScored: 3, verdictMatched: 3, criticalHitSum: 3, criticalTotalSum: 3, falseFindingRuns: 0, oracleAccepted: 3 });
      expect(arm).not.toHaveProperty("accepted");
    }
    expect(summary.spentUsd).toBeCloseTo(0.36);
    expect(summary.stopReason).toBeNull();
    for (const file of await findFiles(evidenceDir, /./)) {
      const body = await readFile(file, "utf8");
      expect(body).not.toContain(root);
      expect(body).not.toContain("sk-");
    }
  });
});

describe("source binding of approvals (I6a) and the real home (item 8)", () => {
  it("refuses untracked files under a bound path, but not elsewhere", async () => {
    const root = await temporaryRoot("ablation-source-bound-");
    const git = (...args: string[]) => exec("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args]);
    await git("init", "--quiet");
    await writeFile(join(root, "a.txt"), "1");
    await git("add", "."); await git("commit", "--quiet", "-m", "one");
    const head = (await git("rev-parse", "HEAD")).stdout.trim();
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "note.md"), "x");
    await writeFile(join(root, "untracked.txt"), "x");
    expect(await sourceCommit(root)).toBe(head);
    for (const path of ["eval/extensions/new.ts", "src/new.ts", "test/new.test.ts", "scripts/new.mjs", "package.json", "tsconfig.extra.json"]) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), "x");
      await expect(sourceCommit(root)).rejects.toThrow("source_dirty");
      await rm(join(root, path));
    }
    expect(await sourceCommit(root)).toBe(head);
    expect(sourceIsDirty("?? docs/x\0")).toBe(false);
    expect(sourceIsDirty("?? eval/extensions/x.ts\0")).toBe(true);
    expect(sourceIsDirty(" M docs/x\0")).toBe(true);
    expect(sourceIsDirty("!! eval/extensions/ignored.ts\0")).toBe(false);
    expect(dirtyBoundPaths("R  eval/extensions/b.ts\0docs/old.md\0?? docs/y\0")).toEqual(["eval/extensions/b.ts"]);
  });

  it("takes the guarded home from the account database, not from $HOME", () => {
    const previous = process.env.HOME;
    process.env.HOME = "/nonexistent-home-for-test";
    try { expect(realHome()).toBe(userInfo().homedir); expect(realHome()).not.toBe("/nonexistent-home-for-test"); } finally { process.env.HOME = previous; }
  });
});

/** The real route of the operator: `--plan` to approval, a (calibration) wave, re-plan with `--exclude-wave`, a new approval, a report over both waves. */
describe("canonical run ids, exclusion and the two-wave report (R58-R60)", () => {
  async function flow() {
    const root = await temporaryRoot("ablation-flow-");
    const repo = join(root, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) => exec("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args]);
    await git("init", "--quiet");
    await writeFile(join(repo, "a.txt"), "x");
    await git("add", "."); await git("commit", "--quiet", "-m", "base");
    const sources = join(root, "elsewhere");
    const tasks = await Promise.all(["R1", "R2", "R3"].map((id) => reviewTask(sources, id)));
    const tasksFile = join(root, "tasks.json");
    const configFile = join(root, "config.json");
    const ledgerPath = join(root, "ledger", "ledger.json");
    await writeFile(tasksFile, JSON.stringify(tasks));
    await writeFile(configFile, JSON.stringify(productionConfig));
    type Plan = { exclusion?: { waves: { wave: string; executed: number }[]; ledgerOnly: number; removed: number; resumable: string | null };
      matrix: { count: number; projectedUsd: number; runs: { runId: string; ordinal: number; taskId: string; profile: string; arm: string; pairings: string[] }[] };
      trimmed: { remainingUsd: number }; approvalTemplate: Record<string, unknown> & { runs: RunSpec[] } };
    const plan = async (...extra: string[]): Promise<Plan> =>
      await buildPlan(parseArgs(["--plan", "--tasks", tasksFile, "--config", configFile, "--ledger", ledgerPath, ...extra]), { sourceCwd: repo }) as unknown as Plan;
    const approve = (p: Plan): Approval => ({ ...p.approvalTemplate, approved: true, approvedAt: "2026-10-21T00:00:00Z" }) as unknown as Approval;
    const hostAuth = { openai: { type: "oauth", access: "a", refresh: "", expires: Date.now() + 3_600_000 }, xai: { type: "api_key", key: "k" } };
    const wave = (approval: Approval, name: string, steps: Step[], extra: Partial<WaveInput> = {}) => {
      const { spawnRun, captured } = fake(steps, root);
      const waveDir = join(root, name);
      return { waveDir, captured, run: () => runWave({ approval, tasks, waveDir, ledgerPath, productionConfig, hostAuth, extensionTemplate: join(root, "template"), repoRoot: sources, killGraceMs: 0, ...extra }, { ...baseDeps(), spawnRun }) };
    };
    const report = (dirs: string[], evidence = "evidence") => writeEvidence(dirs, join(root, evidence), ledgerPath, { repoRoot: repo });
    return { root, repo, tasks, tasksFile, ledgerPath, plan, approve, wave, report, git };
  }

  it("keeps the full matrix's run ids, ordinals and order in a --pairings and a --trim plan", async () => {
    const f = await flow();
    const full = await f.plan();
    expect(full.matrix.count).toBe(15);
    expect(full.matrix.runs.map((r) => r.ordinal)).toEqual(full.matrix.runs.map((_, i) => i + 1));
    const byId = new Map(full.matrix.runs.map((r) => [r.runId, r]));
    const subset = await f.plan("--pairings", "pl-review");
    expect(subset.matrix.count).toBe(6);
    expect(subset.matrix.runs.map((r) => r.ordinal)).not.toEqual(subset.matrix.runs.map((_, i) => i + 1));
    const trimmed = await f.plan("--trim");
    expect(trimmed.matrix.count).toBeLessThan(15);
    for (const plan of [subset, trimmed]) {
      for (const run of plan.matrix.runs) expect({ ...run, pairings: 0 }).toEqual({ ...byId.get(run.runId)!, pairings: 0 });
      expect(plan.matrix.runs.map((r) => r.ordinal)).toEqual(plan.matrix.runs.map((r) => r.ordinal).sort((a, b) => a - b));
      expect(plan.approvalTemplate.runs.map((r) => r.runId)).toEqual(plan.matrix.runs.map((r) => r.runId));
    }
    // The pairings of a run stay the subset that selected it in this plan.
    expect(subset.matrix.runs.find((r) => r.arm === "A")!.pairings).toEqual(["pl-review"]);
    expect(byId.get(subset.matrix.runs.find((r) => r.arm === "A")!.runId)!.pairings).toEqual(["pl-review", "co-review"]);
    // The canonical runs are valid approval content (R62b).
    expect(() => validateApproval(f.approve(subset), { sourceCommit: f.approve(subset).sourceCommit, tasks: f.tasks })).not.toThrow();
  });

  it("excludes the calibration runs, reports resumable when the list is unchanged, and resumes under the same approval", async () => {
    const f = await flow();
    const approval1 = f.approve(await f.plan());
    const w1 = f.wave(approval1, "wave-1", [text({ cost: 0.1 }), text({ cost: 0.1 })], { maxRuns: 2 });
    expect((await w1.run()).paused).toBe(true);
    const again = await f.plan("--trim", "--exclude-wave", w1.waveDir);
    expect(again.exclusion).toEqual({ waves: [{ wave: "wave-1", executed: 2 }], ledgerOnly: 0, removed: 2, resumable: "wave-1", replannedStopped: [], notReplanned: [] });
    expect(JSON.stringify(again.exclusion)).not.toContain(f.root);
    expect(again.matrix.runs.map((r) => r.runId)).toEqual(approval1.runs.slice(2).map((r) => r.runId));
    expect(again.matrix.count).toBe(13);
    // The projection covers the 13 runs that remain: 4 observed grok runs at USD 0.1 and 9 unobserved review runs at the USD 1 floor.
    expect(again.matrix.projectedUsd).toBeCloseTo(0.4 + 9);
    expect(again.trimmed.remainingUsd).toBeCloseTo(9.8);
    const w1again = f.wave(approval1, "wave-1", Array.from({ length: 13 }, () => text({ cost: 0.1 })), { resume: true });
    const resumed = await w1again.run();
    expect(resumed.paused).toBe(false);
    expect(resumed.records).toHaveLength(13);
    expect((await readdir(join(w1.waveDir, "runs"))).length).toBe(15);
  });

  it("re-plans after calibration with a forced trim: no resume, a new approval, a fresh wave and one report over both", async () => {
    const f = await flow();
    const full = await f.plan();
    const approval1 = f.approve(full);
    const w1 = f.wave(approval1, "wave-1", [text({ cost: 0.5 }), text({ cost: 0.5 })], { maxRuns: 2 });
    await w1.run();
    const again = await f.plan("--trim", "--exclude-wave", w1.waveDir);
    expect(again.exclusion).toMatchObject({ removed: 2, resumable: null });
    expect(again.matrix.count).toBe(10);
    expect(again.matrix.runs.every((r) => !approval1.runs.slice(0, 2).some((x) => x.runId === r.runId))).toBe(true);
    // Only the runs that remain are projected: 4 grok runs at USD 0.5 and 6 review runs at the USD 1 floor.
    expect(again.matrix.projectedUsd).toBeCloseTo(2 + 6);
    expect(again.trimmed.remainingUsd).toBeCloseTo(9);
    const approval2 = f.approve(again);
    expect(approval2.runs[0]!.runId).toBe(full.matrix.runs[2]!.runId);
    const w2 = f.wave(approval2, "wave-2", Array.from({ length: 10 }, () => text({ cost: 0.05 })));
    const second = await w2.run();
    expect(second.stopReason).toBeNull();
    expect(w2.captured).toHaveLength(10);
    const summary = await f.report([w1.waveDir, w2.waveDir]);
    const copied = (await readdir(join(f.root, "evidence", "runs"))).sort();
    expect(copied).toHaveLength(12);
    expect(new Set(copied).size).toBe(12);
    expect((await readdir(join(f.root, "evidence", "approvals"))).sort()).toEqual(["approval-1.json", "approval-2.json"]);
    expect(summary.pairings.find((p) => p.id === "pl-review-grok")).toMatchObject({ complete: true, tasks: ["R1", "R2", "R3"] });
    expect(summary.pairings.find((p) => p.id === "pl-review")).toMatchObject({ complete: true, tasks: ["R1", "R2", "R3"] });
    expect(summary.pairings.find((p) => p.id === "co-review")).toMatchObject({ kind: "review", recommendation: "descriptive", tasks: [] });
    // Wave 1 alone is reported with only its own spend.
    expect(summary.waveSpend.observedUsd).toBeCloseTo(1 + 10 * 0.05);
    expect(summary.budgetSpend.observedUsd).toBeCloseTo(1 + 10 * 0.05);
  });

  it("includes the not_run slots of a stopped wave, lets wave 2 execute some, and the report lets executed records replace not_run", async () => {
    const f = await flow();
    const full = await f.plan();
    const approval1 = f.approve(full);
    // A stop that is not an audit stop: the first run left no strace log.
    const w1 = f.wave(approval1, "wave-1", [text({ trace: null })]);
    expect((await w1.run()).stopReason).toBe("harness_failure");
    expect(existsSync(join(w1.waveDir, "diagnostics"))).toBe(false);
    const again = await f.plan("--exclude-wave", w1.waveDir);
    expect(again.exclusion).toEqual({ waves: [{ wave: "wave-1", executed: 1 }], ledgerOnly: 0, removed: 1, resumable: null, replannedStopped: [], notReplanned: [] });
    expect(again.matrix.runs.map((r) => r.runId)).toEqual(approval1.runs.slice(1).map((r) => r.runId));
    const approval2 = f.approve(again);
    const w2 = f.wave(approval2, "wave-2", [text(), text(), text()], { maxRuns: 3 });
    expect((await w2.run()).paused).toBe(true);
    const summary = await f.report([w1.waveDir, w2.waveDir]);
    const files = (await readdir(join(f.root, "evidence", "runs"))).sort();
    expect(files).toEqual(approval1.runs.map((r) => `${r.runId}.json`).sort());
    const outcome = async (dir: string, run: RunSpec) => (JSON.parse(await readFile(join(dir, "runs", `${run.runId}.json`), "utf8")) as RunRecord).outcome;
    for (const run of approval1.runs.slice(1, 4)) {
      expect(await outcome(w1.waveDir, run)).toBe("not_run");
      expect(await readFile(join(f.root, "evidence", "runs", `${run.runId}.json`), "utf8")).toBe(await readFile(join(w2.waveDir, "runs", `${run.runId}.json`), "utf8"));
    }
    for (const run of approval1.runs.slice(4)) expect(await outcome(join(f.root, "evidence"), run)).toBe("not_run");
    expect(summary.stopReason).toBe("harness_failure");
  });

  describe("a slot stopped by the trace audit (R84, R85)", () => {
    const outside = `${benignTrace()}4242 openat(AT_FDCWD</scope>, "/home/u/x", O_WRONLY|O_CREAT, 0644) = 3</home/u/x>\n`;

    it("keeps the causing log lines privately on the stop, and only then", async () => {
      const f = await flow();
      const approval1 = f.approve(await f.plan());
      const w1 = f.wave(approval1, "wave-1", [text({ trace: outside })]);
      expect((await w1.run()).stopReason).toBe("outside_write");
      const runId = approval1.runs[0]!.runId;
      expect(await readdir(join(w1.waveDir, "diagnostics"))).toEqual([`${runId}.txt`]);
      const kept = await readFile(join(w1.waveDir, "diagnostics", `${runId}.txt`), "utf8");
      expect(kept).toContain('openat(AT_FDCWD</scope>, "/home/u/x"');
      expect(kept.split("\n").every((line) => line.length <= 1000)).toBe(true);
      expect((await stat(join(w1.waveDir, "diagnostics", `${runId}.txt`))).mode & 0o777).toBe(0o600);
      // The record has no trace lines, and the private run directory is gone as before.
      const record = await readFile(join(w1.waveDir, "runs", `${runId}.json`), "utf8");
      expect(record).not.toContain("/home/u/x");
      expect(JSON.parse(record)).toMatchObject({ stopReason: "outside_write", trace: { outsideWrites: 1 } });
      expect(existsSync(privateRunDir(w1.waveDir, runId))).toBe(false);
      // The report never reads or copies diagnostics/.
      await f.report([w1.waveDir]);
      expect(await findFiles(join(f.root, "evidence"), /./)).not.toEqual(expect.arrayContaining([expect.stringContaining("diagnostics")]));
      for (const file of await findFiles(join(f.root, "evidence"), /./)) expect(await readFile(file, "utf8")).not.toContain("/home/u/x");
    });

    it("keeps lines of an oracle trace that stops the run, and cuts a long line", async () => {
      const s = await waveSetup(1, { kind: "implementation" });
      const long = `4242 openat(AT_FDCWD</scope/clone>, "/home/u/${"y".repeat(1500)}", O_WRONLY|O_CREAT, 0644) = 3</home/u/y>\n`;
      const tracing: WaveDeps["scoreImplementation"] = async (_clone, _task, options) => {
        const argv = options.wrap!(["npm", "test"]);
        await writeFile(argv[argv.indexOf("-o") + 1]!, prelude(9000) + long.replace("4242", "9000"));
        return { accepted: true, testsPassed: true, outOfScope: [] };
      };
      const r = await runWave(s.input, s.deps([text()], { scoreImplementation: tracing }).deps);
      expect(r.stopReason).toBe("outside_write");
      const kept = await readFile(join(s.waveDir, "diagnostics", `${r.records[0]!.runId}.txt`), "utf8");
      expect(kept).toContain("/home/u/yyy");
      expect(Math.max(...kept.split("\n").map((line) => line.length))).toBe(1000);
    });

    it("plans the slot again, lets exactly it run despite its charge, and the report lets the later record replace the stop", async () => {
      const f = await flow();
      const full = await f.plan();
      const approval1 = f.approve(full);
      const w1 = f.wave(approval1, "wave-1", [text({ trace: outside })]);
      expect((await w1.run()).stopReason).toBe("outside_write");
      const first = approval1.runs[0]!.runId;
      const again = await f.plan("--exclude-wave", w1.waveDir);
      expect(again.exclusion).toEqual({ waves: [{ wave: "wave-1", executed: 1 }], ledgerOnly: 0, removed: 0, resumable: null, replannedStopped: [first], notReplanned: [] });
      expect(again.matrix.runs.map((r) => r.runId)).toEqual(approval1.runs.map((r) => r.runId));
      expect(again.approvalTemplate.replannedStopped).toEqual([{ runId: first, charges: 1 }]);
      // The charge stays in the ledger and in the remaining budget.
      expect(again.trimmed.remainingUsd).toBeCloseTo(9.9);
      const approval2 = f.approve(again);
      // Without the list in the approval the guard refuses a charged run id; with it, only that id may run again.
      const { replannedStopped: _list, ...unlisted } = approval2;
      const refused = f.wave(unlisted as Approval, "wave-refused", [text()], { maxRuns: 1 });
      await expect(refused.run()).rejects.toThrow("run_already_charged");
      expect(refused.captured).toHaveLength(0);
      const w2 = f.wave(approval2, "wave-2", [text({ cost: 0.05 }), text({ cost: 0.05 })], { maxRuns: 2 });
      expect((await w2.run()).paused).toBe(true);
      expect(w2.captured).toHaveLength(2);
      const charges = (JSON.parse(await readFile(f.ledgerPath, "utf8")) as { entries: { runId: string }[] }).entries.filter((entry) => entry.runId === first);
      expect(charges).toHaveLength(2);
      // The stale approval is not a licence for another run id that was charged: a third wave naming no list refuses the first run again.
      const stale = f.wave({ ...approval2, replannedStopped: [] }, "wave-stale", [text()], { maxRuns: 1 });
      await expect(stale.run()).rejects.toThrow("run_already_charged");

      const summary = await f.report([w1.waveDir, w2.waveDir]);
      const evidence = join(f.root, "evidence", "runs");
      expect(await readFile(join(evidence, `${first}.json`), "utf8")).toBe(await readFile(join(w2.waveDir, "runs", `${first}.json`), "utf8"));
      expect(JSON.parse(await readFile(join(evidence, `${first}.json`), "utf8"))).toMatchObject({ outcome: "scored", stopReason: null });
      expect(summary.waveStops).toEqual([{ wave: 1, runId: first, stopReason: "outside_write" }]);
      // Two executed records of one slot still refuse.
      const copy = join(f.root, "wave-2-copy");
      await cp(w2.waveDir, copy, { recursive: true });
      await expect(f.report([w1.waveDir, w2.waveDir, copy], "evidence-duplicate")).rejects.toThrow("duplicate_run_record");
    });

    it("scenario A: a wave left out of --exclude-wave that already re-ran the slot keeps it excluded, and the old approval is refused", async () => {
      const f = await flow();
      const approval1 = f.approve(await f.plan());
      const first = approval1.runs[0]!.runId;
      const w1 = f.wave(approval1, "wave-1", [text({ trace: outside })]);
      await w1.run();
      const approval2 = f.approve(await f.plan("--exclude-wave", w1.waveDir));
      expect(approval2.replannedStopped).toEqual([{ runId: first, charges: 1 }]);
      const w2 = f.wave(approval2, "wave-2", [text({ trace: outside })]);
      expect((await w2.run()).stopReason).toBe("outside_write");
      // Wave 2 charged the slot again and was stopped by the audit as well. Leaving it out of the plan must not plan the slot a third time.
      const omitted = await f.plan("--exclude-wave", w1.waveDir);
      expect(omitted.exclusion).toMatchObject({ replannedStopped: [], notReplanned: [{ runId: first, reason: "ledger_charges_differ_from_records" }] });
      expect(omitted.matrix.runs.map((r) => r.runId)).not.toContain(first);
      expect(omitted.approvalTemplate.replannedStopped).toBeUndefined();
      // The approval written before wave 2 lists one charge, the ledger holds two: the guard refuses, up front.
      const stale = f.wave(approval2, "wave-stale", [text()], { maxRuns: 1 });
      await expect(stale.run()).rejects.toThrow("run_already_charged");
      expect(stale.captured).toHaveLength(0);
      // With both waves excluded the two charges match the two audit-stopped records, and the slot is planned with the count 2.
      const both = await f.plan("--exclude-wave", w1.waveDir, "--exclude-wave", w2.waveDir);
      expect(both.exclusion).toMatchObject({ replannedStopped: [first], notReplanned: [] });
      expect(both.approvalTemplate.replannedStopped).toEqual([{ runId: first, charges: 2 }]);
      const w3 = f.wave(f.approve(both), "wave-3", [text()], { maxRuns: 1 });
      expect((await w3.run()).paused).toBe(true);
      expect(w3.captured).toHaveLength(1);
    });

    it("scenario B: a charge without a record (a crash after the charge) keeps the slot excluded and the approval refused", async () => {
      const f = await flow();
      const approval1 = f.approve(await f.plan());
      const first = approval1.runs[0]!.runId;
      const w1 = f.wave(approval1, "wave-1", [text({ trace: outside })]);
      await w1.run();
      const approval2 = f.approve(await f.plan("--exclude-wave", w1.waveDir));
      expect(approval2.replannedStopped).toEqual([{ runId: first, charges: 1 }]);
      // The crash: the slot was run again and charged, and no record was written.
      const ledger = await PersistedLedger.openExisting(f.ledgerPath);
      await ledger.record(first, approval1.runs[0]!.profile, 0.1);
      const replanned = await f.plan("--exclude-wave", w1.waveDir);
      expect(replanned.exclusion).toMatchObject({ replannedStopped: [], notReplanned: [{ runId: first, reason: "ledger_charges_differ_from_records" }] });
      expect(replanned.matrix.runs.map((r) => r.runId)).not.toContain(first);
      const refused = f.wave(approval2, "wave-2", [text()], { maxRuns: 1 });
      await expect(refused.run()).rejects.toThrow("run_already_charged");
      expect(refused.captured).toHaveLength(0);
    });

    it("reports the same merge whatever the order of the waves", async () => {
      const f = await flow();
      const approval1 = f.approve(await f.plan());
      const first = approval1.runs[0]!.runId;
      const w1 = f.wave(approval1, "wave-1", [text({ trace: outside })]);
      await w1.run();
      const w2 = f.wave(f.approve(await f.plan("--exclude-wave", w1.waveDir)), "wave-2", [text(), text()], { maxRuns: 2 });
      await w2.run();
      const later = await readFile(join(w2.waveDir, "runs", `${first}.json`), "utf8");
      for (const [name, order] of [["evidence-a", [w1.waveDir, w2.waveDir]], ["evidence-b", [w2.waveDir, w1.waveDir]]] as const) {
        const summary = await f.report([...order], name);
        expect(await readFile(join(f.root, name, "runs", `${first}.json`), "utf8")).toBe(later);
        expect(summary.waveStops).toEqual([{ wave: order.indexOf(w1.waveDir) + 1, runId: first, stopReason: "outside_write" }]);
        expect(summary.stopReason).toBeNull();
      }
    });

    it("leaves a structured, path-free event on stderr when the diagnostics cannot be written, and the stop stands (R84)", async () => {
      const f = await flow();
      const approval1 = f.approve(await f.plan());
      const runId = approval1.runs[0]!.runId;
      const events: string[] = [];
      const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => { events.push(String(chunk)); return true; }) as typeof process.stderr.write);
      try {
        // The file is already there (`wx`).
        const existing = f.wave(approval1, "wave-exists", [text({ trace: outside })]);
        await mkdir(join(existing.waveDir, "diagnostics"), { recursive: true });
        await writeFile(join(existing.waveDir, "diagnostics", `${runId}.txt`), "earlier");
        expect((await existing.run()).stopReason).toBe("outside_write");
        // `diagnostics` is a link: nothing is written through it.
        const g = await flow();
        const linked = g.wave(g.approve(await g.plan()), "wave-linked", [text({ trace: outside })]);
        const elsewhere = join(g.root, "elsewhere-diagnostics");
        await mkdir(elsewhere);
        await mkdir(linked.waveDir, { recursive: true });
        await symlink(elsewhere, join(linked.waveDir, "diagnostics"));
        expect((await linked.run()).stopReason).toBe("outside_write");
        expect(await readdir(elsewhere)).toEqual([]);
      } finally { spy.mockRestore(); }
      const failures = events.filter((line) => line.includes("diagnostics_write_failed")).map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(failures).toEqual([{ event: "diagnostics_write_failed", runId, code: "eexist" }, { event: "diagnostics_write_failed", runId, code: "diagnostics_dir_invalid" }]);
      expect(JSON.stringify(failures)).not.toMatch(/\/tmp\//);
    });

    it("plans a slot again only when every executed record is an audit stop, and validates the list in an approval", async () => {
      const f = await flow();
      const approval1 = f.approve(await f.plan());
      const w1 = f.wave(approval1, "wave-1", [text({ trace: outside })]);
      await w1.run();
      const second = f.approve(await f.plan("--exclude-wave", w1.waveDir));
      const w2 = f.wave(second, "wave-2", [text()], { maxRuns: 1 });
      await w2.run();
      // The slot now has a scored record in wave 2: excluding both waves leaves it out for good, excluding only wave 1 plans it again.
      const both = await f.plan("--exclude-wave", w1.waveDir, "--exclude-wave", w2.waveDir);
      expect(both.exclusion).toMatchObject({ removed: 1, replannedStopped: [], notReplanned: [] });
      expect(both.matrix.runs.map((r) => r.runId)).not.toContain(approval1.runs[0]!.runId);
      expect((await f.plan("--exclude-wave", w1.waveDir)).exclusion).toMatchObject({ replannedStopped: [], notReplanned: [{ runId: approval1.runs[0]!.runId, reason: "ledger_charges_differ_from_records" }] });
      // An approval may only name run ids of its own list, once each.
      const tasks = f.tasks;
      const entry = (runId: string) => ({ runId, charges: 1 });
      expect(() => validateApproval({ ...second, replannedStopped: [entry("999-nope-review-A")] }, { sourceCommit: second.sourceCommit, tasks })).toThrow("approval_binding_changed");
      expect(() => validateApproval({ ...second, replannedStopped: [entry(second.runs[0]!.runId), entry(second.runs[0]!.runId)] }, { sourceCommit: second.sourceCommit, tasks })).toThrow("approval_binding_changed");
      expect(() => validateApproval({ ...second, replannedStopped: [{ runId: second.runs[0]!.runId }] }, { sourceCommit: second.sourceCommit, tasks })).toThrow("approval_invalid");
      expect(() => validateApproval({ ...second, replannedStopped: [{ ...entry(second.runs[0]!.runId), extra: 1 }] }, { sourceCommit: second.sourceCommit, tasks })).toThrow("approval_invalid");
      expect(() => validateApproval(second, { sourceCommit: second.sourceCommit, tasks })).not.toThrow();
    });
  });

  it("excludes a slot that has only a ledger entry (a crash after the charge) and counts it as ledger-only", async () => {
    const f = await flow();
    const approval1 = f.approve(await f.plan());
    const w1 = f.wave(approval1, "wave-1", [text(), text()], { maxRuns: 2 });
    await w1.run();
    await rm(join(w1.waveDir, "runs", `${approval1.runs[1]!.runId}.json`));
    const again = await f.plan("--exclude-wave", w1.waveDir);
    expect(again.exclusion).toEqual({ waves: [{ wave: "wave-1", executed: 1 }], ledgerOnly: 1, removed: 2, resumable: null, replannedStopped: [], notReplanned: [] });
    expect(again.matrix.runs.map((r) => r.runId)).toEqual(approval1.runs.slice(2).map((r) => r.runId));
    // Without --exclude-wave the ledger is not consulted.
    expect((await f.plan()).matrix.count).toBe(15);
  });

  it("refuses an excluded wave without an approval, under another ledger, without a runs directory, and bad arguments", async () => {
    const f = await flow();
    const approval1 = f.approve(await f.plan());
    const w1 = f.wave(approval1, "wave-1", [text()], { maxRuns: 1 });
    await w1.run();
    const empty = join(f.root, "empty");
    mkdirSync(empty);
    await expect(f.plan("--exclude-wave", empty)).rejects.toThrow("approval_missing");
    const other = join(f.root, "other");
    mkdirSync(join(other, "runs"), { recursive: true });
    await writeFile(join(other, "approval.json"), JSON.stringify({ ...approval1, ledgerId: "44444444-4444-4444-8444-444444444444" }));
    await expect(f.plan("--exclude-wave", other)).rejects.toThrow("ledger_mismatch");
    await rm(join(w1.waveDir, "runs"), { recursive: true });
    await expect(f.plan("--exclude-wave", w1.waveDir)).rejects.toThrow("runs_missing");
    // M3: waves planned over other tasks do not describe these runs.
    const kept = JSON.parse(await readFile(f.tasksFile, "utf8")) as unknown[];
    await writeFile(f.tasksFile, JSON.stringify(kept.slice(0, 2)));
    await mkdir(join(w1.waveDir, "runs"));
    await expect(f.plan("--exclude-wave", w1.waveDir)).rejects.toThrow("tasks_changed");
    await writeFile(f.tasksFile, JSON.stringify(kept));
    // M6: a wrong --ledger with --exclude-wave creates nothing.
    const wrong = join(f.root, "wrong", "ledger.json");
    await expect(buildPlan(parseArgs(["--plan", "--tasks", f.tasksFile, "--ledger", wrong, "--exclude-wave", w1.waveDir]), { sourceCwd: f.repo })).rejects.toThrow("ledger_missing");
    expect(existsSync(join(f.root, "wrong"))).toBe(false);
    const base = ["--plan", "--tasks", "t.json"];
    expect(parseArgs([...base, "--ledger", "l.json", "--exclude-wave", "a", "--exclude-wave", "b"]).excludeWaves).toEqual(["a", "b"]);
    expect(() => parseArgs([...base, "--exclude-wave", "a"])).toThrow("ledger_required");
    expect(() => parseArgs([...base, "--ledger", "l.json", "--exclude-wave", "a", "--exclude-wave", "a"])).toThrow("invalid_argument");
    const live = ["--approval", "a.json", "--tasks", "t.json", "--template", "x", "--out", "w", "--ledger", "l.json"];
    expect(() => parseArgs(["--wave", ...live, "--exclude-wave", "a"])).toThrow("invalid_argument");
    expect(() => parseArgs(["--report", "--wave", "w", "--ledger", "l.json", "--evidence", "e", "--exclude-wave", "a"])).toThrow("invalid_argument");
  });

  describe("replicates (R90)", () => {
    const grok = ["--pairings", "pl-review-grok"];
    const records = async (dir: string): Promise<(RunRecord & { replicate?: number })[]> =>
      Promise.all((await readdir(join(dir, "runs"))).sort().map(async (name) => JSON.parse(await readFile(join(dir, "runs", name), "utf8")) as RunRecord));

    it("plans every task and arm per replicate, binds the replicate count in the approval, and leaves one replicate as it was", async () => {
      const f = await flow();
      const plain = await f.plan(...grok);
      const one = await f.plan(...grok, "--replicates", "1");
      expect(JSON.stringify(one.matrix)).toBe(JSON.stringify(plain.matrix));
      expect(JSON.stringify(one.approvalTemplate)).toBe(JSON.stringify(plain.approvalTemplate));
      expect("replicates" in plain.approvalTemplate).toBe(false);
      expect(plain.approvalTemplate.runs.every((r) => !("replicate" in r) && !/-r\d$/.test(r.runId))).toBe(true);

      const three = await f.plan(...grok, "--replicates", "3");
      expect(three.matrix.count).toBe(3 * plain.matrix.count);
      expect(three.approvalTemplate.replicates).toBe(3);
      expect(three.approvalTemplate.runs.map((r) => r.replicate)).toEqual(three.approvalTemplate.runs.map((_, i) => Math.floor(i / plain.matrix.count) + 1));
      expect(three.matrix.runs.map((r) => r.ordinal)).toEqual(three.matrix.runs.map((r) => r.ordinal).sort((a, b) => a - b));
      expect(three.matrix.runs.every((r, i) => r.runId.endsWith(`-r${Math.floor(i / plain.matrix.count) + 1}`))).toBe(true);
      // Arm A leads on R1 in replicate 1 and trails in replicate 2.
      const firstArm = (k: number) => three.approvalTemplate.runs.find((r) => r.taskId === "R1" && r.replicate === k)!.arm;
      expect([firstArm(1), firstArm(2), firstArm(3)]).toEqual(["A", "pi-lens", "A"]);
      expect(matrixDigest(three.approvalTemplate.runs)).not.toBe(matrixDigest(plain.approvalTemplate.runs));

      const approval = f.approve(three);
      const check = (candidate: unknown) => () => validateApproval(candidate, { sourceCommit: approval.sourceCommit, tasks: f.tasks });
      expect(check(approval)).not.toThrow();
      // The replicate count is part of the binding: the same runs under another count, or without one, are not canonical.
      expect(check({ ...approval, replicates: 2 })).toThrow("approval_binding_changed");
      const { replicates: omitted, ...withoutCount } = approval;
      void omitted;
      expect(check(withoutCount)).toThrow("approval_binding_changed");
      expect(check({ ...f.approve(plain), replicates: 3 })).toThrow("approval_binding_changed");
      expect(check({ ...approval, replicates: 10 })).toThrow("approval_invalid");
      const [first, ...rest] = approval.runs;
      expect(check({ ...approval, runs: [{ ...first!, replicate: 2 }, ...rest] })).toThrow("approval_binding_changed");
      const { replicate: dropped, ...bare } = first!;
      void dropped;
      expect(check({ ...approval, runs: [bare, ...rest] })).toThrow("approval_binding_changed");
      // A subsequence of the replicated matrix is valid content, as for any plan (R58).
      expect(check({ ...approval, ...{ runs: approval.runs.slice(2, 9), matrixDigest: matrixDigest(approval.runs.slice(2, 9)) } })).not.toThrow();
    });

    it("excludes executed runs by run id, resumes under the same approval, and reports the units of the replicates", async () => {
      const f = await flow();
      const approval = f.approve(await f.plan(...grok, "--replicates", "2"));
      expect(approval.runs).toHaveLength(12);
      const w1 = f.wave(approval, "wave-1", [text({ cost: 0.1 }), text({ cost: 0.1 })], { maxRuns: 2 });
      expect((await w1.run()).paused).toBe(true);
      const written = await records(w1.waveDir);
      expect(written.map((r) => r.replicate)).toEqual([1, 1]);
      expect(written.every((r) => r.runId.endsWith("-r1"))).toBe(true);

      const again = await f.plan(...grok, "--replicates", "2", "--exclude-wave", w1.waveDir);
      expect(again.exclusion).toMatchObject({ removed: 2, resumable: "wave-1" });
      expect(again.matrix.runs.map((r) => r.runId)).toEqual(approval.runs.slice(2).map((r) => r.runId));
      // Replicate k of a plan with more replicates has the run ids of replicate k here, so a wave is excluded from it, but is no longer resumable.
      const other = await f.plan(...grok, "--replicates", "3", "--exclude-wave", w1.waveDir);
      expect(other.exclusion).toMatchObject({ removed: 2, resumable: null });
      expect(other.matrix.count).toBe(16);
      // A plan without replicates has other run ids (no suffix): nothing of this wave is one of its slots.
      const plainPlan = await f.plan(...grok, "--exclude-wave", w1.waveDir);
      expect(plainPlan.exclusion).toMatchObject({ removed: 0 });

      const resumed = await f.wave(approval, "wave-1", Array.from({ length: 10 }, () => text({ cost: 0.1 })), { resume: true }).run();
      expect(resumed.paused).toBe(false);
      expect(resumed.records).toHaveLength(10);
      // A different count in the approval is not the approval the wave ran under.
      await expect(f.wave({ ...approval, replicates: 3 }, "wave-1", [text()], { resume: true }).run()).rejects.toThrow();

      const summary = await f.report([w1.waveDir]);
      const result = summary.pairings.find((p) => p.id === "pl-review-grok")!;
      expect(result).toMatchObject({ kind: "review", recommendation: "descriptive", complete: true, tasks: ["R1", "R2", "R3"] });
      expect(result.replicated).toMatchObject({ replicates: 2 });
      expect(result.replicated!.units).toHaveLength(6);
      expect(JSON.parse(await readFile(join(f.root, "evidence", "approvals", "approval-1.json"), "utf8"))).toMatchObject({ replicates: 2 });
      // G1: the same run ids cannot be charged twice, whatever the wave directory.
      await expect(f.wave(approval, "wave-again", [text()]).run()).rejects.toThrow("run_already_charged");
    });

    it("refuses a resume whose stored record belongs to another slot, and a plan whose excluded record names another slot", async () => {
      const f = await flow();
      const approval = f.approve(await f.plan(...grok, "--replicates", "2"));
      const w1 = f.wave(approval, "wave-1", [text({ cost: 0.1 })], { maxRuns: 1 });
      await w1.run();
      const file = join(w1.waveDir, "runs", `${approval.runs[0]!.runId}.json`);
      const stored = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      await writeFile(file, JSON.stringify({ ...stored, taskId: "R2" }));
      await expect(f.plan(...grok, "--replicates", "2", "--exclude-wave", w1.waveDir)).rejects.toThrow("wave_slot_mismatch");
      const resumed = f.wave(approval, "wave-1", [text()], { resume: true });
      await expect(resumed.run()).rejects.toThrow("resume_invalid");
      expect(resumed.captured).toHaveLength(0);
      const { replicate: dropped, ...withoutReplicate } = stored;
      void dropped;
      await writeFile(file, JSON.stringify(withoutReplicate));
      await expect(f.wave(approval, "wave-1", [text()], { resume: true }).run()).rejects.toThrow("resume_invalid");
    });
  });
});

describe("a stale status must not allow a resume (R61)", () => {
  /** Deps whose clock fails from the first reading after a run was spawned, as a crash in the middle of an invocation would. */
  const crashingAfterFirstRun = (s: Setup, steps: Step[]): WaveDeps => {
    const d = s.deps(steps);
    d.deps.now = () => { if (d.captured.length > 0) throw new Error("clock_failed"); return Date.now(); };
    return d.deps;
  };
  const statusOf = async (dir: string) => JSON.parse(await readFile(join(dir, "status.json"), "utf8")) as { state: string };

  it("leaves `running` after a fresh invocation that dies, and refuses to resume it", async () => {
    const s = await waveSetup(3);
    await expect(runWave(s.input, crashingAfterFirstRun(s, [text(), text()]))).rejects.toThrow("clock_failed");
    expect(await statusOf(s.waveDir)).toMatchObject({ state: "running", stopReason: null });
    expect(existsSync(`${s.input.ledgerPath}.lock`)).toBe(false);
    const resumed = s.deps([text()]);
    await expect(runWave({ ...s.input, resume: true }, resumed.deps)).rejects.toThrow("resume_invalid");
    expect(resumed.captured).toHaveLength(0);
  });

  it("leaves `running` after a resumed invocation that dies, so the earlier `paused` cannot be reused", async () => {
    const s = await waveSetup(4);
    await runWave({ ...s.input, maxRuns: 1 }, s.deps([text()]).deps);
    expect(await statusOf(s.waveDir)).toMatchObject({ state: "paused" });
    // The clock fails before the third run, after the second was recorded and charged.
    await expect(runWave({ ...s.input, resume: true }, crashingAfterFirstRun(s, [text(), text()]))).rejects.toThrow("clock_failed");
    expect(await statusOf(s.waveDir)).toMatchObject({ state: "running" });
    expect((await readdir(join(s.waveDir, "runs"))).length).toBe(2);
    const again = s.deps([text()]);
    await expect(runWave({ ...s.input, resume: true }, again.deps)).rejects.toThrow("resume_invalid");
    expect(again.captured).toHaveLength(0);
  });

  it("refuses wave_stopped when the status says paused but a record holds a stop reason", async () => {
    const s = await waveSetup(3);
    const outside = `${benignTrace()}4242 openat(AT_FDCWD</scope>, "/home/u/x", O_WRONLY|O_CREAT, 0644) = 3</home/u/x>\n`;
    expect((await runWave(s.input, s.deps([text({ trace: outside })]).deps)).stopReason).toBe("outside_write");
    const status = JSON.parse(await readFile(join(s.waveDir, "status.json"), "utf8")) as Record<string, unknown>;
    await writeFile(join(s.waveDir, "status.json"), JSON.stringify({ ...status, state: "paused", stopReason: null }));
    const resumed = s.deps([text()]);
    await expect(runWave({ ...s.input, resume: true }, resumed.deps)).rejects.toThrow("wave_stopped");
    expect(resumed.captured).toHaveLength(0);
  });
});

describe("lock before read (R62a)", () => {
  it("takes the lock first and leaves no lock file when opening fails", async () => {
    const root = await temporaryRoot("ablation-open-locked-");
    const path = join(root, "ledger.json");
    // A missing ledger in a missing directory creates neither the directory nor a lock (M6).
    await expect(PersistedLedger.openLocked(join(root, "nodir", "ledger.json"), LEDGER_ID)).rejects.toThrow("ledger_missing");
    expect(existsSync(join(root, "nodir"))).toBe(false);
    await expect(PersistedLedger.openLocked(path, LEDGER_ID)).rejects.toThrow("ledger_missing");
    expect(existsSync(`${path}.lock`)).toBe(false);
    await seedLedger(path, [], "44444444-4444-4444-8444-444444444444");
    await expect(PersistedLedger.openLocked(path, LEDGER_ID)).rejects.toThrow("ledger_mismatch");
    expect(existsSync(`${path}.lock`)).toBe(false);
    await writeFile(path, "{ not json");
    await expect(PersistedLedger.openLocked(path, LEDGER_ID)).rejects.toThrow();
    expect(existsSync(`${path}.lock`)).toBe(false);
    await seedLedger(path);
    const held = await PersistedLedger.openLocked(path, LEDGER_ID);
    expect(existsSync(`${path}.lock`)).toBe(true);
    // A second holder is refused before it reads anything, and its refusal does not remove the first holder's lock.
    await expect(PersistedLedger.openLocked(path, LEDGER_ID)).rejects.toThrow("ledger_locked");
    expect(existsSync(`${path}.lock`)).toBe(true);
    await held.release();
    expect(existsSync(`${path}.lock`)).toBe(false);
  });
});

describe("approved runs must be canonical (R62b)", () => {
  async function edited(change: (runs: RunSpec[]) => RunSpec[]) {
    const root = await temporaryRoot("ablation-canonical-");
    const tasks = [await reviewTask(root, "A1"), await reviewTask(root, "A2")];
    const runs = buildMatrix(tasks, PAIRINGS);
    const approval = approvalFor(tasks, change(runs));
    return () => validateApproval(approval, { sourceCommit: approval.sourceCommit, tasks, routes: approval.routes });
  }
  const first = (runs: RunSpec[]): RunSpec => runs.find((r) => r.profile === "review-grok" && r.arm === "pi-lens")!;
  const replaceFirst = (runs: RunSpec[], run: RunSpec): RunSpec[] => runs.map((r, i) => (i === 0 ? run : r));

  it("accepts the canonical list and any subsequence of it with subset pairings", async () => {
    expect((await edited((runs) => runs))()).toBeDefined();
    expect((await edited((runs) => runs.slice(3, 9)))()).toBeDefined();
    expect((await edited((runs) => runs.map((r) => ({ ...r, pairings: [r.pairings[0]!] }))))()).toBeDefined();
  });

  it("refuses an arm-B run of a profile that has no pairing for that extension", async () => {
    const run = (runs: RunSpec[]) => ({ ...first(runs), arm: "pi-cache-optimizer" as const, runId: first(runs).runId.replace(/pi-lens$/, "pi-cache-optimizer") });
    await expect((await edited((runs) => replaceFirst(runs, run(runs)))).bind(null)).toThrow("approval_binding_changed");
  });

  it("refuses an unknown pairing id, a duplicated pairing id, and a pairing of another slot", async () => {
    await expect(await edited((runs) => replaceFirst(runs, { ...runs[0]!, pairings: ["no-such-pairing"] }))).toThrow("approval_binding_changed");
    await expect(await edited((runs) => replaceFirst(runs, { ...runs[0]!, pairings: [runs[0]!.pairings[0]!, runs[0]!.pairings[0]!] }))).toThrow("approval_binding_changed");
    await expect(await edited((runs) => replaceFirst(runs, { ...runs[0]!, pairings: ["pl-code"] }))).toThrow("approval_binding_changed");
  });

  it("refuses a run id that does not match its slot or ordinal", async () => {
    await expect(await edited((runs) => replaceFirst(runs, { ...runs[0]!, runId: "999-A1-review-grok-A" }))).toThrow("approval_binding_changed");
    await expect(await edited((runs) => replaceFirst(runs, { ...runs[0]!, ordinal: 99 }))).toThrow("approval_binding_changed");
    await expect(await edited((runs) => replaceFirst(runs, { ...runs[0]!, taskId: "A2" }))).toThrow("approval_binding_changed");
  });

  it("refuses a review task on a code profile", async () => {
    await expect(await edited((runs) => replaceFirst(runs, { ...runs[0]!, profile: "code", runId: runs[0]!.runId.replace("review-grok", "code") }))).toThrow("approval_binding_changed");
  });

  it("refuses runs that are not in increasing ordinal order", async () => {
    await expect(await edited((runs) => [...runs].reverse())).toThrow("approval_binding_changed");
    await expect(await edited((runs) => [runs[1]!, runs[0]!, ...runs.slice(2)])).toThrow("approval_binding_changed");
  });
});

describe("an invalid session cost counts as missing (R62c)", () => {
  const usage = (assistantCost: number, tokens: number, sessionTokens = 10) => ({
    session: { input: sessionTokens, output: 0, cacheRead: 0, cacheWrite: 0, total: sessionTokens, costUsd: -1 },
    assistant: { messages: 1, input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: assistantCost }, providerError: null,
  });
  const entriesOf = async (path: string) => (JSON.parse(await readFile(path, "utf8")) as { entries: { runId: string; costUsd: number | null; estimated?: boolean }[] }).entries;

  it("falls back in the wave like a missing session total: the assistant sum or the estimate when tokens show anywhere, null only without tokens (M2)", async () => {
    const s = await waveSetup(3);
    const r = await runWave(s.input, s.deps([
      text({ output: { usage: usage(1.5, 10) } }), text({ output: { usage: usage(0.4, 0) } }), text({ output: { usage: usage(0.4, 0, 0) } }),
    ]).deps);
    const entries = await entriesOf(s.input.ledgerPath);
    expect(entries[0]).toMatchObject({ runId: s.runs[0]!.runId, costUsd: 1.5, estimated: true });
    // Session tokens alone are a billed response: the estimate stands in (at least the assistant cost).
    expect(entries[1]).toMatchObject({ runId: s.runs[1]!.runId, estimated: true });
    expect(entries[1]!.costUsd).toBeGreaterThanOrEqual(1);
    // No token anywhere: nothing was billed.
    expect(entries[2]).toMatchObject({ runId: s.runs[2]!.runId, costUsd: null });
    expect(entries[2]!.estimated).toBeUndefined();
    expect(r.stopReason).toBeNull();
  });

  it("fails a preflight route with usage_missing and still charges the assistant cost", async () => {
    const root = await temporaryRoot("ablation-invalid-session-");
    const tasks = [await reviewTask(join(root, "repo"), "P1")];
    const approval = approvalFor(tasks, buildMatrix(tasks, PAIRINGS.filter((p) => p.id === "pl-review")));
    await seedLedger(join(root, "l.json"));
    const { spawnRun } = fake([{ text: "PONG", output: { usage: usage(0.07, 10) } }], root);
    const result = await runPreflight({ approval, waveDir: join(root, "w"), ledgerPath: join(root, "l.json"), productionConfig, hostAuth: { openai: { type: "api_key", key: "k" } } }, {
      ...seams(), spawnRun: (scope, input) => spawnRun(scope, input, join(scope.root, "x.log")), residualCheck: async () => true,
    });
    expect(result.routes).toMatchObject([{ profile: "review", ok: false, terminal: "completed", failure: "usage_missing" }]);
    expect(await entriesOf(join(root, "l.json"))).toMatchObject([{ costUsd: 0.07 }]);
  });
});

describe("no run is executed twice (G1) and records are atomic (A1)", () => {
  it("refuses to resume wave 1 once another wave executed one of its pending slots, before anything is written", async () => {
    const s = await waveSetup(4);
    await runWave({ ...s.input, maxRuns: 1 }, s.deps([text()]).deps);
    // What a wave 2 under a re-approval would have left in the shared ledger.
    const ledger = await PersistedLedger.openExisting(s.input.ledgerPath, LEDGER_ID);
    await ledger.record(s.runs[2]!.runId, "review", 0.1);
    const resumed = s.deps([text()]);
    await expect(runWave({ ...s.input, resume: true }, resumed.deps)).rejects.toThrow("run_already_charged");
    expect(resumed.captured).toHaveLength(0);
    expect(JSON.parse(await readFile(join(s.waveDir, "status.json"), "utf8"))).toMatchObject({ state: "paused" });
    expect((await readdir(join(s.waveDir, "runs"))).length).toBe(1);
    expect(existsSync(`${s.input.ledgerPath}.lock`)).toBe(false);
  });

  it("refuses a second fresh --out under the same approval", async () => {
    const s = await waveSetup(2);
    await runWave(s.input, s.deps([text(), text()]).deps);
    const second = s.deps([text(), text()]);
    const other = join(s.root, "wave-b");
    await expect(runWave({ ...s.input, waveDir: other }, second.deps)).rejects.toThrow("run_already_charged");
    expect(second.captured).toHaveLength(0);
    expect(existsSync(join(other, "status.json"))).toBe(false);
    expect(existsSync(join(other, "approval.json"))).toBe(false);
    expect(existsSync(`${s.input.ledgerPath}.lock`)).toBe(false);
  });

  it("never overwrites an existing record and leaves no temporary file", async () => {
    const s = await waveSetup(2);
    const target = join(s.waveDir, "runs", `${s.runs[0]!.runId}.json`);
    let calls = 0;
    // The guard is read before the wave and after each run: the record appears in between.
    const guard = async () => { calls += 1; if (calls === 2) await writeFile(target, "sentinel"); return { files: {} }; };
    const r = await runWave(s.input, s.deps([text(), text()], { guard }).deps);
    expect(r.stopReason).toBe("harness_failure");
    expect(await readFile(target, "utf8")).toBe("sentinel");
    expect((await readdir(s.waveDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    // The second run was not executed after the failed write.
    expect(r.records.map((x) => x.outcome)).toEqual(["scored", "not_run"]);
  });
});

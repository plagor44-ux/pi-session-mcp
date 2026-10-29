import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { matrixDigest, routesOf, tasksDigest, type Approval } from "../eval/extensions/approval.js";
import { buildMatrix, PAIRINGS } from "../eval/extensions/matrix.js";
import { EMPTY_PLAN } from "../eval/extensions/sandbox.js";
import { resolveTool, type ToolPaths } from "../eval/extensions/tools.js";
import { hash } from "../eval/profiles/files.js";
import type { RunSpec, TaskSpec } from "../eval/extensions/schemas.js";
import { type RunRecord, type WaveDeps, type WaveInput } from "../eval/extensions/wave.js";
import { privateRunDir, scopeRoot, type RunScope, type ScopeInput } from "../eval/extensions/workspace.js";
import { temporaryRoot } from "./temporary-roots.js";

export const exec = promisify(execFile);

export const SOURCE = "/src/example-repo";
export const PROFILE = { provider: "openai", model: "model-a", thinkingLevel: "high", permissionProfile: "read-only", default: true, skills: ["pi-session-review"] };
export const CODING = { provider: "deepseek", model: "model-b", thinkingLevel: "high", permissionProfile: "coding", default: false, skills: ["pi-session-implementation"] };
export const OPT_OUT = { DO_NOT_TRACK: "DO_NOT_TRACK", CODEGRAPH_NO_UPDATE_CHECK: "CODEGRAPH_NO_UPDATE_CHECK", CODEGRAPH_TELEMETRY: "CODEGRAPH_TELEMETRY" };
export const CODEGRAPH_SERVER = { command: "/usr/bin/codegraph", args: ["serve", "--mcp"], tools: { explore: { name: "codegraph_explore", readOnly: true } } };
export const productionConfig = {
  workspaces: { repo: SOURCE },
  skillCatalog: { "pi-session-review": "builtin:pi-session-review", "pi-session-implementation": "builtin:pi-session-implementation" },
  executionProfiles: { review: PROFILE, "review-grok": { ...PROFILE, provider: "xai" }, code: { ...CODING, provider: "openai" }, "code-deepseek": CODING },
};
export const GOOD_REVIEW = "src/example.ts: there is a race in the cache refresh.";

/** bwrap's setup processes (muted by the audit), then the workload `pid` (R46). */
export const prelude = (pid: number) => `${pid - 2} clone(child_stack=NULL, flags=CLONE_NEWNS|CLONE_NEWIPC|CLONE_NEWUSER|CLONE_NEWPID|SIGCHLD) = ${pid - 1}\n${pid - 1} clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|CLONE_CHILD_SETTID|SIGCHLD, child_tidptr=0x7f0) = ${pid}\n`;
export const benignTrace = (pid = 4242) => `${prelude(pid)}${pid} openat(AT_FDCWD</scope>, "/etc/hosts", O_RDONLY) = 3</etc/hosts>\n`;

export interface Step {
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

export const FAKE_SCRIPT = `
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

export function outputFor(step: Step) {
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
export function fake(steps: Step[], dir: string) {
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

export const fakePrepare = async (input: ScopeInput): Promise<RunScope> => {
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

export async function reviewTask(repoRoot: string, id: string): Promise<TaskSpec> {
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

export async function implTask(repoRoot: string, id: string): Promise<TaskSpec> {
  const body = `Fix ${SOURCE}/src/example.ts.`;
  const promptRef = `eval/results/ablation-test/${id}.txt`;
  await mkdir(join(repoRoot, "eval/results/ablation-test"), { recursive: true });
  await writeFile(join(repoRoot, promptRef), body);
  return {
    id, kind: "implementation", repo: "repo", baseCommit: "a".repeat(40), promptRef, promptHash: hash(body), sourceSession: "s",
    allowedPaths: ["src/example.ts"], scopeIgnore: [], oracle: { kind: "implementation", command: ["npm", "test"], timeoutMs: 10_000 },
  };
}

export interface Setup { input: WaveInput; deps: (steps: Step[], extra?: WaveDeps) => { deps: WaveDeps; captured: ReturnType<typeof fake>["captured"] }; runs: RunSpec[]; waveDir: string; root: string }

export function approvalFor(tasks: TaskSpec[], runs: RunSpec[], sourceCommit = "c".repeat(40)): Approval {
  return {
    approved: true, approvedAt: "2026-10-20T00:00:00Z", budgetUsd: 10, sourceCommit, tasksDigest: tasksDigest(tasks), matrixDigest: matrixDigest(runs),
    ledgerId: LEDGER_ID, runs, routes: routesOf(productionConfig, runs.map((r) => r.profile)),
  };
}

/** The ledger an approval's id names: the evaluation's one ledger exists before any preflight or wave (R55). */
export async function seedLedger(path: string, entries: unknown[] = [], ledgerId: string = LEDGER_ID): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ ledgerId, limitUsd: 10, spentUsd: 0, entries }));
}

/** The seams that keep a preflight or wave test off the host: no strace, bwrap, codegraph, DNS or provider. */
export const seams = () => ({
  hostCheck: async () => undefined, containmentCheck: async () => undefined, planSandbox: async () => EMPTY_PLAN, resolveTools: async () => TOOLS, checkRoute: async () => undefined,
});

export async function waveSetup(count: number, options: Partial<WaveInput> & { kind?: "review" | "implementation"; hostAuth?: unknown; sourceCommit?: string } = {}): Promise<Setup> {
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

export const TOOLS: ToolPaths = { strace: "/opt/tools/bin/strace", prlimit: "/opt/tools/bin/prlimit", git: "/opt/tools/bin/git", codegraph: "/opt/tools/bin/codegraph", bwrap: "/opt/tools/bin/bwrap" };
export const baseDeps = (): WaveDeps => ({ prepareScope: fakePrepare, guard: async () => ({ files: {} }), residualCheck: async () => true, resolveAddresses: async () => noAddresses, hostCheck: async () => undefined, containmentCheck: async () => undefined, planSandbox: async () => EMPTY_PLAN, resolveTools: async () => TOOLS });
/** Every directory below `dir` with the given name. */
export async function findDirs(dir: string, name: string): Promise<string[]> {
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
export async function findFiles(dir: string, pattern: RegExp): Promise<string[]> {
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
export const realTools = async (bin?: string): Promise<Pick<ToolPaths, "git" | "codegraph">> =>
  ({ git: await resolveTool("git", process.env.PATH ?? ""), codegraph: bin === undefined ? "/nonexistent/codegraph" : join(bin, "codegraph") });
export const LEDGER_ID = "11111111-1111-4111-8111-111111111111";
export const noAddresses = { providerAddresses: new Set<string>(), dnsAddresses: new Set<string>() };
export const text = (extra: Step = {}): Step => ({ text: GOOD_REVIEW, ...extra });
export const stopReasons = (records: RunRecord[]) => records.map((r) => r.outcome);

export async function entriesOfLedger(path: string) {
  return (JSON.parse(await readFile(path, "utf8")) as { entries: { runId: string }[] }).entries;
}

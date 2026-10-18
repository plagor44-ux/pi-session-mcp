import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createPlan, taskCatalog } from "./catalog.js";
import { ownedTemporary, sourceBinding, copyFixture, snapshot, changedPaths, hash, digest } from "./files.js";
import { taskDefinitions, evaluateTask } from "./oracles.js";
import { evaluateBounded } from "./oracle-process.js";
import { manifestSchema, type Manifest, type Budget, type Run } from "./schemas.js";
import { validateApproval } from "./runner.js";
import { measureCodexEvent } from "./token-client-events.js";
import { bounded } from "./transport.js";
import { proxyMetricsSchema, runTokenProxy, type ProxyMetrics } from "./token-live-proxy.js";
import { frameSchema, type Frame } from "./token-meter.js";
import { fileURLToPath } from "node:url";
import { readSkillTree, type SkillTree } from "../../src/skill-library.js";

export const DEFAULT_CONTROLLER_VERSION = "0.162.0" as const;
export const CONTROLLER_BASE = {
  client: "codex",
  provider: "openai",
  model: "gpt-6.1-sol",
  effort: "high",
  auth: "existing-client-login-not-probed",
} as const;

export interface ControllerBinding {
  readonly client: "codex";
  readonly version: string;
  readonly provider: "openai";
  readonly model: "gpt-6.1-sol";
  readonly effort: "high";
  readonly auth: "existing-client-login-not-probed";
}

export function controllerConfig(version: string = DEFAULT_CONTROLLER_VERSION): ControllerBinding {
  return { ...CONTROLLER_BASE, version };
}

export const CONTROLLER = controllerConfig(DEFAULT_CONTROLLER_VERSION);
const ROUTES = {
  review: { provider: "openai-codex", model: "gpt-6.1-sol", effort: "high" as const, auth_type: "oauth" as const, billing_type: "subscription" as const, data_path: "synthetic-fixture-to-selected-provider" as const },
  code: { provider: "openai-codex", model: "gpt-6.1-sol", effort: "medium" as const, auth_type: "oauth" as const, billing_type: "subscription" as const, data_path: "synthetic-fixture-to-selected-provider" as const },
};
const MATRIX = [
  { id: "L1", task: "T1", starts: 1, turns: 1, route: "review", slots: ["m1-l1"], prompts: 1 },
  { id: "L2", task: "T2", starts: 1, turns: 1, route: "code", slots: ["m1-l2"], prompts: 1 },
  { id: "L3", task: "T1", starts: 2, turns: 3, route: "review", slots: ["m1-l3-shared"], prompts: 3 },
] as const;
const RUN_PROMPTS = [
  "For this fresh isolated evaluation, use only the pi-session-mcp server. Discover capabilities; start one read-only session in workspace alias `fixture` using profile `review`; prompt once with the supplied task; poll with bounded pauses until terminal; retrieve its completed receipt; close it and verify the session list is empty. Do not start another session.",
  "For this fresh isolated evaluation, use only the pi-session-mcp server. Discover capabilities; start one coding session in workspace alias `fixture` using profile `code`; prompt once with the supplied task; poll with bounded pauses until terminal; retrieve its completed receipt; close it and verify the session list is empty. Do not start another session. The harness independently recorded the failing T2 baseline before this controller started.",
  "For this fresh isolated evaluation, use only the pi-session-mcp server. Discover capabilities; start exactly two read-only sessions in workspace alias `fixture`, both using profile `review`, before prompting either. Prompt each once with its supplied task, poll both with bounded pauses to terminal, retrieve both receipts, then issue exactly one additional prompt to the first session with the supplied follow-up. Poll that turn to terminal, retrieve its receipt, verify the first turn remains unchanged, close both sessions and verify the list is empty. Do not start or prompt any other session.",
];

export interface WorkerSkillBinding {
  readonly name: string;
  readonly tree_digest: string;
}

export function parseWorkerSkills(value: unknown): readonly WorkerSkillBinding[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const r = asRecord(item);
    const name = String(r.name ?? r.identity ?? "");
    const tree_digest = String(r.tree_digest ?? r.digest ?? "");
    return { name, tree_digest };
  }).filter((s) => s.name.length > 0 && s.tree_digest.length > 0);
}

/** Per-case server configuration. The server requires a read-only default, so L2 keeps `review` as default and selects `code` explicitly. */
/**
 * Selected worker skills point at the digest-verified source trees (`<skillsRoot>/<name>/SKILL.md`), not at
 * `builtin:`: the evaluation server runs from a compiled build without a shipped `skills/` directory.
 */
export function caseServerConfig(caseId: "L1" | "L2" | "L3", workspace: string, workerSkills: readonly WorkerSkillBinding[] = [], skillsRoot?: string) {
  const hasReview = workerSkills.some((s) => s.name === "pi-session-review");
  const hasCode = workerSkills.some((s) => s.name === "pi-session-implementation");
  if ((hasReview || hasCode) && skillsRoot === undefined) throw new Error("worker_skill_root_required");
  const skillCatalog: Record<string, string> = {};
  if (hasReview) skillCatalog["pi-session-review"] = join(skillsRoot!, "pi-session-review", "SKILL.md");
  if (hasCode) skillCatalog["pi-session-implementation"] = join(skillsRoot!, "pi-session-implementation", "SKILL.md");
  const review = {
    permissionProfile: "read-only",
    provider: "openai-codex",
    model: "gpt-6.1-sol",
    thinkingLevel: "high",
    default: true,
    ...(hasReview ? { skills: ["pi-session-review"] } : {}),
  } as const;
  const code = {
    permissionProfile: "coding",
    provider: "openai-codex",
    model: "gpt-6.1-sol",
    thinkingLevel: "medium",
    default: false,
    ...(hasCode ? { skills: ["pi-session-implementation"] } : {}),
  } as const;
  return {
    workspaces: { fixture: workspace },
    ...(Object.keys(skillCatalog).length > 0 ? { skillCatalog } : {}),
    executionProfiles: caseId === "L2" ? { review, code } : { review },
  };
}

export function formatEmbeddedSkillTree(tree: SkillTree): string {
  const skillFile = tree.files.find((f) => f.path === "SKILL.md");
  if (!skillFile) throw new Error("orchestration_skill_missing");
  const skillText = skillFile.bytes.toString("utf8");
  const referenceFiles = tree.files.filter((f) => f.path !== "SKILL.md");
  const referenceSections = referenceFiles.map((file) =>
    `--- Reference: ${file.path} ---\n${file.bytes.toString("utf8")}\n--- End Reference: ${file.path} ---`
  );
  return referenceSections.length > 0 ? `${skillText}\n\n${referenceSections.join("\n\n")}` : skillText;
}
async function buildBinding(build: string): Promise<`sha256:${string}`> {
  const root = resolve(build), entries: Array<[string, string]> = [];
  for (const required of ["package.json", "src/main.js", "eval/profiles/token-live-proxy.js"]) {
    const stat = await lstat(join(root, required));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("compiled_build_incomplete");
  }
  async function walk(relative: string): Promise<void> {
    for (const entry of (await readdir(join(root, relative), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (relative === "" && entry.name === "node_modules") continue;
      const child = join(relative, entry.name), full = join(root, child), stat = await lstat(full);
      if (stat.isSymbolicLink()) throw new Error("compiled_build_symlink");
      if (stat.isDirectory()) await walk(child);
      else if (stat.isFile()) entries.push([child.split("\\").join("/"), hash(await readFile(full))]);
      else throw new Error("compiled_build_entry_invalid");
    }
  }
  await walk("src"); await walk("eval/profiles");
  entries.push(["package.json", hash(await readFile(join(root, "package.json")))]);
  entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return digest(entries);
}
const hashFile = async (path: string) => hash(await readFile(path));
const noApproval = "M1 exact-schedule approval missing or stale";

export interface TokenLiveTemplates {
  readonly profileManifest: Manifest;
  readonly budgetProposal: Record<string, unknown>;
  readonly decisionTemplate: TokenLiveDecision;
}
export interface TokenLiveApproval {
  readonly approved: true;
  readonly manifest_digest: string;
  readonly budget_digest: string;
  readonly source_digest: string;
  readonly build_digest: string;
  readonly matrix_digest: string;
  readonly controller_skill_digest: string;
  readonly controller: ControllerBinding;
  readonly schedule: typeof MATRIX;
  readonly worker_skills?: readonly WorkerSkillBinding[];
  readonly budget_limits: { max_starts: 4; max_retries: 0; parallelism: 1; run_timeout_ms: 600000; total_timeout_ms: 1800000; provider_cap_usd: null };
  readonly advisory_usd: number;
  readonly limits: { starts: 4; work_turns: 5; retries: 0; invocations: 3 };
}
export type TokenLiveDecision = Omit<TokenLiveApproval, "approved" | "manifest_digest" | "budget_digest" | "source_digest" | "build_digest" | "advisory_usd"> & {
  readonly schema_version: "token-live-decision-1";
  readonly approved: boolean;
  readonly manifest_digest: string | null;
  readonly budget_digest: string | null;
  readonly source_digest: string;
  readonly build_digest: string;
  readonly advisory_usd: number | null;
  readonly operator_acknowledges_advisory_not_cap: boolean;
};
export interface TokenLiveResult {
  readonly schema_version: "token-live-result-1";
  readonly harness_status: "PASS" | "FAIL" | "BLOCKED" | "INCONCLUSIVE";
  readonly source_digest: string;
  readonly build_digest: string;
  readonly failure_code: "execution_error" | null;
  readonly binding: {
    readonly source_commit: string;
    readonly source_recheck_passed: boolean;
    readonly build_recheck_passed: boolean;
    readonly skill_recheck_passed: boolean;
    readonly worker_skills_recheck_passed?: boolean;
    readonly manifest_digest: string;
    readonly budget_digest: string;
    readonly decision_digest: string;
    readonly skill_digest: string;
    readonly worker_skills?: readonly WorkerSkillBinding[];
    readonly matrix_digest: string;
    readonly node_version: string;
    readonly controller: ControllerBinding;
    readonly routes: { readonly review: typeof ROUTES.review; readonly code: typeof ROUTES.code };
    readonly tasks: readonly { readonly id: string; readonly task_hash: string; readonly fixture_hash: string; readonly prompt_digest: string }[];
  };
  readonly starts: number | null;
  readonly work_turns: number | null;
  readonly retries: number;
  readonly cases: readonly {
    readonly id: "L1" | "L2" | "L3";
    readonly status: "PASS" | "FAIL" | "BLOCKED" | "INCONCLUSIVE";
    readonly starts: number | null;
    readonly prompts: number | null;
    readonly controller_exit_code: number | null;
    readonly controller_stdout_bytes: number;
    readonly proxy_integrity: boolean | null;
    readonly server_cleanup_observed: boolean | null;
    readonly controller_cleanup_observed: boolean | null;
    readonly proxy_bytes: { readonly controller_received: number; readonly server_received: number; readonly server_written: number; readonly quota_rejections: number } | null;
    readonly events: readonly ReturnType<typeof measureCodexEvent>[];
    readonly independent_checks: readonly { id: string; passed: boolean }[];
    readonly frames: readonly Frame[];
  }[];
}
export type ChildFactory = (command: string, args: string[], options: Parameters<typeof spawn>[2]) => ChildProcessWithoutNullStreams;
const defaultChildFactory: ChildFactory = (command, args, options) => spawn(command, args, options) as ChildProcessWithoutNullStreams;
const asRecord = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
export function verifyL3ReceiptSchedule(
  prompts: readonly { sessionId: string; turnId: string }[],
  observations: readonly { sessionId: string; turnId: string; hash: string; sequence: number }[],
): { readonly uniquePrompts: boolean; readonly everyPromptHasReceipt: boolean; readonly originalReFetchedAfterFollowup: boolean; readonly originalUnchanged: boolean } {
  const keys = prompts.map(prompt => `${prompt.sessionId}\0${prompt.turnId}`);
  const uniquePrompts = prompts.length === 3 && new Set(keys).size === 3 && prompts[0]!.sessionId !== prompts[1]!.sessionId
    && prompts[0]!.sessionId === prompts[2]!.sessionId && prompts[0]!.turnId !== prompts[2]!.turnId;
  const obsByKey = new Map<string, typeof observations[number][]>();
  for (const observation of observations) {
    const key = `${observation.sessionId}\0${observation.turnId}`;
    obsByKey.set(key, [...obsByKey.get(key) ?? [], observation]);
  }
  const everyPromptHasReceipt = uniquePrompts && keys.every(key => obsByKey.has(key)) && obsByKey.size === keys.length;
  const followupKey = keys[2] ?? "", originalKey = keys[0] ?? "";
  const followup = (obsByKey.get(followupKey) ?? []).at(-1);
  const original = obsByKey.get(originalKey) ?? [];
  const after = followup !== undefined && original.some(row => row.sequence > followup.sequence);
  const originalUnchanged = original.length >= 2 && new Set(original.map(row => row.hash)).size === 1;
  return { uniquePrompts, everyPromptHasReceipt, originalReFetchedAfterFollowup: after, originalUnchanged };
}
function signalChild(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  child.kill(signal);
  if (child.pid && process.platform !== "win32") void signalObservedControllerGroup(child.pid, signal);
}
async function signalObservedControllerGroup(pgid: number, signal: NodeJS.Signals): Promise<boolean> {
  if (process.platform !== "linux") return false;
  try {
    const entries: Array<{ pid: number; start: string }> = [];
    for (const name of (await readdir("/proc")).filter(value => /^\d+$/.test(value))) {
      try {
        const stat = await readFile(`/proc/${name}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (fields.length < 20 || !fields[0] || !fields[19] || !Number.isSafeInteger(Number(fields[2]))) return false;
        if (Number(fields[2]) === pgid && fields[0] !== "Z" && fields[0] !== "X") entries.push({ pid: Number(name), start: fields[19] });
      } catch (error) { const code = (error as NodeJS.ErrnoException).code; if (code !== "ENOENT" && code !== "ESRCH") return false; }
    }
    for (const entry of entries) {
      try {
        const stat = await readFile(`/proc/${entry.pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (fields[19] === entry.start && Number(fields[2]) === pgid && fields[0] !== "Z" && fields[0] !== "X") process.kill(entry.pid, signal);
      } catch (error) { const code = (error as NodeJS.ErrnoException).code; if (code !== "ENOENT" && code !== "ESRCH") return false; }
    }
    return true;
  } catch { return false; }
}
async function controllerGroupGone(pgid: number): Promise<boolean> {
  if (process.platform === "linux") {
    try {
      const pids = (await readdir("/proc")).filter(name => /^\d+$/.test(name));
      for (const name of pids) {
        try {
          const stat = await readFile(`/proc/${name}/stat`, "utf8"), fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          if (fields.length < 20 || !fields[0] || !Number.isSafeInteger(Number(fields[2]))) return false;
          if (Number(fields[2]) === pgid && fields[0] !== "Z" && fields[0] !== "X") return false;
        } catch (error) { const code = (error as NodeJS.ErrnoException).code; if (code !== "ENOENT" && code !== "ESRCH") return false; }
      }
      return true;
    } catch { return false; }
  }
  try { process.kill(-pgid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
/** Clean and observe the proxy-registered detached MCP server process group. */
export async function cleanupRegisteredServer(controlPath: string, timeoutMs = 3000): Promise<boolean> {
  if (process.platform !== "linux") return false;
  try {
    const row = asRecord(JSON.parse(await readFile(controlPath, "utf8")));
    const pid = row.pid, start = row.start, group = row.process_group;
    if (row.schema_version !== "token-live-server-identity-1" || !Number.isSafeInteger(pid) || (pid as number) <= 1
      || typeof start !== "string" || !/^\d+$/.test(start) || group !== pid) return false;
    const pgid = pid as number;
    const leaderIdentityValid = async (): Promise<boolean> => {
      try {
        const stat = await readFile("/proc/" + pgid + "/stat", "utf8"), fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        return fields.length >= 20 && fields[19] === start && Number(fields[2]) === pgid;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return code === "ENOENT" || code === "ESRCH";
      }
    };
    const scan = async (signal?: NodeJS.Signals): Promise<boolean> => {
      if (!(await leaderIdentityValid())) return false;
      const alive: Array<{ pid: number; start: string }> = [];
      for (const name of (await readdir("/proc")).filter(value => /^\d+$/.test(value))) {
        try {
          const stat = await readFile("/proc/" + name + "/stat", "utf8"), fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          if (fields.length < 20 || !fields[0] || !fields[19] || !Number.isSafeInteger(Number(fields[2]))) return false;
          if (Number(fields[2]) === pgid && fields[0] !== "Z" && fields[0] !== "X") alive.push({ pid: Number(name), start: fields[19] });
        } catch (error) { const code = (error as NodeJS.ErrnoException).code; if (code !== "ENOENT" && code !== "ESRCH") return false; }
      }
      if (signal && !(await leaderIdentityValid())) return false;
      if (signal) for (const member of alive) {
        try {
          const stat = await readFile("/proc/" + member.pid + "/stat", "utf8"), fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          if (fields.length < 20 || !fields[0] || !fields[19]) return false;
          if (fields[19] === member.start && Number(fields[2]) === pgid && fields[0] !== "Z" && fields[0] !== "X") process.kill(member.pid, signal);
        } catch (error) { const code = (error as NodeJS.ErrnoException).code; if (code !== "ENOENT" && code !== "ESRCH") return false; }
      }
      return alive.length === 0;
    };
    if (await scan()) return true;
    await scan("SIGTERM");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { if (await scan()) return true; await new Promise(resolveWait => setTimeout(resolveWait, 40)); }
    await scan("SIGKILL");
    const killDeadline = Date.now() + 1500;
    while (Date.now() < killDeadline) { if (await scan()) return true; await new Promise(resolveWait => setTimeout(resolveWait, 40)); }
    return scan();
  } catch { return false; }
}
function existingControllerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keys = ["PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "PI_CODING_AGENT_DIR"];
  return Object.fromEntries(keys.flatMap(key => source[key] === undefined ? [] : [[key, source[key]!]]));
}

export interface OwnedControllerResult {
  readonly exit_code: number | null;
  readonly timed_out: boolean;
  readonly process_group_cleanup_observed: boolean;
  readonly stdout_bytes: number;
  readonly line_integrity_passed: boolean;
}
/** Bounded controller process helper; stdout is delivered line-by-line and never returned or saved. */
export async function runOwnedController(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }, input: string,
  timeoutMs: number, onLine: (line: Buffer) => void, spawnFactory: ChildFactory = defaultChildFactory, signal?: AbortSignal): Promise<OwnedControllerResult> {
  if (signal?.aborted) return { exit_code: null, timed_out: true, process_group_cleanup_observed: true, stdout_bytes: 0, line_integrity_passed: false };
  const child = spawnFactory(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "ignore"], detached: process.platform !== "win32" });
  let exitCode: number | null = null, closed = false, stdoutBytes = 0, pending = Buffer.alloc(0), lineIntegrity = true, childError = false;
  const ended = new Promise<void>(resolveEnd => child.once("close", code => { exitCode = code; closed = true; resolveEnd(); }));
  child.on("error", () => { childError = true; });
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > 32 * 1024 * 1024) { lineIntegrity = false; signalChild(child, "SIGTERM"); return; }
    pending = Buffer.concat([pending, chunk]);
    if (pending.length > 2 * 1024 * 1024) { lineIntegrity = false; signalChild(child, "SIGTERM"); return; }
    let end: number;
    while ((end = pending.indexOf(10)) >= 0) {
      const line = Buffer.from(pending.subarray(0, end)); pending = pending.subarray(end + 1);
      try { onLine(line); } catch { lineIntegrity = false; signalChild(child, "SIGTERM"); }
    }
  });
  let timedOut = false, aborted = false, stdinFailed = false;
  child.stdin.on("error", () => { stdinFailed = true; signalChild(child, "SIGTERM"); });
  let rejectAbort!: (reason?: Error) => void;
  const abortPromise = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => { aborted = true; signalChild(child, "SIGTERM"); rejectAbort(new Error("aborted")); };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try { child.stdin.end(input); } catch { stdinFailed = true; signalChild(child, "SIGTERM"); }
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => { timedOut = true; signalChild(child, "SIGTERM"); reject(new Error("deadline")); }, timeoutMs);
  });
  try {
    await Promise.race([ended, abortPromise, timeoutPromise]);
  } catch {
    timedOut = !aborted; signalChild(child, "SIGTERM");
    try { await bounded(ended, 26_000); }
    catch { signalChild(child, "SIGKILL"); try { await bounded(ended, 2000); } catch { /* result carries unverified cleanup */ } }
  } finally { clearTimeout(timeout); }
  signal?.removeEventListener("abort", onAbort);
  if (pending.length) lineIntegrity = false;
  let processGroupCleanupObserved = process.platform === "win32" ? exitCode !== null : false;
  if (closed && child.pid && process.platform !== "win32") {
    const groupAlive = async () => !(await controllerGroupGone(child.pid!));
    if (await groupAlive()) {
      await signalObservedControllerGroup(child.pid, "SIGTERM");
      const deadline = Date.now() + 26_000;
      while (Date.now() < deadline && await groupAlive()) await new Promise(resolvePoll => setTimeout(resolvePoll, 40));
      if (await groupAlive()) { await signalObservedControllerGroup(child.pid, "SIGKILL"); const killDeadline = Date.now() + 2000; while (Date.now() < killDeadline && await groupAlive()) await new Promise(resolvePoll => setTimeout(resolvePoll, 40)); }
    }
    processGroupCleanupObserved = !(await groupAlive());
  }
  return { exit_code: exitCode, timed_out: timedOut || aborted, process_group_cleanup_observed: processGroupCleanupObserved, stdout_bytes: stdoutBytes, line_integrity_passed: lineIntegrity && !childError && !stdinFailed };
}

export interface PrepareTokenLiveOptions {
  readonly controllerVersion?: string | undefined;
  readonly workerSkills?: readonly WorkerSkillBinding[] | undefined;
}

export async function prepareTokenLive(root: string, build: string, options?: PrepareTokenLiveOptions): Promise<TokenLiveTemplates> {
  const base = await createPlan(root), tasks = await taskCatalog(root), source = await sourceBinding(root);
  const runs: Run[] = ([
    { ...base.runs[0]!, run_id: "m1-l1", task_id: "T1", profile_id: "P1", view: "scout", stage: "screening", repetition: 1, permission_profile: "read-only", variant: "A", skills: [], extensions: [], route: ROUTES.review },
    { ...base.runs[1]!, run_id: "m1-l2", task_id: "T2", profile_id: "P2", view: "implementer", stage: "screening", repetition: 1, permission_profile: "coding", variant: "A", skills: [], extensions: [], route: ROUTES.code },
    { ...base.runs[0]!, run_id: "m1-l3-a", task_id: "T1", profile_id: "P1", view: "scout", stage: "screening", repetition: 1, permission_profile: "read-only", variant: "A", skills: [], extensions: [], route: ROUTES.review },
    { ...base.runs[0]!, run_id: "m1-l3-b", task_id: "T1", profile_id: "P1", view: "scout", stage: "screening", repetition: 2, permission_profile: "read-only", variant: "A", skills: [], extensions: [], route: ROUTES.review },
  ] as Run[]).map(run => ({ ...run, task_hash: tasks.find(task => task.id === run.task_id)!.task_hash }));
  const profileManifest = manifestSchema.parse({ ...base, approved: false, runs, tasks, server_commit: source.commit, source_digest: source.digest, prerequisites: { baseline_passed: false, screening_passed: false, bottleneck: null } });
  const buildDigest = await buildBinding(build);
  const matrixDigest = digest(MATRIX);
  const orchestrationTree = await readSkillTree(join(root, "skills/pi-session-orchestration"));
  const controllerSkillDigest = orchestrationTree.fingerprint;
  const controller = controllerConfig(options?.controllerVersion ?? DEFAULT_CONTROLLER_VERSION);
  const workerSkills = options?.workerSkills ? parseWorkerSkills(options.workerSkills) : [];
  return {
    profileManifest,
    budgetProposal: { schema_version: "1.0.0", approved: false, manifest_digest: null, max_starts: 4, max_retries: 0, parallelism: 1, run_timeout_ms: 600000, total_timeout_ms: 1800000, advisory_usd: null, provider_cap_usd: null, acknowledges_unmetered_cost: false },
    decisionTemplate: {
      schema_version: "token-live-decision-1",
      approved: false,
      manifest_digest: null,
      budget_digest: null,
      source_digest: source.digest,
      build_digest: buildDigest,
      matrix_digest: matrixDigest,
      controller_skill_digest: controllerSkillDigest,
      controller,
      schedule: MATRIX,
      worker_skills: workerSkills,
      budget_limits: { max_starts: 4, max_retries: 0, parallelism: 1, run_timeout_ms: 600000, total_timeout_ms: 1800000, provider_cap_usd: null },
      advisory_usd: null,
      limits: { starts: 4, work_turns: 5, retries: 0, invocations: 3 },
      operator_acknowledges_advisory_not_cap: false,
    },
  };
}

function validDecision(value: unknown, manifest: Manifest, budget: Budget, expected: TokenLiveTemplates): value is TokenLiveApproval {
  const d = asRecord(value);
  const exactManifest = { ...manifest, approved: false };
  const dWorkerSkills = parseWorkerSkills(d.worker_skills ?? d.worker_skill_tree_digests);
  const expWorkerSkills = parseWorkerSkills(expected.decisionTemplate.worker_skills);
  return d.schema_version === "token-live-decision-1" && d.approved === true && d.operator_acknowledges_advisory_not_cap === true
    && d.manifest_digest === digest(manifest) && d.budget_digest === digest(budget)
    && digest(exactManifest) === digest(expected.profileManifest)
    && d.source_digest === expected.decisionTemplate.source_digest && d.build_digest === expected.decisionTemplate.build_digest && d.matrix_digest === digest(MATRIX)
    && d.controller_skill_digest === expected.decisionTemplate.controller_skill_digest
    && digest(d.controller) === digest(expected.decisionTemplate.controller) && digest(d.schedule) === digest(MATRIX)
    && digest(dWorkerSkills) === digest(expWorkerSkills)
    && digest(d.budget_limits) === digest({ max_starts: 4, max_retries: 0, parallelism: 1, run_timeout_ms: 600000, total_timeout_ms: 1800000, provider_cap_usd: null })
    && d.advisory_usd === budget.advisory_usd && budget.max_starts === 4 && budget.max_retries === 0 && budget.parallelism === 1
    && budget.run_timeout_ms === 600000 && budget.total_timeout_ms === 1800000 && budget.provider_cap_usd === null
    && digest(d.limits) === digest({ starts: 4, work_turns: 5, retries: 0, invocations: 3 });
}

/** Fresh-controller M1 path. Tests may inject a child factory; production defaults to the Codex CLI. */
export async function runTokenLive(root: string, build: string, approvals: { profileManifest: unknown; budget: unknown; decision: unknown }, output: string,
  dependencies: { spawn?: ChildFactory; now?: () => number; signal?: AbortSignal; controllerVersion?: ((version: string) => boolean) | (() => boolean) } = {}): Promise<TokenLiveResult> {
  // Preserve existing profile gate and reject before creating temp dirs, clients, or child processes.
  const { manifest, budget } = await validateApproval(root, approvals.profileManifest, approvals.budget);
  const dec = asRecord(approvals.decision);
  const decController = asRecord(dec.controller);
  const controllerVersion = typeof decController.version === "string" ? decController.version : undefined;
  const workerSkills = parseWorkerSkills(dec.worker_skills ?? dec.worker_skill_tree_digests);
  const expected = await prepareTokenLive(root, build, { controllerVersion, workerSkills });
  if (!validDecision(approvals.decision, manifest, budget, expected)) throw new Error(noApproval);
  const source = await sourceBinding(root);
  const buildDigest = await buildBinding(build);
  if (source.digest !== expected.decisionTemplate.source_digest || buildDigest !== expected.decisionTemplate.build_digest) throw new Error(noApproval);

  // P3: Bound client version verification
  const boundVersion = expected.decisionTemplate.controller.version;
  const versionOk = dependencies.controllerVersion ? dependencies.controllerVersion(boundVersion) : (() => {
    const versionCheck = spawnSync("codex", ["--version"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
    if (versionCheck.status !== 0) return false;
    const escaped = boundVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^codex-cli ${escaped}(?:\\s|$)`, "m").test(versionCheck.stdout ?? "");
  })();
  if (!versionOk) throw new Error("controller_version_mismatch");

  // P2: Verify worker skills before starting
  for (const skill of expected.decisionTemplate.worker_skills ?? []) {
    if (skill.name !== "pi-session-implementation" && skill.name !== "pi-session-review") {
      throw new Error("worker_skill_invalid");
    }
    const skillPath = join(root, "skills", skill.name);
    let tree: SkillTree;
    try {
      tree = await readSkillTree(skillPath);
    } catch {
      throw new Error("worker_skill_missing");
    }
    if (tree.fingerprint !== skill.tree_digest) {
      throw new Error("worker_skill_digest_mismatch");
    }
  }

  // P1: Freeze controller skill tree and build embedded prompt text
  const skillTree = await readSkillTree(join(root, "skills/pi-session-orchestration"));
  const skillDigest = skillTree.fingerprint;
  if (skillDigest !== expected.decisionTemplate.controller_skill_digest) throw new Error(noApproval);
  const fullSkillText = formatEmbeddedSkillTree(skillTree);

  const factory = dependencies.spawn ?? defaultChildFactory, now = dependencies.now ?? Date.now;
  const startTime = now(), cases: TokenLiveResult["cases"][number][] = [];
  const privateRun = await ownedTemporary();
  let sourceSame = false, buildSame = false, skillSame = false, executionFailure = false;
  let activeCaseId: TokenLiveResult["cases"][number]["id"] | null = null;
  let activePartial: TokenLiveResult["cases"][number] | null = null;
  try {
    for (let index = 0; index < MATRIX.length; index++) {
      if (now() - startTime >= budget.total_timeout_ms) break;
      const spec = MATRIX[index]!, runStart = now(), temp = join(privateRun.root, spec.id);
      activeCaseId = spec.id;
      activePartial = { id: spec.id, status: "INCONCLUSIVE", starts: null, prompts: null, controller_exit_code: null, controller_stdout_bytes: 0,
        proxy_integrity: null, server_cleanup_observed: null, controller_cleanup_observed: null, proxy_bytes: null, events: [], independent_checks: [], frames: [] };
      await mkdir(temp, { recursive: true, mode: 0o700 });
      const workspace = join(temp, "fixture");
      await copyFixture(join(root, "eval/fixtures", spec.task, "public"), workspace);
      const workspaces = [workspace];
      const before = await snapshot(workspace);
      const caseRemaining = () => Math.max(0, Math.min(budget.total_timeout_ms - (now() - startTime), budget.run_timeout_ms - (now() - runStart)));
      let baseline: Awaited<ReturnType<typeof evaluateBounded>> | undefined, baselineStatus: "not-needed" | "failed" | "timeout" | "unavailable" | "inconclusive" = "not-needed";
      if (spec.id === "L2") {
        const timeout = Math.min(180_000, caseRemaining());
        if (timeout < 1) baselineStatus = "timeout";
        else {
          try { baseline = await evaluateBounded(root, "T2", workspace, {}, undefined, "implementer", timeout, dependencies.signal); baselineStatus = baseline.status === "FAIL" ? "failed" : baseline.status === "INCONCLUSIVE" || baseline.status === "BLOCKED" ? "inconclusive" : "unavailable"; }
          catch (error) { const code = (error as { code?: unknown }).code; baselineStatus = code === "oracle_timeout" || code === "oracle_aborted" ? "timeout" : "unavailable"; }
        }
      }
      const eventRows: ReturnType<typeof measureCodexEvent>[] = [], receiptMap = new Map<string, unknown>();
      const promptKeys: Array<{ key: string; sessionId: string; turnId: string }> = [];
      const receiptObservations: Array<{ sessionId: string; turnId: string; hash: string; sequence: number }> = [];
      let eventSequence = 0;
      const frameRows: Frame[] = [];
      const routeChecks: ProxyMetrics["route_checks"] = [], closedSessionOrdinals = new Set<number>();
      let emptySessionListObserved = false, sessionListAfterAllClosed = false;
      let controllerStdoutBytes = 0, proxyControllerBytes = 0, proxyServerBytes = 0, proxyServerWrittenBytes = 0, quotaRejections = 0, metricsObserved = false;
      const controllerPrompt = `${fullSkillText}\n\nM1 measurement override: perform exactly the listed operations, with zero retries. If any operation fails, stop and report failure; do not start replacement sessions.\n${RUN_PROMPTS[index]}\nTask: ${taskDefinitions.find(t => t.id === spec.task)!.prompt}\n${spec.id === "L3" ? `Follow-up: ${"Re-read the T1 source and documentation. Return the same two source-linked claims with numeric status values; do not modify files."}` : ""}\nReturn no success claim unless every requested step and cleanup check completed.`;
      const turns = [controllerPrompt];
      const caseChecks: { id: string; passed: boolean }[] = [];
      let caseStarts: number | null = 0, casePrompts: number | null = 0, caseStatus: TokenLiveResult["harness_status"] = spec.id === "L2" && baselineStatus !== "failed" ? baselineStatus === "timeout" ? "INCONCLUSIVE" : "FAIL" : "PASS", controllerExit: number | null = null, proxyOk: boolean | null = null, serverCleaned: boolean | null = null, controllerCleanup = false;
      if (spec.id === "L2" && baselineStatus === "inconclusive") caseStatus = "INCONCLUSIVE";
      const refreshPartial = () => { activePartial = { id: spec.id, status: caseStatus, starts: caseStarts, prompts: casePrompts, controller_exit_code: controllerExit,
        controller_stdout_bytes: controllerStdoutBytes, proxy_integrity: proxyOk, server_cleanup_observed: serverCleaned,
        controller_cleanup_observed: controllerCleanup, proxy_bytes: metricsObserved ? { controller_received: proxyControllerBytes, server_received: proxyServerBytes, server_written: proxyServerWrittenBytes, quota_rejections: quotaRejections } : null,
        events: eventRows, independent_checks: caseChecks, frames: frameRows }; };
      refreshPartial();
      if (spec.id === "L2") caseChecks.push({ id: "fail-before", passed: baseline?.status === "FAIL" });
      for (let invocation = 0; invocation < turns.length && caseStatus === "PASS"; invocation++) {
        const cfg = join(temp, `config-${invocation}.json`), metrics = join(temp, `proxy-${invocation}.json`), control = join(temp, `server-${invocation}.json`), proxyEntry = fileURLToPath(new URL("./token-live-proxy.js", import.meta.url));
        const proxyEnv = { TOKEN_LIVE_REAL_ENTRY: join(resolve(build), "src/main.js"), TOKEN_LIVE_CONFIG: cfg, TOKEN_LIVE_METRICS_FILE: metrics, TOKEN_LIVE_CONTROL_FILE: control, TOKEN_LIVE_MAX_STARTS: String(spec.starts), TOKEN_LIVE_MAX_PROMPTS: String(spec.prompts), TOKEN_LIVE_WORKER_TURN_MS: "180000" };
        const config = caseServerConfig(spec.id, workspace, expected.decisionTemplate.worker_skills, join(root, "skills"));
        await writeFile(cfg, JSON.stringify(config), { mode: 0o600, flag: "wx" });
        const envToml = `{${Object.entries(proxyEnv).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(",")}}`;
        const controllerCwd = join(temp, "controller"); await mkdir(controllerCwd, { mode: 0o700 });
        const codexArgs = ["exec", "--json", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check", "--sandbox", "read-only", "--model", "gpt-6.1-sol", "-c", 'model_reasoning_effort="high"', "-c", `mcp_servers.pi-session-mcp.command=${JSON.stringify(process.execPath)}`, "-c", `mcp_servers.pi-session-mcp.args=[${JSON.stringify(proxyEntry)}]`, "-c", `mcp_servers.pi-session-mcp.env=${envToml}`, "-c", 'mcp_servers.pi-session-mcp.tools.pi_session_prompt.approval_mode="approve"', "-c", 'mcp_servers.pi-session-mcp.tools.pi_session_close.approval_mode="approve"', "-"];
        let parseError = false;
        const remaining = caseRemaining();
        if (remaining < 1000) { caseStatus = "INCONCLUSIVE"; break; }
        const processResult = await runOwnedController("codex", codexArgs, { cwd: controllerCwd, env: existingControllerEnvironment(process.env) }, turns[invocation]!, Math.min(budget.run_timeout_ms, remaining), line => {
          try {
            const event = JSON.parse(line.toString("utf8")) as unknown, measurement = measureCodexEvent(event);
            eventRows.push(measurement);
            refreshPartial();
            eventSequence++;
            const e = asRecord(event), item = asRecord(e.item), result = asRecord(item.result), structured = asRecord(result.structured_content), turn = asRecord(asRecord(structured.turn));
            const sessionId = typeof turn.sessionId === "string" ? turn.sessionId : "";
            const turnId = typeof turn.turnId === "string" ? turn.turnId : "";
            const key = sessionId && turnId ? `${sessionId}\0${turnId}` : "";
            const toolName = [item.name, item.tool, item.tool_name, item.toolName].find(value => typeof value === "string");
            if (toolName === "pi_session_prompt" && key && turn.state !== "failed" && turn.state !== "aborted") promptKeys.push({ key, sessionId, turnId });
            if (toolName === "pi_turn_get" && key && typeof turn.assistantText === "string" && turn.state === "completed" && !turn.truncated) {
              try {
                const receipt = JSON.parse(turn.assistantText) as unknown, receiptHash = digest(receipt);
                receiptObservations.push({ sessionId, turnId, hash: receiptHash, sequence: eventSequence });
                receiptMap.set(key, receipt);
              } catch { /* invalid receipts remain unaccepted */ }
            }
          } catch { parseError = true; }
        }, factory, dependencies.signal);
        controllerExit = processResult.exit_code;
        controllerCleanup = processResult.process_group_cleanup_observed;
        controllerStdoutBytes += processResult.stdout_bytes;
        refreshPartial();
        let metric: ProxyMetrics | undefined;
        try { metric = proxyMetricsSchema.parse(JSON.parse(await readFile(metrics, "utf8"))); } catch { metric = undefined; }
        const registeredServerCleaned = await cleanupRegisteredServer(control);
        if (metric) {
          metricsObserved = true;
          caseStarts = caseStarts === null ? null : caseStarts + metric.start_attempts;
          casePrompts = casePrompts === null ? null : casePrompts + metric.prompt_attempts;
          proxyControllerBytes += metric.controller_bytes; proxyServerBytes += metric.received_bytes; proxyServerWrittenBytes += metric.written_bytes; quotaRejections += metric.quota_rejections;
          frameRows.push(...metric.frames);
          routeChecks.push(...metric.route_checks);
          for (const ordinal of metric.closed_session_ordinals) closedSessionOrdinals.add(ordinal);
          emptySessionListObserved ||= metric.empty_session_list_observed;
          sessionListAfterAllClosed ||= metric.session_list_after_all_closed;
          proxyOk = metric.integrity_passed;
          serverCleaned = metric.server_exit_code === 0 && metric.server_cleanup_observed && registeredServerCleaned;
        }
        if (!registeredServerCleaned) { serverCleaned = false; caseStatus = "INCONCLUSIVE"; }
        if (!metric) { caseStarts = null; casePrompts = null; }
        refreshPartial();
        if (processResult.timed_out || parseError || !processResult.line_integrity_passed || !processResult.process_group_cleanup_observed || !metric || controllerExit !== 0 || metric.worker_turn_timed_out) { caseStatus = processResult.timed_out || metric?.worker_turn_timed_out || !processResult.process_group_cleanup_observed ? "INCONCLUSIVE" : "FAIL"; break; }
        proxyOk = metric.integrity_passed; serverCleaned = metric.server_exit_code === 0 && metric.server_cleanup_observed && registeredServerCleaned;
        if (metric.quota_rejections !== 0) { caseStatus = "FAIL"; break; }
      }
      if (caseStatus === "PASS") {
        let verificationTimedOut = false;
        const receipts = promptKeys.map(row => receiptMap.get(row.key)).filter(value => value !== undefined);
        if (caseStarts !== spec.starts || casePrompts !== spec.prompts) caseChecks.push({ id: "approved-quota-exact", passed: false });
        else caseChecks.push({ id: "approved-quota-exact", passed: true });
        const firstReceipt = receipts[0];
        caseChecks.push({ id: "completed-receipts-present", passed: receipts.length === spec.prompts });
        caseChecks.push({ id: "unique-turn-receipts", passed: promptKeys.length === spec.prompts
          && new Set(promptKeys.map(row => row.key)).size === spec.prompts && receiptMap.size === spec.prompts });
        const evaluateTaskWithin = async (receipt: unknown) => {
          const timeout = caseRemaining();
          return timeout < 1 ? undefined : await bounded(evaluateTask("T1", workspace, receipt, undefined, "scout"), timeout).catch(() => undefined);
        };
        let verdict: Awaited<ReturnType<typeof evaluateTask>> | undefined;
        const oracleTimeout = caseRemaining();
        if (oracleTimeout < 1) caseStatus = "INCONCLUSIVE";
        else if (spec.task === "T1") verdict = await evaluateTaskWithin(firstReceipt);
        else {
          try { verdict = await evaluateBounded(root, "T2", workspace, firstReceipt, undefined, "implementer", Math.min(180_000, oracleTimeout), dependencies.signal); }
          catch { verdict = undefined; }
        }
        caseChecks.push({ id: "independent-oracle", passed: verdict?.status === "PASS" });
        const expectedProfile = spec.route === "code" ? "coding" : "read-only";
        const routed = frameRows.filter(frame => frame.direction === "response" && frame.tool === "pi_session_start").map(frame => frame.session_ordinal);
        const routePass = routed.length === spec.starts && routed.every(ordinal => routeChecks.some(row => row.session_ordinal === ordinal && row.profile === expectedProfile && row.passed));
        caseChecks.push({ id: "resolved-route-and-permission", passed: routePass });
        if (spec.id === "L3") {
          const first = await evaluateTaskWithin(receipts[0]);
          const second = await evaluateTaskWithin(receipts[1]);
          const followup = await evaluateTaskWithin(receipts[2]);
          verificationTimedOut = first === undefined || second === undefined || followup === undefined;
          caseChecks.push({ id: "both-read-oracles", passed: first?.status === "PASS" && second?.status === "PASS" });
          const receiptSchedule = verifyL3ReceiptSchedule(promptKeys, receiptObservations);
          caseChecks.push({ id: "followup-first-turn-invariance", passed: followup?.status === "PASS" && receiptSchedule.originalReFetchedAfterFollowup && receiptSchedule.originalUnchanged });
          const sessionIds = frameRows.filter(frame => frame.direction === "response" && frame.tool === "pi_session_start").map(frame => frame.session_ordinal).filter((value): value is number => value !== null);
          const promptSessionIds = frameRows.filter(frame => frame.direction === "request" && frame.tool === "pi_session_prompt").map(frame => frame.session_ordinal);
          const distinctSessions = new Set(sessionIds).size === 2 && promptSessionIds.length === 3 && promptSessionIds[0] !== null
            && promptSessionIds[1] !== null && promptSessionIds[0] !== promptSessionIds[1] && promptSessionIds[2] === promptSessionIds[0];
          caseChecks.push({ id: "two-sessions-one-followup", passed: distinctSessions && receiptSchedule.uniquePrompts && receiptSchedule.everyPromptHasReceipt && receipts.length === 3 });
        }
        if (caseStatus === "PASS") caseStatus = verificationTimedOut || verdict === undefined ? "INCONCLUSIVE" : verdict.status === "PASS" && caseChecks.every(c => c.passed) ? "PASS" : "FAIL";
      }
      const changed = changedPaths(before, await snapshot(workspace));
      caseChecks.push({ id: "workspace-change-scope", passed: spec.id === "L2" ? changed.length === 1 && changed[0] === "contract.mjs" : changed.length === 0 });
      if (caseStatus === "PASS" && caseChecks.some(check => !check.passed)) caseStatus = "FAIL";
      const calls = frameRows.filter(frame => frame.direction === "request").map(frame => frame.tool);
      const expectedCloses = spec.starts;
      const closeRows = frameRows.filter(frame => frame.direction === "response" && frame.tool === "pi_session_close" && frame.state !== "domain-error" && frame.session_ordinal !== null);
      const startOrdinals = frameRows.filter(frame => frame.direction === "response" && frame.tool === "pi_session_start" && frame.session_ordinal !== null).map(frame => frame.session_ordinal!);
      const closeOrdinals = closeRows.map(frame => frame.session_ordinal!);
      const closeChecks = calls.filter(tool => tool === "pi_session_close").length === expectedCloses && new Set(startOrdinals).size === expectedCloses
        && new Set(closeOrdinals).size === expectedCloses && startOrdinals.every(ordinal => closeOrdinals.includes(ordinal) && closedSessionOrdinals.has(ordinal));
      caseChecks.push({ id: "all-sessions-closed", passed: closeChecks && proxyOk === true && serverCleaned === true && controllerCleanup });
      caseChecks.push({ id: "empty-session-list-observed", passed: emptySessionListObserved && sessionListAfterAllClosed });
      if (caseStatus === "PASS" && caseChecks.some(check => !check.passed)) caseStatus = "FAIL";
      refreshPartial();
      cases.push({ id: spec.id, status: caseStatus, starts: caseStarts, prompts: casePrompts, controller_exit_code: controllerExit, controller_stdout_bytes: controllerStdoutBytes, proxy_integrity: proxyOk, server_cleanup_observed: serverCleaned, controller_cleanup_observed: controllerCleanup, proxy_bytes: metricsObserved ? { controller_received: proxyControllerBytes, server_received: proxyServerBytes, server_written: proxyServerWrittenBytes, quota_rejections: quotaRejections } : null, events: eventRows, independent_checks: caseChecks, frames: frameRows.map(frame => frameSchema.parse(frame)) });
      activeCaseId = null;
      activePartial = null;
      if (caseStatus !== "PASS") break;
      if (now() - startTime > budget.total_timeout_ms || now() - runStart > budget.run_timeout_ms) break;
    }
  } catch {
    executionFailure = true;
    if (activeCaseId && activePartial) cases.push({ ...activePartial, status: "FAIL", independent_checks: [...activePartial.independent_checks, { id: "attempt-incomplete", passed: false }], frames: activePartial.frames.map(frame => frameSchema.parse(frame)) });
  }
  finally { await privateRun.remove().catch(() => undefined); }
  let workerSkillsSame = true;
  try {
    sourceSame = (await sourceBinding(root)).digest === source.digest;
    buildSame = await buildBinding(build) === buildDigest;
    skillSame = (await readSkillTree(join(root, "skills/pi-session-orchestration"))).fingerprint === skillDigest;
    for (const skill of expected.decisionTemplate.worker_skills ?? []) {
      const tree = await readSkillTree(join(root, "skills", skill.name));
      if (tree.fingerprint !== skill.tree_digest) workerSkillsSame = false;
    }
  } catch { executionFailure = true; }
  const startsKnown = cases.every(c => c.starts !== null), promptsKnown = cases.every(c => c.prompts !== null);
  const measuredStarts = startsKnown ? cases.reduce((n, c) => n + (c.starts ?? 0), 0) : null;
  const measuredPrompts = promptsKnown ? cases.reduce((n, c) => n + (c.prompts ?? 0), 0) : null;
  const allPassed = cases.length === MATRIX.length && cases.every(c => c.status === "PASS") && sourceSame && buildSame && skillSame && workerSkillsSame
    && measuredStarts === 4 && measuredPrompts === 5;
  const result: TokenLiveResult = { schema_version: "token-live-result-1", harness_status: allPassed ? "PASS" : executionFailure || cases.some(c => c.status === "FAIL") ? "FAIL" : cases.length === 0 ? "BLOCKED" : "INCONCLUSIVE", source_digest: source.digest, build_digest: buildDigest,
    failure_code: executionFailure ? "execution_error" : null,
    binding: { source_commit: source.commit, source_recheck_passed: sourceSame, build_recheck_passed: buildSame, skill_recheck_passed: skillSame,
      worker_skills_recheck_passed: workerSkillsSame,
      manifest_digest: digest(manifest), budget_digest: digest(budget), decision_digest: digest(approvals.decision), skill_digest: skillDigest,
      worker_skills: expected.decisionTemplate.worker_skills ?? [],
      matrix_digest: digest(MATRIX), node_version: process.versions.node,
      controller: expected.decisionTemplate.controller, routes: ROUTES, tasks: expected.profileManifest.tasks.map(task => ({ id: task.id, task_hash: task.task_hash, fixture_hash: task.fixture_hash, prompt_digest: hash(Buffer.from(taskDefinitions.find(definition => definition.id === task.id)!.prompt, "utf8")) })) },
    starts: measuredStarts, work_turns: measuredPrompts, retries: 0, cases };
  const safe = { ...result, cases: result.cases.map(c => ({ ...c, events: c.events.map(e => ({ ...e })) })) };
  await mkdir(output, { recursive: true, mode: 0o700 });
  await writeFile(join(output, "token-live-result.json"), JSON.stringify(safe, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return result;
}

export { runTokenProxy };

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { readSkillTree } from "../../../src/skill-library.js";
import { copyFixture, ownedTemporary, snapshot, changedPaths } from "../../profiles/files.js";
import { evaluateTask } from "../../profiles/oracles.js";
import { formatEmbeddedSkillTree } from "../../profiles/token-live.js";
import { processesReferencing, type LeftoverProcess } from "../claude-probe.js";
import { claimCount, readSpoolEvents } from "../hook-waiter.js";
import { API_KEY_FILE_ENV, REQUIRED_CONTROLLER, REQUIRED_WORKER, approvalDigest, readCredentialFile, validateApproval, type Arm } from "./approval.js";
import { DUMMY_KEY, startFakeApi, type FakeApi } from "./fake-api.js";
import { buildClaudeArgs, buildControllerEnv, buildMcpConfig, buildPiConfig, buildSettings, firstJsonObject, sha256Hex, systemPrompt, userPrompt } from "./plan.js";
import { assertOutputClean, assertTopLevelAllowlist, decideEnd, eventToNextAssistantMs, parseCounters, StreamTracker, summarizeStream, type ServerCounters } from "./stream.js";

// Live runner for ONE approved L1 measurement pair (arm A vs arm C), plus a provider-free dry run on a loopback fake API.
// One call = one controller run = one result file. Result files hold allowlisted fields only (counts, labels, numbers,
// millisecond offsets); a validation step refuses any string holding the temporary root, /home/, the receipt text or a credential.
export const RUN_DEADLINE_MS = 20 * 60_000;
export const EXIT_GRACE_MS = 30_000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const bound = (promise: Promise<unknown>, ms: number): Promise<boolean> => {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([promise.then(() => true, () => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); })]).finally(() => clearTimeout(timer));
};
const histogram = (values: string[]): Record<string, number> => { const out: Record<string, number> = {}; for (const v of values) out[v] = (out[v] ?? 0) + 1; return out; };
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void { if (child.pid) { try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } } } }

export class RefusedError extends Error { constructor(readonly reason: string) { super(reason); this.name = "RefusedError"; } }

export interface LiveOptions { arm: Arm; out: string; approvalPath?: string; dryRun: boolean; clientVersion?: string }
export interface LiveSummary { file: string; seq: number; dryRun: boolean; arm: Arm; outcome: string; result: Record<string, unknown> }

interface Locations { repo: string; bridgeDir: string; liveDir: string; buildRoot: string }
function locate(): Locations {
  const liveDir = dirname(fileURLToPath(import.meta.url)), bridgeDir = dirname(liveDir);
  for (let dir = liveDir, i = 0; i < 8; i += 1, dir = dirname(dir)) {
    if (existsSync(join(dir, "skills/pi-session-orchestration/SKILL.md")) && existsSync(join(dir, "eval/fixtures/T1/public"))) return { repo: dir, bridgeDir, liveDir, buildRoot: join(dirname(dirname(bridgeDir))) };
  }
  throw new Error("repository_root_not_found");
}

function git(repo: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "ignore"] });
  if (result.status !== 0) throw new Error("git_failed");
  return result.stdout;
}
/** Porcelain lines that count as changes: everything but the ignored build and index directories. */
export function dirtyLines(porcelain: string): string[] {
  return porcelain.split("\n").filter((line) => line.trim() !== "").filter((line) => !/^.. "?\.(bridge-eval|codegraph)(\/|"|$)/.test(line));
}

export function installedClientVersion(): string {
  const env = buildControllerEnv(process.env.PATH ?? "/usr/bin:/bin", { home: "/nonexistent-live-home", configDir: "/nonexistent-live-home/claude-config", tmp: "/nonexistent-live-home/tmp", apiKey: "" });
  delete env.ANTHROPIC_API_KEY;
  const result = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"], env });
  return result.status === 0 ? result.stdout.trim() : "unavailable";
}

/** Existing result files of this kind (live or dry) in the output directory. */
export async function recordedRuns(out: string, dry: boolean): Promise<number> {
  const pattern = dry ? /^dry-\d+-L1-[AC]\.json$/ : /^\d+-L1-[AC]\.json$/;
  return (await readdir(out).catch(() => [] as string[])).filter((name) => pattern.test(name)).length;
}

async function buildDigest(buildRoot: string): Promise<string | null> {
  try {
    const entries: Array<[string, string]> = [];
    const walk = async (relative: string): Promise<void> => {
      for (const entry of (await readdir(join(buildRoot, relative), { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const child = join(relative, entry.name);
        if (entry.isDirectory()) await walk(child);
        else if (entry.isFile() && entry.name.endsWith(".js")) entries.push([child.split("\\").join("/"), createHash("sha256").update(await readFile(join(buildRoot, child))).digest("hex")]);
      }
    };
    await walk("src"); await walk("eval");
    return entries.length === 0 ? null : `sha256:${createHash("sha256").update(JSON.stringify(entries)).digest("hex")}`;
  } catch { return null; }
}

/** The receipt a correct worker returns, derived from the fixture source (dry run only). */
export async function deriveDryReceipt(workspace: string): Promise<Record<string, unknown>> {
  const read = (path: string): Promise<string> => readFile(join(workspace, path), "utf8");
  const [route, service, data, readme] = await Promise.all([read("src/api/records.ts"), read("src/services/records.ts"), read("src/data/record-store.ts"), read("README.md")]);
  const handler = /export (?:async )?function (\w+)/.exec(route)?.[1], getter = /export (?:async )?function (\w+)/.exec(service)?.[1];
  const store = /export const (\w+) = \{ (\w+)\(/.exec(data), documented = /HTTP (\d{3})/.exec(readme)?.[1], actual = /\{status:(404)\}/.exec(route)?.[1];
  if (!handler || !getter || !store || !documented || !actual) throw new Error("fixture_not_derivable");
  return { claims: [
    { id: "api-data-flow", paths: ["src/api/records.ts", "src/services/records.ts", "src/data/record-store.ts"], symbols: [handler, getter, `${store[1]}.${store[2]}`], text: "Handler calls the service, which calls the store lookup." },
    { id: "stale-doc", paths: ["README.md", "src/api/records.ts"], document_status: Number(documented), source_status: Number(actual), text: "README says 200 for a missing record; the route returns 404." },
  ] };
}

async function runOracle(workspace: string, receipts: string[]): Promise<Record<string, unknown>> {
  if (receipts.length !== 1) return { receipt_files: receipts.length, receipt_json_found: false, status: "INCONCLUSIVE", checks: [{ id: "single-receipt", status: "INCONCLUSIVE" }] };
  const parsed = firstJsonObject(receipts[0]!);
  const verdict = await evaluateTask("T1", workspace, parsed ?? {});
  return { receipt_files: 1, receipt_json_found: parsed !== undefined, status: verdict.status, checks: verdict.checks.map((c) => ({ id: c.id, status: c.status })) };
}

async function readJsonLines(path: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).flatMap((line) => { try { const v = JSON.parse(line) as unknown; return isObject(v) ? [v] : []; } catch { return []; } });
}

interface RunInput {
  options: LiveOptions; loc: Locations; apiKey: string; clientVersion: string; seq: number; approval: Record<string, unknown>; skillText: string; skillFingerprint: string;
}

async function executeRun(input: RunInput): Promise<{ result: Record<string, unknown>; forbidden: string[] }> {
  const { options, loc, apiKey } = input, arm = options.arm, dry = options.dryRun;
  const temp = await ownedTemporary();
  const root = temp.root, home = join(root, "home"), configDir = join(home, "claude-config"), workspace = join(root, "workspace"), tmp = join(root, "tmp");
  const spool = join(root, "spool"), receiptDir = join(root, "receipts"), counterFile = join(root, "counters.json"), waiterLog = join(root, "waiters.log");
  const forbidden: string[] = [root, basename(root), apiKey];
  const sysPrompt = systemPrompt(arm, input.skillText), usrPrompt = userPrompt();
  let wallStart = Date.now();
  const tracker = new StreamTracker(() => Date.now() - wallStart);
  const startedAt = new Date().toISOString();
  const run = { exit_code: null as number | null, exit_signal: null as string | null, exit_at_ms: null as number | null, stdin_ended_at_ms: null as number | null, timed_out: false, end_reason: "exited" as string, stderr_bytes: 0, spawn_error: false };
  let fake: FakeApi | undefined, child: ChildProcess | undefined, harnessInvalid = false;
  let leftoverAtExit: LeftoverProcess[] = [], leftoverAfterGrace: LeftoverProcess[] = [], groupAlive = false, tempRemoved = false;
  const collected: Record<string, unknown> = {};
  let finalCounters: ServerCounters | null = null, oracle: Record<string, unknown> = { status: "NOT_RUN", checks: [] }, workspaceChanged: boolean | null = null;
  try {
    for (const dir of [configDir, workspace, tmp, spool, receiptDir, join(home, ".config"), join(home, ".local/share"), join(home, ".cache"), join(home, ".local/state")]) await mkdir(dir, { recursive: true });
    await copyFixture(join(loc.repo, "eval/fixtures/T1/public"), workspace);
    const before = await snapshot(workspace);
    const piConfig = join(root, "pi-session-mcp.json"), liveConfig = join(root, "bridge-live.json"), mcpConfig = join(root, "mcp.json"), settingsFile = join(root, "settings.json");
    const receiptDry = dry ? await deriveDryReceipt(workspace) : undefined;
    await writeFile(piConfig, JSON.stringify(buildPiConfig(workspace)), { mode: 0o600 });
    await writeFile(liveConfig, JSON.stringify({ mode: dry ? "scripted" : "sdk", piConfigPath: piConfig, spoolBase: spool, counterFile, receiptDir,
      ...(dry ? { scripts: [{ prompts: [[{ sleepMs: 3000 }, { complete: `Here is the receipt:\n${JSON.stringify(receiptDry)}` }]] }] } : {}) }), { mode: 0o600 });
    const agentDir = dry ? undefined : (process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi/agent"));
    await writeFile(mcpConfig, JSON.stringify(buildMcpConfig(process.execPath, join(loc.liveDir, "live-server-main.js"), { liveConfigPath: liveConfig, ...(agentDir !== undefined ? { agentDir } : {}) })), { mode: 0o600 });
    await writeFile(settingsFile, JSON.stringify(buildSettings(arm, { node: process.execPath, waiterJs: join(loc.bridgeDir, "hook-waiter.js"), spoolBase: spool, waiterLog })), { mode: 0o600 });
    if (dry) fake = await startFakeApi(arm);
    const env = buildControllerEnv(process.env.PATH ?? "/usr/bin:/bin", { home, configDir, tmp, apiKey: dry ? DUMMY_KEY : apiKey, ...(fake ? { baseUrl: `http://127.0.0.1:${fake.port}` } : {}) });

    wallStart = Date.now();
    const spawned = spawn("claude", buildClaudeArgs({ mcpConfig, settings: settingsFile, systemPrompt: sysPrompt }), { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    child = spawned;
    const closed = new Promise<void>((resolve) => spawned.once("close", (code, signal) => { run.exit_code = code; run.exit_signal = signal; run.exit_at_ms = Date.now() - wallStart; resolve(); }));
    let exited = false; void closed.then(() => { exited = true; });
    spawned.on("error", () => { run.spawn_error = true; harnessInvalid = true; });
    spawned.stdin!.on("error", () => undefined);
    spawned.stderr!.on("data", (chunk: Buffer) => { run.stderr_bytes += chunk.length; });
    let ending = false;
    const endInput = (reason: string): void => {
      if (ending) return;
      ending = true; run.end_reason = reason; run.stdin_ended_at_ms = Date.now() - wallStart;
      try { spawned.stdin!.end(); } catch { /* closed */ }
      void (async () => {
        if (await bound(closed, EXIT_GRACE_MS)) return;
        signalGroup(spawned, "SIGTERM");
        if (!(await bound(closed, 5000))) { signalGroup(spawned, "SIGKILL"); await bound(closed, 3000); }
      })();
    };
    let chain: Promise<void> = Promise.resolve();
    const onResult = async (): Promise<void> => {
      if (ending) return;
      const counters = parseCounters(await readFile(counterFile, "utf8").catch(() => ""));
      const decision = decideEnd(arm, counters);
      if (decision.end) endInput(decision.reason);
    };
    let pending = "";
    spawned.stdout!.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      for (let i = pending.indexOf("\n"); i >= 0; i = pending.indexOf("\n")) {
        const line = pending.slice(0, i); pending = pending.slice(i + 1);
        if (line && tracker.ingestLine(line)) chain = chain.then(onResult, onResult);
      }
    });
    spawned.stdin!.write(`${JSON.stringify({ type: "user", message: { role: "user", content: usrPrompt } })}\n`);

    const deadline = new Promise<"deadline">((resolve) => { const timer = setTimeout(() => resolve("deadline"), RUN_DEADLINE_MS); void closed.then(() => clearTimeout(timer)); });
    if ((await Promise.race([closed.then(() => "closed" as const), deadline])) === "deadline" && !exited) { run.timed_out = true; endInput("deadline"); }
    await closed;
    await chain.catch(() => undefined);

    // Hook and server processes may outlive the client by a moment; judge after a short grace period.
    leftoverAtExit = await processesReferencing(root);
    try { process.kill(-spawned.pid!, 0); groupAlive = true; } catch { groupAlive = false; }
    leftoverAfterGrace = leftoverAtExit;
    for (const end = Date.now() + 3000; leftoverAfterGrace.length > 0 && Date.now() < end;) { await sleep(150); leftoverAfterGrace = await processesReferencing(root); }
    for (const p of leftoverAfterGrace) { try { process.kill(p.pid, "SIGKILL"); } catch { /* gone */ } }
    signalGroup(spawned, "SIGKILL");

    // ---- collect (allowlisted fields only)
    finalCounters = parseCounters(await readFile(counterFile, "utf8").catch(() => ""));
    const events = readSpoolEvents(spool);
    const arrivals = [...tracker.assistantAt.values()];
    const terminals = events.filter((e) => e.kind === "turn_terminal");
    const waiters = await readJsonLines(waiterLog);
    collected.bridge = {
      events: events.map((e) => ({ seq: e.seq, at_ms: Date.parse(e.at) - wallStart, kind: e.kind, state: "state" in e ? e.state : null, via: "via" in e ? e.via : null, reason: e.kind === "instance_ended" ? e.reason : null })),
      claims: claimCount(spool),
      terminal_to_next_assistant_ms: terminals.map((e) => eventToNextAssistantMs(Date.parse(e.at) - wallStart, arrivals)),
      waiters: { started: waiters.length, by_reason: histogram(waiters.map((w) => String(w.reason))), exit_codes: histogram(waiters.map((w) => String(w.exit))) },
    };
    const receiptNames = (await readdir(receiptDir).catch(() => [] as string[])).filter((n) => n.endsWith(".txt"));
    const receipts = await Promise.all(receiptNames.map((n) => readFile(join(receiptDir, n), "utf8")));
    forbidden.push(...receipts.filter((r) => r.length >= 8));
    oracle = await runOracle(workspace, receipts);
    workspaceChanged = changedPaths(before, await snapshot(workspace)).length > 0;
  } catch { harnessInvalid = true; }
  finally {
    if (child) signalGroup(child, "SIGKILL");
    if (fake) { collected.fake_api = { main_requests: fake.stats.main, auxiliary_requests: fake.stats.auxiliary, wake_requests: fake.stats.wakeRequests, invalid: fake.stats.invalid, http_unexpected: fake.stats.httpUnexpected, steps: fake.stats.labels }; await fake.close().catch(() => undefined); }
    await temp.remove().catch(() => undefined);
    tempRemoved = !(await stat(root).then(() => true, () => false));
  }

  const stream = summarizeStream(tracker);
  const fakeInvalid = fake ? fake.stats.invalid : false;
  const polls = finalCounters?.pi_turn_get.running ?? null;
  const checks = {
    exited_cleanly: run.exit_code === 0 && !run.timed_out, no_harness_failure: !harnessInvalid && !fakeInvalid && !run.spawn_error,
    sessions_closed: finalCounters !== null && finalCounters.open_sessions === 0 && finalCounters.closes >= 1,
    no_leftover_process: leftoverAfterGrace.length === 0, temp_removed: tempRemoved, oracle_pass: oracle.status === "PASS", workspace_unchanged: workspaceChanged === false,
    no_json_errors: tracker.jsonErrors === 0, spool_failures_zero: finalCounters?.spool_failures === 0,
  };
  const outcome = harnessInvalid || run.spawn_error ? "harness_failure" : run.timed_out ? "timed_out" : "completed";
  const result: Record<string, unknown> = {
    schema_version: "bridge-live-1", dry_run: dry, case: "L1", arm, seq: input.seq, started_at: startedAt, ended_at: new Date().toISOString(), wall_ms: run.exit_at_ms,
    tooling: { client_version: input.clientVersion, client_version_matches_required: input.clientVersion === REQUIRED_CONTROLLER.client_version, node: process.versions.node, server_mode: dry ? "scripted" : "sdk", build_digest: await buildDigest(loc.buildRoot) },
    approval: dry ? { dry_run: true } : input.approval,
    prompts: { system_prompt_sha256: `sha256:${sha256Hex(sysPrompt)}`, system_prompt_bytes: Buffer.byteLength(sysPrompt), user_prompt_sha256: `sha256:${sha256Hex(usrPrompt)}`, controller_skill_fingerprint: input.skillFingerprint },
    run, stream,
    server: finalCounters === null ? null : { tools: finalCounters.tools, pi_turn_get: finalCounters.pi_turn_get, open_sessions_at_end: finalCounters.open_sessions, closes: finalCounters.closes, spool_failures: finalCounters.spool_failures,
      polls_running: polls, terminal_reads: finalCounters.pi_turn_get.terminal, bash_calls: tracker.toolUses.Bash ?? 0 },
    ...(collected.bridge ? { bridge: collected.bridge } : {}),
    ...(collected.fake_api ? { fake_api: collected.fake_api } : {}),
    oracle: { ...oracle, workspace_unchanged: workspaceChanged === false },
    cleanup: { leftover_at_exit: leftoverAtExit.length, leftover_after_grace: leftoverAfterGrace.length, leftover_kinds: histogram(leftoverAfterGrace.map((p) => p.kind)), process_group_alive_after_exit: groupAlive, temp_removed: tempRemoved },
    checks, outcome,
  };
  return { result, forbidden };
}

export async function runLive(options: LiveOptions): Promise<LiveSummary> {
  const loc = locate(), dry = options.dryRun;
  let approval: Record<string, unknown> = {}, apiKey = "";
  let clientVersion: string;
  const recorded = await recordedRuns(options.out, dry);
  if (!dry) {
    // Everything that can refuse happens here, before a process or a temporary directory exists.
    if (!options.approvalPath) throw new RefusedError("approval_required");
    const bytes = await readFile(options.approvalPath).catch(() => undefined);
    if (bytes === undefined) throw new RefusedError("approval_unreadable");
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString("utf8")) as unknown; } catch { throw new RefusedError("approval_unparseable"); }
    let headCommit: string, clean: boolean;
    try { headCommit = git(loc.repo, ["rev-parse", "HEAD"]).trim(); clean = dirtyLines(git(loc.repo, ["status", "--porcelain", "--untracked-files=all"])).length === 0; } catch { throw new RefusedError("git_unavailable"); }
    const check = validateApproval(parsed, { arm: options.arm, headCommit, worktreeClean: clean, runsRecorded: recorded });
    if (!check.ok) throw new RefusedError(check.reason);
    const credential = await readCredentialFile(process.env[API_KEY_FILE_ENV]);
    if (!credential.ok) throw new RefusedError(`credential_${credential.reason}`);
    apiKey = credential.value;
    clientVersion = installedClientVersion();
    if (clientVersion !== REQUIRED_CONTROLLER.client_version) throw new RefusedError("client_version_mismatch");
    const a = parsed as Record<string, unknown>;
    approval = { digest: approvalDigest(bytes), source_commit: headCommit, max_controller_runs: a.max_controller_runs, budget_usd_advisory: a.budget_usd_advisory, controller: REQUIRED_CONTROLLER, worker: REQUIRED_WORKER };
  } else {
    if (process.platform !== "linux") throw new RefusedError("unsupported_platform");
    if (!Object.values(networkInterfaces()).flat().every((i) => i?.internal === true)) throw new RefusedError("network_namespace_not_isolated");
    clientVersion = installedClientVersion();
    if (clientVersion === "unavailable") throw new RefusedError("client_unavailable");
    if (options.clientVersion !== undefined && clientVersion !== options.clientVersion) throw new RefusedError("client_version_mismatch");
  }
  const tree = await readSkillTree(join(loc.repo, "skills/pi-session-orchestration"));
  const skillText = formatEmbeddedSkillTree(tree);
  const seq = recorded + 1;
  await mkdir(options.out, { recursive: true });
  const { result, forbidden } = await executeRun({ options, loc, apiKey, clientVersion, seq, approval, skillText, skillFingerprint: String(tree.fingerprint) });
  let written: Record<string, unknown> = result;
  try { assertTopLevelAllowlist(result); assertOutputClean(result, forbidden); } catch {
    written = { schema_version: "bridge-live-1", dry_run: dry, case: "L1", arm: options.arm, seq, outcome: "output_validation_failed", checks: { output_validation: false } };
  }
  const file = join(options.out, `${dry ? "dry-" : ""}${String(seq).padStart(2, "0")}-L1-${options.arm}.json`);
  await writeFile(file, `${JSON.stringify(written, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return { file, seq, dryRun: dry, arm: options.arm, outcome: String(written.outcome), result: written };
}

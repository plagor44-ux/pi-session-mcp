import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseProductionConfig } from "./approval.js";
import { auditLog } from "./audit.js";
import { containmentSelfTest } from "./containment.js";
import { assertDependencyDir, checkTaskDependencies } from "./dependencies.js";
import { WaveDirGuard, removeTree, reportDiagnosticsFailure, writeDiagnostics } from "./evidence.js";
import { fixedCode } from "./classify.js";
import { PAIRINGS, buildMatrix } from "./matrix.js";
import { dnsServers } from "./network.js";
import { changedPaths } from "./oracles.js";
import { RUN_KEY_BYTES, macMatches } from "./output-mac.js";
import { boundTargets, planSandbox, type SandboxPlan } from "./sandbox.js";
import { MAX_LOG_BYTES, MAX_OUTPUT_BYTES, readRegularFile } from "./safe-read.js";
import type { ExtensionId, Pairing, ProfileId, TaskSpec } from "./schemas.js";
import { BUILD_ROOT, assertHostSafe, exitedCleanly, groupIsEmpty, killProcessGroup, startWithKey, supervise, tracedCommand } from "./supervise.js";
import { assertWaveDirOutsideSources, resolveTools, type ToolPaths } from "./tools.js";
import { countIoUringSetups } from "./trace.js";
import { prepareRunScope, privateRunDir, scopeRoot, type RunScope, type ScopeInput } from "./workspace.js";

const DRY_LOAD_TIMEOUT_MS = 3 * 60_000;
/** The fixture runtime's own provider and model, which replace the profile's in the dry-load config. */
export const DRY_PROVIDER = "dry-load";
export const DRY_MODEL = "dry-load-model";

/** What the dry-load entry writes, signed with the supervisor's per-run key. */
export const dryLoadOutputSchema = z.object({
  runId: z.string(), started: z.boolean(), startErrorCode: z.string().nullable(), activeTools: z.array(z.string()),
  providerCalls: z.number().int().nonnegative(), sessionsLeft: z.number().int().nonnegative(), harnessError: z.string().nullable(), mac: z.string().nullable(),
}).strict();
export type DryLoadOutput = z.infer<typeof dryLoadOutputSchema>;

export interface DryLoadPair {
  pairing: string;
  extension: ExtensionId;
  profile: ProfileId;
  /** The tool names active on the started session, sorted; empty when the session did not start. */
  activeTools: string[];
  /** Every tool the pairing grants is active (true when it grants none). */
  grantedOk: boolean;
  /** Repo-relative paths the session changed in the clone: the candidates for the tasks' `scopeIgnore`. Private: the report never goes to tracked evidence. */
  cloneWrites: string[];
  trace: {
    outsideWrites: number; unresolvedWrites: number; deniedWriteAttempts: number; unresolvedEgress: number; ioUringSetupsSucceeded: number;
    /** Informational (not part of `ok`): inet connect attempts of the loaded session. */
    connects: number;
  };
  /** Every inet destination the session connected to that is not name resolution; must be empty (R53). Private: addresses are allowed here only. */
  unexpectedConnects: { family: "inet" | "inet6"; address: string; port: number }[];
  /** A fixed code naming the first thing that went wrong; null when `ok`. */
  failure: string | null;
  ok: boolean;
}

export interface DryLoadReport {
  /**
   * The one deviation from a real run: the profile's provider and model are replaced by a fixture runtime's own, so that no credential is
   * needed and no provider can be called. Extension resolution, trust, tool composition and binding are the product's.
   */
  deviation: string;
  pairs: DryLoadPair[];
}

export interface DryLoadInput {
  /** The extension template: its `npm/` directory is copied into each scope's agent directory, as in a wave. */
  templateDir: string;
  tasks: TaskSpec[];
  productionConfig: unknown;
  waveDir: string;
  /** The operator's dependency directory (R68); required when a task that is loaded declares dependencies. */
  depsDir?: string | undefined;
}

export interface DryLoadDeps {
  /** Defaults to every pairing. */
  pairings?: readonly Pairing[] | undefined;
  prepareScope?: ((input: ScopeInput) => Promise<RunScope>) | undefined;
  /** Starts the traced dry-load entry in `scope`; the default runs the compiled entry through prlimit, strace and bubblewrap. */
  spawn?: ((scope: RunScope, inputPath: string, log: string) => ChildProcess) | undefined;
  resolveTools?: (() => Promise<ToolPaths>) | undefined;
  hostCheck?: (() => Promise<void>) | undefined;
  containmentCheck?: ((tools: ToolPaths, plan: SandboxPlan) => Promise<void>) | undefined;
  planSandbox?: ((tools: ToolPaths) => Promise<SandboxPlan>) | undefined;
  /** The read-only dependency checks of every task that declares dependencies (R68); the default reads the workspaces' git. */
  checkDependencies?: typeof checkTaskDependencies | undefined;
  residualCheck?: ((pgid: number) => Promise<boolean>) | undefined;
  changedPaths?: typeof changedPaths | undefined;
  removeTree?: ((path: string) => Promise<void>) | undefined;
  newKey?: (() => Uint8Array) | undefined;
  /** Absolute path of the compiled `dry-load-entry.js`; defaults to the one next to this module. */
  entry?: string | undefined;
  /** The disposable build the entry loads from, bound read-only into the sandbox; defaults to this module's build. */
  buildRoot?: string | undefined;
  repoRoot?: string | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

const DEVIATION = "Provider and model of each profile are replaced by a fixture runtime's own (dry-load/dry-load-model); no credential is used and every model call is refused.";
const startCode = (value: string | null): string => (value === null ? "start_failed" : `start_failed_${fixedCode(value, "unknown") ?? "unknown"}`);

/** Reads the entry's output and verifies schema, run id and MAC against the per-run key before anything in it is used (R35, R39). */
async function readVerifiedDryLoad(root: string, runId: string, key: Uint8Array): Promise<DryLoadOutput | "missing" | "tampered"> {
  let raw: string;
  try { raw = (await readRegularFile(join(root, "dry-load-output.json"), MAX_OUTPUT_BYTES)).toString("utf8"); } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "tampered";
  }
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return "tampered"; }
  const parsed = dryLoadOutputSchema.safeParse(json);
  if (!parsed.success || !macMatches(json as Record<string, unknown>, key) || parsed.data.runId !== runId) return "tampered";
  return parsed.data;
}

/**
 * Provider-free proof that each arm-B extension loads under pi-session-mcp as in a run (`projectTrusted: false`, the real resolver, the
 * real tool composition) from the evaluation template: one session per pairing is started in a prepared scope, under the same strace
 * and bubblewrap as a run, and closed again without a prompt. The report lists the active tools, what the session wrote to the clone and
 * the trace counts; the scope is removed afterwards as in a wave (R42).
 */
export async function dryLoad(input: DryLoadInput, deps: DryLoadDeps = {}): Promise<DryLoadReport> {
  const config = parseProductionConfig(input.productionConfig);
  const jobs = (deps.pairings ?? PAIRINGS).map((pairing) => {
    const run = buildMatrix(input.tasks, [pairing]).find((r) => r.arm === pairing.extension);
    if (!run) throw new Error("no_task_for_pairing");
    const task = input.tasks.find((t) => t.id === run.taskId)!;
    const profile = config.executionProfiles[pairing.profile];
    const source = config.workspaces[task.repo];
    if (profile === undefined || source === undefined) throw new Error("run_inputs_missing");
    return { pairing, run, task, profile, source };
  });
  const repoRoot = deps.repoRoot ?? process.cwd();
  await (deps.hostCheck ?? assertHostSafe)();
  const tools = await (deps.resolveTools ?? resolveTools)();
  await assertWaveDirOutsideSources(input.waveDir, [...Object.values(config.workspaces), repoRoot]);
  // Every task that declares dependencies is checked, not only the one each pairing loads: the dry load is where a wrong lock shows.
  const depsSources = [...Object.values(config.workspaces), repoRoot, input.waveDir];
  await assertDependencyDir(input.depsDir, input.tasks, depsSources);
  await (deps.checkDependencies ?? checkTaskDependencies)({ depsDir: input.depsDir, tasks: input.tasks, workspaces: config.workspaces, git: tools.git, sources: depsSources });
  const plan = await (deps.planSandbox ?? ((t: ToolPaths) => planSandbox({ tools: t, repoRoot, buildRoot: deps.buildRoot ?? BUILD_ROOT })))(tools);
  await (deps.containmentCheck ?? containmentSelfTest)(tools, plan);
  // The wave directory, `private` and `scopes` are pinned by device and inode; nothing is created or removed below them unless all three are intact.
  const guard = await WaveDirGuard.capture(input.waveDir);

  // Nothing of an earlier attempt may be overwritten or mixed in: refuse before anything starts.
  for (const { run } of jobs) if (existsSync(privateRunDir(input.waveDir, run.runId)) || existsSync(scopeRoot(input.waveDir, run.runId))) throw new Error("output_exists");

  const entry = deps.entry ?? fileURLToPath(new URL("./dry-load-entry.js", import.meta.url));
  const spawnEntry = deps.spawn ?? ((scope: RunScope, inputPath: string, log: string): ChildProcess => {
    const stderr = openSync(join(scope.root, "dry-load.stderr"), "a", 0o600);
    try {
      const { file, args } = tracedCommand(tools, plan, scope.root, log, inputPath, { workload: [process.execPath, "--disable-sigusr1", entry, inputPath], binds: scope.dependencyBinds ?? [] });
      return spawn(file, args, { cwd: scope.root, env: scope.env, detached: true, stdio: ["pipe", "ignore", stderr] });
    } finally { closeSync(stderr); }
  });
  const prepareScope = deps.prepareScope ?? prepareRunScope;
  const residualCheck = deps.residualCheck ?? groupIsEmpty;
  const diff = deps.changedPaths ?? changedPaths;
  const remove = deps.removeTree ?? removeTree;
  // No provider is contacted, so every inet destination is unexpected; only the resolver's nameservers are tolerated.
  const addresses = { providerAddresses: new Set<string>(), dnsAddresses: await dnsServers() };

  const pairs: DryLoadPair[] = [];
  for (const { pairing, run, task, profile, source } of jobs) {
    if (deps.signal?.aborted) throw new Error("interrupted");
    const privateRun = privateRunDir(input.waveDir, run.runId);
    const key = (deps.newKey ?? (() => randomBytes(RUN_KEY_BYTES)))();
    let scope: RunScope | undefined;
    let failure: string | null = null;
    let output: DryLoadOutput | null = null;
    let findings: Awaited<ReturnType<typeof auditLog>> = null;
    let ioUring = 0;
    let cloneWrites: string[] = [];
    let interrupted = false;
    let cleanupFailed = false;
    try {
      await guard.assertIntact();
      await mkdir(privateRun, { recursive: true, mode: 0o700 });
      scope = await prepareScope({
        waveDir: input.waveDir, run, task, sourceRepoPath: source, extensionTemplate: input.templateDir, hostAuth: {},
        productionProfile: { ...profile, provider: DRY_PROVIDER, model: DRY_MODEL }, skillCatalog: config.skillCatalog, pairing, tools,
        ...(input.depsDir === undefined ? {} : { depsDir: input.depsDir }),
      });
      const inputPath = join(scope.root, "dry-load-input.json");
      await writeFile(inputPath, JSON.stringify({ runId: run.runId, configPath: scope.configPath, workspaceAlias: "clone", profile: pairing.profile }), { mode: 0o600 });
      const log = join(privateRun, "strace.log");
      const child = spawnEntry(scope, inputPath, log);
      startWithKey(child, key);
      const supervised = await supervise(child, deps.timeoutMs ?? DRY_LOAD_TIMEOUT_MS, deps.signal);
      const residualClean = child.pid === undefined ? true : await residualCheck(child.pid);
      killProcessGroup(child.pid);
      interrupted = supervised.interrupted;
      const verified = await readVerifiedDryLoad(scope.root, run.runId, key);
      findings = await auditLog(log, [scope.root], scope.root, addresses, true, boundTargets(plan, scope.dependencyBinds));
      if (findings && (findings.outsideWrites.length > 0 || findings.unresolvedWrites > 0 || findings.unresolvedEgress > 0)) {
        // R84: the lines behind an unclean load are kept privately, as for a wave; the report stays as it is.
        try { await guard.assertIntact(); await writeDiagnostics(input.waveDir, run.runId, findings.evidenceLines); } catch (error) { reportDiagnosticsFailure(run.runId, error); }
      }
      try { ioUring = countIoUringSetups((await readRegularFile(log, MAX_LOG_BYTES)).toString("utf8")); } catch { /* no log: reported as trace_missing below */ }
      cloneWrites = await diff(scope.clone, { gitDir: scope.baseGitDir, commit: task.baseCommit }, []);
      if (supervised.timedOut) failure = "timeout";
      else if (supervised.interrupted) failure = "interrupted";
      else if (verified === "tampered") failure = "output_integrity";
      else if (verified === "missing") failure = "output_missing";
      else {
        output = verified;
        if (!exitedCleanly(supervised)) failure = "bad_exit";
        else if (!residualClean) failure = "residual_process";
        else if (verified.harnessError !== null) failure = fixedCode(verified.harnessError, "harness_error");
        else if (!verified.started) failure = startCode(verified.startErrorCode);
        else if (verified.providerCalls > 0) failure = "provider_call_attempted";
        else if (verified.sessionsLeft > 0) failure = "session_left_open";
      }
      if (failure === null && findings === null) failure = "trace_missing";
    } catch (error) {
      failure ??= fixedCode(error instanceof Error ? error.message : "") ?? "dry_load_step_failed";
    } finally {
      // R42: nothing derived from the session is kept beyond the report. Every ancestor must still be the pinned directory, or nothing is removed.
      try {
        await guard.assertIntact();
        await remove(privateRun);
        if (scope) await remove(scope.root);
      } catch { cleanupFailed = true; }
    }
    if (interrupted) throw new Error("interrupted");
    const activeTools = output?.started === true ? output.activeTools : [];
    const grantedOk = (pairing.grantedExtensionTools ?? []).every((tool) => activeTools.includes(tool));
    const trace = {
      outsideWrites: findings?.outsideWrites.length ?? 0, unresolvedWrites: findings?.unresolvedWrites ?? 0, deniedWriteAttempts: findings?.deniedWriteAttempts ?? 0,
      unresolvedEgress: findings?.unresolvedEgress ?? 0, ioUringSetupsSucceeded: ioUring, connects: findings?.connects ?? 0,
    };
    const clean = trace.outsideWrites === 0 && trace.unresolvedWrites === 0 && trace.deniedWriteAttempts === 0 && trace.unresolvedEgress === 0 && trace.ioUringSetupsSucceeded === 0;
    // R53: a provider-free load opens no connection but name resolution; the destinations are in this private report.
    const unexpectedConnects = findings?.unexpectedConnects.map((destination) => ({ ...destination })) ?? [];
    if (cleanupFailed) failure = "cleanup_failed";
    const ok = failure === null && grantedOk && clean && unexpectedConnects.length === 0;
    pairs.push({
      pairing: pairing.id, extension: pairing.extension, profile: pairing.profile, activeTools, grantedOk, cloneWrites, trace, unexpectedConnects,
      failure: ok ? null : failure ?? (!grantedOk ? "granted_tool_missing" : !clean ? "trace_not_clean" : "unexpected_connect"), ok,
    });
  }
  return { deviation: DEVIATION, pairs };
}

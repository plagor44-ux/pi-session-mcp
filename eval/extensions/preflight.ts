import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expiresWithin } from "../../src/writer-credentials.js";
import { parseProductionConfig, type Approval } from "./approval.js";
import { readVerifiedOutput } from "./audit.js";
import { fixedCode } from "./classify.js";
import { WaveDirGuard, removeTree } from "./evidence.js";
import { PersistedLedger, validSessionCost } from "./ledger-file.js";
import { routeAddresses } from "./network.js";
import { RUN_KEY_BYTES } from "./output-mac.js";
import { containmentSelfTest } from "./containment.js";
import { planSandbox, type SandboxPlan } from "./sandbox.js";
import type { RunOneInput, RunOutput } from "./run-one.js";
import { BUILD_ROOT, assertHostSafe, exitedCleanly, groupIsEmpty, killProcessGroup, spawnRunOne, startWithKey, supervise, type Supervised } from "./supervise.js";
import { assertWaveDirOutsideSources, resolveTools, type ToolPaths } from "./tools.js";
import { prepareEmptyScope, privateRunDir, scopeRoot, type RunScope } from "./workspace.js";

const PONG_PROMPT = "Reply with exactly: PONG";
const PREFLIGHT_TIMEOUT_MS = 3 * 60_000;
const CREDENTIAL_MARGIN_MINUTES = 20;

export interface PreflightRoute {
  profile: string;
  ok: boolean;
  terminal: string | null;
  costUsd: number | null;
  /** A fixed code; null when the route answered. */
  failure: string | null;
}

export interface PreflightInput {
  approval: Approval;
  waveDir: string;
  /** The evaluation's single budget ledger (R37). */
  ledgerPath: string;
  hostAuth: unknown;
  productionConfig: unknown;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  /** Root of the evaluation repository; a wave directory inside it is refused like one inside a workspace. */
  repoRoot?: string | undefined;
}

export interface PreflightDeps {
  spawnRun?: ((scope: RunScope, runInput: string) => ChildProcess) | undefined;
  resolveTools?: (() => Promise<ToolPaths>) | undefined;
  residualCheck?: ((pgid: number) => Promise<boolean>) | undefined;
  /** Resolves the route's endpoint; a failure fails that route (`provider_host_unresolvable`). */
  checkRoute?: ((route: { provider: string; model: string }) => Promise<unknown>) | undefined;
  hostCheck?: (() => Promise<void>) | undefined;
  containmentCheck?: ((tools: ToolPaths, plan: SandboxPlan) => Promise<void>) | undefined;
  planSandbox?: ((tools: ToolPaths) => Promise<SandboxPlan>) | undefined;
  now?: (() => number) | undefined;
}

const preflightFileSchema = z.object({
  binding: z.object({ sourceCommit: z.string(), tasksDigest: z.string(), matrixDigest: z.string() }).strict(),
  /** The id of the ledger this preflight spent from; the wave must continue that very ledger (R37b). */
  ledgerId: z.string().uuid(),
  routes: z.array(z.object({
    profile: z.string(), ok: z.boolean(), terminal: z.string().nullable(), costUsd: z.number().nullable(), failure: z.string().nullable(),
  }).strict()),
  spentUsd: z.number(),
}).strict();
export type PreflightFile = z.infer<typeof preflightFileSchema>;

/**
 * One PONG prompt per approved route on arm A. Each cost counts against the evaluation's ledger.
 * A route fails on any terminal other than `completed`; its pairings then have to be removed, which needs a new approval.
 */
export async function runPreflight(input: PreflightInput, deps: PreflightDeps = {}): Promise<{ routes: PreflightRoute[]; spentUsd: number }> {
  const now = deps.now ?? Date.now;
  const config = parseProductionConfig(input.productionConfig);
  await (deps.hostCheck ?? assertHostSafe)();
  const tools = await (deps.resolveTools ?? resolveTools)();
  await assertWaveDirOutsideSources(input.waveDir, [...Object.values(config.workspaces), input.repoRoot ?? process.cwd()]);
  const plan = await (deps.planSandbox ?? ((t: ToolPaths) => planSandbox({ tools: t, repoRoot: input.repoRoot ?? process.cwd(), buildRoot: BUILD_ROOT })))(tools);
  await (deps.containmentCheck ?? containmentSelfTest)(tools, plan);
  const names = input.approval.routes.map((route) => `preflight-${route.profile}`);
  if ([join(input.waveDir, "preflight.json"), ...names.flatMap((name) => [scopeRoot(input.waveDir, name), privateRunDir(input.waveDir, name)])].some((path) => existsSync(path))) {
    throw new Error("output_exists");
  }
  await mkdir(input.waveDir, { recursive: true, mode: 0o700 });
  const waveDir = await realpath(input.waveDir);
  const dirGuard = await WaveDirGuard.capture(waveDir);
  // The ledger is the evaluation's one budget: it must exist and be the approval's (R55), and this process holds it exclusively.
  const ledger = await PersistedLedger.openLocked(input.ledgerPath, input.approval.ledgerId);
  try {
  const results: PreflightRoute[] = [];
  const timeoutMs = input.timeoutMs ?? PREFLIGHT_TIMEOUT_MS;
  for (const route of input.approval.routes) {
    const fail = (failure: string, terminal: string | null = null, costUsd: number | null = null): void => {
      results.push({ profile: route.profile, ok: false, terminal, costUsd, failure });
    };
    const profile = config.executionProfiles[route.profile];
    if (!profile) { fail("profile_missing"); continue; }
    if (input.signal?.aborted) { fail("interrupted"); continue; }
    if (!ledger.ledger.allows(route.profile)) { fail("budget"); continue; }
    if (expiresWithin(input.hostAuth, [route.provider], CREDENTIAL_MARGIN_MINUTES, now())) { fail("credential_expiring"); continue; }
    try { await (deps.checkRoute ?? routeAddresses)(route); } catch (error) { fail(fixedCode(error instanceof Error ? error.message : "") ?? "provider_host_unresolvable"); continue; }
    const name = `preflight-${route.profile}`;
    const privateRun = privateRunDir(waveDir, name);
    const key = randomBytes(RUN_KEY_BYTES);
    let scope: RunScope | undefined;
    let executed = false;
    let charged = false;
    try {
      scope = await prepareEmptyScope({ waveDir, name, profile: route.profile, hostAuth: input.hostAuth, productionProfile: profile, skillCatalog: config.skillCatalog });
      const runOneInput: RunOneInput = {
        runId: name, configPath: scope.configPath, workspaceAlias: "clone", profile: route.profile, promptText: PONG_PROMPT,
        turnTimeoutMs: Math.max(1_000, timeoutMs - 30_000), privateDir: scope.privateDir,
      };
      const inputPath = join(scope.root, "run-input.json");
      await writeFile(inputPath, JSON.stringify(runOneInput), { mode: 0o600 });
      if (input.signal?.aborted) { fail("interrupted"); continue; }
      const child = (deps.spawnRun ?? ((sc: RunScope, ri: string) => spawnRunOne(tools, plan, sc, ri)))(scope, inputPath);
      executed = true;
      startWithKey(child, key);
      const supervised: Supervised = await supervise(child, timeoutMs, input.signal);
      const clean = child.pid === undefined ? true : await (deps.residualCheck ?? groupIsEmpty)(child.pid);
      killProcessGroup(child.pid);
      const verified = await readVerifiedOutput(scope.root, scope.privateDir, name, key);
      let output: RunOutput | null = null;
      let tampered = false;
      if (supervised.timedOut || supervised.interrupted) { /* not believed; the stop is the timeout or the interrupt */ }
      else if (verified.present && !exitedCleanly(supervised)) tampered = true;
      else ({ output, tampered } = verified);
      // Preflight costs are spend only (R54): they count toward the budget but never move the per-profile estimate. A real cost is
      // never lost: without a session total the assistant usage sum stands in, and without a trusted output the estimate is charged.
      // A session total with an invalid cost counts as missing (R62c).
      const sessionCost = validSessionCost(output?.usage.session);
      const cost = sessionCost ?? (output !== null ? validSessionCost(output.usage.assistant) ?? 0 : null);
      charged = true;
      await ledger.recordPreflight(name, route.profile, cost);
      const answered = output !== null && output.terminal === "completed" && output.harnessError === null && output.sessionsLeft === 0 && clean && !supervised.timedOut && !supervised.interrupted;
      // A completed PONG without a usable session total proves the cost-of-record path does not work for this route (I3).
      if (answered && sessionCost !== null) results.push({ profile: route.profile, ok: true, terminal: output?.terminal ?? null, costUsd: cost, failure: null });
      else {
        fail(
          tampered ? "output_integrity" : supervised.interrupted ? "interrupted" : supervised.timedOut ? "timeout" : !clean ? "cleanup_failure"
            : output === null ? "run_output_missing" : answered ? "usage_missing"
              : fixedCode(output.harnessError ?? output.usage.providerError ?? output.startErrorCode ?? output.terminal, "route_failed")!,
          output?.terminal ?? null, cost,
        );
      }
    } catch {
      if (!results.some((r) => r.profile === route.profile)) fail("preflight_step_failed");
    } finally {
      // A throw after the spawn still charges the estimate (R41) unless the cost was already recorded.
      if (executed && !charged) await ledger.recordPreflight(name, route.profile, null).catch(() => undefined);
      // R42: nothing derived from the worker is kept. A removal that fails (or an ancestor that was swapped) is not swallowed:
      // the route fails with `cleanup_failure`, which leaves `preflight.json` failing.
      try {
        await dirGuard.assertIntact();
        await removeTree(privateRun);
        if (scope) await removeTree(scope.root);
      } catch (error) {
        const failure = { profile: route.profile, ok: false, terminal: null, costUsd: null, failure: error instanceof Error && error.message === "wave_dir_tampered" ? "wave_dir_tampered" : "cleanup_failure" };
        const at = results.findIndex((r) => r.profile === route.profile);
        if (at >= 0) results[at] = failure; else results.push(failure);
      }
    }
  }
  await ledger.save();
  const file: PreflightFile = {
    ledgerId: ledger.id,
    binding: { sourceCommit: input.approval.sourceCommit, tasksDigest: input.approval.tasksDigest, matrixDigest: input.approval.matrixDigest },
    routes: results, spentUsd: ledger.ledger.spentUsd,
  };
  await writeFile(join(waveDir, "preflight.json"), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  return { routes: results, spentUsd: ledger.ledger.spentUsd };
  } finally {
    await ledger.release();
  }
}

/**
 * The wave may only start on a preflight of this very approval in which every approved route answered, and only on the ledger that
 * preflight spent from, holding a `preflight-<profile>` entry for every approved route (R37b).
 */
export async function assertPreflightPassed(preflightDir: string, approval: Approval, ledgerPath: string): Promise<void> {
  let json: unknown;
  try { json = JSON.parse(await readFile(join(preflightDir, "preflight.json"), "utf8")); } catch (error) {
    throw new Error((error as NodeJS.ErrnoException).code === "ENOENT" ? "preflight_missing" : "preflight_invalid");
  }
  const parsed = preflightFileSchema.safeParse(json);
  if (!parsed.success) throw new Error("preflight_invalid");
  const file = parsed.data;
  const { binding } = file;
  if (binding.sourceCommit !== approval.sourceCommit || binding.tasksDigest !== approval.tasksDigest || binding.matrixDigest !== approval.matrixDigest) {
    throw new Error("preflight_binding_changed");
  }
  const passed = new Set(file.routes.filter((route) => route.ok).map((route) => route.profile));
  if (approval.routes.some((route) => !passed.has(route.profile))) throw new Error("preflight_failed");
  const ledger = await PersistedLedger.openExisting(ledgerPath, approval.ledgerId);
  if (ledger.id !== file.ledgerId || approval.routes.some((route) => !ledger.hasEntry(`preflight-${route.profile}`))) throw new Error("ledger_mismatch");
}

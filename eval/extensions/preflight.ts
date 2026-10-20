import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expiresWithin } from "../../src/writer-credentials.js";
import { parseProductionConfig, type Approval } from "./approval.js";
import { readVerifiedOutput } from "./audit.js";
import { fixedCode } from "./classify.js";
import { boundarySecrets, writeEvidence } from "./evidence.js";
import { PersistedLedger, isValidCost } from "./ledger-file.js";
import { routeAddresses } from "./network.js";
import { RUN_KEY_BYTES } from "./output-mac.js";
import type { RunOneInput, RunOutput } from "./run-one.js";
import { assertHostSafe, exitedCleanly, groupIsEmpty, killProcessGroup, spawnRunOne, startWithKey, supervise, type Supervised } from "./supervise.js";
import { prepareEmptyScope, privateRunDir, scopeRoot, type RunScope } from "./workspace.js";

export const PONG_PROMPT = "Reply with exactly: PONG";
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
}

export interface PreflightDeps {
  spawnRun?: ((scope: RunScope, runInput: string) => ChildProcess) | undefined;
  residualCheck?: ((pgid: number) => Promise<boolean>) | undefined;
  /** Resolves the route's endpoint; a failure fails that route (`provider_host_unresolvable`). */
  checkRoute?: ((route: { provider: string; model: string }) => Promise<unknown>) | undefined;
  hostCheck?: (() => Promise<void>) | undefined;
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
  const names = input.approval.routes.map((route) => `preflight-${route.profile}`);
  if ([join(input.waveDir, "preflight.json"), ...names.flatMap((name) => [scopeRoot(input.waveDir, name), privateRunDir(input.waveDir, name)])].some((path) => existsSync(path))) {
    throw new Error("output_exists");
  }
  const ledger = await PersistedLedger.open(input.ledgerPath);
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
    const privateRun = privateRunDir(input.waveDir, name);
    const key = randomBytes(RUN_KEY_BYTES);
    const secrets = boundarySecrets(input.hostAuth, [route.provider]);
    let scope: RunScope | undefined;
    let executed = false;
    let rawOutput: string | null = null;
    try {
      scope = await prepareEmptyScope({ waveDir: input.waveDir, name, profile: route.profile, hostAuth: input.hostAuth, productionProfile: profile, skillCatalog: config.skillCatalog });
      const runOneInput: RunOneInput = {
        runId: name, configPath: scope.configPath, workspaceAlias: "clone", profile: route.profile, promptText: PONG_PROMPT,
        turnTimeoutMs: Math.max(1_000, timeoutMs - 30_000), privateDir: scope.privateDir,
      };
      const inputPath = join(scope.root, "run-input.json");
      await writeFile(inputPath, JSON.stringify(runOneInput), { mode: 0o600 });
      if (input.signal?.aborted) { fail("interrupted"); continue; }
      const child = (deps.spawnRun ?? spawnRunOne)(scope, inputPath);
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
      else { ({ output, tampered } = verified); if (output !== null) rawOutput = verified.raw; }
      const cost = output?.usage.session?.costUsd ?? null;
      if (output !== null && isValidCost(cost)) await ledger.record(name, route.profile, cost);
      else await ledger.recordEstimate(name, route.profile);
      const ok = output !== null && output.terminal === "completed" && output.harnessError === null && output.sessionsLeft === 0 && clean && !supervised.timedOut && !supervised.interrupted;
      if (ok) results.push({ profile: route.profile, ok: true, terminal: output?.terminal ?? null, costUsd: cost, failure: null });
      else {
        fail(
          tampered ? "output_integrity" : supervised.interrupted ? "interrupted" : supervised.timedOut ? "timeout" : !clean ? "cleanup_failure"
            : output === null ? "run_output_missing"
              : fixedCode(output.harnessError ?? output.usage.providerError ?? output.startErrorCode ?? output.terminal, "route_failed")!,
          output?.terminal ?? null, cost,
        );
      }
    } catch {
      if (!results.some((r) => r.profile === route.profile)) fail("preflight_step_failed");
    } finally {
      // Never keep a whole scope (R38): only the verified output stays, scanned for the boundary secrets.
      try { if (executed) await writeEvidence(privateRun, rawOutput === null ? {} : { "run-output.json": rawOutput }, secrets); } catch { /* the scope is removed regardless */ }
      if (scope) await rm(scope.root, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  await ledger.save();
  const file: PreflightFile = {
    ledgerId: ledger.id,
    binding: { sourceCommit: input.approval.sourceCommit, tasksDigest: input.approval.tasksDigest, matrixDigest: input.approval.matrixDigest },
    routes: results, spentUsd: ledger.ledger.spentUsd,
  };
  await mkdir(input.waveDir, { recursive: true, mode: 0o700 });
  await writeFile(join(input.waveDir, "preflight.json"), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  return { routes: results, spentUsd: ledger.ledger.spentUsd };
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
  const ledger = await PersistedLedger.open(ledgerPath);
  if (ledger.id !== file.ledgerId || approval.routes.some((route) => !ledger.hasEntry(`preflight-${route.profile}`))) throw new Error("ledger_mismatch");
}

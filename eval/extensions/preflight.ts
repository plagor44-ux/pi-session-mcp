import { randomBytes } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expiresWithin } from "../../src/writer-credentials.js";
import { parseProductionConfig, type Approval } from "./approval.js";
import { readVerifiedOutput } from "./audit.js";
import { fixedCode } from "./classify.js";
import { PersistedLedger, isValidCost } from "./ledger-file.js";
import { routeAddresses } from "./network.js";
import { RUN_KEY_BYTES } from "./output-mac.js";
import type { RunOneInput } from "./run-one.js";
import { groupIsEmpty, killProcessGroup, spawnRunOne, startWithKey, supervise } from "./supervise.js";
import { prepareEmptyScope, privateRunDir, scopeRoot, scrubCredentials, type RunScope } from "./workspace.js";

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
  now?: (() => number) | undefined;
}

export interface PreflightFile {
  binding: { sourceCommit: string; tasksDigest: string; matrixDigest: string };
  routes: PreflightRoute[];
  spentUsd: number;
}

/**
 * One PONG prompt per approved route on arm A. Each cost counts against the evaluation's ledger.
 * A route fails on any terminal other than `completed`; its pairings then have to be removed, which needs a new approval.
 */
export async function runPreflight(input: PreflightInput, deps: PreflightDeps = {}): Promise<{ routes: PreflightRoute[]; spentUsd: number }> {
  const now = deps.now ?? Date.now;
  const config = parseProductionConfig(input.productionConfig);
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
    let scope: RunScope | undefined;
    let executed = false;
    try {
      scope = await prepareEmptyScope({ waveDir: input.waveDir, name, profile: route.profile, hostAuth: input.hostAuth, productionProfile: profile, skillCatalog: config.skillCatalog });
      const runOneInput: RunOneInput = {
        runId: name, configPath: scope.configPath, workspaceAlias: "clone", profile: route.profile, promptText: PONG_PROMPT,
        turnTimeoutMs: Math.max(1_000, timeoutMs - 30_000), privateDir: scope.privateDir,
      };
      const inputPath = join(scope.root, "run-input.json");
      await writeFile(inputPath, JSON.stringify(runOneInput), { mode: 0o600 });
      if (input.signal?.aborted) { fail("interrupted"); await rm(scope.root, { recursive: true, force: true }); continue; }
      const child = (deps.spawnRun ?? spawnRunOne)(scope, inputPath);
      executed = true;
      startWithKey(child, key);
      const supervised = await supervise(child, timeoutMs, input.signal);
      const clean = child.pid === undefined ? true : await (deps.residualCheck ?? groupIsEmpty)(child.pid);
      killProcessGroup(child.pid);
      const { output, tampered } = await readVerifiedOutput(scope.root, scope.privateDir, name, key);
      const cost = output?.usage.session?.costUsd ?? null;
      await ledger.record(name, route.profile, isValidCost(cost) ? cost : null);
      const ok = output !== null && output.terminal === "completed" && output.harnessError === null && output.sessionsLeft === 0 && clean && !supervised.timedOut && !supervised.interrupted;
      if (ok) {
        results.push({ profile: route.profile, ok: true, terminal: output.terminal, costUsd: cost, failure: null });
        await rm(scope.root, { recursive: true, force: true }).catch(() => undefined);
      } else {
        fail(
          tampered ? "output_integrity" : supervised.interrupted ? "interrupted" : supervised.timedOut ? "timeout" : !clean ? "cleanup_failure"
            : output === null ? "run_output_missing"
              : fixedCode(output.harnessError ?? output.usage.providerError ?? output.startErrorCode ?? output.terminal, "route_failed")!,
          output?.terminal ?? null, cost,
        );
        // A kept scope never carries credentials.
        try { await scrubCredentials(scope.agentDir); } catch { await rm(scope.root, { recursive: true, force: true }); continue; }
        await mkdir(privateRun, { recursive: true, mode: 0o700 });
        await rename(scope.root, join(privateRun, "scope")).catch(() => undefined);
      }
    } catch {
      if (!results.some((r) => r.profile === route.profile)) fail("preflight_step_failed");
      if (scope && !executed) await rm(scope.root, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  const file: PreflightFile = {
    binding: { sourceCommit: input.approval.sourceCommit, tasksDigest: input.approval.tasksDigest, matrixDigest: input.approval.matrixDigest },
    routes: results, spentUsd: ledger.ledger.spentUsd,
  };
  await mkdir(input.waveDir, { recursive: true, mode: 0o700 });
  await writeFile(join(input.waveDir, "preflight.json"), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  return { routes: results, spentUsd: ledger.ledger.spentUsd };
}

/** The wave may only start on a preflight of this very approval in which every approved route answered. */
export async function assertPreflightPassed(preflightDir: string, approval: Approval): Promise<void> {
  let file: PreflightFile;
  try { file = JSON.parse(await readFile(join(preflightDir, "preflight.json"), "utf8")) as PreflightFile; } catch { throw new Error("preflight_missing"); }
  const { binding } = file;
  if (!binding || binding.sourceCommit !== approval.sourceCommit || binding.tasksDigest !== approval.tasksDigest || binding.matrixDigest !== approval.matrixDigest) {
    throw new Error("preflight_binding_changed");
  }
  const passed = new Set(file.routes.filter((route) => route.ok).map((route) => route.profile));
  if (approval.routes.some((route) => !passed.has(route.profile))) throw new Error("preflight_failed");
}

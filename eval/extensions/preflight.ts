import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expiresWithin } from "../../src/writer-credentials.js";
import type { Approval } from "./approval.js";
import { parseProductionConfig } from "./approval.js";
import { PersistedLedger } from "./ledger-file.js";
import type { RunOneInput } from "./run-one.js";
import { killProcessGroup, groupIsEmpty, readOutput, supervise } from "./wave.js";
import { prepareEmptyScope, type RunScope } from "./workspace.js";

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
  hostAuth: unknown;
  productionConfig: unknown;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export interface PreflightDeps {
  spawnRun?: ((scope: RunScope, runInput: string) => ChildProcess) | undefined;
  residualCheck?: ((pgid: number) => Promise<boolean>) | undefined;
  now?: (() => number) | undefined;
}

/** The run unit without `strace`: the PONG prompt touches no repository and only proves that the route answers. */
function spawnRunOne(scope: RunScope, runInput: string): ChildProcess {
  return spawn(process.execPath, [fileURLToPath(new URL("./run-one.js", import.meta.url)), runInput], {
    cwd: scope.root, env: scope.env, detached: true, stdio: "ignore",
  });
}

/**
 * One PONG prompt per approved route on arm A. Each cost counts against the same ledger file the wave continues from.
 * A route fails on any terminal other than `completed`; its pairings then have to be removed, which needs a new approval.
 */
export async function runPreflight(input: PreflightInput, deps: PreflightDeps = {}): Promise<{ routes: PreflightRoute[]; spentUsd: number }> {
  const now = deps.now ?? Date.now;
  const config = parseProductionConfig(input.productionConfig);
  const ledger = await PersistedLedger.open(input.waveDir);
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
    const name = `preflight-${route.profile}`;
    let scope: RunScope | undefined;
    try {
      scope = await prepareEmptyScope({ waveDir: input.waveDir, name, profile: route.profile, hostAuth: input.hostAuth, productionProfile: profile, skillCatalog: config.skillCatalog });
      const runOneInput: RunOneInput = {
        runId: name, configPath: scope.configPath, workspaceAlias: "clone", profile: route.profile, promptText: PONG_PROMPT,
        turnTimeoutMs: Math.max(1_000, timeoutMs - 30_000), privateDir: scope.privateDir,
      };
      const inputPath = join(scope.root, "run-input.json");
      await writeFile(inputPath, JSON.stringify(runOneInput), { mode: 0o600 });
      const child = (deps.spawnRun ?? spawnRunOne)(scope, inputPath);
      const supervised = await supervise(child, timeoutMs, input.signal);
      const clean = child.pid === undefined ? true : await (deps.residualCheck ?? groupIsEmpty)(child.pid);
      killProcessGroup(child.pid);
      const output = await readOutput(join(scope.root, "run-output.json"));
      const cost = output?.usage.session?.costUsd ?? null;
      await ledger.record(name, route.profile, cost).catch(() => ledger.record(name, route.profile, null));
      const ok = output !== null && output.terminal === "completed" && output.harnessError === null && output.sessionsLeft === 0 && clean && !supervised.timedOut && !supervised.interrupted;
      if (ok) {
        results.push({ profile: route.profile, ok: true, terminal: output.terminal, costUsd: cost, failure: null });
        await rm(scope.root, { recursive: true, force: true }).catch(() => undefined);
      } else {
        fail(supervised.interrupted ? "interrupted" : supervised.timedOut ? "timeout" : !clean ? "cleanup_failure" : output === null ? "run_output_missing" : output.harnessError ?? output.usage.providerError ?? output.startErrorCode ?? output.terminal, output?.terminal ?? null, cost);
        await mkdir(join(input.waveDir, "private", name), { recursive: true, mode: 0o700 });
        await rename(scope.root, join(input.waveDir, "private", name, "scope")).catch(() => undefined);
      }
    } catch { fail("preflight_step_failed"); }
  }
  await writeFile(join(input.waveDir, "preflight.json"), `${JSON.stringify({ routes: results, spentUsd: ledger.ledger.spentUsd }, null, 2)}\n`, { mode: 0o600 });
  return { routes: results, spentUsd: ledger.ledger.spentUsd };
}

import { stdoutGuard } from "./stdout-guard-install.js";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { runDoctor, type DoctorResult } from "./doctor.js";
import { createModelCatalog, type ModelCatalog } from "./model-catalog.js";
import type { PiSessionAdapter } from "./pi-adapter.js";
import { runProfileProbe } from "./profile-probe.js";
import { SdkPiSessionAdapter } from "./sdk-pi-adapter.js";
import { catalogReport, formatCatalogHuman, formatProbeHuman, type ProbeReport } from "./setup-probe-result.js";

export interface ProbeMainDependencies {
  readonly catalog?: () => Promise<ModelCatalog>;
  readonly adapter?: () => Promise<PiSessionAdapter>;
  readonly doctor?: () => Promise<DoctorResult>;
  readonly packageRoot?: string;
}

export async function runListModels(json: boolean, deps: ProbeMainDependencies = {}): Promise<number> {
  let report;
  try { report = catalogReport(await (deps.catalog ?? createModelCatalog)()); }
  catch { report = catalogReport(undefined); }
  stdoutGuard.transportStdout.write(json ? JSON.stringify(report) + "\n" : formatCatalogHuman(report));
  return report.exitCode;
}

function refused(apply: boolean, refusal: NonNullable<ProbeReport["refusal"]>): ProbeReport {
  return {
    schemaVersion: 1, operation: apply ? "apply" : "dry-run", status: "failed", refusal,
    doctor: { blocking: [], other: [] }, findings: [], usage: "unknown", exitCode: refusal === "operation_interrupted" ? 130 : 1,
  };
}

export async function runProbe(request: { profiles: readonly string[]; apply: boolean }, json: boolean, configPath: string, signal: AbortSignal, deps: ProbeMainDependencies = {}): Promise<number> {
  let report: ProbeReport;
  let catalogFailed = false;
  try {
    if (!configPath) report = refused(request.apply, "config_required");
    else {
      const configFile = resolve(configPath);
      const packageRoot = deps.packageRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
      report = await runProfileProbe(request, {
        configPath: configFile, loadConfig, signal,
        doctor: deps.doctor ?? (() => runDoctor({ packageRoot, configPath: configFile, loadConfig: () => loadConfig(configFile) })),
        catalog: async () => {
          try { return await (deps.catalog ?? createModelCatalog)(); }
          catch (error) { catalogFailed = true; throw error; }
        },
        adapter: deps.adapter ?? (async () => new SdkPiSessionAdapter({
          diagnosticSink: (diagnostic) => { process.stderr.write(JSON.stringify(diagnostic) + "\n"); },
          protectedReadPaths: [dirname(configFile), dirname(await realpath(configFile))],
        })),
        makeTempDir: async () => {
          const directory = await mkdtemp(join(tmpdir(), "pi-session-mcp-probe-"));
          try { await chmod(directory, 0o700); return directory; }
          catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
        },
        removeDir: (directory) => rm(directory, { recursive: true, force: true }),
      });
    }
  } catch {
    report = refused(request.apply, signal.aborted ? "operation_interrupted" : catalogFailed ? "catalog_unavailable" : "operation_failed");
  }
  if (signal.aborted) report = { ...report, status: "failed", refusal: "operation_interrupted", exitCode: signal.reason === 143 ? 143 : 130 };
  stdoutGuard.transportStdout.write(json ? JSON.stringify(report) + "\n" : formatProbeHuman(report));
  return report.exitCode;
}

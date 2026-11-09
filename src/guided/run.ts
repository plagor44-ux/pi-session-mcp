import { constants } from "node:fs";
import { chmod, copyFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { PricedModelCatalog } from "../model-catalog.js";
import { routingConfigPath, writeRoutingDocument } from "../routing/config.js";
import type { ModeRequest } from "../setup-modes.js";
import type { ProbeReport } from "../setup-probe-result.js";
import { result, type SetupFinding, type SetupResult, type SetupStatus, type SetupTarget } from "../setup-result.js";
import type { GuidedAnswers } from "./answers.js";
import { buildGuidedPlan, GuidedPlanError } from "./plan.js";

export interface GuidedDependencies {
  configPath: string;
  optionalFeatures(): Promise<{ podman: boolean; bubblewrap: boolean }>;
  catalog(): Promise<PricedModelCatalog>;
  doctor(configPath: string): Promise<{ ok: boolean }>;
  probe(profiles: readonly string[], configPath: string): Promise<ProbeReport>;
  changeMode(request: ModeRequest, configPath: string): Promise<SetupResult>;
  registrations(operation: "dry-run" | "apply" | "verify", targets: readonly SetupTarget[]): Promise<SetupResult>;
  signal?: AbortSignal;
  now?: () => Date;
}

async function readOptional(path: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as unknown; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
const documentBytes = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";

/** The exclusive claim records the owner; its sibling is a plain, Doctor-readable config.
 * Keep the claim until all work finishes, even after the candidate is renamed live.
 */
async function claimCandidate(path: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let file;
    try { file = await open(path, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let pid: unknown;
      try { pid = (JSON.parse(await readFile(path, "utf8")) as { pid?: unknown }).pid; }
      catch { return false; } // An incomplete or unreadable claim is not ours to remove.
      if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
      try { process.kill(pid, 0); return false; }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ESRCH") return false; }
      await rm(path);
      continue;
    }
    try { await file.writeFile(JSON.stringify({ pid: process.pid })); }
    catch (error) { await rm(path, { force: true }); throw error; }
    finally { await file.close(); }
    return true;
  }
  return false;
}

export async function runGuided(request: { apply: boolean; answers: GuidedAnswers }, deps: GuidedDependencies): Promise<SetupResult> {
  const operation = request.apply ? "apply" : "dry-run";
  const findings: SetupFinding[] = [];
  const add = (scope: string, alias: string, code: string, status: SetupStatus = "unchanged"): void => {
    findings.push({ target: { client: "guided", scope, alias }, status, code });
  };
  const stop = (code: string, scope = "plan", alias = "installation"): SetupResult => {
    add(scope, alias, code, "failed");
    return result(operation, findings, "failed", code === "operation_interrupted" ? deps.signal?.reason === 143 ? 143 : 130 : 1);
  };
  const check = (): void => { if (deps.signal?.aborted) throw new Error("operation_interrupted"); };
  const project = (report: SetupResult, scope: string, alias: string): boolean => {
    for (const finding of report.findings) add(scope, alias, finding.code, scope === "verification" && finding.status === "ok" ? "unchanged" : finding.status);
    return report.exitCode === 0 && report.status !== "failed";
  };
  const claim = `${deps.configPath}.guided-candidate`;
  const candidate = `${claim}.json`;
  let claimed = false;
  try {
    check();
    const existingConfig = await readOptional(deps.configPath);
    const existingRouting = await readOptional(routingConfigPath(deps.configPath));
    const plan = buildGuidedPlan(request.answers, { ...(existingConfig === undefined ? {} : { config: existingConfig }), ...(existingRouting === undefined ? {} : { routing: existingRouting }) });
    const optional = await deps.optionalFeatures(); check();
    if (!optional.podman) add("prerequisites", "podman", "podman_unavailable");
    if (!optional.bubblewrap) add("prerequisites", "bubblewrap", "bubblewrap_unavailable");
    if (existingConfig !== undefined && plan.targets.length) {
      const preflight = await deps.registrations("dry-run", plan.targets); check();
      if (preflight.findings.some((f) => f.code === "release_binding_mismatch")) return stop("upgrade_required", "registrations");
      if (preflight.findings.some((f) => f.status === "divergent")) return stop("registration_divergent", "registrations");
      if (preflight.exitCode !== 0) return stop("registration_preflight_failed", "registrations");
    }
    const catalog = await deps.catalog(); check();
    for (const profile of request.answers.profiles) {
      if (!catalog.providers().some((provider) => provider.id === profile.provider && provider.authConfigured)) {
        // No credential or arbitrary input is included in guidance or reports.
        const providerId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(profile.provider) ? profile.provider : "provider";
        return stop("provider_login_required", "providers", providerId);
      }
    }
    if (!request.apply) {
      add("config", "installation", plan.configChanged || plan.routingChanged ? "configuration_planned" : "configuration_unchanged", plan.configChanged || plan.routingChanged ? "planned" : "unchanged");
      for (const alias of plan.newProfiles) add("profiles", alias, "probe_planned", "planned");
      for (const mode of plan.modeRequests) add("modes", mode.alias, "mode_planned", "planned");
      for (const target of plan.targets) add("registrations", target.client, "registration_planned", "planned");
      return result(operation, findings, "planned");
    }
    await mkdir(dirname(deps.configPath), { recursive: true, mode: 0o700 }); check();
    claimed = await claimCandidate(claim);
    if (!claimed) return stop("guided_in_progress");
    check();
    // A stale owner's config is removed only after the exclusive claim is ours.
    await rm(candidate, { force: true });
    const file = await open(candidate, "wx", 0o600);
    try { await file.writeFile(documentBytes(plan.nextConfig)); } finally { await file.close(); }
    check();
    if (!(await deps.doctor(candidate)).ok) { check(); return stop("doctor_failed", "candidate"); }
    check();
    if (plan.newProfiles.length) {
      const probe = await deps.probe(plan.newProfiles, candidate); check();
      if (probe.refusal) return stop("probe_failed", "profiles");
      const failed = plan.newProfiles.filter((alias) => !probe.findings.some((finding) => finding.profile === alias && finding.status === "ok"));
      if (failed.includes(request.answers.defaultProfile)) return stop("default_profile_failed", "profiles", request.answers.defaultProfile);
      if (failed.length) {
        const profiles = plan.nextConfig.executionProfiles as Record<string, unknown>;
        const routing = plan.routingDocument as { families?: Record<string, unknown>; tiers?: Record<string, Record<string, string[]>> } | undefined;
        for (const alias of failed) {
          delete profiles[alias];
          if (routing?.families) delete routing.families[alias];
          for (const tier of Object.values(routing?.tiers ?? {})) for (const [role, aliases] of Object.entries(tier)) tier[role] = aliases.filter((value) => value !== alias);
          add("profiles", alias, "profile_dropped", "ok");
        }
        plan.modeRequests = plan.modeRequests.map((mode) => mode.container?.profiles
          ? { ...mode, container: { ...mode.container, profiles: mode.container.profiles.filter((alias) => !failed.includes(alias)) } }
          : mode);
        const emptyContainer = plan.modeRequests.find((mode) => mode.mode === "container" && mode.container?.profiles?.length === 0);
        if (emptyContainer) return stop("container_profiles_empty", "modes", emptyContainer.alias);
        // Mutate only the owned candidate, never the live configuration during probes.
        const updated = await open(candidate, "w", 0o600);
        try { await updated.writeFile(documentBytes(plan.nextConfig)); } finally { await updated.close(); }
        check();
        if (!(await deps.doctor(candidate)).ok) { check(); return stop("doctor_failed", "candidate"); }
        check();
      }
    }
    // This is the first point at which the live files may change.
    check();
    if (plan.configChanged) {
      if (existingConfig !== undefined) {
        const timestamp = (deps.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, "-");
        const backup = `${deps.configPath}.bak-guided-${timestamp}`;
        await copyFile(deps.configPath, backup, constants.COPYFILE_EXCL);
        await chmod(backup, 0o600);
      }
      check();
      await rename(candidate, deps.configPath);
    }
    if (plan.routingChanged && plan.routingDocument !== undefined) {
      check();
      if (existingRouting !== undefined) {
        const timestamp = (deps.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, "-");
        const path = routingConfigPath(deps.configPath);
        const backup = `${path}.bak-guided-${timestamp}`;
        await copyFile(path, backup, constants.COPYFILE_EXCL);
        await chmod(backup, 0o600);
      }
      check();
      await writeRoutingDocument(deps.configPath, plan.routingDocument);
    }
    add("config", "installation", plan.configChanged || plan.routingChanged ? "configuration_installed" : "configuration_unchanged", plan.configChanged || plan.routingChanged ? "ok" : "unchanged");
    for (const mode of plan.modeRequests) {
      check(); const report = await deps.changeMode(mode, deps.configPath); check();
      if (!project(report, "modes", mode.alias)) return stop("mode_failed", "modes", mode.alias);
    }
    if (plan.targets.length) {
      check(); const report = await deps.registrations("apply", plan.targets); check();
      if (!project(report, "registrations", "clients")) return stop("registration_failed", "registrations");
    }
    check();
    if (!(await deps.doctor(deps.configPath)).ok) { check(); return stop("doctor_failed", "verification"); }
    check();
    if (plan.targets.length) {
      const report = await deps.registrations("verify", plan.targets); check();
      if (!project(report, "verification", "clients")) return stop("verification_failed", "verification");
    }
    return result(operation, findings);
  } catch (error) {
    return stop(deps.signal?.aborted ? "operation_interrupted" : error instanceof GuidedPlanError ? error.code : "operation_failed");
  } finally {
    if (claimed) {
      try { await rm(candidate, { force: true }); }
      finally { await rm(claim, { force: true }); }
    }
  }
}

import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { CATALOG_ID_PATTERN, type PricedModelCatalog } from "../model-catalog.js";
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

/** Keep our immutable claim until all work finishes, even after the candidate is renamed live. */
async function claimCandidate(configPath: string): Promise<string | undefined> {
  const claim = `${configPath}.guided-claim-${randomUUID()}`;
  const temporary = `${configPath}.guided-tmp-${randomUUID()}`;
  let acquired = false;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify({ pid: process.pid })); }
    finally { await file.close(); }
    await rename(temporary, claim);
    // Publish before listing: if one run lists before another publishes, the later
    // run sees the earlier claim. Both cannot succeed (both may safely back off).
    let held = false;
    const directory = dirname(configPath);
    const prefix = `${basename(configPath)}.guided-claim-`;
    for (const entry of await readdir(directory)) {
      const other = join(directory, entry);
      if (!entry.startsWith(prefix) || entry === basename(claim)) continue;
      let pid: unknown;
      try { pid = (JSON.parse(await readFile(other, "utf8")) as { pid?: unknown }).pid; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") held = true;
        continue;
      }
      if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) { held = true; continue; }
      try { process.kill(pid, 0); held = true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") await rm(other, { force: true });
        else held = true;
      }
    }
    if (held) return undefined;
    acquired = true;
    return claim;
  } finally {
    try { await rm(temporary, { force: true }); }
    finally { if (!acquired) await rm(claim, { force: true }); }
  }
}

export async function runGuided(request: { apply: boolean; answers: GuidedAnswers }, deps: GuidedDependencies): Promise<SetupResult> {
  const operation = request.apply ? "apply" : "dry-run";
  const findings: SetupFinding[] = [];
  const add = (scope: string, alias: string, code: string, status: SetupStatus = "unchanged", cause?: string): void => {
    findings.push({ target: { client: "guided", scope, alias }, status, code, ...(cause === undefined ? {} : { cause }) });
  };
  const stop = (code: string, scope = "plan", alias = "installation", cause?: string): SetupResult => {
    add(scope, alias, code, "failed", cause);
    return result(operation, findings, "failed", code === "operation_interrupted" ? deps.signal?.reason === 143 ? 143 : 130 : 1);
  };
  const check = (): void => { if (deps.signal?.aborted) throw new Error("operation_interrupted"); };
  const project = (report: SetupResult, scope: string, alias: string): boolean => {
    for (const finding of report.findings) add(scope, alias, finding.code, scope === "verification" && finding.status === "ok" ? "unchanged" : finding.status);
    return report.exitCode === 0 && report.status !== "failed";
  };
  const candidate = `${deps.configPath}.guided-candidate.json`;
  let claim: string | undefined;
  try {
    check();
    for (const [alias, path] of [["config", deps.configPath], ["routing", routingConfigPath(deps.configPath)]] as const) {
      try { if (!(await lstat(path)).isFile()) return stop("config_not_regular", "config", alias); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const existingConfig = await readOptional(deps.configPath);
    const existingRouting = await readOptional(routingConfigPath(deps.configPath));
    const plan = buildGuidedPlan(request.answers, { ...(existingConfig === undefined ? {} : { config: existingConfig }), ...(existingRouting === undefined ? {} : { routing: existingRouting }) });
    plan.routingDocument = structuredClone(plan.routingDocument);
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
      const provider = catalog.providers().find((entry) => entry.id === profile.provider);
      if (!provider?.authConfigured) {
        // Only catalog ids, never arbitrary answer values, may enter reports.
        return stop("provider_login_required", "providers", provider && CATALOG_ID_PATTERN.test(provider.id) ? provider.id : "provider");
      }
      if (plan.newProfiles.includes(profile.alias) && !provider.models.includes(profile.model)) return stop("model_unknown", "profiles", profile.alias);
    }
    if (!request.apply) {
      add("config", "installation", plan.configChanged || plan.routingChanged ? "configuration_planned" : "configuration_unchanged", plan.configChanged || plan.routingChanged ? "planned" : "unchanged");
      for (const alias of plan.newProfiles) add("profiles", alias, "probe_planned", "planned");
      for (const mode of plan.modeRequests) add("modes", mode.alias, "mode_planned", "planned");
      for (const target of plan.targets) add("registrations", target.client, "registration_planned", "planned");
      return result(operation, findings, "planned");
    }
    // A dry run reports planned probes; only an apply needs the owner's approval to spend.
    if (plan.newProfiles.length && !request.answers.approveProbes) return stop("probes_not_approved", "profiles");
    await mkdir(dirname(deps.configPath), { recursive: true, mode: 0o700 }); check();
    claim = await claimCandidate(deps.configPath);
    if (!claim) return stop("guided_in_progress");
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
      // The adapter's code for a refused session start, otherwise the probe's own outcome code.
      const causeOf = (alias: string): string | undefined => {
        const finding = probe.findings.find((entry) => entry.profile === alias);
        return finding?.startCode ?? finding?.code;
      };
      const defaultProfile = request.answers.defaultProfile;
      for (const alias of plan.newProfiles) {
        if (!failed.includes(alias)) add("profiles", alias, "probe_passed", "ok");
        else if (alias !== defaultProfile) add("profiles", alias, "profile_dropped", "ok", causeOf(alias));
      }
      if (failed.includes(defaultProfile)) return stop("default_profile_failed", "profiles", defaultProfile, causeOf(defaultProfile));
      if (failed.length) {
        const profiles = plan.nextConfig.executionProfiles as Record<string, { permissionProfile?: unknown }>;
        const routing = plan.routingDocument as { families?: Record<string, unknown>; tiers?: Record<string, Record<string, string[]>> } | undefined;
        const droppedCoding = failed.some((alias) => profiles[alias]?.permissionProfile === "coding");
        for (const alias of failed) {
          delete profiles[alias];
          if (routing?.families) delete routing.families[alias];
          for (const tier of Object.values(routing?.tiers ?? {})) for (const [role, aliases] of Object.entries(tier)) tier[role] = aliases.filter((value) => value !== alias);
        }
        plan.configChanged = !isDeepStrictEqual(existingConfig, plan.nextConfig);
        plan.routingChanged = !isDeepStrictEqual(existingRouting, plan.routingDocument);
        plan.modeRequests = plan.modeRequests.map((mode) => mode.container?.profiles
          ? { ...mode, container: { ...mode.container, profiles: mode.container.profiles.filter((alias) => !failed.includes(alias)) } }
          : mode);
        const emptyContainer = plan.modeRequests.find((mode) => mode.mode === "container" && mode.container?.profiles?.length === 0);
        if (emptyContainer) return stop("container_profiles_empty", "modes", emptyContainer.alias);
        // The owner accepted a coding profile; an installation that cannot code is not what they chose.
        if (droppedCoding && !Object.values(profiles).some((profile) => profile?.permissionProfile === "coding")) return stop("coding_profiles_dropped", "profiles");
        // Mutate only the owned candidate, never the live configuration during probes.
        await rm(candidate, { force: true });
        const updated = await open(candidate, "wx", 0o600);
        try { await updated.writeFile(documentBytes(plan.nextConfig)); } finally { await updated.close(); }
        check();
        if (!(await deps.doctor(candidate)).ok) { check(); return stop("doctor_failed", "candidate"); }
        check();
      }
    }
    // This is the first point at which the live files may change.
    check();
    const currentConfig = await readOptional(deps.configPath);
    const currentRouting = await readOptional(routingConfigPath(deps.configPath));
    if (!isDeepStrictEqual(existingConfig, currentConfig) || !isDeepStrictEqual(existingRouting, currentRouting)) return stop("config_changed_during_run", "config");
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
    if (claim) {
      try { await rm(candidate, { force: true }); }
      finally { await rm(claim, { force: true }); }
    }
  }
}

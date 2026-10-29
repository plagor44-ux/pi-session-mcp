import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { loadConfig } from "./config.js";
import { MAX_WRITERS, type ContainerSettings, type WorkspaceModeEntry } from "./execution-modes.js";
import type { ModeRequest } from "./setup-modes.js";
import { result, type SetupFinding, type SetupOperation, type SetupResult } from "./setup-result.js";
import { skillOverrideDirectory } from "./skill-library.js";
import { sameWriterLimits, writerLimits } from "./writer-limits.js";
import type * as lifecycle from "./writer-lifecycle.js";
import { readWriterState, writerName } from "./writer-state.js";
import { codeFor, context, doctorGate, FENCE_CODES, fenced, modesTarget, preflight, services, targetFor, writerIndex, type WriterPlan, type WriterSetupDependencies } from "./setup-writers-common.js";

/** Base inference, the settings check and the plans a mode change shows or checks before it writes the modes file. */

export type SettingsDrift = (name: string, ctx?: lifecycle.WriterContext) => Promise<lifecycle.WriterOutcome | undefined>;
/** What a writer's configuration is rendered from: the raw configuration file and the skill override directory. */
export interface RenderInputs { readonly rawConfig: unknown; readonly overrideDirectory: string }

export async function renderInputs(configPath: string): Promise<RenderInputs> {
  return { rawConfig: JSON.parse(await readFile(configPath, "utf8")) as unknown, overrideDirectory: skillOverrideDirectory(configPath) };
}

/**
 * The one settings check (#134, #163) of the pre-write gate, the dry run and reconciliation: whether a writer's
 * provisioned settings or rendered configuration differ from `settings`. Reconcile passes its fenced context per writer.
 */
export function settingsDriftCheck(inputs: RenderInputs, ctx: lifecycle.WriterContext, settings: ContainerSettings, deps: WriterSetupDependencies): SettingsDrift {
  const { life } = services(deps);
  return (name, scoped = ctx) => life.writerSettingsDrift(scoped, { index: writerIndex(name), settings, ...inputs });
}

/**
 * The request as the modes file should record it: `--base` as provisioning resolves it, so a refused or
 * remote-tracking form never reaches the modes file; without `--base`, the one base the existing writers share, or
 * for a first provisioning the base it will resolve (origin/HEAD, else main), so default starts find writers.
 * Returns a refusal instead when the base cannot be resolved or existing writers disagree.
 */
export async function inferBase(configPath: string, request: ModeRequest, deps: WriterSetupDependencies, containerRuntime: () => Promise<boolean>, failed: (code: string) => SetupResult): Promise<ModeRequest | SetupResult> {
  const operation = request.apply ? "apply" : "dry-run";
  if (request.baseRef !== undefined) {
    try { return { ...request, baseRef: await services(deps).life.baseBranchName(await context(request.alias, deps), request.baseRef) }; }
    catch (error) { return failed(codeFor(error)); }
  }
  if (!(request.mode === "container" || request.mode === undefined && await containerRuntime())) return request;
  const config = await loadConfig(configPath);
  if (config.workspaceModes.get(request.alias)?.container?.base) return request;
  const bases = new Set<string>();
  for (let index = 1; index <= MAX_WRITERS; index++) {
    const state = await readWriterState(deps.home ?? homedir(), writerName(request.alias, index));
    if (state) bases.add(state.base.ref);
  }
  if (bases.size > 1) return result(operation, [{ target: modesTarget(request.alias), status: "failed", code: "workspace_base_ambiguous" }]);
  if (bases.size === 1) return { ...request, baseRef: [...bases][0]!.replace(/^refs\/heads\//, "") };
  if (request.mode !== "container") return request;
  try { return { ...request, baseRef: await services(deps).life.baseBranchName(await context(request.alias, deps)) }; }
  catch (error) { return failed(codeFor(error)); }
}

/**
 * Apply only: the Doctor gate, a fence and the destructive-work refusal for each surplus writer, and the settings
 * check of kept writers before the write, so a kept writer with changed settings refuses the mode change itself and
 * the modes file never records a mode no writer matches (#163). Read-only like the dry run, which fences nothing;
 * reconcile re-checks under its fence. Missing writers have no settings yet. Returns a refusal or `undefined`.
 */
export async function gateBeforeWrite(configPath: string, ctx: lifecycle.WriterContext, entry: WorkspaceModeEntry, planned: WriterPlan, discard: boolean, operation: SetupOperation, deps: WriterSetupDependencies): Promise<SetupResult | undefined> {
  await doctorGate(ctx, deps);
  for (const name of planned.surplus) {
    try { await fenced(ctx, name, deps, (leased) => preflight(leased, [name], discard, deps)); }
    catch (error) {
      // Refuse the mode change, but name the writer that could not be fenced.
      if (FENCE_CODES.includes(codeFor(error))) return result(operation, [{ target: targetFor(ctx.alias, name), status: "failed", code: codeFor(error) }]);
      throw error;
    }
  }
  if (entry.mode !== "container") return undefined;
  const drift = settingsDriftCheck(await renderInputs(configPath), ctx, entry.container!, deps);
  const drifted: SetupFinding[] = [];
  for (const name of planned.keep) {
    if (planned.missing.includes(name)) continue;
    const outcome = await drift(name);
    if (outcome) drifted.push({ target: targetFor(ctx.alias, name), ...outcome });
  }
  return drifted.length ? result(operation, drifted) : undefined;
}

/** The dry run's writer plan: kept writers with the same settings check as apply (#134), then the surplus to remove. */
export async function plannedWriters(configPath: string, ctx: lifecycle.WriterContext, proposed: WorkspaceModeEntry, planned: WriterPlan, deps: WriterSetupDependencies): Promise<SetupResult> {
  const drift = settingsDriftCheck(await renderInputs(configPath), ctx, proposed.container!, deps);
  const kept: SetupFinding[] = [];
  for (const name of planned.keep) {
    const outcome = await drift(name);
    const state = await readWriterState(ctx.home, name);
    const updatingLimits = state && state.phase !== "provisioning" && !sameWriterLimits(state.limits, writerLimits(proposed.container!));
    kept.push({ target: targetFor(ctx.alias, name), ...(outcome ?? { status: "planned" as const, code: updatingLimits ? "writer_limits_update_planned" : "writer_planned" }) });
  }
  const refused = kept.some((finding) => finding.status === "failed" || finding.status === "divergent");
  return result("dry-run", [...kept, ...planned.surplus.map((name) => ({ target: targetFor(ctx.alias, name), status: "planned" as const, code: "writer_remove_planned" }))], refused ? "failed" : "planned");
}

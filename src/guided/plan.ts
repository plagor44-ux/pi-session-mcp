import { isDeepStrictEqual } from "node:util";
import type { ModeRequest } from "../setup-modes.js";
import type { ContainerSettings } from "../execution-modes.js";
import type { SetupChange, SetupTarget } from "../setup-result.js";
import { ROLES, TIERS } from "../routing/config.js";
import type { GuidedAnswers } from "./answers.js";

export type GuidedPlanErrorCode = "container_profiles_invalid" | "config_change_not_allowed" | "profile_alias_conflict" | "workspace_alias_conflict" | "host_writes_not_accepted" | "routing_requires_history" | "default_profile_unknown" | "default_profile_conflict" | "routing_profile_conflict";
export class GuidedPlanError extends Error {
  /** `plan` accompanies `config_change_not_allowed`: the plan that the refusal withholds, so a dry run can still show it. */
  constructor(readonly code: GuidedPlanErrorCode, readonly plan?: GuidedPlan) { super(code); this.name = "GuidedPlanError"; }
}
export interface GuidedPlan {
  nextConfig: Record<string, unknown>;
  configChanged: boolean;
  newProfiles: readonly string[];
  routingDocument: unknown | undefined;
  routingChanged: boolean;
  modeRequests: readonly ModeRequest[];
  targets: readonly SetupTarget[];
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function buildGuidedPlan(answers: GuidedAnswers, existing: { config?: unknown; routing?: unknown }): GuidedPlan {
  const original = record(existing.config);
  const oldProfiles = record(original.executionProfiles);
  const oldWorkspaces = record(original.workspaces);
  if (!Object.hasOwn(oldProfiles, answers.defaultProfile) && !answers.profiles.some((p) => p.alias === answers.defaultProfile)) throw new GuidedPlanError("default_profile_unknown");
  const oldDefault = Object.entries(oldProfiles).find(([, value]) => record(value).default === true)?.[0];
  if (oldDefault !== undefined && oldDefault !== answers.defaultProfile) throw new GuidedPlanError("default_profile_conflict");
  if (answers.routing.mode === "auto" && !answers.history.enabled) throw new GuidedPlanError("routing_requires_history");
  const profiles = { ...oldProfiles };
  const workspaces = { ...oldWorkspaces };
  const newProfiles: string[] = [];
  for (const p of answers.profiles) {
    const proposed = { default: oldDefault === undefined && p.alias === answers.defaultProfile, permissionProfile: p.role === "code" ? "coding" : "read-only", provider: p.provider, model: p.model, thinkingLevel: p.thinkingLevel };
    if (Object.hasOwn(profiles, p.alias)) {
      const current = record(profiles[p.alias]);
      if (!Object.entries(proposed).every(([key, value]) => key === "default" ? current[key] === (p.alias === answers.defaultProfile) : current[key] === value)) throw new GuidedPlanError("profile_alias_conflict");
    } else { profiles[p.alias] = proposed; newProfiles.push(p.alias); }
  }
  const modeRequests: ModeRequest[] = [];
  for (const workspace of answers.workspaces) {
    if (workspace.mode === "container" && (!workspace.container?.profiles?.length || workspace.container.profiles.some((alias) => record(profiles[alias]).permissionProfile !== "coding"))) throw new GuidedPlanError("container_profiles_invalid");
    if (workspace.mode === "host" && workspace.acceptHostWrites !== true) throw new GuidedPlanError("host_writes_not_accepted");
    if (Object.hasOwn(workspaces, workspace.alias) && workspaces[workspace.alias] !== workspace.path) throw new GuidedPlanError("workspace_alias_conflict");
    workspaces[workspace.alias] = workspace.path;
    modeRequests.push({ alias: workspace.alias, mode: workspace.mode, acceptHostWrites: workspace.acceptHostWrites === true, apply: true, ...(workspace.container === undefined ? {} : { container: Object.fromEntries(Object.entries(workspace.container).filter(([, value]) => value !== undefined)) as Partial<ContainerSettings> }) });
  }
  const nextConfig: Record<string, unknown> = { ...original, workspaces, executionProfiles: profiles, history: { ...record(original.history), enabled: answers.history.enabled }, ...(answers.clients.claudeCode ? { events: { ...record(original.events), delivery: "spool" } } : {}) };
  const configChanged = !isDeepStrictEqual(existing.config, nextConfig);
  const oldRouting = record(existing.routing);
  const oldTiers = record(oldRouting.tiers);
  const tiers = { ...oldTiers };
  const families = { ...record(oldRouting.families) };
  for (const p of answers.profiles) {
    if (p.tier === null) continue;
    if (Object.hasOwn(families, p.alias) && families[p.alias] !== p.family) throw new GuidedPlanError("routing_profile_conflict");
    for (const tier of TIERS) for (const role of ROLES) {
      const list = record(oldTiers[tier])[role];
      if ((tier !== p.tier || (role === "code") !== (p.role === "code")) && Array.isArray(list) && list.includes(p.alias)) throw new GuidedPlanError("routing_profile_conflict");
    }
    const cells = { ...record(tiers[p.tier]) };
    const list = Array.isArray(cells[p.role]) ? cells[p.role] as unknown[] : [];
    if (!list.includes(p.alias)) cells[p.role] = [...list, p.alias];
    tiers[p.tier] = cells;
    families[p.alias] = p.family;
  }
  const hasAssignments = answers.profiles.some((p) => p.tier !== null);
  const routingDocument = existing.routing === undefined && !hasAssignments && answers.routing.mode === "off" ? undefined : { ...oldRouting, mode: answers.routing.mode, ...(hasAssignments || oldRouting.tiers !== undefined ? { tiers } : {}), ...(hasAssignments || oldRouting.families !== undefined ? { families } : {}) };
  const routingChanged = !isDeepStrictEqual(existing.routing, routingDocument);
  const targets: SetupTarget[] = [];
  if (answers.clients.claudeCode) targets.push({ client: "claude-code", scope: "user", alias: "pi-session-mcp" });
  if (answers.clients.codex) targets.push({ client: "codex", scope: "user", alias: "pi-session-mcp" });
  const plan: GuidedPlan = { nextConfig, configChanged, newProfiles, routingDocument, routingChanged, modeRequests, targets };
  if (!answers.allowConfigChange && ((existing.config !== undefined && configChanged) || (existing.routing !== undefined && routingChanged))) throw new GuidedPlanError("config_change_not_allowed", plan);
  return plan;
}

/**
 * Key paths at which a document gains or changes a value, down to `depth` segments: `executionProfiles.<alias>` stops at the alias,
 * `history.enabled` at the field. A key that only the new document has and that holds an object is listed below its parent, as
 * if the old document held an empty object there. Values never leave this function; paths consist of the keys that the plan itself
 * sets (field names and aliases).
 */
function diffPaths(file: "config" | "routing", before: unknown, after: unknown, depth: number, prefix: readonly string[] = []): SetupChange[] {
  const old = record(before), next = record(after), changes: SetupChange[] = [];
  for (const key of new Set([...Object.keys(next), ...Object.keys(old)])) {
    if (isDeepStrictEqual(old[key], next[key])) continue;
    const path = [...prefix, key];
    const nested = path.length < depth && next[key] !== null && typeof next[key] === "object" && !Array.isArray(next[key]) && (old[key] === undefined || (old[key] !== null && typeof old[key] === "object" && !Array.isArray(old[key])));
    if (nested) changes.push(...diffPaths(file, old[key], next[key], depth, path));
    else changes.push({ file, kind: !Object.hasOwn(old, key) ? "add" : !Object.hasOwn(next, key) ? "remove" : "change", path: path.join(".") });
  }
  return changes;
}

/**
 * The preview of a guided dry run for the owner: what the plan would add to or change in the configuration and routing files,
 * which workspace modes it sets and which client registrations it makes. Paths and values of the owner's system stay out: entries
 * name fields and aliases only. Mode and client entries state what the answers set; the dry run does not compare them with the
 * current state, so they are always `change`.
 */
export function plannedChanges(plan: GuidedPlan, existing: { config?: unknown; routing?: unknown }): SetupChange[] {
  return [
    ...diffPaths("config", existing.config, plan.nextConfig, 2),
    ...(plan.routingDocument === undefined ? [] : diffPaths("routing", existing.routing, plan.routingDocument, 3)),
    ...plan.modeRequests.map((mode): SetupChange => ({ file: "modes", kind: "change", path: `workspaces.${mode.alias}` })),
    ...plan.targets.map((target): SetupChange => ({ file: "client", kind: "change", path: `${target.client}.${target.alias}` })),
  ];
}

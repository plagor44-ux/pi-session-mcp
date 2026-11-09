import { codingAllowed, type WorkspaceModeEntry } from "../execution-modes.js";
import type { ConfiguredExecutionProfile } from "../execution-profile.js";
import { TIERS, tierRank, type Role, type RoutingConfig, type Tier } from "./config.js";
import type { DecisionInput } from "./store.js";

export type RoutingErrorCode = "routing_off" | "routing_profile_conflict" | "routing_role_required" | "routing_tier_below_floor" | "routing_no_candidate" | "routing_same_family" | "routing_author_required";
export class RoutingError extends Error {
  constructor(readonly code: RoutingErrorCode) {
    super(code);
    this.name = "RoutingError";
  }
}

export interface RoutingRequest {
  workspace: string;
  executionProfile?: string;
  tier?: Tier;
  role?: Role;
  risk?: "normal" | "high";
  shell?: boolean;
  authorFamily?: string;
  allowSameFamily?: boolean;
}
export interface SelectionContext {
  config: RoutingConfig;
  profiles: ReadonlyMap<string, ConfiguredExecutionProfile>;
  defaultProfile: string;
  workspaceMode: WorkspaceModeEntry;
  relay: boolean;
  order(tier: Tier, role: Role): readonly string[] | undefined;
  suspended: ReadonlySet<string>;
  exploration: { allowed: boolean; rate: number; random(): number };
}
export interface RoutedStart {
  alias: string;
  decision?: Omit<DecisionInput, "sessionRef" | "decidedAt">;
  result?: { tier: Tier; role: Role; profile: string; reason: "floor" | "raised" | "lower_tier_review"; exploration: boolean };
}

export function floorFor(config: RoutingConfig, role: Role, risk: "normal" | "high", workspace: string): Tier {
  let floor = config.floors[role];
  const workspaceFloor = config.floors.workspaces.get(workspace);
  if (workspaceFloor !== undefined && tierRank(workspaceFloor) > tierRank(floor)) floor = workspaceFloor;
  if (risk === "high" && tierRank(config.floors.riskHigh) > tierRank(floor)) floor = config.floors.riskHigh;
  return floor;
}

function candidatesFor(tier: Tier, role: Role, request: RoutingRequest, context: SelectionContext): string[] {
  const listed = context.config.tiers[tier][role];
  const stored = context.order(tier, role) ?? [];
  const order = [...new Set([...stored.filter((alias) => listed.includes(alias)), ...listed])];
  return order.filter((alias) => {
    const profile = context.profiles.get(alias);
    if (!profile || context.suspended.has(alias)) return false;
    if (profile.permissionProfile !== (role === "code" ? "coding" : "read-only")) return false;
    const mode = context.workspaceMode;
    if (role === "code" && !codingAllowed(mode, context.relay)) return false;
    if (mode.mode === "container" && !mode.container?.profiles.includes(alias)) return false;
    if (mode.mode === "snapshot" && ((profile.extensions?.length ?? 0) > 0 || (profile.grantedExtensionTools?.length ?? 0) > 0 || Object.keys(profile.mcpServers ?? {}).length > 0)) return false;
    return !request.shell || profile.shell === "sandboxed";
  });
}

export function routeStart(request: RoutingRequest, context: SelectionContext): RoutedStart {
  const { config } = context;
  if (request.executionProfile !== undefined && request.tier !== undefined) throw new RoutingError("routing_profile_conflict");
  if (request.executionProfile !== undefined || (request.tier === undefined && request.role === undefined)) {
    const alias = request.executionProfile ?? context.defaultProfile;
    if (config.mode === "off") return { alias };
    const tier = request.executionProfile !== undefined && request.role !== undefined
      ? TIERS.find((tier) => config.tiers[tier][request.role!].includes(alias)) ?? null
      : null;
    return { alias, decision: {
      tier, role: tier === null ? null : request.role!, risk: "normal", profile: alias,
      family: config.families.get(alias) ?? null,
      origin: request.executionProfile !== undefined ? "explicit" : "default",
      exploration: false, sameFamilyOverride: false,
    } };
  }
  if (config.mode === "off") throw new RoutingError("routing_off");
  if (request.role === undefined) throw new RoutingError("routing_role_required");
  const role = request.role;
  const risk = request.risk ?? "normal";
  const floor = floorFor(config, role, risk, request.workspace);
  let tier = request.tier ?? floor;
  if (tierRank(tier) < tierRank(floor)) throw new RoutingError("routing_tier_below_floor");
  if (role === "review" && request.authorFamily === undefined && !request.allowSameFamily) throw new RoutingError("routing_author_required");
  let reason: NonNullable<RoutedStart["result"]>["reason"] = tierRank(tier) > tierRank(floor) ? "raised" : "floor";
  let candidates = candidatesFor(tier, role, request, context);
  if (candidates.length === 0) throw new RoutingError("routing_no_candidate");
  let sameFamilyOverride = false;
  if (role === "review") {
    const otherFamilies = (aliases: readonly string[]): string[] => aliases.filter((alias) => config.families.get(alias) !== request.authorFamily);
    const different = otherFamilies(candidates);
    if (request.authorFamily === undefined) {
      sameFamilyOverride = true;
    } else if (different.length > 0) {
      candidates = different;
    } else if (request.allowSameFamily) {
      sameFamilyOverride = true;
    } else {
      // Only the family rule permits a fallback, and only to the next tier.
      const lower = TIERS[tierRank(tier) - 1];
      if (lower === undefined || tierRank(lower) < tierRank(floor)) throw new RoutingError("routing_same_family");
      candidates = otherFamilies(candidatesFor(lower, role, request, context));
      if (candidates.length === 0) throw new RoutingError("routing_same_family");
      tier = lower;
      reason = "lower_tier_review";
    }
  }
  let exploration = false;
  let index = 0;
  if (config.mode === "auto" && context.exploration.allowed && risk !== "high" && candidates.length > 1 && context.exploration.random() < context.exploration.rate) {
    index = 1 + Math.floor(context.exploration.random() * (candidates.length - 1));
    exploration = true;
  }
  const alias = candidates[index]!;
  return {
    alias,
    decision: { tier, role, risk, profile: alias, family: config.families.get(alias) ?? null, origin: reason, exploration, sameFamilyOverride },
    result: { tier, role, profile: alias, reason, exploration },
  };
}

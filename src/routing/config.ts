import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ALIAS_PATTERN, ImmutableMap, type ConfiguredExecutionProfile } from "../execution-profile.js";

export const TIERS = ["low", "medium", "hightech", "ultra"] as const;
export const ROLES = ["code", "review", "explore"] as const;
export type Tier = (typeof TIERS)[number];
export type Role = (typeof ROLES)[number];
export type RoutingMode = "off" | "manual" | "auto";
export const FAMILY_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export function tierRank(tier: Tier): number { return TIERS.indexOf(tier); }

export interface RoutingConfig {
  mode: RoutingMode;
  tiers: Readonly<Record<Tier, Readonly<Record<Role, readonly string[]>>>>;
  families: ReadonlyMap<string, string>;
  floors: { code: Tier; review: Tier; explore: Tier; riskHigh: Tier; workspaces: ReadonlyMap<string, Tier> };
  learning: { minSamples: number; margin: number; explorationRate: number; explorationBudgetUsd: number };
}

export class RoutingConfigError extends Error {
  readonly code = "routing_config_invalid" as const;
  constructor() { super("Routing configuration is invalid"); this.name = "RoutingConfigError"; }
}

const tier = z.enum(TIERS);
const alias = z.string().regex(ALIAS_PATTERN);
const cell = z.array(alias);
const tierCells = z.object({ code: cell.optional(), review: cell.optional(), explore: cell.optional() }).strict();
const schema = z.object({
  mode: z.enum(["off", "manual", "auto"]),
  tiers: z.object({ low: tierCells.optional(), medium: tierCells.optional(), hightech: tierCells.optional(), ultra: tierCells.optional() }).strict().optional(),
  families: z.record(alias, z.string().regex(FAMILY_PATTERN)).optional(),
  floors: z.object({
    code: tier.optional(), review: tier.optional(), explore: tier.optional(), riskHigh: tier.optional(),
    workspaces: z.record(alias, tier).optional(),
  }).strict().optional(),
  learning: z.object({
    minSamples: z.number().int().min(1).max(1000).optional(),
    margin: z.number().min(0).max(1).optional(),
    explorationRate: z.number().min(0).max(1).optional(),
    explorationBudgetUsd: z.number().min(0).optional(),
  }).strict().optional(),
}).strict();

export function parseRoutingConfig(input: unknown, profiles: ReadonlyMap<string, ConfiguredExecutionProfile>, workspaces: ReadonlyMap<string, string>): RoutingConfig {
  const result = schema.safeParse(input);
  if (!result.success) throw new RoutingConfigError();
  const data = result.data;
  const families = new ImmutableMap(Object.entries(data.families ?? {}));
  const assigned = new Map<string, Tier>();
  const tiers = {} as Record<Tier, Record<Role, readonly string[]>>;
  for (const name of TIERS) {
    const roles = {} as Record<Role, readonly string[]>;
    for (const role of ROLES) {
      const aliases = data.tiers?.[name]?.[role] ?? [];
      for (const profileAlias of aliases) {
        const profile = profiles.get(profileAlias);
        if (!profile || profile.permissionProfile !== (role === "code" ? "coding" : "read-only") || !families.has(profileAlias) || (assigned.has(profileAlias) && assigned.get(profileAlias) !== name)) throw new RoutingConfigError();
        assigned.set(profileAlias, name);
      }
      roles[role] = Object.freeze([...aliases]);
    }
    tiers[name] = Object.freeze(roles);
  }
  const workspaceFloors = Object.entries(data.floors?.workspaces ?? {});
  if (workspaceFloors.some(([name]) => !workspaces.has(name))) throw new RoutingConfigError();
  return Object.freeze({
    mode: data.mode,
    tiers: Object.freeze(tiers), families,
    floors: Object.freeze({ code: data.floors?.code ?? "medium", review: data.floors?.review ?? "medium", explore: data.floors?.explore ?? "low", riskHigh: data.floors?.riskHigh ?? "hightech", workspaces: new ImmutableMap(workspaceFloors) }),
    learning: Object.freeze({ minSamples: data.learning?.minSamples ?? 8, margin: data.learning?.margin ?? 0.1, explorationRate: data.learning?.explorationRate ?? 0.1, explorationBudgetUsd: data.learning?.explorationBudgetUsd ?? 5 }),
  });
}

export const ROUTING_OFF: RoutingConfig = parseRoutingConfig({ mode: "off" }, new Map(), new Map());

export function routingConfigPath(configPath: string): string { return join(dirname(configPath), "routing.json"); }

export async function loadRoutingConfig(configPath: string, profiles: ReadonlyMap<string, ConfiguredExecutionProfile>, workspaces: ReadonlyMap<string, string>): Promise<RoutingConfig> {
  let input: unknown;
  try {
    input = JSON.parse(await readFile(routingConfigPath(configPath), "utf8")) as unknown;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return ROUTING_OFF;
    throw new RoutingConfigError();
  }
  return parseRoutingConfig(input, profiles, workspaces);
}

export async function writeRoutingDocument(configPath: string, document: unknown): Promise<void> {
  const path = routingConfigPath(configPath);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let created = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    created = true;
    try { await handle.writeFile(JSON.stringify(document, null, 2) + "\n"); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, path);
  } finally {
    if (created) await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
}

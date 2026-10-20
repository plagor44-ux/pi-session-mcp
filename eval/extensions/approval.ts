import { z } from "zod";
import { digest } from "../profiles/files.js";
import { BUDGET_USD } from "./budget.js";
import { profileIdSchema, type ProfileId, type RunSpec, type TaskSpec } from "./schemas.js";

export const routeSchema = z.object({
  profile: profileIdSchema, provider: z.string().min(1), model: z.string().min(1), thinkingLevel: z.string().min(1),
}).strict();
export type Route = z.infer<typeof routeSchema>;

export const approvalSchema = z.object({
  approved: z.literal(true), approvedAt: z.string().min(1), budgetUsd: z.literal(BUDGET_USD),
  sourceCommit: z.string().min(1), tasksDigest: z.string().min(1), matrixDigest: z.string().min(1),
  routes: z.array(routeSchema).min(1),
}).strict();
export type Approval = z.infer<typeof approvalSchema>;

/** The part of the production configuration the evaluation reads; everything else is ignored here and never copied. */
export const productionConfigSchema = z.object({
  workspaces: z.record(z.string(), z.string()),
  executionProfiles: z.record(z.string(), z.record(z.string(), z.unknown())),
  skillCatalog: z.record(z.string(), z.string()).optional(),
});
export type ProductionConfig = z.infer<typeof productionConfigSchema>;

export function parseProductionConfig(raw: unknown): ProductionConfig {
  const parsed = productionConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error("production_config_invalid");
  return parsed.data;
}

export const tasksDigest = (tasks: TaskSpec[]): `sha256:${string}` => digest(tasks);
export const matrixDigest = (runs: RunSpec[]): `sha256:${string}` => digest(runs);

/** Provider, model and thinking level of every profile used by `runs`, ordered by profile id. */
export function routesOf(config: ProductionConfig, profiles: Iterable<ProfileId>): Route[] {
  return [...new Set(profiles)].sort().map((profile) => {
    const entry = config.executionProfiles[profile];
    const parsed = routeSchema.safeParse({ profile, provider: entry?.provider, model: entry?.model, thinkingLevel: entry?.thinkingLevel });
    if (!parsed.success) throw new Error("route_profile_missing");
    return parsed.data;
  });
}

const sortedRoutes = (routes: Route[]): string => JSON.stringify([...routes].sort((a, b) => a.profile.localeCompare(b.profile)));

/**
 * Checks the approval against what would run now. `routes` is optional so the digests can be checked where the production
 * configuration is not at hand; the wave and the preflight always pass it.
 */
export function validateApproval(
  raw: unknown,
  current: { sourceCommit: string; tasks: TaskSpec[]; runs: RunSpec[]; routes?: Route[] },
): Approval {
  const parsed = approvalSchema.safeParse(raw);
  if (!parsed.success) throw new Error("approval_invalid");
  const approval = parsed.data;
  const changed = approval.sourceCommit !== current.sourceCommit
    || approval.tasksDigest !== tasksDigest(current.tasks)
    || approval.matrixDigest !== matrixDigest(current.runs)
    || (current.routes !== undefined && sortedRoutes(approval.routes) !== sortedRoutes(current.routes));
  if (changed) throw new Error("approval_binding_changed");
  return approval;
}

import { z } from "zod";
import { digest } from "../profiles/files.js";
import { BUDGET_USD } from "./budget.js";
import { MAX_REPLICATES, PAIRINGS, buildMatrix } from "./matrix.js";
import { profileIdSchema, runSpecSchema, type ProfileId, type RunSpec, type TaskSpec } from "./schemas.js";

const routeSchema = z.object({
  profile: profileIdSchema, provider: z.string().min(1), model: z.string().min(1), thinkingLevel: z.string().min(1),
}).strict();
export type Route = z.infer<typeof routeSchema>;

export const approvalSchema = z.object({
  approved: z.literal(true), approvedAt: z.string().min(1), budgetUsd: z.literal(BUDGET_USD),
  sourceCommit: z.string().min(1), tasksDigest: z.string().min(1), matrixDigest: z.string().min(1),
  /** The one budget ledger of the whole evaluation, also across re-approvals (R55). */
  ledgerId: z.string().uuid(),
  /** The explicit, ordered run list that was approved (R56), trimmed if `--trim` was used. Wave and preflight run exactly this list. */
  runs: z.array(runSpecSchema).min(1),
  /** The replicates the run ids and ordinals were planned for (R90); absent for a plan without replicates, read as 1. Part of the binding. */
  replicates: z.number().int().min(1).max(MAX_REPLICATES).optional(),
  routes: z.array(routeSchema).min(1),
  /**
   * Runs of the run list whose earlier attempts were all stopped by the trace audit (R85) and which are planned again: the ledger already
   * holds `charges` run charges for each, and a listed run may run despite them only while the ledger still holds exactly that many (a run
   * that was charged again since, by a wave the plan did not see or a crash after the charge, is refused). Written by `--plan`; the approval,
   * and with it this list, is what the operator approves and what a resumed wave must match exactly.
   */
  replannedStopped: z.array(z.object({ runId: z.string().min(1), charges: z.number().int().min(1) }).strict()).optional(),
}).strict();
export type Approval = z.infer<typeof approvalSchema>;

/** The part of the production configuration the evaluation reads; everything else is ignored here and never copied. */
const productionConfigSchema = z.object({
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

/**
 * Every approved run is a slot of the canonical matrix (R58) with its own run id, ordinal and slot, the runs follow in canonical order,
 * and each one's pairings are a non-empty, unique subset of that slot's pairings (R62b). The canonical matrix is the one of the approval's
 * `replicates` (R90): its run ids carry `-r<k>`, so a run list of another replicate count matches no slot.
 */
function runsAreCanonical(runs: readonly RunSpec[], tasks: TaskSpec[], replicates: number): boolean {
  const slots = new Map(buildMatrix(tasks, PAIRINGS, new Set(), replicates).map((slot) => [slot.runId, slot]));
  let last = 0;
  return runs.every((run) => {
    const slot = slots.get(run.runId);
    const ordered = run.ordinal > last;
    last = run.ordinal;
    return ordered && slot !== undefined && slot.ordinal === run.ordinal && slot.taskId === run.taskId && slot.profile === run.profile && slot.arm === run.arm
      && slot.replicate === run.replicate
      && run.pairings.length > 0 && new Set(run.pairings).size === run.pairings.length && run.pairings.every((id) => slot.pairings.includes(id));
  });
}

const sortedRoutes = (routes: Route[]): string => JSON.stringify([...routes].sort((a, b) => a.profile.localeCompare(b.profile)));

/**
 * Checks the approval against what would run now: the source commit, the tasks, the digest of its own run list (which must be canonical slots of
 * known tasks, R62b) and, when given, the routes of the production configuration. The run list comes from the approval and is never
 * recomputed from the ledger at wave time (R56). `routes` is optional so the digests can be checked where the production configuration
 * is not at hand; the wave and the preflight always pass it.
 */
export function validateApproval(
  raw: unknown,
  current: { sourceCommit: string; tasks: TaskSpec[]; routes?: Route[] },
): Approval {
  const parsed = approvalSchema.safeParse(raw);
  if (!parsed.success) throw new Error("approval_invalid");
  const approval = parsed.data;
  const known = new Set(current.tasks.map((task) => task.id));
  const changed = approval.sourceCommit !== current.sourceCommit
    || approval.tasksDigest !== tasksDigest(current.tasks)
    || approval.matrixDigest !== matrixDigest(approval.runs)
    || approval.runs.some((run) => !known.has(run.taskId))
    || new Set(approval.runs.map((run) => run.runId)).size !== approval.runs.length
    || !(approval.replannedStopped ?? []).every(({ runId }, index, listed) => approval.runs.some((run) => run.runId === runId) && listed.findIndex((other) => other.runId === runId) === index)
    || !runsAreCanonical(approval.runs, current.tasks, approval.replicates ?? 1)
    || (current.routes !== undefined && sortedRoutes(approval.routes) !== sortedRoutes(current.routes));
  if (changed) throw new Error("approval_binding_changed");
  return approval;
}

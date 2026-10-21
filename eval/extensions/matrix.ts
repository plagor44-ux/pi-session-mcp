import type { Arm, Pairing, ProfileId, RunSpec, TaskSpec } from "./schemas.js";

export type { Arm, ExtensionId, Pairing, ProfileId, RunSpec, TaskSpec } from "./schemas.js";

const PI_LENS_REVIEW_TOOLS = ["symbol_search", "project_report", "read_symbol", "read_enclosing", "module_report"];

export const PAIRINGS: readonly Pairing[] = [
  { id: "pl-code-deepseek", extension: "pi-lens", profile: "code-deepseek", priority: 1 },
  { id: "pl-code", extension: "pi-lens", profile: "code", priority: 2 },
  { id: "pl-review-grok", extension: "pi-lens", profile: "review-grok", priority: 3, grantedExtensionTools: [...PI_LENS_REVIEW_TOOLS] },
  { id: "pl-review", extension: "pi-lens", profile: "review", priority: 3, grantedExtensionTools: [...PI_LENS_REVIEW_TOOLS] },
  { id: "co-code", extension: "pi-cache-optimizer", profile: "code", priority: 4 },
  { id: "co-review", extension: "pi-cache-optimizer", profile: "review", priority: 4 },
];

const MIN_TASKS_PER_PAIRING = 3;

/** The kind of task a profile is paired with: review profiles take review tasks, the others implementation tasks. */
export function taskKind(profile: ProfileId): TaskSpec["kind"] {
  return profile === "review" || profile === "review-grok" ? "review" : "implementation";
}

interface Selection { pairing: Pairing; tasks: TaskSpec[] }
interface Draft { task: TaskSpec; taskIndex: number; profile: ProfileId; arm: Arm; priority: number; profilePos: number; pairings: string[] }

/** Each pairing uses the first `limits[pairing.id]` tasks of its kind in task-list order, so arm-A runs stay shared. */
function select(tasks: TaskSpec[], pairings: readonly Pairing[], limits: ReadonlyMap<string, number>): Selection[] {
  return pairings.map((pairing) => ({
    pairing,
    tasks: tasks.filter((t) => t.kind === taskKind(pairing.profile)).slice(0, limits.get(pairing.id) ?? Infinity),
  }));
}

function assertUniqueTaskIds(tasks: TaskSpec[]): void {
  if (new Set(tasks.map((t) => t.id)).size !== tasks.length) throw new Error("duplicate_task_id");
}

/** The most replicates a plan may ask for (R90). */
export const MAX_REPLICATES = 9;

/** A run without a `replicate` field is the one run of a plan without replicates (R90). */
export const replicateOf = (run: { replicate?: number | undefined }): number => run.replicate ?? 1;

function assertReplicates(replicates: number): void {
  if (!Number.isInteger(replicates) || replicates < 1 || replicates > MAX_REPLICATES) throw new Error("invalid_argument");
}

const slotKey = (taskId: string, profile: ProfileId, arm: Arm, replicate: number): string => `${taskId}\u0000${profile}\u0000${arm}\u0000${replicate}`;

/** The drafts of `selections` in execution order within one replicate. Ordinals are not assigned here; see `plan`. */
function order(tasks: TaskSpec[], selections: Selection[], replicate: number): Draft[] {
  // Position within the task's kind (task-list order), so alternation holds for interleaved lists.
  const seen = { review: 0, implementation: 0 };
  const kindIndex = new Map<TaskSpec, number>(tasks.map((t) => [t, seen[t.kind]++]));
  const drafts = new Map<string, Draft>();
  const profilePos = new Map<ProfileId, number>();
  selections.forEach(({ pairing }, i) => { if (!profilePos.has(pairing.profile)) profilePos.set(pairing.profile, i); });
  for (const { pairing, tasks: selected } of selections) {
    for (const task of selected) {
      for (const arm of ["A", pairing.extension] as const) {
        const key = slotKey(task.id, pairing.profile, arm, replicate);
        const draft = drafts.get(key);
        if (draft) { draft.priority = Math.min(draft.priority, pairing.priority); draft.pairings.push(pairing.id); continue; }
        drafts.set(key, { task, taskIndex: kindIndex.get(task)!, profile: pairing.profile, arm, priority: pairing.priority, profilePos: profilePos.get(pairing.profile)!, pairings: [pairing.id] });
      }
    }
  }
  // Arm A leads on even task indexes and trails on odd ones, so position does not favour one arm; the next replicate flips it (R90).
  const armPos = (d: Draft) => (d.arm === "A" ? ((d.taskIndex + replicate - 1) % 2 === 0 ? -1 : 1) : 0);
  return [...drafts.values()]
    .sort((a, b) => a.priority - b.priority || a.profilePos - b.profilePos || a.taskIndex - b.taskIndex || armPos(a) - armPos(b) || a.arm.localeCompare(b.arm));
}

/**
 * The one definition of the run order and of the run id: the matrix of all pairings, untrimmed (R58). With `replicates` > 1 (R90) it is the
 * matrix once per replicate, concatenated replicate by replicate, ordinals over the whole list; every run id gains `-r<k>` and the run its
 * `replicate`. Without replicates ids, ordinals and runs are exactly those of a plan that never knew replicates.
 */
function canonical(tasks: TaskSpec[], replicates: number): RunSpec[] {
  const all = select(tasks, PAIRINGS, new Map());
  const drafts = Array.from({ length: replicates }, (_, k) => order(tasks, all, k + 1).map((d) => ({ d, replicate: k + 1 }))).flat();
  return drafts.map(({ d, replicate }, i) => {
    const ordinal = i + 1;
    const suffix = replicates > 1 ? `-r${replicate}` : "";
    return {
      runId: `${String(ordinal).padStart(3, "0")}-${d.task.id}-${d.profile}-${d.arm}${suffix}`, taskId: d.task.id, profile: d.profile, arm: d.arm, ordinal, pairings: d.pairings,
      ...(replicates > 1 ? { replicate } : {}),
    };
  });
}

/**
 * A subsequence of the canonical matrix in canonical order: every slot keeps the `runId` and `ordinal` it has there (ordinals may have gaps),
 * and `pairings` is the subset of pairings that selected it here. Slots in `skip` (run ids that already ran) are left out.
 */
function plan(tasks: TaskSpec[], selections: Selection[], skip: ReadonlySet<string>, replicates: number): RunSpec[] {
  const slots = new Map(canonical(tasks, replicates).map((run) => [slotKey(run.taskId, run.profile, run.arm, replicateOf(run)), run]));
  const picked = Array.from({ length: replicates }, (_, k) => order(tasks, selections, k + 1).map((d) => ({ d, replicate: k + 1 }))).flat();
  return picked.map(({ d, replicate }) => {
    const slot = slots.get(slotKey(d.task.id, d.profile, d.arm, replicate));
    if (!slot) throw new Error("unknown_pairing");
    return { ...slot, pairings: d.pairings };
  }).filter((run) => !skip.has(run.runId)).sort((a, b) => a.ordinal - b.ordinal);
}

/** Without `skip` the matrix of `pairings`; with it, the run ids that already ran are left out. */
export function buildMatrix(tasks: TaskSpec[], pairings: readonly Pairing[], skip: ReadonlySet<string> = new Set(), replicates = 1): RunSpec[] {
  assertUniqueTaskIds(tasks);
  assertReplicates(replicates);
  return plan(tasks, select(tasks, pairings, new Map()), skip, replicates);
}

export function trimMatrix(
  tasks: TaskSpec[], pairings: readonly Pairing[], projectedUsd: (runs: RunSpec[]) => number, remainingUsd: number, skip: ReadonlySet<string> = new Set(), replicates = 1,
): { pairings: Pairing[]; tasksPerPairing: Record<string, string[]>; runs: RunSpec[] } {
  assertUniqueTaskIds(tasks);
  assertReplicates(replicates);
  const limits = new Map<string, number>();
  let kept = [...pairings];
  const current = () => plan(tasks, select(tasks, kept, limits), skip, replicates);
  // Lowest priority is the highest number; on ties the later pairing in the list goes first.
  const lowest = (candidates: Pairing[]) => candidates.reduce((worst, p) => (p.priority >= worst.priority ? p : worst));
  const size = (p: Pairing) => select(tasks, [p], limits)[0]!.tasks.length;
  let runs = current();
  while (projectedUsd(runs) > remainingUsd) {
    const trimmable = kept.filter((p) => size(p) > MIN_TASKS_PER_PAIRING);
    if (trimmable.length > 0) {
      const target = lowest(trimmable);
      limits.set(target.id, size(target) - 1);
    } else if (kept.length > 0) {
      kept = kept.filter((p) => p !== lowest(kept));
    } else break;
    runs = current();
  }
  const selections = select(tasks, kept, limits);
  return {
    pairings: kept,
    tasksPerPairing: Object.fromEntries(selections.map((s) => [s.pairing.id, s.tasks.map((t) => t.id)])),
    runs,
  };
}

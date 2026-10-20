import type { Arm, Pairing, ProfileId, RunSpec, TaskSpec } from "./schemas.js";

export type { Arm, ExtensionId, Pairing, ProfileId, RunSpec, TaskSpec } from "./schemas.js";

const PI_LENS_REVIEW_TOOLS = ["symbol_search", "project_report", "read_symbol", "read_enclosing", "module_report", "ast_grep_search", "ast_grep_outline"];

export const PAIRINGS: readonly Pairing[] = [
  { id: "pl-code-deepseek", extension: "pi-lens", profile: "code-deepseek", priority: 1 },
  { id: "pl-code", extension: "pi-lens", profile: "code", priority: 2 },
  { id: "pl-review-grok", extension: "pi-lens", profile: "review-grok", priority: 3, grantedExtensionTools: [...PI_LENS_REVIEW_TOOLS] },
  { id: "pl-review", extension: "pi-lens", profile: "review", priority: 3, grantedExtensionTools: [...PI_LENS_REVIEW_TOOLS] },
  { id: "co-code", extension: "pi-cache-optimizer", profile: "code", priority: 4 },
  { id: "co-review", extension: "pi-cache-optimizer", profile: "review", priority: 4 },
];

const MIN_TASKS_PER_PAIRING = 3;

function taskKind(profile: ProfileId): TaskSpec["kind"] {
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

function plan(tasks: TaskSpec[], selections: Selection[]): RunSpec[] {
  const drafts = new Map<string, Draft>();
  const profilePos = new Map<ProfileId, number>();
  selections.forEach(({ pairing }, i) => { if (!profilePos.has(pairing.profile)) profilePos.set(pairing.profile, i); });
  for (const { pairing, tasks: selected } of selections) {
    for (const task of selected) {
      for (const arm of ["A", pairing.extension] as const) {
        const key = `${task.id}\u0000${pairing.profile}\u0000${arm}`;
        const draft = drafts.get(key);
        if (draft) { draft.priority = Math.min(draft.priority, pairing.priority); draft.pairings.push(pairing.id); continue; }
        drafts.set(key, { task, taskIndex: tasks.indexOf(task), profile: pairing.profile, arm, priority: pairing.priority, profilePos: profilePos.get(pairing.profile)!, pairings: [pairing.id] });
      }
    }
  }
  // Arm A leads on even task indexes and trails on odd ones, so position does not favour one arm.
  const armPos = (d: Draft) => (d.arm === "A" ? (d.taskIndex % 2 === 0 ? -1 : 1) : 0);
  return [...drafts.values()]
    .sort((a, b) => a.priority - b.priority || a.profilePos - b.profilePos || a.taskIndex - b.taskIndex || armPos(a) - armPos(b) || a.arm.localeCompare(b.arm))
    .map((d, i) => {
      const ordinal = i + 1;
      return { runId: `${String(ordinal).padStart(3, "0")}-${d.task.id}-${d.profile}-${d.arm}`, taskId: d.task.id, profile: d.profile, arm: d.arm, ordinal, pairings: d.pairings };
    });
}

export function buildMatrix(tasks: TaskSpec[], pairings: readonly Pairing[]): RunSpec[] {
  return plan(tasks, select(tasks, pairings, new Map()));
}

export function trimMatrix(
  tasks: TaskSpec[], pairings: readonly Pairing[], projectedUsd: (runs: RunSpec[]) => number, remainingUsd: number,
): { pairings: Pairing[]; tasksPerPairing: Record<string, string[]>; runs: RunSpec[] } {
  const limits = new Map<string, number>();
  let kept = [...pairings];
  const current = () => plan(tasks, select(tasks, kept, limits));
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

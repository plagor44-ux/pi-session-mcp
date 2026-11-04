import { readFileSync } from "node:fs";
import type { HistoryStore } from "./store.js";

/**
 * The kernel start time of a process (field 22 of `/proc/<pid>/stat`), so a reused pid is not
 * mistaken for the instance that wrote a row. `null` where `/proc` is unavailable (macOS).
 */
export function procStartOf(pid: number): string | null {
  if (process.platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name in field 2 may contain spaces and parentheses; fields resume after the last ")".
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

/** Whether the process that wrote an instance row still runs. A recorded start time must match. */
export function defaultIsAlive(pid: number, procStart: string | null): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    // ESRCH: gone. EPERM: the pid now belongs to another account, so it is not this account's server.
    return false;
  }
  if (procStart === null) return true;
  const current = procStartOf(pid);
  return current === null ? process.platform !== "linux" : current === procStart;
}

/**
 * Marks sessions of server instances that ended without recording their close as `incomplete`,
 * and their unrecorded turns as `unrecorded` (design call 3). An instance is dead when it recorded
 * its end or its process no longer runs. Nothing is resumed or replayed. Returns the number of
 * sessions marked. Throws on a store failure; callers decide how to report it.
 */
export function reconcileInstances(store: HistoryStore, isAlive: (pid: number, procStart: string | null) => boolean): number {
  const instances = store.db.prepare(`SELECT DISTINCT i.id AS id, i.pid AS pid, i.proc_start AS proc_start, i.ended_at AS ended_at
    FROM instances i JOIN sessions s ON s.instance_id = i.id
    WHERE s.closed_at IS NULL AND s.completeness != 'incomplete'
    UNION SELECT id, pid, proc_start, ended_at FROM instances WHERE ended_at IS NULL`).all() as Array<{ id: string; pid: number; proc_start: string | null; ended_at: string | null }>;
  const dead = instances.filter((instance) => instance.ended_at !== null || !isAlive(instance.pid, instance.proc_start));
  if (dead.length === 0) return 0;
  const now = new Date().toISOString();
  return store.transaction(() => {
    let marked = 0;
    for (const instance of dead) {
      store.db.prepare(`UPDATE turns SET state = 'unrecorded' WHERE recorded = 0 AND session_id IN
        (SELECT id FROM sessions WHERE instance_id = ? AND closed_at IS NULL AND completeness != 'incomplete')`).run(instance.id);
      marked += Number(store.db.prepare("UPDATE sessions SET completeness = 'incomplete' WHERE instance_id = ? AND closed_at IS NULL AND completeness != 'incomplete'").run(instance.id).changes);
      store.db.prepare("UPDATE instances SET ended_at = ? WHERE id = ? AND ended_at IS NULL").run(now, instance.id);
    }
    return marked;
  });
}

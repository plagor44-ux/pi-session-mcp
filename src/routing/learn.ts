import type { HistoryStore } from "../history/store.js";
import { ROLES, TIERS, type RoutingConfig } from "./config.js";
import { createRoutingStore } from "./store.js";

export interface CellStat { profile: string; samples: number; meanScore: number; medianCostUsd: number | null }
export function wilsonLowerBound(score: number, samples: number, z = 1.96): number {
  if (!samples) return 0;
  const z2 = z * z;
  return (score + z2 / (2 * samples) - z * Math.sqrt((score * (1 - score) + z2 / (4 * samples)) / samples)) / (1 + z2 / samples);
}
export function nextSwap(order: readonly CellStat[], limits: { minSamples: number; margin: number }): readonly string[] | undefined {
  const eligible = order.map((s, i) => ({ s, i })).filter(({ s }) => s.samples >= limits.minSamples);
  for (const cost of [false, true]) for (let i = 0; i + 1 < eligible.length; i++) {
    const a = eligible[i]!; const b = eligible[i + 1]!;
    const diff = wilsonLowerBound(b.s.meanScore, b.s.samples) - wilsonLowerBound(a.s.meanScore, a.s.samples);
    if ((!cost && diff > limits.margin) || (cost && Math.abs(diff) <= limits.margin && a.s.medianCostUsd !== null && b.s.medianCostUsd !== null && b.s.medianCostUsd < a.s.medianCostUsd)) {
      const result = order.map(s => s.profile); [result[a.i], result[b.i]] = [result[b.i]!, result[a.i]!]; return result;
    }
  }
  return undefined;
}
export function explorationAllowed(spend: { knownUsd: number; costUnknown: boolean; pending: number }, budgetUsd: number): boolean {
  return !spend.costUnknown && spend.pending < 3 && spend.knownUsd < budgetUsd;
}
type Input = { store: HistoryStore; config: RoutingConfig; now: Date; deadlineMs?: number };
export function refreshRouting({ store, config, now, deadlineMs = 2000 }: Input): { outcomes: number; changes: number; proposals: number } {
  const result = { outcomes: 0, changes: 0, proposals: 0 };
  if (config.mode === "off") return result;
  const start = Date.now(); const expired = () => Date.now() - start >= deadlineMs;
  const db = store.db; const timestamp = now.toISOString();
  const decisions = db.prepare(`SELECT d.id, s.id AS session_id FROM routing_decisions d JOIN sessions s ON s.public_session_id = d.session_ref
    WHERE d.decided_at >= ? AND s.closed_at IS NOT NULL AND EXISTS (SELECT 1 FROM verdicts v WHERE v.session_id = s.id)
      AND (d.settled = 0 OR d.verdict IS NOT (SELECT v.verdict FROM verdicts v WHERE v.session_id = s.id ORDER BY v.id DESC LIMIT 1)) ORDER BY d.id LIMIT 500`).all(new Date(now.getTime() - 30 * 86400000).toISOString());
  const update = db.prepare(`UPDATE routing_decisions SET turns = (SELECT COUNT(*) FROM turns WHERE session_id = ?),
    failed_turns = (SELECT COUNT(*) FROM turns WHERE session_id = ? AND state = 'failed'),
    cost_usd = (SELECT NULLIF(SUM(json_extract(redacted_json, '$.message.usage.cost.total')), 0) FROM entries WHERE session_id = ? AND role = 'assistant'),
    verdict = (SELECT verdict FROM verdicts WHERE session_id = ? ORDER BY id DESC LIMIT 1), settled = 1 WHERE id = ?`);
  for (const row of decisions) { if (expired()) break; update.run(row.session_id!, row.session_id!, row.session_id!, row.session_id!, row.id!); result.outcomes++; }
  const routing = createRoutingStore(store); const suspended = new Set(routing.suspendedProfiles(now));
  const profiles = new Set(TIERS.flatMap(t => ROLES.flatMap(r => [...config.tiers[t][r]])));
  const failures = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT s.id, EXISTS(SELECT 1 FROM turns t WHERE t.session_id = s.id AND t.state = 'failed') AS failed FROM sessions s WHERE s.execution_profile = ? AND EXISTS(SELECT 1 FROM turns t WHERE t.session_id = s.id) ORDER BY s.created_at DESC, s.id DESC LIMIT 10) WHERE failed = 1`);
  const version = db.prepare(`INSERT INTO routing_versions (tier, role, kind, profile, before_json, after_json, reason, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const openSuspend = db.prepare("SELECT 1 AS found FROM routing_versions WHERE kind = 'suspend' AND profile = ? AND state = 'proposed' LIMIT 1");
  for (const profile of profiles) {
    if (expired()) break;
    if (suspended.has(profile) || Number(failures.get(profile)!.n) < 3) continue;
    const cells = TIERS.flatMap(tier => ROLES.filter(role => config.tiers[tier][role].includes(profile)).map(role => ({ tier, role })));
    if (cells.some(({ tier, role }) => !config.tiers[tier][role].some(p => p !== profile && !suspended.has(p)))) continue;
    if (config.mode !== "auto" && openSuspend.get(profile)) continue;
    const cell = cells[0]!;
    store.transaction(() => {
      if (config.mode === "auto") db.prepare(`INSERT INTO routing_suspensions (profile, until, reason) VALUES (?, ?, 'failed_sessions') ON CONFLICT(profile) DO UPDATE SET until=excluded.until, reason=excluded.reason`).run(profile, new Date(now.getTime() + 86400000).toISOString());
      version.run(cell.tier, cell.role, "suspend", profile, "[]", "[]", "failed_sessions", config.mode === "auto" ? "applied" : "proposed", timestamp);
    });
    if (config.mode === "auto") { suspended.add(profile); result.changes++; } else result.proposals++;
  }
  for (const tier of TIERS) for (const role of ROLES) {
    if (expired()) return result;
    const cell = db.prepare("SELECT frozen FROM routing_cells WHERE tier = ? AND role = ?").get(tier, role);
    if (cell?.frozen === 1) continue;
    const listed = config.tiers[tier][role]; const saved = routing.currentOrder(tier, role) ?? [];
    const order = [...new Set([...saved.filter(p => listed.includes(p)), ...listed])];
    const rows = db.prepare("SELECT profile, verdict, cost_usd FROM routing_decisions WHERE tier = ? AND role = ? AND settled = 1 AND turns > 0 AND verdict IS NOT NULL").all(tier, role);
    const stats: CellStat[] = order.map(profile => {
      const selected = rows.filter(row => row.profile === profile);
      const costs = selected.map(row => row.cost_usd).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
      const mid = Math.floor(costs.length / 2);
      return { profile, samples: selected.length, meanScore: selected.length ? selected.reduce((sum, row) => sum + (row.verdict === "accepted" ? 1 : row.verdict === "reworked" ? 0.5 : 0), 0) / selected.length : 0, medianCostUsd: costs.length ? (costs.length % 2 ? costs[mid]! : (costs[mid - 1]! + costs[mid]!) / 2) : null };
    });
    const next = nextSwap(stats, config.learning); if (!next) continue;
    store.transaction(() => {
      if (config.mode === "auto") db.prepare(`INSERT INTO routing_cells (tier, role, order_json, frozen) VALUES (?, ?, ?, 0) ON CONFLICT(tier, role) DO UPDATE SET order_json=excluded.order_json`).run(tier, role, JSON.stringify(next));
      else db.prepare("UPDATE routing_versions SET state = 'superseded' WHERE tier = ? AND role = ? AND kind = 'reorder' AND state = 'proposed'").run(tier, role);
      version.run(tier, role, "reorder", null, JSON.stringify(order), JSON.stringify(next), "quality_or_cost", config.mode === "auto" ? "applied" : "proposed", timestamp);
    });
    if (config.mode === "auto") result.changes++; else result.proposals++;
  }
  return result;
}
export function maybeRefreshRouting(input: Input): boolean {
  if (input.config.mode === "off") return false;
  const claimed = input.store.transaction(() => {
    input.store.db.prepare("INSERT OR IGNORE INTO routing_meta (key, value) VALUES ('last_refresh_at', '')").run();
    return input.store.db.prepare("UPDATE routing_meta SET value = ? WHERE key = 'last_refresh_at' AND value <= ?").run(input.now.toISOString(), new Date(input.now.getTime() - 86400000).toISOString()).changes === 1;
  });
  if (claimed) refreshRouting(input);
  return claimed;
}

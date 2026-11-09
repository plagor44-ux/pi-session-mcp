import type { HistoryStore } from "../history/store.js";
import type { Role, Tier } from "./config.js";

export const ROUTING_CELL_RETENTION = 200;
export type DecisionOrigin = "floor" | "raised" | "lower_tier_review" | "explicit" | "default";
export interface DecisionInput {
  sessionRef: string;
  decidedAt: string;
  tier: Tier | null;
  role: Role | null;
  risk: "normal" | "high";
  profile: string;
  family: string | null;
  origin: DecisionOrigin;
  exploration: boolean;
  sameFamilyOverride: boolean;
}
export interface RoutingStore {
  recordDecision(input: DecisionInput): void;
  currentOrder(tier: Tier, role: Role): readonly string[] | undefined;
  suspendedProfiles(now: Date): ReadonlySet<string>;
  explorationSpend(since: Date): { knownUsd: number; costUnknown: boolean; pending: number };
}

export function createRoutingStore(store: HistoryStore): RoutingStore {
  const insert = store.db.prepare(`INSERT INTO routing_decisions
    (session_ref, decided_at, tier, role, risk, profile, family, origin, exploration, same_family_override)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const trimCell = store.db.prepare(`DELETE FROM routing_decisions WHERE tier = ? AND role = ? AND id NOT IN
    (SELECT id FROM routing_decisions WHERE tier = ? AND role = ? ORDER BY id DESC LIMIT ?)`);
  const trimUnassigned = store.db.prepare(`DELETE FROM routing_decisions WHERE (tier IS NULL OR role IS NULL) AND id NOT IN
    (SELECT id FROM routing_decisions WHERE tier IS NULL OR role IS NULL ORDER BY id DESC LIMIT ?)`);
  const order = store.db.prepare("SELECT order_json FROM routing_cells WHERE tier = ? AND role = ?");
  const suspensions = store.db.prepare("SELECT profile FROM routing_suspensions WHERE until > ?");
  const spend = store.db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS known_usd,
    COALESCE(SUM(CASE WHEN settled = 1 AND cost_usd IS NULL THEN 1 ELSE 0 END), 0) AS unknown,
    COALESCE(SUM(CASE WHEN settled = 0 THEN 1 ELSE 0 END), 0) AS pending
    FROM routing_decisions WHERE exploration = 1 AND decided_at >= ?`);
  return {
    recordDecision(input) {
      store.transaction(() => {
        insert.run(input.sessionRef, input.decidedAt, input.tier, input.role, input.risk, input.profile, input.family, input.origin, Number(input.exploration), Number(input.sameFamilyOverride));
        if (input.tier === null || input.role === null) trimUnassigned.run(ROUTING_CELL_RETENTION);
        else trimCell.run(input.tier, input.role, input.tier, input.role, ROUTING_CELL_RETENTION);
      });
    },
    currentOrder(tier, role) {
      const row = order.get(tier, role);
      if (!row) return undefined;
      const parsed: unknown = JSON.parse(row.order_json as string);
      if (!Array.isArray(parsed) || !parsed.every((value: unknown) => typeof value === "string")) throw new Error("Invalid routing order");
      return parsed as string[];
    },
    suspendedProfiles(now) {
      return new Set(suspensions.all(now.toISOString()).map((row) => row.profile as string));
    },
    explorationSpend(since) {
      const row = spend.get(since.toISOString())!;
      return { knownUsd: row.known_usd as number, costUnknown: (row.unknown as number) > 0, pending: row.pending as number };
    },
  };
}

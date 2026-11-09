import type { ConfiguredExecutionProfile } from "../execution-profile.js";
import type { WorkspaceModeEntry } from "../execution-modes.js";
import type { HistoryStore } from "../history/store.js";
import { ROLES, TIERS, type Role, type RoutingConfig, type RoutingMode, type Tier } from "./config.js";
import { routeStart, type RoutedStart, type RoutingRequest } from "./select.js";
import { createRoutingStore } from "./store.js";

export interface RoutingRuntime {
  readonly config: RoutingConfig;
  route(request: RoutingRequest, input: { defaultProfile: string; profiles: ReadonlyMap<string, ConfiguredExecutionProfile>; workspaceMode: WorkspaceModeEntry; relay: boolean }): RoutedStart;
  afterStart(sessionId: string, routed: RoutedStart): void;
  capabilities(): { mode: RoutingMode; tiers?: Record<Tier, Record<Role, string[]>>; families?: Record<string, string> };
}
export function createRoutingRuntime(options: { config: RoutingConfig; store?: HistoryStore; now?: () => Date; random?: () => number; diagnostic?: (code: string) => void; refresh?: () => void }): RoutingRuntime {
  const { config } = options;
  const now = options.now ?? (() => new Date());
  const diagnostic = (code: string): void => { try { options.diagnostic?.(code); } catch { /* diagnostics cannot affect starts */ } };
  return {
    config,
    route(request, input) {
      const orders = new Map<string, readonly string[]>();
      let suspended: ReadonlySet<string> = new Set();
      let allowed = false;
      if (config.mode !== "off" && options.store) {
        try {
          const store = createRoutingStore(options.store);
          for (const tier of TIERS) for (const role of ROLES) {
            const order = store.currentOrder(tier, role);
            if (order) orders.set(`${tier}:${role}`, order);
          }
          suspended = store.suspendedProfiles(now());
          if (config.mode === "auto") {
            const spend = store.explorationSpend(new Date(now().getTime() - 7 * 24 * 60 * 60 * 1000));
            allowed = !spend.costUnknown && spend.pending < 3 && spend.knownUsd < config.learning.explorationBudgetUsd;
          }
        } catch {
          orders.clear(); suspended = new Set(); allowed = false;
          diagnostic("routing_store_unavailable");
        }
      }
      return routeStart(request, { ...input, config, order: (tier, role) => orders.get(`${tier}:${role}`), suspended, exploration: { allowed, rate: config.learning.explorationRate, random: options.random ?? Math.random } });
    },
    afterStart(sessionId, routed) {
      if (config.mode === "off" || !options.store) return;
      try {
        if (routed.decision) createRoutingStore(options.store).recordDecision({ ...routed.decision, sessionRef: sessionId, decidedAt: now().toISOString() });
        if (options.refresh) setImmediate(() => { try { options.refresh?.(); } catch { diagnostic("routing_refresh_failed"); } });
      } catch { diagnostic("routing_store_unavailable"); }
    },
    capabilities() {
      if (config.mode === "off") return { mode: "off" };
      const tiers = Object.fromEntries(TIERS.map(tier => [tier, Object.fromEntries(ROLES.map(role => [role, [...config.tiers[tier][role]].sort()]))])) as Record<Tier, Record<Role, string[]>>;
      return { mode: config.mode, tiers, families: Object.fromEntries([...config.families].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) };
    },
  };
}

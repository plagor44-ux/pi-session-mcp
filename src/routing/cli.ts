import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { historyLocation, openHistoryStore, type HistoryStore } from "../history/store.js";
import { loadRoutingConfig, routingConfigPath, writeRoutingDocument, ROLES, TIERS, type Role, type Tier } from "./config.js";
import { refreshRouting } from "./learn.js";
import { createRoutingStore } from "./store.js";

export interface RoutingCliIo { stdout(text: string): void; stderr(text: string): void; home?: string; now?: () => Date; configPath?: string }
class Failure extends Error { constructor(readonly code: string) { super(code); } }
const fail = (code: string): never => { throw new Failure(code); };
const isTier = (value: string | undefined): value is Tier => (TIERS as readonly string[]).includes(value ?? "");
const isRole = (value: string | undefined): value is Role => (ROLES as readonly string[]).includes(value ?? "");

export async function runRoutingCli(argv: readonly string[], io: RoutingCliIo): Promise<0 | 1 | 64> {
  const [command, ...args] = argv;
  const valid = (command === "status" && (args.length === 0 || (args.length === 1 && args[0] === "--json"))) ||
    (command === "mode" && args.length === 1 && ["off", "manual", "auto"].includes(args[0]!)) ||
    ((command === "proposals" || command === "refresh") && args.length === 0) ||
    (command === "apply" && args.length === 1 && /^[1-9]\d*$/.test(args[0]!) && Number.isSafeInteger(Number(args[0]))) ||
    ((command === "rollback" || command === "unfreeze") && args.length === 2 && isTier(args[0]) && isRole(args[1]));
  if (!valid) { io.stderr("usage_invalid\n"); return 64; }
  let store: HistoryStore | undefined;
  try {
    const path = io.configPath ?? process.env.PI_SESSION_MCP_CONFIG ?? join(io.home ?? userInfo().homedir, ".config", "pi-session-mcp", "pi-session-mcp.json");
    if (command === "mode" && !existsSync(routingConfigPath(path))) fail("routing_not_configured");
    const config = await loadConfig(path);
    const routing = await loadRoutingConfig(path, config.executionProfiles, config.workspaces);
    if (command === "mode") {
      if (args[0] === "auto" && !config.history?.enabled) fail("routing_history_required");
      const document = JSON.parse(await readFile(routingConfigPath(path), "utf8")) as Record<string, unknown>;
      await writeRoutingDocument(path, { ...document, mode: args[0] });
      io.stdout("mode updated; running clients need a reconnect\n"); return 0;
    }
    const historyExists = existsSync(historyLocation(io.home).file);
    if (historyExists && config.history?.enabled) store = await openHistoryStore({ ...(io.home === undefined ? {} : { home: io.home }), readOnly: command === "status" || command === "proposals" });
    if (!store && command !== "status" && command !== "proposals") fail("history_unavailable");
    const db = store?.db;
    if (command === "status") {
      const routingStore = store && createRoutingStore(store);
      const cells = TIERS.flatMap(tier => ROLES.map(role => {
        const listed = routing.tiers[tier][role]; const saved = routingStore?.currentOrder(tier, role) ?? [];
        const order = [...new Set([...saved.filter(p => listed.includes(p)), ...listed])];
        const rows = db?.prepare("SELECT profile, count(*) AS n FROM routing_decisions WHERE tier = ? AND role = ? AND settled = 1 AND turns > 0 AND verdict IS NOT NULL GROUP BY profile").all(tier, role) ?? [];
        const samples = Object.fromEntries(order.map(profile => [profile, Number(rows.find(row => row.profile === profile)?.n ?? 0)]));
        const frozen = db?.prepare("SELECT frozen FROM routing_cells WHERE tier = ? AND role = ?").get(tier, role)?.frozen === 1;
        const counts = db?.prepare("SELECT count(*) AS total, sum(CASE WHEN verdict IS NOT NULL THEN 1 ELSE 0 END) AS verdicts, sum(CASE WHEN origin IN ('explicit','default') THEN 1 ELSE 0 END) AS bypasses FROM routing_decisions WHERE tier = ? AND role = ?").get(tier, role);
        const count = Number(counts?.total ?? 0);
        return { tier, role, order, samples, minSamples: routing.learning.minSamples, frozen, verdictCoverage: count ? Number(counts?.verdicts ?? 0) / count : 0, bypassShare: count ? Number(counts?.bypasses ?? 0) / count : 0 };
      }));
      const totals = db?.prepare("SELECT count(*) AS total, sum(CASE WHEN verdict IS NOT NULL THEN 1 ELSE 0 END) AS verdicts, sum(CASE WHEN origin IN ('explicit','default') THEN 1 ELSE 0 END) AS bypasses FROM routing_decisions").get();
      const total = Number(totals?.total ?? 0);
      const report = { mode: routing.mode, cells, verdictCoverage: total ? Number(totals?.verdicts ?? 0) / total : 0, bypassShare: total ? Number(totals?.bypasses ?? 0) / total : 0 };
      io.stdout(JSON.stringify(report, null, args.includes("--json") ? 0 : 2) + "\n"); return 0;
    }
    if (command === "proposals") {
      const rows = db?.prepare("SELECT id, tier, role, kind, profile FROM routing_versions WHERE state = 'proposed' ORDER BY id").all() ?? [];
      const safe = rows.filter(row => isTier(String(row.tier)) && isRole(String(row.role)) && (row.kind === "reorder" || row.kind === "suspend") && (row.profile === null || (typeof row.profile === "string" && config.executionProfiles.has(row.profile))));
      io.stdout(JSON.stringify(safe) + "\n"); return 0;
    }
    const active = store!; const database = active.db;
    if (command === "refresh") { const result = refreshRouting({ store: active, config: routing, now: io.now?.() ?? new Date() }); io.stdout(JSON.stringify(result) + "\n"); return 0; }
    if (command === "apply") {
      active.transaction(() => {
        const row = database.prepare("SELECT * FROM routing_versions WHERE id = ? AND state = 'proposed'").get(Number(args[0]));
        if (!row || !isTier(String(row.tier)) || !isRole(String(row.role))) return fail("routing_proposal_unavailable");
        const tier = row.tier as Tier, role = row.role as Role;
        if (row.kind === "reorder") {
          const order: unknown = JSON.parse(String(row.after_json));
          if (!Array.isArray(order) || order.some(p => typeof p !== "string" || !routing.tiers[tier][role].includes(p)) || new Set(order).size !== order.length || order.length !== routing.tiers[tier][role].length) return fail("routing_proposal_unavailable");
          database.prepare("INSERT INTO routing_cells (tier,role,order_json,frozen) VALUES (?,?,?,0) ON CONFLICT(tier,role) DO UPDATE SET order_json=excluded.order_json").run(tier, role, JSON.stringify(order));
        } else if (row.kind === "suspend" && typeof row.profile === "string" && routing.tiers[tier][role].includes(row.profile)) {
          database.prepare("INSERT INTO routing_suspensions (profile,until,reason) VALUES (?,?,'failed_sessions') ON CONFLICT(profile) DO UPDATE SET until=excluded.until, reason=excluded.reason").run(row.profile, new Date((io.now?.() ?? new Date()).getTime() + 86400000).toISOString());
        } else return fail("routing_proposal_unavailable");
        database.prepare("UPDATE routing_versions SET state='applied' WHERE id=?").run(Number(args[0]));
      });
    } else if (command === "rollback") {
      active.transaction(() => {
        const row = database.prepare("SELECT id, before_json FROM routing_versions WHERE tier=? AND role=? AND kind='reorder' AND state='applied' ORDER BY id DESC LIMIT 1").get(args[0]!, args[1]!);
        if (!row) return fail("routing_version_unavailable");
        const before: unknown = JSON.parse(String(row.before_json));
        if (!Array.isArray(before) || before.some(p => typeof p !== "string" || !routing.tiers[args[0] as Tier][args[1] as Role].includes(p))) return fail("routing_version_unavailable");
        database.prepare("INSERT INTO routing_cells (tier,role,order_json,frozen) VALUES (?,?,?,1) ON CONFLICT(tier,role) DO UPDATE SET order_json=excluded.order_json,frozen=1").run(args[0]!, args[1]!, JSON.stringify(before));
        database.prepare("UPDATE routing_versions SET state='rolled_back' WHERE id=?").run(row.id!);
      });
    } else {
      database.prepare("UPDATE routing_cells SET frozen=0 WHERE tier=? AND role=?").run(args[0]!, args[1]!);
    }
    io.stdout("routing updated\n"); return 0;
  } catch (error) {
    io.stderr(`${error instanceof Failure ? error.code : error instanceof Error && "code" in error && error.code === "routing_config_invalid" ? "routing_config_invalid" : "routing_unavailable"}\n`); return 1;
  } finally { store?.close(); }
}

import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openHistoryStore } from "../src/history/store.js";
import { runRoutingCli } from "../src/routing/cli.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);
const now = new Date("2026-11-09T12:00:00.000Z");
async function fixture(history = true) {
  const home = await temporaryRoot("routing-cli-"); const configPath = join(home, "config.json");
  await writeFile(configPath, JSON.stringify({ workspaces: { repo: "." }, executionProfiles: { a: { provider: "fake", model: "fake", permissionProfile: "coding", default: false, thinkingLevel: "medium" }, b: { provider: "fake", model: "fake", permissionProfile: "coding", default: false, thinkingLevel: "medium" }, reader: { provider: "fake", model: "fake", permissionProfile: "read-only", default: true, thinkingLevel: "medium" } }, history: { enabled: history } }));
  const document = { mode: "manual", tiers: { medium: { code: ["a", "b"] } }, families: { a: "one", b: "two" }, learning: { minSamples: 8 } };
  await writeFile(join(home, "routing.json"), JSON.stringify(document));
  const store = await openHistoryStore({ home });
  const run = async (...args: string[]) => { let out = "", err = ""; const code = await runRoutingCli(args, { home, configPath, now: () => now, stdout: s => { out += s; }, stderr: s => { err += s; } }); return { code, out, err }; };
  return { home, configPath, document, store, run };
}
function proposal(store: Awaited<ReturnType<typeof openHistoryStore>>, kind = "reorder") {
  return Number(store.db.prepare("INSERT INTO routing_versions (tier,role,kind,profile,before_json,after_json,reason,state,created_at) VALUES ('medium','code',?,?,'[\"a\",\"b\"]','[\"b\",\"a\"]','reason','proposed','now')").run(kind, kind === "suspend" ? "a" : null).lastInsertRowid);
}
describe("routing CLI", () => {
  it("shows order, samples against minSamples, coverage and bypasses", async () => { const f = await fixture(); try {
    f.store.db.exec("INSERT INTO routing_decisions (session_ref,decided_at,tier,role,risk,profile,origin,exploration,same_family_override,turns,verdict,settled) VALUES ('1','now','medium','code','normal','a','explicit',0,0,1,'accepted',1),('2','now',NULL,NULL,'normal','a','default',0,0,0,NULL,0)");
    const result = await f.run("status", "--json"); expect(result.code).toBe(0); const status = JSON.parse(result.out); const cell = status.cells.find((c: {tier: string; role: string}) => c.tier === "medium" && c.role === "code"); expect(cell.order).toEqual(["a", "b"]); expect(cell.samples).toEqual({ a: 1, b: 0 }); expect(cell.minSamples).toBe(8); expect(cell.verdictCoverage).toBe(1); expect(cell.bypassShare).toBe(1); expect(status.verdictCoverage).toBe(0.5); expect(status.bypassShare).toBe(1);
  } finally { f.store.close(); } });
  it("changes only the mode", async () => { const f = await fixture(); try { const r = await f.run("mode", "auto"); expect(r.code).toBe(0); expect(r.out).toContain("reconnect"); expect(JSON.parse(await readFile(join(f.home, "routing.json"), "utf8"))).toEqual({ ...f.document, mode: "auto" }); } finally { f.store.close(); } });
  it("refuses auto without history", async () => { const f = await fixture(false); try { expect(await f.run("mode", "auto")).toMatchObject({ code: 1, err: "routing_history_required\n" }); } finally { f.store.close(); } });
  it("refuses mode without routing.json", async () => { const f = await fixture(); try { await unlink(join(f.home, "routing.json")); expect(await f.run("mode", "off")).toMatchObject({ code: 1, err: "routing_not_configured\n" }); } finally { f.store.close(); } });
  it("applies a proposal", async () => { const f = await fixture(); try { const id = proposal(f.store); expect((await f.run("apply", String(id))).code).toBe(0); expect(f.store.db.prepare("SELECT order_json FROM routing_cells").get()).toMatchObject({ order_json: '["b","a"]' }); expect(f.store.db.prepare("SELECT state FROM routing_versions").get()).toMatchObject({ state: "applied" }); expect((await f.run("apply", String(id))).code).toBe(1); } finally { f.store.close(); } });
  it("applies a suspend proposal for 24 hours", async () => { const f = await fixture(); try { const id = proposal(f.store, "suspend"); expect((await f.run("apply", String(id))).code).toBe(0); expect(f.store.db.prepare("SELECT profile, until FROM routing_suspensions").get()).toMatchObject({ profile: "a", until: "2026-11-10T12:00:00.000Z" }); } finally { f.store.close(); } });
  it("rolls back and freezes the cell", async () => { const f = await fixture(); try { const id = proposal(f.store); await f.run("apply", String(id)); expect((await f.run("rollback", "medium", "code")).code).toBe(0); expect(f.store.db.prepare("SELECT order_json, frozen FROM routing_cells").get()).toMatchObject({ order_json: '["a","b"]', frozen: 1 }); expect(f.store.db.prepare("SELECT state FROM routing_versions").get()).toMatchObject({ state: "rolled_back" }); } finally { f.store.close(); } });
  it("unfreezes a cell", async () => { const f = await fixture(); try { f.store.db.exec(`INSERT INTO routing_cells VALUES ('medium','code','[]',1)`); expect((await f.run("unfreeze", "medium", "code")).code).toBe(0); expect(f.store.db.prepare("SELECT frozen FROM routing_cells").get()).toMatchObject({ frozen: 0 }); } finally { f.store.close(); } });
  it("lists proposals and runs a manual refresh", async () => { const f = await fixture(); try { const id = proposal(f.store); const listed = await f.run("proposals"); expect(JSON.parse(listed.out)).toEqual([expect.objectContaining({ id, tier: "medium", role: "code", kind: "reorder" })]); const refreshed = await f.run("refresh"); expect(refreshed.code).toBe(0); expect(JSON.parse(refreshed.out)).toEqual({ outcomes: 0, changes: 0, proposals: 0 }); } finally { f.store.close(); } });
  it("prints no path", async () => { const f = await fixture(); try { for (const args of [["status", "--json"], ["proposals"], ["bad", f.home]]) { const r = await f.run(...args); expect(r.out + r.err).not.toContain(f.home); } } finally { f.store.close(); } });
  it("returns 64 for unknown commands and arguments", async () => { const f = await fixture(); try { for (const args of [[], ["bad"], ["status", "--bad"], ["rollback", "bad", "code"], ["apply", "1", "extra"]]) expect((await f.run(...args)).code).toBe(64); } finally { f.store.close(); } });
});

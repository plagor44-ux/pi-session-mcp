import { afterAll, describe, expect, it } from "vitest";
import { explorationAllowed, maybeRefreshRouting, nextSwap, refreshRouting, wilsonLowerBound } from "../src/routing/learn.js";
import { openHistoryStore } from "../src/history/store.js";
import { ROUTING_OFF, type RoutingConfig } from "../src/routing/config.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);
const now = new Date("2026-11-09T00:00:00.000Z");
function config(mode: "auto" | "manual" = "auto"): RoutingConfig {
  return { ...ROUTING_OFF, mode, tiers: { ...ROUTING_OFF.tiers, medium: { ...ROUTING_OFF.tiers.medium, code: ["a", "b"] } } };
}
async function fixture() {
  const home = await temporaryRoot("learn-");
  const store = await openHistoryStore({ home });
  store.db.exec("INSERT INTO instances (id,pid,package_version,started_at) VALUES ('i',1,'1','now')");
  const session = store.db.prepare("INSERT INTO sessions (id,instance_id,public_session_id,workspace,execution_profile,package_version,configuration_fingerprint,created_at,closed_at,capture_source) VALUES (?,'i',?,'w',?,'1','f',?,?,'host')");
  const turn = store.db.prepare("INSERT INTO turns (session_id,turn_id,state) VALUES (?,?,?)");
  const verdict = store.db.prepare("INSERT INTO verdicts (session_id,verdict,reason,recorded_at,source) VALUES (?,?,'','now','test')");
  const decision = store.db.prepare("INSERT INTO routing_decisions (session_ref,decided_at,tier,role,risk,profile,origin,exploration,same_family_override) VALUES (?,?,'medium','code','normal',?,'floor',0,0)");
  function add(id: string, profile: string, state = "completed", outcome = "accepted") {
    session.run(id, id, profile, now.toISOString(), now.toISOString()); turn.run(id, "t", state); verdict.run(id, outcome); decision.run(id, now.toISOString(), profile);
  }
  return { store, home, add, turn, verdict };
}

const stat = (profile: string, samples: number, meanScore: number, medianCostUsd: number | null = null) => ({ profile, samples, meanScore, medianCostUsd });
const limits = { minSamples: 8, margin: 0.1 };
describe("routing learning", () => {
  it("computes the Wilson bound", () => {
    expect(wilsonLowerBound(1, 8)).toBeCloseTo(0.6756, 4);
    expect(wilsonLowerBound(0.5, 8)).toBeCloseTo(0.2152, 4);
    expect(wilsonLowerBound(1, 0)).toBe(0);
  });
  it("does not reorder below minSamples", () => expect(nextSwap([stat("a", 7, 0), stat("b", 7, 1)], limits)).toBeUndefined());
  it("swaps when the bound exceeds the margin", () => expect(nextSwap([stat("a", 8, 0), stat("b", 8, 1)], limits)).toEqual(["b", "a"]));
  it("does not swap at exactly the margin", () => expect(nextSwap([stat("a", 8, 0), stat("b", 8, 1)], { ...limits, margin: wilsonLowerBound(1, 8) })).toBeUndefined());
  it("puts the cheaper profile first within the margin", () => expect(nextSwap([stat("a", 8, 1, 2), stat("b", 8, 1, 1)], limits)).toEqual(["b", "a"]));
  it("leaves an under-sampled profile in place", () => expect(nextSwap([stat("a", 8, 0), stat("x", 2, 1), stat("b", 8, 1)], limits)).toEqual(["b", "x", "a"]));
  it("makes one change per cell per refresh", async () => {
    const { store, add } = await fixture();
    try { for (let i = 0; i < 8; i++) { add(`a${i}`, "a", "completed", "rejected"); add(`b${i}`, "b"); }
      expect(refreshRouting({ store, config: config(), now }).changes).toBe(1);
      expect(refreshRouting({ store, config: config(), now }).changes).toBe(0);
    } finally { store.close(); }
  });
  it("uses the latest verdict of a session", async () => {
    const { store, add, verdict } = await fixture();
    try { add("one", "a"); verdict.run("one", "rejected"); refreshRouting({ store, config: config(), now });
      expect(store.db.prepare("SELECT verdict FROM routing_decisions").get()).toMatchObject({ verdict: "rejected" });
    } finally { store.close(); }
  });
  it("counts failed sessions, not failed turns", async () => {
    const { store, add, turn } = await fixture();
    try { add("one", "a", "failed"); turn.run("one", "two", "failed"); turn.run("one", "three", "failed");
      refreshRouting({ store, config: config(), now }); expect(store.db.prepare("SELECT * FROM routing_suspensions").all()).toHaveLength(0);
      add("two", "a", "failed"); add("three", "a", "failed"); refreshRouting({ store, config: config(), now });
      expect(store.db.prepare("SELECT profile FROM routing_suspensions").all()).toHaveLength(1);
    } finally { store.close(); }
  });
  it("runs one refresh when two servers race", async () => {
    const { store, home, add } = await fixture();
    const other = await openHistoryStore({ home });
    try { for (let i = 0; i < 8; i++) { add(`a${i}`, "a", "completed", "rejected"); add(`b${i}`, "b"); }
      expect([maybeRefreshRouting({ store, config: config(), now }), maybeRefreshRouting({ store: other, config: config(), now })]).toEqual([true, false]);
      expect(store.db.prepare("SELECT * FROM routing_versions").all()).toHaveLength(1);
      expect(maybeRefreshRouting({ store, config: config(), now: new Date(now.getTime() + 86400000) })).toBe(true);
    } finally { other.close(); store.close(); }
  });
  it("ignores deadline stops for suspension", async () => {
    const { store, add } = await fixture();
    try { for (let i = 0; i < 3; i++) add(`a${i}`, "a", "aborted");
      refreshRouting({ store, config: config(), now }); expect(store.db.prepare("SELECT * FROM routing_suspensions").all()).toHaveLength(0);
    } finally { store.close(); }
  });
  it("never suspends the last candidate", async () => {
    const { store, add } = await fixture();
    try { for (let i = 0; i < 3; i++) { add(`a${i}`, "a", "failed"); add(`b${i}`, "b", "failed"); }
      refreshRouting({ store, config: config(), now }); expect(store.db.prepare("SELECT * FROM routing_suspensions").all()).toHaveLength(1);
    } finally { store.close(); }
  });
  it("only proposes in manual mode", async () => {
    const { store, add } = await fixture();
    try { for (let i = 0; i < 8; i++) { add(`a${i}`, "a", "completed", "rejected"); add(`b${i}`, "b"); }
      expect(refreshRouting({ store, config: config("manual"), now }).proposals).toBe(1);
      expect(store.db.prepare("SELECT * FROM routing_cells").all()).toHaveLength(0);
      expect(store.db.prepare("SELECT state FROM routing_versions").get()).toMatchObject({ state: "proposed" });
    } finally { store.close(); }
  });
  it("skips a frozen cell", async () => {
    const { store, add } = await fixture();
    try { for (let i = 0; i < 8; i++) { add(`a${i}`, "a", "completed", "rejected"); add(`b${i}`, "b"); }
      store.db.exec(`INSERT INTO routing_cells VALUES ('medium','code','["a","b"]',1)`);
      expect(refreshRouting({ store, config: config(), now }).changes).toBe(0);
    } finally { store.close(); }
  });
  it("is stable after a swap", async () => {
    const { store, add } = await fixture();
    try { for (let i = 0; i < 8; i++) { add(`a${i}`, "a", "completed", "rejected"); add(`b${i}`, "b"); }
      refreshRouting({ store, config: config(), now }); expect(refreshRouting({ store, config: config(), now }).changes).toBe(0);
    } finally { store.close(); }
  });
  it("refreshes again after 24 hours only", async () => {
    const { store } = await fixture();
    try { expect(maybeRefreshRouting({ store, config: config(), now })).toBe(true);
      expect(maybeRefreshRouting({ store, config: config(), now: new Date(now.getTime() + 86399999) })).toBe(false);
      expect(maybeRefreshRouting({ store, config: config(), now: new Date(now.getTime() + 86400000) })).toBe(true);
    } finally { store.close(); }
  });
  it("stops exploration over budget, unknown cost or 3 pending", () => {
    expect(explorationAllowed({ knownUsd: 1, costUnknown: false, pending: 2 }, 5)).toBe(true);
    expect(explorationAllowed({ knownUsd: 5, costUnknown: false, pending: 0 }, 5)).toBe(false);
    expect(explorationAllowed({ knownUsd: 0, costUnknown: true, pending: 0 }, 5)).toBe(false);
    expect(explorationAllowed({ knownUsd: 0, costUnknown: false, pending: 3 }, 5)).toBe(false);
  });
});

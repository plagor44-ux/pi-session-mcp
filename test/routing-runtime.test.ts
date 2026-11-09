import { afterAll, expect, it, vi } from "vitest";
import { createRoutingRuntime } from "../src/routing/runtime.js";
import { parseRoutingConfig, ROUTING_OFF } from "../src/routing/config.js";
import { openHistoryStore } from "../src/history/store.js";
import { temporaryRoot, removeTemporaryRoots } from "./temporary-roots.js";
import type { ConfiguredExecutionProfile } from "../src/execution-profile.js";
afterAll(removeTemporaryRoots);
const profiles = new Map<string, ConfiguredExecutionProfile>(["z", "a"].map(alias => [alias, { alias, default: alias === "z", permissionProfile: "coding", provider: "fake", model: "fake", thinkingLevel: "off" }]));
const config = parseRoutingConfig({ mode: "auto", tiers: { medium: { code: ["z", "a"] } }, families: { z: "one", a: "two" }, learning: { explorationRate: 1 } }, profiles, new Map());
const input = { defaultProfile: "z", profiles, workspaceMode: { mode: "host" as const }, relay: true };
it("uses the routing.json order when the store throws", async () => {
  const store = await openHistoryStore({ home: await temporaryRoot("routing-runtime-") });
  const diagnostic = vi.fn(); const runtime = createRoutingRuntime({ config, store, diagnostic, random: () => 0 }); store.close();
  expect(runtime.route({ workspace: "repo", role: "code" }, input).alias).toBe("z"); expect(diagnostic).toHaveBeenCalledWith(expect.any(String));
});
it("does not explore without a store", () => {
  const runtime = createRoutingRuntime({ config, random: () => 0 });
  expect(runtime.route({ workspace: "repo", role: "code" }, input).result?.exploration).toBe(false);
});
it("records a decision after a start and never throws", async () => {
  const store = await openHistoryStore({ home: await temporaryRoot("routing-runtime-") });
  const runtime = createRoutingRuntime({ config, store, random: () => 1 }); const routed = runtime.route({ workspace: "repo", role: "code" }, input);
  runtime.afterStart("session", routed); expect(store.db.prepare("SELECT session_ref FROM routing_decisions").get()?.session_ref).toBe("session");
  store.close(); expect(() => runtime.afterStart("session", routed)).not.toThrow();
});
it("records nothing in mode off", async () => {
  const store = await openHistoryStore({ home: await temporaryRoot("routing-runtime-") });
  try {
    const runtime = createRoutingRuntime({ config: ROUTING_OFF, store });
    const routed = runtime.route({ workspace: "repo" }, input);
    expect(routed.decision).toBeUndefined(); runtime.afterStart("session", routed);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM routing_decisions").get()?.n).toBe(0);
  } finally { store.close(); }
});
it("discards learned orders and suspensions together on a store failure", async () => {
  const store = await openHistoryStore({ home: await temporaryRoot("routing-runtime-") });
  try {
    store.db.exec(`INSERT INTO routing_cells VALUES ('medium', 'code', '["a","z"]', 0), ('hightech', 'code', 'invalid', 0); INSERT INTO routing_suspensions VALUES ('z', '2099-01-01', 'failed');`);
    const diagnostic = vi.fn(); const runtime = createRoutingRuntime({ config, store, diagnostic, random: () => 0 });
    expect(runtime.route({ workspace: "repo", role: "code" }, input)).toMatchObject({ alias: "z", result: { exploration: false } });
    expect(diagnostic.mock.calls).toEqual([["routing_store_unavailable"]]);
  } finally { store.close(); }
});
it("does not publish learned order and returns detached sorted lists", async () => {
  const store = await openHistoryStore({ home: await temporaryRoot("routing-runtime-") });
  try {
    store.db.exec(`INSERT INTO routing_cells VALUES ('medium', 'code', '["z","a"]', 0)`);
    const runtime = createRoutingRuntime({ config, store });
    const capabilities = runtime.capabilities(); expect(capabilities.tiers?.medium.code).toEqual(["a", "z"]);
    capabilities.tiers?.medium.code.reverse(); expect(runtime.capabilities().tiers?.medium.code).toEqual(["a", "z"]);
  } finally { store.close(); }
});
it("never propagates a throwing diagnostic", async () => {
  const store = await openHistoryStore({ home: await temporaryRoot("routing-runtime-") });
  const runtime = createRoutingRuntime({ config, store, diagnostic: () => { throw new Error("private detail"); } });
  store.close(); expect(() => runtime.afterStart("session", { alias: "z", decision: { tier: null, role: null, risk: "normal", profile: "z", family: "one", origin: "default", exploration: false, sameFamilyOverride: false } })).not.toThrow();
  expect(runtime.route({ workspace: "repo", role: "code" }, input).alias).toBe("z");
});

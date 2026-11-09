import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { SessionRegistry } from "../src/session-registry.js";
import { FakeAdapter } from "./fake-adapter.js";
import { createRoutingRuntime } from "../src/routing/runtime.js";
import { parseRoutingConfig, type RoutingMode } from "../src/routing/config.js";
import type { ConfiguredExecutionProfile } from "../src/execution-profile.js";
const profiles = new Map<string, ConfiguredExecutionProfile>(["z", "a"].map(alias => [alias, { alias, default: alias === "z", permissionProfile: "coding", provider: "fake", model: "fake", thinkingLevel: "off" }]));
const workspaces = new Map([["repo", "/safe/repo"]]);
const closes: (() => Promise<void>)[] = []; afterEach(async () => { await Promise.all(closes.splice(0).map(close => close())); });
async function connect(mode?: RoutingMode) {
  const registry = new SessionRegistry(new FakeAdapter(), workspaces);
  const routing = mode === undefined ? undefined : createRoutingRuntime({ config: parseRoutingConfig({ mode, tiers: { medium: { code: ["z", "a"] } }, families: { z: "one", a: "two" } }, profiles, workspaces) });
  const server = createServer(registry, workspaces, profiles, "z", { fingerprint: `sha256:${"0".repeat(64)}`, reloadPolicy: "restart-required" }, new Map(), "off", true, routing ? { routing } : {});
  const client = new Client({ name: "test", version: "1" }); const [ct, st] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(st), client.connect(ct)]);
  closes.push(async () => { await client.close(); await server.close(); await registry.shutdown(); });
  return async (args: Record<string, unknown>, name = "pi_session_start") => (await client.callTool({ name, arguments: args })).structuredContent;
}
it.each(["off", "manual", "auto"] as const)("starts with an explicit profile in every mode (%s)", async mode => { const call = await connect(mode); const result = await call({ workspace: "repo", executionProfile: "a" }); expect(result).toMatchObject({ ok: true }); expect(result).not.toHaveProperty("routing"); });
it.each(["off", "manual", "auto"] as const)("starts a call without routing arguments as today when routing is on (%s)", async mode => { const call = await connect(mode); const result = await call({ workspace: "repo" }); expect(result).toMatchObject({ ok: true, session: { executionProfile: "z" } }); expect(result).not.toHaveProperty("routing"); });
it("returns the routing block for a tier start", async () => { const call = await connect("manual"); expect(await call({ workspace: "repo", tier: "medium", role: "code" })).toMatchObject({ ok: true, routing: { tier: "medium", role: "code", profile: "z", reason: "floor", exploration: false } }); });
it("projects routing errors with their code", async () => { const call = await connect(); expect(await call({ workspace: "repo", role: "code" })).toMatchObject({ ok: false, error: { code: "routing_off" } }); });
it("publishes mode off and no tiers without a runtime", async () => { const call = await connect(); expect(await call({}, "pi_capabilities_get")).toHaveProperty("routing", { mode: "off" }); });
it.each(["off", "manual", "auto"] as const)("keeps the legacy alias check order (%s)", async mode => {
  const call = await connect(mode);
  expect(await call({ workspace: "gone", executionProfile: "gone", base: "dev", role: "review", risk: "high", authorFamily: "one", shell: true })).toMatchObject({ ok: false, error: { code: "unknown_execution_profile" } });
  expect(await call({ workspace: "gone" })).toMatchObject({ ok: false, error: { code: "unknown_workspace" } });
  expect(await call({ workspace: "repo", executionProfile: "a", tier: "medium" })).toMatchObject({ ok: false, error: { code: "routing_profile_conflict" } });
});
it("publishes sorted tiers and families when on", async () => { const call = await connect("manual"); expect(await call({}, "pi_capabilities_get")).toMatchObject({ routing: { mode: "manual", tiers: { medium: { code: ["a", "z"] } }, families: { z: "one", a: "two" } } }); });

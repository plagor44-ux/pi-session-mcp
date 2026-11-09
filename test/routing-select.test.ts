import { describe, expect, it, vi } from "vitest";
import type { ConfiguredExecutionProfile } from "../src/execution-profile.js";
import { parseRoutingConfig, TIERS, type RoutingConfig } from "../src/routing/config.js";
import { floorFor, routeStart, RoutingError, type RoutingRequest, type SelectionContext } from "../src/routing/select.js";

const profile = (alias: string, permissionProfile: "coding" | "read-only", extra: Partial<ConfiguredExecutionProfile> = {}): ConfiguredExecutionProfile => ({ alias, permissionProfile, default: false, provider: "fake", model: "fake", thinkingLevel: "medium", ...extra });
function context(document: Record<string, unknown> = {}): SelectionContext {
  const profiles = new Map([
    ["writer", profile("writer", "coding")], ["writer2", profile("writer2", "coding", { shell: "sandboxed" })],
    ["reader", profile("reader", "read-only")], ["other", profile("other", "read-only", { shell: "sandboxed" })],
    ["upper", profile("upper", "read-only")], ["highwriter", profile("highwriter", "coding")],
  ]);
  const config = parseRoutingConfig({ mode: "auto", tiers: { medium: { code: ["writer", "writer2"], review: ["reader", "other"] }, hightech: { code: ["highwriter"], review: ["upper"] } }, families: { writer: "openai", writer2: "glm", reader: "openai", other: "glm", upper: "openai", highwriter: "glm" }, ...document }, profiles, new Map([["repo", "."]]));
  return { config, profiles, defaultProfile: "writer", workspaceMode: { mode: "host" }, relay: true, order: () => undefined, suspended: new Set(), exploration: { allowed: false, rate: 0.1, random: vi.fn(() => 0) } };
}
const request = (extra: Partial<RoutingRequest> = {}): RoutingRequest => ({ workspace: "repo", ...extra });
function rejects(input: RoutingRequest, ctx: SelectionContext, code: string): void {
  expect(() => routeStart(input, ctx)).toThrowError(expect.objectContaining({ code }));
}

describe("routing profile selection", () => {
  it("refuses executionProfile and tier in any mode", () => {
    for (const mode of ["off", "manual", "auto"]) rejects(request({ executionProfile: "writer", tier: "medium" }), context({ mode }), "routing_profile_conflict");
  });
  it("returns an explicit alias without a decision when off", () => {
    expect(routeStart(request({ executionProfile: "missing", role: "review", risk: "high", shell: true }), context({ mode: "off" }))).toEqual({ alias: "missing" });
  });
  it("records an explicit alias when on, assigning a cell only for a listed role", () => {
    const ctx = context();
    expect(routeStart(request({ executionProfile: "reader", role: "review", risk: "high", allowSameFamily: true }), ctx)).toEqual({ alias: "reader", decision: { tier: "medium", role: "review", risk: "normal", profile: "reader", family: "openai", origin: "explicit", exploration: false, sameFamilyOverride: false } });
    for (const extra of [{}, { role: "code" as const }]) expect(routeStart(request({ executionProfile: "reader", ...extra }), ctx).decision).toMatchObject({ tier: null, role: null });
    expect(routeStart(request({ executionProfile: "missing" }), ctx).decision).toMatchObject({ family: null });
  });
  it("returns the default without a decision when off and neither tier nor role is given", () => {
    expect(routeStart(request({ risk: "high", shell: true }), context({ mode: "off" }))).toEqual({ alias: "writer" });
  });
  it("records the default when on and neither tier nor role is given", () => {
    expect(routeStart(request({ risk: "high", shell: true, authorFamily: "openai", allowSameFamily: true }), context())).toEqual({ alias: "writer", decision: { tier: null, role: null, risk: "normal", profile: "writer", family: "openai", origin: "default", exploration: false, sameFamilyOverride: false } });
  });
  it("refuses tier or role when off", () => {
    for (const extra of [{ tier: "medium" as const }, { role: "code" as const }]) rejects(request(extra), context({ mode: "off" }), "routing_off");
  });
  it("requires role with tier when on", () => { rejects(request({ tier: "medium" }), context(), "routing_role_required"); });
  it("selects for role with or without tier when on", () => {
    for (const extra of [{}, { tier: "medium" as const }]) expect(routeStart(request({ role: "code", ...extra }), context()).alias).toBe("writer");
  });
  it("uses the floor when tier is omitted", () => {
    expect(routeStart(request({ role: "code" }), context())).toMatchObject({ result: { tier: "medium", reason: "floor", exploration: false }, decision: { origin: "floor", risk: "normal" } });
  });
  it("uses hightech for risk high", () => { expect(routeStart(request({ role: "code", risk: "high" }), context()).result?.tier).toBe("hightech"); });
  it("honours a raised workspace floor", () => {
    const ctx = context({ floors: { workspaces: { repo: "hightech" } } });
    expect(routeStart(request({ role: "code" }), ctx).result?.tier).toBe("hightech");
    expect(floorFor(ctx.config, "explore", "normal", "repo")).toBe("hightech");
    expect(floorFor(ctx.config, "explore", "normal", "elsewhere")).toBe("low");
  });
  it("records a tier above the floor as raised", () => { expect(routeStart(request({ role: "code", tier: "hightech" }), context())).toMatchObject({ result: { reason: "raised" }, decision: { origin: "raised" } }); });
  it("refuses a tier below the floor", () => { rejects(request({ role: "code", tier: "low" }), context(), "routing_tier_below_floor"); });
  it("refuses review without authorFamily or allowSameFamily", () => { rejects(request({ role: "review" }), context(), "routing_author_required"); });
  it("never returns the author's family without the override", () => {
    const ctx = context(); ctx.suspended = new Set(["other"]);
    rejects(request({ role: "review", authorFamily: "openai" }), ctx, "routing_same_family");
  });
  it("falls back one tier for a review above the floor", () => {
    expect(routeStart(request({ role: "review", tier: "hightech", authorFamily: "openai" }), context())).toMatchObject({ alias: "other", result: { tier: "medium", reason: "lower_tier_review" }, decision: { tier: "medium", origin: "lower_tier_review", sameFamilyOverride: false } });
  });
  it("does not fall back below the floor", () => { rejects(request({ role: "review", tier: "hightech", risk: "high", authorFamily: "openai" }), context(), "routing_same_family"); });
  it("uses the same family with the override and records it", () => {
    expect(routeStart(request({ role: "review", tier: "hightech", authorFamily: "openai", allowSameFamily: true }), context())).toMatchObject({ alias: "upper", decision: { sameFamilyOverride: true } });
    expect(routeStart(request({ role: "review", allowSameFamily: true }), context()).decision?.sameFamilyOverride).toBe(true);
  });
  it("prefers another family even with the override", () => { expect(routeStart(request({ role: "review", authorFamily: "openai", allowSameFamily: true }), context())).toMatchObject({ alias: "other", decision: { sameFamilyOverride: false } }); });
  it("follows the stored order and appends new aliases", () => {
    const ctx = context(); ctx.order = () => ["writer2"];
    expect(routeStart(request({ role: "code" }), ctx).alias).toBe("writer2");
    ctx.suspended = new Set(["writer2"]);
    expect(routeStart(request({ role: "code" }), ctx).alias).toBe("writer");
  });
  it("drops stored aliases that left routing.json", () => {
    const ctx = context(); ctx.order = () => ["gone", "reader", "writer2"];
    expect(routeStart(request({ role: "code" }), ctx).alias).toBe("writer2");
  });
  it("skips suspended profiles", () => { const ctx = context(); ctx.suspended = new Set(["writer"]); expect(routeStart(request({ role: "code" }), ctx).alias).toBe("writer2"); });
  it("admits only a container workspace's profiles", () => {
    const ctx = context(); ctx.workspaceMode = { mode: "container", container: { profiles: ["writer2"], writers: 1, lifecycle: "persistent", image: "node", network: "none", cache: "none", tags: "none", clean: "all" } };
    expect(routeStart(request({ role: "code" }), ctx).alias).toBe("writer2");
    ctx.relay = false; rejects(request({ role: "code" }), ctx, "routing_no_candidate");
  });
  it("explores only when allowed and random is below rate", () => {
    const ctx = context(); const random = vi.fn().mockReturnValueOnce(0.05).mockReturnValueOnce(0.9); ctx.exploration = { allowed: true, rate: 0.1, random };
    expect(routeStart(request({ role: "code" }), ctx)).toMatchObject({ alias: "writer2", result: { exploration: true }, decision: { exploration: true } });
    expect(random).toHaveBeenCalledTimes(2);
    ctx.exploration.random = () => 0.1;
    expect(routeStart(request({ role: "code" }), ctx).alias).toBe("writer");
    ctx.exploration.allowed = false; ctx.exploration.random = () => 0;
    expect(routeStart(request({ role: "code" }), ctx).alias).toBe("writer");
    ctx.config = { ...ctx.config, mode: "manual" }; ctx.exploration.allowed = true;
    expect(routeStart(request({ role: "code" }), ctx).alias).toBe("writer");
  });
  it("uses a second random draw uniformly among candidates after the first", () => {
    const ctx = context();
    ctx.profiles = new Map(ctx.profiles).set("writer3", profile("writer3", "coding"));
    ctx.config = { ...ctx.config, tiers: { ...ctx.config.tiers, medium: { ...ctx.config.tiers.medium, code: ["writer", "writer2", "writer3"] } } };
    for (const [draw, alias] of [[0, "writer2"], [0.49, "writer2"], [0.5, "writer3"], [0.99, "writer3"]] as const) {
      ctx.exploration = { allowed: true, rate: 0.1, random: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(draw) };
      expect(routeStart(request({ role: "code" }), ctx)).toMatchObject({ alias, result: { exploration: true } });
    }
  });
  it("never explores with risk high", () => {
    const ctx = context({ floors: { riskHigh: "medium" } }); ctx.exploration.allowed = true;
    expect(routeStart(request({ role: "code", risk: "high" }), ctx).result?.exploration).toBe(false); expect(ctx.exploration.random).not.toHaveBeenCalled();
  });
  it("never explores with one candidate", () => {
    const ctx = context(); ctx.exploration.allowed = true; ctx.suspended = new Set(["writer2"]);
    expect(routeStart(request({ role: "code" }), ctx).result?.exploration).toBe(false); expect(ctx.exploration.random).not.toHaveBeenCalled();
  });
  it("returns routing_no_candidate for an empty cell", () => { rejects(request({ role: "explore" }), context(), "routing_no_candidate"); });
  it("requires sandboxed shell when requested", () => { expect(routeStart(request({ role: "code", shell: true }), context()).alias).toBe("writer2"); });
  it("filters coding by workspace mode", () => {
    for (const mode of ["read-only", "snapshot"] as const) { const ctx = context(); ctx.workspaceMode = { mode }; rejects(request({ role: "code" }), ctx, "routing_no_candidate"); }
  });
  it("filters snapshot profiles with extensions, grants or MCP servers", () => {
    for (const extra of [{ extensions: ["npm:fake@1.0.0"] }, { grantedExtensionTools: ["tool"] }, { mcpServers: { fake: { command: "fake" } } }]) {
      const ctx = context(); ctx.workspaceMode = { mode: "snapshot" };
      ctx.profiles = new Map(ctx.profiles).set("reader", profile("reader", "read-only", extra as Partial<ConfiguredExecutionProfile>));
      expect(routeStart(request({ role: "review", authorFamily: "unknown" }), ctx).alias).toBe("other");
    }
  });
  it("does not fall back for workspace or suspension exclusions", () => {
    const ctx = context(); ctx.suspended = new Set(["upper"]);
    rejects(request({ role: "review", tier: "hightech", authorFamily: "openai" }), ctx, "routing_no_candidate");
  });
  it("falls back only one tier and never explores into the author's family", () => {
    const ctx = context(); ctx.exploration.allowed = true;
    rejects(request({ role: "review", tier: "ultra", authorFamily: "openai" }), ctx, "routing_no_candidate");
    expect(routeStart(request({ role: "review", authorFamily: "openai" }), ctx).alias).toBe("other");
  });
  it("explores only among candidates left after the family filter", () => {
    const ctx = context();
    ctx.profiles = new Map(ctx.profiles).set("third", profile("third", "read-only"));
    ctx.config = { ...ctx.config, tiers: { ...ctx.config.tiers, medium: { ...ctx.config.tiers.medium, review: ["reader", "other", "third"] } }, families: new Map(ctx.config.families).set("third", "glm") };
    ctx.exploration = { allowed: true, rate: 0.1, random: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0) };
    expect(routeStart(request({ role: "review", authorFamily: "openai" }), ctx)).toMatchObject({ alias: "third", result: { exploration: true }, decision: { family: "glm", sameFamilyOverride: false } });
  });
  it("counts a duplicated alias once when exploring", () => {
    const ctx = context();
    ctx.config = { ...ctx.config, tiers: { ...ctx.config.tiers, medium: { ...ctx.config.tiers.medium, code: ["writer", "writer", "writer2"] } } };
    ctx.exploration = { allowed: true, rate: 0.1, random: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0) };
    expect(routeStart(request({ role: "code" }), ctx)).toMatchObject({ alias: "writer2", result: { exploration: true } });
  });
  it("keeps all resolved floors at or above every applicable floor", () => {
    const ctx = context();
    for (const roleFloor of TIERS) for (const riskFloor of TIERS) for (const workspaceFloor of TIERS) {
      const config: RoutingConfig = { ...ctx.config, floors: { code: roleFloor, review: roleFloor, explore: roleFloor, riskHigh: riskFloor, workspaces: new Map([["repo", workspaceFloor]]) } };
      expect(TIERS.indexOf(floorFor(config, "code", "high", "repo"))).toBe(Math.max(TIERS.indexOf(roleFloor), TIERS.indexOf(riskFloor), TIERS.indexOf(workspaceFloor)));
    }
  });
  it("enforces family and floor boundaries across every tier", () => {
    for (const floor of TIERS) for (const tier of TIERS) {
      const ctx = context();
      const cell = { code: [], review: ["reader"], explore: [] };
      ctx.config = { ...ctx.config, floors: { ...ctx.config.floors, review: floor }, tiers: { low: cell, medium: cell, hightech: cell, ultra: cell } };
      rejects(request({ role: "review", tier, authorFamily: "openai" }), ctx, TIERS.indexOf(tier) < TIERS.indexOf(floor) ? "routing_tier_below_floor" : "routing_same_family");
      if (TIERS.indexOf(tier) >= TIERS.indexOf(floor)) {
        expect(routeStart(request({ role: "review", tier, authorFamily: "openai", allowSameFamily: true }), ctx)).toMatchObject({ alias: "reader", result: { tier }, decision: { sameFamilyOverride: true } });
      }
    }
  });
  it("uses a named RoutingError with a safe message", () => {
    try { routeStart(request({ role: "review", authorFamily: "/private/secret" }), context({ mode: "off" })); expect.fail("expected rejection"); }
    catch (error) { expect(error).toBeInstanceOf(RoutingError); expect((error as Error).message).not.toContain("/private/secret"); }
  });
});

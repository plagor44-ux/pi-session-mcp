import { describe, expect, it } from "vitest";
import { ALIAS_PATTERN, type ThinkingLevel } from "../src/execution-profile.js";
import type { PricedModelCatalog } from "../src/model-catalog.js";
import { familyOfModel, proposeProfiles, tierForOutputPrice } from "../src/guided/propose.js";

const catalog = (entries: readonly { provider: string; model: string; price?: number; auth?: boolean }[], effective?: (model: string, level: ThinkingLevel) => ThinkingLevel): PricedModelCatalog => ({
  providers: () => entries.map((e) => ({ id: e.provider, authConfigured: e.auth !== false, models: [e.model] })),
  outputPrice: (provider, model) => entries.find((e) => e.provider === provider && e.model === model)?.price,
  thinkingLevels: () => undefined,
  effectiveThinkingLevel: (_provider, model, level) => effective?.(model, level),
});

describe("guided profile proposals", () => {
  it.each([[30, "ultra"], [29.99, "hightech"], [3.5, "hightech"], [3.49, "medium"], [1.5, "medium"], [1.49, "low"], [0, undefined], [undefined, undefined], [NaN, undefined]] as const)("maps %s to %s", (price, tier) => {
    expect(tierForOutputPrice(price)).toBe(tier);
  });
  it("maps known model families and fits provider fallback", () => {
    for (const [model, family] of [["glm-4", "glm"], ["deepseek-r1", "deepseek"], ["grok-3", "xai"], ["claude-4", "anthropic"], ["gpt-4", "openai"], ["o1", "openai"], ["o3", "openai"], ["o4", "openai"], ["gemini-2", "google"], ["mistral", "mistral"], ["devstral", "mistral"], ["codestral", "mistral"], ["ministral", "mistral"], ["magistral", "mistral"]]) expect(familyOfModel(model!, "provider")).toBe(family);
    expect(familyOfModel("other", "Example-Provider")).toBe("example-provider");
  });
  it("ignores providers without authentication", () => {
    expect(proposeProfiles(catalog([{ provider: "p", model: "m", price: 2, auth: false }]))).toEqual([]);
  });
  it("gives no proposal for a model without a price", () => {
    expect(proposeProfiles(catalog([{ provider: "p", model: "m" }]))).toEqual([]);
  });
  it("proposes one per tier, role and family at the highest price, breaking ties by model id", () => {
    const result = proposeProfiles(catalog([{ provider: "p", model: "gpt-a", price: 2 }, { provider: "p", model: "gpt-b", price: 3 }, { provider: "p", model: "gpt-c", price: 3 }]));
    expect(result).toHaveLength(2);
    expect(result.every((p) => p.model === "gpt-c" && p.family === "openai" && p.tier === "medium")).toBe(true);
    expect(result.find((p) => p.role === "code")?.thinkingLevel).toBe("medium");
    expect(result.find((p) => p.role === "review")?.thinkingLevel).toBe("high");
  });
  it("proposes the level Pi applies when the model lacks the role's level", () => {
    // Like the DeepSeek models of #288: medium is not offered and Pi moves it up to high.
    const result = proposeProfiles(catalog([{ provider: "p", model: "no-medium", price: 1 }], (_model, level) => level === "medium" ? "high" : level));
    expect(result.map((p) => [p.role, p.thinkingLevel])).toEqual([["code", "high"], ["review", "high"], ["explore", "low"]]);
  });
  it("proposes off for a model without reasoning", () => {
    const result = proposeProfiles(catalog([{ provider: "p", model: "plain", price: 1 }], () => "off"));
    expect(result.map((p) => p.thinkingLevel)).toEqual(["off", "off", "off"]);
  });
  it("proposes explore only for low", () => {
    const result = proposeProfiles(catalog([{ provider: "p", model: "a", price: 1 }, { provider: "p", model: "b", price: 2 }]));
    expect(result.filter((p) => p.role === "explore")).toMatchObject([{ tier: "low", thinkingLevel: "low" }]);
  });
  it("caps a tier and role at four, ordered by price then family", () => {
    const result = proposeProfiles(catalog(["e", "d", "c", "b", "a"].map((provider) => ({ provider, model: "model", price: 2 }))));
    expect(result.filter((p) => p.role === "code").map((p) => p.family)).toEqual(["a", "b", "c", "d"]);
    expect(result.filter((p) => p.role === "review")).toHaveLength(4);
  });
  it("produces aliases that match ALIAS_PATTERN", () => {
    const result = proposeProfiles(catalog([{ provider: "Example-Provider", model: "model", price: 1 }]));
    expect(result.length).toBeGreaterThan(0);
    for (const p of result) { expect(p.alias).toBe(`${p.role}-${p.tier}-${p.family}`); expect(p.alias).toMatch(ALIAS_PATTERN); }
  });
});

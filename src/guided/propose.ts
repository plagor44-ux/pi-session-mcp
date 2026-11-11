import type { ThinkingLevel } from "../execution-profile.js";
import type { PricedModelCatalog } from "../model-catalog.js";
import { ROLES, TIERS, type Role, type Tier } from "../routing/config.js";

export interface ProfileProposal {
  alias: string;
  provider: string;
  model: string;
  role: Role;
  tier: Tier;
  family: string;
  thinkingLevel: ThinkingLevel;
}

/** The level each role asks for; a proposal takes the level Pi applies to that request for its model. */
const ROLE_THINKING_LEVEL: Readonly<Record<Role, ThinkingLevel>> = { code: "medium", review: "high", explore: "low" };

export function tierForOutputPrice(usd: number | undefined): Tier | undefined {
  if (usd === undefined || !Number.isFinite(usd) || usd <= 0) return undefined;
  if (usd >= 30) return "ultra";
  if (usd >= 3.5) return "hightech";
  if (usd >= 1.5) return "medium";
  return "low";
}

export function familyOfModel(modelId: string, providerId: string): string {
  const model = modelId.toLowerCase();
  if (model.includes("glm")) return "glm";
  if (model.includes("deepseek")) return "deepseek";
  if (model.includes("grok")) return "xai";
  if (model.includes("claude")) return "anthropic";
  if (/(?:gpt|(?:^|[^a-z0-9])o[134])/.test(model)) return "openai";
  if (model.includes("gemini")) return "google";
  if (/(?:mistral|devstral|codestral|ministral|magistral)/.test(model)) return "mistral";
  const fitted = providerId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^[^a-z]+/, "").slice(0, 32);
  return fitted || "provider";
}

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

export function proposeProfiles(catalog: PricedModelCatalog): readonly ProfileProposal[] {
  const cells = new Map<string, Map<string, { proposal: ProfileProposal; price: number }>>();
  for (const provider of catalog.providers()) {
    if (!provider.authConfigured) continue;
    for (const model of provider.models) {
      const price = catalog.outputPrice(provider.id, model);
      const tier = tierForOutputPrice(price);
      if (tier === undefined || price === undefined) continue;
      const family = familyOfModel(model, provider.id);
      for (const role of ROLES) {
        if (role === "explore" && tier !== "low") continue;
        const key = `${tier}:${role}`;
        let cell = cells.get(key);
        if (!cell) { cell = new Map(); cells.set(key, cell); }
        const previous = cell.get(family);
        if (previous && (previous.price > price || (previous.price === price && compare(previous.proposal.model, model) >= 0))) continue;
        // A session refuses a level its model does not offer (thinking_level_unavailable), so propose the one Pi applies.
        const thinkingLevel = catalog.effectiveThinkingLevel(provider.id, model, ROLE_THINKING_LEVEL[role]) ?? ROLE_THINKING_LEVEL[role];
        cell.set(family, { price, proposal: { alias: `${role}-${tier}-${family}`, provider: provider.id, model, role, tier, family, thinkingLevel } });
      }
    }
  }
  const result: ProfileProposal[] = [];
  for (const tier of TIERS) for (const role of ROLES) {
    const entries = [...(cells.get(`${tier}:${role}`)?.values() ?? [])];
    entries.sort((a, b) => b.price - a.price || compare(a.proposal.family, b.proposal.family));
    result.push(...entries.slice(0, 4).map((entry) => entry.proposal));
  }
  return result;
}

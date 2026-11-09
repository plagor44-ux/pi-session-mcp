import { describe, it, expect } from "vitest";
import { configSchema } from "../src/config.js";
import { parseGuidedAnswers } from "../src/guided/answers.js";
import { buildGuidedPlan } from "../src/guided/plan.js";

const answers = () => parseGuidedAnswers({ schemaVersion: 1, approveProbes: true, allowConfigChange: true, profiles: [{ alias: "safe", provider: "p", model: "m", role: "review", thinkingLevel: "medium", tier: "medium", family: "p" }], defaultProfile: "safe", workspaces: [{ alias: "project", path: "/project", mode: "read-only" }], history: { enabled: true }, routing: { mode: "manual" }, clients: { claudeCode: false, codex: true } });
const code = (fn: () => unknown, expected: string) => { try { fn(); expect.fail("expected error"); } catch (e) { expect(e).toMatchObject({ code: expected }); } };

describe("guided plan", () => {
  it("rejects relative workspace paths in answers", () => {
    const a = answers(); a.workspaces[0]!.path = "relative/repo";
    code(() => parseGuidedAnswers(a), "answers_invalid");
  });
  it.each([{ profiles: undefined }, { profiles: [] }, { profiles: ["safe"] }, { profiles: ["missing"] }])("rejects invalid container profiles $profiles", ({ profiles }) => {
    const a = answers(); a.workspaces[0]!.mode = "container";
    if (profiles !== undefined) a.workspaces[0]!.container = { profiles };
    code(() => buildGuidedPlan(a, {}), "container_profiles_invalid");
  });
  it("accepts existing coding container profiles", () => {
    const a = answers(); a.workspaces[0]!.mode = "container"; a.workspaces[0]!.container = { profiles: ["writer"] };
    expect(buildGuidedPlan(a, { config: { executionProfiles: { writer: { permissionProfile: "coding" } } } }).modeRequests[0]!.container!.profiles).toEqual(["writer"]);
  });
  it("refuses unknown keys and does not echo their values", () => { try { parseGuidedAnswers({ apiKey: "SECRET" }); expect.fail(); } catch (e) { expect(e).toMatchObject({ code: "answers_invalid" }); expect(String(e)).not.toContain("SECRET"); } });
  it("builds a fresh configuration", () => { const plan = buildGuidedPlan(answers(), {}); expect(configSchema.safeParse(plan.nextConfig).success).toBe(true); expect(plan.newProfiles).toEqual(["safe"]); expect(plan.targets).toEqual([{ client: "codex", scope: "user", alias: "pi-session-mcp" }]); });
  it("preserves fields it does not know", () => { const first = buildGuidedPlan(answers(), {}); const config = { ...first.nextConfig, skillCatalog: { worker: "builtin:pi-session-review" }, history: { enabled: true, redactPaths: ["private/**"] }, executionProfiles: { safe: { ...(first.nextConfig.executionProfiles as Record<string, object>).safe, extensions: ["npm:example@1.0.0"], mcpServers: { sample: {} } } } }; const plan = buildGuidedPlan(answers(), { config, routing: first.routingDocument }); expect(plan.nextConfig).toEqual(config); });
  it("reports no change on a second plan", () => { const first = buildGuidedPlan(answers(), {}); const second = buildGuidedPlan(answers(), { config: first.nextConfig, routing: first.routingDocument }); expect(second).toMatchObject({ configChanged: false, routingChanged: false, newProfiles: [] }); });
  it("refuses a change to an existing file without allowConfigChange", () => { const a = { ...answers(), allowConfigChange: false }; code(() => buildGuidedPlan(a, { config: { workspaces: {}, executionProfiles: {} } }), "config_change_not_allowed"); });
  it("refuses an alias that exists with other content", () => { const first = buildGuidedPlan(answers(), {}); const a = answers(); code(() => buildGuidedPlan({ ...a, profiles: [{ ...a.profiles[0]!, model: "other" }] }, { config: first.nextConfig }), "profile_alias_conflict"); code(() => buildGuidedPlan({ ...a, workspaces: [{ ...a.workspaces[0]!, path: "/other" }] }, { config: first.nextConfig }), "workspace_alias_conflict"); });
  it("reuses an alias with identical content", () => { const first = buildGuidedPlan(answers(), {}); expect(buildGuidedPlan(answers(), { config: first.nextConfig }).newProfiles).toEqual([]); });
  it("refuses host mode without acceptHostWrites", () => { const a = answers(); code(() => buildGuidedPlan({ ...a, workspaces: [{ ...a.workspaces[0]!, mode: "host" }] }, {}), "host_writes_not_accepted"); });
  it("refuses auto without history", () => { const a = answers(); code(() => buildGuidedPlan({ ...a, history: { enabled: false }, routing: { mode: "auto" } }, {}), "routing_requires_history"); });
  it("plans new profiles without approveProbes", () => { expect(buildGuidedPlan({ ...answers(), approveProbes: false }, {}).newProfiles).not.toHaveLength(0); });
  it("sets spool delivery only for Claude Code", () => { const a = answers(); expect(buildGuidedPlan(a, {}).nextConfig.events).toBeUndefined(); expect(buildGuidedPlan({ ...a, clients: { ...a.clients, claudeCode: true } }, {}).nextConfig.events).toEqual({ delivery: "spool" }); });
  it("refuses a different default profile", () => { const first = buildGuidedPlan(answers(), {}); const a = answers(); expect((first.nextConfig.executionProfiles as Record<string, { default: boolean }>).safe?.default).toBe(true); code(() => buildGuidedPlan({ ...a, defaultProfile: "other", profiles: [...a.profiles, { ...a.profiles[0]!, alias: "other" }] }, { config: first.nextConfig }), "default_profile_conflict"); });
  it("refuses a profile routed to another tier", () => { code(() => buildGuidedPlan(answers(), { routing: { mode: "manual", tiers: { low: { review: ["safe"] } }, families: { safe: "p" } } }), "routing_profile_conflict"); });
  it("refuses a different existing family", () => { code(() => buildGuidedPlan(answers(), { routing: { mode: "manual", tiers: { medium: { review: ["safe"] } }, families: { safe: "other" } } }), "routing_profile_conflict"); });
  it("marks the answered default in a configuration without one", () => { const config = { workspaces: {}, executionProfiles: { legacy: { default: false, permissionProfile: "read-only", provider: "x", model: "y", thinkingLevel: "off" } } }; const plan = buildGuidedPlan(answers(), { config }); expect(configSchema.safeParse(plan.nextConfig).success).toBe(true); expect((plan.nextConfig.executionProfiles as Record<string, { default: boolean }>).safe?.default).toBe(true); });
  it("refuses an unknown default profile", () => { code(() => buildGuidedPlan({ ...answers(), defaultProfile: "missing" }, {}), "default_profile_unknown"); });
  it("leaves an unrouted profile alone in an existing routing document", () => { const a = answers(); const routing = { mode: "manual", tiers: { medium: { review: ["safe"] } }, families: { safe: "p" } }; const plan = buildGuidedPlan({ ...a, profiles: [{ ...a.profiles[0]!, tier: null, family: null }] }, { routing }); expect(plan.routingDocument).toEqual(routing); expect(plan.routingChanged).toBe(false); });
  it("refuses a role of the other permission class in the same tier", () => { const a = answers(); code(() => buildGuidedPlan({ ...a, profiles: [{ ...a.profiles[0]!, tier: null, family: null }, { ...a.profiles[0]!, alias: "writer", role: "code" }] }, { routing: { mode: "manual", tiers: { medium: { review: ["writer"] } }, families: { writer: "p" } } }), "routing_profile_conflict"); });
  it("adds another role in the same tier without removing the existing role", () => { const routing = { mode: "manual", tiers: { medium: { explore: ["safe"] } }, families: { safe: "p" } }; expect(buildGuidedPlan(answers(), { routing }).routingDocument).toEqual({ mode: "manual", tiers: { medium: { explore: ["safe"], review: ["safe"] } }, families: { safe: "p" } }); });
});

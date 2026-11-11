import { describe, expect, it } from "vitest";
import { collectGuidedAnswers, type Prompter } from "../src/guided/prompts.js";
import { parseGuidedAnswers } from "../src/guided/answers.js";
import type { PricedModelCatalog } from "../src/model-catalog.js";
const catalog: PricedModelCatalog = { providers: () => [{ id: "openai", authConfigured: true, models: ["gpt-test"] }], outputPrice: () => 2, thinkingLevels: () => undefined, effectiveThinkingLevel: () => undefined };
async function collect(overrides: Partial<Prompter> = {}, existing: Parameters<typeof collectGuidedAnswers>[2] = {}, source: PricedModelCatalog = catalog) {
  const questions: string[] = [];
  const base: Prompter = {
    text: async (_q, fallback) => fallback ?? "",
    confirm: async (q, fallback) => q.includes("Approve") ? true : fallback,
    choose: async (_q, _options, fallback) => fallback,
    ...overrides,
  };
  const prompter: Prompter = {
    text: async (q, fallback) => { questions.push(q); return base.text(q, fallback); },
    confirm: async (q, fallback) => { questions.push(q); return base.confirm(q, fallback); },
    choose: async (q, options, fallback) => { questions.push(q); return base.choose(q, options, fallback); },
  };
  return { answers: await collectGuidedAnswers(prompter, source, existing), questions: questions.join("\n") };
}
/** Changes the code proposal, types `model` for it and records the thinking-level question. */
async function changeCodeLevel(source: PricedModelCatalog, model: string) {
  const asked: { options: readonly string[]; fallback: string }[] = [];
  const { answers } = await collect({
    choose: async (q, options, fallback) => {
      if (q.startsWith("Thinking level for")) asked.push({ options, fallback });
      return options.includes("change" as never) && q.includes("role code") ? "change" as typeof fallback : fallback;
    },
    text: async (q, fallback) => q.startsWith("Model for") ? model : fallback ?? "",
  }, {}, source);
  return { asked, profile: answers.profiles.find((p) => p.role === "code")! };
}
function workspace(text: Prompter["text"], container = false): Partial<Prompter> {
  let added = false;
  return {
    text,
    confirm: async (q, fallback) => q.startsWith("Add") ? !added && (added = true) : q.includes("Approve") || fallback,
    choose: async (_q, options, fallback) => container && options.includes("container" as never) ? "container" as typeof fallback : fallback,
  };
}
describe("guided prompts", () => {
  it("reports a declined family warning", async () => {
    await expect(collect({ confirm: async () => false })).rejects.toMatchObject({ code: "interview_declined" });
  });
  it.each([false, true])("reports why no read-only candidates exist (authenticated %s)", async (authConfigured) => {
    const prompter: Prompter = { text: async () => "", confirm: async () => true, choose: async (_q, options, fallback) => options.includes("skip" as never) ? "skip" as typeof fallback : fallback };
    await expect(collectGuidedAnswers(prompter, { ...catalog, providers: () => [{ id: "openai", authConfigured, models: ["gpt-test"] }] }, {})).rejects.toMatchObject({ code: authConfigured ? "no_read_only_profile" : "provider_login_required" });
  });
  it("offers only the levels of the model chosen on the change path, defaulting to the one Pi applies", async () => {
    // The proposal is for gpt-test at medium; the owner switches to a model that lacks medium.
    const source: PricedModelCatalog = {
      ...catalog,
      thinkingLevels: (_provider, model) => model === "no-medium" ? ["off", "low", "high"] : undefined,
      effectiveThinkingLevel: (_provider, model, level) => model === "no-medium" && level === "medium" ? "high" : undefined,
    };
    const { asked, profile } = await changeCodeLevel(source, "no-medium");
    expect(asked).toEqual([{ options: ["off", "low", "high"], fallback: "high" }]);
    expect(profile).toMatchObject({ model: "no-medium", thinkingLevel: "high" });
  });
  it("offers every level on the change path when the catalog does not know the model", async () => {
    const { asked } = await changeCodeLevel(catalog, "typed-model");
    expect(asked).toEqual([{ options: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fallback: "medium" }]);
  });
  it("turns confirmed proposals into valid answers", async () => { const { answers } = await collect(); expect(parseGuidedAnswers(answers)).toEqual(answers); expect(answers.profiles.length).toBe(2); });
  it("accepts a proposal with one question", async () => {
    const { questions, answers } = await collect();
    for (const p of answers.profiles) {
      const lines = questions.split("\n").filter((q) => q.includes(p.alias));
      expect(lines).toHaveLength(1);
      for (const value of [p.provider, p.model, p.tier!, p.role, p.family!, p.thinkingLevel]) expect(lines[0]).toContain(value);
    }
  });
  it("asks details only for change", async () => {
    let changed = false;
    const { questions } = await collect({ choose: async (_q, options, fallback) => {
      if (options.includes("change" as never) && !changed) { changed = true; return "change" as typeof fallback; }
      return fallback;
    } });
    for (const label of ["Tier for", "Role for", "Model for", "Family for", "Thinking level for"]) expect(questions.split("\n").filter((q) => q.startsWith(label))).toHaveLength(1);
  });
  it("skips a declined proposal", async () => {
    const { answers } = await collect({ choose: async (q, options, fallback) => options.includes("skip" as never) && q.includes("role code") ? "skip" as typeof fallback : fallback });
    expect(answers.profiles).toHaveLength(1); expect(answers.profiles[0]!.role).toBe("review");
  });
  it("re-asks an invalid workspace alias", async () => {
    const values = ["bad alias", "repo"];
    const { answers, questions } = await collect(workspace(async (q, fallback) => q === "Workspace alias" ? values.shift()! : q.startsWith("Absolute") ? "/repo" : fallback ?? ""));
    expect(answers.workspaces[0]!.alias).toBe("repo"); expect(questions.match(/Workspace alias/g)).toHaveLength(2);
  });
  it("re-asks a relative workspace path", async () => {
    const values = ["relative/repo", "/repo"];
    const { answers, questions } = await collect(workspace(async (q, fallback) => q === "Workspace alias" ? "repo" : q.startsWith("Absolute") ? values.shift()! : fallback ?? ""));
    expect(answers.workspaces[0]!.path).toBe("/repo"); expect(questions.match(/Absolute repository path/g)).toHaveLength(2);
  });
  it("re-asks an invalid family", async () => {
    const values = ["bad family", "valid-family"];
    const { answers, questions } = await collect({
      choose: async (q, options, fallback) => options.includes("change" as never) && q.includes("role review") ? "change" as typeof fallback : fallback,
      text: async (q, fallback) => q.startsWith("Family") ? values.shift()! : fallback ?? "",
    });
    expect(answers.profiles.find((p) => p.role === "review")!.family).toBe("valid-family"); expect(questions.match(/Family for/g)).toHaveLength(2);
  });
  it("trims container profiles and re-asks an empty list", async () => {
    const values = [" , , ", " medium-openai-code , , medium-openai-review "];
    const { answers, questions } = await collect(workspace(async (q, fallback) => q === "Workspace alias" ? "repo" : q.startsWith("Absolute") ? "/repo" : q.startsWith("Container") ? values.shift()! : fallback ?? "", true));
    expect(answers.workspaces[0]!.container!.profiles).toEqual(["medium-openai-code", "medium-openai-review"]); expect(questions.match(/Container profile aliases/g)).toHaveLength(2);
  });
  it("warns when a tier has fewer than two families", async () => { expect((await collect()).questions).toContain("fewer than two families"); });
  it("does not warn for a tier without review profiles", async () => {
    const { questions } = await collect({ choose: async (q, options, fallback) => {
      if (options.includes("change" as never) && q.includes("role code")) return "change" as typeof fallback;
      if (q.startsWith("Tier for")) return "low" as typeof fallback;
      return fallback;
    } });
    expect(questions.split("\n").filter((q) => q.includes("fewer than two families"))).toEqual(["medium has fewer than two families; review may need the same-family override. Continue?"]);
  });
  it("defaults clients to what is installed", async () => {
    for (const clients of [{ claudeCode: true, codex: false }, { claudeCode: false, codex: true }]) expect((await collect({}, { clients })).answers.clients).toEqual(clients);
    expect((await collect()).answers.clients).toEqual({ claudeCode: false, codex: false });
  });
  it("does not ask for probes without new profiles", async () => {
    const initial = (await collect()).answers;
    const executionProfiles = Object.fromEntries(initial.profiles.map((p) => [p.alias, { permissionProfile: p.role === "code" ? "coding" : "read-only" }]));
    const { answers, questions } = await collect({}, { config: { executionProfiles } });
    expect(answers.approveProbes).toBe(true); expect(questions).not.toContain("Approve");
  });
  it("states the number of provider turns before probing", async () => { expect((await collect()).questions).toContain("2 provider turns"); });
  it("says the history stores redacted content locally and that auto requires it", async () => { const { questions } = await collect(); expect(questions).toContain("redacted session content locally"); expect(questions).toContain("auto requires history"); });
});

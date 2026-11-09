import { describe, expect, it } from "vitest";
import { collectGuidedAnswers, type Prompter } from "../src/guided/prompts.js";
import { parseGuidedAnswers } from "../src/guided/answers.js";
const catalog = { providers: () => [{ id: "openai", authConfigured: true, models: ["gpt-test"] }], outputPrice: () => 2 };
async function collect() {
  const questions: string[] = [];
  const prompter: Prompter = {
    text: async (q, fallback) => { questions.push(q); return fallback ?? ""; },
    confirm: async (q, fallback) => { questions.push(q); return q.includes("Approve") ? true : fallback; },
    choose: async (q, _options, fallback) => { questions.push(q); return fallback; },
  };
  return { answers: await collectGuidedAnswers(prompter, catalog, {}), questions: questions.join("\n") };
}
describe("guided prompts", () => {
  it("turns confirmed proposals into valid answers", async () => { const { answers } = await collect(); expect(parseGuidedAnswers(answers)).toEqual(answers); expect(answers.profiles.length).toBe(2); });
  it("warns when a tier has fewer than two families", async () => { expect((await collect()).questions).toContain("fewer than two families"); });
  it("states the number of provider turns before probing", async () => { expect((await collect()).questions).toContain("2 provider turns"); });
  it("says the history stores redacted content locally and that auto requires it", async () => { const { questions } = await collect(); expect(questions).toContain("redacted session content locally"); expect(questions).toContain("auto requires history"); });
});

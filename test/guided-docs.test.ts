import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ANSWERS_RULES } from "../src/guided/answers.js";

/** The operator guide must name every result code that guided setup can emit itself (#318). */
describe("guided result codes in the agent guide", () => {
  it("names every code that the guided sources emit", async () => {
    const sources = await Promise.all(["src/guided/run.ts", "src/guided/plan.ts", "src/setup-guided-main.ts"].map((path) => readFile(path, "utf8")));
    const emitted = new Set<string>();
    for (const source of sources) {
      for (const match of source.matchAll(/\b(?:stop|fail)\(\s*"([a-z][a-z_]+)"/g)) emitted.add(match[1]!);
      // Scopes and aliases never contain an underscore; codes do. A code may sit in a conditional expression.
      for (const line of source.split("\n")) if (/\badd\(/.test(line)) for (const match of line.matchAll(/"([a-z]+_[a-z_]+)"/g)) emitted.add(match[1]!);
      for (const match of source.matchAll(/new GuidedPlanError\(\s*"([a-z][a-z_]+)"/g)) emitted.add(match[1]!);
    }
    for (const required of ["answers_invalid", "answers_unreadable", "config_change_not_allowed", "probes_not_approved", "configuration_planned", "bubblewrap_unavailable"]) expect(emitted, "the extraction must see " + required).toContain(required);
    const guide = await readFile("docs/agent-install.md", "utf8");
    const missing = [...emitted].filter((code) => !guide.includes("`" + code + "`"));
    expect(missing).toEqual([]);
  });
  it("names every answers rule code", async () => {
    const guide = await readFile("docs/agent-install.md", "utf8");
    expect(ANSWERS_RULES.filter((rule) => !guide.includes("`" + rule + "`"))).toEqual([]);
  });
});

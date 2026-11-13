import { describe, expect, it } from "vitest";
import { compilePathRule } from "../src/history/path-rule.js";
import { generatedGlob, generator, plainPathRule } from "./path-rule-reference.js";

const PIECES = ["a", "b", "x", "s", "/", "/", "/", ".", "..", "\n", "secret", "\\", "@", "ab", "ba", "bb", "aa", "A", "S"];

describe("path rule", () => {
  it("decides as the plain translation of its globs, for generated globs and paths", () => {
    for (let seed = 1; seed <= 25_000; seed += 1) {
      const random = generator(seed);
      const globs = Array.from({ length: 1 + Math.floor(random() * 2) }, () => generatedGlob(random));
      const path = Array.from({ length: Math.floor(random() * 14) }, () => PIECES[Math.floor(random() * PIECES.length)]!).join("");
      expect(compilePathRule(globs)(path), `seed ${seed}: ${JSON.stringify({ globs, path })}`).toBe(plainPathRule(globs)(path));
    }
  }, 60_000);

  it.each([
    ["*a*b*", "a".repeat(100_000)],
    ["*secret*/**", "secret".repeat(40_000)],
    ["x/*a*b*c*/y", `x/${"abab".repeat(5000)}/z`],
  ])("tests a long path for %s without backtracking into its wildcards", (glob, path) => {
    // The plain translation of each glob takes seconds or more on its path; the rule takes milliseconds.
    const rule = compilePathRule([glob]);
    const started = performance.now();
    expect(rule(path)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

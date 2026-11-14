import { describe, expect, it } from "vitest";
import { compilePathRule, readPath } from "../src/history/path-rule.js";
import { generatedDeepGlob, generatedGlob, generator, plainPathRule } from "./path-rule-reference.js";

const PIECES = ["a", "b", "x", "s", "/", "/", "/", ".", "..", "\n", "secret", "\\", "@", "ab", "ba", "bb", "aa", "A", "S"];

/** Globs with a `**` before further steps, each with the directory that a long path repeats. */
const DEEP: readonly (readonly [string, string])[] = [["**/config/**/secret*", "/config/"], ["clusters/**/secret*.yaml", "clusters/"]];
/** A path of at least `length` characters: the directory repeated, then the file name. */
const long = (directory: string, length: number, name: string): string => `${directory.repeat(Math.ceil(length / directory.length))}${name}`;

describe("path rule", () => {
  it("decides as the plain translation of its globs, for generated globs and paths", () => {
    for (let seed = 1; seed <= 25_000; seed += 1) {
      const random = generator(seed);
      const globs = Array.from({ length: 1 + Math.floor(random() * 2) }, () => generatedGlob(random));
      const path = Array.from({ length: Math.floor(random() * 14) }, () => PIECES[Math.floor(random() * PIECES.length)]!).join("");
      expect(compilePathRule(globs)(path), `seed ${seed}: ${JSON.stringify({ globs, path })}`).toBe(plainPathRule(globs)(path));
    }
  }, 60_000);

  it("decides as the plain translation of its globs, for generated globs with a `**` before further steps", () => {
    for (let seed = 1; seed <= 25_000; seed += 1) {
      const random = generator(seed);
      const globs = Array.from({ length: 1 + Math.floor(random() * 2) }, () => generatedDeepGlob(random));
      const path = Array.from({ length: Math.floor(random() * 14) }, () => PIECES[Math.floor(random() * PIECES.length)]!).join("");
      expect(compilePathRule(globs)(path), `seed ${seed}: ${JSON.stringify({ globs, path })}`).toBe(plainPathRule(globs)(path));
    }
  }, 60_000);

  it.each(DEEP)("tests a path of 200,000 characters for %s without reading it again at each `/`", (glob, directory) => {
    // The plain translation reads the rest of the path again at each `/`, which takes seconds here.
    const rule = compilePathRule([glob]);
    const started = performance.now();
    expect(rule(long(directory, 200_000, "z"))).toBe(false);
    expect(rule(long(directory, 200_000, "secret.yaml"))).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it.each(DEEP)("reads a path for %s with work that at most doubles when its length doubles", (glob, directory) => {
    const rule = compilePathRule([glob]);
    const work = (length: number): number => {
      const path = rule.parts!.normalize(long(directory, length, "z"));
      const pass = readPath(rule.parts!, path);
      expect(pass.found).toBe(rule(path));
      return pass.work;
    };
    const [small, medium, large] = [50_000, 100_000, 200_000].map(work) as [number, number, number];
    // Every character is read, and a path twice as long costs at most twice the work and a constant.
    expect(small).toBeGreaterThan(50_000);
    expect(medium).toBeLessThanOrEqual(2 * small + 1000);
    expect(large).toBeLessThanOrEqual(2 * medium + 1000);
  });

  it.each([
    ["*a*b*", "a".repeat(100_000)],
    ["*secret*/**", "secret".repeat(40_000)],
    ["x/*a*b*c*/y", `x/${"abab".repeat(5000)}/z`],
    ["**b*c", `dir/${"b".repeat(100_000)}`],
    ["a**b*c", `dir/a${"b".repeat(100_000)}`],
    ["x/a*b**/c", `x/a${"b".repeat(100_000)}`],
  ])("tests a long path for %s without backtracking into its wildcards", (glob, path) => {
    // The plain translation of each glob takes seconds or more on its path; the rule takes milliseconds.
    const rule = compilePathRule([glob]);
    const started = performance.now();
    expect(rule(path)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

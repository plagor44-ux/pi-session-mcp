import { describe, expect, it } from "vitest";
import { filterGrepText, GREP_CHECK_BUDGET } from "../src/history/grep-paths.js";
import { compilePathRule } from "../src/history/path-rule.js";
import { generatedGlob, generator, plainPathRule } from "./path-rule-reference.js";

type Rule = (path: string) => boolean;

const prefixOf = (root: string | undefined): string => root === undefined || root === "." || root === "" ? "" : `${root.replace(/\/+$/, "")}/`;

/** Where each `:N:` or `-N-` separator of a line starts. */
function separatorEnds(line: string): number[] {
  const ends: number[] = [];
  for (let at = 0; at < line.length; at += 1) if (/^(?::\d+:|-\d+-)/.test(line.slice(at))) ends.push(at);
  return ends;
}

/** The rule applied to every reading of every line, without shortcuts: what the filter must drop. */
function reference(text: string, root: string | undefined, rule: Rule): string {
  const prefix = prefixOf(root);
  const lines = text.split("\n");
  const starts: number[] = [];
  for (let index = 0, position = 0; index < lines.length; position += lines[index]!.length + 1, index += 1) starts.push(position);
  return lines.filter((line, index) => !separatorEnds(line).some((end) => {
    const stop = starts[index]! + end;
    for (let candidate = index; candidate >= 0 && (candidate === index || starts[candidate]! >= stop - 4096); candidate -= 1) {
      const path = text.slice(starts[candidate]!, stop);
      if (rule(path) || (prefix !== "" && rule(prefix + path))) return true;
    }
    return false;
  })).join("\n");
}

/** True when the rule protects a path that starts at the line itself. */
function lineAlone(line: string, root: string | undefined, rule: Rule): boolean {
  const prefix = prefixOf(root);
  return separatorEnds(line).some((end) => rule(line.slice(0, end)) || (prefix !== "" && rule(prefix + line.slice(0, end))));
}

const PIECES = ["a", "b", "x", ".", "..", "/", "/", "\\", "\n", "\n", "@", ":1:", "-2-", ":", "-", "1", "secrets", "kubeconfig", "prod", "config", "app.yaml", ".env", "key.pem", "//", "./", "../", " ", "s"];
const NAMES = ["a", "b", "x", "s", "prod", "config", "secrets", "kubeconfig", "app.yaml", ".env", "key.pem", "cred.json", ".", "..", "..", "", "@", "@s", "@secrets", "q\n", "\nq", "\n", "x\n", "\nx", "secrets\n", "\nsecrets", "\n..", "..\n", "\n.", ".\n", "kube\nconfig", "a\nb", "s\n", "\nprod"];
const JOINERS = ["/", "/", "/", "/", "/", "\\", "//", "/./"];
const TEXTS = [":1: needle", "-2- ctx", ":3:", " plain", ":1:-2-", "", ":12: a//b ./c ../d", "-1-x"];
const ROOTS = [undefined, ".", "", "x", "a/b", "/abs/dir", "../up", "a/../..", "@x", "x\\y", "config/prod", "config/staging/../prod", "/", "a/", "..", "secrets/../x", "config/x", "a", "@/abs"];
const GLOBS: readonly (readonly string[])[] = [
  [], ["config/prod/*.yaml"], ["**/cred*"], ["*/x"], ["*/x*"], ["a/**/b"], ["?/s*", "x/**"], ["**/"], ["prod/**", "*.yaml"], [".*"], [".."],
  ["/abs/**"], ["../**"], ["@*/**"], ["config/prod"], ["a/b"], ["**/x"], ["**/**"], ["**/*"], ["a/**"], ["**/a/**/b"], ["**/**/x/**"],
  ["a/**/"], ["*/**/*"], ["x/*.yaml", "*.json"], ["a/x/b", "**/q*"],
];

/** Grep-like lines whose paths have names with line feeds, `.`, `..`, `@`, empty segments and backslashes. */
function structured(random: () => number, pick: <T>(list: readonly T[]) => T): string {
  const lines: string[] = [];
  for (let count = 1 + Math.floor(random() * 6); lines.length < count;) {
    const names = Array.from({ length: 1 + Math.floor(random() * 5) }, () => pick(NAMES));
    let path = names.reduce((joined, part) => `${joined}${pick(JOINERS)}${part}`);
    if (random() < 0.15) path = `/${path}`;
    if (random() < 0.1) path = `@${path}`;
    if (random() < 0.1) path += "/";
    lines.push(path + (random() < 0.4 ? "" : pick(TEXTS)));
  }
  return lines.join("\n");
}

/** Ordinary grep output of Pi's maximum size: at most 2000 lines and 50 KiB. */
function ordinary(kind: "short" | "markdown" | "source"): string {
  const lines: string[] = [];
  for (let index = 0, size = 0; lines.length < 2000; index += 1) {
    const line = kind === "short" ? `a${index % 9}.ts:${index + 1}: ${index % 2 === 1 ? "x:1:y" : "-2-"}`
      : kind === "markdown" ? `docs/guide/part-${index % 7}.md:${index + 1}: See [the setup](../setup/a-${index}.md) and ./b/../c/d.md or @team/x and ../../up/${index}`
        : `src/module${index % 40}/file${index}.ts:${index + 1}: const value = call(arg, "a/b/c"); // see ../x/./y`;
    size += line.length + 1;
    if (size > 51_200) break;
    lines.push(line);
  }
  return lines.join("\n");
}

// Each case is protected only when its path starts on an earlier line: [case, text, root, globs].
const TARGETED: readonly (readonly [string, string, string | undefined, readonly string[]])[] = [
  ["a basename the line ends with a slash", "kubeconfig\nprod/:1: x", undefined, []],
  ["a basename the line ends with a dot segment", "kubeconfig\nprod/.:1: x", undefined, []],
  ["an empty segment", "config//prod/app\n.yaml:1: x", undefined, ["config/prod/*.yaml"]],
  ["a dot-dot segment", "config/prod/x/../app\n.yaml:1: x", undefined, ["config/prod/*.yaml"]],
  ["a backslash", "x\\kubeconfig\nprod:1: x", undefined, []],
  ["backslashes as separators", "cfg\\secrets\\k\nz:1: x", undefined, ["cfg/secrets/**"]],
  ["an absolute path", "/x\ny:1: x", undefined, ["*/x*"]],
  ["a leading @", "@kubeconfig\nprod:1: x", undefined, []],
  ["an @ that only the search root makes a name", "@/s\nq:1: x", "r", ["?/s*"]],
  ["a leading dot-dot", "../x\ny:1: x", undefined, ["*/x*"]],
  ["a name that a dot-dot takes away", "../q\n/..:1: x", undefined, [".."]],
  ["a dot-dot that takes away a name of the root", "../prod/app\n.yaml:1: x", "config/x", ["config/prod/*.yaml"]],
  ["dot-dot segments of both root and path", "../x\ny:1: x", "a/../..", ["../../**"]],
  ["an absolute root", "q\nz:1: x", "/abs/dir", ["/abs/dir/q*"]],
];

describe("grep path filter", () => {
  it.each(TARGETED)("drops a line that only a path over several lines makes protected: %s", (_case, text, root, globs) => {
    const plain = plainPathRule(globs);
    const line = text.slice(text.lastIndexOf("\n") + 1);
    expect(lineAlone(line, root, plain)).toBe(false);
    const result = filterGrepText(text, root, compilePathRule(globs), { left: GREP_CHECK_BUDGET });
    expect(result.dropped).toBe(true);
    expect(result.text.split("\n")).not.toContain(line);
    expect(result.text).toBe(reference(text, root, plain));
  });

  it("tests a path that starts at its own line however far the separator lies", () => {
    const rule = compilePathRule([]);
    const text = `notes/a.txt:1: keep\nsecrets/${"a".repeat(5000)}:2: x`;
    expect(filterGrepText(text, undefined, rule, { left: GREP_CHECK_BUDGET }).text).toBe("notes/a.txt:1: keep");
  });

  const randomPieces = (random: () => number, pick: <T>(list: readonly T[]) => T): string => Array.from({ length: 1 + Math.floor(random() * 40) }, () => pick(PIECES)).join("");
  const listed = (_random: () => number, pick: <T>(list: readonly T[]) => T): readonly string[] => pick(GLOBS);
  const generated = (random: () => number): readonly string[] => Array.from({ length: 1 + Math.floor(random() * 2) }, () => generatedGlob(random));
  it.each([
    ["random pieces", 1, 20_000, randomPieces, listed],
    ["grep-like lines", 100_003, 20_000, structured, listed],
    ["grep-like lines and generated globs", 200_003, 10_000, structured, generated],
  ])("drops exactly the lines that the rule drops when it reads every candidate whole: %s", (_kind, base, count, make, globsOf) => {
    for (let seed = base; seed < base + count; seed += 1) {
      const random = generator(seed);
      const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
      const text = make(random, pick);
      const root = pick(ROOTS);
      const globs = globsOf(random, pick);
      const expected = reference(text, root, plainPathRule(globs));
      const actual = filterGrepText(text, root, compilePathRule(globs), { left: Number.POSITIVE_INFINITY }).text;
      expect(actual, `seed ${seed}: ${JSON.stringify({ text, root, globs })}`).toBe(expected);
    }
  }, 60_000);

  it.each([
    ["a/**/b/**/c", (index: number) => `${"a/b/".repeat(25)}xc:${index + 1}: x`],
    ["*secret*/**", () => "secret:1:".repeat(55)],
    ["*a*b*", () => "a:1:".repeat(125)],
  ])("keeps the time of a check in line with the work it counts, for a configured %s", (glob, line) => {
    // Lines within Pi's limits. While matching backtracked into the glob's wildcards, output like this took 16 s to minutes.
    const lines: string[] = [];
    for (let size = 0; size + line(lines.length).length + 1 <= 51_200;) { size += line(lines.length).length + 1; lines.push(line(lines.length)); }
    const started = performance.now();
    filterGrepText(lines.join("\n"), undefined, compilePathRule([glob]), { left: GREP_CHECK_BUDGET });
    expect(performance.now() - started).toBeLessThan(10_000);
  }, 60_000);

  it.each([
    ["short", "/home/user/projects/pi", ["*/.ssh/*"]],
    ["markdown", "../sibling", ["docs/**/private/*.md"]],
    ["source", "src/history", ["config/**/secret.yaml"]],
  ] as const)("keeps an ordinary result of Pi's maximum size within half the budget: %s lines", (kind, root, globs) => {
    const text = ordinary(kind);
    const budget = { left: GREP_CHECK_BUDGET };
    const result = filterGrepText(text, root, compilePathRule(globs), budget);
    expect(result).toEqual({ text, dropped: false });
    expect(GREP_CHECK_BUDGET - budget.left).toBeLessThan(GREP_CHECK_BUDGET / 2);
  });

  it("reads a long search root once for all candidates", () => {
    const root = "a/".repeat(25_000);
    for (const [text, globs] of [
      [ordinary("source"), []],
      [Array.from({ length: 3000 }, (_, index) => index % 4 === 3 ? `${"../".repeat(index % 50)}..:1: x` : "..").join("\n"), ["a/**/b"]],
    ] as const) {
      const budget = { left: GREP_CHECK_BUDGET };
      expect(filterGrepText(text, root, compilePathRule(globs), budget)).toEqual({ text, dropped: false });
      expect(GREP_CHECK_BUDGET - budget.left).toBeLessThan(GREP_CHECK_BUDGET / 10);
    }
  });

  it("spends the budget when reading the search root would cost more than is left", () => {
    // The glob's leading `*` reads each character of the root's name, the longest one a file system allows.
    const rule = compilePathRule(["*q*/**"]);
    const root = "r".repeat(255);
    expect(filterGrepText("notes/a.txt:1: x", root, rule, { left: GREP_CHECK_BUDGET })).toEqual({ text: "notes/a.txt:1: x", dropped: false });
    const budget = { left: 20_000 };
    expect(filterGrepText("notes/a.txt:1: x", root, rule, budget)).toEqual({ text: "", dropped: true });
    expect(budget.left).toBeLessThan(0);
    // The text blocks of one result share the budget: a later block's lines with a separator are dropped unchecked.
    expect(filterGrepText("notes/b.txt:1: keep", undefined, rule, budget)).toEqual({ text: "", dropped: true });
  });
});

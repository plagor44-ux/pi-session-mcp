/**
 * `AGENTS.md` points from each sensitive area to its decision record, its entry code and its tests.
 * A renamed or removed file must not leave a dead pointer there.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

/** The items of the `## Sensitive areas` list, each joined into one line. */
function areas(): string[] {
  const lines = readFileSync(join(root, "AGENTS.md"), "utf8").split("\n");
  const start = lines.indexOf("## Sensitive areas");
  expect(start).toBeGreaterThan(-1);
  const end = lines.findIndex((line, index) => index > start && (line.startsWith("## ") || line.startsWith("<!--")));
  const items: string[] = [];
  for (const line of lines.slice(start + 1, end === -1 ? undefined : end)) {
    if (line.startsWith("- ")) items.push(line.slice(2));
    else if (line.startsWith("  ") && items.length > 0) items[items.length - 1] += ` ${line.trim()}`;
  }
  return items;
}

it("names an existing decision record, entry code and test for every sensitive area", () => {
  const items = areas();
  expect(items).toHaveLength(4);
  for (const item of items) {
    const records = [...item.matchAll(/\]\((docs\/adr\/[^)#]+)\)/g)].map((match) => match[1]!);
    const paths = [...item.matchAll(/`((?:src|test)\/[^`]+)`/g)].map((match) => match[1]!);
    expect(records, item).not.toHaveLength(0);
    expect(paths.filter((path) => path.startsWith("src/")), item).not.toHaveLength(0);
    expect(paths.filter((path) => path.startsWith("test/")), item).not.toHaveLength(0);
    expect([...records, ...paths].filter((path) => !existsSync(join(root, path))), item).toEqual([]);
  }
});

/** The `src/` or `test/` paths an item names. */
function named(item: string, prefix: "src" | "test"): string[] {
  return [...item.matchAll(/`((?:src|test)\/[^`]+)`/g)].map((match) => match[1]!).filter((path) => path.startsWith(`${prefix}/`));
}

/**
 * Whether a test file loads `source` at run time: a static import that is not type-only, or a
 * dynamic one. A mention in a comment or a string does not count. An import shows that the test
 * loads the code, not how much of it the test covers.
 */
function imports(test: string, source: string): boolean {
  const specifier = `\\.\\./${source.replace(/\.ts$/, ".js").replace(/[.\\/]/g, "\\$&")}`;
  const fixed = new RegExp(`^import\\s+(?!type\\b)[^;"']*?\\bfrom\\s+(["'])${specifier}\\1`, "m");
  const dynamic = new RegExp(`^[^/\\n]*\\bimport\\(\\s*(["'])${specifier}\\1\\s*\\)`, "m");
  return fixed.test(test) || dynamic.test(test);
}

// Existing files could be any files. The named tests must load the named code, and no two
// areas may start at the same code, so one unrelated pointer cannot stand in for all four.
it("names tests that import the entry code of their area, and other entry code for each area", () => {
  const owner = new Map<string, string>();
  for (const item of areas()) {
    const tests = named(item, "test").map((path) => readFileSync(join(root, path), "utf8"));
    for (const source of named(item, "src")) {
      expect(tests.some((text) => imports(text, source)), `${source} is imported by no test of: ${item}`).toBe(true);
      expect(owner.get(source), `${source} is named by two areas`).toBeUndefined();
      owner.set(source, item);
    }
  }
});

it("counts a run-time import only, in either kind of quotes", () => {
  const source = "src/confined-tools.ts";
  expect(imports(`import { a } from "../src/confined-tools.js";`, source)).toBe(true);
  expect(imports(`import { a } from '../src/confined-tools.js';`, source)).toBe(true);
  expect(imports(`import {\n  a,\n  type B,\n} from "../src/confined-tools.js";`, source)).toBe(true);
  expect(imports(`const { a } = await import("../src/confined-tools.js");`, source)).toBe(true);
  expect(imports(`// "../src/confined-tools.js"`, source)).toBe(false);
  expect(imports(`// import { a } from "../src/confined-tools.js";`, source)).toBe(false);
  expect(imports(`// const { a } = await import("../src/confined-tools.js");`, source)).toBe(false);
  expect(imports(`import type { B } from "../src/confined-tools.js";`, source)).toBe(false);
  expect(imports(`import { a } from "../src/confined-tools-other.js";`, source)).toBe(false);
  expect(imports(`import { a } from "../src/confined-toolsXjs";`, source)).toBe(false);
});

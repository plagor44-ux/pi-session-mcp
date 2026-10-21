import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pathOnlyLine, scoreReview } from "../eval/extensions/oracles.js";
import { pathTokens } from "../eval/extensions/path-tokens.js";
import { taskSpecSchema, type ReviewOracle } from "../eval/extensions/schemas.js";

/* R82: scoreReview runs synchronously on a review text of up to 64 KiB, so no step may be super-linear in the text. */

const SOURCE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "proto", "graphql", "gql", "json", "md", "mdx", "py", "go", "rs", "java", "kt", "kts", "rb", "php", "c", "h", "cc", "cpp", "hpp",
  "cs", "swift", "sh", "bash", "zsh", "fish", "yaml", "yml", "toml", "ini", "cfg", "sql", "css", "scss", "sass", "less", "html", "htm", "vue",
  "svelte", "txt", "xml", "gradle", "lock", "env",
]);
const NOT_PATHS = new Set(["node.js", "next.js", "nuxt.js", "vue.js", "react.js", "express.js", "three.js", "d3.js", "e.g", "i.e"]);
const extensionOf = (segment: string): string | undefined => { const dot = segment.lastIndexOf("."); return dot > 0 ? segment.slice(dot + 1) : undefined; };

/** The quadratic regular-expression implementation `pathTokens` replaced; the new one must give the same tokens (below its length cap). */
function referencePathTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.replace(/[a-z][a-z0-9+.-]*:\/\/\S*/g, " ").matchAll(/[a-z0-9_.\-/]+/g)) {
    const token = match[0].replace(/\.+$/, "");
    if (token === "") continue;
    if (token.includes("/")) {
      const last = token.split("/").pop() ?? "";
      const ext = extensionOf(last);
      if ((ext !== undefined && SOURCE_EXTENSIONS.has(ext)) || (token.endsWith("/") && token.length >= 3)) tokens.push(token);
    } else if (!NOT_PATHS.has(token)) {
      const ext = extensionOf(token);
      if (ext !== undefined && SOURCE_EXTENSIONS.has(ext)) tokens.push(token);
    }
  }
  return tokens;
}

/** The repeated-replace implementation of the path-only line test that the index-based one replaced. */
function referencePathOnlyLine(line: string): string | undefined {
  if (!/^\S/.test(line)) return undefined;
  let rest = line.trim().toLowerCase();
  for (let changed = true; changed;) {
    const before = rest;
    rest = rest.replace(/^(\*\*|`)/, "").replace(/(\*\*|`|:)$/, "").replace(/:\d+(?:-\d+)?$/, "");
    changed = rest !== before;
  }
  const tokens = referencePathTokens(rest);
  return tokens.length === 1 && tokens[0] === rest ? rest : undefined;
}

/** A small deterministic generator, so a failure names a reproducible input. */
function generator(seed: number): () => number {
  let state = seed;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
}
function fuzz(alphabet: readonly string[], count: number, maxLength: number, seed: number): string[] {
  const next = generator(seed);
  return Array.from({ length: count }, () => Array.from({ length: Math.floor(next() * maxLength) }, () => alphabet[Math.floor(next() * alphabet.length)]!).join(""));
}

describe("linear path tokens and path-only lines keep their results (R82)", () => {
  it("gives the reference tokens on URL-, dot- and slash-heavy fuzz", () => {
    const texts = [
      ...fuzz(["a", "b", "1", ".", "/", "-", "+", ":", "//", "://", "http", " ", "\n", "ts", ".ts", "x/", "..", "node.js", "e.g"], 3000, 18, 7),
      "see http://a/b.ts and https://x.y/z.md, then src/a.ts: and 1http://q/r.ts", "a1+b://c d.ts e://", "://x a.ts", "x:// a.ts", "ftp://", "ab://c\td/e.ts",
    ];
    for (const text of texts) expect(pathTokens(text), JSON.stringify(text)).toEqual(referencePathTokens(text));
  });

  it("gives the reference result for path-only lines with decoration", () => {
    const lines = [
      ...fuzz(["*", "**", "`", ":", "-", "1", "23", "a", "src/", "a.ts", ".", " "], 4000, 12, 11),
      "**src/a.ts**", "`src/a.ts`:", "src/a.ts:42", "src/a.ts:42-50", "**`src/a.ts:42`**:", "src/a.ts:1-", "src/a.ts:-2", ":1:2src/a.ts", "**", "``", "::", "a.ts::",
    ];
    for (const line of lines) expect(pathOnlyLine(line), JSON.stringify(line)).toBe(referencePathOnlyLine(line));
  });

  it("ignores a path-character run longer than 4096 characters", () => {
    expect(pathTokens(`${"a/".repeat(2100)}b.ts`)).toEqual([]);
    expect(pathTokens(`${"a/".repeat(2000)}b.ts`)).toHaveLength(1);
  });
});

describe("scoreReview on adversarial 64 KiB texts (R82)", () => {
  const tasks = JSON.parse(readFileSync(fileURLToPath(new URL("../docs/evaluation/extension-ablation-2026-10-20/tasks.json", import.meta.url)), "utf8")) as unknown;
  const oracles = taskSpecSchema.array().parse(tasks).flatMap((task) => (task.oracle.kind === "review" ? [{ id: task.id, oracle: task.oracle as ReviewOracle }] : []));
  const N = 64 * 1024;
  const NL = "\n";
  const tokens = (count: number): string => Array.from({ length: count }, (_, i) => `d${i}/f.ts`).join(" ");
  const inputs: Record<string, string> = {
    "one line of x": "x".repeat(N),
    "a/ runs": "a/".repeat(N / 2),
    "a.b/ runs": "a.b/".repeat(N / 4),
    "dots then a letter": ".".repeat(N - 1) + "a",
    "-* lines": "-*\n".repeat(N / 3),
    "-* in one line": "-*".repeat(N / 2),
    "many short lines": "a\n".repeat(N / 2),
    "mixed punctuation": "a.b/c-d_e: (x) [y] {z} ".repeat(Math.floor(N / 23)),
    "scheme runs": "a1+b://".repeat(N / 7),
    "bullets": "- ".repeat(N / 2),
    "numbered items": "1. a\n".repeat(N / 5),
    "headings": "# a\n".repeat(N / 4),
    "bold path lines": "**a/b.ts**\n".repeat(N / 11),
    "stars": "**".repeat(N / 2),
    "backticks": "`".repeat(N),
    "colons": ":".repeat(N),
    "line references": ":1".repeat(N / 2),
    "backticks then digits": "`".repeat(N / 2) + "1".repeat(N / 2),
    "unclosed md fences": "```md\n".repeat(N / 6),
    "unclosed fences": "```\n".repeat(N / 4) + "x",
    "closed fences": "```\na\n```\n".repeat(N / 12),
    "one long heading": `# ${"x".repeat(N - 3)}`,
    "long heading of paths, many blocks": `# ${tokens(300)}${NL}${NL}${Array.from({ length: 20000 }, () => "z").join(NL + NL)}`,
    "heading and body of many distinct paths": `# ${tokens(2500)}${NL}${tokens(2500)}`,
    "table rows": "| a | b |\n".repeat(N / 10),
  };
  it("covers every committed review oracle", () => {
    expect(oracles.length).toBeGreaterThanOrEqual(4);
  });

  it.each(Object.entries(inputs))("scores %s in far less than the bound for every review oracle", (_name, text) => {
    expect(text.length).toBeLessThanOrEqual(N + 8);
    for (const { oracle } of oracles) {
      const started = performance.now();
      scoreReview(text, oracle);
      // Measured at 2 to 90 ms on the development machine (the quadratic versions took seconds); the 2 s bound is generous for a loaded CI host and still far below the quadratic versions (seconds to minutes).
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(2000);
    }
  });
});

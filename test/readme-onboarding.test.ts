/**
 * The README is where an operator starts. Its relative links and anchors must resolve, and the
 * places that name the package version must follow `package.json` (docs/releasing.md, step 2).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const version = (JSON.parse(read("package.json")) as { version: string }).version;

/** The lines outside fenced code blocks: a `#` line or a link inside a fence is neither heading nor link. */
function prose(markdown: string): string[] {
  const lines: string[] = [];
  let fence: string | undefined;
  for (const line of markdown.split("\n")) {
    const marker = /^\s*(```|~~~)/.exec(line)?.[1];
    if (marker !== undefined && (fence === undefined || fence === marker)) { fence = fence === undefined ? marker : undefined; continue; }
    if (fence === undefined) lines.push(line);
  }
  return lines;
}

/**
 * GitHub's heading anchors: lower case, punctuation dropped, spaces as hyphens. A repeated heading gets the
 * next free numbered suffix, which also counts as taken for a later heading of that literal name.
 */
function anchors(markdown: string): Set<string> {
  const occurrences = new Map<string, number>();
  for (const line of prose(markdown)) {
    const heading = /^#{1,6}\s+(.*?)\s*$/.exec(line)?.[1];
    if (heading === undefined) continue;
    const text = heading.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    const base = text.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_ -]/gu, "").replace(/ /g, "-");
    let slug = base;
    while (occurrences.has(slug)) {
      const next = occurrences.get(base)! + 1;
      occurrences.set(base, next);
      slug = `${base}-${next}`;
    }
    occurrences.set(slug, 0);
  }
  return new Set(occurrences.keys());
}

/**
 * Relative link targets of `file` that name a missing path or a heading the target does not have. Covers the
 * two link forms with a written target, inline `[text](target)` and reference definitions `[label]: target`.
 */
function brokenLinks(file: string, markdown = read(file)): string[] {
  const broken: string[] = [];
  for (const line of prose(markdown)) {
    const definition = /^ {0,3}\[[^\]]+\]:\s*<?([^\s>]+)/.exec(line)?.[1];
    const targets = [...line.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]!);
    for (const target of definition === undefined ? targets : [definition]) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const [path, anchor] = target.split("#") as [string, string | undefined];
      const resolved = path === "" ? file : join(dirname(file), path);
      if (!existsSync(join(root, resolved))) { broken.push(target); continue; }
      if (anchor !== undefined && !(resolved.endsWith(".md") && anchors(read(resolved)).has(anchor))) broken.push(target);
    }
  }
  return broken;
}

it("finds a missing file, a missing heading and a heading that exists only inside a code fence", () => {
  const sample = [
    "[ok](docs/installation.md#upgrade) [external](https://example.com/#nowhere) [ref][good] [ref][bad]",
    "[file](docs/no-such-file.md) [heading](docs/installation.md#no-such-heading) [own](#nowhere)",
    "```sh", "[fenced](docs/no-such-file.md)", "```",
    "[good]: docs/installation.md#remove", "[bad]: docs/no-such-reference.md",
  ].join("\n");
  expect(brokenLinks("README.md", sample)).toEqual(["docs/no-such-file.md", "docs/installation.md#no-such-heading", "#nowhere", "docs/no-such-reference.md"]);
  expect([...anchors("# One\n```\n# Fenced\n```\n## 2. `Two` (three)\n# One\n# One-1\n# One\n")]).toEqual(["one", "2-two-three", "one-1", "one-1-1", "one-2"]);
});

it("resolves every relative inline link, reference definition and anchor of the README", () => {
  expect(brokenLinks("README.md")).toEqual([]);
});

it("names the package version in the README's version line and release link", () => {
  const readme = read("README.md");
  expect(readme).toContain(`The package version is **${version}**.`);
  expect(readme).toContain(`https://github.com/plagor44-ux/pi-session-mcp/releases/tag/v${version})`);
});

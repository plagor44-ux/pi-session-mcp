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

/** GitHub's heading anchors: lower case, punctuation dropped, spaces as hyphens, repeated headings numbered. */
function anchors(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const result = new Set<string>();
  for (const line of prose(markdown)) {
    const heading = /^#{1,6}\s+(.*?)\s*$/.exec(line)?.[1];
    if (heading === undefined) continue;
    const text = heading.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    const slug = text.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_ -]/gu, "").replace(/ /g, "-");
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    result.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return result;
}

/** Relative link targets of `file` that name a missing path or a heading the target does not have. */
function brokenLinks(file: string, markdown = read(file)): string[] {
  const broken: string[] = [];
  for (const line of prose(markdown)) {
    for (const match of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1]!;
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
    "[ok](docs/installation.md#upgrade) [external](https://example.com/#nowhere)",
    "[file](docs/no-such-file.md) [heading](docs/installation.md#no-such-heading) [own](#nowhere)",
    "```sh", "[fenced](docs/no-such-file.md)", "```",
  ].join("\n");
  expect(brokenLinks("README.md", sample)).toEqual(["docs/no-such-file.md", "docs/installation.md#no-such-heading", "#nowhere"]);
  expect([...anchors("# One\n```\n# Fenced\n```\n## 2. `Two` (three)\n# One\n")]).toEqual(["one", "2-two-three", "one-1"]);
});

it("resolves every relative link and anchor of the README", () => {
  expect(brokenLinks("README.md")).toEqual([]);
});

it("names the package version in the README's version line and release link", () => {
  const readme = read("README.md");
  expect(readme).toContain(`The package version is **${version}**.`);
  expect(readme).toContain(`https://github.com/plagor44-ux/pi-session-mcp/releases/tag/v${version})`);
});

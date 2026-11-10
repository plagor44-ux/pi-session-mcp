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

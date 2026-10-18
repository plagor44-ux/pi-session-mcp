import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** Follow static runtime imports/re-exports, not lazy imports or erased type imports. */
async function staticDependencies(entry: string, seen = new Set<string>()): Promise<Set<string>> {
  const path = resolve(entry);
  if (seen.has(path)) return seen;
  seen.add(path);
  const source = await readFile(path, "utf8");
  const declarations = /^(?:import|export)\s+(?!type\b)(?:[^;]*?\sfrom\s*)?["'](\.[^"']+)["']/gm;
  for (const match of source.matchAll(declarations)) {
    await staticDependencies(resolve(dirname(path), match[1]!.replace(/\.js$/, ".ts")), seen);
  }
  return seen;
}

describe("CLI static import boundaries", () => {
  it.each(["src/setup-main.ts", "src/doctor-cli.ts"])("keeps stdout guard installation out of %s", async (entry) => {
    expect(await staticDependencies(entry)).not.toContain(resolve("src/stdout-guard-install.ts"));
  });
  it("finds the guard in the server entry point as a positive control", async () => {
    expect(await staticDependencies("src/main.ts")).toContain(resolve("src/stdout-guard-install.ts"));
  });
});

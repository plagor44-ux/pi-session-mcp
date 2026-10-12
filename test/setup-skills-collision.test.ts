import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { expectSkill, fixture } from "./fixtures/setup-skills-fixture.js";
import { removeTemporaryRoots } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

/**
 * Two different trees whose 0.8.0 (version 1) fingerprint is the same stream of
 * `path NUL content NUL`: tree A holds one file whose content embeds the second file's record.
 */
const COLLIDING_A = { "assets/a.bin": Buffer.from("X\0assets/b.bin\0Y") };
const COLLIDING_B = { "assets/a.bin": Buffer.from("X"), "assets/b.bin": Buffer.from("Y") };

async function writeAssets(directory: string, files: Record<string, Buffer>): Promise<void> {
  await rm(join(directory, "assets"), { recursive: true, force: true });
  await mkdir(join(directory, "assets"), { recursive: true });
  for (const [path, bytes] of Object.entries(files)) await writeFile(join(directory, path), bytes);
}

describe("a modified copy that collides with setup's own tree", () => {
  it.each(["remove", "rollback"] as const)("%s reports divergence and keeps the files", async (operation) => {
    const f = await fixture(); const slot = f.slot({ client: "codex", scope: "user", alias: "pi-session-mcp" });
    await writeAssets(f.source, COLLIDING_A);
    expectSkill(await f.run("apply"), "skill_installed", "ok");
    expect(await readFile(join(slot, "assets", "a.bin"))).toEqual(COLLIDING_A["assets/a.bin"]);
    // The operator replaces the copy by a different tree that shares the version 1 fingerprint.
    await writeAssets(slot, COLLIDING_B);
    const output = await f.run(operation);
    expectSkill(output, "skill_divergent", "divergent");
    expect(output.exitCode).toBe(1);
    expect(await readFile(join(slot, "assets", "a.bin"))).toEqual(COLLIDING_B["assets/a.bin"]);
    expect(await readFile(join(slot, "assets", "b.bin"))).toEqual(COLLIDING_B["assets/b.bin"]);
    expect(existsSync(join(slot, "SKILL.md"))).toBe(true);
  });
});

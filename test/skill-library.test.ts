import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  builtinSkillPath, CONTROLLER_SKILLS, MAX_SKILL_TREE_BYTES, MAX_SKILL_TREE_FILES, PACKAGE_ROOT, readSkillTree,
  resolveLibrarySkill, shippedSkillsDirectory, SKILL_NAME_PATTERN, skillOverrideDirectory,
} from "../src/skill-library.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

async function skill(root: string, name: string, files: Record<string, string> = {}): Promise<string> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Fixture.\n---\n`);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(directory, path, ".."), { recursive: true });
    await writeFile(join(directory, path), content);
  }
  return directory;
}

describe("skill library", () => {
  it("ships every controller skill and resolves the package root", () => {
    for (const name of CONTROLLER_SKILLS) {
      expect(resolveLibrarySkill(name, { overrideDirectory: "/nonexistent-override" })).toMatchObject({ name, source: "shipped" });
    }
    expect(shippedSkillsDirectory()).toBe(join(PACKAGE_ROOT, "skills"));
  });

  it("derives the override directory from the configuration file only", () => {
    expect(skillOverrideDirectory("/etc/pi/config.json")).toBe("/etc/pi/skills");
  });

  it("lets an override replace a shipped skill and add new names", async () => {
    const root = await temporaryRoot("pi-skill-library-");
    const overrideDirectory = join(root, "overrides");
    await skill(overrideDirectory, "pi-session-review");
    await skill(overrideDirectory, "team-checklist");
    expect(resolveLibrarySkill("pi-session-review", { overrideDirectory })).toMatchObject({ source: "override", directory: join(overrideDirectory, "pi-session-review") });
    expect(resolveLibrarySkill("team-checklist", { overrideDirectory })).toMatchObject({ source: "override" });
    expect(resolveLibrarySkill("pi-session-implementation", { overrideDirectory })).toMatchObject({ source: "shipped" });
    expect(resolveLibrarySkill("absent-skill", { overrideDirectory })).toBeUndefined();
    expect(builtinSkillPath("absent-skill", { overrideDirectory })).toBe(join(PACKAGE_ROOT, "skills", "absent-skill", "SKILL.md"));
    expect(builtinSkillPath("team-checklist", { overrideDirectory })).toBe(join(overrideDirectory, "team-checklist", "SKILL.md"));
  });

  it.each(["", "Upper", "under_score", "-lead", "trail-", "double--hyphen", "a/b", "..", "x".repeat(65)])("rejects the name %j", (name) => {
    expect(SKILL_NAME_PATTERN.test(name)).toBe(false);
    expect(resolveLibrarySkill(name, { overrideDirectory: "/tmp" })).toBeUndefined();
  });

  it("reads a stable tree without dot entries and fingerprints its content", async () => {
    const root = await temporaryRoot("pi-skill-tree-");
    const directory = await skill(root, "tree", { "references/b.md": "b", "a.md": "a", ".hidden": "x", ".git/config": "x" });
    const first = await readSkillTree(directory);
    expect(first.files.map((file) => file.path)).toEqual(["SKILL.md", "a.md", "references/b.md"]);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect((await readSkillTree(directory)).fingerprint).toBe(first.fingerprint);
    await writeFile(join(directory, "a.md"), "changed");
    expect((await readSkillTree(directory)).fingerprint).not.toBe(first.fingerprint);
  });

  it("rejects a missing SKILL.md, links inside the tree and oversized trees", async () => {
    const root = await temporaryRoot("pi-skill-tree-bad-");
    await mkdir(join(root, "empty"));
    await writeFile(join(root, "empty", "README.md"), "x");
    await expect(readSkillTree(join(root, "empty"))).rejects.toMatchObject({ code: "skill_tree_missing" });
    await expect(readSkillTree(join(root, "absent"))).rejects.toMatchObject({ code: "skill_tree_missing" });
    const linked = await skill(root, "linked");
    await symlink("/etc/hostname", join(linked, "outside.md"));
    await expect(readSkillTree(linked)).rejects.toMatchObject({ code: "skill_tree_invalid" });
    const many = await skill(root, "many", Object.fromEntries(Array.from({ length: MAX_SKILL_TREE_FILES }, (_, index) => [`f${index}.md`, "x"])));
    await expect(readSkillTree(many)).rejects.toMatchObject({ code: "skill_tree_too_large" });
    const big = await skill(root, "big", { "big.md": "x".repeat(MAX_SKILL_TREE_BYTES) });
    await expect(readSkillTree(big)).rejects.toMatchObject({ code: "skill_tree_too_large" });
  });

  it("follows a linked skill root but keeps the shipped skills readable", async () => {
    const root = await temporaryRoot("pi-skill-tree-root-");
    const real = await skill(root, "real");
    await symlink(real, join(root, "alias"));
    expect((await readSkillTree(join(root, "alias"))).fingerprint).toBe((await readSkillTree(real)).fingerprint);
    for (const name of ["pi-session-orchestration", "pi-session-implementation", "pi-session-review"]) {
      await expect(readSkillTree(join(shippedSkillsDirectory(), name))).resolves.toMatchObject({ files: [expect.objectContaining({ path: "SKILL.md" })] });
    }
  });
});

import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  builtinSkillPath, CONTROLLER_SKILLS, LEGACY_SKILL_TREE_FINGERPRINT_PATTERN, legacySkillTreeFingerprint, MAX_SKILL_TREE_BYTES,
  MAX_SKILL_TREE_FILES, PACKAGE_ROOT, provesLegacyFingerprint, readSkillTree, RELEASED_SKILL_TREES, releasedSkillFingerprint,
  resolveLibrarySkill, shippedSkillsDirectory, SKILL_NAME_PATTERN, SKILL_TREE_FINGERPRINT_PATTERN, skillOverrideDirectory,
  SkillTreeError, skillTreeFingerprint,
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
    expect(first.fingerprint).toMatch(SKILL_TREE_FINGERPRINT_PATTERN);
    expect(first.legacyFingerprint).toMatch(LEGACY_SKILL_TREE_FINGERPRINT_PATTERN);
    expect((await readSkillTree(directory)).fingerprint).toBe(first.fingerprint);
    await writeFile(join(directory, "a.md"), "changed");
    expect((await readSkillTree(directory)).fingerprint).not.toBe(first.fingerprint);
  });

  it("separates trees that the version 1 encoding confused through NUL bytes in content", async () => {
    const root = await temporaryRoot("pi-skill-tree-collision-");
    const joined = await skill(root, "joined");
    await mkdir(join(joined, "assets"));
    await writeFile(join(joined, "assets", "a.bin"), Buffer.from("X\0assets/b.bin\0Y", "latin1"));
    const split = await skill(root, "split", { "assets/a.bin": "X", "assets/b.bin": "Y" });
    // Both trees carry the same valid SKILL.md apart from the name line; align it.
    await writeFile(join(joined, "SKILL.md"), "---\nname: same\ndescription: Fixture.\n---\n");
    await writeFile(join(split, "SKILL.md"), "---\nname: same\ndescription: Fixture.\n---\n");
    const [a, b] = await Promise.all([readSkillTree(joined), readSkillTree(split)]);
    expect(a.legacyFingerprint).toBe(b.legacyFingerprint);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it("encodes lengths and order explicitly and refuses duplicate paths", () => {
    const file = (path: string, content: string) => ({ path, bytes: Buffer.from(content, "utf8") });
    const ordered = skillTreeFingerprint([file("SKILL.md", "s"), file("a/b.md", "x")]);
    expect(skillTreeFingerprint([file("a/b.md", "x"), file("SKILL.md", "s")])).toBe(ordered);
    expect(skillTreeFingerprint([file("SKILL.md", "s"), file("a/b.md", "x"), file("c", "")])).not.toBe(ordered);
    expect(skillTreeFingerprint([file("SKILL.md", "sa"), file("/b.md", "x")])).not.toBe(ordered);
    expect(() => skillTreeFingerprint([file("SKILL.md", "s"), file("SKILL.md", "t")])).toThrow(SkillTreeError);
    expect(legacySkillTreeFingerprint([file("SKILL.md", "s")])).toMatch(LEGACY_SKILL_TREE_FINGERPRINT_PATTERN);
  });

  it("accepts a version 1 fingerprint only with byte equality to a trusted tree", async () => {
    const root = await temporaryRoot("pi-skill-tree-legacy-");
    const current = await readSkillTree(await skill(root, "current", { "a.md": "a" }));
    const other = await readSkillTree(await skill(root, "other", { "a.md": "b" }));
    expect(provesLegacyFingerprint("current", current.legacyFingerprint, current, [current])).toBe(true);
    // A matching version 1 value alone is not enough: the candidate must be the trusted tree.
    expect(provesLegacyFingerprint("current", current.legacyFingerprint, other, [current])).toBe(false);
    expect(provesLegacyFingerprint("current", current.legacyFingerprint, current)).toBe(false);
    expect(provesLegacyFingerprint("current", current.fingerprint, current, [current])).toBe(false);
    const released = RELEASED_SKILL_TREES[0]!;
    expect(provesLegacyFingerprint(released.name, released.legacyFingerprint, { fingerprint: released.fingerprint })).toBe(true);
    expect(provesLegacyFingerprint("pi-session-review", released.legacyFingerprint, { fingerprint: released.fingerprint })).toBe(false);
    expect(releasedSkillFingerprint(released.name, released.legacyFingerprint)).toBe(released.fingerprint);
    expect(releasedSkillFingerprint(released.name, current.legacyFingerprint)).toBeUndefined();
  });

  it("lists every shipped skill of 0.8.0 as a released tree", () => {
    expect(RELEASED_SKILL_TREES.map((tree) => tree.name).sort()).toEqual(["pi-session-implementation", "pi-session-orchestration", "pi-session-review"]);
    for (const tree of RELEASED_SKILL_TREES) {
      expect(tree.release).toBe("0.8.0");
      expect(tree.legacyFingerprint).toMatch(LEGACY_SKILL_TREE_FINGERPRINT_PATTERN);
      expect(tree.fingerprint).toMatch(SKILL_TREE_FINGERPRINT_PATTERN);
    }
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

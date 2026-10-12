import { mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { customizeSkill, MAX_SKILL_BASES_BYTES, readSkillBases, SKILL_BASES_FILE, SkillBasesError } from "../src/skill-customize.js";
import { readSkillTree } from "../src/skill-library.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

async function fixture() {
  const root = await temporaryRoot("pi-skill-customize-");
  const packageRoot = join(root, "package");
  const shipped = join(packageRoot, "skills", "review");
  await mkdir(join(shipped, "refs"), { recursive: true });
  await writeFile(join(shipped, "SKILL.md"), "---\nname: review\ndescription: Shipped.\n---\n");
  await writeFile(join(shipped, "refs", "a.md"), "reference");
  const configDirectory = join(root, "config dir");
  await mkdir(configDirectory);
  const configPath = join(configDirectory, "config.json");
  await writeFile(configPath, "{}");
  const override = join(configDirectory, "skills");
  const run = (name: string, apply: boolean) => customizeSkill({ name, configPath, apply, packageRoot });
  const finding = (outcome: Awaited<ReturnType<typeof run>>) => outcome.findings[0]!;
  return { root, packageRoot, shipped, configPath, override, run, finding };
}

const FINGERPRINT = /^[0-9a-f]{64}$/;

describe("skill customization", () => {
  it("plans without writing in a dry run", async () => {
    const { run, finding, override } = await fixture();
    const outcome = await run("review", false);
    expect(outcome).toMatchObject({ operation: "dry-run", status: "planned", exitCode: 0 });
    expect(finding(outcome)).toEqual({ target: { client: "skills", scope: "override", alias: "review" }, status: "planned", code: "skill_customize_planned" });
    await expect(stat(override)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("copies the shipped tree and records its fingerprint as the base", async () => {
    const { run, finding, override, shipped } = await fixture();
    const outcome = await run("review", true);
    expect(outcome).toMatchObject({ operation: "apply", exitCode: 0 });
    expect(finding(outcome)).toMatchObject({ status: "ok", code: "skill_customized" });
    const copy = await readSkillTree(join(override, "review"));
    const original = await readSkillTree(shipped);
    expect(copy.fingerprint).toBe(original.fingerprint);
    expect(await readFile(join(override, "review", "refs", "a.md"), "utf8")).toBe("reference");
    expect((await stat(override)).mode & 0o777).toBe(0o700);
    const basesPath = join(override, SKILL_BASES_FILE);
    expect((await stat(basesPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(basesPath, "utf8"))).toEqual({ schemaVersion: 1, bases: { review: original.fingerprint } });
    expect((await readdir(override)).sort()).toEqual([SKILL_BASES_FILE, "review"]);
  });

  it("is idempotent and reports a current override without writing", async () => {
    const { run, finding, override } = await fixture();
    await run("review", true);
    const before = await readFile(join(override, SKILL_BASES_FILE), "utf8");
    for (const apply of [false, true]) {
      const outcome = await run("review", apply);
      expect(finding(outcome)).toMatchObject({ status: "unchanged", code: "skill_override_current" });
      expect(outcome.exitCode).toBe(0);
    }
    expect(await readFile(join(override, SKILL_BASES_FILE), "utf8")).toBe(before);
  });

  it("never overwrites an existing override that has no recorded base", async () => {
    const { run, finding, override, shipped } = await fixture();
    await mkdir(join(override, "review"), { recursive: true });
    await writeFile(join(override, "review", "SKILL.md"), "operator content");
    expect(finding(await run("review", false))).toMatchObject({ status: "planned", code: "skill_override_outdated" });
    expect(finding(await run("review", true))).toMatchObject({ status: "ok", code: "skill_base_updated" });
    expect(await readFile(join(override, "review", "SKILL.md"), "utf8")).toBe("operator content");
    expect(await readdir(join(override, "review"))).toEqual(["SKILL.md"]);
    const bases = await readSkillBases(override);
    expect(bases.review).toBe((await readSkillTree(shipped)).fingerprint);
  });

  it("acknowledges a changed original by moving the base only", async () => {
    const { run, finding, override, shipped } = await fixture();
    await run("review", true);
    await writeFile(join(override, "review", "SKILL.md"), "operator edit");
    const operatorBytes = await readFile(join(override, "review", "SKILL.md"));
    await writeFile(join(shipped, "SKILL.md"), "---\nname: review\ndescription: Shipped v2.\n---\n");
    const dry = await run("review", false);
    expect(finding(dry)).toMatchObject({ status: "planned", code: "skill_override_outdated" });
    expect(dry.status).toBe("planned");
    expect((await readSkillBases(override)).review).not.toBe((await readSkillTree(shipped)).fingerprint);
    const applied = await run("review", true);
    expect(finding(applied)).toMatchObject({ status: "ok", code: "skill_base_updated" });
    expect((await readSkillBases(override)).review).toBe((await readSkillTree(shipped)).fingerprint);
    expect(await readFile(join(override, "review", "SKILL.md"))).toEqual(operatorBytes);
    expect(await readFile(join(override, "review", "refs", "a.md"), "utf8")).toBe("reference");
    expect(finding(await run("review", true))).toMatchObject({ status: "unchanged", code: "skill_override_current" });
  });

  it("keeps the bases of other skills", async () => {
    const { run, override, packageRoot } = await fixture();
    await mkdir(join(packageRoot, "skills", "plan"));
    await writeFile(join(packageRoot, "skills", "plan", "SKILL.md"), "plan");
    await run("review", true);
    await run("plan", true);
    const bases = await readSkillBases(override);
    expect(Object.keys(bases).sort()).toEqual(["plan", "review"]);
    expect(Object.values(bases).every((value) => FINGERPRINT.test(value))).toBe(true);
  });

  it("fails for a skill that is not shipped or has an invalid name", async () => {
    const { run, finding, override } = await fixture();
    for (const name of ["missing", "Review", "../review", "review/", "", "a".repeat(65), "--apply"]) {
      for (const apply of [false, true]) {
        const outcome = await run(name, apply);
        expect(outcome).toMatchObject({ status: "failed", exitCode: 1 });
        expect(finding(outcome).code).toBe("skill_not_shipped");
        expect(finding(outcome).status).toBe("failed");
      }
    }
    expect((await run("../review", false)).findings[0]!.target.alias).toBe("invalid");
    expect((await run("missing", false)).findings[0]!.target.alias).toBe("missing");
    await expect(stat(override)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails with skill_customize_failed for an unusable shipped skill", async () => {
    const { run, finding, shipped } = await fixture();
    await symlink("/etc/hostname", join(shipped, "outside.md"));
    expect(finding(await run("review", true))).toMatchObject({ status: "failed", code: "skill_customize_failed" });
  });

  it("fails with skill_override_invalid for a file, a link or a rejected tree", async () => {
    const { run, finding, override, root } = await fixture();
    await mkdir(override, { recursive: true });
    await writeFile(join(override, "review"), "a file");
    expect(finding(await run("review", true))).toMatchObject({ status: "failed", code: "skill_override_invalid" });
    await rm(join(override, "review"));
    await mkdir(join(root, "elsewhere"));
    await symlink(join(root, "elsewhere"), join(override, "review"));
    expect(finding(await run("review", true))).toMatchObject({ status: "failed", code: "skill_override_invalid" });
    await rm(join(override, "review"));
    await mkdir(join(override, "review"));
    await writeFile(join(override, "review", "README.md"), "no SKILL.md");
    expect(finding(await run("review", false))).toMatchObject({ status: "failed", code: "skill_override_invalid" });
    await writeFile(join(override, "review", "SKILL.md"), "x");
    await symlink("/etc/hostname", join(override, "review", "link.md"));
    expect(finding(await run("review", true))).toMatchObject({ status: "failed", code: "skill_override_invalid" });
    await expect(stat(join(override, SKILL_BASES_FILE))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["not JSON", "{"],
    ["an array", "[]"],
    ["a wrong version", JSON.stringify({ schemaVersion: 2, bases: {} })],
    ["an extra key", JSON.stringify({ schemaVersion: 1, bases: {}, extra: 1 })],
    ["a missing bases map", JSON.stringify({ schemaVersion: 1 })],
    ["an invalid name", JSON.stringify({ schemaVersion: 1, bases: { "Bad Name": "a".repeat(64) } })],
    ["a short fingerprint", JSON.stringify({ schemaVersion: 1, bases: { review: "abc" } })],
    ["an uppercase fingerprint", JSON.stringify({ schemaVersion: 1, bases: { review: "A".repeat(64) } })],
    ["a non-string fingerprint", JSON.stringify({ schemaVersion: 1, bases: { review: 1 } })],
    ["an oversized file", " ".repeat(MAX_SKILL_BASES_BYTES + 1)],
  ])("reports a corrupt bases file (%s) without touching anything", async (_name, content) => {
    const { run, finding, override } = await fixture();
    await mkdir(override, { recursive: true });
    await writeFile(join(override, SKILL_BASES_FILE), content);
    for (const apply of [false, true]) {
      const outcome = await run("review", apply);
      expect(outcome).toMatchObject({ status: "failed", exitCode: 1 });
      expect(finding(outcome).code).toBe("skill_bases_corrupt");
    }
    await expect(readSkillBases(override)).rejects.toBeInstanceOf(SkillBasesError);
    expect(await readFile(join(override, SKILL_BASES_FILE), "utf8")).toBe(content);
    expect(await readdir(override)).toEqual([SKILL_BASES_FILE]);
  });

  it("treats a bases file that is a link as corrupt", async () => {
    const { run, finding, override, root } = await fixture();
    await mkdir(override, { recursive: true });
    await writeFile(join(root, "bases.json"), JSON.stringify({ schemaVersion: 1, bases: {} }));
    await symlink(join(root, "bases.json"), join(override, SKILL_BASES_FILE));
    expect(finding(await run("review", true)).code).toBe("skill_bases_corrupt");
  });

  it("reads an absent bases file as empty", async () => {
    const { override } = await fixture();
    expect(await readSkillBases(override)).toEqual({});
  });

  it("leaves no temporary entry behind and keeps output free of paths and content", async () => {
    const { run, override, root } = await fixture();
    const outputs = [await run("review", false), await run("review", true), await run("review", true), await run("nope", true)];
    const text = JSON.stringify(outputs);
    expect(text).not.toContain(root);
    expect(text).not.toMatch(/\/|Shipped\.|reference/);
    expect((await readdir(override)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });
});

import { mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor.js";
import { customizeSkill, MAX_SKILL_BASES_BYTES, readSkillBases, SKILL_BASES_FILE, SkillBasesError } from "../src/skill-customize.js";
import { acquireOverrideLock, SKILL_BASES_LOCK_FILE } from "../src/override-lock.js";
import { readSkillTree, type ReleasedSkillTree } from "../src/skill-library.js";
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

const FINGERPRINT = /^v2:[0-9a-f]{64}$/;

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
    expect(JSON.parse(await readFile(basesPath, "utf8"))).toEqual({ schemaVersion: 2, bases: { review: original.fingerprint } });
    expect((await readdir(override)).sort()).toEqual([SKILL_BASES_FILE, SKILL_BASES_LOCK_FILE, "review"]);
    expect((await stat(join(override, SKILL_BASES_LOCK_FILE))).mode & 0o777).toBe(0o600);
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
    // A link to a complete, valid skill is still refused: the override entry itself must be a directory.
    await mkdir(join(root, "elsewhere"));
    await writeFile(join(root, "elsewhere", "SKILL.md"), "---\nname: review\ndescription: Linked.\n---\n");
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
    ["a wrong version", JSON.stringify({ schemaVersion: 3, bases: {} })],
    ["a string version", JSON.stringify({ schemaVersion: "2", bases: {} })],
    ["a version 2 value in a version 1 file", JSON.stringify({ schemaVersion: 1, bases: { review: `v2:${"a".repeat(64)}` } })],
    ["a short version 2 value", JSON.stringify({ schemaVersion: 2, bases: { review: `v2:${"a".repeat(63)}` } })],
    ["an uppercase version 2 value", JSON.stringify({ schemaVersion: 2, bases: { review: `v2:${"A".repeat(64)}` } })],
    ["a version 2 value with another prefix", JSON.stringify({ schemaVersion: 2, bases: { review: `v3:${"a".repeat(64)}` } })],
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
    // The apply took the lock before it read the file; that is the only addition.
    expect((await readdir(override)).sort()).toEqual([SKILL_BASES_FILE, SKILL_BASES_LOCK_FILE]);
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

const V2_ZERO = `v2:${"0".repeat(64)}`;

describe("skill customization transaction", () => {
  const entries = async (directory: string) => (await readdir(directory)).sort();

  async function twoSkills() {
    const fx = await fixture();
    await mkdir(join(fx.packageRoot, "skills", "plan"));
    await writeFile(join(fx.packageRoot, "skills", "plan", "SKILL.md"), "plan");
    const apply = (name: string, dependencies: Parameters<typeof customizeSkill>[1] = {}) => customizeSkill({ name, configPath: fx.configPath, apply: true, packageRoot: fx.packageRoot }, dependencies);
    const dry = (name: string, dependencies: Parameters<typeof customizeSkill>[1] = {}) => customizeSkill({ name, configPath: fx.configPath, apply: false, packageRoot: fx.packageRoot }, dependencies);
    return { ...fx, apply, dry };
  }

  it("takes no lock and writes nothing in a dry run, with or without an override directory", async () => {
    const { dry, override } = await twoSkills();
    expect((await dry("review")).findings[0]!.code).toBe("skill_customize_planned");
    await expect(stat(override)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(join(override, "review"), { recursive: true });
    await writeFile(join(override, "review", "SKILL.md"), "operator");
    const outcome = await dry("review");
    expect(outcome.findings[0]).toMatchObject({ status: "planned", code: "skill_override_outdated" });
    expect(await entries(override)).toEqual(["review"]);
    // A held lock does not matter to a dry run.
    await writeFile(join(override, SKILL_BASES_FILE), JSON.stringify({ schemaVersion: 2, bases: {} }));
    const lock = await acquireOverrideLock(override);
    try { expect((await dry("review", { lock: { timeoutMs: 50 } })).findings[0]!.code).toBe("skill_override_outdated"); }
    finally { await lock.release(); }
  });

  it("reads the bases only after the lock is held", async () => {
    const { apply, override } = await twoSkills();
    await mkdir(override, { recursive: true });
    // Another run commits a base between this run's start and its lock.
    const outcome = await apply("review", { afterLock: () => writeFile(join(override, SKILL_BASES_FILE), JSON.stringify({ schemaVersion: 2, bases: { plan: V2_ZERO } })) });
    expect(outcome.findings[0]).toMatchObject({ status: "ok", code: "skill_customized" });
    expect(Object.keys((await readSkillBases(override))).sort()).toEqual(["plan", "review"]);
    expect((await readSkillBases(override)).plan).toBe(V2_ZERO);
  });

  it("reports a bases file that turns corrupt under the lock and changes nothing", async () => {
    const { apply, override } = await twoSkills();
    await mkdir(override, { recursive: true });
    const outcome = await apply("review", { afterLock: () => writeFile(join(override, SKILL_BASES_FILE), "{") });
    expect(outcome.findings[0]).toMatchObject({ status: "failed", code: "skill_bases_corrupt" });
    expect(await readFile(join(override, SKILL_BASES_FILE), "utf8")).toBe("{");
    expect(await entries(override)).toEqual([SKILL_BASES_FILE, SKILL_BASES_LOCK_FILE]);
  });

  it("keeps the previous bases byte-identical when the commit fails and completes on retry", async () => {
    const { apply, dry, override, shipped } = await twoSkills();
    expect((await apply("plan")).findings[0]!.code).toBe("skill_customized");
    const before = await readFile(join(override, SKILL_BASES_FILE));
    const failed = await apply("review", { beforeBasesRename: () => { throw new Error("injected"); } });
    expect(failed).toMatchObject({ status: "failed", exitCode: 1 });
    expect(failed.findings[0]!.code).toBe("skill_customize_failed");
    expect(await readFile(join(override, SKILL_BASES_FILE))).toEqual(before);
    expect((await readSkillBases(override)).plan).toMatch(FINGERPRINT);
    expect((await entries(override)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    // The copy exists and equals the shipped tree: the retry completes the customization.
    expect((await dry("review")).findings[0]).toMatchObject({ status: "planned", code: "skill_customize_planned" });
    expect((await apply("review")).findings[0]).toMatchObject({ status: "ok", code: "skill_customized" });
    const bases = await readSkillBases(override);
    expect(Object.keys(bases).sort()).toEqual(["plan", "review"]);
    expect(bases.review).toBe((await readSkillTree(shipped)).fingerprint);
    expect((await apply("review")).findings[0]!.code).toBe("skill_override_current");
  });

  it("never overwrites operator changes made between a failed commit and the retry", async () => {
    const { apply, override } = await twoSkills();
    await apply("review", { beforeBasesRename: () => { throw new Error("injected"); } });
    await writeFile(join(override, "review", "SKILL.md"), "operator edit");
    await writeFile(join(override, "review", "extra.md"), "operator file");
    const outcome = await apply("review");
    expect(outcome.findings[0]).toMatchObject({ status: "ok", code: "skill_base_updated" });
    expect(await readFile(join(override, "review", "SKILL.md"), "utf8")).toBe("operator edit");
    expect(await readFile(join(override, "review", "extra.md"), "utf8")).toBe("operator file");
  });

  it("fails with a distinct code when the lock stays busy and writes nothing", async () => {
    const { apply, override } = await twoSkills();
    await mkdir(override, { recursive: true });
    const holder = await acquireOverrideLock(override);
    try {
      const started = Date.now();
      const outcome = await apply("review", { lock: { timeoutMs: 200 } });
      expect(outcome).toMatchObject({ status: "failed", exitCode: 1 });
      expect(outcome.findings[0]!.code).toBe("skill_customize_lock_busy");
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally { await holder.release(); }
    expect(await entries(override)).toEqual([SKILL_BASES_LOCK_FILE]);
  });

  it("fails closed with skill_customize_lock_unavailable and writes no copy or bases", async () => {
    const { apply, override } = await twoSkills();
    const unavailable = [
      { platform: "win32" as const },
      { platform: "linux" as const, isTrustedBinary: () => false },
      { platform: "linux" as const, isTrustedBinary: () => true, readStatfs: async () => ({ type: 0 }) },
      { platform: "darwin" as const, readStatfs: async (path: string) => ({ type: path === "/" ? 1 : 2 }) },
    ];
    for (const lock of unavailable) {
      const outcome = await apply("review", { lock });
      expect(outcome.findings[0]).toMatchObject({ status: "failed", code: "skill_customize_lock_unavailable" });
      expect(await entries(override)).toEqual([]);
    }
  });

  describe("legacy bases", () => {
    const LEGACY = "a".repeat(64);
    const UNRESOLVED = "b".repeat(64);
    const released = (name: string, fingerprint: string): ReleasedSkillTree[] => [{ name, release: "0.8.0", legacyFingerprint: LEGACY, fingerprint }];

    async function legacyFixture(bases: Record<string, string>, schemaVersion = 1) {
      const fx = await twoSkills();
      await mkdir(fx.override, { recursive: true });
      // review and plan already have operator copies, as after a 0.8.0 customization.
      for (const name of ["review", "plan"]) await mkdir(join(fx.override, name));
      await writeFile(join(fx.override, "review", "SKILL.md"), "operator review");
      await writeFile(join(fx.override, "plan", "SKILL.md"), "operator plan");
      const text = `${JSON.stringify({ schemaVersion, bases })}\n`;
      await writeFile(join(fx.override, SKILL_BASES_FILE), text);
      return { ...fx, text };
    }

    it("interprets resolvable and unresolvable legacy bases without writing in a dry run or in Doctor", async () => {
      const { dry, override, shipped, packageRoot, text } = await legacyFixture({ review: LEGACY, plan: UNRESOLVED });
      const original = (await readSkillTree(shipped)).fingerprint;
      const trees = released("review", original);
      expect((await dry("review", { released: trees })).findings[0]).toMatchObject({ status: "planned", code: "skill_base_migration_planned" });
      expect((await dry("plan", { released: trees })).findings[0]).toMatchObject({ status: "planned", code: "skill_base_unverified" });
      const config = async () => ({
        workspaces: new Map(), executionProfiles: new Map(), defaultExecutionProfile: "none",
        configuration: { fingerprint: `sha256:${"0".repeat(64)}` as `sha256:${string}`, reloadPolicy: "restart-required" as const }, skillOverrideDirectory: override,
      });
      const checks = (await runDoctor({ packageRoot, loadConfig: config, releasedSkillTrees: trees })).checks.filter((check) => check.id === "skill_override_outdated");
      expect(checks.map((check) => [check.subject, check.severity])).toEqual([["skill:plan", "warning"], ["skill:review", "ok"]]);
      expect(await readFile(join(override, SKILL_BASES_FILE), "utf8")).toBe(text);
      expect(await entries(override)).toEqual([SKILL_BASES_FILE, "plan", "review"]);
    });

    it("rewrites the file as schema version 2 on the next apply, migrating what is provable", async () => {
      const { apply, override, shipped, packageRoot } = await legacyFixture({ review: LEGACY, plan: UNRESOLVED });
      const original = (await readSkillTree(shipped)).fingerprint;
      // Another skill's apply: review migrates to its version 2 value, plan keeps its legacy value verbatim.
      await mkdir(join(packageRoot, "skills", "gamma"));
      await writeFile(join(packageRoot, "skills", "gamma", "SKILL.md"), "gamma");
      expect((await apply("gamma", { released: released("review", original) })).findings[0]).toMatchObject({ status: "ok", code: "skill_customized" });
      const gamma = (await readSkillBases(override)).gamma!;
      expect(JSON.parse(await readFile(join(override, SKILL_BASES_FILE), "utf8"))).toEqual({ schemaVersion: 2, bases: { gamma, plan: UNRESOLVED, review: original } });
      expect(gamma).toMatch(FINGERPRINT);
    });

    it("acknowledges an unresolvable legacy base by recording the shipped value", async () => {
      const { apply, override, shipped } = await legacyFixture({ plan: UNRESOLVED });
      expect((await apply("plan")).findings[0]).toMatchObject({ status: "ok", code: "skill_base_updated" });
      expect((await readSkillBases(override)).plan).toBe((await readSkillTree(join(shipped, "..", "plan"))).fingerprint);
      expect(JSON.parse(await readFile(join(override, SKILL_BASES_FILE), "utf8")).schemaVersion).toBe(2);
    });

    it("migrates a legacy base that names the current shipped tree, and reports an outdated one", async () => {
      const { apply, dry, override, shipped } = await legacyFixture({ review: LEGACY, plan: LEGACY });
      const original = (await readSkillTree(shipped)).fingerprint;
      expect((await apply("review", { released: released("review", original) })).findings[0]).toMatchObject({ status: "ok", code: "skill_base_migrated" });
      expect((await readSkillBases(override)).review).toBe(original);
      expect((await readFile(join(override, "review", "SKILL.md"), "utf8"))).toBe("operator review");
      // plan's released original differs from the shipped tree: the change is reported and acknowledged as usual.
      const older = released("plan", V2_ZERO);
      expect((await dry("plan", { released: older })).findings[0]).toMatchObject({ status: "planned", code: "skill_override_outdated" });
      expect((await apply("plan", { released: older })).findings[0]).toMatchObject({ status: "ok", code: "skill_base_updated" });
    });

    it("reads schema version 2 with a legacy value and rejects other shapes", async () => {
      const { override } = await legacyFixture({ review: UNRESOLVED, plan: V2_ZERO }, 2);
      expect(await readSkillBases(override)).toEqual({ review: UNRESOLVED, plan: V2_ZERO });
    });
  });
});

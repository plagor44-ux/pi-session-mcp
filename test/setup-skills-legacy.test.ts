import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { OwnershipRecord } from "../src/setup-ownership.js";
import { legacySkillTreeFingerprint, readSkillTree, SKILL_TREE_FINGERPRINT_PATTERN, type ReleasedSkillTree } from "../src/skill-library.js";
import { expectSkill, fixture, skill, skillTarget, targets } from "./fixtures/setup-skills-fixture.js";
import { removeTemporaryRoots } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

const target = targets[0]!;
const ownedTarget = skillTarget(target);
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A record as 0.8.0 wrote it: a bare version 1 value. */
async function writeLegacy(f: Fixture, record: Partial<OwnershipRecord> & { readonly fingerprint: string }): Promise<OwnershipRecord> {
  const legacy: OwnershipRecord = { target: ownedTarget, previous: "absent", phase: "owned", transactionId: randomUUID(), ...record };
  await f.ownership.put(legacy);
  return legacy;
}
async function overrideWith(f: Fixture, content: string): Promise<void> {
  await mkdir(f.override, { recursive: true }); await writeFile(join(f.override, "SKILL.md"), content);
}
const released = (tree: Awaited<ReturnType<typeof readSkillTree>>): ReleasedSkillTree[] =>
  [{ name: skill, release: "test", legacyFingerprint: tree.legacyFingerprint, fingerprint: tree.fingerprint }];

describe("version 2 skill records", () => {
  it("stores version 2 values through install, verify, unchanged apply and remove", async () => {
    const f = await fixture(); const slot = f.slot(target);
    const puts: OwnershipRecord[] = []; const put = f.ownership.put.bind(f.ownership);
    f.ownership.put = async (record) => { if (record.target.alias.startsWith("skill:")) puts.push(record); await put(record); };
    expectSkill(await f.run("apply"), "skill_installed", "ok");
    const installed = await readSkillTree(slot);
    expect(installed.fingerprint).toMatch(SKILL_TREE_FINGERPRINT_PATTERN);
    expect(await f.ownership.get(ownedTarget)).toMatchObject({ phase: "owned", fingerprint: installed.fingerprint });
    expectSkill(await f.run("verify"), "skill_verified", "ok");
    expectSkill(await f.run("apply"), "skill_already_equivalent", "unchanged");
    expect(puts.map((record) => [record.target.alias, record.phase])).toEqual([
      ["skill:pi-session-orchestration", "pending"], ["skill:pi-session-orchestration", "owned"],
      ["skill:pi-session-profiles", "pending"], ["skill:pi-session-profiles", "owned"],
    ]);
    await overrideWith(f, "controller v2");
    expectSkill(await f.run("apply"), "skill_updated", "ok");
    const pending = puts[4]!;
    expect(pending).toMatchObject({ phase: "pending", replaces: installed.fingerprint });
    expect(pending.fingerprint).toMatch(SKILL_TREE_FINGERPRINT_PATTERN);
    expect((await f.ownership.get(ownedTarget))?.fingerprint).toBe((await readSkillTree(slot)).fingerprint);
    expectSkill(await f.run("remove"), "skill_removed", "ok");
    expect(existsSync(slot)).toBe(false); expect(await f.ownership.get(ownedTarget)).toBeUndefined();
  });
});

describe("records that 0.8.0 wrote with version 1 values", () => {
  it("uses colliding trees that really share the version 1 value but not the version 2 value", async () => {
    const shared = [{ path: "SKILL.md", bytes: Buffer.from("s") }];
    const a = [...shared, { path: "assets/a.bin", bytes: Buffer.from("X\0assets/b.bin\0Y") }];
    const b = [...shared, { path: "assets/a.bin", bytes: Buffer.from("X") }, { path: "assets/b.bin", bytes: Buffer.from("Y") }];
    expect(legacySkillTreeFingerprint(a)).toBe(legacySkillTreeFingerprint(b));
  });

  it("migrates the record of a slot that equals the current library tree, and a later remove works", async () => {
    const f = await fixture(); const slot = f.slot(target);
    await f.run("apply");
    const tree = await readSkillTree(slot);
    const legacy = await writeLegacy(f, { fingerprint: tree.legacyFingerprint });
    expectSkill(await f.run("dry-run"), "skill_equivalent", "unchanged");
    expect(await f.ownership.get(ownedTarget)).toEqual(legacy);
    expectSkill(await f.run("apply"), "skill_already_equivalent", "unchanged");
    expect(await f.ownership.get(ownedTarget)).toEqual({ ...legacy, phase: "owned", fingerprint: tree.fingerprint });
    await writeLegacy(f, { fingerprint: tree.legacyFingerprint });
    expectSkill(await f.run("remove"), "skill_removed", "ok");
    expect(existsSync(slot)).toBe(false); expect(await f.ownership.get(ownedTarget)).toBeUndefined();
  });

  it("proves a slot against an injected released tree, migrates, then updates", async () => {
    const f0 = await fixture(); await f0.run("apply");
    const old = await readSkillTree(f0.slot(target));
    const f = await fixture(false, { released: released(old) });
    await f.run("apply"); await overrideWith(f, "controller v2");
    await writeLegacy(f, { fingerprint: old.legacyFingerprint });
    expectSkill(await f.run("dry-run"), "skill_update_planned", "planned");
    expectSkill(await f.run("apply"), "skill_updated", "ok");
    expect(await readFile(join(f.slot(target), "SKILL.md"), "utf8")).toBe("controller v2");
    const record = (await f.ownership.get(ownedTarget))!;
    expect(record).toMatchObject({ phase: "owned", fingerprint: (await readSkillTree(f.slot(target))).fingerprint });
    expect(await readdir(join(f.slot(target), ".."))).toEqual([skill, "pi-session-profiles"]);
  });

  it("migrates a pending 0.8.0 record whose replaced copy a released tree proves", async () => {
    const f0 = await fixture(); await f0.run("apply");
    const old = await readSkillTree(f0.slot(target));
    const f = await fixture(false, { released: released(old) });
    await f.run("apply"); await overrideWith(f, "controller v2");
    await writeLegacy(f, { phase: "pending", fingerprint: "b".repeat(64), replaces: old.legacyFingerprint });
    expectSkill(await f.run("apply"), "skill_updated", "ok");
    expect((await f.ownership.get(ownedTarget))?.phase).toBe("owned");
  });

  it("removes a slot that a released tree proves", async () => {
    const f0 = await fixture(); await f0.run("apply");
    const old = await readSkillTree(f0.slot(target));
    const f = await fixture(false, { released: released(old) });
    await f.run("apply"); await overrideWith(f, "controller v2");
    await writeLegacy(f, { fingerprint: old.legacyFingerprint });
    expectSkill(await f.run("remove"), "skill_removed", "ok");
    expect(existsSync(f.slot(target))).toBe(false); expect(await f.ownership.get(ownedTarget)).toBeUndefined();
  });

  it("does not trust a legacy value that no reference proves", async () => {
    const f0 = await fixture(); await f0.run("apply");
    const old = await readSkillTree(f0.slot(target));
    const f = await fixture(); await f.run("apply"); await overrideWith(f, "controller v2");
    const legacy = await writeLegacy(f, { fingerprint: old.legacyFingerprint });
    for (const operation of ["dry-run", "apply", "remove", "rollback"] as const) {
      expectSkill(await f.run(operation), "skill_legacy_unverified", "divergent");
      expect(await readFile(join(f.slot(target), "SKILL.md"), "utf8")).toBe("controller v1");
      expect(await f.ownership.get(ownedTarget)).toEqual(legacy);
    }
  });

  describe.each(["dry-run", "apply", "remove", "rollback"] as const)("a colliding modified copy during %s", (operation) => {
    it("is unverified and leaves files and record unchanged", async () => {
      const f = await fixture(); const slot = f.slot(target);
      await mkdir(join(f.source, "assets"));
      await writeFile(join(f.source, "assets", "a.bin"), Buffer.from("X\0assets/b.bin\0Y"));
      await f.run("apply");
      const tree = await readSkillTree(slot);
      const legacy = await writeLegacy(f, { fingerprint: tree.legacyFingerprint });
      await rm(join(slot, "assets", "a.bin"));
      await writeFile(join(slot, "assets", "a.bin"), "X"); await writeFile(join(slot, "assets", "b.bin"), "Y");
      expect(legacySkillTreeFingerprint((await readSkillTree(slot)).files)).toBe(tree.legacyFingerprint);
      const output = await f.run(operation);
      expectSkill(output, "skill_legacy_unverified", "divergent");
      expect(output.exitCode).toBe(1);
      expect(JSON.stringify(output)).not.toContain(f.root);
      expect(await readFile(join(slot, "assets", "a.bin"), "utf8")).toBe("X");
      expect(await readFile(join(slot, "assets", "b.bin"), "utf8")).toBe("Y");
      expect(await f.ownership.get(ownedTarget)).toEqual(legacy);
    });
  });

  it("installs over an absent slot and replaces the legacy record; remove then deletes it", async () => {
    const f = await fixture(); const slot = f.slot(target);
    await writeLegacy(f, { fingerprint: "c".repeat(64) });
    expectSkill(await f.run("dry-run"), "skill_absent", "absent");
    expectSkill(await f.run("apply"), "skill_installed", "ok");
    const record = (await f.ownership.get(ownedTarget))!;
    expect(record).toMatchObject({ phase: "owned", fingerprint: (await readSkillTree(slot)).fingerprint });
    expect(record.fingerprint).toMatch(SKILL_TREE_FINGERPRINT_PATTERN);
    expectSkill(await f.run("remove"), "skill_removed", "ok");
    expect(existsSync(slot)).toBe(false); expect(await f.ownership.get(ownedTarget)).toBeUndefined();
  });

  it.each(["remove", "rollback"] as const)("%s deletes a legacy record whose slot is absent", async (operation) => {
    const f = await fixture();
    await writeLegacy(f, { fingerprint: "c".repeat(64) });
    expectSkill(await f.run(operation), "skill_absent", "ok");
    expect(await f.ownership.get(ownedTarget)).toBeUndefined();
  });
});

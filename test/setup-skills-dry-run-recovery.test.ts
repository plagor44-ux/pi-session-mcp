import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { OwnershipRecord } from "../src/setup-ownership.js";
import type { SkillCheckpoint } from "../src/setup-skills.js";
import { readSkillTree } from "../src/skill-library.js";
import { expectSkill, fixture, skill, skillTarget, targets } from "./fixtures/setup-skills-fixture.js";
import { removeTemporaryRoots } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

const owned = skillTarget(targets[0]!);
const V1 = { "SKILL.md": "controller v1", "references/guide.md": "guide" };
const V2 = { "SKILL.md": "controller v2", "references/guide.md": "guide v2" };

/**
 * The state of a pending version 2 transaction. Both builders script it: `scripted` stops a real update
 * through the checkpoint seam, `recorded` persists the pending record like an interrupted update would.
 * Neither is a real OS crash.
 */
async function build(stopAt?: SkillCheckpoint) {
  let armed = false;
  const f = await fixture(false, { checkpoint: (step: SkillCheckpoint) => { if (armed && step === stopAt) { armed = false; throw new Error("scripted interruption"); } } });
  expectSkill(await f.run("apply"), "skill_installed", "ok");
  const slot = f.slot(targets[0]!); const parent = dirname(slot);
  const v1 = await readSkillTree(slot);
  await mkdir(join(f.override, "references"), { recursive: true });
  await writeFile(join(f.override, "SKILL.md"), V2["SKILL.md"]); await writeFile(join(f.override, "references", "guide.md"), V2["references/guide.md"]);
  const v2 = await readSkillTree(f.override);
  let id: string;
  if (stopAt) {
    armed = true;
    expectSkill(await f.run("apply"), "skill_install_failed", "failed");
    id = (await f.ownership.get(owned))!.transactionId;
  } else {
    id = randomUUID();
    await f.ownership.put({ target: owned, fingerprint: v2.fingerprint, previous: "absent", phase: "pending", transactionId: id, replaces: v1.fingerprint });
  }
  expect(await f.ownership.get(owned)).toMatchObject({ phase: "pending", fingerprint: v2.fingerprint, replaces: v1.fingerprint });
  const path = (kind: "staging" | "backup" | "trash"): string => join(parent, `.pi-session-mcp-${skill}-${id}.${kind}`);
  return { f, slot, parent, id, v1, v2, path, marker: `operator-marker-${randomUUID()}` };
}
type Pending = Awaited<ReturnType<typeof build>>;
const scripted = (stopAt: "trash-renamed" | "trash-entry-removed" | "backup-renamed" | "installed"): Promise<Pending> => build(stopAt);
const recorded = (): Promise<Pending> => build();

const put = async (path: string, files: Record<string, string>): Promise<void> => {
  for (const [name, content] of Object.entries(files)) { await mkdir(dirname(join(path, name)), { recursive: true }); await writeFile(join(path, name), content); }
};
/** Names, bytes and link targets of everything below a directory; a link is never followed. */
const snapshot = async (path: string): Promise<string> =>
  JSON.stringify(await Promise.all((await readdir(path, { recursive: true })).sort().map(async (entry) => {
    const info = await lstat(join(path, entry));
    return [entry, info.isSymbolicLink() ? { link: await readlink(join(path, entry)) } : info.isFile() ? await readFile(join(path, entry), "utf8") : null];
  })));

/**
 * A dry-run reports what apply would do and never writes: the finding, the overall result, the parent of
 * the slot and the pending record. The report carries neither a path nor a marker from a file.
 */
async function dryRun(x: Pending, code: string, status: "planned" | "divergent"): Promise<void> {
  const before = await snapshot(x.parent); const record = await x.f.ownership.get(owned);
  expect(record).toMatchObject({ phase: "pending" });
  const output = await x.f.run("dry-run");
  expectSkill(output, code, status);
  if (status === "divergent") expect(output.status).toBe("failed"); else expect(output.status).not.toBe("failed");
  expect(output.exitCode).toBe(status === "divergent" ? 1 : 0);
  expect(await snapshot(x.parent)).toBe(before);
  expect(await x.f.ownership.get(owned)).toEqual(record);
  const report = JSON.stringify(output);
  expect(report).not.toContain(x.f.root); expect(report).not.toContain(x.marker);
}
/** The apply that follows a retained dry-run retains as well, and changes nothing. */
async function applyRetains(x: Pending): Promise<void> {
  const record = await x.f.ownership.get(owned);
  const output = await x.f.run("apply");
  expectSkill(output, "skill_recovery_retained", "divergent");
  expect(output.status).toBe("failed"); expect(output.exitCode).toBe(1);
  expect(await x.f.ownership.get(owned)).toEqual(record);
  expect(JSON.stringify(output)).not.toContain(x.f.root);
}

describe("a dry-run predicts that apply retains an intermediate of a pending transaction", () => {
  const retained: [string, () => Promise<Pending>, (x: Pending) => Promise<void>][] = [
    ["a trash with an added regular file", () => scripted("trash-renamed"), async (x) => { await writeFile(join(x.path("trash"), "operator-notes.txt"), x.marker); }],
    ["a trash with modified SKILL.md", () => scripted("trash-renamed"), async (x) => { await writeFile(join(x.path("trash"), "SKILL.md"), `controller v1 ${x.marker}`); }],
    ["a partial trash from an interrupted deletion", () => scripted("trash-entry-removed"), async (x) => { expect(await readdir(x.path("trash"))).toHaveLength(1); }],
    ["a partial trash with one entry removed", () => scripted("trash-renamed"), async (x) => { await rm(join(x.path("trash"), "references"), { recursive: true }); }],
    ["an empty trash directory", () => scripted("trash-renamed"), async (x) => { for (const entry of await readdir(x.path("trash"))) await rm(join(x.path("trash"), entry), { recursive: true }); }],
    ["a trash while the record names no replaced copy", () => scripted("trash-renamed"), async (x) => {
      const record: OwnershipRecord = { target: owned, fingerprint: x.v2.fingerprint, previous: "absent", phase: "pending", transactionId: x.id };
      await x.f.ownership.put(record);
    }],
    ["a backup with modified content", recorded, async (x) => { await put(x.path("backup"), { ...V1, "SKILL.md": `operator edit ${x.marker}` }); }],
    ["a backup with modified content and an empty slot", recorded, async (x) => {
      await put(x.path("backup"), { ...V1, "SKILL.md": `operator edit ${x.marker}` }); await rm(x.slot, { recursive: true });
    }],
    ["a staging directory with modified content", recorded, async (x) => { await put(x.path("staging"), { ...V2, "SKILL.md": `controller v2 plus ${x.marker}` }); }],
    ["a staging directory with a file outside the target tree", recorded, async (x) => { await put(x.path("staging"), { "SKILL.md": "controller", "notes.md": x.marker }); }],
    ["a staging directory with a hidden entry", recorded, async (x) => { await put(x.path("staging"), { "SKILL.md": "controller", ".hidden": x.marker }); }],
    ["a staging directory with a link", recorded, async (x) => { await put(x.path("staging"), { "SKILL.md": "controller" }); await symlink(x.slot, join(x.path("staging"), "references")); }],
    ["a staging directory that is a link", recorded, async (x) => { await symlink(x.slot, x.path("staging")); }],
    ["a staging directory that is a regular file", recorded, async (x) => { await writeFile(x.path("staging"), x.marker); }],
  ];

  it.each(retained)("reports skill_recovery_retained for %s and apply retains it", async (_label, state, mutate) => {
    const x = await state();
    await mutate(x);
    await dryRun(x, "skill_recovery_retained", "divergent");
    await applyRetains(x);
  });
});

describe("a dry-run keeps announcing the recovery apply can settle", () => {
  const settleable: [string, () => Promise<Pending>, (x: Pending) => Promise<void>, string][] = [
    ["a complete unchanged own trash", () => scripted("trash-renamed"), async (x) => { expect((await readSkillTree(x.path("trash"))).fingerprint).toBe(x.v1.fingerprint); }, "skill_recovered"],
    ["a complete staging directory beside the replaced copy", recorded, async (x) => { await put(x.path("staging"), V2); }, "skill_updated"],
    ["a complete staging directory with an empty slot", recorded, async (x) => { await put(x.path("staging"), V2); await rm(x.slot, { recursive: true }); }, "skill_recovered"],
    ["a prefix-consistent partial staging directory", recorded, async (x) => { await put(x.path("staging"), { "SKILL.md": "controller", "references/guide.md": "" }); }, "skill_updated"],
    ["a partial staging directory with only an empty directory", recorded, async (x) => { await mkdir(join(x.path("staging"), "references"), { recursive: true }); }, "skill_updated"],
    ["a backup equal to the replaced copy with an empty slot", recorded, async (x) => { await put(x.path("backup"), V1); await rm(x.slot, { recursive: true }); }, "skill_updated"],
    ["a backup equal to the replaced copy beside the installed target", () => scripted("installed"), async (x) => { expect((await readSkillTree(x.path("backup"))).fingerprint).toBe(x.v1.fingerprint); }, "skill_recovered"],
    ["a backup and a complete staging directory with an empty slot", () => scripted("backup-renamed"), async (x) => { expect(await existsSlot(x)).toBe(false); }, "skill_recovered"],
    ["a pending record with the target installed and no intermediates", recorded, async (x) => {
      await rm(x.slot, { recursive: true }); await put(x.slot, V2);
      expect(await readdir(x.parent)).toEqual([skill, "pi-session-profiles"]);
    }, "skill_recovered"],
  ];
  const existsSlot = (x: Pending): Promise<boolean> => lstat(x.slot).then(() => true, () => false);

  it.each(settleable)("reports skill_recovery_planned for %s and apply settles it", async (_label, state, mutate, code) => {
    const x = await state();
    await mutate(x);
    await dryRun(x, "skill_recovery_planned", "planned");
    const output = await x.f.run("apply");
    expectSkill(output, code, "ok");
    expect(output.exitCode).toBe(0);
    expect(await readdir(x.parent)).toEqual([skill, "pi-session-profiles"]);
    expect(await x.f.ownership.get(owned)).toMatchObject({ phase: "owned" });
    expect(JSON.stringify(output)).not.toContain(x.f.root);
  });
});

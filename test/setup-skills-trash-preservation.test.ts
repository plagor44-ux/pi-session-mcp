import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { OwnershipRecord } from "../src/setup-ownership.js";
import type { SkillCheckpoint } from "../src/setup-skills.js";
import { readSkillTree } from "../src/skill-library.js";
import { afterProfilesCleanup, expectSkill, fixture, skill, skillTarget, targets } from "./fixtures/setup-skills-fixture.js";
import { removeTemporaryRoots } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

const operations = ["apply", "remove", "rollback"] as const;
type Operation = (typeof operations)[number];
const owned = skillTarget(targets[0]!);

/**
 * Installs version 1, makes version 2 the library tree and stops the update right after the backup
 * became the transaction's trash. This is a scripted interruption through the checkpoint seam, not
 * a real OS crash: the pending record, the version 2 slot and the complete version 1 trash remain.
 */
async function interrupted() {
  let armed = false;
  const f = await fixture(false, { checkpoint: (step: SkillCheckpoint) => { if (armed && step === "trash-renamed") { armed = false; throw new Error("scripted interruption"); } } });
  expectSkill(await f.run("apply"), "skill_installed", "ok");
  await mkdir(join(f.override, "references"), { recursive: true });
  await writeFile(join(f.override, "SKILL.md"), "controller v2"); await writeFile(join(f.override, "references", "guide.md"), "guide v2");
  const v2 = await readSkillTree(f.override);
  armed = true;
  expectSkill(await f.run("apply"), "skill_install_failed", "failed");
  const slot = f.slot(targets[0]!); const parent = dirname(slot);
  const record = (await f.ownership.get(owned))!;
  const id = record.transactionId;
  const trash = join(parent, `.pi-session-mcp-${skill}-${id}.trash`);
  const v1 = await readSkillTree(trash);
  expect(record).toMatchObject({ phase: "pending", fingerprint: v2.fingerprint, replaces: v1.fingerprint });
  expect(existsSync(trash)).toBe(true); expect(await readFile(join(slot, "SKILL.md"), "utf8")).toBe("controller v2");
  return { f, slot, parent, trash, id, record: structuredClone(record), v1, v2, marker: `operator-marker-${randomUUID()}` };
}
type Interrupted = Awaited<ReturnType<typeof interrupted>>;

/** Names and bytes of everything below a directory; directories read as null. */
const snapshot = async (path: string): Promise<string> =>
  JSON.stringify(await Promise.all((await readdir(path, { recursive: true })).sort().map(async (entry) => [entry, await readFile(join(path, entry), "utf8").catch(() => null)])));
const put = async (path: string, files: Record<string, string>): Promise<void> => {
  for (const [name, content] of Object.entries(files)) { await mkdir(dirname(join(path, name)), { recursive: true }); await writeFile(join(path, name), content); }
};
const V1_FILES = { "SKILL.md": "controller v1", "references/guide.md": "guide" };

/** The operation's outcome for setup's own, fully verified trash: it is deleted and the update settles. */
async function expectSettled(x: Interrupted, operation: Operation): Promise<void> {
  const output = await x.f.run(operation);
  expect(JSON.stringify(output)).not.toContain(x.f.root);
  expect(existsSync(x.trash)).toBe(false);
  if (operation === "apply") {
    expectSkill(output, "skill_recovered", "ok");
    expect(await x.f.ownership.get(owned)).toMatchObject({ phase: "owned", fingerprint: x.v2.fingerprint });
    expect("replaces" in (await x.f.ownership.get(owned))!).toBe(false);
    expect((await readSkillTree(x.slot)).fingerprint).toBe(x.v2.fingerprint);
    expect(await readdir(x.parent)).toEqual([skill, "pi-session-profiles"]);
    return;
  }
  expect(output.findings[0]).toMatchObject({ code: operation === "remove" ? "removed" : "rolled_back", status: "ok" });
  expectSkill(output, "skill_removed", "ok");
  expect(await x.f.ownership.get(owned)).toBeUndefined();
  expect(existsSync(x.slot)).toBe(false); expect(await readdir(x.parent)).toEqual([]);
}

/** The operation's outcome when the trash cannot be proven to be the replaced copy: nothing changes. */
async function expectRetained(x: Interrupted, operation: Operation): Promise<void> {
  const before = await snapshot(x.parent);
  const output = await x.f.run(operation);
  expectSkill(output, "skill_recovery_retained", "divergent");
  expect(output.status).toBe("failed"); expect(output.exitCode).toBe(1);
  if (operation !== "apply") expect(output.findings[0]).toMatchObject({ code: operation === "remove" ? "removed" : "rolled_back", status: "ok" });
  expect(await snapshot(x.parent)).toBe(operation === "apply" ? before : afterProfilesCleanup(before));
  expect(output.findings[2]).toMatchObject({ target: { alias: "pi-session-profiles" }, code: operation === "apply" ? "skill_already_equivalent" : "skill_removed" });
  expect(existsSync(x.trash)).toBe(true);
  expect(await x.f.ownership.get(owned)).toEqual(x.record);
  const report = JSON.stringify(output);
  expect(report).not.toContain(x.f.root); expect(report).not.toContain(x.marker);
}

describe("recovery deletes the transaction's trash only when it is the complete replaced copy", () => {
  const retained: [string, (x: Interrupted) => Promise<void>][] = [
    ["a new operator file", async (x) => { await writeFile(join(x.trash, "operator-notes.txt"), x.marker); }],
    ["modified SKILL.md", async (x) => { await writeFile(join(x.trash, "SKILL.md"), `controller v1 ${x.marker}`); }],
    ["modified references/guide.md", async (x) => { await writeFile(join(x.trash, "references", "guide.md"), `guide ${x.marker}`); }],
    ["a missing references directory", async (x) => { await rm(join(x.trash, "references"), { recursive: true }); }],
    ["a missing SKILL.md", async (x) => { await rm(join(x.trash, "SKILL.md")); }],
    ["no entries at all", async (x) => { for (const entry of await readdir(x.trash)) await rm(join(x.trash, entry), { recursive: true }); }],
  ];

  it.each(retained.flatMap(([label, mutate]) => operations.map((operation) => [label, operation, mutate] as const)))(
    "retains a trash with %s during %s", async (_label, operation, mutate) => {
      const x = await interrupted();
      await mutate(x);
      expect(await readdir(x.parent)).toContain(`.pi-session-mcp-${skill}-${x.id}.trash`);
      await expectRetained(x, operation);
    });

  it.each(operations)("keeps the operator's file byte for byte in the retained trash during %s", async (operation) => {
    const x = await interrupted();
    await writeFile(join(x.trash, "operator-notes.txt"), x.marker);
    await expectRetained(x, operation);
    expect(await readFile(join(x.trash, "operator-notes.txt"), "utf8")).toBe(x.marker);
    expect(await readFile(join(x.trash, "SKILL.md"), "utf8")).toBe("controller v1");
    expect(await readFile(join(x.trash, "references", "guide.md"), "utf8")).toBe("guide");
  });

  it.each(operations)("deletes the complete unchanged trash and settles during %s", async (operation) => {
    const x = await interrupted();
    expect((await readSkillTree(x.trash)).fingerprint).toBe(x.record.replaces);
    await expectSettled(x, operation);
  });

  it.each(operations)("retains a trash that matches a pending record without a replaced fingerprint during %s", async (operation) => {
    const x = await interrupted();
    // A record that names no replaced copy has no reference to verify the trash against, even if its bytes look like version 1.
    const id = randomUUID();
    const unknown: OwnershipRecord = { target: owned, fingerprint: x.v2.fingerprint, previous: "absent", phase: "pending", transactionId: id };
    await x.f.ownership.put(unknown);
    await rm(x.trash, { recursive: true });
    const trash = join(x.parent, `.pi-session-mcp-${skill}-${id}.trash`);
    await put(trash, V1_FILES);
    expect(existsSync(join(x.parent, `.pi-session-mcp-${skill}-${x.id}.trash`))).toBe(false);
    const before = await snapshot(x.parent);
    const output = await x.f.run(operation);
    expectSkill(output, "skill_recovery_retained", "divergent");
    expect(output.status).toBe("failed"); expect(output.exitCode).toBe(1);
    expect(await snapshot(x.parent)).toBe(operation === "apply" ? before : afterProfilesCleanup(before));
    expect(output.findings[2]).toMatchObject({ target: { alias: "pi-session-profiles" }, code: operation === "apply" ? "skill_already_equivalent" : "skill_removed" });
    expect(existsSync(trash)).toBe(true); expect(await readFile(join(x.slot, "SKILL.md"), "utf8")).toBe("controller v2");
    expect(await x.f.ownership.get(owned)).toEqual(unknown);
    expect(JSON.stringify(output)).not.toContain(x.f.root);
  });

  it.each(operations)("never touches a trash of another transaction while its own transaction proceeds during %s", async (operation) => {
    const x = await interrupted();
    const foreign = join(x.parent, `.pi-session-mcp-${skill}-${randomUUID()}.trash`);
    await put(foreign, { ...V1_FILES, "operator-notes.txt": x.marker });
    const bystander = await snapshot(foreign);
    await expectSettledBesides(x, operation, foreign);
    expect(await snapshot(foreign)).toBe(bystander);
    expect(await readFile(join(foreign, "operator-notes.txt"), "utf8")).toBe(x.marker);
  });
});

/** Like `expectSettled`, but the parent legitimately keeps the named bystander directory. */
async function expectSettledBesides(x: Interrupted, operation: Operation, bystander: string): Promise<void> {
  const name = bystander.slice(x.parent.length + 1);
  const output = await x.f.run(operation);
  expect(JSON.stringify(output)).not.toContain(x.f.root); expect(JSON.stringify(output)).not.toContain(x.marker);
  expect(existsSync(x.trash)).toBe(false);
  if (operation === "apply") {
    expectSkill(output, "skill_recovered", "ok");
    expect(await x.f.ownership.get(owned)).toMatchObject({ phase: "owned", fingerprint: x.v2.fingerprint });
    expect((await readSkillTree(x.slot)).fingerprint).toBe(x.v2.fingerprint);
    expect((await readdir(x.parent)).sort()).toEqual([name, skill, "pi-session-profiles"].sort());
    return;
  }
  expect(output.findings[0]).toMatchObject({ code: operation === "remove" ? "removed" : "rolled_back", status: "ok" });
  expectSkill(output, "skill_removed", "ok");
  expect(await x.f.ownership.get(owned)).toBeUndefined();
  expect(await readdir(x.parent)).toEqual([name]);
}

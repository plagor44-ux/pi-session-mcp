import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DurableOwnershipStore, type OwnershipRecord } from "../src/setup-ownership.js";
import { currentSetupPlatform } from "../src/setup-platform.js";
import { FileSetupSkillInstaller, type SkillCheckpoint } from "../src/setup-skills.js";
import type { SetupFinding, SetupOperation, SetupTarget } from "../src/setup-result.js";
import { readSkillTree, SKILL_TREE_FINGERPRINT_PATTERN } from "../src/skill-library.js";
import { compileServerEntry } from "./compiled-entry.js";
import { expectSkill, fixture, skill, skillTarget, targets } from "./fixtures/setup-skills-fixture.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

const CHILD = fileURLToPath(new URL("./fixtures/skill-crash-child.mjs", import.meta.url));
const registration: SetupTarget = { client: "codex", scope: "user", alias: "pi-session-mcp" };
const ownedTarget = skillTarget(registration);

describe.skipIf(process.platform !== "linux" || !currentSetupPlatform())("recovery after a SIGKILLed update", () => {
  let compiled: string;
  beforeAll(async () => { compiled = dirname(await compileServerEntry()); }, 180_000);

  /** Installs version 1, makes version 2 the library tree, and kills a child applying it at `stopAt`. */
  async function crashAt(stopAt: SkillCheckpoint) {
    const root = await temporaryRoot("pi-skill-crash-");
    const home = join(root, "home"); const cwd = join(root, "project"); const packageRoot = join(root, "package");
    const configPath = join(root, "config", "config.json"); const ownershipPath = join(root, "state", "ownership.json");
    const source = join(packageRoot, "skills", skill); const override = join(root, "config", "skills", skill);
    for (const directory of [home, cwd, join(source, "references"), join(override, "references")]) await mkdir(directory, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "controller v1"); await writeFile(join(source, "references", "guide.md"), "guide v1");
    const roots = { packageRoot, configPath, home, cwd };
    const store = new DurableOwnershipStore(ownershipPath);
    const run = (operation: SetupOperation, installer = new FileSetupSkillInstaller(roots)): Promise<readonly SetupFinding[]> =>
      store.transaction((access) => installer.run(operation, registration, access));
    expect((await run("apply"))[0]).toMatchObject({ code: "skill_installed" });
    const v1 = await readSkillTree(join(home, ".agents", "skills", skill));
    await writeFile(join(override, "SKILL.md"), "controller v2"); await writeFile(join(override, "references", "guide.md"), "guide v2");

    const child = spawn(process.execPath, [CHILD, JSON.stringify({ out: compiled, ...roots, ownershipPath, stopAt })], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    const reached = new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk) => { stdout += String(chunk); if (stdout.includes(`checkpoint:${stopAt}\n`)) resolve(); });
      void exited.then(() => reject(new Error(`child ended before ${stopAt}: ${stdout} ${stderr}`)));
    });
    try { await reached; } catch (error) { child.kill("SIGKILL"); throw error; }
    child.kill("SIGKILL");
    expect(await exited).toEqual({ code: null, signal: "SIGKILL" });

    const parent = join(home, ".agents", "skills"); const slot = join(parent, skill);
    const record = (await store.get(ownedTarget))!;
    const base = join(parent, `.pi-session-mcp-${skill}-${record.transactionId}`);
    return {
      root, store, run, roots, v1, record, parent, slot, source, override,
      staging: `${base}.staging`, backup: `${base}.backup`, trash: `${base}.trash`,
      entries: () => readdir(parent).then((names) => names.sort()),
      text: (path: string) => readFile(join(path, "SKILL.md"), "utf8"),
    };
  }
  const finalState = async (c: Awaited<ReturnType<typeof crashAt>>, content: string): Promise<void> => {
    expect(await c.text(c.slot)).toBe(content);
    expect(await c.entries()).toEqual([skill]);
    const record = (await c.store.get(ownedTarget))!;
    expect(record).toMatchObject({ phase: "owned", fingerprint: (await readSkillTree(c.slot)).fingerprint });
    expect(record.fingerprint).toMatch(SKILL_TREE_FINGERPRINT_PATTERN);
    expect("replaces" in record).toBe(false);
  };
  const removedState = async (c: Awaited<ReturnType<typeof crashAt>>): Promise<void> => {
    expect(await c.entries()).toEqual([]);
    expect(await c.store.get(ownedTarget)).toBeUndefined();
  };

  it("after the staging directory was filled: keeps the old copy, deletes the staging, and updates", async () => {
    const c = await crashAt("staged");
    expect(c.record).toMatchObject({ phase: "pending", replaces: c.v1.fingerprint });
    expect(await c.text(c.slot)).toBe("controller v1"); expect(await c.text(c.staging)).toBe("controller v2");
    expect(existsSync(c.backup)).toBe(false); expect(existsSync(c.trash)).toBe(false);
    expect((await c.run("apply"))[0]).toMatchObject({ code: "skill_updated", status: "ok" });
    await finalState(c, "controller v2");
    expect((await c.run("remove"))[0]).toMatchObject({ code: "skill_removed", status: "ok" });
    await removedState(c);
  }, 60_000);

  it("after the backup rename: finishes forward from the complete staging directory", async () => {
    const c = await crashAt("backup-renamed");
    expect(c.record).toMatchObject({ phase: "pending", replaces: c.v1.fingerprint });
    expect(existsSync(c.slot)).toBe(false);
    expect(await c.text(c.backup)).toBe("controller v1"); expect(await c.text(c.staging)).toBe("controller v2");
    expect((await c.run("apply"))[0]).toMatchObject({ code: "skill_recovered", status: "ok" });
    await finalState(c, "controller v2");
    expect((await c.run("remove"))[0]).toMatchObject({ code: "skill_removed", status: "ok" });
    await removedState(c);
  }, 60_000);

  it.each(["remove", "rollback"] as const)("after the backup rename: %s deletes every verified intermediate and the record", async (operation) => {
    const c = await crashAt("backup-renamed");
    expect(existsSync(c.slot)).toBe(false); expect(existsSync(c.backup)).toBe(true); expect(existsSync(c.staging)).toBe(true);
    expect((await c.run(operation))[0]).toMatchObject({ code: "skill_absent", status: "ok" });
    await removedState(c);
  }, 60_000);

  it("after the backup rename with an unusable staging directory: moves the backup back and updates again", async () => {
    const c = await crashAt("backup-renamed");
    await writeFile(join(c.staging, "SKILL.md"), "controller");
    await rm(join(c.staging, "references"), { recursive: true });
    expect((await c.run("apply"))[0]).toMatchObject({ code: "skill_updated", status: "ok" });
    await finalState(c, "controller v2");
  }, 60_000);

  it("after the new copy was installed: verifies and deletes the backup", async () => {
    const c = await crashAt("installed");
    expect(await c.text(c.slot)).toBe("controller v2"); expect(await c.text(c.backup)).toBe("controller v1");
    expect(c.record.phase).toBe("pending");
    expect((await c.run("apply"))[0]).toMatchObject({ code: "skill_recovered", status: "ok" });
    await finalState(c, "controller v2");
    expect((await c.run("remove"))[0]).toMatchObject({ code: "skill_removed", status: "ok" });
    await removedState(c);
  }, 60_000);

  it("after the backup was renamed to trash: deletes the trash", async () => {
    const c = await crashAt("trash-renamed");
    expect(existsSync(c.trash)).toBe(true); expect(existsSync(c.backup)).toBe(false); expect(await c.text(c.slot)).toBe("controller v2");
    expect((await c.run("apply"))[0]).toMatchObject({ code: "skill_recovered", status: "ok" });
    await finalState(c, "controller v2");
  }, 60_000);

  /** The relative paths and bytes below a directory, for comparing a retained tree before and after. */
  const treeBytes = async (path: string): Promise<string> => JSON.stringify(await Promise.all((await readdir(path, { recursive: true })).sort().map(async (entry) => [entry, await readFile(join(path, entry), "utf8").catch(() => null)])));

  it.each(["apply", "remove", "rollback"] as const)("during trash deletion: %s retains the partial trash and changes nothing", async (operation) => {
    const c = await crashAt("trash-entry-removed");
    const left = await readdir(c.trash);
    expect(left).toHaveLength(1); // the old copy had two entries: SKILL.md and references
    const trash = await treeBytes(c.trash); const entries = await c.entries(); const before = await c.store.get(ownedTarget);
    expect(before).toMatchObject({ phase: "pending", replaces: c.v1.fingerprint });
    // The dry-run predicts the retention and changes nothing.
    expect((await c.run("dry-run"))[0]).toMatchObject({ code: "skill_recovery_retained", status: "divergent" });
    expect(await treeBytes(c.trash)).toBe(trash); expect(await c.entries()).toEqual(entries); expect(await c.store.get(ownedTarget)).toEqual(before);
    expect((await c.run(operation))[0]).toMatchObject({ code: "skill_recovery_retained", status: "divergent" });
    expect(await readdir(c.trash)).toEqual(left); expect(await treeBytes(c.trash)).toBe(trash);
    expect(await c.text(c.slot)).toBe("controller v2"); expect(await c.entries()).toEqual(entries);
    expect(await c.store.get(ownedTarget)).toEqual(before);
  }, 60_000);

  it("during trash deletion: apply settles after the operator deleted the retained trash", async () => {
    const c = await crashAt("trash-entry-removed");
    expect((await c.run("apply"))[0]).toMatchObject({ code: "skill_recovery_retained", status: "divergent" });
    await rm(c.trash, { recursive: true });
    expect((await c.run("apply"))[0]).toMatchObject({ code: "skill_recovered", status: "ok" });
    await finalState(c, "controller v2");
  }, 60_000);

  it("before the final ownership update: promotes the record", async () => {
    const c = await crashAt("before-ownership");
    expect(await c.entries()).toEqual([skill]);
    expect(await c.store.get(ownedTarget)).toMatchObject({ phase: "pending", replaces: c.v1.fingerprint });
    expect((await c.run("apply"))[0]).toMatchObject({ code: "skill_recovered", status: "ok" });
    await finalState(c, "controller v2");
    expect((await c.run("remove"))[0]).toMatchObject({ code: "skill_removed", status: "ok" });
    await removedState(c);
  }, 60_000);

  it.each(["apply", "remove", "rollback"] as const)("keeps a modified backup and reports it during %s", async (operation) => {
    const c = await crashAt("backup-renamed");
    await writeFile(join(c.backup, "SKILL.md"), "operator edit");
    const before = await c.store.get(ownedTarget);
    expect((await c.run("dry-run"))[0]).toMatchObject({ code: "skill_recovery_retained", status: "divergent" });
    expect(await c.text(c.backup)).toBe("operator edit"); expect(existsSync(c.slot)).toBe(false); expect(await c.store.get(ownedTarget)).toEqual(before);
    expect((await c.run(operation))[0]).toMatchObject({ code: "skill_recovery_retained", status: "divergent" });
    expect(await c.text(c.backup)).toBe("operator edit"); expect(await c.text(c.staging)).toBe("controller v2");
    expect(existsSync(c.slot)).toBe(false);
    expect(await c.store.get(ownedTarget)).toEqual(before);
  }, 60_000);

  it("keeps a partial trash that contains a link", async () => {
    const c = await crashAt("trash-entry-removed");
    await symlink(c.source, join(c.trash, "link"));
    const before = await c.store.get(ownedTarget);
    expect((await c.run("dry-run"))[0]).toMatchObject({ code: "skill_recovery_retained", status: "divergent" });
    expect(existsSync(c.trash)).toBe(true); expect(await c.store.get(ownedTarget)).toEqual(before);
    for (const operation of ["apply", "remove"] as const) {
      expect((await c.run(operation))[0]).toMatchObject({ code: "skill_recovery_retained", status: "divergent" });
      expect(existsSync(c.trash)).toBe(true); expect(await c.store.get(ownedTarget)).toEqual(before);
    }
  }, 60_000);
});

describe("recovery only deletes this transaction's verified directories", () => {
  const other = (): string => randomUUID();
  /** Installs version 1, makes version 2 the library tree and persists a pending record like an interrupted update. */
  async function interrupted() {
    const f = await fixture(); await f.run("apply"); const slot = f.slot(targets[0]!); const parent = join(slot, "..");
    const v1 = await readSkillTree(slot);
    await mkdir(join(f.override, "references"), { recursive: true });
    await writeFile(join(f.override, "SKILL.md"), "controller v2"); await writeFile(join(f.override, "references", "guide.md"), "guide v2");
    const v2 = await readSkillTree(f.override);
    const record: OwnershipRecord = { target: skillTarget(targets[0]!), fingerprint: v2.fingerprint, previous: "absent", phase: "pending", transactionId: randomUUID(), replaces: v1.fingerprint };
    await f.ownership.put(record);
    const name = (id: string, kind: string): string => join(parent, `.pi-session-mcp-${skill}-${id}.${kind}`);
    const put = async (path: string, content = "unrelated"): Promise<void> => { await mkdir(path, { recursive: true }); await writeFile(join(path, "SKILL.md"), content); };
    return { f, slot, parent, record, name, put, id: record.transactionId, v1, v2 };
  }
  const snapshot = async (path: string): Promise<string> => JSON.stringify(await Promise.all((await readdir(path, { recursive: true })).sort().map(async (entry) => [entry, await readFile(join(path, entry), "utf8").catch(() => null)])));

  it("never touches directories of another transaction, other kinds or the 0.8.0 random names", async () => {
    const x = await interrupted();
    const foreign = [x.name(other(), "staging"), x.name(other(), "backup"), x.name(other(), "trash"), join(x.parent, `.pi-session-mcp-${skill}-${other()}`), join(x.parent, `.pi-session-mcp-${skill}-${x.id}`), x.name(x.id, "other")];
    for (const path of foreign) await x.put(path);
    const before = await snapshot(x.parent);
    expectSkill(await x.f.run("apply"), "skill_updated", "ok");
    expect(await readFile(join(x.slot, "SKILL.md"), "utf8")).toBe("controller v2");
    for (const path of foreign) expect(await readFile(join(path, "SKILL.md"), "utf8")).toBe("unrelated");
    expect((await readdir(x.parent)).sort()).toEqual([...foreign.map((path) => path.slice(x.parent.length + 1)), skill].sort());
    expect(before).toContain("unrelated");
  });

  it("deletes the transaction's own complete and interrupted staging directories and nothing else", async () => {
    for (const interruptedWrite of [false, true]) {
      const x = await interrupted(); const staging = x.name(x.id, "staging");
      await mkdir(join(staging, "references"), { recursive: true });
      await writeFile(join(staging, "SKILL.md"), interruptedWrite ? "controller" : "controller v2");
      if (interruptedWrite) await writeFile(join(staging, "references", "guide.md"), "");
      else await writeFile(join(staging, "references", "guide.md"), "guide v2");
      const bystander = x.name(other(), "staging"); await x.put(bystander);
      expectSkill(await x.f.run("remove"), "skill_removed", "ok");
      expect(existsSync(staging)).toBe(false); expect(existsSync(x.slot)).toBe(false);
      expect(await readFile(join(bystander, "SKILL.md"), "utf8")).toBe("unrelated");
    }
  });

  it.each([
    ["modified content", async (x: Awaited<ReturnType<typeof interrupted>>, staging: string) => { await x.put(staging, "controller v2 plus operator edit"); }],
    ["a file outside the target tree", async (x: Awaited<ReturnType<typeof interrupted>>, staging: string) => { await x.put(staging, "controller"); await writeFile(join(staging, "notes.md"), ""); }],
    ["a hidden entry", async (x: Awaited<ReturnType<typeof interrupted>>, staging: string) => { await x.put(staging, "controller"); await writeFile(join(staging, ".hidden"), ""); }],
    ["a link", async (x: Awaited<ReturnType<typeof interrupted>>, staging: string) => { await x.put(staging, "controller"); await symlink(x.slot, join(staging, "references")); }],
    ["a link as the directory", async (x: Awaited<ReturnType<typeof interrupted>>, staging: string) => { await symlink(x.slot, staging); }],
    ["a regular file", async (_x: Awaited<ReturnType<typeof interrupted>>, staging: string) => { await writeFile(staging, "file"); }],
  ])("retains a staging directory with %s", async (_label, build) => {
    for (const operation of ["apply", "remove", "rollback"] as const) {
      const x = await interrupted(); const staging = x.name(x.id, "staging");
      await build(x, staging);
      const before = await snapshot(x.parent);
      const planned = await x.f.run("dry-run");
      expectSkill(planned, "skill_recovery_retained", "divergent");
      expect(JSON.stringify(planned)).not.toContain(x.f.root);
      expect(await snapshot(x.parent)).toBe(before);
      expect(await x.f.ownership.get(skillTarget(targets[0]!))).toEqual(x.record);
      const output = await x.f.run(operation);
      expectSkill(output, "skill_recovery_retained", "divergent");
      expect(JSON.stringify(output)).not.toContain(x.f.root);
      expect(await snapshot(x.parent)).toBe(before);
      expect(await x.f.ownership.get(skillTarget(targets[0]!))).toEqual(x.record);
    }
  });

  it("retains a backup that is not the replaced copy and a trash with hidden content", async () => {
    for (const kind of ["backup", "trash"] as const) {
      const x = await interrupted(); const path = x.name(x.id, kind);
      if (kind === "backup") await x.put(path, "operator edit"); else { await x.put(path, ""); await writeFile(join(path, ".hidden"), "keep"); }
      const before = await snapshot(x.parent);
      expectSkill(await x.f.run("dry-run"), "skill_recovery_retained", "divergent");
      expect(await snapshot(x.parent)).toBe(before);
      expect(await x.f.ownership.get(skillTarget(targets[0]!))).toEqual(x.record);
      expectSkill(await x.f.run("apply"), "skill_recovery_retained", "divergent");
      expect(await snapshot(x.parent)).toBe(before);
    }
  });

  it("plans the recovery of a pending version 2 transaction in a dry-run without writing", async () => {
    const x = await interrupted(); const staging = x.name(x.id, "staging"); await x.put(staging, "controller v2");
    const check = async (): Promise<void> => {
      const before = await snapshot(x.parent);
      const output = await x.f.run("dry-run");
      expectSkill(output, "skill_recovery_planned", "planned");
      expect(JSON.stringify(output)).not.toContain(x.f.root);
      expect(await snapshot(x.parent)).toBe(before);
      expect(await x.f.ownership.get(skillTarget(targets[0]!))).toEqual(x.record);
    };
    await check(); // the replaced copy is in the slot
    await rm(x.slot, { recursive: true }); await check(); // the slot is empty, like after the backup rename
    await mkdir(join(x.slot, "references"), { recursive: true });
    await writeFile(join(x.slot, "SKILL.md"), "controller v2"); await writeFile(join(x.slot, "references", "guide.md"), "guide v2");
    await check(); // the target is installed and only the record is pending
  });

  it("keeps the divergent code in a dry-run when the slot is foreign", async () => {
    const x = await interrupted();
    await writeFile(join(x.slot, "SKILL.md"), "operator edit");
    expectSkill(await x.f.run("dry-run"), "skill_divergent", "divergent");
  });

  it("reports skill_recovered only when apply settled the transaction without a further update", async () => {
    const x = await interrupted();
    await rm(x.slot, { recursive: true }); await mkdir(join(x.slot, "references"), { recursive: true });
    await writeFile(join(x.slot, "SKILL.md"), "controller v2"); await writeFile(join(x.slot, "references", "guide.md"), "guide v2");
    const staging = x.name(x.id, "staging"); await x.put(staging, "controller v2");
    await mkdir(join(staging, "references")); await writeFile(join(staging, "references", "guide.md"), "guide v2");
    expectSkill(await x.f.run("apply"), "skill_recovered", "ok");
    expect(existsSync(staging)).toBe(false);
    expect(await x.f.ownership.get(skillTarget(targets[0]!))).toMatchObject({ phase: "owned", fingerprint: x.v2.fingerprint });
    expectSkill(await x.f.run("apply"), "skill_already_equivalent", "unchanged");
  });

  it("keeps skill_updated when apply continues with a normal update after recovery", async () => {
    const x = await interrupted(); const staging = x.name(x.id, "staging"); await x.put(staging, "controller");
    expectSkill(await x.f.run("apply"), "skill_updated", "ok");
    expect(existsSync(staging)).toBe(false);
  });

  it("does not recover while the slot is neither empty nor one of setup's copies", async () => {
    const x = await interrupted(); const staging = x.name(x.id, "staging"); await x.put(staging, "controller v2");
    await writeFile(join(x.slot, "SKILL.md"), "operator edit");
    expectSkill(await x.f.run("apply"), "skill_divergent", "divergent");
    expectSkill(await x.f.run("remove"), "skill_divergent", "divergent");
    expect(await readFile(join(x.slot, "SKILL.md"), "utf8")).toBe("operator edit");
    expect(await readFile(join(staging, "SKILL.md"), "utf8")).toBe("controller v2");
  });
});

import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRecord } from "../src/setup-ownership.js";
import { MemoryOwnershipStore, type OwnershipRecord } from "../src/setup-ownership.js";
import { SetupOrchestrator, type SetupClientAdapter } from "../src/setup.js";
import type { SetupOperation, SetupTarget } from "../src/setup-result.js";
import { readSkillTree } from "../src/skill-library.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);
const skill = "pi-session-orchestration";
const fingerprint = "a".repeat(64);
const targets: SetupTarget[] = [
  { client: "codex", scope: "user", alias: "pi-session-mcp" },
  ...["user", "local", "project"].map((scope) => ({ client: "claude-code", scope, alias: "pi-session-mcp" })),
];
const skillTarget = (target: SetupTarget): SetupTarget => ({ ...target, scope: target.scope === "local" ? "user" : target.scope, alias: `skill:${skill}` });
async function fixture(linkedRoots = false) {
  const root = await temporaryRoot("pi-setup-skills-");
  const anchor = linkedRoots ? join(root, "alias") : root;
  if (linkedRoots) await symlink(root, anchor);
  const home = join(anchor, "home"); const cwd = join(anchor, "project"); const packageRoot = join(root, "package");
  const configPath = join(root, "config", "config.json");
  const source = join(packageRoot, "skills", skill); const override = join(root, "config", "skills", skill);
  await mkdir(source, { recursive: true }); await mkdir(home); await mkdir(cwd);
  await mkdir(join(source, "references"));
  await writeFile(join(source, "SKILL.md"), "controller v1"); await writeFile(join(source, "references", "guide.md"), "guide");
  const ownership = new MemoryOwnershipStore(); const registered = new Set<string>();
  const adapters: SetupClientAdapter[] = ["codex", "claude-code"].map((name) => ({
    name, supportedScopes: name === "codex" ? ["user"] : ["user", "local", "project"],
    async inspect(target) { return registered.has(`${target.client}:${target.scope}`) ? { state: "equivalent", fingerprint } : { state: "absent" }; },
    async apply(target) { registered.add(`${target.client}:${target.scope}`); },
    async remove(target) { registered.delete(`${target.client}:${target.scope}`); },
    async verify() { return { ok: true, code: "mcp_verified" }; },
  }));
  const { FileSetupSkillInstaller } = await import("../src/setup-skills.js");
  const skills = new FileSetupSkillInstaller({ packageRoot, configPath, home, cwd });
  const orchestrator = new SetupOrchestrator({ adapters, ownership, intendedFingerprint: fingerprint, skills });
  const slot = (target: SetupTarget) => join(target.scope === "project" ? cwd : home, target.client === "codex" ? ".agents" : ".claude", "skills", skill);
  const run = (operation: SetupOperation = "dry-run", selected: SetupTarget[] = [targets[0]!]) => orchestrator.run({ operation, targets: selected });
  return { root, home, cwd, source, override, ownership, registered, adapters, skills, orchestrator, slot, run };
}
function expectSkill(output: Awaited<ReturnType<SetupOrchestrator["run"]>>, code: string, status: string, target = targets[0]!) {
  expect(output.findings[1]).toEqual({ target: { ...target, alias: skill }, code, status });
}

describe("skill ownership validation", () => {
  it("accepts exactly registration and normalized skill records", () => {
    for (const target of targets) {
      const record = { target, fingerprint, previous: "absent", phase: "owned", transactionId: randomUUID() };
      expect(isRecord(record)).toBe(true);
      expect(isRecord({ ...record, target: skillTarget(target) })).toBe(true);
      expect(isRecord({ ...record, target: skillTarget(target), phase: "pending" })).toBe(true);
    }
    const record = { target: skillTarget(targets[0]!), fingerprint, previous: "absent", phase: "owned", transactionId: randomUUID() };
    for (const target of [
      { ...record.target, scope: "project" }, { ...record.target, scope: "local" },
      { ...record.target, client: "unknown" }, { ...record.target, alias: "skill:../escape" },
      { ...record.target, alias: "skill:Bad" }, { ...record.target, alias: "skill:" },
      { ...record.target, alias: `skill:${"a".repeat(65)}` },
      { ...skillTarget(targets[1]!), scope: "local" },
    ]) expect(isRecord({ ...record, target })).toBe(false);
    for (const change of [{ fingerprint: "path/secret" }, { previous: "equivalent" }, { phase: "bad" }, { transactionId: "bad" }, { path: "/secret" }]) expect(isRecord({ ...record, ...change })).toBe(false);
  });
});

describe("setup controller skills", () => {
  it.each(targets)("installs, verifies, reapplies and removes $client:$scope in its exact slot", async (target) => {
    const f = await fixture(); const slot = f.slot(target);
    const sentinel = join(slot, "..", "foreign-sentinel", "SKILL.md"); await mkdir(join(sentinel, ".."), { recursive: true }); await writeFile(sentinel, "foreign");
    expectSkill(await f.run(), "skill_absent", "absent");
    expect(existsSync(f.slot(targets[0]!))).toBe(false);
    expectSkill(await f.run("apply", [target]), "skill_installed", "ok", target);
    expect(await readFile(join(slot, "SKILL.md"), "utf8")).toBe("controller v1");
    expect(await readFile(join(slot, "references", "guide.md"), "utf8")).toBe("guide");
    expect((await f.ownership.get(skillTarget(target)))?.phase).toBe("owned");
    expect((await stat(slot)).mode & 0o777).toBe(0o755);
    expectSkill(await f.run("apply", [target]), "skill_already_equivalent", "unchanged", target);
    expectSkill(await f.run("verify", [target]), "skill_verified", "ok", target);
    expectSkill(await f.run("remove", [target]), "skill_removed", "ok", target);
    expect(existsSync(slot)).toBe(false); expect(await f.ownership.get(skillTarget(target))).toBeUndefined();
    expect(await readFile(sentinel, "utf8")).toBe("foreign");
  });
  it("supports trusted home/project ancestors reached through system-style symlinks", async () => {
    const f = await fixture(true);
    for (const target of [targets[0]!, targets[3]!]) {
      expectSkill(await f.run("apply", [target]), "skill_installed", "ok", target);
      expectSkill(await f.run("verify", [target]), "skill_verified", "ok", target);
      expectSkill(await f.run("remove", [target]), "skill_removed", "ok", target);
    }
  });
  it("dry-run leaves filesystem and ownership untouched and returns path-free findings", async () => {
    const f = await fixture(); const output = await f.run(); expectSkill(output, "skill_absent", "absent");
    expect(existsSync(join(f.home, ".agents"))).toBe(false); expect(await f.ownership.get(skillTarget(targets[0]!))).toBeUndefined();
    expect(JSON.stringify(output)).not.toContain(f.root);
    expect(output.findings.every((finding) => /^[a-z][a-z0-9_]{0,63}$/.test(finding.code))).toBe(true);
  });
  it("updates owned unmodified content when an override is added", async () => {
    const f = await fixture(); await f.run("apply"); const before = await f.ownership.get(skillTarget(targets[0]!));
    await mkdir(f.override, { recursive: true }); await writeFile(join(f.override, "SKILL.md"), "operator override");
    expectSkill(await f.run(), "skill_update_planned", "planned");
    expectSkill(await f.run("apply"), "skill_updated", "ok");
    expect(await readFile(join(f.slot(targets[0]!), "SKILL.md"), "utf8")).toBe("operator override");
    expect((await f.ownership.get(skillTarget(targets[0]!)))?.fingerprint).not.toBe(before?.fingerprint);
    expect(await readdir(join(f.slot(targets[0]!), ".."))).toEqual([skill]);
  });
  it("uses an override on the first install", async () => {
    const f = await fixture(); await mkdir(f.override, { recursive: true }); await writeFile(join(f.override, "SKILL.md"), "override");
    expectSkill(await f.run("apply"), "skill_installed", "ok");
    expect(await readFile(join(f.slot(targets[0]!), "SKILL.md"), "utf8")).toBe("override");
  });
  it.each(["modified", "foreign", "symlink", "file", "invalid-tree"])("preserves divergent %s content while applying the registration", async (kind) => {
    const f = await fixture(); const slot = f.slot(targets[0]!);
    if (kind === "modified") await f.run("apply");
    await mkdir(join(slot, ".."), { recursive: true });
    if (kind === "symlink") await symlink(f.source, slot);
    else if (kind === "file") await writeFile(slot, "foreign file");
    else { await mkdir(slot, { recursive: true }); await writeFile(join(slot, "SKILL.md"), "foreign content"); if (kind === "invalid-tree") await symlink(join(f.source, "SKILL.md"), join(slot, "linked.md")); }
    expectSkill(await f.run(), "skill_divergent", "divergent");
    const output = await f.run("apply"); expectSkill(output, "skill_divergent", "divergent");
    expect(output.findings[0]?.status).toMatch(/^(ok|unchanged)$/); expect(f.registered.has("codex:user")).toBe(true);
    expect(JSON.stringify(output)).not.toContain(f.root);
    if (kind === "symlink") expect((await lstat(slot)).isSymbolicLink()).toBe(true);
    else if (kind === "file") expect(await readFile(slot, "utf8")).toBe("foreign file");
    else expect(await readFile(join(slot, "SKILL.md"), "utf8")).toBe("foreign content");
  });
  it("installs into an operator-linked client directory but never follows a linked skill entry", async () => {
    const f = await fixture(); const dotfiles = join(f.root, "dotfiles-agents"); await mkdir(dotfiles);
    await symlink(dotfiles, join(f.home, ".agents"));
    expectSkill(await f.run("apply"), "skill_installed", "ok");
    expect(await readFile(join(dotfiles, "skills", skill, "SKILL.md"), "utf8")).toBe("controller v1");
    expect((await lstat(join(f.home, ".agents"))).isSymbolicLink()).toBe(true);
    expectSkill(await f.run("remove"), "skill_removed", "ok");
    expect(await readdir(join(dotfiles, "skills"))).toEqual([]);
  });
  it("never follows a link inside an untrusted project", async () => {
    const f = await fixture(); const outside = join(f.root, "outside-project"); await mkdir(outside);
    await symlink(outside, join(f.cwd, ".claude"));
    const project = targets.find((target) => target.scope === "project")!;
    expectSkill(await f.run("apply", [project]), "skill_divergent", "divergent", project);
    expect(await readdir(outside)).toEqual([]);
    await rm(join(f.cwd, ".claude")); await mkdir(join(f.cwd, ".claude")); await symlink(outside, join(f.cwd, ".claude", "skills"));
    expectSkill(await f.run("apply", [project]), "skill_divergent", "divergent", project);
    expect(await readdir(outside)).toEqual([]);
  });
  it("reports remove of a never-installed target as missing ownership", async () => {
    const f = await fixture();
    const output = await f.run("remove");
    expect(output.findings).toEqual([{ target: targets[0], status: "failed", code: "ownership_unavailable" }]);
  });
  it("reports unreadable trees as divergent and leaves them alone", async () => {
    const f = await fixture(); await f.run("apply"); const slot = f.slot(targets[0]!);
    await chmod(slot, 0o000);
    try {
      expectSkill(await f.run("apply"), "skill_divergent", "divergent");
      expectSkill(await f.run("remove"), "skill_divergent", "divergent");
    } finally { await chmod(slot, 0o755); }
    expect(await readFile(join(slot, "SKILL.md"), "utf8")).toBe("controller v1");
  });
  it.each(["remove", "rollback"] as const)("%s leaves an owned slot replaced by a symlink alone", async (operation) => {
    const f = await fixture(); await f.run("apply"); const slot = f.slot(targets[0]!);
    await rm(slot, { recursive: true }); await symlink(f.source, slot);
    expectSkill(await f.run(operation), "skill_divergent", "divergent");
    expect((await lstat(slot)).isSymbolicLink()).toBe(true); expect(await readFile(join(f.source, "SKILL.md"), "utf8")).toBe("controller v1");
  });
  it("never adopts a foreign equivalent skill", async () => {
    const f = await fixture(); const slot = f.slot(targets[0]!); await mkdir(join(slot, "references"), { recursive: true });
    await writeFile(join(slot, "SKILL.md"), "controller v1"); await writeFile(join(slot, "references", "guide.md"), "guide");
    expectSkill(await f.run(), "skill_equivalent", "unchanged"); expectSkill(await f.run("apply"), "skill_already_equivalent", "unchanged");
    expect(await f.ownership.get(skillTarget(targets[0]!))).toBeUndefined();
    expectSkill(await f.run("remove"), "skill_not_owned", "unchanged"); expect(existsSync(slot)).toBe(true);
  });
  it.each(["remove", "rollback"] as const)("%s preserves a modified owned copy and reports divergence", async (operation) => {
    const f = await fixture(); await f.run("apply"); const slot = f.slot(targets[0]!); await writeFile(join(slot, "SKILL.md"), "modified");
    expectSkill(await f.run(operation), "skill_divergent", "divergent");
    expect(await readFile(join(slot, "SKILL.md"), "utf8")).toBe("modified"); expect(f.registered.size).toBe(0);
    expect(await f.ownership.get(skillTarget(targets[0]!))).toBeDefined();
  });
  it("keeps the shared Claude user/local slot until the last registration is removed", async () => {
    const f = await fixture(); const user = targets[1]!; const local = targets[2]!;
    await f.run("apply", [user, local]);
    expectSkill(await f.run("remove", [user]), "skill_kept_shared", "unchanged", user);
    expect(existsSync(f.slot(local))).toBe(true);
    expectSkill(await f.run("rollback", [local]), "skill_removed", "ok", local); expect(existsSync(f.slot(local))).toBe(false);
  });
  it("reports absent during cleanup and clears stale skill ownership", async () => {
    const f = await fixture(); await f.run("apply"); await rm(f.slot(targets[0]!), { recursive: true });
    expectSkill(await f.run("remove"), "skill_absent", "ok"); expect(await f.ownership.get(skillTarget(targets[0]!))).toBeUndefined();
  });
  it("retries owned skill cleanup after registration removal and restored content", async () => {
    const f = await fixture(); await f.run("apply"); const slot = f.slot(targets[0]!);
    await writeFile(join(slot, "SKILL.md"), "modified");
    expectSkill(await f.run("remove"), "skill_divergent", "divergent"); expect(f.registered.size).toBe(0);
    await writeFile(join(slot, "SKILL.md"), "controller v1");
    expectSkill(await f.run("remove"), "skill_removed", "ok"); expect(existsSync(slot)).toBe(false);
  });
  it("cleans orphaned skill ownership after a crash between registration removal and skill cleanup", async () => {
    const f = await fixture(); await f.run("apply"); f.registered.clear(); await f.ownership.delete(targets[0]!);
    expectSkill(await f.run("rollback"), "skill_removed", "ok"); expect(existsSync(f.slot(targets[0]!))).toBe(false);
  });
  it("does not retry skill cleanup while an unowned registration is present", async () => {
    const f = await fixture(); await f.run("apply"); await f.ownership.delete(targets[0]!);
    const output = await f.run("remove"); expect(output.findings).toHaveLength(1); expect(output.findings[0]?.code).toBe("ownership_unavailable");
    expect(existsSync(f.slot(targets[0]!))).toBe(true);
  });
  it("verifies missing, changed, invalid-source and equivalent skills", async () => {
    const f = await fixture(); expectSkill(await f.run("verify"), "skill_missing", "failed"); await f.run("apply");
    await writeFile(join(f.slot(targets[0]!), "SKILL.md"), "changed"); expectSkill(await f.run("verify"), "skill_not_equivalent", "failed");
    await writeFile(join(f.slot(targets[0]!), "SKILL.md"), "controller v1"); expectSkill(await f.run("verify"), "skill_verified", "ok");
    await rm(f.source, { recursive: true }); expectSkill(await f.run("verify"), "skill_not_equivalent", "failed");
  });
  it("reports invalid source without blocking registration or exposing paths", async () => {
    const f = await fixture(); await symlink(join(f.source, "SKILL.md"), join(f.source, "bad"));
    expectSkill(await f.run(), "skill_source_invalid", "failed"); const output = await f.run("apply");
    expectSkill(output, "skill_source_invalid", "failed"); expect(output.findings[0]?.code).toBe("applied"); expect(JSON.stringify(output)).not.toContain(f.root);
  });
  it("skips skill mutation when registration apply fails", async () => {
    const f = await fixture(); f.adapters[0]!.apply = async () => { throw new Error("failed"); };
    const output = await f.run("apply"); expect(output.findings).toHaveLength(1); expect(existsSync(f.slot(targets[0]!))).toBe(false);
  });
  it("writes pending before filesystem mutations and promotes only the matching installed tree", async () => {
    const f = await fixture(); const put = f.ownership.put.bind(f.ownership); const phases: string[] = [];
    f.ownership.put = async (record) => {
      if (record.target.alias.startsWith("skill:")) {
        phases.push(record.phase);
        if (record.phase === "pending") expect(existsSync(join(f.home, ".agents"))).toBe(false);
        else expect((await readSkillTree(f.slot(targets[0]!))).fingerprint).toBe(record.fingerprint);
      }
      await put(record);
    };
    expectSkill(await f.run("apply"), "skill_installed", "ok"); expect(phases).toEqual(["pending", "owned"]);
  });
  it("leaves pending ownership and no filesystem mutation when the fence becomes unhealthy", async () => {
    const f = await fixture(); let compromised = false; const put = f.ownership.put.bind(f.ownership);
    f.ownership.put = async (record: OwnershipRecord) => { await put(record); if (record.target.alias.startsWith("skill:")) compromised = true; };
    Object.assign(f.ownership, { assertHealthy() { if (compromised) throw new Error("fence_unhealthy"); } });
    expectSkill(await f.run("apply"), "skill_install_failed", "failed");
    expect(existsSync(join(f.home, ".agents"))).toBe(false); expect((await f.ownership.get(skillTarget(targets[0]!)))?.phase).toBe("pending");
  });
  it("retains pending ownership when the installed tree changes before promotion", async () => {
    const f = await fixture(); const slot = f.slot(targets[0]!); let changed = false;
    Object.assign(f.ownership, { assertHealthy() {
      if (!changed && existsSync(join(slot, "SKILL.md"))) { changed = true; writeFileSync(join(slot, "SKILL.md"), "interference"); }
    } });
    expectSkill(await f.run("apply"), "skill_install_failed", "failed");
    expect((await f.ownership.get(skillTarget(targets[0]!)))?.phase).toBe("pending");
    expect(await readFile(join(slot, "SKILL.md"), "utf8")).toBe("interference");
  });
  it("removes both shared registrations in order within one request", async () => {
    const f = await fixture(); await f.run("apply", [targets[1]!, targets[2]!]);
    const output = await f.run("remove", [targets[1]!, targets[2]!]);
    expect(output.findings.map((finding) => finding.code)).toEqual(["removed", "skill_kept_shared", "removed", "skill_removed"]);
    expect(existsSync(f.slot(targets[1]!))).toBe(false);
  });
  it("does not remove skills when registration cleanup fails", async () => {
    const f = await fixture(); await f.run("apply"); f.adapters[0]!.remove = async () => { throw new Error("failed"); };
    const output = await f.run("remove"); expect(output.findings).toHaveLength(1); expect(existsSync(f.slot(targets[0]!))).toBe(true);
  });
  it("recovers pending ownership of an equivalent installed tree", async () => {
    const f = await fixture(); await f.run("apply"); const owned = (await f.ownership.get(skillTarget(targets[0]!)))!;
    await f.ownership.put({ ...owned, phase: "pending" }); expectSkill(await f.run("apply"), "skill_already_equivalent", "unchanged");
    expect((await f.ownership.get(skillTarget(targets[0]!)))?.phase).toBe("owned");
  });
});

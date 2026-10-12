import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { MemoryOwnershipStore } from "../../src/setup-ownership.js";
import { FileSetupSkillInstaller, type SetupSkillDependencies } from "../../src/setup-skills.js";
import { SetupOrchestrator, type SetupClientAdapter } from "../../src/setup.js";
import type { SetupOperation, SetupTarget } from "../../src/setup-result.js";
import { temporaryRoot } from "../temporary-roots.js";

/** Shared fixture of the setup skill tests: a temporary home, project, package and configuration. */
export const skill = "pi-session-orchestration";
export const fingerprint = "a".repeat(64);
export const targets: SetupTarget[] = [
  { client: "codex", scope: "user", alias: "pi-session-mcp" },
  ...["user", "local", "project"].map((scope) => ({ client: "claude-code", scope, alias: "pi-session-mcp" })),
];
export const projectIdentity = (cwd: string): string => createHash("sha256").update(realpathSync(cwd)).digest("hex").slice(0, 16);
export const skillTarget = (target: SetupTarget, cwd = "/"): SetupTarget => ({
  ...target, scope: target.scope === "local" ? "user" : target.scope,
  alias: target.scope === "project" ? `skill:${skill}@${projectIdentity(cwd)}` : `skill:${skill}`,
});
export async function fixture(linkedRoots = false, installer: SetupSkillDependencies = {}) {
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
  const skills = new FileSetupSkillInstaller({ packageRoot, configPath, home, cwd }, installer);
  const orchestrator = new SetupOrchestrator({ adapters, ownership, intendedFingerprint: fingerprint, skills });
  const slot = (target: SetupTarget) => join(target.scope === "project" ? cwd : home, target.client === "codex" ? ".agents" : ".claude", "skills", skill);
  const run = (operation: SetupOperation = "dry-run", selected: SetupTarget[] = [targets[0]!]) => orchestrator.run({ operation, targets: selected });
  return { root, home, cwd, source, override, ownership, registered, adapters, skills, orchestrator, slot, run };
}
export function expectSkill(output: Awaited<ReturnType<SetupOrchestrator["run"]>>, code: string, status: string, target = targets[0]!) {
  expect(output.findings[1]).toEqual({ target: { ...target, alias: skill }, code, status });
}


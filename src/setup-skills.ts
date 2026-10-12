import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { CONTROLLER_SKILLS, readSkillTree, resolveLibrarySkill, skillOverrideDirectory, type SkillTree } from "./skill-library.js";
import type { OwnershipAccess, OwnershipRecord } from "./setup-ownership.js";
import type { SetupFinding, SetupOperation, SetupStatus, SetupTarget } from "./setup-result.js";

export interface SetupSkillInstaller {
  /** Called under the registration's ownership transaction for every mutation. */
  run(operation: SetupOperation, target: SetupTarget, ownership: OwnershipAccess): Promise<readonly SetupFinding[]>;
  /** Whether setup owns an installed skill in the slot of this registration target. */
  owns(target: SetupTarget, ownership: OwnershipAccess): Promise<boolean>;
}
export interface SetupSkillRoots {
  readonly packageRoot: string;
  readonly configPath: string;
  readonly home: string;
  readonly cwd: string;
}
type Slot = { readonly state: "absent" } | { readonly state: "divergent" } |
  { readonly state: "tree"; readonly fingerprint: string; readonly dev: number; readonly ino: number };

/** Paths remain internal. Ownership identifies a client slot, never its location. */
export class FileSetupSkillInstaller implements SetupSkillInstaller {
  constructor(private readonly roots: SetupSkillRoots) {}

  async run(operation: SetupOperation, target: SetupTarget, ownership: OwnershipAccess): Promise<readonly SetupFinding[]> {
    const findings: SetupFinding[] = [];
    for (const name of CONTROLLER_SKILLS) findings.push(await this.skill(operation, target, name, ownership));
    return findings;
  }

  async owns(target: SetupTarget, ownership: OwnershipAccess): Promise<boolean> {
    for (const name of CONTROLLER_SKILLS) if (await ownership.get(this.ownedTarget(target, name))) return true;
    return false;
  }

  private async slot(target: SetupTarget, name: string): Promise<string> {
    // The client's skills directory may be the operator's own link, for example into a dotfiles
    // checkout, so it is canonicalized; the skill entry itself is never followed.
    const skills = join(target.scope === "project" ? this.roots.cwd : this.roots.home, target.client === "codex" ? ".agents" : ".claude", "skills");
    return join(await canonicalExisting(skills), name);
  }
  private ownedTarget(target: SetupTarget, name: string): SetupTarget {
    return { client: target.client, scope: target.scope === "project" ? "project" : "user", alias: `skill:${name}` };
  }
  private desired(name: string): Promise<SkillTree> {
    const library = resolveLibrarySkill(name, { overrideDirectory: skillOverrideDirectory(this.roots.configPath), packageRoot: this.roots.packageRoot });
    if (!library) throw new Error("skill_source_invalid");
    return readSkillTree(library.directory);
  }
  private async skill(operation: SetupOperation, target: SetupTarget, name: string, ownership: OwnershipAccess): Promise<SetupFinding> {
    const finding = (code: string, status: SetupStatus): SetupFinding => ({ target: { ...target, alias: name }, code, status });
    let path: string;
    try { path = await this.slot(target, name); }
    catch {
      return finding(operation === "verify" ? "skill_missing" :
        operation === "dry-run" ? "skill_source_invalid" :
        operation === "apply" ? "skill_install_failed" : "skill_divergent", operation === "remove" || operation === "rollback" ? "divergent" : "failed");
    }
    const ownedTarget = this.ownedTarget(target, name);
    if (operation === "remove" || operation === "rollback") {
      try {
        const owned = await ownership.get(ownedTarget);
        if (!owned) return finding("skill_not_owned", "unchanged");
        if (target.client === "claude-code" && target.scope !== "project") {
          const other = await ownership.get({ ...target, scope: target.scope === "local" ? "user" : "local" });
          if (other?.phase === "owned") return finding("skill_kept_shared", "unchanged");
        }
        const current = await inspectSlot(path);
        if (current.state === "absent") {
          healthy(ownership); await ownership.delete(ownedTarget); healthy(ownership);
          return finding("skill_absent", "ok");
        }
        if (current.state !== "tree" || current.fingerprint !== owned.fingerprint) return finding("skill_divergent", "divergent");
        healthy(ownership);
        if (!await sameSlot(path, current)) return finding("skill_divergent", "divergent");
        healthy(ownership); await rm(path, { recursive: true }); healthy(ownership);
        await syncDirectory(dirname(path)); healthy(ownership);
        await ownership.delete(ownedTarget); healthy(ownership);
        return finding("skill_removed", "ok");
      } catch { return finding("skill_divergent", "divergent"); }
    }
    if (operation === "verify") {
      const current = await inspectSlot(path);
      if (current.state === "absent") return finding("skill_missing", "failed");
      try {
        const desired = await this.desired(name);
        return current.state === "tree" && current.fingerprint === desired.fingerprint
          ? finding("skill_verified", "ok") : finding("skill_not_equivalent", "failed");
      } catch { return finding("skill_not_equivalent", "failed"); }
    }
    let desired: SkillTree;
    try { desired = await this.desired(name); }
    catch { return finding("skill_source_invalid", "failed"); }
    try {
      const current = await inspectSlot(path);
      const owned = await ownership.get(ownedTarget);
      // An owned copy modified by the user is divergent, even if it matches a new source.
      const modified = owned && current.state === "tree" && current.fingerprint !== owned.fingerprint;
      if (current.state === "divergent" || modified) return finding("skill_divergent", "divergent");
      if (current.state === "tree" && current.fingerprint === desired.fingerprint) {
        if (operation === "apply" && owned?.phase === "pending") {
          healthy(ownership); await ownership.put({ ...owned, phase: "owned" }); healthy(ownership);
        }
        return finding(operation === "apply" ? "skill_already_equivalent" : "skill_equivalent", "unchanged");
      }
      if (current.state === "tree" && (!owned || owned.phase !== "owned")) return finding("skill_divergent", "divergent");
      if (operation === "dry-run") return current.state === "absent" ? finding("skill_absent", "absent") : finding("skill_update_planned", "planned");
      const pending: OwnershipRecord = { target: ownedTarget, fingerprint: desired.fingerprint, previous: "absent", phase: "pending", transactionId: randomUUID() };
      healthy(ownership); await ownership.put(pending); healthy(ownership);
      await this.replace(path, name, desired, current, ownership);
      healthy(ownership);
      const after = await inspectSlot(path);
      if (after.state !== "tree" || after.fingerprint !== desired.fingerprint) throw new Error("skill_post_install_mismatch");
      healthy(ownership); await ownership.put({ ...pending, phase: "owned" }); healthy(ownership);
      return finding(current.state === "absent" ? "skill_installed" : "skill_updated", "ok");
    } catch { return finding(operation === "apply" ? "skill_install_failed" : "skill_source_invalid", "failed"); }
  }

  private async replace(path: string, name: string, desired: SkillTree, current: Slot, ownership: OwnershipAccess): Promise<void> {
    const parent = dirname(path);
    healthy(ownership); await ensureParents(parent, ownership); healthy(ownership);
    const temporary = join(parent, `.pi-session-mcp-${name}-${randomUUID()}`);
    const backup = join(parent, `.pi-session-mcp-${name}-${randomUUID()}`);
    let staged = false;
    try {
      healthy(ownership); await mkdir(temporary, { mode: 0o755 }); staged = true;
      for (const file of desired.files) {
        healthy(ownership);
        const destination = join(temporary, ...file.path.split("/"));
        await ensureParents(dirname(destination), ownership);
        healthy(ownership);
        const handle = await open(destination, "wx", 0o644);
        try { await handle.writeFile(file.bytes); await handle.sync(); } finally { await handle.close(); }
      }
      await syncTreeDirectories(temporary, desired, ownership);
      healthy(ownership);
      if (!await sameSlot(path, current)) throw new Error("skill_slot_changed");
      healthy(ownership);
      if (current.state === "tree") {
        await rename(path, backup); healthy(ownership); await syncDirectory(parent); healthy(ownership);
      }
      await rename(temporary, path); staged = false;
      healthy(ownership); await syncDirectory(parent); healthy(ownership);
      const after = await inspectSlot(path);
      if (after.state !== "tree" || after.fingerprint !== desired.fingerprint) throw new Error("skill_post_install_mismatch");
      if (current.state === "tree") {
        // Delete only the exact old tree moved by this transaction.
        if (!await sameSlot(backup, current)) throw new Error("skill_backup_changed");
        healthy(ownership); await rm(backup, { recursive: true }); healthy(ownership); await syncDirectory(parent);
      }
    } finally {
      // An unhealthy fence retains staged/backup content for conservative recovery.
      if (staged) { healthy(ownership); await rm(temporary, { recursive: true, force: true }); }
    }
  }
}

function healthy(ownership: OwnershipAccess): void { ownership.assertHealthy?.(); }

/** The real path of the nearest existing ancestor, with the not yet existing tail appended. */
async function canonicalExisting(path: string): Promise<string> {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try { return join(await realpath(current), ...missing); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(current) === current) throw error;
      missing.unshift(basename(current));
      current = dirname(current);
    }
  }
}

/** Reject symlink parents too, so inspecting a slot never traverses one. */
async function safeParents(directory: string): Promise<void> {
  if (dirname(directory) !== directory) await safeParents(dirname(directory));
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("skill_parent_invalid");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
async function inspectSlot(path: string): Promise<Slot> {
  try {
    await safeParents(dirname(path));
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) return { state: "divergent" };
    const tree = await readSkillTree(path);
    const after = await lstat(path);
    if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== info.dev || after.ino !== info.ino) return { state: "divergent" };
    return { state: "tree", fingerprint: tree.fingerprint, dev: info.dev, ino: info.ino };
  } catch (error) { return { state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "divergent" }; }
}
async function sameSlot(path: string, expected: Slot): Promise<boolean> {
  const actual = await inspectSlot(path);
  return expected.state === "absent" ? actual.state === "absent" :
    expected.state === "tree" && actual.state === "tree" && actual.fingerprint === expected.fingerprint && actual.dev === expected.dev && actual.ino === expected.ino;
}
async function ensureParents(directory: string, ownership: OwnershipAccess): Promise<void> {
  if (dirname(directory) !== directory) await ensureParents(dirname(directory), ownership);
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("skill_parent_invalid");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    healthy(ownership); await mkdir(directory, { mode: 0o755 }); healthy(ownership);
    await syncDirectory(directory); await syncDirectory(dirname(directory));
  }
}
async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function syncTreeDirectories(root: string, tree: SkillTree, ownership: OwnershipAccess): Promise<void> {
  const directories = new Set<string>([root]);
  for (const file of tree.files) {
    let cursor = dirname(join(root, file.path));
    while (cursor !== root) { directories.add(cursor); cursor = dirname(cursor); }
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) { healthy(ownership); await syncDirectory(directory); }
}

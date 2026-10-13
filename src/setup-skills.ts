import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join, posix } from "node:path";
import {
  CONTROLLER_SKILLS, LEGACY_SKILL_TREE_FINGERPRINT_PATTERN, MAX_SKILL_TREE_BYTES, MAX_SKILL_TREE_FILES, provesLegacyFingerprint,
  RELEASED_SKILL_TREES, readSkillTree, resolveLibrarySkill, SKILL_TREE_FINGERPRINT_PATTERN, skillOverrideDirectory,
  type ReleasedSkillTree, type SkillTree,
} from "./skill-library.js";
import type { OwnershipAccess, OwnershipRecord } from "./setup-ownership.js";
import type { SetupFinding, SetupOperation, SetupStatus, SetupTarget } from "./setup-result.js";

export interface SetupSkillInstaller {
  /** Called under the registration's ownership transaction for every mutation. */
  run(operation: SetupOperation, target: SetupTarget, ownership: OwnershipAccess): Promise<readonly SetupFinding[]>;
  /**
   * Whether setup still owns an installed skill of exactly this registration target, so that a
   * remove may finish the skill cleanup after the registration is already gone.
   */
  owns(target: SetupTarget, ownership: OwnershipAccess): Promise<boolean>;
}
export interface SetupSkillRoots {
  readonly packageRoot: string;
  readonly configPath: string;
  readonly home: string;
  readonly cwd: string;
}
/** The crash-relevant points of an update, in order. Only a test seam observes them. */
export type SkillCheckpoint =
  | "staged" | "backup-renamed" | "installed" | "trash-renamed" | "trash-entry-removed" | "trash-deleted" | "before-ownership";
export interface SetupSkillDependencies {
  /** Trusted released trees that prove 0.8.0 records; defaults to the shipped table. */
  readonly released?: readonly ReleasedSkillTree[];
  /** Test seam, called after each step in `SkillCheckpoint` completed; defaults to a no-op. */
  readonly checkpoint?: (step: SkillCheckpoint) => void | Promise<void>;
}
type TreeSlot = { readonly state: "tree"; readonly fingerprint: string; readonly dev: number; readonly ino: number };
type Slot =
  | { readonly state: "absent" }
  | { readonly state: "divergent" }
  /** A link to exactly the effective library skill: the operator's own, equivalent, never owned. */
  | { readonly state: "linked" }
  | TreeSlot;
interface Location { readonly path: string; readonly owned: SetupTarget }
/**
 * `settled`: nothing of the transaction was left; `recovered`: it was settled and recovery changed
 * the disk (renamed into the slot or deleted an intermediate); `retained`: something stays;
 * `untouched`: the slot is not setup's copy.
 */
type Recovery = "settled" | "recovered" | "retained" | "untouched";
interface Intermediates { readonly staging: string; readonly backup: string; readonly trash: string }

const TRANSACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TREE_DEPTH = 8;
const MAX_TREE_ENTRIES = 256;

/** Whether a version 2 fingerprint is setup's own copy: the owned one, or the one a pending update replaces. */
function ownsFingerprint(record: OwnershipRecord, fingerprint: string): boolean {
  return fingerprint === record.fingerprint || (record.phase === "pending" && record.replaces === fingerprint);
}
const isLegacy = (value: string | undefined): value is string => value !== undefined && LEGACY_SKILL_TREE_FINGERPRINT_PATTERN.test(value);
const hasLegacy = (record: OwnershipRecord): boolean => isLegacy(record.fingerprint) || isLegacy(record.replaces);

/**
 * Every intermediate directory of an update is named after the pending record's transaction id
 * in the slot's parent, so recovery derives them from persisted state and never searches.
 */
function intermediates(path: string, name: string, transactionId: string): Intermediates {
  if (!TRANSACTION_ID.test(transactionId)) throw new Error("skill_transaction_invalid");
  const base = join(dirname(path), `.pi-session-mcp-${name}-${transactionId}`);
  return { staging: `${base}.staging`, backup: `${base}.backup`, trash: `${base}.trash` };
}

/** Paths remain internal. Ownership identifies a client slot, never its location. */
export class FileSetupSkillInstaller implements SetupSkillInstaller {
  constructor(private readonly roots: SetupSkillRoots, private readonly dependencies: SetupSkillDependencies = {}) {}

  async run(operation: SetupOperation, target: SetupTarget, ownership: OwnershipAccess): Promise<readonly SetupFinding[]> {
    const findings: SetupFinding[] = [];
    for (const name of CONTROLLER_SKILLS) findings.push(await this.skill(operation, target, name, ownership));
    return findings;
  }

  async owns(target: SetupTarget, ownership: OwnershipAccess): Promise<boolean> {
    // Claude Code user and local share one slot: while the other registration exists, its skill
    // is not this target's to clean up.
    if (target.client === "claude-code" && target.scope !== "project"
      && await ownership.get({ ...target, scope: target.scope === "local" ? "user" : "local" })) return false;
    for (const name of CONTROLLER_SKILLS) if (await ownership.get((await this.location(target, name)).owned)) return true;
    return false;
  }

  private async step(step: SkillCheckpoint): Promise<void> { await this.dependencies.checkpoint?.(step); }

  /**
   * The slot path and its ownership key. A project may be untrusted: only its root is
   * canonicalized, and a link below it (for example `.claude` pointing elsewhere) makes the
   * slot divergent, so setup never writes outside the project. In the operator's home the
   * client's skills directory may be the operator's own link, for example into a dotfiles
   * checkout, so it is followed. The skill entry itself is never followed in either place.
   * A project slot's ownership is bound to an opaque, path-free identity of the project, so a
   * remove in another project never touches this project's copy.
   */
  private async location(target: SetupTarget, name: string): Promise<Location> {
    const client = target.client === "codex" ? ".agents" : ".claude";
    if (target.scope === "project") {
      const project = await realpath(this.roots.cwd);
      const identity = createHash("sha256").update(project).digest("hex").slice(0, 16);
      return { path: join(project, client, "skills", name), owned: { client: target.client, scope: "project", alias: `skill:${name}@${identity}` } };
    }
    return { path: join(await canonicalExisting(join(this.roots.home, client, "skills")), name), owned: { client: target.client, scope: "user", alias: `skill:${name}` } };
  }
  private library(name: string) {
    return resolveLibrarySkill(name, { overrideDirectory: skillOverrideDirectory(this.roots.configPath), packageRoot: this.roots.packageRoot });
  }

  /**
   * Whether the record names this installed tree: its version 2 value, or a 0.8.0 value that a
   * trusted reference proves for exactly these bytes. A bare legacy value never proves identity.
   */
  private ownsTree(name: string, record: OwnershipRecord, slot: TreeSlot, references: readonly SkillTree[]): boolean {
    if (ownsFingerprint(record, slot.fingerprint)) return true;
    const named = record.phase === "pending" ? [record.fingerprint, record.replaces] : [record.fingerprint];
    return named.some((value) => isLegacy(value) && provesLegacyFingerprint(name, value, slot, references, this.dependencies.released ?? RELEASED_SKILL_TREES));
  }

  private async skill(operation: SetupOperation, target: SetupTarget, name: string, ownership: OwnershipAccess): Promise<SetupFinding> {
    const finding = (code: string, status: SetupStatus): SetupFinding => ({ target: { ...target, alias: name }, code, status });
    let location: Location;
    try { location = await this.location(target, name); }
    catch {
      return finding(operation === "verify" ? "skill_missing" :
        operation === "dry-run" ? "skill_source_invalid" :
        operation === "apply" ? "skill_install_failed" : "skill_divergent", operation === "remove" || operation === "rollback" ? "divergent" : "failed");
    }
    const { path, owned: ownedTarget } = location;
    const library = this.library(name);
    // Only a usable library skill can stand behind an accepted link or a legacy proof; otherwise verify and apply would disagree.
    const desired = library ? await readSkillTree(library.directory).catch(() => undefined) : undefined;
    const linkTarget = desired ? await realpath(library!.directory).catch(() => undefined) : undefined;
    const references: readonly SkillTree[] = desired ? [desired] : [];
    if (operation === "remove" || operation === "rollback") {
      try {
        const owned = await ownership.get(ownedTarget);
        if (!owned) return finding("skill_not_owned", "unchanged");
        if (target.client === "claude-code" && target.scope !== "project") {
          const other = await ownership.get({ ...target, scope: target.scope === "local" ? "user" : "local" });
          if (other?.phase === "owned") return finding("skill_kept_shared", "unchanged");
        }
        if (owned.phase === "pending" && SKILL_TREE_FINGERPRINT_PATTERN.test(owned.fingerprint)
          && await this.recover(operation, path, name, owned, desired, linkTarget, ownership) === "retained") return finding("skill_recovery_retained", "divergent");
        const current = await inspectSlot(path, linkTarget);
        if (current.state === "absent") {
          healthy(ownership); await ownership.delete(ownedTarget); healthy(ownership);
          return finding("skill_absent", "ok");
        }
        if (current.state === "linked") {
          // The operator replaced setup's copy with their own link: the record is stale, the link stays.
          healthy(ownership); await ownership.delete(ownedTarget); healthy(ownership);
          return finding("skill_not_owned", "unchanged");
        }
        if (current.state !== "tree") return finding("skill_divergent", "divergent");
        if (!this.ownsTree(name, owned, current, references)) return finding(hasLegacy(owned) ? "skill_legacy_unverified" : "skill_divergent", "divergent");
        healthy(ownership);
        if (!await sameSlot(path, current, linkTarget)) return finding("skill_divergent", "divergent");
        healthy(ownership); await rm(path, { recursive: true }); healthy(ownership);
        await syncDirectory(dirname(path)); healthy(ownership);
        await ownership.delete(ownedTarget); healthy(ownership);
        return finding("skill_removed", "ok");
      } catch { return finding("skill_divergent", "divergent"); }
    }
    if (operation === "verify") {
      const current = await inspectSlot(path, linkTarget);
      if (current.state === "absent") return finding("skill_missing", "failed");
      if (current.state === "linked") return finding("skill_verified", "ok");
      return desired && current.state === "tree" && current.fingerprint === desired.fingerprint
        ? finding("skill_verified", "ok") : finding("skill_not_equivalent", "failed");
    }
    if (!desired) return finding("skill_source_invalid", "failed");
    try {
      let owned = await ownership.get(ownedTarget);
      let recovered = false;
      if (operation === "apply" && owned?.phase === "pending" && SKILL_TREE_FINGERPRINT_PATTERN.test(owned.fingerprint)) {
        const outcome = await this.recover("apply", path, name, owned, desired, linkTarget, ownership);
        if (outcome === "retained") return finding("skill_recovery_retained", "divergent");
        recovered = outcome === "recovered";
      }
      // A dry-run never recovers; it announces the settlement apply would perform for a version 2 transaction.
      const recoveryPlanned = operation === "dry-run" && owned?.phase === "pending" && SKILL_TREE_FINGERPRINT_PATTERN.test(owned.fingerprint) && !hasLegacy(owned);
      const current = await inspectSlot(path, linkTarget);
      if (current.state === "linked") {
        if (operation === "apply" && owned) { healthy(ownership); await ownership.delete(ownedTarget); healthy(ownership); }
        return finding("skill_linked", "unchanged");
      }
      if (current.state === "divergent") return finding("skill_divergent", "divergent");
      if (owned && current.state === "tree" && hasLegacy(owned)) {
        // A record from 0.8.0: it names the slot only if a trusted reference proves these exact bytes.
        if (!this.ownsTree(name, owned, current, references)) return finding("skill_legacy_unverified", "divergent");
        owned = { target: ownedTarget, fingerprint: current.fingerprint, previous: owned.previous, phase: "owned", transactionId: owned.transactionId };
        if (operation === "apply") { healthy(ownership); await ownership.put(owned); healthy(ownership); }
      }
      // A copy setup did not write, or its own copy modified since, is never replaced.
      if (current.state === "tree" && (!owned || !ownsFingerprint(owned, current.fingerprint))) {
        if (!owned && current.fingerprint === desired.fingerprint) return finding(operation === "apply" ? "skill_already_equivalent" : "skill_equivalent", "unchanged");
        return finding("skill_divergent", "divergent");
      }
      if (current.state === "tree" && current.fingerprint === desired.fingerprint) {
        if (recoveryPlanned) return finding("skill_recovery_planned", "planned");
        if (operation === "apply" && owned?.phase === "pending") {
          healthy(ownership); await ownership.put(ownedRecord(owned, desired.fingerprint)); healthy(ownership);
          return finding("skill_recovered", "ok");
        }
        if (operation === "apply" && recovered) return finding("skill_recovered", "ok");
        return finding(operation === "apply" ? "skill_already_equivalent" : "skill_equivalent", "unchanged");
      }
      if (operation === "dry-run") {
        if (recoveryPlanned) return finding("skill_recovery_planned", "planned");
        return current.state === "absent" ? finding("skill_absent", "absent") : finding("skill_update_planned", "planned");
      }
      // The pending record is persisted before any intermediate exists. It names the intermediates
      // (transaction id), the target and the replaced copy, so an interrupted update can be
      // recovered, finished or removed from persisted state alone.
      const pending: OwnershipRecord = {
        target: ownedTarget, fingerprint: desired.fingerprint, previous: "absent", phase: "pending", transactionId: randomUUID(),
        ...(current.state === "tree" ? { replaces: current.fingerprint } : {}),
      };
      healthy(ownership); await ownership.put(pending); healthy(ownership);
      await this.replace(path, name, desired, current, pending, ownership);
      healthy(ownership);
      const after = await inspectSlot(path);
      if (after.state !== "tree" || after.fingerprint !== desired.fingerprint) throw new Error("skill_post_install_mismatch");
      await this.step("before-ownership");
      healthy(ownership); await ownership.put(ownedRecord(pending, desired.fingerprint)); healthy(ownership);
      return finding(current.state === "absent" ? "skill_installed" : "skill_updated", "ok");
    } catch { return finding(operation === "apply" ? "skill_install_failed" : "skill_source_invalid", "failed"); }
  }

  /**
   * Installs the new tree through the transaction's own intermediates. A failure leaves them for
   * recovery; nothing here deletes by guess.
   */
  private async replace(path: string, name: string, desired: SkillTree, current: Slot, record: OwnershipRecord, ownership: OwnershipAccess): Promise<void> {
    const parent = dirname(path);
    const names = intermediates(path, name, record.transactionId);
    healthy(ownership); await ensureParents(parent, ownership); healthy(ownership);
    healthy(ownership); await mkdir(names.staging, { mode: 0o755 });
    for (const file of desired.files) {
      healthy(ownership);
      const destination = join(names.staging, ...file.path.split("/"));
      await ensureParents(dirname(destination), ownership);
      healthy(ownership);
      const handle = await open(destination, "wx", 0o644);
      try { await handle.writeFile(file.bytes); await handle.sync(); } finally { await handle.close(); }
    }
    await syncTreeDirectories(names.staging, desired, ownership);
    await this.step("staged");
    healthy(ownership);
    if (!await sameSlot(path, current)) throw new Error("skill_slot_changed");
    healthy(ownership);
    if (current.state === "tree") {
      // A rename onto an existing empty directory would replace it silently.
      if (await present(names.backup)) throw new Error("skill_backup_exists");
      await rename(path, names.backup); healthy(ownership); await syncDirectory(parent); healthy(ownership);
      await this.step("backup-renamed");
    }
    await rename(names.staging, path);
    healthy(ownership); await syncDirectory(parent); healthy(ownership);
    await this.step("installed");
    const after = await inspectSlot(path);
    if (after.state !== "tree" || after.fingerprint !== desired.fingerprint) throw new Error("skill_post_install_mismatch");
    if (current.state === "tree") await this.discardBackup(names, current, parent, ownership);
  }

  /**
   * Deletes the backup only after it is verified to be the exact old copy: it is renamed to the
   * transaction's trash name first, so the deletion never leaves an unverifiable partial tree
   * under the backup name.
   */
  private async discardBackup(names: Intermediates, backup: TreeSlot, parent: string, ownership: OwnershipAccess): Promise<void> {
    if (await present(names.trash)) throw new Error("skill_trash_exists");
    if (!await sameSlot(names.backup, backup)) throw new Error("skill_backup_changed");
    healthy(ownership); await rename(names.backup, names.trash); healthy(ownership); await syncDirectory(parent); healthy(ownership);
    await this.step("trash-renamed");
    await this.discardTrash(names, parent, ownership);
    await this.step("trash-deleted");
  }

  /**
   * Deletes the transaction's trash entry by entry, so a crash leaves only a smaller partial tree.
   * Callers must have proven the trash to be the complete replaced copy; a later recovery retains
   * a partial tree instead of deleting it.
   */
  private async discardTrash(names: Intermediates, parent: string, ownership: OwnershipAccess): Promise<void> {
    await removeEntries(names.trash, parent, ownership, () => this.step("trash-entry-removed"));
  }

  /**
   * Settles an interrupted update of the pending record's transaction, inside the ownership
   * transaction. Only directories with this transaction's exact names are examined, and only
   * verified ones are deleted: the backup must equal the replaced copy, the staging directory
   * the target or an interrupted write of it, the trash the complete replaced copy. Anything
   * else stays and is reported, including a partial or changed trash.
   *
   * apply, slot absent: a complete staging directory is renamed into the slot (forward);
   * otherwise a verified backup is moved back. remove and rollback do not restore, they delete
   * what is verified and leave the slot to the caller.
   */
  private async recover(
    operation: "apply" | "remove" | "rollback", path: string, name: string, record: OwnershipRecord,
    library: SkillTree | undefined, linkTarget: string | undefined, ownership: OwnershipAccess,
  ): Promise<Recovery> {
    const parent = dirname(path);
    const names = intermediates(path, name, record.transactionId);
    const target = record.fingerprint;
    const previous = record.replaces !== undefined && SKILL_TREE_FINGERPRINT_PATTERN.test(record.replaces) ? record.replaces : undefined;
    const slot = await inspectSlot(path, linkTarget);
    // Only an empty slot, a link or one of setup's two copies can have intermediates of this transaction settled.
    if (slot.state === "divergent" || (slot.state === "tree" && slot.fingerprint !== target && slot.fingerprint !== previous)) return "untouched";
    // A trash directory with the transaction's name holds the verified replaced copy, but only
    // while it is complete: it is deleted only when it still equals the record's replaced
    // fingerprint. A partial trash (an interrupted deletion) or any changed content cannot be
    // proven to be setup's own, so it is retained and reported for the operator to settle.
    let changed = false;
    if (await present(names.trash)) {
      const trash = await inspectSlot(names.trash);
      if (trash.state !== "tree" || previous === undefined || trash.fingerprint !== previous) return "retained";
      await this.discardTrash(names, parent, ownership);
      changed = true;
    }
    let backup = await inspectSlot(names.backup);
    if (backup.state === "divergent" || (backup.state === "tree" && backup.fingerprint !== previous)) return "retained";
    let staging = await classifyStaging(names.staging, target, library);
    if (staging === "foreign") return "retained";
    if (operation === "apply" && slot.state === "absent") {
      if (staging === "complete" || backup.state === "tree") {
        const source = staging === "complete" ? names.staging : names.backup;
        const expected = staging === "complete" ? target : previous;
        healthy(ownership);
        if (!await sameSlot(path, slot)) throw new Error("skill_slot_changed");
        healthy(ownership); await rename(source, path); healthy(ownership); await syncDirectory(parent); healthy(ownership);
        const restored = await inspectSlot(path);
        if (restored.state !== "tree" || restored.fingerprint !== expected) throw new Error("skill_recovery_mismatch");
        changed = true;
        if (staging === "complete") staging = "absent"; else backup = { state: "absent" };
      }
    }
    if (backup.state === "tree") { await this.discardBackup(names, backup, parent, ownership); changed = true; }
    if (staging !== "absent") {
      healthy(ownership);
      await removeEntries(names.staging, parent, ownership);
      changed = true;
    }
    return changed ? "recovered" : "settled";
  }
}

function healthy(ownership: OwnershipAccess): void { ownership.assertHealthy?.(); }

/** The owned form of a record, without the replaced fingerprint of a finished update. */
function ownedRecord(record: OwnershipRecord, fingerprint: string): OwnershipRecord {
  return { target: record.target, fingerprint, previous: record.previous, phase: "owned", transactionId: record.transactionId };
}

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
async function inspectSlot(path: string, linkTarget?: string): Promise<Slot> {
  try {
    await safeParents(dirname(path));
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      return linkTarget !== undefined && await realpath(path).then((target) => target === linkTarget, () => false) ? { state: "linked" } : { state: "divergent" };
    }
    if (!info.isDirectory()) return { state: "divergent" };
    // Hidden entries are operator content: setup never writes them, and the fingerprint would not protect them.
    const tree = await readSkillTree(path, { hidden: "reject" });
    const after = await lstat(path);
    if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== info.dev || after.ino !== info.ino) return { state: "divergent" };
    return { state: "tree", fingerprint: tree.fingerprint, dev: info.dev, ino: info.ino };
  } catch (error) { return { state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "divergent" }; }
}
async function sameSlot(path: string, expected: Slot, linkTarget?: string): Promise<boolean> {
  const actual = await inspectSlot(path, linkTarget);
  return expected.state === "absent" ? actual.state === "absent" :
    expected.state === "tree" && actual.state === "tree" && actual.fingerprint === expected.fingerprint && actual.dev === expected.dev && actual.ino === expected.ino;
}
async function present(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/**
 * The regular files and directories (relative, `/` separated) below a directory, or undefined
 * unless it is a real directory with only regular files and directories, no hidden entry, and
 * within the tree limits. A link or special file is never followed or counted as plain.
 */
async function collectPlain(root: string): Promise<{ readonly files: string[]; readonly directories: string[] } | undefined> {
  const files: string[] = []; const directories: string[] = [];
  let bytes = 0; let entries = 0;
  const visit = async (current: string, prefix: string, depth: number): Promise<boolean> => {
    if (depth > MAX_TREE_DEPTH) return false;
    for (const entry of await readdir(current)) {
      if (entry.startsWith(".") || ++entries > MAX_TREE_ENTRIES) return false;
      const path = join(current, entry); const relative = prefix === "" ? entry : `${prefix}/${entry}`;
      const info = await lstat(path);
      if (info.isDirectory()) { directories.push(relative); if (!await visit(path, relative, depth + 1)) return false; continue; }
      if (!info.isFile()) return false;
      bytes += info.size;
      if (files.length + 1 > MAX_SKILL_TREE_FILES || bytes > MAX_SKILL_TREE_BYTES) return false;
      files.push(relative);
    }
    return true;
  };
  try {
    const info = await lstat(root);
    return info.isDirectory() && await visit(root, "", 0) ? { files, directories } : undefined;
  } catch { return undefined; }
}

/**
 * How a staging directory of the pending record relates to its target: `complete` (its tree
 * equals the target fingerprint), `partial` (an interrupted write: every entry is a regular file
 * of the target tree whose content equals that file or a prefix of it, or a directory on the path
 * of one, checked only against the current library tree when it is the record's target),
 * `absent`, or `foreign`, which is never deleted.
 */
async function classifyStaging(staging: string, target: string, library: SkillTree | undefined): Promise<"absent" | "complete" | "partial" | "foreign"> {
  const staged = await inspectSlot(staging);
  if (staged.state === "absent") return "absent";
  if (staged.state === "tree" && staged.fingerprint === target) return "complete";
  if (!library || library.fingerprint !== target) return "foreign";
  const plain = await collectPlain(staging);
  if (!plain) return "foreign";
  const expected = new Map(library.files.map((file) => [file.path, file.bytes]));
  const ancestors = new Set<string>();
  for (const file of library.files) for (let cursor = posix.dirname(file.path); cursor !== "."; cursor = posix.dirname(cursor)) ancestors.add(cursor);
  if (!plain.directories.every((directory) => ancestors.has(directory))) return "foreign";
  for (const file of plain.files) {
    const bytes = expected.get(file);
    if (!bytes) return "foreign";
    const content = await readFile(join(staging, ...file.split("/")));
    if (content.length > bytes.length || !bytes.subarray(0, content.length).equals(content)) return "foreign";
  }
  return "partial";
}

/** Removes a verified directory entry by entry and then itself, with directory fsyncs, so a crash leaves a smaller partial tree. */
async function removeEntries(directory: string, parent: string, ownership: OwnershipAccess, afterEntry?: () => Promise<void>): Promise<void> {
  for (const entry of await readdir(directory)) {
    healthy(ownership); await rm(join(directory, entry), { recursive: true }); healthy(ownership);
    await syncDirectory(directory);
    await afterEntry?.();
  }
  healthy(ownership); await rmdir(directory); healthy(ownership);
  await syncDirectory(parent); healthy(ownership);
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

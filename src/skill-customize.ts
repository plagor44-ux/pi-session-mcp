import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { acquireOverrideLock, OverrideLockError, type OverrideLockOptions } from "./override-lock.js";
import { result, type SetupFinding, type SetupResult, type SetupStatus, type SetupTarget } from "./setup-result.js";
import {
  LEGACY_SKILL_TREE_FINGERPRINT_PATTERN, readSkillTree, releasedSkillFingerprint, shippedSkillsDirectory, SKILL_NAME_PATTERN, SKILL_TREE_FINGERPRINT_PATTERN,
  SkillTreeError, skillOverrideDirectory, type ReleasedSkillTree, type SkillTree,
} from "./skill-library.js";

/**
 * `--customize-skill <name>`: copies a shipped skill into the operator's override directory as a
 * starting point, and records the shipped fingerprint it was based on. The operator's files are
 * never overwritten or edited; a changed original is only reported and acknowledged by moving
 * the recorded base. Reports carry the skill name and a code, never a path or file content.
 *
 * Applying is a cross-process transaction: everything from reading the bases file to replacing it
 * runs under the kernel lock of `override-lock.ts`, so two runs for different skills cannot lose
 * each other's base. A dry run takes no lock and writes nothing.
 */

export const SKILL_BASES_FILE = ".pi-session-mcp-bases.json";
export const MAX_SKILL_BASES_BYTES = 64 * 1024;
/** Written by this version; version 1 (0.8.0) holds only legacy fingerprints and is still read. */
const BASES_SCHEMA_VERSION = 2;

export class SkillBasesError extends Error {
  constructor() {
    super("Skill bases file is not usable");
    this.name = "SkillBasesError";
  }
}

/** Per skill, a version 2 fingerprint or a legacy (version 1) one that could not be migrated. */
export type SkillBases = Readonly<Record<string, string>>;

/** Strictly validated contents of the bases file; an absent file or override directory is an empty record. */
export async function readSkillBases(overrideDirectory: string): Promise<SkillBases> {
  const path = join(overrideDirectory, SKILL_BASES_FILE);
  let text: string;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > MAX_SKILL_BASES_BYTES) throw new SkillBasesError();
    const bytes = await readFile(path);
    if (bytes.length > MAX_SKILL_BASES_BYTES) throw new SkillBasesError();
    text = bytes.toString("utf8");
  } catch (error) {
    if (error instanceof SkillBasesError) throw error;
    if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") return Object.freeze({});
    throw new SkillBasesError();
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new SkillBasesError(); }
  if (!isPlainObject(parsed) || Object.keys(parsed).sort().join() !== "bases,schemaVersion") throw new SkillBasesError();
  const version = parsed.schemaVersion;
  if (version !== 1 && version !== BASES_SCHEMA_VERSION) throw new SkillBasesError();
  const bases = parsed.bases;
  if (!isPlainObject(bases)) throw new SkillBasesError();
  const entries = Object.entries(bases);
  const validValue = (value: unknown): value is string =>
    typeof value === "string" && (LEGACY_SKILL_TREE_FINGERPRINT_PATTERN.test(value) || (version === BASES_SCHEMA_VERSION && SKILL_TREE_FINGERPRINT_PATTERN.test(value)));
  if (!entries.every(([name, value]) => SKILL_NAME_PATTERN.test(name) && validValue(value))) throw new SkillBasesError();
  return Object.freeze(Object.fromEntries(entries) as Record<string, string>);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

/**
 * Atomic replacement: a private temporary file in the same directory, fsynced, then a rename and a
 * directory fsync. Every provable legacy entry is migrated to its version 2 value on the way; an
 * entry that no released tree names stays verbatim. A failure before the rename leaves the
 * previous file untouched.
 */
async function writeSkillBases(overrideDirectory: string, bases: SkillBases, released: readonly ReleasedSkillTree[] | undefined, beforeRename: (() => Promise<void> | void) | undefined): Promise<void> {
  const migrated = Object.entries(bases).map(([name, value]): [string, string] =>
    [name, LEGACY_SKILL_TREE_FINGERPRINT_PATTERN.test(value) ? releasedSkillFingerprint(name, value, released) ?? value : value]);
  const sorted = Object.fromEntries(migrated.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
  const content = Buffer.from(`${JSON.stringify({ schemaVersion: BASES_SCHEMA_VERSION, bases: sorted })}\n`, "utf8");
  if (content.length > MAX_SKILL_BASES_BYTES) throw new SkillBasesError();
  const temporary = join(overrideDirectory, `.${SKILL_BASES_FILE.slice(1)}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    try { await handle.writeFile(content); await handle.sync(); }
    finally { await handle.close(); }
    await beforeRename?.();
    await rename(temporary, join(overrideDirectory, SKILL_BASES_FILE));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await syncDirectory(overrideDirectory);
}

export interface SkillCustomizeRequest {
  readonly name: string;
  readonly configPath: string;
  readonly apply: boolean;
  /** Package root that holds the shipped `skills/` directory; defaults to this package. */
  readonly packageRoot?: string;
}

/** Injection points for tests; production callers pass none. */
export interface SkillCustomizeDependencies {
  /** Reference trees that resolve legacy bases; defaults to the released shipped skills. */
  readonly released?: readonly ReleasedSkillTree[];
  /** Lock acquisition bound and platform seams. */
  readonly lock?: OverrideLockOptions;
  /** Runs while the lock is held, before the bases file is read. */
  readonly afterLock?: () => Promise<void> | void;
  /** Runs while the lock is held, after the new bases content is durable and before it replaces the old file. */
  readonly beforeBasesRename?: () => Promise<void> | void;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function report(request: SkillCustomizeRequest, status: SetupStatus, code: string): SetupResult {
  // The name is echoed only when it is a valid skill name, so arbitrary input never reaches a report.
  const alias = SKILL_NAME_PATTERN.test(request.name) ? request.name : "invalid";
  const target: SetupTarget = { client: "skills", scope: "override", alias };
  const finding: SetupFinding = { target, status, code };
  // A planned change reports `planned` overall, like a registration dry-run.
  return result(request.apply ? "apply" : "dry-run", [finding], status === "planned" ? "planned" : undefined);
}

/** What one run does for a skill: nothing, copy the shipped tree and record it, or only record the base. */
type Decision =
  | { readonly kind: "failed"; readonly code: string }
  | { readonly kind: "current" }
  | { readonly kind: "copy" | "record"; readonly planned: string; readonly applied: string };

const OUTDATED: Decision = Object.freeze({ kind: "record", planned: "skill_override_outdated", applied: "skill_base_updated" });

/** Pure with respect to the library: reads the override tree, never changes anything. */
async function decide(name: string, overridePath: string, shipped: SkillTree, bases: SkillBases, released: readonly ReleasedSkillTree[] | undefined): Promise<Decision> {
  try { if (!(await lstat(overridePath)).isDirectory()) return { kind: "failed", code: "skill_override_invalid" }; }
  catch (error) {
    if (!isMissing(error)) throw error;
    return { kind: "copy", planned: "skill_customize_planned", applied: "skill_customized" };
  }
  let override: SkillTree;
  try { override = await readSkillTree(overridePath); }
  catch (error) {
    if (error instanceof SkillTreeError) return { kind: "failed", code: "skill_override_invalid" };
    throw error;
  }
  const base = Object.hasOwn(bases, name) ? bases[name] : undefined;
  // Without a base an identical override is a customization whose bases commit failed earlier.
  if (base === undefined) return override.fingerprint === shipped.fingerprint ? { kind: "record", planned: "skill_customize_planned", applied: "skill_customized" } : OUTDATED;
  if (SKILL_TREE_FINGERPRINT_PATTERN.test(base)) return base === shipped.fingerprint ? { kind: "current" } : OUTDATED;
  // A legacy base only names a released original when a trusted reference tree has that value.
  const original = releasedSkillFingerprint(name, base, released);
  if (original === undefined) return { kind: "record", planned: "skill_base_unverified", applied: "skill_base_updated" };
  return original === shipped.fingerprint ? { kind: "record", planned: "skill_base_migration_planned", applied: "skill_base_migrated" } : OUTDATED;
}

export async function customizeSkill(request: SkillCustomizeRequest, dependencies: SkillCustomizeDependencies = {}): Promise<SetupResult> {
  const done = (status: SetupStatus, code: string): SetupResult => report(request, status, code);
  if (!SKILL_NAME_PATTERN.test(request.name)) return done("failed", "skill_not_shipped");
  try {
    const shippedDirectory = join(shippedSkillsDirectory(request.packageRoot), request.name);
    let shipped: SkillTree;
    try { shipped = await readSkillTree(shippedDirectory); }
    catch (error) {
      if (error instanceof SkillTreeError && error.code === "skill_tree_missing") return done("failed", "skill_not_shipped");
      return done("failed", "skill_customize_failed");
    }
    const overrideDirectory = skillOverrideDirectory(request.configPath);
    const overridePath = join(overrideDirectory, request.name);
    const read = async (): Promise<SkillBases | undefined> => {
      try { return await readSkillBases(overrideDirectory); }
      catch (error) {
        if (error instanceof SkillBasesError) return undefined;
        throw error;
      }
    };
    if (!request.apply) {
      // No lock and no write: the report is a snapshot of what an apply would decide.
      const bases = await read();
      if (bases === undefined) return done("failed", "skill_bases_corrupt");
      const decision = await decide(request.name, overridePath, shipped, bases, dependencies.released);
      if (decision.kind === "failed") return done("failed", decision.code);
      return decision.kind === "current" ? done("unchanged", "skill_override_current") : done("planned", decision.planned);
    }
    await mkdir(overrideDirectory, { recursive: true, mode: 0o700 });
    let lock;
    try { lock = await acquireOverrideLock(overrideDirectory, dependencies.lock); }
    catch (error) {
      if (error instanceof OverrideLockError) return done("failed", error.code === "override_lock_busy" ? "skill_customize_lock_busy" : "skill_customize_lock_unavailable");
      throw error;
    }
    try {
      await dependencies.afterLock?.();
      // Read only now: a snapshot from before the lock may miss a base another run just wrote.
      const bases = await read();
      if (bases === undefined) return done("failed", "skill_bases_corrupt");
      const decision = await decide(request.name, overridePath, shipped, bases, dependencies.released);
      if (decision.kind === "failed") return done("failed", decision.code);
      if (decision.kind === "current") return done("unchanged", "skill_override_current");
      if (decision.kind === "copy") await copyShippedSkill(shipped.files, overrideDirectory, overridePath, request.name);
      await writeSkillBases(overrideDirectory, { ...bases, [request.name]: shipped.fingerprint }, dependencies.released, dependencies.beforeBasesRename);
      return done("ok", decision.applied);
    } finally { await lock.release(); }
  } catch {
    return done("failed", "skill_customize_failed");
  }
}

async function copyShippedSkill(files: readonly { readonly path: string; readonly bytes: Buffer }[], overrideDirectory: string, overridePath: string, name: string): Promise<void> {
  const temporary = join(overrideDirectory, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await mkdir(temporary, { mode: 0o755 });
    for (const file of files) {
      const destination = join(temporary, ...file.path.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      const handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
      try { await handle.writeFile(file.bytes); await handle.sync(); }
      finally { await handle.close(); }
    }
    // Every directory entry of the temporary tree is durable before the rename and the bases commit.
    const directories = new Set<string>([temporary]);
    for (const file of files) {
      let cursor = dirname(join(temporary, ...file.path.split("/")));
      while (cursor !== temporary) { directories.add(cursor); cursor = dirname(cursor); }
    }
    for (const directory of [...directories].sort((left, right) => right.length - left.length)) await syncDirectory(directory);
    // The override must not appear while the copy runs, and an operator's directory is never replaced.
    if (await lstat(overridePath).then(() => true, (error: unknown) => { if (isMissing(error)) return false; throw error; })) throw new Error("override appeared");
    await rename(temporary, overridePath);
    await syncDirectory(overrideDirectory);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

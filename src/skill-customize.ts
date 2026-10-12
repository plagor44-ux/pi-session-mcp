import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { result, type SetupFinding, type SetupResult, type SetupStatus, type SetupTarget } from "./setup-result.js";
import { readSkillTree, shippedSkillsDirectory, SKILL_NAME_PATTERN, SkillTreeError, skillOverrideDirectory } from "./skill-library.js";

/**
 * `--customize-skill <name>`: copies a shipped skill into the operator's override directory as a
 * starting point, and records the shipped fingerprint it was based on. The operator's files are
 * never overwritten or edited; a changed original is only reported and acknowledged by moving
 * the recorded base. Reports carry the skill name and a code, never a path or file content.
 */

export const SKILL_BASES_FILE = ".pi-session-mcp-bases.json";
export const MAX_SKILL_BASES_BYTES = 64 * 1024;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

export class SkillBasesError extends Error {
  constructor() {
    super("Skill bases file is not usable");
    this.name = "SkillBasesError";
  }
}

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
  if (!isPlainObject(parsed) || Object.keys(parsed).sort().join() !== "bases,schemaVersion" || parsed.schemaVersion !== 1) throw new SkillBasesError();
  const bases = parsed.bases;
  if (!isPlainObject(bases)) throw new SkillBasesError();
  const entries = Object.entries(bases);
  if (!entries.every(([name, value]) => SKILL_NAME_PATTERN.test(name) && typeof value === "string" && FINGERPRINT_PATTERN.test(value))) throw new SkillBasesError();
  return Object.freeze(Object.fromEntries(entries) as Record<string, string>);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** Atomic replacement: a private temporary file in the same directory, then a rename. */
async function writeSkillBases(overrideDirectory: string, bases: SkillBases): Promise<void> {
  const sorted = Object.fromEntries(Object.entries(bases).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
  const content = Buffer.from(`${JSON.stringify({ schemaVersion: 1, bases: sorted })}\n`, "utf8");
  if (content.length > MAX_SKILL_BASES_BYTES) throw new SkillBasesError();
  const temporary = join(overrideDirectory, `.${SKILL_BASES_FILE.slice(1)}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    try { await handle.writeFile(content); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, join(overrideDirectory, SKILL_BASES_FILE));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export interface SkillCustomizeRequest {
  readonly name: string;
  readonly configPath: string;
  readonly apply: boolean;
  /** Package root that holds the shipped `skills/` directory; defaults to this package. */
  readonly packageRoot?: string;
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

export async function customizeSkill(request: SkillCustomizeRequest): Promise<SetupResult> {
  const done = (status: SetupStatus, code: string): SetupResult => report(request, status, code);
  if (!SKILL_NAME_PATTERN.test(request.name)) return done("failed", "skill_not_shipped");
  try {
    const shippedDirectory = join(shippedSkillsDirectory(request.packageRoot), request.name);
    let shipped;
    try { shipped = await readSkillTree(shippedDirectory); }
    catch (error) {
      if (error instanceof SkillTreeError && error.code === "skill_tree_missing") return done("failed", "skill_not_shipped");
      return done("failed", "skill_customize_failed");
    }
    const overrideDirectory = skillOverrideDirectory(request.configPath);
    let bases: SkillBases;
    try { bases = await readSkillBases(overrideDirectory); }
    catch (error) {
      if (error instanceof SkillBasesError) return done("failed", "skill_bases_corrupt");
      throw error;
    }
    const overridePath = join(overrideDirectory, request.name);
    let exists = true;
    try {
      const info = await lstat(overridePath);
      if (!info.isDirectory()) return done("failed", "skill_override_invalid");
    } catch (error) {
      if (!isMissing(error)) throw error;
      exists = false;
    }
    if (!exists) {
      if (!request.apply) return done("planned", "skill_customize_planned");
      await copyShippedSkill(shipped.files, overrideDirectory, overridePath, request.name);
      await writeSkillBases(overrideDirectory, { ...bases, [request.name]: shipped.fingerprint });
      return done("ok", "skill_customized");
    }
    try { await readSkillTree(overridePath); }
    catch (error) {
      if (error instanceof SkillTreeError) return done("failed", "skill_override_invalid");
      throw error;
    }
    if (bases[request.name] === shipped.fingerprint) return done("unchanged", "skill_override_current");
    if (!request.apply) return done("planned", "skill_override_outdated");
    // Only the recorded base moves: it acknowledges that the operator reviewed the changed original.
    await writeSkillBases(overrideDirectory, { ...bases, [request.name]: shipped.fingerprint });
    return done("ok", "skill_base_updated");
  } catch {
    return done("failed", "skill_customize_failed");
  }
}

async function copyShippedSkill(files: readonly { readonly path: string; readonly bytes: Buffer }[], overrideDirectory: string, overridePath: string, name: string): Promise<void> {
  await mkdir(overrideDirectory, { recursive: true, mode: 0o700 });
  const temporary = join(overrideDirectory, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await mkdir(temporary, { mode: 0o755 });
    for (const file of files) {
      const destination = join(temporary, ...file.path.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, file.bytes, { flag: "wx", mode: 0o644 });
    }
    // The override must not appear while the copy runs, and an operator's directory is never replaced.
    if (await lstat(overridePath).then(() => true, (error: unknown) => { if (isMissing(error)) return false; throw error; })) throw new Error("override appeared");
    await rename(temporary, overridePath);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

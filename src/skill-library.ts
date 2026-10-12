import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The skill library: skills shipped in the package's `skills/` directory, and the operator's
 * override directory `skills/` next to the configuration file. An override with the same name
 * replaces the shipped skill; a new name adds a skill. Nothing else is searched.
 */

/** Agent Skills name rule: lowercase letters and digits in hyphen-separated groups, 1 to 64 characters. */
export const SKILL_NAME_PATTERN = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A `skillCatalog` value `builtin:<name>` names a library skill instead of a path. */
export const BUILTIN_SKILL_PREFIX = "builtin:";
/** Skills for the controlling agent, which setup installs into Claude Code and Codex. */
export const CONTROLLER_SKILLS: readonly string[] = Object.freeze(["pi-session-orchestration"]);
export const MAX_SKILL_TREE_FILES = 32;
export const MAX_SKILL_TREE_BYTES = 1024 * 1024;
const MAX_SKILL_TREE_DEPTH = 8;

/** `dist/`, `.pi-session-mcp-cli/` and `src/` all sit one level below the package root. */
export const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

export function shippedSkillsDirectory(packageRoot: string = PACKAGE_ROOT): string {
  return join(packageRoot, "skills");
}

/** The override directory belongs to the configuration, never to a workspace or the shell's directory. */
export function skillOverrideDirectory(configPath: string): string {
  return join(dirname(resolve(configPath)), "skills");
}

export interface LibrarySkill {
  readonly name: string;
  readonly source: "override" | "shipped";
  /** Absolute directory that holds the skill's `SKILL.md`. Internal; never reported. */
  readonly directory: string;
}

export interface LibraryRoots {
  readonly overrideDirectory: string;
  readonly packageRoot?: string;
}

function isRegularFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/** The override wins over the shipped skill of the same name; undefined when neither exists. */
export function resolveLibrarySkill(name: string, roots: LibraryRoots): LibrarySkill | undefined {
  if (!SKILL_NAME_PATTERN.test(name)) return undefined;
  const override = join(roots.overrideDirectory, name);
  if (isRegularFile(join(override, "SKILL.md"))) return Object.freeze({ name, source: "override", directory: override });
  const shipped = join(shippedSkillsDirectory(roots.packageRoot), name);
  if (isRegularFile(join(shipped, "SKILL.md"))) return Object.freeze({ name, source: "shipped", directory: shipped });
  return undefined;
}

/** The `SKILL.md` a `builtin:<name>` catalog value stands for; a missing skill keeps the shipped location. */
export function builtinSkillPath(name: string, roots: LibraryRoots): string {
  const skill = resolveLibrarySkill(name, roots);
  return join(skill?.directory ?? join(shippedSkillsDirectory(roots.packageRoot), name), "SKILL.md");
}

export interface SkillTreeFile {
  /** Path relative to the skill directory, with `/` separators. */
  readonly path: string;
  readonly bytes: Buffer;
}

export interface SkillTree {
  readonly files: readonly SkillTreeFile[];
  /** SHA-256 hex over the sorted relative paths and contents; path-free and stable. */
  readonly fingerprint: string;
}

export class SkillTreeError extends Error {
  constructor(readonly code: "skill_tree_missing" | "skill_tree_invalid" | "skill_tree_too_large") {
    super("Skill directory is not usable");
    this.name = "SkillTreeError";
  }
}

/**
 * Reads the regular files below a skill directory in a stable order. Entries whose name starts
 * with `.` are skipped. A symbolic link or special file inside the tree, a missing `SKILL.md`,
 * or more than the file and byte limits fail, so the tree can be copied and compared exactly.
 */
export async function readSkillTree(directory: string): Promise<SkillTree> {
  let root: string;
  try { root = await realpath(directory); }
  catch { throw new SkillTreeError("skill_tree_missing"); }
  const files: SkillTreeFile[] = [];
  let bytes = 0;
  const visit = async (current: string, prefix: string, depth: number): Promise<void> => {
    if (depth > MAX_SKILL_TREE_DEPTH) throw new SkillTreeError("skill_tree_invalid");
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch { throw new SkillTreeError("skill_tree_invalid"); }
    for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
      if (entry.name.startsWith(".")) continue;
      const path = join(current, entry.name);
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const info = await lstat(path);
      if (info.isDirectory()) { await visit(path, relativePath, depth + 1); continue; }
      if (!info.isFile()) throw new SkillTreeError("skill_tree_invalid");
      if (files.length + 1 > MAX_SKILL_TREE_FILES || bytes + info.size > MAX_SKILL_TREE_BYTES) throw new SkillTreeError("skill_tree_too_large");
      const content = await readFile(path);
      // Counted as read, so a file that grew after lstat cannot pass the limit.
      bytes += content.length;
      if (bytes > MAX_SKILL_TREE_BYTES) throw new SkillTreeError("skill_tree_too_large");
      files.push(Object.freeze({ path: relativePath, bytes: content }));
    }
  };
  await visit(root, "", 0);
  if (!files.some((file) => file.path === "SKILL.md")) throw new SkillTreeError("skill_tree_missing");
  const hash = createHash("sha256");
  for (const file of files) hash.update(file.path).update("\0").update(file.bytes).update("\0");
  return Object.freeze({ files: Object.freeze(files), fingerprint: hash.digest("hex") });
}

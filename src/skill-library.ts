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
  return shippedLibrarySkill(name, roots.packageRoot);
}

/** The shipped skill of that name, whatever overrides exist; undefined when the package ships none. */
export function shippedLibrarySkill(name: string, packageRoot?: string): LibrarySkill | undefined {
  if (!SKILL_NAME_PATTERN.test(name)) return undefined;
  const shipped = join(shippedSkillsDirectory(packageRoot), name);
  return isRegularFile(join(shipped, "SKILL.md")) ? Object.freeze({ name, source: "shipped", directory: shipped }) : undefined;
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
  /** Version 2 fingerprint (`v2:` and SHA-256 hex) of the paths and contents; path-free and stable. */
  readonly fingerprint: string;
  /**
   * The version 1 fingerprint that 0.8.0 recorded, only to recognize such records. It is
   * ambiguous and never proves identity on its own; see `provesLegacyFingerprint`.
   */
  readonly legacyFingerprint: string;
}

export class SkillTreeError extends Error {
  constructor(readonly code: "skill_tree_missing" | "skill_tree_invalid" | "skill_tree_too_large") {
    super("Skill directory is not usable");
    this.name = "SkillTreeError";
  }
}

/** A version 2 skill tree fingerprint as it is stored. */
export const SKILL_TREE_FINGERPRINT_PATTERN = /^v2:[0-9a-f]{64}$/;
/** A version 1 fingerprint as 0.8.0 stored it: bare SHA-256 hex. */
export const LEGACY_SKILL_TREE_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const FINGERPRINT_DOMAIN = "pi-session-mcp skill tree v2\n";

function uint32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function uint64(value: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

/**
 * Version 2: a domain and version tag, the file count, then per file in byte order of the path
 * the length-prefixed UTF-8 path and the length-prefixed content. Every field has an explicit
 * length, so two different trees never share an encoding.
 */
export function skillTreeFingerprint(files: readonly SkillTreeFile[]): string {
  const entries = files.map((file) => ({ path: Buffer.from(file.path, "utf8"), bytes: file.bytes }))
    .sort((left, right) => Buffer.compare(left.path, right.path));
  const hash = createHash("sha256").update(FINGERPRINT_DOMAIN, "utf8").update(uint32(entries.length));
  entries.forEach((entry, index) => {
    if (index > 0 && Buffer.compare(entries[index - 1]!.path, entry.path) === 0) throw new SkillTreeError("skill_tree_invalid");
    hash.update(uint32(entry.path.length)).update(entry.path).update(uint64(entry.bytes.length)).update(entry.bytes);
  });
  return `v2:${hash.digest("hex")}`;
}

/**
 * Version 1, as 0.8.0 computed it: `path NUL content NUL` per file in reading order. File
 * content may contain NUL bytes, so two different trees can share this value.
 */
export function legacySkillTreeFingerprint(files: readonly SkillTreeFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) hash.update(file.path).update("\0").update(file.bytes).update("\0");
  return hash.digest("hex");
}

export interface ReleasedSkillTree {
  readonly name: string;
  readonly release: string;
  readonly legacyFingerprint: string;
  readonly fingerprint: string;
}

/**
 * The shipped skills of every release that recorded version 1 fingerprints (0.8.0 only), as
 * trusted references for recognizing such records. Computed from the `v0.8.0` tag and checked
 * against the published npm package.
 */
export const RELEASED_SKILL_TREES: readonly ReleasedSkillTree[] = Object.freeze([
  Object.freeze({ name: "pi-session-orchestration", release: "0.8.0", legacyFingerprint: "e2a72b558ea14748a4badd0058ff65b8731cc125033a666706b103842784673a", fingerprint: "v2:39edc4c4783dec7f90345b22844a17e5e48b465722bb0f1b20059d6ee51e1523" }),
  Object.freeze({ name: "pi-session-implementation", release: "0.8.0", legacyFingerprint: "5f719b44da266d3f66dd5bf3c18f3e3e04ca7df357e2fe2eedbf0409e6c1bf64", fingerprint: "v2:f8ce75eff83a5c952f6ca51c04e1e8025cb7c2c558c30d692f291a3f6594eb12" }),
  Object.freeze({ name: "pi-session-review", release: "0.8.0", legacyFingerprint: "8cf58ccb8d473a3eedf12ce6b902b1e91dd9e2fef83ad110c4d8e2e6164cb257", fingerprint: "v2:610c0b4829eeb1ce6c9b2000ad73f8e88ca230707eef7f7b1708a80767952bf0" }),
]);

/**
 * Whether a version 1 fingerprint from a record proves that `candidate` is the tree it names:
 * a trusted reference, a released shipped tree of this name or one of `references` (such as
 * the current library tree), has exactly this version 1 fingerprint and is byte-identical to
 * `candidate` by its version 2 fingerprint. The version 1 fingerprint alone never suffices.
 */
export function provesLegacyFingerprint(
  name: string,
  legacyFingerprint: string,
  candidate: Pick<SkillTree, "fingerprint">,
  references: readonly Pick<SkillTree, "fingerprint" | "legacyFingerprint">[] = [],
  released: readonly ReleasedSkillTree[] = RELEASED_SKILL_TREES,
): boolean {
  if (!LEGACY_SKILL_TREE_FINGERPRINT_PATTERN.test(legacyFingerprint) || !SKILL_TREE_FINGERPRINT_PATTERN.test(candidate.fingerprint)) return false;
  const trusted = [...released.filter((tree) => tree.name === name), ...references];
  return trusted.some((tree) => tree.legacyFingerprint === legacyFingerprint && tree.fingerprint === candidate.fingerprint);
}

/**
 * The version 2 fingerprint of the released shipped skill that a version 1 fingerprint names,
 * or undefined. Only released trees qualify: the current shipped tree could share a version 1
 * fingerprint with an older original without being that original.
 */
export function releasedSkillFingerprint(name: string, legacyFingerprint: string, released: readonly ReleasedSkillTree[] = RELEASED_SKILL_TREES): string | undefined {
  return released.find((tree) => tree.name === name && tree.legacyFingerprint === legacyFingerprint)?.fingerprint;
}

export interface ReadSkillTreeOptions {
  /**
   * `skip` (default) ignores entries whose name starts with `.`, as for a source tree. `reject`
   * fails on them, for an installed copy: setup never writes hidden entries, so one there is
   * operator content that a fingerprint over the visible files would not protect.
   */
  readonly hidden?: "skip" | "reject";
}

/**
 * Reads the regular files below a skill directory in a stable order. Entries whose name starts
 * with `.` are skipped or rejected (see options). A symbolic link or special file inside the
 * tree, a missing `SKILL.md`, or more than the file and byte limits fail, so the tree can be
 * copied and compared exactly.
 */
export async function readSkillTree(directory: string, options: ReadSkillTreeOptions = {}): Promise<SkillTree> {
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
      if (entry.name.startsWith(".")) {
        if (options.hidden === "reject") throw new SkillTreeError("skill_tree_invalid");
        continue;
      }
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
  return Object.freeze({ files: Object.freeze(files), fingerprint: skillTreeFingerprint(files), legacyFingerprint: legacySkillTreeFingerprint(files) });
}

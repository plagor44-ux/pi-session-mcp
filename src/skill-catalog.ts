import { BUILTIN_SKILL_PREFIX, SKILL_NAME_PATTERN } from "./skill-library.js";

/**
 * A catalog skill that an execution profile selects. The alias is the only public name;
 * the path stays inside the server and never appears in MCP output, errors or diagnostics.
 */
export interface SkillSelection {
  /** The operator's `skillCatalog` alias. Path-free; it may differ from the skill's own name. */
  readonly alias: string;
  /** Absolute path of the selected `SKILL.md`, resolved against the configuration file's directory. */
  readonly path: string;
}

export const MAX_SKILL_CATALOG_ENTRIES = 64;
export const MAX_PROFILE_SKILLS = 16;
export const MAX_SKILL_PATH_LENGTH = 4096;
/** Upper bound for one selected `SKILL.md`, checked before the Pi SDK reads it. */
export const MAX_SKILL_FILE_BYTES = 256 * 1024;
export const SKILL_FILE_NAME = "SKILL.md";

/** `npm:`, `git+ssh:`, `https:`, `file:` and any other scheme-prefixed source. */
const SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const GLOB_CHARACTERS = /[*?[\]{}]/;

/** The library skill name of a `builtin:<name>` catalog value; undefined for every other value. */
export function builtinSkillName(value: string): string | undefined {
  if (!value.startsWith(BUILTIN_SKILL_PREFIX)) return undefined;
  const name = value.slice(BUILTIN_SKILL_PREFIX.length);
  return SKILL_NAME_PATTERN.test(name) ? name : undefined;
}

/**
 * Whether a configured catalog value names exactly one local `SKILL.md`: its last path segment
 * is `SKILL.md`, and it is no URL or other scheme-prefixed source, no `~` home shorthand, no
 * glob and no Windows-style path. So it can never stand for a directory, a pattern or a
 * remote source. Relative values are resolved later against the configuration file's directory.
 * The one scheme-prefixed form accepted is `builtin:<name>`, which names a library skill.
 */
export function isSkillCatalogPath(value: string): boolean {
  if (value.length === 0 || value.length > MAX_SKILL_PATH_LENGTH) return false;
  if (value.includes("\0") || value.includes("\\") || value.startsWith("~")) return false;
  if (builtinSkillName(value) !== undefined) return true;
  if (SCHEME_PREFIX.test(value) || GLOB_CHARACTERS.test(value)) return false;
  return value.split("/").at(-1) === SKILL_FILE_NAME;
}

import { access, readdir, readFile, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  detectSupportedImageMimeTypeFromFile,
  type GrepOperations,
  type LsOperations,
  type ReadOperations,
  type Skill,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

/** Fixed refusal text; it never names the refused path. */
export const OUTSIDE_ROOTS_MESSAGE = "Path is outside the allowed read roots";

/** The read-only built-ins whose definitions this server replaces with confined ones. */
export const CONFINED_TOOL_NAMES: readonly string[] = ["read", "grep", "find", "ls"];

/** What the SDK's `normalizePath` would rewrite before resolving (core/tools/path-utils.js, utils/paths.js). */
const UNICODE_SPACES = /[  -   　]/;

/** Real path of an existing path, or the nearest existing ancestor's real path plus the missing rest. */
async function canonical(path: string): Promise<string> {
  let current = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try { return join(await realpath(current), ...rest.reverse()); } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      rest.push(basename(current));
      current = parent;
    }
  }
}

function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** The allowed read roots: the workspace and the directory of each selected skill file, as real paths. */
export async function allowedReadRoots(workspace: string, skills: readonly Skill[]): Promise<string[]> {
  const roots = new Set<string>([await realpath(workspace)]);
  for (const skill of skills) roots.add(await realpath(dirname(skill.filePath)));
  return [...roots];
}

/**
 * Resolves a tool `path` argument the way the SDK will and checks the canonical result against the
 * roots. Arguments the SDK would rewrite before resolving are refused, so both resolve the same path.
 * Returns the canonical path; a refusal throws a fixed message without the path.
 */
export async function confineToolPath(input: unknown, cwd: string, roots: readonly string[]): Promise<string> {
  const value = input === undefined || input === "" ? "." : input;
  if (typeof value !== "string"
    || value.startsWith("@") || value.startsWith("~") || value.startsWith("file:")
    || value.includes("\0") || UNICODE_SPACES.test(value)) {
    throw new Error(OUTSIDE_ROOTS_MESSAGE);
  }
  const real = await canonical(resolve(cwd, value));
  if (!roots.some((root) => isWithin(real, root))) throw new Error(OUTSIDE_ROOTS_MESSAGE);
  return real;
}

/** The second layer: the absolute path the SDK hands to an operations hook. */
async function checkAbsolute(path: string, roots: readonly string[]): Promise<void> {
  const real = await canonical(path);
  if (!roots.some((root) => isWithin(real, root))) throw new Error(OUTSIDE_ROOTS_MESSAGE);
}

/** The `*Operations` hooks that re-check every absolute path the SDK hands them; exported for tests. */
export function confinedOperations(roots: readonly string[]): { read: ReadOperations; grep: GrepOperations; ls: LsOperations } {
  const guard = async <T>(path: string, run: () => Promise<T>): Promise<T> => { await checkAbsolute(path, roots); return run(); };
  return {
    read: {
      access: (path) => guard(path, () => access(path, constants.R_OK)),
      readFile: (path) => guard(path, () => readFile(path)),
      detectImageMimeType: (path) => guard(path, () => detectSupportedImageMimeTypeFromFile(path)),
    },
    grep: {
      isDirectory: (path) => guard(path, async () => (await stat(path)).isDirectory()),
      readFile: (path) => guard(path, () => readFile(path, "utf-8")),
    },
    ls: {
      exists: (path) => guard(path, async () => { try { await access(path, constants.F_OK); return true; } catch { return false; } }),
      stat: (path) => guard(path, () => stat(path)),
      readdir: (path) => guard(path, () => readdir(path)),
    },
  };
}

/** Runs the root check on `params.path` before the SDK tool executes. */
function confine(definition: ToolDefinition, cwd: string, roots: readonly string[]): ToolDefinition {
  return {
    ...definition,
    execute: async (toolCallId, params, signal, onUpdate, context) => {
      // The SDK resolves against `ctx.cwd || cwd`; resolve the same way.
      await confineToolPath((params as { path?: unknown }).path, context?.cwd || cwd, roots);
      return definition.execute(toolCallId, params, signal, onUpdate, context);
    },
  };
}

/**
 * Definitions named `read`, `grep`, `find` and `ls` that accept only paths below `roots`. Registered as
 * SDK custom tools they replace the built-ins of the same name. `find` has no operations hook that
 * would still cover `fd`, so it relies on the execute wrapper alone.
 */
export function createConfinedReadOnlyTools(cwd: string, roots: readonly string[]): ToolDefinition[] {
  const operations = confinedOperations(roots);
  return [
    confine(createReadToolDefinition(cwd, { operations: operations.read }) as unknown as ToolDefinition, cwd, roots),
    confine(createGrepToolDefinition(cwd, { operations: operations.grep }) as unknown as ToolDefinition, cwd, roots),
    confine(createFindToolDefinition(cwd) as unknown as ToolDefinition, cwd, roots),
    confine(createLsToolDefinition(cwd, { operations: operations.ls }) as unknown as ToolDefinition, cwd, roots),
  ];
}

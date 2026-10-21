import { access, constants, realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";

export interface ToolPaths { strace: string; prlimit: string; git: string; codegraph: string; bwrap: string }
export const TOOL_NAMES = ["strace", "prlimit", "git", "codegraph", "bwrap"] as const;

/** First executable named `name` on `pathEnv`; the result is absolute. Throws `<name>_missing`. */
export async function resolveTool(name: string, pathEnv: string, executable: (path: string) => Promise<boolean> = isExecutable): Promise<string> {
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === "" || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    if (await executable(candidate)) return candidate;
  }
  throw new Error(`${name}_missing`);
}

const isExecutable = (path: string): Promise<boolean> => access(path, constants.X_OK).then(() => true, () => false);

/**
 * Resolves every external tool the supervisor starts to an absolute path, once, from its own PATH (R44), so a PATH entry the worker
 * could influence later can never substitute a tool.
 */
export async function resolveTools(pathEnv = process.env.PATH ?? "", executable?: (path: string) => Promise<boolean>): Promise<ToolPaths> {
  const found = await Promise.all(TOOL_NAMES.map(async (name) => [name, await resolveTool(name, pathEnv, executable)] as const));
  return Object.fromEntries(found) as unknown as ToolPaths;
}

/** The nearest existing ancestor's real path plus the rest, so a not yet created directory is judged by where it will be. */
async function canonical(path: string): Promise<string> {
  let current = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try { return join(await realpath(current), ...rest.reverse()); } catch {
      const parent = resolve(current, "..");
      if (parent === current) return resolve(path);
      rest.push(basename(current));
      current = parent;
    }
  }
}

const within = (inner: string, outer: string): boolean => inner === outer || inner.startsWith(outer.endsWith("/") ? outer : `${outer}/`);

/** Refuses a directory that lies inside a source or contains one, with the fixed `code`. */
export async function assertOutsideSources(dir: string, sources: Iterable<string>, code: string): Promise<void> {
  const real = await canonical(dir);
  for (const source of sources) {
    const repo = await canonical(source);
    if (within(real, repo) || within(repo, real)) throw new Error(code);
  }
}

/** Refuses a wave directory that lies inside a source repository or contains one (R44): scopes and kept records must not mix with sources. */
export const assertWaveDirOutsideSources = (waveDir: string, sources: Iterable<string>): Promise<void> => assertOutsideSources(waveDir, sources, "wave_dir_in_source");

/** Refuses a dependency directory (R68) that lies inside a source repository, the wave directory or contains one: a source checkout must never be reachable through it. */
export const assertDepsDirOutsideSources = (depsDir: string, sources: Iterable<string>): Promise<void> => assertOutsideSources(depsDir, sources, "deps_dir_in_source");

/** The operator's real home from the account database, not from `$HOME`, which a caller's environment could point elsewhere. */
export const realHome = (): string => userInfo().homedir;

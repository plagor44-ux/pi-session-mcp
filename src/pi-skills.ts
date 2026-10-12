import { constants, type Stats } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { loadSkills, type Skill } from "@earendil-works/pi-coding-agent";
import { PiSessionCreationError } from "./pi-adapter.js";
import { MAX_SKILL_FILE_BYTES, type SkillSelection } from "./skill-catalog.js";

export class PiSkillError extends PiSessionCreationError {
  constructor(readonly alias?: string) {
    super("skill_load_failed");
    this.name = "PiSkillError";
  }
}

interface SkillDependencies {
  readonly stat: (path: string) => Promise<Stats>;
  readonly access: (path: string, mode: number) => Promise<void>;
  readonly realpath: (path: string) => Promise<string>;
  readonly loadSkills: typeof loadSkills;
}

/** Load only the configured files, independently of package discovery and SDK deduplication. */
export async function loadSelectedSkills(
  selection: readonly SkillSelection[],
  cwd: string,
  dependencies: Partial<SkillDependencies> = {},
): Promise<Skill[]> {
  if (selection.length === 0) return [];
  const fs = { stat, access, realpath, loadSkills, ...dependencies };
  const paths: string[] = [];
  const canonical = new Set<string>();
  try {
    for (const selected of selection) {
      try {
        const path = resolve(selected.path);
        const info = await fs.stat(path);
        if (!info.isFile() || info.size > MAX_SKILL_FILE_BYTES) throw new PiSkillError(selected.alias);
        await fs.access(path, constants.R_OK);
        const real = await fs.realpath(path);
        if (canonical.has(real)) throw new PiSkillError(selected.alias);
        canonical.add(real);
        paths.push(path);
      } catch {
        throw new PiSkillError(selected.alias);
      }
    }
    const result = fs.loadSkills({ cwd, agentDir: cwd, skillPaths: paths, includeDefaults: false });
    if (result.diagnostics.length > 0) {
      const aliases = new Set(result.diagnostics.map((diagnostic) => {
        const index = paths.indexOf(diagnostic.path ?? "");
        return index < 0 ? undefined : selection[index]!.alias;
      }));
      throw new PiSkillError(aliases.size === 1 ? [...aliases][0] : undefined);
    }
    if (result.skills.length !== paths.length) {
      const missing = selection.filter((_selected, index) => !result.skills.some((skill) => skill.filePath === paths[index]));
      throw new PiSkillError(missing.length === 1 ? missing[0]!.alias : undefined);
    }
    return paths.map((path, index) => {
      const matches = result.skills.filter((skill) => skill.filePath === path);
      if (matches.length !== 1 || matches[0]!.disableModelInvocation === true) throw new PiSkillError(selection[index]!.alias);
      return matches[0]!;
    });
  } catch (error) {
    if (error instanceof PiSkillError) throw error;
    throw new PiSkillError();
  }
}

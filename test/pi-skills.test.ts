import { access, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it, vi } from "vitest";
import { loadSelectedSkills, PiSkillError } from "../src/pi-skills.js";
import { MAX_SKILL_FILE_BYTES } from "../src/skill-catalog.js";
import { createPhase0ResourceLoader } from "../src/sdk-pi-adapter.js";
import { temporaryRoot, removeTemporaryRoots } from "./temporary-roots.js";

const root = fileURLToPath(new URL("./fixtures/pi-skill-fixtures/", import.meta.url));
const selection = (folder: string, alias = "catalog-alias") => ({ alias, path: join(root, folder, "SKILL.md") });
afterAll(removeTemporaryRoots);

describe("selected Pi skills", () => {
  it("returns empty without accessing files or the SDK", async () => {
    const forbidden = vi.fn(() => { throw new Error("must not run"); });
    expect(await loadSelectedSkills([], root, { stat: forbidden, access: forbidden, realpath: forbidden, loadSkills: forbidden })).toEqual([]);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("loads once without defaults and preserves configured order", async () => {
    const sdkLoad = vi.fn(loadSkills);
    const selected = [selection("fixture-beta", "beta"), selection("fixture-alpha", "alpha")];
    const skills = await loadSelectedSkills(selected, root, { loadSkills: sdkLoad });
    expect(skills.map(({ name }) => name)).toEqual(["fixture-beta", "fixture-alpha"]);
    expect(sdkLoad).toHaveBeenCalledExactlyOnceWith({ cwd: root, agentDir: root, skillPaths: selected.map(({ path }) => path), includeDefaults: false });
  });

  it("rejects two aliases on one canonical file itself, without relying on SDK dedupe", async () => {
    const cwd = await temporaryRoot("pi-skill-canonical-");
    const linked = join(cwd, "SKILL.md");
    await symlink(selection("fixture-alpha").path, linked);
    // A loader that keeps both paths, as an SDK without real-path dedupe would.
    const keepsBoth = vi.fn((options: Parameters<typeof loadSkills>[0]) => {
      const [skill] = loadSkills({ ...options, skillPaths: [options.skillPaths[0]!] }).skills;
      return { skills: options.skillPaths.map((filePath) => ({ ...skill!, filePath })), diagnostics: [] };
    });
    await expect(loadSelectedSkills([selection("fixture-alpha", "one"), { alias: "two", path: linked }], cwd, { loadSkills: keepsBoth }))
      .rejects.toMatchObject({ code: "skill_load_failed", alias: "two" });
    expect(keepsBoth).not.toHaveBeenCalled();
  });

  it("returns fresh skill and source-info copies on SDK reload", async () => {
    const cwd = await temporaryRoot("pi-skill-copies-");
    const skills = await loadSelectedSkills([selection("fixture-alpha")], cwd);
    const { resourceLoader } = await createPhase0ResourceLoader(cwd, skills);
    const first = resourceLoader.getSkills().skills[0]!;
    first.name = "changed";
    first.sourceInfo.path = "/private/changed";
    skills[0]!.description = "caller changed";
    await resourceLoader.reload();
    const next = resourceLoader.getSkills().skills[0]!;
    expect(next.name).toBe("fixture-alpha");
    expect(next.description).toBe("SELECTED_ALPHA_DESCRIPTION_SENTINEL");
    expect(next.sourceInfo.path).toBe(selection("fixture-alpha").path);
    expect(next).not.toBe(first);
    expect(next.sourceInfo).not.toBe(first.sourceInfo);
  });

  for (const folder of ["missing", "fixture-invalid", "fixture-explicit"]) {
    it(`rejects ${folder} with a fixed error and catalog alias`, async () => {
      await expect(loadSelectedSkills([selection(folder)], root)).rejects.toMatchObject({
        code: "skill_load_failed", alias: "catalog-alias", message: "Configured Pi skill could not be loaded",
      });
    });
  }

  it("rejects two selected files with the same skill name", async () => {
    await expect(loadSelectedSkills([selection("fixture-alpha", "one"), selection("collision/fixture-alpha", "two")], root)).rejects.toBeInstanceOf(PiSkillError);
  });

  it("follows symlinks and rejects duplicate canonical files", async () => {
    const cwd = await temporaryRoot("pi-skills-");
    const linked = join(cwd, "SKILL.md");
    await symlink(selection("fixture-alpha").path, linked);
    expect((await loadSelectedSkills([{ alias: "linked", path: linked }], cwd))[0]?.filePath).toBe(linked);
    await expect(loadSelectedSkills([selection("fixture-alpha"), { alias: "duplicate", path: linked }], cwd)).rejects.toMatchObject({ alias: "duplicate", code: "skill_load_failed" });
  });

  it("rejects directories, oversized files and inaccessible files before SDK loading", async () => {
    const cwd = await temporaryRoot("pi-skills-");
    const huge = join(cwd, "SKILL.md");
    await writeFile(huge, "x".repeat(MAX_SKILL_FILE_BYTES + 1));
    const sdkLoad = vi.fn(loadSkills);
    for (const path of [cwd, huge]) await expect(loadSelectedSkills([{ alias: "bad", path }], cwd, { loadSkills: sdkLoad })).rejects.toMatchObject({ alias: "bad" });
    await expect(loadSelectedSkills([selection("fixture-alpha")], cwd, {
      access: async () => { throw new Error("PRIVATE_SDK_SENTINEL"); }, loadSkills: sdkLoad,
    })).rejects.toMatchObject({ alias: "catalog-alias" });
    expect(sdkLoad).not.toHaveBeenCalled();
  });

  it("rejects every diagnostic, mismatched results and unexpected SDK exceptions without exposing text", async () => {
    const selected = [selection("fixture-alpha")];
    const valid = loadSkills({ cwd: root, agentDir: root, skillPaths: selected.map(({ path }) => path), includeDefaults: false });
    const results = [
      ...(["warning", "error", "collision"] as const).map((type) => ({ ...valid, diagnostics: [{ type, message: "PRIVATE_SDK_SENTINEL", path: selected[0]!.path }] })),
      { skills: [], diagnostics: [] },
      { ...valid, skills: [...valid.skills, ...valid.skills] },
      { ...valid, skills: valid.skills.map((skill) => ({ ...skill, filePath: "/private/path" })) },
      { ...valid, skills: valid.skills.map((skill) => ({ ...skill, disableModelInvocation: true })) },
    ];
    for (const result of results) {
      await expect(loadSelectedSkills(selected, root, { loadSkills: () => result })).rejects.toMatchObject({ code: "skill_load_failed", message: "Configured Pi skill could not be loaded" });
    }
    await expect(loadSelectedSkills(selected, root, { loadSkills: () => { throw new Error("PRIVATE_SDK_SENTINEL"); } })).rejects.toMatchObject({ code: "skill_load_failed", message: "Configured Pi skill could not be loaded" });
    // The injectable filesystem operations retain their production defaults independently.
    expect(await loadSelectedSkills(selected, root, { stat, access, realpath })).toHaveLength(1);
  });

  it("attributes a silently skipped selected file to its catalog alias", async () => {
    await expect(loadSelectedSkills([selection("fixture-alpha", "alpha-alias"), selection("fixture-beta", "beta-alias")], root, {
      loadSkills: (options) => loadSkills({ ...options, skillPaths: [selection("fixture-alpha").path] }),
    })).rejects.toMatchObject({ code: "skill_load_failed", alias: "beta-alias" });
  });
});

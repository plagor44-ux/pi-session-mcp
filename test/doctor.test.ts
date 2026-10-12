import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";
import { parseExtensionSpec, PiExtensionError } from "../src/extension-spec.js";
import { ConfigError, type ConfigurationMetadata } from "../src/config.js";
import { MAX_SKILL_FILE_BYTES } from "../src/skill-catalog.js";
import { SKILL_BASES_FILE } from "../src/skill-customize.js";
import { readSkillTree } from "../src/skill-library.js";
import { parseDoctorArgs, renderDoctorHuman, renderDoctorJson, runDoctor, type DoctorFileSystem } from "../src/doctor.js";

function fsFor(paths: { readonly files?: readonly string[]; readonly dirs?: readonly string[]; readonly unreadable?: readonly string[]; readonly unwritable?: readonly string[] }): DoctorFileSystem {
  return {
    readFile: async (path) => path.endsWith("package.json") ? JSON.stringify({ version: "1.0.0", engines: { node: ">=22.19.0" } }) : JSON.stringify({ packages: { "": { version: "1.0.0" } } }),
    stat: async (path) => { if (paths.files?.includes(path)) return { isDirectory: () => false, isFile: () => true }; if (paths.dirs?.includes(path)) return { isDirectory: () => true, isFile: () => false }; const error = new Error("hidden"); Object.assign(error, { code: "ENOENT" }); throw error; },
    access: async (path, mode) => { if (mode === 2 && paths.unwritable?.includes(path) || mode === 4 && paths.unreadable?.includes(path)) { const error = new Error("hidden"); Object.assign(error, { code: "EACCES" }); throw error; } },
  };
}

function timestampedFs(packageMtime: number, lockMtime: number, buildMtime: number): DoctorFileSystem {
  const base = fsFor({ files: ["/root/dist/main.js"], dirs: ["/hidden/workspace"] });
  return { ...base, stat: async (path) => { const mtimeMs = path.endsWith("package.json") ? packageMtime : path.endsWith("package-lock.json") ? lockMtime : path.endsWith("dist/main.js") ? buildMtime : undefined; const info = mtimeMs === undefined ? await base.stat(path) : { isDirectory: () => false, isFile: () => true }; return mtimeMs === undefined ? info : { ...info, mtimeMs }; } };
}

const TEST_CONFIGURATION: ConfigurationMetadata = {
  fingerprint: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  reloadPolicy: "restart-required",
};

const healthyConfig = async () => ({
  workspaces: new Map([["repo", "/hidden/workspace"]]),
  executionProfiles: new Map([["safe", {
    alias: "safe",
    default: true,
    permissionProfile: "read-only" as const,
    provider: "fake",
    model: "fake",
    thinkingLevel: "off" as const,
  }]]),
  defaultExecutionProfile: "safe",
  configuration: TEST_CONFIGURATION,
  skillOverrideDirectory: "/hidden/skills",
});

afterAll(removeTemporaryRoots);

describe("offline doctor", () => {
  it("accepts an npm installation that has no lockfile and no sources", async () => {
    // An npm installation has package.json and the built files, but no lockfile, no src/ and no tsconfig.
    const root = await temporaryRoot("pi-session-mcp-installed-");
    await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.2.3", engines: { node: ">=22.19.0" } }));
    await mkdir(join(root, "dist"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(join(root, "dist", "main.js"), "export {};\n");
    const result = await runDoctor({ packageRoot: root, loadConfig: async () => ({ ...(await healthyConfig()), workspaces: new Map([["repo", root]]) }) });
    expect(result.checks.map((check) => check.id)).not.toContain("package_metadata_unreadable");
    expect(result.checks).toContainEqual(expect.objectContaining({ id: "build_stale", severity: "ok" }));
    expect(result.checks).toContainEqual(expect.objectContaining({ id: "version_mismatch", severity: "ok" }));
    expect(result.ok).toBe(true);
  });

  it("accepts an npm installation that extracted package.json after the build", async () => {
    // npm 12 writes extraction times in archive order, and the archive lists dist/ before package.json.
    const root = await temporaryRoot("pi-session-mcp-installed-");
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist", "main.js"), "export {};\n");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.2.3", engines: { node: ">=22.19.0" } }));
    const result = await runDoctor({ packageRoot: root, loadConfig: async () => ({ ...(await healthyConfig()), workspaces: new Map([["repo", root]]) }) });
    expect(result.checks).toContainEqual(expect.objectContaining({ id: "build_stale", severity: "ok" }));
    expect(result.exitCode).toBe(0);
  });

  it("still reports a source checkout whose package.json is newer than the build as stale", async () => {
    const root = await temporaryRoot("pi-session-mcp-checkout-");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "main.ts"), "export {};\n");
    await writeFile(join(root, "tsconfig.json"), "{}\n");
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist", "main.js"), "export {};\n");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.2.3", engines: { node: ">=22.19.0" } }));
    const result = await runDoctor({ packageRoot: root, loadConfig: async () => ({ ...(await healthyConfig()), workspaces: new Map([["repo", root]]) }) });
    expect(result.checks).toContainEqual(expect.objectContaining({ id: "build_stale", severity: "warning" }));
  });

  it("returns a deterministic sanitized healthy model and equivalent projections", async () => {
    const result = await runDoctor({ packageRoot: "/hidden/root", fileSystem: fsFor({ files: ["/hidden/root/dist/main.js"], dirs: ["/hidden/workspace"] }), loadConfig: healthyConfig });
    expect(result.exitCode).toBe(0);
    expect(JSON.stringify(result)).not.toContain("/hidden/");
    expect(renderDoctorJson(result)).toContain('"schemaVersion":1');
    expect(renderDoctorHuman(result)).not.toContain("/hidden/");
  });

  it("classifies missing build and workspace without leaking paths or errors", async () => {
    const result = await runDoctor({ packageRoot: "/secret/root", fileSystem: fsFor({}), loadConfig: healthyConfig });
    expect(result.exitCode).toBe(2);
    expect(result.checks.map((check) => check.id)).toContain("build_missing");
    expect(result.checks.map((check) => check.id)).toContain("workspace_missing");
    expect(renderDoctorJson(result)).not.toContain("secret");
  });

  it("uses the coding profile to gate write checks", async () => {
    const config = async () => ({ ...(await healthyConfig()), executionProfiles: new Map([["code", { alias: "code", default: true, permissionProfile: "coding" as const, provider: "fake", model: "fake", thinkingLevel: "off" as const }]]) });
    const result = await runDoctor({ packageRoot: "/root", fileSystem: fsFor({ files: ["/root/dist/main.js"], dirs: ["/hidden/workspace"], unwritable: ["/hidden/workspace"] }), loadConfig: config });
    expect(result.checks.map((check) => check.id)).toContain("workspace_not_writable");
  });

  it("maps a provable package/build version drift to a warning", async () => {
    const result = await runDoctor({ packageRoot: "/root", packageMetadata: async () => ({ version: "1.0.0", expectedVersion: "2.0.0", engines: { node: ">=22.19.0" } }), fileSystem: fsFor({ files: ["/root/dist/main.js"], dirs: ["/hidden/workspace"] }), loadConfig: healthyConfig });
    expect(result.exitCode).toBe(1);
    expect(result.checks).toContainEqual(expect.objectContaining({ id: "version_mismatch", severity: "warning" }));
  });

  it("reports build metadata newer than the production artifact as stale", async () => {
    const result = await runDoctor({ packageRoot: "/root", fileSystem: timestampedFs(20, 30, 10), loadConfig: healthyConfig });
    expect(result.exitCode).toBe(1);
    expect(result.checks).toContainEqual(expect.objectContaining({ id: "build_stale", severity: "warning", subject: "build output" }));
  });

  it("warns when build freshness cannot be established", async () => {
    const base = fsFor({ files: ["/root/dist/main.js"], dirs: ["/hidden/workspace"] });
    const fileSystem: DoctorFileSystem = { ...base, stat: async (path) => path.endsWith("dist/main.js") ? { isDirectory: () => false, isFile: () => true, mtimeMs: 10 } : base.stat(path) };
    const result = await runDoctor({ packageRoot: "/root", fileSystem, loadConfig: healthyConfig });
    expect(result.checks).toContainEqual(expect.objectContaining({ id: "build_stale", severity: "warning" }));
  });

  it("rejects unknown CLI options at the parser boundary", () => { expect(parseDoctorArgs(["--network"])).toBeUndefined(); expect(parseDoctorArgs(["--json"])).toEqual({ json: true }); });

  it("reports unsupported Node versions", async () => {
    const result = await runDoctor({ nodeVersion: "20.0.0", packageMetadata: async () => ({ version: "1.0.0", engines: { node: ">=22.19.0" } }), fileSystem: fsFor({ files: ["/root/dist/main.js"], dirs: ["/hidden/workspace"] }), loadConfig: healthyConfig });
    expect(result.exitCode).toBe(2); expect(result.checks).toContainEqual(expect.objectContaining({ id: "node_version_unsupported", severity: "error" }));
  });

  it("distinguishes non-directory build output and config failures", async () => {
    const invalid = async () => { const error = new Error("RAW_SECRET_ERROR /etc/passwd"); Object.assign(error, { code: "EINVAL" }); throw error; };
    const result = await runDoctor({ packageRoot: "/secret/root", packageMetadata: async () => ({ version: "1.0.0", engines: { node: ">=22.19.0" } }), fileSystem: fsFor({ files: ["/secret/root/dist/main.js"] }), loadConfig: invalid });
    expect(result.exitCode).toBe(2);
    expect(result.checks).toContainEqual(expect.objectContaining({ id: "config_invalid", severity: "error" }));
    expect(renderDoctorHuman(result)).not.toMatch(/RAW_SECRET|passwd|secret\/root/);
    expect(renderDoctorJson(result)).not.toMatch(/RAW_SECRET|passwd|secret\/root/);
  });

  it("classifies unreadable and unwritable workspaces", async () => {
    const result = await runDoctor({ packageRoot: "/root", packageMetadata: async () => ({ version: "1.0.0", engines: { node: ">=22.19.0" } }), fileSystem: fsFor({ files: ["/root/dist/main.js"], dirs: ["/hidden/workspace"], unreadable: ["/hidden/workspace"] }), loadConfig: async () => ({ ...(await healthyConfig()), executionProfiles: new Map([["code", { alias: "code", default: true, permissionProfile: "coding" as const, provider: "fake", model: "fake", thinkingLevel: "off" as const }]]) }) });
    expect(result.checks).toContainEqual(expect.objectContaining({ id: "workspace_unreadable", severity: "error" }));
    expect(result.checks).toContainEqual(expect.objectContaining({ id: "workspace_not_writable", severity: "ok" }));
  });

  it("keeps check order stable regardless of workspace insertion order", async () => {
    const config = async () => ({ ...(await healthyConfig()), workspaces: new Map([["zeta", "/hidden/z"], ["alpha", "/hidden/a"]]) });
    const deps = { packageRoot: "/root", packageMetadata: async () => ({ version: "1.0.0", engines: { node: ">=22.19.0" } }), fileSystem: fsFor({ files: ["/root/dist/main.js"], dirs: ["/hidden/z", "/hidden/a"] }), loadConfig: config };
    const result = await runDoctor(deps); const again = await runDoctor(deps);
    expect(result.checks).toEqual(again.checks);
    expect(result.checks.filter((check) => check.id === "workspace_not_directory").map((check) => check.subject)).toEqual(["alpha", "zeta"]);
  });

  it("sanitizes unreadable package metadata and non-file build output", async () => {
    const result = await runDoctor({ packageRoot: "/private/PACKAGE_SENTINEL", packageMetadata: async () => { throw new Error("RAW_PACKAGE_SECRET"); }, fileSystem: fsFor({ dirs: ["/private/PACKAGE_SENTINEL/dist/main.js", "/hidden/workspace"] }), loadConfig: healthyConfig });
    expect(result.checks).toContainEqual(expect.objectContaining({ id: "package_metadata_unreadable", severity: "error" }));
    expect(result.checks).toContainEqual(expect.objectContaining({ id: "build_missing", severity: "error" }));
    expect(`${renderDoctorJson(result)}${renderDoctorHuman(result)}`).not.toMatch(/PACKAGE_SENTINEL|RAW_PACKAGE_SECRET|private/);
  });

  it("reports a missing configuration when no configuration path is set", async () => {
    const result = await runDoctor({ packageRoot: "/root", packageMetadata: async () => ({ version: "1.0.0", engines: { node: ">=22.19.0" } }), fileSystem: fsFor({ files: ["/root/dist/main.js"] }), loadConfig: async () => { throw new ConfigError("config_path_required"); } });
    expect(result.checks).toContainEqual(expect.objectContaining({ id: "config_missing", severity: "error" }));
    expect(result.checks).not.toContainEqual(expect.objectContaining({ id: "config_invalid", severity: "error" }));
  });

  it.each([
    ["ENOENT", "config_missing"],
    ["EACCES", "config_unreadable"],
  ] as const)("maps %s configuration access without raw errors", async (code, expected) => {
    const result = await runDoctor({ packageRoot: "/root", packageMetadata: async () => ({ version: "1.0.0", engines: { node: ">=22.19.0" } }), fileSystem: fsFor({ files: ["/root/dist/main.js"] }), loadConfig: async () => { const error = new Error("CONFIG_SECRET_SENTINEL"); Object.assign(error, { code }); throw error; } });
    expect(result.checks).toContainEqual(expect.objectContaining({ id: expected, severity: "error" }));
    expect(renderDoctorJson(result)).not.toContain("CONFIG_SECRET_SENTINEL");
  });

  it("distinguishes a workspace file from a directory", async () => {
    const result = await runDoctor({ packageRoot: "/root", packageMetadata: async () => ({ version: "1.0.0", engines: { node: ">=22.19.0" } }), fileSystem: fsFor({ files: ["/root/dist/main.js", "/hidden/workspace"] }), loadConfig: healthyConfig });
    expect(result.checks).toContainEqual(expect.objectContaining({ id: "workspace_not_directory", severity: "error", subject: "repo" }));
  });

  const extension = parseExtensionSpec("npm:fixture-ext@1.2.3")!;
  const configWithExtension = async () => {
    const base = await healthyConfig();
    return { ...base, executionProfiles: new Map([["safe", { ...base.executionProfiles.get("safe")!, extensions: [extension] }]]) };
  };
  const extensionFs = () => fsFor({ files: ["/root/dist/main.js"], dirs: ["/hidden/workspace"] });

  it("reports installed pinned extensions as ok", async () => {
    const resolveExtension = vi.fn(async () => "/hidden/extension");
    const result = await runDoctor({ packageRoot: "/root", fileSystem: extensionFs(), loadConfig: configWithExtension, resolveExtension });
    expect(resolveExtension).toHaveBeenCalledWith(extension);
    expect(result.checks).toContainEqual({ id: "extension_missing", severity: "ok", subject: "safe:fixture-ext" });
    expect(result.checks).toContainEqual({ id: "extension_version_mismatch", severity: "ok", subject: "safe:fixture-ext" });
    expect(result.checks.slice(-2).map((check) => check.id)).toEqual(["extension_missing", "extension_version_mismatch"]);
  });

  it.each([
    ["extension_not_installed", "extension_missing"],
    ["extension_version_mismatch", "extension_version_mismatch"],
    ["extension_load_failed", "extension_version_mismatch"],
  ] as const)("maps %s to a failing %s check without a path", async (code, id) => {
    const result = await runDoctor({
      packageRoot: "/root", fileSystem: extensionFs(), loadConfig: configWithExtension,
      resolveExtension: async () => { throw new PiExtensionError(code); },
    });
    expect(result.checks).toContainEqual(expect.objectContaining({ id, severity: "error", subject: "safe:fixture-ext" }));
    expect(result.exitCode).toBe(2);
    expect(JSON.stringify(result)).not.toContain("/hidden/extension");
  });

  it("never resolves extensions when no profile has any", async () => {
    const resolveExtension = vi.fn(async () => "/hidden/extension");
    await runDoctor({ packageRoot: "/root", fileSystem: extensionFs(), loadConfig: healthyConfig, resolveExtension });
    expect(resolveExtension).not.toHaveBeenCalled();
  });

  describe("skill checks", () => {
    const skillChecks = (result: Awaited<ReturnType<typeof runDoctor>>) => result.checks.filter((check) => check.id.startsWith("skill_"));
    async function skillRoot() {
      const root = await temporaryRoot("pi-session-mcp-skills-");
      await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.2.3", engines: { node: ">=22.19.0" } }));
      await mkdir(join(root, "dist"));
      await writeFile(join(root, "dist", "main.js"), "export {};\n");
      await mkdir(join(root, "skills", "review"), { recursive: true });
      await writeFile(join(root, "skills", "review", "SKILL.md"), "---\nname: review\n---\nbody\n");
      return root;
    }
    const configWithSkills = (root: string, skills: ReadonlyArray<{ alias: string; path: string }>) => async () => {
      const base = await healthyConfig();
      return { ...base, workspaces: new Map([["repo", root]]), executionProfiles: new Map([["safe", { ...base.executionProfiles.get("safe")!, skills }]]) };
    };
    const IDS = ["skill_missing", "skill_unreadable", "skill_duplicate"];

    it("reports a readable skill file as ok on all three checks", async () => {
      const root = await skillRoot();
      const result = await runDoctor({ packageRoot: root, loadConfig: configWithSkills(root, [{ alias: "review", path: join(root, "skills", "review", "SKILL.md") }]) });
      expect(skillChecks(result)).toEqual(IDS.map((id) => ({ id, severity: "ok", subject: "safe:review" })));
      expect(result.checks.slice(-3).map((check) => check.id)).toEqual(IDS);
    });

    it("never touches the skill checks when no profile selects a skill", async () => {
      const result = await runDoctor({ packageRoot: "/root", fileSystem: fsFor({ files: ["/root/dist/main.js"], dirs: ["/hidden/workspace"] }), loadConfig: healthyConfig });
      expect(skillChecks(result)).toEqual([]);
    });

    it("reports a missing file as skill_missing without a path", async () => {
      const root = await skillRoot();
      const result = await runDoctor({ packageRoot: root, loadConfig: configWithSkills(root, [{ alias: "gone", path: join(root, "skills", "gone", "SKILL.md") }]) });
      expect(skillChecks(result)).toEqual([{ id: "skill_missing", severity: "error", subject: "safe:gone", remediation: "create the skill file or fix its skillCatalog entry" }]);
      expect(result.exitCode).toBe(2);
    });

    it("reports a directory in place of the file as skill_unreadable", async () => {
      const root = await skillRoot();
      const result = await runDoctor({ packageRoot: root, loadConfig: configWithSkills(root, [{ alias: "dir", path: join(root, "skills", "review") }]) });
      expect(skillChecks(result)).toEqual([
        { id: "skill_missing", severity: "ok", subject: "safe:dir" },
        { id: "skill_unreadable", severity: "error", subject: "safe:dir", remediation: "point the skillCatalog entry to a readable SKILL.md within the size limit" },
      ]);
    });

    it("reports an oversized file as skill_unreadable and accepts one at the limit", async () => {
      const root = await skillRoot();
      await mkdir(join(root, "skills", "big"), { recursive: true });
      await mkdir(join(root, "skills", "exact"), { recursive: true });
      await writeFile(join(root, "skills", "big", "SKILL.md"), Buffer.alloc(MAX_SKILL_FILE_BYTES + 1, 97));
      await writeFile(join(root, "skills", "exact", "SKILL.md"), Buffer.alloc(MAX_SKILL_FILE_BYTES, 97));
      const result = await runDoctor({ packageRoot: root, loadConfig: configWithSkills(root, [{ alias: "big", path: join(root, "skills", "big", "SKILL.md") }, { alias: "exact", path: join(root, "skills", "exact", "SKILL.md") }]) });
      expect(result.checks).toContainEqual(expect.objectContaining({ id: "skill_unreadable", severity: "error", subject: "safe:big" }));
      expect(result.checks).toContainEqual({ id: "skill_unreadable", severity: "ok", subject: "safe:exact" });
    });

    it("reports an unreadable file through an injected file system", async () => {
      const base = fsFor({ files: ["/root/dist/main.js", "/hidden/skills/a/SKILL.md"], dirs: ["/hidden/workspace"], unreadable: ["/hidden/skills/a/SKILL.md"] });
      const result = await runDoctor({ packageRoot: "/root", fileSystem: base, loadConfig: configWithSkills("/hidden/workspace", [{ alias: "locked", path: "/hidden/skills/a/SKILL.md" }]) });
      expect(skillChecks(result)).toEqual([
        { id: "skill_missing", severity: "ok", subject: "safe:locked" },
        { id: "skill_unreadable", severity: "error", subject: "safe:locked", remediation: "point the skillCatalog entry to a readable SKILL.md within the size limit" },
      ]);
    });

    it("reports an unreadable real file when its mode forbids reading", async () => {
      if (process.getuid?.() === 0) return;
      const root = await skillRoot();
      const file = join(root, "skills", "review", "SKILL.md");
      await chmod(file, 0o000);
      const result = await runDoctor({ packageRoot: root, loadConfig: configWithSkills(root, [{ alias: "review", path: file }]) });
      expect(result.checks).toContainEqual(expect.objectContaining({ id: "skill_unreadable", severity: "error", subject: "safe:review" }));
    });

    it("reports two selections of the same canonical file on the later alias", async () => {
      const root = await skillRoot();
      const file = join(root, "skills", "review", "SKILL.md");
      await mkdir(join(root, "skills", "alias"), { recursive: true });
      await symlink(file, join(root, "skills", "alias", "SKILL.md"));
      const result = await runDoctor({ packageRoot: root, loadConfig: configWithSkills(root, [{ alias: "first", path: file }, { alias: "second", path: join(root, "skills", "alias", "SKILL.md") }]) });
      const duplicates = result.checks.filter((check) => check.id === "skill_duplicate");
      expect(duplicates).toEqual([
        { id: "skill_duplicate", severity: "ok", subject: "safe:first" },
        { id: "skill_duplicate", severity: "error", subject: "safe:second", remediation: "select each skill file only once per profile" },
      ]);
    });

    it("keeps paths and file names out of human and JSON output", async () => {
      const root = await skillRoot();
      const file = join(root, "skills", "review", "SKILL.md");
      await mkdir(join(root, "skills", "alias"), { recursive: true });
      await symlink(file, join(root, "skills", "alias", "SKILL.md"));
      const result = await runDoctor({ packageRoot: root, loadConfig: configWithSkills(root, [
        { alias: "first", path: file }, { alias: "second", path: join(root, "skills", "alias", "SKILL.md") },
        { alias: "gone", path: join(root, "skills", "gone", "SKILL.md") }, { alias: "dir", path: join(root, "skills", "review") },
      ]) });
      for (const output of [renderDoctorJson(result), renderDoctorHuman(result)]) {
        expect(output).not.toContain(root);
        expect(output).not.toContain("SKILL.md\"");
        expect(output).not.toMatch(/skills\/|body/);
      }
      expect(renderDoctorHuman(result)).toContain("ERROR skill_duplicate [safe:second]: select each skill file only once per profile");
    });

    describe("skill_override_outdated", () => {
      const overrideChecks = (result: Awaited<ReturnType<typeof runDoctor>>) => result.checks.filter((check) => check.id === "skill_override_outdated");
      async function overrideRoot() {
        const root = await skillRoot();
        const overrideDirectory = await temporaryRoot("pi-session-mcp-overrides-");
        const config = async () => ({ ...(await healthyConfig()), workspaces: new Map([["repo", root]]), skillOverrideDirectory: overrideDirectory });
        const writeBases = (bases: Record<string, string>, schemaVersion = 2) => writeFile(join(overrideDirectory, SKILL_BASES_FILE), JSON.stringify({ schemaVersion, bases }));
        return { root, overrideDirectory, config, writeBases };
      }

      it("adds nothing without a bases file", async () => {
        const { root, config } = await overrideRoot();
        expect(overrideChecks(await runDoctor({ packageRoot: root, loadConfig: config }))).toEqual([]);
      });

      it("reports an up-to-date skill as ok", async () => {
        const { root, config, writeBases } = await overrideRoot();
        await writeBases({ review: (await readSkillTree(join(root, "skills", "review"))).fingerprint });
        const result = await runDoctor({ packageRoot: root, loadConfig: config });
        expect(overrideChecks(result)).toEqual([{ id: "skill_override_outdated", severity: "ok", subject: "skill:review" }]);
        expect(result.exitCode).toBe(0);
      });

      it("warns when the shipped skill changed since the recorded base", async () => {
        const { root, config, writeBases } = await overrideRoot();
        await writeBases({ review: `v2:${"0".repeat(64)}` });
        const result = await runDoctor({ packageRoot: root, loadConfig: config });
        expect(overrideChecks(result)).toEqual([{
          id: "skill_override_outdated", severity: "warning", subject: "skill:review",
          remediation: "review the changed shipped skill, then run pi-session-mcp-setup --apply --customize-skill review",
        }]);
        expect(result.exitCode).toBe(1);
        expect(result.ok).toBe(true);
        for (const output of [renderDoctorJson(result), renderDoctorHuman(result)]) expect(output).not.toContain(root);
      });

      describe("legacy bases", () => {
        const LEGACY = "a".repeat(64);
        const UNRESOLVED = "b".repeat(64);
        const unconfirmed = "the recorded base predates version 2 fingerprints and cannot be confirmed; review the shipped skill, then run pi-session-mcp-setup --apply --customize-skill review";
        const released = (fingerprint: string) => [{ name: "review", release: "0.8.0", legacyFingerprint: LEGACY, fingerprint }];

        it("resolves a legacy base through the released tree and compares the version 2 value", async () => {
          const { root, overrideDirectory, config, writeBases } = await overrideRoot();
          const shipped = (await readSkillTree(join(root, "skills", "review"))).fingerprint;
          await writeBases({ review: LEGACY }, 1);
          const before = await readFile(join(overrideDirectory, SKILL_BASES_FILE), "utf8");
          const current = await runDoctor({ packageRoot: root, loadConfig: config, releasedSkillTrees: released(shipped) });
          expect(overrideChecks(current)).toEqual([{ id: "skill_override_outdated", severity: "ok", subject: "skill:review" }]);
          const changed = await runDoctor({ packageRoot: root, loadConfig: config, releasedSkillTrees: released(`v2:${"1".repeat(64)}`) });
          expect(overrideChecks(changed)).toEqual([{
            id: "skill_override_outdated", severity: "warning", subject: "skill:review",
            remediation: "review the changed shipped skill, then run pi-session-mcp-setup --apply --customize-skill review",
          }]);
          expect(await readFile(join(overrideDirectory, SKILL_BASES_FILE), "utf8")).toBe(before);
        });

        it("warns that an unresolvable legacy base cannot be confirmed, in either schema version", async () => {
          const { root, overrideDirectory, config, writeBases } = await overrideRoot();
          for (const schemaVersion of [1, 2]) {
            await writeBases({ review: UNRESOLVED }, schemaVersion);
            const before = await readFile(join(overrideDirectory, SKILL_BASES_FILE), "utf8");
            const result = await runDoctor({ packageRoot: root, loadConfig: config, releasedSkillTrees: released(`v2:${"1".repeat(64)}`) });
            expect(overrideChecks(result)).toEqual([{ id: "skill_override_outdated", severity: "warning", subject: "skill:review", remediation: unconfirmed }]);
            expect(result.exitCode).toBe(1);
            expect(await readFile(join(overrideDirectory, SKILL_BASES_FILE), "utf8")).toBe(before);
          }
        });

        it("rejects a version 2 fingerprint in a schema version 1 file as corrupt", async () => {
          const { root, config, writeBases } = await overrideRoot();
          await writeBases({ review: `v2:${"0".repeat(64)}` }, 1);
          expect(overrideChecks(await runDoctor({ packageRoot: root, loadConfig: config }))).toEqual([{ id: "skill_override_outdated", severity: "warning", subject: "skill:bases", remediation: "repair or remove the skill bases file" }]);
        });
      });

      it("ignores a recorded skill that is no longer shipped", async () => {
        const { root, config, writeBases } = await overrideRoot();
        await writeBases({ gone: `v2:${"0".repeat(64)}` });
        expect(overrideChecks(await runDoctor({ packageRoot: root, loadConfig: config }))).toEqual([]);
      });

      it("warns about a corrupt bases file without echoing it", async () => {
        const { root, overrideDirectory, config } = await overrideRoot();
        await writeFile(join(overrideDirectory, SKILL_BASES_FILE), "SECRET-not-json");
        const result = await runDoctor({ packageRoot: root, loadConfig: config });
        expect(overrideChecks(result)).toEqual([{ id: "skill_override_outdated", severity: "warning", subject: "skill:bases", remediation: "repair or remove the skill bases file" }]);
        expect(renderDoctorJson(result)).not.toContain("SECRET");
      });

      it("sorts after the other skill checks", async () => {
        const { root, config, writeBases } = await overrideRoot();
        await writeBases({ review: `v2:${"0".repeat(64)}` });
        const result = await runDoctor({ packageRoot: root, loadConfig: async () => ({ ...(await config()), executionProfiles: (await configWithSkills(root, [{ alias: "review", path: join(root, "skills", "review", "SKILL.md") }])()).executionProfiles }) });
        const ids = result.checks.map((check) => check.id).filter((id) => id.startsWith("skill_"));
        expect(ids.at(-1)).toBe("skill_override_outdated");
        expect(ids.indexOf("skill_duplicate")).toBeLessThan(ids.indexOf("skill_override_outdated"));
      });
    });
  });
});

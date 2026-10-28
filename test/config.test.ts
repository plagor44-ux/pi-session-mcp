import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { startupFailureDiagnostic } from "../src/process-diagnostics.js";
import { shippedSkillsDirectory } from "../src/skill-library.js";
import { toResolvedExecutionProfile } from "../src/execution-profile.js";
import { PROFILE_TOOLS } from "../src/session-tools.js";

afterAll(removeTemporaryRoots);

describe("configuration path", () => {
  const validConfig = { workspaces: { repo: "." }, executionProfiles: { safe: { default: true, permissionProfile: "read-only", provider: "example-provider", model: "example-model", thinkingLevel: "medium" } } };

  async function withoutConfigVariable<T>(run: () => Promise<T>): Promise<T> {
    const original = process.env.PI_SESSION_MCP_CONFIG;
    delete process.env.PI_SESSION_MCP_CONFIG;
    try { return await run(); }
    finally { if (original !== undefined) process.env.PI_SESSION_MCP_CONFIG = original; }
  }

  it("requires an explicit configuration path", async () => {
    await withoutConfigVariable(async () => {
      await expect(loadConfig()).rejects.toMatchObject({ name: "ConfigError", code: "config_path_required" });
    });
  });

  it("never reads a configuration file from the working directory", async () => {
    // The working directory of a server is the client's project, which may be untrusted.
    const untrustedProject = await temporaryRoot("pi-session-mcp-untrusted-cwd-");
    await writeFile(join(untrustedProject, "pi-session-mcp.json"), JSON.stringify(validConfig));
    const originalDirectory = process.cwd();
    process.chdir(untrustedProject);
    try {
      await withoutConfigVariable(async () => {
        await expect(loadConfig()).rejects.toMatchObject({ name: "ConfigError", code: "config_path_required" });
      });
    } finally { process.chdir(originalDirectory); }
  });

  it("rejects an empty configuration path", async () => {
    await expect(loadConfig("")).rejects.toMatchObject({ name: "ConfigError", code: "config_path_required" });
  });
});

describe("loadConfig", () => {
  it("resolves relative workspaces from a config directory containing spaces", async () => {
    const root = await temporaryRoot("pi session mcp ");
    const configDir = join(root, "config with spaces");
    await mkdir(configDir);
    const config = join(configDir, "pi session mcp.json");
    await writeFile(config, JSON.stringify({ workspaces: { repo: "../relative workspace" }, executionProfiles: {
      safe: { default: true, permissionProfile: "read-only", provider: "fake-provider", model: "fake-model", thinkingLevel: "off",
      },
    } }));
    const loaded = await loadConfig(config);
    expect(loaded.workspaces.get("repo")).toBe(resolve(root, "relative workspace"));
    expect(loaded.defaultExecutionProfile).toBe("safe");
    expect(loaded.executionProfiles.get("safe")).toMatchObject({ alias: "safe", permissionProfile: "read-only" });
  });

  const validProfile = { default: true, permissionProfile: "read-only", provider: "fake-provider", model: "fake-model", thinkingLevel: "medium" };
  async function writeConfig(value: unknown): Promise<string> {
    const root = await temporaryRoot("pi-session-mcp-config-"); const path = join(root, "config.json");
    await writeFile(path, JSON.stringify(value)); return path;
  }

  it("requires exactly one read-only default execution profile", async () => {
    const base = { workspaces: { repo: "." } };
    await expect(loadConfig(await writeConfig({ ...base, executionProfiles: {} }))).rejects.toThrow();
    await expect(loadConfig(await writeConfig({ ...base, executionProfiles: { a: { ...validProfile, default: false } } }))).rejects.toThrow();
    await expect(loadConfig(await writeConfig({ ...base, executionProfiles: { a: validProfile, b: validProfile } }))).rejects.toThrow();
    await expect(loadConfig(await writeConfig({ ...base, executionProfiles: { a: { ...validProfile, permissionProfile: "coding" } } }))).rejects.toThrow();
  });

  it("classifies invalid thinking levels without exposing paths or values", async () => {
    const invalidValue = "SECRET_THINKING_SENTINEL";
    let thrown: unknown;
    try {
      await loadConfig(await writeConfig({ workspaces: { repo: "." }, executionProfiles: {
        safe: { ...validProfile, thinkingLevel: invalidValue },
      } }));
    } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect(thrown).toMatchObject({ code: "invalid_thinking_level", message: "Execution profile thinking level is invalid" });
    expect(String(thrown)).not.toContain(invalidValue);
    expect(JSON.stringify(thrown)).not.toContain(invalidValue);
    expect(String(thrown)).not.toContain("executionProfiles");
  });

  it("rejects unknown root/profile and credential fields", async () => {
    const base = { workspaces: { repo: "." }, executionProfiles: { safe: validProfile } };
    const sentinel = "SECRET_CONFIG_SENTINEL";
    for (const field of ["apiKey", "token", "accessToken", "oauthToken", "credential", "credentials", "other"]) {
      let rootError: unknown;
      try { await loadConfig(await writeConfig({ ...base, [field]: sentinel })); } catch (error) { rootError = error; }
      expect(rootError).toBeInstanceOf(ConfigError);
      expect((rootError as ConfigError).code).toBe("invalid_execution_profile_config");
      expect(String(rootError)).not.toContain(sentinel); expect(JSON.stringify(rootError)).not.toContain(sentinel);
      let profileError: unknown;
      try { await loadConfig(await writeConfig({ ...base, executionProfiles: { safe: { ...validProfile, [field]: sentinel } } })); } catch (error) { profileError = error; }
      expect(profileError).toBeInstanceOf(ConfigError);
      expect((profileError as ConfigError).code).toBe("invalid_execution_profile_config");
      expect(String(profileError)).not.toContain(sentinel); expect(JSON.stringify(profileError)).not.toContain(sentinel);
    }
  });

  describe("event delivery", () => {
    const base = { workspaces: { repo: "." }, executionProfiles: { safe: validProfile } };

    it("defaults to off when the events field is absent", async () => {
      expect((await loadConfig(await writeConfig(base))).eventDelivery).toBe("off");
    });

    it("accepts the spool delivery", async () => {
      expect((await loadConfig(await writeConfig({ ...base, events: { delivery: "spool" } }))).eventDelivery).toBe("spool");
    });

    it("accepts an explicit off", async () => {
      expect((await loadConfig(await writeConfig({ ...base, events: { delivery: "off" } }))).eventDelivery).toBe("off");
    });

    it.each([
      ["unknown delivery", { delivery: "socket" }],
      ["missing delivery", {}],
      ["unknown key", { delivery: "spool", path: "/SECRET_EVENT_SENTINEL" }],
      ["non-object", "spool"],
      ["null", null],
    ])("rejects %s with a sanitized invalid_event_delivery error", async (_label, events) => {
      let thrown: unknown;
      try { await loadConfig(await writeConfig({ ...base, events })); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(ConfigError);
      expect(thrown).toMatchObject({ code: "invalid_event_delivery", message: "Event delivery configuration is invalid" });
      expect(JSON.stringify(thrown)).not.toContain("SECRET_EVENT_SENTINEL");
    });

    it("projects the error as a sanitized startup diagnostic", () => {
      expect(startupFailureDiagnostic(new ConfigError("invalid_event_delivery"))).toEqual({
        level: "error", event: "startup_failed", stage: "startup", code: "invalid_event_delivery",
      });
    });
  });

  it("returns immutable execution aliases with all selected values", async () => {
    const loaded = await loadConfig(await writeConfig({ workspaces: { repo: "." }, executionProfiles: { safe: validProfile } }));
    expect(loaded.executionProfiles.get("safe")).toEqual({ alias: "safe", ...validProfile });
    expect(loaded.defaultExecutionProfile).toBe("safe");
    expect(() => (loaded.executionProfiles as Map<string, unknown>).set("other", {})).toThrow();
  });

  it("fingerprints the exact configuration bytes with the restart-required policy", async () => {
    const root = await temporaryRoot("pi-session-mcp-config-");
    const path = join(root, "config.json");
    const bytes = Buffer.from(`{\n  "workspaces": { "repo": "." },\n  "executionProfiles": { "safe": ${JSON.stringify(validProfile)} }\n}\n`);
    await writeFile(path, bytes);
    const loaded = await loadConfig(path);
    expect(loaded.configuration).toEqual({
      fingerprint: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      reloadPolicy: "restart-required",
    });
    expect(Object.keys(loaded.configuration)).toEqual(["fingerprint", "reloadPolicy"]);
    expect(Object.isFrozen(loaded.configuration)).toBe(true);
    expect(JSON.stringify(loaded.configuration)).not.toContain(root);
  });

  it("keeps the loaded snapshot across a file edit until a new load reads new bytes", async () => {
    const root = await temporaryRoot("pi-session-mcp-config-");
    const path = join(root, "config.json");
    const write = (value: unknown): Promise<void> => writeFile(path, JSON.stringify(value));
    await write({ workspaces: { repo: "." }, executionProfiles: { safe: validProfile } });
    const loaded = await loadConfig(path);
    const snapshot = { ...loaded.configuration };
    await write({ workspaces: { repo: ".", "second-workspace": "./nested" }, executionProfiles: {
      safe: validProfile,
      coding: { default: false, permissionProfile: "coding", provider: "fake-provider", model: "fake-model", thinkingLevel: "high" },
    } });
    expect([...loaded.workspaces.keys()]).toEqual(["repo"]);
    expect([...loaded.executionProfiles.keys()]).toEqual(["safe"]);
    expect(loaded.configuration).toEqual(snapshot);

    const reloaded = await loadConfig(path);
    expect([...reloaded.workspaces.keys()].sort()).toEqual(["repo", "second-workspace"]);
    expect(reloaded.configuration.reloadPolicy).toBe("restart-required");
    expect(reloaded.configuration.fingerprint).not.toBe(snapshot.fingerprint);
  });

  it("fails an invalid replacement without disturbing the previously loaded snapshot", async () => {
    const root = await temporaryRoot("pi-session-mcp-config-");
    const path = join(root, "config.json");
    await writeFile(path, JSON.stringify({ workspaces: { repo: "." }, executionProfiles: { safe: validProfile } }));
    const loaded = await loadConfig(path);
    const snapshot = { ...loaded.configuration };
    await writeFile(path, JSON.stringify({ workspaces: { repo: "." }, executionProfiles: { safe: { ...validProfile, thinkingLevel: "turbo" } } }));
    await expect(loadConfig(path)).rejects.toBeInstanceOf(ConfigError);
    expect(loaded.configuration).toEqual(snapshot);
    expect([...loaded.executionProfiles.keys()]).toEqual(["safe"]);
    expect(loaded.configuration.reloadPolicy).toBe("restart-required");
  });
});

describe("execution profile extensions", () => {
  const safe = { default: true, permissionProfile: "read-only", provider: "p", model: "m", thinkingLevel: "off" };

  async function loadProfiles(executionProfiles: Record<string, unknown>) {
    const root = await temporaryRoot("pi-session-mcp-extensions-");
    const path = join(root, "config.json");
    await writeFile(path, JSON.stringify({ workspaces: { repo: "." }, executionProfiles }));
    return loadConfig(path);
  }

  it("parses pinned extensions on read-only and coding profiles", async () => {
    const config = await loadProfiles({
      safe: { ...safe, extensions: ["npm:pi-cursor-sdk@0.5.3"] },
      code: { ...safe, default: false, permissionProfile: "coding", extensions: ["npm:@scope/ext@1.2.3", "npm:other@2.0.0"] },
    });
    expect(config.executionProfiles.get("safe")?.extensions).toEqual([{ spec: "npm:pi-cursor-sdk@0.5.3", name: "pi-cursor-sdk", version: "0.5.3" }]);
    expect(config.executionProfiles.get("code")?.extensions?.map((extension) => extension.name)).toEqual(["@scope/ext", "other"]);
    expect(Object.isFrozen(config.executionProfiles.get("code")?.extensions)).toBe(true);
  });

  it("resolves granted extension tools in configured order as frozen snapshots", async () => {
    const grantedExtensionTools = ["symbol_search", "project_report"];
    const config = await loadProfiles({ safe: { ...safe, extensions: ["npm:pi-lens@4.4.3"], grantedExtensionTools } });
    const profile = config.executionProfiles.get("safe")!;
    const resolved = toResolvedExecutionProfile(profile);
    expect(profile.grantedExtensionTools).toEqual(grantedExtensionTools);
    expect(resolved.grantedExtensionTools).toEqual(grantedExtensionTools);
    expect(Object.isFrozen(profile.grantedExtensionTools)).toBe(true);
    expect(Object.isFrozen(resolved.grantedExtensionTools)).toBe(true);
    expect(resolved.grantedExtensionTools).not.toBe(profile.grantedExtensionTools);
  });

  it("keeps profiles without grants free of the grantedExtensionTools key when resolved", async () => {
    const config = await loadProfiles({ safe: { ...safe, extensions: ["npm:pi-lens@4.4.3"] } });
    const profile = config.executionProfiles.get("safe")!;
    expect("grantedExtensionTools" in profile).toBe(false);
    expect("grantedExtensionTools" in toResolvedExecutionProfile(profile)).toBe(false);
  });

  it("accepts the 32-name grant limit and an explicitly empty grant", async () => {
    for (const grantedExtensionTools of [Array.from({ length: 32 }, (_, index) => `tool_${index}`), []]) {
      const config = await loadProfiles({ safe: { ...safe, extensions: ["npm:pi-lens@4.4.3"], grantedExtensionTools } });
      expect(toResolvedExecutionProfile(config.executionProfiles.get("safe")!).grantedExtensionTools).toEqual(grantedExtensionTools);
    }
  });

  it("rejects granted extension tools on coding profiles", async () => {
    await expect(loadProfiles({
      safe,
      code: { ...safe, default: false, permissionProfile: "coding", extensions: ["npm:pi-lens@4.4.3"], grantedExtensionTools: ["symbol_search"] },
    })).rejects.toMatchObject({ code: "invalid_execution_profile_config" });
  });

  it.each([undefined, []])("rejects granted extension tools without extensions %j", async (extensions) => {
    await expect(loadProfiles({ safe: { ...safe, extensions, grantedExtensionTools: ["symbol_search"] } }))
      .rejects.toMatchObject({ code: "invalid_execution_profile_config" });
  });

  describe("sandboxed shell", () => {
    const withPlatform = async <T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> => {
      const original = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { ...original, value: platform });
      try { return await run(); } finally { Object.defineProperty(process, "platform", original); }
    };

    it("accepts shell sandboxed on a read-only profile and carries it into the resolved profile", async () => {
      await withPlatform("linux", async () => {
        const config = await loadProfiles({ safe: { ...safe, shell: "sandboxed" } });
        const profile = config.executionProfiles.get("safe")!;
        expect(profile.shell).toBe("sandboxed");
        expect(toResolvedExecutionProfile(profile).shell).toBe("sandboxed");
      });
    });

    it("accepts a sandboxed shell together with extensions that grant no tools", async () => {
      await withPlatform("linux", async () => {
        const config = await loadProfiles({ safe: { ...safe, shell: "sandboxed", extensions: ["npm:pi-lens@4.4.3"] } });
        expect(config.executionProfiles.get("safe")?.shell).toBe("sandboxed");
      });
    });

    it("keeps profiles without a shell free of the shell key", async () => {
      const config = await loadProfiles({ safe });
      const profile = config.executionProfiles.get("safe")!;
      expect("shell" in profile).toBe(false);
      expect("shell" in toResolvedExecutionProfile(profile)).toBe(false);
    });

    it("rejects a sandboxed shell on a coding profile", async () => {
      await withPlatform("linux", async () => {
        await expect(loadProfiles({ safe, code: { ...safe, default: false, permissionProfile: "coding", shell: "sandboxed" } }))
          .rejects.toMatchObject({ code: "invalid_execution_profile_config" });
      });
    });

    it("rejects a sandboxed shell together with granted extension tools, also an empty grant", async () => {
      await withPlatform("linux", async () => {
        for (const grantedExtensionTools of [["symbol_search"], []]) {
          await expect(loadProfiles({ safe: { ...safe, shell: "sandboxed", extensions: ["npm:pi-lens@4.4.3"], grantedExtensionTools } }))
            .rejects.toMatchObject({ code: "invalid_execution_profile_config" });
        }
      });
    });

    it.each(["darwin", "win32", "freebsd"] as const)("rejects a sandboxed shell on %s", async (platform) => {
      await withPlatform(platform, async () => {
        await expect(loadProfiles({ safe: { ...safe, shell: "sandboxed" } })).rejects.toMatchObject({ code: "invalid_execution_profile_config" });
      });
    });

    it.each(["none", "bash", "", true, null])("rejects the shell value %j", async (shell) => {
      await withPlatform("linux", async () => {
        await expect(loadProfiles({ safe: { ...safe, shell } })).rejects.toMatchObject({ code: "invalid_execution_profile_config" });
      });
    });
  });

  it.each([
    [["symbol_search", "symbol_search"]],
    [Array.from({ length: 33 }, (_, index) => `tool_${index}`)],
    ...["Symbol Search", " symbol_search", "-x", "mcp__x"].map((name) => [[name]]),
    ...[...new Set([...PROFILE_TOOLS.coding, ...PROFILE_TOOLS["read-only"]])].map((name) => [[name]]),
  ])("rejects invalid granted extension tools %j", async (grantedExtensionTools) => {
    await expect(loadProfiles({ safe: { ...safe, extensions: ["npm:pi-lens@4.4.3"], grantedExtensionTools } }))
      .rejects.toMatchObject({ code: "invalid_execution_profile_config" });
  });

  it("keeps profiles without extensions free of the field", async () => {
    const config = await loadProfiles({ safe });
    expect(config.executionProfiles.get("safe")).not.toHaveProperty("extensions");
  });

  it.each([
    [["npm:pi-cursor-sdk@^0.5.3"]],
    [["npm:pi-cursor-sdk@latest"]],
    [["npm:pi-cursor-sdk@0.5.3+build.1"]],
    [["git:github.com/owner/repo@1.0.0"]],
    [["/absolute/extension"]],
    [["npm:dup@1.0.0", "npm:dup@1.0.1"]],
    [Array.from({ length: 9 }, (_, index) => `npm:ext-${index}@1.0.0`)],
    ["npm:not-an-array@1.0.0"],
  ])("rejects invalid extensions %j", async (extensions) => {
    await expect(loadProfiles({ safe: { ...safe, extensions } })).rejects.toMatchObject({ code: "invalid_execution_profile_config" });
  });
});

describe("skill catalog and profile skills", () => {
  const safe = { default: true, permissionProfile: "read-only", provider: "p", model: "m", thinkingLevel: "off" };

  async function load(value: Record<string, unknown>, directory = "config dir") {
    const root = await temporaryRoot("pi-session-mcp-skills-");
    await mkdir(join(root, directory));
    const path = join(root, directory, "config.json");
    await writeFile(path, JSON.stringify({ workspaces: { repo: "." }, ...value }));
    return { root, base: join(root, directory), config: () => loadConfig(path) };
  }

  it("resolves selected skills against the configuration directory in configured order", async () => {
    const originalDirectory = process.cwd();
    const { base, config } = await load({
      skillCatalog: { review: "skills/review/SKILL.md", plan: "../shared/plan/SKILL.md", other: "/abs/other/SKILL.md" },
      executionProfiles: { safe: { ...safe, skills: ["plan", "review"] }, bare: { ...safe, default: false } },
    });
    // The shell's directory never takes part in the resolution.
    process.chdir(await temporaryRoot("pi-session-mcp-skills-cwd-"));
    try {
      const loaded = await config();
      expect(loaded.executionProfiles.get("safe")?.skills).toEqual([
        { alias: "plan", path: resolve(base, "../shared/plan/SKILL.md") },
        { alias: "review", path: resolve(base, "skills/review/SKILL.md") },
      ]);
      expect(Object.isFrozen(loaded.executionProfiles.get("safe")?.skills)).toBe(true);
      expect(loaded.executionProfiles.get("bare")).not.toHaveProperty("skills");
    } finally { process.chdir(originalDirectory); }
  });

  it("treats a missing catalog as empty and an empty selection as no skills", async () => {
    const loaded = await (await load({ executionProfiles: { safe: { ...safe, skills: [] } } })).config();
    expect(loaded.executionProfiles.get("safe")).not.toHaveProperty("skills");
    await expect((await load({ executionProfiles: { safe: { ...safe, skills: ["review"] } } })).config())
      .rejects.toMatchObject({ code: "invalid_execution_profile_config" });
  });

  it.each([
    ["an unknown alias", { review: "r/SKILL.md" }, ["missing"]],
    ["a duplicate alias", { review: "r/SKILL.md" }, ["review", "review"]],
    ["two aliases on the same resolved path", { review: "r/SKILL.md", again: "./r/../r/SKILL.md" }, ["review", "again"]],
    ["too many skills", Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`s${index}`, `s${index}/SKILL.md`])), Array.from({ length: 17 }, (_, index) => `s${index}`)],
    ["an invalid alias", { Review: "r/SKILL.md" }, ["Review"]],
  ])("rejects %s", async (_name, skillCatalog, skills) => {
    await expect((await load({ skillCatalog, executionProfiles: { safe: { ...safe, skills } } })).config())
      .rejects.toMatchObject({ code: "invalid_execution_profile_config" });
  });

  it.each([
    ["a directory", "skills/review"],
    ["another file name", "skills/review/README.md"],
    ["a lowercase file name", "skills/review/skill.md"],
    ["a URL", "https://example.invalid/SKILL.md"],
    ["an npm source", "npm:pkg/SKILL.md"],
    ["a git source", "git+ssh://host/repo/SKILL.md"],
    ["a home shorthand", "~/skills/SKILL.md"],
    ["a glob", "skills/*/SKILL.md"],
    ["a backslash path", "skills\\review\\SKILL.md"],
    ["an empty path", ""],
  ])("rejects a catalog entry that is %s without exposing it", async (_name, path) => {
    let thrown: unknown;
    try {
      await (await load({ skillCatalog: { review: path }, executionProfiles: { safe } })).config();
    } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ name: "ConfigError", code: "invalid_execution_profile_config" });
    if (path.length > 0) expect(`${String(thrown)} ${JSON.stringify(thrown)}`).not.toContain(path);
  });

  describe("builtin library skills", () => {
    const shipped = (name: string) => join(shippedSkillsDirectory(), name, "SKILL.md");
    const builtin = (value: string) => ({ skillCatalog: { lib: value }, executionProfiles: { safe: { ...safe, skills: ["lib"] } } });

    it("resolves builtin:<name> to the shipped file, whatever the shell's directory", async () => {
      const originalDirectory = process.cwd();
      const { config } = await load(builtin("builtin:pi-session-review"));
      process.chdir(await temporaryRoot("pi-session-mcp-skills-cwd-"));
      try {
        const loaded = await config();
        expect(loaded.executionProfiles.get("safe")?.skills).toEqual([{ alias: "lib", path: shipped("pi-session-review") }]);
      } finally { process.chdir(originalDirectory); }
    });

    it("lets an override next to the configuration file win and exposes the override directory", async () => {
      const { base, config } = await load(builtin("builtin:pi-session-review"));
      await mkdir(join(base, "skills", "pi-session-review"), { recursive: true });
      await writeFile(join(base, "skills", "pi-session-review", "SKILL.md"), "---\nname: pi-session-review\n---\n");
      const loaded = await config();
      expect(loaded.executionProfiles.get("safe")?.skills).toEqual([{ alias: "lib", path: join(base, "skills", "pi-session-review", "SKILL.md") }]);
      expect(loaded.skillOverrideDirectory).toBe(join(base, "skills"));
    });

    it("resolves an override-only name and keeps the shipped location for a missing skill", async () => {
      const { base, config } = await load({
        skillCatalog: { own: "builtin:own-skill", gone: "builtin:not-a-skill" },
        executionProfiles: { safe: { ...safe, skills: ["own", "gone"] } },
      });
      await mkdir(join(base, "skills", "own-skill"), { recursive: true });
      await writeFile(join(base, "skills", "own-skill", "SKILL.md"), "x");
      expect((await config()).executionProfiles.get("safe")?.skills).toEqual([
        { alias: "own", path: join(base, "skills", "own-skill", "SKILL.md") },
        { alias: "gone", path: shipped("not-a-skill") },
      ]);
    });

    it("still rejects two aliases that resolve to the same file", async () => {
      const { config } = await load({
        skillCatalog: { one: "builtin:pi-session-review", two: shipped("pi-session-review") },
        executionProfiles: { safe: { ...safe, skills: ["one", "two"] } },
      });
      await expect(config()).rejects.toMatchObject({ code: "invalid_execution_profile_config" });
    });

    it.each(["builtin:", "builtin:Review", "builtin:a/b", "builtin:../x", "builtin:-x", "builtin:x-", "builtin:a--b", "builtin:" + "a".repeat(65), "builtin:review/SKILL.md", "Builtin:review", "builtin: review"])("rejects the invalid value %j", async (value) => {
      await expect((await load(builtin(value))).config()).rejects.toMatchObject({ code: "invalid_execution_profile_config" });
    });
  });

  it("limits the catalog size", async () => {
    const skillCatalog = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`s${index}`, `s${index}/SKILL.md`]));
    await expect((await load({ skillCatalog, executionProfiles: { safe } })).config()).rejects.toMatchObject({ code: "invalid_execution_profile_config" });
    delete skillCatalog.s64;
    await expect((await load({ skillCatalog, executionProfiles: { safe } })).config()).resolves.toBeDefined();
  });
});

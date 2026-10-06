import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";
import { ConfigError, loadConfig } from "../src/config.js";

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

import { describe, expect, it } from "vitest";
import packageMetadata from "../package.json" with { type: "json" };
import { projectCapabilities } from "../src/capabilities.js";
import type { ConfigurationMetadata } from "../src/config.js";
import type { ConfiguredExecutionProfile } from "../src/execution-profile.js";

const configuration: ConfigurationMetadata = Object.freeze({
  fingerprint: "sha256:1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a",
  reloadPolicy: "restart-required",
});

describe("configuration capability projection", () => {
  it("returns deterministic configured aliases and no workspace paths", () => {
    const workspaces = new Map([
      ["zeta-workspace", "/private/TOKEN_SENTINEL/zeta"],
      ["alpha-workspace", "/private/API_KEY_SENTINEL/alpha"],
    ]);
    const executionProfiles = new Map<string, ConfiguredExecutionProfile>([
      ["zeta-profile", {
        alias: "zeta-profile", default: false, permissionProfile: "coding",
        provider: "provider-z", model: "model-z", thinkingLevel: "high",
        extensions: [{ spec: "npm:ext@1.0.0", name: "ext", version: "1.0.0" }],
        skills: [{ alias: "zeta-review", path: "/private/SKILL_PATH_SENTINEL/review/SKILL.md" }, { alias: "alpha-docs", path: "/private/SKILL_PATH_SENTINEL/docs/SKILL.md" }],
      }],
      ["alpha-profile", {
        alias: "alpha-profile", default: true, permissionProfile: "read-only",
        provider: "provider-a", model: "model-a", thinkingLevel: "medium",
        extensions: [{ spec: "npm:ext@1.0.0", name: "ext", version: "1.0.0" }],
        grantedExtensionTools: ["zeta_lookup", "alpha_lookup"],
      }],
    ]);

    const capabilities = projectCapabilities(workspaces, executionProfiles, configuration);

    expect(capabilities).toEqual({
      ok: true,
      server: { name: packageMetadata.name, version: packageMetadata.version },
      configuration: { fingerprint: configuration.fingerprint, reloadPolicy: "restart-required" },
      events: { delivery: "off" },
      workspaces: [{ alias: "alpha-workspace", mode: "unset" }, { alias: "zeta-workspace", mode: "unset" }],
      executionProfiles: [
        {
          alias: "alpha-profile", default: true, permissionProfile: "read-only",
          provider: "provider-a", model: "model-a", thinkingLevel: "medium", extensions: ["npm:ext@1.0.0"], grantedExtensionTools: ["zeta_lookup", "alpha_lookup"], skills: [],
        },
        {
          alias: "zeta-profile", default: false, permissionProfile: "coding",
          provider: "provider-z", model: "model-z", thinkingLevel: "high", extensions: ["npm:ext@1.0.0"], grantedExtensionTools: [], skills: ["zeta-review", "alpha-docs"],
        },
      ],
    });
    expect(JSON.stringify(capabilities)).not.toMatch(/private|TOKEN_SENTINEL|API_KEY_SENTINEL|SKILL_PATH_SENTINEL|SKILL\.md/);
  });

  it("reports configured workspace modes and defaults missing entries to unset", () => {
    const capabilities = projectCapabilities(
      new Map([["b", "/private/b"], ["a", "/private/a"]]),
      new Map(), configuration, new Map([["a", { mode: "container", container: { writers: 2, lifecycle: "persistent", profiles: ["code"], image: "node", network: "pasta", cache: "none", tags: "none" } }]]),
    );
    expect(capabilities.workspaces).toEqual([{ alias: "a", mode: "container", writers: 2, defaultBase: null }, { alias: "b", mode: "unset" }]);
  });

  it("reports the event delivery it is given", () => {
    expect(projectCapabilities(new Map(), new Map(), configuration, new Map(), "spool").events).toEqual({ delivery: "spool" });
    expect(projectCapabilities(new Map(), new Map(), configuration).events).toEqual({ delivery: "off" });
  });

  it("projects only captured memory with an exact key set on every call", () => {
    const workspaces = new Map([["repo", "/private/CAPTURED_SNAPSHOT_SENTINEL"]]);
    const executionProfiles = new Map<string, ConfiguredExecutionProfile>([
      ["safe", { alias: "safe", default: true, permissionProfile: "read-only", provider: "provider-a", model: "model-a", thinkingLevel: "off" }],
    ]);

    const first = projectCapabilities(workspaces, executionProfiles, configuration);
    const second = projectCapabilities(workspaces, executionProfiles, configuration);

    expect(second).toEqual(first);
    expect(Object.keys(second)).toEqual(["ok", "server", "configuration", "events", "workspaces", "executionProfiles"]);
    expect(Object.keys(second.executionProfiles[0]!)).toEqual(["alias", "default", "permissionProfile", "provider", "model", "thinkingLevel", "extensions", "grantedExtensionTools", "skills"]);
    expect(second.configuration).toEqual({ fingerprint: configuration.fingerprint, reloadPolicy: "restart-required" });
    expect(JSON.stringify(second)).not.toContain("CAPTURED_SNAPSHOT_SENTINEL");
  });
});

it("container workspace lists configured writers and defaultBase", () => {
  const container = { writers: 4, base: "dev", lifecycle: "persistent" as const, profiles: ["code"], image: "node", network: "pasta" as const, cache: "none" as const, tags: "none" as const };
  expect(projectCapabilities(new Map([["repo", "/repo"]]), new Map(), configuration, new Map([["repo", { mode: "container", container }]])).workspaces).toEqual([{ alias: "repo", mode: "container", writers: 4, defaultBase: "dev" }]);
});

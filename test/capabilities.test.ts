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
      }],
      ["alpha-profile", {
        alias: "alpha-profile", default: true, permissionProfile: "read-only",
        provider: "provider-a", model: "model-a", thinkingLevel: "medium",
      }],
    ]);

    const capabilities = projectCapabilities(workspaces, executionProfiles, configuration);

    expect(capabilities).toEqual({
      ok: true,
      server: { name: packageMetadata.name, version: packageMetadata.version },
      configuration: { fingerprint: configuration.fingerprint, reloadPolicy: "restart-required" },
      workspaces: [{ alias: "alpha-workspace" }, { alias: "zeta-workspace" }],
      executionProfiles: [
        {
          alias: "alpha-profile", default: true, permissionProfile: "read-only",
          provider: "provider-a", model: "model-a", thinkingLevel: "medium",
        },
        {
          alias: "zeta-profile", default: false, permissionProfile: "coding",
          provider: "provider-z", model: "model-z", thinkingLevel: "high",
        },
      ],
    });
    expect(JSON.stringify(capabilities)).not.toMatch(/private|TOKEN_SENTINEL|API_KEY_SENTINEL/);
  });

  it("projects only captured memory with an exact key set on every call", () => {
    const workspaces = new Map([["repo", "/private/CAPTURED_SNAPSHOT_SENTINEL"]]);
    const executionProfiles = new Map<string, ConfiguredExecutionProfile>([
      ["safe", { alias: "safe", default: true, permissionProfile: "read-only", provider: "provider-a", model: "model-a", thinkingLevel: "off" }],
    ]);

    const first = projectCapabilities(workspaces, executionProfiles, configuration);
    const second = projectCapabilities(workspaces, executionProfiles, configuration);

    expect(second).toEqual(first);
    expect(Object.keys(second)).toEqual(["ok", "server", "configuration", "workspaces", "executionProfiles"]);
    expect(second.configuration).toEqual({ fingerprint: configuration.fingerprint, reloadPolicy: "restart-required" });
    expect(JSON.stringify(second)).not.toContain("CAPTURED_SNAPSHOT_SENTINEL");
  });
});

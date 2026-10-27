import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type AppConfig } from "../src/config.js";
import { skillOverrideDirectory } from "../src/skill-library.js";
import type { WorkspaceMode } from "../src/execution-modes.js";
import { containerRuntimeUsable } from "../src/container-runtime.js";
import { renderDoctorHuman, renderDoctorJson, runDoctor, type DoctorDependencies } from "../src/doctor.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

function dependencies(modes: Record<string, WorkspaceMode>, coding = true): DoctorDependencies {
  const config: AppConfig = {
    workspaces: new Map(Object.keys(modes).map((alias) => [alias, `/PRIVATE_WORKSPACE/${alias}`])),
    workspaceModes: new Map(Object.entries(modes).map(([alias, mode]) => [alias, { mode }])),
    executionProfiles: new Map([["profile", { alias: "profile", default: true, permissionProfile: coding ? "coding" : "read-only", provider: "fake", model: "fake", thinkingLevel: "off" }]]),
    defaultExecutionProfile: "profile",
    eventDelivery: "off",
    skillOverrideDirectory: "/PRIVATE_SKILLS",
    configuration: { fingerprint: `sha256:${"0".repeat(64)}`, reloadPolicy: "restart-required" },
  };
  return {
    packageRoot: "/PRIVATE_PACKAGE",
    nodeVersion: "22.19.0",
    packageMetadata: async () => ({ version: "1.0.0", engines: { node: ">=22.19.0" } }),
    fileSystem: {
      readFile: async () => "",
      stat: async (path) => ({ isDirectory: () => path.startsWith("/PRIVATE_WORKSPACE/"), isFile: () => !path.startsWith("/PRIVATE_WORKSPACE/") }),
      access: async () => undefined,
      lstat: async () => ({ isFile: () => false, isSymbolicLink: () => false }),
    },
    loadConfig: async () => config,
    containerRuntime: async () => false,
  };
}

const modeChecks = (result: Awaited<ReturnType<typeof runDoctor>>) => result.checks.filter((check) => ["workspace_mode_unset", "workspace_host_writes_accepted", "container_runtime_unavailable"].includes(check.id));

afterEach(() => vi.unstubAllEnvs());
afterAll(removeTemporaryRoots);

describe("Doctor execution modes", () => {
  it("warns once per unset alias when a coding profile exists", async () => {
    const result = await runDoctor(dependencies({ repo: "unset" }));
    expect(modeChecks(result)).toEqual([{ id: "workspace_mode_unset", severity: "warning", subject: "repo", remediation: expect.any(String) }]);
    expect(result.exitCode).toBe(1);
    expect(result.ok).toBe(true);
  });

  it("does not emit an unset check with only read-only profiles", async () => {
    const result = await runDoctor(dependencies({ repo: "unset" }, false));
    expect(modeChecks(result)).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("makes accepted host writes visible without remediation", async () => {
    const result = await runDoctor(dependencies({ repo: "host" }, false));
    expect(modeChecks(result)).toEqual([{ id: "workspace_host_writes_accepted", severity: "ok", subject: "repo" }]);
    expect(result.exitCode).toBe(0);
  });

  it.each([false, true])("reports each container alias with runtime usable=%s and probes only once", async (usable) => {
    const containerRuntime = vi.fn(async () => usable);
    const result = await runDoctor({ ...dependencies({ zeta: "container", alpha: "container" }, false), containerRuntime });
    expect(modeChecks(result)).toEqual(["alpha", "zeta"].map((subject) => ({ id: "container_runtime_unavailable", severity: usable ? "ok" : "error", subject, ...(!usable ? { remediation: expect.any(String) } : {}) })));
    expect(result.exitCode).toBe(usable ? 0 : 2);
    expect(result.ok).toBe(usable);
    expect(containerRuntime).toHaveBeenCalledTimes(1);
  });

  it("does not probe without a container alias or emit a read-only mode check", async () => {
    const containerRuntime = vi.fn(async () => false);
    const result = await runDoctor({ ...dependencies({ repo: "read-only" }), containerRuntime });
    expect(modeChecks(result)).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(containerRuntime).not.toHaveBeenCalled();
  });

  it("orders the new ids after workspace_gitfile and sorts aliases", async () => {
    const result = await runDoctor(dependencies({ zeta: "unset", alpha: "unset", host: "host", contained: "container" }));
    const ids = result.checks.map((check) => check.id);
    expect(ids.slice(ids.lastIndexOf("workspace_gitfile") + 1)).toEqual(["workspace_mode_unset", "workspace_mode_unset", "workspace_host_writes_accepted", "container_runtime_unavailable"]);
    expect(modeChecks(result).map((check) => check.subject)).toEqual(["alpha", "zeta", "host", "contained"]);
    expect(result.exitCode).toBe(2);
    for (const output of [renderDoctorJson(result), renderDoctorHuman(result)]) {
      expect(output).not.toContain("PRIVATE_");
      expect(output).not.toContain("/");
    }
  });
});

describe("Doctor container profile acceptance", () => {
  const profile = { default: false, permissionProfile: "coding", provider: "fake", model: "fake", thinkingLevel: "off" };
  const raw = { executionProfiles: { code: profile }, skillCatalog: { impl: "builtin:pi-session-implementation" } };
  async function check(rawConfig: unknown, overrideDirectory?: string, mode: WorkspaceMode = "container", profiles = ["code"]) {
    const home = await temporaryRoot("doctor-contained-");
    const deps = dependencies({ repo: mode });
    const config = await deps.loadConfig!();
    const loadRawConfig = vi.fn(async () => rawConfig);
    const result = await runDoctor({ ...deps, home, containerRuntime: async () => true, loadRawConfig,
      loadConfig: async () => ({ ...config, ...(overrideDirectory === undefined ? {} : { skillOverrideDirectory: overrideDirectory }),
        workspaceModes: new Map([["repo", { mode, container: { writers: 1, lifecycle: "persistent", profiles, image: "node", network: "none", cache: "none", tags: "none" } }]]) }),
    });
    return { result, loadRawConfig, checks: result.checks.filter((entry) => entry.id === "container_profile_refused") };
  }

  it.each([
    ["missing profile", { executionProfiles: {} }],
    ["extensions present", { ...raw, executionProfiles: { code: { ...profile, extensions: [] } } }],
    ["MCP servers present", { ...raw, executionProfiles: { code: { ...profile, mcpServers: {} } } }],
    ["default not false", { ...raw, executionProfiles: { code: { ...profile, default: true } } }],
    ["permission not coding", { ...raw, executionProfiles: { code: { ...profile, permissionProfile: "read-only" } } }],
    ["skills not an array", { ...raw, executionProfiles: { code: { ...profile, skills: "impl" } } }],
    ["non-builtin skill", { executionProfiles: { code: { ...profile, skills: ["impl"] } }, skillCatalog: { impl: "/PRIVATE_SKILL/SKILL.md" } }],
    ["unshipped builtin skill", { executionProfiles: { code: { ...profile, skills: ["impl"] } }, skillCatalog: { impl: "builtin:not-shipped" } }],
    ["rendered schema invalid", { ...raw, executionProfiles: { code: { ...profile, model: "" } } }],
  ])("refuses %s offline without leaking configuration", async (_name, input) => {
    const { result, checks } = await check(input);
    expect(checks).toEqual([{ id: "container_profile_refused", severity: "error", subject: "repo:code", remediation: expect.any(String) }]);
    expect(result.exitCode).toBe(2);
    for (const output of [renderDoctorHuman(result), renderDoctorJson(result)]) {
      expect(output).not.toContain("PRIVATE_");
      expect(output).not.toContain("/");
    }
  });

  it("refuses operator overrides next to the configuration", async () => {
    const directory = await temporaryRoot("doctor-contained-override-");
    const overrides = skillOverrideDirectory(join(directory, "custom-config.json"));
    await mkdir(join(overrides, "pi-session-implementation"), { recursive: true });
    await writeFile(join(overrides, "pi-session-implementation", "SKILL.md"), "operator copy");
    const { checks } = await check({ ...raw, executionProfiles: { code: { ...profile, skills: ["impl"] } } }, overrides);
    expect(checks).toEqual([expect.objectContaining({ severity: "error", subject: "repo:code" })]);
  });

  it("emits one ok when all selected profiles pass and ignores unused refused profiles", async () => {
    const { checks, loadRawConfig } = await check({ ...raw, executionProfiles: {
      code: profile, skilled: { ...profile, skills: ["impl"] }, unused: { ...profile, extensions: [] },
    } }, undefined, "container", ["code", "skilled"]);
    expect(checks).toEqual([{ id: "container_profile_refused", severity: "ok", subject: "repo" }]);
    expect(loadRawConfig).toHaveBeenCalledTimes(1);
  });

  it("reports every refused profile without an ok for a partially accepted workspace", async () => {
    const { checks } = await check(raw, undefined, "container", ["missing", "code", "other"]);
    expect(checks.map(({ subject, severity }) => ({ subject, severity }))).toEqual([
      { subject: "repo:missing", severity: "error" }, { subject: "repo:other", severity: "error" },
    ]);
  });

  it("does not read raw configuration or emit the check for non-container workspaces", async () => {
    const { checks, loadRawConfig } = await check(null, undefined, "host");
    expect(checks).toEqual([]);
    expect(loadRawConfig).not.toHaveBeenCalled();
  });

  it("reports unreadable raw configuration once per container workspace without blaming profiles", async () => {
    const deps = dependencies({ repo: "container", other: "container", host: "host" });
    const config = await deps.loadConfig!();
    const readFile = vi.fn(async () => { throw new Error("PRIVATE_SECRET /private/config.json"); });
    const result = await runDoctor({ ...deps, configPath: "/private/config.json", fileSystem: { ...deps.fileSystem!, readFile }, loadConfig: async () => ({ ...config,
      workspaceModes: new Map(["repo", "other"].map((alias) => [alias, { mode: "container" as const, container: {
        writers: 1, lifecycle: "persistent" as const, profiles: ["code", "missing"], image: "node", network: "none" as const, cache: "none" as const, tags: "none" as const,
      } }])),
    }) });
    expect(result.checks.filter((entry) => entry.id === "container_profile_refused")).toEqual(
      ["other", "repo"].map((subject) => ({ id: "container_profile_refused", severity: "error", subject,
        remediation: "selected profiles could not be checked; restore configuration read access and rerun Doctor" })),
    );
    expect(readFile).toHaveBeenCalledExactlyOnceWith("/private/config.json", "utf8");
    for (const output of [renderDoctorHuman(result), renderDoctorJson(result)]) {
      expect(output).not.toContain("PRIVATE_");
      expect(output).not.toContain("/");
    }
  });

  it("reads the original configuration from the configured path without starting a writer", async () => {
    const directory = await temporaryRoot("doctor-contained-config-");
    const path = join(directory, "custom-config.json");
    await writeFile(path, JSON.stringify({ ...raw, workspaces: { repo: directory }, executionProfiles: {
      code: { ...profile, skills: ["impl"] }, ro: { ...profile, default: true, permissionProfile: "read-only" },
    } }));
    await writeFile(join(directory, "execution-modes.json"), JSON.stringify({ schemaVersion: 1, workspaces: {
      repo: { mode: "container", writers: 1, lifecycle: "persistent", profiles: ["code"], image: "node", network: "none", cache: "none" },
    } }));
    vi.stubEnv("PI_SESSION_MCP_CONFIG", join(directory, "wrong-config.json"));
    const deps = dependencies({ repo: "container" });
    // Use real filesystem reads for the raw configuration, not the fixture's placeholder.
    const { readFile } = await import("node:fs/promises");
    const result = await runDoctor({ ...deps, home: directory, configPath: path, loadConfig,
      fileSystem: { ...deps.fileSystem!, readFile }, containerRuntime: async () => true });
    expect(result.checks.filter((entry) => entry.id === "container_profile_refused")).toEqual([
      { id: "container_profile_refused", severity: "ok", subject: "repo" },
    ]);
  });
});

describe("default local container runtime probe", () => {
  async function fakePodman(body?: string) {
    const directory = await temporaryRoot("pi-session-mcp-podman-");
    if (body !== undefined) await writeFile(join(directory, "podman"), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
    vi.stubEnv("PATH", directory);
  }

  it("returns false without throwing when Podman is missing, including Doctor's default", async () => {
    await fakePodman();
    expect(await containerRuntimeUsable()).toBe(false);
    const { containerRuntime: _injected, ...deps } = dependencies({ repo: "container" });
    const result = await runDoctor(deps);
    expect(modeChecks(result)).toEqual([{ id: "container_runtime_unavailable", severity: "error", subject: "repo", remediation: expect.any(String) }]);
  });

  it.each([
    ["exit failure", "printf true; exit 1", false],
    ["not rootless", "printf false", false],
    ["rootless", "printf ' true\\n'", true],
    ["unexpected output", "printf 'true extra'", false],
    ["oversized output", "printf true; i=0; while [ \"$i\" -lt 4096 ]; do printf ' '; i=$((i+1)); done", false],
    ["exact stdout cap", "printf true; i=0; while [ \"$i\" -lt 4092 ]; do printf ' '; i=$((i+1)); done", true],
    ["stderr is ignored", "printf false >&2; printf true", true],
    ["exact arguments", "[ \"$#\" -eq 3 ] && [ \"$1\" = info ] && [ \"$2\" = --format ] && [ \"$3\" = '{{.Host.Security.Rootless}}' ] && printf true", true],
  ] as const)("handles %s offline", async (_label, body, expected) => {
    await fakePodman(body);
    expect(await containerRuntimeUsable()).toBe(expected);
  });

  it("uses the successful default probe in Doctor", async () => {
    await fakePodman("printf true");
    const { containerRuntime: _injected, ...deps } = dependencies({ repo: "container" });
    const result = await runDoctor(deps);
    expect(modeChecks(result)).toEqual([{ id: "container_runtime_unavailable", severity: "ok", subject: "repo" }]);
    expect(result.exitCode).toBe(0);
  });

  it("times out a hung probe even after it prints true", async () => {
    await fakePodman("printf true; exec /bin/sleep 30");
    expect(await containerRuntimeUsable()).toBe(false);
  }, 15_000);
});

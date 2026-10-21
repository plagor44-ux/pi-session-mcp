import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
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

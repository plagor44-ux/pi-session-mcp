import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";
import { ConfigError, type ConfigurationMetadata } from "../src/config.js";
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
});

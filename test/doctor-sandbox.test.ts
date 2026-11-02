import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";
import type { AppConfig, ConfigurationMetadata } from "../src/config.js";
import { renderDoctorHuman, runDoctor } from "../src/doctor.js";
import type { ConfiguredExecutionProfile } from "../src/execution-profile.js";

afterAll(removeTemporaryRoots);

const CONFIGURATION: ConfigurationMetadata = {
  fingerprint: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  reloadPolicy: "restart-required",
};

function profile(alias: string, extra: Partial<ConfiguredExecutionProfile> = {}): ConfiguredExecutionProfile {
  return { alias, default: alias === "p0", permissionProfile: "read-only", provider: "fake", model: "fake", thinkingLevel: "off", ...extra };
}

function configFor(workspaces: Record<string, string>, profiles: ConfiguredExecutionProfile[]): () => Promise<AppConfig> {
  return async () => ({
    workspaces: new Map(Object.entries(workspaces)),
    workspaceModes: new Map(Object.keys(workspaces).map((alias) => [alias, { mode: "host" as const }])),
    executionProfiles: new Map(profiles.map((entry) => [entry.alias, entry])),
    defaultExecutionProfile: "p0",
    configuration: CONFIGURATION,
    eventDelivery: "off",
    skillOverrideDirectory: "/hidden/skills",
  });
}

async function packageRoot(): Promise<string> {
  const root = await temporaryRoot("pi-session-mcp-doctor-sandbox-pkg-");
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.0.0", engines: { node: ">=22.19.0" } }));
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist", "main.js"), "export {};\n");
  return root;
}

async function workspace(gitfile?: string): Promise<string> {
  const dir = await temporaryRoot("pi-session-mcp-doctor-sandbox-ws-");
  if (gitfile !== undefined) await writeFile(join(dir, ".git"), gitfile);
  return dir;
}

async function run(profiles: ConfiguredExecutionProfile[], workspaces: Record<string, string>, dependencies: { sandboxProbe?: (workspace: string) => Promise<boolean>; worktreeGitDir?: (workspace: string) => Promise<string | undefined> } = {}) {
  const result = await runDoctor({ packageRoot: await packageRoot(), loadConfig: configFor(workspaces, profiles), ...dependencies });
  return { result, sandbox: result.checks.filter((check) => check.id === "sandbox_unavailable"), git: result.checks.filter((check) => check.id === "workspace_git_unavailable") };
}

describe("doctor sandbox checks", () => {
  it("runs no probe and reports nothing for profiles without a sandboxed shell", async () => {
    const probe = vi.fn(async () => false);
    const resolver = vi.fn(async () => undefined);
    const { sandbox, git } = await run([profile("p0")], { repo: await workspace("gitdir: /x/.git/worktrees/w\n") }, { sandboxProbe: probe, worktreeGitDir: resolver });
    expect(sandbox).toEqual([]);
    expect(git).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
  });

  it("checks opted-in caches without reporting their paths", async () => {
    const cache = await temporaryRoot("doctor-cache-");
    await mkdir(join(cache, "cache/download"), { recursive: true });
    const repo = await workspace();
    const probe = vi.fn(async (_path: string, selection?: unknown) => selection === undefined);
    const { result } = await run([profile("p0", { shell: "sandboxed", goModuleCache: cache })], { repo }, { sandboxProbe: probe });
    expect(result.checks.find(check => check.id === "sandbox_go_cache_unavailable")).toMatchObject({ severity: "error", subject: "p0" });
    expect(JSON.stringify(result)).not.toContain(cache);
    expect(JSON.stringify(result)).not.toContain(repo);
    expect(probe).toHaveBeenCalledTimes(2);
    const success = await run([profile("p0", { shell: "sandboxed", goModuleCache: cache })], { repo }, { sandboxProbe: async () => true });
    expect(success.result.checks.find(check => check.id === "sandbox_go_cache_unavailable")?.severity).toBe("ok");
    const missing = await run([profile("p0", { shell: "sandboxed", goModuleCache: join(cache, "missing") })], { repo }, { sandboxProbe: async () => true });
    expect(missing.result.checks.find(check => check.id === "sandbox_go_cache_unavailable")).toMatchObject({ severity: "error", remediation: expect.stringContaining("create") });
    const noWorkspace = await run([profile("p0", { shell: "sandboxed", goModuleCache: cache })], { repo }, { sandboxProbe: async () => false });
    const noPass = noWorkspace.result.checks.find(check => check.id === "sandbox_go_cache_unavailable");
    expect(noPass).toMatchObject({ severity: "error", subject: "p0", remediation: expect.stringContaining("sandbox_unavailable") });
    expect(JSON.stringify(noWorkspace.result)).not.toContain(cache);
  });

  it("reports cache classification failures with fixed remediation", async () => {
    const root = await temporaryRoot("doctor-cache-classify-");
    const file = join(root, "file"); await writeFile(file, "x");
    const empty = join(root, "empty"); await mkdir(empty);
    const home = join(root, "home"); await mkdir(join(home, "cache/download"), { recursive: true });
    const repo = await workspace();
    for (const [cache, remediation] of [[file, "directory"], [empty, "cache/download"], [home, "dedicated"]] as const) {
      const result = await runDoctor({ packageRoot: await packageRoot(), home, agentDir: join(home, ".pi/agent"), sandboxProbe: async () => true, loadConfig: configFor({ repo }, [profile("p0", { shell: "sandboxed", goModuleCache: cache })]) });
      expect(result.checks.find(check => check.id === "sandbox_go_cache_unavailable")).toMatchObject({ severity: "error", remediation: expect.stringContaining(remediation) });
      expect(JSON.stringify(result)).not.toContain(root);
    }
  });

  it("refuses a cache that equals, contains or lies inside the configuration or agent directory", async () => {
    const root = await temporaryRoot("doctor-cache-protected-");
    const home = join(root, "home"); await mkdir(home);
    const configDir = join(root, "cfg"); const agentDir = join(root, "agent");
    for (const dir of [configDir, agentDir]) {
      await mkdir(join(dir, "inner/cache/download"), { recursive: true });
      await mkdir(join(dir, "cache/download"), { recursive: true });
    }
    await mkdir(join(root, "cache/download"), { recursive: true });
    const configPath = join(configDir, "pi-session-mcp.json"); await writeFile(configPath, "{}");
    const repo = await workspace();
    const probe = vi.fn(async () => true);
    for (const cache of [configDir, join(configDir, "inner"), root, agentDir, join(agentDir, "inner")]) {
      const result = await runDoctor({ packageRoot: await packageRoot(), home, agentDir, configPath, sandboxProbe: probe, loadConfig: configFor({ repo }, [profile("p0", { shell: "sandboxed", goModuleCache: cache })]) });
      expect(result.checks.find(check => check.id === "sandbox_go_cache_unavailable"), cache).toMatchObject({ severity: "error", remediation: expect.stringContaining("dedicated") });
    }
    const fine = join(root, "dedicated"); await mkdir(join(fine, "cache/download"), { recursive: true });
    const result = await runDoctor({ packageRoot: await packageRoot(), home, agentDir, configPath, sandboxProbe: probe, loadConfig: configFor({ repo }, [profile("p0", { shell: "sandboxed", goModuleCache: fine })]) });
    expect(result.checks.find(check => check.id === "sandbox_go_cache_unavailable")?.severity).toBe("ok");
  });

  it("probes each existing workspace directory, reporting per workspace alias", async () => {
    const a = await workspace();
    const b = await workspace();
    const probe = vi.fn(async (path: string) => path === a);
    const { result, sandbox } = await run([profile("p0", { shell: "sandboxed" }), profile("p1", { shell: "sandboxed" }), profile("p2")], { alpha: a, beta: b }, { sandboxProbe: probe });
    expect(probe.mock.calls.map(([path]) => path)).toEqual([a, b]);
    expect(sandbox).toEqual([
      { id: "sandbox_unavailable", severity: "ok", subject: "alpha" },
      { id: "sandbox_unavailable", severity: "error", subject: "beta", remediation: expect.stringMatching(/overlay lower layer.*systemd user manager.*memory and pids delegated/) },
    ]);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(renderDoctorHuman(result)).toContain("ERROR sandbox_unavailable [beta]");
  });

  it("reports ok for every workspace when all probes succeed", async () => {
    const { result, sandbox } = await run([profile("p0", { shell: "sandboxed" })], { alpha: await workspace(), beta: await workspace() }, { sandboxProbe: async () => true });
    expect(sandbox.map((check) => [check.severity, check.subject])).toEqual([["ok", "alpha"], ["ok", "beta"]]);
    expect(result.exitCode).toBe(0);
  });

  it("skips a workspace that is missing or not a directory", async () => {
    const file = join(await temporaryRoot("pi-session-mcp-doctor-sandbox-file-"), "f");
    await writeFile(file, "x");
    const probe = vi.fn(async () => true);
    const { sandbox } = await run([profile("p0", { shell: "sandboxed" })], { gone: join(file, "..", "missing"), file, good: await workspace() }, { sandboxProbe: probe });
    expect(sandbox.map((check) => check.subject)).toEqual(["good"]);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("treats a probe that throws as a failed probe", async () => {
    const { sandbox } = await run([profile("p0", { shell: "sandboxed" })], { repo: await workspace() }, { sandboxProbe: async () => { throw new Error("boom"); } });
    expect(sandbox.map((check) => check.severity)).toEqual(["error"]);
  });

  it("warns once per workspace whose gitfile pointer is unusable", async () => {
    const linked = await workspace("gitdir: /x/.git/worktrees/w\n");
    const plain = await workspace();
    const resolver = vi.fn(async (path: string) => path === linked ? undefined : "/main/.git");
    const { result, git } = await run([profile("p0", { shell: "sandboxed" })], { linked, plain }, { sandboxProbe: async () => true, worktreeGitDir: resolver });
    expect(git).toEqual([{ id: "workspace_git_unavailable", severity: "warning", subject: "linked", remediation: expect.stringContaining("Git commands fail inside the shell sandbox") }]);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(1);
  });

  it("reports ok for a usable worktree pointer and stays silent without a gitfile", async () => {
    const linked = await workspace("gitdir: /x/.git/worktrees/w\n");
    const { git } = await run([profile("p0", { shell: "sandboxed" })], { linked, plain: await workspace() }, { sandboxProbe: async () => true, worktreeGitDir: async () => "/main/.git" });
    expect(git).toEqual([{ id: "workspace_git_unavailable", severity: "ok", subject: "linked" }]);
  });

  it("uses the real resolver by default and rejects a pointer to an unrelated directory", async () => {
    const fakeHome = await temporaryRoot("pi-session-mcp-doctor-sandbox-home-");
    const { git } = await run([profile("p0", { shell: "sandboxed" })], { repo: await workspace(`gitdir: ${fakeHome}\n`) }, { sandboxProbe: async () => true });
    expect(git.map((check) => [check.severity, check.subject])).toEqual([["warning", "repo"]]);
  });

  it("contains a throwing resolver as an unusable pointer", async () => {
    const { git } = await run([profile("p0", { shell: "sandboxed" })], { repo: await workspace("gitdir: /x/.git/worktrees/w\n") }, { sandboxProbe: async () => true, worktreeGitDir: async () => { throw new Error("boom"); } });
    expect(git.map((check) => check.severity)).toEqual(["warning"]);
  });

  it("probes the real sandbox by default without leaving state behind", async () => {
    const { sandbox } = await run([profile("p0", { shell: "sandboxed" })], { repo: await workspace() });
    expect(sandbox).toHaveLength(1);
    expect(["ok", "error"]).toContain(sandbox[0]!.severity);
  });
});

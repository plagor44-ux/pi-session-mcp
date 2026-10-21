import { chmod, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";
import type { AppConfig, ConfigurationMetadata } from "../src/config.js";
import { renderDoctorHuman, renderDoctorJson, runDoctor, type DoctorFileSystem } from "../src/doctor.js";

const CONFIGURATION: ConfigurationMetadata = {
  fingerprint: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  reloadPolicy: "restart-required",
};

function profile(alias: string, permissionProfile: "coding" | "read-only", isDefault: boolean) {
  return { alias, default: isDefault, permissionProfile, provider: "fake", model: "fake", thinkingLevel: "off" as const };
}

function configFor(workspaces: Record<string, string>, permissionProfiles: readonly ("coding" | "read-only")[]): () => Promise<AppConfig> {
  return async () => ({
    workspaces: new Map(Object.entries(workspaces)),
    workspaceModes: new Map(Object.keys(workspaces).map((alias) => [alias, { mode: "host" as const }])),
    executionProfiles: new Map(permissionProfiles.map((permission, index) => [`p${index}`, profile(`p${index}`, permission, index === 0)])),
    defaultExecutionProfile: "p0",
    configuration: CONFIGURATION,
    eventDelivery: "off",
    skillOverrideDirectory: "/hidden/skills",
  });
}

/** A package root that Doctor accepts as built, so that only workspace checks can add findings. */
async function packageRoot(): Promise<string> {
  const root = await temporaryRoot("pi-session-mcp-gitfile-pkg-");
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.0.0", engines: { node: ">=22.19.0" } }));
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist", "main.js"), "export {};\n");
  return root;
}

/** A workspace directory; `git` is the content of its `.git` entry, created by `setup`. */
async function workspace(setup?: (gitPath: string) => Promise<void>): Promise<string> {
  const dir = await temporaryRoot("pi-session-mcp-gitfile-ws-");
  if (setup) await setup(join(dir, ".git"));
  return dir;
}

const gitfile = (content: string) => (path: string) => writeFile(path, content);

async function gitfileChecks(workspaces: Record<string, string>, permissionProfiles: readonly ("coding" | "read-only")[], dependencies: { fileSystem?: DoctorFileSystem } = {}) {
  const result = await runDoctor({ packageRoot: await packageRoot(), loadConfig: configFor(workspaces, permissionProfiles), ...dependencies });
  return { result, checks: result.checks.filter((check) => check.id === "workspace_gitfile") };
}

afterAll(removeTemporaryRoots);

describe("doctor workspace_gitfile", () => {
  it("warns exactly once per alias for a valid gitfile when a coding profile exists", async () => {
    const withGitfile = await workspace(gitfile("gitdir: /somewhere/else/.git/worktrees/w\n"));
    const plain = await workspace();
    const { result, checks } = await gitfileChecks({ linked: withGitfile, plain }, ["read-only", "coding"]);
    expect(checks).toEqual([
      { id: "workspace_gitfile", severity: "warning", subject: "linked", remediation: expect.stringContaining("possible linked worktree") },
      { id: "workspace_gitfile", severity: "ok", subject: "plain" },
    ]);
    expect(checks[0]?.remediation).toContain("separate full clone");
    expect(result.exitCode).toBe(1);
    expect(result.ok).toBe(true);
  });

  it("sorts directly after workspace_not_writable", async () => {
    const { result } = await gitfileChecks({ linked: await workspace(gitfile("gitdir: x\n")) }, ["coding"]);
    const ids = result.checks.map((check) => check.id);
    expect(ids[ids.indexOf("workspace_not_writable") + 1]).toBe("workspace_gitfile");
  });

  it("does not warn for a normal .git directory or a non-repository directory", async () => {
    const repository = await workspace((path) => mkdir(path));
    const { result, checks } = await gitfileChecks({ repo: repository, plain: await workspace() }, ["coding"]);
    expect(checks.map((check) => check.severity)).toEqual(["ok", "ok"]);
    expect(result.exitCode).toBe(0);
  });

  it("does not warn or emit a check when only read-only profiles exist", async () => {
    const { result, checks } = await gitfileChecks({ linked: await workspace(gitfile("gitdir: /x\n")) }, ["read-only"]);
    expect(checks).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("warns for submodule-style and separate-git-dir-style gitfiles alike", async () => {
    const submodule = await workspace(gitfile("gitdir: ../.git/modules/x\n"));
    const separate = await workspace(gitfile("gitdir: /srv/repos/project.git"));
    const noSpace = await workspace(gitfile("gitdir:/srv/repos/project.git\r\n"));
    const { checks } = await gitfileChecks({ submodule, separate, noSpace }, ["coding"]);
    expect(checks.map((check) => check.severity)).toEqual(["warning", "warning", "warning"]);
  });

  it.each([
    ["empty", ""],
    ["prefix only", "gitdir:\n"],
    ["prefix with blanks only", "gitdir:   \n\n"],
    ["wrong prefix", "ref: refs/heads/main\n"],
    ["prefix not at the start", "\ngitdir: x\n"],
    ["binary", "\u0000\u0001\u0002"],
  ])("does not warn for an invalid gitfile (%s)", async (_name, content) => {
    const { checks } = await gitfileChecks({ w: await workspace(gitfile(content)) }, ["coding"]);
    expect(checks).toEqual([{ id: "workspace_gitfile", severity: "ok", subject: "w" }]);
  });

  it("does not warn for an oversized file, even one that starts with a gitdir prefix", async () => {
    const big = await workspace(gitfile(`gitdir: ${"a".repeat(5000)}\n`));
    const exact = await workspace(gitfile(`gitdir: ${"a".repeat(4096 - 8)}`));
    const { checks } = await gitfileChecks({ big, exact }, ["coding"]);
    expect(checks.find((check) => check.subject === "big")?.severity).toBe("ok");
    // A file of exactly the 4 KiB cap is still inspected.
    expect(checks.find((check) => check.subject === "exact")?.severity).toBe("warning");
  });

  it("does not read more than the cap when the file grows after the size check", async () => {
    const dir = await workspace();
    let requested = 0;
    const fileSystem: DoctorFileSystem = {
      readFile: (path, encoding) => readFile(path, encoding),
      stat: (path) => stat(path),
      access: async () => undefined,
      lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, size: 20 }),
      readPrefix: async (_path, maxBytes) => { requested = maxBytes; return `gitdir: ${"a".repeat(maxBytes)}`; },
    };
    const { checks } = await gitfileChecks({ w: dir }, ["coding"], { fileSystem });
    expect(requested).toBe(4097);
    expect(checks.map((check) => check.severity)).toEqual(["ok"]);
  });

  it("does not follow a symbolic link named .git, whatever it points to", async () => {
    const target = await workspace(gitfile("gitdir: /x\n"));
    const link = await workspace((path) => symlink(join(target, ".git"), path));
    const dangling = await workspace((path) => symlink("/nonexistent/pi-session-mcp-gitfile", path));
    const { checks } = await gitfileChecks({ link, dangling }, ["coding"]);
    expect(checks.map((check) => check.severity)).toEqual(["ok", "ok"]);
  });

  it.skipIf(process.getuid?.() === 0)("treats an unreadable .git file as not detected without failing Doctor", async () => {
    const dir = await workspace(gitfile("gitdir: /x\n"));
    await chmod(join(dir, ".git"), 0o000);
    try {
      const { result, checks } = await gitfileChecks({ w: dir }, ["coding"]);
      expect(checks).toEqual([{ id: "workspace_gitfile", severity: "ok", subject: "w" }]);
      expect(result.exitCode).toBe(0);
    } finally { await chmod(join(dir, ".git"), 0o600); }
  });

  it("treats an lstat or read failure as not detected without failing Doctor", async () => {
    const dir = await workspace(gitfile("gitdir: /x\n"));
    const denied = (): never => { throw Object.assign(new Error("denied /private/path"), { code: "EACCES" }); };
    const base = { readFile: (path: string, encoding: "utf8") => readFile(path, encoding), stat: (path: string) => stat(path), access: async () => undefined };
    const lstatFails = await gitfileChecks({ w: dir }, ["coding"], { fileSystem: { ...base, lstat: async () => denied() } });
    const readFails = await gitfileChecks({ w: dir }, ["coding"], { fileSystem: { ...base, lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, size: 10 }), readPrefix: async () => denied() } });
    for (const { result, checks } of [lstatFails, readFails]) {
      expect(checks).toEqual([{ id: "workspace_gitfile", severity: "ok", subject: "w" }]);
      expect(JSON.stringify(result)).not.toContain("private");
    }
  });

  it("keeps exit code 2 when an error exists next to the warning", async () => {
    const linked = await workspace(gitfile("gitdir: /x\n"));
    const missing = join(await temporaryRoot("pi-session-mcp-gitfile-gone-"), "absent");
    const { result, checks } = await gitfileChecks({ linked, missing }, ["coding"]);
    expect(checks).toContainEqual(expect.objectContaining({ subject: "linked", severity: "warning" }));
    expect(result.checks).toContainEqual(expect.objectContaining({ id: "workspace_missing", severity: "error" }));
    expect(result.exitCode).toBe(2);
    expect(result.ok).toBe(false);
  });

  it("outputs no path or gitdir content in JSON or human form", async () => {
    const dir = await workspace(gitfile("gitdir: /SECRET_GITDIR/.git/worktrees/w\n"));
    const { result } = await gitfileChecks({ linked: dir }, ["coding"]);
    for (const output of [renderDoctorJson(result), renderDoctorHuman(result)]) {
      expect(output).not.toContain(dir);
      expect(output).not.toContain("SECRET_GITDIR");
      expect(output).not.toContain("/tmp");
      expect(output).not.toContain("gitdir:");
    }
    expect(renderDoctorHuman(result)).toContain("WARNING workspace_gitfile [linked]:");
  });
});

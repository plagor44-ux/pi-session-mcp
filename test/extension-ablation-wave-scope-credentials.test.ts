import { type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseArgs, withAbort } from "../eval/extensions/cli.js";
import { buildMatrix, PAIRINGS } from "../eval/extensions/matrix.js";
import { HostCredentialError, fileHostCredentials, type HostCredentials } from "../eval/extensions/credentials.js";
import { assertPreflightPassed, runPreflight } from "../eval/extensions/preflight.js";
import { scoreImplementation } from "../eval/extensions/oracles.js";
import { runWave, type WaveDeps } from "../eval/extensions/wave.js";
import { assertCloneSymlinks, prepareEmptyScope, prepareRunScope, privateRunDir, runConfig, scopeEnv, scopeRoot, type RunScope } from "../eval/extensions/workspace.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";
import { exec, PROFILE, CODING, OPT_OUT, CODEGRAPH_SERVER, productionConfig, fake, fakePrepare, reviewTask, approvalFor, seedLedger, seams, waveSetup, baseDeps, findFiles, realTools, text } from "./extension-ablation-wave-fixtures.js";

afterAll(removeTemporaryRoots);

describe("run scope", () => {
  it("refuses a clone symlink that resolves outside the clone (R15)", async () => {
    const root = await temporaryRoot("ablation-symlink-");
    const outside = join(root, "outside");
    await mkdir(outside);
    const clone = join(root, "clone");
    await mkdir(join(clone, "src"), { recursive: true });
    await writeFile(join(clone, "src", "a.ts"), "x");
    await symlink("a.ts", join(clone, "src", "inside-link"));
    await symlink("missing.ts", join(clone, "src", "dangling-inside"));
    await assertCloneSymlinks(clone);
    await symlink(outside, join(clone, "escape"));
    await expect(assertCloneSymlinks(clone)).rejects.toThrow("clone_symlink_escape");
  });

  it("refuses an absolute and a dangling symlink to the outside", async () => {
    const root = await temporaryRoot("ablation-symlink2-");
    const clone = join(root, "clone");
    await mkdir(join(clone, "deep"), { recursive: true });
    await symlink("/etc/passwd", join(clone, "deep", "abs"));
    await expect(assertCloneSymlinks(clone)).rejects.toThrow("clone_symlink_escape");
    const second = join(root, "clone2");
    await mkdir(second);
    await symlink("../nowhere", join(second, "dangling-outside"));
    await expect(assertCloneSymlinks(second)).rejects.toThrow("clone_symlink_escape");
  });

  it("builds the run configuration with exactly one read-only default", () => {
    const review = runConfig("review", "A", PROFILE, "/c", { s: "builtin:s" }, undefined) as { executionProfiles: Record<string, { default: boolean }>; workspaces: unknown };
    expect(review.workspaces).toEqual({ clone: "/c" });
    expect(Object.keys(review.executionProfiles)).toEqual(["review"]);
    expect(review.executionProfiles.review!.default).toBe(true);
    const code = runConfig("code", "A", CODING, "/c", undefined, undefined) as { executionProfiles: Record<string, { default: boolean; permissionProfile: string }> };
    expect(Object.entries(code.executionProfiles).map(([k, v]) => [k, v.permissionProfile, v.default])).toEqual([["code", "coding", false], ["code-ro", "read-only", true]]);
  });

  it("forwards the telemetry and update-check opt-out to every MCP server and changes nothing else (R65)", () => {
    const profile = { ...PROFILE, mcpServers: {
      codegraph: CODEGRAPH_SERVER,
      other: { command: "/usr/bin/other", envFrom: { TOKEN: "HOST_TOKEN", DO_NOT_TRACK: "SOMETHING_ELSE" }, tools: { t: { name: "t", readOnly: true } } },
    } };
    const before = structuredClone(profile);
    const { executionProfiles } = runConfig("review", "A", profile, "/c", undefined, undefined) as { executionProfiles: { review: { mcpServers: Record<string, { envFrom: Record<string, string> }> } & Record<string, unknown> } };
    const { mcpServers, ...rest } = executionProfiles.review;
    expect(mcpServers.codegraph!.envFrom).toEqual(OPT_OUT);
    expect(mcpServers.other!.envFrom).toEqual({ TOKEN: "HOST_TOKEN", ...OPT_OUT });
    const { envFrom: _kept, ...otherRest } = mcpServers.other!;
    expect(otherRest).toEqual({ command: "/usr/bin/other", tools: { t: { name: "t", readOnly: true } } });
    expect(rest).toEqual({ ...PROFILE, default: true });
    expect(profile).toEqual(before);
    const code = runConfig("code", "A", { ...CODING, mcpServers: { codegraph: CODEGRAPH_SERVER } }, "/c", undefined, undefined) as { executionProfiles: Record<string, { mcpServers: Record<string, { envFrom: unknown }> }> };
    for (const entry of Object.values(code.executionProfiles)) expect(entry.mcpServers.codegraph!.envFrom).toEqual(OPT_OUT);
  });

  it("refuses an MCP server whose merged envFrom would exceed the product limit", () => {
    const envFrom = Object.fromEntries(Array.from({ length: 62 }, (_, i) => [`VAR_${i}`, `HOST_${i}`]));
    expect(() => runConfig("review", "A", { ...PROFILE, mcpServers: { codegraph: { ...CODEGRAPH_SERVER, envFrom } } }, "/c", undefined, undefined)).toThrow("mcp_env_from_overflow");
  });

  it("adds the pin to arm B and the granted tools on review pairings only", () => {
    const pl = PAIRINGS.find((p) => p.id === "pl-review")!;
    const b = runConfig("review", "pi-lens", PROFILE, "/c", undefined, pl) as { executionProfiles: { review: Record<string, unknown> } };
    expect(b.executionProfiles.review.extensions).toEqual(["npm:pi-lens@4.4.3"]);
    expect(b.executionProfiles.review.grantedExtensionTools).toEqual(pl.grantedExtensionTools);
    const code = runConfig("code", "pi-lens", CODING, "/c", undefined, PAIRINGS.find((p) => p.id === "pl-code")!) as { executionProfiles: { code: Record<string, unknown> } };
    expect(code.executionProfiles.code.extensions).toEqual(["npm:pi-lens@4.4.3"]);
    expect(code.executionProfiles.code.grantedExtensionTools).toBeUndefined();
    expect(() => runConfig("review", "pi-lens", PROFILE, "/c", undefined, undefined)).toThrow("pairing_not_found");
  });

  it("clones at the base commit, keeps a pristine bare clone outside the root and isolates the environment", async () => {
    const root = await temporaryRoot("ablation-scope-");
    const source = join(root, "source");
    await mkdir(source);
    const git = (...args: string[]) => exec("git", ["-C", source, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args]);
    await git("init", "--quiet");
    await writeFile(join(source, "a.txt"), "base");
    await git("add", "."); await git("commit", "--quiet", "-m", "base");
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    await writeFile(join(source, "a.txt"), "later");
    await git("commit", "--quiet", "-am", "later");
    // A stand-in `codegraph` keeps the test independent of the installed index tool.
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "codegraph"), "#!/bin/sh\nmkdir -p \"$3/.codegraph\"\n");
    await chmod(join(bin, "codegraph"), 0o755);
    const template = join(root, "template");
    await mkdir(join(template, "npm", "node_modules", "pi-lens"), { recursive: true });
    await writeFile(join(template, "npm", "node_modules", "pi-lens", "index.js"), "x");
    const task = { ...(await reviewTask(root, "S1")), baseCommit: base };
    const run = buildMatrix([task], PAIRINGS.filter((p) => p.id === "pl-review")).find((x) => x.arm === "pi-lens")!;
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    let scope: RunScope;
    try {
      scope = await prepareRunScope({
        waveDir: join(root, "wave"), run, task, sourceRepoPath: source, extensionTemplate: template,
        hostAuth: { openai: { type: "oauth", access: "tok", refresh: "secret-refresh", expires: 1 }, xai: { type: "api_key", key: "other" } },
        productionProfile: { ...PROFILE, mcpServers: { codegraph: CODEGRAPH_SERVER } }, skillCatalog: productionConfig.skillCatalog, pairing: PAIRINGS.find((p) => p.id === "pl-review"), tools: await realTools(bin),
      });
    } finally { process.env.PATH = previousPath; }
    expect(await readFile(join(scope.clone, "a.txt"), "utf8")).toBe("base");
    // I3: the clone's remotes point at the pristine bare clone outside the root, never at the real repository.
    const remotes = (await exec("git", ["-C", scope.clone, "remote", "-v"])).stdout.trim().split("\n");
    expect(remotes).toHaveLength(2);
    for (const line of remotes) expect(line).toMatch(new RegExp(`^origin\\t${scope.baseGitDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\((fetch|push)\\)$`));
    expect(await readFile(join(scope.clone, ".git", "info", "exclude"), "utf8")).toContain(".codegraph/");
    expect(scope.baseGitDir.startsWith(scope.root)).toBe(false);
    expect((await exec("git", ["--git-dir", scope.baseGitDir, "cat-file", "-t", base])).stdout.trim()).toBe("commit");
    const auth = JSON.parse(await readFile(join(scope.agentDir, "auth.json"), "utf8")) as Record<string, { refresh?: string; access?: string }>;
    expect(Object.keys(auth)).toEqual(["openai"]);
    expect(auth.openai).toMatchObject({ access: "tok", refresh: "" });
    expect(existsSync(join(scope.agentDir, "npm", "node_modules", "pi-lens", "index.js"))).toBe(true);
    const config = JSON.parse(await readFile(scope.configPath, "utf8")) as { workspaces: { clone: string }; executionProfiles: Record<string, { extensions?: string[]; mcpServers?: unknown }> };
    expect(config.workspaces.clone).toBe(scope.clone);
    // R65: the MCP child does not inherit the run environment, so the written configuration forwards the opt-out variables to it.
    expect(config.executionProfiles.review!.mcpServers).toEqual({ codegraph: { ...CODEGRAPH_SERVER, envFrom: OPT_OUT } });
    expect(config.executionProfiles.review!.extensions).toEqual(["npm:pi-lens@4.4.3"]);
    for (const key of ["HOME", "PI_CODING_AGENT_DIR", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "PI_LENS_HOME"]) {
      expect(scope.env[key]!.startsWith(scope.root + "/")).toBe(true);
    }
    expect(scope.env).toMatchObject({ PI_LENS_DISABLE_TOOL_INSTALL: "1", PI_LENS_DISABLE_LSP_INSTALL: "1", PI_CACHE_OPTIMIZER_NO_ZERO_PRICE_WARMING: "1", UV_USE_IO_URING: "0" });
    // R73: package managers fail fast offline, the same in every run and arm.
    expect(scope.env).toMatchObject({ GOPROXY: "off", GOTOOLCHAIN: "local", UV_OFFLINE: "1", UV_NO_SYNC: "1", UV_PYTHON_DOWNLOADS: "never", npm_config_offline: "true" });
    expect(scope.env).not.toHaveProperty("GOFLAGS");
    expect(scope.env).toMatchObject({ DO_NOT_TRACK: "1", CODEGRAPH_NO_UPDATE_CHECK: "1", CODEGRAPH_TELEMETRY: "0" });
  });

  it("never gives a run or the oracle the variables that point at a display server, a bus, an agent or the runtime directory (R88)", async () => {
    const names = ["DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "SSH_AUTH_SOCK", "XDG_RUNTIME_DIR"];
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    for (const name of names) process.env[name] = `host-${name}`;
    const root = await temporaryRoot("ablation-no-session-env-");
    const clone = join(root, "clone");
    await mkdir(clone);
    const git = (...args: string[]) => exec("git", ["-C", clone, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args]);
    await git("init", "--quiet");
    await writeFile(join(clone, "a.txt"), "base\n");
    await git("add", "a.txt"); await git("commit", "--quiet", "-m", "base");
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    try {
      const env = scopeEnv("/scope", { home: "/scope/home", agentDir: "/scope/agent" });
      for (const name of names) expect(env, name).not.toHaveProperty(name);
      expect(JSON.stringify(env)).not.toContain("host-");
      const score = await scoreImplementation(clone, {
        allowedPaths: ["env.txt"], scopeIgnore: [], baseCommit: base,
        oracle: { kind: "implementation", command: ["sh", "-c", "env > env.txt"], timeoutMs: 30_000 },
      }, { gitDir: join(clone, ".git"), home: join(root, "oracle-home") });
      expect(score.testsPassed).toBe(true);
    } finally {
      for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    }
    const seen = await readFile(join(clone, "env.txt"), "utf8");
    for (const name of names) expect(seen).not.toContain(`${name}=`);
    expect(seen).not.toContain("host-");
  });

  it("keeps the offline package-manager variables out of the oracle's own minimal environment (R73)", async () => {
    const root = await temporaryRoot("ablation-oracle-env-");
    const clone = join(root, "clone");
    await mkdir(clone);
    const git = (...args: string[]) => exec("git", ["-C", clone, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args]);
    await git("init", "--quiet");
    await writeFile(join(clone, "a.txt"), "base\n");
    await git("add", "a.txt"); await git("commit", "--quiet", "-m", "base");
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    const previous = { GOPROXY: process.env.GOPROXY, UV_OFFLINE: process.env.UV_OFFLINE };
    Object.assign(process.env, { GOPROXY: "host-value", UV_OFFLINE: "host-value" });
    try {
      const score = await scoreImplementation(clone, {
        allowedPaths: ["env.txt"], scopeIgnore: [], baseCommit: base,
        oracle: { kind: "implementation", command: ["sh", "-c", "env > env.txt"], timeoutMs: 30_000 },
      }, { gitDir: join(clone, ".git"), home: join(root, "oracle-home") });
      expect(score.testsPassed).toBe(true);
    } finally {
      for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    }
    const seen = (await readFile(join(clone, "env.txt"), "utf8")).split("\n").map((line) => line.split("=")[0]);
    for (const name of ["GOPROXY", "GOTOOLCHAIN", "GOFLAGS", "UV_OFFLINE", "UV_NO_SYNC", "UV_PYTHON_DOWNLOADS", "npm_config_offline"]) expect(seen).not.toContain(name);
    expect(seen).toEqual(expect.arrayContaining(["HOME", "TMPDIR", "CI"]));
  });

  it("removes a failed scope with its credentials and its bare clone", async () => {
    const root = await temporaryRoot("ablation-scope-fail-");
    const source = join(root, "source");
    await mkdir(source);
    const git = (...args: string[]) => exec("git", ["-C", source, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args]);
    await git("init", "--quiet");
    await writeFile(join(source, "a.txt"), "base");
    await git("add", "."); await git("commit", "--quiet", "-m", "base");
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "codegraph"), "#!/bin/sh\nmkdir -p \"$3/.codegraph\"\n");
    await chmod(join(bin, "codegraph"), 0o755);
    const task = { ...(await reviewTask(root, "S3")), baseCommit: base };
    const run = buildMatrix([task], PAIRINGS.filter((p) => p.id === "pl-review")).find((x) => x.arm === "pi-lens")!;
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    try {
      // The extension template is missing, so the failure comes after the credentials were written.
      await expect(prepareRunScope({
        waveDir: join(root, "wave"), run, task, sourceRepoPath: source, extensionTemplate: join(root, "no-template"),
        hostAuth: { openai: { type: "oauth", access: "tok", refresh: "r", expires: 1 } }, productionProfile: PROFILE, pairing: PAIRINGS.find((p) => p.id === "pl-review"), tools: await realTools(bin),
      })).rejects.toThrow();
    } finally { process.env.PATH = previousPath; }
    expect(existsSync(scopeRoot(join(root, "wave"), run.runId))).toBe(false);
    expect(existsSync(join(privateRunDir(join(root, "wave"), run.runId), "base.git"))).toBe(false);
  });

  it("refuses a repository whose clone holds an escaping symlink", async () => {
    const root = await temporaryRoot("ablation-scope-link-");
    const source = join(root, "source");
    await mkdir(source);
    const git = (...args: string[]) => exec("git", ["-C", source, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args]);
    await git("init", "--quiet");
    await symlink("/etc", join(source, "link"));
    await git("add", "."); await git("commit", "--quiet", "-m", "link");
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    const task = { ...(await reviewTask(root, "S2")), baseCommit: base };
    const run = buildMatrix([task], PAIRINGS.filter((p) => p.id === "pl-review"))[0]!;
    await expect(prepareRunScope({
      waveDir: join(root, "wave"), run, task, sourceRepoPath: source, extensionTemplate: join(root, "t"), hostAuth: {}, productionProfile: PROFILE, tools: await realTools(),
    })).rejects.toThrow("clone_symlink_escape");
  });
});

/** R86: OAuth credentials are refreshed on the host before each route and run; the refresh is a fake seam, the real auth file is never touched. */
describe("host credential refresh (R86)", () => {
  const SECRET_REFRESH = "REFRESH-TOKEN-SECRET";
  const oauth = (access: string, expiresInMs: number) => ({ openai: { type: "oauth", access, refresh: SECRET_REFRESH, expires: Date.now() + expiresInMs } });

  /** A fake host: `refresh` is called with the provider, `fresh` replaces the stored auth at the n-th call (or the call fails). */
  function fakeHost(initial: unknown, behaviour: { fresh?: (n: number) => unknown; fail?: boolean } = {}) {
    const calls: string[] = [];
    let stored = initial;
    let reads = 0;
    const host: HostCredentials = {
      read: async () => { reads += 1; return stored; },
      refresh: async (provider) => {
        calls.push(provider);
        if (behaviour.fail) throw new Error(`refresh failed with ${SECRET_REFRESH}`);
        if (behaviour.fresh) stored = behaviour.fresh(calls.length);
      },
    };
    return { host, calls, reads: () => reads, stored: () => stored };
  }
  async function withStderr<T>(body: () => Promise<T>): Promise<{ result: T; stderr: string }> {
    let stderr = "";
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write);
    try { return { result: await body(), stderr }; } finally { spy.mockRestore(); }
  }
  /** The access token the scope was prepared with, per run. */
  const copied = (accesses: string[]): Partial<WaveDeps> => ({
    prepareScope: async (input) => {
      const entry = (input.hostAuth as { openai?: { access?: string } }).openai;
      accesses.push(entry?.access ?? "none");
      return fakePrepare(input);
    },
  });
  const everythingOnDisk = async (dir: string): Promise<string> => (await Promise.all((await findFiles(dir, /./)).map((file) => readFile(file, "utf8")))).join("\n");

  it("refreshes an OAuth provider once per run, reads the auth again and copies the re-read credential", async () => {
    const source = fakeHost(oauth("old-access", 3_600_000), { fresh: (n) => oauth(`fresh-access-${n}`, 3_600_000) });
    const s = await waveSetup(4, { hostAuth: oauth("old-access", 3_600_000), hostCredentials: source.host });
    const accesses: string[] = [];
    const { result, stderr } = await withStderr(() => runWave(s.input, s.deps(Array.from({ length: 4 }, () => text()), copied(accesses)).deps));
    expect(result.stopReason).toBeNull();
    expect(source.calls).toEqual(["openai", "openai", "openai", "openai"]);
    expect(source.reads()).toBe(4);
    expect(accesses).toEqual(["fresh-access-1", "fresh-access-2", "fresh-access-3", "fresh-access-4"]);
    expect(stderr).not.toContain("credential_refresh_failed");
    // Records keep the type of the credential only.
    expect(result.records.map((r) => r.authType)).toEqual(["oauth", "oauth", "oauth", "oauth"]);
    const disk = await everythingOnDisk(s.waveDir);
    for (const secret of [SECRET_REFRESH, "fresh-access", "old-access"]) { expect(disk).not.toContain(secret); expect(stderr).not.toContain(secret); }
  });

  it("never refreshes an API key", async () => {
    const source = fakeHost({ openai: { type: "api_key", key: "sk-api-key-secret" } });
    const s = await waveSetup(2, { hostAuth: { openai: { type: "api_key", key: "sk-api-key-secret" } }, hostCredentials: source.host });
    const { result } = await withStderr(() => runWave(s.input, s.deps([text(), text()]).deps));
    expect(result.stopReason).toBeNull();
    expect(source.calls).toEqual([]);
    expect(source.reads()).toBe(0);
    expect(result.records.map((r) => r.authType)).toEqual(["api_key", "api_key"]);
  });

  it("goes on after a failed refresh while the stored token is still valid, and leaves a secret-free event", async () => {
    const source = fakeHost(oauth("still-valid", 3_600_000), { fail: true });
    const s = await waveSetup(2, { hostAuth: oauth("still-valid", 3_600_000), hostCredentials: source.host });
    const accesses: string[] = [];
    const { result, stderr } = await withStderr(() => runWave(s.input, s.deps([text(), text()], copied(accesses)).deps));
    expect(result.stopReason).toBeNull();
    expect(accesses).toEqual(["still-valid", "still-valid"]);
    const events = stderr.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toEqual([
      { event: "credential_refresh_failed", provider: "openai", code: "refresh_failed" },
      { event: "credential_refresh_failed", provider: "openai", code: "refresh_failed" },
    ]);
    for (const secret of [SECRET_REFRESH, "still-valid"]) expect(stderr).not.toContain(secret);
  });

  it("stops with credential_expiring when the refresh fails and the token is too close to expiry", async () => {
    const source = fakeHost(oauth("about-to-expire", 5 * 60_000), { fail: true });
    const s = await waveSetup(3, { hostAuth: oauth("about-to-expire", 5 * 60_000), hostCredentials: source.host });
    const { result, stderr } = await withStderr(() => runWave(s.input, s.deps([text()]).deps));
    expect(result.stopReason).toBe("credential_expiring");
    expect(result.records.map((r) => r.outcome)).toEqual(["not_run", "not_run", "not_run"]);
    expect(source.calls).toEqual(["openai"]);
    expect(stderr).toContain("credential_refresh_failed");
    expect(stderr).not.toContain(SECRET_REFRESH);
    expect(await everythingOnDisk(s.waveDir)).not.toContain(SECRET_REFRESH);
  });

  it("runs when the refresh turns an expiring token into a valid one", async () => {
    const source = fakeHost(oauth("about-to-expire", 5 * 60_000), { fresh: () => oauth("renewed", 3_600_000) });
    const s = await waveSetup(2, { hostAuth: oauth("about-to-expire", 5 * 60_000), hostCredentials: source.host });
    const accesses: string[] = [];
    const { result } = await withStderr(() => runWave(s.input, s.deps([text(), text()], copied(accesses)).deps));
    expect(result.stopReason).toBeNull();
    expect(accesses).toEqual(["renewed", "renewed"]);
  });

  it("does not touch the credentials when no source is given", async () => {
    const s = await waveSetup(1, { hostAuth: oauth("as-given", 3_600_000) });
    const accesses: string[] = [];
    await withStderr(() => runWave(s.input, s.deps([text()], copied(accesses)).deps));
    expect(accesses).toEqual(["as-given"]);
  });

  it("refreshes before each OAuth route of the preflight and never for an API key route", async () => {
    const root = await temporaryRoot("ablation-preflight-refresh-");
    const tasks = [await reviewTask(root, "P1")];
    const runs = buildMatrix(tasks, PAIRINGS.filter((p) => p.id === "pl-review" || p.id === "pl-review-grok"));
    const approval = approvalFor(tasks, runs);
    await seedLedger(join(root, "ledger.json"));
    const expiring = { ...oauth("about-to-expire", 5 * 60_000), xai: { type: "api_key", key: "k" } };
    const source = fakeHost(expiring, { fresh: () => ({ ...oauth("renewed", 3_600_000), xai: { type: "api_key", key: "k" } }) });
    const { spawnRun } = fake([{ cost: 0.01, text: "PONG" }, { cost: 0.01, text: "PONG" }], root);
    const { result } = await withStderr(() => runPreflight({
      approval, waveDir: join(root, "wave"), ledgerPath: join(root, "ledger.json"), productionConfig, hostAuth: expiring, hostCredentials: source.host,
    }, { ...seams(), spawnRun: (scope, input) => spawnRun(scope, input, join(scope.root, "ignored.log")), residualCheck: async () => true }));
    expect(source.calls).toEqual(["openai"]);
    expect(result.routes.map((r) => [r.profile, r.ok, r.failure])).toEqual([["review", true, null], ["review-grok", true, null]]);
    // Without the refresh the same expiring token fails the route.
    const plain = await runPreflight({
      approval, waveDir: join(root, "wave-plain"), ledgerPath: join(root, "ledger.json"), productionConfig, hostAuth: expiring,
    }, { ...seams(), spawnRun: (scope, input) => spawnRun(scope, input, join(scope.root, "ignored.log")), residualCheck: async () => true });
    expect(plain.routes.find((r) => r.profile === "review")).toMatchObject({ ok: false, failure: "credential_expiring" });
  });

  /** A host whose reads fail as told: `failReads` is how many reads fail first, `Infinity` for all of them. */
  function flakyHost(stored: unknown, fresh: unknown | undefined, failReads: number, refreshFails = false) {
    let current = stored;
    let failed = 0;
    const signals: (AbortSignal | undefined)[] = [];
    const host: HostCredentials = {
      read: async () => { if (failed < failReads) { failed += 1; throw new SyntaxError(`unterminated ${SECRET_REFRESH}`); } return current; },
      refresh: async (_provider, signal) => { signals.push(signal); if (refreshFails) throw new Error(SECRET_REFRESH); if (fresh !== undefined) current = fresh; },
    };
    return { host, signals };
  }
  const eventsOf = (stderr: string) => stderr.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>);

  it("tries the re-read once more after a successful refresh and uses what it then reads", async () => {
    const { host } = flakyHost(oauth("old", 5 * 60_000), oauth("renewed", 3_600_000), 1);
    const s = await waveSetup(1, { hostAuth: oauth("old", 5 * 60_000), hostCredentials: host });
    const accesses: string[] = [];
    const { result, stderr } = await withStderr(() => runWave(s.input, s.deps([text()], copied(accesses)).deps));
    expect(result.stopReason).toBeNull();
    expect(accesses).toEqual(["renewed"]);
    expect(eventsOf(stderr)).toEqual([]);
  });

  it("stops as for an expiring credential when the auth stays unreadable after a successful refresh, even with a valid old token", async () => {
    const { host } = flakyHost(oauth("old", 3_600_000), oauth("renewed", 3_600_000), Infinity);
    const s = await waveSetup(2, { hostAuth: oauth("old", 3_600_000), hostCredentials: host });
    const { result, stderr } = await withStderr(() => runWave(s.input, s.deps([text()]).deps));
    expect(result.stopReason).toBe("credential_expiring");
    expect(result.records.map((r) => r.outcome)).toEqual(["not_run", "not_run"]);
    expect(eventsOf(stderr)).toEqual([{ event: "credential_refresh_failed", provider: "openai", code: "auth_unreadable" }]);
    expect(stderr).not.toContain(SECRET_REFRESH);
  });

  it("keeps the previous auth when the refresh failed and the file cannot be read either", async () => {
    const { host } = flakyHost(oauth("old", 3_600_000), undefined, Infinity, true);
    const s = await waveSetup(1, { hostAuth: oauth("old", 3_600_000), hostCredentials: host });
    const accesses: string[] = [];
    const { result, stderr } = await withStderr(() => runWave(s.input, s.deps([text()], copied(accesses)).deps));
    expect(result.stopReason).toBeNull();
    expect(accesses).toEqual(["old"]);
    expect(eventsOf(stderr).map((event) => event.code)).toEqual(["refresh_failed", "auth_unreadable"]);
    expect(stderr).not.toContain(SECRET_REFRESH);
  });

  it("reports a refresh that returned a token that expires too soon by its own code, and nothing of the message", async () => {
    const host: HostCredentials = { read: async () => oauth("short", 3_600_000), refresh: async () => { throw new HostCredentialError("refresh_too_short"); } };
    const s = await waveSetup(1, { hostAuth: oauth("short", 3_600_000), hostCredentials: host });
    const { result, stderr } = await withStderr(() => runWave(s.input, s.deps([text()]).deps));
    expect(result.stopReason).toBeNull();
    expect(eventsOf(stderr)).toEqual([{ event: "credential_refresh_failed", provider: "openai", code: "refresh_too_short" }]);
  });

  it("hands the abort signal of the wave and of the preflight to the refresh", async () => {
    const controller = new AbortController();
    const waveHost = flakyHost(oauth("old", 3_600_000), undefined, 0);
    const s = await waveSetup(1, { hostAuth: oauth("old", 3_600_000), hostCredentials: waveHost.host, signal: controller.signal });
    await withStderr(() => runWave(s.input, s.deps([text()]).deps));
    expect(waveHost.signals).toEqual([controller.signal]);
    const root = await temporaryRoot("ablation-preflight-signal-");
    const tasks = [await reviewTask(root, "P1")];
    const approval = approvalFor(tasks, buildMatrix(tasks, PAIRINGS.filter((p) => p.id === "pl-review")));
    await seedLedger(join(root, "ledger.json"));
    const preflightHost = flakyHost(oauth("old", 3_600_000), undefined, 0);
    const { spawnRun } = fake([{ cost: 0.01, text: "PONG" }], root);
    await withStderr(() => runPreflight({
      approval, waveDir: join(root, "wave"), ledgerPath: join(root, "ledger.json"), productionConfig, hostAuth: oauth("old", 3_600_000), hostCredentials: preflightHost.host, signal: controller.signal,
    }, { ...seams(), spawnRun: (scope, input) => spawnRun(scope, input, join(scope.root, "ignored.log")), residualCheck: async () => true }));
    expect(preflightHost.signals).toEqual([controller.signal]);
  });

  describe("the file credentials", () => {
    const authFile = async (expires: number) => {
      const root = await temporaryRoot("ablation-file-credentials-");
      const path = join(root, "auth.json");
      await writeFile(path, JSON.stringify({ openai: { type: "oauth", access: "a", refresh: "r", expires } }));
      return path;
    };

    it("does not keep a runtime whose creation was rejected, forwards the signal and the minimum validity", async () => {
      const path = await authFile(Date.now() + 3_600_000);
      let created = 0;
      const seen: unknown[] = [];
      const host = fileHostCredentials(path, async () => {
        created += 1;
        if (created === 1) throw new Error("sdk import failed");
        return { getAuth: async (_provider, overrides) => { seen.push(overrides); return undefined; } };
      });
      const controller = new AbortController();
      await expect(host.refresh("openai", controller.signal)).rejects.toMatchObject({ code: "refresh_failed" });
      await host.refresh("openai", controller.signal);
      await host.refresh("openai");
      expect(created).toBe(2);
      expect(seen).toEqual([{ minOAuthValidityMs: 30 * 60_000, signal: controller.signal }, { minOAuthValidityMs: 30 * 60_000 }]);
    });

    it("tells a refresh that returned a token which still expires too soon from other OAuth failures, by the stored expiry having moved", async () => {
      const path = await authFile(Date.now() + 60_000);
      const tooShort = fileHostCredentials(path, async () => ({
        getAuth: async () => {
          await writeFile(path, JSON.stringify({ openai: { type: "oauth", access: "b", refresh: "r2", expires: Date.now() + 120_000 } }));
          throw Object.assign(new Error("OAuth refresh returned a token that expires too soon"), { code: "oauth" });
        },
      }));
      await expect(tooShort.refresh("openai")).rejects.toMatchObject({ code: "refresh_too_short", message: "refresh_too_short" });
      const unchanged = fileHostCredentials(path, async () => ({ getAuth: async () => { throw Object.assign(new Error("endpoint down"), { code: "oauth" }); } }));
      await expect(unchanged.refresh("openai")).rejects.toMatchObject({ code: "refresh_failed", message: "refresh_failed" });
      const other = fileHostCredentials(path, async () => ({ getAuth: async () => { throw Object.assign(new Error("lock"), { code: "auth" }); } }));
      await expect(other.refresh("openai")).rejects.toMatchObject({ code: "refresh_failed" });
    });
  });

  it("refreshes a throwaway auth file through the Pi SDK without changing a valid credential, and reads it back", async () => {
    const root = await temporaryRoot("ablation-sdk-refresh-");
    const path = join(root, "auth.json");
    const content = { openai: { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 10 * 3_600_000 } };
    await writeFile(path, JSON.stringify(content));
    const host = fileHostCredentials(path);
    await host.refresh("openai");
    await host.refresh("provider-the-sdk-does-not-know");
    expect(await host.read()).toEqual(content);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(content);
  });
});

describe("preflight", () => {
  it("runs one PONG per route, records its cost and flags a route that did not complete", async () => {
    const root = await temporaryRoot("ablation-preflight-");
    const waveDir = join(root, "wave");
    const tasks = [await reviewTask(root, "P1")];
    const runs = buildMatrix(tasks, PAIRINGS.filter((p) => p.id === "pl-review" || p.id === "pl-review-grok"));
    const approval = approvalFor(tasks, runs);
    await seedLedger(join(root, "ledger.json"));
    const { spawnRun, captured } = fake([{ cost: 0.01, text: "PONG" }, { output: { terminal: "failed" }, providerError: "auth", cost: null }], root);
    const result = await runPreflight({
      approval, waveDir, ledgerPath: join(root, "ledger.json"), productionConfig,
      hostAuth: { openai: { type: "oauth", access: "a", refresh: "", expires: Date.now() + 3_600_000 }, xai: { type: "api_key", key: "k" } },
    }, { ...seams(), spawnRun: (scope, input) => spawnRun(scope, input, join(scope.root, "ignored.log")), residualCheck: async () => true });
    expect(captured.map((c) => c.input.promptText)).toEqual(["Reply with exactly: PONG", "Reply with exactly: PONG"]);
    expect(result.routes.map((r) => [r.profile, r.ok, r.failure])).toEqual([["review", true, null], ["review-grok", false, "auth"]]);
    expect(result.spentUsd).toBeCloseTo(0.01);
    const ledger = JSON.parse(await readFile(join(root, "ledger.json"), "utf8")) as { ledgerId: string; entries: { runId: string }[] };
    expect(ledger.entries.map((e) => e.runId)).toEqual(["preflight-review", "preflight-review-grok"]);
    expect(ledger.entries).toMatchObject([{ kind: "preflight", costUsd: 0.01 }, { kind: "preflight", costUsd: 0 }]);
    expect(JSON.parse(await readFile(join(waveDir, "preflight.json"), "utf8"))).toMatchObject({ ledgerId: ledger.ledgerId, routes: [{ ok: true }, { ok: false }], binding: { matrixDigest: approval.matrixDigest } });
    // No scope is kept, only the verified output; no credentials anywhere under private/.
    expect(existsSync(scopeRoot(waveDir, "preflight-review-grok"))).toBe(false);
    expect(await findFiles(join(waveDir, "private"), /auth/i)).toEqual([]);
    await expect(assertPreflightPassed(waveDir, approval, join(root, "ledger.json"))).rejects.toThrow("preflight_failed");
  });

  it("prepares an empty scope with credentials for the route's provider only", async () => {
    const root = await temporaryRoot("ablation-empty-scope-");
    const scope = await prepareEmptyScope({
      waveDir: root, name: "preflight-code", profile: "code", hostAuth: { openai: { type: "api_key", key: "k" }, xai: { type: "api_key", key: "z" } },
      productionProfile: { ...CODING, provider: "openai" }, skillCatalog: productionConfig.skillCatalog,
    });
    expect(Object.keys(JSON.parse(await readFile(join(scope.agentDir, "auth.json"), "utf8")) as object)).toEqual(["openai"]);
    expect(Object.keys((JSON.parse(await readFile(scope.configPath, "utf8")) as { executionProfiles: object }).executionProfiles)).toEqual(["code", "code-ro"]);
  });
});

describe("cli arguments", () => {
  it("accepts the live modes and rejects unknown modes and options", () => {
    expect(parseArgs(["--plan", "--tasks", "t.json"])).toMatchObject({ mode: "--plan", options: { "--tasks": "t.json" }, trim: false });
    expect(parseArgs(["--plan", "--tasks", "t.json", "--trim", "--ledger", "l.json"])).toMatchObject({ mode: "--plan", trim: true, options: { "--ledger": "l.json" } });
    // R56: trimming and pairing selection belong to the plan; wave and preflight run the approval's list.
    const live = ["--approval", "a.json", "--tasks", "t.json", "--template", "x", "--out", "w", "--ledger", "l.json"];
    expect(() => parseArgs(["--wave", ...live, "--trim"])).toThrow("invalid_argument");
    expect(() => parseArgs(["--wave", ...live, "--pairings", "pl-code"])).toThrow("invalid_argument");
    expect(parseArgs(["--wave", ...live, "--max-runs", "2"])).toMatchObject({ mode: "--wave", maxRuns: 2, resume: false });
    expect(parseArgs(["--wave", ...live, "--resume"])).toMatchObject({ resume: true });
    for (const bad of ["0", "-1", "x", "1.5", "10000"]) expect(() => parseArgs(["--wave", ...live, "--max-runs", bad])).toThrow("invalid_argument");
    expect(() => parseArgs(["--preflight", ...live.filter((a) => a !== "--template" && a !== "x"), "--max-runs", "2"])).toThrow("invalid_argument");
    expect(() => parseArgs(["--preflight", ...live.filter((a) => a !== "--template" && a !== "x"), "--resume"])).toThrow("invalid_argument");
    expect(() => parseArgs(["--plan", "--tasks", "t.json", "--approval", "a.json"])).toThrow("invalid_argument");
    // `--report` takes --wave more than once.
    expect(parseArgs(["--report", "--wave", "w1", "--wave", "w2", "--ledger", "l.json", "--evidence", "e"]).waves).toEqual(["w1", "w2"]);
    expect(() => parseArgs(["--report", "--ledger", "l.json", "--evidence", "e"])).toThrow("wave_required");
    expect(() => parseArgs(["--report", "--wave", "w1", "--ledger", "l.json", "--ledger", "m.json", "--evidence", "e"])).toThrow("invalid_argument");
    expect(() => parseArgs(["--unknown-mode", "--tasks", "t.json"])).toThrow("mode_required");
    expect(() => parseArgs(["--plan", "--wave", "--tasks", "t.json"])).toThrow("choose_one_mode");
    expect(() => parseArgs(["--plan", "--tasks", "t.json", "--bogus", "x"])).toThrow("invalid_argument");
    expect(() => parseArgs(["--wave", "--tasks", "t.json"])).toThrow("approval_required");
    expect(() => parseArgs(["--wave", "--tasks", "t.json", "--approval", "a.json"])).toThrow("out_required");
    expect(() => parseArgs(["--wave", "--tasks", "t.json", "--approval", "a.json", "--out", "w"])).toThrow("ledger_required");
    expect(() => parseArgs(["--preflight", "--tasks", "t.json", "--approval", "a.json", "--ledger", "l.json"])).toThrow("out_required");
    expect(() => parseArgs(["--wave", "--tasks", "t.json", "--approval", "a.json", "--out", "w", "--ledger", "l.json"])).toThrow("template_required");
    expect(parseArgs(["--wave", "--tasks", "t.json", "--approval", "a.json", "--out", "w", "--ledger", "l.json", "--template", "x", "--preflight-dir", "p"]).options["--preflight-dir"]).toBe("p");
    expect(() => parseArgs(["--preflight", "--tasks", "t.json", "--approval", "a.json", "--out", "w", "--ledger", "l.json", "--preflight-dir", "p"])).toThrow("invalid_argument");
    expect(() => parseArgs(["--plan"])).toThrow("tasks_required");
  });
});

describe("output integrity (R35)", () => {
  it.each([["cost", "a forged cost"], ["text", "a replaced text file"], ["nomac", "a missing MAC"]] as const)("stops on %s: %s", async (tamper, _why) => {
    const s = await waveSetup(2);
    const r = await runWave(s.input, s.deps([text({ tamper, cost: 0.3 })]).deps);
    expect(r.stopReason).toBe("output_integrity");
    expect(r.records.map((x) => x.outcome)).toEqual(["stopped", "not_run"]);
    // Nothing of a forged output is believed: no terminal, no usage, no score. Its cost is the profile's estimate, flagged (R41).
    expect(r.records[0]).toMatchObject({ accepted: null, usage: null, harnessError: "output_integrity" });
    expect(r.spentUsd).toBe(1);
    const ledger = JSON.parse(await readFile(s.input.ledgerPath, "utf8")) as { entries: { costUsd: number; estimated?: boolean }[] };
    expect(ledger.entries).toMatchObject([{ costUsd: 1, estimated: true }]);
  });

  it("accepts a correctly signed output and never puts the key into argv, env or a file", async () => {
    const s = await waveSetup(1);
    const { deps, captured } = s.deps([text()]);
    const r = await runWave(s.input, deps);
    expect(r.records[0]).toMatchObject({ outcome: "scored", accepted: true });
    expect(JSON.stringify(captured[0]!.scope.env)).toBe("{}");
    expect(captured[0]!.input).not.toHaveProperty("key");
  });
});

describe("interrupt handling (C1)", () => {
  it("survives two SIGINTs, kills the group, records the run as interrupted and the rest as not_run", async () => {
    const s = await waveSetup(3, { runTimeoutMs: 60_000 });
    const { spawnRun, captured } = fake([{ hang: true }], s.root);
    let pid: number | undefined;
    const spy = (scope: RunScope, runInput: string, log: string): ChildProcess => { const child = spawnRun(scope, runInput, log); pid = child.pid; return child; };
    const emitter = new EventEmitter();
    setTimeout(() => emitter.emit("SIGINT"), 300);
    setTimeout(() => emitter.emit("SIGINT"), 350);
    const r = await withAbort((signal) => runWave({ ...s.input, signal }, {
      ...baseDeps(), spawnRun: spy,
    }), emitter);
    expect(captured).toHaveLength(1);
    expect(r.stopReason).toBe("interrupted");
    expect(r.records.map((x) => x.outcome)).toEqual(["stopped", "not_run", "not_run"]);
    expect(r.records[0]).toMatchObject({ stopReason: "interrupted" });
    expect(() => process.kill(-pid!, 0)).toThrow();
    expect(emitter.listenerCount("SIGINT")).toBe(0);
    const ledger = JSON.parse(await readFile(s.input.ledgerPath, "utf8")) as { entries: { runId: string }[] };
    expect(ledger.entries.map((e) => e.runId)).toEqual([s.runs[0]!.runId]);
    for (const run of s.runs) expect(existsSync(join(s.waveDir, "runs", `${run.runId}.json`))).toBe(true);
  });

  it("does not spawn when the abort arrives between scope preparation and spawn", async () => {
    const s = await waveSetup(2);
    const controller = new AbortController();
    const { deps, captured } = s.deps([text()], { prepareScope: async (input) => { const scope = await fakePrepare(input); controller.abort(); return scope; } });
    const r = await runWave({ ...s.input, signal: controller.signal }, deps);
    expect(captured).toHaveLength(0);
    expect(r.stopReason).toBe("interrupted");
    expect(r.records.map((x) => x.outcome)).toEqual(["stopped", "not_run"]);
    // No run started, so no scope is kept.
    expect(existsSync(scopeRoot(s.waveDir, s.runs[0]!.runId))).toBe(false);
    expect(existsSync(join(privateRunDir(s.waveDir, s.runs[0]!.runId), "scope"))).toBe(false);
  });
});

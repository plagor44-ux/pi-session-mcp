import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import type { AppConfig } from "../src/config.js";
import { podmanImageExists, renderDoctorHuman, renderDoctorJson, runDoctor, type DoctorDependencies } from "../src/doctor.js";
import { LEASE_DIRECTORY } from "../src/writer-lease.js";
import { currentAcceptanceFingerprint, currentAcceptanceRecord, writeWriterAcceptanceRecord } from "../src/writer-state.js";
import { writerPaths, writeWriterState, type WriterState } from "../src/writer-state.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function fixture(options: { base?: string } = {}) {
  const home = await mkdtemp(join(tmpdir(), "doctor-writer-")); roots.push(home);
  const paths = writerPaths(home, "repo-w1");
  const config: AppConfig = { workspaces: new Map([["repo", home]]), workspaceModes: new Map(), executionProfiles: new Map(), defaultExecutionProfile: "ro", eventDelivery: "off", skillOverrideDirectory: join(home, "skills"), configuration: { fingerprint: `sha256:${"0".repeat(64)}`, reloadPolicy: "restart-required" } };
  const container = { writers: 1, lifecycle: "persistent" as const, profiles: ["coding"], image: "node", network: "pasta" as const, cache: "none" as const, tags: "none" as const, clean: "untracked" as const, ...(options.base === undefined ? {} : { base: options.base }) };
  const configured = { ...config, workspaceModes: new Map([["repo", { mode: "container" as const, container }]]) };
  const state: WriterState = { schemaVersion: 1, alias: "repo", index: 1, phase: "ready", lifecycle: "persistent", launch: "relay", profiles: ["coding"], providers: [], network: "pasta", cache: "none", tags: "none", clean: "untracked", imageId: "a".repeat(64), base: { ref: "refs/heads/main", commit: "b".repeat(40) } };
  const run = async (overrides: DoctorDependencies = {}) => runDoctor({
    home, loadConfig: async () => configured, containerRuntime: async () => true,
    writerRuntime: async () => ({ podmanVersion: "5.4.0", imageExists: async () => true }), ...overrides,
  });
  const check = async (version = "5.4.0", image = true) => (await run({ writerRuntime: async () => ({ podmanVersion: version, imageExists: async () => image }) })).checks.filter((c) => c.id.startsWith("writer_"));
  const ready = async () => {
    const git = join(paths.clone, ".git");
    await mkdir(join(git, "refs", "heads"), { recursive: true });
    await mkdir(paths.bundles); await writeFile(paths.wrapper, "wrapper");
    await mkdir(dirname(join(git, state.base.ref)), { recursive: true });
    await writeFile(join(git, "config"), '[USER]\nName = Worker\nEMAIL = worker@invalid\n');
    await writeFile(join(git, "HEAD"), `ref: ${state.base.ref}\n`);
    await writeFile(join(git, state.base.ref), state.base.commit + "\n");
    state.acceptance = { fingerprint: await currentAcceptanceFingerprint(paths.wrapper, state, "5.4.0"), verdict: "pass", network: "not_limited", at: "now" };
    await writeWriterState(home, "repo-w1", state);
  };
  return { home, paths, state, run, check, ready };
}
const leaseDirectory = (home: string) => join(home, ...LEASE_DIRECTORY);
it.each(["absent", "invalid"])("reports only readiness for %s state", async (kind) => {
  const { paths, check, ready } = await fixture();
  if (kind === "invalid") { await ready(); await writeFile(paths.state, "{}"); }
  expect(await check()).toEqual([expect.objectContaining({ id: "writer_not_ready", severity: "error", subject: "repo-w1" })]);
});
it.each(["", "[user]\nname = Worker\n", "x".repeat(65_537)])("warns offline for missing or unsafe identity", async (config) => {
  const { paths, check, ready } = await fixture(); await ready();
  await writeFile(join(paths.clone, ".git/config"), config);
  expect(await check()).toContainEqual(expect.objectContaining({ id: "writer_git_identity_missing", severity: "warning", subject: "repo-w1" }));
});
it("names Podman drift and prints the repository remediation", async () => {
  const f = await fixture(); await f.ready();
  await writeWriterAcceptanceRecord(f.home, "repo-w1", await currentAcceptanceRecord(f.paths.wrapper, f.state, "5.4.0"));
  const report = await f.run({ writerRuntime: async () => ({ podmanVersion: "5.5.0", imageExists: async () => true }) });
  expect(report.checks).toContainEqual(expect.objectContaining({ id: "writer_not_ready", reason: "podman_version", remediation: "run pi-session-mcp-setup --repo repo --apply" }));
  expect(renderDoctorHuman(report)).toContain("repo-w1 (podman_version)");
  expect(renderDoctorJson(report)).toContain('"reason":"podman_version"');
});
it("reports missing images separately and asks to restore them", async () => {
  const f = await fixture(); await f.ready();
  expect(await f.check("5.4.0", false)).toContainEqual(expect.objectContaining({ reason: "image_missing", remediation: expect.stringContaining("restore the writer's recorded image") }));
});
it.each([
  ["exit 0", async () => ({ exitCode: 0, stdout: "", stderr: "" }), undefined],
  ["exit 1", async () => ({ exitCode: 1, stdout: "", stderr: "" }), "image_missing"],
  ["exit 125", async () => ({ exitCode: 125, stdout: "", stderr: "" }), "runtime_unavailable"],
  ["a timeout", async () => { throw new Error("aborted"); }, "runtime_unavailable"],
] as const)("maps an image check with %s like setup does", async (_label, result, reason) => {
  const f = await fixture(); await f.ready();
  const run = vi.fn(result);
  const report = await f.run({ writerRuntime: async () => ({ podmanVersion: "5.4.0", imageExists: podmanImageExists({ run }) }) });
  expect(run).toHaveBeenCalledWith("podman", ["image", "exists", f.state.imageId], expect.any(AbortSignal));
  const check = report.checks.find((c) => c.id === "writer_not_ready");
  if (reason === undefined) expect(check).toEqual(expect.objectContaining({ severity: "ok" }));
  else expect(check).toEqual(expect.objectContaining({ severity: "error", reason }));
  if (reason === "runtime_unavailable") expect(check?.remediation).toBe("make rootless Podman usable, then run pi-session-mcp-setup --repo repo --apply");
});
it("reports unreadable state without recommending recreate", async () => {
  const f = await fixture(); await f.ready();
  const original = fsPromises.open;
  const mock = vi.spyOn(fsPromises, "open").mockImplementation(((path: unknown, ...args: unknown[]) => {
    if (path === f.paths.state) return Promise.reject(Object.assign(new Error("private"), { code: "EACCES" }));
    return Reflect.apply(original, fsPromises, [path, ...args]);
  }) as typeof fsPromises.open);
  syncBuiltinESMExports();
  try {
    expect(await f.check()).toContainEqual(expect.objectContaining({ reason: "state_unreadable", remediation: "restore read access to the writer state, then run pi-session-mcp-setup --repo repo --apply" }));
  } finally { mock.mockRestore(); syncBuiltinESMExports(); }
});
it("uses acceptance_changed for an older acceptance without a sidecar", async () => {
  const f = await fixture(); await f.ready();
  expect(await f.check("5.5.0")).toContainEqual(expect.objectContaining({ reason: "acceptance_changed" }));
});
it("detects wrapper drift", async () => {
  const { paths, check, ready } = await fixture(); await ready();
  await writeFile(paths.wrapper, "changed wrapper");
  expect(await check()).toContainEqual(expect.objectContaining({ id: "writer_not_ready", severity: "error" }));
});
it("matches fingerprints and detects runtime/image drift", async () => {
  const { check, ready } = await fixture(); await ready();
  expect((await check()).every((c) => c.severity === "ok")).toBe(true);
  for (const checks of [await check("5.5.0"), await check("5.4.0", false)]) expect(checks).toContainEqual(expect.objectContaining({ id: "writer_not_ready", severity: "error" }));
});
it.each(["branch", "symlink", "bundle", "packed", "parent-symlink", "oversized", "moved-base", "detached"])("detects %s without leaking paths", async (kind) => {
  const { paths, check, ready } = await fixture(); await ready();
  if (kind === "oversized") await writeFile(join(paths.clone, ".git/HEAD"), "x".repeat(65_537));
  if (kind === "moved-base") await writeFile(join(paths.clone, ".git/refs/heads/main"), "c".repeat(40));
  if (kind === "detached") await writeFile(join(paths.clone, ".git/HEAD"), "b".repeat(40));
  if (kind === "branch") await writeFile(join(paths.clone, ".git/refs/heads/x"), "c".repeat(40));
  if (kind === "packed") await writeFile(join(paths.clone, ".git/packed-refs"), `${"c".repeat(40)} refs/heads/x\n`);
  if (kind === "symlink") {
    const target = join(paths.root, "readable-head");
    await writeFile(target, "ref: refs/heads/main\n");
    await rm(join(paths.clone, ".git/HEAD"));
    await symlink(target, join(paths.clone, ".git/HEAD"));
  }
  if (kind === "parent-symlink") {
    const target = join(paths.root, "readable-refs");
    await mkdir(join(target, "heads"), { recursive: true });
    await writeFile(join(target, "heads/main"), "b".repeat(40) + "\n");
    await rm(join(paths.clone, ".git/refs"), { recursive: true });
    await symlink(target, join(paths.clone, ".git/refs"));
  }
  if (kind === "bundle") await writeFile(join(paths.bundles, "collect.bundle"), "bundle");
  const checks = await check();
  expect(checks).toContainEqual(expect.objectContaining({ id: kind === "bundle" ? "writer_uncollected_bundle" : "writer_dirty", severity: "warning" }));
  for (const c of checks) { expect(c.subject).toBe("repo-w1"); expect(c.remediation ?? "").not.toContain("/"); }
});
it("ignores an absent writer lease directory", async () => {
  const { run } = await fixture();
  expect((await run()).checks.filter((check) => check.id === "writer_lease_directory")).toEqual([]);
});
it("accepts a private writer lease directory", async () => {
  const { home, run } = await fixture();
  await mkdir(leaseDirectory(home), { recursive: true, mode: 0o700 });
  await chmod(leaseDirectory(home), 0o700);
  expect((await run()).checks.filter((check) => check.id === "writer_lease_directory")).toEqual([
    { id: "writer_lease_directory", severity: "ok", subject: "writer lease" },
  ]);
});
it.each(["mode", "symlink", "owner"] as const)("rejects an unsafe writer lease directory (%s)", async (kind) => {
  const { home, run } = await fixture();
  const lease = leaseDirectory(home);
  if (kind === "symlink") {
    const target = join(home, "lease-target");
    await mkdir(target, { recursive: true, mode: 0o700 });
    await mkdir(dirname(lease), { recursive: true, mode: 0o700 });
    await symlink(target, lease);
  } else {
    await mkdir(lease, { recursive: true, mode: 0o700 });
    await chmod(lease, kind === "mode" ? 0o750 : 0o700);
  }
  const overrides = kind === "owner"
    ? { writerLeaseRoot: async () => ({ isDirectory: true, uid: (process.getuid?.() ?? 0) + 1, mode: 0o700 }) }
    : {};
  const [finding] = (await run(overrides)).checks.filter((check) => check.id === "writer_lease_directory");
  expect(finding).toEqual({ id: "writer_lease_directory", severity: "error", subject: "writer lease", remediation: expect.any(String) });
  // A real directory is repaired in place: replacing it would give held leases a new inode.
  expect(finding!.remediation).toMatch(kind === "symlink" ? /close every writer session/ : /in place.*never move or delete/);
});
it("reports an uninspectable writer lease directory as an error", async () => {
  const { run } = await fixture();
  const overrides = { writerLeaseRoot: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } };
  expect((await run(overrides)).checks.filter((check) => check.id === "writer_lease_directory")).toEqual([
    { id: "writer_lease_directory", severity: "error", subject: "writer lease", remediation: expect.any(String) },
  ]);
});
it("warns once per writer that still launches legacy", async () => {
  const { state, check, ready } = await fixture();
  state.launch = "legacy"; await ready();
  expect((await check()).filter((check) => check.id === "writer_not_migrated")).toEqual([
    { id: "writer_not_migrated", severity: "warning", subject: "repo-w1", remediation: expect.any(String) },
  ]);
});
it("warns once per container workspace without a recorded default base", async () => {
  const { run, ready } = await fixture(); await ready();
  expect((await run()).checks.filter((check) => check.id === "workspace_base_unset")).toEqual([
    { id: "workspace_base_unset", severity: "warning", subject: "repo", remediation: expect.any(String) },
  ]);
});
it("warns with a count when ready writers are off the default base", async () => {
  const { state, run, ready } = await fixture({ base: "main" });
  state.base = { ref: "refs/heads/release", commit: "c".repeat(40) }; await ready();
  const checks = (await run()).checks.filter((check) => check.id === "writer_off_default_base");
  expect(checks).toHaveLength(1);
  expect(checks[0]).toMatchObject({ id: "writer_off_default_base", severity: "warning", subject: "repo" });
  expect(checks[0]?.remediation).toContain("1");
  expect(checks[0]?.remediation).not.toContain("release");
  expect(checks[0]?.remediation).not.toContain("refs/heads");
});
it("warns about a ready writer behind its default base, with exit 1 and no path", async () => {
  const { home, state, run, ready } = await fixture({ base: "main" }); await ready();
  const seen: unknown[] = [];
  const result = await run({ writerBaseFreshness: async (request) => { seen.push(request); return "behind"; } });
  expect(result.checks.filter((check) => check.id === "writer_base_behind")).toEqual([
    { id: "writer_base_behind", severity: "warning", subject: "repo-w1", remediation: expect.stringContaining("--writer repo-w1 --finish --apply") },
  ]);
  expect(seen).toEqual([{ home, name: "repo-w1", checkout: home, base: state.base }]);
  expect(result.checks.filter((check) => check.severity === "error" && check.id.startsWith("writer_"))).toEqual([]);
  expect([renderDoctorJson(result), renderDoctorHuman(result)].join("\n")).not.toContain(home);
});
it("exits 1 when a writer behind its base is the only finding", async () => {
  const { home, run, ready } = await fixture({ base: "main" }); await ready();
  const result = await run({
    writerBaseFreshness: async () => "behind",
    packageRoot: home, nodeVersion: "22.19.0", packageMetadata: async () => ({ version: "1.0.0", engines: { node: ">=22.19.0" } }),
    fileSystem: { readFile: async () => "", stat: async (path) => ({ isDirectory: () => path === home, isFile: () => path !== home }), access: async () => undefined },
    loadRawConfig: async () => ({ executionProfiles: { coding: { default: false, permissionProfile: "coding", provider: "fake", model: "fake", thinkingLevel: "off" } } }),
    writerLeaseRoot: async () => undefined,
  });
  expect(result.checks.filter((check) => check.severity !== "ok").map((check) => check.id)).toEqual(["writer_base_behind"]);
  expect(result.exitCode).toBe(1);
  expect(result.ok).toBe(true);
});
it.each(["current", "unknown"] as const)("does not warn about a writer that is %s", async (freshness) => {
  const { run, ready } = await fixture({ base: "main" }); await ready();
  expect((await run({ writerBaseFreshness: async () => freshness })).checks.filter((check) => check.id === "writer_base_behind")).toEqual([
    { id: "writer_base_behind", severity: "ok", subject: "repo-w1" },
  ]);
});
it("a failing comparison does not warn", async () => {
  const { run, ready } = await fixture({ base: "main" }); await ready();
  const checks = (await run({ writerBaseFreshness: async () => { throw new Error("comparison failed"); } })).checks;
  expect(checks.filter((check) => check.id === "writer_base_behind")).toEqual([{ id: "writer_base_behind", severity: "ok", subject: "repo-w1" }]);
});
it.each([
  ["off the default base", { base: "main" }, { ref: "refs/heads/fix", commit: "c".repeat(40) }, false],
  ["without a default base", {}, undefined, false],
  ["not ready", { base: "main" }, undefined, true],
] as const)("does not compare a writer %s", async (_name, options, base, broken) => {
  const { paths, state, run, ready } = await fixture(options);
  if (base) state.base = { ...base };
  await ready();
  if (broken) await writeFile(paths.wrapper, "changed wrapper");
  let compared = false;
  const result = await run({ writerBaseFreshness: async () => { compared = true; return "behind"; } });
  expect(compared).toBe(false);
  expect(result.checks.filter((check) => check.id === "writer_base_behind")).toEqual([]);
});
it("reports no paths, branch names or the lease directory name", async () => {
  const { home, state, run, ready } = await fixture({ base: "base-branch" });
  state.launch = "legacy";
  state.base = { ref: "refs/heads/writer-branch", commit: "c".repeat(40) };
  await ready();
  await mkdir(leaseDirectory(home), { recursive: true, mode: 0o700 });
  await chmod(leaseDirectory(home), 0o755);
  const result = await run();
  expect(result.checks.map((check) => check.id)).toEqual(expect.arrayContaining([
    "writer_lease_directory", "writer_not_migrated", "writer_off_default_base",
  ]));
  const output = [JSON.stringify(result), renderDoctorJson(result), renderDoctorHuman(result)].join("\n");
  for (const secret of [home, "leases", "refs/heads", "base-branch", "writer-branch", "feat/157-t9-doctor"]) {
    expect(output).not.toContain(secret);
  }
});

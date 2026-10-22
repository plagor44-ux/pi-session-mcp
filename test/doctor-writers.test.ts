import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { runDoctor } from "../src/doctor.js";
import { currentAcceptanceFingerprint } from "../src/writer-state.js";
import { writerPaths, writeWriterState, type WriterState } from "../src/writer-state.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "doctor-writer-")); roots.push(home);
  const paths = writerPaths(home, "repo-w1");
  const config: AppConfig = { workspaces: new Map([["repo", home]]), workspaceModes: new Map(), executionProfiles: new Map(), defaultExecutionProfile: "ro", eventDelivery: "off", skillOverrideDirectory: join(home, "skills"), configuration: { fingerprint: `sha256:${"0".repeat(64)}`, reloadPolicy: "restart-required" } };
  const configured = { ...config, workspaceModes: new Map([["repo", { mode: "container" as const, container: { writers: 1, lifecycle: "persistent" as const, profiles: ["coding"], image: "node", network: "pasta" as const, cache: "none" as const } }]]) };
  const state: WriterState = { schemaVersion: 1, alias: "repo", index: 1, phase: "ready", lifecycle: "persistent", profiles: ["coding"], providers: [], network: "pasta", cache: "none", imageId: "a".repeat(64), base: { ref: "refs/heads/main", commit: "b".repeat(40) } };
  const check = async (version = "5.4.0", image = true) => (await runDoctor({ home, loadConfig: async () => configured, containerRuntime: async () => true, writerRuntime: async () => ({ podmanVersion: version, imageExists: async () => image }) })).checks.filter((c) => c.id.startsWith("writer_"));
  const ready = async () => {
    await mkdir(join(paths.clone, ".git/refs/heads"), { recursive: true });
    await mkdir(paths.bundles); await writeFile(paths.wrapper, "wrapper");
    await writeFile(join(paths.clone, ".git/HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(paths.clone, ".git/refs/heads/main"), state.base.commit + "\n");
    state.acceptance = { fingerprint: await currentAcceptanceFingerprint(paths.wrapper, state, "5.4.0"), verdict: "pass", network: "not_limited", at: "now" };
    await writeWriterState(home, "repo-w1", state);
  };
  return { paths, check, ready };
}
it.each(["absent", "invalid"])("reports only readiness for %s state", async (kind) => {
  const { paths, check, ready } = await fixture();
  if (kind === "invalid") { await ready(); await writeFile(paths.state, "{}"); }
  expect(await check()).toEqual([expect.objectContaining({ id: "writer_not_ready", severity: "error", subject: "repo-w1" })]);
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

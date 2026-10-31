import { mkdir, rm, symlink, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { runDoctor, type DoctorDependencies } from "../src/doctor.js";
import { ensureSnapshotRoot, snapshotPaths, writeSnapshotState } from "../src/review-snapshot.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

function dependencies(home: string, workspacePath: string, source = "repo"): DoctorDependencies {
  const config: AppConfig = {
    workspaces: new Map([["repo", join(home, "repo")], ["review", workspacePath]]),
    workspaceModes: new Map([["repo", { mode: "host" }], ["review", { mode: "snapshot", snapshot: { source } }]]),
    executionProfiles: new Map([["profile", { alias: "profile", default: true, permissionProfile: "read-only", provider: "fake", model: "fake", thinkingLevel: "off" }]]),
    defaultExecutionProfile: "profile",
    eventDelivery: "off",
    skillOverrideDirectory: join(home, "skills"),
    configuration: { fingerprint: `sha256:${"0".repeat(64)}`, reloadPolicy: "restart-required" },
  };
  return {
    home,
    packageRoot: join(home, "package"),
    nodeVersion: "22.19.0",
    packageMetadata: async () => ({ version: "1.0.0", engines: { node: ">=22.19.0" } }),
    loadConfig: async () => config,
    containerRuntime: async () => false,
    writerLeaseRoot: async () => undefined,
  };
}

const snapshotChecks = (result: Awaited<ReturnType<typeof runDoctor>>) => result.checks
  .filter((check) => check.id.startsWith("snapshot_") || (check.subject === "review" && check.id.startsWith("workspace_")))
  .map(({ id, severity, subject }) => ({ id, severity, subject }));

const state = { v: 1 as const, source: "repo", base: "a".repeat(40), head: "b".repeat(40), tree: "c".repeat(40), at: "2026-10-31T00:00:00.000Z" };

describe.skipIf(process.platform !== "linux")("Doctor snapshot slots", () => {
  it("warns about an absent slot without the generic workspace failures", async () => {
    const home = await temporaryRoot("doctor-snapshot-");
    const paths = snapshotPaths(home, "review");
    expect(snapshotChecks(await runDoctor(dependencies(home, paths.worktree)))).toEqual([
      { id: "snapshot_path_mismatch", severity: "ok", subject: "review" },
      { id: "snapshot_incomplete", severity: "ok", subject: "review" },
      { id: "snapshot_unavailable", severity: "warning", subject: "review" },
    ]);
  });

  it("accepts a slot with a worktree directory and valid state", async () => {
    const home = await temporaryRoot("doctor-snapshot-");
    const paths = snapshotPaths(home, "review");
    await ensureSnapshotRoot(paths); await mkdir(paths.worktree); await writeSnapshotState(paths, state);
    const result = await runDoctor(dependencies(home, paths.worktree));
    expect(snapshotChecks(result)).toEqual([
      { id: "snapshot_path_mismatch", severity: "ok", subject: "review" },
      { id: "snapshot_incomplete", severity: "ok", subject: "review" },
      { id: "snapshot_unavailable", severity: "ok", subject: "review" },
    ]);
  });

  it("reports a configured path that is not the derived one", async () => {
    const home = await temporaryRoot("doctor-snapshot-");
    const result = await runDoctor(dependencies(home, join(home, "elsewhere")));
    expect(snapshotChecks(result)).toEqual([{ id: "snapshot_path_mismatch", severity: "error", subject: "review" }]);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(home);
  });

  it.each([
    ["a worktree without state", async (paths: ReturnType<typeof snapshotPaths>) => { await mkdir(paths.worktree); }],
    ["state without a worktree", async (paths: ReturnType<typeof snapshotPaths>) => { await writeSnapshotState(paths, state); }],
    ["invalid state", async (paths: ReturnType<typeof snapshotPaths>) => { await mkdir(paths.worktree); await writeFile(paths.state, "{}", { mode: 0o600 }); await chmod(paths.state, 0o600); }],
    ["a linked state file", async (paths: ReturnType<typeof snapshotPaths>) => { await mkdir(paths.worktree); await symlink(join(paths.root, "elsewhere"), paths.state); }],
  ])("reports an incomplete slot: %s", async (_name, prepare) => {
    const home = await temporaryRoot("doctor-snapshot-");
    const paths = snapshotPaths(home, "review");
    await ensureSnapshotRoot(paths); await prepare(paths);
    const result = await runDoctor(dependencies(home, paths.worktree));
    expect(snapshotChecks(result)).toEqual([
      { id: "snapshot_path_mismatch", severity: "ok", subject: "review" },
      { id: "snapshot_incomplete", severity: "error", subject: "review" },
    ]);
    expect(result.ok).toBe(false);
  });

  it.each(["file", "link"])("reports a %s occupant with and without state", async (kind) => {
    const home = await temporaryRoot("doctor-occupant-"); const paths = snapshotPaths(home, "review");
    await ensureSnapshotRoot(paths);
    if (kind === "file") await writeFile(paths.worktree, "x"); else await symlink(home, paths.worktree);
    for (const withState of [false, true]) {
      if (withState) await writeSnapshotState(paths, state);
      expect(snapshotChecks(await runDoctor(dependencies(home, paths.worktree)))).toContainEqual({ id: "snapshot_incomplete", severity: "error", subject: "review" });
    }
  });
  it("accepts a symlinked home parent before the worktree exists", async () => {
    const home = await temporaryRoot("doctor-home-"); const link = `${home}-link`; await symlink(home, link);
    try {
      const paths = snapshotPaths(home, "review"); await ensureSnapshotRoot(paths);
      expect(snapshotChecks(await runDoctor(dependencies(home, snapshotPaths(link, "review").worktree)))).toContainEqual({ id: "snapshot_path_mismatch", severity: "ok", subject: "review" });
    } finally { await rm(link); }
  });
  it("reports state recorded for another source", async () => {
    const home = await temporaryRoot("doctor-snapshot-");
    const paths = snapshotPaths(home, "review");
    await ensureSnapshotRoot(paths); await mkdir(paths.worktree); await writeSnapshotState(paths, { ...state, source: "other" });
    expect(snapshotChecks(await runDoctor(dependencies(home, paths.worktree)))).toContainEqual({ id: "snapshot_incomplete", severity: "error", subject: "review" });
    await rm(paths.state);
  });
});

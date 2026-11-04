import { chmod, mkdir, open, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AppConfig, HistoryConfig } from "../src/config.js";
import { runDoctor, type DoctorDependencies } from "../src/doctor.js";
import { loadSqlite } from "../src/history/sqlite.js";
import { historyLocation, openHistoryStore } from "../src/history/store.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

const enabled: HistoryConfig = { enabled: true, redactPaths: [], workspaces: new Map() };
const config = (history: HistoryConfig | undefined, workspaces = new Map<string, string>()): (() => Promise<AppConfig>) => async () => ({
  workspaces,
  workspaceModes: new Map([...workspaces.keys()].map((alias) => [alias, { mode: "read-only" as const }])),
  executionProfiles: new Map([["safe", { alias: "safe", default: true, permissionProfile: "read-only" as const, provider: "fake", model: "fake", thinkingLevel: "off" as const }]]),
  defaultExecutionProfile: "safe",
  configuration: { fingerprint: `sha256:${"0".repeat(64)}` as const, reloadPolicy: "restart-required" as const },
  eventDelivery: "off",
  skillOverrideDirectory: "/hidden/skills",
  ...(history === undefined ? {} : { history }),
});

async function packageRoot(): Promise<string> {
  const root = await temporaryRoot("pi-session-mcp-history-pkg-");
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.0.0", engines: { node: ">=22.19.0" } }));
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist", "main.js"), "export {};\n");
  return root;
}

async function historyChecks(home: string, history: HistoryConfig | undefined, extra: Partial<DoctorDependencies> & { workspaces?: Map<string, string> } = {}) {
  const { workspaces, ...dependencies } = extra;
  const result = await runDoctor({ packageRoot: await packageRoot(), home, loadConfig: config(history, workspaces), writerLeaseRoot: async () => undefined, ...dependencies });
  return result.checks.filter((check) => check.id.startsWith("history_"));
}

async function freshHome(): Promise<string> {
  const home = await temporaryRoot("doctor-history-");
  (await openHistoryStore({ home })).close();
  return home;
}

describe("doctor history checks", () => {
  it("no history checks when disabled", async () => {
    const home = await freshHome();
    expect(await historyChecks(home, undefined)).toEqual([]);
    expect(await historyChecks(home, { enabled: false })).toEqual([]);
  });

  it("ok on a fresh v1 file with correct modes, and on a missing file", async () => {
    expect(await historyChecks(await freshHome(), enabled)).toEqual([
      { id: "history_storage", severity: "ok", subject: "session history" },
      { id: "history_schema", severity: "ok", subject: "session history" },
      { id: "history_integrity", severity: "ok", subject: "session history" },
      { id: "history_gaps", severity: "ok", subject: "session history" },
    ]);
    expect(await historyChecks(await temporaryRoot("doctor-history-empty-"), enabled)).toEqual([{ id: "history_storage", severity: "ok", subject: "session history" }]);
  });

  it("history_storage on a 0644 file, a symlinked directory, and a workspace alias pointing at the history directory", async () => {
    const loose = await freshHome();
    await chmod(historyLocation(loose).file, 0o644);
    const looseChecks = await historyChecks(loose, enabled);
    expect(looseChecks).toEqual([expect.objectContaining({ id: "history_storage", severity: "error" })]);
    expect(looseChecks[0]!.remediation).not.toContain(loose);

    const linked = await freshHome();
    const { directory } = historyLocation(linked);
    const moved = join(linked, "elsewhere");
    await rename(directory, moved);
    await symlink(moved, directory);
    expect(await historyChecks(linked, enabled)).toEqual([expect.objectContaining({ id: "history_storage", severity: "error" })]);

    const exposed = await freshHome();
    const checks = await historyChecks(exposed, enabled, { workspaces: new Map([["leak", historyLocation(exposed).directory]]) });
    expect(checks.find((check) => check.id === "history_storage")).toMatchObject({ severity: "error" });
    expect(checks.find((check) => check.id === "history_storage")!.remediation).not.toContain(exposed);
    const parent = await freshHome();
    expect((await historyChecks(parent, enabled, { workspaces: new Map([["home", parent]]) })).find((check) => check.id === "history_storage")).toMatchObject({ severity: "error" });
  });

  it("history_schema on user_version 2", async () => {
    const home = await freshHome();
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(historyLocation(home).file);
    db.exec("PRAGMA user_version = 2");
    db.close();
    const checks = await historyChecks(home, enabled);
    expect(checks.find((check) => check.id === "history_schema")).toMatchObject({ severity: "error" });
    expect(checks.map((check) => check.id)).not.toContain("history_gaps");
  });

  it("history_integrity on a corrupted page", async () => {
    const home = await freshHome();
    const handle = await open(historyLocation(home).file, "r+");
    await handle.write(Buffer.alloc(4096, 0x5a), 0, 4096, 4096);
    await handle.close();
    const checks = await historyChecks(home, enabled);
    expect(checks.find((check) => check.id === "history_integrity")).toMatchObject({ severity: "error" });
  });

  it("history_gaps warns with a count and no codes or paths in remediation", async () => {
    const home = await freshHome();
    const store = await openHistoryStore({ home });
    const insert = store.db.prepare("INSERT INTO gaps (session_id, first_turn_id, last_turn_id, code, recorded_at) VALUES (NULL, NULL, NULL, ?, ?)");
    insert.run("history_locked", new Date().toISOString());
    insert.run("history_relay_invalid", new Date().toISOString());
    insert.run("history_full", "2026-01-01T00:00:00.000Z");
    store.close();
    const gaps = (await historyChecks(home, enabled)).find((check) => check.id === "history_gaps")!;
    expect(gaps).toMatchObject({ severity: "warning" });
    expect(gaps.remediation).toContain("2 gaps");
    expect(gaps.remediation).not.toMatch(/history_(locked|relay_invalid|full)/);
    expect(gaps.remediation).not.toContain(home);
  });

  it("uses the inspection seam instead of the file when injected", async () => {
    const seen: string[] = [];
    const checks = await historyChecks("/nonexistent-home", enabled, { history: { inspect: async (home) => { seen.push(home); return { storage: "ok", schemaVersion: 1, integrity: "ok", recentGaps: 0 }; } } });
    expect(seen).toEqual(["/nonexistent-home"]);
    expect(checks.map((check) => check.severity)).toEqual(["ok", "ok", "ok", "ok"]);
  });
});

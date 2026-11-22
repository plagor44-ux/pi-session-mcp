import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseGuidedAnswers } from "../src/guided/answers.js";
import { buildGuidedPlan, GuidedPlanError, plannedChanges } from "../src/guided/plan.js";
import { runGuided, type GuidedDependencies } from "../src/guided/run.js";
import { formatSetupHuman, formatSetupResult } from "../src/setup-cli.js";
import { result, type SetupChange } from "../src/setup-result.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const base = {
  schemaVersion: 1, approveProbes: true, allowConfigChange: true,
  profiles: [{ alias: "review-medium", provider: "SECRET-PROVIDER", model: "SECRET-MODEL", role: "review", thinkingLevel: "high", tier: "medium", family: "fam" }],
  defaultProfile: "review-medium",
  workspaces: [{ alias: "project", path: "/SECRET/PATH/repo", mode: "read-only" }],
  history: { enabled: true }, routing: { mode: "manual" }, clients: { claudeCode: true, codex: true },
};
const answers = (change: Record<string, unknown> = {}) => parseGuidedAnswers({ ...base, ...change });

async function fixture(config?: unknown, routing?: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "guided-preview-"));
  directories.push(directory);
  const configPath = join(directory, "config.json");
  if (config !== undefined) await writeFile(configPath, JSON.stringify(config));
  if (routing !== undefined) await writeFile(join(directory, "routing.json"), JSON.stringify(routing));
  const target = { client: "fake", scope: "user", alias: "pi-session-mcp" };
  const deps: GuidedDependencies = {
    configPath, optionalFeatures: async () => ({ podman: true, bubblewrap: true }),
    catalog: async () => ({ thinkingLevels: () => undefined, effectiveThinkingLevel: () => undefined, providers: () => [{ id: "SECRET-PROVIDER", authConfigured: true, models: ["SECRET-MODEL"] }], outputPrice: () => 2 }),
    doctor: vi.fn(async () => ({ ok: true })),
    probe: vi.fn<GuidedDependencies["probe"]>(async () => { throw new Error("a dry run must not probe"); }),
    changeMode: vi.fn(async () => result("apply", [{ target, status: "ok", code: "mode_ready" }])),
    registrations: vi.fn(async (operation) => result(operation, [{ target, status: "absent", code: "registration_ready" }])),
    now: () => new Date("2026-11-09T12:00:00Z"),
  };
  return { directory, deps, configPath };
}
const existing = { workspaces: { other: "/SECRET/other" }, executionProfiles: { old: { default: false, permissionProfile: "read-only", provider: "SECRET-OLD", model: "SECRET-OLD-MODEL", thinkingLevel: "off" } } };
const entry = (file: SetupChange["file"], kind: SetupChange["kind"], path: string): SetupChange => ({ file, kind, path });

describe("planned changes", () => {
  it("lists the keys a fresh installation adds, by alias and field name only", () => {
    const a = answers();
    expect(plannedChanges(buildGuidedPlan(a, {}), {})).toEqual([
      entry("config", "add", "workspaces.project"), entry("config", "add", "executionProfiles.review-medium"), entry("config", "add", "history.enabled"), entry("config", "add", "events.delivery"),
      entry("routing", "add", "mode"), entry("routing", "add", "tiers.medium.review"), entry("routing", "add", "families.review-medium"),
      entry("modes", "change", "workspaces.project"), entry("client", "change", "claude-code.pi-session-mcp"), entry("client", "change", "codex.pi-session-mcp"),
    ]);
  });
  it("lists only what an existing configuration would gain, and a changed existing key as a change", () => {
    const a = answers();
    const config = { ...existing, executionProfiles: { ...existing.executionProfiles }, history: { enabled: false }, events: { delivery: "off" } };
    const routing = { mode: "off", tiers: { medium: { review: ["old"] } }, families: { old: "fam" } };
    const found = plannedChanges(buildGuidedPlan(a, { config, routing }), { config, routing });
    expect(found).toEqual(expect.arrayContaining([
      entry("config", "add", "workspaces.project"), entry("config", "add", "executionProfiles.review-medium"), entry("config", "change", "history.enabled"), entry("config", "change", "events.delivery"),
      entry("routing", "change", "mode"), entry("routing", "change", "tiers.medium.review"), entry("routing", "add", "families.review-medium"),
    ]));
    expect(found.filter((change) => change.file === "config" || change.file === "routing").length).toBe(7);
  });
  it("lists no config or routing entry when both files already match", () => {
    const a = answers();
    const first = buildGuidedPlan(a, {});
    const second = buildGuidedPlan(a, { config: first.nextConfig, routing: first.routingDocument });
    expect(plannedChanges(second, { config: first.nextConfig, routing: first.routingDocument }).map((change) => change.file)).toEqual(["modes", "client", "client"]);
  });
  it("keeps the plan on the error that refuses the change", () => {
    const a = answers({ allowConfigChange: false });
    try { buildGuidedPlan(a, { config: existing }); expect.fail("expected a refusal"); }
    catch (error) {
      expect(error).toBeInstanceOf(GuidedPlanError);
      expect(error).toMatchObject({ code: "config_change_not_allowed" });
      expect(plannedChanges((error as GuidedPlanError).plan!, { config: existing })).toContainEqual(entry("config", "add", "executionProfiles.review-medium"));
    }
  });
});

describe("dry run preview", () => {
  it("reports the changes on the planned result, without any value or path, and writes nothing", async () => {
    const f = await fixture(existing);
    const before = await readFile(f.configPath);
    const planned = await runGuided({ apply: false, answers: answers() }, f.deps);
    expect(planned).toMatchObject({ status: "planned", exitCode: 0 });
    expect(planned.changes).toContainEqual(entry("config", "add", "executionProfiles.review-medium"));
    expect(planned.changes).toContainEqual(entry("modes", "change", "workspaces.project"));
    for (const text of [formatSetupResult(planned), formatSetupHuman(planned)]) {
      for (const secret of ["SECRET", "/PATH", "gpt", f.directory]) expect(text).not.toContain(secret);
    }
    expect(JSON.parse(formatSetupResult(planned)).changes).toEqual(planned.changes);
    expect(formatSetupHuman(planned)).toContain("change: config add executionProfiles.review-medium");
    expect(await readFile(f.configPath)).toEqual(before);
    expect((await readdir(f.directory)).sort()).toEqual(["config.json"]);
    expect(f.deps.probe).not.toHaveBeenCalled();
  });
  it("shows the preview together with config_change_not_allowed so the owner can approve before allowConfigChange is set", async () => {
    const f = await fixture(existing);
    const refused = await runGuided({ apply: false, answers: answers({ allowConfigChange: false }) }, f.deps);
    expect(refused).toMatchObject({ status: "failed", exitCode: 1 });
    expect(refused.findings.map((finding) => finding.code)).toEqual(["config_change_not_allowed"]);
    expect(refused.changes).toContainEqual(entry("config", "add", "executionProfiles.review-medium"));
    expect(formatSetupResult(refused)).not.toContain("SECRET");
  });
  it("gives an apply that is refused the same code and no preview", async () => {
    const f = await fixture(existing);
    const refused = await runGuided({ apply: true, answers: answers({ allowConfigChange: false }) }, f.deps);
    expect(refused.findings.map((finding) => finding.code)).toEqual(["config_change_not_allowed"]);
    expect(refused.changes).toBeUndefined();
  });
  it("gives an applied run no preview", async () => {
    const f = await fixture(existing);
    f.deps.probe = vi.fn(async (profiles: readonly string[]) => ({ schemaVersion: 1, operation: "apply", status: "ok", doctor: { blocking: [], other: [] }, findings: profiles.map((profile) => ({ profile, status: "ok", code: "probe_passed", providerTurn: true, durationMs: 1 })), usage: "unknown", exitCode: 0 }) as never);
    const applied = await runGuided({ apply: true, answers: answers() }, f.deps);
    expect(applied.exitCode).toBe(0);
    expect(applied.changes).toBeUndefined();
  });
  it("reports no config change on a fresh directory beyond the files it would create", async () => {
    const f = await fixture();
    const planned = await runGuided({ apply: false, answers: answers() }, f.deps);
    expect(planned.changes?.filter((change) => change.file === "config").map((change) => change.kind)).toEqual(["add", "add", "add", "add"]);
  });
});

describe("result changes", () => {
  it("passes plain entries and leaves out anything else", () => {
    const report = result("dry-run", [], "planned", 0, [
      entry("config", "add", "executionProfiles.review-medium"),
      { file: "config", kind: "add", path: "/etc/passwd" },
      { file: "config", kind: "add", path: "a b" },
      { file: "config", kind: "add", path: "x".repeat(300) },
      { file: "secrets", kind: "add", path: "ok" } as never,
      { file: "config", kind: "wipe", path: "ok" } as never,
    ]);
    expect(report.changes).toEqual([entry("config", "add", "executionProfiles.review-medium")]);
  });
  it("omits the field when there is nothing to report", () => {
    expect("changes" in result("dry-run", [], "planned", 0, [])).toBe(false);
    expect("changes" in result("dry-run", [])).toBe(false);
  });
});

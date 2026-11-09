import { chmod, mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGuided, type GuidedDependencies } from "../src/guided/run.js";
import { parseGuidedAnswers } from "../src/guided/answers.js";
import { result } from "../src/setup-result.js";
import { runGuidedMain } from "../src/setup-guided-main.js";
import type { Prompter } from "../src/guided/prompts.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
const answers = () => parseGuidedAnswers({ schemaVersion: 1, approveProbes: true, allowConfigChange: true,
  profiles: ["review", "code"].map((role) => ({ alias: role, provider: "openai", model: "gpt-test", role, thinkingLevel: "medium", tier: "medium", family: "openai" })),
  defaultProfile: "review", workspaces: [{ alias: "repo", path: "/fake/repo", mode: "read-only" }], history: { enabled: true }, routing: { mode: "manual" }, clients: { claudeCode: true, codex: false } });
async function fixture(live = false) {
  const directory = await mkdtemp(join(tmpdir(), "guided-test-")); directories.push(directory);
  const configPath = join(directory, "config.json");
  if (live) await writeFile(configPath, '{ "workspaces": {}, "executionProfiles": {} }\n');
  const calls: string[] = [];
  let modeApplied = false, registered = false;
  const target = { client: "fake", scope: "user", alias: "pi-session-mcp" };
  const deps: GuidedDependencies = {
    configPath, optionalFeatures: async () => ({ podman: true, bubblewrap: true }),
    catalog: async () => ({ providers: () => [{ id: "openai", authConfigured: true, models: ["gpt-test"] }], outputPrice: () => 2 }),
    doctor: vi.fn(async () => { calls.push("doctor"); return { ok: true }; }),
    probe: vi.fn<GuidedDependencies["probe"]>(async (profiles) => { calls.push("probe"); return { schemaVersion: 1, operation: "apply", status: "ok", doctor: { blocking: [], other: [] }, findings: profiles.map((profile) => ({ profile, status: "ok", code: "probe_passed", providerTurn: true, durationMs: 1 })), usage: "unknown", exitCode: 0 }; }),
    changeMode: async () => { calls.push("changeMode"); const status = modeApplied ? "unchanged" : "ok"; modeApplied = true; return result("apply", [{ target, status, code: "mode_ready" }]); },
    registrations: async (operation) => { calls.push(operation); const status = operation === "verify" ? "ok" : registered ? "unchanged" : operation === "apply" ? "ok" : "absent"; if (operation === "apply") registered = true; return result(operation, [{ target, status, code: "registration_ready" }]); },
    now: () => new Date("2026-11-09T12:00:00Z"),
  };
  return { directory, deps, calls, configPath };
}
const codes = (r: Awaited<ReturnType<typeof runGuided>>) => r.findings.map((f) => f.code);
describe("guided run", () => {
  it("installs from answers and verifies", async () => {
    const f = await fixture(); const report = await runGuided({ apply: true, answers: answers() }, f.deps);
    expect(report.status).toBe("ok"); expect(f.calls).toEqual(["doctor", "probe", "changeMode", "apply", "doctor", "verify"]);
    expect((await stat(f.configPath)).mode & 0o777).toBe(0o600);
  });
  it("reports missing optional features and continues", async () => {
    const f = await fixture(); f.deps.optionalFeatures = async () => ({ podman: false, bubblewrap: false });
    const r = await runGuided({ apply: true, answers: answers() }, f.deps); expect(r.status).toBe("ok"); expect(codes(r)).toContain("podman_unavailable");
  });
  it("changes nothing on a second run", async () => {
    const f = await fixture(); await runGuided({ apply: true, answers: answers() }, f.deps); const before = await readFile(f.configPath);
    vi.mocked(f.deps.probe).mockClear(); const r = await runGuided({ apply: true, answers: answers() }, f.deps);
    expect(f.deps.probe).not.toHaveBeenCalled(); expect(await readFile(f.configPath)).toEqual(before); expect(r.findings.every((x) => x.status === "unchanged")).toBe(true);
  });
  it("writes and spends nothing in a dry run", async () => {
    const f = await fixture(true); const before = await readFile(f.configPath); const r = await runGuided({ apply: false, answers: answers() }, f.deps);
    expect(r.status).toBe("planned"); expect(f.deps.probe).not.toHaveBeenCalled(); expect(await readFile(f.configPath)).toEqual(before);
  });
  it("keeps the live config when a probe fails", async () => {
    const f = await fixture(true); const before = await readFile(f.configPath);
    vi.mocked(f.deps.probe).mockResolvedValue({ schemaVersion: 1, operation: "apply", status: "failed", doctor: { blocking: [], other: [] }, findings: [{ profile: "review", status: "failed", code: "probe_timeout", providerTurn: true, durationMs: 1 }], usage: "unknown", exitCode: 1 });
    expect(codes(await runGuided({ apply: true, answers: answers() }, f.deps))).toContain("default_profile_failed"); expect(await readFile(f.configPath)).toEqual(before);
  });
  it("drops a failing profile from config and routing", async () => {
    const f = await fixture(); vi.mocked(f.deps.probe).mockResolvedValue({ schemaVersion: 1, operation: "apply", status: "failed", doctor: { blocking: [], other: [] }, findings: [{ profile: "review", status: "ok", code: "probe_passed", providerTurn: true, durationMs: 1 }, { profile: "code", status: "failed", code: "probe_timeout", providerTurn: true, durationMs: 1 }], usage: "unknown", exitCode: 1 });
    const r = await runGuided({ apply: true, answers: answers() }, f.deps); expect(codes(r)).toContain("profile_dropped");
    expect(JSON.parse(await readFile(f.configPath, "utf8")).executionProfiles).not.toHaveProperty("code");
    expect(JSON.parse(await readFile(join(f.directory, "routing.json"), "utf8")).tiers.medium.code).toEqual([]);
  });
  it("removes a dropped profile from container modes", async () => {
    const f = await fixture(); const input = answers();
    input.workspaces[0]!.mode = "container"; input.workspaces[0]!.container = { profiles: ["review", "code"] };
    const probe = f.deps.probe;
    f.deps.probe = async (profiles, path) => { const report = await probe(profiles, path); return { ...report, findings: report.findings.filter((p) => p.profile !== "code") }; };
    const changeMode = vi.fn(f.deps.changeMode); f.deps.changeMode = changeMode;
    expect((await runGuided({ apply: true, answers: input }, f.deps)).exitCode).toBe(0);
    expect(changeMode.mock.calls[0]![0].container!.profiles).toEqual(["review"]);
  });
  it("stops when a container workspace loses every profile", async () => {
    const f = await fixture(true); const before = await readFile(f.configPath); const input = answers();
    input.workspaces[0]!.mode = "container"; input.workspaces[0]!.container = { profiles: ["code"] };
    const probe = f.deps.probe;
    f.deps.probe = async (profiles, path) => { const report = await probe(profiles, path); return { ...report, findings: report.findings.filter((p) => p.profile !== "code") }; };
    expect(codes(await runGuided({ apply: true, answers: input }, f.deps))).toContain("container_profiles_empty");
    expect(await readFile(f.configPath)).toEqual(before); expect(f.calls).not.toContain("changeMode"); expect(f.calls).not.toContain("apply");
    await expect(stat(join(f.directory, "routing.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("backs up routing.json before changing it", async () => {
    const f = await fixture(true); const path = join(f.directory, "routing.json"); const before = '{ "mode": "off", "custom": true }\n';
    await writeFile(path, before, { mode: 0o644 });
    expect((await runGuided({ apply: true, answers: answers() }, f.deps)).exitCode).toBe(0);
    const backup = `${path}.bak-guided-2026-11-09T12-00-00-000Z`;
    expect(await readFile(backup, "utf8")).toBe(before); expect((await stat(backup)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).not.toBe(before);
  });
  it.each([["stops on a foreign registration", "divergent", "registration_divergent"], ["stops with upgrade_required on a release mismatch", "release_binding_mismatch", "upgrade_required"]])("%s", async (_name, code, expected) => {
    const f = await fixture(true); const before = await readFile(f.configPath);
    f.deps.registrations = async () => result("dry-run", [{ target: { client: "codex", scope: "user", alias: "pi-session-mcp" }, status: "divergent", code: code! }]);
    expect(codes(await runGuided({ apply: true, answers: answers() }, f.deps))).toContain(expected); expect(await readFile(f.configPath)).toEqual(before);
  });
  it("stops with provider_login_required", async () => {
    const f = await fixture(true); f.deps.catalog = async () => ({ providers: () => [], outputPrice: () => undefined });
    const r = await runGuided({ apply: true, answers: answers() }, f.deps); expect(codes(r)).toContain("provider_login_required"); expect(JSON.stringify(r)).toContain("openai"); expect(JSON.stringify(r)).not.toContain(f.directory);
  });
  it("leaves no candidate after an abort", async () => {
    const f = await fixture(true); const before = await readFile(f.configPath); const controller = new AbortController(); f.deps.signal = controller.signal;
    f.deps.probe = async () => { controller.abort(130); throw new Error("secret"); };
    const r = await runGuided({ apply: true, answers: answers() }, f.deps); expect(r.exitCode).toBe(130); expect(await readFile(f.configPath)).toEqual(before);
    await expect(stat(`${f.configPath}.guided-candidate`)).rejects.toMatchObject({ code: "ENOENT" }); await expect(stat(`${f.configPath}.guided-candidate.json`)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("replaces a stale candidate", async () => {
    const f = await fixture(); await writeFile(`${f.configPath}.guided-candidate`, JSON.stringify({ pid: 2147483647 }));
    await writeFile(`${f.configPath}.guided-candidate.json`, "incomplete stale config");
    expect((await runGuided({ apply: true, answers: answers() }, f.deps)).status).toBe("ok");
  });
  it("refuses a live candidate", async () => {
    const f = await fixture(); await writeFile(`${f.configPath}.guided-candidate`, JSON.stringify({ pid: process.pid }));
    expect(codes(await runGuided({ apply: true, answers: answers() }, f.deps))).toContain("guided_in_progress");
    expect(JSON.parse(await readFile(`${f.configPath}.guided-candidate`, "utf8")).pid).toBe(process.pid);
  });
  it("keeps live bytes when candidate Doctor refuses", async () => {
    const f = await fixture(true); const before = await readFile(f.configPath); f.deps.doctor = async () => ({ ok: false });
    expect(codes(await runGuided({ apply: true, answers: answers() }, f.deps))).toContain("doctor_failed");
    expect(await readFile(f.configPath)).toEqual(before); expect(f.deps.probe).not.toHaveBeenCalled();
  });
  it("reports SIGTERM as exit 143 without touching live bytes", async () => {
    const f = await fixture(true); const before = await readFile(f.configPath); const controller = new AbortController(); f.deps.signal = controller.signal;
    f.deps.doctor = async () => { controller.abort(143); return { ok: true }; };
    expect((await runGuided({ apply: true, answers: answers() }, f.deps)).exitCode).toBe(143); expect(await readFile(f.configPath)).toEqual(before);
  });
  it.each(["default_profile_conflict", "routing_profile_conflict"])("reports plan refusal %s", async (code) => {
    const f = await fixture();
    await runGuided({ apply: true, answers: answers() }, f.deps); const before = await readFile(f.configPath);
    const input = answers();
    if (code === "default_profile_conflict") { input.defaultProfile = "other"; input.profiles.push({ ...input.profiles[0]!, alias: "other" }); }
    else input.profiles[0]!.family = "other";
    expect(codes(await runGuided({ apply: true, answers: input }, f.deps))).toContain(code); expect(await readFile(f.configPath)).toEqual(before);
  });
  it("detects installed clients with executable access checks on PATH", async () => {
    const f = await fixture(); await writeFile(join(f.directory, "claude"), "not a runnable program"); await chmod(join(f.directory, "claude"), 0o700);
    await writeFile(join(f.directory, "codex"), "not executable", { mode: 0o600 });
    const previous = process.env.PATH; process.env.PATH = f.directory;
    const defaults: Record<string, boolean> = {};
    const prompter: Prompter = {
      text: async (_q, fallback) => fallback ?? "",
      choose: async (_q, _options, fallback) => fallback,
      confirm: async (q, fallback) => { defaults[q] = fallback; return q.includes("Approve") || fallback; },
    };
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true); const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await runGuidedMain({ apply: false, configPath: f.configPath }, true, new AbortController().signal, { dependencies: f.deps, prompter, terminal: true })).toBe(0);
      expect(defaults["Register Claude Code (if installed), including the wake hook?"]).toBe(true);
      expect(defaults["Register Codex (if installed)?"]).toBe(false);
      expect(stderr.mock.calls.map((c) => String(c[0])).join("")).not.toContain(f.directory);
    } finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; stdout.mockRestore(); stderr.mockRestore(); }
  });
  it.each([[true, false, true], [true, true, false], [false, false, false]])("prints reconnect guidance only for successful human apply (%s, %s)", async (apply, json, expected) => {
    const f = await fixture(); const path = join(f.directory, "answers.json"); await writeFile(path, JSON.stringify(answers()));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true); const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await runGuidedMain({ apply, answersPath: path }, json, new AbortController().signal, { dependencies: f.deps })).toBe(0);
      const message = stderr.mock.calls.map((c) => String(c[0])).join("");
      expect(message.includes("must reconnect")).toBe(expected);
      if (expected) { expect(message).toContain("Claude Code and Codex"); expect(message).toContain("/mcp"); }
      expect(message).not.toContain(f.directory);
    } finally { stdout.mockRestore(); stderr.mockRestore(); }
  });
  it("rejects invalid or unreadable answers with one path-free JSON report", async () => {
    const f = await fixture(); const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await runGuidedMain({ apply: true, answersPath: join(f.directory, "missing") }, true, new AbortController().signal, { dependencies: f.deps })).toBe(1);
      expect(output).toHaveBeenCalledTimes(1); expect(JSON.parse(String(output.mock.calls[0]![0])).findings[0].code).toBe("answers_invalid");
      expect(String(output.mock.calls[0]![0])).not.toContain(f.directory);
    } finally { output.mockRestore(); }
  });
  it("does not re-check an unauthenticated provider next to an authenticated one", async () => {
    const f = await fixture(); f.deps.catalog = async () => ({ providers: () => [{ id: "openai", authConfigured: false, models: [] }, { id: "anthropic", authConfigured: true, models: ["claude-test"] }], outputPrice: () => 2 });
    const questions: string[] = [];
    const prompter: Prompter = { text: async (q, fallback) => { questions.push(q); return fallback ?? ""; }, confirm: async (q, fallback) => { questions.push(q); return q.includes("Approve") ? true : fallback; }, choose: async (q, _options, fallback) => { questions.push(q); return fallback; } };
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true); const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await runGuidedMain({ apply: false, configPath: f.configPath }, true, new AbortController().signal, { dependencies: f.deps, prompter, terminal: true })).toBe(0);
      expect(stdout).toHaveBeenCalledTimes(1); expect(JSON.parse(String(stdout.mock.calls[0]![0])).status).toBe("planned");
      const guidance = stderr.mock.calls.map((c) => String(c[0])).join(""); expect(guidance).toContain('"$(npm root -g)/pi-session-mcp/node_modules/.bin/pi"'); expect(guidance).not.toContain(f.directory);
      expect(questions).not.toContain("Re-check provider login?");
      expect(guidance).toContain("Authenticated providers: anthropic"); expect(guidance).toContain("Optional providers (not authenticated): openai");
      expect(questions.join(" ")).not.toMatch(/(?:enter|provide) (?:a )?(?:credential|api key|token)/i);
    } finally { stdout.mockRestore(); stderr.mockRestore(); }
  });
});

import { chmod, mkdtemp, readFile, writeFile, rm, stat, symlink, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGuided, type GuidedDependencies } from "../src/guided/run.js";
import { parseGuidedAnswers } from "../src/guided/answers.js";
import { result } from "../src/setup-result.js";
import { PassThrough } from "node:stream";
import { buildGuidedPlan } from "../src/guided/plan.js";
import { PROVIDER_KEY_CHILD_STDIO, offerProviderCredentials, runGuidedMain, setProviderKeyInTerminal, terminalPrompter } from "../src/setup-guided-main.js";
import type { Prompter } from "../src/guided/prompts.js";

vi.mock("node:fs/promises", { spy: true });
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
const answers = () => parseGuidedAnswers({ schemaVersion: 1, approveProbes: true, allowConfigChange: true,
  profiles: ["review", "code"].map((role) => ({ alias: role, provider: "openai", model: "gpt-test", role, thinkingLevel: "medium", tier: "medium", family: "openai" })),
  defaultProfile: "review", workspaces: [{ alias: "repo", path: "/fake/repo", mode: "read-only" }], history: { enabled: true }, routing: { mode: "manual" }, clients: { claudeCode: true, codex: false } });
/** A catalog that cannot tell a model's thinking levels, so proposals keep the role's level. */
const noLevels = { thinkingLevels: () => undefined, effectiveThinkingLevel: () => undefined };
const FIRST_PROVIDER_QUESTION = "Provider ID (? lists them, empty to continue)";
const NEXT_PROVIDER_QUESTION = "Another provider ID (? lists them, empty to continue)";
const providerQuestion = (q: string) => q === FIRST_PROVIDER_QUESTION || q === NEXT_PROVIDER_QUESTION;
const KEY_OFFER = "Store a provider key now?";
async function fixture(live = false) {
  const directory = await mkdtemp(join(tmpdir(), "guided-test-")); directories.push(directory);
  const configPath = join(directory, "config.json");
  if (live) await writeFile(configPath, '{ "workspaces": {}, "executionProfiles": {} }\n');
  const calls: string[] = [];
  let modeApplied = false, registered = false;
  const target = { client: "fake", scope: "user", alias: "pi-session-mcp" };
  const deps: GuidedDependencies = {
    configPath, optionalFeatures: async () => ({ podman: true, bubblewrap: true }),
    catalog: async () => ({ ...noLevels, providers: () => [{ id: "openai", authConfigured: true, models: ["gpt-test"] }], outputPrice: () => 2 }),
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
  it.each([
    { apply: true, terminal: true, stderrTerminal: true, offered: true },
    { apply: false, terminal: true, stderrTerminal: true, offered: false },
    { apply: true, terminal: true, stderrTerminal: false, offered: false },
  ])("gates provider key handoff: $apply $terminal $stderrTerminal", async ({ apply, terminal, stderrTerminal, offered }) => {
    const f = await fixture();
    let reads = 0;
    f.deps.catalog = async () => { reads++; return { ...noLevels, providers: () => [{ id: "openai", authConfigured: false, models: ["gpt-test"] }], outputPrice: () => 2 }; };
    const child = vi.fn(async () => 1);
    const prompts: string[] = [];
    // The owner opts in, names an unknown ID, then openai, then ends the list.
    const ids = ["no-such-provider", "openai", ""];
    const prompter: Prompter = {
      text: async (q, fallback) => { prompts.push(q); return providerQuestion(q) ? ids.shift() ?? "" : fallback ?? ""; },
      confirm: async (q, fallback) => { prompts.push(q); return q === KEY_OFFER ? true : fallback ?? false; },
      choose: async (q, _opts, fallback) => { prompts.push(q); return fallback; },
    };
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await runGuidedMain({ apply, configPath: f.configPath }, true, new AbortController().signal, { dependencies: f.deps, prompter, terminal, stderrTerminal, setProviderKey: child });
      expect(child).toHaveBeenCalledTimes(offered ? 1 : 0);
      expect(prompts.includes(KEY_OFFER)).toBe(offered);
      if (offered) {
        expect(child).toHaveBeenCalledWith("openai");
        expect(JSON.stringify(child.mock.calls)).not.toContain("sk-test-SENTINEL");
        expect(reads).toBeGreaterThanOrEqual(2);
        const stderr = err.mock.calls.map(c => String(c[0])).join("");
        expect(stderr).toContain("Unknown provider ID");
        expect(stderr).not.toContain("no-such-provider");
        expect(stderr).toContain("openai: key command failed, not authenticated");
        expect(stderr).not.toContain("not configured");
      }
      expect(f.deps.probe).not.toHaveBeenCalled();
    } finally { out.mockRestore(); err.mockRestore(); }
  });
  it("leaves the outcome of a stored key to the key command and then asks for another provider", async () => {
    const f = await fixture();
    let stored = false, reads = 0;
    f.deps.catalog = async () => { reads++; return { ...noLevels, providers: () => [{ id: "openai", authConfigured: stored, models: ["gpt-test"] }], outputPrice: () => 2 }; };
    const child = vi.fn(async () => { stored = true; return 0; });
    const ids = ["openai", ""];
    const prompts: string[] = [];
    const prompter: Prompter = {
      text: async (q, fallback) => { prompts.push(q); return providerQuestion(q) ? ids.shift() ?? "" : fallback ?? ""; },
      confirm: async (q, fallback) => q === KEY_OFFER ? true : fallback ?? false,
      choose: async (_q, _opts, fallback) => fallback,
    };
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await runGuidedMain({ apply: true, configPath: f.configPath }, true, new AbortController().signal, { dependencies: f.deps, prompter, terminal: true, stderrTerminal: true, setProviderKey: child });
      expect(child).toHaveBeenCalledWith("openai");
      expect(reads).toBeGreaterThanOrEqual(2);
      expect(prompts.filter(providerQuestion)).toEqual([FIRST_PROVIDER_QUESTION, NEXT_PROVIDER_QUESTION]);
      const stderr = err.mock.calls.map(c => String(c[0])).join("");
      expect(stderr).not.toMatch(/openai: (?:nothing changed|key command)/);
      expect(stderr).toContain("Authenticated providers: openai");
      expect(out.mock.calls.map(c => String(c[0])).join("")).not.toContain("one at a time");
    } finally { out.mockRestore(); err.mockRestore(); }
  });
  it("runs the key command with interrupts deferred", async () => {
    const f = await fixture();
    const events: string[] = [];
    const ids = ["openai", ""];
    const prompter: Prompter = {
      text: async (q, fallback) => providerQuestion(q) ? ids.shift() ?? "" : fallback ?? "",
      confirm: async (q, fallback) => q === KEY_OFFER ? true : fallback ?? false,
      choose: async (_q, _opts, fallback) => fallback,
    };
    const deferInterrupts = async <T>(run: () => Promise<T>): Promise<T> => { events.push("defer"); try { return await run(); } finally { events.push("resume"); } };
    const setProviderKey = async (): Promise<number> => { events.push("child"); return 0; };
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await runGuidedMain({ apply: true, configPath: f.configPath }, true, new AbortController().signal, { dependencies: f.deps, prompter, terminal: true, stderrTerminal: true, setProviderKey, deferInterrupts });
      expect(events).toEqual(["defer", "child", "resume"]);
    } finally { out.mockRestore(); err.mockRestore(); }
  });
  it("runs the key child with stdout on stderr and returns only its exit status", async () => {
    expect(PROVIDER_KEY_CHILD_STDIO).toEqual(["inherit", 2, "inherit"]);
    const script = join(await mkdtemp(join(tmpdir(), "guided-child-")), "child.mjs"); directories.push(join(script, ".."));
    await writeFile(script, 'const [, , a, b, id] = process.argv; if (a !== "auth" || b !== "set") process.exit(9); if (id === "signal") process.kill(process.pid, "SIGKILL"); process.exit(id === "openai" ? 0 : 3);\n');
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await setProviderKeyInTerminal("openai", script)).toBe(0);
      expect(await setProviderKeyInTerminal("other", script)).toBe(3);
      expect(await setProviderKeyInTerminal("signal", script)).toBe(1);
      expect(await setProviderKeyInTerminal("openai", join(script, "..", "missing.mjs"))).not.toBe(0);
    } finally { err.mockRestore(); }
  });
  it("never offers credential handoff with answers", async () => {
    const f = await fixture(); const path = join(f.directory, "answers.json"); await writeFile(path, "{}");
    const child = vi.fn(async () => 0); const prompter: Prompter = { text: vi.fn(), confirm: vi.fn(), choose: vi.fn() };
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true); const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await runGuidedMain({ apply: true, answersPath: path }, true, new AbortController().signal, { dependencies: f.deps, prompter, terminal: true, stderrTerminal: true, setProviderKey: child });
      expect(child).not.toHaveBeenCalled(); expect(prompter.choose).not.toHaveBeenCalled();
    } finally { out.mockRestore(); err.mockRestore(); }
  });
  it("rejects a pending terminal question when input ends", async () => {
    const input = new PassThrough(); const terminal = terminalPrompter(new AbortController().signal, input);
    try {
      const pending = expect(terminal.prompter.text("Question")).rejects.toMatchObject({ code: "input_closed" });
      input.end(); await pending;
      await expect(terminal.prompter.text("Again")).rejects.toMatchObject({ code: "input_closed" });
    } finally { terminal.close(); }
  });
  it.each(["input_closed", "interview_declined", "no_read_only_profile", "provider_login_required", "answers_invalid", "untrusted"]) ("reports only allowed interview codes: %s", async (code) => {
    const f = await fixture();
    const prompter: Prompter = { text: async () => "", confirm: async () => false, choose: async () => { throw Object.assign(new Error("private"), { code }); } };
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true); const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await runGuidedMain({ apply: true, configPath: f.configPath }, true, new AbortController().signal, { dependencies: f.deps, prompter, terminal: true })).toBe(1);
      expect(JSON.parse(String(stdout.mock.calls[0]![0])).findings[0].code).toBe(code === "untrusted" ? "operation_failed" : code);
    } finally { stdout.mockRestore(); stderr.mockRestore(); }
  });
  it.each([false, true])("rejects unknown models before writes (apply %s)", async (apply) => {
    const f = await fixture(); const a = answers(); a.profiles[0]!.model = "unknown";
    const r = await runGuided({ apply, answers: a }, f.deps);
    expect(r.findings).toContainEqual({ target: { client: "guided", scope: "profiles", alias: "review" }, status: "failed", code: "model_unknown" });
    expect(await readdir(f.directory)).toEqual([]); expect(f.deps.probe).not.toHaveBeenCalled();
  });
  it("does not report arbitrary provider-shaped input", async () => {
    const f = await fixture(); const a = answers(); a.profiles[0]!.provider = "sk-live-secret";
    const path = join(f.directory, "answers.json"); await writeFile(path, JSON.stringify(a));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const r = await runGuided({ apply: false, answers: a }, f.deps);
      expect(r.findings[0]!.target.alias).toBe("provider"); expect(JSON.stringify(r)).not.toContain("sk-live-secret");
      expect(await runGuidedMain({ apply: false, answersPath: path }, true, new AbortController().signal, { dependencies: f.deps })).toBe(1);
      expect(stdout.mock.calls.map((c) => String(c[0])).join("")).not.toContain("sk-live-secret");
    } finally { stdout.mockRestore(); }
  });
  it("does not report an unsafe catalog provider id", async () => {
    const f = await fixture(); const a = answers(); const id = "unsafe\nprovider";
    a.profiles[0]!.provider = id;
    f.deps.catalog = async () => ({ ...noLevels, providers: () => [{ id, authConfigured: false, models: [] }], outputPrice: () => undefined });
    const r = await runGuided({ apply: true, answers: a }, f.deps);
    expect(codes(r)).toContain("provider_login_required"); expect(r.findings.at(-1)!.target.alias).toBe("provider");
    expect(JSON.stringify(r)).not.toContain(JSON.stringify(id).slice(1, -1));
    expect(await readdir(f.directory)).toEqual([]);
  });
  it.each(["config", "routing"]) ("refuses non-regular %s in dry run and apply", async (alias) => {
    const f = await fixture(); const target = join(f.directory, "target"); await writeFile(target, "{}");
    const path = alias === "config" ? f.configPath : join(f.directory, "routing.json");
    await symlink(target, path);
    for (const apply of [false, true]) {
      const r = await runGuided({ apply, answers: answers() }, f.deps);
      expect(r.findings).toContainEqual({ target: { client: "guided", scope: "config", alias }, status: "failed", code: "config_not_regular" });
    }
    expect(await readFile(target, "utf8")).toBe("{}");
    await rm(path); await mkdir(path);
    expect(codes(await runGuided({ apply: false, answers: answers() }, f.deps))).toContain("config_not_regular");
  });
  it.each(["config", "routing"]) ("detects concurrent %s changes before replacing live files", async (alias) => {
    const f = await fixture(true); const before = await readFile(f.configPath, "utf8");
    const path = alias === "config" ? f.configPath : join(f.directory, "routing.json");
    const probe = f.deps.probe; f.deps.probe = async (profiles, candidate) => { await writeFile(path, '{"changed":true}'); return probe(profiles, candidate); };
    expect(codes(await runGuided({ apply: true, answers: answers() }, f.deps))).toContain("config_changed_during_run");
    expect(await readFile(f.configPath, "utf8")).toBe(alias === "config" ? '{"changed":true}' : before);
    expect(await readdir(f.directory)).not.toContain("config.json.bak-guided-2026-11-09T12-00-00-000Z");
  });
  it("unlinks a probe-created candidate symlink before rewriting", async () => {
    const f = await fixture(); const target = join(f.directory, "target"); await writeFile(target, "unchanged");
    // code-two passes, so dropping code leads to the rewrite instead of the coding_profiles_dropped stop.
    const a = answers(); a.profiles.push({ ...a.profiles[1]!, alias: "code-two" });
    const probe = f.deps.probe;
    f.deps.probe = async (profiles, candidate) => { const r = await probe(profiles, candidate); await rm(candidate); await symlink(target, candidate); return { ...r, findings: r.findings.filter((p) => p.profile !== "code") }; };
    expect((await runGuided({ apply: true, answers: a }, f.deps)).exitCode).toBe(0);
    expect(await readFile(target, "utf8")).toBe("unchanged");
  });
  it("removes a dropped alias from previously unchanged routing and backs it up", async () => {
    const f = await fixture(); const a = answers(); a.profiles[1]!.alias = "x"; a.profiles[1]!.tier = null; a.profiles[1]!.family = null;
    // A second coding profile passes, so dropping x does not leave the installation without one.
    a.profiles.push({ ...a.profiles[1]!, alias: "y" });
    const routing = { mode: "manual", tiers: { medium: { review: ["review"], code: ["x"] } }, families: { review: "openai", x: "openai" } };
    expect(buildGuidedPlan(a, { routing }).routingChanged).toBe(false);
    const path = join(f.directory, "routing.json"); await writeFile(path, JSON.stringify(routing));
    const probe = f.deps.probe; f.deps.probe = async (profiles, candidate) => { const r = await probe(profiles, candidate); return { ...r, findings: r.findings.filter((p) => p.profile !== "x") }; };
    expect((await runGuided({ apply: true, answers: a }, f.deps)).exitCode).toBe(0);
    const live = JSON.parse(await readFile(path, "utf8")); expect(live.tiers.medium.code).toEqual([]); expect(live.families).not.toHaveProperty("x");
    expect(JSON.parse(await readFile(`${path}.bak-guided-2026-11-09T12-00-00-000Z`, "utf8"))).toEqual(routing);
  });
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
  it("plans probes in a dry run without approval and refuses the apply", async () => {
    const f = await fixture(true); const before = await readFile(f.configPath); const unapproved = { ...answers(), approveProbes: false };
    const planned = await runGuided({ apply: false, answers: unapproved }, f.deps);
    expect(planned).toMatchObject({ status: "planned", exitCode: 0 }); expect(codes(planned)).toEqual(expect.arrayContaining(["probe_planned"])); expect(codes(planned)).not.toContain("probes_not_approved");
    const applied = await runGuided({ apply: true, answers: unapproved }, f.deps);
    expect(applied.exitCode).toBe(1); expect(codes(applied)).toContain("probes_not_approved");
    expect(f.deps.probe).not.toHaveBeenCalled(); expect(f.deps.doctor).not.toHaveBeenCalled(); expect(await readFile(f.configPath)).toEqual(before);
    expect((await readdir(f.directory)).sort()).toEqual(["config.json"]);
  });
  it("keeps the live config when a probe fails", async () => {
    const f = await fixture(true); const before = await readFile(f.configPath);
    vi.mocked(f.deps.probe).mockResolvedValue({ schemaVersion: 1, operation: "apply", status: "failed", doctor: { blocking: [], other: [] }, findings: [{ profile: "review", status: "failed", code: "probe_timeout", providerTurn: true, durationMs: 1 }, { profile: "code", status: "ok", code: "probe_passed", providerTurn: true, durationMs: 1 }], usage: "unknown", exitCode: 1 });
    const r = await runGuided({ apply: true, answers: answers() }, f.deps);
    expect(r.findings.filter((x) => x.target.scope === "profiles")).toEqual([
      { target: { client: "guided", scope: "profiles", alias: "code" }, status: "ok", code: "probe_passed" },
      { target: { client: "guided", scope: "profiles", alias: "review" }, status: "failed", code: "default_profile_failed", cause: "probe_timeout" },
    ]);
    expect(await readFile(f.configPath)).toEqual(before);
  });
  it("drops a failing profile from config and routing", async () => {
    const f = await fixture(); const a = answers(); a.profiles.push({ ...a.profiles[1]!, alias: "code-two" });
    vi.mocked(f.deps.probe).mockResolvedValue({ schemaVersion: 1, operation: "apply", status: "failed", doctor: { blocking: [], other: [] }, findings: [{ profile: "review", status: "ok", code: "probe_passed", providerTurn: true, durationMs: 1 }, { profile: "code", status: "failed", code: "probe_timeout", providerTurn: true, durationMs: 1 }, { profile: "code-two", status: "ok", code: "probe_passed", providerTurn: true, durationMs: 1 }], usage: "unknown", exitCode: 1 });
    const r = await runGuided({ apply: true, answers: a }, f.deps);
    expect(r.findings).toContainEqual({ target: { client: "guided", scope: "profiles", alias: "code" }, status: "ok", code: "profile_dropped", cause: "probe_timeout" });
    expect(JSON.parse(await readFile(f.configPath, "utf8")).executionProfiles).not.toHaveProperty("code");
    expect(JSON.parse(await readFile(join(f.directory, "routing.json"), "utf8")).tiers.medium.code).toEqual(["code-two"]);
  });
  it("names the session-start cause of a dropped profile and reports every passed probe", async () => {
    const f = await fixture(); const a = answers(); a.profiles.push({ ...a.profiles[1]!, alias: "code-two" });
    vi.mocked(f.deps.probe).mockResolvedValue({ schemaVersion: 1, operation: "apply", status: "failed", doctor: { blocking: [], other: [] }, findings: [
      { profile: "review", status: "ok", code: "probe_passed", providerTurn: true, durationMs: 1 },
      { profile: "code", status: "failed", code: "probe_start_failed", startCode: "thinking_level_unavailable", providerTurn: false, durationMs: 1 },
      { profile: "code-two", status: "ok", code: "probe_passed", providerTurn: true, durationMs: 1 },
    ], usage: "unknown", exitCode: 1 });
    const r = await runGuided({ apply: true, answers: a }, f.deps);
    expect(r).toMatchObject({ status: "ok", exitCode: 0 });
    expect(r.findings.filter((x) => x.target.scope === "profiles")).toEqual([
      { target: { client: "guided", scope: "profiles", alias: "review" }, status: "ok", code: "probe_passed" },
      { target: { client: "guided", scope: "profiles", alias: "code" }, status: "ok", code: "profile_dropped", cause: "thinking_level_unavailable" },
      { target: { client: "guided", scope: "profiles", alias: "code-two" }, status: "ok", code: "probe_passed" },
    ]);
  });
  it("does not stop for a missing coding profile when the owner accepted none", async () => {
    const f = await fixture(); const a = answers(); a.profiles[1]!.alias = "explore"; a.profiles[1]!.role = "explore";
    vi.mocked(f.deps.probe).mockResolvedValue({ schemaVersion: 1, operation: "apply", status: "failed", doctor: { blocking: [], other: [] }, findings: [{ profile: "review", status: "ok", code: "probe_passed", providerTurn: true, durationMs: 1 }, { profile: "explore", status: "failed", code: "probe_timeout", providerTurn: true, durationMs: 1 }], usage: "unknown", exitCode: 1 });
    const r = await runGuided({ apply: true, answers: a }, f.deps);
    expect(r).toMatchObject({ status: "ok", exitCode: 0 });
    expect(r.findings).toContainEqual({ target: { client: "guided", scope: "profiles", alias: "explore" }, status: "ok", code: "profile_dropped", cause: "probe_timeout" });
    expect(codes(r)).not.toContain("coding_profiles_dropped");
  });
  it("stops before any live change when the probes drop every accepted coding profile", async () => {
    const f = await fixture(true); const before = await readFile(f.configPath);
    vi.mocked(f.deps.probe).mockResolvedValue({ schemaVersion: 1, operation: "apply", status: "failed", doctor: { blocking: [], other: [] }, findings: [
      { profile: "review", status: "ok", code: "probe_passed", providerTurn: true, durationMs: 1 },
      { profile: "code", status: "failed", code: "probe_start_failed", startCode: "thinking_level_unavailable", providerTurn: false, durationMs: 1 },
    ], usage: "unknown", exitCode: 1 });
    const r = await runGuided({ apply: true, answers: answers() }, f.deps);
    expect(r).toMatchObject({ status: "failed", exitCode: 1 });
    expect(r.findings.slice(-2)).toEqual([
      { target: { client: "guided", scope: "profiles", alias: "code" }, status: "ok", code: "profile_dropped", cause: "thinking_level_unavailable" },
      { target: { client: "guided", scope: "profiles", alias: "installation" }, status: "failed", code: "coding_profiles_dropped" },
    ]);
    expect(await readFile(f.configPath)).toEqual(before);
    for (const call of ["changeMode", "apply", "verify"]) expect(f.calls).not.toContain(call);
    expect(await readdir(f.directory)).toEqual(["config.json"]);
  });
  it("leaves live bytes untouched with no backup when every new profile is dropped", async () => {
    const f = await fixture(); const a = answers();
    a.routing.mode = "off";
    for (const profile of a.profiles) { profile.tier = null; profile.family = null; }
    // The existing coding profile keeps the installation able to code, so dropping the new one does not stop the run.
    const baseline = { ...a, profiles: [a.profiles[0]!, { ...a.profiles[1]!, alias: "coder" }] };
    const config = buildGuidedPlan(baseline, {}).nextConfig;
    const before = JSON.stringify(config, null, 4) + "\n\n";
    await writeFile(f.configPath, before);
    expect(buildGuidedPlan(a, { config }).newProfiles).toEqual(["code"]);
    vi.mocked(f.deps.probe).mockResolvedValue({ schemaVersion: 1, operation: "apply", status: "failed", doctor: { blocking: [], other: [] }, findings: [{ profile: "code", status: "failed", code: "probe_timeout", providerTurn: true, durationMs: 1 }], usage: "unknown", exitCode: 1 });
    const r = await runGuided({ apply: true, answers: a }, f.deps);
    expect(r.exitCode).toBe(0); expect(codes(r)).toContain("profile_dropped");
    expect(codes(r)).toContain("configuration_unchanged"); expect(codes(r)).not.toContain("configuration_installed");
    expect(await readFile(f.configPath, "utf8")).toBe(before);
    expect(await readdir(f.directory)).toEqual(["config.json"]);
  });
  it("removes a dropped profile from container modes", async () => {
    const f = await fixture(); const input = answers();
    input.workspaces[0]!.mode = "container"; input.profiles.push({ ...input.profiles[1]!, alias: "writer" });
    input.workspaces[0]!.container = { profiles: ["writer", "code"] };
    const probe = f.deps.probe;
    f.deps.probe = async (profiles, path) => { const report = await probe(profiles, path); return { ...report, findings: report.findings.filter((p) => p.profile !== "code") }; };
    const changeMode = vi.fn(f.deps.changeMode); f.deps.changeMode = changeMode;
    expect((await runGuided({ apply: true, answers: input }, f.deps)).exitCode).toBe(0);
    expect(changeMode.mock.calls[0]![0].container!.profiles).toEqual(["writer"]);
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
    const f = await fixture(true); f.deps.catalog = async () => ({ ...noLevels, providers: () => [], outputPrice: () => undefined });
    const r = await runGuided({ apply: true, answers: answers() }, f.deps); expect(codes(r)).toContain("provider_login_required"); expect(r.findings.at(-1)!.target.alias).toBe("provider"); expect(JSON.stringify(r)).not.toContain(f.directory);
  });
  it("leaves no candidate after an abort", async () => {
    const f = await fixture(true); const before = await readFile(f.configPath); const controller = new AbortController(); f.deps.signal = controller.signal;
    f.deps.probe = async () => { controller.abort(130); throw new Error("secret"); };
    const r = await runGuided({ apply: true, answers: answers() }, f.deps); expect(r.exitCode).toBe(130); expect(await readFile(f.configPath)).toEqual(before);
    expect(await readdir(f.directory)).toEqual(["config.json"]);
  });
  it("removes a dead owner's claim and replaces a stale candidate", async () => {
    const f = await fixture(); await writeFile(`${f.configPath}.guided-claim-dead`, JSON.stringify({ pid: 2147483647 }));
    await writeFile(`${f.configPath}.guided-candidate.json`, "incomplete stale config");
    expect((await runGuided({ apply: true, answers: answers() }, f.deps)).status).toBe("ok");
    expect(JSON.parse(await readFile(f.configPath, "utf8")).executionProfiles).toHaveProperty("review");
    expect(await readdir(f.directory)).toEqual(["config.json", "routing.json"]);
  });
  it("publishes a complete private immutable claim by rename", async () => {
    const f = await fixture(); const actual = await vi.importActual<typeof fs>("node:fs/promises");
    const rename = vi.spyOn(fs, "rename").mockImplementationOnce(async (source, destination) => {
      expect(String(source)).toMatch(/config\.json\.guided-tmp-/);
      expect(String(destination)).toMatch(/config\.json\.guided-claim-/);
      expect(JSON.parse(await readFile(source, "utf8"))).toEqual({ pid: process.pid });
      expect((await stat(source)).mode & 0o777).toBe(0o600);
      await actual.rename(source, destination);
    });
    try {
      expect((await runGuided({ apply: true, answers: answers() }, f.deps)).exitCode).toBe(0);
      expect(rename).toHaveBeenCalled();
      expect(await readdir(f.directory)).toEqual(["config.json", "routing.json"]);
    } finally { rename.mockRestore(); }
  });
  it("backs off when another live claim appears after publishing, removing only its own claim", async () => {
    const f = await fixture(true); const before = await readFile(f.configPath);
    const claim = `${f.configPath}.guided-claim-other`; const bytes = `{ "pid": ${process.pid} }\n`;
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    const rename = vi.spyOn(fs, "rename").mockImplementationOnce(async (source, destination) => {
      await actual.rename(source, destination);
      await writeFile(claim, bytes);
    });
    try {
      expect(codes(await runGuided({ apply: true, answers: answers() }, f.deps))).toContain("guided_in_progress");
      expect(await readFile(claim, "utf8")).toBe(bytes);
      expect(await readFile(f.configPath)).toEqual(before);
      expect(f.deps.doctor).not.toHaveBeenCalled();
      expect(await readdir(f.directory)).toEqual(["config.json", "config.json.guided-claim-other"]);
    } finally { rename.mockRestore(); }
  });
  it("does not block on a claim that disappears between listing and reading", async () => {
    const f = await fixture(); const claim = `${f.configPath}.guided-claim-gone`;
    await writeFile(claim, JSON.stringify({ pid: process.pid }));
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    const list = vi.spyOn(fs, "readdir").mockImplementationOnce(async (...args: Parameters<typeof fs.readdir>) => {
      const entries = await actual.readdir(...args);
      await rm(claim);
      return entries;
    });
    try {
      expect((await runGuided({ apply: true, answers: answers() }, f.deps)).exitCode).toBe(0);
      expect(await readdir(f.directory)).toEqual(["config.json", "routing.json"]);
    } finally { list.mockRestore(); }
  });
  it.each(["", "invalid", "null", '{"pid":0}', '{"pid":1.5}', '{"pid":9007199254740992}'])("leaves invalid foreign claim contents alone: %s", async (bytes) => {
    const f = await fixture(); const claim = `${f.configPath}.guided-claim-invalid`; await writeFile(claim, bytes);
    expect(codes(await runGuided({ apply: true, answers: answers() }, f.deps))).toContain("guided_in_progress");
    expect(await readFile(claim, "utf8")).toBe(bytes);
    expect(await readdir(f.directory)).toEqual(["config.json.guided-claim-invalid"]);
  });
  it("refuses a foreign live claim without changing live files or the claim", async () => {
    const f = await fixture(true); const before = await readFile(f.configPath);
    const claim = `${f.configPath}.guided-claim-live`; const bytes = `{ "pid": ${process.pid} }\n`;
    await writeFile(claim, bytes);
    const candidate = `${f.configPath}.guided-candidate.json`; await writeFile(candidate, "stale candidate");
    expect(codes(await runGuided({ apply: true, answers: answers() }, f.deps))).toContain("guided_in_progress");
    expect(await readFile(claim, "utf8")).toBe(bytes); expect(await readFile(f.configPath)).toEqual(before);
    expect(await readFile(candidate, "utf8")).toBe("stale candidate");
    expect(await readdir(f.directory)).toEqual(["config.json", "config.json.guided-candidate.json", "config.json.guided-claim-live"]);
  });
  it("cleans the temporary file when claim publication fails", async () => {
    const f = await fixture();
    const rename = vi.spyOn(fs, "rename").mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
    try {
      expect(codes(await runGuided({ apply: true, answers: answers() }, f.deps))).toContain("operation_failed");
      expect(await readdir(f.directory)).toEqual([]);
    } finally { rename.mockRestore(); }
  });
  it("ignores claim prefixes for different configuration file names", async () => {
    const f = await fixture(); const siblings = ["config.json-other.guided-claim-x", "other.json.guided-claim-x"];
    for (const name of siblings) await writeFile(join(f.directory, name), JSON.stringify({ pid: process.pid }));
    expect((await runGuided({ apply: true, answers: answers() }, f.deps)).exitCode).toBe(0);
    expect(await readdir(f.directory)).toEqual(["config.json", ...siblings, "routing.json"].sort());
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
    const f = await fixture(); f.deps.catalog = async () => ({ ...noLevels, providers: () => [{ id: "openai", authConfigured: false, models: [] }, { id: "anthropic", authConfigured: true, models: ["claude-test"] }], outputPrice: () => 2 });
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
describe("provider key step", () => {
  const catalogOf = (authenticated: Record<string, boolean>) => ({ ...noLevels, outputPrice: () => 2,
    providers: () => Object.entries(authenticated).map(([id, authConfigured]) => ({ id, authConfigured, models: ["m"] })) });
  const providers = { anthropic: true, deepseek: false, openai: false, "openai-codex": false };
  async function step(answers: string[], options: { status?: number | ((id: string) => number); before?: Record<string, boolean>; after?: Record<string, boolean> } = {}) {
    const events: string[] = [];
    const prompter: Prompter = {
      text: async (q) => { events.push(`ask: ${q}`); return answers.shift() ?? ""; },
      confirm: async (q) => { events.push(`confirm: ${q}`); return true; },
      choose: async (_q, _options, fallback) => fallback,
    };
    const run = vi.fn(async (id: string) => typeof options.status === "function" ? options.status(id) : options.status ?? 0);
    const before = options.before ?? providers;
    await offerProviderCredentials(prompter, catalogOf(before), async () => catalogOf(options.after ?? before), run, (text) => { events.push(`say: ${text}`); });
    const said = events.filter((e) => e.startsWith("say: ")).map((e) => e.slice(5));
    return { events, run, said, asked: events.filter((e) => e.startsWith("ask: ")).map((e) => e.slice(5)) };
  }
  it("explains the step before its first question and words the question differently after a stored key", async () => {
    const { events, said, asked } = await step(["openai", ""], { after: { ...providers, openai: true } });
    expect(events[0]).toMatch(/^say: /); expect(events[1]).toBe(`confirm: ${KEY_OFFER}`);
    expect(said[0]).toContain("each provider you name, one at a time"); expect(said[0]).toContain("an empty answer continues");
    expect(asked).toEqual([FIRST_PROVIDER_QUESTION, NEXT_PROVIDER_QUESTION]);
    // The key command itself says whether it stored or replaced the key; the step adds no line.
    expect(said).toHaveLength(1);
  });
  it("keeps the follow-up question after a later entry fails", async () => {
    const { said, asked } = await step(["openai", "deepseek", ""], { status: (id) => id === "openai" ? 0 : 4, after: { ...providers, openai: true } });
    expect(asked).toEqual([FIRST_PROVIDER_QUESTION, NEXT_PROVIDER_QUESTION, NEXT_PROVIDER_QUESTION]);
    expect(said.slice(1)).toEqual(["deepseek: nothing changed, not authenticated\n"]);
  });
  it("lists the provider IDs on ? without running the key command", async () => {
    const { run, said, asked } = await step(["?", ""]);
    expect(run).not.toHaveBeenCalled();
    expect(said.slice(1)).toEqual(["Authenticated providers: anthropic\nOptional providers (not authenticated): deepseek, openai, openai-codex\n"]);
    expect(asked).toEqual([FIRST_PROVIDER_QUESTION, FIRST_PROVIDER_QUESTION]);
  });
  it("answers an unknown ID with close catalog IDs and never echoes it", async () => {
    const { run, said } = await step(["OpenAI-Codx", "opena", "open ai", "zz-sk-test-SENTINEL", "bad id!", ""]);
    expect(run).not.toHaveBeenCalled();
    expect(said.slice(1)).toEqual([
      "Unknown provider ID. Closest: openai-codex. Enter ? to list all.\n",
      "Unknown provider ID. Closest: openai, openai-codex. Enter ? to list all.\n",
      "Unknown provider ID. Closest: openai. Enter ? to list all.\n",
      "Unknown provider ID. Enter ? to list all provider IDs.\n",
      "Unknown provider ID. Enter ? to list all provider IDs.\n",
    ]);
    expect(said.join("")).not.toMatch(/Codx|open ai|SENTINEL|bad id/);
  });
  it.each([
    { status: 4, authenticated: true, line: "openai: nothing changed, still authenticated\n" },
    { status: 3, authenticated: false, line: "openai: nothing changed, not authenticated\n" },
    { status: 64, authenticated: true, line: "openai: nothing changed, still authenticated\n" },
    { status: 1, authenticated: true, line: "openai: key command failed, authenticated\n" },
    { status: 1, authenticated: false, line: "openai: key command failed, not authenticated\n" },
    { status: 0, authenticated: false, line: "openai: key command succeeded, but not authenticated\n" },
  ])("reports exit $status with authentication $authenticated in one outcome line", async ({ status, authenticated, line }) => {
    const catalog = { ...providers, openai: authenticated };
    const { run, said, asked } = await step(["openai", ""], { status, before: catalog, after: catalog });
    expect(run).toHaveBeenCalledWith("openai");
    expect(said.slice(1)).toEqual([line]);
    // Only a key that the reloaded catalog shows counts as stored.
    expect(asked).toEqual([FIRST_PROVIDER_QUESTION, FIRST_PROVIDER_QUESTION]);
  });
});

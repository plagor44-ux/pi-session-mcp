import { cp, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, ModelRuntime, SettingsManager, type AgentSession, type AgentSessionServices, type AgentSessionRuntime, type ResourceLoader, createAgentSession, createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseExtensionSpec } from "../src/extension-spec.js";
import type { ResolvedExecutionProfile } from "../src/execution-profile.js";
import { resolvePiExtension } from "../src/pi-extensions.js";
import { SdkPiSessionAdapter, type SdkPiAdapterDiagnostic, type ExtensionSdk } from "../src/sdk-pi-adapter.js";
import { SessionRegistry } from "../src/session-registry.js";
import type { SkillSelection } from "../src/skill-catalog.js";
import { loadSelectedSkills } from "../src/pi-skills.js";
import type { McpConnection } from "../src/mcp-session-tools.js";
import { declaredTools } from "./model-context.js";
import { temporaryRoot, removeTemporaryRoots } from "./temporary-roots.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/pi-skill-fixtures/", import.meta.url));
const selected = (folder: string, alias = "catalog-alias"): SkillSelection => ({ alias, path: join(FIXTURES, folder, "SKILL.md") });
const events = (): string[] => ((globalThis as { __piSkillFixtureEvents?: string[] }).__piSkillFixtureEvents ??= []);
interface Report { system: string; user: string; tools: string[] }
afterAll(removeTemporaryRoots);
beforeEach(() => { events().length = 0; });

function scriptedRuntime(): ModelRuntime {
  const model = { provider: "scripted", id: "scripted", input: ["text"] };
  return {
    getProvider: () => ({ id: "scripted" }), getModel: () => model,
    hasConfiguredAuth: () => true, checkAuth: async () => true, getAuth: async () => ({ token: "synthetic" }),
    isUsingOAuth: () => false, getAvailable: async () => [model], getAvailableSnapshot: () => [model],
    streamSimple: async (_model: unknown, context: { messages: Array<{ role?: string }> }) => {
      const report: Report = {
        system: context.messages.filter((m) => m.role === "system").map((m) => JSON.stringify(m)).join("\n"),
        user: context.messages.filter((m) => m.role === "user").map((m) => JSON.stringify(m)).join("\n"),
        tools: declaredTools(context.messages),
      };
      const final = { role: "assistant", content: [{ type: "text", text: JSON.stringify(report) }], api: "scripted", provider: "scripted", model: "scripted", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 1 }, stopReason: "stop", timestamp: Date.now() };
      let sent = false;
      return { [Symbol.asyncIterator]: () => ({ next: async () => sent ? { done: true, value: undefined } : (sent = true, { done: false, value: { type: "start", partial: final } }) }), result: async () => final };
    },
  } as unknown as ModelRuntime;
}

async function harness(withExtensions = false) {
  const root = await temporaryRoot("pi-sdk-skills-");
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const packageDir = join(agentDir, "npm/node_modules/pi-skill-fixture");
  await mkdir(cwd);
  await mkdir(join(agentDir, "npm/node_modules"), { recursive: true });
  await cp(join(FIXTURES, "package"), packageDir, { recursive: true });
  const diagnostics: SdkPiAdapterDiagnostic[] = [];
  const sessions: AgentSession[] = [];
  const runtimes: ModelRuntime[] = [];
  const adapter = new SdkPiSessionAdapter({
    modelRuntimeFactory: async () => {
      const runtime = withExtensions ? await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false, modelsPath: null, authPath: join(agentDir, "auth.json"), modelsStorePath: join(agentDir, "models-store.json") }) : scriptedRuntime();
      runtimes.push(runtime);
      return runtime;
    },
    resolveExtension: (spec) => resolvePiExtension(spec, { agentDir }),
    createSession: async (options) => { const result = await createAgentSession(options); sessions.push(result.session); return result; },
    extensionSdk: {
      createServices: createAgentSessionServices,
      createSessionFromServices: async (options) => { const result = await createAgentSessionFromServices(options); sessions.push(result.session); return result; },
      createRuntime: createAgentSessionRuntime,
    },
    diagnosticSink: (diagnostic) => { diagnostics.push(diagnostic); },
  });
  const registry = new SessionRegistry(adapter, new Map([["repo", cwd]]));
  const profile = (skills: readonly SkillSelection[] = [], alias = "fixture", permissionProfile: ResolvedExecutionProfile["permissionProfile"] = "read-only"): ResolvedExecutionProfile => ({
    alias, permissionProfile, provider: withExtensions ? "fixture-skills" : "scripted", model: withExtensions ? "fixture-skills" : "scripted", thinkingLevel: "off", skills,
    ...(withExtensions ? { extensions: [parseExtensionSpec("npm:pi-skill-fixture@1.0.0")!] } : {}),
  });
  const report = async (sessionId: string, prompt = "inspect catalog"): Promise<Report> => {
    const accepted = await registry.prompt(sessionId, prompt);
    const deadline = Date.now() + 10_000;
    let turn = registry.getTurn(sessionId, accepted.turn.turnId);
    while (turn.state === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      turn = registry.getTurn(sessionId, accepted.turn.turnId);
    }
    expect(turn.state).toBe("completed");
    return JSON.parse(turn.assistantText!) as Report;
  };
  const resourcesAreSelected = (skills: readonly SkillSelection[]): void => {
    const loader = sessions.at(-1)!.resourceLoader;
    expect(loader.getSkills().skills.map((s) => s.filePath)).toEqual(skills.map((s) => s.path));
    expect(loader.getPrompts().prompts).toEqual([]);
    expect(loader.getThemes().themes).toEqual([]);
  };
  return { adapter, cwd, root, registry, profile, report, diagnostics, packageDir, sessions, runtimes, resourcesAreSelected };
}

function catalog(report: Report): string {
  return report.system.match(/<available_skills>[\s\S]*?<\/available_skills>/)?.[0] ?? "";
}

describe("Pi SDK selected skill contract", () => {
  // Guards the negative tests below against passing vacuously: the fixture package must really
  // reach the SDK's skill and prompt catalogs through the path that the override closes.
  it("control: without overrides, Pi SDK loads package skills and prompts despite noSkills", async () => {
    const h = await harness(true);
    const loader = new DefaultResourceLoader({
      cwd: h.cwd, agentDir: h.cwd, settingsManager: SettingsManager.inMemory(undefined, { projectTrusted: false }),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, additionalExtensionPaths: [h.packageDir],
    });
    await loader.reload();
    expect(loader.getSkills().skills.map((skill) => skill.name).sort()).toEqual(["fixture-alpha", "fixture-bundled"]);
    expect(loader.getPrompts().prompts.length).toBeGreaterThan(0);
    loader.extendResources({ skillPaths: [{ path: join(h.packageDir, "late/fixture-late/SKILL.md"), metadata: { source: "fixture", scope: "temporary", origin: "top-level" } }] });
    expect(loader.getSkills().skills.map((skill) => skill.name)).toContain("fixture-late");
  });

  it("loads plain skill folders without an extension package (1)", async () => {
    const h = await harness();
    const session = await h.registry.start("repo", h.profile([selected("fixture-alpha")]));
    try {
      expect(catalog(await h.report(session.id))).toContain("SELECTED_ALPHA_DESCRIPTION_SENTINEL");
      expect(h.sessions[0]!.resourceLoader.getSkills().skills.map((s) => s.filePath)).toEqual([selected("fixture-alpha").path]);
    } finally { await h.registry.close(session.id); }
  });

  it("keeps concurrent profiles isolated and ordered, including an empty selection (2)", async () => {
    const h = await harness();
    const [a, b, empty] = await Promise.all([
      h.registry.start("repo", h.profile([selected("fixture-beta", "beta"), selected("fixture-alpha", "alpha")], "a")),
      h.registry.start("repo", h.profile([selected("fixture-alpha")], "b")),
      h.registry.start("repo", h.profile([], "empty")),
    ]);
    try {
      const [ar, br, er] = await Promise.all([h.report(a.id), h.report(b.id), h.report(empty.id)]);
      expect(catalog(ar).indexOf("fixture-beta")).toBeLessThan(catalog(ar).indexOf("fixture-alpha"));
      expect(catalog(br)).toContain("fixture-alpha");
      expect(catalog(br)).not.toContain("fixture-beta");
      expect(catalog(er)).toBe("");
      expect(h.runtimes).toHaveLength(1);
    } finally { await Promise.all([a, b, empty].map((s) => h.registry.close(s.id))); }
  });

  it("package skills and resources_discover cannot widen an empty selection (3,8)", async () => {
    const h = await harness(true);
    const session = await h.registry.start("repo", h.profile());
    try {
      const result = await h.report(session.id);
      expect(catalog(result)).toBe("");
      expect(result.system).not.toContain("PROMPT_BODY_SECRET_SENTINEL");
      expect(events()).toContain("resources_discover");
      h.resourcesAreSelected([]);
    } finally { await h.registry.close(session.id); }
  });

  it("selects a package skill through its explicit installed catalog path (4)", async () => {
    const h = await harness(true);
    const session = await h.registry.start("repo", h.profile([{ alias: "bundled", path: join(h.packageDir, "skills/fixture-bundled/SKILL.md") }]));
    try {
      const actual = catalog(await h.report(session.id));
      expect(actual).toContain("fixture-bundled");
      expect(actual).toContain("BUNDLED_DESCRIPTION_SENTINEL");
      expect(actual).not.toContain("fixture-alpha");
      expect(actual).not.toContain("fixture-late");
      h.resourcesAreSelected([{ alias: "bundled", path: join(h.packageDir, "skills/fixture-bundled/SKILL.md") }]);
    } finally { await h.registry.close(session.id); }
  });

  it("unselected same-name package skill cannot displace the selected file (5,8)", async () => {
    const h = await harness(true);
    const session = await h.registry.start("repo", h.profile([selected("fixture-alpha")]));
    try {
      const actual = catalog(await h.report(session.id));
      expect(actual).toContain("SELECTED_ALPHA_DESCRIPTION_SENTINEL");
      expect(actual).toContain(selected("fixture-alpha").path);
      expect(actual).not.toContain("BUNDLED_ALPHA_DESCRIPTION_SENTINEL");
      expect(actual).not.toContain("fixture-bundled");
      expect(actual).not.toContain("fixture-late");
      h.resourcesAreSelected([selected("fixture-alpha")]);
    } finally { await h.registry.close(session.id); }
  });

  for (const withExtensions of [false, true]) {
    it(`rejects all invalid selections without a session or sensitive diagnostics, extensions=${withExtensions} (6,11)`, async () => {
      const h = await harness(withExtensions);
      const linked = join(h.root, "SKILL.md");
      await symlink(selected("fixture-alpha").path, linked);
      const cases = [
        [selected("missing")], [selected("fixture-invalid")], [selected("fixture-explicit")],
        [selected("fixture-alpha", "one"), selected("collision/fixture-alpha", "two")],
        [selected("fixture-alpha", "one"), { alias: "two", path: linked }],
      ];
      for (const skills of cases) {
        await expect(h.registry.start("repo", h.profile(skills))).rejects.toMatchObject({ code: "skill_load_failed", message: "Configured Pi skill could not be loaded" });
        expect(h.registry.list()).toEqual([]);
      }
      expect(h.sessions).toEqual([]);
      expect(events()).not.toContain("session_start");
      expect(h.diagnostics).toHaveLength(cases.length);
      expect(h.diagnostics.every((d) => d.stage === "skill_load" && d.code === "skill_load_failed")).toBe(true);
      expect(h.diagnostics[0]?.skill).toBe("catalog-alias");
      const publicText = JSON.stringify(h.diagnostics);
      for (const forbidden of [FIXTURES, h.root, "fixture-alpha", "DESCRIPTION_SENTINEL", "SKILL_BODY_SECRET_SENTINEL"]) expect(publicText).not.toContain(forbidden);
    });
  }

  it("forwards /skill text literally and never dispatches a command (9)", async () => {
    const h = await harness(true);
    const session = await h.registry.start("repo", h.profile([selected("fixture-alpha")]));
    try {
      const result = await h.report(session.id, "/skill:fixture-alpha");
      expect(result.user).toContain("/skill:fixture-alpha");
      expect(result.user).not.toContain("SKILL_BODY_SECRET_SENTINEL");
      expect(events()).not.toContain("command");
      expect(events()).toContain("input:rpc");
    } finally { await h.registry.close(session.id); }
  });

  it("retains tool allowlists, separate extension runtimes and shutdown cleanup (10)", async () => {
    const h = await harness(true);
    const [a, b] = await Promise.all([
      h.registry.start("repo", h.profile([selected("fixture-alpha")], "read")),
      h.registry.start("repo", h.profile([selected("fixture-beta")], "code", "coding")),
    ]);
    try {
      const [ar, br] = await Promise.all([h.report(a.id), h.report(b.id)]);
      expect(ar.tools).toEqual(["find", "grep", "ls", "read"]);
      expect(br.tools).toEqual(["bash", "edit", "find", "grep", "ls", "read", "skill_fixture_tool", "write"]);
      expect(catalog(ar)).not.toContain("fixture-beta");
      expect(catalog(br)).not.toContain("fixture-alpha");
      expect(h.runtimes).toHaveLength(2);
      expect(h.runtimes[0]).not.toBe(h.runtimes[1]);
    } finally { await Promise.all([h.registry.close(a.id), h.registry.close(b.id)]); }
    expect(events().filter((e) => e === "session_shutdown")).toHaveLength(2);
    expect(h.registry.list().every((s) => s.state === "closed")).toBe(true);
  });
});

// Controlled public SDK facades let each lifecycle check fail independently; the catalog
// still uses real files and loadSkills, and MCP cleanup uses the production bridge.
describe("resource lifecycle rejection and cleanup (10,11)", () => {
  for (const stage of ["postcheck", "extension_load", "extension_bind"] as const) {
    for (const mismatch of ["missing", "extra", "name", "filePath", "prompts", "themes"] as const) {
      it(`rejects ${mismatch} at ${stage} with classified diagnostics and cleanup`, async () => {
        const cwd = await temporaryRoot("pi-skill-postcheck-");
        const selection = [selected("fixture-alpha")];
        const validated = await loadSelectedSkills(selection, cwd);
        let corrupted = stage !== "extension_bind";
        const loader = {
          getSkills: () => ({
            skills: !corrupted ? validated : mismatch === "missing" ? [] : mismatch === "extra" ? [...validated, ...validated] :
              mismatch === "name" ? validated.map((s) => ({ ...s, name: "PRIVATE_NAME_SENTINEL" })) :
              mismatch === "filePath" ? validated.map((s) => ({ ...s, filePath: "/private/FILE_PATH_SENTINEL" })) : validated,
            diagnostics: [],
          }),
          getPrompts: () => ({ prompts: corrupted && mismatch === "prompts" ? [{}] : [], diagnostics: [] }),
          getThemes: () => ({ themes: corrupted && mismatch === "themes" ? [{}] : [], diagnostics: [] }),
          getExtensions: () => ({ extensions: [], errors: [] }),
        } as unknown as ResourceLoader;
        const sessionDispose = vi.fn();
        const runtimeDispose = vi.fn(async () => undefined);
        const closeMcp = vi.fn(async () => undefined);
        const connection: McpConnection = {
          connect: async () => undefined,
          listTools: async () => ({ tools: [{ name: "probe", inputSchema: { type: "object" } }] }),
          callTool: async () => ({ content: [] }), close: closeMcp,
        };
        const runtime = scriptedRuntime();
        const session = {
          model: runtime.getModel("scripted", "scripted"), thinkingLevel: "off", resourceLoader: loader,
          getActiveToolNames: () => ["read", "grep", "find", "ls", "mcp_knowledge_probe"],
          bindExtensions: async () => { corrupted = true; }, dispose: sessionDispose,
        } as unknown as AgentSession;
        const services = { resourceLoader: loader, modelRuntime: runtime, diagnostics: [] } as unknown as AgentSessionServices;
        const sessionRuntime = { session, dispose: runtimeDispose } as unknown as AgentSessionRuntime;
        const extensionSdk = {
          createServices: async () => services,
          createSessionFromServices: async () => ({ session }),
          createRuntime: async () => sessionRuntime,
        } as unknown as ExtensionSdk;
        const diagnostics: SdkPiAdapterDiagnostic[] = [];
        const adapter = new SdkPiSessionAdapter({
          modelRuntimeFactory: async () => runtime,
          createSession: async () => ({ session }) as Awaited<ReturnType<typeof createAgentSession>>,
          extensionSdk, resolveExtension: async () => "/private/extension",
          mcpConnectionFactory: () => connection,
          diagnosticSink: (d) => { diagnostics.push(d); },
        });
        const profile: ResolvedExecutionProfile = {
          alias: "catalog-profile", provider: "scripted", model: "scripted", permissionProfile: "read-only", thinkingLevel: "off", skills: selection,
          mcpServers: { knowledge: { command: process.execPath, tools: { probe: { name: "probe", readOnly: true } } } },
          ...(stage === "postcheck" ? {} : { extensions: [parseExtensionSpec("npm:pi-skill-fixture@1.0.0")!] }),
        };
        const code = mismatch === "prompts" || mismatch === "themes" ? "pi_session_creation_failed" : "skill_load_failed";
        await expect(adapter.create({ cwd, executionProfile: profile })).rejects.toMatchObject({
          code, message: code === "skill_load_failed" ? "Configured Pi skill could not be loaded" : "Pi session creation failed",
        });
        expect(diagnostics).toEqual([expect.objectContaining({ stage, code })]);
        for (const secret of ["/private", FIXTURES, "SENTINEL", "fixture-alpha"]) expect(JSON.stringify(diagnostics)).not.toContain(secret);
        expect(closeMcp).toHaveBeenCalledTimes(stage === "extension_load" ? 0 : 1);
        expect(sessionDispose).toHaveBeenCalledTimes(stage === "postcheck" ? 1 : 0);
        expect(runtimeDispose).toHaveBeenCalledTimes(stage === "extension_bind" ? 1 : 0);
      });
    }
  }
});

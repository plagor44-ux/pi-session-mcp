import { describe, expect, it } from "vitest";
import { createClaudeCodeAdapter } from "../src/client-adapters/claude-code.js";
import { createCodexAdapter } from "../src/client-adapters/codex.js";
import { verifyMcpCapabilities, type McpStdioProcess, type McpVerifierResult } from "../src/client-adapters/mcp-verifier.js";
import { versionFromOutput } from "../src/client-adapters/command.js";
import { projectCapabilities } from "../src/capabilities.js";
import type { WorkspaceModeEntry } from "../src/execution-modes.js";
import { ImmutableMap, type ConfiguredExecutionProfile } from "../src/execution-profile.js";
import { MAX_PROFILE_EXTENSIONS, parseExtensionSpec, type ExtensionSpec } from "../src/extension-spec.js";
import { MAX_PROFILE_SKILLS } from "../src/skill-catalog.js";
import { PACKAGE_VERSION } from "../src/package-metadata.js";
import type { CommandRunner } from "../src/client-adapters/index.js";

const intent = { scope: "user" as const, nodePath: "/usr/bin/node", entryPath: "/srv/pi-session-mcp/dist/main.js", configPath: "/etc/pi-session-mcp.json" };
const TOOL_NAMES = ["pi_capabilities_get", "pi_session_start", "pi_session_list", "pi_session_get", "pi_session_prompt", "pi_session_abort", "pi_session_close", "pi_turn_get"] as const;
const VERIFIED_CONFIGURATION = { fingerprint: `sha256:${"0".repeat(64)}`, reloadPolicy: "restart-required" };
const VERIFIED_PROFILE = { alias: "safe", default: true, permissionProfile: "read-only", provider: "fake-provider", model: "fake-model", thinkingLevel: "off", extensions: [], grantedExtensionTools: [], shell: "none", skills: [] };
const VERIFIED_CAPABILITIES: Record<string, unknown> = {
  ok: true,
  server: { name: "pi-session-mcp", version: PACKAGE_VERSION },
  configuration: VERIFIED_CONFIGURATION,
  events: { delivery: "off" },
  workspaces: [],
  executionProfiles: [VERIFIED_PROFILE],
};

/** Drives the bounded handshake with a scripted capabilities payload. */
async function verifyCapabilityPayload(capabilities: Record<string, unknown>): Promise<McpVerifierResult> {
  const responses = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "pi-session-mcp", version: PACKAGE_VERSION }, protocolVersion: "2025-03-26" } }),
    JSON.stringify({ jsonrpc: "2.0", id: 3, result: { tools: TOOL_NAMES.map((name) => ({ name })) } }),
    JSON.stringify({ jsonrpc: "2.0", id: 4, result: { structuredContent: capabilities } }),
  ];
  const process: McpStdioProcess = { write() {}, async read() { return responses.shift() ?? null; }, kill() {} };
  return verifyMcpCapabilities({ launch: async () => process, timeoutMs: 100 });
}

function withoutConfiguration(capabilities: Record<string, unknown>): Record<string, unknown> {
  const { configuration: _configuration, ...rest } = capabilities;
  return rest;
}

function capabilitiesWith(configuration: unknown): Record<string, unknown> {
  return { ...VERIFIED_CAPABILITIES, configuration };
}

function capabilitiesWithWorkspace(workspace: Record<string, unknown>): Record<string, unknown> {
  return { ...VERIFIED_CAPABILITIES, workspaces: [workspace] };
}

function capabilitiesWithProfile(profile: Record<string, unknown>): Record<string, unknown> {
  return { ...VERIFIED_CAPABILITIES, executionProfiles: [profile] };
}

function extensionSpecs(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `npm:ext-${index}@1.0.0`);
}

function skillAliases(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `skill-${index}`);
}

function extension(spec: string): ExtensionSpec {
  const parsed = parseExtensionSpec(spec);
  if (!parsed) throw new Error(`invalid test extension spec ${spec}`);
  return parsed;
}

describe("client adapters", () => {
  it.each([
    ["codex", "codex-cli 0.150.1\n", "0.150.1"],
    ["claude-code", "2.1.252 (Claude Code)\r\n", "2.1.252"],
    ["claude-code", "claude-code v2.1.251", "2.1.251"],
  ] as const)("parses the complete documented %s version line %j", (client, output, expected) => {
    expect(versionFromOutput(client, output)).toBe(expected);
  });

  it.each([
    ["codex", "codex 0.150.1 diagnostics"],
    ["codex", "codex 0.150.1\nextra"],
    ["codex", "0.150.1"],
    ["codex", "codex 0.150.1 (Claude Code)"],
    ["claude-code", "2.1.251\nextra"],
    ["claude-code", "2.1.251 unexpected"],
  ] as const)("rejects incomplete or wrong-client %s output %j", (client, output) => {
    expect(versionFromOutput(client, output)).toBeUndefined();
  });

  it("discovers a Codex client of any version when the mcp subcommands exist", async () => {
    const runner: CommandRunner = { async run(_command, args) { return args[0] === "--version" ? { exitCode: 0, stdout: "codex-cli 9.9.9\n", stderr: "" } : { exitCode: 0, stdout: "mcp get\nmcp add\nmcp remove", stderr: "" }; } };
    expect(await createCodexAdapter({ runner }).discover()).toEqual({ client: "codex", version: "9.9.9", supportsJson: true, supportsAdd: true, supportsRemove: true, scopes: ["user"] });
  });

  it("discovers a Claude Code client of any version when the mcp subcommands exist", async () => {
    const runner: CommandRunner = { async run(_command, args) { return args[0] === "--version" ? { exitCode: 0, stdout: "9.9.9 (Claude Code)\n", stderr: "" } : { exitCode: 0, stdout: "mcp get\nmcp add\nmcp remove", stderr: "" }; } };
    expect(await createClaudeCodeAdapter({ runner }).discover()).toEqual({ client: "claude-code", version: "9.9.9", supportsJson: false, supportsAdd: true, supportsRemove: true, scopes: ["user", "project", "local"] });
  });

  it.each([["codex", createCodexAdapter], ["claude-code", createClaudeCodeAdapter]] as const)("fails closed for %s when a required mcp subcommand is missing", async (_client, create) => {
    const runner: CommandRunner = { async run(_command, args) { return args[0] === "--version" ? { exitCode: 0, stdout: "9.9.9\n", stderr: "" } : { exitCode: 0, stdout: "mcp get\nmcp add", stderr: "" }; } };
    const capabilities = await create({ runner }).discover();
    expect(capabilities).toMatchObject({ supportsAdd: false, supportsRemove: false, scopes: [] });
  });

  it("inspects a Claude Code registration without asking for the client version", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(_command, args) { calls.push([...args]); return { exitCode: 1, stdout: "", stderr: 'No MCP server named "pi-session-mcp".' }; } };
    expect((await createClaudeCodeAdapter({ runner }).inspect("user", intent)).state).toBe("absent");
    expect(calls).toEqual([["mcp", "get", "pi-session-mcp"]]);
  });

  it("plans Codex add and recognizes an equivalent structured registration", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(_command, args) { calls.push([...args]); if (args[1] === "get") return { exitCode: 0, stdout: JSON.stringify({ name: "pi-session-mcp", enabled: true, transport: { type: "stdio", command: intent.nodePath, args: [intent.entryPath], env: { PI_SESSION_MCP_CONFIG: intent.configPath }, env_vars: [], cwd: null } }), stderr: "" }; return { exitCode: 0, stdout: "codex 0.150.1\n", stderr: "" }; } };
    const adapter = createCodexAdapter({ runner });
    await expect(adapter.plan(intent)).resolves.toMatchObject({ state: "equivalent", operation: "none" });
    expect(calls.some((args) => args.includes("--json"))).toBe(true);
  });

  it("fails closed for malformed Claude output and never returns command details", async () => {
    const runner: CommandRunner = { async run(_command, args) { return args[0] === "--version" ? { exitCode: 0, stdout: "2.1.251\n", stderr: "" } : { exitCode: 0, stdout: "pi-session-mcp: malformed unexpected output", stderr: "/secret/raw/path" }; } };
    const registration = await createClaudeCodeAdapter({ runner }).inspect("user", intent);
    expect(registration.state).toBe("unsupported");
    expect(JSON.stringify(registration)).not.toContain("/secret");
    expect(registration).not.toHaveProperty("stderr");
  });

  it("verifies only the bounded capability sequence and always kills the process", async () => {
    const methods: string[] = []; let killed = false;
    const responses = [JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "pi-session-mcp", version: PACKAGE_VERSION }, protocolVersion: "2025-03-26" } }), JSON.stringify({ jsonrpc: "2.0", id: 3, result: { tools: TOOL_NAMES.map((name) => ({ name })) } }), JSON.stringify({ jsonrpc: "2.0", id: 4, result: { structuredContent: VERIFIED_CAPABILITIES } })];
    const process: McpStdioProcess = { write(frame) { const body = JSON.parse(frame.trim()); if (typeof body.method === "string") methods.push(body.method); }, async read() { return responses.shift() ?? null; }, kill() { killed = true; } };
    await expect(verifyMcpCapabilities({ launch: async () => process })).resolves.toMatchObject({ status: "verified", capabilitiesGet: true });
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    expect(killed).toBe(true);
    expect(methods).not.toContain("pi_session_start");
  });

  it.each(["unset", "host", "read-only"])("accepts workspace mode %s", async (mode) => {
    const capabilities = { ...VERIFIED_CAPABILITIES, workspaces: [{ alias: "repo", mode }] };
    expect(await verifyCapabilityPayload(capabilities)).toMatchObject({ status: "verified", capabilitiesGet: true });
  });

  it.each([
    [1, "main"],
    [16, "feature/container-verify"],
    [2, null],
  ])("accepts a container workspace with writers %s and defaultBase %s", async (writers, defaultBase) => {
    const capabilities = capabilitiesWithWorkspace({ alias: "repo", mode: "container", writers, defaultBase });
    expect(await verifyCapabilityPayload(capabilities)).toMatchObject({ status: "verified", capabilitiesGet: true });
  });

  it.each([
    ["missing writers", { defaultBase: "main" }],
    ["missing defaultBase", { writers: 1 }],
    ["zero writers", { writers: 0, defaultBase: "main" }],
    ["too many writers", { writers: 17, defaultBase: "main" }],
    ["fractional writers", { writers: 1.5, defaultBase: "main" }],
    ["non-number writers", { writers: "1", defaultBase: "main" }],
    ["invalid defaultBase", { writers: 1, defaultBase: "refs/heads/main" }],
    ["non-string defaultBase", { writers: 1, defaultBase: 1 }],
    ["unknown key", { writers: 1, defaultBase: "main", extra: true }],
  ])("rejects a container workspace with %s", async (_label, fields) => {
    const capabilities = capabilitiesWithWorkspace({ alias: "repo", mode: "container", ...fields });
    expect(await verifyCapabilityPayload(capabilities)).toMatchObject({ status: "failed", capabilitiesGet: false });
  });

  it("accepts a snapshot workspace with exactly alias and mode (#235)", async () => {
    const capabilities = capabilitiesWithWorkspace({ alias: "repo", mode: "snapshot" });
    expect(await verifyCapabilityPayload(capabilities)).toMatchObject({ status: "verified", capabilitiesGet: true });
  });

  it.each([
    ["writers", { writers: 1 }],
    ["defaultBase", { defaultBase: null }],
    ["an unknown key", { extra: true }],
  ])("rejects a snapshot workspace with %s (#235)", async (_label, fields) => {
    const capabilities = capabilitiesWithWorkspace({ alias: "repo", mode: "snapshot", ...fields });
    expect(await verifyCapabilityPayload(capabilities)).toMatchObject({ status: "failed", capabilitiesGet: false });
  });

  it("rejects an unknown workspace mode (#235)", async () => {
    const capabilities = capabilitiesWithWorkspace({ alias: "repo", mode: "mirror" });
    expect(await verifyCapabilityPayload(capabilities)).toMatchObject({ status: "failed", capabilitiesGet: false });
  });

  it.each(["unset", "host", "read-only"])("rejects container fields on a %s workspace", async (mode) => {
    for (const fields of [{ writers: 1 }, { defaultBase: null }]) {
      const capabilities = capabilitiesWithWorkspace({ alias: "repo", mode, ...fields });
      expect(await verifyCapabilityPayload(capabilities)).toMatchObject({ status: "failed", capabilitiesGet: false });
    }
  });

  const malformedCapabilities: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["missing workspace mode", { ...VERIFIED_CAPABILITIES, workspaces: [{ alias: "repo" }] }],
    ["unknown workspace mode", { ...VERIFIED_CAPABILITIES, workspaces: [{ alias: "repo", mode: "unknown" }] }],
    ["unknown workspace key", { ...VERIFIED_CAPABILITIES, workspaces: [{ alias: "repo", mode: "host", extra: true }] }],
    ["missing configuration", withoutConfiguration(VERIFIED_CAPABILITIES)],
    ["unknown capabilities key", { ...VERIFIED_CAPABILITIES, extra: true }],
    ["missing events", (({ events: _events, ...rest }) => rest)(VERIFIED_CAPABILITIES)],
    ["unknown events delivery", { ...VERIFIED_CAPABILITIES, events: { delivery: "socket" } }],
    ["unknown events key", { ...VERIFIED_CAPABILITIES, events: { delivery: "off", path: "/run/x" } }],
    ["non-object events", { ...VERIFIED_CAPABILITIES, events: "off" }],
    ["unknown configuration key", capabilitiesWith({ ...VERIFIED_CONFIGURATION, stale: false })],
    ["uppercase fingerprint", capabilitiesWith({ ...VERIFIED_CONFIGURATION, fingerprint: `sha256:${"A".repeat(64)}` })],
    ["short fingerprint", capabilitiesWith({ ...VERIFIED_CONFIGURATION, fingerprint: `sha256:${"a".repeat(63)}` })],
    ["unsupported fingerprint algorithm", capabilitiesWith({ ...VERIFIED_CONFIGURATION, fingerprint: `sha512:${"a".repeat(128)}` })],
    ["other reload policy", capabilitiesWith({ ...VERIFIED_CONFIGURATION, reloadPolicy: "live-reload" })],
    ["profile without extensions", capabilitiesWithProfile({ ...VERIFIED_PROFILE, extensions: undefined })],
    ["non-array extensions", capabilitiesWithProfile({ ...VERIFIED_PROFILE, extensions: "npm:pi-cursor-sdk@0.5.3" })],
    ["non-string extension", capabilitiesWithProfile({ ...VERIFIED_PROFILE, extensions: [1] })],
    ["unpinned extension", capabilitiesWithProfile({ ...VERIFIED_PROFILE, extensions: ["npm:pi-cursor-sdk@latest"] })],
    ["too many extensions", capabilitiesWithProfile({ ...VERIFIED_PROFILE, extensions: extensionSpecs(MAX_PROFILE_EXTENSIONS + 1) })],
    ["profile without shell", capabilitiesWithProfile({ ...VERIFIED_PROFILE, shell: undefined })],
    ["unknown shell value", capabilitiesWithProfile({ ...VERIFIED_PROFILE, shell: "bash" })],
    ["non-string shell", capabilitiesWithProfile({ ...VERIFIED_PROFILE, shell: true })],
    ["profile without skills", capabilitiesWithProfile({ ...VERIFIED_PROFILE, skills: undefined })],
    ["unknown profile key", capabilitiesWithProfile({ ...VERIFIED_PROFILE, path: "/srv/SKILL.md" })],
    ["non-array skills", capabilitiesWithProfile({ ...VERIFIED_PROFILE, skills: "review" })],
    ["non-string skill", capabilitiesWithProfile({ ...VERIFIED_PROFILE, skills: [1] })],
    ["non-alias skill", capabilitiesWithProfile({ ...VERIFIED_PROFILE, skills: ["/srv/review/SKILL.md"] })],
    ["uppercase skill alias", capabilitiesWithProfile({ ...VERIFIED_PROFILE, skills: ["Review"] })],
    ["duplicate skill", capabilitiesWithProfile({ ...VERIFIED_PROFILE, skills: ["review", "review"] })],
    ["too many skills", capabilitiesWithProfile({ ...VERIFIED_PROFILE, skills: skillAliases(MAX_PROFILE_SKILLS + 1) })],
  ];
  it.each(malformedCapabilities)("rejects %s in the capabilities payload", async (_label, capabilities) => {
    expect((await verifyCapabilityPayload(capabilities)).status).toBe("failed");
  });

  it("accepts a sandboxed shell in the capabilities payload", async () => {
    expect((await verifyCapabilityPayload(capabilitiesWithProfile({ ...VERIFIED_PROFILE, shell: "sandboxed" }))).status).toBe("verified");
  });

  it("accepts the maximum number of profile extensions", async () => {
    const capabilities = capabilitiesWithProfile({ ...VERIFIED_PROFILE, extensions: extensionSpecs(MAX_PROFILE_EXTENSIONS) });
    expect((await verifyCapabilityPayload(capabilities)).status).toBe("verified");
  });

  it("accepts the maximum number of granted extension tools", async () => {
    const capabilities = capabilitiesWithProfile({ ...VERIFIED_PROFILE, grantedExtensionTools: Array.from({ length: 32 }, (_, index) => `tool_${index}`) });
    expect((await verifyCapabilityPayload(capabilities)).status).toBe("verified");
  });

  it("accepts spool event delivery", async () => {
    expect((await verifyCapabilityPayload({ ...VERIFIED_CAPABILITIES, events: { delivery: "spool" } })).status).toBe("verified");
  });

  it("accepts the maximum number of profile skills", async () => {
    const capabilities = capabilitiesWithProfile({ ...VERIFIED_PROFILE, skills: skillAliases(MAX_PROFILE_SKILLS) });
    expect((await verifyCapabilityPayload(capabilities)).status).toBe("verified");
  });

  it("verifies the server's own capability projection, including container workspaces, profile extensions and skills", async () => {
    const profiles: ConfiguredExecutionProfile[] = [
      { alias: "safe", default: true, permissionProfile: "read-only", provider: "fake-provider", model: "fake-model", thinkingLevel: "off" },
      { alias: "code-ext", default: false, permissionProfile: "coding", provider: "fake-ext", model: "fake-ext-model", thinkingLevel: "high", extensions: [extension("npm:pi-cursor-sdk@0.5.3"), extension("npm:@scope/other-ext@1.2.3-beta.1")], skills: [{ alias: "review", path: "/srv/review/SKILL.md" }, { alias: "docs", path: "/srv/docs/SKILL.md" }] },
    ];
    const capabilities = projectCapabilities(
      new ImmutableMap([["repo", "/srv/repo"]]),
      new ImmutableMap(profiles.map((profile) => [profile.alias, profile] as const)),
      { fingerprint: `sha256:${"0".repeat(64)}`, reloadPolicy: "restart-required" },
      new ImmutableMap<string, WorkspaceModeEntry>([["repo", {
        mode: "container",
        container: { writers: 2, base: "main", lifecycle: "persistent", profiles: ["code-ext"], image: "node", network: "none", cache: "none", tags: "none", clean: "untracked" },
      }]]),
    );
    expect(capabilities.workspaces).toEqual([{ alias: "repo", mode: "container", writers: 2, defaultBase: "main" }]);
    expect((await verifyCapabilityPayload(capabilities)).status).toBe("verified");
  });

  it("rejects Codex project scope", async () => { const a = createCodexAdapter({ runner: { async run() { return { exitCode: 0, stdout: "codex 0.150.1", stderr: "" }; } } }); expect((await a.inspect("project", intent)).state).toBe("unsupported"); });
  it("classifies unknown Codex registration as absent only for exact message", async () => { const a = createCodexAdapter({ runner: { async run(_c, args) { return args[0] === "--version" ? { exitCode: 0, stdout: "codex 0.150.1", stderr: "" } : { exitCode: 1, stdout: "", stderr: "Error: No MCP server named 'pi-session-mcp' found." }; } } }); expect((await a.inspect("user", intent)).state).toBe("absent"); });
  it("fails closed for non-absent Codex errors", async () => { const a = createCodexAdapter({ runner: { async run(_c, args) { return args[0] === "--version" ? { exitCode: 0, stdout: "codex 0.150.1", stderr: "" } : { exitCode: 1, stdout: "", stderr: "permission denied" }; } } }); expect((await a.inspect("user", intent)).state).toBe("unsupported"); });
  it("treats additional Codex environment as divergent", async () => { const registration = { name: "pi-session-mcp", enabled: true, transport: { type: "stdio", command: intent.nodePath, args: [intent.entryPath], env: { PI_SESSION_MCP_CONFIG: intent.configPath, EXTRA: "unexpected" }, env_vars: [], cwd: null } }; const a = createCodexAdapter({ runner: { async run(_c, args) { return args[0] === "--version" ? { exitCode: 0, stdout: "codex 0.150.1", stderr: "" } : { exitCode: 0, stdout: JSON.stringify(registration), stderr: "" }; } } }); expect((await a.inspect("user", intent)).state).toBe("divergent"); });
  it("discovers Claude Code scopes from the mcp help output", async () => { const a = createClaudeCodeAdapter({ runner: { async run(_c, args) { return args[0] === "--version" ? { exitCode: 0, stdout: "2.1.202", stderr: "" } : { exitCode: 0, stdout: "mcp get\nmcp add\nmcp remove", stderr: "" }; } } }); expect((await a.discover()).scopes).toContain("user"); });
  it("discovers all three Claude Code scopes for the 2.1.252 version line", async () => { const a = createClaudeCodeAdapter({ runner: { async run(_c, args) { return args[0] === "--version" ? { exitCode: 0, stdout: "2.1.252 (Claude Code)\n", stderr: "" } : { exitCode: 0, stdout: "mcp get\nmcp add\nmcp remove", stderr: "" }; } } }); expect((await a.discover()).scopes).toEqual(["user", "project", "local"]); });
  it("classifies exact Claude absent message", async () => { const a = createClaudeCodeAdapter({ runner: { async run(_c, args) { return args[0] === "--version" ? { exitCode: 0, stdout: "2.1.251", stderr: "" } : { exitCode: 1, stdout: "", stderr: 'No MCP server named "pi-session-mcp".' }; } } }); expect((await a.inspect("user", intent)).state).toBe("absent"); });
  it("classifies the current Claude absent remediation as absent", async () => { const a = createClaudeCodeAdapter({ runner: { async run(_c, args) { return args[0] === "--version" ? { exitCode: 0, stdout: "2.1.202", stderr: "" } : { exitCode: 1, stdout: "", stderr: 'No MCP server named "pi-session-mcp". Run `claude mcp add` to add one.' }; } } }); expect((await a.inspect("project", { ...intent, scope: "project" })).state).toBe("absent"); });
  it("recognizes the documented Claude detail format and exact scope", async () => { const output = `pi-session-mcp:\n  Scope: User config\n  Status: Connected\n  Type: stdio\n  Command: ${intent.nodePath}\n  Args: ${intent.entryPath}\n  Environment:\n    PI_SESSION_MCP_CONFIG=${intent.configPath}\n`; const a = createClaudeCodeAdapter({ runner: { async run(_c, args) { return args[0] === "--version" ? { exitCode: 0, stdout: "2.1.251", stderr: "" } : { exitCode: 0, stdout: output, stderr: "" }; } } }); expect((await a.inspect("user", intent)).state).toBe("equivalent"); expect((await a.inspect("project", { ...intent, scope: "project" })).state).toBe("divergent"); });
  it("recognizes Claude's bounded absent message with configured-server suffix", async () => { const a = createClaudeCodeAdapter({ runner: { async run(_c, args) { return args[0] === "--version" ? { exitCode: 0, stdout: "2.1.202", stderr: "" } : { exitCode: 1, stdout: "", stderr: 'No MCP server named "pi-session-mcp". Configured servers: safe-one, safe-two' }; } } }); expect((await a.inspect("local", { ...intent, scope: "local" })).state).toBe("absent"); });
  const claudeAbsentState = async (stderr: string) => createClaudeCodeAdapter({ runner: { async run() { return { exitCode: 1, stdout: "", stderr }; } } }).inspect("local", { ...intent, scope: "local" }).then((r) => r.state);
  const didYouMean = (name: string) => `Did you mean ${name}? Run \`claude mcp list\` to see all.`;
  it("recognizes Claude Code 2.1.310's bounded 'Did you mean' absent message", async () => {
    expect(await claudeAbsentState('No MCP server named "pi-session-mcp". ' + didYouMean('"pi-session-mcp-w1"'))).toBe("absent");
    expect(await claudeAbsentState('No MCP server named "pi-session-mcp". ' + didYouMean('"pi_coding-Other_1"') + "\n")).toBe("absent");
    expect(await claudeAbsentState('No MCP server named "pi-session-mcp". ' + didYouMean('"plugin:engineering:notion"'))).toBe("absent");
    expect(await claudeAbsentState('No MCP server named "pi-session-mcp". ' + didYouMean('"claude.ai Google Drive"'))).toBe("absent");
  });
  it.each([
    ["an unquoted suggestion", 'No MCP server named "pi-session-mcp". ' + didYouMean("pi-session-mcp-w1")],
    ["a suggestion with an embedded quote", 'No MCP server named "pi-session-mcp". ' + didYouMean('"pi-session"-mcp"')],
    ["a suggestion with a newline", 'No MCP server named "pi-session-mcp". Did you mean "pi-session\nmcp"? Run `claude mcp list` to see all.'],
    ["an empty suggestion", 'No MCP server named "pi-session-mcp". ' + didYouMean('""')],
    ["an over-long suggestion", 'No MCP server named "pi-session-mcp". ' + didYouMean(`"${"a".repeat(257)}"`)],
    ["trailing text", 'No MCP server named "pi-session-mcp". ' + didYouMean('"pi-session-mcp-w1"') + " Extra."],
    ["a second line", 'No MCP server named "pi-session-mcp". ' + didYouMean('"pi-session-mcp-w1"') + "\nmore"],
    ["another hint", 'No MCP server named "pi-session-mcp". Did you mean "pi-session-mcp-w1"? Run `rm -rf` to see all.'],
    ["a missing hint sentence", 'No MCP server named "pi-session-mcp". Did you mean "pi-session-mcp-w1"?'],
  ])("keeps %s unsupported", async (_label, stderr) => { expect(await claudeAbsentState(stderr)).toBe("unsupported"); });
  it("does not accept Claude output without scope", async () => { const a = createClaudeCodeAdapter({ runner: { async run(_c, args) { return args[0] === "--version" ? { exitCode: 0, stdout: "2.1.251", stderr: "" } : { exitCode: 0, stdout: "pi-session-mcp:\nCommand: /usr/bin/node\nArgs: /srv/pi-session-mcp/dist/main.js\nPI_SESSION_MCP_CONFIG: /etc/pi-session-mcp.json", stderr: "" }; } } }); expect((await a.inspect("user", intent)).state).toBe("unsupported"); });
  it("rejects wrong MCP server identity", async () => { const p: McpStdioProcess = { write() {}, async read() { return JSON.stringify({ id: 1, result: { serverInfo: { name: "wrong", version: PACKAGE_VERSION }, protocolVersion: "2025-03-26" } }); }, kill() {} }; expect((await verifyMcpCapabilities({ launch: async () => p, timeoutMs: 50 })).status).toBe("unsupported"); });
  it("rejects wrong MCP capability payload", async () => { let n = 0; const p: McpStdioProcess = { write() {}, async read() { n++; if (n === 1) return JSON.stringify({ id: 1, result: { serverInfo: { name: "pi-session-mcp", version: PACKAGE_VERSION }, protocolVersion: "2025-03-26" } }); if (n === 2) return JSON.stringify({ id: 3, result: { tools: TOOL_NAMES.map((name) => ({ name })) } }); return JSON.stringify({ id: 4, result: { structuredContent: { ok: false } } }); }, kill() {} }; expect((await verifyMcpCapabilities({ launch: async () => p, timeoutMs: 100 })).status).toBe("failed"); });

  it.each([
    null,
    { name: "" },
    { name: "x".repeat(129) },
    { name: "pi_capabilities_get" },
    { description: "missing name" },
  ])("rejects malformed tools/list entries (%s)", async (badTool: unknown) => {
    let n = 0;
    const valid = TOOL_NAMES.map((name) => ({ name }));
    const tools = badTool && typeof badTool === "object" && "name" in badTool && (badTool as { name?: unknown }).name === "pi_capabilities_get"
      ? [...valid.slice(0, 7), badTool]
      : [badTool, ...valid];
    const p: McpStdioProcess = { write() {}, async read() { n++; if (n === 1) return JSON.stringify({ id: 1, result: { serverInfo: { name: "pi-session-mcp", version: PACKAGE_VERSION }, protocolVersion: "2025-03-26" } }); return JSON.stringify({ id: 3, result: { tools } }); }, kill() {} };
    expect((await verifyMcpCapabilities({ launch: async () => p, timeoutMs: 100 })).status).toBe("unsupported");
  });

  it("aborts a launch that exceeds the shared verification deadline", async () => {
    let aborted = false;
    const output = await verifyMcpCapabilities({ launch: async (signal) => { signal.addEventListener("abort", () => { aborted = true; }); return new Promise<McpStdioProcess>(() => undefined); }, timeoutMs: 20 });
    expect(output.status).toBe("timeout");
    expect(aborted).toBe(true);
  });

  it("times out a blocked read and still invokes cleanup", async () => {
    let killed = false;
    const process: McpStdioProcess = { write() {}, async read() { return new Promise<string | null>(() => undefined); }, kill() { killed = true; } };
    expect((await verifyMcpCapabilities({ launch: async () => process, timeoutMs: 20 })).status).toBe("timeout");
    expect(killed).toBe(true);
  });
});

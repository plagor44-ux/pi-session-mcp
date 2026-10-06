import { safeRunner, versionFromOutput } from "./command.js";
import type { ClientAdapter, ClientCapabilities, ClientRegistration, ClientScope, CommandRunner, RegistrationIntent, RegistrationPlan } from "./types.js";

const NAME = "pi-session-mcp" as const;
function scopeArgs(scope: ClientScope): string[] { return ["-s", scope]; }
function inspectText(text: string, intent: RegistrationIntent): { state: ClientRegistration["state"]; expected: boolean } {
  const bounded = text.slice(0, 32_768);
  if (!/(?:^|\n)\s*pi-session-mcp\s*:/i.test(bounded)) return { state: "absent", expected: false };
  const scope = /(?:^|\n)\s*scope\s*:\s*(user|project|local)\s+config\b.*$/im.exec(bounded)?.[1]?.toLowerCase();
  const type = /(?:^|\n)\s*type\s*:\s*(\S+)\s*$/im.exec(bounded)?.[1];
  const command = /(?:^|\n)\s*command\s*:\s*(\S+)\s*$/im.exec(bounded)?.[1];
  const args = /(?:^|\n)\s*args?\s*:\s*(.+)\s*$/im.exec(bounded)?.[1];
  const environmentBlock = /(?:^|\n)\s*environment\s*:\s*\n((?:\s{4,}[^\n]+\n?)+)/im.exec(bounded)?.[1];
  const environment = environmentBlock?.split("\n").map((line) => line.trim()).filter(Boolean) ?? [];
  const configLine = environment[0];
  const config = configLine?.startsWith("PI_SESSION_MCP_CONFIG=") ? configLine.slice("PI_SESSION_MCP_CONFIG=".length) : undefined;
  if (!scope || type !== "stdio" || !command || !args || environment.length !== 1 || !config) return { state: "unsupported", expected: false };
  const expected = scope === intent.scope && command === intent.nodePath && args.trim() === intent.entryPath && config === intent.configPath;
  return { state: expected ? "equivalent" : "divergent", expected };
}
export function createClaudeCodeAdapter(input: { readonly runner: CommandRunner }): ClientAdapter {
  const runner = safeRunner(input.runner.run);
  return {
    client: "claude-code",
    async discover(): Promise<ClientCapabilities> { const versionResult = await runner.run("claude", ["--version"]); const v = versionResult.exitCode === 0 ? versionFromOutput("claude-code", versionResult.stdout) : undefined; const probe = await runner.run("claude", ["mcp", "--help"]); const supported = probe.exitCode === 0 && ["get", "add", "remove"].every((command) => new RegExp(`\\b${command}\\b`).test(probe.stdout)); return { client: "claude-code", version: v ?? "unknown", supportsJson: false, supportsAdd: supported, supportsRemove: supported, scopes: supported ? ["user", "project", "local"] : [] }; },
    async inspect(scope, intent): Promise<ClientRegistration> { const r = await runner.run("claude", ["mcp", "get", NAME]); const absent = /^No MCP server named \"pi-session-mcp\"\.(?:(?:\s+Configured servers:.*)|(?:\s+Run `claude mcp add` to add one\.))?\s*$/i.test(r.stderr.trim()); const x = r.exitCode === 0 ? inspectText(r.stdout, intent) : absent ? { state: "absent" as const, expected: false } : { state: "unsupported" as const, expected: false }; return { client: "claude-code", scope, name: NAME, state: x.state, command: x.expected ? "node" : "unknown", hasExpectedConfig: x.expected, supported: x.state !== "unsupported" }; },
    async plan(intent): Promise<RegistrationPlan> { const r = await this.inspect(intent.scope, intent); return { client: "claude-code", scope: intent.scope, state: r.state, operation: r.state === "absent" ? "add" : "none", reason: r.state === "absent" ? "missing" : r.state === "equivalent" ? "already_registered" : r.state }; },
    async add(intent, execution): Promise<void> { const r = await (execution?.runner ?? runner).run("claude", ["mcp", "add", NAME, "-s", intent.scope, "-e", `PI_SESSION_MCP_CONFIG=${intent.configPath}`, "--", intent.nodePath, intent.entryPath], execution?.signal); if (r.exitCode !== 0) throw new Error("client registration failed"); },
    async remove(scope, execution): Promise<void> { const r = await (execution?.runner ?? runner).run("claude", ["mcp", "remove", NAME, ...scopeArgs(scope)], execution?.signal); if (r.exitCode !== 0) throw new Error("client removal failed"); },
  };
}

import { safeRunner, versionFromOutput } from "./command.js";
import type { ClientAdapter, ClientCapabilities, ClientRegistration, ClientScope, CommandRunner, RegistrationIntent, RegistrationPlan } from "./types.js";

const NAME = "pi-session-mcp" as const;
function equivalent(value: unknown, intent: RegistrationIntent): boolean {
  if (!value || typeof value !== "object") return false;
  const root = value as Record<string, unknown>;
  if (root.name !== NAME || root.enabled !== true) return false;
  const transport = root.transport;
  if (!transport || typeof transport !== "object") return false;
  const entry = transport as Record<string, unknown>;
  const args = Array.isArray(entry.args) ? entry.args : [];
  const env = entry.env;
  const envRecord = env && typeof env === "object" ? env as Record<string, unknown> : undefined;
  return entry.type === "stdio"
    && entry.command === intent.nodePath
    && args.length === 1 && args[0] === intent.entryPath
    && !!envRecord && Object.keys(envRecord).length === 1 && envRecord.PI_SESSION_MCP_CONFIG === intent.configPath
    && Array.isArray(entry.env_vars) && entry.env_vars.length === 0
    && entry.cwd === null;
}

export function createCodexAdapter(input: { readonly runner: CommandRunner }): ClientAdapter {
  const runner = safeRunner(input.runner.run);
  return {
    client: "codex",
    async discover(): Promise<ClientCapabilities> {
      const versionResult = await runner.run("codex", ["--version"]);
      const version = versionResult.exitCode === 0 ? versionFromOutput("codex", versionResult.stdout) : undefined;
      const probe = await runner.run("codex", ["mcp", "--help"]);
      const supported = probe.exitCode === 0 && ["get", "add", "remove"].every((command) => new RegExp(`\\b${command}\\b`).test(probe.stdout));
      return { client: "codex", version: version ?? "unknown", supportsJson: supported, supportsAdd: supported, supportsRemove: supported, scopes: supported ? ["user"] : [] };
    },
    async inspect(scope, intent): Promise<ClientRegistration> {
      if (scope !== "user") return { client: "codex", scope, name: NAME, state: "unsupported", command: "unknown", hasExpectedConfig: false, supported: false };
      const result = await runner.run("codex", ["mcp", "get", NAME, "--json"]);
      let state: ClientRegistration["state"] = "absent"; let supported = true; let hasExpectedConfig = false; let command: ClientRegistration["command"] = "unknown";
      if (result.exitCode === 0) { try { const value: unknown = JSON.parse(result.stdout); const transport = value && typeof value === "object" && (value as Record<string, unknown>).transport; if (!transport || typeof transport !== "object") throw new Error("schema"); hasExpectedConfig = equivalent(value, intent); state = hasExpectedConfig ? "equivalent" : "divergent"; command = hasExpectedConfig ? "node" : "unknown"; } catch { state = "unsupported"; supported = false; } }
      else if (/^Error: No MCP server named 'pi-session-mcp' found\.\s*$/i.test(result.stderr.trim())) state = "absent";
      else { state = "unsupported"; supported = false; }
      return { client: "codex", scope, name: NAME, state, command, hasExpectedConfig, supported };
    },
    async plan(intent): Promise<RegistrationPlan> { const r = await this.inspect(intent.scope, intent); return { client: "codex", scope: intent.scope, state: r.state, operation: r.state === "absent" ? "add" : "none", reason: r.state === "absent" ? "missing" : r.state === "equivalent" ? "already_registered" : r.state }; },
    async add(intent, execution): Promise<void> { if (intent.scope !== "user") throw new Error("unsupported client scope"); const r = await (execution?.runner ?? runner).run("codex", ["mcp", "add", NAME, "--env", `PI_SESSION_MCP_CONFIG=${intent.configPath}`, "--", intent.nodePath, intent.entryPath], execution?.signal); if (r.exitCode !== 0) throw new Error("client registration failed"); },
    async remove(scope, execution): Promise<void> { if (scope !== "user") throw new Error("unsupported client scope"); const r = await (execution?.runner ?? runner).run("codex", ["mcp", "remove", NAME], execution?.signal); if (r.exitCode !== 0) throw new Error("client removal failed"); },
  };
}

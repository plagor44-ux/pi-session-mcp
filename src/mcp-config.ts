import { isAbsolute } from "node:path";

/** Operator-owned configuration. MCP callers can select a profile, never supply this data. */
export interface McpToolGrant {
  readonly name: string;
  /** An explicit operator assertion, never inferred from an MCP annotation. */
  readonly readOnly: boolean;
}
export interface McpServerConfig {
  readonly command: string;
  readonly args?: readonly string[];
  /** Child environment variable -> existing host environment variable (not a secret value). */
  readonly envFrom?: Readonly<Record<string, string>>;
  readonly tools: Readonly<Record<string, McpToolGrant>>;
}
export type McpServers = Readonly<Record<string, McpServerConfig>>;

const aliasPattern = /^[a-z][a-z0-9_-]{0,23}$/;
const environmentPattern = /^[A-Z_][A-Z0-9_]{0,127}$/;
export const MAX_MCP_SERVERS = 8;
export const MAX_MCP_TOOLS = 64;

export function mcpToolName(server: string, tool: string): string {
  return `mcp_${server}_${tool}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function keysAre(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !value.includes("\0");
}

/** Also used at the adapter boundary: a manually constructed profile must not bypass policy. */
export function isMcpServers(value: unknown, permissionProfile: "read-only" | "coding" = "coding"): value is McpServers {
  if (permissionProfile !== "read-only" && permissionProfile !== "coding") return false;
  if (!record(value) || Object.keys(value).length > MAX_MCP_SERVERS) return false;
  const toolNames = new Set<string>();
  for (const [serverAlias, server] of Object.entries(value)) {
    if (!aliasPattern.test(serverAlias) || !record(server) || !keysAre(server, ["command", "args", "envFrom", "tools"])) return false;
    if (!text(server.command, 4096) || !isAbsolute(server.command)) return false;
    if (server.args !== undefined && (!Array.isArray(server.args) || server.args.length > 128
      || !server.args.every((arg) => typeof arg === "string" && arg.length <= 4096 && !arg.includes("\0")))) return false;
    if (server.envFrom !== undefined && (!record(server.envFrom) || Object.keys(server.envFrom).length > 64
      || !Object.entries(server.envFrom).every(([target, source]) => environmentPattern.test(target)
        && typeof source === "string" && environmentPattern.test(source)))) return false;
    if (!record(server.tools) || Object.keys(server.tools).length === 0) return false;
    const remoteNames = new Set<string>();
    for (const [toolAlias, grant] of Object.entries(server.tools)) {
      if (!aliasPattern.test(toolAlias) || !record(grant) || !keysAre(grant, ["name", "readOnly"])
        || !text(grant.name, 256) || typeof grant.readOnly !== "boolean") return false;
      if (permissionProfile === "read-only" && !grant.readOnly) return false;
      const exposedName = mcpToolName(serverAlias, toolAlias);
      // Underscore-containing aliases can otherwise create cross-server name collisions.
      if (toolNames.has(exposedName) || remoteNames.has(grant.name)) return false;
      toolNames.add(exposedName);
      remoteNames.add(grant.name);
      if (toolNames.size > MAX_MCP_TOOLS) return false;
    }
  }
  return true;
}

export function snapshotMcpServers(servers: McpServers): McpServers {
  return Object.freeze(Object.fromEntries(Object.entries(servers).map(([alias, server]) => [alias, Object.freeze({
    command: server.command,
    args: Object.freeze([...(server.args ?? [])]),
    envFrom: Object.freeze({ ...server.envFrom }),
    tools: Object.freeze(Object.fromEntries(Object.entries(server.tools).map(([name, grant]) => [name, Object.freeze({ ...grant })]))),
  })])));
}

/** Safe discovery metadata; never project commands, arguments, paths, or environment references. */
export function configuredMcpToolNames(servers: McpServers): string[] {
  return Object.entries(servers).flatMap(([server, config]) => Object.keys(config.tools).map((tool) => mcpToolName(server, tool))).sort();
}

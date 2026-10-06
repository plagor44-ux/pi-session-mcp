import { Client, type Tool } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import packageMetadata from "../package.json" with { type: "json" };
import { MCP_CALL_TIMEOUT_MS, MCP_STARTUP_TIMEOUT_MS, type McpConnectionFactory } from "./mcp-session-tools.js";

/** Uses only the MCP SDK's public exports. No HTTP, shell, or global MCP config. */
export const createStdioMcpConnection: McpConnectionFactory = (server, cwd) => {
  const env: Record<string, string> = {};
  for (const [target, source] of Object.entries(server.envFrom ?? {})) {
    const value = process.env[source];
    if (value === undefined) throw new Error("External MCP environment is unavailable");
    env[target] = value;
  }
  const transport = new StdioClientTransport({
    command: server.command, args: [...(server.args ?? [])], cwd, env, stderr: "pipe",
  });
  // The SDK supplies its small default OS environment; never spread process.env.
  // Drain child diagnostics without copying secrets to controller stdout/stderr.
  transport.stderr?.on("data", () => undefined);
  const client = new Client({ name: "pi-session-mcp-session", version: packageMetadata.version }, { capabilities: {} });
  client.onerror = () => undefined;
  const discoveredTools = new Map<string, Tool>();
  return {
    async connect(signal) {
      await client.connect(transport, { signal, timeout: MCP_STARTUP_TIMEOUT_MS });
      if (!client.getServerCapabilities()?.tools) throw new Error("External MCP tools capability is unavailable");
    },
    async listTools(cursor, signal) {
      // `Client.listTools({})` auto-aggregates and hides cursor loops. Issue one
      // validated protocol request per page so the bridge owns completeness limits.
      const page = await client.request({
        method: "tools/list",
        params: cursor === undefined ? {} : { cursor },
      }, { signal, timeout: MCP_STARTUP_TIMEOUT_MS });
      for (const tool of page.tools) discoveredTools.set(tool.name, tool);
      return page;
    },
    callTool(name, args, signal) {
      const toolDefinition = discoveredTools.get(name);
      if (!toolDefinition) throw new Error("External MCP tool definition is unavailable");
      return client.callTool({ name, arguments: args }, {
        signal, timeout: MCP_CALL_TIMEOUT_MS, maxTotalTimeout: MCP_CALL_TIMEOUT_MS, resetTimeoutOnProgress: false,
        toolDefinition,
      });
    },
    async close() {
      // Close the transport too if initialization failed before Client took ownership.
      try { await client.close(); } finally { await transport.close(); }
    },
  };
};

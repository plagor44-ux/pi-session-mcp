import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { PACKAGE_VERSION } from "./package-metadata.js";

export type RefusalCode = "container_runtime_unavailable" | "writer_not_ready";
const messages: Record<RefusalCode, string> = {
  container_runtime_unavailable: "Rootless Podman is not usable on this machine; this writer refuses all work.",
  writer_not_ready: "This writer is not ready; run pi-session-mcp-setup for its repository.",
};

export async function serveRefusal(code: RefusalCode, io?: { stdin: Readable; stdout: Writable }): Promise<void> {
  serveStdio(() => {
    const server = new McpServer({ name: "pi-session-mcp", version: PACKAGE_VERSION }, { capabilities: { tools: {} } });
    for (const name of ["pi_capabilities_get", "pi_session_start", "pi_session_list", "pi_session_get", "pi_session_prompt", "pi_session_abort", "pi_session_close", "pi_turn_get"]) {
      server.registerTool(name, { inputSchema: z.object({}).passthrough() }, () => {
        const value = { ok: false, error: { code, message: messages[code] } };
        return { isError: true, structuredContent: value, content: [{ type: "text" as const, text: JSON.stringify(value) }] };
      });
    }
    return server;
  }, { transport: new StdioServerTransport(io?.stdin ?? process.stdin, io?.stdout ?? process.stdout) });
}

import { readFile } from "node:fs/promises";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { FakeAdapter } from "../../test/fake-adapter.js";
import { SessionRegistry } from "../../src/session-registry.js";
import { createServer } from "../../src/server.js";

// Test-only model-request boundary fixture. No ModelRuntime, provider or auth.
const config = JSON.parse(await readFile(process.env.PI_SESSION_MCP_CONFIG!, "utf8")) as { workspace: string };
const marker = "token_probe_marker_74ac";
const workspaces = new Map([[marker, config.workspace]]), adapter = new FakeAdapter();
const originalCreate = adapter.create.bind(adapter);
adapter.create = async input => {
  await originalCreate(input);
  const handle = adapter.handles.at(-1)!, prompt = handle.prompt.bind(handle);
  handle.prompt = (text, preflight, activity) => {
    const outcome = prompt(text, preflight, activity);
    // Keep the accepted response small and independently parseable. The large
    // terminal view is fetched in a separate call, after this scripted delay.
    setTimeout(() => handle.complete(marker + " <think>synthetic_thinking_echo</think> synthetic_tool_echo  " + "🙂".repeat(20000)), 100);
    return outcome;
  };
  return handle;
};
const registry = new SessionRegistry(adapter, workspaces);
const server = createServer(registry, workspaces, new Map([["fixture", { alias: "fixture", default: true, permissionProfile: "read-only" as const, provider: "scripted", model: "scripted", thinkingLevel: "off" as const }]]), "fixture", { fingerprint: `sha256:${"0".repeat(64)}`, reloadPolicy: "restart-required" });
await server.connect(new StdioServerTransport());
let closed = false;
const close = async () => { if (closed) return; closed = true; await registry.shutdown(); await server.close(); };
process.stdin.once("end", () => { void close(); });
process.once("SIGTERM", () => { void close(); });

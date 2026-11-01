// Real production MCP server/registry over stdio; only adapter and deadline clock are fake.
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createServer } from "../../dist/server.js";
import { SessionRegistry } from "../../dist/session-registry.js";
const scenario = JSON.parse(await readFile(process.argv[2], "utf8"));
const nativeTimeout = globalThis.setTimeout;
const nativeNow = performance.now.bind(performance);
let offset = 0;
Object.defineProperty(performance, "now", { value: () => nativeNow() + offset });
globalThis.setTimeout = (callback, ms, ...args) => ms >= 59_000 && ms <= 60_000
  ? nativeTimeout(() => { offset += ms; callback(...args); }, 50)
  : nativeTimeout(callback, ms, ...args);
const profile = { alias: "code", default: true, permissionProfile: "coding", provider: "p", model: "m", thinkingLevel: "off", maxTurnSeconds: 60 };
let handle;
const adapter = { async create() {
  let settle;
  handle = {
    sdkSessionId: randomUUID(), appliedSelection: { provider: "p", model: "m", thinkingLevel: "off" },
    prompt(_text, preflight) { preflight(true); return new Promise(resolve => { settle = resolve; }); },
    async abort() {
      if (scenario.abortFailure) {
        nativeTimeout(() => settle?.({ status: "completed", assistantText: "done", completion: "stop" }), 20);
        throw new Error("fixture abort failure");
      }
      settle?.({ status: "aborted" });
    },
    dispose() {},
  };
  return handle;
} };
const workspaces = new Map([["repo", "/unused"]]);
const registry = new SessionRegistry(adapter, workspaces);
const server = createServer(registry, workspaces, new Map([["code", profile]]), "code", { fingerprint: "sha256:" + "a".repeat(64), reloadPolicy: "restart-required" }, new Map([["repo", { mode: "host" }]]));
await server.connect(new StdioServerTransport());
process.stdin.on("end", async () => { await registry.shutdown(); await server.close(); });

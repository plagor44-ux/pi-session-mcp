import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeAdapter } from "../../test/fake-adapter.js";
import { createServer } from "../../src/server.js";
import { SessionRegistry } from "../../src/session-registry.js";
import { makeReport, repair } from "./token-reports.js";

const workspace = process.env.TOKEN_FIXTURE_WORKSPACE;
if (!workspace) throw new Error("fixture_workspace_missing");
const adapter = new FakeAdapter(), create = adapter.create.bind(adapter);
adapter.create = async input => {
  await create(input);
  const handle = adapter.handles.at(-1)!, prompt = handle.prompt.bind(handle), dispose = handle.dispose.bind(handle);
  let timer: NodeJS.Timeout | undefined;
  handle.prompt = (text, preflight, activity) => {
    const command = JSON.parse(text) as { task: "read" | "code"; compact: boolean; delay: number; mode?: string };
    handle.plan.manualPreflight = command.mode === "timeout";
    const outcome = prompt(text, preflight, activity);
    if (command.mode === "timeout" || command.mode === "abort") return outcome;
    timer = setTimeout(() => { void (async () => {
      activity?.();
      if (command.mode === "failure") { handle.fail(); return; }
      if (command.task === "code") await writeFile(join(input.cwd, "contract.mjs"), repair);
      const answer = command.mode === "unicode-small" ? "é🙂" : command.mode === "unicode-exact" ? "🙂".repeat(16384) :
        command.mode === "unicode-over" ? "🙂".repeat(16385) : makeReport(command.task, command.compact);
      handle.complete(answer);
    })().catch(() => handle.fail()); }, command.delay);
    return outcome;
  };
  handle.dispose = () => { clearTimeout(timer); dispose(); };
  return handle;
};
const workspaces = new Map([["fixture", workspace]]);
const registry = new SessionRegistry(adapter, workspaces, { preflightDeadlineMs: 40 });
const profiles = new Map([["fixture", { alias: "fixture", default: true, permissionProfile: "coding" as const, provider: "scripted", model: "scripted", thinkingLevel: "off" as const }]]);
const server = createServer(registry, workspaces, profiles, "fixture", { fingerprint: `sha256:${"0".repeat(64)}`, reloadPolicy: "restart-required" });
await server.connect(new StdioServerTransport());
let stopped = false;
const stop = async () => { if (stopped) return; stopped = true; await registry.shutdown(); await server.close(); };
process.stdin.once("end", () => { void stop(); });
process.once("SIGTERM", () => { void stop(); });

/**
 * Pi SDK contract for allowlisted extensions, against the installed SDK and the local
 * fixture extension. No provider, credentials or network: the fixture provider answers
 * from memory. When an SDK upgrade breaks an assumption, the failing test names it.
 */
import { existsSync } from "node:fs";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as waitFor } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { parseExtensionSpec } from "../src/extension-spec.js";
import type { PermissionProfile, ResolvedExecutionProfile } from "../src/execution-profile.js";
import { resolvePiExtension } from "../src/pi-extensions.js";
import { SdkPiSessionAdapter } from "../src/sdk-pi-adapter.js";
import { SessionRegistry, type TurnView } from "../src/session-registry.js";
import { PROFILE_TOOLS } from "../src/session-tools.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/pi-extension-fixture", import.meta.url));
const extension = parseExtensionSpec("npm:pi-extension-fixture@1.0.0")!;
// Shared by every test in this file, so the tests must run sequentially: never use `describe.concurrent`.
const events = (): string[] => ((globalThis as { __piExtensionFixtureEvents?: string[] }).__piExtensionFixtureEvents ??= []);

afterAll(removeTemporaryRoots);
beforeEach(() => {
  events().length = 0;
  (globalThis as { __piExtensionFixtureMode?: string }).__piExtensionFixtureMode = "default";
});

async function harness(permissionProfile: PermissionProfile, grantedExtensionTools?: readonly string[]) {
  const root = await temporaryRoot("pi-session-mcp-extension-contract-");
  const agentDir = join(root, "agent");
  const workspace = join(root, "workspace");
  await mkdir(join(agentDir, "npm", "node_modules"), { recursive: true });
  await mkdir(workspace);
  await cp(FIXTURE, join(agentDir, "npm", "node_modules", "pi-extension-fixture"), { recursive: true });
  const adapter = new SdkPiSessionAdapter({
    modelRuntimeFactory: () => ModelRuntime.create({
      refreshOnCreate: false, allowModelNetwork: false, modelsPath: null,
      authPath: join(agentDir, "auth.json"), modelsStorePath: join(agentDir, "models-store.json"),
    }),
    resolveExtension: (spec) => resolvePiExtension(spec, { agentDir }),
  });
  const registry = new SessionRegistry(adapter, new Map([["repo", workspace]]));
  const executionProfile: ResolvedExecutionProfile = {
    alias: "fixture", permissionProfile, provider: "fixture-ext", model: "fixture-ext-model", thinkingLevel: "off", extensions: [extension],
    ...(grantedExtensionTools === undefined ? {} : { grantedExtensionTools }),
  };
  return { registry, executionProfile, workspace, agentDir };
}

async function terminal(registry: SessionRegistry, sessionId: string, turnId: string): Promise<TurnView> {
  let turn = registry.getTurn(sessionId, turnId);
  const deadline = Date.now() + 20_000;
  while (turn.state === "running" && Date.now() < deadline) {
    await waitFor(5);
    turn = registry.getTurn(sessionId, turnId);
  }
  return turn;
}

describe("Pi SDK contract for allowlisted extensions", () => {
  it("registers the extension provider before verification and completes a prompt from it", async () => {
    const { registry, executionProfile } = await harness("read-only");
    const session = await registry.start("repo", executionProfile);
    try {
      expect(session).toMatchObject({ provider: "fixture-ext", model: "fixture-ext-model", state: "idle" });
      const accepted = await registry.prompt(session.id, "hello");
      expect(await terminal(registry, session.id, accepted.turn.turnId)).toMatchObject({ state: "completed", assistantText: "FIXTURE-PONG" });
      expect(events()).toEqual(expect.arrayContaining(["load", "session_start", "stream"]));
    } finally {
      await registry.close(session.id);
    }
  }, 30_000);

  it("never runs Pi's built-in MCP client, so a workspace mcp.json starts no server even after session_start (#115)", async () => {
    const { registry, executionProfile, workspace, agentDir } = await harness("coding");
    // Pi's MCP extension reads `mcp.json` from the global agent directory (where `pi mcp add`
    // writes) and, for trusted projects, `.pi/mcp.json`. The session's own agent directory is
    // the workspace, so a repository could carry a copy there too.
    const marker = join(workspace, "mcp-server-started");
    const server = { command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`], exposure: "direct" };
    await mkdir(join(workspace, ".pi"));
    for (const file of [join(agentDir, "mcp.json"), join(workspace, "mcp.json"), join(workspace, ".pi", "mcp.json")]) {
      await writeFile(file, JSON.stringify({ mcpServers: { configured: server } }));
    }
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const session = await registry.start("repo", executionProfile);
      try {
        const accepted = await registry.prompt(session.id, "hello");
        expect(await terminal(registry, session.id, accepted.turn.turnId)).toMatchObject({ state: "completed" });
        expect(events()).toContain("session_start");
      } finally {
        await registry.close(session.id);
      }
      await waitFor(500);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  it("shows client prompts to extension input hooks as rpc input", async () => {
    const { registry, executionProfile } = await harness("read-only");
    const session = await registry.start("repo", executionProfile);
    try {
      const accepted = await registry.prompt(session.id, "hello");
      expect(await terminal(registry, session.id, accepted.turn.turnId)).toMatchObject({ state: "completed" });
      expect(events()).toContain("input:rpc");
      expect(events()).not.toContain("input:interactive");
    } finally {
      await registry.close(session.id);
    }
  }, 30_000);

  it("keeps extension tools away from the model in read-only profiles even against setActiveTools", async () => {
    const { registry, executionProfile } = await harness("read-only");
    const session = await registry.start("repo", executionProfile);
    try {
      const accepted = await registry.prompt(session.id, "list the tools");
      expect(await terminal(registry, session.id, accepted.turn.turnId)).toMatchObject({ state: "completed" });
      expect(events()).toContain("widen:before_agent_start");
      expect(events()).toContain(`tools:${[...PROFILE_TOOLS["read-only"]].sort().join(",")}`);
    } finally {
      await registry.close(session.id);
    }
  }, 30_000);

  it("declares exactly granted extension tools in read-only profiles despite setActiveTools", async () => {
    const { registry, executionProfile } = await harness("read-only", ["fixture_reader"]);
    const session = await registry.start("repo", executionProfile);
    try {
      const accepted = await registry.prompt(session.id, "list the tools");
      expect(await terminal(registry, session.id, accepted.turn.turnId)).toMatchObject({ state: "completed" });
      expect(events()).toContain("widen:before_agent_start");
      expect(events().filter((event) => event.startsWith("tools:"))).toEqual([
        `tools:${[...PROFILE_TOOLS["read-only"], "fixture_reader"].sort().join(",")}`,
      ]);
    } finally {
      await registry.close(session.id);
    }
  }, 30_000);

  it("rejects an unregistered grant before session_start", async () => {
    const { registry, executionProfile } = await harness("read-only", ["fixture_missing"]);
    await expect(registry.start("repo", executionProfile)).rejects.toMatchObject({ code: "extension_tool_missing" });
    expect(events()).not.toContain("session_start");
  }, 30_000);

  it.each(["deactivate", "hidden"])("rejects a granted tool that is inactive in mode %s", async (mode) => {
    (globalThis as { __piExtensionFixtureMode?: string }).__piExtensionFixtureMode = mode;
    const { registry, executionProfile } = await harness("read-only", ["fixture_reader"]);
    await expect(registry.start("repo", executionProfile)).rejects.toMatchObject({ code: "extension_tool_missing" });
    expect(events()).toContain("session_start");
    expect(events()).toContain("session_shutdown");
  }, 30_000);

  it("declares extension tools to the model in coding profiles", async () => {
    const { registry, executionProfile } = await harness("coding");
    const session = await registry.start("repo", executionProfile);
    try {
      const accepted = await registry.prompt(session.id, "list the tools");
      expect(await terminal(registry, session.id, accepted.turn.turnId)).toMatchObject({ state: "completed" });
      expect(events()).toContain(`tools:${[...PROFILE_TOOLS.coding, "fixture_tool", "fixture_reader"].sort().join(",")}`);
    } finally {
      await registry.close(session.id);
    }
  }, 30_000);

  it("sends slash-command text to the model instead of running the command", async () => {
    const { registry, executionProfile } = await harness("read-only");
    const session = await registry.start("repo", executionProfile);
    try {
      const accepted = await registry.prompt(session.id, "/fixture-cmd now");
      expect(await terminal(registry, session.id, accepted.turn.turnId)).toMatchObject({ state: "completed" });
      expect(events()).not.toContain("command");
      expect(events()).toContain("stream");
    } finally {
      await registry.close(session.id);
    }
  }, 30_000);

  it("runs session_shutdown when the session closes", async () => {
    const { registry, executionProfile } = await harness("read-only");
    const session = await registry.start("repo", executionProfile);
    await registry.close(session.id);
    expect(events()).toContain("session_shutdown");
  }, 30_000);
});

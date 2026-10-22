/**
 * Runs the setup verifier against the real compiled server over stdio.
 *
 * The server's capability projection and the verifier's payload check are written
 * separately. A scripted payload cannot notice when they drift apart (#36), so this
 * test lets `setup`'s own launcher and verifier talk to the built server.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import packageMetadata from "../package.json" with { type: "json" };
import { MCP_MAX_FRAME_BYTES, verifyMcpCapabilities } from "../src/client-adapters/mcp-verifier.js";
import { createMcpStdioLauncher } from "../src/setup-process.js";
import { compileServerEntry } from "./compiled-entry.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

let entry = "";

beforeAll(async () => { entry = await compileServerEntry(); }, 150_000);
afterAll(removeTemporaryRoots);

function capabilities(profiles = 1) {
  return {
    ok: true,
    server: { name: packageMetadata.name, version: packageMetadata.version },
    configuration: { fingerprint: `sha256:${"a".repeat(64)}`, reloadPolicy: "restart-required" },
    events: { delivery: "off" },
    workspaces: [{ alias: "repo", mode: "unset" }],
    executionProfiles: Array.from({ length: profiles }, (_, index) => ({
      alias: `p${index}`.padEnd(64, "a"), default: index === 0, permissionProfile: "read-only",
      provider: "p".repeat(256), model: "m".repeat(256), thinkingLevel: "off",
      extensions: Array.from({ length: 8 }, (_, i) => `npm:e${i}${"x".repeat(244)}@1.0.0`),
      grantedExtensionTools: Array.from({ length: 32 }, (_, i) => `t${i}`.padEnd(64, "x")),
      skills: [],
    })),
  };
}

function capabilitiesFrame(value: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id: 4, result: {
    content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value,
  } })}\n`;
}

async function verifyPayload(value: unknown) {
  const responses = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26", serverInfo: { name: packageMetadata.name, version: packageMetadata.version } } }),
    JSON.stringify({ jsonrpc: "2.0", id: 3, result: { tools: ["pi_capabilities_get", "pi_session_start", "pi_session_list", "pi_session_get", "pi_session_prompt", "pi_session_abort", "pi_session_close", "pi_turn_get"].map((name) => ({ name })) } }),
    capabilitiesFrame(value),
  ];
  return verifyMcpCapabilities({ launch: async () => ({ write() {}, read: async () => responses.shift() ?? null, kill() {} }) });
}

describe("setup verifier grant validation", () => {
  it("accepts two configured grants", async () => {
    const payload = capabilities();
    payload.executionProfiles[0]!.grantedExtensionTools = ["zeta_lookup", "alpha_lookup"];
    expect(await verifyPayload(payload)).toMatchObject({ status: "verified", capabilitiesGet: true });
  });

  it.each([
    ["too many", Array.from({ length: 33 }, (_, i) => `tool_${i}`)],
    ["duplicates", ["lookup", "lookup"]],
    ["invalid name", ["bad.name"]],
    ["reserved name", ["mcp__lookup"]],
    ["non-string", [1]],
    ["not an array", "lookup"],
    ["missing", undefined],
  ])("rejects %s grants", async (_label, grants) => {
    const payload = capabilities();
    Object.assign(payload.executionProfiles[0]!, { grantedExtensionTools: grants });
    expect(await verifyPayload(payload)).toMatchObject({ status: "failed", capabilitiesGet: false });
  });

  it("documents the largest fitting profile count with maximum-sized specs and grants", async () => {
    const bytes = (count: number) => Buffer.byteLength(capabilitiesFrame(capabilities(count)), "utf8");
    let fitting = 10;
    while (bytes(fitting) > MCP_MAX_FRAME_BYTES) fitting--;
    expect(fitting).toBe(6);
    expect(bytes(fitting)).toBeLessThanOrEqual(MCP_MAX_FRAME_BYTES);
    expect(bytes(fitting + 1)).toBeGreaterThan(MCP_MAX_FRAME_BYTES);
    expect(await verifyPayload(capabilities(fitting))).toMatchObject({ status: "verified", capabilitiesGet: true });
    expect(await verifyPayload(capabilities(fitting + 1))).toMatchObject({ status: "failed", capabilitiesGet: false });
  });
});

describe("setup verification against the real server", () => {
  it("verifies profiles with and without extensions and skills", async () => {
    const root = await temporaryRoot("pi-session-mcp-setup-verify-");
    const config = join(root, "config.json");
    await mkdir(join(root, "skills", "review"), { recursive: true });
    await writeFile(join(root, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review changes.\n---\nReview.\n");
    await writeFile(config, JSON.stringify({
      workspaces: { project: root },
      skillCatalog: { review: "skills/review/SKILL.md" },
      executionProfiles: {
        safe: { default: true, permissionProfile: "read-only", provider: "inert-provider", model: "inert-model", thinkingLevel: "off" },
        "code-ext": {
          default: false, permissionProfile: "coding", provider: "inert-extension", model: "inert-extension-model", thinkingLevel: "high",
          extensions: ["npm:pi-extension-fixture@1.0.0", "npm:@scope/other-extension@1.2.3-beta.1"],
          skills: ["review"],
        },
        "review-ext": {
          default: false, permissionProfile: "read-only", provider: "inert-provider", model: "inert-model", thinkingLevel: "off",
          extensions: ["npm:pi-extension-fixture@1.0.0"],
          grantedExtensionTools: ["zeta_lookup", "alpha_lookup"],
        },
      },
    }), { mode: 0o600 });
    const launch = createMcpStdioLauncher({ nodePath: process.execPath, entryPath: entry, configPath: config, timeoutMs: 20_000 });
    const result = await verifyMcpCapabilities({ launch, timeoutMs: 20_000 });
    expect(result).toMatchObject({ status: "verified", initialize: true, toolsList: true, capabilitiesGet: true });
  }, 60_000);

  it.each([
    ["passes the runtime directory, so a spool server starts its spool there", true],
    ["verifies a spool server that gets no runtime directory", false],
  ])("%s (#113)", async (_label, withRuntime) => {
    const root = await temporaryRoot("pi-session-mcp-setup-verify-spool-");
    const runtime = join(root, "runtime");
    await mkdir(runtime, { mode: 0o700 });
    const config = join(root, "config.json");
    await writeFile(config, JSON.stringify({
      events: { delivery: "spool" },
      workspaces: { project: root },
      executionProfiles: { safe: { default: true, permissionProfile: "read-only", provider: "inert-provider", model: "inert-model", thinkingLevel: "off" } },
    }), { mode: 0o600 });
    const launch = createMcpStdioLauncher({ nodePath: process.execPath, entryPath: entry, configPath: config, timeoutMs: 20_000, runtimeDir: withRuntime ? runtime : "" });
    const result = await verifyMcpCapabilities({ launch, timeoutMs: 20_000 });
    expect(result).toMatchObject({ status: "verified", initialize: true, toolsList: true, capabilitiesGet: true });
    expect(existsSync(join(runtime, "pi-session-mcp", "events"))).toBe(withRuntime);
  }, 60_000);
});

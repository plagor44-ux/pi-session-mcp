/**
 * Runs the setup verifier against the real compiled server over stdio.
 *
 * The server's capability projection and the verifier's payload check are written
 * separately. A scripted payload cannot notice when they drift apart (#36), so this
 * test lets `setup`'s own launcher and verifier talk to the built server.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyMcpCapabilities } from "../src/client-adapters/mcp-verifier.js";
import { createMcpStdioLauncher } from "../src/setup-process.js";
import { compileServerEntry } from "./compiled-entry.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

let entry = "";

beforeAll(async () => { entry = await compileServerEntry(); }, 150_000);
afterAll(removeTemporaryRoots);

describe("setup verification against the real server", () => {
  it("verifies profiles with and without extensions", async () => {
    const root = await temporaryRoot("pi-session-mcp-setup-verify-");
    const config = join(root, "config.json");
    await writeFile(config, JSON.stringify({
      workspaces: { project: root },
      executionProfiles: {
        safe: { default: true, permissionProfile: "read-only", provider: "inert-provider", model: "inert-model", thinkingLevel: "off" },
        "code-ext": {
          default: false, permissionProfile: "coding", provider: "inert-extension", model: "inert-extension-model", thinkingLevel: "high",
          extensions: ["npm:pi-extension-fixture@1.0.0", "npm:@scope/other-extension@1.2.3-beta.1"],
        },
      },
    }), { mode: 0o600 });
    const launch = createMcpStdioLauncher({ nodePath: process.execPath, entryPath: entry, configPath: config, timeoutMs: 20_000 });
    const result = await verifyMcpCapabilities({ launch, timeoutMs: 20_000 });
    expect(result).toMatchObject({ status: "verified", initialize: true, toolsList: true, capabilitiesGet: true });
  }, 60_000);
});

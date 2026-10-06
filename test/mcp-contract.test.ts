import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";
import { SessionRegistry, type SessionRegistryOptions } from "../src/session-registry.js";
import { FakeAdapter } from "./fake-adapter.js";
import { PiSessionCreationError } from "../src/pi-adapter.js";
import packageMetadata from "../package.json" with { type: "json" };
import { loadConfig, type ConfigurationMetadata } from "../src/config.js";
import type { ConfiguredExecutionProfile } from "../src/execution-profile.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

const TEST_CONFIGURATION: ConfigurationMetadata = Object.freeze({
  fingerprint: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  reloadPolicy: "restart-required",
});

afterAll(removeTemporaryRoots);

describe("MCP contracts", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { await Promise.allSettled(closers.splice(0).map((close) => close())); });
  async function client(registryOptions: SessionRegistryOptions = {}, fixtures: {
    workspaces?: ReadonlyMap<string, string>;
    profiles?: ReadonlyMap<string, ConfiguredExecutionProfile>;
    defaultExecutionProfile?: string;
    configuration?: ConfigurationMetadata;
  } = {}) {
    const workspaces = fixtures.workspaces ?? new Map([["repo", "/safe/repo"]]);
    const adapter = new FakeAdapter(); const registry = new SessionRegistry(adapter, workspaces, registryOptions);
    const profiles = fixtures.profiles ?? new Map([
      ["safe", { alias: "safe", default: true, permissionProfile: "read-only" as const, provider: "fake-provider", model: "fake-model", thinkingLevel: "off" as const }],
      ["coding", { alias: "coding", default: false, permissionProfile: "coding" as const, provider: "fake-provider", model: "fake-model", thinkingLevel: "high" as const }],
    ]);
    const server = createServer(registry, workspaces, profiles, fixtures.defaultExecutionProfile ?? "safe", fixtures.configuration ?? TEST_CONFIGURATION);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: "contract-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]); closers.push(async () => { await client.close(); await server.close(); await registry.shutdown(); }); return { client, adapter, registry };
  }

  it("publishes eight tools with closed-world capability discovery annotations", async () => {
    const connected = await client();
    expect(connected.client.getServerVersion()).toEqual({ name: packageMetadata.name, version: packageMetadata.version });
    const tools = (await connected.client.listTools()).tools; expect(tools.map(({ name }) => name)).toEqual([
      "pi_capabilities_get", "pi_session_start", "pi_session_list", "pi_session_get", "pi_session_prompt", "pi_session_abort", "pi_session_close", "pi_turn_get",
    ]);
    const discovery = tools.find((tool) => tool.name === "pi_capabilities_get");
    expect(discovery?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(discovery?.inputSchema).toMatchObject({ type: "object", properties: {}, additionalProperties: false });
    const inputSchemaOf = (name: string) => tools.find((tool) => tool.name === name)?.inputSchema;
    expect(inputSchemaOf("pi_session_start")).toMatchObject({ type: "object", required: ["workspace"], additionalProperties: false, properties: { workspace: { type: "string" }, executionProfile: { type: "string" } } });
    expect(inputSchemaOf("pi_session_list")).toMatchObject({ type: "object", properties: {}, additionalProperties: false });
    for (const name of ["pi_session_get", "pi_session_abort", "pi_session_close"]) expect(inputSchemaOf(name)).toMatchObject({ type: "object", required: ["sessionId"], additionalProperties: false, properties: { sessionId: { type: "string" } } });
    expect(inputSchemaOf("pi_session_prompt")).toMatchObject({ type: "object", required: ["sessionId", "prompt"], additionalProperties: false, properties: { sessionId: { type: "string" }, prompt: { type: "string" } } });
    expect(inputSchemaOf("pi_turn_get")).toMatchObject({ type: "object", required: ["sessionId", "turnId"], additionalProperties: false, properties: { sessionId: { type: "string" }, turnId: { type: "string" } } });
    expect(discovery?.outputSchema).toMatchObject({
      type: "object",
      required: ["ok", "server", "configuration", "workspaces", "executionProfiles"],
      additionalProperties: false,
      properties: {
        server: { additionalProperties: false },
        configuration: {
          type: "object",
          required: ["fingerprint", "reloadPolicy"],
          additionalProperties: false,
          properties: {
            fingerprint: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
            reloadPolicy: { type: "string", const: "restart-required" },
          },
        },
        workspaces: { items: { required: ["alias"], additionalProperties: false } },
        executionProfiles: {
          items: {
            required: ["alias", "default", "permissionProfile", "provider", "model", "thinkingLevel"],
            additionalProperties: false,
          },
        },
      },
    });
    const turnGet = tools.find((tool) => tool.name === "pi_turn_get"); expect(turnGet?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tools.find((tool) => tool.name === "pi_session_list")?.annotations?.readOnlyHint).toBe(true);
    for (const name of ["pi_session_prompt", "pi_session_abort", "pi_session_close"]) expect(tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(false);
  });

  it("discovers only deterministic configured capabilities without runtime calls", async () => {
    const connected = await client({}, {
      workspaces: new Map([
        ["zeta-workspace", "/private/WORKSPACE_PATH_SENTINEL/zeta"],
        ["alpha-workspace", "/private/API_KEY_SENTINEL/alpha"],
      ]),
      profiles: new Map<string, ConfiguredExecutionProfile>([
        ["zeta-profile", {
          alias: "zeta-profile", default: false, permissionProfile: "coding",
          provider: "provider-z", model: "model-z", thinkingLevel: "high",
        }],
        ["alpha-profile", {
          alias: "alpha-profile", default: true, permissionProfile: "read-only",
          provider: "provider-a", model: "model-a", thinkingLevel: "medium",
        }],
      ]),
      defaultExecutionProfile: "alpha-profile",
    });

    const registryList = vi.spyOn(connected.registry, "list");
    const discovered = await connected.client.callTool({ name: "pi_capabilities_get", arguments: {} });
    const discoveredAgain = await connected.client.callTool({ name: "pi_capabilities_get", arguments: {} });
    expect(discovered.structuredContent).toEqual({
      ok: true,
      server: { name: packageMetadata.name, version: packageMetadata.version },
      configuration: { fingerprint: TEST_CONFIGURATION.fingerprint, reloadPolicy: "restart-required" },
      workspaces: [{ alias: "alpha-workspace" }, { alias: "zeta-workspace" }],
      executionProfiles: [
        {
          alias: "alpha-profile", default: true, permissionProfile: "read-only",
          provider: "provider-a", model: "model-a", thinkingLevel: "medium",
        },
        {
          alias: "zeta-profile", default: false, permissionProfile: "coding",
          provider: "provider-z", model: "model-z", thinkingLevel: "high",
        },
      ],
    });
    expect(discoveredAgain.structuredContent).toEqual(discovered.structuredContent);
    expect((discovered.structuredContent as { server: unknown }).server).toEqual(connected.client.getServerVersion());
    expect(discovered.structuredContent).toMatchObject({ configuration: TEST_CONFIGURATION });
    expect(JSON.parse((discovered.content[0] as { text: string }).text)).toEqual(discovered.structuredContent);
    expect((discovered.structuredContent as { executionProfiles: Array<{ default: boolean }> }).executionProfiles.filter(({ default: isDefault }) => isDefault)).toHaveLength(1);
    expect(JSON.stringify(discovered)).not.toMatch(/private|WORKSPACE_PATH_SENTINEL|API_KEY_SENTINEL/);
    expect(connected.adapter.createInputs).toHaveLength(0);
    expect(connected.adapter.handles).toHaveLength(0);
    expect(registryList).not.toHaveBeenCalled();
  });

  it("strictly rejects capability discovery input without invoking runtime code", async () => {
    const connected = await client();
    const registryList = vi.spyOn(connected.registry, "list");
    const sentinel = "CAPABILITY_INPUT_SENTINEL";
    const rejected = await connected.client.callTool({
      name: "pi_capabilities_get",
      arguments: { unexpected: sentinel },
    });
    expect(rejected).toMatchObject({ isError: true });
    expect(JSON.stringify(rejected)).not.toContain(sentinel);
    expect(connected.adapter.createInputs).toHaveLength(0);
    expect(registryList).not.toHaveBeenCalled();
  });

  it("serves the loaded snapshot after the configuration file changes", async () => {
    const root = await temporaryRoot("pi-session-mcp-contract-");
    const configPath = join(root, "config.json");
    const profile = { default: true, permissionProfile: "read-only", provider: "fake-provider", model: "fake-model", thinkingLevel: "off" };
    await writeFile(configPath, JSON.stringify({ workspaces: { repo: "." }, executionProfiles: { safe: profile } }));
    const loaded = await loadConfig(configPath);
    const connected = await client({}, {
      workspaces: loaded.workspaces,
      profiles: loaded.executionProfiles,
      defaultExecutionProfile: loaded.defaultExecutionProfile,
      configuration: loaded.configuration,
    });
    await writeFile(configPath, JSON.stringify({ workspaces: { repo: ".", added: "./added" }, executionProfiles: {
      safe: { ...profile, provider: "changed-provider" },
      coding: { default: false, permissionProfile: "coding", provider: "changed-provider", model: "changed-model", thinkingLevel: "high" },
    } }));
    const discovered = await connected.client.callTool({ name: "pi_capabilities_get", arguments: {} });
    expect(discovered.structuredContent).toMatchObject({
      configuration: { fingerprint: loaded.configuration.fingerprint, reloadPolicy: "restart-required" },
      workspaces: [{ alias: "repo" }],
      executionProfiles: [{ alias: "safe", default: true, permissionProfile: "read-only", provider: "fake-provider", model: "fake-model", thinkingLevel: "off" }],
    });
    const started = await connected.client.callTool({ name: "pi_session_start", arguments: { workspace: "repo" } });
    expect(started.structuredContent).toMatchObject({ ok: true, session: { workspace: "repo", provider: "fake-provider", model: "fake-model" } });
  });

  const malformedMetadata: ReadonlyArray<readonly [string, unknown]> = [
    ["missing keys", {}],
    ["uppercase fingerprint", { fingerprint: `sha256:${"A".repeat(64)}`, reloadPolicy: "restart-required" }],
    ["wrong policy", { fingerprint: TEST_CONFIGURATION.fingerprint, reloadPolicy: "hot-reload" }],
  ];
  it.each(malformedMetadata)("rejects malformed configured metadata (%s) instead of projecting it", async (_label, configuration) => {
    // Test-only: a caller bypassing the config contract must not get a projection served.
    const connected = await client({}, { configuration: configuration as ConfigurationMetadata });
    const rejected = await connected.client.callTool({ name: "pi_capabilities_get", arguments: {} });
    expect(rejected).toMatchObject({ isError: true });
  });

  it("returns observable turn schema and safe errors", async () => {
    const connected = await client(); const started = await connected.client.callTool({ name: "pi_session_start", arguments: { workspace: "repo" } });
    const sessionId = (started.structuredContent as { session: { id: string } }).session.id; const prompted = await connected.client.callTool({ name: "pi_session_prompt", arguments: { sessionId, prompt: "read package.json" } });
    expect(prompted.structuredContent).toMatchObject({ ok: true, session: { id: sessionId }, turn: { sessionId, turnId: expect.any(String), state: "running" } });
    const turnId = (prompted.structuredContent as { turn: { turnId: string } }).turn.turnId; const turn = await connected.client.callTool({ name: "pi_turn_get", arguments: { sessionId, turnId } });
    expect(turn.structuredContent).toMatchObject({ ok: true, turn: { turnId, sessionId, state: "running" } });
  });

  it("exposes an aborted turn with completedAt while MCP close is pending", async () => {
    const connected = await client(); const started = await connected.client.callTool({ name: "pi_session_start", arguments: { workspace: "repo" } });
    const sessionId = (started.structuredContent as { session: { id: string } }).session.id; const prompted = await connected.client.callTool({ name: "pi_session_prompt", arguments: { sessionId, prompt: "close race" } });
    const turnId = (prompted.structuredContent as { turn: { turnId: string } }).turn.turnId; let release!: () => void; connected.adapter.handles[0]!.abortGate = new Promise<void>((resolve) => { release = resolve; });
    const closing = connected.client.callTool({ name: "pi_session_close", arguments: { sessionId } }); while (connected.adapter.handles[0]!.aborted < 1) await new Promise((resolve) => setTimeout(resolve, 0));
    const observed = await connected.client.callTool({ name: "pi_turn_get", arguments: { sessionId, turnId } }); expect(observed.structuredContent).toMatchObject({ ok: true, turn: { state: "aborted", completedAt: expect.any(String), turnId, sessionId } });
    release(); await closing;
  });

  it("validates terminal failed and aborted turn schemas without SDK fields", async () => {
    const connected = await client(); connected.adapter.plans.push({ prompts: [{ rejectDetail: "SECRET_PROVIDER_FAILURE" }, {}] }); const started = await connected.client.callTool({ name: "pi_session_start", arguments: { workspace: "repo" } });
    const sessionId = (started.structuredContent as { session: { id: string } }).session.id; const failedPrompt = await connected.client.callTool({ name: "pi_session_prompt", arguments: { sessionId, prompt: "fail" } }); const failedId = (failedPrompt.structuredContent as { turn: { turnId: string } }).turn.turnId; await new Promise((resolve) => setTimeout(resolve, 0));
    const failed = await connected.client.callTool({ name: "pi_turn_get", arguments: { sessionId, turnId: failedId } }); expect(failed.structuredContent).toMatchObject({ ok: true, turn: { state: "failed", error: { code: "turn_failed", message: "Pi turn failed" }, completedAt: expect.any(String) } }); expect(JSON.stringify(failed)).not.toContain("SECRET_PROVIDER_FAILURE");
    const abortedPrompt = await connected.client.callTool({ name: "pi_session_prompt", arguments: { sessionId, prompt: "abort" } }); const abortedId = (abortedPrompt.structuredContent as { turn: { turnId: string } }).turn.turnId; await connected.client.callTool({ name: "pi_session_abort", arguments: { sessionId } });
    const aborted = await connected.client.callTool({ name: "pi_turn_get", arguments: { sessionId, turnId: abortedId } }); expect(aborted.structuredContent).toMatchObject({ ok: true, turn: { state: "aborted", completedAt: expect.any(String) } });
  });

  it("reports a generic abort failure while keeping the turn occupied", async () => {
    const connected = await client(); const started = await connected.client.callTool({ name: "pi_session_start", arguments: { workspace: "repo" } }); const sessionId = (started.structuredContent as { session: { id: string } }).session.id;
    const prompted = await connected.client.callTool({ name: "pi_session_prompt", arguments: { sessionId, prompt: "abort failure" } }); const turnId = (prompted.structuredContent as { turn: { turnId: string } }).turn.turnId;
    connected.adapter.handles[0]!.abortError = new Error("SECRET_ABORT_FAILURE"); const aborted = await connected.client.callTool({ name: "pi_session_abort", arguments: { sessionId } });
    expect(aborted).toMatchObject({ isError: true, structuredContent: { ok: false, error: { code: "abort_failed", message: "Pi abort failed" } } }); expect(JSON.stringify(aborted)).not.toContain("SECRET_ABORT_FAILURE");
    const session = await connected.client.callTool({ name: "pi_session_get", arguments: { sessionId } }); expect(session.structuredContent).toMatchObject({ ok: true, session: { state: "running" } });
    const second = await connected.client.callTool({ name: "pi_session_prompt", arguments: { sessionId, prompt: "must remain blocked" } }); expect(second).toMatchObject({ isError: true, structuredContent: { error: { code: "session_running" } } });
    connected.adapter.handles[0]!.complete("eventual completion"); await new Promise((resolve) => setTimeout(resolve, 0)); const completed = await connected.client.callTool({ name: "pi_turn_get", arguments: { sessionId, turnId } }); expect(completed.structuredContent).toMatchObject({ ok: true, turn: { state: "completed", assistantText: "eventual completion" } });
  });

  it("projects distinct sanitized preflight and abort deadline errors", async () => {
    vi.useFakeTimers();
    try {
      const connected = await client({ preflightDeadlineMs: 10, abortDeadlineMs: 10, closeCleanupDeadlineMs: 10, shutdownDeadlineMs: 30 });
      connected.adapter.plans.push({ manualPreflight: true });
      const first = await connected.client.callTool({ name: "pi_session_start", arguments: { workspace: "repo" } });
      const firstId = (first.structuredContent as { session: { id: string } }).session.id;
      const promptSentinel = "PRIVATE_PREFLIGHT_PROMPT_SENTINEL";
      const prompting = connected.client.callTool({ name: "pi_session_prompt", arguments: { sessionId: firstId, prompt: promptSentinel } });
      await vi.advanceTimersByTimeAsync(10);
      const timedOutPrompt = await prompting;
      expect(timedOutPrompt).toMatchObject({ isError: true, structuredContent: { ok: false, error: {
        code: "prompt_timeout", message: "Pi prompt preflight timed out",
      } } });
      expect(JSON.stringify(timedOutPrompt)).not.toContain(promptSentinel);
      await connected.client.callTool({ name: "pi_session_close", arguments: { sessionId: firstId } });

      const second = await connected.client.callTool({ name: "pi_session_start", arguments: { workspace: "repo" } });
      const secondId = (second.structuredContent as { session: { id: string } }).session.id;
      await connected.client.callTool({ name: "pi_session_prompt", arguments: { sessionId: secondId, prompt: "abort deadline" } });
      connected.adapter.handles[1]!.abortGate = new Promise<void>(() => undefined);
      const aborting = connected.client.callTool({ name: "pi_session_abort", arguments: { sessionId: secondId } });
      await vi.advanceTimersByTimeAsync(10);
      const timedOutAbort = await aborting;
      expect(timedOutAbort).toMatchObject({ isError: true, structuredContent: { ok: false, error: {
        code: "abort_timeout", message: "Pi abort timed out",
      } } });
      const closing = connected.client.callTool({ name: "pi_session_close", arguments: { sessionId: secondId } });
      await vi.advanceTimersByTimeAsync(10);
      await closing;
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains generic structured error shape", async () => {
    const connected = await client(); const failed = await connected.client.callTool({ name: "pi_session_start", arguments: { workspace: "missing" } });
    expect(failed).toMatchObject({ isError: true, structuredContent: { ok: false, error: { code: "unknown_workspace" } } });
    const started = await connected.client.callTool({ name: "pi_session_start", arguments: { workspace: "repo" } });
    expect(started.structuredContent).toMatchObject({ ok: true, session: { workspace: "repo", profile: "read-only", state: "idle" } });
  });

  it("maps the shutdown admission gate to a stable sanitized MCP error", async () => {
    const connected = await client();
    await connected.registry.shutdown();
    const failed = await connected.client.callTool({ name: "pi_session_start", arguments: { workspace: "repo" } });
    expect(failed).toMatchObject({ isError: true, structuredContent: { ok: false, error: {
      code: "server_stopping", message: "Server is shutting down",
    } } });
    expect(connected.adapter.createInputs).toHaveLength(0);
  });

  it("does not echo unknown valid session or turn identifiers", async () => {
    const connected = await client();
    const sessionSentinel = crypto.randomUUID();
    const unknownSession = await connected.client.callTool({ name: "pi_session_get", arguments: { sessionId: sessionSentinel } });
    expect(unknownSession).toMatchObject({ isError: true, structuredContent: { error: { code: "unknown_session", message: "Unknown session" } } });
    expect(JSON.stringify(unknownSession)).not.toContain(sessionSentinel);

    const started = await connected.client.callTool({ name: "pi_session_start", arguments: { workspace: "repo" } });
    const sessionId = (started.structuredContent as { session: { id: string } }).session.id;
    const turnSentinel = crypto.randomUUID();
    const unknownTurn = await connected.client.callTool({ name: "pi_turn_get", arguments: { sessionId, turnId: turnSentinel } });
    expect(unknownTurn).toMatchObject({ isError: true, structuredContent: { error: { code: "unknown_turn", message: "Unknown turn" } } });
    expect(JSON.stringify(unknownTurn)).not.toContain(turnSentinel);
  });

  it("resolves default and explicit execution aliases server-side", async () => {
    const connected = await client();
    const defaultSession = await connected.client.callTool({ name: "pi_session_start", arguments: { workspace: "repo" } });
    expect(defaultSession.structuredContent).toMatchObject({ ok: true, session: { executionProfile: "safe", profile: "read-only", provider: "fake-provider", model: "fake-model", thinkingLevel: "off" } });
    const explicit = await connected.client.callTool({ name: "pi_session_start", arguments: { workspace: "repo", executionProfile: "coding" } });
    expect(explicit.structuredContent).toMatchObject({ ok: true, session: { executionProfile: "coding", profile: "coding", thinkingLevel: "high" } });
    expect(connected.adapter.createInputs.map(({ executionProfile }) => executionProfile.alias)).toEqual(["safe", "coding"]);
  });

  it("rejects unknown aliases before adapter creation", async () => {
    const connected = await client();
    const failed = await connected.client.callTool({ name: "pi_session_start", arguments: { workspace: "repo", executionProfile: "missing" } });
    expect(failed).toMatchObject({ isError: true, structuredContent: { ok: false, error: { code: "unknown_execution_profile", message: "Unknown execution profile" } } });
    expect(connected.adapter.createInputs).toHaveLength(0);
  });

  it("rejects malformed workspace aliases in the MCP schema and keeps unknown valid aliases sanitized", async () => {
    const connected = await client();
    const malformed = "INVALID_WORKSPACE_SENTINEL";
    const invalid = await connected.client.callTool({ name: "pi_session_start", arguments: { workspace: malformed } });
    expect(invalid).toMatchObject({ isError: true });
    expect(JSON.stringify(invalid)).not.toContain(malformed);
    expect(connected.adapter.createInputs).toHaveLength(0);

    const unknown = "unknown-workspace";
    const missing = await connected.client.callTool({ name: "pi_session_start", arguments: { workspace: unknown } });
    expect(missing).toMatchObject({ isError: true, structuredContent: { ok: false, error: {
      code: "unknown_workspace", message: "Unknown workspace",
    } } });
    expect(JSON.stringify(missing)).not.toContain(unknown);
    expect(connected.adapter.createInputs).toHaveLength(0);
  });

  it("strictly rejects legacy, raw selection, credential, and unknown start fields", async () => {
    const connected = await client();
    const sentinel = "SECRET_MCP_SENTINEL";
    for (const field of ["profile", "provider", "model", "thinkingLevel", "apiKey", "token", "accessToken", "oauthToken", "credential", "credentials", "other"]) {
      const failed = await connected.client.callTool({ name: "pi_session_start", arguments: { workspace: "repo", [field]: sentinel } });
      expect(failed).toMatchObject({ isError: true });
      expect(JSON.stringify(failed)).not.toContain(sentinel);
      expect(String(failed)).not.toContain(sentinel);
    }
    expect(connected.adapter.createInputs).toHaveLength(0);
  });

  it.each([
    ["unknown_provider", "Execution profile provider is not in the local Pi catalog"],
    ["external_mcp_unavailable", "Configured external MCP tools are unavailable"],
    ["external_mcp_no_tools", "Configured external MCP server returned no tools"],
    ["external_mcp_grant_tool_missing", "Configured external MCP grant is missing from discovery"],
    ["external_mcp_activation_mismatch", "Configured external MCP tools could not be activated"],
  ] as const)("projects %s with consistent sanitized public representations", async (code, message) => {
    const connected = await client();
    const sentinel = "SECRET_PRIVATE_PATH_CHILD_STDERR";
    const creationError = Object.assign(new PiSessionCreationError(code), {
      cause: sentinel,
      stderr: sentinel,
      command: `/private/${sentinel}`,
    });
    connected.adapter.plans.push({ creationError });
    const failed = await connected.client.callTool({ name: "pi_session_start", arguments: { workspace: "repo" } });
    expect(failed).toMatchObject({ isError: true, structuredContent: { ok: false, error: { code, message } } });
    const text = failed.content[0];
    expect(text?.type).toBe("text");
    if (!text || text.type !== "text") throw new Error("Expected a text MCP result");
    expect(JSON.parse(text.text)).toEqual(failed.structuredContent);
    expect(JSON.stringify(failed)).not.toContain(sentinel);
  });
});

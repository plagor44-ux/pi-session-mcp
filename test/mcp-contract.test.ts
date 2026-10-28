import { z } from "zod";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";
import { SessionRegistry, type SessionRegistryOptions } from "../src/session-registry.js";
import { FakeAdapter } from "./fake-adapter.js";
import { PiSessionCreationError, WriterUnavailableError } from "../src/pi-adapter.js";
import packageMetadata from "../package.json" with { type: "json" };
import { loadConfig, type ConfigurationMetadata } from "../src/config.js";
import type { WorkspaceModeEntry } from "../src/execution-modes.js";
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
    workspaceModes?: ReadonlyMap<string, WorkspaceModeEntry>;
    eventDelivery?: "spool" | "off";
    relay?: boolean;
  } = {}) {
    const workspaces = fixtures.workspaces ?? new Map([["repo", "/safe/repo"]]);
    const adapter = new FakeAdapter(); const registry = new SessionRegistry(adapter, workspaces, registryOptions);
    const profiles = fixtures.profiles ?? new Map([
      ["safe", { alias: "safe", default: true, permissionProfile: "read-only" as const, provider: "fake-provider", model: "fake-model", thinkingLevel: "off" as const }],
      ["coding", { alias: "coding", default: false, permissionProfile: "coding" as const, provider: "fake-provider", model: "fake-model", thinkingLevel: "high" as const }],
    ]);
    const server = createServer(registry, workspaces, profiles, fixtures.defaultExecutionProfile ?? "safe", fixtures.configuration ?? TEST_CONFIGURATION, fixtures.workspaceModes, fixtures.eventDelivery, fixtures.relay);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: "contract-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]); closers.push(async () => { await client.close(); await server.close(); await registry.shutdown(); }); return { client, adapter, registry };
  }

  it.each([
    ["container", "safe"], ["host", "coding"], ["read-only", "coding"], ["unset", "coding"],
  ] as const)("rejects base for %s / %s before creation", async (mode, executionProfile) => {
    const connected = await client({}, { workspaceModes: new Map([["repo", { mode }]]) });
    const response = await connected.client.callTool({ name: "pi_session_start", arguments: { workspace: "repo", executionProfile, base: "dev" } });
    expect(response.structuredContent).toMatchObject({ ok: false, error: { code: "base_not_applicable" } });
    expect(connected.adapter.createInputs).toHaveLength(0);
  });

  it("allows container coding with relay and passes base", async () => {
    const connected = await client({}, { workspaceModes: new Map([["repo", { mode: "container" }]]), relay: true });
    const response = await connected.client.callTool({ name: "pi_session_start", arguments: { workspace: "repo", executionProfile: "coding", base: "dev" } });
    expect(response.structuredContent).toMatchObject({ ok: true });
    expect(connected.adapter.createInputs[0]).toMatchObject({ workspace: "repo", base: "dev" });
  });

  it("checks unknown_execution_profile before base applicability", async () => {
    const connected = await client();
    const response = await connected.client.callTool({ name: "pi_session_start", arguments: { workspace: "repo", executionProfile: "missing", base: "dev" } });
    expect(response.structuredContent).toMatchObject({ ok: false, error: { code: "unknown_execution_profile" } });
    expect(connected.adapter.createInputs).toHaveLength(0);
  });

  it.each(["", "HEAD", "refs/heads/main", "a".repeat(40), "a".repeat(64), "../x"])("rejects invalid base %s at schema validation", async (base) => {
    const connected = await client({}, { workspaceModes: new Map([["repo", { mode: "container" }]]), relay: true });
    const response = await connected.client.callTool({ name: "pi_session_start", arguments: { workspace: "repo", executionProfile: "coding", base } });
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toBeUndefined();
    expect(connected.adapter.createInputs).toHaveLength(0);
  });

  it.each(["none_ready", "none_at_base"] as const)("writer_unavailable omits absent counts for %s", async (reason) => {
    const connected = await client();
    connected.adapter.plans.push({ creationError: new WriterUnavailableError(reason) });
    const response = await connected.client.callTool({ name: "pi_session_start", arguments: { workspace: "repo" } });
    expect(response.structuredContent).toEqual({ ok: false, error: { code: "writer_unavailable", message: "No writer is available", reason } });
  });

  it("writer_unavailable carries reason and counts", async () => {
    const connected = await client();
    const counts = { busy: 1, notAtBaseline: 2, settingsChanged: 3 };
    connected.adapter.plans.push({ creationError: new WriterUnavailableError("none_admitted", counts) });
    const response = await connected.client.callTool({ name: "pi_session_start", arguments: { workspace: "repo" } });
    expect(response.structuredContent).toEqual({ ok: false, error: { code: "writer_unavailable", message: "No writer is available", reason: "none_admitted", counts } });
  });

  const modeProfiles = new Map<string, ConfiguredExecutionProfile>([
    ["code", { alias: "code", default: true, permissionProfile: "coding", provider: "fake-provider", model: "fake-model", thinkingLevel: "off" }],
    ["review", { alias: "review", default: false, permissionProfile: "read-only", provider: "fake-provider", model: "fake-model", thinkingLevel: "off" }],
  ]);

  it.each(["container", "read-only"] as const)("refuses a coding start on a %s workspace without creating a session", async (mode) => {
    const connected = await client({}, {
      workspaces: new Map([["a", "/safe/a"]]), profiles: modeProfiles, defaultExecutionProfile: "code",
      workspaceModes: new Map([["a", { mode }]]),
    });
    const start = vi.spyOn(connected.registry, "start");
    for (const args of [{ workspace: "a", executionProfile: "code" }, { workspace: "a" }]) {
      const refused = await connected.client.callTool({ name: "pi_session_start", arguments: args });
      expect(refused).toMatchObject({ isError: true, structuredContent: { ok: false, error: {
        code: "workspace_mode_forbids_coding",
        message: "The workspace's execution mode does not allow coding sessions on this server",
      } } });
    }
    expect(start).not.toHaveBeenCalled();
    expect(connected.adapter.createInputs).toHaveLength(0);
    const listed = await connected.client.callTool({ name: "pi_session_list", arguments: {} });
    expect(listed.structuredContent).toEqual({ ok: true, sessions: [] });
  });

  it.each(["container", "read-only", "unset", "host"] as const)("allows read-only profiles on %s workspaces", async (mode) => {
    const connected = await client({}, {
      workspaceModes: new Map([["repo", { mode }]]), profiles: modeProfiles, defaultExecutionProfile: "code",
    });
    const started = await connected.client.callTool({ name: "pi_session_start", arguments: { workspace: "repo", executionProfile: "review" } });
    expect(started.structuredContent).toMatchObject({ ok: true, session: { profile: "read-only" } });
    expect(connected.adapter.createInputs).toHaveLength(1);
  });

  it.each([undefined, "unset", "host"] as const)("unset and host keep today's behavior (%s)", async (mode) => {
    const connected = await client({}, {
      workspaceModes: mode === undefined ? new Map() : new Map([["repo", { mode }]]),
      profiles: modeProfiles, defaultExecutionProfile: "code",
    });
    const started = await connected.client.callTool({ name: "pi_session_start", arguments: { workspace: "repo", executionProfile: "code" } });
    expect(started.structuredContent).toMatchObject({ ok: true, session: { profile: "coding" } });
    expect(connected.adapter.createInputs).toHaveLength(1);
  });

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
    expect(inputSchemaOf("pi_session_start")).toMatchObject({ type: "object", required: ["workspace"], additionalProperties: false, properties: { workspace: { type: "string" }, executionProfile: { type: "string" }, base: { type: "string" } } });
    expect(inputSchemaOf("pi_session_list")).toMatchObject({ type: "object", properties: {}, additionalProperties: false });
    for (const name of ["pi_session_get", "pi_session_abort", "pi_session_close"]) expect(inputSchemaOf(name)).toMatchObject({ type: "object", required: ["sessionId"], additionalProperties: false, properties: { sessionId: { type: "string" } } });
    expect(inputSchemaOf("pi_session_prompt")).toMatchObject({ type: "object", required: ["sessionId", "prompt"], additionalProperties: false, properties: { sessionId: { type: "string" }, prompt: { type: "string" } } });
    expect(inputSchemaOf("pi_turn_get")).toMatchObject({ type: "object", required: ["sessionId", "turnId"], additionalProperties: false, properties: { sessionId: { type: "string" }, turnId: { type: "string" } } });
    expect(discovery?.outputSchema).toMatchObject({
      type: "object",
      required: ["ok", "server", "configuration", "events", "workspaces", "executionProfiles"],
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
        events: { type: "object", required: ["delivery"], additionalProperties: false, properties: { delivery: { enum: ["spool", "off"] } } },
        workspaces: { items: { required: ["alias", "mode"], additionalProperties: false, properties: { mode: { enum: ["unset", "host", "container", "read-only"] } } } },
        executionProfiles: {
          items: {
            required: ["alias", "default", "permissionProfile", "provider", "model", "thinkingLevel", "extensions", "grantedExtensionTools", "shell", "skills"],
            properties: { grantedExtensionTools: { type: "array", items: { type: "string" } }, shell: { enum: ["none", "sandboxed"] } },
            additionalProperties: false,
          },
        },
      },
    });
    const turnGet = tools.find((tool) => tool.name === "pi_turn_get"); expect(turnGet?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tools.find((tool) => tool.name === "pi_session_list")?.annotations?.readOnlyHint).toBe(true);
    for (const name of ["pi_session_prompt", "pi_session_abort", "pi_session_close"]) expect(tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(false);
  });

  it("requires extension tool grants in the advertised capabilities output schema", async () => {
    const connected = await client({}, { profiles: new Map([["safe", {
      alias: "safe", default: true, permissionProfile: "read-only", provider: "fake-provider", model: "fake-model", thinkingLevel: "off",
      extensions: [{ spec: "npm:ext@1.0.0", name: "ext", version: "1.0.0" }],
      grantedExtensionTools: ["zeta_lookup", "alpha_lookup"],
    }]]) });
    const discovery = (await connected.client.listTools()).tools.find(({ name }) => name === "pi_capabilities_get")!;
    const schema = z.fromJSONSchema(discovery.outputSchema! as Parameters<typeof z.fromJSONSchema>[0]);
    const response = await connected.client.callTool({ name: "pi_capabilities_get", arguments: {} });
    expect(response.structuredContent).toMatchObject({ executionProfiles: [{ grantedExtensionTools: ["zeta_lookup", "alpha_lookup"] }] });
    expect(schema.safeParse(response.structuredContent).success).toBe(true);
    const missing = structuredClone(response.structuredContent) as { executionProfiles: Array<Record<string, unknown>> };
    delete missing.executionProfiles[0]!.grantedExtensionTools;
    expect(schema.safeParse(missing).success).toBe(false);
  });

  it("publishes short behavior hints in the tool descriptions", async () => {
    const connected = await client();
    const descriptions = Object.fromEntries((await connected.client.listTools()).tools.map(({ name, description }) => [name, description]));
    expect(descriptions).toEqual({
      pi_capabilities_get: "List configured workspace and execution-profile aliases. This reports configured intent, not provider or runtime availability. Call once at the start of a run.",
      pi_session_start: "Start a managed embedded Pi session for a configured workspace alias.",
      pi_session_list: "List local Pi sessions and their state.",
      pi_session_get: "Get one local Pi session by ID.",
      pi_session_prompt: "Accept a prompt after Pi preflight and run the turn in the background. Returns a running turn at once; poll pi_turn_get with pauses.",
      pi_session_abort: "Abort a running Pi turn; idle sessions are unchanged.",
      pi_session_close: "Abort if needed, dispose, and remove a Pi session. Idempotent; close every started session.",
      pi_turn_get: "Get the normalized observable result of a Pi turn. completed, failed and aborted are terminal and never change: read a terminal turn once. completed is not task success.",
    });
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
      workspaceModes: new Map([["alpha-workspace", { mode: "container", container: { writers: 2, lifecycle: "persistent", profiles: ["zeta-profile"], image: "node", network: "pasta", cache: "none", tags: "none", clean: "untracked" } }]]),
    });

    const registryList = vi.spyOn(connected.registry, "list");
    const discovered = await connected.client.callTool({ name: "pi_capabilities_get", arguments: {} });
    const discoveredAgain = await connected.client.callTool({ name: "pi_capabilities_get", arguments: {} });
    expect(discovered.structuredContent).toEqual({
      ok: true,
      server: { name: packageMetadata.name, version: packageMetadata.version },
      configuration: { fingerprint: TEST_CONFIGURATION.fingerprint, reloadPolicy: "restart-required" },
      events: { delivery: "off" },
      workspaces: [{ alias: "alpha-workspace", mode: "container", writers: 2, defaultBase: null }, { alias: "zeta-workspace", mode: "unset" }],
      executionProfiles: [
        {
          alias: "alpha-profile", default: true, permissionProfile: "read-only",
          provider: "provider-a", model: "model-a", thinkingLevel: "medium", extensions: [], grantedExtensionTools: [], shell: "none", skills: [],
        },
        {
          alias: "zeta-profile", default: false, permissionProfile: "coding",
          provider: "provider-z", model: "model-z", thinkingLevel: "high", extensions: [], grantedExtensionTools: [], shell: "none", skills: [],
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

  it("reports the configured event delivery", async () => {
    const connected = await client({}, { eventDelivery: "spool" });
    const discovered = await connected.client.callTool({ name: "pi_capabilities_get", arguments: {} });
    expect(discovered.structuredContent).toMatchObject({ events: { delivery: "spool" } });
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
    expect(failed.structuredContent).toEqual({ ok: false, error: { code: "unknown_workspace", message: "Unknown workspace" } });
    expect(failed.isError).toBe(true);
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

  it("keeps strict UUID input validation while the input schemas omit the repeated pattern", async () => {
    const connected = await client();
    const tools = (await connected.client.listTools()).tools;
    const fields: Array<[string, string]> = [
      ["pi_session_get", "sessionId"], ["pi_session_prompt", "sessionId"], ["pi_session_abort", "sessionId"],
      ["pi_session_close", "sessionId"], ["pi_turn_get", "sessionId"], ["pi_turn_get", "turnId"],
    ];
    for (const [tool, field] of fields) {
      const properties = (tools.find(({ name }) => name === tool)?.inputSchema as { properties: Record<string, unknown> }).properties;
      expect(properties[field]).toEqual({ type: "string", format: "uuid" });
    }

    const started = await connected.client.callTool({ name: "pi_session_start", arguments: { workspace: "repo" } });
    const sessionId = (started.structuredContent as { session: { id: string } }).session.id;
    const prompted = await connected.client.callTool({ name: "pi_session_prompt", arguments: { sessionId, prompt: "pin" } });
    const turnId = (prompted.structuredContent as { turn: { turnId: string } }).turn.turnId;
    const observe = async () => JSON.stringify([
      (await connected.client.callTool({ name: "pi_session_list", arguments: {} })).structuredContent,
      (await connected.client.callTool({ name: "pi_turn_get", arguments: { sessionId, turnId } })).structuredContent,
    ]);
    const before = await observe();

    const unknown = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const accepted = [unknown, unknown.toUpperCase(), "00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff"];
    const rejected: unknown[] = [
      "", "not-a-uuid", unknown.slice(0, -1), `${unknown}a`, unknown.replaceAll("-", ""), `${unknown}\n`,
      "aaaaaaaa-aaaa-0aaa-8aaa-aaaaaaaaaaaa", "aaaaaaaa-aaaa-9aaa-8aaa-aaaaaaaaaaaa", "aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa",
      "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF", 1, null, true, {}, [unknown],
    ];
    for (const [tool, field] of fields) {
      const call = (value: unknown) => connected.client.callTool({
        name: tool,
        arguments: { sessionId: field === "turnId" ? sessionId : unknown, ...(tool === "pi_turn_get" ? { turnId: unknown } : {}), ...(tool === "pi_session_prompt" ? { prompt: "p" } : {}), [field]: value },
      });
      for (const value of accepted) {
        // Valid UUIDs reach the registry and yield its domain error, never an input-validation error.
        expect(await call(value), `${tool}.${field} ${String(value)}`).toMatchObject({ isError: true, structuredContent: { ok: false, error: { code: field === "turnId" ? "unknown_turn" : "unknown_session" } } });
      }
      for (const value of rejected) {
        const response = await call(value);
        expect(response, `${tool}.${field} ${JSON.stringify(value)}`).toMatchObject({ isError: true });
        expect(response.structuredContent).toBeUndefined();
        expect(JSON.stringify(response.content)).toContain(`Input validation error: Invalid arguments for tool ${tool}: ${field}: `);
      }
    }
    expect(await observe()).toBe(before);
    expect(connected.adapter.handles).toHaveLength(1);
    expect(connected.adapter.handles[0]!.aborted).toBe(0);
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
    ["skill_load_failed", "Configured Pi skill could not be loaded"],
    ["sandbox_unavailable", "Read-only shell sandbox is not available"],
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

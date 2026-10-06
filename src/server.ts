import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import packageMetadata from "../package.json" with { type: "json" };
import { projectCapabilities } from "./capabilities.js";
import { CONFIGURATION_FINGERPRINT_PATTERN, RELOAD_POLICY, type ConfigurationMetadata } from "./config.js";
import { PiSessionCreationError } from "./pi-adapter.js";
import { ALIAS_PATTERN, toResolvedExecutionProfile, type ConfiguredExecutionProfile } from "./execution-profile.js";
import { RegistryError, type SessionRegistry } from "./session-registry.js";

const thinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const viewSchema = z.object({
  id: z.string(), workspace: z.string(), executionProfile: z.string(), profile: z.enum(["read-only", "coding"]),
  provider: z.string(), model: z.string(), thinkingLevel: thinkingLevelSchema,
  state: z.enum(["idle", "running", "failed", "closing", "closed"]), createdAt: z.string(), updatedAt: z.string(),
  lastError: z.string().optional(),
});
const aliasSchema = z.string().regex(ALIAS_PATTERN);
const successSchema = z.object({ ok: z.literal(true), session: viewSchema });
const turnBase = { turnId: z.string().uuid(), sessionId: z.string().uuid(), startedAt: z.string(), updatedAt: z.string() };
const turnSchema = z.discriminatedUnion("state", [
  z.object({ ...turnBase, state: z.literal("running") }),
  z.object({ ...turnBase, state: z.literal("completed"), completedAt: z.string(), assistantText: z.string(), truncated: z.boolean() }),
  z.object({ ...turnBase, state: z.literal("failed"), completedAt: z.string(), error: z.object({ code: z.literal("turn_failed"), message: z.literal("Pi turn failed") }) }),
  z.object({ ...turnBase, state: z.literal("aborted"), completedAt: z.string() }),
]);
const promptSuccessSchema = z.object({ ok: z.literal(true), session: viewSchema, turn: turnSchema });
const turnSuccessSchema = z.object({ ok: z.literal(true), turn: turnSchema });
const listSchema = z.object({ ok: z.literal(true), sessions: z.array(viewSchema) });
const errorSchema = z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) });
const capabilitiesSchema = z.object({
  ok: z.literal(true),
  server: z.object({ name: z.literal(packageMetadata.name), version: z.literal(packageMetadata.version) }).strict(),
  configuration: z.object({
    fingerprint: z.string().regex(CONFIGURATION_FINGERPRINT_PATTERN),
    reloadPolicy: z.literal(RELOAD_POLICY),
  }).strict(),
  workspaces: z.array(z.object({ alias: aliasSchema }).strict()),
  executionProfiles: z.array(z.object({
    alias: aliasSchema,
    default: z.boolean(),
    permissionProfile: z.enum(["read-only", "coding"]),
    provider: z.string(),
    model: z.string(),
    thinkingLevel: thinkingLevelSchema,
  }).strict()),
}).strict();

function result<T extends Record<string, unknown>>(value: T, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError: true } : {}) };
}
async function safe(action: () => Promise<Record<string, unknown>> | Record<string, unknown>) {
  try { return result(await action()); }
  catch (error) {
    const known = error instanceof RegistryError || error instanceof PiSessionCreationError;
    return result({ ok: false, error: { code: known ? error.code : "internal_error", message: known ? error.message : "Operation failed" } }, true);
  }
}

export function createServer(
  registry: SessionRegistry,
  workspaces: ReadonlyMap<string, string>,
  executionProfiles: ReadonlyMap<string, ConfiguredExecutionProfile>,
  defaultExecutionProfile: string,
  configuration: ConfigurationMetadata,
): McpServer {
  const server = new McpServer({ name: packageMetadata.name, version: packageMetadata.version }, { capabilities: { tools: {} } });
  server.registerTool("pi_capabilities_get", {
    description: "List configured workspace and execution-profile aliases. This reports configured intent, not provider or runtime availability.",
    inputSchema: z.object({}).strict(),
    outputSchema: capabilitiesSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, () => result(projectCapabilities(workspaces, executionProfiles, configuration)));
  server.registerTool("pi_session_start", {
    description: "Start a managed embedded Pi session for a configured workspace alias.",
    inputSchema: z.object({ workspace: aliasSchema, executionProfile: aliasSchema.optional() }).strict(), outputSchema: z.union([successSchema, errorSchema]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, ({ workspace, executionProfile }) => safe(async () => {
    const alias = executionProfile ?? defaultExecutionProfile;
    const configured = executionProfiles.get(alias);
    if (!configured) throw new RegistryError("unknown_execution_profile");
    return { ok: true, session: await registry.start(workspace, toResolvedExecutionProfile(configured)) };
  }));
  server.registerTool("pi_session_list", {
    description: "List local Pi sessions and their state.", inputSchema: z.object({}).strict(), outputSchema: z.union([listSchema, errorSchema]),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, () => safe(() => ({ ok: true, sessions: registry.list() })));
  server.registerTool("pi_session_get", {
    description: "Get one local Pi session by ID.", inputSchema: z.object({ sessionId: z.string().uuid() }).strict(), outputSchema: z.union([successSchema, errorSchema]),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ sessionId }) => safe(() => ({ ok: true, session: registry.get(sessionId) })));
  server.registerTool("pi_session_prompt", {
    description: "Accept a prompt after Pi preflight and run the turn in the background.", inputSchema: z.object({ sessionId: z.string().uuid(), prompt: z.string().min(1).max(100_000) }).strict(), outputSchema: z.union([promptSuccessSchema, errorSchema]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, ({ sessionId, prompt }) => safe(async () => ({ ok: true, ...(await registry.prompt(sessionId, prompt)) })));
  server.registerTool("pi_session_abort", {
    description: "Abort a running Pi turn; idle sessions are unchanged.", inputSchema: z.object({ sessionId: z.string().uuid() }).strict(), outputSchema: z.union([successSchema, errorSchema]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, ({ sessionId }) => safe(async () => ({ ok: true, session: await registry.abort(sessionId) })));
  server.registerTool("pi_session_close", {
    description: "Abort if needed, dispose, and remove a Pi session.", inputSchema: z.object({ sessionId: z.string().uuid() }).strict(), outputSchema: z.union([successSchema, errorSchema]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, ({ sessionId }) => safe(async () => ({ ok: true, session: await registry.close(sessionId) })));
  server.registerTool("pi_turn_get", {
    description: "Get the normalized observable result of a Pi turn.", inputSchema: z.object({ sessionId: z.string().uuid(), turnId: z.string().uuid() }).strict(), outputSchema: z.union([turnSuccessSchema, errorSchema]),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ sessionId, turnId }) => safe(() => ({ ok: true, turn: registry.getTurn(sessionId, turnId) })));
  return server;
}

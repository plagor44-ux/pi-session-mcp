import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import packageMetadata from "../package.json" with { type: "json" };
import { projectCapabilities } from "./capabilities.js";
import type { ConfigurationMetadata } from "./config.js";
import { codingAllowed, isShortBranchName, type WorkspaceModeEntry } from "./execution-modes.js";
import { PiSessionCreationError, WriterUnavailableError } from "./pi-adapter.js";
import { toResolvedExecutionProfile, type ConfiguredExecutionProfile } from "./execution-profile.js";
import { RegistryError, type SessionRegistry } from "./session-registry.js";
import { aliasSchema, idInputSchema, successSchema, promptSuccessSchema, turnSuccessSchema, listSchema, errorSchema, capabilitiesSchema } from "./tool-schemas.js";

function result<T extends Record<string, unknown>>(value: T, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError: true } : {}) };
}
async function safe(action: () => Promise<Record<string, unknown>> | Record<string, unknown>) {
  try { return result(await action()); }
  catch (error) {
    if (error instanceof WriterUnavailableError) {
      return result({ ok: false, error: { code: error.code, message: error.message, reason: error.reason, ...(error.counts === undefined ? {} : { counts: error.counts }) } }, true);
    }
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
  workspaceModes: ReadonlyMap<string, WorkspaceModeEntry> = new Map(),
  eventDelivery: "spool" | "off" = "off",
  relay = false,
): McpServer {
  const server = new McpServer({ name: packageMetadata.name, version: packageMetadata.version }, { capabilities: { tools: {} } });
  server.registerTool("pi_capabilities_get", {
    description: "List configured workspace and execution-profile aliases. This reports configured intent, not provider or runtime availability. Call once at the start of a run.",
    inputSchema: z.object({}).strict(),
    outputSchema: capabilitiesSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, () => result(projectCapabilities(workspaces, executionProfiles, configuration, workspaceModes, eventDelivery)));
  server.registerTool("pi_session_start", {
    description: "Start a managed embedded Pi session for a configured workspace alias.",
    inputSchema: z.object({ workspace: aliasSchema, executionProfile: aliasSchema.optional(), base: z.string().refine(isShortBranchName).optional() }).strict(), outputSchema: z.union([successSchema, errorSchema]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, ({ workspace, executionProfile, base }) => safe(async () => {
    const alias = executionProfile ?? defaultExecutionProfile;
    const configured = executionProfiles.get(alias);
    if (!configured) throw new RegistryError("unknown_execution_profile");
    if (!workspaces.has(workspace)) throw new RegistryError("unknown_workspace");
    const mode = workspaceModes.get(workspace) ?? { mode: "unset" };
    if (base !== undefined && (configured.permissionProfile !== "coding" || mode.mode !== "container")) {
      throw new RegistryError("base_not_applicable");
    }
    if (configured.permissionProfile === "coding" && !codingAllowed(mode, relay)) {
      throw new RegistryError("workspace_mode_forbids_coding");
    }
    return { ok: true, session: await registry.start(workspace, toResolvedExecutionProfile(configured), base === undefined ? {} : { base }) };
  }));
  server.registerTool("pi_session_list", {
    description: "List local Pi sessions and their state.", inputSchema: z.object({}).strict(), outputSchema: z.union([listSchema, errorSchema]),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, () => safe(() => ({ ok: true, sessions: registry.list() })));
  server.registerTool("pi_session_get", {
    description: "Get one local Pi session by ID.", inputSchema: z.object({ sessionId: idInputSchema }).strict(), outputSchema: z.union([successSchema, errorSchema]),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ sessionId }) => safe(() => ({ ok: true, session: registry.get(sessionId) })));
  server.registerTool("pi_session_prompt", {
    description: "Accept a prompt after Pi preflight and run the turn in the background. Returns a running turn at once; poll pi_turn_get with pauses.", inputSchema: z.object({ sessionId: idInputSchema, prompt: z.string().min(1).max(100_000) }).strict(), outputSchema: z.union([promptSuccessSchema, errorSchema]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, ({ sessionId, prompt }) => safe(async () => ({ ok: true, ...(await registry.prompt(sessionId, prompt)) })));
  server.registerTool("pi_session_abort", {
    description: "Abort a running Pi turn; idle sessions are unchanged.", inputSchema: z.object({ sessionId: idInputSchema }).strict(), outputSchema: z.union([successSchema, errorSchema]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, ({ sessionId }) => safe(async () => ({ ok: true, session: await registry.abort(sessionId) })));
  server.registerTool("pi_session_close", {
    description: "Abort if needed, dispose, and remove a Pi session. Idempotent; close every started session.", inputSchema: z.object({ sessionId: idInputSchema }).strict(), outputSchema: z.union([successSchema, errorSchema]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, ({ sessionId }) => safe(async () => ({ ok: true, session: await registry.close(sessionId) })));
  server.registerTool("pi_turn_get", {
    description: "Get the normalized observable result of a Pi turn. completed, failed and aborted are terminal and never change: read a terminal turn once. completed is not task success.", inputSchema: z.object({ sessionId: idInputSchema, turnId: idInputSchema }).strict(), outputSchema: z.union([turnSuccessSchema, errorSchema]),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ sessionId, turnId }) => safe(() => ({ ok: true, turn: registry.getTurn(sessionId, turnId) })));
  return server;
}

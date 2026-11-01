import { z } from "zod";
import packageMetadata from "../package.json" with { type: "json" };
import { CONFIGURATION_FINGERPRINT_PATTERN, RELOAD_POLICY } from "./config.js";
import { ALIAS_PATTERN } from "./execution-profile.js";
import { WORKSPACE_MODES } from "./execution-modes.js";

export const thinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const viewSchema = z.object({
  id: z.string(), workspace: z.string(), executionProfile: z.string(), profile: z.enum(["read-only", "coding"]),
  provider: z.string(), model: z.string(), thinkingLevel: thinkingLevelSchema,
  state: z.enum(["idle", "running", "failed", "closing", "closed"]), createdAt: z.string(), updatedAt: z.string(),
  lastError: z.string().optional(),
  writer: z.string().optional(), base: z.object({ ref: z.string(), commit: z.string() }).optional(),
  snapshot: z.object({ base: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/), head: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/), tree: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/) }).strict().optional(),
});
export const aliasSchema = z.string().regex(ALIAS_PATTERN);
// Input IDs: tools/list keeps `format: "uuid"` but omits zod's long repeated `pattern`; the
// server still validates with the unchanged `z.string().uuid()`, so accepted values and issues are identical.
export const idInputSchema = z.string().meta({ format: "uuid" }).pipe(z.string().uuid());
export const successSchema = z.object({ ok: z.literal(true), session: viewSchema });
export const turnBase = { turnId: z.string().uuid(), sessionId: z.string().uuid(), startedAt: z.string(), updatedAt: z.string() };
export const turnSchema = z.discriminatedUnion("state", [
  z.object({ ...turnBase, state: z.literal("running") }),
  z.object({ ...turnBase, state: z.literal("completed"), completedAt: z.string(), assistantText: z.string(), truncated: z.boolean(), completion: z.enum(["stop", "output_limit", "tool_use"]) }),
  z.object({ ...turnBase, state: z.literal("failed"), completedAt: z.string(), error: z.object({ code: z.literal("turn_failed"), message: z.literal("Pi turn failed") }) }),
  z.object({ ...turnBase, state: z.literal("aborted"), completedAt: z.string() }),
]);
export const promptSuccessSchema = z.object({ ok: z.literal(true), session: viewSchema, turn: turnSchema });
export const turnSuccessSchema = z.object({ ok: z.literal(true), turn: turnSchema });
export const listSchema = z.object({ ok: z.literal(true), sessions: z.array(viewSchema) });
export const errorSchema = z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string(), reason: z.enum(["none_ready", "none_at_base", "none_admitted"]).optional(), counts: z.object({ busy: z.number().int().nonnegative(), notAtBaseline: z.number().int().nonnegative(), settingsChanged: z.number().int().nonnegative() }).optional() }) });
export const capabilitiesSchema = z.object({
  ok: z.literal(true),
  server: z.object({ name: z.literal(packageMetadata.name), version: z.literal(packageMetadata.version) }).strict(),
  configuration: z.object({
    fingerprint: z.string().regex(CONFIGURATION_FINGERPRINT_PATTERN),
    reloadPolicy: z.literal(RELOAD_POLICY),
  }).strict(),
  events: z.object({ delivery: z.enum(["spool", "off"]) }).strict(),
  workspaces: z.array(z.object({ alias: aliasSchema, mode: z.enum(WORKSPACE_MODES), writers: z.number().int().nonnegative().optional(), defaultBase: z.string().nullable().optional() }).strict()),
  executionProfiles: z.array(z.object({
    alias: aliasSchema,
    default: z.boolean(),
    permissionProfile: z.enum(["read-only", "coding"]),
    provider: z.string(),
    model: z.string(),
    thinkingLevel: thinkingLevelSchema,
    extensions: z.array(z.string()),
    grantedExtensionTools: z.array(z.string()),
    shell: z.enum(["none", "sandboxed"]),
    skills: z.array(aliasSchema),
  }).strict()),
}).strict();


import { z } from "zod";
import { hashSchema, relativePathSchema } from "../profiles/schemas.js";

export const profileIdSchema = z.enum(["review-grok", "review", "code", "code-deepseek"]);
export type ProfileId = z.infer<typeof profileIdSchema>;
export const extensionIdSchema = z.enum(["pi-lens", "pi-cache-optimizer"]);
export type ExtensionId = z.infer<typeof extensionIdSchema>;
export const armSchema = z.union([z.literal("A"), extensionIdSchema]);
export type Arm = z.infer<typeof armSchema>;

export const pairingSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/), extension: extensionIdSchema, profile: profileIdSchema,
  priority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  grantedExtensionTools: z.array(z.string().min(1)).min(1).optional(),
}).strict();
export type Pairing = z.infer<typeof pairingSchema>;

export const anchorSchema = z.object({ file: relativePathSchema, terms: z.array(z.string().min(1)).min(1) }).strict();
export type Anchor = z.infer<typeof anchorSchema>;
export const reviewOracleSchema = z.object({
  kind: z.literal("review"),
  findings: z.array(z.object({ id: z.string().min(1), critical: z.boolean(), anchors: z.array(anchorSchema).min(1) }).strict()),
  falseFindings: z.array(z.object({ id: z.string().min(1), anchors: z.array(anchorSchema).min(1) }).strict()),
}).strict();
export type ReviewOracle = z.infer<typeof reviewOracleSchema>;
export const implementationOracleSchema = z.object({
  kind: z.literal("implementation"),
  command: z.array(z.string().min(1)).min(1), timeoutMs: z.number().int().positive(),
  setup: z.array(z.array(z.string().min(1)).min(1)).optional(),
}).strict();
export type ImplementationOracle = z.infer<typeof implementationOracleSchema>;
export const oracleSchema = z.discriminatedUnion("kind", [reviewOracleSchema, implementationOracleSchema]);

/** A repo-relative directory prefix such as `dist/`: trailing slash, no leading slash, no `..` segment, no glob characters. */
export const scopeIgnoreEntrySchema = z.string().min(1).refine((p) =>
  p.endsWith("/") && !p.startsWith("/") && !p.split("/").includes("..") && !/[*?[\]{}]/.test(p), { message: "scope_ignore_prefix_invalid" });

export const taskSpecSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/), kind: z.enum(["review", "implementation"]),
  repo: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
  promptRef: relativePathSchema.refine((p) => p.startsWith("eval/results/")), promptHash: hashSchema,
  sourceSession: z.string().min(1), allowedPaths: z.array(relativePathSchema), scopeIgnore: z.array(scopeIgnoreEntrySchema),
  oracle: oracleSchema,
}).strict().refine((t) => t.kind === t.oracle.kind, { message: "oracle_kind_mismatch", path: ["oracle"] });
export type TaskSpec = z.infer<typeof taskSpecSchema>;

export const runSpecSchema = z.object({
  runId: z.string().regex(/^\d{3,}-[a-zA-Z0-9_-]+-[a-z-]+-[a-zA-Z-]+$/), taskId: z.string().min(1),
  profile: profileIdSchema, arm: armSchema, ordinal: z.number().int().min(1), pairings: z.array(z.string().min(1)).min(1),
}).strict();
export type RunSpec = z.infer<typeof runSpecSchema>;

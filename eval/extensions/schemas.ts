import { z } from "zod";
import { pathTokens } from "./path-tokens.js";
import { hashSchema, relativePathSchema } from "../profiles/schemas.js";

export const profileIdSchema = z.enum(["review-grok", "review", "code", "code-deepseek"]);
export type ProfileId = z.infer<typeof profileIdSchema>;
const extensionIdSchema = z.enum(["pi-lens", "pi-cache-optimizer"]);
export type ExtensionId = z.infer<typeof extensionIdSchema>;
export const armSchema = z.union([z.literal("A"), extensionIdSchema]);
export type Arm = z.infer<typeof armSchema>;

export const pairingSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/), extension: extensionIdSchema, profile: profileIdSchema,
  priority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  grantedExtensionTools: z.array(z.string().min(1)).min(1).optional(),
}).strict();
export type Pairing = z.infer<typeof pairingSchema>;

/** Anchor files are matched as path tokens in review text, so only token characters are allowed. */
const anchorFileSchema = relativePathSchema
  .refine((p) => /^[A-Za-z0-9_.\-/]+$/.test(p) && !p.endsWith("."), { message: "anchor_file_charset" })
  .refine((file) => {
    const lower = file.toLowerCase();
    const tokens = pathTokens(lower);
    return tokens.length === 1 && tokens[0] === lower;
  }, { message: "anchor_file_path_token" });
export const anchorSchema = z.object({ file: anchorFileSchema, terms: z.array(z.string().min(1)).min(1) }).strict();
export type Anchor = z.infer<typeof anchorSchema>;
const reviewOracleSchema = z.object({
  kind: z.literal("review"),
  findings: z.array(z.object({ id: z.string().min(1), critical: z.boolean(), anchors: z.array(anchorSchema).min(1) }).strict()),
  falseFindings: z.array(z.object({ id: z.string().min(1), anchors: z.array(anchorSchema).min(1) }).strict()),
}).strict();
export type ReviewOracle = z.infer<typeof reviewOracleSchema>;
/** The decisive command and its setup share this deadline; it is capped so an oracle cannot outlast a run by hours. */
const MAX_ORACLE_TIMEOUT_MS = 10 * 60_000;
const implementationOracleSchema = z.object({
  kind: z.literal("implementation"),
  command: z.array(z.string().min(1)).min(1), timeoutMs: z.number().int().positive().max(MAX_ORACLE_TIMEOUT_MS),
  setup: z.array(z.array(z.string().min(1)).min(1)).optional(),
}).strict();
export type ImplementationOracle = z.infer<typeof implementationOracleSchema>;
const oracleSchema = z.discriminatedUnion("kind", [reviewOracleSchema, implementationOracleSchema]);

/** A repo-relative directory prefix such as `dist/`: trailing slash, no leading slash, no `..` segment, no glob characters. */
const scopeIgnoreEntrySchema = z.string().min(1).refine((p) =>
  p.endsWith("/") && !p.startsWith("/") && !p.split("/").includes("..") && !/[*?[\]{}]/.test(p), { message: "scope_ignore_prefix_invalid" });

/** An allowed path is a repo-relative file, or a directory prefix such as `backend/tests/` under the rules of a `scopeIgnore` entry (R77). */
const allowedPathSchema = z.union([relativePathSchema, scopeIgnoreEntrySchema]);

/** A repo-relative directory without trailing slash (`backend/.venv`): no `..`, no `.git` segment, no glob characters. */
const dependencyPathSchema = relativePathSchema.refine((p) =>
  !p.split("/").includes(".git") && !/[*?[\]{}]/.test(p), { message: "dependency_path_invalid" });
/** An installed dependency (R68): the directory to mount read-only at its repo-relative place, and the lockfile it was built from. */
export const dependencySchema = z.object({ path: dependencyPathSchema, lockfile: relativePathSchema }).strict();
export type Dependency = z.infer<typeof dependencySchema>;
const dependenciesSchema = z.array(dependencySchema).max(4)
  // A mount below another mount cannot be created: its mount point would have to exist inside the read-only one.
  .refine((list) => list.every((a, i) => list.every((b, j) => i === j || (a.path !== b.path && !a.path.startsWith(`${b.path}/`)))), { message: "dependency_paths_overlap" });

export const taskSpecSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/), kind: z.enum(["review", "implementation"]),
  repo: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
  promptRef: relativePathSchema.refine((p) => p.startsWith("eval/results/")), promptHash: hashSchema,
  sourceSession: z.string().min(1), allowedPaths: z.array(allowedPathSchema), scopeIgnore: z.array(scopeIgnoreEntrySchema),
  oracle: oracleSchema, dependencies: dependenciesSchema.optional(),
}).strict().refine((t) => t.kind === t.oracle.kind, { message: "oracle_kind_mismatch", path: ["oracle"] });
export type TaskSpec = z.infer<typeof taskSpecSchema>;

export const runSpecSchema = z.object({
  runId: z.string().regex(/^\d{3,}-[a-zA-Z0-9_-]+-[a-z-]+-[a-zA-Z-]+$/), taskId: z.string().min(1),
  profile: profileIdSchema, arm: armSchema, ordinal: z.number().int().min(1), pairings: z.array(z.string().min(1)).min(1),
}).strict();
export type RunSpec = z.infer<typeof runSpecSchema>;

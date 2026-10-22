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
const BRACE_QUANTIFIER = /^\{(\d+)(?:(,)(\d*))?\}/;

/**
 * A conservative syntactic check that a verdict pattern runs in linear time (R80): no backreference (`\1`..`\9`, `\k<`) and no repeated
 * group (`*`, `+`, `{n,}`, `{n,m}` with m > 1) that itself contains a quantifier, as in `(a+)+`, `(\w+\s?)*` or `(?:x*){2,}`. It does not see
 * overlapping alternations such as `(a|a)*`, nor adjacent overlapping quantifiers such as `^\W*(x\s*)?\W*` or `[^\n]*\b[\w/-]+\.` tried from
 * every `^` position (multiline), which are super-linear without any nested quantifier. Verdict patterns should be literal alternations,
 * anchors and simple classes with bounded widths (`[^\w\n]{0,N}`); curation must time each pattern on adversarial 64 KiB inputs.
 */
export function verdictPatternIsLinear(pattern: string): boolean {
  const open: boolean[] = []; // per open group: it contains a quantifier
  let closed: boolean | null = null; // the group just closed contained a quantifier
  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i]!;
    if (c === "\\") {
      const next = pattern[i + 1] ?? "";
      if (/[1-9]/.test(next) || (next === "k" && pattern[i + 2] === "<")) return false;
      i += 1; closed = null;
      continue;
    }
    if (inClass) { if (c === "]") inClass = false; continue; }
    if (c === "[") { inClass = true; closed = null; continue; }
    if (c === "(") {
      open.push(false); closed = null;
      if (pattern[i + 1] === "?") { // group syntax, not a quantifier: (?: (?= (?! (?<= (?<! (?<name>
        i += 1;
        if (":=!".includes(pattern[i + 1] ?? "\0")) i += 1;
        else if (pattern[i + 1] === "<") i += pattern[i + 2] === "=" || pattern[i + 2] === "!" ? 2 : Math.max(pattern.indexOf(">", i) - i, 1);
      }
      continue;
    }
    if (c === ")") {
      const inner = open.pop() ?? false;
      if (open.length > 0 && inner) open[open.length - 1] = true;
      closed = inner;
      continue;
    }
    let repeats = false;
    if (c === "*" || c === "+" || c === "?") repeats = c !== "?";
    else if (c === "{") {
      const brace = BRACE_QUANTIFIER.exec(pattern.slice(i));
      if (brace === null) { closed = null; continue; }
      const max = brace[2] === undefined ? Number(brace[1]) : brace[3] === "" ? Infinity : Number(brace[3]);
      repeats = max > 1;
      i += brace[0].length - 1;
    } else { closed = null; continue; }
    if (repeats && closed === true) return false;
    if (open.length > 0) open[open.length - 1] = true;
    closed = null;
    if (pattern[i + 1] === "?") i += 1; // lazy marker
  }
  return true;
}

/**
 * The review's required verdict (R78): a JavaScript regular expression source, compiled with flags `im`; at most 500 characters. It must run in
 * linear time (R80): literal alternations, anchors and simple classes; a backreference or a repeated group containing a quantifier is refused.
 */
const VERDICT_FLAGS = "im";
const verdictPatternSchema = z.string().min(1).max(500).refine((pattern) => {
  try { new RegExp(pattern, VERDICT_FLAGS); return true; } catch { return false; }
}, { message: "verdict_pattern_invalid" }).refine(verdictPatternIsLinear, { message: "verdict_pattern_unsafe" });
const reviewOracleSchema = z.object({
  kind: z.literal("review"),
  verdict: z.object({ pattern: verdictPatternSchema }).strict(),
  findings: z.array(z.object({ id: z.string().min(1), critical: z.boolean(), anchors: z.array(anchorSchema).min(1) }).strict()),
  falseFindings: z.array(z.object({ id: z.string().min(1), anchors: z.array(anchorSchema).min(1) }).strict()),
}).strict().refine((oracle) => oracle.findings.some((finding) => finding.critical), { message: "review_oracle_no_critical", path: ["findings"] });
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

/** The most replicates a plan may ask for (R90). */
export const MAX_REPLICATES = 9;

export const runSpecSchema = z.object({
  runId: z.string().regex(/^\d{3,}-[a-zA-Z0-9_-]+-[a-z-]+-[a-zA-Z-]+(?:-r[1-9])?$/), taskId: z.string().min(1),
  profile: profileIdSchema, arm: armSchema, ordinal: z.number().int().min(1), pairings: z.array(z.string().min(1)).min(1),
  /** The 1-based replicate (R90); absent in a plan without replicates, where it reads as 1 and the run id has no `-r<k>` suffix. */
  replicate: z.number().int().min(1).max(MAX_REPLICATES).optional(),
}).strict();
export type RunSpec = z.infer<typeof runSpecSchema>;

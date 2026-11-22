import { z } from "zod";
import { isAbsolute } from "node:path";
import { ALIAS_PATTERN } from "../execution-profile.js";
import { FAMILY_PATTERN, ROLES, TIERS } from "../routing/config.js";

const alias = z.string().regex(ALIAS_PATTERN);
const container = z.object({
  writers: z.number().int().min(1).max(16).optional(), lifecycle: z.enum(["persistent", "ephemeral"]).optional(),
  profiles: z.array(alias).optional(), image: z.string().optional(), network: z.enum(["pasta", "none"]).optional(),
  cache: z.enum(["none", "go", "uv", "npm"]).optional(), tags: z.enum(["none", "reachable"]).optional(),
  clean: z.enum(["untracked", "all"]).optional(), base: z.string().optional(), cpus: z.number().optional(),
  cpuShares: z.number().optional(), memory: z.string().optional(),
}).strict();
const schema = z.object({
  schemaVersion: z.literal(1), approveProbes: z.boolean(), allowConfigChange: z.boolean(),
  profiles: z.array(z.object({ alias, provider: z.string().trim().min(1).max(256), model: z.string().trim().min(1).max(256), role: z.enum(ROLES), thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]), tier: z.enum(TIERS).nullable(), family: z.string().regex(FAMILY_PATTERN).nullable() }).strict().refine((profile) => profile.tier === null || profile.family !== null, { path: ["family"], params: { rule: "required_with_tier" } })),
  defaultProfile: alias,
  workspaces: z.array(z.object({ alias, path: z.string().min(1).refine(isAbsolute, { params: { rule: "not_absolute_path" } }), mode: z.enum(["host", "container", "read-only"]), acceptHostWrites: z.boolean().optional(), container: container.optional() }).strict()),
  history: z.object({ enabled: z.boolean() }).strict(), routing: z.object({ mode: z.enum(["off", "manual", "auto"]) }).strict(),
  clients: z.object({ claudeCode: z.boolean(), codex: z.boolean() }).strict(),
}).strict().superRefine((answers, ctx) => {
  const duplicated = (values: readonly string[]): boolean => new Set(values).size !== values.length;
  const rule = (path: string, name: string): void => ctx.addIssue({ code: "custom", path: [path], params: { rule: name } });
  if (duplicated(answers.profiles.map((profile) => profile.alias))) rule("profiles", "duplicate_profile_alias");
  if (duplicated(answers.workspaces.map((workspace) => workspace.alias))) rule("workspaces", "duplicate_workspace_alias");
  if (answers.profiles.some((profile) => profile.alias === answers.defaultProfile && profile.role === "code")) rule("defaultProfile", "default_profile_is_code");
});

export type GuidedAnswers = z.infer<typeof schema>;

/** One violated rule of the answers: a field path and a rule code, never a value or a name taken from the input. */
export interface AnswersIssue { readonly path: string; readonly rule: string }
export const MAX_ANSWERS_ISSUES = 20;
/** Every rule code that `parseGuidedAnswers` and the answers file reader can report; `docs/agent-install.md` explains each one. */
export const ANSWERS_RULES = ["not_json", "missing_field", "wrong_type", "invalid_value", "invalid_format", "too_small", "too_large", "unknown_field", "not_absolute_path", "required_with_tier", "default_profile_is_code", "duplicate_profile_alias", "duplicate_workspace_alias"] as const;

/**
 * The path holds schema field names and array indices only, so it is safe to report; "document" is the whole answers
 * document. Issues about an unknown field name the parent and say `unknown_field`, because the field's own name comes from
 * the input and may be a pasted secret.
 */
function issueOf(issue: z.core.$ZodIssue, input: unknown): AnswersIssue {
  let value: unknown = input;
  for (const segment of issue.path) value = value !== null && typeof value === "object" ? (value as Record<PropertyKey, unknown>)[segment as PropertyKey] : undefined;
  const path = issue.path.length === 0 ? "document" : issue.path.map((segment) => typeof segment === "number" ? String(segment) : /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(String(segment)) ? String(segment) : "field").join(".");
  const custom = issue.code === "custom" ? (issue.params as { rule?: unknown } | undefined)?.rule : undefined;
  const rule = typeof custom === "string" ? custom
    : issue.code === "invalid_type" ? (value === undefined && issue.path.length > 0 ? "missing_field" : "wrong_type")
    : issue.code === "unrecognized_keys" ? "unknown_field"
    : issue.code === "too_small" ? "too_small"
    : issue.code === "too_big" ? "too_large"
    : issue.code === "invalid_format" ? "invalid_format"
    : "invalid_value";
  return { path, rule };
}

export class AnswersInvalidError extends Error {
  readonly code = "answers_invalid" as const;
  constructor(readonly issues: readonly AnswersIssue[]) { super("Guided answers are invalid"); this.name = "AnswersInvalidError"; }
}

export function parseGuidedAnswers(input: unknown): GuidedAnswers {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const seen = new Set<string>(), issues: AnswersIssue[] = [];
  for (const raw of result.error.issues) {
    const issue = issueOf(raw, input), key = `${issue.path}\0${issue.rule}`;
    if (!seen.has(key) && issues.length < MAX_ANSWERS_ISSUES) { seen.add(key); issues.push(issue); }
  }
  throw new AnswersInvalidError(issues);
}

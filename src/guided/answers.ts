import { z } from "zod";
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
  profiles: z.array(z.object({ alias, provider: z.string().trim().min(1).max(256), model: z.string().trim().min(1).max(256), role: z.enum(ROLES), thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]), tier: z.enum(TIERS).nullable(), family: z.string().regex(FAMILY_PATTERN).nullable() }).strict().refine((profile) => profile.tier === null || profile.family !== null)),
  defaultProfile: alias,
  workspaces: z.array(z.object({ alias, path: z.string().min(1), mode: z.enum(["host", "container", "read-only"]), acceptHostWrites: z.boolean().optional(), container: container.optional() }).strict()),
  history: z.object({ enabled: z.boolean() }).strict(), routing: z.object({ mode: z.enum(["off", "manual", "auto"]) }).strict(),
  clients: z.object({ claudeCode: z.boolean(), codex: z.boolean() }).strict(),
}).strict().refine((answers) => {
  const profiles = answers.profiles.map((profile) => profile.alias);
  const workspaces = answers.workspaces.map((workspace) => workspace.alias);
  return new Set(profiles).size === profiles.length && new Set(workspaces).size === workspaces.length
    && !answers.profiles.some((profile) => profile.alias === answers.defaultProfile && profile.role === "code");
});

export type GuidedAnswers = z.infer<typeof schema>;

export function parseGuidedAnswers(input: unknown): GuidedAnswers {
  const result = schema.safeParse(input);
  if (!result.success) throw Object.assign(new Error("Guided answers are invalid"), { code: "answers_invalid" as const });
  return result.data;
}

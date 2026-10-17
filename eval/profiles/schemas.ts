import { z } from "zod";

export const VERSION = "1.0.0" as const;
export const statusSchema = z.enum(["PASS", "FAIL", "BLOCKED", "NOT_RUN", "INCONCLUSIVE"]);
export type Status = z.infer<typeof statusSchema>;
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const hashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const relativePathSchema = z.string().min(1).max(256).refine((s) => !s.startsWith("/") && !s.includes("\\") && s.split("/").every((p) => p !== ".." && p !== "." && p.length > 0));
export const routeSchema = z.object({
  provider: id, model: z.string().regex(/^[a-zA-Z0-9_.:@/-]{1,160}$/),
  effort: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  auth_type: z.enum(["api-key", "oauth", "subscription", "local", "unknown"]),
  billing_type: z.enum(["api", "subscription", "local", "unknown"]),
  data_path: z.literal("synthetic-fixture-to-selected-provider"),
}).strict();
export const taskSchema = z.object({
  schema_version: z.literal(VERSION), id: z.string().regex(/^T[1-9]$/), title: z.string(), family: z.string(),
  profiles: z.array(z.enum(["P1", "P2", "P3", "P4"])), views: z.array(id),
  allowed_paths: z.array(relativePathSchema), prompt_hash: hashSchema, fixture_hash: hashSchema,
  oracle_kind: z.string(), task_hash: hashSchema,
}).strict();
export const runSchema = z.object({
  run_id: id, task_id: z.string().regex(/^T[1-9]$/), task_hash: hashSchema,
  profile_id: z.enum(["P1", "P2", "P3", "P4"]), view: id, repetition: z.number().int().min(1).max(2),
  stage: z.enum(["screening", "pilot", "ablation"]), route: routeSchema,
  permission_profile: z.enum(["read-only", "coding"]),
  variant: z.enum(["A", "B", "C"]),
  review_target:z.object({path:relativePathSchema.refine(p=>p.startsWith("eval/results/")&&p.endsWith(".snapshot")),hash:hashSchema}).strict().nullable().default(null),
  skills: z.array(z.object({ identity: id, digest: hashSchema }).strict()).max(2),
  extensions: z.array(z.object({ identity: z.string().regex(/^npm:(?:@[a-z0-9-]+\/)?[a-z0-9-]+@\d+\.\d+\.\d+$/), digest: hashSchema }).strict()).max(1),
}).strict();
export type Run = z.infer<typeof runSchema>;
export const manifestSchema = z.object({
  schema_version: z.literal(VERSION), approved: z.boolean(), server_commit: z.string().regex(/^[a-f0-9]{40}$/),
  screening_evidence:z.array(z.object({path:relativePathSchema.refine(p=>p.startsWith("eval/results/")&&p.endsWith(".json")),hash:hashSchema}).strict()).max(8).default([]),
  source_digest: hashSchema, tasks: z.array(taskSchema).length(9), runs: z.array(runSchema).min(1).max(30),
  prerequisites: z.object({ baseline_passed: z.boolean(), screening_passed: z.boolean(), bottleneck: z.string().nullable() }).strict(),
}).strict().superRefine((m, c) => {
  if (new Set(m.runs.map((r) => r.run_id)).size !== m.runs.length) c.addIssue({code:"custom",message:"duplicate_run"});
  if (new Set(m.tasks.map((t) => t.id)).size !== 9) c.addIssue({code:"custom",message:"duplicate_task"});
  for (const stage of ["screening", "pilot", "ablation"] as const) {
    if (m.runs.filter((r) => r.stage === stage).length > {screening:8,pilot:18,ablation:4}[stage]) c.addIssue({code:"custom",message:"stage_limit"});
  }
  for (const r of m.runs) {
    const task = m.tasks.find((t) => t.id === r.task_id);
    if (!task || task.task_hash !== r.task_hash || !task.profiles.includes(r.profile_id) || !task.views.includes(r.view)) c.addIssue({code:"custom",message:"task_binding"});
    const roleViews:Record<string,string[]>={P1:["scout","docs-writer"],P2:["implementer"],P3:["reviewer"],P4:["ui-writer","tester"]};
    if(!roleViews[r.profile_id]!.includes(r.view))c.addIssue({code:"custom",message:"profile_view_binding"});
    const writer = r.profile_id === "P2" || (r.profile_id === "P4" && r.view === "ui-writer");
    if ((r.permission_profile === "coding") !== writer) c.addIssue({code:"custom",message:"permission_binding"});
    if ((r.variant === "A" && r.skills.length > 0) || (r.variant !== "C" && r.extensions.length > 0) || (r.variant === "C" && r.extensions.length !== 1)) c.addIssue({code:"custom",message:"variant_binding"});
    if (r.stage !== "ablation" && r.variant !== "A") c.addIssue({code:"custom",message:"baseline_variant"});
    if (r.stage !== "screening" && !m.prerequisites.screening_passed) c.addIssue({code:"custom",message:"screening_gate"});
    if ((r.task_id === "T9" || r.stage === "ablation") && !m.prerequisites.baseline_passed) c.addIssue({code:"custom",message:"baseline_gate"});
    if (r.stage === "ablation" && !m.prerequisites.bottleneck) c.addIssue({code:"custom",message:"ablation_gate"});
  }
});
export type Manifest = z.infer<typeof manifestSchema>;
export const budgetSchema = z.object({
  schema_version: z.literal(VERSION), approved: z.literal(true), manifest_digest: hashSchema,
  max_starts: z.number().int().min(1).max(30), max_retries: z.literal(0), parallelism: z.literal(1),
  run_timeout_ms: z.number().int().min(1000).max(600000), total_timeout_ms: z.number().int().min(1000).max(18000000),
  advisory_usd: z.number().positive().max(25), provider_cap_usd: z.number().positive().nullable(),
  acknowledges_unmetered_cost: z.literal(true),
}).strict();
export type Budget = z.infer<typeof budgetSchema>;
export const checkSchema = z.object({ id, status: statusSchema, exit_code: z.number().int().nullable(), reason: z.string().optional() }).strict();
export const resultSchema = z.object({
  schema_version: z.literal(VERSION), stage:runSchema.shape.stage, run_id: id, task_id: z.string(), task_hash: hashSchema, repetition: z.number().int(),
  scope_id:id,fixture_revision: hashSchema, server_commit: z.string(), source_digest: hashSchema,
  package_version: z.string(), sdk_version: z.string(), client_version: z.string(),
  profile_id: z.string(), view: id, profile_digest: hashSchema, permission_profile: z.enum(["coding", "read-only"]),
  skills: runSchema.shape.skills, extensions: runSchema.shape.extensions,
  requested_route: routeSchema, resolved_route: routeSchema.nullable(), model_revision: z.null(),
  started_at: z.string().nullable(), ended_at: z.string().nullable(), terminal_status: z.string().nullable(),
  harness_status: statusSchema, task_status: statusSchema, boundary_status: statusSchema,
  recommendation: z.enum(["suitable-for-synthetic-scope", "restricted", "blocked-not-established", "rejected-for-scope"]),
  checks: z.array(checkSchema), blockers: z.array(id),
  artifacts: z.array(z.object({ path: relativePathSchema, hash: hashSchema }).strict()),
  expected_diff_scope: z.array(relativePathSchema), observed_diff_scope: z.array(relativePathSchema),
  duration_ms: z.number().nonnegative().nullable(), tool_errors: z.number().int().nonnegative().nullable(),
  manual_rework: z.number().nonnegative().nullable(), controller_calls: z.number().int().nonnegative(),
  cost_usd: z.null(), usage: z.null(), cost_source: z.literal("not-exposed-by-mcp"),
  metrics: z.record(z.string(), z.number().nullable()),
}).strict();
export type Result = z.infer<typeof resultSchema>;

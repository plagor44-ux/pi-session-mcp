import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

// Approval binding and credential-file checks for the live L1 pair. Refusal reasons are fixed codes: no message ever carries
// a path, an approval value or credential content.
export const REQUIRED_CONTROLLER = { client_version: "2.1.306 (Claude Code)", model: "claude-sonnet-5-5", auth: "api-key" } as const;
/** The worker routes an approval may name; their values mirror the operator's profiles of the same alias. */
export const WORKER_ROUTES = {
  "explore-fast": { profile_alias: "explore-fast", provider: "openai", model: "gpt-6-luna", thinkingLevel: "low" },
  review: { profile_alias: "review", provider: "openai", model: "gpt-6.1-sol", thinkingLevel: "high" },
} as const;
export type WorkerRoute = (typeof WORKER_ROUTES)[keyof typeof WORKER_ROUTES];
/** The route of dry runs and of the first live pair. */
export const DEFAULT_WORKER: WorkerRoute = WORKER_ROUTES["explore-fast"];
export const API_KEY_FILE_ENV = "CLAUDE_EVAL_API_KEY_FILE";

export type Arm = "A" | "C";
export type RefusalReason =
  | "approval_not_object" | "not_approved" | "wrong_case" | "arm_not_approved" | "max_runs_invalid" | "runs_exhausted"
  | "source_commit_mismatch" | "worktree_dirty" | "controller_mismatch" | "worker_mismatch" | "budget_invalid";
export interface ApprovalContext { arm: Arm; headCommit: string; worktreeClean: boolean; runsRecorded: number }
export type ApprovalCheck = { ok: true } | { ok: false; reason: RefusalReason };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const refuse = (reason: RefusalReason): ApprovalCheck => ({ ok: false, reason });

/** Pure. Checks run in a fixed order; the first failing rule names the refusal. */
export function validateApproval(approval: unknown, context: ApprovalContext): ApprovalCheck {
  if (!isObject(approval)) return refuse("approval_not_object");
  if (approval.approved !== true) return refuse("not_approved");
  if (approval.case !== "L1") return refuse("wrong_case");
  if (!Array.isArray(approval.arms) || !approval.arms.includes(context.arm)) return refuse("arm_not_approved");
  const max = approval.max_controller_runs;
  if (typeof max !== "number" || !Number.isInteger(max) || max < 1) return refuse("max_runs_invalid");
  if (context.runsRecorded >= max) return refuse("runs_exhausted");
  if (typeof approval.source_commit !== "string" || approval.source_commit !== context.headCommit) return refuse("source_commit_mismatch");
  if (!context.worktreeClean) return refuse("worktree_dirty");
  const controller = approval.controller;
  if (!isObject(controller) || (Object.keys(REQUIRED_CONTROLLER) as Array<keyof typeof REQUIRED_CONTROLLER>).some((key) => controller[key] !== REQUIRED_CONTROLLER[key])) return refuse("controller_mismatch");
  if (approvedWorker(approval.worker) === undefined) return refuse("worker_mismatch");
  const budget = approval.budget_usd_advisory;
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget < 0) return refuse("budget_invalid");
  return { ok: true };
}

/** The approved worker route: one of the fixed routes with exactly its values and no skills, else undefined. */
export function approvedWorker(worker: unknown): WorkerRoute | undefined {
  if (!isObject(worker) || !Array.isArray(worker.skills) || worker.skills.length !== 0) return undefined;
  const route = Object.values(WORKER_ROUTES).find((candidate) => candidate.profile_alias === worker.profile_alias);
  return route !== undefined && (Object.keys(route) as Array<keyof WorkerRoute>).every((key) => worker[key] === route[key]) ? route : undefined;
}

export const approvalDigest = (bytes: Uint8Array | string): `sha256:${string}` => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export type CredentialFileReason = "unset" | "missing" | "not_regular" | "too_open" | "empty" | "unreadable";
export type CredentialRead = { ok: true; value: string } | { ok: false; reason: CredentialFileReason };

/**
 * Reads the API key from the file whose path the operator put in an environment variable. The file must be a regular file,
 * owner-only (no group or other permission bit) and non-empty after trimming. The path and the content never enter a result.
 */
export async function readCredentialFile(path: string | undefined): Promise<CredentialRead> {
  if (path === undefined || path === "") return { ok: false, reason: "unset" };
  let handle;
  try { handle = await open(path, "r"); } catch (error) { return { ok: false, reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" }; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { ok: false, reason: "not_regular" };
    if ((stat.mode & 0o077) !== 0) return { ok: false, reason: "too_open" };
    if (stat.size > 64 * 1024) return { ok: false, reason: "unreadable" };
    const value = (await handle.readFile("utf8")).trim();
    return value === "" ? { ok: false, reason: "empty" } : { ok: true, value };
  } catch { return { ok: false, reason: "unreadable" }; }
  finally { await handle.close().catch(() => undefined); }
}

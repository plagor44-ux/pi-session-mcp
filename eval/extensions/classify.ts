import { z } from "zod";
import type { RunOutput } from "./run-one.js";
import type { ReviewScore } from "./oracles.js";
import type { Arm, ProfileId } from "./schemas.js";
import { MAX_EVIDENCE_LINES, type TraceFindings } from "./trace.js";
import type { RunUsage } from "./usage.js";

export type StopReason =
  | "outside_write" | "unresolved_write" | "unresolved_egress" | "output_integrity" | "guard_changed" | "harness_failure" | "cleanup_failure"
  | "provider_error" | "credential_expiring" | "budget" | "wave_timeout" | "interrupted";

/** Path-free projection of the trace findings; the raw findings stay under the wave's private directory. */
export interface TraceSummary {
  outsideWrites: number;
  unresolvedWrites: number;
  deniedWriteAttempts: number;
  unresolvedEgress: number;
  /** The first `MAX_UNEXPECTED_CONNECTS` destinations; `unexpectedConnectCount` has the full number. */
  unexpectedConnects: { family: "inet" | "inet6"; address: string; port: number }[];
  unexpectedConnectCount: number;
  connects: number;
}

/** Worker-controlled destinations are capped in tracked records. */
export const MAX_UNEXPECTED_CONNECTS = 20;

export interface RunRecord {
  runId: string;
  taskId: string;
  profile: ProfileId;
  arm: Arm;
  /** The run's replicate (R90); absent in a plan without replicates. */
  replicate?: number;
  pairings: string[];
  outcome: "scored" | "stopped" | "not_run";
  terminal: RunOutput["terminal"] | null;
  accepted: boolean | null;
  review?: ReviewScore;
  /** The out-of-scope paths are worker-controlled strings and never leave the wave: only their count is recorded (R42). */
  implementation?: { accepted: boolean; testsPassed: boolean; outOfScopeCount: number };
  usage: RunUsage | null;
  durationMs: number | null;
  trace: TraceSummary | null;
  stopReason: StopReason | null;
  /** A fixed failure code from the run unit or the wave, never a message or a path. */
  harnessError: string | null;
  assistantTextTruncated: boolean | null;
  /** SHA-256 of the assistant text, which itself is not kept. */
  assistantTextSha256: string | null;
  /** The type of the boundary credential the run used: a subscription (oauth) or an API key. Quota use is recorded, not priced. */
  authType: "oauth" | "api_key" | null;
}

const usageSession = z.object({
  input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), total: z.number(), costUsd: z.number(),
});
const usageAssistant = z.object({
  messages: z.number(), input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), costUsd: z.number(),
});
/** What `run-one` writes; a file that does not parse is treated as no output at all. */
export const runOutputSchema = z.object({
  runId: z.string(),
  terminal: z.enum(["completed", "failed", "aborted", "timeout", "start_failed"]),
  startErrorCode: z.string().nullable(),
  usage: z.object({
    session: usageSession.nullable(), assistant: usageAssistant,
    providerError: z.enum(["auth", "quota", "rate_limit", "other"]).nullable(),
  }),
  durationMs: z.number(), sessionsLeft: z.number(), assistantTextRef: z.string().nullable(),
  assistantTextTruncated: z.boolean(), assistantTextSha256: z.string().nullable(), mac: z.string().nullable(), harnessError: z.string().nullable(),
});

/**
 * The stop reasons of the trace audit: the run's own containment audit found a write or a connection it could not clear. A slot stopped by
 * one of them may be planned again under a new approval (R85), because the stop says nothing about the extension's result.
 */
export const AUDIT_STOPS: readonly StopReason[] = ["outside_write", "unresolved_write", "unresolved_egress"];
export const isAuditStop = (reason: string | null | undefined): boolean => AUDIT_STOPS.includes(reason as StopReason);

/** Only fixed codes reach a record; any other string (a message, a path) is replaced. */
export function fixedCode(value: string | null | undefined, fallback = "wave_step_failed"): string | null {
  if (value === null || value === undefined) return null;
  return /^[a-z][a-z0-9_]{0,60}$/.test(value) ? value : fallback;
}

export function summarizeTrace(trace: TraceFindings): TraceSummary {
  return {
    outsideWrites: trace.outsideWrites.length, unresolvedWrites: trace.unresolvedWrites, deniedWriteAttempts: trace.deniedWriteAttempts,
    unresolvedEgress: trace.unresolvedEgress, unexpectedConnects: trace.unexpectedConnects.slice(0, MAX_UNEXPECTED_CONNECTS).map((d) => ({ ...d })),
    unexpectedConnectCount: trace.unexpectedConnects.length, connects: trace.connects,
  };
}

export function mergeTrace(a: TraceFindings, b: TraceFindings): TraceFindings {
  const seen = new Set<string>();
  const unexpectedConnects = [...a.unexpectedConnects, ...b.unexpectedConnects].filter((d) => {
    const key = `${d.family}|${d.address}|${d.port}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
  return {
    outsideWrites: [...new Set([...a.outsideWrites, ...b.outsideWrites])],
    unresolvedWrites: a.unresolvedWrites + b.unresolvedWrites,
    deniedWriteAttempts: a.deniedWriteAttempts + b.deniedWriteAttempts,
    unexpectedConnects, connects: a.connects + b.connects, unresolvedEgress: a.unresolvedEgress + b.unresolvedEgress,
    evidenceLines: [...a.evidenceLines, ...b.evidenceLines].slice(0, MAX_EVIDENCE_LINES),
  };
}

export interface RunFacts {
  /** The parsed `run-one` output, or null when none was written or it did not parse. */
  output: RunOutput | null;
  timedOut: boolean;
  interrupted: boolean;
  /** No process of the run's group is left (zombies excluded). */
  residualClean: boolean;
  /** Null when the strace log is missing or empty, which means the run cannot be audited. */
  trace: TraceFindings | null;
  guardChanged: boolean;
  /** The output file exists but its MAC, schema or text hash did not verify (R35); `output` is then null. */
  integrityFailed?: boolean;
  /** A failure of the wave's own steps for this run (scope, prompt, spawn, oracle), as a fixed code. */
  waveFailure: string | null;
}

/**
 * The single stop reason of a run, or null when the run is scored. Security findings outrank harness findings, so a run that
 * both failed and wrote outside its scope is reported as the write. A failed, timed-out or aborted turn is scored, not a stop.
 */
export function classifyRun(facts: RunFacts): { stopReason: StopReason | null; harnessError: string | null } {
  const { output, trace } = facts;
  const harnessError = facts.waveFailure ?? fixedCode(output?.harnessError, "invalid_harness_error")
    ?? (output === null && !facts.interrupted ? (facts.timedOut ? "run_timeout_killed" : "run_output_missing") : null)
    ?? (output?.terminal === "start_failed" ? "start_failed" : null)
    ?? (trace === null && !facts.interrupted ? "trace_missing" : null);
  const checks: [StopReason, boolean][] = [
    ["outside_write", (trace?.outsideWrites.length ?? 0) > 0],
    ["unresolved_write", (trace?.unresolvedWrites ?? 0) > 0],
    ["unresolved_egress", (trace?.unresolvedEgress ?? 0) > 0],
    ["output_integrity", facts.integrityFailed === true],
    ["guard_changed", facts.guardChanged],
    ["cleanup_failure", !facts.residualClean || (output?.sessionsLeft ?? 0) > 0],
    ["harness_failure", harnessError !== null],
    ["provider_error", ["auth", "quota", "rate_limit"].includes(output?.usage.providerError ?? "")],
    ["interrupted", facts.interrupted],
  ];
  return { stopReason: checks.find(([, hit]) => hit)?.[0] ?? null, harnessError };
}

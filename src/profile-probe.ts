import type { AppConfig } from "./config.js";
import type { DoctorResult } from "./doctor.js";
import { toResolvedExecutionProfile, type ConfiguredExecutionProfile } from "./execution-profile.js";
import type { ModelCatalog } from "./model-catalog.js";
import { PiSessionCreationError, type PiSessionAdapter, type PiSessionHandle } from "./pi-adapter.js";
import type { ProbeCode, ProbeFinding, ProbeReport } from "./setup-probe-result.js";
import { GLOBAL_ERRORS } from "./setup-writers-common.js";

export const PROBE_PROMPT = "Reply with exactly the word PONG and nothing else.";
export const PROBE_DEADLINES = { startMs: 60_000, turnMs: 120_000, cleanupMs: 10_000 } as const;

export function isPong(reply: string): boolean {
  return reply.trim().replace(/\.$/, "").toUpperCase() === "PONG";
}

export interface ProbeDependencies {
  readonly configPath: string;
  readonly loadConfig: (path: string) => Promise<AppConfig>;
  readonly doctor: () => Promise<DoctorResult>;
  readonly catalog: () => Promise<ModelCatalog>;
  readonly adapter: () => Promise<PiSessionAdapter>;
  readonly makeTempDir: () => Promise<string>;
  readonly removeDir: (path: string) => Promise<void>;
  readonly now?: () => number;
  readonly deadlines?: typeof PROBE_DEADLINES;
  readonly signal?: AbortSignal;
}

class ProbeTimeout extends Error {}
class ProbeInterrupted extends Error {}

/** Always detach the timer and listener, including when the operation rejects. */
async function bounded<T>(operation: () => T | Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new ProbeInterrupted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let interrupt: (() => void) | undefined;
  const stop = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeout()), ms);
    interrupt = () => reject(new ProbeInterrupted());
    signal?.addEventListener("abort", interrupt, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), stop]);
  } finally {
    clearTimeout(timer);
    if (interrupt) signal?.removeEventListener("abort", interrupt);
  }
}

async function dispose(handle: PiSessionHandle, ms: number, abort: boolean): Promise<void> {
  // An uncooperative abort must not prevent disposal or directory removal.
  if (abort) await bounded(() => handle.abort(), ms).catch(() => undefined);
  await bounded(() => handle.dispose(), ms).catch(() => undefined);
}

async function probe(profile: ConfiguredExecutionProfile, adapter: PiSessionAdapter, deps: ProbeDependencies): Promise<ProbeFinding> {
  const deadlines = deps.deadlines ?? PROBE_DEADLINES;
  const now = deps.now ?? Date.now;
  const started = now();
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  deps.signal?.addEventListener("abort", interrupt, { once: true });
  if (deps.signal?.aborted) controller.abort();
  let cwd: string | undefined;
  let handle: PiSessionHandle | undefined;
  let abandoned = false;
  let providerTurn = false;
  let code: ProbeCode = "probe_start_failed";
  let startCode: ProbeFinding["startCode"];
  let abort = false;
  try {
    cwd = await deps.makeTempDir();
    const input = { cwd, workspace: "profile-probe", executionProfile: toResolvedExecutionProfile(profile), signal: controller.signal };
    handle = await bounded(async () => {
      const created = await adapter.create(input);
      // A create that ignores cancellation may finish after its deadline.
      if (abandoned) {
        await dispose(created, deadlines.cleanupMs, true);
        throw new ProbeTimeout();
      }
      return created;
    }, deadlines.startMs, deps.signal);
    code = "probe_turn_failed";
    const outcome = await bounded(() => handle!.prompt(PROBE_PROMPT, (accepted) => {
      if (accepted) providerTurn = true;
    }), deadlines.turnMs, deps.signal);
    code = outcome.status === "completed"
      ? isPong(outcome.assistantText) ? "probe_passed" : "probe_unexpected_reply"
      : "probe_turn_failed";
  } catch (error) {
    if (error instanceof ProbeTimeout || error instanceof ProbeInterrupted) {
      abandoned = true;
      controller.abort();
      abort = true;
      if (error instanceof ProbeTimeout) code = "probe_timeout";
    } else if (handle === undefined) {
      startCode = error instanceof PiSessionCreationError ? error.code : "pi_session_creation_failed";
    }
  } finally {
    deps.signal?.removeEventListener("abort", interrupt);
    try {
      if (handle) await dispose(handle, deadlines.cleanupMs, abort || deps.signal?.aborted === true);
    } finally {
      if (cwd !== undefined) await deps.removeDir(cwd);
    }
  }
  return {
    profile: profile.alias, status: code === "probe_passed" ? "ok" : "failed", code,
    ...(startCode === undefined ? {} : { startCode }), providerTurn, durationMs: Math.max(0, now() - started),
  };
}

export async function runProfileProbe(request: { profiles: readonly string[]; apply: boolean }, deps: ProbeDependencies): Promise<ProbeReport> {
  const profiles = [...new Set(request.profiles)];
  const doctor: { blocking: string[]; other: string[] } = { blocking: [], other: [] };
  const findings: ProbeFinding[] = [];
  const report = (refusal?: ProbeReport["refusal"]): ProbeReport => {
    const status = refusal !== undefined || findings.some((finding) => finding.status === "failed")
      ? "failed" : request.apply ? "ok" : "planned";
    return {
      schemaVersion: 1, operation: request.apply ? "apply" : "dry-run", status,
      ...(refusal === undefined ? {} : { refusal }), doctor, findings, usage: "unknown",
      exitCode: refusal === "operation_interrupted" ? 130 : status === "failed" ? 1 : 0,
    };
  };
  if (deps.signal?.aborted) return report("operation_interrupted");
  const diagnosis = await deps.doctor();
  for (const check of diagnosis.checks) {
    if (check.severity === "ok") continue;
    const list = check.severity === "error" && (GLOBAL_ERRORS.has(check.id) || profiles.includes(check.subject.split(":")[0]!))
      ? doctor.blocking : doctor.other;
    if (!list.includes(check.id)) list.push(check.id);
  }
  if (deps.signal?.aborted) return report("operation_interrupted");
  if (doctor.blocking.length) return report("doctor_failed");
  let config: AppConfig;
  try {
    config = await deps.loadConfig(deps.configPath);
  } catch {
    return report(deps.signal?.aborted ? "operation_interrupted" : "config_unusable");
  }
  if (deps.signal?.aborted) return report("operation_interrupted");
  const catalog = await deps.catalog();
  let adapter: PiSessionAdapter | undefined;
  for (const alias of profiles) {
    if (deps.signal?.aborted) return report("operation_interrupted");
    const profile = config.executionProfiles.get(alias);
    const provider = profile && catalog.providers().find((entry) => entry.id === profile.provider);
    const code: ProbeCode = !profile ? "probe_profile_unknown"
      : !provider ? "probe_provider_unknown"
      : !provider.models.includes(profile.model) ? "probe_model_unknown"
      : !provider.authConfigured ? "probe_auth_missing" : "probe_planned";
    if (code !== "probe_planned" || !request.apply) {
      findings.push({ profile: alias, status: code === "probe_planned" ? "planned" : "failed", code, providerTurn: false });
      continue;
    }
    adapter ??= await deps.adapter();
    if (deps.signal?.aborted) return report("operation_interrupted");
    findings.push(await probe(profile!, adapter, deps));
    if (deps.signal?.aborted) return report("operation_interrupted");
  }
  return report();
}

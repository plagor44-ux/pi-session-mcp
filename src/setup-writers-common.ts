import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { ALIAS_PATTERN } from "./execution-profile.js";
import { runDoctor } from "./doctor.js";
import { MAX_WRITERS, type WorkspaceModeEntry } from "./execution-modes.js";
import { acquireOverrideLock, MAX_OVERRIDE_LOCK_TIMEOUT_MS, OverrideLockError } from "./override-lock.js";
import { createCommandMcpStdioLauncher, createProcessRunner } from "./setup-process.js";
import { DurableOwnershipStore, type OwnershipAccess, type OwnershipStore } from "./setup-ownership.js";
import { localHookNeededByOthers, ownsWakeHook, runWakeHook, type WakeHookOutcome } from "./setup-hooks.js";
import type { SetupFinding, SetupOperation, SetupTarget } from "./setup-result.js";
import { createWriterRegistrationAdapter, unregisterWriter, type WriterRegistrationIntent, type WriterRegistrationAdapter } from "./client-adapters/writer-registration.js";
import { verifyMcpCapabilities } from "./client-adapters/mcp-verifier.js";
import { IMAGE_PULL_TIMEOUT_MS } from "./writer-boundary.js";
import { acquireWriterLease, WriterLeaseError } from "./writer-lease.js";
import { ensureWriterAbsent } from "./writer-fence.js";

import * as lifecycle from "./writer-lifecycle.js";
import * as acceptance from "./writer-acceptance.js";
import { readWriterState, writerName, writerPaths, writerRegistrationName, writersRoot, WRITER_NAME_PATTERN } from "./writer-state.js";

/** Services, fencing, the Doctor gate and removal shared by mode changes, reconciliation and single-writer operations. */

export const SETUP_LEASE_WAIT_MS = 10_000;
export const FENCE_CODES: readonly string[] = ["writer_busy", "writer_fenced", "writer_lease_unavailable"];
/**
 * Failures of shared setup state rather than of one writer: they end the whole reconciliation (#180). The ownership
 * store's own failures count; `ownership_unavailable` and `ownership_diverged` concern one writer's registration.
 */
export const INFRASTRUCTURE_CODE = /^(?:ownership_(?!unavailable$|diverged$)[a-z_]+|config_[a-z_]+|operation_aborted|platform_unsupported)$/;
export const GLOBAL_ERRORS = new Set(["node_version_unsupported", "package_metadata_unreadable", "build_missing", "build_stale", "version_mismatch", "config_missing", "config_unreadable", "config_invalid", "skill_controller_selected"]);

export interface WriterSetupDependencies {
  configPath: string;
  releaseRoot: string;
  home?: string;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
  runner?: lifecycle.WriterContext["runner"];
  lifecycle?: typeof lifecycle;
  acceptance?: typeof acceptance;
  ownership?: OwnershipStore;
  adapter?: WriterRegistrationAdapter;
  doctor?: typeof runDoctor;
  verify?: typeof verifyMcpCapabilities;
  launch?: typeof createCommandMcpStdioLauncher;
  lock?: typeof acquireOverrideLock;
  lease?: typeof acquireWriterLease;
  ensureAbsent?: typeof ensureWriterAbsent;
  containerRuntime?: () => Promise<boolean>;
}
const safeAlias = (alias: string): string => ALIAS_PATTERN.test(alias) ? alias : "invalid";
export const targetFor = (alias: string, name: string): SetupTarget => ({ client: "writer", scope: safeAlias(alias), alias: WRITER_NAME_PATTERN.test(name) || (alias === "host" && name === "control") ? name : "invalid" });
export const modesTarget = (alias: string): SetupTarget => ({ client: "modes", scope: "workspace", alias: safeAlias(alias) });
export const codeFor = (error: unknown): string => error instanceof OverrideLockError || error instanceof WriterLeaseError ? error.code : error instanceof Error && /^[a-z][a-z0-9_]{0,63}$/.test(error.message) ? error.message : "writer_operation_failed";
export function services(deps: WriterSetupDependencies) {
  const home = deps.home ?? homedir();
  const runner = deps.runner ?? createProcessRunner({ timeoutMs: IMAGE_PULL_TIMEOUT_MS, maxOutputBytes: 1_048_576, ...(deps.signal ? { signal: deps.signal } : {}) });
  return { home, runner, life: deps.lifecycle ?? lifecycle, accept: deps.acceptance ?? acceptance,
    ownership: deps.ownership ?? new DurableOwnershipStore(join(home, ".local", "state", "pi-session-mcp", "ownership.json"), { ...(deps.signal ? { signal: deps.signal } : {}) }),
    adapter: deps.adapter ?? createWriterRegistrationAdapter(runner) };
}
export async function context(alias: string, deps: WriterSetupDependencies): Promise<lifecycle.WriterContext> {
  const config = await loadConfig(deps.configPath);
  const checkout = config.workspaces.get(alias);
  if (!checkout) throw new Error("alias_unknown");
  const { home, runner } = services(deps);
  return { home, runner, checkout, alias, releaseRoot: deps.releaseRoot, nodePath: process.execPath };
}
/**
 * One global lock serializes every writer setup operation: they share the execution-modes file, writer state, writer
 * leases, ownership and hook state. It waits the longest bound the lock allows, because under load other repositories'
 * operations run long (#229). Skill customization and the modes step keep the default bound.
 */
export async function locked<T>(deps: WriterSetupDependencies, action: () => Promise<T>): Promise<T> {
  const directory = writersRoot(deps.home ?? homedir());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const lock = await (deps.lock ?? acquireOverrideLock)(directory, { timeoutMs: MAX_OVERRIDE_LOCK_TIMEOUT_MS, ...(deps.signal ? { signal: deps.signal } : {}) });
  try { return await action(); } finally { await lock.release(); }
}
export async function fenced<T>(ctx: lifecycle.WriterContext, name: string, deps: WriterSetupDependencies, action: (ctx: lifecycle.WriterContext) => Promise<T>): Promise<T> {
  let lease;
  try { lease = await (deps.lease ?? acquireWriterLease)(ctx.home, name, { waitMs: SETUP_LEASE_WAIT_MS, ...(deps.signal ? { signal: deps.signal } : {}) }); }
  catch (error) { throw new Error(error instanceof WriterLeaseError && error.code === "writer_busy" ? "writer_busy" : "writer_lease_unavailable"); }
  try {
    try { await (deps.ensureAbsent ?? ensureWriterAbsent)(ctx.runner, writerPaths(ctx.home, name), name, { leaseFd: lease.fd }); }
    catch { throw new Error("writer_fenced"); }
    return await action({ ...ctx, leaseFd: lease.fd });
  } finally { await lease.release(); }
}
export function intent(ctx: lifecycle.WriterContext, name: string, client: "claude-code" | "codex"): WriterRegistrationIntent {
  return { client, name: writerRegistrationName(name), wrapperPath: writerPaths(ctx.home, name).wrapper, projectDir: ctx.checkout };
}
/**
 * The wake hook of a writer's Claude Code registration, in the local settings of the operator's
 * project. Claude Code only: a Codex writer has no hook. The writer's own configuration decides
 * whether delivery is wanted; the entry is shared per project, see `localHookNeededByOthers`.
 * Findings without news (`hook_not_enabled`, `hook_not_owned`) are not reported.
 */
export async function writerHook(ctx: lifecycle.WriterContext, name: string, deps: WriterSetupDependencies, operation: "apply" | "dry-run" | "verify" | "remove", enabled: boolean): Promise<WakeHookOutcome | undefined> {
  const { ownership } = services(deps);
  const roots = { packageRoot: deps.releaseRoot, home: ctx.home, cwd: ctx.checkout, env: process.env, nodePath: ctx.nodePath };
  // Nothing wanted and nothing owned: not even the project's settings are looked at.
  if (!enabled && !await ownsWakeHook("local", roots, ownership)) return undefined;
  const request = (access: OwnershipAccess, op: SetupOperation) => runWakeHook({
    operation: op, scope: "local", enabled, ownership: access,
    roots,
    keep: () => localHookNeededByOthers({ ownership: access, home: ctx.home, cwd: ctx.checkout, configPath: deps.configPath, except: { writer: name } }),
  });
  const outcome = operation === "apply" || operation === "remove" ? await ownership.transaction((access) => request(access, operation)) : await request(ownership, operation);
  return outcome.code === "hook_not_enabled" || outcome.code === "hook_not_owned" ? undefined : outcome;
}
export class DoctorGateError extends Error {
  constructor(readonly findings: readonly SetupFinding[]) { super("doctor_failed"); }
}
export async function doctorGate(ctx: lifecycle.WriterContext, deps: WriterSetupDependencies): Promise<void> {
  const doctor = await (deps.doctor ?? runDoctor)({ home: ctx.home, packageRoot: deps.releaseRoot, configPath: deps.configPath, loadConfig: () => loadConfig(deps.configPath) });
  const ownSubjects = new Set([ctx.alias, ...Array.from({ length: 16 }, (_, index) => writerName(ctx.alias, index + 1))]);
  // A refused profile of this repository is its own finding: collect, finish and the profile change that fixes it must stay possible (#141).
  // Another repository's writer that is not ready is untouched by this step and expected after an upgrade; counting it would deadlock
  // the repository steps of two container repositories (#148).
  // The container runtime probe is host-wide, so `container_runtime_unavailable` of another repository says nothing about it
  // that this step does not see itself: the step uses Podman for its own repository and fails closed with its own code when
  // Podman is really unusable. A slow host must not block it on the others' findings (#229).
  const own = (check: { id: string; subject: string }) => ownSubjects.has(check.subject)
    || (check.id === "container_profile_refused" && check.subject.startsWith(`${ctx.alias}:`))
    || (check.id === "writer_not_ready" && WRITER_NAME_PATTERN.test(check.subject))
    || check.id === "container_runtime_unavailable";
  const blocking = doctor.checks.filter((check) => check.severity === "error" && !own(check));
  // One finding per check and alias: several `config_invalid` locations (#173) all map to the alias `invalid`.
  const findings = blocking.map((check) => ({ status: "failed" as const, code: check.id, target: { client: "doctor", scope: "check", alias: gateAlias(check.id, check.subject) } }));
  const unique = findings.filter((finding, index) => findings.findIndex((other) => other.code === finding.code && other.target.alias === finding.target.alias) === index);
  if (unique.length) throw new DoctorGateError(unique);
}
/** The alias that leads a Doctor subject: `<profile>:<package>` and writer names report their alias part; global checks have none. */
function gateAlias(id: string, subject: string): string {
  if (GLOBAL_ERRORS.has(id)) return "invalid";
  const head = subject.split(":")[0] ?? "";
  return safeAlias(WRITER_NAME_PATTERN.test(head) ? head.slice(0, head.lastIndexOf("-w")) : head);
}
export async function preflight(ctx: lifecycle.WriterContext, names: readonly string[], discard: boolean, deps: WriterSetupDependencies): Promise<void> {
  if (discard) return;
  for (const name of names) {
    const state = await readWriterState(ctx.home, name);
    const work = await (deps.lifecycle ?? lifecycle).inspectWork(ctx, name);
    if (!work.baseline && state?.collected?.digest !== work.digest) throw new Error("writer_uncollected");
  }
}
export async function remove(ctx: lifecycle.WriterContext, name: string, discard: boolean, deps: WriterSetupDependencies, extras: WakeHookOutcome[] = []): Promise<lifecycle.WriterOutcome> {
  await preflight(ctx, [name], discard, deps);
  const { adapter, ownership, life } = services(deps);
  // Remove registrations before deleting the wrapper used to prove ownership.
  for (const client of ["claude-code", "codex"] as const) {
    const expected = intent(ctx, name, client);
    const owned = await ownership.get({ client, scope: client === "codex" ? "user" : "local", alias: expected.name });
    if (owned) await unregisterWriter(ownership, adapter, expected);
    else if (["equivalent", "divergent"].includes(await adapter.inspect(expected))) throw new Error("ownership_unavailable");
  }
  // After the registration is gone. A hook that cannot be edited is reported, not a reason to keep the
  // writer: the operator's settings are not the writer's to hold hostage, and the record keeps the entry owned.
  const hook = await writerHook(ctx, name, deps, "remove", false).catch((): WakeHookOutcome => ({ status: "failed", code: "hook_install_failed" }));
  if (hook) extras.push(hook);
  return life.removeWriter(ctx, name, { discard });
}
export const writerIndex = (name: string): number => Number(name.slice(name.lastIndexOf("-w") + 2));
/** Which writers a mode entry keeps, which of those still need provisioning, and which existing writers it no longer wants. */
export async function plan(ctx: lifecycle.WriterContext, entry: WorkspaceModeEntry) {
  const keep: string[] = [], missing: string[] = [], surplus: string[] = [];
  for (let index = 1; index <= MAX_WRITERS; index++) {
    const name = writerName(ctx.alias, index), state = await readWriterState(ctx.home, name);
    if (entry.mode === "container" && index <= entry.container!.writers) { keep.push(name); if (!state || state.phase === "provisioning") missing.push(name); }
    else if (state) surplus.push(name);
  }
  return { keep, missing, surplus };
}
export type WriterPlan = Awaited<ReturnType<typeof plan>>;

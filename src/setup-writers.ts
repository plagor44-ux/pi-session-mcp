import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { containerRuntimeUsable } from "./container-runtime.js";
import { ALIAS_PATTERN } from "./execution-profile.js";
import { runDoctor } from "./doctor.js";
import { MAX_WRITERS, type WorkspaceModeEntry } from "./execution-modes.js";
import { changeExecutionMode, type ModeRequest } from "./setup-modes.js";
import { acquireOverrideLock, OverrideLockError } from "./override-lock.js";
import { createCommandMcpStdioLauncher, createProcessRunner } from "./setup-process.js";
import { DurableOwnershipStore, type OwnershipAccess, type OwnershipStore } from "./setup-ownership.js";
import { localHookNeededByOthers, ownsWakeHook, runWakeHook, type WakeHookOutcome } from "./setup-hooks.js";
import { result, type SetupFinding, type SetupOperation, type SetupResult, type SetupTarget } from "./setup-result.js";
import { createWriterRegistrationAdapter, unregisterWriter, type WriterRegistrationIntent, type WriterRegistrationAdapter } from "./client-adapters/writer-registration.js";
import { verifyMcpCapabilities } from "./client-adapters/mcp-verifier.js";
import { sameWriterLimits, writerLimits } from "./writer-limits.js";
import { IMAGE_PULL_TIMEOUT_MS, podmanCgroupControllers } from "./writer-boundary.js";
import { acquireWriterLease, WriterLeaseError } from "./writer-lease.js";
import { ensureWriterAbsent } from "./writer-fence.js";

import * as lifecycle from "./writer-lifecycle.js";
import * as acceptance from "./writer-acceptance.js";
import { skillOverrideDirectory } from "./skill-library.js";
import { renderWrapper, wrapperDigest } from "./writer-wrapper.js";
import { readWriterState, writeWriterState, writerName, writerPaths, writerRegistrationName, writersRoot, WRITER_NAME_PATTERN } from "./writer-state.js";

export const SETUP_LEASE_WAIT_MS = 10_000;
const FENCE_CODES: readonly string[] = ["writer_busy", "writer_fenced", "writer_lease_unavailable"];
/** Failures of shared setup state rather than of one writer: they end the whole reconciliation (#180). */
const INFRASTRUCTURE_CODE = /^(?:ownership_[a-z_]+|config_[a-z_]+|operation_aborted|platform_unsupported)$/;

export type WriterOperation = "collect" | "reset" | "recreate" | "finish" | "remove" | "verify";
export interface WriterOptions { apply: boolean; discard: boolean; baseRef?: string; }
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
const targetFor = (alias: string, name: string): SetupTarget => ({ client: "writer", scope: safeAlias(alias), alias: WRITER_NAME_PATTERN.test(name) || (alias === "host" && name === "control") ? name : "invalid" });
const modesTarget = (alias: string): SetupTarget => ({ client: "modes", scope: "workspace", alias: safeAlias(alias) });
const codeFor = (error: unknown): string => error instanceof OverrideLockError || error instanceof WriterLeaseError ? error.code : error instanceof Error && /^[a-z][a-z0-9_]{0,63}$/.test(error.message) ? error.message : "writer_operation_failed";
function services(deps: WriterSetupDependencies) {
  const home = deps.home ?? homedir();
  const runner = deps.runner ?? createProcessRunner({ timeoutMs: IMAGE_PULL_TIMEOUT_MS, maxOutputBytes: 1_048_576, ...(deps.signal ? { signal: deps.signal } : {}) });
  return { home, runner, life: deps.lifecycle ?? lifecycle, accept: deps.acceptance ?? acceptance,
    ownership: deps.ownership ?? new DurableOwnershipStore(join(home, ".local", "state", "pi-session-mcp", "ownership.json"), { ...(deps.signal ? { signal: deps.signal } : {}) }),
    adapter: deps.adapter ?? createWriterRegistrationAdapter(runner) };
}
async function context(alias: string, deps: WriterSetupDependencies): Promise<lifecycle.WriterContext> {
  const config = await loadConfig(deps.configPath);
  const checkout = config.workspaces.get(alias);
  if (!checkout) throw new Error("alias_unknown");
  const { home, runner } = services(deps);
  return { home, runner, checkout, alias, releaseRoot: deps.releaseRoot, nodePath: process.execPath };
}
async function locked<T>(deps: WriterSetupDependencies, action: () => Promise<T>): Promise<T> {
  const directory = writersRoot(deps.home ?? homedir());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const lock = await (deps.lock ?? acquireOverrideLock)(directory, { ...(deps.signal ? { signal: deps.signal } : {}) });
  try { return await action(); } finally { await lock.release(); }
}
async function fenced<T>(ctx: lifecycle.WriterContext, name: string, deps: WriterSetupDependencies, action: (ctx: lifecycle.WriterContext) => Promise<T>): Promise<T> {
  let lease;
  try { lease = await (deps.lease ?? acquireWriterLease)(ctx.home, name, { waitMs: SETUP_LEASE_WAIT_MS, ...(deps.signal ? { signal: deps.signal } : {}) }); }
  catch (error) { throw new Error(error instanceof WriterLeaseError && error.code === "writer_busy" ? "writer_busy" : "writer_lease_unavailable"); }
  try {
    try { await (deps.ensureAbsent ?? ensureWriterAbsent)(ctx.runner, writerPaths(ctx.home, name), name, { leaseFd: lease.fd }); }
    catch { throw new Error("writer_fenced"); }
    return await action({ ...ctx, leaseFd: lease.fd });
  } finally { await lease.release(); }
}
function intent(ctx: lifecycle.WriterContext, name: string, client: "claude-code" | "codex"): WriterRegistrationIntent {
  return { client, name: writerRegistrationName(name), wrapperPath: writerPaths(ctx.home, name).wrapper, projectDir: ctx.checkout };
}
/**
 * The wake hook of a writer's Claude Code registration, in the local settings of the operator's
 * project. Claude Code only: a Codex writer has no hook. The writer's own configuration decides
 * whether delivery is wanted; the entry is shared per project, see `localHookNeededByOthers`.
 * Findings without news (`hook_not_enabled`, `hook_not_owned`) are not reported.
 */
async function writerHook(ctx: lifecycle.WriterContext, name: string, deps: WriterSetupDependencies, operation: "apply" | "dry-run" | "verify" | "remove", enabled: boolean): Promise<WakeHookOutcome | undefined> {
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
class DoctorGateError extends Error {
  constructor(readonly findings: readonly SetupFinding[]) { super("doctor_failed"); }
}
async function doctorGate(ctx: lifecycle.WriterContext, deps: WriterSetupDependencies): Promise<void> {
  const doctor = await (deps.doctor ?? runDoctor)({ home: ctx.home, packageRoot: deps.releaseRoot, configPath: deps.configPath, loadConfig: () => loadConfig(deps.configPath) });
  const ownSubjects = new Set([ctx.alias, ...Array.from({ length: 16 }, (_, index) => writerName(ctx.alias, index + 1))]);
  // A refused profile of this repository is its own finding: collect, finish and the profile change that fixes it must stay possible (#141).
  // Another repository's writer that is not ready is untouched by this step and expected after an upgrade; counting it would deadlock
  // the repository steps of two container repositories (#148).
  const own = (check: { id: string; subject: string }) => ownSubjects.has(check.subject)
    || (check.id === "container_profile_refused" && check.subject.startsWith(`${ctx.alias}:`))
    || (check.id === "writer_not_ready" && WRITER_NAME_PATTERN.test(check.subject));
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
async function preflight(ctx: lifecycle.WriterContext, names: readonly string[], discard: boolean, deps: WriterSetupDependencies): Promise<void> {
  if (discard) return;
  for (const name of names) {
    const state = await readWriterState(ctx.home, name);
    const work = await (deps.lifecycle ?? lifecycle).inspectWork(ctx, name);
    if (!work.baseline && state?.collected?.digest !== work.digest) throw new Error("writer_uncollected");
  }
}
async function remove(ctx: lifecycle.WriterContext, name: string, discard: boolean, deps: WriterSetupDependencies, extras: WakeHookOutcome[] = []): Promise<lifecycle.WriterOutcome> {
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
const writerIndex = (name: string): number => Number(name.slice(name.lastIndexOf("-w") + 2));
async function plan(ctx: lifecycle.WriterContext, entry: WorkspaceModeEntry) {
  const keep: string[] = [], missing: string[] = [], surplus: string[] = [];
  for (let index = 1; index <= MAX_WRITERS; index++) {
    const name = writerName(ctx.alias, index), state = await readWriterState(ctx.home, name);
    if (entry.mode === "container" && index <= entry.container!.writers) { keep.push(name); if (!state || state.phase === "provisioning") missing.push(name); }
    else if (state) surplus.push(name);
  }
  return { keep, missing, surplus };
}

type ReconcileRequest = { discard: boolean; baseRef?: string };
async function reconcileUnlocked(configPath: string, alias: string, request: ReconcileRequest, deps: WriterSetupDependencies): Promise<SetupResult> {
  const findings: SetupFinding[] = [];
  const ctx = await context(alias, { ...deps, configPath });
  const config = await loadConfig(configPath), entry = config.workspaceModes.get(alias)!;
  const planned = await plan(ctx, entry), { life, accept, ownership, adapter } = services(deps);
  const add = (name: string, outcome: lifecycle.WriterOutcome): void => { findings.push({ target: targetFor(alias, name), ...outcome }); };
  await doctorGate(ctx, deps);
  // A surplus writer that cannot be fenced is reported on its own target and left in place; the others proceed.
  const unfenced = new Set<string>();
  for (const name of planned.surplus) {
    try { await fenced(ctx, name, deps, (leased) => preflight(leased, [name], request.discard, deps)); }
    catch (error) {
      if (!FENCE_CODES.includes(codeFor(error))) throw error;
      unfenced.add(name); add(name, { status: "failed", code: codeFor(error) });
    }
  }
  const rawConfig: unknown = JSON.parse(await readFile(configPath, "utf8")), overrideDirectory = skillOverrideDirectory(configPath);
  // Each writer's reconciliation, including first provisioning and acceptance, owns one fence.
  // A writer added without --base joins the recorded default base, so default starts find it. A recorded base that is
  // the repository default stays unset: provisioning then resolves origin/HEAD, as the first provisioning did.
  let baseRef = request.baseRef;
  const recordedBase = entry.container?.base;
  if (baseRef === undefined && recordedBase !== undefined && recordedBase !== await life.baseBranchName(ctx).catch(() => undefined)) baseRef = recordedBase;
  for (const name of planned.keep) {
    try { await fenced(ctx, name, deps, async (ctx) => {
      if (planned.missing.includes(name)) {
        const outcome = await life.provisionWriter(ctx, { index: writerIndex(name), settings: entry.container!, rawConfig, overrideDirectory, ...(baseRef ? { baseRef } : {}) });
        add(name, outcome); if (outcome.status === "failed") return;
      }
      // Settings first: a drifted writer is left exactly as it is, neither migrated nor accepted again (#134).
      if (!planned.missing.includes(name)) {
        const drift = await life.writerSettingsDrift(ctx, { index: writerIndex(name), settings: entry.container!, rawConfig, overrideDirectory });
        if (drift) { add(name, drift); return; }
        const state = await readWriterState(ctx.home, name);
        if (!state) throw new Error("writer_state_invalid");
        const limits = writerLimits(entry.container!);
        if (!sameWriterLimits(state.limits, limits)) {
          const { limits: _previous, ...rest } = state;
          await writeWriterState(ctx.home, name, { ...rest, ...(limits ? { limits } : {}) });
          add(name, { status: "ok", code: "writer_limits_updated" });
        }
      }
      // Decide for both clients before removing anything, so a divergent registration of one client never
      // costs the writer its owned registration of the other. A client that is not installed has nothing to keep.
      let divergent = false;
      const owned: WriterRegistrationIntent[] = [];
      for (const client of ["claude-code", "codex"] as const) {
        const expected = intent(ctx, name, client);
        const record = await ownership.get({ client, scope: client === "codex" ? "user" : "local", alias: expected.name });
        const current = await adapter.inspect(expected);
        if (record ? current === "divergent" : current === "equivalent" || current === "divergent") divergent = true;
        else if (record) owned.push(expected);
      }
      if (!divergent) {
        for (const expected of owned) {
          try { await unregisterWriter(ownership, adapter, expected); }
          catch (error) { if (codeFor(error) !== "ownership_diverged") throw error; divergent = true; }
        }
      }
      const hook = await writerHook(ctx, name, deps, "remove", false);
      if (hook) findings.push({ target: targetFor(alias, name), ...hook });
      const state = await readWriterState(ctx.home, name);
      if (!state) throw new Error("writer_state_invalid");
      if (divergent) {
        if (state.launch !== "legacy") await writeWriterState(ctx.home, name, { ...state, launch: "legacy" });
        add(name, { status: "failed", code: "registration_divergent" }); return;
      }
      const paths = writerPaths(ctx.home, name), wrapper = renderWrapper(ctx.nodePath, ctx.releaseRoot, name);
      if (!(await lstat(paths.wrapper).catch(() => undefined))?.isFile()) throw new Error("writer_state_invalid");
      const wrapperChanged = wrapperDigest(await readFile(paths.wrapper, "utf8")) !== wrapperDigest(wrapper);
      if (wrapperChanged) {
        const temporary = join(paths.root, `.wrapper-${randomUUID()}.tmp`);
        try { await writeFile(temporary, wrapper, { flag: "wx", mode: 0o700 }); await rename(temporary, paths.wrapper); }
        finally { await rm(temporary, { force: true }); }
      }
      // A launch change also needs fresh provider-free acceptance, even when wrapper bytes match.
      const migrated = state.launch !== "relay";
      if (migrated || wrapperChanged) {
        const { acceptance: _oldAcceptance, ...unaccepted } = state;
        await writeWriterState(ctx.home, name, { ...unaccepted, launch: "relay", phase: "not_ready" });
      }
      // A ready phase with a stale binding (package upgrade, new image, Podman version) is accepted again (#130).
      const current = await accept.acceptanceCurrent(ctx, name);
      if (current === "stale") {
        const outcome = await accept.acceptWriter(ctx, name);
        add(name, outcome); if (outcome.status === "failed") return;
      } else if (current === "unknown") { add(name, { status: "failed", code: "podman_unavailable" }); return; }
    }); } catch (error) {
      // A broken writer is reported on its own target and the others are still reconciled.
      if (INFRASTRUCTURE_CODE.test(codeFor(error))) throw error;
      add(name, { status: "failed", code: codeFor(error) });
    }
  }
  for (const name of planned.surplus) {
    if (unfenced.has(name)) continue;
    const extras: WakeHookOutcome[] = [];
    try { add(name, await fenced(ctx, name, deps, (leased) => remove(leased, name, request.discard, deps, extras))); }
    catch (error) { add(name, { status: "failed", code: codeFor(error) }); }
    for (const extra of extras) findings.push({ target: targetFor(alias, name), ...extra });
  }
  return result("apply", findings);
}

/** Serializes planning, destructive-work refusal, mode commit and writer reconciliation. */
export async function changeWriterMode(configPath: string, request: ModeRequest, deps: WriterSetupDependencies): Promise<SetupResult> {
  const operation = request.apply ? "apply" : "dry-run";
  const writerTarget = targetFor(request.alias, `${request.alias}-w1`);
  const failed = (code: string) => result(operation, [{ target: writerTarget, status: "failed", code }]);
  if (!ALIAS_PATTERN.test(request.alias)) return failed("alias_unknown");
  let runtimeProbe: Promise<boolean> | undefined;
  const containerRuntime = () => runtimeProbe ??= (deps.containerRuntime ?? containerRuntimeUsable)().catch(() => false);
  const modeDependencies = { containerRuntime, cgroupControllers: () => podmanCgroupControllers(services(deps).runner) };
  try {
    let writerWork = request.mode === "container";
    if (!writerWork) {
      let config;
      try { config = await loadConfig(configPath); }
      catch { return changeExecutionMode(configPath, request, modeDependencies); }
      writerWork = config.workspaceModes.get(request.alias)?.mode === "container";
      for (let index = 1; index <= MAX_WRITERS && !writerWork; index++) {
        try { await lstat(join(writersRoot(deps.home ?? homedir()), writerName(request.alias, index))); writerWork = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      if (!writerWork && request.mode === undefined) writerWork = await containerRuntime();
    }
    if (!writerWork) return changeExecutionMode(configPath, request, modeDependencies);
    if ((deps.platform ?? process.platform) !== "linux") return failed("platform_unsupported");
  } catch (error) { return failed(codeFor(error)); }
  const action = async () => {
    let proposed: WorkspaceModeEntry;
    // Record the base as provisioning resolves it, so a refused or remote-tracking form never reaches the modes file.
    let recorded: ModeRequest = request;
    if (request.baseRef !== undefined) {
      try { recorded = { ...request, baseRef: await services(deps).life.baseBranchName(await context(request.alias, deps), request.baseRef) }; }
      catch (error) { return failed(codeFor(error)); }
    } else if (request.mode === "container" || request.mode === undefined && await containerRuntime()) {
      const config = await loadConfig(configPath);
      if (!config.workspaceModes.get(request.alias)?.container?.base) {
        const bases = new Set<string>();
        for (let index = 1; index <= MAX_WRITERS; index++) {
          const state = await readWriterState(deps.home ?? homedir(), writerName(request.alias, index));
          if (state) bases.add(state.base.ref);
        }
        if (bases.size > 1) return result(operation, [{ target: modesTarget(request.alias), status: "failed", code: "workspace_base_ambiguous" }]);
        if (bases.size === 1) recorded = { ...request, baseRef: [...bases][0]!.replace(/^refs\/heads\//, "") };
        // First provisioning: record the base it will resolve (origin/HEAD, else main), so default starts find writers.
        else if (request.mode === "container") {
          try { recorded = { ...request, baseRef: await services(deps).life.baseBranchName(await context(request.alias, deps)) }; }
          catch (error) { return failed(codeFor(error)); }
        }
      }
    }
    return changeExecutionMode(configPath, recorded, {
      ...modeDependencies,
      beforeWrite: async (entry) => {
        proposed = entry;
        const ctx = await context(request.alias, deps), planned = await plan(ctx, entry);
        try {
          if (request.apply) {
            await doctorGate(ctx, deps);
            for (const name of planned.surplus) {
              try { await fenced(ctx, name, deps, (leased) => preflight(leased, [name], request.discard ?? false, deps)); }
              catch (error) {
                // Refuse the mode change, but name the writer that could not be fenced.
                if (FENCE_CODES.includes(codeFor(error))) return result(operation, [{ target: targetFor(request.alias, name), status: "failed", code: codeFor(error) }]);
                throw error;
              }
            }
            // Settings drift before the write, so a kept writer with changed settings refuses the mode
            // change itself and the modes file never records a mode no writer matches (#163). Read-only like
            // the dry run, which fences nothing; reconcile re-checks under its fence. Missing writers have
            // no settings yet.
            if (entry.mode === "container") {
              const { life } = services(deps);
              const rawConfig: unknown = JSON.parse(await readFile(configPath, "utf8")), overrideDirectory = skillOverrideDirectory(configPath);
              const drifted: SetupFinding[] = [];
              for (const name of planned.keep) {
                if (planned.missing.includes(name)) continue;
                const drift = await life.writerSettingsDrift(ctx, { index: writerIndex(name), settings: entry.container!, rawConfig, overrideDirectory });
                if (drift) drifted.push({ target: targetFor(request.alias, name), ...drift });
              }
              if (drifted.length) return result(operation, drifted);
            }
          } else await preflight(ctx, planned.surplus, request.discard ?? false, deps);
        }
        catch (error) { return error instanceof DoctorGateError ? result(operation, [...failed(error.message).findings, ...error.findings]) : failed(codeFor(error)); }
        return undefined;
      },
      afterChange: async (modes) => {
        let writers: SetupResult;
        try {
          if (request.apply) writers = await reconcileUnlocked(configPath, request.alias, { discard: request.discard ?? false, ...(request.baseRef ? { baseRef: request.baseRef } : {}) }, deps);
          else {
            const ctx = await context(request.alias, deps), planned = await plan(ctx, proposed), { life } = services(deps);
            const kept: SetupFinding[] = [];
            const rawConfig: unknown = JSON.parse(await readFile(configPath, "utf8")), overrideDirectory = skillOverrideDirectory(configPath);
            for (const name of planned.keep) {
              // The same settings check as apply, so a drifted writer shows before anything is applied (#134).
              const drift = await life.writerSettingsDrift(ctx, { index: writerIndex(name), settings: proposed.container!, rawConfig, overrideDirectory });
              const state = await readWriterState(ctx.home, name);
              const updatingLimits = state && state.phase !== "provisioning" && !sameWriterLimits(state.limits, writerLimits(proposed.container!));
              kept.push({ target: targetFor(request.alias, name), ...(drift ?? { status: "planned" as const, code: updatingLimits ? "writer_limits_update_planned" : "writer_planned" }) });
            }
            const refused = kept.some((finding) => finding.status === "failed" || finding.status === "divergent");
            writers = result("dry-run", [...kept, ...planned.surplus.map((name) => ({ target: targetFor(request.alias, name), status: "planned" as const, code: "writer_remove_planned" }))], refused ? "failed" : "planned");
          }
        } catch (error) { writers = error instanceof DoctorGateError ? result(operation, [...failed(error.message).findings, ...error.findings]) : failed(FENCE_CODES.includes(codeFor(error)) ? codeFor(error) : "writer_reconcile_failed"); }
        const findings = [...modes.findings, ...writers.findings].filter((f) => f.code !== "controllers_restart_required");
        if (request.apply && findings.some((f) => f.status === "ok")) findings.push({ target: modesTarget(request.alias), status: "ok", code: "controllers_restart_required" });
        return result(operation, findings, writers.exitCode ? "failed" : request.apply ? undefined : "planned");
      },
    });
  };
  try { return request.apply ? await locked(deps, action) : await action(); }
  catch (error) { return failed(codeFor(error)); }
}

const GLOBAL_ERRORS = new Set(["node_version_unsupported", "package_metadata_unreadable", "build_missing", "build_stale", "version_mismatch", "config_missing", "config_unreadable", "config_invalid"]);
export async function runWriterOperation(name: string, operation: WriterOperation, opts: WriterOptions, deps: WriterSetupDependencies): Promise<SetupResult> {
  const reportOperation: SetupOperation = operation === "verify" ? "verify" : opts.apply ? operation === "remove" ? "remove" : "apply" : "dry-run";
  if (!WRITER_NAME_PATTERN.test(name)) return result(reportOperation, [{ target: { client: "invalid", scope: "invalid", alias: "invalid" }, status: "failed", code: "usage_invalid" }], "failed", 64);
  const alias = name.slice(0, name.lastIndexOf("-w")), target = targetFor(alias, name);
  const done = (outcome: lifecycle.WriterOutcome, hooks: readonly WakeHookOutcome[] = []) => result(reportOperation, [
    { target, ...outcome },
    ...hooks.map((hook) => ({ target, ...hook })),
  ], outcome.status === "planned" ? "planned" : undefined);
  if ((deps.platform ?? process.platform) !== "linux") return done({ status: "failed", code: "platform_unsupported" });
  try {
    if (!opts.apply && operation !== "verify") { await context(alias, deps); return done({ status: "planned", code: `writer_${operation}_planned` }); }
    return await locked(deps, async () => fenced(await context(alias, deps), name, deps, async (ctx) => {
      const { life } = services(deps);
      if (operation === "verify") {
        const doctor = await (deps.doctor ?? runDoctor)({ home: ctx.home, packageRoot: deps.releaseRoot, configPath: deps.configPath, loadConfig: () => loadConfig(deps.configPath) });
        if (doctor.checks.some((check) => check.severity === "error" && (check.subject === name || GLOBAL_ERRORS.has(check.id)))) return done({ status: "failed", code: "doctor_failed" });
        const checked = await (deps.verify ?? verifyMcpCapabilities)({ launch: (deps.launch ?? createCommandMcpStdioLauncher)([writerPaths(ctx.home, name).wrapper], { HOME: ctx.home, PATH: process.env.PATH ?? "", PI_WRITER_NO_CREDENTIAL_REFRESH: "1", PI_WRITER_LEASE_FD: "3", ...(process.env.XDG_RUNTIME_DIR === undefined ? {} : { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }) }, { inheritFds: [ctx.leaseFd!] }) });
        if (checked.status !== "verified") return done({ status: "failed", code: `mcp_${checked.status}` });
        return done({ status: "ok", code: "mcp_verified" });
      }
      try { await doctorGate(ctx, deps); }
      catch (error) {
        if (error instanceof DoctorGateError) return result(reportOperation, [...done({ status: "failed", code: error.message }).findings, ...error.findings]);
        throw error;
      }
      const entry = (await loadConfig(deps.configPath)).workspaceModes.get(alias);
      const baseRef = opts.baseRef ?? entry?.container?.base;
      const baseOptions = baseRef === undefined ? {} : { baseRef };
      const extras: WakeHookOutcome[] = [];
      const outcome = operation === "remove" ? await remove(ctx, name, opts.discard, deps, extras)
        : operation === "collect" ? await life.collectWriter(ctx, name)
        : operation === "reset" ? await life.resetWriter(ctx, name, opts)
        : operation === "recreate" ? await life.recreateWriter(ctx, name, { ...opts, ...baseOptions })
        : await life.finishWriter(ctx, name, baseOptions);
      return done(outcome, extras);
    }));
  } catch (error) { return done({ status: "failed", code: codeFor(error) }); }
}

export async function runWriterControl(alias: string, apply: boolean, deps: WriterSetupDependencies): Promise<SetupResult> {
  const target = targetFor("host", "control"), operation = apply ? "apply" : "dry-run";
  try {
    if ((deps.platform ?? process.platform) !== "linux") throw new Error("platform_unsupported");
    if (!apply) await context(alias, deps);
    const outcome = apply ? await locked(deps, async () => (deps.acceptance ?? acceptance).runIsolationControl(await context(alias, deps))) : { status: "planned" as const, code: "isolation_control_planned" };
    return result(operation, [{ target, ...outcome }], apply ? undefined : "planned");
  } catch (error) { return result(operation, [{ target, status: "failed", code: codeFor(error) }]); }
}

import { chmod, lstat, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { containerRuntimeUsable } from "./container-runtime.js";
import { ALIAS_PATTERN } from "./execution-profile.js";
import { runDoctor } from "./doctor.js";
import type { WorkspaceModeEntry } from "./execution-modes.js";
import { changeExecutionMode, type ModeRequest } from "./setup-modes.js";
import { acquireOverrideLock, OverrideLockError } from "./override-lock.js";
import { createCommandMcpStdioLauncher, createProcessRunner } from "./setup-process.js";
import { DurableOwnershipStore, type OwnershipAccess, type OwnershipStore } from "./setup-ownership.js";
import { localHookNeededByOthers, ownsWakeHook, runWakeHook, type WakeHookOutcome } from "./setup-hooks.js";
import { result, type SetupFinding, type SetupOperation, type SetupResult, type SetupTarget } from "./setup-result.js";
import { createWriterRegistrationAdapter, registerWriter, unregisterWriter, type WriterRegistrationIntent, type WriterRegistrationAdapter } from "./client-adapters/writer-registration.js";
import { verifyMcpCapabilities } from "./client-adapters/mcp-verifier.js";
import { IMAGE_PULL_TIMEOUT_MS } from "./writer-boundary.js";
import * as lifecycle from "./writer-lifecycle.js";
import * as acceptance from "./writer-acceptance.js";
import { skillOverrideDirectory } from "./skill-library.js";
import { readWriterState, writerEventDeliveryEnabled, writerName, writerPaths, writerRegistrationName, writersRoot, WRITER_NAME_PATTERN } from "./writer-state.js";

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
  containerRuntime?: () => Promise<boolean>;
}
const safeAlias = (alias: string): string => ALIAS_PATTERN.test(alias) ? alias : "invalid";
const targetFor = (alias: string, name: string): SetupTarget => ({ client: "writer", scope: safeAlias(alias), alias: WRITER_NAME_PATTERN.test(name) || (alias === "host" && name === "control") ? name : "invalid" });
const modesTarget = (alias: string): SetupTarget => ({ client: "modes", scope: "workspace", alias: safeAlias(alias) });
const codeFor = (error: unknown): string => error instanceof OverrideLockError ? error.code : error instanceof Error && /^[a-z][a-z0-9_]{0,63}$/.test(error.message) ? error.message : "writer_operation_failed";
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
/** Whether a provisioned writer's own configuration enables delivery; before provisioning the host configuration decides, as provisioning copies it. */
async function writerDelivery(ctx: lifecycle.WriterContext, name: string, hostDelivery: boolean): Promise<boolean> {
  return await readWriterState(ctx.home, name) ? writerEventDeliveryEnabled(writerPaths(ctx.home, name).config) : hostDelivery;
}
async function doctorGate(ctx: lifecycle.WriterContext, deps: WriterSetupDependencies): Promise<void> {
  const doctor = await (deps.doctor ?? runDoctor)({ home: ctx.home, packageRoot: deps.releaseRoot, loadConfig: () => loadConfig(deps.configPath) });
  const ownSubjects = new Set([ctx.alias, ...Array.from({ length: 16 }, (_, index) => writerName(ctx.alias, index + 1))]);
  if (doctor.checks.some((check) => check.severity === "error" && !ownSubjects.has(check.subject))) throw new Error("doctor_failed");
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
  for (let index = 1; index <= 16; index++) {
    const name = writerName(ctx.alias, index), state = await readWriterState(ctx.home, name);
    if (entry.mode === "container" && index <= entry.container!.writers) { keep.push(name); if (!state || state.phase === "provisioning") missing.push(name); }
    else if (state) surplus.push(name);
  }
  return { keep, missing, surplus };
}

type ReconcileRequest = { discard: boolean; baseRef?: string; codex: boolean };
async function reconcileUnlocked(configPath: string, alias: string, request: ReconcileRequest, deps: WriterSetupDependencies): Promise<SetupResult> {
  const findings: SetupFinding[] = [];
  const ctx = await context(alias, { ...deps, configPath });
  const config = await loadConfig(configPath), entry = config.workspaceModes.get(alias)!;
  const planned = await plan(ctx, entry), { life, accept, ownership, adapter } = services(deps);
  const add = (name: string, outcome: lifecycle.WriterOutcome): void => { findings.push({ target: targetFor(alias, name), ...outcome }); };
  await doctorGate(ctx, deps);
  await preflight(ctx, planned.surplus, request.discard, deps);
  const rawConfig: unknown = JSON.parse(await readFile(configPath, "utf8")), overrideDirectory = skillOverrideDirectory(configPath);
  const failedProvision = new Set<string>();
  for (const name of planned.missing) {
    const outcome = await life.provisionWriter(ctx, { index: writerIndex(name), settings: entry.container!, rawConfig, overrideDirectory, ...(request.baseRef ? { baseRef: request.baseRef } : {}) });
    add(name, outcome); if (outcome.status === "failed") failedProvision.add(name);
  }
  // Writers left exactly as they are: neither accepted nor registered in this run.
  const held = new Set<string>();
  for (const name of planned.keep) {
    if (failedProvision.has(name)) continue;
    if (!planned.missing.includes(name)) {
      // Settings first: a writer that no longer matches its configuration is not accepted or registered again (#134).
      const drift = await life.writerSettingsDrift(ctx, { index: writerIndex(name), settings: entry.container!, rawConfig, overrideDirectory });
      if (drift) { held.add(name); add(name, drift); continue; }
    }
    // A ready phase with a stale binding (package upgrade, new image, Podman version) is accepted again (#130).
    const current = await accept.acceptanceCurrent(ctx, name);
    if (current === "stale") add(name, await accept.acceptWriter(ctx, name));
    else if (current === "unknown") { held.add(name); add(name, { status: "failed", code: "podman_unavailable" }); }
  }
  for (const name of planned.keep) {
    if (failedProvision.has(name) || held.has(name) || (await readWriterState(ctx.home, name))?.phase !== "ready") continue;
    for (const client of request.codex ? ["claude-code", "codex"] as const : ["claude-code"] as const) {
      const expected = intent(ctx, name, client), before = await adapter.inspect(expected);
      try { await registerWriter(ownership, adapter, expected); add(name, { status: before === "equivalent" ? "unchanged" : "ok", code: "writer_registered" }); }
      catch (error) { add(name, { status: "failed", code: codeFor(error) }); continue; }
      if (client === "claude-code") {
        const hook = await writerHook(ctx, name, deps, "apply", await writerEventDeliveryEnabled(writerPaths(ctx.home, name).config));
        if (hook) findings.push({ target: targetFor(alias, name), ...hook });
      }
    }
  }
  for (const name of planned.surplus) {
    const extras: WakeHookOutcome[] = [];
    try { add(name, await remove(ctx, name, request.discard, deps, extras)); }
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
  const modeDependencies = { containerRuntime };
  try {
    let writerWork = request.mode === "container";
    if (!writerWork) {
      let config;
      try { config = await loadConfig(configPath); }
      catch { return changeExecutionMode(configPath, request, modeDependencies); }
      writerWork = config.workspaceModes.get(request.alias)?.mode === "container";
      for (let index = 1; index <= 16 && !writerWork; index++) {
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
    return changeExecutionMode(configPath, request, {
      ...modeDependencies,
      beforeWrite: async (entry) => {
        proposed = entry;
        const ctx = await context(request.alias, deps), planned = await plan(ctx, entry);
        try { if (request.apply) await doctorGate(ctx, deps); await preflight(ctx, planned.surplus, request.discard ?? false, deps); }
        catch (error) { return failed(codeFor(error)); }
        return undefined;
      },
      afterChange: async (modes) => {
        let writers: SetupResult;
        try {
          if (request.apply) writers = await reconcileUnlocked(configPath, request.alias, { discard: request.discard ?? false, codex: request.codex ?? false, ...(request.baseRef ? { baseRef: request.baseRef } : {}) }, deps);
          else {
            const ctx = await context(request.alias, deps), planned = await plan(ctx, proposed), { life } = services(deps);
            const hostDelivery = (await loadConfig(configPath)).eventDelivery === "spool", hooks: SetupFinding[] = [], kept: SetupFinding[] = [];
            const rawConfig: unknown = JSON.parse(await readFile(configPath, "utf8")), overrideDirectory = skillOverrideDirectory(configPath);
            for (const name of planned.keep) {
              // The same settings check as apply, so a drifted writer shows before anything is applied (#134).
              const drift = await life.writerSettingsDrift(ctx, { index: writerIndex(name), settings: proposed.container!, rawConfig, overrideDirectory });
              kept.push({ target: targetFor(request.alias, name), ...(drift ?? { status: "planned" as const, code: "writer_planned" }) });
            }
            for (const name of planned.keep) { const hook = await writerHook(ctx, name, deps, "dry-run", await writerDelivery(ctx, name, hostDelivery)); if (hook) hooks.push({ target: targetFor(request.alias, name), ...hook }); }
            for (const name of planned.surplus) { const hook = await writerHook(ctx, name, deps, "dry-run", false); if (hook) hooks.push({ target: targetFor(request.alias, name), ...hook }); }
            const refused = [...kept, ...hooks].some((finding) => finding.status === "failed" || finding.status === "divergent");
            writers = result("dry-run", [...kept, ...planned.surplus.map((name) => ({ target: targetFor(request.alias, name), status: "planned" as const, code: "writer_remove_planned" })), ...hooks], refused ? "failed" : "planned");
          }
        } catch { writers = failed("writer_reconcile_failed"); }
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
  // A reset, recreate or finish clears the writer's projected credentials; its running server keeps stale ones until reconnected (#136).
  const reconnectRequired = (outcome: lifecycle.WriterOutcome): boolean => opts.apply && outcome.status === "ok" && (operation === "reset" || operation === "recreate" || operation === "finish");
  const done = (outcome: lifecycle.WriterOutcome, hooks: readonly WakeHookOutcome[] = []) => result(reportOperation, [
    { target, ...outcome },
    ...hooks.map((hook) => ({ target, ...hook })),
    ...(reconnectRequired(outcome) ? [{ target, status: "ok" as const, code: "writer_reconnect_required" }] : []),
  ], outcome.status === "planned" ? "planned" : undefined);
  if ((deps.platform ?? process.platform) !== "linux") return done({ status: "failed", code: "platform_unsupported" });
  try {
    if (!opts.apply && operation !== "verify") { await context(alias, deps); return done({ status: "planned", code: `writer_${operation}_planned` }); }
    return await locked(deps, async () => {
      const ctx = await context(alias, deps), { life, ownership, adapter } = services(deps);
      if (operation === "verify") {
        const doctor = await (deps.doctor ?? runDoctor)({ home: ctx.home, packageRoot: deps.releaseRoot, loadConfig: () => loadConfig(deps.configPath) });
        if (doctor.checks.some((check) => check.severity === "error" && (check.subject === name || GLOBAL_ERRORS.has(check.id)))) return done({ status: "failed", code: "doctor_failed" });
        for (const client of ["claude-code", "codex"] as const) {
          const expected = intent(ctx, name, client);
          const owned = await ownership.get({ client, scope: client === "codex" ? "user" : "local", alias: expected.name });
          const current = await adapter.inspect(expected);
          if ((client === "claude-code" || owned || current !== "absent") && current !== "equivalent") return done({ status: "failed", code: "registration_not_equivalent" });
        }
        const checked = await (deps.verify ?? verifyMcpCapabilities)({ launch: (deps.launch ?? createCommandMcpStdioLauncher)([writerPaths(ctx.home, name).wrapper], { HOME: ctx.home, PATH: process.env.PATH ?? "", PI_WRITER_NO_CREDENTIAL_REFRESH: "1", ...(process.env.XDG_RUNTIME_DIR === undefined ? {} : { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }) }) });
        if (checked.status !== "verified") return done({ status: "failed", code: `mcp_${checked.status}` });
        // The hook is part of the Claude Code registration: verified after it, from the writer's own configuration.
        const hook = await writerHook(ctx, name, deps, "verify", await writerEventDeliveryEnabled(writerPaths(ctx.home, name).config));
        if (hook?.status === "failed" || hook?.status === "divergent") return done({ status: "failed", code: hook.code });
        return done({ status: "ok", code: "mcp_verified" }, hook ? [hook] : []);
      }
      await doctorGate(ctx, deps);
      const extras: WakeHookOutcome[] = [];
      const outcome = operation === "remove" ? await remove(ctx, name, opts.discard, deps, extras)
        : operation === "collect" ? await life.collectWriter(ctx, name)
        : operation === "reset" ? await life.resetWriter(ctx, name, opts)
        : operation === "recreate" ? await life.recreateWriter(ctx, name, opts)
        : await life.finishWriter(ctx, name);
      return done(outcome, extras);
    });
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

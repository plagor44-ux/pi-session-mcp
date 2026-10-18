import { chmod, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { runDoctor } from "./doctor.js";
import type { WorkspaceModeEntry } from "./execution-modes.js";
import { changeExecutionMode, type ModeRequest } from "./setup-modes.js";
import { acquireOverrideLock, OverrideLockError } from "./override-lock.js";
import { createCommandMcpStdioLauncher, createProcessRunner } from "./setup-process.js";
import { DurableOwnershipStore, type OwnershipStore } from "./setup-ownership.js";
import { result, type SetupFinding, type SetupOperation, type SetupResult, type SetupTarget } from "./setup-result.js";
import { createWriterRegistrationAdapter, registerWriter, unregisterWriter, type WriterRegistrationIntent, type WriterRegistrationAdapter } from "./client-adapters/writer-registration.js";
import { verifyMcpCapabilities } from "./client-adapters/mcp-verifier.js";
import { IMAGE_PULL_TIMEOUT_MS } from "./writer-boundary.js";
import * as lifecycle from "./writer-lifecycle.js";
import * as acceptance from "./writer-acceptance.js";
import { readWriterState, writerName, writerPaths, writerRegistrationName, writersRoot, WRITER_NAME_PATTERN } from "./writer-state.js";

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
const targetFor = (alias: string, name: string): SetupTarget => ({ client: "writer", scope: alias, alias: name });
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
async function remove(ctx: lifecycle.WriterContext, name: string, discard: boolean, deps: WriterSetupDependencies): Promise<lifecycle.WriterOutcome> {
  await preflight(ctx, [name], discard, deps);
  const { adapter, ownership, life } = services(deps);
  // Remove registrations before deleting the wrapper used to prove ownership.
  for (const client of ["claude-code", "codex"] as const) {
    const expected = intent(ctx, name, client);
    const owned = await ownership.get({ client, scope: client === "codex" ? "user" : "local", alias: expected.name });
    if (owned) await unregisterWriter(ownership, adapter, expected);
    else if (["equivalent", "divergent"].includes(await adapter.inspect(expected))) throw new Error("ownership_unavailable");
  }
  return life.removeWriter(ctx, name, { discard });
}
async function plan(ctx: lifecycle.WriterContext, entry: WorkspaceModeEntry) {
  const keep: string[] = [], missing: string[] = [], surplus: string[] = [];
  for (let index = 1; index <= 16; index++) {
    const name = writerName(ctx.alias, index), state = await readWriterState(ctx.home, name);
    if (entry.mode === "container" && index <= entry.container!.writers) { keep.push(name); if (!state || state.phase === "provisioning") missing.push(name); }
    else if (state) surplus.push(name);
  }
  return { keep, missing, surplus };
}

type ReconcileRequest = { apply: boolean; discard: boolean; baseRef?: string; codex: boolean };
/** Standalone reconciliation shares the same lock as mode changes and named operations. */
export async function reconcileWriters(configPath: string, alias: string, request: ReconcileRequest, deps: WriterSetupDependencies): Promise<SetupResult> {
  const action = () => reconcileUnlocked(configPath, alias, request, deps);
  try {
    if ((deps.platform ?? process.platform) !== "linux") throw new Error("platform_unsupported");
    const output = request.apply ? await locked(deps, action) : await action();
    if (!request.apply || !output.findings.some((finding) => finding.status === "ok")) return output;
    return result("apply", [...output.findings, { target: targetFor(alias, writerName(alias, 1)), status: "ok", code: "controllers_restart_required" }]);
  } catch (error) { return result(request.apply ? "apply" : "dry-run", [{ target: targetFor(alias, writerName(alias, 1)), status: "failed", code: codeFor(error) }]); }
}
async function reconcileUnlocked(configPath: string, alias: string, request: ReconcileRequest, deps: WriterSetupDependencies): Promise<SetupResult> {
  const operation = request.apply ? "apply" : "dry-run", findings: SetupFinding[] = [];
  const ctx = await context(alias, { ...deps, configPath });
  const config = await loadConfig(configPath), entry = config.workspaceModes.get(alias)!;
  const planned = await plan(ctx, entry), { life, accept, ownership, adapter } = services(deps);
  const add = (name: string, outcome: lifecycle.WriterOutcome): void => { findings.push({ target: targetFor(alias, name), ...outcome }); };
  if (request.apply) await doctorGate(ctx, deps);
  await preflight(ctx, planned.surplus, request.discard, deps);
  if (!request.apply) {
    for (const name of planned.keep) add(name, { status: "planned", code: "writer_planned" });
    for (const name of planned.surplus) add(name, { status: "planned", code: "writer_remove_planned" });
    return result(operation, findings, "planned");
  }
  const rawConfig: unknown = JSON.parse(await readFile(configPath, "utf8"));
  const failedProvision = new Set<string>();
  for (const name of planned.missing) {
    const outcome = await life.provisionWriter(ctx, { index: Number(name.slice(name.lastIndexOf("-w") + 2)), settings: entry.container!, rawConfig, ...(request.baseRef ? { baseRef: request.baseRef } : {}) });
    add(name, outcome); if (outcome.status === "failed") failedProvision.add(name);
  }
  for (const name of planned.keep) {
    if (failedProvision.has(name)) continue;
    let state = await readWriterState(ctx.home, name);
    if (state?.phase !== "ready") { const outcome = await accept.acceptWriter(ctx, name); add(name, outcome); if (outcome.status === "failed") continue; state = await readWriterState(ctx.home, name); }
  }
  for (const name of planned.keep) {
    if (failedProvision.has(name) || (await readWriterState(ctx.home, name))?.phase !== "ready") continue;
    for (const client of request.codex ? ["claude-code", "codex"] as const : ["claude-code"] as const) {
      const expected = intent(ctx, name, client), before = await adapter.inspect(expected);
      try { await registerWriter(ownership, adapter, expected); add(name, { status: before === "equivalent" ? "unchanged" : "ok", code: "writer_registered" }); }
      catch (error) { add(name, { status: "failed", code: codeFor(error) }); }
    }
  }
  for (const name of planned.surplus) {
    try { add(name, await remove(ctx, name, request.discard, deps)); }
    catch (error) { add(name, { status: "failed", code: codeFor(error) }); }
  }
  return result(operation, findings);
}

/** Serializes planning, destructive-work refusal, mode commit and writer reconciliation. */
export async function changeWriterMode(configPath: string, request: ModeRequest, deps: WriterSetupDependencies): Promise<SetupResult> {
  const operation = request.apply ? "apply" : "dry-run";
  const failed = (code: string) => result(operation, [{ target: targetFor(request.alias, writerName(request.alias, 1)), status: "failed", code }]);
  if ((deps.platform ?? process.platform) !== "linux") return failed("platform_unsupported");
  const action = async () => {
    let proposed: WorkspaceModeEntry;
    return changeExecutionMode(configPath, request, {
      ...(deps.containerRuntime ? { containerRuntime: deps.containerRuntime } : {}),
      beforeWrite: async (entry) => {
        proposed = entry;
        const ctx = await context(request.alias, deps), planned = await plan(ctx, entry);
        try { if (request.apply) await doctorGate(ctx, deps); await preflight(ctx, planned.surplus, request.discard ?? false, deps); }
        catch (error) { return failed(codeFor(error)); }
        return undefined;
      },
      afterChange: async (modes) => {
        let writers: SetupResult;
        if (request.apply) writers = await reconcileUnlocked(configPath, request.alias, { apply: true, discard: request.discard ?? false, codex: request.codex ?? false, ...(request.baseRef ? { baseRef: request.baseRef } : {}) }, deps);
        else {
          const ctx = await context(request.alias, deps), planned = await plan(ctx, proposed);
          writers = result("dry-run", [...planned.keep.map((name) => ({ target: targetFor(request.alias, name), status: "planned" as const, code: "writer_planned" })), ...planned.surplus.map((name) => ({ target: targetFor(request.alias, name), status: "planned" as const, code: "writer_remove_planned" }))], "planned");
        }
        const findings = [...modes.findings, ...writers.findings].filter((f) => f.code !== "controllers_restart_required");
        if (request.apply && findings.some((f) => f.status === "ok")) findings.push({ target: { client: "modes", scope: "workspace", alias: request.alias }, status: "ok", code: "controllers_restart_required" });
        return result(operation, findings, writers.exitCode ? "failed" : request.apply ? undefined : "planned");
      },
    });
  };
  try { return request.apply ? await locked(deps, action) : await action(); }
  catch (error) { return failed(codeFor(error)); }
}

const GLOBAL_ERRORS = new Set(["node_version_unsupported", "package_metadata_unreadable", "build_missing", "build_stale", "version_mismatch", "config_missing", "config_unreadable", "config_invalid"]);
export async function runWriterOperation(name: string, operation: WriterOperation, opts: WriterOptions, deps: WriterSetupDependencies): Promise<SetupResult> {
  const reportOperation: SetupOperation = operation === "verify" || operation === "remove" ? operation : opts.apply ? "apply" : "dry-run";
  if (!WRITER_NAME_PATTERN.test(name)) return result(reportOperation, [{ target: { client: "invalid", scope: "invalid", alias: "invalid" }, status: "failed", code: "usage_invalid" }], "failed", 64);
  const alias = name.slice(0, name.lastIndexOf("-w")), target = targetFor(alias, name);
  const done = (outcome: lifecycle.WriterOutcome) => result(reportOperation, [{ target, ...outcome }], outcome.status === "planned" ? "planned" : undefined);
  if ((deps.platform ?? process.platform) !== "linux") return done({ status: "failed", code: "platform_unsupported" });
  try {
    if (!opts.apply && operation !== "verify" && operation !== "remove") { await context(alias, deps); return done({ status: "planned", code: `writer_${operation}_planned` }); }
    return await locked(deps, async () => {
      const ctx = await context(alias, deps), { life, ownership, adapter } = services(deps);
      if (operation === "verify") {
        const doctor = await (deps.doctor ?? runDoctor)({ home: ctx.home, packageRoot: deps.releaseRoot, loadConfig: () => loadConfig(deps.configPath) });
        if (doctor.checks.some((check) => check.severity === "error" && (check.subject === name || GLOBAL_ERRORS.has(check.id)))) return done({ status: "failed", code: "doctor_failed" });
        for (const client of ["claude-code", "codex"] as const) {
          const expected = intent(ctx, name, client);
          const owned = await ownership.get({ client, scope: client === "codex" ? "user" : "local", alias: expected.name });
          if ((client === "claude-code" || owned) && await adapter.inspect(expected) !== "equivalent") return done({ status: "failed", code: "registration_not_equivalent" });
        }
        const checked = await (deps.verify ?? verifyMcpCapabilities)({ launch: (deps.launch ?? createCommandMcpStdioLauncher)([writerPaths(ctx.home, name).wrapper], { ...process.env, PI_WRITER_NO_CREDENTIAL_REFRESH: "1" }) });
        return done({ status: checked.status === "verified" ? "ok" : "failed", code: `mcp_${checked.status}` });
      }
      await doctorGate(ctx, deps);
      const outcome = operation === "remove" ? await remove(ctx, name, opts.discard, deps)
        : operation === "collect" ? await life.collectWriter(ctx, name)
        : operation === "reset" ? await life.resetWriter(ctx, name, opts)
        : operation === "recreate" ? await life.recreateWriter(ctx, name, opts)
        : await life.finishWriter(ctx, name);
      return done(outcome);
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

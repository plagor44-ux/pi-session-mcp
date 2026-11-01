import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { containerRuntimeUsable } from "./container-runtime.js";
import { ALIAS_PATTERN } from "./execution-profile.js";
import { runDoctor } from "./doctor.js";
import { MAX_WRITERS, type WorkspaceModeEntry } from "./execution-modes.js";
import { changeExecutionMode, type ModeRequest } from "./setup-modes.js";
import { createCommandMcpStdioLauncher } from "./setup-process.js";
import type { WakeHookOutcome } from "./setup-hooks.js";
import { result, type SetupOperation, type SetupResult } from "./setup-result.js";
import { verifyMcpCapabilities } from "./client-adapters/mcp-verifier.js";
import { podmanCgroupControllers } from "./writer-boundary.js";
import * as lifecycle from "./writer-lifecycle.js";
import { recoverWriter } from "./writer-recover.js";
import * as acceptance from "./writer-acceptance.js";
import { writerName, writerPaths, writersRoot, WRITER_NAME_PATTERN } from "./writer-state.js";
import { codeFor, context, DoctorGateError, doctorGate, FENCE_CODES, fenced, GLOBAL_ERRORS, locked, modesTarget, plan, preflight, remove, services, targetFor, type WriterSetupDependencies } from "./setup-writers-common.js";
import { gateBeforeWrite, inferBase, plannedWriters } from "./setup-writers-plan.js";
import { reconcileUnlocked } from "./setup-writers-reconcile.js";

/**
 * Writer setup entry points: a repository's mode change with its writers (planning and base inference in
 * `setup-writers-plan.ts`, reconciliation in `setup-writers-reconcile.ts`), single-writer operations and the isolation control.
 */

export { SETUP_LEASE_WAIT_MS, type WriterSetupDependencies } from "./setup-writers-common.js";
export type WriterOperation = "collect" | "recover" | "reset" | "recreate" | "finish" | "remove" | "verify";
export interface WriterOptions { apply: boolean; discard: boolean; baseRef?: string; }

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
    const recorded = await inferBase(configPath, request, deps, containerRuntime, failed);
    if ("schemaVersion" in recorded) return recorded;
    return changeExecutionMode(configPath, recorded, {
      ...modeDependencies,
      beforeWrite: async (entry) => {
        proposed = entry;
        const ctx = await context(request.alias, deps), planned = await plan(ctx, entry);
        try {
          if (request.apply) return await gateBeforeWrite(configPath, ctx, entry, planned, request.discard ?? false, operation, deps);
          await preflight(ctx, planned.surplus, request.discard ?? false, deps);
        }
        catch (error) { return error instanceof DoctorGateError ? result(operation, [...failed(error.message).findings, ...error.findings]) : failed(codeFor(error)); }
        return undefined;
      },
      afterChange: async (modes) => {
        let writers: SetupResult;
        try {
          if (request.apply) writers = await reconcileUnlocked(configPath, request.alias, { discard: request.discard ?? false, ...(request.baseRef ? { baseRef: request.baseRef } : {}) }, deps);
          else {
            const ctx = await context(request.alias, deps);
            writers = await plannedWriters(configPath, ctx, proposed, await plan(ctx, proposed), deps);
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
      if (operation === "recover") {
        const { warnings = [], ...outcome } = await recoverWriter(ctx, name);
        return result(reportOperation, [{ target, ...outcome }, ...warnings.map(warning => ({ target, ...warning }))]);
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

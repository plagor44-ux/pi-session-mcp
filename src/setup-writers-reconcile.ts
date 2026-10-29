import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { result, type SetupFinding, type SetupResult } from "./setup-result.js";
import { unregisterWriter, type WriterRegistrationIntent } from "./client-adapters/writer-registration.js";
import { sameWriterLimits, writerLimits } from "./writer-limits.js";
import { renderWrapper, wrapperDigest } from "./writer-wrapper.js";
import type * as lifecycle from "./writer-lifecycle.js";
import { readWriterState, writeWriterState, writerPaths } from "./writer-state.js";
import { codeFor, context, doctorGate, FENCE_CODES, fenced, INFRASTRUCTURE_CODE, intent, plan, preflight, remove, services, targetFor, writerHook, writerIndex, type WriterSetupDependencies } from "./setup-writers-common.js";
import { renderInputs, settingsDriftCheck } from "./setup-writers-plan.js";
import type { WakeHookOutcome } from "./setup-hooks.js";

/** Writer reconciliation after a mode change is written: provisioning, migration to the relay launch, acceptance and removal. */

export type ReconcileRequest = { discard: boolean; baseRef?: string };

/**
 * Moves a kept writer to the relay launch: its owned registrations are removed (both clients are decided before
 * anything is removed, so a divergent registration of one client never costs the writer its owned registration of the
 * other; a client that is not installed has nothing to keep), and so is its wake hook; the wrapper is rebound to this
 * release. A changed launch or wrapper leaves the writer unaccepted. Returns a refusal outcome or `undefined`.
 */
async function migrateToRelay(ctx: lifecycle.WriterContext, name: string, deps: WriterSetupDependencies, findings: SetupFinding[]): Promise<lifecycle.WriterOutcome | undefined> {
  const { ownership, adapter } = services(deps);
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
  if (hook) findings.push({ target: targetFor(ctx.alias, name), ...hook });
  const state = await readWriterState(ctx.home, name);
  if (!state) throw new Error("writer_state_invalid");
  if (divergent) {
    if (state.launch !== "legacy") await writeWriterState(ctx.home, name, { ...state, launch: "legacy" });
    return { status: "failed", code: "registration_divergent" };
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
  if (state.launch !== "relay" || wrapperChanged) {
    const { acceptance: _oldAcceptance, ...unaccepted } = state;
    await writeWriterState(ctx.home, name, { ...unaccepted, launch: "relay", phase: "not_ready" });
  }
  return undefined;
}

export async function reconcileUnlocked(configPath: string, alias: string, request: ReconcileRequest, deps: WriterSetupDependencies): Promise<SetupResult> {
  const findings: SetupFinding[] = [];
  const ctx = await context(alias, { ...deps, configPath });
  const config = await loadConfig(configPath), entry = config.workspaceModes.get(alias)!;
  const planned = await plan(ctx, entry), { life, accept } = services(deps);
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
  const inputs = await renderInputs(configPath), drift = settingsDriftCheck(inputs, ctx, entry.container!, deps);
  // Each writer's reconciliation, including first provisioning and acceptance, owns one fence.
  // A writer added without --base joins the recorded default base, so default starts find it. A recorded base that is
  // the repository default stays unset: provisioning then resolves origin/HEAD, as the first provisioning did.
  let baseRef = request.baseRef;
  const recordedBase = entry.container?.base;
  if (baseRef === undefined && recordedBase !== undefined && recordedBase !== await life.baseBranchName(ctx).catch(() => undefined)) baseRef = recordedBase;
  for (const name of planned.keep) {
    try { await fenced(ctx, name, deps, async (ctx) => {
      if (planned.missing.includes(name)) {
        const outcome = await life.provisionWriter(ctx, { index: writerIndex(name), settings: entry.container!, ...inputs, ...(baseRef ? { baseRef } : {}) });
        add(name, outcome); if (outcome.status === "failed") return;
      }
      // Settings first: a drifted writer is left exactly as it is, neither migrated nor accepted again (#134).
      if (!planned.missing.includes(name)) {
        const drifted = await drift(name, ctx);
        if (drifted) { add(name, drifted); return; }
        const state = await readWriterState(ctx.home, name);
        if (!state) throw new Error("writer_state_invalid");
        const limits = writerLimits(entry.container!);
        if (!sameWriterLimits(state.limits, limits)) {
          const { limits: _previous, ...rest } = state;
          await writeWriterState(ctx.home, name, { ...rest, ...(limits ? { limits } : {}) });
          add(name, { status: "ok", code: "writer_limits_updated" });
        }
      }
      const refused = await migrateToRelay(ctx, name, deps, findings);
      if (refused) { add(name, refused); return; }
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

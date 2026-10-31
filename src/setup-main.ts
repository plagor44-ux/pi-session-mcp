#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryPoint } from "./entry-point.js";
import { createProcessRunner } from "./setup-process.js";
import { currentSetupPlatform } from "./setup-platform.js";
import { createProductionSetup, isSupportedTarget } from "./setup.js";
import { customizeSkill } from "./skill-customize.js";
import { SKILL_NAME_PATTERN } from "./skill-library.js";
import { ALIAS_PATTERN } from "./execution-profile.js";
import { changeWriterMode, runWriterControl, runWriterOperation } from "./setup-writers.js";
import { runSnapshotOperation } from "./setup-snapshots.js";
import { WRITER_NAME_PATTERN } from "./writer-state.js";
import { formatSetupHuman, formatSetupResult, parseSetupArgs, type SetupCliRequest } from "./setup-cli.js";
import { result, type SetupOperation, type SetupResult, type SetupTarget } from "./setup-result.js";

/** Executable entry point for client registrations, skill customization and `--repo <alias>` execution modes. */
export interface SetupMainDependencies { readonly createSetup?: typeof createProductionSetup; readonly packageRoot?: string; }
export async function main(argv: readonly string[] = process.argv.slice(2), dependencies: SetupMainDependencies = {}): Promise<number> {
  let json = argv.includes("--json");
  let request: SetupCliRequest;
  try {
    request = parseSetupArgs(argv);
    json = request.json;
  } catch { return write(cliFailure("dry-run", [], "usage_invalid", 64), json); }
  const operation = request.operation ?? "dry-run";
  const failureTargets = request.snapshot ? [{ client: "snapshot", scope: "workspace", alias: request.snapshot.alias }] : request.writer ? [{ client: "writer", scope: request.writer.name.slice(0, request.writer.name.lastIndexOf("-w")), alias: request.writer.name }] : request.isolationControl ? [{ client: "writer", scope: "host", alias: "control" }] : request.repo !== undefined ? [{ client: "modes", scope: "workspace", alias: request.repo.alias }] : request.customizeSkill === undefined ? request.targets : [skillTarget(request.customizeSkill)];
  if (!currentSetupPlatform() && !request.snapshot) return write(cliFailure(operation, failureTargets, "platform_unsupported", 1), request.json);
  if (request.listModels) return (await import("./setup-probe-main.js")).runListModels(request.json);
  const config = process.env.PI_SESSION_MCP_CONFIG;
  if (!config) {
    if (request.probe) return (await import("./setup-probe-main.js")).runProbe(request.probe, request.json, "", new AbortController().signal);
    return write(cliFailure(operation, failureTargets, "config_required", 1), request.json);
  }
  if (request.customizeSkill !== undefined) {
    const name = request.customizeSkill;
    try { return write(await customizeSkill({ name, configPath: resolve(config), apply: operation === "apply", ...(dependencies.packageRoot === undefined ? {} : { packageRoot: dependencies.packageRoot }) }), request.json); }
    catch { return write(cliFailure(operation, [skillTarget(name)], "skill_customize_failed", 1), request.json); }
  }
  const root = dependencies.packageRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const controller = new AbortController();
  let interrupted: 130 | 143 | undefined;
  const onInterrupt = (): void => { interrupted ??= 130; controller.abort(interrupted); };
  const onTerminate = (): void => { interrupted ??= 143; controller.abort(interrupted); };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  let setup;
  try {
    if (request.probe) return await (await import("./setup-probe-main.js")).runProbe(request.probe, request.json, resolve(config), controller.signal, { packageRoot: root });
    if (request.snapshot) return write(await runSnapshotOperation(resolve(config), request.snapshot, { signal: controller.signal }), request.json);
    const writerDeps = { configPath: resolve(config), releaseRoot: root, signal: controller.signal };
    if (request.repo !== undefined) {
      try { return write(await changeWriterMode(resolve(config), request.repo, writerDeps), request.json); }
      catch { return write(cliFailure(operation, failureTargets, "operation_failed", 1), request.json); }
    }
    if (request.writer) return write(await runWriterOperation(request.writer.name, request.writer.operation, request.writer, writerDeps), request.json);
    if (request.isolationControl) return write(await runWriterControl(request.isolationControl.alias, request.isolationControl.apply, writerDeps), request.json);
    try { setup = await (dependencies.createSetup ?? createProductionSetup)(createProcessRunner({ signal: controller.signal }), root, resolve(config), undefined, controller.signal); }
    catch { return write(cliFailure(operation, request.targets, interrupted ? "operation_interrupted" : "release_unavailable", interrupted ?? 1), request.json); }
    try {
      const output = await setup.run(request);
      return write(interrupted ? cliFailure(operation, request.targets, "operation_interrupted", interrupted) : output, request.json);
    } catch { return write(cliFailure(operation, request.targets, interrupted ? "operation_interrupted" : "operation_failed", interrupted ?? 1), request.json); }
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  }
}

/** The skill name is echoed only when it is a valid name; arbitrary input never reaches a report. */
function skillTarget(name: string): SetupTarget { return { client: "skills", scope: "override", alias: SKILL_NAME_PATTERN.test(name) ? name : "invalid" }; }
function isReportableTarget(target: SetupTarget): boolean { return isSupportedTarget(target) || (target.client === "snapshot" && target.scope === "workspace" && ALIAS_PATTERN.test(target.alias)) || (target.client === "writer" && ((ALIAS_PATTERN.test(target.scope) && WRITER_NAME_PATTERN.test(target.alias)) || (target.scope === "host" && target.alias === "control"))) || (target.client === "modes" && target.scope === "workspace" && ALIAS_PATTERN.test(target.alias)) || (target.client === "skills" && target.scope === "override" && (target.alias === "invalid" || SKILL_NAME_PATTERN.test(target.alias))); }

function cliFailure(operation: SetupOperation, targets: readonly SetupTarget[], code: string, exitCode: 1 | 64 | 130 | 143): SetupResult {
  const safeTargets = targets.filter(isReportableTarget);
  const reported: readonly SetupTarget[] = safeTargets.length === targets.length && safeTargets.length > 0 ? safeTargets : [{ client: "invalid", scope: "invalid", alias: "invalid" }];
  return result(operation, reported.map((target) => ({ target, status: "failed", code })), "failed", exitCode);
}
function write(value: SetupResult, json: boolean): number { process.stdout.write((json ? formatSetupResult(value) : formatSetupHuman(value)) + "\n"); return value.exitCode; }
if (isEntryPoint(import.meta.url, process.argv[1])) void main().then((code) => { process.exitCode = code; });

#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProcessRunner } from "./setup-process.js";
import { createProductionSetup, isSupportedTarget } from "./setup.js";
import { formatSetupHuman, formatSetupResult, parseSetupArgs, type SetupCliRequest } from "./setup-cli.js";
import { result, type SetupOperation, type SetupResult, type SetupTarget } from "./setup-result.js";

/** Executable entry point: `node dist/setup-main.js [operation] --target client:scope:alias`. */
export interface SetupMainDependencies { readonly createSetup?: typeof createProductionSetup; readonly packageRoot?: string; }
export async function main(argv: readonly string[] = process.argv.slice(2), dependencies: SetupMainDependencies = {}): Promise<number> {
  let json = argv.includes("--json");
  let request: SetupCliRequest;
  try {
    request = parseSetupArgs(argv);
    json = request.json;
  } catch { return write(cliFailure("dry-run", [], "usage_invalid", 64), json); }
  const operation = request.operation ?? "dry-run";
  if (process.platform !== "linux") return write(cliFailure(operation, request.targets, "platform_unsupported", 1), request.json);
  const config = process.env.PI_SESSION_MCP_CONFIG;
  if (!config) return write(cliFailure(operation, request.targets, "config_required", 1), request.json);
  const root = dependencies.packageRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const controller = new AbortController();
  let interrupted: 130 | 143 | undefined;
  const onInterrupt = (): void => { interrupted ??= 130; controller.abort(); };
  const onTerminate = (): void => { interrupted ??= 143; controller.abort(); };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  let setup;
  try {
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

function cliFailure(operation: SetupOperation, targets: readonly SetupTarget[], code: string, exitCode: 1 | 64 | 130 | 143): SetupResult {
  const safeTargets = targets.filter(isSupportedTarget);
  const reported: readonly SetupTarget[] = safeTargets.length === targets.length && safeTargets.length > 0 ? safeTargets : [{ client: "invalid", scope: "invalid", alias: "invalid" }];
  return result(operation, reported.map((target) => ({ target, status: "failed", code })), "failed", exitCode);
}
function write(value: SetupResult, json: boolean): number { process.stdout.write((json ? formatSetupResult(value) : formatSetupHuman(value)) + "\n"); return value.exitCode; }
if (import.meta.url === `file://${process.argv[1]}`) void main().then((code) => { process.exitCode = code; });

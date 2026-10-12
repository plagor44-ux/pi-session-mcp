import { SetupOrchestrator, type SetupRequest } from "./setup.js";
import type { SetupOperation, SetupResult, SetupTarget } from "./setup-result.js";

/** Small argv adapter; command execution remains injected in SetupClientAdapter. */
export interface SetupCliRequest extends SetupRequest {
  readonly json: boolean;
  /** `--customize-skill <name>`: copies a shipped skill into the override directory instead of touching clients. */
  readonly customizeSkill?: string;
}
export function parseSetupArgs(argv: readonly string[]): SetupCliRequest {
  let operation: SetupOperation | undefined;
  let json = false;
  const targets: SetupTarget[] = [];
  let customizeSkill: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { if (json) throw new Error("json_repeated"); json = true; continue; }
    if (argument === "--dry-run" || argument === "--apply" || argument === "--verify" || argument === "--rollback" || argument === "--remove") {
      if (operation) throw new Error("operation_repeated");
      operation = argument.slice(2) as SetupOperation;
      continue;
    }
    if (argument === "--target") {
      const value = argv[++index];
      const parts = value?.split(":");
      if (!parts || parts.length !== 3) throw new Error("target_invalid");
      targets.push({ client: parts[0]!, scope: parts[1]!, alias: parts[2]! });
      continue;
    }
    if (argument === "--customize-skill") {
      if (customizeSkill !== undefined) throw new Error("customize_skill_repeated");
      const value = argv[++index];
      if (value === undefined || value === "" || value.startsWith("-")) throw new Error("customize_skill_invalid");
      customizeSkill = value;
      continue;
    }
    throw new Error("argument_unsupported");
  }
  if (customizeSkill !== undefined) {
    // Skill customization is a dry-run or an explicit apply; it never targets a client.
    if (targets.length > 0 || (operation !== undefined && operation !== "dry-run" && operation !== "apply")) throw new Error("customize_skill_combination");
    return operation ? { operation, targets, json, customizeSkill } : { targets, json, customizeSkill };
  }
  return operation ? { operation, targets, json } : { targets, json };
}

export async function runSetupCli(argv: readonly string[], orchestrator: SetupOrchestrator): Promise<SetupResult> {
  return orchestrator.run(parseSetupArgs(argv));
}

/** Both report modes are projections of the same sanitized result. */
export function formatSetupResult(setupResult: SetupResult): string {
  return JSON.stringify(setupResult);
}
export function formatSetupHuman(setupResult: SetupResult): string { return [`${setupResult.operation}: ${setupResult.status}`, ...setupResult.findings.map((x) => `${x.target.client}/${x.target.scope}/${x.target.alias}: ${x.status} (${x.code})`)].join("\n"); }

import { SetupOrchestrator, type SetupRequest } from "./setup.js";
import type { SetupOperation, SetupResult, SetupTarget } from "./setup-result.js";
import type { ModeRequest } from "./setup-modes.js";
import type { ContainerSettings } from "./execution-modes.js";

/** Small argv adapter; command execution remains injected in SetupClientAdapter. */
export interface SetupCliRequest extends SetupRequest {
  readonly json: boolean;
  /** `--customize-skill <name>`: copies a shipped skill into the override directory instead of touching clients. */
  readonly customizeSkill?: string;
  readonly repo?: ModeRequest;
}
export function parseSetupArgs(argv: readonly string[]): SetupCliRequest {
  let operation: SetupOperation | undefined;
  let json = false;
  const targets: SetupTarget[] = [];
  let customizeSkill: string | undefined;
  let repo: string | undefined;
  let mode: ModeRequest["mode"];
  let acceptHostWrites = false;
  const container: { -readonly [K in keyof ContainerSettings]?: ContainerSettings[K] } = {};
  const modeFlags = new Set<string>();
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
    if (["--repo", "--mode", "--accept-host-writes", "--writers", "--lifecycle", "--profiles", "--image", "--network"].includes(argument!)) {
      if (modeFlags.has(argument!)) throw new Error("repo_argument_repeated");
      modeFlags.add(argument!);
      if (argument === "--accept-host-writes") { acceptHostWrites = true; continue; }
      const value = argv[++index];
      if (!value || value.startsWith("-")) throw new Error("repo_argument_invalid");
      switch (argument) {
        case "--repo": repo = value; break;
        case "--mode":
          if (value !== "host" && value !== "container" && value !== "read-only") throw new Error("mode_invalid");
          mode = value; break;
        case "--writers":
          if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 16) throw new Error("writers_invalid");
          container.writers = Number(value); break;
        case "--lifecycle":
          if (value !== "persistent" && value !== "ephemeral") throw new Error("lifecycle_invalid");
          container.lifecycle = value; break;
        case "--profiles":
          if (value.split(",").some((profile) => profile === "")) throw new Error("profiles_invalid");
          container.profiles = value.split(","); break;
        case "--image": container.image = value; break;
        case "--network":
          if (value !== "pasta" && value !== "none") throw new Error("network_invalid");
          container.network = value; break;
      }
      continue;
    }
    throw new Error("argument_unsupported");
  }
  if (modeFlags.size > 0) {
    if (repo === undefined || targets.length > 0 || customizeSkill !== undefined || (operation !== undefined && operation !== "dry-run" && operation !== "apply")) throw new Error("repo_combination");
    if ((mode === "host" || mode === "read-only") && Object.keys(container).length > 0) throw new Error("repo_combination");
    const request: ModeRequest = { alias: repo, acceptHostWrites, apply: operation === "apply", ...(mode === undefined ? {} : { mode }), ...(Object.keys(container).length === 0 ? {} : { container }) };
    return { ...(operation === undefined ? {} : { operation }), targets, json, repo: request };
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

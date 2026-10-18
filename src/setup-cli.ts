import { SetupOrchestrator, type SetupRequest } from "./setup.js";
import type { SetupOperation, SetupResult, SetupTarget } from "./setup-result.js";
import type { ModeRequest } from "./setup-modes.js";
import type { ContainerSettings } from "./execution-modes.js";
import { WRITER_NAME_PATTERN } from "./writer-state.js";
import type { WriterOperation } from "./setup-writers.js";

/** Small argv adapter; command execution remains injected in SetupClientAdapter. */
export interface SetupCliRequest extends SetupRequest {
  readonly json: boolean;
  /** `--customize-skill <name>`: copies a shipped skill into the override directory instead of touching clients. */
  readonly customizeSkill?: string;
  readonly repo?: ModeRequest;
  readonly writer?: { name: string; operation: WriterOperation; apply: boolean; discard: boolean; baseRef?: string };
  readonly isolationControl?: { alias: string; apply: boolean };
}
export function parseSetupArgs(argv: readonly string[]): SetupCliRequest {
  let operation: SetupOperation | undefined;
  let json = false;
  const targets: SetupTarget[] = [];
  let customizeSkill: string | undefined;
  let repo: string | undefined;
  let mode: ModeRequest["mode"];
  let acceptHostWrites = false;
  let writer: string | undefined, writerOperation: WriterOperation | undefined, baseRef: string | undefined;
  let discard = false, codex = false, isolationControl = false;
  const container: { -readonly [K in keyof ContainerSettings]?: ContainerSettings[K] } = {};
  const modeFlags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--collect", "--reset", "--recreate", "--finish"].includes(argument!)) {
      if (writerOperation) throw new Error("operation_repeated");
      writerOperation = argument!.slice(2) as WriterOperation; continue;
    }
    if (["--writer", "--base", "--client"].includes(argument!)) {
      const value = argv[++index];
      if (!value || value.startsWith("-")) throw new Error("usage_invalid");
      if (argument === "--writer") { if (writer || !WRITER_NAME_PATTERN.test(value)) throw new Error("usage_invalid"); writer = value; }
      if (argument === "--base") { if (baseRef) throw new Error("usage_invalid"); baseRef = value; }
      if (argument === "--client") { if (codex || value !== "codex") throw new Error("usage_invalid"); codex = true; }
      continue;
    }
    if (argument === "--discard") { if (discard) throw new Error("usage_invalid"); discard = true; continue; }
    if (argument === "--isolation-control") { if (isolationControl) throw new Error("usage_invalid"); isolationControl = true; continue; }
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
  if (writer !== undefined) {
    if (operation === "remove" || operation === "verify") { if (writerOperation) throw new Error("usage_invalid"); writerOperation = operation; }
    else if (operation !== undefined && operation !== "apply" && operation !== "dry-run") throw new Error("usage_invalid");
    if (!writerOperation || modeFlags.size || targets.length || customizeSkill || codex || isolationControl || (discard && !["reset", "recreate", "remove"].includes(writerOperation)) || (baseRef && writerOperation !== "reset")) throw new Error("usage_invalid");
    return { ...(operation ? { operation } : {}), targets, json, writer: { name: writer, operation: writerOperation, apply: operation === "apply" || operation === "remove" || operation === "verify", discard, ...(baseRef ? { baseRef } : {}) } };
  }
  if (writerOperation) throw new Error("usage_invalid");
  if (isolationControl) {
    if (!repo || modeFlags.size !== 1 || targets.length || customizeSkill || discard || baseRef || codex || (operation && operation !== "apply" && operation !== "dry-run")) throw new Error("usage_invalid");
    return { ...(operation ? { operation } : {}), targets, json, isolationControl: { alias: repo, apply: operation === "apply" } };
  }
  if ((discard || baseRef || codex) && !repo) throw new Error("usage_invalid");
  if (modeFlags.size > 0) {
    if (repo === undefined || targets.length > 0 || customizeSkill !== undefined || (operation !== undefined && operation !== "dry-run" && operation !== "apply")) throw new Error("repo_combination");
    if ((mode === "host" || mode === "read-only") && Object.keys(container).length > 0) throw new Error("repo_combination");
    const request: ModeRequest = { alias: repo, acceptHostWrites, apply: operation === "apply", discard, codex, ...(baseRef ? { baseRef } : {}), ...(mode === undefined ? {} : { mode }), ...(Object.keys(container).length === 0 ? {} : { container }) };
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

import { cpusSchema, cpuSharesSchema, memorySchema } from "./writer-limits.js";
import type { SetupRequest } from "./setup.js";
import type { SetupOperation, SetupResult, SetupTarget } from "./setup-result.js";
import type { ModeRequest } from "./setup-modes.js";
import type { ContainerSettings } from "./execution-modes.js";
import { WRITER_NAME_PATTERN } from "./writer-state.js";
import type { WriterOperation } from "./setup-writers.js";
import { ALIAS_PATTERN } from "./execution-profile.js";

/** Small argv adapter; command execution remains injected in SetupClientAdapter. */
export interface SetupCliRequest extends SetupRequest {
  readonly json: boolean;
  /** `--customize-skill <name>`: copies a shipped skill into the override directory instead of touching clients. */
  readonly customizeSkill?: string;
  readonly repo?: ModeRequest;
  readonly writer?: { name: string; operation: WriterOperation; apply: boolean; discard: boolean; baseRef?: string };
  readonly isolationControl?: { alias: string; apply: boolean };
  /** `--list-models`: prints the offline provider/model catalog. */
  readonly listModels?: true;
  /** `--probe-profile <alias>[,<alias>...]`: checks profiles offline, then probes them with `--apply`. */
  readonly probe?: { readonly profiles: readonly string[]; readonly apply: boolean };
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
  let listModels = false;
  let probeProfiles: string[] | undefined;
  const container: { -readonly [K in keyof ContainerSettings]?: ContainerSettings[K] } = {};
  const modeFlags = new Set<string>();
  const clearLimits: ("cpus" | "cpuShares" | "memory")[] = [];
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
    if (argument === "--list-models") { if (listModels) throw new Error("usage_invalid"); listModels = true; continue; }
    if (argument === "--probe-profile") {
      if (probeProfiles !== undefined) throw new Error("usage_invalid");
      const value = argv[++index];
      if (value === undefined || value === "") throw new Error("usage_invalid");
      const aliases = value.split(",");
      if (aliases.some((alias) => !ALIAS_PATTERN.test(alias))) throw new Error("usage_invalid");
      probeProfiles = [...new Set(aliases)];
      continue;
    }
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
    if (["--repo", "--mode", "--accept-host-writes", "--writers", "--lifecycle", "--profiles", "--image", "--network", "--cache", "--tags", "--clean", "--cpus", "--cpu-shares", "--memory"].includes(argument!)) {
      if (modeFlags.has(argument!)) throw new Error("repo_argument_repeated");
      modeFlags.add(argument!);
      if (argument === "--accept-host-writes") { acceptHostWrites = true; continue; }
      const value = argv[++index] ?? "";
      if ((!value || value.startsWith("-")) && !["--cpus", "--cpu-shares", "--memory"].includes(argument!)) throw new Error("repo_argument_invalid");
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
        case "--tags":
          if (value !== "none" && value !== "reachable") throw new Error("tags_invalid");
          container.tags = value; break;
        case "--clean":
          if (value !== "untracked" && value !== "all") throw new Error("clean_invalid");
          container.clean = value; break;
        case "--cpus":
          if (value === "none") { clearLimits.push("cpus"); break; }
          if (!value || !/^[0-9]+(?:\.[0-9]{1,2})?$/.test(value) || !cpusSchema.safeParse(Number(value)).success) throw new Error("cpus_invalid");
          container.cpus = Number(value); break;
        case "--cpu-shares":
          if (value === "none") { clearLimits.push("cpuShares"); break; }
          if (!value || !/^[0-9]+$/.test(value) || !cpuSharesSchema.safeParse(Number(value)).success) throw new Error("cpu_shares_invalid");
          container.cpuShares = Number(value); break;
        case "--memory":
          if (value === "none") { clearLimits.push("memory"); break; }
          if (!memorySchema.safeParse(value).success) throw new Error("memory_invalid");
          container.memory = value; break;
        case "--cache":
          if (value !== "none" && value !== "go" && value !== "uv" && value !== "npm") throw new Error("cache_invalid");
          container.cache = value; break;
      }
      continue;
    }
    throw new Error("argument_unsupported");
  }
  if (listModels || probeProfiles !== undefined) {
    if (listModels && probeProfiles !== undefined) throw new Error("usage_invalid");
    if (targets.length > 0 || modeFlags.size > 0 || customizeSkill !== undefined || writer !== undefined || writerOperation !== undefined || isolationControl || discard || baseRef || codex) {
      throw new Error(listModels ? "list_models_combination" : "probe_combination");
    }
    if (listModels) {
      if (operation !== undefined && operation !== "dry-run") throw new Error("list_models_combination");
      return { ...(operation ? { operation } : {}), targets, json, listModels: true };
    }
    if (operation !== undefined && operation !== "dry-run" && operation !== "apply") throw new Error("probe_combination");
    return { ...(operation ? { operation } : {}), targets, json, probe: { profiles: probeProfiles!, apply: operation === "apply" } };
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
    if ((mode === "host" || mode === "read-only") && (Object.keys(container).length > 0 || clearLimits.length > 0)) throw new Error("repo_combination");
    const request: ModeRequest = { alias: repo, acceptHostWrites, apply: operation === "apply", discard, codex, ...(baseRef ? { baseRef } : {}), ...(mode === undefined ? {} : { mode }), ...(Object.keys(container).length === 0 ? {} : { container }), ...(clearLimits.length === 0 ? {} : { clearLimits }) };
    return { ...(operation === undefined ? {} : { operation }), targets, json, repo: request };
  }
  if (customizeSkill !== undefined) {
    // Skill customization is a dry-run or an explicit apply; it never targets a client.
    if (targets.length > 0 || (operation !== undefined && operation !== "dry-run" && operation !== "apply")) throw new Error("customize_skill_combination");
    return operation ? { operation, targets, json, customizeSkill } : { targets, json, customizeSkill };
  }
  return operation ? { operation, targets, json } : { targets, json };
}

/** Both report modes are projections of the same sanitized result. */
export function formatSetupResult(setupResult: SetupResult): string {
  return JSON.stringify(setupResult);
}
export function formatSetupHuman(setupResult: SetupResult): string { return [`${setupResult.operation}: ${setupResult.status}`, ...setupResult.findings.map((x) => `${x.target.client}/${x.target.scope}/${x.target.alias}: ${x.status} (${x.code})`)].join("\n"); }

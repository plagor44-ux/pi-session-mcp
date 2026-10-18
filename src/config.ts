import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { MAX_PROFILE_EXTENSIONS, parseExtensionSpec } from "./extension-spec.js";
import { isMcpServers, snapshotMcpServers, type McpServers } from "./mcp-config.js";
import { builtinSkillName, isSkillCatalogPath, MAX_PROFILE_SKILLS, MAX_SKILL_CATALOG_ENTRIES, type SkillSelection } from "./skill-catalog.js";
import {
  ALIAS_PATTERN,
  ImmutableMap,
  type ConfiguredExecutionProfile,
  type PermissionProfile,
  type ThinkingLevel,
} from "./execution-profile.js";
import { builtinSkillPath, skillOverrideDirectory } from "./skill-library.js";
import { loadExecutionModes, type WorkspaceModeEntry } from "./execution-modes.js";

const alias = z.string().regex(ALIAS_PATTERN);
const permissionProfile = z.enum(["read-only", "coding"] satisfies [PermissionProfile, PermissionProfile]);
const thinkingLevel = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] satisfies [ThinkingLevel, ...ThinkingLevel[]]);
const extensionSpec = z.string().refine((value) => parseExtensionSpec(value) !== undefined);
const skillCatalogPath = z.string().refine(isSkillCatalogPath);
const profileSchema = z.object({
  default: z.boolean(), permissionProfile, provider: z.string().trim().min(1).max(256),
  model: z.string().trim().min(1).max(256), thinkingLevel,
  mcpServers: z.custom<McpServers>((value) => isMcpServers(value)).optional(),
  extensions: z.array(extensionSpec).max(MAX_PROFILE_EXTENSIONS).optional(),
  skills: z.array(alias).max(MAX_PROFILE_SKILLS).optional(),
}).strict().superRefine((profile, context) => {
  if (profile.mcpServers !== undefined && !isMcpServers(profile.mcpServers, profile.permissionProfile)) {
    context.addIssue({ code: "custom", path: ["mcpServers"], message: "MCP tool grants do not match the permission profile" });
  }
  if (profile.extensions !== undefined) {
    const names = profile.extensions.flatMap((spec) => parseExtensionSpec(spec)?.name ?? []);
    if (new Set(names).size !== names.length) {
      context.addIssue({ code: "custom", path: ["extensions"], message: "An extension package may appear only once per profile" });
    }
  }
  if (profile.skills !== undefined && new Set(profile.skills).size !== profile.skills.length) {
    context.addIssue({ code: "custom", path: ["skills"], message: "A skill alias may appear only once per profile" });
  }
});

export type ConfigErrorCode = "config_path_required" | "invalid_execution_profile_config" | "invalid_thinking_level" | "invalid_execution_modes";

const CONFIG_ERROR_MESSAGES: Record<ConfigErrorCode, string> = {
  config_path_required: "Configuration path is required",
  invalid_execution_profile_config: "Execution profile configuration is invalid",
  invalid_thinking_level: "Execution profile thinking level is invalid",
  invalid_execution_modes: "Execution modes file is invalid",
};

export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  constructor(code: ConfigErrorCode) {
    super(CONFIG_ERROR_MESSAGES[code]);
    this.name = "ConfigError";
    this.code = code;
  }
}

export const configSchema = z.object({
  workspaces: z.record(alias, z.string().min(1)),
  skillCatalog: z.record(alias, skillCatalogPath).refine((catalog) => Object.keys(catalog).length <= MAX_SKILL_CATALOG_ENTRIES).optional(),
  executionProfiles: z.record(alias, profileSchema).superRefine((profiles, context) => {
    const entries = Object.entries(profiles);
    if (entries.length === 0) context.addIssue({ code: "custom", message: "At least one execution profile is required" });
    const defaults = entries.filter(([, profile]) => profile.default);
    if (defaults.length !== 1) context.addIssue({ code: "custom", message: "Exactly one execution profile must be the default" });
    if (defaults.length === 1 && defaults[0]![1].permissionProfile !== "read-only") context.addIssue({ code: "custom", message: "The default execution profile must be read-only" });
  }),
}).strict().superRefine((config, context) => {
  // A profile may select only cataloged skills; there is no implicit or default skill.
  const catalog = config.skillCatalog ?? {};
  for (const [profileAlias, profile] of Object.entries(config.executionProfiles)) {
    if ((profile.skills ?? []).some((skill) => !Object.hasOwn(catalog, skill))) {
      context.addIssue({ code: "custom", path: ["executionProfiles", profileAlias, "skills"], message: "A selected skill must be a skillCatalog alias" });
    }
  }
});

/** The only supported reload behavior: a running controller keeps the snapshot it loaded at startup. */
export const RELOAD_POLICY = "restart-required" as const;
export type ReloadPolicy = typeof RELOAD_POLICY;
export const CONFIGURATION_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Path-free, secret-free metadata captured from the exact configuration bytes read at load time. */
export interface ConfigurationMetadata {
  readonly fingerprint: `sha256:${string}`;
  readonly reloadPolicy: ReloadPolicy;
}

export interface AppConfig {
  readonly workspaces: ReadonlyMap<string, string>;
  readonly workspaceModes: ReadonlyMap<string, WorkspaceModeEntry>;
  readonly executionProfiles: ReadonlyMap<string, ConfiguredExecutionProfile>;
  readonly defaultExecutionProfile: string;
  readonly configuration: ConfigurationMetadata;
  /** Absolute skill override directory next to the configuration file. Internal; never projected. */
  readonly skillOverrideDirectory: string;
}

function configurationFingerprint(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Resolves a profile's selection against the catalog. Catalog paths resolve like workspaces,
 * against the configuration file's directory. Two selected aliases on the same path would
 * load one skill twice under different public names, so they invalidate the configuration.
 * A `builtin:<name>` value resolves to the library skill: the operator's override, else the shipped one.
 */
function resolveSkillSelection(selected: readonly string[] | undefined, catalog: Readonly<Record<string, string>>, base: string, overrideDirectory: string): readonly SkillSelection[] | undefined {
  if (selected === undefined || selected.length === 0) return undefined;
  const resolveEntry = (value: string): string => {
    const builtin = builtinSkillName(value);
    return builtin === undefined ? resolve(base, value) : builtinSkillPath(builtin, { overrideDirectory });
  };
  const skills = selected.map((skill) => Object.freeze({ alias: skill, path: resolveEntry(catalog[skill]!) }));
  if (new Set(skills.map((skill) => skill.path)).size !== skills.length) throw new ConfigError("invalid_execution_profile_config");
  return Object.freeze(skills);
}

/**
 * The configuration path comes only from the caller or from `PI_SESSION_MCP_CONFIG`.
 * There is no default file: a server's working directory is the client's project,
 * which may be untrusted, so a file found there must never become the policy.
 */
export async function loadConfig(path = process.env.PI_SESSION_MCP_CONFIG): Promise<AppConfig> {
  if (!path) throw new ConfigError("config_path_required");
  const absoluteConfig = resolve(path);
  // One read: the same bytes feed both the fingerprint and the parse.
  const bytes = await readFile(absoluteConfig);
  const configuration: ConfigurationMetadata = Object.freeze({
    fingerprint: configurationFingerprint(bytes),
    reloadPolicy: RELOAD_POLICY,
  });
  const input = JSON.parse(bytes.toString("utf8")) as unknown;
  let parsed: z.infer<typeof configSchema>;
  try {
    parsed = configSchema.parse(input);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const thinkingLevelIssue = error.issues.some((issue) => issue.path.at(-1) === "thinkingLevel");
      throw new ConfigError(thinkingLevelIssue ? "invalid_thinking_level" : "invalid_execution_profile_config");
    }
    throw error;
  }
  const base = dirname(absoluteConfig);
  const overrideDirectory = skillOverrideDirectory(absoluteConfig);
  const workspaces = new ImmutableMap(Object.entries(parsed.workspaces).map(([key, value]) => [key, resolve(base, value)] as const));
  const catalog = parsed.skillCatalog ?? {};
  const executionProfiles = new ImmutableMap(Object.entries(parsed.executionProfiles).map(([key, { mcpServers, extensions, skills, ...value }]) => {
    const selection = resolveSkillSelection(skills, catalog, base, overrideDirectory);
    return [key, Object.freeze({
      alias: key, ...value,
      ...(mcpServers === undefined ? {} : { mcpServers: snapshotMcpServers(mcpServers) }),
      ...(extensions === undefined ? {} : { extensions: Object.freeze(extensions.map((spec) => parseExtensionSpec(spec)!)) }),
      ...(selection === undefined ? {} : { skills: selection }),
    })] as const;
  }));
  const workspaceModes = await loadExecutionModes(absoluteConfig, new Set(workspaces.keys()), executionProfiles);
  const defaultEntry = [...executionProfiles].find(([, profile]) => profile.default);
  if (!defaultEntry) throw new Error("Execution profile configuration is invalid");
  return { workspaces, workspaceModes, executionProfiles, defaultExecutionProfile: defaultEntry[0], configuration, skillOverrideDirectory: overrideDirectory };
}

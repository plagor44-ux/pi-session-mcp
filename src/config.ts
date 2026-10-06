import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { isMcpServers, snapshotMcpServers, type McpServers } from "./mcp-config.js";
import {
  ALIAS_PATTERN,
  ImmutableMap,
  type ConfiguredExecutionProfile,
  type PermissionProfile,
  type ThinkingLevel,
} from "./execution-profile.js";

const alias = z.string().regex(ALIAS_PATTERN);
const permissionProfile = z.enum(["read-only", "coding"] satisfies [PermissionProfile, PermissionProfile]);
const thinkingLevel = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] satisfies [ThinkingLevel, ...ThinkingLevel[]]);
const profileSchema = z.object({
  default: z.boolean(), permissionProfile, provider: z.string().trim().min(1).max(256),
  model: z.string().trim().min(1).max(256), thinkingLevel,
  mcpServers: z.custom<McpServers>((value) => isMcpServers(value)).optional(),
}).strict().superRefine((profile, context) => {
  if (profile.mcpServers !== undefined && !isMcpServers(profile.mcpServers, profile.permissionProfile)) {
    context.addIssue({ code: "custom", path: ["mcpServers"], message: "MCP tool grants do not match the permission profile" });
  }
});

export type ConfigErrorCode = "config_path_required" | "invalid_execution_profile_config" | "invalid_thinking_level";

const CONFIG_ERROR_MESSAGES: Record<ConfigErrorCode, string> = {
  config_path_required: "Configuration path is required",
  invalid_execution_profile_config: "Execution profile configuration is invalid",
  invalid_thinking_level: "Execution profile thinking level is invalid",
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
  executionProfiles: z.record(alias, profileSchema).superRefine((profiles, context) => {
    const entries = Object.entries(profiles);
    if (entries.length === 0) context.addIssue({ code: "custom", message: "At least one execution profile is required" });
    const defaults = entries.filter(([, profile]) => profile.default);
    if (defaults.length !== 1) context.addIssue({ code: "custom", message: "Exactly one execution profile must be the default" });
    if (defaults.length === 1 && defaults[0]![1].permissionProfile !== "read-only") context.addIssue({ code: "custom", message: "The default execution profile must be read-only" });
  }),
}).strict();

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
  readonly executionProfiles: ReadonlyMap<string, ConfiguredExecutionProfile>;
  readonly defaultExecutionProfile: string;
  readonly configuration: ConfigurationMetadata;
}

function configurationFingerprint(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
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
  const workspaces = new ImmutableMap(Object.entries(parsed.workspaces).map(([key, value]) => [key, resolve(base, value)] as const));
  const executionProfiles = new ImmutableMap(Object.entries(parsed.executionProfiles).map(([key, { mcpServers, ...value }]) => [key, Object.freeze({
    alias: key, ...value,
    ...(mcpServers === undefined ? {} : { mcpServers: snapshotMcpServers(mcpServers) }),
  })] as const));
  const defaultEntry = [...executionProfiles].find(([, profile]) => profile.default);
  if (!defaultEntry) throw new Error("Execution profile configuration is invalid");
  return { workspaces, executionProfiles, defaultExecutionProfile: defaultEntry[0], configuration };
}

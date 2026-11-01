import packageMetadata from "../package.json" with { type: "json" };
import type { ConfigurationMetadata } from "./config.js";
import type { WorkspaceModeEntry } from "./execution-modes.js";
import type { ConfiguredExecutionProfile } from "./execution-profile.js";

const compareAliases = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

/** The public capability shape of one profile, exactly as `pi_capabilities_get` publishes it. */
export function projectExecutionProfile(
  { alias, default: isDefault, permissionProfile, provider, model, thinkingLevel, extensions, grantedExtensionTools, shell, skills, maxTurnSeconds }: ConfiguredExecutionProfile,
) {
  return {
    alias,
    default: isDefault,
    permissionProfile,
    provider,
    model,
    thinkingLevel,
    extensions: (extensions ?? []).map((extension) => extension.spec),
    grantedExtensionTools: [...(grantedExtensionTools ?? [])],
    // Configured intent only: whether the server's probe succeeds is a start-time fact.
    shell: shell ?? ("none" as const),
    skills: (skills ?? []).map((skill) => skill.alias),
    maxTurnSeconds: maxTurnSeconds ?? null,
  };
}

/** Pure projection of the snapshot captured at load time; never reads the configuration file. */
export function projectCapabilities(
  workspaces: ReadonlyMap<string, string>,
  executionProfiles: ReadonlyMap<string, ConfiguredExecutionProfile>,
  configuration: ConfigurationMetadata,
  workspaceModes: ReadonlyMap<string, WorkspaceModeEntry> = new Map(),
  eventDelivery: "spool" | "off" = "off",
) {
  return {
    ok: true as const,
    server: { name: packageMetadata.name, version: packageMetadata.version },
    configuration: {
      fingerprint: configuration.fingerprint,
      reloadPolicy: configuration.reloadPolicy,
    },
    events: { delivery: eventDelivery },
    workspaces: [...workspaces.keys()]
      .sort(compareAliases)
      .map((alias) => {
        const entry = workspaceModes.get(alias);
        return { alias, mode: entry?.mode ?? "unset", ...(entry?.mode === "container" && entry.container ? { writers: entry.container.writers, defaultBase: entry.container.base ?? null } : {}) };
      }),
    executionProfiles: [...executionProfiles.values()]
      .sort((left, right) => compareAliases(left.alias, right.alias))
      .map(projectExecutionProfile),
  };
}

import packageMetadata from "../package.json" with { type: "json" };
import type { ConfigurationMetadata } from "./config.js";
import type { WorkspaceModeEntry } from "./execution-modes.js";
import type { ConfiguredExecutionProfile } from "./execution-profile.js";

const compareAliases = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

/** Pure projection of the snapshot captured at load time; never reads the configuration file. */
export function projectCapabilities(
  workspaces: ReadonlyMap<string, string>,
  executionProfiles: ReadonlyMap<string, ConfiguredExecutionProfile>,
  configuration: ConfigurationMetadata,
  workspaceModes: ReadonlyMap<string, WorkspaceModeEntry> = new Map(),
) {
  return {
    ok: true as const,
    server: { name: packageMetadata.name, version: packageMetadata.version },
    configuration: {
      fingerprint: configuration.fingerprint,
      reloadPolicy: configuration.reloadPolicy,
    },
    workspaces: [...workspaces.keys()]
      .sort(compareAliases)
      .map((alias) => ({ alias, mode: workspaceModes.get(alias)?.mode ?? "unset" })),
    executionProfiles: [...executionProfiles.values()]
      .sort((left, right) => compareAliases(left.alias, right.alias))
      .map(({ alias, default: isDefault, permissionProfile, provider, model, thinkingLevel, extensions, grantedExtensionTools, skills }) => ({
        alias,
        default: isDefault,
        permissionProfile,
        provider,
        model,
        thinkingLevel,
        extensions: (extensions ?? []).map((extension) => extension.spec),
        grantedExtensionTools: [...(grantedExtensionTools ?? [])],
        skills: (skills ?? []).map((skill) => skill.alias),
      })),
  };
}

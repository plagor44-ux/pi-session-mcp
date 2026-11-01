import type { ExtensionSpec } from "./extension-spec.js";
import { snapshotMcpServers, type McpServers } from "./mcp-config.js";
import type { SkillSelection } from "./skill-catalog.js";

export const ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export type PermissionProfile = "read-only" | "coding";
export type ShellMode = "sandboxed";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** A profile as it appears in the strictly validated application config. */
export interface ConfiguredExecutionProfile {
  readonly alias: string;
  readonly default: boolean;
  readonly maxTurnSeconds?: number;
  readonly permissionProfile: PermissionProfile;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: ThinkingLevel;
  readonly mcpServers?: McpServers;
  readonly extensions?: readonly ExtensionSpec[];
  readonly grantedExtensionTools?: readonly string[];
  /** `sandboxed` adds a bubblewrap-confined `bash` to a read-only profile (ADR 0013); absent means no shell. */
  readonly shell?: ShellMode;
  /** The selected catalog skills in configured order; absent when the profile selects none. */
  readonly skills?: readonly SkillSelection[];
}

/** The immutable, server-side selection passed to the Pi adapter. */
export interface ResolvedExecutionProfile {
  readonly maxTurnSeconds?: number;
  readonly alias: string;
  readonly permissionProfile: PermissionProfile;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: ThinkingLevel;
  readonly mcpServers?: McpServers;
  readonly extensions?: readonly ExtensionSpec[];
  readonly grantedExtensionTools?: readonly string[];
  readonly shell?: ShellMode;
  readonly skills?: readonly SkillSelection[];
}

export function toResolvedExecutionProfile(profile: ConfiguredExecutionProfile): ResolvedExecutionProfile {
  return Object.freeze({
    alias: profile.alias,
    ...(profile.maxTurnSeconds === undefined ? {} : { maxTurnSeconds: profile.maxTurnSeconds }),
    permissionProfile: profile.permissionProfile,
    provider: profile.provider,
    model: profile.model,
    thinkingLevel: profile.thinkingLevel,
    ...(profile.mcpServers === undefined ? {} : { mcpServers: snapshotMcpServers(profile.mcpServers) }),
    ...(profile.extensions === undefined ? {} : { extensions: profile.extensions }),
    ...(profile.grantedExtensionTools === undefined ? {} : { grantedExtensionTools: Object.freeze([...profile.grantedExtensionTools]) }),
    ...(profile.shell === undefined ? {} : { shell: profile.shell }),
    ...(profile.skills === undefined ? {} : { skills: profile.skills }),
  });
}

/** A small read-only map implementation which has no mutating methods at runtime. */
export class ImmutableMap<K, V> implements ReadonlyMap<K, V> {
  private readonly entriesMap: Map<K, V>;

  constructor(entries: Iterable<readonly [K, V]>) {
    this.entriesMap = new Map(entries);
  }

  get size(): number { return this.entriesMap.size; }
  get(key: K): V | undefined { return this.entriesMap.get(key); }
  has(key: K): boolean { return this.entriesMap.has(key); }
  entries(): MapIterator<[K, V]> { return this.entriesMap.entries(); }
  keys(): MapIterator<K> { return this.entriesMap.keys(); }
  values(): MapIterator<V> { return this.entriesMap.values(); }
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    this.entriesMap.forEach((value, key) => callbackfn.call(thisArg, value, key, this));
  }
  [Symbol.iterator](): MapIterator<[K, V]> { return this.entriesMap.entries(); }
}

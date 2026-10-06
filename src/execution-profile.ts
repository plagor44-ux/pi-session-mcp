import { snapshotMcpServers, type McpServers } from "./mcp-config.js";

export const ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export type PermissionProfile = "read-only" | "coding";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** A profile as it appears in the strictly validated application config. */
export interface ConfiguredExecutionProfile {
  readonly alias: string;
  readonly default: boolean;
  readonly permissionProfile: PermissionProfile;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: ThinkingLevel;
  readonly mcpServers?: McpServers;
}

/** The immutable, server-side selection passed to the Pi adapter. */
export interface ResolvedExecutionProfile {
  readonly alias: string;
  readonly permissionProfile: PermissionProfile;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: ThinkingLevel;
  readonly mcpServers?: McpServers;
}

export function toResolvedExecutionProfile(profile: ConfiguredExecutionProfile): ResolvedExecutionProfile {
  return Object.freeze({
    alias: profile.alias,
    permissionProfile: profile.permissionProfile,
    provider: profile.provider,
    model: profile.model,
    thinkingLevel: profile.thinkingLevel,
    ...(profile.mcpServers === undefined ? {} : { mcpServers: snapshotMcpServers(profile.mcpServers) }),
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

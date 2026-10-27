import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ConfigError } from "./config.js";
import { ImmutableMap } from "./execution-profile.js";

export type WorkspaceMode = "unset" | "host" | "container" | "read-only";

export interface ContainerSettings {
  readonly writers: number;
  readonly lifecycle: "persistent" | "ephemeral";
  readonly profiles: readonly string[];
  readonly image: string;
  readonly network: "pasta" | "none";
  readonly cache: "none" | "go" | "uv";
}

export interface WorkspaceModeEntry {
  readonly mode: WorkspaceMode;
  readonly container?: ContainerSettings;
}

export const EXECUTION_MODES_FILE = "execution-modes.json";

export function executionModesPath(configPath: string): string {
  return join(dirname(configPath), EXECUTION_MODES_FILE);
}

const entrySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("host"), acceptHostWrites: z.literal(true) }).strict(),
  z.object({ mode: z.literal("read-only") }).strict(),
  z.object({
    mode: z.literal("container"),
    writers: z.number().int().min(1).max(16).default(1),
    lifecycle: z.enum(["persistent", "ephemeral"]).default("persistent"),
    profiles: z.array(z.string()).min(1),
    image: z.union([z.literal("node"), z.string().regex(/^[0-9a-f]{64}$/)]).default("node"),
    network: z.enum(["pasta", "none"]).default("pasta"),
    cache: z.enum(["none", "go", "uv"]).default("none"),
  }).strict(),
]);

export const executionModesSchema = z.object({
  schemaVersion: z.literal(1),
  workspaces: z.record(z.string(), entrySchema),
}).strict();

type ModeProfile = { readonly permissionProfile: "read-only" | "coding"; readonly provider: string };

export function resolveExecutionModes(
  raw: unknown,
  workspaceAliases: ReadonlySet<string>,
  profiles: ReadonlyMap<string, ModeProfile>,
): ReadonlyMap<string, WorkspaceModeEntry> {
  const parsed = executionModesSchema.safeParse(raw);
  if (!parsed.success) throw new ConfigError("invalid_execution_modes");
  const entries = new Map<string, WorkspaceModeEntry>();
  for (const [alias, entry] of Object.entries(parsed.data.workspaces)) {
    if (!workspaceAliases.has(alias)) throw new ConfigError("invalid_execution_modes");
    if (entry.mode === "container") {
      for (const profileAlias of entry.profiles) {
        const profile = profiles.get(profileAlias);
        if (profile?.permissionProfile !== "coding" || profile.provider === "cursor") {
          throw new ConfigError("invalid_execution_modes");
        }
      }
      const { mode, ...settings } = entry;
      entries.set(alias, Object.freeze({ mode, container: Object.freeze({
        ...settings, profiles: Object.freeze([...settings.profiles]),
      }) }));
    } else {
      entries.set(alias, Object.freeze({ mode: entry.mode }));
    }
  }
  return new ImmutableMap([...workspaceAliases].map((alias) => [alias, entries.get(alias) ?? Object.freeze({ mode: "unset" })] as const));
}

export async function loadExecutionModes(
  configPath: string,
  workspaceAliases: ReadonlySet<string>,
  profiles: ReadonlyMap<string, ModeProfile>,
): Promise<ReadonlyMap<string, WorkspaceModeEntry>> {
  let raw: unknown;
  try {
    const bytes = await readFile(executionModesPath(configPath), "utf8");
    raw = JSON.parse(bytes) as unknown;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      raw = { schemaVersion: 1, workspaces: {} };
    } else {
      throw new ConfigError("invalid_execution_modes");
    }
  }
  return resolveExecutionModes(raw, workspaceAliases, profiles);
}

export function codingAllowed(entry: WorkspaceModeEntry): boolean {
  return entry.mode === "unset" || entry.mode === "host";
}

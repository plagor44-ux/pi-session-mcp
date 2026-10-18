import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ConfigError, loadConfig } from "./config.js";
import { containerRuntimeUsable } from "./container-runtime.js";
import { ALIAS_PATTERN } from "./execution-profile.js";
import { executionModesPath, executionModesSchema, resolveExecutionModes, type ContainerSettings } from "./execution-modes.js";
import { acquireOverrideLock, OverrideLockError } from "./override-lock.js";
import { result, type SetupResult, type SetupStatus } from "./setup-result.js";
import { skillOverrideDirectory } from "./skill-library.js";

export interface ModeRequest {
  readonly alias: string;
  readonly mode?: "host" | "container" | "read-only";
  readonly acceptHostWrites: boolean;
  readonly container?: Partial<ContainerSettings>;
  readonly apply: boolean;
  readonly discard?: boolean;
  readonly baseRef?: string;
  readonly codex?: boolean;
}

/** A dry run writes nothing; apply serializes the entire read/validate/replace transaction. */
export async function changeExecutionMode(configPath: string, request: ModeRequest, dependencies: { containerRuntime?: () => Promise<boolean>; beforeWrite?: (entry: import("./execution-modes.js").WorkspaceModeEntry) => Promise<SetupResult | undefined>; afterChange?: (output: SetupResult) => Promise<SetupResult> } = {}): Promise<SetupResult> {
  const target = { client: "modes", scope: "workspace", alias: ALIAS_PATTERN.test(request.alias) ? request.alias : "invalid" };
  const operation = request.apply ? "apply" : "dry-run";
  const done = (status: SetupStatus, code: string): SetupResult => result(operation, [{ target, status, code }], status === "planned" ? "planned" : undefined);
  if (!ALIAS_PATTERN.test(request.alias)) return done("failed", "alias_unknown");
  const change = async (): Promise<SetupResult> => {
    let config;
    try { config = await loadConfig(configPath); }
    catch (error) { return done("failed", error instanceof ConfigError && error.code === "invalid_execution_modes" ? "modes_file_invalid" : "config_invalid"); }
    if (!config.workspaces.has(request.alias)) return done("failed", "alias_unknown");
    const aliases = new Set(config.workspaces.keys());
    const path = executionModesPath(configPath);
    let raw: { schemaVersion: 1; workspaces: Record<string, unknown> };
    let current;
    try {
      try {
        // Do not replace links, directories or other non-regular operator content.
        if (!(await lstat(path)).isFile()) return done("failed", "modes_file_invalid");
        raw = JSON.parse(await readFile(path, "utf8")) as typeof raw;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        raw = { schemaVersion: 1, workspaces: {} };
      }
      current = executionModesSchema.parse(raw);
      resolveExecutionModes(current, aliases, config.executionProfiles);
    } catch { return done("failed", "modes_file_invalid"); }
    let mode = request.mode;
    const runtimeUsable = () => (dependencies.containerRuntime ?? containerRuntimeUsable)().catch(() => false);
    if (mode === undefined) {
      if (!await runtimeUsable()) return done("failed", "mode_choice_required");
      mode = "container";
    }
    if (mode === "host" && !request.acceptHostWrites) return done("failed", "host_ack_required");
    if (mode === "container" && !request.container?.profiles?.length) return done("failed", "container_profiles_required");
    if (request.mode === "container" && !await runtimeUsable()) return done("failed", "container_runtime_unavailable");
    const entry = mode === "host" ? { mode, acceptHostWrites: true } : mode === "container" ? { ...request.container, mode } : { mode };
    let proposed;
    try {
      proposed = executionModesSchema.parse({ schemaVersion: 1, workspaces: { ...raw.workspaces, [request.alias]: entry } });
      resolveExecutionModes(proposed, aliases, config.executionProfiles);
    } catch { return done("failed", "modes_file_invalid"); }
    const resolved = resolveExecutionModes(proposed, aliases, config.executionProfiles).get(request.alias)!;
    const refused = await dependencies.beforeWrite?.(resolved);
    if (refused) return refused;
    if (JSON.stringify(current.workspaces[request.alias]) === JSON.stringify(proposed.workspaces[request.alias])) return done("unchanged", "mode_unchanged");
    if (!request.apply) return done("planned", "mode_planned");
    // Preserve every other repository's entry verbatim, including omitted defaults.
    const content = { ...raw, workspaces: { ...raw.workspaces, [request.alias]: proposed.workspaces[request.alias] } };
    const temporary = join(dirname(path), `.execution-modes.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      try { await handle.writeFile(`${JSON.stringify(content, null, 2)}\n`); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(() => undefined); }
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
    return result(operation, [{ target, status: "ok", code: "mode_applied" }, { target, status: "ok", code: "controllers_restart_required" }]);
  };
  try {
    if (!request.apply) { const output = await change(); return output.exitCode === 0 && dependencies.afterChange ? await dependencies.afterChange(output) : output; }
    const directory = skillOverrideDirectory(configPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lock = await acquireOverrideLock(directory);
    try { const output = await change(); return output.exitCode === 0 && dependencies.afterChange ? await dependencies.afterChange(output) : output; } finally { await lock.release(); }
  } catch (error) { return done("failed", error instanceof OverrideLockError ? error.code : "operation_failed"); }
}

import { createHash } from "node:crypto";
import { join } from "node:path";
import { taskDefinitions } from "../../profiles/oracles.js";
import type { Arm } from "./approval.js";

// Pure builders for one live L1 run: prompts, settings, MCP config, Pi config and the Claude command line.
export const SERVER_KEY = "pi-session-mcp";
export const TOOL_PREFIX = `mcp__${SERVER_KEY}__`;
export const PRODUCT_TOOLS = ["pi_capabilities_get", "pi_session_start", "pi_session_prompt", "pi_turn_get", "pi_session_close", "pi_session_get", "pi_session_list", "pi_session_abort"] as const;
export const CONTROLLER_MODEL = "claude-sonnet-5-5";
export const HOOK_TIMEOUT_S = 900;
export const WAIT_BUDGET_MS = 840_000;
export const WORKER_PROFILE = "explore-fast";

export const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** Copy of RUN_PROMPTS[0] in eval/profiles/token-live.ts with the profile alias replaced (a test compares both against the source file). */
export const L1_RUN_PROMPT = `For this fresh isolated evaluation, use only the pi-session-mcp server. Discover capabilities; start one read-only session in workspace alias \`fixture\` using profile \`${WORKER_PROFILE}\`; prompt once with the supplied task; poll with bounded pauses until terminal; retrieve its completed receipt; close it and verify the session list is empty. Do not start another session.`;

export const ARM_C_PARAGRAPH = "Event delivery is active for this run. After pi_session_prompt returns a running turn, do not poll that turn and do not sleep; end your turn instead. A system message starting with `pi-bridge:` will wake you when the turn is terminal. Then read the turn once with pi_turn_get. If you are woken by a budget message instead, poll once.";

export function t1Prompt(): string {
  const task = taskDefinitions.find((t) => t.id === "T1");
  if (!task) throw new Error("task_missing");
  return task.prompt;
}
export const userPrompt = (): string => `${L1_RUN_PROMPT}\nSupplied task:\n${t1Prompt()}`;
export const systemPrompt = (arm: Arm, skillText: string): string => (arm === "C" ? `${skillText}\n\n${ARM_C_PARAGRAPH}` : skillText);

/** POSIX single-quote quoting for a hook command line. */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export interface HookPaths { node: string; waiterJs: string; spoolBase: string; waiterLog: string }
export const WAITER_MATCHER = `${TOOL_PREFIX}pi_session_prompt|${TOOL_PREFIX}pi_turn_get`;
export function buildSettings(arm: Arm, paths: HookPaths): Record<string, unknown> {
  if (arm === "A") return {};
  const command = `env BRIDGE_SPOOL_BASE=${shellQuote(paths.spoolBase)} BRIDGE_WAIT_BUDGET_MS=${WAIT_BUDGET_MS} BRIDGE_ON_BUDGET=wake BRIDGE_WAITER_LOG=${shellQuote(paths.waiterLog)} ${shellQuote(paths.node)} ${shellQuote(paths.waiterJs)}`;
  return { hooks: { PostToolUse: [{ matcher: WAITER_MATCHER, hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_S, asyncRewake: true }] }] } };
}

export interface ServerEnvInput { liveConfigPath: string; agentDir?: string }
export function buildMcpConfig(node: string, serverJs: string, input: ServerEnvInput): Record<string, unknown> {
  const env: Record<string, string> = { BRIDGE_LIVE_CONFIG: input.liveConfigPath };
  if (input.agentDir !== undefined) env.PI_CODING_AGENT_DIR = input.agentDir;
  return { mcpServers: { [SERVER_KEY]: { command: node, args: [serverJs], env } } };
}

/** Pi configuration of the worker: one read-only profile, no skills, no extensions. */
export function buildPiConfig(workspace: string): Record<string, unknown> {
  return {
    workspaces: { fixture: workspace },
    executionProfiles: { [WORKER_PROFILE]: { permissionProfile: "read-only", provider: "openai", model: "gpt-6-luna", thinkingLevel: "low", default: true } },
  };
}

export interface CommandInput { mcpConfig: string; settings: string; systemPrompt: string }
export function buildClaudeArgs(input: CommandInput): string[] {
  const allowed = [...PRODUCT_TOOLS.map((tool) => `${TOOL_PREFIX}${tool}`), "Bash(sleep:*)"].join(",");
  return ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-hook-events", "--model", CONTROLLER_MODEL, "--strict-mcp-config",
    "--mcp-config", input.mcpConfig, "--settings", input.settings, "--no-session-persistence", "--tools", "Bash", "--allowedTools", allowed, "--append-system-prompt", input.systemPrompt];
}

export interface EnvInput { home: string; configDir: string; tmp: string; apiKey: string; baseUrl?: string }
/** Scrubbed controller environment. The API key is the only credential; dry runs add a loopback base URL. */
export function buildControllerEnv(path: string, input: EnvInput): NodeJS.ProcessEnv {
  return {
    PATH: path, HOME: input.home, CLAUDE_CONFIG_DIR: input.configDir, TMPDIR: input.tmp, CLAUDE_CODE_TMPDIR: input.tmp,
    XDG_CONFIG_HOME: join(input.home, ".config"), XDG_DATA_HOME: join(input.home, ".local/share"), XDG_CACHE_HOME: join(input.home, ".cache"), XDG_STATE_HOME: join(input.home, ".local/state"),
    DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", ENABLE_TOOL_SEARCH: "false",
    ANTHROPIC_API_KEY: input.apiKey, ...(input.baseUrl ? { ANTHROPIC_BASE_URL: input.baseUrl, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } : {}),
  };
}

/** First JSON object in a text (fenced or surrounded by prose); balanced-brace scan that respects strings. Returns undefined when none parses. */
export function firstJsonObject(text: string): unknown {
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i]!;
      if (inString) { if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === "\"") inString = false; continue; }
      if (ch === "\"") inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}" && --depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)) as unknown; } catch { break; }
      }
    }
  }
  return undefined;
}

import type { PromptPlan } from "../scripted-adapter.js";

// Configuration of the live evaluation server (read from the JSON file named by BRIDGE_LIVE_CONFIG).
// `sdk` runs the real SdkPiSessionAdapter; `scripted` is the provider-free dry-run worker.
export interface LiveServerConfig {
  mode: "sdk" | "scripted";
  /** File handed to loadConfig (same semantics as PI_SESSION_MCP_CONFIG). */
  piConfigPath: string;
  spoolBase: string;
  counterFile: string;
  receiptDir: string;
  /** Scripted mode only: one entry per session in start order. */
  scripts?: Array<{ prompts: PromptPlan[] }>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export function parseLiveServerConfig(raw: unknown): LiveServerConfig {
  if (!isObject(raw)) throw new Error("config_invalid");
  const { mode, piConfigPath, spoolBase, counterFile, receiptDir, scripts } = raw;
  if (mode !== "sdk" && mode !== "scripted") throw new Error("config_invalid");
  if (!nonEmpty(piConfigPath) || !nonEmpty(spoolBase) || !nonEmpty(counterFile) || !nonEmpty(receiptDir)) throw new Error("config_invalid");
  if (mode === "scripted") {
    if (!Array.isArray(scripts) || !scripts.every((s) => isObject(s) && Array.isArray(s.prompts))) throw new Error("config_invalid");
    return { mode, piConfigPath, spoolBase, counterFile, receiptDir, scripts: scripts as LiveServerConfig["scripts"] & object };
  }
  if (scripts !== undefined) throw new Error("config_invalid");
  return { mode, piConfigPath, spoolBase, counterFile, receiptDir };
}

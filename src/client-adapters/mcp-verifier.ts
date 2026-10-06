import { PACKAGE_NAME, PACKAGE_VERSION } from "../package-metadata.js";

export const MCP_VERIFY_TIMEOUT_MS = 5_000;
export const MCP_MAX_FRAME_BYTES = 65_536;

export interface McpStdioProcess {
  write(frame: string): void | Promise<void>;
  read(): Promise<string | null>;
  kill(): void | Promise<void>;
}

export interface McpVerifierOptions {
  readonly launch: (signal: AbortSignal) => Promise<McpStdioProcess>;
  readonly timeoutMs?: number;
}

export interface McpVerifierResult {
  readonly status: "verified" | "unsupported" | "timeout" | "failed";
  readonly initialize: boolean;
  readonly toolsList: boolean;
  readonly capabilitiesGet: boolean;
  readonly tools: readonly string[];
}

type JsonRpc = { readonly id?: number; readonly result?: unknown; readonly error?: unknown };
const EXPECTED_TOOLS = ["pi_capabilities_get", "pi_session_start", "pi_session_list", "pi_session_get", "pi_session_prompt", "pi_session_abort", "pi_session_close", "pi_turn_get"] as const;
const EXPECTED_PROTOCOL = "2025-03-26";
const ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const RELOAD_POLICY = "restart-required";

class VerificationTimeoutError extends Error {}

async function beforeDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new VerificationTimeoutError();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new VerificationTimeoutError()), remaining);
  });
  try { return await Promise.race([operation, timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

function frame(value: unknown): string {
  const body = JSON.stringify(value);
  return `${body}\n`;
}
function parseFrame(value: string): JsonRpc | undefined {
  if (Buffer.byteLength(value, "utf8") > MCP_MAX_FRAME_BYTES) return undefined;
  const split = value.indexOf("\r\n\r\n");
  const body = (split >= 0 ? value.slice(split + 4) : value).trim();
  try { const parsed: unknown = JSON.parse(body); return parsed && typeof parsed === "object" ? parsed as JsonRpc : undefined; } catch { return undefined; }
}
function parseToolNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names: string[] = [];
  for (const tool of value) {
    if (!tool || typeof tool !== "object") return undefined;
    const name = (tool as { name?: unknown }).name;
    if (typeof name !== "string" || name.length === 0 || name.length > 128 || names.includes(name)) return undefined;
    names.push(name);
  }
  return names;
}
async function readResponse(process: McpStdioProcess, id: number, deadline: number): Promise<JsonRpc | undefined> {
  while (Date.now() < deadline) {
    const line = await beforeDeadline(process.read(), deadline);
    if (line === null) return undefined;
    const response = parseFrame(line);
    if (response?.id === id) return response;
  }
  return undefined;
}
function validConfiguration(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return exactKeys(record, ["fingerprint", "reloadPolicy"])
    && typeof record.fingerprint === "string" && FINGERPRINT_PATTERN.test(record.fingerprint)
    && record.reloadPolicy === RELOAD_POLICY;
}

function validCapabilities(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const x = value as Record<string, unknown>;
  if (x.ok !== true || !exactKeys(x, ["ok", "server", "configuration", "workspaces", "executionProfiles"]) || !x.server || typeof x.server !== "object") return false;
  const info = x.server as Record<string, unknown>;
  if (!exactKeys(info, ["name", "version"]) || info.name !== PACKAGE_NAME || info.version !== PACKAGE_VERSION || !Array.isArray(x.workspaces) || !Array.isArray(x.executionProfiles)) return false;
  if (!validConfiguration(x.configuration)) return false;
  const workspaces = x.workspaces as unknown[];
  const profiles = x.executionProfiles as unknown[];
  if (!workspaces.every((workspace) => {
    if (!workspace || typeof workspace !== "object") return false;
    const record = workspace as Record<string, unknown>;
    return exactKeys(record, ["alias"]) && typeof record.alias === "string" && ALIAS_PATTERN.test(record.alias);
  })) return false;
  if (!profiles.every((profile) => {
    if (!profile || typeof profile !== "object") return false;
    const record = profile as Record<string, unknown>;
    return exactKeys(record, ["alias", "default", "permissionProfile", "provider", "model", "thinkingLevel"])
      && typeof record.alias === "string" && ALIAS_PATTERN.test(record.alias)
      && typeof record.default === "boolean"
      && (record.permissionProfile === "read-only" || record.permissionProfile === "coding")
      && typeof record.provider === "string" && record.provider.length > 0 && record.provider.length <= 256
      && typeof record.model === "string" && record.model.length > 0 && record.model.length <= 256
      && typeof record.thinkingLevel === "string" && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(record.thinkingLevel);
  })) return false;
  const defaults = profiles.filter((profile) => (profile as Record<string, unknown>).default === true);
  if (defaults.length !== 1 || (defaults[0] as Record<string, unknown>).permissionProfile !== "read-only") return false;
  return true;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && [...expected].sort().every((key, index) => keys[index] === key);
}

async function performVerification(process: McpStdioProcess, deadline: number): Promise<McpVerifierResult> {
  const result: { status: McpVerifierResult["status"]; initialize: boolean; toolsList: boolean; capabilitiesGet: boolean; tools: string[] } = { status: "failed", initialize: false, toolsList: false, capabilitiesGet: false, tools: [] };
  await beforeDeadline(Promise.resolve(process.write(frame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: EXPECTED_PROTOCOL, capabilities: {}, clientInfo: { name: "pi-session-mcp-verifier", version: PACKAGE_VERSION } } }))), deadline);
  const initialized = await readResponse(process, 1, deadline);
  const initializedResult = initialized?.result && typeof initialized.result === "object" ? initialized.result as Record<string, unknown> : undefined;
  const serverInfo = initializedResult?.serverInfo;
  if (!initializedResult || !serverInfo || typeof serverInfo !== "object"
    || initializedResult.protocolVersion !== EXPECTED_PROTOCOL
    || (serverInfo as Record<string, unknown>).name !== PACKAGE_NAME
    || (serverInfo as Record<string, unknown>).version !== PACKAGE_VERSION) return { ...result, status: "unsupported" };
  result.initialize = true;
  await beforeDeadline(Promise.resolve(process.write(frame({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }))), deadline);
  await beforeDeadline(Promise.resolve(process.write(frame({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }))), deadline);
  const listed = await readResponse(process, 3, deadline);
  if (!listed?.result || typeof listed.result !== "object") return { ...result, status: "unsupported" };
  const tools = parseToolNames((listed.result as { tools?: unknown }).tools);
  result.toolsList = true;
  if (!tools || tools.length !== EXPECTED_TOOLS.length || EXPECTED_TOOLS.some((name) => !tools.includes(name))) return { ...result, status: "unsupported" };
  result.tools = [...EXPECTED_TOOLS];
  await beforeDeadline(Promise.resolve(process.write(frame({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "pi_capabilities_get", arguments: {} } }))), deadline);
  const called = await readResponse(process, 4, deadline);
  const structured = called?.result && typeof called.result === "object" ? (called.result as { structuredContent?: unknown }).structuredContent : undefined;
  if (!called?.result || !validCapabilities(structured)) return { ...result, status: "failed" };
  result.capabilitiesGet = true;
  return { ...result, status: "verified" };
}

/** Performs only initialize, tools/list, and pi_capabilities_get({}). */
export async function verifyMcpCapabilities(options: McpVerifierOptions): Promise<McpVerifierResult> {
  const timeout = Math.max(1, options.timeoutMs ?? MCP_VERIFY_TIMEOUT_MS);
  const deadline = Date.now() + timeout;
  const empty: McpVerifierResult = { status: "failed", initialize: false, toolsList: false, capabilitiesGet: false, tools: [] };
  const controller = new AbortController();
  let process: McpStdioProcess | undefined;
  let outcome = empty;
  try {
    process = await beforeDeadline(options.launch(controller.signal), deadline);
    outcome = await performVerification(process, deadline);
  } catch (error) {
    outcome = { ...empty, status: error instanceof VerificationTimeoutError ? "timeout" : "failed" };
  }
  controller.abort();
  if (process) {
    try { await beforeDeadline(Promise.resolve(process.kill()), Date.now() + Math.min(timeout, 1_000)); }
    catch { return { ...outcome, status: "failed" }; }
  }
  return outcome;
}

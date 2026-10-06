import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { isMcpServers, mcpToolName, snapshotMcpServers, type McpServerConfig, type McpServers } from "./mcp-config.js";

export const MCP_STARTUP_TIMEOUT_MS = 10_000;
export const MCP_CALL_TIMEOUT_MS = 30_000;
// The stdio SDK allows 2s for EOF and 2s for SIGTERM before sending SIGKILL.
// This bound must exceed that escalation window and remain below registry cleanup (5s).
export const MCP_CLOSE_TIMEOUT_MS = 4_500;
const MAX_DISCOVERED_TOOLS = 512;
const MAX_DISCOVERY_PAGES = 16;
const MAX_RESULT_BYTES = 256 * 1024;
const RESULT_LIMIT_MESSAGE = "External MCP result exceeds the bridge limit of 262144 bytes; request less data.";
const MAX_ERROR_RESULT_BYTES = 1024;
const MAX_ERROR_MESSAGE_CHARACTERS = 200;
const SOURCE_TOO_LARGE_MESSAGE = JSON.stringify({
  code: "SOURCE_TOO_LARGE",
  message: "Requested source exceeds the response limit; increase maxBytes.",
});

export interface McpRemoteTool {
  readonly name: string;
  // The MCP SDK models `description` as `string | undefined`; exactOptionalPropertyTypes
  // rejects that value for a plain `description?: string`.
  readonly description?: string | undefined;
  readonly inputSchema: { readonly type: "object"; readonly [key: string]: unknown };
}
export interface McpToolPage { readonly tools: readonly McpRemoteTool[]; readonly nextCursor?: string | undefined; }
export interface McpCallResult {
  readonly content: readonly { readonly type: string; readonly [key: string]: unknown }[];
  // The MCP SDK types this as `unknown`; error payloads are validated before classification.
  readonly structuredContent?: unknown;
  readonly isError?: boolean | undefined;
}
/** One connection is owned by one session. Implementations must tolerate repeated close calls. */
export interface McpConnection {
  connect(signal: AbortSignal): Promise<void>;
  listTools(cursor: string | undefined, signal: AbortSignal): Promise<McpToolPage>;
  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult>;
  close(): Promise<void>;
}
export type McpConnectionFactory = (server: McpServerConfig, cwd: string) => McpConnection;
export interface SessionMcpTools { readonly tools: ToolDefinition[]; close(): Promise<void>; }
export interface McpBridgeOptions {
  readonly startupMs?: number; readonly callMs?: number; readonly closeMs?: number;
  readonly signal?: AbortSignal;
}

export type McpStartupErrorCode =
  | "external_mcp_unavailable"
  | "external_mcp_no_tools"
  | "external_mcp_grant_tool_missing";

export interface McpStartupFailure {
  readonly code: McpStartupErrorCode;
  readonly serverAlias?: string;
  readonly toolAlias?: string;
  readonly discoveredToolCount?: number;
}

class McpStartupError extends Error implements McpStartupFailure {
  readonly code: McpStartupErrorCode;
  readonly serverAlias?: string;
  readonly toolAlias?: string;
  readonly discoveredToolCount?: number;

  constructor(code: McpStartupErrorCode, details: Omit<McpStartupFailure, "code"> = {}) {
    super("External MCP operation failed");
    this.name = "McpStartupError";
    this.code = code;
    if (details.serverAlias !== undefined) this.serverAlias = details.serverAlias;
    if (details.toolAlias !== undefined) this.toolAlias = details.toolAlias;
    if (details.discoveredToolCount !== undefined) this.discoveredToolCount = details.discoveredToolCount;
  }
}

function startupFailure(
  code: McpStartupErrorCode,
  details: Omit<McpStartupFailure, "code"> = {},
): McpStartupError {
  return new McpStartupError(code, details);
}

/** Returns only classifications created by this module, never lookalike foreign errors. */
export function classifyMcpStartupError(error: unknown): McpStartupFailure | undefined {
  if (!(error instanceof McpStartupError)) return undefined;
  return Object.freeze({
    code: error.code,
    ...(error.serverAlias === undefined ? {} : { serverAlias: error.serverAlias }),
    ...(error.toolAlias === undefined ? {} : { toolAlias: error.toolAlias }),
    ...(error.discoveredToolCount === undefined ? {} : { discoveredToolCount: error.discoveredToolCount }),
  });
}

function failure(): Error { return new Error("External MCP operation failed"); }

async function bounded<T>(operation: Promise<T>, milliseconds: number, onTimeout: () => void = () => undefined): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(failure());
    }, milliseconds);
  });
  try { return await Promise.race([operation, timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function remoteTool(value: unknown): value is McpRemoteTool {
  return object(value)
    && typeof value.name === "string" && value.name.length > 0 && value.name.length <= 256
    && (value.description === undefined || typeof value.description === "string")
    && object(value.inputSchema) && value.inputSchema.type === "object";
}

function closedObject(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (!object(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && fields.includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.get === undefined
    && Object.getOwnPropertyDescriptor(value, key)?.set === undefined);
}

interface SourceTooLarge { readonly code: "SOURCE_TOO_LARGE"; readonly message: string; }
function sourceTooLarge(value: unknown): value is SourceTooLarge {
  return closedObject(value, ["code", "message"])
    && Object.keys(value).length === 2
    && value.code === "SOURCE_TOO_LARGE" && typeof value.message === "string"
    && value.message.length > 0 && Array.from(value.message).length <= MAX_ERROR_MESSAGE_CHARACTERS
    // Reject control/format characters, path separators, URL schemes and domain-like indicators.
    // Even admitted ordinary foreign text is never copied into the controller message.
    && !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value.message)
    && !/[\\/]|[a-z][a-z0-9+.-]*:|\b[a-z0-9-]+\.[a-z][a-z0-9-]+/iu.test(value.message);
}

// The only accepted raw JSON grammar is a two-member object with string values.
// Decode the keys before comparing them so escaped duplicate keys cannot be hidden
// by JSON.parse's last-key-wins behavior. Structured content is already SDK-decoded.
const jsonString = '"(?:[^"\\\\\\u0000-\\u001f]|\\\\(?:["\\\\/bfnrt]|u[0-9a-fA-F]{4}))*"';
const jsonWhitespace = "[\\t\\n\\r ]*";
const jsonMember = `${jsonWhitespace}(${jsonString})${jsonWhitespace}:${jsonWhitespace}${jsonString}${jsonWhitespace}`;
const errorTextObject = new RegExp(`^${jsonWhitespace}\\{${jsonMember},${jsonMember}\\}${jsonWhitespace}$`);
function sourceTooLargeText(text: string): SourceTooLarge | undefined {
  const match = errorTextObject.exec(text);
  if (!match || JSON.parse(match[1]!) === JSON.parse(match[2]!)) return undefined;
  const parsed: unknown = JSON.parse(text);
  return sourceTooLarge(parsed) ? parsed : undefined;
}

function projectedErrorMessage(result: unknown): string | undefined {
  if (!closedObject(result, ["content", "structuredContent", "isError"])
    || result.isError !== true || !Array.isArray(result.content)
    || Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_ERROR_RESULT_BYTES) return undefined;
  let textError: SourceTooLarge | undefined;
  if (result.content.length === 1) {
    const block: unknown = result.content[0];
    if (!closedObject(block, ["type", "text"]) || Object.keys(block).length !== 2
      || block.type !== "text" || typeof block.text !== "string") return undefined;
    textError = sourceTooLargeText(block.text);
    if (!textError) return undefined;
  } else if (result.content.length !== 0) return undefined;
  if (result.structuredContent !== undefined) {
    if (!sourceTooLarge(result.structuredContent)) return undefined;
    if (textError && (textError.code !== result.structuredContent.code
      || textError.message !== result.structuredContent.message)) return undefined;
  } else if (!textError) return undefined;
  return SOURCE_TOO_LARGE_MESSAGE;
}

/** Explicit, fail-closed tool grants. No extension loading, model calls, or global MCP config. */
export async function connectSessionMcpTools(
  configured: McpServers,
  permissionProfile: "read-only" | "coding",
  cwd: string,
  factory: McpConnectionFactory,
  options: McpBridgeOptions = {},
): Promise<SessionMcpTools> {
  if (!isMcpServers(configured, permissionProfile)) throw failure();
  const servers = snapshotMcpServers(configured);
  const connections: McpConnection[] = [];
  const lifetime = new AbortController();
  const closeMs = options.closeMs ?? MCP_CLOSE_TIMEOUT_MS;
  const callMs = options.callMs ?? MCP_CALL_TIMEOUT_MS;
  let closing: Promise<void> | undefined;
  const connectionClosures = new WeakMap<McpConnection, Promise<void>>();
  const closeConnection = (connection: McpConnection): Promise<void> => {
    const existing = connectionClosures.get(connection);
    if (existing) return existing;
    // Join an in-progress transport close instead of racing its process escalation.
    const pending = bounded(Promise.resolve().then(() => connection.close()), closeMs).then(
      () => undefined, () => undefined,
    );
    connectionClosures.set(connection, pending);
    void pending.then(() => { if (connectionClosures.get(connection) === pending) connectionClosures.delete(connection); });
    return pending;
  };
  const close = (): Promise<void> => {
    if (!closing) {
      lifetime.abort();
      options.signal?.removeEventListener("abort", onShutdown);
      closing = Promise.all(connections.map(closeConnection)).then(() => undefined);
    }
    return closing;
  };
  const ensureOpen = (): void => { if (lifetime.signal.aborted) throw failure(); };
  // Keep the shutdown link for the entire session, including pending SDK construction.
  const onShutdown = (): void => { void close(); };
  options.signal?.addEventListener("abort", onShutdown, { once: true });
  if (options.signal?.aborted) onShutdown();

  const initialize = async (): Promise<ToolDefinition[]> => {
    ensureOpen();
    const tools: ToolDefinition[] = [];
    for (const [serverAlias, server] of Object.entries(servers)) {
      try {
        ensureOpen();
        const connection = factory(server, cwd);
        connections.push(connection);
        // If an implementation ignores cancellation, still clean up a late connection.
        await Promise.resolve().then(() => {
          ensureOpen();
          return connection.connect(lifetime.signal);
        }).finally(async () => {
          // A late failure can own a process too; cleanup is not success-only.
          if (lifetime.signal.aborted) await closeConnection(connection);
        });
        ensureOpen();
        const discovered = new Map<string, McpRemoteTool>();
        const cursors = new Set<string>();
        let cursor: string | undefined;
        for (let pageIndex = 0; ; pageIndex++) {
          ensureOpen();
          if (pageIndex >= MAX_DISCOVERY_PAGES) {
            throw startupFailure("external_mcp_unavailable", { serverAlias });
          }
          const page = await connection.listTools(cursor, lifetime.signal);
          ensureOpen();
          if (!object(page) || !Array.isArray(page.tools)
            || (page.nextCursor !== undefined && typeof page.nextCursor !== "string")) {
            throw startupFailure("external_mcp_unavailable", { serverAlias });
          }
          for (const tool of page.tools) {
            if (!remoteTool(tool) || discovered.has(tool.name) || discovered.size >= MAX_DISCOVERED_TOOLS) {
              throw startupFailure("external_mcp_unavailable", { serverAlias });
            }
            discovered.set(tool.name, tool);
          }
          if (page.nextCursor === undefined) break;
          if (cursors.has(page.nextCursor)) {
            throw startupFailure("external_mcp_unavailable", { serverAlias });
          }
          cursors.add(page.nextCursor);
          cursor = page.nextCursor;
        }
        if (discovered.size === 0) {
          throw startupFailure("external_mcp_no_tools", { serverAlias, discoveredToolCount: 0 });
        }
        for (const [toolAlias, grant] of Object.entries(server.tools)) {
          const remote = discovered.get(grant.name);
          if (!remote) {
            throw startupFailure("external_mcp_grant_tool_missing", {
              serverAlias,
              toolAlias,
              discoveredToolCount: discovered.size,
            });
          }
          // MCP JSON Schemas are passed intact to Pi's JSON-Schema argument validator.
          const parameters = structuredClone(remote.inputSchema) as ToolDefinition["parameters"];
          tools.push({
            name: mcpToolName(serverAlias, toolAlias),
            label: `MCP ${serverAlias}/${toolAlias}`,
            description: remote.description ?? `Call the configured ${serverAlias}/${toolAlias} MCP tool.`,
            parameters,
            promptSnippet: "Call an explicitly granted external MCP tool.",
            executionMode: "sequential",
            async execute(_id, args, signal) {
              ensureOpen();
              if (!object(args) || signal?.aborted) throw failure();
              const call = new AbortController();
              let rejectCancellation!: (error: Error) => void;
              const cancellation = new Promise<never>((_, reject) => { rejectCancellation = reject; });
              void cancellation.catch(() => undefined);
              const cancel = (): void => { call.abort(); rejectCancellation(failure()); };
              lifetime.signal.addEventListener("abort", cancel, { once: true });
              signal?.addEventListener("abort", cancel, { once: true });
              let projectedError: Error | undefined;
              try {
                // Check again after subscribing; close/abort must never race a new call admission.
                if (lifetime.signal.aborted || signal?.aborted) throw failure();
                const result = await bounded(
                  Promise.race([cancellation, Promise.resolve().then(() => {
                    if (call.signal.aborted) throw failure();
                    return connection.callTool(grant.name, args, call.signal);
                  })]),
                  callMs, cancel,
                );
                if (call.signal.aborted) throw failure();
                if (result.isError !== undefined && typeof result.isError !== "boolean") throw failure();
                if (result.isError === true) {
                  const message = projectedErrorMessage(result);
                  if (message === undefined) throw failure();
                  // A private per-execution identity, never a foreign error's name/code/message,
                  // is the only exception permitted to survive the sanitizing catch below.
                  projectedError = new Error(message);
                  throw projectedError;
                }
                if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_RESULT_BYTES) {
                  projectedError = new Error(RESULT_LIMIT_MESSAGE);
                  throw projectedError;
                }
                const content: { type: "text"; text: string }[] = result.content.map((block) => ({
                  type: "text", text: block.type === "text" && typeof block.text === "string" ? block.text : JSON.stringify(block),
                }));
                if (content.length === 0 && result.structuredContent !== undefined) {
                  content.push({ type: "text", text: JSON.stringify(result.structuredContent) });
                }
                return { content, details: {
                  server: serverAlias, tool: toolAlias,
                  ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
                } };
              } catch (error) {
                // A transport exception or MCP isError must not become a successful Pi tool result.
                if (!call.signal.aborted && projectedError !== undefined && error === projectedError) throw error;
                throw failure();
              } finally {
                call.abort();
                lifetime.signal.removeEventListener("abort", cancel);
                signal?.removeEventListener("abort", cancel);
              }
            },
          });
        }
      } catch (error) {
        if (error instanceof McpStartupError) throw error;
        throw startupFailure("external_mcp_unavailable", { serverAlias });
      }
    }
    ensureOpen();
    return tools;
  };
  try {
    const tools = await bounded(initialize(), options.startupMs ?? MCP_STARTUP_TIMEOUT_MS, () => lifetime.abort());
    return { tools, close };
  } catch (error) {
    await close();
    if (error instanceof McpStartupError) throw error;
    throw startupFailure("external_mcp_unavailable");
  }
}

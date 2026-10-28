import type { PermissionProfile, ResolvedExecutionProfile, ThinkingLevel } from "./execution-profile.js";

export type { PermissionProfile };

export type PiTurnOutcome =
  | { status: "completed"; assistantText: string; truncated?: boolean }
  | { status: "failed" }
  | { status: "aborted" };

export interface PiAppliedSelection {
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: ThinkingLevel;
}

export type PiSessionCreationErrorCode =
  | "unknown_provider"
  | "unknown_model"
  | "local_authentication_missing"
  | "local_authentication_unavailable"
  | "model_unavailable"
  | "thinking_level_unavailable"
  | "execution_selection_mismatch"
  | "external_mcp_unavailable"
  | "external_mcp_no_tools"
  | "external_mcp_grant_tool_missing"
  | "external_mcp_activation_mismatch"
  | "extension_not_installed"
  | "extension_version_mismatch"
  | "extension_load_failed"
  | "extension_tool_conflict"
  | "extension_tool_missing"
  | "skill_load_failed"
  | "sandbox_unavailable"
  | "pi_session_creation_failed";

const PI_SESSION_CREATION_MESSAGES: Record<PiSessionCreationErrorCode, string> = {
  unknown_provider: "Execution profile provider is not in the local Pi catalog",
  unknown_model: "Execution profile model is not in the local Pi catalog",
  local_authentication_missing: "Local authentication for the execution profile is missing",
  local_authentication_unavailable: "Local authentication for the execution profile is unavailable",
  model_unavailable: "Execution profile model is not locally available",
  thinking_level_unavailable: "Execution profile thinking level is unavailable for the model",
  execution_selection_mismatch: "Execution profile could not be applied",
  external_mcp_unavailable: "Configured external MCP tools are unavailable",
  external_mcp_no_tools: "Configured external MCP server returned no tools",
  external_mcp_grant_tool_missing: "Configured external MCP grant is missing from discovery",
  external_mcp_activation_mismatch: "Configured external MCP tools could not be activated",
  extension_not_installed: "Configured Pi extension is not installed",
  extension_version_mismatch: "Configured Pi extension version is not installed",
  extension_load_failed: "Configured Pi extension could not be loaded",
  extension_tool_conflict: "Configured Pi extension tools conflict",
  extension_tool_missing: "Granted Pi extension tool is not available",
  skill_load_failed: "Configured Pi skill could not be loaded",
  sandbox_unavailable: "Read-only shell sandbox is not available",
  pi_session_creation_failed: "Pi session creation failed",
};

export class PiSessionCreationError extends Error {
  readonly code: PiSessionCreationErrorCode;
  constructor(code: PiSessionCreationErrorCode) {
    super(PI_SESSION_CREATION_MESSAGES[code]);
    this.name = "PiSessionCreationError";
    this.code = code;
  }
}

export class WriterUnavailableError extends Error {
  readonly code = "writer_unavailable";
  constructor(
    readonly reason: "none_ready" | "none_at_base" | "none_admitted",
    readonly counts?: { busy: number; notAtBaseline: number; settingsChanged: number },
  ) {
    super("No writer is available");
    this.name = "WriterUnavailableError";
  }
}

export interface PiSessionHandle {
  readonly placement?: { writer: string; base: { ref: string; commit: string } } | undefined;
  readonly deadlines?: { preflightMs?: number; abortMs?: number; cleanupMs?: number } | undefined;
  isLost?(): boolean;
  readonly sdkSessionId: string;
  /** Only whitelisted, post-verified selection metadata may cross the adapter boundary. */
  readonly appliedSelection: PiAppliedSelection;
  /**
   * `onActivity` is an optional content-free liveness callback, invoked on observed public
   * SDK activity of the running prompt: assistant message start, update and end, and tool
   * execution start, update and end. Streaming is activity, not evidence of finished or
   * useful work, and internal work without a public event stays invisible. It receives no
   * event payload and must only be used for timestamping; it never carries tool names,
   * arguments, results, text, paths, or credentials.
   */
  prompt(text: string, preflight: (accepted: boolean) => void, onActivity?: () => void): Promise<PiTurnOutcome>;
  abort(): Promise<void>;
  /** May await bounded external-resource cleanup; synchronous fakes remain supported. */
  dispose(): void | Promise<void>;
}

export interface PiSessionAdapter {
  create(input: { cwd: string; workspace: string; base?: string; executionProfile: ResolvedExecutionProfile; signal?: AbortSignal }): Promise<PiSessionHandle>;
}

import type { PermissionProfile, ShellMode } from "./execution-profile.js";

export const PROFILE_TOOLS: Readonly<Record<PermissionProfile, readonly string[]>> = {
  "read-only": ["read", "grep", "find", "ls"],
  coding: ["read", "bash", "edit", "write", "grep", "find", "ls"],
};

/** The built-in tools of a profile: a read-only profile with a sandboxed shell also has `bash`. */
export function profileTools(permissionProfile: PermissionProfile, shell?: ShellMode): readonly string[] {
  return permissionProfile === "read-only" && shell === "sandboxed" ? [...PROFILE_TOOLS["read-only"], "bash"] : PROFILE_TOOLS[permissionProfile];
}

export const MAX_GRANTED_EXTENSION_TOOLS = 32;

/**
 * Letters, digits, `_` and `-`, at most 64 characters, which fits the common provider
 * function-name limit `^[a-zA-Z0-9_-]{1,64}$`. The SDK reads `*` in an allowlist as a glob
 * and a leading `+` or `-` as a modifier, so the first character may not be `-`.
 */
const EXTENSION_TOOL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;

/**
 * These mirror `isMcpToolName` of Pi SDK 1.4.0 (core/mcp-servers.js), which is not a root
 * export. When the allowlist names no `mcp__` entry, the SDK's `_isAllowedTool` keeps such
 * tools outside the allowlist for codemode and tool_search, so an extension tool with one
 * of these names could be active without being granted. This server's own MCP bridge
 * tools are named `mcp_<server>_<tool>` with a single underscore, so they never collide.
 */
const MCP_RESERVED_PREFIX = "mcp__";
const MCP_RESERVED_NAMES: ReadonlySet<string> = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);

export function isAcceptableExtensionToolName(name: string): boolean {
  return EXTENSION_TOOL_NAME.test(name) && !name.startsWith(MCP_RESERVED_PREFIX) && !MCP_RESERVED_NAMES.has(name);
}

export type ComposedSessionTools =
  | { readonly ok: true; readonly tools: string[] }
  | { readonly ok: false; readonly code: "extension_tool_conflict" | "extension_tool_missing" };

/**
 * The tool allowlist of a session. Read-only activates exactly the granted extension
 * names; coding activates all registered extension tools. Conflicts are checked first
 * in both profiles so an extension can never shadow a built-in or granted MCP tool.
 * Unsafe names and names the SDK treats as MCP tools also fail closed.
 */
export function composeSessionTools(
  permissionProfile: PermissionProfile,
  mcpToolNames: readonly string[],
  extensionToolNames: readonly (readonly string[])[],
  grantedExtensionTools: readonly string[] = [],
  shell?: ShellMode,
): ComposedSessionTools {
  const reserved = new Set([...PROFILE_TOOLS.coding, ...PROFILE_TOOLS["read-only"], ...mcpToolNames]);
  const extensionTools: string[] = [];
  for (const names of extensionToolNames) {
    for (const name of names) {
      if (!isAcceptableExtensionToolName(name) || reserved.has(name)) return { ok: false, code: "extension_tool_conflict" };
      reserved.add(name);
      extensionTools.push(name);
    }
  }
  if (permissionProfile === "read-only" && grantedExtensionTools.some((name) => !extensionTools.includes(name))) {
    return { ok: false, code: "extension_tool_missing" };
  }
  return { ok: true, tools: [...profileTools(permissionProfile, shell), ...mcpToolNames, ...(permissionProfile === "coding" ? extensionTools : grantedExtensionTools)] };
}

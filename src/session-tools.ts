import type { PermissionProfile } from "./execution-profile.js";

export const PROFILE_TOOLS: Readonly<Record<PermissionProfile, readonly string[]>> = {
  "read-only": ["read", "grep", "find", "ls"],
  coding: ["read", "bash", "edit", "write", "grep", "find", "ls"],
};

/** The SDK reads `*` in an allowlist as a glob and a leading `+` or `-` as a modifier, so those names are rejected: the first character may not be `-`. */
const EXTENSION_TOOL_NAME = /^[A-Za-z0-9_.:][A-Za-z0-9_.:-]*$/;

/**
 * The tool allowlist of a session, or undefined when an extension tool name conflicts.
 * Extension tools are active only in coding profiles, but a conflict fails closed in both,
 * so an extension can never shadow a built-in or granted tool. A name outside the safe
 * character set also fails closed.
 */
export function composeSessionTools(
  permissionProfile: PermissionProfile,
  mcpToolNames: readonly string[],
  extensionToolNames: readonly (readonly string[])[],
): string[] | undefined {
  const reserved = new Set([...PROFILE_TOOLS.coding, ...PROFILE_TOOLS["read-only"], ...mcpToolNames]);
  const extensionTools: string[] = [];
  for (const names of extensionToolNames) {
    for (const name of names) {
      if (!EXTENSION_TOOL_NAME.test(name) || reserved.has(name)) return undefined;
      reserved.add(name);
      extensionTools.push(name);
    }
  }
  return [...PROFILE_TOOLS[permissionProfile], ...mcpToolNames, ...(permissionProfile === "coding" ? extensionTools : [])];
}

import { createHash } from "node:crypto";
import { join } from "node:path";

/** Pure wrapper rendering and hashing; safe to import from operator CLIs. */
export function renderWrapper(nodePath: string, releaseRoot: string, name: string): string {
  const quote = (value: string) => {
    if (value.includes("'")) throw new Error("writer_wrapper_invalid");
    return `'${value}'`;
  };
  return `#!/bin/sh\n# stdout is reserved for MCP frames.\nexec ${quote(nodePath)} ${quote(join(releaseRoot, "dist", "writer-launch.js"))} ${quote(name)} "$@"\n`;
}

export function wrapperDigest(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

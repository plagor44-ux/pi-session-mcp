import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Whether the module at `importMetaUrl` is the script that Node started. npm
 * installs `bin` entries as symlinks, so the comparison uses real paths.
 */
export function isEntryPoint(importMetaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  try { return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(argv1); }
  catch { return false; }
}

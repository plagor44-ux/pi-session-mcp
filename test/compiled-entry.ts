import { execFile } from "node:child_process";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { temporaryRoot } from "./temporary-roots.js";

const REPOSITORY = fileURLToPath(new URL("..", import.meta.url));
const execFileAsync = promisify(execFile);

/**
 * Compiles the current sources into a temporary directory and returns the built `main.js`.
 * CI runs the tests before `npm run build`, so an existing `dist/` may be stale.
 */
export async function compileServerEntry(): Promise<string> {
  const root = await temporaryRoot("pi-session-mcp-entry-build-");
  // The compiled entry imports `../package.json` and the installed packages.
  await symlink(join(REPOSITORY, "package.json"), join(root, "package.json"));
  await symlink(join(REPOSITORY, "node_modules"), join(root, "node_modules"), "dir");
  await execFileAsync(process.execPath, [
    join(REPOSITORY, "node_modules", "typescript", "bin", "tsc"),
    "-p", join(REPOSITORY, "tsconfig.build.json"), "--outDir", join(root, "out"), "--declaration", "false",
  ], { cwd: REPOSITORY, timeout: 120_000 });
  return join(root, "out", "main.js");
}

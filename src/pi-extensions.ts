import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { PiExtensionError, type ExtensionSpec } from "./extension-spec.js";

export interface PiExtensionResolverDependencies {
  /** Pi's agent directory; defaults to the SDK's `getAgentDir()`. */
  readonly agentDir?: string;
  /** Locates Pi's user-scope install of an npm source; the default only computes the path. */
  readonly installedPath?: (source: string, agentDir: string) => string | undefined;
  readonly readFile?: (path: string) => Promise<string>;
  readonly realpath?: (path: string) => Promise<string>;
  readonly stat?: (path: string) => Promise<{ isFile(): boolean }>;
}

// The SDK has no side-effect-free lookup: `resolve()` runs `npm install`, and `getInstalledPath`
// falls back to a synchronous `npm root -g` on a miss and accepts global installs made outside Pi.
// So this only computes where Pi puts user-scope npm packages; a missing directory means not installed.
function installedPathFromPi(source: string, agentDir: string): string | undefined {
  return join(agentDir, "npm", "node_modules", source.slice("npm:".length));
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

/**
 * Resolves a pinned extension to the real directory of Pi's installed package.
 * It never installs, never imports extension code and never reports a path.
 */
export async function resolvePiExtension(extension: ExtensionSpec, dependencies: PiExtensionResolverDependencies = {}): Promise<string> {
  const agentDir = dependencies.agentDir ?? getAgentDir();
  const read = dependencies.readFile ?? ((path: string) => readFile(path, "utf8"));
  const real = dependencies.realpath ?? realpath;
  const statFile = dependencies.stat ?? stat;
  let installed: string | undefined;
  try { installed = (dependencies.installedPath ?? installedPathFromPi)(`npm:${extension.name}`, agentDir); }
  catch { throw new PiExtensionError("extension_load_failed"); }
  if (installed === undefined) throw new PiExtensionError("extension_not_installed");
  let root: string;
  let manifest: unknown;
  try {
    root = await real(installed);
    manifest = JSON.parse((await read(join(root, "package.json"))).replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new PiExtensionError(isMissing(error) ? "extension_not_installed" : "extension_load_failed");
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) throw new PiExtensionError("extension_load_failed");
  const { version, pi } = manifest as { version?: unknown; pi?: { extensions?: unknown } };
  if (version !== extension.version) throw new PiExtensionError("extension_version_mismatch");
  const entries = pi?.extensions;
  if (!Array.isArray(entries) || entries.length === 0
    || !entries.every((entry) => typeof entry === "string" && entry.length > 0 && !isAbsolute(entry))) {
    throw new PiExtensionError("extension_load_failed");
  }
  for (const entry of entries as string[]) {
    let target: string;
    try {
      target = await real(join(root, entry));
      if (!inside(root, target) || !(await statFile(target)).isFile()) throw new PiExtensionError("extension_load_failed");
    } catch { throw new PiExtensionError("extension_load_failed"); }
  }
  return root;
}

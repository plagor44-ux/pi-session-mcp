import packageMetadata from "../package.json" with { type: "json" };
import { join } from "node:path";

export const PACKAGE_NAME = packageMetadata.name;
export const PACKAGE_VERSION = packageMetadata.version;
export const PACKAGE_NODE_ENGINE = packageMetadata.engines.node;

export interface LoadedPackageMetadata {
  readonly version: string;
  readonly engines: { readonly node?: string };
  /** Absent in an npm installation: npm never ships a lockfile inside a package. */
  readonly lockVersion?: string;
}

type ReadFile = (path: string, encoding: "utf8") => Promise<string>;

export function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

/** The lockfile text of a Git checkout, or undefined for an npm installation. Other read errors propagate. */
export async function readLockfile(packageRoot: string, readFile: ReadFile): Promise<string | undefined> {
  try { return await readFile(join(packageRoot, "package-lock.json"), "utf8"); }
  catch (error) { if (isMissingFile(error)) return undefined; throw error; }
}

/** Read the package and lock metadata using the same shape as production. */
export async function readPackageMetadata(packageRoot: string, readFile: ReadFile): Promise<LoadedPackageMetadata> {
  const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    readonly version?: unknown;
    readonly engines?: { readonly node?: unknown };
  };
  const lockText = await readLockfile(packageRoot, readFile);
  const lock = lockText === undefined ? undefined : JSON.parse(lockText) as {
    readonly packages?: { readonly ""?: { readonly version?: unknown } };
  };
  const engines = packageJson.engines?.node;
  const lockVersion = lock?.packages?.[""]?.version;
  return {
    version: packageJson.version as string,
    engines: engines === undefined ? {} : { node: engines as string },
    ...(lockVersion === undefined ? {} : { lockVersion: lockVersion as string }),
  };
}

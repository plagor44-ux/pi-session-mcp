import packageMetadata from "../package.json" with { type: "json" };
import { join } from "node:path";

export const PACKAGE_NAME = packageMetadata.name;
export const PACKAGE_VERSION = packageMetadata.version;
export const PACKAGE_NODE_ENGINE = packageMetadata.engines.node;

export interface LoadedPackageMetadata {
  readonly version: string;
  readonly engines: { readonly node?: string };
  readonly lockVersion?: string;
}

/** Read the package and lock metadata using the same shape as production. */
export async function readPackageMetadata(
  packageRoot: string,
  readFile: (path: string, encoding: "utf8") => Promise<string>,
): Promise<LoadedPackageMetadata> {
  const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    readonly version?: unknown;
    readonly engines?: { readonly node?: unknown };
  };
  const lock = JSON.parse(await readFile(join(packageRoot, "package-lock.json"), "utf8")) as {
    readonly packages?: { readonly ""?: { readonly version?: unknown } };
  };
  const engines = packageJson.engines?.node;
  const lockVersion = lock.packages?.[""]?.version;
  return {
    version: packageJson.version as string,
    engines: engines === undefined ? {} : { node: engines as string },
    ...(lockVersion === undefined ? {} : { lockVersion: lockVersion as string }),
  };
}

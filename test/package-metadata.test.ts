import { describe, expect, it } from "vitest";
import { readPackageMetadata } from "../src/package-metadata.js";

function readerFor(files: Readonly<Record<string, string>>) {
  return async (path: string): Promise<string> => {
    const name = path.split("/").pop() ?? path;
    const content = files[name];
    if (content === undefined) { const error = new Error(`missing ${name}`) as NodeJS.ErrnoException; error.code = "ENOENT"; throw error; }
    return content;
  };
}

const manifest = JSON.stringify({ version: "1.2.3", engines: { node: ">=22.19.0" } });

describe("package metadata", () => {
  it("reads the lock version from package-lock.json", async () => {
    const metadata = await readPackageMetadata("/root", readerFor({ "package.json": manifest, "package-lock.json": JSON.stringify({ packages: { "": { version: "1.2.3" } } }) }));
    expect(metadata).toEqual({ version: "1.2.3", engines: { node: ">=22.19.0" }, lockVersion: "1.2.3" });
  });

  it("reports no lock version when package-lock.json is absent, as in an npm installation", async () => {
    // npm never ships a lockfile inside a package, so an installed copy has only package.json.
    const metadata = await readPackageMetadata("/root", readerFor({ "package.json": manifest }));
    expect(metadata).toEqual({ version: "1.2.3", engines: { node: ">=22.19.0" } });
  });

  it("still fails on a lockfile that cannot be read for another reason", async () => {
    const reader = async (path: string): Promise<string> => {
      if (path.endsWith("package.json")) return manifest;
      const error = new Error("denied") as NodeJS.ErrnoException; error.code = "EACCES"; throw error;
    };
    await expect(readPackageMetadata("/root", reader)).rejects.toThrow("denied");
  });
});

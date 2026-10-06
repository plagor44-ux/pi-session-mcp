import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { isEntryPoint } from "../src/entry-point.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

describe("entry point detection", () => {
  it("recognizes the module when it is started through a bin symlink, as npm installs it", async () => {
    const root = await temporaryRoot("pi-session-mcp-entry-");
    await mkdir(join(root, "bin"));
    const real = join(root, "main.js");
    await writeFile(real, "export {};\n");
    const link = join(root, "bin", "pi-session-mcp");
    await symlink(real, link);
    expect(isEntryPoint(pathToFileURL(real).href, link)).toBe(true);
    expect(isEntryPoint(pathToFileURL(real).href, real)).toBe(true);
  });

  it("stays false for another file, a missing file and a missing argument", async () => {
    const root = await temporaryRoot("pi-session-mcp-entry-");
    const real = join(root, "main.js"); const other = join(root, "other.js");
    await writeFile(real, "export {};\n"); await writeFile(other, "export {};\n");
    expect(isEntryPoint(pathToFileURL(real).href, other)).toBe(false);
    expect(isEntryPoint(pathToFileURL(real).href, join(root, "missing.js"))).toBe(false);
    expect(isEntryPoint(pathToFileURL(real).href, undefined)).toBe(false);
  });
});

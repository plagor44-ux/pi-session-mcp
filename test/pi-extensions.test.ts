import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseExtensionSpec } from "../src/extension-spec.js";
import { resolvePiExtension } from "../src/pi-extensions.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

const extension = parseExtensionSpec("npm:fixture-ext@1.2.3")!;

async function installed(manifest: unknown, files: Record<string, string> = { "index.js": "export default () => {};\n" }) {
  const root = await temporaryRoot("pi-session-mcp-extension-");
  const dir = join(root, "npm", "node_modules", "fixture-ext");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return { root, dir };
}

const at = (dir: string | undefined) => ({ agentDir: "/unused-agent-dir", installedPath: vi.fn((_source: string, _agentDir: string) => dir) });
const valid = { name: "fixture-ext", version: "1.2.3", pi: { extensions: ["./index.js"] } };

describe("resolvePiExtension", () => {
  it("returns the real package directory for the pinned version", async () => {
    const { dir } = await installed(valid);
    const dependencies = at(dir);
    await expect(resolvePiExtension(extension, dependencies)).resolves.toBe(await realpath(dir));
    expect(dependencies.installedPath).toHaveBeenCalledWith("npm:fixture-ext", "/unused-agent-dir");
  });

  it("finds Pi's user install through the package manager without resolving or installing", async () => {
    const { root, dir } = await installed(valid);
    const resolve = vi.spyOn(DefaultPackageManager.prototype, "resolve");
    await expect(resolvePiExtension(extension, { agentDir: root })).resolves.toBe(await realpath(dir));
    expect(resolve).not.toHaveBeenCalled();
    resolve.mockRestore();
  });

  it("reports a package Pi has not installed", async () => {
    await expect(resolvePiExtension(extension, at(undefined))).rejects.toMatchObject({ name: "PiExtensionError", code: "extension_not_installed" });
  });

  it("reports an installed directory without a manifest as not installed", async () => {
    const root = await temporaryRoot("pi-session-mcp-extension-");
    await expect(resolvePiExtension(extension, at(root))).rejects.toMatchObject({ code: "extension_not_installed" });
  });

  it("reports another installed version", async () => {
    const { dir } = await installed({ ...valid, version: "1.2.4" });
    await expect(resolvePiExtension(extension, at(dir))).rejects.toMatchObject({ code: "extension_version_mismatch" });
  });

  it.each([
    ["invalid JSON", "{"],
    ["a non-object manifest", "null"],
    ["no pi.extensions", { name: "fixture-ext", version: "1.2.3" }],
    ["an empty pi.extensions", { ...valid, pi: { extensions: [] } }],
    ["an absolute entry", { ...valid, pi: { extensions: ["/etc/passwd"] } }],
    ["a missing entry file", { ...valid, pi: { extensions: ["./missing.js"] } }],
    ["an entry outside the package", { ...valid, pi: { extensions: ["../outside.js"] } }],
  ])("rejects %s as a load failure", async (_label, manifest) => {
    const { root, dir } = await installed(manifest);
    await writeFile(join(root, "npm", "node_modules", "outside.js"), "export default () => {};\n");
    const error = await resolvePiExtension(extension, at(dir)).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "PiExtensionError", code: "extension_load_failed" });
    expect(String((error as Error).message)).not.toContain(root);
  });

  it("rejects an entry symlink that leaves the package", async () => {
    const { root, dir } = await installed({ ...valid, pi: { extensions: ["./link.js"] } });
    const outside = join(root, "outside.js");
    await writeFile(outside, "export default () => {};\n");
    await symlink(outside, join(dir, "link.js"));
    await expect(resolvePiExtension(extension, at(dir))).rejects.toMatchObject({ code: "extension_load_failed" });
  });
});

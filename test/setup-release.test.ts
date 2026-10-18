import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PACKAGE_VERSION } from "../src/package-metadata.js";
import { immutableReleaseBinding, registrationFingerprint } from "../src/setup.js";

const temporaryRoots: string[] = [];

async function releaseFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-session-mcp-release-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "dist", "nested"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ version: PACKAGE_VERSION, engines: { node: ">=22.19.0" } }));
  await writeFile(join(root, "package-lock.json"), JSON.stringify({ packages: { "": { version: PACKAGE_VERSION } } }));
  await writeFile(join(root, "dist", "main.js"), "export const main = true;\n");
  await writeFile(join(root, "dist", "setup-command-guardian.js"), "export const guardian = true;\n");
  await writeFile(join(root, "dist", "setup-platform.js"), "export const platform = true;\n");
  await writeFile(join(root, "dist", "writer-launch.js"), "export const launcher = true;\n");
  await writeFile(join(root, "dist", "nested", "runtime.js"), "export const runtime = 1;\n");
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("immutable setup release binding", () => {
  it("packs both provider-free isolation scripts", () => {
    const report = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] })) as { files: { path: string }[] }[] | Record<string, { files: { path: string }[] }>;
    const entry = Array.isArray(report) ? report[0]! : Object.values(report)[0]!;
    expect(entry.files.map(({ path }) => path)).toEqual(expect.arrayContaining(["scripts/isolation-acceptance.mjs", "scripts/isolation-probe.cjs"]));
  }, 120_000);
  it("changes when any built runtime module changes", async () => {
    const root = await releaseFixture();
    const before = await immutableReleaseBinding(root);
    await writeFile(join(root, "dist", "nested", "runtime.js"), "export const runtime = 2;\n");
    expect(await immutableReleaseBinding(root)).not.toBe(before);
  });

  it("binds an npm installation that has no lockfile", async () => {
    const root = await releaseFixture();
    await rm(join(root, "package-lock.json"));
    const binding = await immutableReleaseBinding(root);
    expect(binding).toMatch(/^[0-9a-f]{64}$/);
    await writeFile(join(root, "dist", "nested", "runtime.js"), "export const runtime = 2;\n");
    expect(await immutableReleaseBinding(root)).not.toBe(binding);
  });

  it("fails closed when package and lock versions differ", async () => {
    const root = await releaseFixture();
    await writeFile(join(root, "package-lock.json"), JSON.stringify({ packages: { "": { version: "0.2.0" } } }));
    await expect(immutableReleaseBinding(root)).rejects.toThrow("release_version_mismatch");
  });

  it("requires a regular non-symlink guardian in the immutable runtime", async () => {
    const missing = await releaseFixture();
    await rm(join(missing, "dist", "setup-command-guardian.js"));
    await expect(immutableReleaseBinding(missing)).rejects.toThrow("release_entry_missing");
    const linked = await releaseFixture();
    await rm(join(linked, "dist", "setup-command-guardian.js"));
    await symlink("main.js", join(linked, "dist", "setup-command-guardian.js"));
    await expect(immutableReleaseBinding(linked)).rejects.toThrow("release_symlink_invalid");
  });

  it("requires a regular non-symlink platform module in the immutable runtime", async () => {
    const missing = await releaseFixture();
    await rm(join(missing, "dist", "setup-platform.js"));
    await expect(immutableReleaseBinding(missing)).rejects.toThrow("release_entry_missing");
    const linked = await releaseFixture();
    await rm(join(linked, "dist", "setup-platform.js"));
    await symlink("main.js", join(linked, "dist", "setup-platform.js"));
    await expect(immutableReleaseBinding(linked)).rejects.toThrow("release_symlink_invalid");
  });

  it("requires a regular non-symlink writer launcher in the immutable runtime", async () => {
    const missing = await releaseFixture();
    await rm(join(missing, "dist", "writer-launch.js"));
    await expect(immutableReleaseBinding(missing)).rejects.toThrow("release_entry_missing");
    const linked = await releaseFixture();
    await rm(join(linked, "dist", "writer-launch.js"));
    await symlink("main.js", join(linked, "dist", "writer-launch.js"));
    await expect(immutableReleaseBinding(linked)).rejects.toThrow("release_symlink_invalid");
  });

  it("includes the release binding in ownership fingerprints", () => {
    const intent = { scope: "user" as const, nodePath: "/node", entryPath: "/main.js", configPath: "/config.json" };
    expect(registrationFingerprint(intent, "release-a")).not.toBe(registrationFingerprint(intent, "release-b"));
  });
});

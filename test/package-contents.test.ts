/**
 * The npm package ships operator documentation but not development artifacts.
 *
 * `npm pack --dry-run` lists what `package.json#files` selects without building or
 * writing a tarball, so this checks the real packing rules instead of the field's text.
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const REPOSITORY = fileURLToPath(new URL("..", import.meta.url));
const execFileAsync = promisify(execFile);

interface PackEntry { readonly files: ReadonlyArray<{ readonly path: string }> }

async function packedPaths(): Promise<string[]> {
  const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: REPOSITORY, timeout: 60_000 });
  const parsed = JSON.parse(stdout) as PackEntry[] | Record<string, PackEntry>;
  // npm 10 prints an array of packages; npm 11 and later key them by package name.
  const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  if (!entry) throw new Error("npm pack listed no package");
  return entry.files.map((file) => file.path);
}

describe("package contents", () => {
  it("ships the operator documentation and the worker skills without implementation plans, sources or tests", async () => {
    const paths = await packedPaths();
    expect(paths).toEqual(expect.arrayContaining([
      "README.md", "CHANGELOG.md", "docs/installation.md", "docs/tool-contracts.md", "docs/adr/0006-pi-extension-allowlist.md",
    ]));
    expect(paths).toEqual(expect.arrayContaining([
      "skills/pi-session-orchestration/SKILL.md", "skills/pi-session-orchestration/references/start-errors.md", "skills/pi-session-implementation/SKILL.md", "skills/pi-session-review/SKILL.md",
    ]));
    expect(paths.filter((path) => path.startsWith("docs/superpowers/"))).toEqual([]);
    expect(paths.filter((path) => path.startsWith("src/") || path.startsWith("test/") || path === "package-lock.json")).toEqual([]);
  }, 90_000);
});

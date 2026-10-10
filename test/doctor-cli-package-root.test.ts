/**
 * Process-level evidence that the Doctor CLI evaluates the package it was loaded
 * from, not the current working directory.
 *
 * The suite compiles the current Doctor CLI sources into a temporary package laid
 * out like an npm installation: the checked-in bootstrap, the generated CLI, the
 * manifest and a build output, without a lockfile, TypeScript sources or build
 * configuration. CI runs the tests before `npm run build:cli`, so an existing
 * `.pi-session-mcp-cli/` may be stale. The bootstrap is copied, not linked:
 * Node resolves a linked entry point to its real path, which would load the
 * repository's generated CLI instead.
 */
import { execFile } from "node:child_process";
import { copyFile, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PACKAGE_VERSION } from "../src/package-metadata.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

const REPOSITORY = fileURLToPath(new URL("..", import.meta.url));
const execFileAsync = promisify(execFile);

interface DoctorRun { code: number | null; report: { ok: boolean; packageVersion?: string; checks: { id: string; severity: string }[] }; stdout: string }

let root = "";
let bootstrap = "";
let config = "";

beforeAll(async () => {
  root = await temporaryRoot("pi-session-mcp-doctor-root-");
  const installed = join(root, "installed");
  await mkdir(join(installed, "scripts"), { recursive: true });
  await mkdir(join(installed, "dist"));
  // The generated CLI imports `../package.json` and the installed packages.
  await symlink(join(REPOSITORY, "package.json"), join(installed, "package.json"));
  await symlink(join(REPOSITORY, "node_modules"), join(installed, "node_modules"), "dir");
  await copyFile(join(REPOSITORY, "scripts", "doctor.mjs"), join(installed, "scripts", "doctor.mjs"));
  await writeFile(join(installed, "dist", "main.js"), "// build output placeholder\n");
  await execFileAsync(process.execPath, [
    join(REPOSITORY, "node_modules", "typescript", "bin", "tsc"),
    "-p", join(REPOSITORY, "tsconfig.cli.json"), "--outDir", join(installed, ".pi-session-mcp-cli"),
  ], { cwd: REPOSITORY, timeout: 120_000 });
  bootstrap = join(installed, "scripts", "doctor.mjs");

  await mkdir(join(root, "workspace"));
  config = join(root, "config.json");
  await writeFile(config, JSON.stringify({
    workspaces: { project: join(root, "workspace") },
    executionProfiles: { safe: { default: true, permissionProfile: "read-only", provider: "fixture", model: "fixture-model", thinkingLevel: "off" } },
  }));
}, 150_000);

afterAll(removeTemporaryRoots);

async function runDoctorFrom(cwd: string): Promise<DoctorRun> {
  const result = await execFileAsync(process.execPath, [bootstrap, "--json"], {
    cwd, env: { PATH: process.env.PATH ?? "", HOME: root, PI_SESSION_MCP_CONFIG: config }, timeout: 10_000, killSignal: "SIGKILL",
  }).then(({ stdout }) => ({ code: 0, stdout }), (error: { code?: number | null; stdout?: string }) => ({ code: error.code ?? null, stdout: error.stdout ?? "" }));
  return { ...result, report: JSON.parse(result.stdout) as DoctorRun["report"] };
}

describe("Doctor CLI package root", () => {
  it("checks its own installed package from an unrelated working directory", async () => {
    const neutral = join(root, "neutral");
    await mkdir(neutral);

    const run = await runDoctorFrom(neutral);

    expect(run.report.checks.filter((check) => check.severity !== "ok")).toEqual([]);
    expect(run.report.packageVersion).toBe(PACKAGE_VERSION);
    expect(run.code).toBe(0);
    expect(run.stdout).not.toContain(root);
  }, 30_000);

  it("ignores another package in the working directory", async () => {
    const other = join(root, "other");
    await mkdir(other);
    await writeFile(join(other, "package.json"), JSON.stringify({ name: "other", version: "9.9.9", engines: { node: ">=22.19.0" } }));

    const run = await runDoctorFrom(other);

    expect(run.report.packageVersion).toBe(PACKAGE_VERSION);
    expect(run.report.checks.filter((check) => check.severity !== "ok")).toEqual([]);
    expect(run.code).toBe(0);
  }, 30_000);
});

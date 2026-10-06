import { access, readFile, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { loadConfig, type AppConfig } from "./config.js";
import { readPackageMetadata } from "./package-metadata.js";

export type DoctorSeverity = "ok" | "warning" | "error";
export type DoctorExitCode = 0 | 1 | 2 | 64;
export type DoctorCheckId =
  | "node_version_unsupported" | "package_metadata_unreadable" | "build_missing"
  | "build_stale" | "version_mismatch" | "config_missing" | "config_unreadable" | "config_invalid"
  | "workspace_missing" | "workspace_not_directory" | "workspace_unreadable"
  | "workspace_not_writable";

export interface DoctorCheck {
  readonly id: DoctorCheckId;
  readonly severity: DoctorSeverity;
  readonly subject: string;
  readonly remediation?: string;
}

export interface DoctorResult {
  readonly schemaVersion: 1;
  readonly ok: boolean;
  readonly packageVersion?: string;
  readonly checks: readonly DoctorCheck[];
  readonly exitCode: Exclude<DoctorExitCode, 64>;
}

export interface DoctorPackageMetadata { readonly version: string; readonly engines?: { readonly node?: string }; readonly lockVersion?: string; readonly expectedVersion?: string; }
export interface DoctorFileSystem {
  readonly readFile: (path: string, encoding: "utf8") => Promise<string>;
  readonly stat: (path: string) => Promise<{ readonly isDirectory: () => boolean; readonly isFile: () => boolean; readonly mtimeMs?: number }>;
  readonly access: (path: string, mode: number) => Promise<void>;
}
export interface DoctorDependencies {
  readonly packageRoot?: string;
  readonly nodeVersion?: string;
  readonly fileSystem?: DoctorFileSystem;
  readonly loadConfig?: () => Promise<AppConfig>;
  readonly packageMetadata?: () => Promise<DoctorPackageMetadata>;
}

const defaultFileSystem: DoctorFileSystem = { readFile, stat, access };
const CHECK_ORDER: readonly DoctorCheckId[] = ["node_version_unsupported", "package_metadata_unreadable", "build_missing", "build_stale", "version_mismatch", "config_missing", "config_unreadable", "config_invalid", "workspace_missing", "workspace_not_directory", "workspace_unreadable", "workspace_not_writable"];

function failure(id: DoctorCheckId, subject: string, remediation: string): DoctorCheck { return Object.freeze({ id, severity: "error", subject, remediation }); }
function warning(id: DoctorCheckId, subject: string, remediation: string): DoctorCheck { return Object.freeze({ id, severity: "warning", subject, remediation }); }
function ok(id: DoctorCheckId, subject: string): DoctorCheck { return Object.freeze({ id, severity: "ok", subject }); }
function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && ["ENOENT", "config_path_required"].includes(String((error as { code?: unknown }).code)); }
/** The lockfile's modification time, or undefined for an npm installation, which has no lockfile. */
async function lockfileMtime(fs: DoctorFileSystem, root: string): Promise<number | undefined> {
  try { return (await fs.stat(join(root, "package-lock.json"))).mtimeMs; }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
}
function isUnreadable(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && ["EACCES", "EPERM"].includes(String((error as { code?: unknown }).code)); }
function isSemver(value: string): boolean { return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value); }

function satisfiesNode(version: string, range: string): boolean {
  const minimum = range.match(/>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  const actual = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!minimum || !actual) return false;
  const want: [number, number, number] = [Number(minimum[1]), Number(minimum[2] ?? 0), Number(minimum[3] ?? 0)];
  const got: [number, number, number] = [Number(actual[1]), Number(actual[2]), Number(actual[3])];
  return got[0] > want[0] || (got[0] === want[0] && (got[1] > want[1] || (got[1] === want[1] && got[2] >= want[2])));
}

/** Build inputs beyond the manifests. An installed package has none of them, which is not staleness. */
async function productionBuildInputMtimes(root: string): Promise<number[]> {
  const mtimes: number[] = [];
  for (const name of ["tsconfig.json", "tsconfig.build.json"] as const) {
    try { mtimes.push((await stat(join(root, name))).mtimeMs); }
    catch (error) { if (!isMissing(error)) throw error; }
  }
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".ts")) mtimes.push((await stat(path)).mtimeMs);
    }
  };
  try { await visit(join(root, "src")); }
  catch (error) { if (!isMissing(error)) throw error; }
  return mtimes;
}

export async function runDoctor(dependencies: DoctorDependencies = {}): Promise<DoctorResult> {
  const fs = dependencies.fileSystem ?? defaultFileSystem;
  const root = dependencies.packageRoot ?? process.cwd();
  const checks: DoctorCheck[] = [];
  let metadata: DoctorPackageMetadata | undefined;
  try {
    const injected = dependencies.packageMetadata !== undefined;
    if (dependencies.packageMetadata) metadata = await dependencies.packageMetadata();
    else {
      metadata = await readPackageMetadata(root, fs.readFile);
    }
    if (!metadata || !isSemver(metadata.version) || typeof metadata.engines?.node !== "string" || !/>=\s*\d+/.test(metadata.engines.node)) throw new Error("invalid package metadata");
    if (!injected && metadata.lockVersion !== undefined && !isSemver(metadata.lockVersion)) throw new Error("invalid lock metadata");
  } catch {
    checks.push(failure("package_metadata_unreadable", "package metadata", "repair package metadata"));
  }
  const nodeRange = metadata?.engines?.node;
  if (nodeRange && !satisfiesNode(dependencies.nodeVersion ?? process.versions.node, nodeRange)) checks.push(failure("node_version_unsupported", "Node.js", "use a supported Node.js version"));
  else if (nodeRange) checks.push(ok("node_version_unsupported", "Node.js"));
  let buildMtime: number | undefined;
  try {
    const build = await fs.stat(join(root, "dist", "main.js"));
    if (build.isFile()) { buildMtime = build.mtimeMs; checks.push(ok("build_missing", "build output")); }
    else checks.push(failure("build_missing", "build output", "run the production build"));
  }
  catch (error) { checks.push(failure("build_missing", "build output", isMissing(error) ? "run the production build" : "check build output access")); }
  if (buildMtime !== undefined) {
    try {
      const packageMtime = (await fs.stat(join(root, "package.json"))).mtimeMs;
      const lockMtime = await lockfileMtime(fs, root);
      const inputMtimes = [packageMtime, lockMtime].filter((value): value is number => value !== undefined);
      if (!dependencies.fileSystem) inputMtimes.push(...await productionBuildInputMtimes(root));
      if (inputMtimes.some((mtime) => mtime > buildMtime)) checks.push(warning("build_stale", "build output", "run the production build"));
      else checks.push(ok("build_stale", "build output"));
    } catch { checks.push(warning("build_stale", "build output", "rebuild to establish current build state")); }
  }
  if (metadata) {
    const expectedVersion = metadata.expectedVersion ?? metadata.lockVersion;
    if (expectedVersion && metadata.version !== expectedVersion) checks.push(warning("version_mismatch", "package version", "reinstall matching build artifacts"));
    else checks.push(ok("version_mismatch", "package version"));
  }
  let config: AppConfig | undefined;
  try { config = await (dependencies.loadConfig ?? (() => loadConfig()))(); checks.push(ok("config_invalid", "configuration")); }
  catch (error) {
    if (isMissing(error)) checks.push(failure("config_missing", "configuration", "create PI_SESSION_MCP_CONFIG configuration"));
    else if (isUnreadable(error)) checks.push(failure("config_unreadable", "configuration", "grant configuration read access"));
    else checks.push(failure("config_invalid", "configuration", "fix configuration using the documented schema"));
  }
  if (config) {
    for (const [alias, path] of [...config.workspaces].sort(([a], [b]) => a.localeCompare(b))) {
      try {
        const info = await fs.stat(path);
        if (!info.isDirectory()) checks.push(failure("workspace_not_directory", alias, "point the workspace alias to a directory"));
        else {
          checks.push(ok("workspace_not_directory", alias));
          try { await fs.access(path, constants.R_OK); checks.push(ok("workspace_unreadable", alias)); }
          catch { checks.push(failure("workspace_unreadable", alias, "grant workspace read access")); }
          const canWrite = [...config.executionProfiles.values()].some((profile) => profile.permissionProfile === "coding");
          if (canWrite) { try { await fs.access(path, constants.W_OK); checks.push(ok("workspace_not_writable", alias)); } catch { checks.push(failure("workspace_not_writable", alias, "grant coding workspace write access")); } }
        }
      } catch (error) { checks.push(failure(isMissing(error) ? "workspace_missing" : "workspace_unreadable", alias, isMissing(error) ? "fix the workspace alias target" : "grant workspace access")); }
    }
  }
  const rank = new Map(CHECK_ORDER.map((id, index) => [id, index]));
  checks.sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999) || a.subject.localeCompare(b.subject));
  const hasError = checks.some((check) => check.severity === "error");
  const result: DoctorResult = { schemaVersion: 1, ok: !hasError, ...(metadata ? { packageVersion: metadata.version } : {}), checks: Object.freeze(checks), exitCode: hasError ? 2 : checks.some((check) => check.severity === "warning") ? 1 : 0 };
  return Object.freeze(result);
}

export function renderDoctorJson(result: DoctorResult): string { return JSON.stringify(result) + "\n"; }
export function renderDoctorHuman(result: DoctorResult): string { return result.checks.map((check) => `${check.severity.toUpperCase()} ${check.id} [${check.subject}]${check.remediation ? `: ${check.remediation}` : ""}`).join("\n") + "\n"; }

export function parseDoctorArgs(args: readonly string[]): { json: boolean } | undefined { return args.length === 0 ? { json: false } : args.length === 1 && args[0] === "--json" ? { json: true } : undefined; }

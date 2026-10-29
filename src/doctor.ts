import { access, lstat, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createProcessRunner } from "./setup-process.js";
import { probeSandbox, resolveWorktreeGitDir } from "./sandbox-shell.js";
import { podmanInfo, isSafeRefName } from "./writer-boundary.js";
import { containedBuiltinSkills, containedProfileRefused } from "./writer-lifecycle.js";
import { readWriterState, writerAcceptanceCurrent, writerName, writerPaths, type WriterState } from "./writer-state.js";
import { LEASE_DIRECTORY } from "./writer-lease.js";
import { ConfigError, loadConfig, type AppConfig } from "./config.js";
import { containerRuntimeUsable } from "./container-runtime.js";
import { PiExtensionError, type ExtensionSpec } from "./extension-spec.js";
import { readPackageMetadata } from "./package-metadata.js";
import { claimsRoot, eventsRoot } from "./turn-events.js";
import { MAX_SKILL_FILE_BYTES } from "./skill-catalog.js";
import { readSkillBases, SkillBasesError } from "./skill-customize.js";
import { LEGACY_SKILL_TREE_FINGERPRINT_PATTERN, readSkillTree, releasedSkillFingerprint, shippedSkillsDirectory, type ReleasedSkillTree } from "./skill-library.js";

export type DoctorSeverity = "ok" | "warning" | "error";
export type DoctorExitCode = 0 | 1 | 2 | 64;
export type DoctorCheckId =
  | "node_version_unsupported" | "package_metadata_unreadable" | "build_missing"
  | "build_stale" | "version_mismatch" | "config_missing" | "config_unreadable" | "config_invalid" | "skill_controller_selected"
  | "workspace_missing" | "workspace_not_directory" | "workspace_unreadable"
  | "workspace_not_writable" | "workspace_gitfile"
  | "workspace_mode_unset" | "workspace_base_unset" | "workspace_host_writes_accepted" | "container_runtime_unavailable"
  | "container_profile_refused" | "writer_lease_directory" | "writer_not_ready" | "writer_not_migrated" | "writer_off_default_base"
  | "writer_dirty" | "writer_git_identity_missing" | "writer_uncollected_bundle"
  | "extension_missing" | "extension_version_mismatch" | "extension_unpinned"
  | "skill_missing" | "skill_unreadable" | "skill_duplicate" | "skill_override_outdated"
  | "sandbox_unavailable" | "workspace_git_unavailable"
  | "event_spool_root";

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
  readonly stat: (path: string) => Promise<{ readonly isDirectory: () => boolean; readonly isFile: () => boolean; readonly mtimeMs?: number; readonly size?: number }>;
  readonly access: (path: string, mode: number) => Promise<void>;
  /** Canonical path; defaults to the real file system when an injected fake omits it. */
  readonly realpath?: (path: string) => Promise<string>;
  /** Metadata without following a final symbolic link; defaults to the real file system when omitted. */
  readonly lstat?: (path: string) => Promise<{ readonly isFile: () => boolean; readonly isSymbolicLink: () => boolean; readonly size?: number }>;
  /** At most `maxBytes` of a regular file's start, never following a symbolic link; defaults to the real file system when omitted. */
  readonly readPrefix?: (path: string, maxBytes: number) => Promise<string>;
}
export interface DoctorDependencies {
  readonly home?: string;
  /** Pi's agent directory; defaults to the SDK's `getAgentDir()`. */
  readonly agentDir?: string;
  readonly writerRuntime?: () => Promise<{ podmanVersion?: string; imageExists: (id: string) => Promise<boolean> }>;
  readonly packageRoot?: string;
  readonly nodeVersion?: string;
  readonly fileSystem?: DoctorFileSystem;
  /** Explicit configuration path, otherwise captured once from PI_SESSION_MCP_CONFIG. */
  readonly configPath?: string;
  readonly loadConfig?: (path?: string) => Promise<AppConfig>;
  /** Original configuration, before skill resolution; read only for selected container profiles. */
  readonly loadRawConfig?: () => Promise<unknown>;
  readonly packageMetadata?: () => Promise<DoctorPackageMetadata>;
  /** Offline rootless Podman probe; called only when a workspace uses container mode. */
  readonly containerRuntime?: () => Promise<boolean>;
  /** Reads the installed manifest of a pinned extension; never imports extension code. */
  readonly resolveExtension?: (extension: ExtensionSpec) => Promise<string>;
  /** Reference trees that resolve legacy skill bases; defaults to the released shipped skills. */
  readonly releasedSkillTrees?: readonly ReleasedSkillTree[];
  /** Environment for the event spool check; defaults to the process environment. */
  readonly env?: NodeJS.ProcessEnv;
  /** Metadata of the spool root without following a final symbolic link, `undefined` when absent; used only when event delivery is enabled. */
  readonly eventSpoolRoot?: (path: string) => Promise<EventSpoolRootInfo | undefined>;
  /** Metadata of the writer lease directory without following a final symbolic link, `undefined` when absent. */
  readonly writerLeaseRoot?: (path: string) => Promise<EventSpoolRootInfo | undefined>;
  /** Effective user id of the current process; defaults to the real one. */
  readonly uid?: number;
  /** Probes the read-only shell sandbox with the session's fixed arguments for one workspace; called only when a profile selects it. */
  readonly sandboxProbe?: (workspace: string) => Promise<boolean>;
  /** The main Git directory of a linked worktree workspace, or `undefined` when the pointer is unusable. */
  readonly worktreeGitDir?: (workspace: string) => Promise<string | undefined>;
}
export interface EventSpoolRootInfo { readonly isDirectory: boolean; readonly uid: number; readonly mode: number }

/** Largest `.git` file Doctor inspects; a real gitfile is one short line. */
const MAX_GITFILE_BYTES = 4096;
/** Reads at most `maxBytes` from a regular file; a final symbolic link or a non-regular file is rejected. */
async function readPrefix(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("not a regular file");
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
}

const defaultFileSystem: DoctorFileSystem = { readFile, stat, access };
const CHECK_ORDER: readonly DoctorCheckId[] = ["node_version_unsupported", "package_metadata_unreadable", "build_missing", "build_stale", "version_mismatch", "config_missing", "config_unreadable", "config_invalid", "skill_controller_selected", "workspace_missing", "workspace_not_directory", "workspace_unreadable", "workspace_not_writable", "workspace_gitfile", "workspace_mode_unset", "workspace_base_unset", "workspace_host_writes_accepted", "container_runtime_unavailable", "container_profile_refused", "writer_lease_directory", "writer_not_ready", "writer_not_migrated", "writer_off_default_base", "writer_dirty", "writer_git_identity_missing", "writer_uncollected_bundle", "extension_missing", "extension_version_mismatch", "extension_unpinned", "skill_missing", "skill_unreadable", "skill_duplicate", "skill_override_outdated", "sandbox_unavailable", "workspace_git_unavailable", "event_spool_root"];

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

/**
 * Compares the shipped skills with the fingerprints recorded when the operator copied them.
 * Reads only the bases file and the shipped files, takes no lock and writes nothing: the bases
 * file is replaced atomically, so a read sees either the old or the new content.
 */
async function skillOverrideChecks(overrideDirectory: string | undefined, shippedDirectory: string, released: readonly ReleasedSkillTree[] | undefined): Promise<DoctorCheck[]> {
  if (overrideDirectory === undefined) return [];
  let bases: Readonly<Record<string, string>>;
  try { bases = await readSkillBases(overrideDirectory); }
  catch (error) {
    if (error instanceof SkillBasesError) return [warning("skill_override_outdated", "skill:bases", "repair or remove the skill bases file")];
    throw error;
  }
  const checks: DoctorCheck[] = [];
  for (const [name, base] of Object.entries(bases).sort(([a], [b]) => a.localeCompare(b))) {
    let fingerprint: string;
    try { fingerprint = (await readSkillTree(join(shippedDirectory, name))).fingerprint; }
    catch { continue; }
    const command = `pi-session-mcp-setup --apply --customize-skill ${name}`;
    // A legacy base is meaningful only as the version 2 value of the released original it names.
    const recorded = LEGACY_SKILL_TREE_FINGERPRINT_PATTERN.test(base) ? releasedSkillFingerprint(name, base, released) : base;
    if (recorded === undefined) checks.push(warning("skill_override_outdated", `skill:${name}`, `the recorded base predates version 2 fingerprints and cannot be confirmed; review the shipped skill, then run ${command}`));
    else checks.push(recorded === fingerprint
      ? ok("skill_override_outdated", `skill:${name}`)
      : warning("skill_override_outdated", `skill:${name}`, `review the changed shipped skill, then run ${command}`));
  }
  return checks;
}

/**
 * True when `<workspace>/.git` is a regular file whose content starts with a `gitdir:` pointer.
 * A gitfile does not prove a linked worktree: submodules and `git init --separate-git-dir` use
 * one too, and telling them apart would need the pointer target, which is never followed.
 * A symbolic link, an absent or unreadable entry, an oversized file, or any other content is not
 * a match, so no error here can fail Doctor.
 */
async function hasGitfilePointer(fs: DoctorFileSystem, workspace: string): Promise<boolean> {
  const entry = join(workspace, ".git");
  try {
    const info = await (fs.lstat ?? lstat)(entry);
    if (info.isSymbolicLink() || !info.isFile() || (info.size ?? 0) > MAX_GITFILE_BYTES) return false;
    // One byte more than the cap proves the file grew after the size check.
    const content = await (fs.readPrefix ?? readPrefix)(entry, MAX_GITFILE_BYTES + 1);
    return Buffer.byteLength(content, "utf8") <= MAX_GITFILE_BYTES && /^gitdir:[ \t]*\S/.test(content);
  } catch { return false; }
}

/** The trusted bubblewrap binary plus a probe run through the session's fixed arguments for the workspace, its worktree Git directory included. */
const defaultSandboxProbe = (workspace: string): Promise<boolean> => probeSandbox(workspace);

async function defaultRootInfo(path: string): Promise<EventSpoolRootInfo | undefined> {
  try {
    const info = await lstat(path);
    return { isDirectory: info.isDirectory(), uid: info.uid, mode: info.mode };
  } catch (error) { if (isMissing(error)) return undefined; throw error; }
}

/**
 * Offline check of the host-only writer lease directory. A missing directory is fine because the
 * first lease creates it. An existing entry must be a real directory of the current user with mode
 * 0700: the rule `acquireWriterLease` applies before it opens a lease file. Nothing is created,
 * repaired or read, and no path or lease file name appears in the report.
 */
async function writerLeaseCheck(home: string, probe: (path: string) => Promise<EventSpoolRootInfo | undefined>, uid: number | undefined): Promise<DoctorCheck | undefined> {
  let info: EventSpoolRootInfo | undefined;
  try { info = await probe(join(home, ...LEASE_DIRECTORY)); }
  catch { return failure("writer_lease_directory", "writer lease", "grant access to the writer lease directory"); }
  if (info === undefined) return undefined;
  // Lease files must keep their inodes: a moved or recreated directory would let a second holder in.
  if (!info.isDirectory) return failure("writer_lease_directory", "writer lease", "close every writer session and setup run, then replace the entry with a private directory owned by the current user");
  if ((uid !== undefined && info.uid !== uid) || (info.mode & 0o7777) !== 0o700) {
    return failure("writer_lease_directory", "writer lease", "repair the lease directory in place (owner and chmod 700); never move or delete it or its lock files");
  }
  return ok("writer_lease_directory", "writer lease");
}

/**
 * Offline check of the event spool's runtime directories, run only when event delivery is enabled.
 * Nothing is created or repaired, and no path appears in the report. A missing runtime directory
 * variable is a warning because Doctor may run in a different environment than the server.
 * The `pi-session-mcp` entry, its `events` root and its `claims` directory, when present, must be
 * real directories of the current user without group or other access: the rule that
 * `TurnEventSpool.open` applies to the events root and the wake hook to the claims directory.
 * An absent entry is fine because the server creates it, so Doctor cannot be green where startup
 * fails with `event_spool_unavailable` for these directories.
 */
async function eventSpoolCheck(env: NodeJS.ProcessEnv, probe: (path: string) => Promise<EventSpoolRootInfo | undefined>, uid: number | undefined): Promise<DoctorCheck> {
  const events = eventsRoot(env);
  if (events === undefined) return warning("event_spool_root", "event spool", "without an absolute XDG_RUNTIME_DIR in the server environment, delivery stays inactive: set it, or disable events.delivery");
  const runtime = dirname(events);
  const entries: ReadonlyArray<readonly [string, string]> = [[runtime, "pi-session-mcp runtime"], [events, "events"], [claimsRoot(env) ?? join(runtime, "claims"), "claims"]];
  for (const [path, label] of entries) {
    let info: EventSpoolRootInfo | undefined;
    try { info = await probe(path); }
    catch { return failure("event_spool_root", "event spool", `grant access to the ${label} directory`); }
    if (info === undefined) { if (path === runtime) break; continue; }
    if (!info.isDirectory) return failure("event_spool_root", "event spool", `replace the ${label} entry with a private directory owned by the current user`);
    if (uid !== undefined && info.uid !== uid) return failure("event_spool_root", "event spool", `the ${label} directory must be owned by the current user`);
    if ((info.mode & 0o077) !== 0) return failure("event_spool_root", "event spool", `remove group and other permissions from the ${label} directory (chmod 700)`);
  }
  return ok("event_spool_root", "event spool");
}

async function defaultWriterRuntime() {
  const runner = createProcessRunner();
  const info = await podmanInfo(runner);
  return { ...(info.version ? { podmanVersion: info.version } : {}), imageExists: async (id: string) => {
    try { return (await runner.run("podman", ["image", "exists", id], AbortSignal.timeout(10_000))).exitCode === 0; }
    catch { return false; }
  } };
}

async function writerGitIdentity(clone: string): Promise<boolean> {
  try {
    const handle = await open(join(clone, ".git", "config"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 65_536) return false;
      const buffer = Buffer.alloc(65_536);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if ((await handle.stat()).size > 65_536) return false;
      let user = false, name = false, email = false;
      for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n")) {
        const section = /^\s*\[([^\]]+)\]/.exec(line);
        if (section) { user = section[1]!.trim().toLowerCase() === "user"; continue; }
        if (!user) continue;
        const key = /^\s*(name|email)\s*=\s*(.*?)\s*$/i.exec(line);
        if (!key || !key[2] || /^(?:""|[#;])/.test(key[2])) continue;
        if (key[1]!.toLowerCase() === "name") name = true;
        else email = true;
      }
      return name && email;
    } finally { await handle.close(); }
  } catch { return false; }
}

async function writerDirty(clone: string, state: WriterState): Promise<boolean> {
  try {
    const git = join(clone, ".git");
    if (!(await lstat(clone)).isDirectory() || !(await lstat(git)).isDirectory()) return true;
    const bounded = async (path: string) => {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > 65_536) throw new Error("unsafe metadata");
        const buffer = Buffer.alloc(65_536);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if ((await handle.stat()).size > 65_536) throw new Error("oversized metadata");
        return buffer.subarray(0, bytesRead).toString("utf8");
      } finally { await handle.close(); }
    };
    if (!isSafeRefName(state.base.ref) || !state.base.ref.startsWith("refs/heads/")) return true;
    if ((await bounded(join(git, "HEAD"))).trim() !== `ref: ${state.base.ref}`) return true;
    const refs = new Map<string, string>();
    try {
      for (const line of (await bounded(join(git, "packed-refs"))).split("\n")) {
        if (!line || line.startsWith("#") || line.startsWith("^")) continue;
        const match = /^([0-9a-f]{40}|[0-9a-f]{64}) (refs\/\S+)$/.exec(line);
        if (!match) return true;
        if (match[2]!.startsWith("refs/heads/")) refs.set(match[2]!, match[1]!);
      }
    } catch (error) { if (!isMissing(error)) throw error; }
    const walk = async (path: string, ref: string, depth = 0): Promise<void> => {
      if (depth > 64 || !(await lstat(path)).isDirectory()) throw new Error("unsafe refs");
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const child = join(path, entry.name), name = `${ref}/${entry.name}`;
        if (entry.isDirectory()) await walk(child, name, depth + 1);
        else if (entry.isFile()) refs.set(name, (await bounded(child)).trim());
        else throw new Error("unsafe ref");
      }
    };
    if (!(await lstat(join(git, "refs"))).isDirectory()) return true;
    try { await walk(join(git, "refs/heads"), "refs/heads"); }
    catch (error) { if (!isMissing(error)) throw error; }
    return refs.size !== 1 || refs.get(state.base.ref) !== state.base.commit;
  } catch { return true; }
}

export async function runDoctor(dependencies: DoctorDependencies = {}): Promise<DoctorResult> {
  const fs = dependencies.fileSystem ?? defaultFileSystem;
  const root = dependencies.packageRoot ?? process.cwd();
  const home = dependencies.home ?? homedir();
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
      if (!dependencies.fileSystem) {
        const buildInputMtimes = await productionBuildInputMtimes(root);
        // npm writes an installed package at extraction time in archive order, so without
        // build inputs the manifest times say nothing about the freshness of the build.
        if (buildInputMtimes.length === 0) inputMtimes.length = 0;
        else inputMtimes.push(...buildInputMtimes);
      }
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
  const configPath = dependencies.configPath ?? process.env.PI_SESSION_MCP_CONFIG;
  try { config = await (dependencies.loadConfig ?? loadConfig)(configPath); checks.push(ok("config_invalid", "configuration")); }
  catch (error) {
    if (isMissing(error)) checks.push(failure("config_missing", "configuration", "create PI_SESSION_MCP_CONFIG configuration"));
    else if (isUnreadable(error)) checks.push(failure("config_unreadable", "configuration", "grant configuration read access"));
    else {
      // Locations name the offending field; an error without one, or at the root, keeps the plain subject.
      const locations = error instanceof ConfigError ? error.locations : [];
      const controller = new Set((error instanceof ConfigError ? error.controllerSkills : []).map((skillAlias) => `skillCatalog.${skillAlias}`));
      for (const location of locations.length ? locations : [""]) {
        const subject = location ? `configuration:${location}` : "configuration";
        checks.push(controller.has(location)
          ? failure("skill_controller_selected", subject, "remove this skillCatalog entry: controller skills are for the controlling agent, not for Pi workers")
          : failure("config_invalid", subject, "fix configuration using the documented schema"));
      }
    }
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
          if (canWrite) {
            if (await hasGitfilePointer(fs, path)) checks.push(warning("workspace_gitfile", alias, "the workspace has a gitfile pointer (possible linked worktree or Git metadata stored outside the workspace); hooks and config may be shared with another repository, so give coding workers a separate full clone"));
            else checks.push(ok("workspace_gitfile", alias));
          }
        }
      } catch (error) { checks.push(failure(isMissing(error) ? "workspace_missing" : "workspace_unreadable", alias, isMissing(error) ? "fix the workspace alias target" : "grant workspace access")); }
    }
  }
  if (config) {
    const canWrite = [...config.executionProfiles.values()].some((profile) => profile.permissionProfile === "coding");
    let runtimeUsable: boolean | undefined;
    for (const alias of [...config.workspaces.keys()].sort((a, b) => a.localeCompare(b))) {
      const mode = config.workspaceModes.get(alias)?.mode ?? "unset";
      if (mode === "unset" && canWrite) checks.push(warning("workspace_mode_unset", alias, "choose an explicit execution mode for the workspace"));
      else if (mode === "host") checks.push(ok("workspace_host_writes_accepted", alias));
      else if (mode === "container") {
        runtimeUsable ??= await (dependencies.containerRuntime ?? containerRuntimeUsable)();
        checks.push(runtimeUsable
          ? ok("container_runtime_unavailable", alias)
          : failure("container_runtime_unavailable", alias, "make rootless Podman available or choose a different execution mode"));
      }
    }
  }
  if (config) {
    let runtime: Awaited<ReturnType<typeof defaultWriterRuntime>> | undefined;
    let rawConfig: unknown, rawConfigLoaded = false, rawConfigReadable = false;
    let availableBuiltinSkills: ReadonlySet<string> = new Set();
    const offDefaultBase = new Map<string, number>();
    for (const [alias, entry] of config.workspaceModes) {
      if (entry.mode !== "container" || !entry.container) continue;
      checks.push(entry.container.base === undefined
        ? warning("workspace_base_unset", alias, `record the workspace default base with pi-session-mcp-setup --repo ${alias} --base <branch> --apply`)
        : ok("workspace_base_unset", alias));
      if (!rawConfigLoaded) {
        rawConfigLoaded = true;
        try {
          rawConfig = await (dependencies.loadRawConfig ?? (async () => {
            if (!configPath) throw new Error("configuration path unavailable");
            return JSON.parse(await fs.readFile(configPath, "utf8")) as unknown;
          }))();
          availableBuiltinSkills = containedBuiltinSkills(rawConfig, config.skillOverrideDirectory);
          rawConfigReadable = true;
        } catch { /* An unavailable raw configuration cannot establish profile acceptance. */ }
      }
      if (!rawConfigReadable) {
        checks.push(failure("container_profile_refused", alias, "selected profiles could not be checked; restore configuration read access and rerun Doctor"));
      } else {
        const refused = entry.container.profiles.filter((profile) => containedProfileRefused(rawConfig, profile, availableBuiltinSkills));
        for (const profile of refused) checks.push(failure("container_profile_refused", `${alias}:${profile}`, "use a non-default coding profile without extensions or MCP grants and with only shipped, non-overridden builtin skills, or drop it from the repository's profiles"));
        if (refused.length === 0) checks.push(ok("container_profile_refused", alias));
      }
      for (let index = 1; index <= entry.container.writers; index++) {
        const name = writerName(alias, index), paths = writerPaths(home, name);
        const remediation = `run pi-session-mcp-setup --repo ${alias} --apply, or --writer ${name} --recreate --apply`;
        let state: WriterState | undefined, ready = false;
        try {
          state = await readWriterState(home, name);
          if (state?.phase === "ready" && state.acceptance) {
            runtime ??= await (dependencies.writerRuntime ?? defaultWriterRuntime)();
            ready = await writerAcceptanceCurrent(paths.wrapper, state, runtime);
          }
        } catch { /* Unreadable state or runtime is not ready. */ }
        checks.push(ready ? ok("writer_not_ready", name) : failure("writer_not_ready", name, remediation));
        if (!state) continue;
        checks.push(state.launch === "relay" ? ok("writer_not_migrated", name)
          : warning("writer_not_migrated", name, `run pi-session-mcp-setup --repo ${alias} --apply to migrate the writer to the relay`));
        if (entry.container.base !== undefined && ready && state.base.ref !== `refs/heads/${entry.container.base}`) {
          offDefaultBase.set(alias, (offDefaultBase.get(alias) ?? 0) + 1);
        }
        checks.push(await writerDirty(paths.clone, state)
          ? warning("writer_dirty", name, "collect writer work before resetting or recreating the writer") : ok("writer_dirty", name));
        let bundles = false;
        try {
          if (!(await lstat(paths.bundles)).isDirectory()) bundles = true;
          else bundles = (await readdir(paths.bundles)).some((file) => file !== "base.bundle");
        } catch (error) { bundles = !isMissing(error); }
        checks.push(await writerGitIdentity(paths.clone) ? ok("writer_git_identity_missing", name)
          : warning("writer_git_identity_missing", name, "set user.name and user.email in the operator checkout, then reset the writer"));
        checks.push(bundles ? warning("writer_uncollected_bundle", name, "collect or review outstanding writer bundles") : ok("writer_uncollected_bundle", name));
      }
    }
    for (const [alias, entry] of config.workspaceModes) {
      if (entry.mode !== "container" || !entry.container || entry.container.base === undefined) continue;
      const count = offDefaultBase.get(alias) ?? 0;
      checks.push(count === 0 ? ok("writer_off_default_base", alias)
        : warning("writer_off_default_base", alias, `${count} ${count === 1 ? "writer is" : "writers are"} off the workspace default base; finish each with pi-session-mcp-setup --writer <name> --finish --apply once its work is collected`));
    }
  }
  if (config) {
    // This advisory check needs positive evidence, like the gitfile check: unreadable or
    // malformed optional settings are ignored, while installed-manifest checks still run.
    const unpinned = new Set<string>();
    if ([...config.executionProfiles.values()].some((profile) => profile.extensions?.length)) {
      try {
        // Load the SDK only here, like the extension resolver, so a broken install cannot stop Doctor from loading.
        const agentDir = dependencies.agentDir ?? (await import("@earendil-works/pi-coding-agent")).getAgentDir();
        const settings: unknown = JSON.parse((await fs.readFile(join(agentDir, "settings.json"), "utf8")).replace(/^\uFEFF/, ""));
        if (typeof settings === "object" && settings !== null && "packages" in settings && Array.isArray(settings.packages)) {
          for (const entry of settings.packages) {
            const source: unknown = typeof entry === "object" && entry !== null && "source" in entry ? entry.source : entry;
            if (typeof source === "string") unpinned.add(source);
          }
        }
      } catch { /* Optional settings cannot establish an unpinned entry. */ }
    }
    const resolveExtension = dependencies.resolveExtension
      ?? (async (extension: ExtensionSpec) => (await import("./pi-extensions.js")).resolvePiExtension(extension));
    for (const [alias, profile] of [...config.executionProfiles].sort(([a], [b]) => a.localeCompare(b))) {
      for (const extension of profile.extensions ?? []) {
        const subject = `${alias}:${extension.name}`;
        if (unpinned.has(`npm:${extension.name}`)) checks.push(warning("extension_unpinned", subject, `pin it with pi install npm:${extension.name}@${extension.version}`));
        try {
          await resolveExtension(extension);
          checks.push(ok("extension_missing", subject), ok("extension_version_mismatch", subject));
        } catch (error) {
          const code = error instanceof PiExtensionError ? error.code : "extension_load_failed";
          if (code === "extension_not_installed") checks.push(failure("extension_missing", subject, "install the pinned extension version with Pi"));
          else checks.push(ok("extension_missing", subject), failure("extension_version_mismatch", subject, "install the pinned extension version with Pi"));
        }
      }
    }
  }
  if (config) {
    for (const [alias, profile] of [...config.executionProfiles].sort(([a], [b]) => a.localeCompare(b))) {
      const canonical = new Set<string>();
      for (const skill of profile.skills ?? []) {
        const subject = `${alias}:${skill.alias}`;
        let real: string;
        try {
          const info = await fs.stat(skill.path);
          if (!info.isFile() || (info.size ?? 0) > MAX_SKILL_FILE_BYTES) throw new Error("unusable skill file");
          await fs.access(skill.path, constants.R_OK);
          real = await (fs.realpath ?? realpath)(skill.path);
        } catch (error) {
          if (isMissing(error)) checks.push(failure("skill_missing", subject, "create the skill file or fix its skillCatalog entry"));
          else checks.push(ok("skill_missing", subject), failure("skill_unreadable", subject, "point the skillCatalog entry to a readable SKILL.md within the size limit"));
          continue;
        }
        checks.push(ok("skill_missing", subject), ok("skill_unreadable", subject));
        if (canonical.has(real)) checks.push(failure("skill_duplicate", subject, "select each skill file only once per profile"));
        else { canonical.add(real); checks.push(ok("skill_duplicate", subject)); }
      }
    }
  }
  if (config) {
    const sandboxed = [...config.executionProfiles].filter(([, profile]) => profile.shell === "sandboxed").map(([alias]) => alias).sort((a, b) => a.localeCompare(b));
    if (sandboxed.length > 0) {
      // The overlay depends on the workspace's filesystem, so each existing workspace directory is probed.
      for (const [alias, path] of [...config.workspaces].sort(([a], [b]) => a.localeCompare(b))) {
        try { if (!(await fs.stat(path)).isDirectory()) continue; } catch { continue; }
        let usable = false;
        try { usable = await (dependencies.sandboxProbe ?? defaultSandboxProbe)(path); } catch { usable = false; }
        checks.push(usable
          ? ok("sandbox_unavailable", alias)
          : failure("sandbox_unavailable", alias, "install a bubblewrap with --overlay-src, --tmp-overlay and --disable-userns support at /usr/bin/bwrap (root-owned, not group- or world-writable) and allow unprivileged user namespaces, and keep the workspace on a filesystem that can be an overlay lower layer; see docs/installation.md"));
      }
      // Without a usable worktree pointer Git commands fail inside the sandbox; the read tools are unaffected.
      for (const [alias, path] of [...config.workspaces].sort(([a], [b]) => a.localeCompare(b))) {
        if (!(await hasGitfilePointer(fs, path))) continue;
        let gitDir: string | undefined;
        try { gitDir = await (dependencies.worktreeGitDir ?? resolveWorktreeGitDir)(path); } catch { gitDir = undefined; }
        checks.push(gitDir === undefined
          ? warning("workspace_git_unavailable", alias, "the workspace's gitfile does not point to a linked worktree whose main Git directory is intact, so Git commands fail inside the shell sandbox")
          : ok("workspace_git_unavailable", alias));
      }
    }
  }
  if (config?.eventDelivery === "spool") checks.push(await eventSpoolCheck(dependencies.env ?? process.env, dependencies.eventSpoolRoot ?? defaultRootInfo, dependencies.uid ?? process.getuid?.()));
  const lease = await writerLeaseCheck(home, dependencies.writerLeaseRoot ?? defaultRootInfo, dependencies.uid ?? process.getuid?.());
  if (lease) checks.push(lease);
  if (config) checks.push(...await skillOverrideChecks(config.skillOverrideDirectory, shippedSkillsDirectory(dependencies.packageRoot), dependencies.releasedSkillTrees));
  const rank = new Map(CHECK_ORDER.map((id, index) => [id, index]));
  checks.sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999) || a.subject.localeCompare(b.subject));
  const hasError = checks.some((check) => check.severity === "error");
  const result: DoctorResult = { schemaVersion: 1, ok: !hasError, ...(metadata ? { packageVersion: metadata.version } : {}), checks: Object.freeze(checks), exitCode: hasError ? 2 : checks.some((check) => check.severity === "warning") ? 1 : 0 };
  return Object.freeze(result);
}

export function renderDoctorJson(result: DoctorResult): string { return JSON.stringify(result) + "\n"; }
export function renderDoctorHuman(result: DoctorResult): string { return result.checks.map((check) => `${check.severity.toUpperCase()} ${check.id} [${check.subject}]${check.remediation ? `: ${check.remediation}` : ""}`).join("\n") + "\n"; }

export function parseDoctorArgs(args: readonly string[]): { json: boolean } | undefined { return args.length === 0 ? { json: false } : args.length === 1 && args[0] === "--json" ? { json: true } : undefined; }

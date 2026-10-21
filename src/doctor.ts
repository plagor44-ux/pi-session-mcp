import { access, lstat, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createProcessRunner } from "./setup-process.js";
import { podmanInfo, isSafeRefName } from "./writer-boundary.js";
import { currentAcceptanceFingerprint, readWriterState, writerName, writerPaths, type WriterState } from "./writer-state.js";
import { loadConfig, type AppConfig } from "./config.js";
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
  | "build_stale" | "version_mismatch" | "config_missing" | "config_unreadable" | "config_invalid"
  | "workspace_missing" | "workspace_not_directory" | "workspace_unreadable"
  | "workspace_not_writable" | "workspace_gitfile"
  | "workspace_mode_unset" | "workspace_host_writes_accepted" | "container_runtime_unavailable"
  | "writer_not_ready" | "writer_dirty" | "writer_uncollected_bundle"
  | "extension_missing" | "extension_version_mismatch"
  | "skill_missing" | "skill_unreadable" | "skill_duplicate" | "skill_override_outdated"
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
  readonly writerRuntime?: () => Promise<{ podmanVersion?: string; imageExists: (id: string) => Promise<boolean> }>;
  readonly packageRoot?: string;
  readonly nodeVersion?: string;
  readonly fileSystem?: DoctorFileSystem;
  readonly loadConfig?: () => Promise<AppConfig>;
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
  /** Effective user id of the current process; defaults to the real one. */
  readonly uid?: number;
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
const CHECK_ORDER: readonly DoctorCheckId[] = ["node_version_unsupported", "package_metadata_unreadable", "build_missing", "build_stale", "version_mismatch", "config_missing", "config_unreadable", "config_invalid", "workspace_missing", "workspace_not_directory", "workspace_unreadable", "workspace_not_writable", "workspace_gitfile", "workspace_mode_unset", "workspace_host_writes_accepted", "container_runtime_unavailable", "writer_not_ready", "writer_dirty", "writer_uncollected_bundle", "extension_missing", "extension_version_mismatch", "skill_missing", "skill_unreadable", "skill_duplicate", "skill_override_outdated", "event_spool_root"];

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

async function defaultEventSpoolRoot(path: string): Promise<EventSpoolRootInfo | undefined> {
  try {
    const info = await lstat(path);
    return { isDirectory: info.isDirectory(), uid: info.uid, mode: info.mode };
  } catch (error) { if (isMissing(error)) return undefined; throw error; }
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
  if (events === undefined) return warning("event_spool_root", "event spool", "set XDG_RUNTIME_DIR to an absolute path in the server environment, or disable events.delivery");
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
    for (const [alias, entry] of config.workspaceModes) {
      if (entry.mode !== "container" || !entry.container) continue;
      for (let index = 1; index <= entry.container.writers; index++) {
        const name = writerName(alias, index), home = dependencies.home ?? homedir(), paths = writerPaths(home, name);
        const remediation = `run pi-session-mcp-setup --repo ${alias} --apply, or --writer ${name} --recreate --apply`;
        let state: WriterState | undefined, ready = false;
        try {
          state = await readWriterState(home, name);
          if (state?.phase === "ready" && state.acceptance) {
            runtime ??= await (dependencies.writerRuntime ?? defaultWriterRuntime)();
            ready = !!runtime.podmanVersion && state.acceptance.fingerprint === await currentAcceptanceFingerprint(paths.wrapper, state, runtime.podmanVersion)
              && await runtime.imageExists(state.imageId);
          }
        } catch { /* Unreadable state or runtime is not ready. */ }
        checks.push(ready ? ok("writer_not_ready", name) : failure("writer_not_ready", name, remediation));
        if (!state) continue;
        checks.push(await writerDirty(paths.clone, state)
          ? warning("writer_dirty", name, "collect writer work before resetting or recreating the writer") : ok("writer_dirty", name));
        let bundles = false;
        try {
          if (!(await lstat(paths.bundles)).isDirectory()) bundles = true;
          else bundles = (await readdir(paths.bundles)).some((file) => file !== "base.bundle");
        } catch (error) { bundles = !isMissing(error); }
        checks.push(bundles ? warning("writer_uncollected_bundle", name, "collect or review outstanding writer bundles") : ok("writer_uncollected_bundle", name));
      }
    }
  }
  if (config) {
    const resolveExtension = dependencies.resolveExtension
      ?? (async (extension: ExtensionSpec) => (await import("./pi-extensions.js")).resolvePiExtension(extension));
    for (const [alias, profile] of [...config.executionProfiles].sort(([a], [b]) => a.localeCompare(b))) {
      for (const extension of profile.extensions ?? []) {
        const subject = `${alias}:${extension.name}`;
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
  if (config?.eventDelivery === "spool") checks.push(await eventSpoolCheck(dependencies.env ?? process.env, dependencies.eventSpoolRoot ?? defaultEventSpoolRoot, dependencies.uid ?? process.getuid?.()));
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

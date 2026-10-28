import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, opendir, readdir, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { DEFAULT_COMMAND_TIMEOUT_MS } from "./client-adapters/command.js";
import type { CommandResult, CommandRunner } from "./client-adapters/types.js";
import { CONTAINER_EVENTS_DIR, EVENTS_DIR_ENV, writerEventsDir } from "./turn-events.js";
import { writerContainerName, writerLabel } from "./writer-fence.js";
import { writerPaths, type WriterState } from "./writer-state.js";

export const NODE_IMAGE_REF = "docker.io/library/node@sha256:c4d5523090a817b7aa86d2111241fdd4f66d1e27782b44160e6aa63b357ecb2d";
export const IMAGE_PULL_TIMEOUT_MS = 900_000;
export const BOUNDARY_GIT = "git -c safe.directory=* -c core.fsmonitor=false -c core.hooksPath=/dev/null";

type WriterPaths = ReturnType<typeof writerPaths>;

export class BoundaryError extends Error {
  constructor(readonly code: "image_unavailable" | "clone_verification_failed" | "writer_fenced") {
    super(code);
    this.name = "BoundaryError";
  }
}

/** `eventsDir` is the dedicated host spool directory of this writer; pass it only when event delivery is enabled for the writer. */
export function serveArgs(paths: WriterPaths, state: WriterState, command: readonly string[], releaseRoot: string, eventsDir?: string, options?: { name?: string }): string[] {
  const args = [
    "run", "-i", "--rm", "--pull=never", "--userns=keep-id", "--read-only",
    "--cap-drop=all", "--security-opt=no-new-privileges", `--network=${state.network}`,
    "--label", writerLabel(options?.name ?? basename(paths.root)),
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m",
    "--tmpfs", "/pi/home:rw,nosuid,nodev,mode=0700,size=64m,U",
    "-v", `${paths.clone}:${paths.clone}:rw`,
    "-v", `${paths.clone}/.git/hooks:${paths.clone}/.git/hooks:ro`,
    "-v", `${paths.clone}/.git/config:${paths.clone}/.git/config:ro`,
    "-v", `${releaseRoot}:/opt/pi-session-mcp:ro`,
    "-v", `${paths.config}:/pi/config:ro`,
    "-v", `${paths.agent}:/pi/agent:rw`,
    "--workdir", paths.clone,
    "-e", "HOME=/pi/home",
    "-e", "PI_SESSION_MCP_CONFIG=/pi/config/pi-session-mcp.json",
    "-e", "PI_CODING_AGENT_DIR=/pi/agent",
    "-e", "PI_SESSION_MCP_WRITER_GUARD=/pi/config/writer-guard.json",
  ];
  if (options?.name !== undefined) args.push("--name", writerContainerName(options.name));
  if (eventsDir !== undefined) args.push(
    "-v", `${eventsDir}:${CONTAINER_EVENTS_DIR}:rw`,
    "-e", `${EVENTS_DIR_ENV}=${CONTAINER_EVENTS_DIR}`,
  );
  if (state.cache === "go") args.push(
    "-v", `${paths.go}:/pi/go:rw`,
    "-e", "GOPATH=/pi/go", "-e", "GOCACHE=/pi/go/cache", "-e", "GOTOOLCHAIN=local",
  );
  if (state.cache === "uv") args.push(
    "-v", `${paths.uv}:/pi/uv:rw`,
    "-e", "UV_CACHE_DIR=/pi/uv/cache", "-e", "npm_config_cache=/pi/uv/npm",
  );
  return [...args, state.imageId, ...command];
}

export class EventsDirectoryError extends Error {
  readonly code = "events_directory_unavailable";
  constructor() {
    super("events_directory_unavailable");
    this.name = "EventsDirectoryError";
  }
}

/** Upper bound of entries a launch deletes from the writer's own spool directory; more means the directory is refused. */
export const EVENTS_CLEANUP_MAX_ENTRIES = 10_000;
const EVENTS_CLEANUP_MAX_DEPTH = 8;
/** Event files and temporary files of a server instance younger than this are never removed at launch. */
export const EVENTS_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const INSTANCE_DIRECTORY = /^inst-[0-9a-f]{16}$/;

const NO_FOLLOW_DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
// Linux O_PATH (0o10000000). Node's `constants` does not declare it; writers are Linux-only.
const O_PATH = 0o10000000;
const PROC_FD = "/proc/self/fd";

/**
 * Test seam for the race windows of the cleanup: called with the logical path of an entry after it was listed
 * and inspected and before it is opened or removed (`"inspected"`), and before an emptied directory is removed
 * (`"emptied"`). A test uses it to swap the entry for a symlink, which the cleanup must not follow.
 */
export type EventsCleanupSeam = (stage: "inspected" | "emptied", logicalPath: string) => Promise<void> | void;

interface Walk { uid: number; budget: { left: number }; cutoff: number; seam: EventsCleanupSeam | undefined }

/**
 * The cleanup runs in a directory that a worker of the same user can change concurrently, for example while
 * another container of the same writer is still running. Every directory is therefore held as an open file
 * descriptor and all children are reached through `/proc/self/fd/<fd>/<name>`, which resolves relative to the
 * already opened directory and never through a path a worker could swap for a link.
 */
const fdPath = (handle: FileHandle): string => `${PROC_FD}/${handle.fd}`;

/**
 * Opens a real directory (never through a link), requires `uid` as owner and resets its mode to 0700. The inode
 * is first pinned with an `O_PATH` descriptor, so even a directory the worker stripped to 0000 can be changed
 * without following a link; `chmod` on the descriptor's magic link applies to that inode. The directory is then
 * reopened for reading and must be the same inode.
 */
async function openPrivateDirectory(path: string, uid: number): Promise<FileHandle> {
  const pin = await open(path, O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let pinned;
  try {
    pinned = await pin.stat();
    if (!pinned.isDirectory() || pinned.uid !== uid) throw new EventsDirectoryError();
    if ((pinned.mode & 0o777) !== 0o700) await chmod(fdPath(pin), 0o700);
  } finally { await pin.close(); }
  const handle = await open(path, NO_FOLLOW_DIRECTORY);
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory() || stat.uid !== uid || stat.ino !== pinned.ino || stat.dev !== pinned.dev || (stat.mode & 0o777) !== 0o700) throw new EventsDirectoryError();
  } catch (error) { await handle.close().catch(() => {}); throw error; }
  return handle;
}

async function listNames(directory: FileHandle, budget: { left: number }): Promise<string[]> {
  const names: string[] = [];
  const handle = await opendir(fdPath(directory));
  try {
    for await (const entry of handle) {
      if (--budget.left < 0) throw new EventsDirectoryError();
      names.push(entry.name);
    }
  } catch (error) { await handle.close().catch(() => {}); throw error; }
  return names;
}

/** Removes everything below `directory`; links are unlinked, never followed. */
async function clearDirectory(directory: FileHandle, logical: string, walk: Walk, depth: number): Promise<void> {
  if (depth > EVENTS_CLEANUP_MAX_DEPTH) throw new EventsDirectoryError();
  for (const name of await listNames(directory, walk.budget)) await removeEntry(directory, logical, name, walk, depth + 1);
}

async function removeEntry(parent: FileHandle, logicalParent: string, name: string, walk: Walk, depth: number): Promise<void> {
  const path = `${fdPath(parent)}/${name}`, logical = join(logicalParent, name);
  const stat = await lstat(path);
  await walk.seam?.("inspected", logical);
  if (stat.isDirectory()) {
    if (stat.uid !== walk.uid) throw new EventsDirectoryError();
    const directory = await openPrivateDirectory(path, walk.uid);
    try {
      await clearDirectory(directory, logical, walk, depth);
      await walk.seam?.("emptied", logical);
    } finally { await directory.close(); }
    await rmdir(path);
  } else await unlink(path);
}

/**
 * A server instance directory may belong to a live server of the same writer, so it is never removed while
 * it could be in use: only entries older than the stale age go, and the directory goes only when it is then
 * empty and itself has not changed within that age.
 */
async function sweepInstance(parent: FileHandle, logicalParent: string, name: string, before: { mtimeMs: number }, walk: Walk): Promise<void> {
  const path = `${fdPath(parent)}/${name}`, logical = join(logicalParent, name);
  const directory = await openPrivateDirectory(path, walk.uid);
  let kept = 0;
  try {
    for (const entry of await listNames(directory, walk.budget)) {
      const stat = await lstat(`${fdPath(directory)}/${entry}`);
      // A live server only creates event and temporary files; fresh entries of any kind are kept, old ones go by age alone.
      if (stat.mtimeMs >= walk.cutoff) { kept++; continue; }
      await removeEntry(directory, logical, entry, walk, 2);
    }
    if (kept === 0 && before.mtimeMs < walk.cutoff) await walk.seam?.("emptied", logical);
  } finally { await directory.close(); }
  if (kept === 0 && before.mtimeMs < walk.cutoff) {
    try { await rmdir(path); } catch (error) {
      if (!(error instanceof Error && "code" in error && (error.code === "ENOTEMPTY" || error.code === "ENOENT"))) throw error;
    }
  }
}

/** Launch-time cleanup of the writer's own spool directory; see `ensureWriterEventsDirectory`. */
async function sweepWriterDirectory(directory: FileHandle, logical: string, walk: Walk): Promise<void> {
  for (const name of await listNames(directory, walk.budget)) {
    const stat = await lstat(`${fdPath(directory)}/${name}`);
    if (stat.isDirectory() && stat.uid === walk.uid && INSTANCE_DIRECTORY.test(name)) {
      await walk.seam?.("inspected", join(logical, name));
      await sweepInstance(directory, logical, name, stat, walk);
    } else await removeEntry(directory, logical, name, walk, 1);
  }
}

/**
 * Creates (when missing) and verifies the dedicated spool directory of one writer, `events` inside the
 * writer's state directory. That state directory is created by setup, must be a real directory of `uid`
 * without group or other access, and is never created or changed here. The spool directory is writable by
 * the worker (same user inside the boundary), so a mode the worker changed is reset to 0700 instead of
 * refused. Before it is mounted, everything that is not an `inst-<16 hex>` directory is removed, and inside
 * instance directories only entries older than 24 hours (an instance directory only when then empty and
 * itself that old), so a launch never breaks a live server of the same writer. The work is bounded, runs
 * through open directory descriptors (a swapped link is never followed), and needs `/proc/self/fd`
 * (`procDirectory` lets a test stand in for a system without it; writers are Linux-only).
 */
export async function ensureWriterEventsDirectory(
  home: string, name: string, uid: number, now: number = Date.now(), seam?: EventsCleanupSeam, procDirectory: string = PROC_FD,
): Promise<string> {
  const target = writerEventsDir(home, name);
  if (target === undefined) throw new EventsDirectoryError();
  try {
    if (!(await lstat(procDirectory)).isDirectory()) throw new EventsDirectoryError();
    const root = await lstat(dirname(target));
    if (!root.isDirectory() || root.uid !== uid || (root.mode & 0o077) !== 0) throw new EventsDirectoryError();
    try { await mkdir(target, { mode: 0o700 }); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const directory = await openPrivateDirectory(target, uid);
    try { await sweepWriterDirectory(directory, target, { uid, budget: { left: EVENTS_CLEANUP_MAX_ENTRIES }, cutoff: now - EVENTS_STALE_AFTER_MS, seam }); }
    finally { await directory.close(); }
  } catch { throw new EventsDirectoryError(); }
  return target;
}

export function throwawayArgs(
  name: string, paths: WriterPaths, imageId: string,
  opts: { clone: "ro" | "rw"; bundles: boolean },
  script: string, args: readonly string[],
): string[] {
  const result = [
    "run", "--rm", "-i", "--pull=never", "--network=none", "--userns=keep-id", "--read-only",
    "--cap-drop=all", "--security-opt=no-new-privileges", "--label", writerLabel(name),
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=1g", "-e", "HOME=/tmp",
    "-v", `${paths.clone}:${paths.clone}:${opts.clone}`,
    "--workdir", paths.clone,
  ];
  if (opts.bundles) result.push("-v", `${paths.bundles}:/bundles:rw`);
  return [...result, imageId, "sh", "-c", script, "sh", ...args];
}

async function podman(runner: CommandRunner, args: readonly string[], timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): Promise<CommandResult> {
  return runner.run("podman", args, AbortSignal.timeout(timeoutMs));
}

export async function podmanInfo(runner: CommandRunner): Promise<{ usable: boolean; version?: string }> {
  try {
    const info = await podman(runner, ["info", "--format", "{{.Host.Security.Rootless}}"]);
    if (info.exitCode !== 0 || info.stdout.trim() !== "true") return { usable: false };
    const result = await podman(runner, ["version", "--format", "{{.Client.Version}}"]);
    const version = result.stdout.trim();
    if (result.exitCode !== 0 || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) return { usable: false };
    return { usable: true, version };
  } catch {
    return { usable: false };
  }
}

export async function resolveImage(runner: CommandRunner, image: string, pull: boolean): Promise<string> {
  if (image !== "node" && !/^[0-9a-f]{64}$/.test(image)) throw new BoundaryError("image_unavailable");
  const ref = image === "node" ? NODE_IMAGE_REF : image;
  try {
    const inspect = () => podman(runner, ["image", "inspect", "--format", "{{.Id}}", ref]);
    const imageId = (result: CommandResult): string | undefined => result.exitCode === 0
      ? /^(?:sha256:)?([0-9a-f]{64})$/.exec(result.stdout.trim())?.[1] : undefined;
    let id = imageId(await inspect());
    if (!id && image === "node" && pull) {
      const pulled = await podman(runner, ["pull", "-q", ref], IMAGE_PULL_TIMEOUT_MS);
      if (pulled.exitCode !== 0) throw new BoundaryError("image_unavailable");
      id = imageId(await inspect());
    }
    if (id) return id;
  } catch {
    throw new BoundaryError("image_unavailable");
  }
  throw new BoundaryError("image_unavailable");
}

export async function verifyCloneLayout(clone: string): Promise<void> {
  try {
    const git = join(clone, ".git");
    if (!(await lstat(git)).isDirectory()) throw new BoundaryError("clone_verification_failed");
    if (!(await lstat(join(git, "config"))).isFile()) throw new BoundaryError("clone_verification_failed");
    for (const entry of ["commondir", "gitdir", "config.worktree"]) {
      try {
        await lstat(join(git, entry));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
      throw new BoundaryError("clone_verification_failed");
    }
    const hooks = join(git, "hooks");
    if (!(await lstat(hooks)).isDirectory()) throw new BoundaryError("clone_verification_failed");
    for (const entry of await readdir(hooks)) {
      if (!entry.endsWith(".sample") || !(await lstat(join(hooks, entry))).isFile()) {
        throw new BoundaryError("clone_verification_failed");
      }
    }
  } catch {
    throw new BoundaryError("clone_verification_failed");
  }
}

export function isSafeRefName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(name)
    && !name.includes("..") && !name.includes("//") && !name.endsWith("/") && !name.endsWith(".lock");
}

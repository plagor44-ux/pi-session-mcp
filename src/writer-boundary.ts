import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, opendir, readdir, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_COMMAND_TIMEOUT_MS } from "./client-adapters/command.js";
import type { CommandResult, CommandRunner } from "./client-adapters/types.js";
import { CONTAINER_EVENTS_DIR, EVENTS_DIR_ENV, writerEventsDir } from "./turn-events.js";
import type { writerPaths, WriterState } from "./writer-state.js";

export const NODE_IMAGE_REF = "docker.io/library/node@sha256:c4d5523090a817b7aa86d2111241fdd4f66d1e27782b44160e6aa63b357ecb2d";
export const IMAGE_PULL_TIMEOUT_MS = 900_000;
export const BOUNDARY_GIT = "git -c safe.directory=* -c core.fsmonitor=false -c core.hooksPath=/dev/null";

type WriterPaths = ReturnType<typeof writerPaths>;

export class BoundaryError extends Error {
  constructor(readonly code: "image_unavailable" | "clone_verification_failed") {
    super(code);
    this.name = "BoundaryError";
  }
}

/** `eventsDir` is the dedicated host spool directory of this writer; pass it only when event delivery is enabled for the writer. */
export function serveArgs(paths: WriterPaths, state: WriterState, command: readonly string[], releaseRoot: string, eventsDir?: string): string[] {
  const args = [
    "run", "-i", "--rm", "--pull=never", "--userns=keep-id", "--read-only",
    "--cap-drop=all", "--security-opt=no-new-privileges", `--network=${state.network}`,
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
  if (eventsDir !== undefined) args.push(
    "-v", `${eventsDir}:${CONTAINER_EVENTS_DIR}:rw`,
    "-e", `${EVENTS_DIR_ENV}=${CONTAINER_EVENTS_DIR}`,
  );
  if (state.cache === "go") args.push(
    "-v", `${paths.go}:/pi/go:rw`,
    "-e", "GOPATH=/pi/go", "-e", "GOCACHE=/pi/go/cache", "-e", "GOTOOLCHAIN=local",
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

const NO_FOLLOW_DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/**
 * Requires a real directory owned by `uid` and resets its mode to 0700. The mode is changed first because a
 * directory the worker stripped to 0000 cannot be opened; the handle opened afterwards must be the same inode.
 */
async function resetPrivateDirectory(path: string, uid: number): Promise<void> {
  const before = await lstat(path);
  if (!before.isDirectory() || before.uid !== uid) throw new EventsDirectoryError();
  if ((before.mode & 0o777) !== 0o700) await chmod(path, 0o700);
  const handle = await open(path, NO_FOLLOW_DIRECTORY);
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory() || stat.uid !== uid || stat.ino !== before.ino || stat.dev !== before.dev || (stat.mode & 0o777) !== 0o700) throw new EventsDirectoryError();
  } finally { await handle.close(); }
}

/** Removes everything below `directory` without following links; the budget is shared across the whole walk. */
async function clearDirectory(directory: string, uid: number, budget: { left: number }, depth: number): Promise<void> {
  if (depth > EVENTS_CLEANUP_MAX_DEPTH) throw new EventsDirectoryError();
  for (const name of await listNames(directory, budget)) await removeEntry(join(directory, name), uid, budget, depth + 1);
}

/** Event files and temporary files of a server instance younger than this are never removed at launch. */
export const EVENTS_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const INSTANCE_DIRECTORY = /^inst-[0-9a-f]{16}$/;

async function removeEntry(path: string, uid: number, budget: { left: number }, depth: number): Promise<void> {
  const stat = await lstat(path);
  if (stat.isDirectory()) {
    if (stat.uid !== uid) throw new EventsDirectoryError();
    await resetPrivateDirectory(path, uid);
    await clearDirectory(path, uid, budget, depth);
    await rmdir(path);
  } else await unlink(path);
}

async function listNames(directory: string, budget: { left: number }): Promise<string[]> {
  const names: string[] = [];
  const handle = await opendir(directory);
  try {
    for await (const entry of handle) {
      if (--budget.left < 0) throw new EventsDirectoryError();
      names.push(entry.name);
    }
  } catch (error) { await handle.close().catch(() => {}); throw error; }
  return names;
}

/**
 * A server instance directory may belong to a live server of the same writer, so it is never removed while
 * it could be in use: only event and temporary files older than the stale age go, and the directory goes
 * only when it is then empty and itself has not changed within that age.
 */
async function sweepInstance(path: string, uid: number, before: { mtimeMs: number }, cutoff: number, budget: { left: number }): Promise<void> {
  await resetPrivateDirectory(path, uid);
  let kept = 0;
  for (const name of await listNames(path, budget)) {
    const entry = join(path, name), stat = await lstat(entry);
    const old = stat.mtimeMs < cutoff;
    // A live server only creates event and temporary files; anything else is junk that goes by age alone.
    if (!old) { kept++; continue; }
    await removeEntry(entry, uid, budget, 2);
  }
  if (kept === 0 && before.mtimeMs < cutoff) {
    try { await rmdir(path); } catch (error) {
      if (!(error instanceof Error && "code" in error && (error.code === "ENOTEMPTY" || error.code === "ENOENT"))) throw error;
    }
  }
}

/** Launch-time cleanup of the writer's own spool directory; see `ensureWriterEventsDirectory`. */
async function sweepWriterDirectory(directory: string, uid: number, now: number): Promise<void> {
  const budget = { left: EVENTS_CLEANUP_MAX_ENTRIES }, cutoff = now - EVENTS_STALE_AFTER_MS;
  for (const name of await listNames(directory, budget)) {
    const path = join(directory, name), stat = await lstat(path);
    if (stat.isDirectory() && stat.uid === uid && INSTANCE_DIRECTORY.test(name)) await sweepInstance(path, uid, stat, cutoff, budget);
    else await removeEntry(path, uid, budget, 1);
  }
}

/**
 * Creates (when missing) and verifies the dedicated spool directory of one writer under the operator's
 * runtime directory, which is a tmpfs cleared at logout and therefore recreated at every launch.
 * The parents must be real directories owned by `uid` without group or other access; links are refused.
 * The writer's own directory is writable by the worker (same user inside the boundary), so a mode the
 * worker changed is reset to 0700 instead of refused. Before it is mounted, everything that is not an
 * `inst-<16 hex>` directory is removed, and inside instance directories only event and temporary files older
 * than 24 hours (an instance directory only when then empty and itself that old), so a launch never breaks a
 * live server of the same writer. The work is bounded and links are unlinked, never followed.
 */
export async function ensureWriterEventsDirectory(env: NodeJS.ProcessEnv, name: string, uid: number, now: number = Date.now()): Promise<string> {
  const target = writerEventsDir(env, name);
  if (target === undefined) throw new EventsDirectoryError();
  const verify = async (path: string): Promise<void> => {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) throw new EventsDirectoryError();
  };
  try {
    const chain = [target, dirname(target), dirname(dirname(target)), dirname(dirname(dirname(target)))].reverse();
    // chain[0] is the runtime directory itself: it must already exist and is never created or changed here.
    await verify(chain[0]!);
    for (const path of chain.slice(1, -1)) {
      try { await mkdir(path, { mode: 0o700 }); } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
      await verify(path);
    }
    try { await mkdir(target, { mode: 0o700 }); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    if (!(await lstat(target)).isDirectory()) throw new EventsDirectoryError();
    await resetPrivateDirectory(target, uid);
    await sweepWriterDirectory(target, uid, now);
  } catch { throw new EventsDirectoryError(); }
  return target;
}

export function throwawayArgs(
  paths: WriterPaths, imageId: string,
  opts: { clone: "ro" | "rw"; bundles: boolean },
  script: string, args: readonly string[],
): string[] {
  const result = [
    "run", "--rm", "-i", "--pull=never", "--network=none", "--userns=keep-id", "--read-only",
    "--cap-drop=all", "--security-opt=no-new-privileges",
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

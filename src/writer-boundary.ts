import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_COMMAND_TIMEOUT_MS } from "./client-adapters/command.js";
import type { CommandResult, CommandRunner } from "./client-adapters/types.js";
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

export function serveArgs(paths: WriterPaths, state: WriterState, command: readonly string[], releaseRoot: string): string[] {
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
  if (state.cache === "go") args.push(
    "-v", `${paths.go}:/pi/go:rw`,
    "-e", "GOPATH=/pi/go", "-e", "GOCACHE=/pi/go/cache", "-e", "GOTOOLCHAIN=local",
  );
  return [...args, state.imageId, ...command];
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

import { spawn } from "node:child_process";
import type { CommandRunner } from "./client-adapters/types.js";
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ALIAS_PATTERN } from "./execution-profile.js";
import { flockBinary, lockWithFlock, OverrideLockError } from "./override-lock.js";
import { assertSupportedFilesystem, isTrustedSystemBinary } from "./setup-platform.js";

export const SNAPSHOT_DIRECTORY = [".local", "state", "pi-session-mcp", "snapshots"] as const;
export type SnapshotCode = "snapshot_busy" | "snapshot_modified" | "snapshot_object_missing" | "snapshot_submodule_present" | "snapshot_source_unsupported" | "snapshot_unavailable" | "snapshot_incomplete";
export class SnapshotError extends Error {
  constructor(readonly code: SnapshotCode) { super("Snapshot is not available"); this.name = "SnapshotError"; }
}
export interface SnapshotPaths { readonly root: string; readonly worktree: string; readonly state: string; readonly lock: string; }
export function snapshotPaths(home: string, alias: string): SnapshotPaths {
  if (!ALIAS_PATTERN.test(alias)) throw new SnapshotError("snapshot_unavailable");
  const root = join(home, ...SNAPSHOT_DIRECTORY, alias);
  return { root, worktree: join(root, "worktree"), state: join(root, "state.json"), lock: join(root, "slot.lock") };
}
export interface SnapshotBinding { readonly base: string; readonly head: string; readonly tree: string; }
export interface SnapshotState extends SnapshotBinding { readonly v: 1; readonly source: string; readonly at: string; }
export function isObjectId(value: string): boolean { return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value); }
const oid = z.string().refine(isObjectId);
const stateSchema = z.object({ v: z.literal(1), source: z.string().regex(ALIAS_PATTERN), base: oid, head: oid, tree: oid, at: z.string() }).strict();
function secure(info: Stats, directory: boolean): boolean {
  return (directory ? info.isDirectory() : info.isFile()) && info.uid === process.getuid?.() && (info.mode & 0o7777) === (directory ? 0o700 : 0o600);
}
/**
 * Creates the slot root below the home directory. `~/.local` and `~/.local/state` are shared with
 * other software: they must be directories owned by this user that no one else can write to, with
 * any mode. The product's own components (`pi-session-mcp`, `snapshots`, the slot) must be private
 * directories (`0700`), and none of these components may be a link. The home directory itself and
 * its ancestors are not inspected: they may legitimately be links (for example `/home`).
 */
export async function ensureSnapshotRoot(paths: SnapshotPaths): Promise<void> {
  try {
    // root = <home>/.local/state/pi-session-mcp/snapshots/<alias>
    let home = paths.root;
    for (let i = 0; i <= SNAPSHOT_DIRECTORY.length; i++) home = dirname(home);
    const components = [...SNAPSHOT_DIRECTORY.map((_, i) => join(home, ...SNAPSHOT_DIRECTORY.slice(0, i + 1))), paths.root];
    const sharedCount = 2; // `.local` and `.local/state`
    for (const [index, path] of components.entries()) {
      const owned = index >= sharedCount;
      try { await lstat(path); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        await mkdir(path, { mode: 0o700 }); await chmod(path, 0o700);
      }
      const info = await lstat(path);
      if (owned ? !secure(info, true) : !info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0) throw new Error();
    }
  } catch { throw new SnapshotError("snapshot_unavailable"); }
}
export async function readSnapshotState(paths: SnapshotPaths): Promise<SnapshotState | undefined> {
  try {
    let before: Stats;
    try { before = await lstat(paths.state); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
    if (!secure(before, false)) throw new Error();
    const file = await open(paths.state, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { const s = await file.stat(); if (!secure(s, false) || s.dev !== before.dev || s.ino !== before.ino) throw new Error(); return stateSchema.parse(JSON.parse(await file.readFile("utf8")) as unknown); }
    finally { await file.close(); }
  } catch { throw new SnapshotError("snapshot_incomplete"); }
}
export async function writeSnapshotState(paths: SnapshotPaths, state: SnapshotState): Promise<void> {
  const temp = join(paths.root, `.state-${randomUUID()}.tmp`); let created = false;
  try {
    const validated = stateSchema.parse(state);
    const file = await open(temp, "wx", 0o600); created = true;
    try { await file.chmod(0o600); await file.writeFile(`${JSON.stringify(validated, null, 2)}\n`); await file.sync(); } finally { await file.close(); }
    await rename(temp, paths.state);
    const dir = await open(paths.root, "r"); try { await dir.sync(); } finally { await dir.close(); }
  } catch { throw new SnapshotError("snapshot_incomplete"); }
  finally { if (created) await unlink(temp).catch(() => undefined); }
}
export async function removeSnapshotState(paths: SnapshotPaths): Promise<void> {
  try { await unlink(paths.state); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new SnapshotError("snapshot_incomplete"); }
}
export interface GitResult { readonly code: number; readonly stdout: string; }
export interface SnapshotGit { run(cwd: string, args: readonly string[], options?: { readonly signal?: AbortSignal; readonly inheritFds?: readonly number[] }): Promise<GitResult>; }
export interface TrustedGitOptions { readonly candidates?: readonly string[]; readonly isTrustedBinary?: (path: string) => boolean; readonly env?: Readonly<Record<string, string>>; readonly timeoutMs?: number; readonly maxOutputBytes?: number; }
export function trustedGit(options: TrustedGitOptions = {}): SnapshotGit | undefined {
  const binary = (options.candidates ?? ["/usr/bin/git", "/bin/git"]).find((path) => (options.isTrustedBinary ?? ((candidate: string) => isTrustedSystemBinary(candidate)))(path));
  if (!binary) return undefined;
  return { run(cwd, args, runOptions = {}) {
    return new Promise((resolve, reject) => {
      if (runOptions.signal?.aborted) { reject(new SnapshotError("snapshot_unavailable")); return; }
      let child;
      try { child = spawn(binary, ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.useReplaceRefs=false", "-C", cwd, ...args], { detached: true, stdio: ["ignore", "pipe", "ignore", ...(runOptions.inheritFds ?? [])], env: { PATH: "/usr/bin:/bin", HOME: options.env?.HOME ?? homedir(), LANG: "C", LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", ...options.env } }); }
      catch { reject(new SnapshotError("snapshot_unavailable")); return; }
      let failed = false; let settled = false; let size = 0; const chunks: Buffer[] = [];
      const stop = (): void => { failed = true; if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { /* exited */ } };
      const timer = setTimeout(stop, options.timeoutMs ?? 10_000);
      runOptions.signal?.addEventListener("abort", stop, { once: true });
      const finish = (outcome: GitResult | undefined): void => {
        if (settled) return;
        settled = true; clearTimeout(timer); runOptions.signal?.removeEventListener("abort", stop);
        if (outcome === undefined) reject(new SnapshotError("snapshot_unavailable")); else resolve(outcome);
      };
      child.stdout!.on("data", (data: Buffer) => { size += data.length; if (size > (options.maxOutputBytes ?? 4 * 1024 * 1024)) stop(); else chunks.push(data); });
      // A spawn failure may emit only `error`; settle on it instead of waiting for `close`.
      child.once("error", () => { stop(); finish(undefined); });
      child.once("close", (code) => { finish(failed || code === null ? undefined : { code, stdout: Buffer.concat(chunks).toString("utf8") }); });
    });
  } };
}
export function guardedGit(runner: CommandRunner, options: TrustedGitOptions & { envCandidates?: readonly string[] } = {}): SnapshotGit | undefined {
  const trusted = options.isTrustedBinary ?? ((candidate: string) => isTrustedSystemBinary(candidate));
  const binary = (options.candidates ?? ["/usr/bin/git", "/bin/git"]).find(trusted);
  const envBinary = (options.envCandidates ?? ["/usr/bin/env", "/bin/env"]).find(trusted);
  if (!binary || !envBinary) return undefined;
  const env = { PATH: "/usr/bin:/bin", HOME: options.env?.HOME ?? homedir(), LANG: "C", LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", ...options.env };
  const pairs = Object.entries(env).map(([key, value]) => {
    if (!key || /[=\0]/.test(key) || value.includes("\0")) throw new SnapshotError("snapshot_unavailable");
    return `${key}=${value}`;
  });
  return { async run(cwd, args, runOptions = {}) {
    const output = await runner.run(envBinary, ["-i", ...pairs, binary, "--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.useReplaceRefs=false", "-C", cwd, ...args], runOptions.signal);
    if ([124, 125, 126, 127].includes(output.exitCode) || output.stderr === "output_limit") throw new SnapshotError("snapshot_unavailable");
    return { code: output.exitCode, stdout: output.stdout };
  } };
}
export async function assertNoConversionDrivers(git: SnapshotGit, cwd: string): Promise<void> {
  const result = await git.run(cwd, ["config", "--get-regexp", "^(filter\\..*\\.(clean|smudge|process)|core\\.fsmonitor)$"]);
  if (result.code === 1 && result.stdout === "") return;
  if (result.code !== 0) throw new SnapshotError("snapshot_unavailable");
  for (const line of result.stdout.split("\n").filter(Boolean)) {
    const match = /^(\S+)(?:\s+(.*))?$/.exec(line);
    if (!match) throw new SnapshotError("snapshot_unavailable");
    if (match[1]!.toLowerCase() !== "core.fsmonitor" || !/^(false|no|off|0)$/i.test(match[2]?.trim() ?? "")) throw new SnapshotError("snapshot_source_unsupported");
  }
}
async function checkContext(git: SnapshotGit, worktree: string): Promise<void> {
  try { await assertNoConversionDrivers(git, worktree); } catch (e) { if (e instanceof SnapshotError && e.code === "snapshot_source_unsupported") throw new SnapshotError("snapshot_modified"); throw e; }
  const result = await git.run(worktree, ["rev-parse", "--is-inside-work-tree"]);
  if (result.code !== 0 || result.stdout.trim() !== "true") throw new SnapshotError("snapshot_unavailable");
}
async function clean(git: SnapshotGit, worktree: string): Promise<void> {
  const status = await git.run(worktree, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching", "-z"]);
  if (status.code !== 0 || status.stdout !== "") throw new SnapshotError("snapshot_modified");
  const flags = await git.run(worktree, ["ls-files", "-v", "-z"]);
  if (flags.code !== 0 || flags.stdout.split("\0").some((s) => s !== "" && !s.startsWith("H "))) throw new SnapshotError("snapshot_modified");
  const index = await git.run(worktree, ["ls-files", "-s", "-z"]);
  if (index.code !== 0 || index.stdout.split("\0").some((s) => s.startsWith("160000 "))) throw new SnapshotError("snapshot_modified");
}
export async function verifySnapshot(git: SnapshotGit, worktree: string, binding: SnapshotBinding): Promise<void> {
  await checkContext(git, worktree);
  if (!isObjectId(binding.base) || !isObjectId(binding.head) || !isObjectId(binding.tree)) throw new SnapshotError("snapshot_modified");
  const head = await git.run(worktree, ["rev-parse", "--verify", "--end-of-options", "HEAD"]);
  if (head.code !== 0 || head.stdout.trim() !== binding.head) throw new SnapshotError("snapshot_modified");
  const base = await git.run(worktree, ["cat-file", "-e", "--end-of-options", `${binding.base}^{commit}`]);
  if (base.code !== 0) throw new SnapshotError("snapshot_modified");
  const tree = await git.run(worktree, ["rev-parse", "--verify", "--end-of-options", `${binding.head}^{tree}`]);
  if (tree.code !== 0 || tree.stdout.trim() !== binding.tree) throw new SnapshotError("snapshot_modified");
  await clean(git, worktree);
}
export async function verifyClean(git: SnapshotGit, worktree: string): Promise<void> { await checkContext(git, worktree); await clean(git, worktree); }
export interface SnapshotLock { readonly fd: number; release(): Promise<void>; }
type LockOptions = { readonly signal?: AbortSignal; readonly flockCandidates?: readonly string[]; readonly isTrustedBinary?: (path: string) => boolean };
async function lockSnapshot(paths: SnapshotPaths, options: LockOptions, shared: boolean): Promise<SnapshotLock> {
  let file: FileHandle | undefined;
  try {
    if (process.platform !== "linux" || options.signal?.aborted || !secure(await lstat(paths.root), true)) throw new Error();
    const binary = flockBinary(options); if (!binary) throw new Error();
    await assertSupportedFilesystem(paths.root, "linux");
    try { file = await open(paths.lock, constants.O_NOFOLLOW | constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600); await file.chmod(0o600); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; file = await open(paths.lock, constants.O_NOFOLLOW | constants.O_RDWR); }
    if (!secure(await file.stat(), false)) throw new Error();
    await lockWithFlock(binary, file.fd, 0, options.signal, true, shared);
    const [descriptor, linked] = await Promise.all([file.stat(), lstat(paths.lock)]);
    if (!secure(descriptor, false) || !secure(linked, false) || descriptor.dev !== linked.dev || descriptor.ino !== linked.ino) throw new Error();
    const held = file; let released = false;
    return { fd: held.fd, async release() { if (!released) { released = true; await held.close().catch(() => undefined); } } };
  } catch (e) { await file?.close().catch(() => undefined); throw new SnapshotError(!shared && e instanceof OverrideLockError && e.code === "override_lock_busy" ? "snapshot_busy" : "snapshot_unavailable"); }
}
export function lockSnapshotShared(paths: SnapshotPaths, options: LockOptions = {}): Promise<SnapshotLock> { return lockSnapshot(paths, options, true); }
export function lockSnapshotExclusive(paths: SnapshotPaths, options: LockOptions = {}): Promise<SnapshotLock> { return lockSnapshot(paths, options, false); }

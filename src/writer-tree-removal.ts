import { chmod, lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/** Upper bound for the entries one permission walk visits: a Go module cache holds many thousands. */
export const TREE_WALK_LIMIT = 5_000_000;
const OWNER_RWX = 0o700;

const errorCode = (error: unknown): string | undefined => (error instanceof Error && "code" in error ? String(error.code) : undefined);

/**
 * Gives the current user rwx on every real directory below `root` (and on `root` itself) that lacks it. Go creates
 * its module cache with directories that have no owner write bit, and Node's recursive `rm` cannot unlink inside
 * such a directory. Nothing is followed: every entry is `lstat`ed, a symbolic link is never opened or `chmod`ed,
 * and only directories owned by the current user are changed. The walk visits only entries below `root`.
 */
export async function makeTreeRemovable(root: string, limit: number = TREE_WALK_LIMIT): Promise<void> {
  const uid = process.getuid?.();
  const pending = [root];
  let visited = 0;
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    if (++visited > limit) throw new Error("tree_walk_limit_exceeded");
    let stat;
    try { stat = await lstat(path); } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    if (!stat.isDirectory()) continue; // Files and symbolic links need no change; removal unlinks a link without following it.
    if (uid !== undefined && stat.uid === uid && (stat.mode & OWNER_RWX) !== OWNER_RWX) await chmod(path, (stat.mode & 0o7777) | OWNER_RWX);
    let names: string[];
    try { names = await readdir(path); } catch (error) {
      // A directory of another user stays unreadable; the removal that follows reports it.
      if (errorCode(error) === "EACCES" || errorCode(error) === "ENOENT") continue;
      throw error;
    }
    for (const name of names) pending.push(join(path, name));
  }
}

/**
 * Removes a writer's storage tree. Permissions are restored first. Then everything except the top-level `clone` and
 * `state.json` is deleted, then `clone`, then `state.json`, then the root. A part-way failure therefore keeps
 * `state.json`, and as long as anything else fails also `clone`, so a retry without `--discard` can still inspect the
 * writer instead of finding one that setup can no longer address.
 */
export async function removeWriterTree(root: string): Promise<void> {
  let stat;
  try { stat = await lstat(root); } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  if (!stat.isDirectory()) { await rm(root, { force: true }); return; }
  await makeTreeRemovable(root);
  for (const name of await readdir(root)) {
    if (name !== "state.json" && name !== "clone") await rm(join(root, name), { recursive: true, force: true });
  }
  await rm(join(root, "clone"), { recursive: true, force: true });
  await rm(join(root, "state.json"), { force: true });
  await rm(root, { recursive: true, force: true });
}

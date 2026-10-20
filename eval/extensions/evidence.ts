import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectBoundaryCredentials } from "../../src/writer-credentials.js";
import { runHelper } from "./helpers.js";

export const REDACTED = "redacted: secret match";
const MIN_SECRET_LENGTH = 12;
const MAX_SCAN_BYTES = 256 * 1024 * 1024;
const MAX_PATCH_BYTES = 32 * 1024 * 1024;
/** The pristine bare clone is a verbatim copy of the repository, not worker output; it is not scanned. */
const NOT_SCANNED = new Set(["base.git"]);

/** Every string value of the selected auth entries except `type` and `expires`, at least 12 characters long (R38). */
export function boundarySecrets(hostAuth: unknown, providers: readonly string[]): string[] {
  const secrets = new Set<string>();
  for (const entry of Object.values(selectBoundaryCredentials(hostAuth, providers))) {
    if (typeof entry !== "object" || entry === null) continue;
    for (const [key, value] of Object.entries(entry)) {
      if (key !== "type" && key !== "expires" && typeof value === "string" && value.length >= MIN_SECRET_LENGTH) secrets.add(value);
    }
  }
  return [...secrets];
}

/**
 * Replaces every file under `dir` that contains a secret with the text "redacted: secret match" (symlinks are removed, files too large
 * to scan are replaced as well). Returns the relative paths it replaced.
 */
export async function redactSecrets(dir: string, secrets: string[], relative = ""): Promise<string[]> {
  const replaced: string[] = [];
  for (const name of await readdir(join(dir, relative))) {
    const rel = relative === "" ? name : `${relative}/${name}`;
    if (relative === "" && NOT_SCANNED.has(name)) continue;
    const path = join(dir, rel);
    const info = await lstat(path);
    if (info.isSymbolicLink()) { await rm(path, { force: true }); replaced.push(rel); continue; }
    if (info.isDirectory()) { replaced.push(...await redactSecrets(dir, secrets, rel)); continue; }
    if (!info.isFile()) { await rm(path, { force: true }); replaced.push(rel); continue; }
    if (secrets.length === 0) continue;
    const hit = info.size > MAX_SCAN_BYTES || await readFile(path).then((bytes) => secrets.some((secret) => bytes.includes(secret)));
    if (hit) { await writeFile(path, REDACTED, { mode: 0o600 }); replaced.push(rel); }
  }
  return replaced;
}

/** Writes the allowlisted files into `dir` and redacts any that carry a secret. */
export async function writeEvidence(dir: string, files: Record<string, string | Buffer>, secrets: string[]): Promise<string[]> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content, { mode: 0o600 });
  return redactSecrets(dir, secrets);
}

const GIT_FLAGS = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.hooksPath=/dev/null"];

/**
 * The worker's changes as `git diff --binary <baseCommit>`, taken through the pristine git directory with a temporary index and object
 * store (the pristine directory is never written), the hardened environment of the oracles and no configuration from the clone.
 */
export async function collectPatch(clone: string, gitDir: string, baseCommit: string, scopeIgnore: string[]): Promise<string> {
  if (!/^[0-9a-f]{40,64}$/.test(baseCommit)) throw new Error("base_commit_invalid");
  const scratch = await mkdtemp(join(tmpdir(), "ablation-patch-"));
  try {
    await mkdir(join(scratch, "home"));
    await mkdir(join(scratch, "objects"));
    const env = {
      PATH: process.env.PATH ?? "", HOME: join(scratch, "home"), GIT_DIR: gitDir, GIT_WORK_TREE: clone, GIT_INDEX_FILE: join(scratch, "index"),
      GIT_OBJECT_DIRECTORY: join(scratch, "objects"), GIT_ALTERNATE_OBJECT_DIRECTORIES: join(gitDir, "objects"),
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    };
    const git = (args: string[]) => runHelper("git", [...GIT_FLAGS, ...args], { cwd: clone, env, maxBuffer: MAX_PATCH_BYTES });
    const excludes = [".codegraph/", ...scopeIgnore].map((prefix) => `:(exclude)${prefix}`);
    await git(["read-tree", baseCommit]);
    // --ignore-errors skips files git cannot index (a FIFO or socket) and still exits 1.
    await git(["add", "-A", "--ignore-errors", "--", ".", ...excludes]).catch((error: { code?: unknown }) => { if (error.code !== 1) throw error; });
    try {
      return (await git(["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", baseCommit, "--", ".", ...excludes])).stdout;
    } catch (error) {
      if ((error as Error).message === "helper_output_too_large") return "patch omitted: too large\n";
      throw error;
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

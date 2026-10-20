import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Anchor, ImplementationOracle, ReviewOracle } from "./schemas.js";

const execFileAsync = promisify(execFile);
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+/;
const HEADING = /^\s{0,3}#{1,6}\s+(\S.*)$/;

/**
 * Splits review text into lower-cased blocks.
 * A block ends at a blank line, at a list item that is not nested deeper than the block's first list item, at a heading,
 * at a table row (`|...`, one block per row) and before a line starting with `**`.
 * Each heading's text is prefixed to every following block until the next heading; a heading without a body is a block itself.
 */
function blocksOf(text: string): string[] {
  const blocks: string[] = [];
  let heading: string | undefined;
  let sectionHasBody = false;
  let current: string[] = [];
  let listIndent: number | undefined;
  const push = (lines: string[]): void => {
    blocks.push((heading === undefined ? lines.join("\n") : `${heading}\n${lines.join("\n")}`).toLowerCase());
    sectionHasBody = true;
  };
  const flush = (): void => { if (current.length > 0) push(current); current = []; listIndent = undefined; };
  const closeSection = (): void => { if (heading !== undefined && !sectionHasBody) blocks.push(heading.toLowerCase()); };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (line.trim() === "") { flush(); continue; }
    const headingMatch = HEADING.exec(line);
    if (headingMatch) { flush(); closeSection(); heading = headingMatch[1] ?? ""; sectionHasBody = false; continue; }
    if (/^\s*\|/.test(line)) { flush(); push([line]); continue; }
    if (/^\s*\*\*/.test(line)) { flush(); current.push(line); continue; }
    const item = LIST_ITEM.exec(line);
    if (item) {
      const indent = (item[1] ?? "").replace(/\t/g, "    ").length;
      if (listIndent === undefined || indent <= listIndent) { flush(); listIndent = indent; }
    }
    current.push(line);
  }
  flush();
  closeSection();
  return blocks;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A term matches from a word start (prefix stems match: `lock` hits `locking`, but not `block`). */
const termHits = (block: string, term: string): boolean => new RegExp(`(?<![a-z0-9_])${escapeRegExp(term)}`, "i").test(block);

const segmentsOf = (path: string): string[] => path.split("/").filter((segment) => segment !== "" && segment !== ".");
const isSegmentSuffix = (suffix: string[], whole: string[]): boolean =>
  suffix.length > 0 && suffix.length <= whole.length && suffix.every((segment, i) => segment === whole[whole.length - suffix.length + i]);

/** True when a maximal path token in the block names the anchor's file: the token's segments are a suffix of the anchor path or vice versa. */
function namesFile(block: string, file: string): boolean {
  const anchorSegments = segmentsOf(file.toLowerCase());
  for (const match of block.matchAll(/[a-z0-9_.\-/]+/g)) {
    const tokenSegments = segmentsOf(match[0].replace(/\.+$/, ""));
    if (isSegmentSuffix(tokenSegments, anchorSegments) || isSegmentSuffix(anchorSegments, tokenSegments)) return true;
  }
  return false;
}

function anchorHits(block: string, anchor: Anchor): boolean {
  return namesFile(block, anchor.file) && anchor.terms.every((term) => termHits(block, term));
}
const anyAnchorHits = (blocks: string[], anchors: Anchor[]): boolean => anchors.some((anchor) => blocks.some((block) => anchorHits(block, anchor)));

export interface ReviewScore { accepted: boolean; criticalHit: number; criticalTotal: number; recall: number; falseFindings: string[] }

/** Deterministic review oracle: an anchor hits when one block names its file (path-agreeing token) and contains every term from a word start. */
export function scoreReview(text: string, oracle: ReviewOracle): ReviewScore {
  const blocks = blocksOf(text);
  const hit = oracle.findings.map((finding) => ({ finding, hit: anyAnchorHits(blocks, finding.anchors) }));
  const critical = hit.filter((entry) => entry.finding.critical);
  const criticalHit = critical.filter((entry) => entry.hit).length;
  const falseFindings = oracle.falseFindings.filter((finding) => anyAnchorHits(blocks, finding.anchors)).map((finding) => finding.id);
  return {
    accepted: criticalHit === critical.length && falseFindings.length === 0,
    criticalHit, criticalTotal: critical.length,
    recall: hit.length === 0 ? 1 : hit.filter((entry) => entry.hit).length / hit.length,
    falseFindings,
  };
}

function minimalEnv(home: string): NodeJS.ProcessEnv { return { PATH: process.env.PATH ?? "", HOME: home, CI: "1" }; }

/** Pristine base: a git directory (in production a bare clone made before the worker starts) and the base commit in it. */
export interface ScopeBase { gitDir: string; commit: string }

const GIT_CONFIG_FLAGS = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.hooksPath=/dev/null"];
const IGNORED_ALWAYS = [".codegraph/"];

const isInsideGitDir = (path: string): boolean => path === ".git" || path.startsWith(".git/");

/**
 * Lists every path of `clone` that differs from the base commit: modified, deleted, untracked and ignored files, repo-relative.
 * All git calls use the pristine `base.gitDir` with a fresh temporary index and config, so worker commits, `skip-worktree` and
 * `assume-unchanged` flags and repository configuration in the clone's own `.git` cannot hide or trigger anything.
 * `options.home` overrides the (otherwise fresh, removed afterwards) HOME of the git calls.
 */
export async function changedPaths(clone: string, base: ScopeBase, scopeIgnore: string[], options: { home?: string } = {}): Promise<string[]> {
  if (!/^[0-9a-f]{40,64}$/.test(base.commit)) throw new Error("base_commit_invalid");
  const scratch = await mkdtemp(join(tmpdir(), "oracle-scope-"));
  try {
    const home = options.home ?? join(scratch, "home");
    await mkdir(join(scratch, "home"), { recursive: true });
    const env = {
      PATH: process.env.PATH ?? "", HOME: home, GIT_DIR: base.gitDir, GIT_WORK_TREE: clone, GIT_INDEX_FILE: join(scratch, "index"),
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    };
    const git = async (...args: string[]): Promise<string> =>
      (await execFileAsync("git", [...GIT_CONFIG_FLAGS, ...args], { cwd: clone, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })).stdout;
    await git("read-tree", base.commit);
    await git("update-index", "-q", "--refresh");
    const modified = (await git("diff-files", "--name-only", "-z")).split("\0");
    const untracked = (await git("ls-files", "--others", "-z")).split("\0");
    const ignored = [...scopeIgnore, ...IGNORED_ALWAYS];
    const paths = new Set([...modified, ...untracked].filter((path) => path !== "" && !isInsideGitDir(path)));
    return [...paths].filter((path) => !ignored.some((prefix) => path.startsWith(prefix))).sort();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Kill a detached process group (pattern of `terminateProcessGroup` in src/setup-process.ts); `fallback` also signals the pid itself. */
function killProcessGroup(pid: number | undefined, fallback: boolean): void {
  if (pid === undefined) return;
  try { process.kill(-pid, "SIGKILL"); return; } catch { /* already exited or no group */ }
  if (fallback) { try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ } }
}

/** Runs an argv list without a shell in the clone; true only on exit code 0 within the timeout. The process group is killed afterwards in every case. */
function runArgv(argv: readonly string[], clone: string, home: string, timeoutMs: number): Promise<boolean> {
  const [file, ...args] = argv;
  if (file === undefined || timeoutMs <= 0) return Promise.resolve(false);
  return new Promise((resolvePromise) => {
    let settled = false;
    const settle = (ok: boolean): void => { if (settled) return; settled = true; clearTimeout(timer); resolvePromise(ok); };
    const child = spawn(file, args, { cwd: clone, env: minimalEnv(home), stdio: "ignore", detached: true });
    const timer = setTimeout(() => { killProcessGroup(child.pid, true); settle(false); }, timeoutMs);
    child.on("error", () => settle(false));
    child.on("exit", (code) => { killProcessGroup(child.pid, false); settle(code === 0); });
  });
}

/** Removes the ignored state directories from the clone, never following a symlinked parent out of it. */
async function removeIgnoredDirectories(clone: string, scopeIgnore: string[]): Promise<void> {
  const root = await realpath(clone);
  for (const prefix of [...scopeIgnore, ...IGNORED_ALWAYS]) {
    const segments = segmentsOf(prefix);
    if (segments.length === 0 || segments[0] === ".git" || segments.includes("..")) continue;
    const target = resolve(root, ...segments);
    const parent = await realpath(dirname(target)).catch(() => undefined);
    if (parent === undefined || (parent !== root && !parent.startsWith(root + sep))) continue;
    await rm(target, { recursive: true, force: true });
  }
}

export interface ImplementationScore { accepted: boolean; testsPassed: boolean; outOfScope: string[] }

/**
 * Task paths are repo-relative. An `allowedPaths` entry matches exactly one path, unless it ends with `/`:
 * then it is a directory prefix and matches every path below it.
 */
export interface ImplementationTask { allowedPaths: string[]; scopeIgnore: string[]; baseCommit: string; oracle: ImplementationOracle }

const isAllowed = (path: string, allowed: string): boolean => allowed.endsWith("/") ? path.startsWith(allowed) : path === allowed;

/**
 * Computes the changed-file scope against the pristine base first, then deletes the ignored state directories from the clone and
 * runs the setup commands and the decisive command, which share one deadline of `oracle.timeoutMs`.
 * HOME defaults to a fresh temporary directory; `wrap` rewrites every argv (for example to run it under strace).
 */
export async function scoreImplementation(
  clone: string,
  task: ImplementationTask,
  options: { gitDir: string; home?: string; wrap?: (argv: readonly string[]) => string[] },
): Promise<ImplementationScore> {
  const changed = await changedPaths(clone, { gitDir: options.gitDir, commit: task.baseCommit }, task.scopeIgnore);
  const outOfScope = changed.filter((path) => !task.allowedPaths.some((allowed) => isAllowed(path, allowed)));
  await removeIgnoredDirectories(clone, task.scopeIgnore);
  const ownHome = options.home === undefined ? await mkdtemp(join(tmpdir(), "oracle-home-")) : undefined;
  const home = options.home ?? ownHome ?? clone;
  try {
    const deadline = Date.now() + task.oracle.timeoutMs;
    const run = (argv: readonly string[]): Promise<boolean> => runArgv(options.wrap ? options.wrap(argv) : argv, clone, home, deadline - Date.now());
    let testsPassed = true;
    for (const setup of task.oracle.setup ?? []) {
      if (!await run(setup)) { testsPassed = false; break; }
    }
    if (testsPassed) testsPassed = await run(task.oracle.command);
    return { accepted: testsPassed && outOfScope.length === 0, testsPassed, outOfScope };
  } finally {
    if (ownHome !== undefined) await rm(ownHome, { recursive: true, force: true });
  }
}

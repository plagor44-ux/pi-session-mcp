import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Anchor, ImplementationOracle, ReviewOracle } from "./schemas.js";

const execFileAsync = promisify(execFile);
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+/;
const HEADING = /^\s{0,3}(#{1,6})\s+(\S.*)$/;

const PATH_RUN = /[a-z0-9_.\-/]+/g;
const SOURCE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "md", "mdx", "py", "go", "rs", "java", "kt", "kts", "rb", "php", "c", "h", "cc", "cpp", "hpp",
  "cs", "swift", "sh", "bash", "zsh", "fish", "yaml", "yml", "toml", "ini", "cfg", "sql", "css", "scss", "sass", "less", "html", "htm", "vue",
  "svelte", "txt", "xml", "gradle", "lock", "env",
]);
/** Prose words that look like `name.ext`. */
const NOT_PATHS = new Set(["node.js", "next.js", "nuxt.js", "vue.js", "react.js", "express.js", "three.js", "d3.js", "e.g", "i.e"]);
const extensionOf = (segment: string): string | undefined => { const dot = segment.lastIndexOf("."); return dot > 0 ? segment.slice(dot + 1) : undefined; };

/**
 * Path tokens of lower-cased text: maximal path-character runs (trailing dots trimmed), URLs excluded, that are either
 * `dir/.../name.ext` or `dir/` with a source extension or trailing slash, or a bare `name.ext` with a source extension that is not a prose word.
 * Dotted identifiers (`this.lock.release`) and slash words (`read/write`) are not paths.
 */
function pathTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.replace(/[a-z][a-z0-9+.-]*:\/\/\S*/g, " ").matchAll(PATH_RUN)) {
    const token = match[0].replace(/\.+$/, "");
    if (token === "") continue;
    if (token.includes("/")) {
      const last = token.split("/").pop() ?? "";
      const ext = extensionOf(last);
      if ((ext !== undefined && SOURCE_EXTENSIONS.has(ext)) || (token.endsWith("/") && token.length >= 3)) tokens.push(token);
    } else if (!NOT_PATHS.has(token)) {
      const ext = extensionOf(token);
      if (ext !== undefined && SOURCE_EXTENSIONS.has(ext)) tokens.push(token);
    }
  }
  return tokens;
}

const FENCE_OPEN = /^\s*(?:(`{3,})[^`]*|(~{3,}).*)$/;
const FENCE_CLOSE = /^\s*(?:`{3,}|~{3,})\s*$/;
/** Drops the lines of every terminated fenced code block; an unterminated opener stays an ordinary text line. */
function withoutFences(lines: string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const open = FENCE_OPEN.exec(line);
    if (open) {
      const marker = open[1] ?? open[2] ?? "";
      let close = -1;
      for (let j = i + 1; j < lines.length; j += 1) {
        const candidate = lines[j] ?? "";
        const trimmed = candidate.trim();
        if (FENCE_CLOSE.test(candidate) && trimmed[0] === marker[0] && trimmed.length >= marker.length) { close = j; break; }
      }
      if (close >= 0) { i = close; continue; }
    }
    kept.push(line);
  }
  return kept;
}

/** A line holding only one path token, optionally in `**`/backticks, with optional `:line` and trailing `:`; returns the token. */
function pathOnlyLine(line: string): string | undefined {
  if (!/^\S/.test(line)) return undefined;
  let rest = line.trim().toLowerCase();
  for (let changed = true; changed;) {
    const before = rest;
    rest = rest.replace(/^(\*\*|`)/, "").replace(/(\*\*|`|:)$/, "").replace(/:\d+(?:-\d+)?$/, "");
    changed = rest !== before;
  }
  const tokens = pathTokens(rest);
  return tokens.length === 1 && tokens[0] === rest ? rest : undefined;
}

interface HeadingEntry { level: number; tokens: string; text: string }

/**
 * Splits review text into lower-cased blocks.
 * A block ends at a blank line, at a list item that is not nested deeper than the block's first list item, at a heading,
 * at a table row (`|...`, one block per row) and before an unindented `**` line outside a list item that contains a path token
 * (field labels such as `**Why:**` continue the block). Terminated fenced code is dropped; it neither splits a block nor contributes
 * tokens or terms, and an unterminated fence opener is plain text.
 * Headings form a stack by level. The first block of a section that has no path token of its own gets the full heading text,
 * later pathless blocks get only the heading's path tokens (inherited from the nearest enclosing lower-level heading when it has none);
 * a heading without a body is a block itself, with the inherited path prepended.
 * A path-only line (`**src/a.ts**`, `src/a.ts:`) acts as a heading one level below the current one until the next heading,
 * the next path-only line, or a blank line followed by a non-list line.
 */
function blocksOf(text: string): string[] {
  const blocks: string[] = [];
  const stack: HeadingEntry[] = [];
  let heading: string | undefined;
  let headingTokens = "";
  let sectionHasBody = false;
  let current: string[] = [];
  let listIndent: number | undefined;
  let pseudoActive = false;
  let pseudoBlank = false;
  const push = (lines: string[]): void => {
    const body = lines.join("\n").toLowerCase();
    if (heading !== undefined && pathTokens(body).length === 0) {
      blocks.push(sectionHasBody ? `${headingTokens}\n${body}` : `${heading.toLowerCase()}\n${headingTokens}\n${body}`);
    } else blocks.push(body);
    sectionHasBody = true;
  };
  const flush = (): void => { if (current.length > 0) push(current); current = []; listIndent = undefined; };
  const closeSection = (): void => {
    if (heading === undefined || sectionHasBody) return;
    const own = pathTokens(heading.toLowerCase()).length > 0;
    blocks.push(own ? heading.toLowerCase() : `${headingTokens}\n${heading.toLowerCase()}`);
  };
  const endPseudo = (): void => {
    if (!pseudoActive) return;
    stack.pop();
    pseudoActive = false;
    const top = stack[stack.length - 1];
    heading = top?.text; headingTokens = top?.tokens ?? ""; sectionHasBody = true;
  };
  const startSection = (level: number, title: string, pseudo: boolean): void => {
    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
    heading = title;
    headingTokens = pathTokens(title.toLowerCase()).join(" ") || (stack[stack.length - 1]?.tokens ?? "");
    stack.push({ level, tokens: headingTokens, text: title });
    sectionHasBody = false;
    pseudoActive = pseudo; pseudoBlank = false;
  };
  for (const line of withoutFences(text.replace(/\r\n?/g, "\n").split("\n"))) {
    if (line.trim() === "") { flush(); if (pseudoActive) pseudoBlank = true; continue; }
    if (pseudoActive && pseudoBlank) {
      pseudoBlank = false;
      if (!LIST_ITEM.test(line)) { closeSection(); endPseudo(); }
    }
    const headingMatch = HEADING.exec(line);
    if (headingMatch) {
      flush(); closeSection(); endPseudo();
      startSection((headingMatch[1] ?? "").length, headingMatch[2] ?? "", false);
      continue;
    }
    if (pathOnlyLine(line) !== undefined) {
      flush(); closeSection(); endPseudo();
      startSection((stack[stack.length - 1]?.level ?? 0) + 1, line.trim(), true);
      continue;
    }
    if (/^\s*\|/.test(line)) { flush(); push([line]); continue; }
    if (line.startsWith("**") && listIndent === undefined && pathTokens(line.toLowerCase()).length > 0) { flush(); current.push(line); continue; }
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

/*
 * Known limits (task curation validates each review oracle against real review text, so they are caught per task):
 * - negation ("X was not found") is invisible to keyword anchors;
 * - title-first field labels (`**Title:** ... **Location:** src/a.ts ...`) are split before the location;
 * - a heading that names several paths gives all of them to pathless blocks.
 */
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
 * Walks the clone without following symlinks and skipping the top-level `.git`. Any permission error fails closed with
 * `scope_unreadable`, and every non-root entry named `.git` (file or directory) is returned as a changed path because git never lists
 * its content, except at gitlink (submodule) paths of the base tree. Known git limit: empty directories are not reported.
 */
async function walkClone(root: string, gitlinks: ReadonlySet<string>, relative = ""): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try { entries = await readdir(join(root, relative), { withFileTypes: true }); } catch { throw new Error("scope_unreadable"); }
  for (const entry of entries) {
    const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.name === ".git") { if (relative !== "" && !gitlinks.has(relative)) found.push(path); continue; }
    if (entry.isDirectory()) found.push(...await walkClone(root, gitlinks, path));
  }
  return found;
}

/**
 * Lists every path of `clone` that differs from the base commit: modified, deleted, untracked and ignored files, repo-relative.
 * All git calls use the pristine `base.gitDir` with a fresh temporary index and config, so worker commits, `skip-worktree` and
 * `assume-unchanged` flags and repository configuration in the clone's own `.git` cannot hide or trigger anything.
 * Fails closed: a non-zero git exit, any git stderr output or an unreadable directory throws `scope_unreadable`.
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
    const git = async (...args: string[]): Promise<string> => {
      try {
        const { stdout, stderr } = await execFileAsync("git", [...GIT_CONFIG_FLAGS, ...args], { cwd: clone, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
        if (stderr.trim() !== "") throw new Error("scope_unreadable");
        return stdout;
      } catch { throw new Error("scope_unreadable"); }
    };
    const gitlinks = new Set<string>();
    for (const record of (await git("ls-tree", "-r", "-z", base.commit)).split("\0")) {
      const tab = record.indexOf("\t");
      if (tab > 0 && record.startsWith("160000 ")) gitlinks.add(record.slice(tab + 1));
    }
    const nestedGit = await walkClone(clone, gitlinks);
    await git("read-tree", base.commit);
    await git("update-index", "-q", "--refresh");
    const modified = (await git("diff-files", "--name-only", "-z")).split("\0");
    const untracked = (await git("ls-files", "--others", "-z")).split("\0");
    const ignored = [...scopeIgnore, ...IGNORED_ALWAYS];
    const paths = new Set([...modified, ...untracked].filter((path) => path !== "" && !isInsideGitDir(path)));
    for (const path of nestedGit) paths.add(path);
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

/**
 * Replaces the clone's `.git` with a fresh one taken from the pristine git directory, so worker-written config and hooks cannot run
 * during setup or tests. The index is reset to the base commit only; the worktree keeps the worker's changes.
 */
async function neutralizeGitDir(clone: string, base: ScopeBase): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "oracle-git-"));
  try {
    const env = { PATH: process.env.PATH ?? "", HOME: join(scratch, "home"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    await mkdir(env.HOME, { recursive: true });
    const fresh = join(scratch, "fresh");
    await execFileAsync("git", ["-c", "core.hooksPath=/dev/null", "clone", "--no-checkout", "--quiet", base.gitDir, fresh], { env });
    await rm(join(clone, ".git"), { recursive: true, force: true });
    await cp(join(fresh, ".git"), join(clone, ".git"), { recursive: true });
    await execFileAsync("git", ["-C", clone, "-c", "core.hooksPath=/dev/null", "reset", "-q", base.commit], { env });
  } finally {
    await rm(scratch, { recursive: true, force: true });
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
 * Computes the changed-file scope against the pristine base first, then deletes the ignored state directories from the clone,
 * neutralizes the clone's `.git` and runs the setup commands and the decisive command, which share one deadline of `oracle.timeoutMs`.
 * HOME defaults to a fresh temporary directory; `wrap` rewrites every argv (for example to run it under strace).
 */
export async function scoreImplementation(
  clone: string,
  task: ImplementationTask,
  options: { gitDir: string; home?: string; wrap?: (argv: readonly string[]) => string[] },
): Promise<ImplementationScore> {
  const base = { gitDir: options.gitDir, commit: task.baseCommit };
  const changed = await changedPaths(clone, base, task.scopeIgnore);
  const outOfScope = changed.filter((path) => !task.allowedPaths.some((allowed) => isAllowed(path, allowed)));
  await removeIgnoredDirectories(clone, task.scopeIgnore);
  await neutralizeGitDir(clone, base);
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

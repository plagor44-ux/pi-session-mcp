import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Anchor, ImplementationOracle, ReviewOracle } from "./schemas.js";
import { pathTokens, withoutTrailingDots, withoutUrls } from "./path-tokens.js";

const execFileAsync = promisify(execFile);
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+/;
const HEADING = /^\s{0,3}(#{1,6})\s+(\S.*)$/;

const FENCE_OPEN = /^\s*(?:(`{3,})[^`]*|(~{3,}).*)$/;
const FENCE_CLOSE = /^\s*(?:`{3,}|~{3,})\s*$/;
/** Unwraps review fences before dropping terminated code fences; unterminated openers stay ordinary text. */
function withoutFences(lines: string[], wholeReview = true): string[] {
  const kept: string[] = [];
  // Per fence character, the shortest marker for which a search for a closing line already failed: a later opener of that character and at
  // least that length searches a suffix of the same lines with a stricter test, so it fails too (keeps the work linear).
  const unclosed = new Map<string, number>();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const open = FENCE_OPEN.exec(line);
    if (open) {
      const marker = open[1] ?? open[2] ?? "";
      let close = -1;
      if (marker.length < (unclosed.get(marker[0]!) ?? Infinity)) {
        for (let j = i + 1; j < lines.length; j += 1) {
          const candidate = lines[j] ?? "";
          const trimmed = candidate.trim();
          if (FENCE_CLOSE.test(candidate) && trimmed[0] === marker[0] && trimmed.length >= marker.length) { close = j; break; }
        }
        if (close < 0) unclosed.set(marker[0]!, marker.length);
      }
      if (close >= 0) {
        const info = line.trim().slice(marker.length).trim().toLowerCase();
        const spansReview = wholeReview && lines.slice(0, i).every((part) => part.trim() === "")
          && lines.slice(close + 1).every((part) => part.trim() === "");
        if (spansReview || info === "md" || info === "markdown") kept.push(...withoutFences(lines.slice(i + 1, close), false));
        i = close;
        continue;
      }
    }
    kept.push(line);
  }
  return kept;
}

/** A line holding only one path token, optionally in `**`/backticks, with optional `:line` and trailing `:`; returns the token. */
export function pathOnlyLine(line: string): string | undefined {
  if (!/^\S/.test(line)) return undefined;
  const text = line.trim().toLowerCase();
  const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";
  // The same stripping as repeatedly applying /^(\*\*|`)/, /(\*\*|`|:)$/ and /:\d+(?:-\d+)?$/ until nothing changes, on indices instead of
  // new strings, so a long line of `**` or backticks is linear. `runs` remembers the digit runs before an end position.
  let lo = 0, hi = text.length;
  const runs = new Map<number, [number, number]>();
  const digitsBefore = (end: number): [number, number] => {
    let cached = runs.get(end);
    if (cached === undefined) {
      let a = end;
      while (a > 0 && isDigit(text[a - 1])) a -= 1;
      let b = a;
      if (a < end && text[a - 1] === "-") { b = a - 1; while (b > 0 && isDigit(text[b - 1])) b -= 1; }
      cached = [a, b];
      runs.set(end, cached);
    }
    return cached;
  };
  for (let changed = true; changed;) {
    changed = false;
    if (lo + 2 <= hi && text[lo] === "*" && text[lo + 1] === "*") { lo += 2; changed = true; } else if (lo < hi && text[lo] === "`") { lo += 1; changed = true; }
    if (hi - lo >= 2 && text[hi - 1] === "*" && text[hi - 2] === "*") { hi -= 2; changed = true; } else if (hi > lo && (text[hi - 1] === "`" || text[hi - 1] === ":")) { hi -= 1; changed = true; }
    const [a, b] = digitsBefore(hi);
    if (a < hi && a > lo && text[a - 1] === ":") { hi = a - 1; changed = true; }
    else if (a < hi && a > lo && text[a - 1] === "-" && b < a - 1 && b > lo && text[b - 1] === ":") { hi = b - 1; changed = true; }
  }
  const rest = text.slice(lo, hi);
  const tokens = pathTokens(rest);
  return tokens.length === 1 && tokens[0] === rest ? rest : undefined;
}

/** Heading words are inherited independently of paths, so a located body cannot gain a different file. */
function wordsOfHeading(title: string): string {
  const lower = withoutUrls(title.toLowerCase());
  const paths = new Set(pathTokens(lower));
  return lower.replace(/[a-z0-9_.\-/]+/g, (token) => paths.has(withoutTrailingDots(token)) ? " " : token);
}

/** Longest run of heading path tokens that pathless blocks below the heading inherit; far above any real heading, it bounds the size of every block. */
const MAX_INHERITED_TOKENS_LENGTH = 4096;
function inheritedTokens(tokens: string[]): string {
  let joined = "";
  for (const token of tokens) {
    const next = joined === "" ? token : `${joined} ${token}`;
    if (next.length > MAX_INHERITED_TOKENS_LENGTH) break;
    joined = next;
  }
  return joined;
}

/** A trie over the reversed segments of path tokens: a body path agrees with them when one is a segment suffix of the other, in linear time. */
interface SuffixTrie { children: Map<string, SuffixTrie>; end: boolean }
function suffixTrie(paths: string[]): SuffixTrie {
  const root: SuffixTrie = { children: new Map(), end: false };
  for (const path of paths) {
    const segments = segmentsOf(path);
    if (segments.length === 0) continue;
    let node = root;
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      let child = node.children.get(segments[i]!);
      if (child === undefined) { child = { children: new Map(), end: false }; node.children.set(segments[i]!, child); }
      node = child;
    }
    node.end = true;
  }
  return root;
}
function agreesWithTrie(path: string, trie: SuffixTrie): boolean {
  const segments = segmentsOf(path);
  if (segments.length === 0) return false;
  let node = trie;
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const child = node.children.get(segments[i]!);
    if (child === undefined) return false;
    if (child.end) return true; // a heading path is a segment suffix of the path
    node = child;
  }
  return true; // the path is a segment suffix of a longer heading path
}

interface HeadingEntry { level: number; tokens: string; text: string; words: string }

/**
 * Splits review text into lower-cased blocks.
 * A block ends at a blank line, at a list item that is not nested deeper than the block's first list item, at a heading,
 * at a table row (`|...`, one block per row) and before an unindented `**` line outside a list item that contains a path token
 * (field labels such as `**Why:**` continue the block). Whole-review and md/markdown fences are unwrapped; other terminated
 * fenced code is dropped and neither splits a block nor contributes tokens or terms. An unterminated fence opener is plain text.
 * Headings form a stack by level. The first block gets the heading's non-path words only if the heading names no path
 * or every body path agrees by segment suffix in either direction with a heading path;
 * pathless blocks also get its path tokens (inherited from the nearest enclosing lower-level heading when it has none);
 * a heading without a body is a block itself, with the inherited path prepended.
 * A path-only line (`**src/a.ts**`, `src/a.ts:`) acts as a heading one level below the current one until the next heading,
 * the next path-only line, or a blank line followed by a non-list line. A path-only continuation stays in its current block,
 * except for a bold path-only line, which also starts a pseudo-heading after prose or inside a list.
 * Only the first pseudo-heading inherits a pathless parent's words.
 */
function blocksOf(text: string): string[] {
  const blocks: string[] = [];
  // Heading path tokens and the trie over them, computed once per heading text however many blocks sit below it.
  const headingPaths = new Map<string, { tokens: string[]; trie: SuffixTrie }>();
  const pathsOfHeading = (title: string): { tokens: string[]; trie: SuffixTrie } => {
    let found = headingPaths.get(title);
    if (found === undefined) { const tokens = pathTokens(title.toLowerCase()); found = { tokens, trie: suffixTrie(tokens) }; headingPaths.set(title, found); }
    return found;
  };
  const stack: HeadingEntry[] = [];
  let heading: string | undefined;
  let headingTokens = "";
  let headingWords = "";
  let sectionHasBody = false;
  let current: string[] = [];
  let listIndent: number | undefined;
  let pseudoActive = false;
  let pseudoBlank = false;
  const push = (lines: string[]): void => {
    const body = lines.join("\n").toLowerCase();
    const own = heading !== undefined ? pathsOfHeading(heading) : undefined;
    const bodyPaths = pathTokens(body);
    const agrees = own === undefined || own.tokens.length === 0 || bodyPaths.every((path) => agreesWithTrie(path, own.trie));
    const words = heading !== undefined && !sectionHasBody && agrees ? headingWords : "";
    const tokens = heading !== undefined && bodyPaths.length === 0 ? headingTokens : "";
    blocks.push(`${words}\n${tokens}\n${body}`);
    sectionHasBody = true;
  };
  const flush = (): void => { if (current.length > 0) push(current); current = []; listIndent = undefined; };
  const closeSection = (): void => {
    if (heading === undefined || sectionHasBody) return;
    blocks.push(`${headingWords}\n${headingTokens}`);
  };
  const endPseudo = (): void => {
    if (!pseudoActive) return;
    stack.pop();
    pseudoActive = false;
    const top = stack[stack.length - 1];
    heading = top?.text; headingTokens = top?.tokens ?? ""; headingWords = top?.words ?? ""; sectionHasBody = true;
  };
  const startSection = (level: number, title: string, pseudo: boolean): void => {
    const firstInSection = !sectionHasBody;
    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
    const parent = stack[stack.length - 1];
    heading = title;
    headingTokens = inheritedTokens(pathsOfHeading(title).tokens) || (parent?.tokens ?? "");
    headingWords = wordsOfHeading(title);
    if (pseudo && firstInSection && parent !== undefined && pathsOfHeading(parent.text).tokens.length === 0) {
      headingWords = `${parent.words}\n${headingWords}`;
    }
    stack.push({ level, tokens: headingTokens, text: title, words: headingWords });
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
    if ((current.length === 0 || line.startsWith("**")) && pathOnlyLine(line) !== undefined) {
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
const termPatterns = new Map<string, RegExp>();
const termHits = (block: string, term: string): boolean => {
  let pattern = termPatterns.get(term);
  if (pattern === undefined) {
    if (termPatterns.size >= 1024) termPatterns.clear();
    pattern = new RegExp(`(?<![a-z0-9_])${escapeRegExp(term)}`, "i");
    termPatterns.set(term, pattern);
  }
  return pattern.test(block);
};

const segmentsOf = (path: string): string[] => path.split("/").filter((segment) => segment !== "" && segment !== ".");
const isSegmentSuffix = (suffix: string[], whole: string[]): boolean =>
  suffix.length > 0 && suffix.length <= whole.length && suffix.every((segment, i) => segment === whole[whole.length - suffix.length + i]);

/** The segments of every maximal path-character run of a block, computed once per block text for all anchors of a score. */
type SegmentCache = Map<string, string[][]>;
function runSegments(block: string, cache: SegmentCache): string[][] {
  let runs = cache.get(block);
  if (runs === undefined) {
    runs = [...block.matchAll(/[a-z0-9_.\-/]+/g)].map((match) => segmentsOf(withoutTrailingDots(match[0])));
    cache.set(block, runs);
  }
  return runs;
}

/** True when a maximal path token in the block names the anchor's file: the token's segments are a suffix of the anchor path or vice versa. */
function namesFile(block: string, file: string, cache: SegmentCache): boolean {
  const anchorSegments = segmentsOf(file.toLowerCase());
  return runSegments(block, cache).some((tokenSegments) => isSegmentSuffix(tokenSegments, anchorSegments) || isSegmentSuffix(anchorSegments, tokenSegments));
}

/** The blocks of one score and, per anchor file, the blocks that name it (found once, however many anchors share the file). */
interface ScoreContext { blocks: string[]; segments: SegmentCache; naming: Map<string, string[]> }
function blocksNaming(file: string, context: ScoreContext): string[] {
  let named = context.naming.get(file);
  if (named === undefined) {
    named = context.blocks.filter((block) => namesFile(block, file, context.segments));
    context.naming.set(file, named);
  }
  return named;
}

const anyAnchorHits = (anchors: Anchor[], context: ScoreContext): boolean =>
  anchors.some((anchor) => blocksNaming(anchor.file, context).some((block) => anchor.terms.every((term) => termHits(block, term))));

/*
 * Known limits (task curation validates each review oracle against real review text, so they are caught per task):
 * - negation ("X was not found") is invisible to keyword anchors;
 * - title-first field labels (`**Title:** ... **Location:** src/a.ts ...`) are split before the location;
 * - a heading that names several paths gives all of them to pathless blocks;
 * - a pathless summary heading naming several issues (`# Review: race in cache and SQL injection in query`)
 *   lends all its words to the first block;
 * - anchors cannot name dotfiles or extensionless files (`.env`, `Dockerfile`, `go.mod`).
 */
export interface ReviewScore {
  accepted: boolean; criticalHit: number; criticalTotal: number; recall: number;
  /** Ids of the false findings the review hit; reported, but not decisive (R78). */
  falseFindings: string[];
  /** The task's verdict pattern matched the review text (R78). */
  verdictMatched: boolean;
}

/**
 * Deterministic review oracle: an anchor hits when one block names its file (path-agreeing token) and contains every term from a word start.
 * A review is accepted when the task's verdict pattern matches (flags `im`) and every critical finding is hit (R78); keyword anchors cannot see
 * negation, so false findings are returned for the report but do not decide.
 */
export function scoreReview(text: string, oracle: ReviewOracle): ReviewScore {
  const blocks = blocksOf(text);
  // Equal blocks hit or miss alike, and every anchor is tested against every block that names its file: each distinct block once.
  const context: ScoreContext = { blocks: [...new Set(blocks)], segments: new Map(), naming: new Map() };
  const verdictMatched = new RegExp(oracle.verdict.pattern, "im").test(text);
  const hit = oracle.findings.map((finding) => ({ finding, hit: anyAnchorHits(finding.anchors, context) }));
  const critical = hit.filter((entry) => entry.finding.critical);
  const criticalHit = critical.filter((entry) => entry.hit).length;
  const falseFindings = oracle.falseFindings.filter((finding) => anyAnchorHits(finding.anchors, context)).map((finding) => finding.id);
  return {
    accepted: verdictMatched && criticalHit === critical.length,
    criticalHit, criticalTotal: critical.length, verdictMatched,
    recall: hit.length === 0 ? 1 : hit.filter((entry) => entry.hit).length / hit.length,
    falseFindings,
  };
}

function minimalEnv(home: string, tmpdir: string): NodeJS.ProcessEnv { return { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: tmpdir, CI: "1" }; }

/** Pristine base: a git directory (in production a bare clone made before the worker starts) and the base commit in it. */
export interface ScopeBase { gitDir: string; commit: string }

const GIT_CONFIG_FLAGS = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.hooksPath=/dev/null"];
const IGNORED_ALWAYS = [".codegraph/"];

const isInsideGitDir = (path: string): boolean => path === ".git" || path.startsWith(".git/");

/**
 * Walks the clone without following symlinks and skipping the top-level `.git`. Any permission error fails closed with
 * `scope_unreadable`, and every non-root entry named `.git` (file or directory) is returned as a changed path because git never lists
 * its content. Known git limit: empty directories are not reported.
 */
async function walkClone(root: string, relative = ""): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try { entries = await readdir(join(root, relative), { withFileTypes: true }); } catch { throw new Error("scope_unreadable"); }
  for (const entry of entries) {
    const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.name === ".git") { if (relative !== "") found.push(path); continue; }
    if (entry.isDirectory()) found.push(...await walkClone(root, path));
  }
  return found;
}

/**
 * Lists every path of `clone` that differs from the base commit: modified, deleted, untracked and ignored files, repo-relative.
 * All git calls use the pristine `base.gitDir` with a fresh temporary index and config, so worker commits, `skip-worktree` and
 * `assume-unchanged` flags and repository configuration in the clone's own `.git` cannot hide or trigger anything.
 * Fails closed: a non-zero git exit, any git stderr output or an unreadable directory throws `scope_unreadable`.
 * A base tree containing a submodule throws `base_has_submodules` (R31).
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
    for (const record of (await git("ls-tree", "-r", "-z", base.commit)).split("\0")) {
      if (record.startsWith("160000 ")) throw new Error("base_has_submodules");
    }
    const nestedGit = await walkClone(clone);
    await git("read-tree", base.commit);
    await git("update-index", "-q", "--refresh");
    const modified = (await git("diff-files", "--ignore-submodules=all", "--name-only", "-z")).split("\0");
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
function runArgv(argv: readonly string[], clone: string, home: string, tmpdir: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  const [file, ...args] = argv;
  if (file === undefined || timeoutMs <= 0) return Promise.resolve(false);
  return new Promise((resolvePromise) => {
    let settled = false;
    const settle = (ok: boolean): void => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolvePromise(ok); };
    const child = spawn(file, args, { cwd: clone, env: minimalEnv(home, tmpdir), stdio: "ignore", detached: true });
    const timer = setTimeout(() => { killProcessGroup(child.pid, true); settle(false); }, timeoutMs);
    // Ctrl-C does not wait for an oracle: the group is killed and the command counts as failed.
    const onAbort = (): void => { killProcessGroup(child.pid, true); settle(false); };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
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
 * HOME defaults to a fresh temporary directory and TMPDIR to `<HOME>/tmp` (R33), so tools that honour TMPDIR stay inside HOME;
 * `wrap` rewrites every argv (for example to run it under strace).
 */
export async function scoreImplementation(
  clone: string,
  task: ImplementationTask,
  options: { gitDir: string; home?: string; tmpdir?: string; wrap?: (argv: readonly string[]) => string[]; signal?: AbortSignal },
): Promise<ImplementationScore> {
  const base = { gitDir: options.gitDir, commit: task.baseCommit };
  const changed = await changedPaths(clone, base, task.scopeIgnore);
  const outOfScope = changed.filter((path) => !task.allowedPaths.some((allowed) => isAllowed(path, allowed)));
  await removeIgnoredDirectories(clone, task.scopeIgnore);
  await neutralizeGitDir(clone, base);
  const ownHome = options.home === undefined ? await mkdtemp(join(tmpdir(), "oracle-home-")) : undefined;
  const home = options.home ?? ownHome ?? clone;
  try {
    const tmp = options.tmpdir ?? join(home, "tmp");
    await mkdir(tmp, { recursive: true });
    const deadline = Date.now() + task.oracle.timeoutMs;
    const run = (argv: readonly string[]): Promise<boolean> => runArgv(options.wrap ? options.wrap(argv) : argv, clone, home, tmp, deadline - Date.now(), options.signal);
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

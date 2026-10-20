import { execFile, spawn } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { Anchor, ImplementationOracle, ReviewOracle } from "./schemas.js";

const execFileAsync = promisify(execFile);
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;

/** Splits review text into blocks at blank lines and at list-item starts; continuation lines stay with their item. */
function blocksOf(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = (): void => { if (current.length > 0) blocks.push(current.join("\n").toLowerCase()); current = []; };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (line.trim() === "") { flush(); continue; }
    if (LIST_ITEM.test(line)) flush();
    current.push(line);
  }
  flush();
  return blocks;
}

const PATH_CHAR = /[a-z0-9_.\-/]/;
const PATH_CHAR_NO_SLASH = /[a-z0-9_.\-]/;
/** After a file name: optional `:line`, `:line-line`, `#Lline` or `#Lline-Lline`, optional sentence dots, then no path character. */
const AFTER_NAME = /^(?::\d+(?:-\d+)?|#l\d+(?:-l?\d+)?)?\.*(?![a-z0-9_.\-/])/;

/** True when `name` occurs in the (lower-cased) block delimited by path boundaries; a basename may follow a `/`. */
function occursAsPath(block: string, name: string, allowSlashBefore: boolean): boolean {
  const beforeChars = allowSlashBefore ? PATH_CHAR_NO_SLASH : PATH_CHAR;
  for (let at = block.indexOf(name); at >= 0; at = block.indexOf(name, at + 1)) {
    const before = at === 0 ? "" : block.charAt(at - 1);
    if (before !== "" && beforeChars.test(before)) continue;
    if (AFTER_NAME.test(block.slice(at + name.length))) return true;
  }
  return false;
}

function anchorHits(block: string, anchor: Anchor): boolean {
  const file = anchor.file.toLowerCase();
  const named = occursAsPath(block, basename(file), true) || occursAsPath(block, file, false);
  return named && anchor.terms.every((term) => block.includes(term.toLowerCase()));
}
const anyAnchorHits = (blocks: string[], anchors: Anchor[]): boolean => anchors.some((anchor) => blocks.some((block) => anchorHits(block, anchor)));

export interface ReviewScore { accepted: boolean; criticalHit: number; criticalTotal: number; recall: number; falseFindings: string[] }

/** Deterministic review oracle: an anchor hits when one block names its file (with path boundaries) and contains every term. */
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

/**
 * Lists every path that differs from HEAD, is untracked or is ignored, as repo-relative paths.
 * Parses `-z` porcelain v1: `XY path`, where a rename or copy entry is followed by a second NUL-separated path; both count.
 */
export async function changedPaths(clone: string, scopeIgnore: string[], options: { home?: string } = {}): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"], {
    cwd: clone, env: minimalEnv(options.home ?? clone), encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
  });
  const fields = stdout.split("\0");
  const paths = new Set<string>();
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index] ?? "";
    if (entry.length < 4) continue;
    paths.add(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) { index += 1; const origin = fields[index]; if (origin) paths.add(origin); }
  }
  const ignored = [...scopeIgnore, ".codegraph/"];
  return [...paths].filter((path) => !ignored.some((prefix) => path.startsWith(prefix))).sort();
}

/** Kill a detached process and every descendant in its process group (pattern of `terminateProcessGroup` in src/setup-process.ts). */
function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try { process.kill(-pid, "SIGKILL"); return; } catch { /* already exited or no group */ }
  try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
}

/** Runs an argv list without a shell in the clone; true only on exit code 0 within the timeout. */
function runArgv(argv: readonly string[], clone: string, home: string, timeoutMs: number): Promise<boolean> {
  const [file, ...args] = argv;
  if (file === undefined) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (ok: boolean): void => { if (settled) return; settled = true; clearTimeout(timer); resolve(ok); };
    const child = spawn(file, args, { cwd: clone, env: minimalEnv(home), stdio: "ignore", detached: true });
    const timer = setTimeout(() => { killProcessGroup(child.pid); settle(false); }, timeoutMs);
    child.on("error", () => settle(false));
    child.on("exit", (code) => settle(code === 0));
  });
}

export interface ImplementationScore { accepted: boolean; testsPassed: boolean; outOfScope: string[] }

/** Computes the changed-file scope first, then runs setup commands and the decisive command in the clone. */
export async function scoreImplementation(
  clone: string,
  task: { allowedPaths: string[]; scopeIgnore: string[]; oracle: ImplementationOracle },
  options: { home?: string } = {},
): Promise<ImplementationScore> {
  const home = options.home ?? clone;
  const changed = await changedPaths(clone, task.scopeIgnore, { home });
  const outOfScope = changed.filter((path) => !task.allowedPaths.some((allowed) => path === allowed || path.startsWith(`${allowed}/`)));
  let testsPassed = true;
  for (const setup of task.oracle.setup ?? []) {
    if (!await runArgv(setup, clone, home, task.oracle.timeoutMs)) { testsPassed = false; break; }
  }
  if (testsPassed) testsPassed = await runArgv(task.oracle.command, clone, home, task.oracle.timeoutMs);
  return { accepted: testsPassed && outOfScope.length === 0, testsPassed, outOfScope };
}

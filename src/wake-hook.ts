import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, unlinkSync, watch, type FSWatcher } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { TURN_EVENT_FILE_PATTERN, TURN_EVENT_MAX_BYTES, parseTurnEvent, type TurnEvent } from "./turn-events.js";
import { WRITER_NAME_PATTERN } from "./writer-state.js";

/**
 * The logic of the `pi-session-mcp-wake` hook program (an asyncRewake PostToolUse command hook).
 * No model call and no network: it waits for one content-free spool event of one turn, claims it
 * exactly once, and lets the entry point exit 2 with a single short line on stderr. The line carries
 * identifiers and a state only, never prompt, answer or assistant text.
 */
export interface HookTarget { readonly sessionId: string; readonly turnId: string }
export type TerminalEvent = Extract<TurnEvent, { kind: "turn_terminal" }>;
export type SilentReason = "budget_silent" | "parent_gone" | "lost_claim" | "claim_error" | "claims_unsafe" | "aborted";
export type WaitResult =
  | { readonly action: "wake"; readonly reason: "terminal" | "budget"; readonly message: string; readonly claimPath?: string }
  | { readonly action: "silent"; readonly reason: SilentReason; readonly code?: string };

export const DEFAULT_BUDGET_MS = 1_800_000;
export const SCAN_MAX_ENTRIES_PER_DIRECTORY = 4096;
export const SCAN_MAX_DIRECTORIES = 256;
export const CLAIM_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const CLAIM_CLEANUP_MAX_ENTRIES = 4096;

const WAKE_TOOL_PATTERN = /^mcp__(pi-session-mcp|pi-coding-[a-z][a-z0-9_-]{0,63}-w(?:[1-9]|1[0-6]))__(pi_session_prompt|pi_turn_get)$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANCE_DIR_PATTERN = /^inst-[0-9a-f]{16}$/;
const WRITER_DIR_PREFIX = "writer-";
const MAX_CONTENT_BLOCKS = 32;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const uuid = (value: unknown): string | undefined => (typeof value === "string" && UUID_PATTERN.test(value) ? value : undefined);

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try { const value: unknown = JSON.parse(trimmed); return isObject(value) ? value : undefined; } catch { return undefined; }
}

/**
 * The candidate payloads of a tool response, in the shapes Claude Code delivers MCP results: an object with
 * `structuredContent`, a plain object, a JSON string, or an array of content blocks whose text is JSON.
 * Only these positions are read, one level each; nothing is searched recursively, so text inside a field
 * (an assistant answer that looks like JSON) never becomes a candidate.
 */
export function payloadCandidates(response: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const fromBlocks = (blocks: readonly unknown[]): void => {
    for (const block of blocks.slice(0, MAX_CONTENT_BLOCKS)) {
      if (isObject(block) && block.type === "text" && typeof block.text === "string") { const parsed = parseJsonObject(block.text); if (parsed) out.push(parsed); }
      else if (isObject(block)) out.push(block);
    }
  };
  if (typeof response === "string") { const parsed = parseJsonObject(response); if (parsed) out.push(parsed); }
  else if (Array.isArray(response)) fromBlocks(response);
  else if (isObject(response)) {
    if (isObject(response.structuredContent)) out.push(response.structuredContent);
    out.push(response);
    if (Array.isArray(response.content)) fromBlocks(response.content);
  }
  return out;
}

/**
 * Pure: the (session, turn) a PostToolUse hook input asks to wait for, or `undefined`. Only
 * `pi_session_prompt` and `pi_turn_get` of this product's servers arm, only for `ok: true` and a turn that is still
 * `running`, and only with lowercase UUID identifiers.
 */
export function parseHookInput(text: string): HookTarget | undefined {
  let input: unknown;
  try { input = JSON.parse(text); } catch { return undefined; }
  if (!isObject(input) || typeof input.tool_name !== "string") return undefined;
  const match = WAKE_TOOL_PATTERN.exec(input.tool_name);
  if (!match) return undefined;
  const isPrompt = match[2] === "pi_session_prompt";
  for (const payload of payloadCandidates(input.tool_response)) {
    if (payload.ok !== true || !isObject(payload.turn) || payload.turn.state !== "running") continue;
    const turnId = uuid(payload.turn.turnId);
    const session = isObject(payload.session) ? payload.session : undefined;
    const fromTurn = uuid(payload.turn.sessionId), fromSession = isPrompt ? uuid(session?.id) : undefined;
    if (fromTurn !== undefined && fromSession !== undefined && fromTurn !== fromSession) continue;
    const sessionId = fromSession ?? fromTurn;
    if (turnId !== undefined && sessionId !== undefined) return { sessionId, turnId };
  }
  return undefined;
}

/** `--budget-ms <n>` or `--budget-ms=<n>`: a positive safe integer, otherwise the default. */
export function parseBudgetArgs(argv: readonly string[]): number {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const raw = arg === "--budget-ms" ? argv[i + 1] : arg.startsWith("--budget-ms=") ? arg.slice("--budget-ms=".length) : undefined;
    if (raw === undefined) continue;
    if (!/^[0-9]{1,15}$/.test(raw)) return DEFAULT_BUDGET_MS;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_BUDGET_MS;
  }
  return DEFAULT_BUDGET_MS;
}

export const formatTerminalWake = (event: Pick<TerminalEvent, "session" | "turn" | "state">): string =>
  `pi-session-mcp: turn ${event.turn} of session ${event.session} is ${event.state}. Read it once with pi_turn_get.`;
export const formatBudgetWake = (turnId: string): string =>
  `pi-session-mcp: no event for turn ${turnId} within the wait budget; it may still be running. Read it once with pi_turn_get to re-arm.`;

// ---- spool scan

export interface SpoolCache { readonly files: Map<string, TurnEvent | null> }
export const newSpoolCache = (): SpoolCache => ({ files: new Map() });
export interface ScanLimits { readonly entriesPerDirectory?: number; readonly directories?: number }
export interface ScanResult { readonly events: TurnEvent[]; readonly directories: string[] }

/** Entry names of a directory, at most `cap`, without following the directory itself if it is a link. */
function listNames(dir: string, cap: number): string[] {
  const names: string[] = [];
  let handle;
  try { handle = opendirSync(dir); } catch { return names; }
  try {
    while (names.length < cap) {
      const entry = handle.readSync();
      if (entry === null) break;
      names.push(entry.name);
    }
  } catch { /* partial listing */ } finally { try { handle.closeSync(); } catch { /* closed */ } }
  return names;
}

function isRealDirectory(path: string): boolean {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
}

/** Reads one regular file of at most `TURN_EVENT_MAX_BYTES` without following a link; `undefined` for anything else. */
function readEventText(path: string): { text: string; size: number; mtimeMs: number } | undefined {
  let fd: number | undefined;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.size > TURN_EVENT_MAX_BYTES) return undefined;
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > TURN_EVENT_MAX_BYTES) return undefined;
    const buffer = Buffer.alloc(TURN_EVENT_MAX_BYTES + 1);
    let length = 0;
    for (;;) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
      if (length > TURN_EVENT_MAX_BYTES) return undefined;
    }
    return { text: buffer.toString("utf8", 0, length), size: stat.size, mtimeMs: stat.mtimeMs };
  } catch { return undefined; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ } }
}

/** Directories that can hold events: the root's `inst-*` children and `writer-<name>/inst-*` grandchildren. */
function eventDirectories(root: string, entriesCap: number, dirCap: number): string[] {
  const dirs: string[] = [];
  const visited = { count: 0 };
  const take = (): boolean => { if (visited.count >= dirCap) return false; visited.count += 1; return true; };
  if (!isRealDirectory(root)) return dirs;
  for (const name of listNames(root, entriesCap)) {
    if (visited.count >= dirCap) break;
    const path = join(root, name);
    if (INSTANCE_DIR_PATTERN.test(name)) { if (isRealDirectory(path) && take()) dirs.push(path); continue; }
    if (name.startsWith(WRITER_DIR_PREFIX) && WRITER_NAME_PATTERN.test(name.slice(WRITER_DIR_PREFIX.length)) && isRealDirectory(path) && take()) {
      for (const inner of listNames(path, entriesCap)) {
        if (visited.count >= dirCap) break;
        const innerPath = join(path, inner);
        if (INSTANCE_DIR_PATTERN.test(inner) && isRealDirectory(innerPath) && take()) dirs.push(innerPath);
      }
    }
  }
  return dirs;
}

/**
 * Every valid event below an events root, ordered by time then sequence. Every entry is `lstat`ed and no link is
 * followed; an event file must also name its own directory's instance. `cache` keys parsed files by path, size and mtime.
 */
export function scanTurnEvents(root: string, cache: SpoolCache = newSpoolCache(), limits: ScanLimits = {}): ScanResult {
  const entriesCap = limits.entriesPerDirectory ?? SCAN_MAX_ENTRIES_PER_DIRECTORY, dirCap = limits.directories ?? SCAN_MAX_DIRECTORIES;
  const directories = eventDirectories(root, entriesCap, dirCap);
  const events: TurnEvent[] = [];
  for (const dir of directories) {
    const instance = dir.slice(dir.lastIndexOf(sep) + 1);
    for (const name of listNames(dir, entriesCap)) {
      if (!TURN_EVENT_FILE_PATTERN.test(name)) continue;
      const path = join(dir, name);
      let stat;
      try { stat = lstatSync(path); } catch { continue; }
      if (!stat.isFile() || stat.size > TURN_EVENT_MAX_BYTES) continue;
      const key = `${path}\0${stat.size}\0${stat.mtimeMs}`;
      let event = cache.files.get(key);
      if (event === undefined) {
        const read = readEventText(path);
        event = read === undefined ? null : parseTurnEvent(read.text) ?? null;
        // Not cached when the read failed: the file may be mid-rename or replaced.
        if (read !== undefined) cache.files.set(key, event);
      }
      if (event !== null && event.instance === instance) events.push(event);
    }
  }
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.seq - b.seq);
  return { events, directories };
}

// ---- claims

/** Creates the claims directory (0700) and checks it is a real directory of this user that others cannot write. */
export function prepareClaimsDir(claims: string): void {
  mkdirSync(claims, { recursive: true, mode: 0o700 });
  const stat = lstatSync(claims);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o022) !== 0) throw Object.assign(new Error("claims directory unsafe"), { code: "EUNSAFE" });
}

/** Exactly one waiter wins an event: exclusive create of `<claims>/<instance>-<seq>`. Returns the claim path, or `undefined` when another waiter holds it. */
export function tryClaim(claims: string, event: Pick<TurnEvent, "instance" | "seq">): string | undefined {
  prepareClaimsDir(claims);
  const path = join(claims, `${event.instance}-${event.seq}`);
  try { closeSync(openSync(path, "wx", 0o600)); return path; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
}

export function releaseClaim(path: string | undefined): void {
  if (path === undefined) return;
  try { unlinkSync(path); } catch { /* already gone */ }
}

/** Best effort: removes regular claim files older than `maxAgeMs`, looking at a bounded number of entries. Returns the removed count. */
export function cleanupOldClaims(claims: string, now: number = Date.now(), maxAgeMs: number = CLAIM_MAX_AGE_MS, cap: number = CLAIM_CLEANUP_MAX_ENTRIES): number {
  let removed = 0;
  for (const name of listNames(claims, cap)) {
    const path = join(claims, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || now - stat.mtimeMs <= maxAgeMs) continue;
      unlinkSync(path); removed += 1;
    } catch { /* best effort */ }
  }
  return removed;
}

/** Claims must never live where a container writer can write. */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// ---- waiting

export interface WaitOptions {
  readonly eventsRoot: string;
  readonly claimsDir: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly budgetMs: number;
  readonly pollMs?: number;
  readonly parentCheckMs?: number;
  readonly isParentAlive?: () => boolean;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  readonly limits?: ScanLimits;
  /** Called right after a claim was won and before the wake is returned, so the caller can release it on SIGTERM. */
  readonly onClaim?: (path: string) => void;
}

function errorCode(error: unknown): { code?: string } {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,20}$/.test(code) ? { code } : {};
}

/** Waits for the first `turn_terminal` event of one turn, claims it, and resolves with the wake or the reason to stay silent. */
export async function waitForTurn(options: WaitOptions): Promise<WaitResult> {
  if (isInside(options.eventsRoot, options.claimsDir)) return { action: "silent", reason: "claims_unsafe" };
  const now = options.now ?? Date.now, pollMs = options.pollMs ?? 500, parentCheckMs = options.parentCheckMs ?? 1000;
  const deadline = now() + options.budgetMs;
  const cache = newSpoolCache();
  const watchers = new Map<string, FSWatcher>();
  let poke: (() => void) | undefined;
  const nudge = (): void => { poke?.(); };
  const watchDir = (dir: string): void => {
    if (watchers.has(dir) || watchers.size >= (options.limits?.directories ?? SCAN_MAX_DIRECTORIES) + 1) return;
    try { const watcher = watch(dir, nudge); watcher.on("error", () => undefined); watchers.set(dir, watcher); } catch { /* polling is the fallback */ }
  };
  let nextParentCheck = now() + parentCheckMs;
  try {
    for (;;) {
      if (options.signal?.aborted) return { action: "silent", reason: "aborted" };
      watchDir(options.eventsRoot);
      const { events, directories } = scanTurnEvents(options.eventsRoot, cache, options.limits);
      for (const dir of directories) watchDir(dir);
      const hit = events.find((event): event is TerminalEvent => event.kind === "turn_terminal" && event.session === options.sessionId && event.turn === options.turnId);
      if (hit !== undefined) {
        let claim: string | undefined;
        try { claim = tryClaim(options.claimsDir, hit); } catch (error) { return { action: "silent", reason: "claim_error", ...errorCode(error) }; }
        if (claim === undefined) return { action: "silent", reason: "lost_claim" };
        options.onClaim?.(claim);
        return { action: "wake", reason: "terminal", message: formatTerminalWake(hit), claimPath: claim };
      }
      const t = now();
      if (t >= nextParentCheck) {
        nextParentCheck = t + parentCheckMs;
        if (options.isParentAlive && !options.isParentAlive()) return { action: "silent", reason: "parent_gone" };
      }
      if (t >= deadline) return { action: "wake", reason: "budget", message: formatBudgetWake(options.turnId) };
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.max(1, Math.min(pollMs, deadline - t, nextParentCheck - t)));
        const abort = (): void => done();
        options.signal?.addEventListener("abort", abort, { once: true });
        function done(): void { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); poke = undefined; resolve(); }
        poke = done;
      });
    }
  } finally { for (const watcher of watchers.values()) watcher.close(); }
}

/** The original parent must still be the parent of this process and must still exist. */
export function parentAliveCheck(original: number = process.ppid): () => boolean {
  return () => {
    if (process.ppid !== original) return false;
    try { process.kill(original, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  };
}

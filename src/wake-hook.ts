import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, realpathSync, unlinkSync, watch, type FSWatcher } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { TURN_EVENT_FILE_PATTERN, TURN_EVENT_MAX_BYTES, parseTurnEvent, type TurnEvent } from "./turn-events.js";
import { WRITER_NAME_PATTERN } from "./writer-state.js";

/**
 * The logic of the `pi-session-mcp-wake` hook program (an asyncRewake PostToolUse command hook).
 * No model call and no network: it waits for one content-free spool event of one turn, claims it
 * exactly once, and lets the entry point exit 2 with a single short line on stderr. The line carries
 * identifiers and a state only, never prompt, answer or assistant text.
 *
 * Trust model. An event is a wake trigger only; it carries no instruction and no content. Writer
 * namespaces (`<events>/writer-<name>/`) are writable by the worker inside that writer's container, which
 * can create any file, directory or symlink there. The spool is therefore read defensively:
 * - The accepted namespace follows from the arming tool name: `mcp__pi-session-mcp__*` reads the top-level
 *   `<events>/inst-*` directories only; `mcp__pi-coding-<name>-wN__*` reads exactly `<events>/writer-<name>-wN/inst-*`.
 *   No other writer's directory is listed, and the claim key carries the namespace, so a forged event in
 *   one namespace can neither take nor block a claim of another.
 * - Every directory is opened with `O_NOFOLLOW|O_DIRECTORY`, checked on the handle (a directory of this user)
 *   and read through that handle (`/proc/self/fd/<fd>/<name>` on Linux; elsewhere with `realpath` checks before and
 *   after the read). Event files are opened with `O_NOFOLLOW`, must be regular and small.
 * - Entries, instance directories and cached files are capped; a flooding worker can at most delay or suppress
 *   wakes within its own namespace (the budget wake still fires).
 * - Claims live in a host directory outside the events root, which no container can write.
 */
export type WakeNamespace = { readonly kind: "host" } | { readonly kind: "writer"; readonly name: string };
export interface HookTarget { readonly sessionId: string; readonly turnId: string; readonly namespace: WakeNamespace }
export type TerminalEvent = Extract<TurnEvent, { kind: "turn_terminal" }>;
export type SilentReason = "budget_silent" | "parent_gone" | "lost_claim" | "claim_error" | "claims_unsafe" | "aborted";
export type WaitResult =
  | { readonly action: "wake"; readonly reason: "terminal" | "budget"; readonly message: string; readonly claimPath?: string }
  | { readonly action: "silent"; readonly reason: SilentReason; readonly code?: string };

export const DEFAULT_BUDGET_MS = 1_800_000;
export const SCAN_MAX_ENTRIES_PER_DIRECTORY = 4096;
export const SCAN_MAX_INSTANCE_DIRECTORIES = 64;
export const CACHE_MAX_ENTRIES = 4096;
export const MIN_SCAN_GAP_MS = 25;
export const CLAIM_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const CLAIM_CLEANUP_MAX_ENTRIES = 4096;

const WAKE_TOOL_PATTERN = /^mcp__(?:(pi-session-mcp)|pi-coding-([a-z][a-z0-9_-]{0,63}-w(?:[1-9]|1[0-6])))__(pi_session_prompt|pi_turn_get)$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANCE_DIR_PATTERN = /^inst-[0-9a-f]{16}$/;
const MAX_CONTENT_BLOCKS = 32;
export const HOST_NAMESPACE: WakeNamespace = { kind: "host" };

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
  const isPrompt = match[3] === "pi_session_prompt";
  const writer = match[2];
  if (writer !== undefined && !WRITER_NAME_PATTERN.test(writer)) return undefined;
  const namespace: WakeNamespace = writer === undefined ? HOST_NAMESPACE : { kind: "writer", name: writer };
  for (const payload of payloadCandidates(input.tool_response)) {
    if (payload.ok !== true || !isObject(payload.turn) || payload.turn.state !== "running") continue;
    const turnId = uuid(payload.turn.turnId);
    const session = isObject(payload.session) ? payload.session : undefined;
    const fromTurn = uuid(payload.turn.sessionId), fromSession = isPrompt ? uuid(session?.id) : undefined;
    if (fromTurn !== undefined && fromSession !== undefined && fromTurn !== fromSession) continue;
    const sessionId = fromSession ?? fromTurn;
    if (turnId !== undefined && sessionId !== undefined) return { sessionId, turnId, namespace };
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

export interface SpoolCache { files: Map<string, TurnEvent | null> }
export const newSpoolCache = (): SpoolCache => ({ files: new Map() });
export interface ScanLimits {
  readonly entriesPerDirectory?: number;
  readonly instanceDirectories?: number;
  readonly cacheEntries?: number;
  /** Test seam: `false` forces the `realpath` fallback used where `/proc/self/fd` does not exist. */
  readonly useProcFd?: boolean;
}
export interface ScanResult { readonly events: TurnEvent[]; readonly directories: string[] }

const PROC_FD_AVAILABLE = ((): boolean => { try { return existsSync("/proc/self/fd"); } catch { return false; } })();

/** An opened directory: the handle is what was checked; `path` is the logical location, `expected` its real location. */
interface Dir { readonly fd: number; readonly path: string; readonly expected: string; readonly useProc: boolean }

/** The path through which entries of `dir` are read: its handle on Linux, its location elsewhere. */
const base = (dir: Dir): string => (dir.useProc ? `/proc/self/fd/${dir.fd}` : dir.path);
const entryPath = (dir: Dir, name: string): string => join(base(dir), name);

/** Where a directory that was opened is still the same place; only the fallback can drift, a handle cannot. */
function stillThere(dir: Dir): boolean {
  if (dir.useProc) return true;
  try { return realpathSync(dir.path) === dir.expected; } catch { return false; }
}

/**
 * Opens one directory without following a link at its last component and checks, on the handle, that it is a
 * directory of this user. Below a parent it is opened through the parent's handle where `/proc/self/fd` exists.
 */
function openDir(parent: Dir | undefined, nameOrRoot: string, useProc: boolean): Dir | undefined {
  let fd: number | undefined;
  try {
    const path = parent === undefined ? nameOrRoot : join(parent.path, nameOrRoot);
    const target = parent !== undefined && useProc ? entryPath(parent, nameOrRoot) : path;
    fd = openSync(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) { closeSync(fd); return undefined; }
    const expected = parent === undefined ? (useProc ? path : realpathSync(path)) : join(parent.expected, nameOrRoot);
    const dir: Dir = { fd, path, expected, useProc };
    if (!stillThere(dir)) { closeSync(fd); return undefined; }
    return dir;
  } catch {
    if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ }
    return undefined;
  }
}

/** Entry names of a directory, at most `cap`. */
function listNames(path: string, cap: number): string[] {
  const names: string[] = [];
  let handle;
  try { handle = opendirSync(path); } catch { return names; }
  try {
    while (names.length < cap) {
      const entry = handle.readSync();
      if (entry === null) break;
      names.push(entry.name);
    }
  } catch { /* partial listing */ } finally { try { handle.closeSync(); } catch { /* closed */ } }
  return names;
}

/** Reads one regular file of at most `TURN_EVENT_MAX_BYTES` without following a link; `undefined` for anything else. */
function readEventText(path: string): string | undefined {
  let fd: number | undefined;
  try {
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
    return buffer.toString("utf8", 0, length);
  } catch { return undefined; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ } }
}

/** The `inst-*` children of a directory, newest first, at most `cap`; only real directories count. */
function newestInstanceDirectories(dir: Dir, entriesCap: number, cap: number): string[] {
  const found: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of listNames(base(dir), entriesCap)) {
    if (!INSTANCE_DIR_PATTERN.test(name)) continue;
    try { const stat = lstatSync(entryPath(dir, name)); if (stat.isDirectory()) found.push({ name, mtimeMs: stat.mtimeMs }); } catch { /* vanished */ }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : 1));
  return found.slice(0, cap).map((entry) => entry.name);
}

/**
 * The valid events of one namespace below an events root, ordered by time then sequence: the top-level `inst-*`
 * directories for the host, exactly `writer-<name>/inst-*` for a writer. Nothing outside that namespace is listed.
 * Every directory is opened `O_NOFOLLOW`, checked on its handle and read through it; no link is followed. An event
 * file must also sit in the directory of its own instance. `cache` is rebuilt per scan from the files seen in it
 * (keyed by path, size and mtime) and never holds more than `cacheEntries`.
 */
export function scanTurnEvents(root: string, namespace: WakeNamespace = HOST_NAMESPACE, cache: SpoolCache = newSpoolCache(), limits: ScanLimits = {}): ScanResult {
  const useProc = limits.useProcFd ?? PROC_FD_AVAILABLE;
  const entriesCap = limits.entriesPerDirectory ?? SCAN_MAX_ENTRIES_PER_DIRECTORY, instanceCap = limits.instanceDirectories ?? SCAN_MAX_INSTANCE_DIRECTORIES;
  const cacheCap = limits.cacheEntries ?? CACHE_MAX_ENTRIES;
  const events: TurnEvent[] = [], directories: string[] = [], opened: Dir[] = [];
  const seen = new Map<string, TurnEvent | null>();
  try {
    const rootDir = openDir(undefined, root, useProc);
    if (rootDir === undefined) return { events, directories };
    opened.push(rootDir);
    let space: Dir | undefined = rootDir;
    if (namespace.kind === "writer") {
      if (!WRITER_NAME_PATTERN.test(namespace.name)) return { events, directories };
      space = openDir(rootDir, `writer-${namespace.name}`, useProc);
      if (space === undefined) return { events, directories };
      opened.push(space);
    }
    directories.push(space.path);
    for (const name of newestInstanceDirectories(space, entriesCap, instanceCap)) {
      const dir = openDir(space, name, useProc);
      if (dir === undefined) continue;
      opened.push(dir);
      directories.push(dir.path);
      const found: TurnEvent[] = [];
      for (const file of listNames(base(dir), entriesCap)) {
        if (!TURN_EVENT_FILE_PATTERN.test(file)) continue;
        const path = entryPath(dir, file);
        let stat;
        try { stat = lstatSync(path); } catch { continue; }
        if (!stat.isFile() || stat.size > TURN_EVENT_MAX_BYTES) continue;
        const key = `${dir.path}/${file}\0${stat.size}\0${stat.mtimeMs}`;
        let event = seen.get(key) ?? cache.files.get(key);
        if (event === undefined) {
          const text = readEventText(path);
          if (text === undefined) continue; // mid-rename or replaced: not cached, read again next scan
          event = parseTurnEvent(text) ?? null;
        }
        if (seen.size < cacheCap) seen.set(key, event);
        if (event !== null && event.instance === name) found.push(event);
      }
      if (stillThere(dir) && stillThere(space)) events.push(...found);
    }
  } finally {
    for (const dir of opened) try { closeSync(dir.fd); } catch { /* closed */ }
    cache.files = seen; // only what this scan saw: a replaced or removed file leaves the cache
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

/** `host-<instance>-<seq>` or `writer-<name>-wN-<instance>-<seq>`: the namespace is part of the key, and every part is validated. */
export function claimKey(namespace: WakeNamespace, event: Pick<TurnEvent, "instance" | "seq">): string {
  if (!INSTANCE_DIR_PATTERN.test(event.instance) || !Number.isSafeInteger(event.seq) || event.seq < 1) throw Object.assign(new Error("claim key invalid"), { code: "EKEY" });
  if (namespace.kind === "host") return `host-${event.instance}-${event.seq}`;
  if (!WRITER_NAME_PATTERN.test(namespace.name)) throw Object.assign(new Error("claim key invalid"), { code: "EKEY" });
  return `writer-${namespace.name}-${event.instance}-${event.seq}`;
}

/** Exactly one waiter wins an event: exclusive create of `<claims>/<claimKey>`. Returns the claim path, or `undefined` when another waiter holds it. */
export function tryClaim(claims: string, event: Pick<TurnEvent, "instance" | "seq">, namespace: WakeNamespace): string | undefined {
  const key = claimKey(namespace, event);
  prepareClaimsDir(claims);
  const path = join(claims, key);
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
  readonly namespace: WakeNamespace;
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
    if (watchers.has(dir) || watchers.size >= (options.limits?.instanceDirectories ?? SCAN_MAX_INSTANCE_DIRECTORIES) + 3) return;
    try { const watcher = watch(dir, nudge); watcher.on("error", () => undefined); watchers.set(dir, watcher); } catch { /* polling is the fallback */ }
  };
  let nextParentCheck = now() + parentCheckMs;
  let lastScan = 0;
  try {
    for (;;) {
      if (options.signal?.aborted) return { action: "silent", reason: "aborted" };
      // A worker that churns its own directory must not make this loop spin: scans are at least a short gap apart.
      const gap = MIN_SCAN_GAP_MS - (Date.now() - lastScan);
      if (gap > 0) await new Promise<void>((resolve) => setTimeout(resolve, gap));
      lastScan = Date.now();
      watchDir(options.eventsRoot);
      const { events, directories } = scanTurnEvents(options.eventsRoot, options.namespace, cache, options.limits);
      for (const dir of directories) watchDir(dir);
      const hit = events.find((event): event is TerminalEvent => event.kind === "turn_terminal" && event.session === options.sessionId && event.turn === options.turnId);
      if (hit !== undefined) {
        let claim: string | undefined;
        try { claim = tryClaim(options.claimsDir, hit, options.namespace); } catch (error) { return { action: "silent", reason: "claim_error", ...errorCode(error) }; }
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

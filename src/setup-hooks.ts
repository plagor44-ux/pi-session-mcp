import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { readWriterState, writerEventDeliveryEnabled, writerPaths, writerRegistrationName, writersRoot, WRITER_NAME_PATTERN } from "./writer-state.js";
import type { OwnershipAccess, OwnershipRecord } from "./setup-ownership.js";
import type { SetupFinding, SetupOperation, SetupStatus, SetupTarget } from "./setup-result.js";

/**
 * The wake hook of ADR 0011 in Claude Code settings.
 *
 * Contract, not version (ADR 0004): Claude Code has no command for hooks, so there is no client
 * version gate and no command to inspect. The entry follows Claude Code's settings schema
 * (`hooks.PostToolUse[]` with `matcher`, and `hooks[]` of `type: "command"` with `command`,
 * `timeout` in seconds and `asyncRewake`). Setup writes that entry and verify checks the file
 * content only; whether the running client honours it is the acceptance check of the release.
 *
 * Settings files by Claude Code scope (documented client behaviour):
 * - user: `${CLAUDE_CONFIG_DIR ?? ~/.claude}/settings.json`
 * - project: `<project>/.claude/settings.json`
 * - local: `<project>/.claude/settings.local.json`
 * A project is the canonical (realpath) working directory, like the project skill slot. An
 * entry written while a session is running may need a session restart (or the client's own
 * settings reload) before it fires; setup cannot observe that.
 *
 * Ownership is the same pending-before-write transaction as skills: the pending record names the
 * entry about to be written (and, for an update, the owned entry it replaces) by fingerprint, so
 * an interrupted run is settled from the file alone. Records hold fingerprints only, never paths
 * or command strings.
 */
export const WAKE_HOOK_ALIAS = "hook:pi-session-mcp-wake";
/** Default wake budget; the hook timeout must cover it (ADR 0011, item 4). */
export const WAKE_BUDGET_MS = 1_800_000;
/** Seconds added to the budget so the hook timeout never fires before the program's own budget. */
export const WAKE_TIMEOUT_MARGIN_SECONDS = 60;
export const WAKE_MATCHER = [
  "mcp__pi-session-mcp__pi_session_prompt",
  "mcp__pi-session-mcp__pi_turn_get",
  "mcp__pi-coding-.*__pi_session_prompt",
  "mcp__pi-coding-.*__pi_turn_get",
].join("|");
/** A command referencing this program path marks an entry as pi-session-mcp's. */
const WAKE_PROGRAM = /\/dist\/wake-main\.js(?=$|[\s"'])/;
/** Paths are embedded unquoted in a shell command: only characters that never need quoting. */
const SAFE_COMMAND_PATH = /^\/[A-Za-z0-9_@%+=:,./-]*$/;
const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;

export type HookScope = "user" | "project" | "local";
export interface WakeHookRoots {
  /** Absolute package root; the program is `<packageRoot>/dist/wake-main.js`. */
  readonly packageRoot: string;
  readonly home: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Defaults to `process.execPath`, like the registration fingerprint. */
  readonly nodePath?: string;
  readonly budgetMs?: number;
}
/** Crash-relevant points, observed only by tests: after the pending record, and after the settings rename. */
export type HookCheckpoint = "pending-recorded" | "written";
export interface WakeHookDependencies {
  readonly checkpoint?: (step: HookCheckpoint) => void | Promise<void>;
  /** Test seam: called after the temporary file is durable and before the compare-and-swap check. */
  readonly beforeCommit?: () => void | Promise<void>;
}
export interface WakeHookRequest {
  readonly operation: SetupOperation;
  readonly scope: HookScope;
  readonly roots: WakeHookRoots;
  /** Whether the server configuration enables `events.delivery: "spool"`. */
  readonly enabled: boolean;
  readonly ownership: OwnershipAccess;
  readonly dependencies?: WakeHookDependencies;
  /**
   * Shared entries: asked when an exactly owned entry would be removed (remove, rollback, or
   * delivery turned off). `true` keeps the entry and its record for another registration that
   * still needs it (`hook_kept_shared`). See `localHookNeededByOthers`.
   */
  readonly keep?: () => Promise<boolean>;
}
export interface WakeHookOutcome { readonly status: SetupStatus; readonly code: string }

class HookError extends Error { constructor(readonly code: string) { super(code); } }
/** The settings file changed between read and rename. */
class SwapMismatch extends Error {}

export interface WakeHookEntry {
  readonly matcher: string;
  readonly hooks: readonly [{ readonly type: "command"; readonly command: string; readonly timeout: number; readonly asyncRewake: true }];
}

/** The canonical, deterministic entry. Throws `hook_path_unsafe` for a path that would need shell quoting. */
export function buildWakeEntry(roots: Pick<WakeHookRoots, "packageRoot" | "nodePath" | "budgetMs">): WakeHookEntry {
  const nodePath = roots.nodePath ?? process.execPath;
  const program = `${roots.packageRoot}/dist/wake-main.js`;
  const budgetMs = roots.budgetMs ?? WAKE_BUDGET_MS;
  if (!Number.isInteger(budgetMs) || budgetMs < 1) throw new HookError("hook_budget_invalid");
  if (!isAbsolute(roots.packageRoot) || !SAFE_COMMAND_PATH.test(nodePath) || !SAFE_COMMAND_PATH.test(program)) throw new HookError("hook_path_unsafe");
  return {
    matcher: WAKE_MATCHER,
    hooks: [{ type: "command", command: `${nodePath} ${program} --budget-ms ${budgetMs}`, timeout: Math.ceil(budgetMs / 1000) + WAKE_TIMEOUT_MARGIN_SECONDS, asyncRewake: true }],
  };
}

/** The settings file of a scope. `projectRoot` must already be canonical. Pure. */
export function wakeSettingsPath(scope: HookScope, input: { readonly home: string; readonly env: Readonly<Record<string, string | undefined>>; readonly projectRoot?: string }): string {
  if (scope === "user") {
    const configured = input.env.CLAUDE_CONFIG_DIR;
    const directory = configured !== undefined && configured !== "" ? configured : join(input.home, ".claude");
    if (!isAbsolute(directory)) throw new HookError("settings_location_invalid");
    return join(directory, "settings.json");
  }
  if (input.projectRoot === undefined || !isAbsolute(input.projectRoot)) throw new HookError("settings_location_invalid");
  return join(input.projectRoot, ".claude", scope === "project" ? "settings.json" : "settings.local.json");
}

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
/** The fingerprint of an entry: sha256 of its JSON text, which is also what setup wrote. */
export const wakeEntryFingerprint = (entry: unknown): string => sha256(JSON.stringify(entry));

interface Location {
  readonly file: string;
  readonly recordTarget: SetupTarget;
}

/**
 * Where the scope's settings live and how its ownership is keyed. A project may be untrusted: a
 * link at `.claude` or at the settings file there makes the slot invalid, so setup never writes
 * outside the project. In the operator's own configuration directory a linked settings file (for
 * example into a dotfiles checkout) is followed and written through. Project and local records
 * are bound to an opaque identity of the project, so another project never shares them.
 */
/** The ownership key of a scope's hook. It looks at no settings file: only the project's canonical directory. */
async function recordTargetOf(scope: HookScope, roots: Pick<WakeHookRoots, "cwd">): Promise<SetupTarget> {
  if (scope === "user") return { client: "claude-code", scope, alias: WAKE_HOOK_ALIAS };
  return { client: "claude-code", scope, alias: `${WAKE_HOOK_ALIAS}@${sha256(await realpath(roots.cwd)).slice(0, 16)}` };
}

async function locate(scope: HookScope, roots: WakeHookRoots): Promise<Location> {
  if (scope === "user") {
    const file = wakeSettingsPath("user", roots);
    return { file: await followUserLink(file), recordTarget: { client: "claude-code", scope, alias: WAKE_HOOK_ALIAS } };
  }
  let projectRoot: string;
  try { projectRoot = await realpath(roots.cwd); } catch { throw new HookError("settings_location_invalid"); }
  const file = wakeSettingsPath(scope, { ...roots, projectRoot });
  for (const [path, directory] of [[dirname(file), true], [file, false]] as const) {
    let entry;
    try { entry = await lstat(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw new HookError("settings_location_invalid"); }
    if (entry.isSymbolicLink() || (directory ? !entry.isDirectory() : !entry.isFile())) throw new HookError("settings_location_invalid");
  }
  const identity = sha256(projectRoot).slice(0, 16);
  return { file, recordTarget: { client: "claude-code", scope, alias: `${WAKE_HOOK_ALIAS}@${identity}` } };
}

async function followUserLink(file: string): Promise<string> {
  let entry;
  try { entry = await lstat(file); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // An absent file is fine; the directory, if it exists, must be one.
      try { if (!(await stat(dirname(file))).isDirectory()) throw new HookError("settings_location_invalid"); }
      catch (inner) { if (inner instanceof HookError) throw inner; if ((inner as NodeJS.ErrnoException).code !== "ENOENT") throw new HookError("settings_location_invalid"); }
      return file;
    }
    throw new HookError("settings_location_invalid");
  }
  if (entry.isFile()) return file;
  if (!entry.isSymbolicLink()) throw new HookError("settings_location_invalid");
  try {
    const real = await realpath(file);
    if (!(await lstat(real)).isFile()) throw new Error("not a file");
    return real;
  } catch { throw new HookError("settings_location_invalid"); }
}

interface Snapshot {
  readonly exists: boolean;
  /** `absent`, or the sha256 of the bytes read. */
  readonly token: string;
  readonly mode: number;
  readonly document: Record<string, unknown>;
}

async function readSnapshot(file: string): Promise<Snapshot> {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { exists: false, token: "absent", mode: 0o600, document: {} };
    throw new HookError(code === "ELOOP" || code === "ENOTDIR" ? "settings_location_invalid" : "settings_unreadable");
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new HookError("settings_location_invalid");
    if (info.size > MAX_SETTINGS_BYTES) throw new HookError("settings_unparseable");
    const bytes = await handle.readFile();
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new HookError("settings_unparseable"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HookError("settings_unparseable");
    return { exists: true, token: sha256(bytes), mode: info.mode & 0o7777, document: parsed as Record<string, unknown> };
  } catch (error) {
    throw error instanceof HookError ? error : new HookError("settings_unreadable");
  } finally { await handle.close().catch(() => undefined); }
}

async function currentToken(file: string): Promise<string> {
  try { return sha256(await readFile(file)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent"; throw new HookError("settings_unreadable"); }
}

/**
 * Writes the document next to the file and swaps it in only while the file still has the bytes
 * that were read. The final compare happens right before the rename; a creation uses a hard link
 * so it can never replace a file that appeared meanwhile. A residual window between the compare
 * and the rename remains and is why a mismatch retries the whole read-modify-write.
 */
async function commit(file: string, before: Snapshot, document: Record<string, unknown>, dependencies: WakeHookDependencies): Promise<void> {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${randomUUID()}.pi-session-mcp.tmp`);
  const mode = before.exists ? before.mode : 0o600;
  let installed = false;
  try {
    const handle = await open(temporary, "wx", mode);
    try { await handle.chmod(mode); await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await dependencies.beforeCommit?.();
    if (await currentToken(file) !== before.token) throw new SwapMismatch();
    if (before.exists) await rename(temporary, file);
    else {
      try { await link(temporary, file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new SwapMismatch(); throw error; }
    }
    installed = true;
    await syncDirectory(directory);
  } finally {
    if (!installed || !before.exists) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

interface PostToolUse { readonly document: Record<string, unknown>; readonly entries: unknown[] | undefined }
function postToolUse(document: Record<string, unknown>): PostToolUse {
  const hooks = document.hooks;
  if (hooks === undefined) return { document, entries: undefined };
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) throw new HookError("settings_shape_invalid");
  const entries = (hooks as Record<string, unknown>).PostToolUse;
  if (entries === undefined) return { document, entries: undefined };
  if (!Array.isArray(entries)) throw new HookError("settings_shape_invalid");
  return { document, entries };
}
const referencesWake = (entry: unknown): boolean => {
  if (!entry || typeof entry !== "object") return false;
  const hooks = (entry as { hooks?: unknown }).hooks;
  return Array.isArray(hooks) && hooks.some((hook) => !!hook && typeof hook === "object" && typeof (hook as { command?: unknown }).command === "string" && WAKE_PROGRAM.test((hook as { command: string }).command));
};
/** Indexes of pi-session-mcp's entries, and of those that setup's record names exactly. */
function classify(entries: readonly unknown[] | undefined, record: OwnershipRecord | undefined): { all: number[]; named: number[] } {
  const all: number[] = []; const named: number[] = [];
  (entries ?? []).forEach((entry, index) => {
    if (!referencesWake(entry)) return;
    all.push(index);
    if (record && wakeEntryFingerprint(entry) === record.fingerprint) named.push(index);
  });
  return { all, named };
}

/**
 * Settles a record from the file alone. A pending record whose entry is present becomes owned;
 * one that still shows the entry it replaces returns to owning that entry; otherwise nothing of
 * the transaction reached the file and the record is dropped.
 */
function settle(record: OwnershipRecord | undefined, entries: readonly unknown[] | undefined): OwnershipRecord | undefined {
  if (!record || record.phase === "owned") return record;
  const present = (fingerprint: string): boolean => (entries ?? []).some((entry) => referencesWake(entry) && wakeEntryFingerprint(entry) === fingerprint);
  if (present(record.fingerprint)) return { target: record.target, fingerprint: record.fingerprint, previous: "absent", phase: "owned", transactionId: record.transactionId };
  if (record.replaces !== undefined && present(record.replaces)) return { target: record.target, fingerprint: record.replaces, previous: "absent", phase: "owned", transactionId: record.transactionId };
  return undefined;
}

const healthy = (ownership: OwnershipAccess): void => { ownership.assertHealthy?.(); };

function edited(document: Record<string, unknown>, change: (entries: unknown[]) => void, cleanup: boolean): Record<string, unknown> {
  const next = JSON.parse(JSON.stringify(document)) as Record<string, unknown>;
  const hooks = (next.hooks ??= {}) as Record<string, unknown>;
  const entries = (hooks.PostToolUse ??= []) as unknown[];
  change(entries);
  // Only structures that setup's entry left empty and nothing else uses are removed; any other
  // content keeps its (possibly empty) array.
  if (cleanup && entries.length === 0 && Object.keys(hooks).length === 1 && Object.keys(next).length === 1) delete next.hooks;
  return next;
}

/** Install, update, verify or remove the wake hook of one Claude Code scope. Never throws. */
export async function runWakeHook(request: WakeHookRequest): Promise<WakeHookOutcome> {
  try { return await reconcile(request); }
  catch (error) { return { status: "failed", code: error instanceof HookError ? error.code : "hook_install_failed" }; }
}

async function reconcile(request: WakeHookRequest): Promise<WakeHookOutcome> {
  // Delivery off and no record of ours: nothing to maintain, so the client's settings are not even looked at
  // (an unparseable or linked file there is not setup's business). Removal follows the record and checks it itself.
  if (!request.enabled && request.operation !== "remove" && request.operation !== "rollback" && !await ownsWakeHook(request.scope, request.roots, request.ownership)) {
    return { status: "unchanged", code: "hook_not_enabled" };
  }
  const location = await locate(request.scope, request.roots);
  const dependencies = request.dependencies ?? {};
  // A changed file is re-read once from the start; the second change fails.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return await step(request, location, dependencies); }
    catch (error) { if (!(error instanceof SwapMismatch)) throw error; }
  }
  throw new HookError("settings_changed");
}

async function step(request: WakeHookRequest, location: Location, dependencies: WakeHookDependencies): Promise<WakeHookOutcome> {
  const { operation, ownership, roots, enabled } = request;
  const { recordTarget, file } = location;
  const apply = operation === "apply";
  const removing = operation === "remove" || operation === "rollback";
  const mutating = apply || removing;
  const snapshot = await readSnapshot(file);
  const { entries } = postToolUse(snapshot.document);
  healthy(ownership);
  const stored = await ownership.get(recordTarget);
  const record = settle(stored, entries);
  // `recovered` is true when settling changed what the ledger says.
  const recovered = stored !== undefined && (record === undefined || record.fingerprint !== stored.fingerprint || record.phase !== stored.phase);
  const persistSettled = async (): Promise<void> => {
    if (!mutating || !recovered) return;
    healthy(ownership);
    if (record) await ownership.put(record); else await ownership.delete(recordTarget);
    healthy(ownership);
  };
  // Settling comes first, so that a refusal below never leaves a transaction pending that the file already decided.
  await persistSettled();
  const { all, named } = classify(entries, record);

  if (removing || (!enabled && operation !== "verify")) {
    // Removal needs no configuration: it follows the record, and only an exactly owned entry goes.
    if (!record) return { status: "unchanged", code: removing ? "hook_not_owned" : "hook_not_enabled" };
    if (named.length > 1 || (named.length === 0 && all.length > 0)) return { status: "divergent", code: "hook_divergent" };
    if (named.length === 0) {
      if (mutating) { healthy(ownership); await ownership.delete(recordTarget); healthy(ownership); }
      return { status: mutating ? "ok" : "unchanged", code: mutating ? "hook_absent" : "hook_not_enabled" };
    }
    if (request.keep && await request.keep()) return { status: "unchanged", code: "hook_kept_shared" };
    if (!mutating) return { status: "planned", code: "hook_remove_planned" };
    await commit(file, snapshot, edited(snapshot.document, (list) => { list.splice(named[0]!, 1); }, true), dependencies);
    await dependencies.checkpoint?.("written");
    healthy(ownership); await ownership.delete(recordTarget); healthy(ownership);
    return { status: "ok", code: "hook_removed" };
  }

  if (operation === "verify") {
    if (!enabled) return record && named.length > 0 ? { status: "failed", code: "hook_delivery_off" } : { status: "unchanged", code: "hook_not_enabled" };
    const canonical = buildWakeEntry(roots);
    const fingerprint = wakeEntryFingerprint(canonical);
    const present = all.filter((index) => wakeEntryFingerprint(entries![index]) === fingerprint);
    if (all.length === 0) return { status: "failed", code: "hook_missing" };
    if (all.length !== 1 || present.length !== 1) return { status: "failed", code: "hook_not_equivalent" };
    if (stored?.phase === "pending") return { status: "failed", code: "hook_ownership_pending" };
    if (!record || record.fingerprint !== fingerprint) return { status: "failed", code: "hook_not_owned" };
    try { if (!(await lstat(`${roots.packageRoot}/dist/wake-main.js`)).isFile()) throw new Error("not a file"); }
    catch { return { status: "failed", code: "hook_program_missing" }; }
    return { status: "ok", code: "hook_verified" };
  }

  const canonical = buildWakeEntry(roots);
  const fingerprint = wakeEntryFingerprint(canonical);
  let replaces: string | undefined;
  let place: (list: unknown[]) => void;
  let verb: "add" | "update";
  if (all.length === 0) { verb = "add"; place = (list) => { list.push(canonical); }; }
  else if (all.length === 1) {
    const index = all[0]!;
    const current = wakeEntryFingerprint(entries![index]);
    if (current === fingerprint) {
      return { status: apply && recovered ? "ok" : "unchanged", code: apply && recovered ? "hook_recovered" : "hook_already_equivalent" };
    }
    // Only an entry that setup's own record names exactly may be replaced; anything else is the operator's.
    if (!record || record.fingerprint !== current) return { status: "divergent", code: "hook_divergent" };
    verb = "update"; replaces = current; place = (list) => { list[index] = canonical; };
  } else return { status: "divergent", code: "hook_divergent" };

  if (!apply) return { status: "planned", code: `hook_${verb}_planned` };
  const pending: OwnershipRecord = {
    target: recordTarget, fingerprint, previous: "absent", phase: "pending", transactionId: randomUUID(),
    ...(replaces === undefined ? {} : { replaces }),
  };
  healthy(ownership); await ownership.put(pending); healthy(ownership);
  await dependencies.checkpoint?.("pending-recorded");
  await commit(file, snapshot, edited(snapshot.document, place, false), dependencies);
  await dependencies.checkpoint?.("written");
  healthy(ownership); await ownership.put({ target: recordTarget, fingerprint, previous: "absent", phase: "owned", transactionId: pending.transactionId }); healthy(ownership);
  return { status: "ok", code: verb === "add" ? "hook_added" : "hook_updated" };
}

export interface InstallWakeHookOptions {
  readonly scope: HookScope;
  readonly cwd: string;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly ownership: OwnershipAccess;
  /** false: dry-run. */
  readonly apply: boolean;
  readonly packageRoot: string;
  /** Whether the registration's server configuration enables spool delivery; false removes an owned hook. */
  readonly delivery: boolean;
  readonly nodePath?: string;
  readonly budgetMs?: number;
  readonly dependencies?: WakeHookDependencies;
}
/** Reconcile the hook of one scope, for example a writer's local scope. Call under the ownership transaction. */
export async function installWakeHook(options: InstallWakeHookOptions): Promise<SetupFinding> {
  const outcome = await runWakeHook({
    operation: options.apply ? "apply" : "dry-run", scope: options.scope, enabled: options.delivery, ownership: options.ownership,
    roots: { packageRoot: options.packageRoot, home: options.home, cwd: options.cwd, env: options.env, ...(options.nodePath === undefined ? {} : { nodePath: options.nodePath }), ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }) },
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  });
  return { target: { client: "claude-code", scope: options.scope, alias: WAKE_HOOK_ALIAS }, ...outcome };
}

/** Whether setup holds a record for the hook of this scope (and, for project and local, this project). */
export async function ownsWakeHook(scope: HookScope, roots: Pick<WakeHookRoots, "home" | "cwd" | "env">, ownership: OwnershipAccess): Promise<boolean> {
  try { return (await ownership.get(await recordTargetOf(scope, roots))) !== undefined; }
  catch { return false; }
}

/** Companion of a registration, like the skill installer: runs after the registration succeeded. */
export interface SetupHookInstaller {
  run(operation: SetupOperation, target: SetupTarget, ownership: OwnershipAccess): Promise<readonly SetupFinding[]>;
  /** Whether setup still owns a hook of exactly this registration target. */
  owns(target: SetupTarget, ownership: OwnershipAccess): Promise<boolean>;
}
export interface SetupHookRoots extends WakeHookRoots {
  /**
   * The registered server configuration. With it, a local-scope removal keeps the entry while a
   * writer registration of the same project still needs it.
   */
  readonly configPath?: string;
  /** Whether the server configuration setup registers enables spool delivery. */
  readonly delivery: () => Promise<boolean>;
}
export class FileSetupHookInstaller implements SetupHookInstaller {
  constructor(private readonly roots: SetupHookRoots, private readonly dependencies: WakeHookDependencies = {}) {}

  async run(operation: SetupOperation, target: SetupTarget, ownership: OwnershipAccess): Promise<readonly SetupFinding[]> {
    const reported: SetupTarget = { ...target, alias: WAKE_HOOK_ALIAS };
    if (target.client !== "claude-code" || !["user", "project", "local"].includes(target.scope)) return [{ target: reported, status: "unchanged", code: "hook_not_applicable" }];
    let enabled = false;
    // Removal follows the record; only the other operations depend on the configuration.
    if (operation !== "remove" && operation !== "rollback") {
      try { enabled = await this.roots.delivery(); }
      catch { return [{ target: reported, status: "failed", code: "hook_config_unreadable" }]; }
    }
    const { delivery: _delivery, configPath, ...roots } = this.roots;
    const keep = configPath !== undefined && target.scope === "local"
      ? () => localHookNeededByOthers({ ownership, home: roots.home, cwd: roots.cwd, configPath, except: "host" })
      : undefined;
    const outcome = await runWakeHook({ operation, scope: target.scope as HookScope, roots, enabled, ownership, dependencies: this.dependencies, ...(keep ? { keep } : {}) });
    return [{ target: reported, ...outcome }];
  }

  async owns(target: SetupTarget, ownership: OwnershipAccess): Promise<boolean> {
    if (target.client !== "claude-code" || !["user", "project", "local"].includes(target.scope)) return false;
    return ownsWakeHook(target.scope as HookScope, this.roots, ownership);
  }
}

/**
 * The sharing rule of the local-scope entry. Claude Code's local settings file of a project holds
 * one wake entry, and one ownership record stands for it, however many registrations need it.
 * It is removed only when none of the others needs it any more. Another registration needs it
 * when it is still owned in local scope and its server enables spool delivery:
 *
 * - a writer (`claude-code:local:pi-coding-<name>` owned) whose configured workspace resolves to
 *   this project and whose own configuration enables delivery; a writer whose project cannot be
 *   determined counts as needing it (the safe side: an entry too many, never one too few);
 * - the host registration (`claude-code:local:pi-session-mcp` owned) while the host configuration
 *   enables delivery. Its project is not recorded, so it counts for every project.
 *
 * `except` names the registration that is going away: a writer by its name, or the host.
 * Any error answers `true`, so a doubt never removes a shared entry.
 */
export async function localHookNeededByOthers(options: {
  readonly ownership: OwnershipAccess;
  readonly home: string;
  readonly cwd: string;
  readonly configPath: string;
  readonly except: "host" | { readonly writer: string };
}): Promise<boolean> {
  try {
    const project = await realpath(options.cwd);
    const { loadConfig } = await import("./config.js");
    const config = await loadConfig(options.configPath);
    if (options.except !== "host") {
      const host = await options.ownership.get({ client: "claude-code", scope: "local", alias: "pi-session-mcp" });
      if (host?.phase === "owned" && config.eventDelivery === "spool") return true;
    }
    let names: string[];
    try { names = await readdir(writersRoot(options.home)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    for (const name of names.filter((candidate) => WRITER_NAME_PATTERN.test(candidate)).sort()) {
      if (options.except !== "host" && options.except.writer === name) continue;
      const record = await options.ownership.get({ client: "claude-code", scope: "local", alias: writerRegistrationName(name) });
      if (record?.phase !== "owned") continue;
      if (!await writerEventDeliveryEnabled(writerPaths(options.home, name).config)) continue;
      const state = await readWriterState(options.home, name);
      const workspace = state ? config.workspaces.get(state.alias) : undefined;
      if (workspace === undefined) return true;
      try { if (await realpath(workspace) === project) return true; }
      catch { return true; }
    }
    return false;
  } catch { return true; }
}

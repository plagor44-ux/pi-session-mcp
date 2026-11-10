import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, type Stats } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { catalogBuiltInProviderIds } from "./model-catalog.js";
import { flockBinary, lockWithFlock, OverrideLockError } from "./override-lock.js";
import { assertSupportedFilesystem, currentSetupPlatform, openLockedDarwin } from "./setup-platform.js";
import { ProviderStoreError, SUPPORTED_PROVIDER_APIS, type ProviderStore, type ProviderDefinition, type ProviderStoreSnapshot, type CredentialSource, type BuiltInProviders } from "./provider-store-contract.js";

const ID = /^[A-Za-z0-9@][A-Za-z0-9._:@\/-]{0,255}$/;
type Entry = { source: "none" } | { source: "key"; key: string; binding: string };
interface State { credentials: Record<string, Entry>; definitions: ProviderDefinition[] }
// Retain values from runtime snapshots, including rotated keys still used by live sessions.
const redactionValues = new Set<string>();
export function providerSecretValues(): readonly string[] { return [...redactionValues]; }
function fail(code: ConstructorParameters<typeof ProviderStoreError>[0]): never { throw new ProviderStoreError(code); }
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const errno = (e: unknown, code: string): boolean => (e as NodeJS.ErrnoException)?.code === code;
const safe = async <T>(fn: () => Promise<T>): Promise<T> => { try { return await fn(); } catch (e) { throw e instanceof ProviderStoreError ? e : new ProviderStoreError("provider_store_unavailable"); } };
const keyValid = (key: unknown): key is string => typeof key === "string" && key.length >= 1 && key.length <= 4096 && !/[\s\x00-\x1f\x7f-\x9f]/u.test(key);

export function isLoopbackProvider(definition: ProviderDefinition): boolean {
  const host = new URL(definition.baseUrl).hostname.toLowerCase();
  return host === "localhost" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function definitionValid(value: unknown): value is ProviderDefinition {
  if (record(value) && Object.keys(value).some(k => !["id", "api", "baseUrl", "models"].includes(k))) return false;
  if (!record(value) || typeof value.id !== "string" || !ID.test(value.id) || !(SUPPORTED_PROVIDER_APIS as readonly unknown[]).includes(value.api) || typeof value.baseUrl !== "string") return false;
  try {
    const url = new URL(value.baseUrl);
    if (/[\s\x00-\x1f\x7f?#]/u.test(value.baseUrl) || /^[a-z]+:\/\/[^/?#]*@/i.test(value.baseUrl) || url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackProvider(value as unknown as ProviderDefinition)))) return false;
  } catch { return false; }
  if (!Array.isArray(value.models) || value.models.length === 0) return false;
  const ids = new Set<string>();
  return value.models.every((m: unknown) => {
    if (record(m) && Object.keys(m).some(k => !["id", "name", "contextWindow", "maxTokens", "reasoning", "input"].includes(k))) return false;
    if (!record(m) || typeof m.id !== "string" || !ID.test(m.id) || ids.has(m.id) || (m.name !== undefined && (typeof m.name !== "string" || m.name.length === 0 || /[\x00-\x1f\x7f]/.test(m.name))) || typeof m.reasoning !== "boolean" || !Number.isSafeInteger(m.contextWindow) || Number(m.contextWindow) <= 0 || !Number.isSafeInteger(m.maxTokens) || Number(m.maxTokens) <= 0 || !Array.isArray(m.input) || m.input.length === 0 || !m.input.every(i => i === "text" || i === "image")) return false;
    ids.add(m.id); return true;
  });
}
function identity(id: string, definitions: readonly ProviderDefinition[]): string {
  const def = definitions.find(d => d.id === id);
  return def ? `custom:${id}:${new URL(def.baseUrl).origin}` : `builtin:${id}`;
}
function snapshot(state: State, builtins: readonly string[]): ProviderStoreSnapshot {
  return { definitions: structuredClone(state.definitions).sort((a, b) => a.id.localeCompare(b.id)), sources: Object.entries(state.credentials).sort(([a], [b]) => a.localeCompare(b)).map(([providerId, entry]) => ({ providerId, source: entry.source, bindingValid: (builtins.includes(providerId) || state.definitions.some(d => d.id === providerId)) && (entry.source === "none" || entry.binding === identity(providerId, state.definitions)) })) };
}
async function stat(path: string): Promise<Stats | undefined> {
  try { return await lstat(path); } catch (e) { if (errno(e, "ENOENT")) return undefined; throw e; }
}
function verify(s: Stats, directory = false): void {
  if (s.uid !== process.getuid?.() || (s.mode & 0o7777) !== (directory ? 0o700 : 0o600) || (directory ? !s.isDirectory() : !s.isFile()) || (!directory && s.nlink !== 1)) fail("provider_store_unavailable");
}
function same(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
async function readJson(path: string): Promise<unknown | undefined> {
  const before = await stat(path);
  if (!before) return undefined;
  verify(before);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat(); verify(opened);
    if (!same(before, opened)) fail("provider_store_unavailable");
    const text = await handle.readFile("utf8");
    const after = await lstat(path);
    if (!same(opened, after)) fail("provider_store_unavailable");
    try { return JSON.parse(text) as unknown; } catch { return fail("provider_store_invalid"); }
  } finally { await handle.close(); }
}
async function checkParents(directory: string): Promise<void> {
  for (const path of [dirname(dirname(directory)), dirname(directory)]) {
    const parent = await stat(path);
    if (parent && !parent.isDirectory()) fail("provider_store_unavailable");
  }
}
async function checkDirectory(directory: string, create: boolean): Promise<Stats | undefined> {
  // A linked .config or product directory must not relocate secrets into a workspace.
  await checkParents(directory);
  let s = await stat(directory);
  if (!s && create) {
    // Create with the exact mode: the umask would narrow it, and repairing a path afterwards could follow a link.
    // Only the short-lived CLI mutates the store, and the synchronous call keeps the umask change out of other work.
    const previous = process.umask(0o077);
    try { mkdirSync(directory, { recursive: true, mode: 0o700 }); } finally { process.umask(previous); }
    s = await lstat(directory);
  }
  if (s) {
    await checkParents(directory);
    verify(s, true);
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { if (!same(s, await handle.stat())) fail("provider_store_unavailable"); } finally { await handle.close(); }
  }
  return s;
}
function parseCredentials(value: unknown): Record<string, Entry> {
  const credentials: Record<string, Entry> = Object.create(null) as Record<string, Entry>;
  if (value === undefined) return credentials;
  if (!record(value) || Object.keys(value).length !== 2 || value.v !== 1 || !record(value.providers)) fail("provider_store_invalid");
  for (const [id, entry] of Object.entries(value.providers)) {
    if (!ID.test(id) || !record(entry)) fail("provider_store_invalid");
    if (entry.source === "none" && Object.keys(entry).length === 1) credentials[id] = { source: "none" };
    else if (entry.source === "key" && Object.keys(entry).length === 3 && keyValid(entry.key) && typeof entry.binding === "string" && entry.binding.length <= 8192) credentials[id] = { source: "key", key: entry.key, binding: entry.binding };
    else fail("provider_store_invalid");
  }
  return credentials;
}

/** Refresh before synchronous history recording, including host-relayed writer sessions after rotation. */
export function refreshProviderRedactionValues(options: { home?: string } = {}): void {
  if (process.env.PI_SESSION_MCP_WRITER_GUARD) return; // The writer's immutable boundary was read by its runtime policy.
  let fd: number | undefined;
  try {
    const directory = location(options.home);
    for (const path of [dirname(dirname(directory)), dirname(directory)]) {
      try { if (!lstatSync(path).isDirectory()) fail("provider_store_unavailable"); }
      catch (error) { if (!errno(error, "ENOENT")) throw error; }
    }
    let dir: Stats;
    try { dir = lstatSync(directory); } catch (error) { if (errno(error, "ENOENT")) return; throw error; }
    verify(dir, true);
    const path = join(directory, "credentials.json");
    let before: Stats;
    try { before = lstatSync(path); } catch (error) { if (errno(error, "ENOENT")) return; throw error; }
    verify(before);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd); verify(opened);
    if (!same(before, opened)) fail("provider_store_unavailable");
    let value: unknown;
    try { value = JSON.parse(readFileSync(fd, "utf8")) as unknown; } catch { fail("provider_store_invalid"); }
    if (!same(opened, lstatSync(path)) || !same(dir, lstatSync(directory))) fail("provider_store_unavailable");
    for (const entry of Object.values(parseCredentials(value))) if (entry.source === "key") redactionValues.add(entry.key);
  } catch (error) { throw error instanceof ProviderStoreError ? error : new ProviderStoreError("provider_store_unavailable"); }
  finally { if (fd !== undefined) closeSync(fd); }
}

async function readState(directory: string): Promise<State> {
  const before = await checkDirectory(directory, false);
  if (!before) return { credentials: {}, definitions: [] };
  const lock = await stat(join(directory, ".lock")); if (lock) verify(lock);
  const c = await readJson(join(directory, "credentials.json"));
  const d = await readJson(join(directory, "providers.json"));
  const credentials = parseCredentials(c);
  let definitions: ProviderDefinition[] = [];
  if (d !== undefined) {
    if (!record(d) || Object.keys(d).length !== 2 || d.v !== 1 || !Array.isArray(d.providers) || !d.providers.every(definitionValid) || new Set(d.providers.map(p => p.id)).size !== d.providers.length) fail("provider_store_invalid");
    definitions = d.providers;
  }
  if (!same(before, await lstat(directory))) fail("provider_store_unavailable");
  for (const entry of Object.values(credentials)) if (entry.source === "key") redactionValues.add(entry.key);
  return { credentials, definitions };
}
async function atomic(directory: string, name: string, value: unknown): Promise<void> {
  const dir = (await checkDirectory(directory, false))!;
  const destination = join(directory, name);
  const existing = await stat(destination); if (existing) verify(existing);
  const temporary = join(directory, `.${name}-${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.chmod(0o600);
    const created = await handle.stat(); verify(created);
    await handle.writeFile(JSON.stringify(value) + "\n"); await handle.sync();
    if (!same(created, await lstat(temporary))) fail("provider_store_unavailable");
    if (!same(dir, await lstat(directory))) fail("provider_store_unavailable");
    const current = await stat(destination);
    if (current) { verify(current); if (!existing || !same(existing, current)) fail("provider_store_unavailable"); }
    else if (existing) fail("provider_store_unavailable");
    await handle.close();
    await rename(temporary, destination);
    // A revocation that a crash could undo would fail open; make the rename itself durable.
    const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await parent.sync(); } finally { await parent.close(); }
  } finally { await handle.close(); await unlink(temporary).catch(() => undefined); }
}
async function locked<T>(directory: string, fn: () => Promise<T>): Promise<T> {
  await checkDirectory(directory, true);
  const path = join(directory, ".lock");
  const platform = currentSetupPlatform();
  if (!platform) fail("provider_store_unavailable");
  await assertSupportedFilesystem(directory, platform);
  const before = await stat(path); if (before) verify(before);
  let handle;
  try {
    handle = platform === "darwin"
      ? await openLockedDarwin(path, { timeoutMs: 2000 })
      : await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    if (!before) await handle.chmod(0o600); // A new lock file; an existing one was verified above.
    const opened = await handle.stat(); verify(opened);
    if (before && !same(before, opened)) fail("provider_store_unavailable");
    if (platform === "linux") {
      const binary = flockBinary({}); if (!binary) fail("provider_store_unavailable");
      await lockWithFlock(binary, handle.fd, 2000, undefined);
    }
    const linked = await lstat(path); verify(linked);
    if (!same(opened, linked)) fail("provider_store_unavailable");
    // A stable kernel lock is released on process death; never unlink its inode.
    return await fn();
  } catch (error) {
    if ((error instanceof OverrideLockError && error.code === "override_lock_busy") || (error instanceof Error && error.message === "ownership_lock_busy")) fail("provider_store_busy");
    throw error;
  } finally { await handle?.close(); }
}
const location = (home?: string): string => join(home ?? userInfo().homedir, ".config", "pi-session-mcp", "providers");
/** The store directory, which confined read-only tools must never expose. */
export const providerStoreDirectory = (home?: string): string => location(home);

export function openProviderStore(options: { home?: string } = {}): ProviderStore {
  const directory = location(options.home);
  const mutate = (fn: (state: State) => Promise<void>): Promise<void> => safe(() => locked(directory, async () => fn(await readState(directory))));
  const saveCredentials = (s: State) => atomic(directory, "credentials.json", { v: 1, providers: s.credentials });
  const known = (s: State, id: string, o: BuiltInProviders) => { if (!ID.test(id) || (!o.builtInProviderIds.includes(id) && !s.definitions.some(d => d.id === id))) fail("provider_unknown"); };
  return {
    read: () => safe(async () => {
      const state = await readState(directory);
      const builtins = Object.keys(state.credentials).length === 0 && state.definitions.length === 0 ? [] : await catalogBuiltInProviderIds(undefined, () => loadProviderPolicy(options));
      return snapshot(state, builtins);
    }),
    setKey: (id, key, o) => { if (!keyValid(key)) return Promise.reject(new ProviderStoreError("credential_invalid")); return mutate(async s => { known(s, id, o); s.credentials[id] = { source: "key", key, binding: identity(id, s.definitions) }; await saveCredentials(s); }); },
    removeKey: (id, o) => mutate(async s => { known(s, id, o); s.credentials[id] = { source: "none" }; await saveCredentials(s); }),
    inherit: (id, o) => mutate(async s => {
      // An entry for a provider that no longer exists can only be deleted; deleting grants nothing.
      if (ID.test(id) && Object.hasOwn(s.credentials, id) && !o.builtInProviderIds.includes(id) && !s.definitions.some(d => d.id === id)) { delete s.credentials[id]; await saveCredentials(s); return; }
      known(s, id, o); if (s.definitions.some(d => d.id === id)) fail("provider_inherit_unsupported"); delete s.credentials[id]; await saveCredentials(s); }),
    addProvider: (definition, o) => {
      if (!definitionValid(definition)) return Promise.reject(new ProviderStoreError("provider_definition_invalid"));
      return mutate(async s => { if (o.builtInProviderIds.includes(definition.id) || s.definitions.some(d => d.id === definition.id)) fail("provider_id_conflict"); await atomic(directory, "providers.json", { v: 1, providers: [...s.definitions, definition] }); });
    },
    removeProvider: id => mutate(async s => {
      if (!s.definitions.some(d => d.id === id)) fail("provider_unknown");
      // Revoke first: interruption leaves a keyless custom provider, never inherited auth.
      // Repeating removal safely completes the second write; no transaction journal is needed.
      delete s.credentials[id]; await saveCredentials(s);
      await atomic(directory, "providers.json", { v: 1, providers: s.definitions.filter(d => d.id !== id) });
    }),
  };
}

export interface ProviderPolicyRuntime {
  getProviders(): readonly { readonly id: string }[];
  registerProvider: ModelRuntime["registerProvider"];
  setRuntimeApiKey: ModelRuntime["setRuntimeApiKey"];
}
export interface ProviderPolicy {
  apply(runtime: ProviderPolicyRuntime): Promise<void>;
  source(providerId: string): CredentialSource;
  blocked(providerId: string): boolean;
  boundaryCredentials(providers: readonly string[]): Record<string, unknown>;
  definitions(providers?: readonly string[]): readonly ProviderDefinition[];
}
/** One immutable launch/runtime snapshot. Keys never escape except to a runtime, redactor or selected writer boundary. */
export async function loadProviderPolicy(options: { home?: string; writerAgentDirectory?: string } = {}): Promise<ProviderPolicy> {
  return safe(async () => {
    const writer = options.writerAgentDirectory;
    const state = writer === undefined ? await readState(location(options.home)) : { credentials: {}, definitions: [] } as State;
    if (writer !== undefined) {
      const value = await readJson(join(writer, "provider-definitions.json"));
      if (value !== undefined) {
        if (!record(value) || value.v !== 1 || !Array.isArray(value.providers) || !value.providers.every(definitionValid)) fail("provider_store_invalid");
        state.definitions = value.providers;
        if (!record(value.sources)) fail("provider_store_invalid");
        const auth = await readJson(join(writer, "auth.json"));
        for (const [id, source] of Object.entries(value.sources)) {
          if (!ID.test(id) || !["inherit", "none", "key"].includes(String(source))) fail("provider_store_invalid");
          if (source === "none") state.credentials[id] = { source: "none" };
          if (source === "key") {
            const entry = record(auth) ? auth[id] : undefined;
            if (!record(entry) || entry.type !== "api_key" || !keyValid(entry.key)) state.credentials[id] = { source: "none" };
            else { state.credentials[id] = { source: "key", key: entry.key, binding: identity(id, state.definitions) }; redactionValues.add(entry.key); }
          }
          if (source === "inherit" && state.definitions.some(d => d.id === id)) fail("provider_store_invalid");
        }
      }
    }
    const custom = new Set(state.definitions.map(d => d.id));
    const source = (id: string): CredentialSource => state.credentials[id]?.source ?? (custom.has(id) ? "none" : "inherit");
    const valid = (id: string): boolean => { const e = state.credentials[id]; return e?.source === "key" && e.binding === identity(id, state.definitions); };
    let builtinIds: ReadonlySet<string> | undefined;
    const known = (id: string): boolean => custom.has(id) || builtinIds === undefined || builtinIds.has(id);
    const blocked = (id: string): boolean => source(id) === "none" || (source(id) === "key" && (!known(id) || !valid(id)));
    return {
      source, blocked,
      async apply(runtime) {
        return safe(async () => {
        if (state.definitions.length === 0 && !Object.values(state.credentials).some(e => e.source === "key")) return;
        const builtin = new Set(runtime.getProviders().map(p => p.id));
        builtinIds = builtin;
        for (const d of state.definitions) {
          if (builtin.has(d.id)) fail("provider_id_conflict");
          runtime.registerProvider(d.id, { name: d.id, baseUrl: d.baseUrl, api: d.api, models: d.models.map(m => ({ ...m, name: m.name ?? m.id, input: [...m.input], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })) });
        }
        for (const [id, e] of Object.entries(state.credentials)) {
          if (e.source === "key" && valid(id) && (builtin.has(id) || custom.has(id))) await runtime.setRuntimeApiKey(id, e.key);
        }
        });
      },
      boundaryCredentials: ids => Object.fromEntries(ids.flatMap(id => { const e = state.credentials[id]; return e?.source === "key" && valid(id) && known(id) ? [[id, { type: "api_key", key: e.key }]] : []; })),
      definitions: ids => structuredClone(state.definitions.filter(d => ids === undefined || ids.includes(d.id))),
    };
  });
}

/** The guarded inner server uses only its private boundary agent directory, never the host store. */
export function loadRuntimeProviderPolicy(): Promise<ProviderPolicy> {
  return loadProviderPolicy(process.env.PI_SESSION_MCP_WRITER_GUARD ? { writerAgentDirectory: process.env.PI_CODING_AGENT_DIR ?? "/pi/agent" } : {});
}

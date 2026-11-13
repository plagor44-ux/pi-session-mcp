import type { Readable } from "node:stream";
import type { ReadStream } from "node:tty";
import { loadConfig } from "./config.js";
import { CATALOG_ID_PATTERN, createCredentialFreeModelCatalog, createModelCatalog, type ModelCatalog } from "./model-catalog.js";
import { ProviderStoreError, SUPPORTED_PROVIDER_APIS, type CredentialSource, type ProviderDefinition, type ProviderStore, type ProviderStoreSnapshot, type SupportedProviderApi } from "./provider-store-contract.js";
import { openProviderStore } from "./provider-store.js";
import { readProviderKey } from "./provider-key-input.js";
import { runBundledPi, type PiAuthMode } from "./provider-sign-in.js";

export interface ProviderCliDependencies {
  store?: ProviderStore;
  /**
   * The offline catalog. `credentials` is true only for `list`, the one command that reports authentication presence,
   * which comes from Pi's credential store. Every other command needs provider identities only and gets a catalog that
   * reads no stored credential and runs no key command (#304).
   */
  catalog?: (options: { readonly credentials: boolean }) => Promise<ModelCatalog>;
  input?: Readable & Partial<Pick<ReadStream, "isTTY" | "isRaw" | "setRawMode">>;
  /** Whether stderr is a terminal; defaults to `process.stderr.isTTY === true`. */
  stderrTerminal?: boolean;
  /** Runs the bundled Pi CLI and resolves its exit status; defaults to `runBundledPi` (ADR 0022). */
  runPi?: (args: readonly string[], mode: PiAuthMode) => Promise<number>;
  stdout(text: string): void;
  stderr(text: string): void;
  configPath?: string;
  loadConfig?: typeof loadConfig;
}
class Failure extends Error { constructor(readonly code: string, readonly exit: 1 | 3 | 4 | 64) { super(code); } }
const fail = (code: string, exit: 1 | 3 | 4 | 64): never => { throw new Failure(code, exit); };
const safeId = (id: string | undefined): id is string => id !== undefined && CATALOG_ID_PATTERN.test(id);
/** Pi's file store only where authentication presence is reported (#304). */
const defaultCatalog = ({ credentials }: { readonly credentials: boolean }): Promise<ModelCatalog> =>
  credentials ? createModelCatalog() : createCredentialFreeModelCatalog();
/** A provider's stored source; a provider without an entry is `inherit`. */
const sourceIn = (snapshot: ProviderStoreSnapshot, id: string): CredentialSource => snapshot.sources.find(s => s.providerId === id)?.source ?? "inherit";

function definition(args: readonly string[]): ProviderDefinition {
  const id = args[0];
  if (!safeId(id)) return fail("provider_definition_invalid", 4);
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--reasoning" || arg === "--image") {
      if (flags.has(arg)) return fail("usage_invalid", 64);
      flags.add(arg);
    } else if (["--api", "--base-url", "--model", "--context-window", "--max-tokens"].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("--") || values.has(arg)) return fail("usage_invalid", 64);
      values.set(arg, value);
    } else return fail("usage_invalid", 64);
  }
  const api = values.get("--api"), baseUrl = values.get("--base-url"), modelIds = values.get("--model")?.split(",");
  if (!api || !baseUrl || !modelIds) return fail("usage_invalid", 64);
  const contextWindow = Number(values.get("--context-window") ?? "128000"), maxTokens = Number(values.get("--max-tokens") ?? "8192");
  let url: URL;
  try { url = new URL(baseUrl); } catch { return fail("provider_definition_invalid", 4); }
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (!(SUPPORTED_PROVIDER_APIS as readonly string[]).includes(api) || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash || !url.hostname || !modelIds.length || modelIds.some(m => !safeId(m)) || new Set(modelIds).size !== modelIds.length || !Number.isSafeInteger(contextWindow) || contextWindow < 1 || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > contextWindow) return fail("provider_definition_invalid", 4);
  return { id, api: api as SupportedProviderApi, baseUrl, models: modelIds.map(model => ({ id: model, contextWindow, maxTokens, reasoning: flags.has("--reasoning"), input: flags.has("--image") ? ["text", "image"] : ["text"] })) };
}

export async function runProviderCli(argv: readonly string[], io: ProviderCliDependencies): Promise<0 | 1 | 3 | 4 | 64> {
  try {
    const [command, ...args] = argv;
    let def: ProviderDefinition | undefined;
    if (command === "add") def = definition(args);
    else if (command === "list") { if (args.length > 1 || (args.length === 1 && args[0] !== "--json")) return fail("usage_invalid", 64); }
    else if (command === "auth") {
      if (!(["set", "remove", "inherit", "login", "logout"].includes(args[0] ?? "")) || !safeId(args[1])
        || (args[0] === "set" ? !(args.length === 2 || (args.length === 3 && args[2] === "--stdin"))
          : args[0] === "login" ? !(args.length === 2 || (args.length === 3 && args[2] === "--no-browser"))
          : args.length !== 2)) return fail("usage_invalid", 64);
      if (args[0] === "set" && args.length === 2 && !(io.input ?? process.stdin).isTTY) return fail("usage_invalid", 64);
      // Typed into --stdin a key would echo; the hidden prompt is the terminal route.
      if (args[0] === "set" && args.length === 3 && (io.input ?? process.stdin).isTTY) return fail("usage_invalid", 64);
      // Pi's sign-in talks to the owner on the terminal. This keeps pipes out; a pseudo-terminal passes, so agents stay out by rule (ADR 0022).
      if (args[0] === "login" && !((io.input ?? process.stdin).isTTY === true && (io.stderrTerminal ?? process.stderr.isTTY === true))) return fail("usage_invalid", 64);
    } else if (command === "remove") { if (args.length !== 1 || !safeId(args[0])) return fail("usage_invalid", 64); }
    else return fail("usage_invalid", 64);
    const store = io.store ?? openProviderStore();
    const snapshot = await store.read();
    const catalog = await (io.catalog ?? defaultCatalog)({ credentials: command === "list" });
    const custom = new Set(snapshot.definitions.map(d => d.id));
    const providers = catalog.providers().filter(p => safeId(p.id));
    const builtInProviderIds = providers.filter(p => !custom.has(p.id)).map(p => p.id);
    const options = { builtInProviderIds };
    if (command === "list") {
      const ids = [...new Set([...providers.map(p => p.id), ...snapshot.definitions.map(d => d.id).filter(safeId)])].sort();
      const rows = ids.map(id => {
        const source = snapshot.sources.find(s => s.providerId === id);
        return { id, kind: custom.has(id) ? "custom" : "built-in", source: source?.source ?? "inherit", ...(source?.source === "key" ? { bindingValid: source.bindingValid } : {}), authConfigured: providers.find(p => p.id === id)?.authConfigured ?? false };
      });
      io.stdout(JSON.stringify(rows, null, args.includes("--json") ? 0 : 2) + "\n");
    } else if (command === "add") await store.addProvider(def!, options);
    else if (command === "remove") {
      const path = io.configPath ?? process.env.PI_SESSION_MCP_CONFIG;
      if (path) {
        let profiles;
        try { profiles = [...(await (io.loadConfig ?? loadConfig)(path)).executionProfiles.values()]; }
        catch { return fail("config_invalid", 1); }
        if (profiles.some(p => p.provider === args[0])) return fail("provider_in_use", 1);
      }
      await store.removeProvider(args[0]!);
    } else if (command === "auth") {
      const [action, id] = args as [string, string];
      if (action === "set") {
        if (!builtInProviderIds.includes(id) && !custom.has(id)) return fail("provider_unknown", 3);
        // Guidance belongs to the hidden prompt only; --stdin keeps its plain output for scripts.
        const terminal = args.length === 2;
        const replacing = snapshot.sources.some(s => s.providerId === id && s.source === "key");
        if (terminal && replacing) io.stderr(`A key is already stored for ${id}. A new key replaces it; an empty entry keeps it.\n`);
        if (terminal) io.stderr(`Enter the key for ${id} (input is hidden): `);
        const key = await readProviderKey(io.input ?? process.stdin, !terminal);
        if (terminal) io.stderr("\n");
        if (!key) return fail("credential_invalid", 4);
        await store.setKey(id, key, options);
        if (terminal) io.stderr(`${id}: ${replacing ? "key replaced" : "key stored"}\n`);
      } else if (action === "remove") await store.removeKey(id, options);
      else if (action === "inherit") await store.inherit(id, options);
      else {
        // Account sign-in (ADR 0022): Pi's own command runs as a child; only its exit status returns.
        if (!builtInProviderIds.includes(id) && !custom.has(id)) return fail("provider_unknown", 3);
        if (custom.has(id) || providers.find(p => p.id === id)?.signIn !== true) return fail("sign_in_unsupported", 4);
        const runPi = io.runPi ?? runBundledPi;
        const status = async (piArgs: readonly string[], mode: PiAuthMode): Promise<number> => { try { return await runPi(piArgs, mode); } catch { return 1; } };
        const source = sourceIn(snapshot, id);
        if (action === "login") {
          if (source === "key") {
            io.stderr(`A key is stored for ${id} and takes precedence over a sign-in. "pi-session-mcp-provider auth inherit ${id}" drops the key; "pi-session-mcp-provider auth remove ${id}" disables the provider.\n`);
            return fail("provider_key_stored", 4);
          }
          io.stderr(`Signing in to ${id} through Pi. Where Pi suggests "pi auth login", run "pi-session-mcp-provider auth login".\n`);
          if (await status(["auth", "login", id, ...(args[2] === "--no-browser" ? ["--no-browser"] : [])], "terminal") !== 0) return fail("sign_in_failed", 1);
          // A provider set to none uses the new sign-in only if nobody changed its source meanwhile: the store
          // checks it under its lock. After Pi has run, every store error reads as one code, so 3, 4 and 64
          // never follow a sign-in.
          if (source === "none") {
            try { await store.inherit(id, options, "none"); }
            catch { return fail("provider_store_unavailable", 1); }
          }
        } else {
          // none first: an interrupted sign-out leaves the provider disabled, never still signed in. Only from
          // inherit, checked under the store's lock, so a key stored meanwhile stays.
          if (source === "inherit") await store.removeKey(id, options, "inherit");
          if (await status(["auth", "logout", id], "silent") !== 0) return fail("sign_out_failed", 1);
        }
      }
    }
    if (command !== "list") io.stdout("ok\n");
    return 0;
  } catch (error) {
    let code = "provider_store_unavailable"; let exit: 1 | 3 | 4 | 64 = 1;
    if (error instanceof Failure) { code = error.code; exit = error.exit; }
    else if (error instanceof ProviderStoreError) {
      code = error.code;
      if (code === "provider_unknown") exit = 3;
      else if (["provider_definition_invalid", "provider_id_conflict", "provider_inherit_unsupported", "credential_invalid"].includes(code)) exit = 4;
    }
    io.stderr(code + "\n"); return exit;
  }
}

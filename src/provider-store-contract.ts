/**
 * Contract of the provider store (ADR 0021). The store is the only reader and writer of
 * `~/.config/pi-session-mcp/providers/`: `credentials.json` (source entries and key values, 0600)
 * and `providers.json` (non-secret definitions of operator-defined providers). Nothing in this
 * contract returns a key value; only the runtime integration in `provider-store.ts` reads one.
 */

/** The effective credential source of one provider. A provider without an entry is `inherit`. */
export type CredentialSource = "inherit" | "key" | "none";

/** Pi APIs an operator-defined provider may use; a fixed allowlist of Pi-supported protocols. */
export const SUPPORTED_PROVIDER_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "mistral-conversations",
] as const;
export type SupportedProviderApi = typeof SUPPORTED_PROVIDER_APIS[number];

/** One model of an operator-defined provider. Costs are unknown and recorded as zero. */
export interface ProviderModelDefinition {
  readonly id: string;
  readonly name?: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly reasoning: boolean;
  readonly input: readonly ("text" | "image")[];
}

/**
 * A non-secret, operator-defined provider. `baseUrl` is `https`, or `http` only for a loopback host,
 * without userinfo, query or fragment. The ID must not collide with a built-in provider.
 */
export interface ProviderDefinition {
  readonly id: string;
  readonly api: SupportedProviderApi;
  readonly baseUrl: string;
  readonly models: readonly ProviderModelDefinition[];
}

/** Safe metadata about one provider's stored source; never a key value. */
export interface StoredSource {
  readonly providerId: string;
  readonly source: Exclude<CredentialSource, "inherit">;
  /** For `key`: whether the key is still bound to the provider's current identity (ID and, for custom providers, base-URL origin). */
  readonly bindingValid: boolean;
}

/** A content-free view of the store. */
export interface ProviderStoreSnapshot {
  /** Entries for providers that are not `inherit`, sorted by provider ID. */
  readonly sources: readonly StoredSource[];
  /** Operator-defined providers, sorted by ID. */
  readonly definitions: readonly ProviderDefinition[];
}

export type ProviderStoreErrorCode =
  | "provider_store_unavailable"   // directory or file missing permissions, wrong owner, a link, or unreadable
  | "provider_store_invalid"       // a file fails its schema
  | "provider_store_busy"          // the mutation lock was not acquired in time
  | "provider_unknown"             // no built-in or operator-defined provider with that ID
  | "provider_definition_invalid"  // a definition fails validation (API, URL, models)
  | "provider_id_conflict"         // the ID is a built-in provider or already defined
  | "provider_inherit_unsupported" // `inherit` for an operator-defined provider
  | "credential_invalid"           // the key is empty, too long or contains whitespace or control characters
  | "credential_binding_mismatch"; // a stored key no longer matches the provider's identity

export class ProviderStoreError extends Error {
  constructor(readonly code: ProviderStoreErrorCode) {
    super(code);
    this.name = "ProviderStoreError";
  }
}

/** Options naming the built-in provider IDs, taken from Pi's offline catalog by the caller. */
export interface BuiltInProviders {
  readonly builtInProviderIds: readonly string[];
}

/**
 * Store operations. Every mutation is serialized by an exclusive lock and written atomically;
 * a failed or cancelled mutation leaves the previous state intact.
 */
export interface ProviderStore {
  read(): Promise<ProviderStoreSnapshot>;
  /** Stores or rotates a key and binds it to the provider's current identity. */
  setKey(providerId: string, key: string, options: BuiltInProviders): Promise<void>;
  /** Moves the provider to `none`; never back to `inherit`. */
  removeKey(providerId: string, options: BuiltInProviders): Promise<void>;
  /** Restores `inherit` for a built-in provider. */
  inherit(providerId: string, options: BuiltInProviders): Promise<void>;
  addProvider(definition: ProviderDefinition, options: BuiltInProviders): Promise<void>;
  /** Removes an operator-defined provider and its stored source. */
  removeProvider(providerId: string): Promise<void>;
}

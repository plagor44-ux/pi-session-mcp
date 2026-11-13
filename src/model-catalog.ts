/**
 * Offline view of Pi's model registry behind an injectable interface, so tests and callers need no
 * provider credentials. Also reads output token limits offline for Doctor's profile comparison.
 * Only documented package-root exports of the SDK are used.
 */
import { THINKING_LEVELS, type ThinkingLevel } from "./execution-profile.js";
import { loadRuntimeProviderPolicy, type ProviderPolicy, type ProviderPolicyRuntime } from "./provider-store.js";

export interface CatalogProvider {
  readonly id: string;
  readonly authConfigured: boolean;
  readonly models: readonly string[];
  /** Present, and true, only for a provider that declares account sign-in (ADR 0022); absent otherwise. */
  readonly signIn?: true;
}

export interface ModelCatalog {
  providers(): readonly CatalogProvider[];
}

/** The catalog guided setup proposes profiles from: prices and thinking levels, both read offline. */
export interface PricedModelCatalog extends ModelCatalog {
  outputPrice(providerId: string, modelId: string): number | undefined;
  /** The levels the model offers, in order from none to the most; undefined for a model the catalog does not list. */
  thinkingLevels(providerId: string, modelId: string): readonly ThinkingLevel[] | undefined;
  /** The level Pi applies when a session with this model requests `level`; undefined for a model the catalog does not list. */
  effectiveThinkingLevel(providerId: string, modelId: string, level: ThinkingLevel): ThinkingLevel | undefined;
}

/** A model entry as the catalog reads it. The thinking fields are only handed to Pi's own rules below. */
export interface CatalogModel {
  readonly id: string;
  readonly maxTokens?: unknown;
  readonly cost?: { readonly output?: unknown };
  readonly reasoning?: unknown;
  readonly thinkingLevelMap?: unknown;
}

/** Pi's rules for a model's thinking levels; a session start applies the same clamp to its configured level. */
export interface ThinkingLevelRules {
  supported(model: CatalogModel): readonly string[];
  clamp(model: CatalogModel, level: ThinkingLevel): string;
}

const loadThinkingLevelRules = (): Promise<ThinkingLevelRules> =>
  import("@earendil-works/pi-ai").then(({ getSupportedThinkingLevels, clampThinkingLevel }) => {
    // `getModels` returns pi-ai `Model` objects; `CatalogModel` names only the fields this module itself reads.
    type PiModel = Parameters<typeof getSupportedThinkingLevels>[0];
    return {
      supported: (model) => getSupportedThinkingLevels(model as unknown as PiModel),
      clamp: (model, level) => clampThinkingLevel(model as unknown as PiModel, level),
    };
  });

const isThinkingLevel = (value: string): value is ThinkingLevel => (THINKING_LEVELS as readonly string[]).includes(value);

/**
 * A provider or model id that is safe to print: no whitespace and no leading `/`, so it never starts a path.
 * A leading `@` is allowed for scoped model ids; ids may contain `/` after the first character.
 */
export const CATALOG_ID_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9._:@\/-]{0,255}$/;

/** Bound for one offline authentication lookup. */
export const AUTH_CHECK_TIMEOUT_MS = 5_000;

/**
 * The part of the SDK's `ModelRuntime` the catalog reads. The runtime is created with `refreshOnCreate: true` and
 * `allowModelNetwork: false`: that is an offline restore of the catalog Pi persisted earlier (the pi.dev overlay in
 * `models-store.json`), which the SDK applies only inside its refresh. With network off, a provider reads its stored
 * credential record, restores the cached catalog and returns before any credential is refreshed, so no request is made.
 * The availability pass that follows reads credential records as the `checkAuth` calls below do. Over Pi's file store
 * that resolves stored API-key values, and a command-valued key (`!command`) runs its command, as in Pi itself.
 * Reads that report no authentication presence use an empty credential store instead (#304). No credential value
 * enters catalog output and no model network call is made.
 */
export interface CatalogRuntime {
  registerProvider?: ProviderPolicyRuntime["registerProvider"];
  setRuntimeApiKey?: ProviderPolicyRuntime["setRuntimeApiKey"];
  /** `auth.oauth` is present when the provider declares account sign-in; the catalog reads only its presence. */
  getProviders(): readonly { readonly id: string; readonly auth?: { readonly oauth?: unknown } }[];
  getModels(providerId: string): readonly CatalogModel[];
  /** Resolves the configured authentication's kind, or `undefined` when none is configured. */
  checkAuth(providerId: string, options?: { signal?: AbortSignal }): Promise<unknown>;
}

/** Options for an offline restore of Pi's persisted catalog: no model network, no credential refresh. */
export const OFFLINE_RUNTIME_OPTIONS = { refreshOnCreate: true, allowModelNetwork: false } as const;

/** Over Pi's file store, for the catalog that reports whether each provider has authentication. */
const createCatalogRuntime = (): Promise<CatalogRuntime> =>
  import("@earendil-works/pi-coding-agent").then(({ ModelRuntime }) => ModelRuntime.create({ ...OFFLINE_RUNTIME_OPTIONS }));

/**
 * The same offline restore over an empty in-memory credential store (pi-ai's `InMemoryCredentialStore`), for reads that
 * report no authentication presence: neither the restore nor its availability pass reads a stored credential or
 * runs a command-valued key (#304). The restore publishes Pi's stored catalog without a credential; only a Radius
 * provider's one-time import of a legacy catalog from its OAuth credential is skipped. Provider policy still applies.
 * `signal` is the SDK's documented cancellation of the create-time restore and its availability pass.
 */
const createCredentialFreeRuntime = (signal?: AbortSignal): Promise<CatalogRuntime> =>
  Promise.all([import("@earendil-works/pi-coding-agent"), import("@earendil-works/pi-ai")]).then(([{ ModelRuntime }, { InMemoryCredentialStore }]) =>
    ModelRuntime.create({ ...OFFLINE_RUNTIME_OPTIONS, credentials: new InMemoryCredentialStore(), ...(signal === undefined ? {} : { signal }) }));

/**
 * Offline identity discovery for the store and writer projection; applies the same policy, without checkAuth/getAuth,
 * over an empty credential store.
 */
export async function catalogBuiltInProviderIds(
  createRuntime: () => Promise<CatalogRuntime> = createCredentialFreeRuntime,
  policyFactory: () => Promise<ProviderPolicy> = loadRuntimeProviderPolicy,
): Promise<readonly string[]> {
  const runtime = await createRuntime();
  const ids = runtime.getProviders().map(provider => provider.id);
  const policy = await policyFactory();
  await policy.apply({
    getProviders: () => runtime.getProviders(),
    registerProvider: (...args) => { if (!runtime.registerProvider) throw new Error("provider_store_unavailable"); runtime.registerProvider(...args); },
    setRuntimeApiKey: (...args) => { if (!runtime.setRuntimeApiKey) throw new Error("provider_store_unavailable"); return runtime.setRuntimeApiKey(...args); },
  });
  return ids;
}

/**
 * Offline output limits for Doctor only; no authentication lookup of its own, no stored credential and no network
 * refresh. Doctor aborts `signal` when its bound expires, which ends the restore instead of leaving it running behind
 * the report.
 */
export async function readCatalogOutputLimits(
  signal?: AbortSignal,
  createRuntime: (signal?: AbortSignal) => Promise<CatalogRuntime> = createCredentialFreeRuntime,
  policyFactory: () => Promise<ProviderPolicy> = loadRuntimeProviderPolicy,
): Promise<(providerId: string, modelId: string) => number | undefined> {
  const runtime = await createRuntime(signal);
  try {
    const policy = await policyFactory();
    await policy.apply({
      getProviders: () => runtime.getProviders(),
      registerProvider: (...args) => { if (!runtime.registerProvider) throw new Error("provider_store_unavailable"); runtime.registerProvider(...args); },
      setRuntimeApiKey: (...args) => { if (!runtime.setRuntimeApiKey) throw new Error("provider_store_unavailable"); return runtime.setRuntimeApiKey(...args); },
    });
  } catch { /* Built-in catalog entries remain usable. */ }
  const limits = new Map<string, Map<string, number>>();
  for (const provider of runtime.getProviders()) {
    const models = new Map<string, number>();
    for (const model of runtime.getModels(provider.id)) {
      const value = model.maxTokens;
      if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) models.set(model.id, value);
    }
    limits.set(provider.id, models);
  }
  return (providerId, modelId) => limits.get(providerId)?.get(modelId);
}

const compareIds = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** True only for a settled, present result; a rejection or a lookup past the bound counts as not configured. */
const authConfigured = (runtime: CatalogRuntime, providerId: string): Promise<boolean> => new Promise((resolve) => {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); resolve(false); }, AUTH_CHECK_TIMEOUT_MS);
  Promise.resolve()
    .then(() => runtime.checkAuth(providerId, { signal: controller.signal }))
    .then((auth) => resolve(auth !== undefined && auth !== null), () => resolve(false))
    .finally(() => clearTimeout(timer));
});

/**
 * Reads the provider ids Pi knows offline, whether each has configured authentication, whether each
 * declares account sign-in (the presence of `auth.oauth`, for the provider CLI and guided setup), and its
 * model ids, including the models of Pi's persisted catalog overlay. `checkAuth` reports only whether and how
 * a provider is configured; its result is reduced to a boolean. `hasConfiguredAuth` is not used. Never
 * calls `getAuth`, `getAvailable` or `refresh` itself. Provider policy registers custom definitions
 * and applies in-memory keys offline; no credential value enters catalog output and no provider is
 * contacted. The runtime reads Pi's file store, so a command-valued stored key runs its command, as
 * in Pi itself. The only refresh is the offline restore at creation. Providers registered only
 * by Pi extensions are not part of the registry. Output prices and thinking levels serve guided
 * setup's proposals only. With `readAuthentication` false the catalog makes no authentication
 * lookup and reports every provider as not configured; only `createCredentialFreeModelCatalog` passes it.
 */
export async function createModelCatalog(
  createRuntime: () => Promise<CatalogRuntime> = createCatalogRuntime,
  policyFactory: () => Promise<ProviderPolicy> = loadRuntimeProviderPolicy,
  thinkingLevelRules: () => Promise<ThinkingLevelRules> = loadThinkingLevelRules,
  readAuthentication = true,
): Promise<PricedModelCatalog> {
  const runtime = await createRuntime();
  const rules = await thinkingLevelRules();
  let policy: ProviderPolicy | undefined;
  let policyUnavailable = false;
  try {
    policy = await policyFactory();
    await policy.apply({
      getProviders: () => runtime.getProviders(),
      registerProvider: (...args) => { if (!runtime.registerProvider) throw new Error("provider_store_unavailable"); runtime.registerProvider(...args); },
      setRuntimeApiKey: (...args) => { if (!runtime.setRuntimeApiKey) throw new Error("provider_store_unavailable"); return runtime.setRuntimeApiKey(...args); },
    });
  } catch { policyUnavailable = true; }
  const prices = new Map<string, Map<string, number>>();
  const entries = new Map<string, Map<string, CatalogModel>>();
  const providers = await Promise.all(runtime.getProviders().map(async (provider) => {
    const configured = readAuthentication && !policyUnavailable && !policy?.blocked(provider.id) && await authConfigured(runtime, provider.id);
    const models = runtime.getModels(provider.id);
    const modelPrices = new Map<string, number>();
    for (const model of models) {
      const price = model.cost?.output;
      if (typeof price === "number" && Number.isFinite(price)) modelPrices.set(model.id, price);
    }
    prices.set(provider.id, modelPrices);
    entries.set(provider.id, new Map(models.map((model) => [model.id, model])));
    return Object.freeze({
      id: provider.id,
      authConfigured: configured,
      models: Object.freeze(models.map((model) => model.id).sort(compareIds)),
      ...(provider.auth?.oauth !== undefined ? { signIn: true as const } : {}),
    });
  }));
  providers.sort((left, right) => compareIds(left.id, right.id));
  const entry = (providerId: string, modelId: string): CatalogModel | undefined => entries.get(providerId)?.get(modelId);
  return Object.freeze({
    providers: () => Object.freeze(providers),
    outputPrice: (providerId: string, modelId: string) => prices.get(providerId)?.get(modelId),
    thinkingLevels: (providerId: string, modelId: string) => {
      const model = entry(providerId, modelId);
      return model === undefined ? undefined : Object.freeze(rules.supported(model).filter(isThinkingLevel));
    },
    effectiveThinkingLevel: (providerId: string, modelId: string, level: ThinkingLevel) => {
      const model = entry(providerId, modelId);
      if (model === undefined) return undefined;
      const effective = rules.clamp(model, level);
      return isThinkingLevel(effective) ? effective : undefined;
    },
  });
}

/**
 * Provider identities for the provider CLI's commands other than `list` (#304): the catalog above, restored over an
 * empty credential store and without its authentication lookup, so it reads no stored credential and runs no key
 * command. Provider ids, model ids and sign-in support are the same, apart from a Radius provider's legacy import
 * (see `createCredentialFreeRuntime`). `authConfigured` is false for every provider and says nothing; callers must not
 * report it.
 */
export function createCredentialFreeModelCatalog(
  policyFactory: () => Promise<ProviderPolicy> = loadRuntimeProviderPolicy,
): Promise<ModelCatalog> {
  return createModelCatalog(createCredentialFreeRuntime, policyFactory, loadThinkingLevelRules, false);
}

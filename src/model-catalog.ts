/**
 * Offline view of Pi's model registry behind an injectable interface, so tests and callers need no
 * provider credentials. Only documented package-root exports of the SDK are used.
 */
export interface CatalogProvider {
  readonly id: string;
  readonly authConfigured: boolean;
  readonly models: readonly string[];
}

export interface ModelCatalog {
  providers(): readonly CatalogProvider[];
}

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
 * The availability pass that follows reads credential records and resolves API-key values in-process, like the
 * `checkAuth` calls below already do; no value leaves the process and no network call is made.
 */
export interface CatalogRuntime {
  getProviders(): readonly { readonly id: string }[];
  getModels(providerId: string): readonly { readonly id: string }[];
  /** Resolves the configured authentication's kind, or `undefined` when none is configured. */
  checkAuth(providerId: string, options?: { signal?: AbortSignal }): Promise<unknown>;
}

/** Options for an offline restore of Pi's persisted catalog: no model network, no credential refresh. */
export const OFFLINE_RUNTIME_OPTIONS = { refreshOnCreate: true, allowModelNetwork: false } as const;

const createCatalogRuntime = (): Promise<CatalogRuntime> =>
  import("@earendil-works/pi-coding-agent").then(({ ModelRuntime }) => ModelRuntime.create({ ...OFFLINE_RUNTIME_OPTIONS }));

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
 * Reads the provider ids Pi knows offline, whether each has configured authentication, and its model
 * ids, including the models of Pi's persisted catalog overlay. `checkAuth` reports only whether and how
 * a provider is configured; its result is reduced to a boolean. `hasConfiguredAuth` is not used. Never
 * calls `getAuth`, `getAvailable` or `refresh` itself, so no credential value is resolved and no
 * provider is contacted; the only refresh is the offline restore at creation. Providers registered only
 * by Pi extensions are not part of the registry.
 */
export async function createModelCatalog(createRuntime: () => Promise<CatalogRuntime> = createCatalogRuntime): Promise<ModelCatalog> {
  const runtime = await createRuntime();
  const providers = await Promise.all(runtime.getProviders().map(async (provider) => {
    const configured = await authConfigured(runtime, provider.id);
    return Object.freeze({
      id: provider.id,
      authConfigured: configured,
      models: Object.freeze(runtime.getModels(provider.id).map((model) => model.id).sort(compareIds)),
    });
  }));
  providers.sort((left, right) => compareIds(left.id, right.id));
  return Object.freeze({ providers: () => Object.freeze(providers) });
}

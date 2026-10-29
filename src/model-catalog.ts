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

/** A provider or model id that is safe to print: no whitespace, no path segments that start a path. */
export const CATALOG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@\/-]{0,255}$/;

/** The part of the SDK's `ModelRuntime` the catalog reads; created without model network and without a refresh. */
interface CatalogRuntime {
  getProviders(): readonly { readonly id: string }[];
  getModels(providerId: string): readonly { readonly id: string }[];
  hasConfiguredAuth(providerId: string): boolean;
}

const createCatalogRuntime = (): Promise<CatalogRuntime> =>
  import("@earendil-works/pi-coding-agent").then(({ ModelRuntime }) =>
    ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false }));

const compareIds = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/**
 * Reads the provider ids Pi knows offline, whether each has configured authentication, and its model
 * ids. Never calls `getAuth`, `getAvailable` or `checkAuth`, so no credential is read and no provider
 * is contacted. Providers registered only by Pi extensions are not part of the registry.
 */
export async function createModelCatalog(): Promise<ModelCatalog> {
  const runtime = await createCatalogRuntime();
  const providers = runtime.getProviders()
    .map((provider) => Object.freeze({
      id: provider.id,
      authConfigured: runtime.hasConfiguredAuth(provider.id),
      models: Object.freeze(runtime.getModels(provider.id).map((model) => model.id).sort(compareIds)),
    }))
    .sort((left, right) => compareIds(left.id, right.id));
  return Object.freeze({ providers: () => Object.freeze(providers) });
}

import { ProviderStoreError, type ProviderStore } from "./provider-store-contract.js";

/**
 * Placeholder until the provider store lands (ADR 0021, #265): every operation fails closed.
 * The real implementation replaces this file and keeps this export.
 */
export function openProviderStore(_options: { home?: string } = {}): ProviderStore {
  const unavailable = (): Promise<never> => Promise.reject(new ProviderStoreError("provider_store_unavailable"));
  return { read: unavailable, setKey: unavailable, removeKey: unavailable, inherit: unavailable, addProvider: unavailable, removeProvider: unavailable };
}

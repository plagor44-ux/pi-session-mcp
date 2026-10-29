import { CATALOG_ID_PATTERN, type CatalogProvider, type ModelCatalog } from "./model-catalog.js";

/** Public, path-free `--list-models` report. */
export interface ModelCatalogReport {
  readonly schemaVersion: 1;
  readonly status: "ok" | "failed";
  readonly code?: "catalog_unavailable";
  readonly providers: readonly CatalogProvider[];
  readonly omittedIds: number;
  readonly note: "extension_providers_not_listed";
  readonly exitCode: 0 | 1;
}

const compareIds = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const providersOf = (catalog: ModelCatalog): { readonly providers: readonly CatalogProvider[]; readonly omittedIds: number } => {
  let omittedIds = 0;
  const providers: CatalogProvider[] = [];
  for (const provider of [...catalog.providers()].sort((left, right) => compareIds(left.id, right.id))) {
    if (!CATALOG_ID_PATTERN.test(provider.id)) {
      omittedIds += 1;
      continue;
    }
    const models = new Set<string>();
    for (const model of provider.models) {
      if (!CATALOG_ID_PATTERN.test(model)) {
        omittedIds += 1;
        continue;
      }
      models.add(model);
    }
    providers.push(Object.freeze({
      id: provider.id,
      authConfigured: provider.authConfigured === true,
      models: Object.freeze([...models].sort(compareIds)),
    }));
  }
  return Object.freeze({ providers: Object.freeze(providers), omittedIds });
};

/** Fails closed when no catalog could be created; drops ids that are not plain catalog ids. */
export function catalogReport(catalog: ModelCatalog | undefined): ModelCatalogReport {
  if (catalog === undefined) {
    return Object.freeze({
      schemaVersion: 1,
      status: "failed",
      code: "catalog_unavailable",
      providers: Object.freeze([]),
      omittedIds: 0,
      note: "extension_providers_not_listed",
      exitCode: 1,
    });
  }
  return Object.freeze({
    schemaVersion: 1,
    status: "ok",
    ...providersOf(catalog),
    note: "extension_providers_not_listed",
    exitCode: 0,
  });
}

/** One line per provider with its auth presence and model ids, then the fixed extension note. */
export function formatCatalogHuman(report: ModelCatalogReport): string {
  const lines = report.providers.map((provider) =>
    `${provider.id} (auth: ${provider.authConfigured ? "yes" : "no"}): ${provider.models.join(", ")}`);
  if (report.status === "failed") lines.unshift("Model catalog unavailable.");
  lines.push("Providers registered only by Pi extensions are not listed.");
  return `${lines.join("\n")}\n`;
}

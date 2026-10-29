import { CATALOG_ID_PATTERN, type CatalogProvider, type ModelCatalog } from "./model-catalog.js";
import type { PiSessionCreationErrorCode } from "./pi-adapter.js";

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

export type ProbeCode = "probe_planned" | "probe_profile_unknown" | "probe_provider_unknown" | "probe_model_unknown" | "probe_auth_missing" | "probe_passed" | "probe_unexpected_reply" | "probe_turn_failed" | "probe_start_failed" | "probe_timeout";

export interface ProbeFinding {
  readonly profile: string;
  readonly status: "planned" | "ok" | "failed";
  readonly code: ProbeCode;
  readonly startCode?: PiSessionCreationErrorCode;
  readonly providerTurn: boolean;
  readonly durationMs?: number;
}

export interface ProbeReport {
  readonly schemaVersion: 1;
  readonly operation: "dry-run" | "apply";
  readonly status: "planned" | "ok" | "failed";
  readonly refusal?: "doctor_failed" | "config_required" | "config_unusable" | "operation_interrupted" | "catalog_unavailable" | "operation_failed";
  readonly doctor: { readonly blocking: readonly string[]; readonly other: readonly string[] };
  readonly findings: readonly ProbeFinding[];
  readonly usage: "unknown";
  readonly exitCode: 0 | 1 | 130 | 143;
}

export function formatProbeHuman(report: ProbeReport): string {
  const lines = report.findings.map((finding) =>
    `${finding.profile}: ${finding.status} (${finding.code}${finding.startCode === undefined ? "" : ` ${finding.startCode}`})`);
  if (report.refusal !== undefined) lines.unshift(`Probe refused: ${report.refusal}`);
  lines.push(`provider turns: ${report.findings.filter((finding) => finding.providerTurn).length}, usage: unknown`);
  return `${lines.join("\n")}\n`;
}

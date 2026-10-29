import { describe, expect, it } from "vitest";
import type { CatalogProvider, ModelCatalog } from "../src/model-catalog.js";
import { catalogReport, formatCatalogHuman } from "../src/setup-probe-result.js";

const fakeCatalog = (providers: readonly CatalogProvider[]): ModelCatalog => ({ providers: () => providers });

describe("model catalog report", () => {
  it("reports providers, auth presence and models from a fake catalog", () => {
    const report = catalogReport(fakeCatalog([
      { id: "other-provider", authConfigured: false, models: [] },
      { id: "example-provider", authConfigured: true, models: ["m-small", "m-large"] },
    ]));
    expect(report).toEqual({
      schemaVersion: 1,
      status: "ok",
      providers: [
        { id: "example-provider", authConfigured: true, models: ["m-large", "m-small"] },
        { id: "other-provider", authConfigured: false, models: [] },
      ],
      omittedIds: 0,
      note: "extension_providers_not_listed",
      exitCode: 0,
    });
  });

  it("omits ids that are not plain catalog ids", () => {
    const report = catalogReport(fakeCatalog([
      { id: "example-provider", authConfigured: true, models: ["/home/x", "m-small"] },
      { id: "bad id", authConfigured: true, models: ["m-other"] },
    ]));
    expect(report.providers.map((provider) => provider.id)).toEqual(["example-provider"]);
    expect(report.providers[0]?.models).toEqual(["m-small"]);
    expect(report.omittedIds).toBe(2);
  });

  it("fails closed when the catalog cannot be created", () => {
    const report = catalogReport(undefined);
    expect(report.status).toBe("failed");
    expect(report.code).toBe("catalog_unavailable");
    expect(report.exitCode).toBe(1);
    expect(report.providers).toEqual([]);
  });

  it("human format has no path and states the extension note", () => {
    const human = formatCatalogHuman(catalogReport(fakeCatalog([
      { id: "example-provider", authConfigured: true, models: ["m-large", "m-small"] },
    ])));
    expect(human).toContain("example-provider (auth: yes): m-large, m-small");
    expect(human).toContain("Providers registered only by Pi extensions are not listed.");
    expect(human).not.toMatch(/\/[A-Za-z0-9_.-]+\//);
  });
});

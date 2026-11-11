import { describe, expect, it, vi } from "vitest";
import { AUTH_CHECK_TIMEOUT_MS, createModelCatalog, type CatalogProvider, type CatalogRuntime, type ModelCatalog } from "../src/model-catalog.js";
import { catalogReport, formatCatalogHuman } from "../src/setup-probe-result.js";

vi.mock("../src/provider-store.js", () => ({
  loadRuntimeProviderPolicy: async () => ({ apply: async () => {}, source: () => "inherit", blocked: () => false }),
}));

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
      { id: "example-provider", authConfigured: true, models: ["/home/x", "m-small", "@scope/family/m-scoped"] },
      { id: "bad id", authConfigured: true, models: ["m-other"] },
    ]));
    expect(report.providers.map((provider) => provider.id)).toEqual(["example-provider"]);
    expect(report.providers[0]?.models).toEqual(["@scope/family/m-scoped", "m-small"]);
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

describe("createModelCatalog", () => {
  it("reads output prices and leaves providers() unchanged", async () => {
    const catalog = await createModelCatalog(async () => ({
      getProviders: () => [{ id: "p" }],
      getModels: () => [{ id: "m", cost: { output: 2.1 } }],
      checkAuth: async () => true,
    }));
    expect(catalog.outputPrice("p", "m")).toBe(2.1);
    expect(catalog.outputPrice("p", "missing")).toBeUndefined();
    expect(Object.keys(catalog.providers()[0]!)).toEqual(["id", "authConfigured", "models"]);
  });

  it("reads the thinking levels a model offers and the level Pi applies to a request", async () => {
    const catalog = await createModelCatalog(async () => ({
      getProviders: () => [{ id: "p" }],
      getModels: () => [
        { id: "no-medium", reasoning: true, thinkingLevelMap: { medium: null } },
        { id: "plain", reasoning: false },
        { id: "extended", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } },
      ],
      checkAuth: async () => true,
    }));
    expect(catalog.thinkingLevels("p", "no-medium")).toEqual(["off", "minimal", "low", "high"]);
    expect(catalog.effectiveThinkingLevel("p", "no-medium", "medium")).toBe("high");
    expect(catalog.effectiveThinkingLevel("p", "no-medium", "low")).toBe("low");
    expect(catalog.thinkingLevels("p", "plain")).toEqual(["off"]);
    expect(catalog.effectiveThinkingLevel("p", "plain", "high")).toBe("off");
    expect(catalog.thinkingLevels("p", "extended")).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
    expect(catalog.effectiveThinkingLevel("p", "extended", "max")).toBe("xhigh");
    expect(catalog.thinkingLevels("p", "missing")).toBeUndefined();
    expect(catalog.effectiveThinkingLevel("p", "missing", "medium")).toBeUndefined();
    expect(catalog.thinkingLevels("other", "no-medium")).toBeUndefined();
  });

  it("treats a non-numeric price as unknown", async () => {
    const catalog = await createModelCatalog(async () => ({
      getProviders: () => [{ id: "p" }], getModels: () => [{ id: "m", cost: { output: "2.1" } }],
      checkAuth: async () => true,
    }));
    expect(catalog.outputPrice("p", "m")).toBeUndefined();
  });
  const fakeRuntime = (checkAuth: CatalogRuntime["checkAuth"]): CatalogRuntime => ({
    getProviders: () => [{ id: "provider-c" }, { id: "provider-a" }, { id: "provider-b" }, { id: "provider-d" }],
    getModels: (providerId) => (providerId === "provider-a" ? [{ id: "m-2" }, { id: "m-1" }] : []),
    checkAuth,
  });

  it("maps checkAuth results to auth presence and sorts providers and models", async () => {
    const checkAuth = vi.fn<CatalogRuntime["checkAuth"]>(async (providerId) => {
      if (providerId === "provider-a") return { source: "stored", type: "api_key" };
      if (providerId === "provider-b") throw new Error("SECRET_CHECK_AUTH");
      if (providerId === "provider-d") return null;
      return undefined;
    });
    const catalog = await createModelCatalog(async () => fakeRuntime(checkAuth));
    expect(catalog.providers()).toEqual([
      { id: "provider-a", authConfigured: true, models: ["m-1", "m-2"] },
      { id: "provider-b", authConfigured: false, models: [] },
      { id: "provider-c", authConfigured: false, models: [] },
      { id: "provider-d", authConfigured: false, models: [] },
    ]);
    expect(checkAuth).toHaveBeenCalledTimes(4);
    for (const call of checkAuth.mock.calls) expect(call[1]).toEqual({ signal: expect.any(AbortSignal) });
  });

  it("stops waiting on a checkAuth that never settles", async () => {
    vi.useFakeTimers();
    try {
      let seen: AbortSignal | undefined;
      // Ignores its signal, so only the catalog's own bound ends the wait.
      const pending = createModelCatalog(async () => fakeRuntime((_providerId, options) => {
        seen = options?.signal;
        return new Promise(() => {});
      }));
      await vi.advanceTimersByTimeAsync(AUTH_CHECK_TIMEOUT_MS);
      const catalog = await pending;
      expect(seen?.aborted).toBe(true);
      expect(catalog.providers().every((provider) => !provider.authConfigured)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

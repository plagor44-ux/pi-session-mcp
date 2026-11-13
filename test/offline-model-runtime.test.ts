import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { catalogBuiltInProviderIds, createCredentialFreeModelCatalog, createModelCatalog, OFFLINE_RUNTIME_OPTIONS, readCatalogOutputLimits, type ModelCatalog } from "../src/model-catalog.js";
import { loadProviderPolicy, type ProviderPolicy } from "../src/provider-store.js";
import { defaultModelRuntimeFactory } from "../src/sdk-pi-adapter.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("offline restore of Pi's persisted catalog (#199)", () => {
  it("uses a restoring runtime without model network", () => {
    expect(OFFLINE_RUNTIME_OPTIONS).toEqual({ refreshOnCreate: true, allowModelNetwork: false });
  });

  it("creates the catalog runtime with the offline restore options", async () => {
    const create = vi.spyOn(ModelRuntime, "create").mockResolvedValue({
      getProviders: () => [], getModels: () => [], checkAuth: async () => undefined,
    } as unknown as ModelRuntime);
    await createModelCatalog();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ refreshOnCreate: true, allowModelNetwork: false });
  });

  it("passes Doctor's signal and an empty credential store to the offline restore of the output limits", async () => {
    const create = vi.spyOn(ModelRuntime, "create").mockResolvedValue({
      getProviders: () => [], getModels: () => [], checkAuth: async () => undefined,
    } as unknown as ModelRuntime);
    const controller = new AbortController();
    await readCatalogOutputLimits(controller.signal, undefined, async () => { throw new Error("no provider store"); });
    expect(create).toHaveBeenCalledWith({ refreshOnCreate: true, allowModelNetwork: false, credentials: expect.any(InMemoryCredentialStore), signal: controller.signal });
    expect(await create.mock.calls[0]![0]!.credentials!.list()).toEqual([]);
  });

  it("creates the provider discovery's runtime over an empty credential store (#304)", async () => {
    const create = vi.spyOn(ModelRuntime, "create").mockResolvedValue({
      getProviders: () => [{ id: "openai" }], getModels: () => [], checkAuth: async () => undefined,
    } as unknown as ModelRuntime);
    const policy = { apply: async () => {} } as unknown as ProviderPolicy;
    expect(await catalogBuiltInProviderIds(undefined, async () => policy)).toEqual(["openai"]);
    expect(create).toHaveBeenCalledWith({ refreshOnCreate: true, allowModelNetwork: false, credentials: expect.any(InMemoryCredentialStore) });
    expect(await create.mock.calls[0]![0]!.credentials!.list()).toEqual([]);
  });

  it("creates the provider CLI's identity catalog over an empty credential store, without an authentication lookup (#304)", async () => {
    const checkAuth = vi.fn(async () => "api_key");
    const create = vi.spyOn(ModelRuntime, "create").mockResolvedValue({
      getProviders: () => [{ id: "openai", auth: { oauth: {} } }], getModels: () => [{ id: "m1" }], checkAuth,
    } as unknown as ModelRuntime);
    const policy = { apply: async () => {}, blocked: () => false } as unknown as ProviderPolicy;
    const catalog = await createCredentialFreeModelCatalog(async () => policy);
    expect(catalog.providers()).toEqual([{ id: "openai", authConfigured: false, models: ["m1"], signIn: true }]);
    expect(checkAuth).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith({ refreshOnCreate: true, allowModelNetwork: false, credentials: expect.any(InMemoryCredentialStore) });
    expect(await create.mock.calls[0]![0]!.credentials!.list()).toEqual([]);
  });

  it("creates the session adapter's default runtime without the refresh-time availability pass", async () => {
    const create = vi.spyOn(ModelRuntime, "create").mockResolvedValue({} as unknown as ModelRuntime);
    await defaultModelRuntimeFactory();
    expect(create).toHaveBeenCalledWith({ refreshOnCreate: false });
  });

  describe("with the real SDK and a persisted overlay", () => {
    let agentDir: string;
    beforeEach(async () => {
      agentDir = await temporaryRoot("pi-agent-overlay-");
      vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
      const model = {
        id: "overlay-only-model", name: "Overlay Only", provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1",
        reasoning: true, input: ["text"], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 10_000,
      };
      await writeFile(join(agentDir, "models-store.json"), JSON.stringify({ openai: { models: [model], checkedAt: Date.now(), lastModified: Date.now() + 86_400_000 } }));
    });

    it("lists an overlay model offline, without any network request", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must not be used"));
      const catalog = await createModelCatalog();
      expect(catalog.providers().find((provider) => provider.id === "openai")?.models).toContain("overlay-only-model");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("reads an overlay model's output limit offline and restores nothing on an aborted signal", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must not be used"));
      const noStore = async () => { throw new Error("no provider store"); };
      const lookup = await readCatalogOutputLimits(new AbortController().signal, undefined, noStore);
      expect(lookup("openai", "overlay-only-model")).toBe(10_000);
      // SDK 1.5.2 resolves without restoring once the signal is aborted; a rejection would be just as acceptable.
      const aborted = await readCatalogOutputLimits(AbortSignal.abort(), undefined, noStore).catch(() => undefined);
      expect(aborted?.("openai", "overlay-only-model")).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("runs no command-valued stored key for Doctor's limits, provider discovery or the provider CLI's identities, unlike the authentication catalog (#304)", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must not be used"));
      const home = await temporaryRoot("pi-provider-home-");
      const policy = () => loadProviderPolicy({ home });
      // Each phase stores its own command, because Pi caches a resolved command for the process.
      const storeKeyCommand = (marker: string) => writeFile(join(agentDir, "auth.json"),
        JSON.stringify({ openai: { type: "api_key", key: `!touch '${join(agentDir, marker)}'` } }), { mode: 0o600 });

      await storeKeyCommand("limits-ran");
      const lookup = await readCatalogOutputLimits(new AbortController().signal, undefined, policy);
      expect(lookup("openai", "overlay-only-model")).toBe(10_000);
      expect(existsSync(join(agentDir, "limits-ran"))).toBe(false);

      await storeKeyCommand("discovery-ran");
      expect(await catalogBuiltInProviderIds(undefined, policy)).toContain("openai");
      expect(existsSync(join(agentDir, "discovery-ran"))).toBe(false);

      await storeKeyCommand("identities-ran");
      const identities = await createCredentialFreeModelCatalog(policy);
      expect(existsSync(join(agentDir, "identities-ran"))).toBe(false);

      // Control: over Pi's file store the same key runs, so the reads above would have run it too.
      await storeKeyCommand("catalog-ran");
      const catalog = await createModelCatalog(undefined, policy);
      expect(catalog.providers().find((provider) => provider.id === "openai")?.models).toContain("overlay-only-model");
      expect(existsSync(join(agentDir, "catalog-ran"))).toBe(true);
      // Apart from authentication presence, the provider CLI sees the providers, models and sign-in support `list` sees.
      const withoutAuth = (source: ModelCatalog) => source.providers().map(({ authConfigured: _, ...identity }) => identity);
      expect(withoutAuth(identities)).toEqual(withoutAuth(catalog));
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("restores an overlay model for one provider through the adapter's offline refresh", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must not be used"));
      const runtime = await defaultModelRuntimeFactory();
      expect(runtime.getModels("openai").map((model) => model.id)).not.toContain("overlay-only-model");
      await runtime.refresh({ allowNetwork: false, providers: ["openai"] });
      expect(runtime.getModels("openai").map((model) => model.id)).toContain("overlay-only-model");
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});

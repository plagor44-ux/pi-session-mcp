import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModelCatalog, OFFLINE_RUNTIME_OPTIONS } from "../src/model-catalog.js";
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

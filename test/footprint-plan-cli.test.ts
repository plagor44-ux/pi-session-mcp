import { describe, expect, it } from "vitest";
import { parseArgs } from "../eval/profiles/cli.js";
import { caseServerConfig, routesFor } from "../eval/profiles/token-live.js";
import { isWorkerProvider } from "../eval/profiles/token-live-proxy.js";

describe("footprint plan options", () => {
  it("accepts a controller version and worker-skill selection only for --footprint-plan", () => {
    expect(parseArgs(["--footprint-plan", "--controller-version", "0.162.1", "--worker-skills", "selected"]).options)
      .toEqual({ "--controller-version": "0.162.1", "--worker-skills": "selected" });
    expect(() => parseArgs(["--plan", "--controller-version", "0.162.1"])).toThrow("footprint_plan_only");
    expect(() => parseArgs(["--footprint-plan", "--controller-version", "latest"])).toThrow("invalid_controller_version");
    expect(() => parseArgs(["--footprint-plan", "--worker-skills", "all"])).toThrow("invalid_worker_skills");
  });
  it("binds an allowed worker provider through the plan, routes and server configuration", () => {
    expect(parseArgs(["--footprint-plan", "--worker-provider", "openai"]).options).toEqual({ "--worker-provider": "openai" });
    expect(() => parseArgs(["--footprint-plan", "--worker-provider", "anthropic"])).toThrow("invalid_worker_provider");
    expect(isWorkerProvider("openai")).toBe(true);
    expect(isWorkerProvider("openai-codex")).toBe(true);
    expect(isWorkerProvider("xai")).toBe(false);
    expect(routesFor("openai").code.provider).toBe("openai");
    const config = caseServerConfig("L2", "/fixture", [], undefined, "openai");
    expect(config.executionProfiles.review.provider).toBe("openai");
    expect(config.executionProfiles.code?.provider).toBe("openai");
    expect(caseServerConfig("L1", "/fixture").executionProfiles.review.provider).toBe("openai-codex");
  });
});

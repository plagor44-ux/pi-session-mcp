import { describe, expect, it } from "vitest";
import { parseArgs } from "../eval/profiles/cli.js";

describe("footprint plan options", () => {
  it("accepts a controller version and worker-skill selection only for --footprint-plan", () => {
    expect(parseArgs(["--footprint-plan", "--controller-version", "0.162.1", "--worker-skills", "selected"]).options)
      .toEqual({ "--controller-version": "0.162.1", "--worker-skills": "selected" });
    expect(() => parseArgs(["--plan", "--controller-version", "0.162.1"])).toThrow("footprint_plan_only");
    expect(() => parseArgs(["--footprint-plan", "--controller-version", "latest"])).toThrow("invalid_controller_version");
    expect(() => parseArgs(["--footprint-plan", "--worker-skills", "all"])).toThrow("invalid_worker_skills");
  });
});

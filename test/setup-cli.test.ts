import { describe, expect, it } from "vitest";
import { formatSetupHuman, formatSetupResult, parseSetupArgs } from "../src/setup-cli.js";
import type { SetupResult } from "../src/setup-result.js";

const sample: SetupResult = { schemaVersion: 1, operation: "dry-run", status: "planned", exitCode: 0, findings: [{ target: { client: "codex", scope: "user", alias: "pi-session-mcp" }, status: "absent", code: "absent" }] };

describe("setup CLI", () => {
  it("parses JSON and target options", () => { expect(parseSetupArgs(["--apply", "--json", "--target", "codex:user:pi-session-mcp"])).toEqual({ operation: "apply", json: true, targets: [{ client: "codex", scope: "user", alias: "pi-session-mcp" }] }); });
  it("defaults to human dry-run mode", () => { expect(parseSetupArgs(["--target", "codex:user:pi-session-mcp"])).toEqual({ json: false, targets: [{ client: "codex", scope: "user", alias: "pi-session-mcp" }] }); expect(formatSetupHuman(sample)).toContain("dry-run: planned"); });
  it("projects the same sanitized result in JSON", () => { const json = formatSetupResult(sample); expect(JSON.parse(json)).toEqual(sample); expect(json).not.toContain("/home/"); expect(json).not.toContain("sk_"); });
  it("rejects unsupported, repeated, and malformed arguments", () => { expect(() => parseSetupArgs(["--wat"])).toThrow("argument_unsupported"); expect(() => parseSetupArgs(["--apply", "--verify"])).toThrow("operation_repeated"); expect(() => parseSetupArgs(["--target", "codex:user"])).toThrow("target_invalid"); });
  it("does not echo secret or path sentinels from a target projection", () => { const result: SetupResult = { ...sample, findings: [{ ...sample.findings[0]!, target: { client: "codex", scope: "user", alias: "SAFE_ALIAS" }, code: "setup_failed" }] }; const rendered = `${formatSetupResult(result)}\n${formatSetupHuman(result)}`; expect(rendered).not.toContain("SECRET_SENTINEL"); expect(rendered).not.toContain("/tmp/secret"); });
  describe("--repo", () => {
    it("parses explicit container settings and defaults to dry-run", () => {
      expect(parseSetupArgs(["--repo", "a", "--mode", "container", "--writers", "2", "--lifecycle", "ephemeral", "--profiles", "code,other", "--image", "node", "--network", "none"])).toMatchObject({ repo: { alias: "a", mode: "container", apply: false, acceptHostWrites: false, container: { writers: 2, lifecycle: "ephemeral", profiles: ["code", "other"], image: "node", network: "none" } } });
      expect(parseSetupArgs(["--apply", "--repo", "a", "--mode", "host", "--accept-host-writes"])).toMatchObject({ repo: { apply: true, acceptHostWrites: true } });
    });
    it.each([
      ["--repo", "a", "--target", "codex:user:pi-session-mcp"],
      ["--repo", "a", "--customize-skill", "review"],
      ["--repo", "a", "--writers", "0"], ["--repo", "a", "--writers", "17"],
      ["--repo", "a", "--writers", "1.5"], ["--repo", "a", "--verify"],
      ["--repo", "a", "--mode", "unset"], ["--repo", "a", "--profiles", ""],
      ["--mode", "host"], ["--repo"], ["--repo", "a", "--repo", "b"],
      ["--repo", "a", "--network", "bridge"],
    ])("rejects invalid repo arguments %j", (...argv) => { expect(() => parseSetupArgs(argv)).toThrow(); });
  });
  describe("--customize-skill", () => {
    it("parses a dry run, an apply and the JSON flag in any order", () => {
      expect(parseSetupArgs(["--customize-skill", "review"])).toEqual({ json: false, targets: [], customizeSkill: "review" });
      expect(parseSetupArgs(["--dry-run", "--customize-skill", "review"])).toEqual({ operation: "dry-run", json: false, targets: [], customizeSkill: "review" });
      expect(parseSetupArgs(["--json", "--customize-skill", "review", "--apply"])).toEqual({ operation: "apply", json: true, targets: [], customizeSkill: "review" });
    });
    it.each([
      ["a repeated flag", ["--customize-skill", "a", "--customize-skill", "b"], "customize_skill_repeated"],
      ["a missing name", ["--customize-skill"], "customize_skill_invalid"],
      ["a name that is an option", ["--customize-skill", "--apply"], "customize_skill_invalid"],
      ["an empty name", ["--customize-skill", ""], "customize_skill_invalid"],
      ["a target", ["--customize-skill", "review", "--target", "codex:user:pi-session-mcp"], "customize_skill_combination"],
      ["a target given first", ["--target", "codex:user:pi-session-mcp", "--customize-skill", "review"], "customize_skill_combination"],
      ["verify", ["--verify", "--customize-skill", "review"], "customize_skill_combination"],
      ["rollback", ["--customize-skill", "review", "--rollback"], "customize_skill_combination"],
      ["remove", ["--customize-skill", "review", "--remove"], "customize_skill_combination"],
    ])("rejects %s", (_name, argv, message) => { expect(() => parseSetupArgs(argv)).toThrow(message); });
  });
});

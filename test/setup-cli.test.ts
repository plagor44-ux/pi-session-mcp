import { describe, expect, it, vi } from "vitest";
import { main } from "../src/setup-main.js";
import { formatSetupHuman, formatSetupResult, parseSetupArgs } from "../src/setup-cli.js";
import type { SetupResult } from "../src/setup-result.js";

const sample: SetupResult = { schemaVersion: 1, operation: "dry-run", status: "planned", exitCode: 0, findings: [{ target: { client: "codex", scope: "user", alias: "pi-session-mcp" }, status: "absent", code: "absent" }] };

describe("setup CLI", () => {
  it("parses writer resets, explicit removal, repository base and Codex", () => {
    expect(parseSetupArgs(["--writer", "a-w1", "--reset", "--base", "main", "--discard", "--apply"]).writer).toEqual({ name: "a-w1", operation: "reset", baseRef: "main", discard: true, apply: true });
    expect(parseSetupArgs(["--writer", "a-w1", "--remove"]).writer).toMatchObject({ operation: "remove", apply: true });
    expect(parseSetupArgs(["--repo", "a", "--base", "main", "--client", "codex"]).repo).toMatchObject({ baseRef: "main", codex: true });
  });
  it("requires only an alias for control and defaults to planning", () => {
    expect(parseSetupArgs(["--isolation-control", "--repo", "a"]).isolationControl).toEqual({ alias: "a", apply: false });
    expect(parseSetupArgs(["--isolation-control", "--repo", "a", "--apply"]).isolationControl?.apply).toBe(true);
    expect(() => parseSetupArgs(["--isolation-control", "--repo", "a", "--mode", "container", "--apply"])).toThrow();
    expect(() => parseSetupArgs(["--isolation-control", "--apply"])).toThrow();
  });
  it("parses JSON and target options", () => { expect(parseSetupArgs(["--apply", "--json", "--target", "codex:user:pi-session-mcp"])).toEqual({ operation: "apply", json: true, targets: [{ client: "codex", scope: "user", alias: "pi-session-mcp" }] }); });
  it("defaults to human dry-run mode", () => { expect(parseSetupArgs(["--target", "codex:user:pi-session-mcp"])).toEqual({ json: false, targets: [{ client: "codex", scope: "user", alias: "pi-session-mcp" }] }); expect(formatSetupHuman(sample)).toContain("dry-run: planned"); });
  it("projects the same sanitized result in JSON", () => { const json = formatSetupResult(sample); expect(JSON.parse(json)).toEqual(sample); expect(json).not.toContain("/home/"); expect(json).not.toContain("sk_"); });
  it("rejects unsupported, repeated, and malformed arguments", () => { expect(() => parseSetupArgs(["--wat"])).toThrow("argument_unsupported"); expect(() => parseSetupArgs(["--apply", "--verify"])).toThrow("operation_repeated"); expect(() => parseSetupArgs(["--target", "codex:user"])).toThrow("target_invalid"); });
  it("does not echo secret or path sentinels from a target projection", () => { const result: SetupResult = { ...sample, findings: [{ ...sample.findings[0]!, target: { client: "codex", scope: "user", alias: "SAFE_ALIAS" }, code: "setup_failed" }] }; const rendered = `${formatSetupResult(result)}\n${formatSetupHuman(result)}`; expect(rendered).not.toContain("SECRET_SENTINEL"); expect(rendered).not.toContain("/tmp/secret"); });
  it.each([["SIGINT", 130], ["SIGTERM", 143]] as const)("reports snapshot interruption by %s", async (signal, code) => {
    const previous = process.env.PI_SESSION_MCP_CONFIG; process.env.PI_SESSION_MCP_CONFIG = "/tmp/test-config";
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const runSnapshot: NonNullable<import("../src/setup-main.js").SetupMainDependencies["runSnapshot"]> = async () => { process.emit(signal); return sample; };
      expect(await main(["--snapshot", "review", "--head", "a".repeat(40), "--base", "b".repeat(40), "--json"], { runSnapshot })).toBe(code);
      expect(JSON.parse(String(output.mock.calls[0]![0]))).toMatchObject({ exitCode: code, findings: [{ code: "operation_interrupted" }] });
    } finally { output.mockRestore(); if (previous === undefined) delete process.env.PI_SESSION_MCP_CONFIG; else process.env.PI_SESSION_MCP_CONFIG = previous; }
  });
  describe("--snapshot", () => {
    const oid = "a".repeat(40), other = "b".repeat(64);
    it("parses planning, apply, discard and removal", () => {
      expect(parseSetupArgs(["--snapshot", "review", "--head", oid, "--base", other]).snapshot).toEqual({ alias: "review", head: oid, base: other, apply: false, remove: false, discard: false });
      expect(parseSetupArgs(["--snapshot", "review", "--head", oid, "--base", other, "--discard", "--apply"]).snapshot).toMatchObject({ apply: true, discard: true });
      expect(parseSetupArgs(["--snapshot", "review", "--remove", "--discard"]).snapshot).toEqual({ alias: "review", apply: true, remove: true, discard: true });
    });
    it.each([
      ["--snapshot", "review"], ["--snapshot", "review", "--head", "main", "--base", oid], ["--snapshot", "review", "--head", oid, "--base", "abc"],
      ["--snapshot", "review", "--remove", "--head", oid], ["--snapshot", "review", "--head", oid, "--base", other, "--writer", "a-w1"],
      ["--snapshot", "review", "--head", oid, "--base", other, "--repo", "a"], ["--snapshot", "review", "--head", oid, "--base", other, "--client", "codex"],
      ["--snapshot", "review", "--head", oid, "--base", other, "--target", "codex:user:pi-session-mcp"], ["--head", oid],
    ])("rejects invalid snapshot arguments %j", (...args) => { expect(() => parseSetupArgs(args)).toThrow(); });
  });
  describe("--repo", () => {
    it("parses snapshot mode with a source and rejects unrelated flags", () => {
      expect(parseSetupArgs(["--repo", "a", "--mode", "snapshot", "--source", "b", "--apply"]).repo).toMatchObject({ alias: "a", mode: "snapshot", source: "b", apply: true });
      for (const args of [["--repo", "a", "--mode", "snapshot"], ["--repo", "a", "--source", "b"], ["--repo", "a", "--mode", "snapshot", "--source", "b", "--writers", "1"]]) expect(() => parseSetupArgs(args)).toThrow();
    });
    it("parses optional resource limits", () => {
      expect(parseSetupArgs(["--repo", "a", "--mode", "container", "--profiles", "code", "--cpus", "1.25", "--cpu-shares", "256", "--memory", "512m"]).repo?.container).toMatchObject({ cpus: 1.25, cpuShares: 256, memory: "512m" });
      const cleared = parseSetupArgs(["--repo", "a", "--mode", "container", "--profiles", "code", "--cpus", "none", "--cpu-shares", "none", "--memory", "none"]).repo;
      expect(cleared?.clearLimits).toEqual(["cpus", "cpuShares", "memory"]);
      expect(cleared?.container).not.toHaveProperty("cpus");
      expect(() => parseSetupArgs(["--repo", "a", "--mode", "host", "--accept-host-writes", "--cpus", "none"])).toThrow("repo_combination");
    });
    it.each([
      ...["0", "-1", "1024.01", "1.001", "NaN", "1e2", ""].map((value) => ["--cpus", value, "cpus_invalid"]),
      ...["1", "262145", "2.5", "-2", ""].map((value) => ["--cpu-shares", value, "cpu_shares_invalid"]),
      ...["0m", "512M", "1gb", "10000000m", "-1g", ""].map((value) => ["--memory", value, "memory_invalid"]),
    ])("rejects resource limit %s %s", (flag, value, code) => {
      expect(() => parseSetupArgs(["--repo", "a", flag!, value!])).toThrow(code);
    });
    it.each(["untracked", "all"])("passes clean %s into container settings", (clean) => {
      expect(parseSetupArgs(["--repo", "a", "--mode", "container", "--profiles", "code", "--clean", clean]).repo?.container?.clean).toBe(clean);
    });
    it.each(["none", "reachable"])("passes tags %s into container settings", (tags) => {
      expect(parseSetupArgs(["--repo", "a", "--mode", "container", "--profiles", "code", "--tags", tags]).repo?.container?.tags).toBe(tags);
    });
    it.each(["none", "go", "uv", "npm"])("passes the selected cache %s into container settings", (cache) => {
      expect(parseSetupArgs(["--repo", "a", "--mode", "container", "--profiles", "code", "--cache", cache]).repo?.container?.cache).toBe(cache);
    });
    it.each([
      [["--repo", "a", "--tags", "all"], "tags_invalid"],
      [["--repo", "a", "--clean", "bogus"], "clean_invalid"],
      [["--repo", "a", "--clean", "all", "--clean", "untracked"], "repo_argument_repeated"],
      [["--repo", "a", "--mode", "host", "--accept-host-writes", "--clean", "all"], "repo_combination"],
      [["--repo", "a", "--cache", "other"], "cache_invalid"],
      [["--repo", "a", "--cache", "go", "--cache", "none"], "repo_argument_repeated"],
      [["--repo", "a", "--mode", "host", "--accept-host-writes", "--cache", "go"], "repo_combination"],
      [["--repo", "a", "--mode", "read-only", "--cache", "none"], "repo_combination"],
      [["--repo", "a", "--cache"], "repo_argument_invalid"],
    ])("rejects invalid cache arguments %j", (argv, code) => {
      expect(() => parseSetupArgs(argv)).toThrow(code);
    });
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
  describe("--list-models and --probe-profile", () => {
    it("parses --list-models", () => {
      expect(parseSetupArgs(["--list-models"])).toEqual({ listModels: true, json: false, targets: [] });
      expect(parseSetupArgs(["--list-models", "--json"])).toEqual({ listModels: true, json: true, targets: [] });
    });
    it("parses --probe-profile as dry run and apply", () => {
      expect(parseSetupArgs(["--probe-profile", "review,code"]).probe).toEqual({ profiles: ["review", "code"], apply: false });
      expect(parseSetupArgs(["--probe-profile", "review,code", "--apply"]).probe).toEqual({ profiles: ["review", "code"], apply: true });
    });
    it("rejects invalid probe aliases", () => {
      expect(parseSetupArgs(["--probe-profile", "review,review"]).probe).toEqual({ profiles: ["review"], apply: false });
      for (const value of ["A", "../x", "review,", "", ",review"]) {
        expect(() => parseSetupArgs(["--probe-profile", value])).toThrow("usage_invalid");
      }
      expect(() => parseSetupArgs(["--probe-profile"])).toThrow("usage_invalid");
      expect(() => parseSetupArgs(["--probe-profile", "--apply"])).toThrow("usage_invalid");
    });
    it("rejects repeated flags", () => {
      expect(() => parseSetupArgs(["--probe-profile", "review", "--probe-profile", "code"])).toThrow("usage_invalid");
      expect(() => parseSetupArgs(["--list-models", "--list-models"])).toThrow("usage_invalid");
    });
    it.each([
      ["a target", ["--probe-profile", "review", "--target", "codex:user:pi-session-mcp"]],
      ["a repository", ["--probe-profile", "review", "--repo", "a"]],
      ["a writer", ["--probe-profile", "review", "--writer", "a-w1"]],
      ["a customized skill", ["--probe-profile", "review", "--customize-skill", "review"]],
      ["the catalog", ["--probe-profile", "review", "--list-models"]],
      ["verify", ["--probe-profile", "review", "--verify"]],
      ["rollback", ["--probe-profile", "review", "--rollback"]],
      ["remove", ["--probe-profile", "review", "--remove"]],
    ])("rejects a probe with %s", (_name, argv) => {
      expect(() => parseSetupArgs(argv)).toThrow();
    });
    it.each([
      ["apply", ["--list-models", "--apply"]],
      ["a target", ["--list-models", "--target", "codex:user:pi-session-mcp"]],
      ["a repository", ["--list-models", "--repo", "a"]],
      ["a writer", ["--list-models", "--writer", "a-w1"]],
      ["a customized skill", ["--list-models", "--customize-skill", "review"]],
      ["a probe", ["--list-models", "--probe-profile", "review"]],
      ["verify", ["--list-models", "--verify"]],
      ["rollback", ["--list-models", "--rollback"]],
      ["remove", ["--list-models", "--remove"]],
    ])("rejects the catalog with %s", (_name, argv) => {
      expect(() => parseSetupArgs(argv)).toThrow();
    });
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

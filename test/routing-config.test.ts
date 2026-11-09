import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type ConfiguredExecutionProfile } from "../src/execution-profile.js";
import { FAMILY_PATTERN, loadRoutingConfig, parseRoutingConfig, ROUTING_OFF, routingConfigPath, tierRank, TIERS, writeRoutingDocument } from "../src/routing/config.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);
const profile = (alias: string, permissionProfile: "coding" | "read-only"): ConfiguredExecutionProfile => ({ alias, permissionProfile, default: false, provider: "fake", model: "fake", thinkingLevel: "medium" });
const profiles = new Map([["writer", profile("writer", "coding")], ["reader", profile("reader", "read-only")]]);
const workspaces = new Map([["repo", "."]]);
const valid = { mode: "manual", tiers: { medium: { code: ["writer"], review: ["reader"] } }, families: { writer: "one", reader: "two" } };

describe("routing configuration", () => {
  it("returns ROUTING_OFF when routing.json is absent", async () => {
    const root = await temporaryRoot("routing-config-");
    const config = await loadRoutingConfig(join(root, "config.json"), profiles, workspaces);
    expect(config).toBe(ROUTING_OFF); expect(config.mode).toBe("off");
  });
  it("applies the default floors and learning limits", () => {
    const config = parseRoutingConfig(valid, profiles, workspaces);
    expect(config.floors).toEqual({ code: "medium", review: "medium", explore: "low", riskHigh: "hightech", workspaces: expect.objectContaining({ size: 0 }) });
    expect(config.learning).toEqual({ minSamples: 8, margin: 0.1, explorationRate: 0.1, explorationBudgetUsd: 5 });
    expect(config.tiers.low.code).toEqual([]);
    expect(TIERS.map(tierRank)).toEqual([0, 1, 2, 3]);
  });
  it.each([
    ["an alias missing from the configuration", { ...valid, tiers: { medium: { code: ["gone"] } } }],
    ["a read-only profile in a code cell", { ...valid, tiers: { medium: { code: ["reader"] } } }],
    ["a coding profile in a review cell", { ...valid, tiers: { medium: { review: ["writer"] } } }],
    ["one alias in two tiers", { ...valid, tiers: { medium: { review: ["reader"] }, low: { explore: ["reader"] } } }],
    ["a tiered alias without a family", { ...valid, families: {} }],
    ["a family that fails FAMILY_PATTERN", { ...valid, families: { writer: "BAD", reader: "two" } }],
    ["an unknown top-level key", { ...valid, secret: "/private/path" }],
    ["a workspace floor for an unknown workspace", { ...valid, floors: { workspaces: { missing: "hightech" } } }],
  ])("refuses %s", (_name, input) => {
    try { parseRoutingConfig(input, profiles, workspaces); expect.fail("expected rejection"); }
    catch (error) { expect(error).toMatchObject({ code: "routing_config_invalid" }); expect((error as Error).message).not.toContain("/private/path"); }
  });
  it("allows one read-only alias in review and explore of the same tier", () => {
    const result = parseRoutingConfig({ ...valid, tiers: { medium: { review: ["reader"], explore: ["reader"] } } }, profiles, workspaces);
    expect(result.tiers.medium.explore).toEqual(["reader"]); expect(result.families.get("reader")).toBe("two");
    expect(FAMILY_PATTERN.test("family-1")).toBe(true);
  });
  it.each([
    { minSamples: 0 }, { minSamples: 1001 }, { minSamples: 1.5 }, { margin: -0.1 }, { margin: 1.1 },
    { explorationRate: -1 }, { explorationRate: 1.1 }, { explorationBudgetUsd: -1 }, { extra: 1 },
  ])("rejects invalid learning limits %j", (learning) => {
    expect(() => parseRoutingConfig({ ...valid, learning }, profiles, workspaces)).toThrowError(expect.objectContaining({ code: "routing_config_invalid" }));
  });
  it("loads overrides and rejects malformed files without leaking paths", async () => {
    const root = await temporaryRoot("routing-config-"); const configPath = join(root, "config.json");
    await writeRoutingDocument(configPath, { ...valid, floors: { code: "ultra", workspaces: { repo: "hightech" } }, learning: { minSamples: 1, margin: 1, explorationRate: 0, explorationBudgetUsd: 0 } });
    const result = await loadRoutingConfig(configPath, profiles, workspaces);
    expect(result.floors.code).toBe("ultra"); expect(result.floors.workspaces.get("repo")).toBe("hightech");
    expect(result.learning).toEqual({ minSamples: 1, margin: 1, explorationRate: 0, explorationBudgetUsd: 0 });
    expect((await stat(routingConfigPath(configPath))).mode & 0o777).toBe(0o600);
    await writeFile(routingConfigPath(configPath), "{");
    await expect(loadRoutingConfig(configPath, profiles, workspaces)).rejects.toMatchObject({ code: "routing_config_invalid", message: expect.not.stringContaining(root) });
  });
  it("atomically replaces a document with private permissions", async () => {
    const root = await temporaryRoot("routing-config-"); const configPath = join(root, "config.json");
    await writeFile(routingConfigPath(configPath), "old", { mode: 0o644 });
    await writeRoutingDocument(configPath, valid);
    expect(JSON.parse(await readFile(routingConfigPath(configPath), "utf8"))).toEqual(valid);
    expect((await stat(routingConfigPath(configPath))).mode & 0o777).toBe(0o600);
  });
});

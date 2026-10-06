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
});

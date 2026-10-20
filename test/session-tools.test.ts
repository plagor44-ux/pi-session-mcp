import { describe, expect, it } from "vitest";
import { composeSessionTools, PROFILE_TOOLS } from "../src/session-tools.js";

describe("composeSessionTools", () => {
  it("keeps read-only output unchanged without a grant", () => {
    expect(composeSessionTools("read-only", ["mcp_note"], [["fixture_tool"]])).toEqual({ ok: true, tools: [...PROFILE_TOOLS["read-only"], "mcp_note"] });
  });

  it("activates exactly the granted extension tools in configured order", () => {
    expect(composeSessionTools("read-only", [], [["a_tool", "b_tool"]], ["b_tool"])).toEqual({ ok: true, tools: ["read", "grep", "find", "ls", "b_tool"] });
    expect(composeSessionTools("read-only", ["mcp_note"], [["a_tool", "b_tool"]], ["b_tool", "a_tool"])).toEqual({ ok: true, tools: [...PROFILE_TOOLS["read-only"], "mcp_note", "b_tool", "a_tool"] });
  });

  it.each(["c_tool", "B_tool"])("fails closed for unregistered grant %s with case-sensitive matching", (name) => {
    expect(composeSessionTools("read-only", [], [["b_tool"]], [name])).toEqual({ ok: false, code: "extension_tool_missing" });
  });

  it("does not satisfy an unregistered extension grant with a granted MCP tool", () => {
    expect(composeSessionTools("read-only", ["mcp_note"], [["fixture_tool"]], ["mcp_note"])).toEqual({ ok: false, code: "extension_tool_missing" });
  });

  it("checks conflicts before missing grants", () => {
    expect(composeSessionTools("read-only", ["mcp_note"], [["mcp_note"]], ["c_tool"])).toEqual({ ok: false, code: "extension_tool_conflict" });
  });

  it("keeps coding output unchanged with or without grants", () => {
    for (const grant of [undefined, ["missing_tool"]]) {
      expect(composeSessionTools("coding", ["mcp_note"], [["fixture_tool"], ["other_tool"]], grant)).toEqual({ ok: true, tools: [...PROFILE_TOOLS.coding, "mcp_note", "fixture_tool", "other_tool"] });
    }
  });

  it.each([
    ["read-only", [], [["read"]]],
    ["read-only", [], [["bash"]]],
    ["coding", ["mcp_note"], [["mcp_note"]]],
    ["coding", [], [["dup"], ["dup"]]],
  ] as const)("fails closed on a %s conflict", (permissionProfile, mcp, extension) => {
    expect(composeSessionTools(permissionProfile, mcp, extension)).toEqual({ ok: false, code: "extension_tool_conflict" });
  });

  it.each(["*", "+x", "-x", "", "mcp__x", "mcp__", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource", "a.b", "a:b", "a".repeat(65)])("rejects the reserved or unsafe extension tool name %j in both profiles", (name) => {
    expect(composeSessionTools("read-only", [], [[name]])).toEqual({ ok: false, code: "extension_tool_conflict" });
    expect(composeSessionTools("coding", [], [[name]])).toEqual({ ok: false, code: "extension_tool_conflict" });
  });

  it.each(["a".repeat(64), "cursor_activate_skill", "fixture_tool", "my-tool", "_x", "mcp_note_x"])("accepts the extension tool name %j", (name) => {
    expect(composeSessionTools("coding", [], [[name]])).toEqual({ ok: true, tools: [...PROFILE_TOOLS.coding, name] });
  });
});

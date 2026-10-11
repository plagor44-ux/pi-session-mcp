import { describe, expect, it } from "vitest";
import { composeSessionTools, PROFILE_TOOLS } from "../src/session-tools.js";

describe("composeSessionTools", () => {
  it("activates extension tools only in coding profiles", () => {
    expect(composeSessionTools("read-only", ["mcp_note"], [["fixture_tool"]])).toEqual([...PROFILE_TOOLS["read-only"], "mcp_note"]);
    expect(composeSessionTools("coding", ["mcp_note"], [["fixture_tool"], ["other_tool"]])).toEqual([...PROFILE_TOOLS.coding, "mcp_note", "fixture_tool", "other_tool"]);
  });

  it.each([
    ["read-only", [], [["read"]]],
    ["read-only", [], [["bash"]]],
    ["coding", ["mcp_note"], [["mcp_note"]]],
    ["coding", [], [["dup"], ["dup"]]],
  ] as const)("fails closed on a %s conflict", (permissionProfile, mcp, extension) => {
    expect(composeSessionTools(permissionProfile, mcp, extension)).toBeUndefined();
  });

  it.each(["*", "+x", "-x", ""])("rejects the extension tool name %j in both profiles", (name) => {
    expect(composeSessionTools("read-only", [], [[name]])).toBeUndefined();
    expect(composeSessionTools("coding", [], [[name]])).toBeUndefined();
  });

  it.each([
    "mcp__x",
    "mcp__",
    "list_mcp_resources",
    "list_mcp_resource_templates",
    "read_mcp_resource",
    "a.b",
    "a:b",
    "a".repeat(65),
  ])("rejects the MCP-reserved or provider-unsafe extension tool name %j in both profiles", (name) => {
    expect(composeSessionTools("read-only", [], [[name]])).toBeUndefined();
    expect(composeSessionTools("coding", [], [[name]])).toBeUndefined();
  });

  it.each(["a".repeat(64), "cursor_activate_skill", "fixture_tool", "my-tool", "_x", "mcp_note_x"])("accepts the extension tool name %j", (name) => {
    expect(composeSessionTools("coding", [], [[name]])).toEqual([...PROFILE_TOOLS.coding, name]);
  });
});

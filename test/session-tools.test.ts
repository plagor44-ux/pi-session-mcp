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
});

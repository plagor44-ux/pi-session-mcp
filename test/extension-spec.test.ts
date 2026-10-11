import { describe, expect, it } from "vitest";
import { parseExtensionSpec, PiExtensionError } from "../src/extension-spec.js";

describe("extension specs", () => {
  it.each([
    ["npm:pi-cursor-sdk@0.5.3", "pi-cursor-sdk", "0.5.3"],
    ["npm:@scope/provider-ext@1.2.3", "@scope/provider-ext", "1.2.3"],
    ["npm:ext@1.0.0-beta.1+build.5", "ext", "1.0.0-beta.1+build.5"],
  ])("parses %s", (spec, name, version) => {
    expect(parseExtensionSpec(spec)).toEqual({ spec, name, version });
    expect(Object.isFrozen(parseExtensionSpec(spec))).toBe(true);
  });

  it.each([
    "pi-cursor-sdk@0.5.3",
    "npm:pi-cursor-sdk",
    "npm:pi-cursor-sdk@^0.5.3",
    "npm:pi-cursor-sdk@~0.5.3",
    "npm:pi-cursor-sdk@latest",
    "npm:pi-cursor-sdk@0.5",
    "git:github.com/owner/repo@1.0.0",
    "npm:../escape@1.0.0",
    "npm:/absolute/path@1.0.0",
    "npm:Upper@1.0.0",
    "npm:@scope@1.0.0",
    " npm:ext@1.0.0",
    `npm:${"a".repeat(260)}@1.0.0`,
  ])("rejects %s", (spec) => {
    expect(parseExtensionSpec(spec)).toBeUndefined();
  });

  it("classifies resolution failures without a path or extension text", () => {
    const error = new PiExtensionError("extension_version_mismatch");
    expect(error).toMatchObject({ name: "PiExtensionError", code: "extension_version_mismatch", message: "Pi extension resolution failed" });
  });
});

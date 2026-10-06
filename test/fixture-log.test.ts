import { describe, expect, it } from "vitest";
import { parseCompleteLines } from "./fixture-log.js";

describe("fixture log parsing", () => {
  it("parses every newline-terminated JSON line", () => {
    expect(parseCompleteLines('{"event":"a"}\n{"event":"b"}\n')).toEqual([{ event: "a" }, { event: "b" }]);
  });

  it("ignores a trailing line that the writer has not finished yet", () => {
    // The fixture appends whole lines; a concurrent reader can still see a prefix of a long one.
    expect(parseCompleteLines('{"event":"a"}\n{"event":"b","text":"' + "x".repeat(70_000))).toEqual([{ event: "a" }]);
  });

  it("returns nothing for empty or absent data", () => {
    expect(parseCompleteLines("")).toEqual([]);
  });
});

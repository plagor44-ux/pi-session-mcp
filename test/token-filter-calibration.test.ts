import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { calibrateFilters } from "../eval/profiles/token-filter-calibration.js";

describe("token filter calibration helper", () => {
  it("returns five sanitized measurements per deterministic case and rejects incomplete success", async () => {
    const rows = await calibrateFilters();
    assert.equal(rows.length, 50);
    assert.deepEqual([...new Set(rows.map(({ case: name }) => name))].sort(), [
      "intermediate", "late_and_sessions", "mixed_final", "ordinary_echo", "private_blocks", "provider_failure", "sdk_length", "streaming", "unicode_boundary", "unknown_block",
    ].sort());
    for (const name of new Set(rows.map(({ case: value }) => value))) {
      assert.deepEqual(rows.filter(({ case: value }) => value === name).map(({ repetition }) => repetition), [1, 2, 3, 4, 5]);
    }
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ["case", "cleanupPassed", "echoMarker", "failure", "independentlyPassed", "outputUtf8Bytes", "providerErrorMarker", "repetition", "state", "streamMarker", "thinkingMarker", "toolMarker", "toolResultMarker", "truncated", "unknownMarker"].sort());
      assert.ok(Number.isSafeInteger(row.outputUtf8Bytes) && row.outputUtf8Bytes >= 0);
      assert.equal(row.independentlyPassed, true, `${row.case} repetition ${row.repetition}: ${JSON.stringify(row)}`);
      assert.equal(row.cleanupPassed, true);
    }
    assert.ok(rows.filter(({ case: name }) => name === "unicode_boundary").every(({ truncated, outputUtf8Bytes }) => truncated && outputUtf8Bytes === 65_536));
    assert.ok(rows.filter(({ case: name }) => name === "provider_failure").every(({ state }) => state === "failed"));
    assert.ok(rows.filter(({ case: name }) => name === "ordinary_echo").every(({ echoMarker }) => echoMarker));
    assert.ok(rows.filter(({ case: name }) => name === "private_blocks").every(({ thinkingMarker, toolMarker }) => !thinkingMarker && !toolMarker));
    assert.ok(rows.filter(({ case: name }) => name === "private_blocks").every(({ toolResultMarker }) => !toolResultMarker));
    assert.ok(rows.filter(({ case: name }) => name === "streaming").every(({ streamMarker }) => !streamMarker));
    await assert.rejects(calibrateFilters(0), RangeError);
  }, 120_000);
  it("retains a failed filter attempt and continues independent cases without raw error text", async () => {
    vi.spyOn(Client.prototype, "callTool").mockRejectedValueOnce(new Error("/private/SYNTHETIC_ERROR"));
    try {
      const rows = await calibrateFilters(1);
      assert.equal(rows.length, 10);
      assert.equal(rows[0]!.failure, "case-error");
      assert.equal(rows[0]!.independentlyPassed, false);
      assert.ok(rows.slice(1).every(r => r.independentlyPassed));
      assert.ok(!JSON.stringify(rows).includes("SYNTHETIC_ERROR"));
    } finally { vi.restoreAllMocks(); }
  }, 120_000);
});

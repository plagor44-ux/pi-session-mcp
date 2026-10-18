import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { symlink, writeFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import { join } from "node:path";
import { ownedTemporary, digest } from "../eval/profiles/files.js";
import { FrameMeter, MeteredStdio, frameSchema } from "../eval/profiles/token-meter.js";
import { runCase } from "../eval/profiles/token-footprint.js";
import { compactReport, makeReport, reportSchema, reportAccepted } from "../eval/profiles/token-reports.js";

describe("token-footprint measurement", () => {
  it("counts exact UTF-8 frames once, correlates responses, and separates overlapping representations", () => {
    const meter = new FrameMeter();
    const request = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pi_turn_get", arguments: {} } }) + "\n");
    meter.observe("request", request);
    const value = { ok: true, turn: { state: "completed", turnId: "synthetic-id", assistantText: "é🙂" } };
    const response = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value } }) + "\n");
    meter.observe("response", response);
    expect(meter.frames[1]).toMatchObject({ wire_bytes: response.length, assistant_bytes: 6, tool: "pi_turn_get", equal_json_representations: true, repeated_terminal: false });
    meter.observe("request", request); meter.observe("response", response);
    expect(meter.frames[3]!.repeated_terminal).toBe(true);
    const persisted = JSON.stringify(meter.frames);
    expect(persisted).not.toContain("synthetic-id"); expect(persisted).not.toContain("é");
    expect(() => frameSchema.parse({ ...meter.frames[0], prompt: "private" })).toThrow();
    expect(meter.frames[0]!.wire_bytes).toBe(request.length);
    expect(meter.frames[1]!.turn_ordinal).toBe(meter.frames[3]!.turn_ordinal);
  });

  it("rejects partial stdout even when the owned child already exited successfully", async () => {
    const temp = await ownedTemporary();
    try {
      const entry = join(temp.root, "partial.mjs");
      await writeFile(entry, 'process.stdout.write("{partial");\n');
      const transport = new MeteredStdio(new FrameMeter(), entry, temp.root);
      await transport.start();
      for (let n = 0; n < 100 && transport.exit_code === null; n++) await pause(10);
      expect(transport.exit_code).toBe(0);
      await expect(transport.close()).rejects.toThrow("fixture_wire_integrity_failed");
      expect(transport.integrity_passed).toBe(false);
      expect(transport.received_bytes).toBe(8);
    } finally { await temp.remove(); }
  });

  it("records per-tool schema serialization separately from the whole discovery frame", () => {
    const meter = new FrameMeter();
    meter.observe("request", Buffer.from('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n'));
    const tool = { name: "pi_turn_get", inputSchema: { type: "object" }, outputSchema: { type: "object" } };
    const raw = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [tool] } }) + "\n");
    meter.observe("response", raw);
    const frame = meter.frames[1]!;
    expect(frame.wire_bytes).toBe(raw.length);
    expect(frame.schema_sizes).toEqual([{ tool: "pi_turn_get", definition_bytes: Buffer.byteLength(JSON.stringify(tool)), input_bytes: 17, output_bytes: 17 }]);
    expect(frame.schema_bytes).toBe(frame.schema_sizes[0]!.definition_bytes + 2);
  });

  it("changes one report factor while preserving failures, blockers, risks and evidence", () => {
    for (const task of ["read", "code"] as const) {
      const baseline = reportSchema.parse(JSON.parse(makeReport(task))), compact = reportSchema.parse(JSON.parse(makeReport(task, true)));
      const { detail: _detail, ...core } = baseline;
      expect(digest(core)).toBe(digest(compact));
      expect(Buffer.byteLength(makeReport(task, true))).toBeLessThan(4096);
      expect(reportAccepted(makeReport(task, true), false, task)).toBe(true);
      for (const invalid of ["{", "null", "[]", JSON.stringify({ ...compact, checks: [] }), JSON.stringify({ ...compact, risks: [] }), JSON.stringify({ ...compact, evidence: [] }), JSON.stringify({ ...compact, status: "failed" }), JSON.stringify({ ...compact, blockers: ["verification-missing"] })]) {
        expect(reportAccepted(invalid, false, task)).toBe(false);
      }
      expect(reportAccepted(makeReport(task, true), true, task)).toBe(false);
      expect(reportAccepted(makeReport(task), false, task)).toBe(false);
    }
    const report = JSON.parse(makeReport("code", true));
    report.checks[1].exit_code = 1;
    expect(reportAccepted(JSON.stringify(report), false, "code")).toBe(false);
    for (const status of ["failed", "blocked"]) {
      const adverse = { ...report, status, blockers: ["verification-missing"], detail: "SYNTHETIC_LOG".repeat(1000) };
      const { detail: _detail, ...expected } = adverse;
      const compact = compactReport(JSON.stringify(adverse));
      expect(JSON.parse(compact)).toEqual(expected);
      expect(reportAccepted(compact, false, "code")).toBe(false);
    }
    // Size/form alone cannot validate truth: the independent T2 oracle must reject unchanged code.
    expect(reportAccepted(makeReport("code", true), false, "code")).toBe(true);
  });

  describe.skipIf(process.platform !== "linux")("actual stdio and independent oracles", () => {
    let build: string, remove: () => Promise<void>;
    beforeAll(async () => {
      const temp = await ownedTemporary(); remove = temp.remove; build = join(temp.root, "build");
      await promisify(execFile)(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.eval.json", "--outDir", build], { timeout: 120000 });
      await symlink(join(process.cwd(), "node_modules"), join(build, "node_modules"), "dir");
    }, 150000);
    afterAll(async () => { await remove?.(); });
    it.each(["code", "two-followup", "domain-error", "unicode-over", "timeout", "abort", "failure"] as const)("calibrates %s, retains sanitation and closes owned sessions/process", async scenario => {
      const previous = process.env.PI_PROFILE_EVAL_BUILD; process.env.PI_PROFILE_EVAL_BUILD = build;
      try {
        const row = await runCase(process.cwd(), build, scenario, "compact", 1);
        expect(row.calibration_passed).toBe(true);
        expect(row.sessions_closed && row.process_closed).toBe(true);
        expect(JSON.stringify(row)).not.toContain(process.cwd());
        if (scenario === "code") expect(row).toMatchObject({ fail_before_observed: true, task_oracle_passed: true, accepted_tasks: 1, compact_form_accepted: true });
        if (scenario === "two-followup") { expect(row).toMatchObject({ starts: 2, turns: 3, accepted_tasks: 3 }); expect(row.polls_per_turn).toHaveLength(3); }
        if (scenario === "timeout") expect(row).toMatchObject({ starts: 1, turns: 0, accepted_tasks: 0 });
      } finally { if (previous === undefined) delete process.env.PI_PROFILE_EVAL_BUILD; else process.env.PI_PROFILE_EVAL_BUILD = previous; }
    }, 15000);
    it("removes only the two labelled repeated terminal fetches", async () => {
      const previous = process.env.PI_PROFILE_EVAL_BUILD; process.env.PI_PROFILE_EVAL_BUILD = build;
      let a, b;
      try { a = await runCase(process.cwd(), build, "repeat", "baseline", 1); b = await runCase(process.cwd(), build, "repeat", "consume-once", 1); }
      finally { if (previous === undefined) delete process.env.PI_PROFILE_EVAL_BUILD; else process.env.PI_PROFILE_EVAL_BUILD = previous; }
      expect(a.calibration_passed && b.calibration_passed).toBe(true);
      expect(a.repeated_terminal_polls).toBe(2); expect(b.repeated_terminal_polls).toBe(0);
      expect(a.controller_calls - b.controller_calls).toBe(2);
      expect(a.accepted_tasks).toBe(b.accepted_tasks);
      expect(a.response_wire_bytes - b.response_wire_bytes).toBe(a.repeated_response_wire_bytes);
    }, 15000);
  });
});

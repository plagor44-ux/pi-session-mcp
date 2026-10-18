import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { z } from "zod";
import { copyFixture, digest, changedPaths, ownedTemporary, snapshot, sourceBinding, hash } from "./files.js";
import { evaluateBounded } from "./oracle-process.js";
import { taskCatalog, versions } from "./catalog.js";
import { taskDefinitions } from "./oracles.js";
import { FrameMeter, MeteredStdio, measuredClient, frameSchema } from "./token-meter.js";
import { compactReport, makeReport, reportAccepted, reportSchema } from "./token-reports.js";
import { calibrateFilters } from "./token-filter-calibration.js";

const number = z.number().nonnegative();
const stages = ["none", "setup", "oracle", "connect", "discovery", "start", "prompt", "consume", "scope", "close", "process", "transport"] as const;
const oracleSchema = z.object({
  phase: z.enum(["baseline", "result"]), status: z.enum(["PASS", "FAIL", "BLOCKED", "INCONCLUSIVE", "NOT_RUN"]),
  checks: z.array(z.object({ id: z.enum(["independent-regression-test", "api-data-flow", "stale-doc-contradiction", "oracle-process-cleanup", "oracle-result", "other"]),
    status: z.enum(["PASS", "FAIL", "BLOCKED", "INCONCLUSIVE", "NOT_RUN"]), exit_code: z.number().int().nullable() }).strict()),
}).strict();
const scenarios = ["read", "code", "two-followup", "delayed", "long", "repeat", "unicode-small", "unicode-exact", "unicode-over", "domain-error", "failure", "abort", "timeout"] as const;
type Scenario = typeof scenarios[number];
type Arm = "baseline" | "compact" | "consume-once";
const rowSchema = z.object({
  scenario: z.enum(scenarios), arm: z.enum(["baseline", "compact", "consume-once"]), repetition: number.int(),
  prompt_hashes: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/)), frames: z.array(frameSchema),
  starts: number.int(), turns: number.int(), accepted_tasks: number.int(), controller_calls: number.int(),
  calls_per_accepted_task: number.nullable(), calls_per_turn: number.nullable(),
  running_polls: number.int(), terminal_polls: number.int(), repeated_terminal_polls: number.int(),
  request_wire_bytes: number.int(), response_wire_bytes: number.int(), discovery_wire_bytes: number.int(),
  repeated_response_wire_bytes: number.int(), duration_ms: number, verification_ms: number,
  task_oracle_passed: z.boolean().nullable(), fail_before_observed: z.boolean(), scope_passed: z.boolean(),
  compact_form_accepted: z.boolean().nullable(), sessions_closed: z.boolean(), process_closed: z.boolean(),
  fixture_exit_code: z.number().int().nullable(), stderr_bytes: number.int(),
  calibration_passed: z.boolean(), failure: z.enum(["none", "case_failed"]),
  failure_stage: z.enum(stages), oracle_results: z.array(oracleSchema),
  transport_integrity_passed: z.boolean(), received_bytes: number.int(), written_bytes: number.int(),
  polls_per_turn: z.array(z.object({ turn_ordinal: number.int(), running: number.int(), terminal: number.int(), repeated: number.int() }).strict()),
  task_prompt_bytes: number.int(),
}).strict();
export type MeasurementRow = z.infer<typeof rowSchema>;

export async function runCase(root: string, build: string, scenario: Scenario, arm: Arm, repetition: number): Promise<MeasurementRow> {
  const temp = await ownedTemporary(), workspace = join(temp.root, "fixture"), task = scenario === "code" ? "code" : "read";
  const meter = new FrameMeter(), transport = new MeteredStdio(meter, join(build, "eval/profiles/token-fixture-server.js"), workspace), client = measuredClient();
  const sessions: string[] = [], prompt_hashes: string[] = [];
  const taskPrompt = taskDefinitions.find(t => t.id === (task === "code" ? "T2" : "T1"))!.prompt;
  let starts = 0, turns = 0, accepted_tasks = 0, task_oracle_passed: boolean | null = null, fail_before_observed = false, scope_passed = false;
  let compact_form_accepted: boolean | null = null, sessions_closed = false, process_closed = false, verification_ms = 0;
  let calibration_passed = false, failure: MeasurementRow["failure"] = "none", duration_ms = 0;
  let stage: typeof stages[number] = "setup", failure_stage: typeof stages[number] = "none";
  const oracle_results: z.infer<typeof oracleSchema>[] = [];
  const beforeTime = performance.now();
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args }, { timeout: 5000 });
    return result.structuredContent as Record<string, any>;
  };
  const verify = async (receipt: unknown) => {
    stage = "oracle";
    const began = performance.now();
    try {
      const result = await evaluateBounded(root, task === "code" ? "T2" : "T1", workspace, receipt, undefined, undefined, 5000);
      const ids = oracleSchema.shape.checks.element.shape.id.options;
      oracle_results.push(oracleSchema.parse({ phase: task === "code" && oracle_results.length === 0 ? "baseline" : "result", status: result.status,
        checks: result.checks.map(c => ({ id: ids.includes(c.id as typeof ids[number]) ? c.id : "other", status: c.status, exit_code: c.exit_code })) }));
      return result;
    }
    finally { verification_ms += performance.now() - began; }
  };
  const start = async () => { stage = "start"; const r = await call("pi_session_start", { workspace: "fixture", executionProfile: "fixture" }); if (!r.ok) throw new Error("start_failed"); starts++; sessions.push(r.session.id); return r.session.id as string; };
  const prompt = async (sessionId: string, followup = false) => {
    stage = "prompt";
    const delay = scenario === "long" ? 420 : scenario === "delayed" ? 120 : 0;
    const text = JSON.stringify({ task, task_prompt: followup ? "Re-read the T1 source and documentation. Return the same two source-linked claims with numeric status values; do not modify files." : taskPrompt, compact: arm === "compact", delay, ...["failure", "abort", "timeout", "unicode-small", "unicode-exact", "unicode-over"].includes(scenario) ? { mode: scenario } : {} });
    prompt_hashes.push(hash(text));
    const r = await call("pi_session_prompt", { sessionId, prompt: text });
    if (r.ok) turns++;
    return r;
  };
  const consume = async (sessionId: string, initial: Record<string, any>) => {
    stage = "consume";
    let turn = initial.turn;
    const deadline = performance.now() + 5000;
    while (turn.state === "running") {
      if (performance.now() >= deadline) throw new Error("case_deadline");
      await pause(60);
      turn = (await call("pi_turn_get", { sessionId, turnId: turn.turnId })).turn;
    }
    if (scenario === "repeat" && arm !== "consume-once") {
      for (let n = 0; n < 2; n++) await call("pi_turn_get", { sessionId, turnId: turn.turnId });
    }
    return turn as Record<string, any>;
  };
  try {
    await copyFixture(join(root, "eval/fixtures", task === "code" ? "T2" : "T1", "public"), workspace);
    const before = await snapshot(workspace);
    if (task === "code") { fail_before_observed = (await verify({})).status === "FAIL"; if (!fail_before_observed) throw new Error("missing_negative_control"); }
    stage = "connect"; await client.connect(transport, { timeout: 5000 });
    stage = "discovery";
    await client.listTools(); await call("pi_capabilities_get", {});
    if (scenario === "domain-error") {
      const r = await call("pi_session_start", { workspace: "missing", executionProfile: "fixture" });
      calibration_passed = r.ok === false && r.error.code === "unknown_workspace";
    } else {
      const ids = [await start()];
      if (scenario === "two-followup") ids.push(await start());
      const pending = [];
      for (const id of ids) pending.push({ id, result: await prompt(id) });
      for (const p of pending) {
        if (scenario === "timeout") { calibration_passed = p.result.ok === false && p.result.error.code === "prompt_timeout"; continue; }
        if (scenario === "abort") await call("pi_session_abort", { sessionId: p.id });
        const turn = await consume(p.id, p.result);
        if (scenario === "abort" || scenario === "failure") { calibration_passed = turn.state === (scenario === "abort" ? "aborted" : "failed"); continue; }
        if (scenario.startsWith("unicode-")) {
          const expected = scenario === "unicode-small" ? 6 : 65536;
          calibration_passed = Buffer.byteLength(turn.assistantText) === expected && turn.truncated === (scenario === "unicode-over") && !turn.assistantText.includes("�");
          continue;
        }
        const report = reportSchema.parse(JSON.parse(turn.assistantText));
        compact_form_accepted = reportAccepted(turn.assistantText, turn.truncated, task);
        const accepted = turn.state === "completed" && !turn.truncated && (await verify(report.receipt)).status === "PASS";
        task_oracle_passed = task_oracle_passed !== false && accepted; if (accepted) accepted_tasks++;
        calibration_passed = task_oracle_passed && (arm !== "compact" || compact_form_accepted === true);
      }
      if (scenario === "two-followup") {
        const turn = await consume(ids[0]!, await prompt(ids[0]!, true));
        const report = reportSchema.parse(JSON.parse(turn.assistantText));
        const accepted = (await verify(report.receipt)).status === "PASS";
        task_oracle_passed = task_oracle_passed !== false && accepted; if (accepted) accepted_tasks++;
        calibration_passed &&= accepted;
      }
    }
    stage = "scope"; const changed = changedPaths(before, await snapshot(workspace));
    scope_passed = changed.join() === (task === "code" ? "contract.mjs" : "");
    calibration_passed &&= scope_passed;
  } catch { failure = "case_failed"; failure_stage = stage; calibration_passed = false; }
  finally {
    try {
      for (const id of sessions) { const r = await call("pi_session_close", { sessionId: id }); if (!r.ok) throw new Error("close_failed"); }
      const listed = await call("pi_session_list", {}); sessions_closed = listed.ok === true && listed.sessions.length === 0;
    } catch { sessions_closed = false; if (failure_stage === "none") failure_stage = "close"; }
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    process_closed = transport.exit_code === 0;
    if (!transport.integrity_passed && failure_stage === "none") failure_stage = "transport";
    if (!process_closed && failure_stage === "none") failure_stage = "process";
    duration_ms = performance.now() - beforeTime - verification_ms;
    await temp.remove();
  }
  const frames = meter.frames;
  const requests = frames.filter(f => f.direction === "request" && f.tool.startsWith("pi_"));
  const polls = frames.filter(f => f.direction === "response" && f.tool === "pi_turn_get");
  const total = (fs: typeof frames) => fs.reduce((n,f) => n + f.wire_bytes, 0);
  return rowSchema.parse({ scenario, arm, repetition, prompt_hashes, frames, starts, turns, accepted_tasks, controller_calls: requests.length,
    calls_per_accepted_task: accepted_tasks ? requests.length / accepted_tasks : null, calls_per_turn: turns ? requests.length / turns : null,
    running_polls: polls.filter(f => f.state === "running").length, terminal_polls: polls.filter(f => ["completed", "failed", "aborted"].includes(f.state)).length,
    repeated_terminal_polls: polls.filter(f => f.repeated_terminal).length,
    request_wire_bytes: total(frames.filter(f => f.direction === "request")), response_wire_bytes: total(frames.filter(f => f.direction === "response")),
    discovery_wire_bytes: total(frames.filter(f => f.tool === "tools/list")), repeated_response_wire_bytes: total(frames.filter(f => f.repeated_terminal)),
    duration_ms, verification_ms, task_oracle_passed, fail_before_observed, scope_passed, compact_form_accepted, sessions_closed, process_closed,
    fixture_exit_code: transport.exit_code, stderr_bytes: transport.stderr_bytes,
    calibration_passed: calibration_passed && sessions_closed && process_closed && transport.integrity_passed, failure, failure_stage, oracle_results,
    transport_integrity_passed: transport.integrity_passed, received_bytes: transport.received_bytes, written_bytes: transport.written_bytes,
    task_prompt_bytes: Buffer.byteLength(taskPrompt),
    polls_per_turn: [...new Set(frames.map(f => f.turn_ordinal).filter((n): n is number => n !== null))].map(turn_ordinal => ({ turn_ordinal,
      running: polls.filter(f => f.turn_ordinal === turn_ordinal && f.state === "running").length,
      terminal: polls.filter(f => f.turn_ordinal === turn_ordinal && ["completed", "failed", "aborted"].includes(f.state)).length,
      repeated: polls.filter(f => f.turn_ordinal === turn_ordinal && f.repeated_terminal).length })),
  });
}

/** Extends PR #84's development runner, with no live mode or new provider path. */
export async function measureFootprint(root: string, output: string) {
  const build = process.env.PI_PROFILE_EVAL_BUILD ?? join(root, ".profile-eval"), binding = await sourceBinding(root);
  const run_id = randomUUID();
  const buildBinding = async () => digest([await snapshot(join(build, "src")), await snapshot(join(build, "eval/profiles")), await snapshot(join(build, "test")), hash(await readFile(join(build, "package.json")))]);
  const build_digest = await buildBinding();
  const started_at = new Date().toISOString(), rows: MeasurementRow[] = [];
  for (const scenario of scenarios) for (let repetition = 1; repetition <= 5; repetition++) rows.push(await runCase(root, build, scenario, "baseline", repetition));
  const baseline = { run_id, binding, build_digest, started_at, rows };
  // Exclusive baseline file is frozen before either candidate is evaluated.
  await writeFile(join(output, "baseline.json"), JSON.stringify(baseline, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  for (const [arm, cases] of [["compact", ["read", "code"]], ["consume-once", ["repeat"]]] as const) {
    for (const scenario of cases) for (let repetition = 1; repetition <= 5; repetition++) rows.push(await runCase(root, build, scenario, arm, repetition));
  }
  const filters = await calibrateFilters(5);
  const report_controls = [];
  for (let repetition = 1; repetition <= 5; repetition++) for (const status of ["failed", "blocked"] as const) {
    const base = JSON.parse(makeReport("code")), adverse = { ...base, status, checks: [{ id: "repaired", exit_code: 1 }], blockers: ["verification-missing"] };
    const { detail: _detail, ...expected } = adverse, compact = compactReport(JSON.stringify(adverse));
    report_controls.push({ repetition, status, preserved: digest(JSON.parse(compact)) === digest(expected),
      incorrectly_accepted: reportAccepted(compact, false, "code"), baseline_bytes: Buffer.byteLength(JSON.stringify(adverse)), compact_bytes: Buffer.byteLength(compact) });
  }
  const source_unchanged = digest(binding) === digest(await sourceBinding(root));
  const build_unchanged = build_digest === await buildBinding();
  const result = { schema_version: "1.0.0", run_id, binding, build_digest, baseline_digest: hash(await readFile(join(output, "baseline.json"))),
    ...await versions(root), node_version: process.version, controller: "scripted-mcp-sdk-client", worker: "scripted-fake-adapter",
    started_at, ended_at: new Date().toISOString(), repetitions: 5, source_unchanged, build_unchanged,
    metric_semantics: { wire_bytes_counts_times: "directly-observed", component_bytes: "utf8-serialization-of-observed-fields", ratios: "calculated-from-observed-counts",
      duration_ms: "harness-wall-minus-separately-recorded-oracle-time", tokens: "unknown-no-tokenizer-or-live-usage", money: "unknown-unmetered", context_projection: "unknown-client-request-not-observed" },
    usage: { controller_input: null, controller_output: null, controller_cache: null, controller_reasoning: null, worker: null, cost_usd: null },
    rows, filters, report_controls, fixtures: (await taskCatalog(root)).filter(t => t.id === "T1" || t.id === "T2"),
    report_fixture_hashes: [hash(makeReport("read")), hash(makeReport("read", true)), hash(makeReport("code")), hash(makeReport("code", true))],
  };
  await writeFile(join(output, "measurement.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return result;
}

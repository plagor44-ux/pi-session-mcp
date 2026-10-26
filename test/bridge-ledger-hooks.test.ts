import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { COMPACT_CONTEXT_MAX_BYTES, compactContext, runCompactHook } from "../eval/bridge/hook-compact.js";
import { runStopHook, stopDecision } from "../eval/bridge/hook-stop.js";
import { applyEvents, createLedger, renderTaskMarkdown, type LedgerEvent, type RunLedger, type RuntimeStatus } from "../eval/bridge/ledger.js";
import { LedgerStore } from "../eval/bridge/ledger-store.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);
const at = "2026-10-26T10:00:00.000Z";
interface FixtureOptions { consumed?: boolean; decision?: "accepted" | "rejected" }
async function fixture(runtime: RuntimeStatus = "running", count = 1, options: FixtureOptions = {}) {
  const consumed = options.consumed ?? true;
  const dir = await temporaryRoot("bridge-ledger-hooks-");
  const events: LedgerEvent[] = [];
  const add = (event: LedgerEvent) => events.push(event);
  add({ type: "instance_connected", instanceId: "ctl", eventId: "connect", at, source: "controller" });
  for (let i = 0; i < count; i++) {
    const taskId = `task-${String(i).padStart(3, "0")}`, sessionId = `session-${i}`, turnId = `turn-${i}`;
    const common = { at, source: "controller" as const };
    add({ ...common, eventId: `declare-${i}`, type: "task_declared", taskId, label: `Task ${i}`, baseCommit: "d93a6d6", dependsOn: [], changeScope: [] });
    add({ ...common, eventId: `attempt-${i}`, type: "attempt_started", taskId, attemptId: `attempt-${i}`, instanceId: "ctl", sessionId, workspaceAlias: "fixture", profileAlias: "fixture", deadlineAt: at });
    add({ ...common, eventId: `start-${i}`, type: "turn_started", sessionId, turnId, kind: "initial" });
    if (runtime === "completed" || runtime === "failed" || runtime === "aborted") {
      add({ ...common, eventId: `terminal-${i}`, type: "turn_terminal", sessionId, turnId, runtime, via: "poll", terminalAt: at });
    }
    if (runtime === "completed") {
      if (consumed) add({ ...common, eventId: `consume-${i}`, type: "result_consumed", sessionId, turnId, textSha256: `sha256:${"a".repeat(64)}`, textBytes: 123, truncated: false });
      if (options.decision) add({ ...common, eventId: `decision-${i}`, type: "decision", taskId, outcome: options.decision, evidence: ["tests passed"] });
    }
  }
  const { ledger, outcomes } = applyEvents(createLedger({ runId: "run-test", controllerLabel: "test", at }), events);
  expect(outcomes.every((o) => o.outcome === "applied")).toBe(true);
  await new LedgerStore(dir).init(ledger);
  return { dir, ledger };
}
/** Applies follow-up events and writes the resulting ledger to a fresh directory. */
async function derived(ledger: RunLedger, events: readonly LedgerEvent[]) {
  const result = applyEvents(ledger, events);
  expect(result.outcomes.every((o) => o.outcome === "applied")).toBe(true);
  const dir = await temporaryRoot("bridge-ledger-hooks-derived-");
  await new LedgerStore(dir).init(result.ledger);
  return { dir, ledger: result.ledger };
}
function closeEvent(sessionId: string, outcome: "closed" | "close_failed" = "closed"): LedgerEvent {
  return { type: "session_closed", eventId: `close-${sessionId}-${outcome}`, at, source: "controller", sessionId, outcome };
}
function safe(output: string, dir: string): string {
  expect(output).not.toContain(dir);
  return output;
}

describe("compaction ledger hook", () => {
  it("is silent for missing configuration, directory or ledger", async () => {
    const dir = await temporaryRoot("bridge-ledger-hooks-missing-");
    for (const target of [undefined, dir, join(dir, "absent")]) expect(safe(await runCompactHook(target), dir)).toBe("");
  });
  it("returns SessionStart context with the rendered ledger", async () => {
    const { dir, ledger } = await fixture("completed");
    const output = JSON.parse(safe(await runCompactHook(dir), dir));
    expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(output.hookSpecificOutput.additionalContext).toContain("do not send a task again that already has a turn");
    expect(output.hookSpecificOutput.additionalContext).toContain(renderTaskMarkdown(ledger));
  });
  it("caps oversized context at 8 KiB on a line boundary with a truncation marker", async () => {
    const { dir, ledger } = await fixture("running", 150);
    const text: string = JSON.parse(safe(await runCompactHook(dir), dir)).hookSpecificOutput.additionalContext;
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(COMPACT_CONTEXT_MAX_BYTES);
    expect(text).toMatch(/\n\[Ledger context truncated\.\]\n$/);
    const retained = text.slice(0, -"[Ledger context truncated.]\n".length);
    expect((`pi-session-mcp run ledger after compaction: do not send a task again that already has a turn; verify every result marked awaiting review before you end the run.\n${renderTaskMarkdown(ledger)}`).startsWith(retained)).toBe(true);
  });
});

describe("verification Stop hook", () => {
  it("does not loop when stop_hook_active is true", async () => {
    const { dir } = await fixture("completed");
    expect(safe(await runStopHook('{"stop_hook_active":true}', dir), dir)).toBe("");
  });
  it("is silent for missing ledgers and invalid input", async () => {
    const dir = await temporaryRoot("bridge-ledger-hooks-missing-");
    for (const target of [undefined, dir, join(dir, "absent")]) expect(safe(await runStopHook("{}", target), dir)).toBe("");
    expect(safe(await runStopHook("not json", dir), dir)).toBe("");
  });
  it("does not block running turns or open sessions alone", async () => {
    const { dir } = await fixture("running", 3);
    expect(safe(await runStopHook("{}", dir), dir)).toBe("");
  });
  it("blocks a completed, consumed result without a decision", async () => {
    const { dir } = await fixture("completed");
    const { reason } = JSON.parse(safe(await runStopHook("{}", dir), dir));
    expect(reason).toContain("task-000");
    expect(reason).toContain("record a decision with ledger-cli apply (type decision)");
    expect(reason).not.toContain("start a new attempt");
  });
  it.each(["failed", "aborted"] as const)("blocks a %s task while its session cleanup is still open", async (runtime) => {
    const { dir } = await fixture(runtime);
    const { reason } = JSON.parse(safe(await runStopHook("{}", dir), dir));
    expect(reason).toContain("task-000");
    expect(reason).toContain("inspect the workspace or collected refs, then close the session (pi_session_close) or start a new attempt");
    expect(reason).not.toContain("ledger-cli apply");
  });
  it.each(["failed", "aborted"] as const)("clears a %s task after the session closes", async (runtime) => {
    const { ledger } = await fixture(runtime);
    for (const outcome of ["closed", "close_failed"] as const) {
      const { dir, ledger: closed } = await derived(ledger, [closeEvent("session-0", outcome)]);
      expect(closed.tasks[0]!.attempts[0]!.cleanup).toBe(outcome);
      expect(safe(await runStopHook("{}", dir), dir)).toBe("");
      expect(stopDecision({}, closed)).toBeUndefined();
    }
  });
  it("does not block a completed turn whose result was never consumed", async () => {
    const { dir, ledger } = await fixture("completed", 1, { consumed: false });
    expect(ledger.tasks[0]!.attempts[0]!.turns[0]!.result).toBeUndefined();
    expect(safe(await runStopHook("{}", dir), dir)).toBe("");
  });
  it("does not block an accepted decision", async () => {
    const { dir } = await fixture("completed", 1, { decision: "accepted" });
    expect(safe(await runStopHook("{}", dir), dir)).toBe("");
  });
  it("does not block a rejected decision", async () => {
    const { dir, ledger } = await fixture("completed", 1, { decision: "rejected" });
    expect(ledger.tasks[0]!.decision?.outcome).toBe("rejected");
    expect(safe(await runStopHook("{}", dir), dir)).toBe("");
  });
  it("uses the latest turn rather than an earlier completed result", async () => {
    const { dir, ledger } = await fixture("completed");
    const { ledger: next, outcomes } = applyEvents(ledger, [{ type: "turn_started", eventId: "follow-up", at, source: "controller", sessionId: "session-0", turnId: "follow-up", kind: "follow_up" }]);
    expect(outcomes[0]?.outcome).toBe("applied");
    expect(stopDecision({}, next)).toBeUndefined();
    expect(safe(JSON.stringify(compactContext(next)), dir)).toContain("running");
    next.tasks[0]!.attempts[0]!.turns = [];
    expect(stopDecision({}, next)).toBeUndefined();
  });
  it("lists completed and failed tasks in their own reason groups", async () => {
    const events: LedgerEvent[] = [{ type: "instance_connected", instanceId: "ctl", eventId: "connect", at, source: "controller" }];
    const common = { at, source: "controller" as const };
    const task = (taskId: string, label: string, attemptId: string, sessionId: string, turnId: string, runtime: "completed" | "failed") => {
      events.push({ ...common, eventId: `declare-${taskId}`, type: "task_declared", taskId, label, baseCommit: "d93a6d6", dependsOn: [], changeScope: [] });
      events.push({ ...common, eventId: `attempt-${taskId}`, type: "attempt_started", taskId, attemptId, instanceId: "ctl", sessionId, workspaceAlias: "fixture", profileAlias: "fixture", deadlineAt: at });
      events.push({ ...common, eventId: `start-${taskId}`, type: "turn_started", sessionId, turnId, kind: "initial" });
      events.push({ ...common, eventId: `terminal-${taskId}`, type: "turn_terminal", sessionId, turnId, runtime, via: "poll", terminalAt: at });
    };
    task("task-done", "Done", "attempt-done", "session-done", "turn-done", "completed");
    events.push({ ...common, eventId: "consume-done", type: "result_consumed", sessionId: "session-done", turnId: "turn-done", textSha256: `sha256:${"b".repeat(64)}`, textBytes: 5, truncated: false });
    task("task-broken", "Broken", "attempt-broken", "session-broken", "turn-broken", "failed");
    const { ledger, outcomes } = applyEvents(createLedger({ runId: "run-test", controllerLabel: "test", at }), events);
    expect(outcomes.every((o) => o.outcome === "applied")).toBe(true);
    const dir = await temporaryRoot("bridge-ledger-hooks-mixed-");
    await new LedgerStore(dir).init(ledger);
    const { reason } = JSON.parse(safe(await runStopHook("{}", dir), dir));
    const [completedGroup, recoveryGroup] = reason.split("Verification needed for ").slice(1);
    expect(completedGroup).toContain("task-done");
    expect(completedGroup).toContain("record a decision with ledger-cli apply (type decision)");
    expect(completedGroup).not.toContain("task-broken");
    expect(recoveryGroup).toContain("task-broken");
    expect(recoveryGroup).toContain("inspect the workspace or collected refs, then close the session (pi_session_close) or start a new attempt");
    expect(recoveryGroup).not.toContain("task-done");
  });
  it("lists at most ten task ids and counts the rest", async () => {
    const { dir } = await fixture("completed", 13);
    const { reason } = JSON.parse(safe(await runStopHook("{}", dir), dir));
    expect(reason.match(/task-\d+/g)).toHaveLength(10);
    expect(reason).toContain("task-009 and 3 more");
    expect(reason).not.toContain("task-010");
  });
});

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const execFileAsync = promisify(execFile);
let compiledRoot = "";
// The README compiles with tsconfig.bridge.json and runs the emitted .bridge-eval files with node.
beforeAll(async () => {
  compiledRoot = await temporaryRoot("bridge-ledger-hooks-build-");
  await execFileAsync(process.execPath, [join(REPO_ROOT, "node_modules/typescript/bin/tsc"), "-p", join(REPO_ROOT, "tsconfig.bridge.json"), "--outDir", compiledRoot], { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 });
}, 120_000);

interface HookProcess { code: number | null; stdout: string; stderr: string }
function runEntry(entry: string, input: string, env: Record<string, string>): Promise<HookProcess> {
  const child = spawn(process.execPath, [entry], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  child.stdin.on("error", () => undefined);
  child.stdin.end(input);
  return new Promise((resolve) => child.once("close", (code) => resolve({ code, stdout, stderr })));
}

describe("compiled ledger hook entry points", () => {
  it("writes one JSON line on a pipe and exits 0, or nothing when failing open", async () => {
    const { dir } = await fixture("completed");
    for (const hook of ["hook-stop", "hook-compact"]) {
      const entry = join(compiledRoot, "eval/bridge", `${hook}.js`);
      const blocked = await runEntry(entry, "{}", { BRIDGE_LEDGER_DIR: dir });
      expect(blocked.code).toBe(0);
      expect(blocked.stderr).toBe("");
      const lines = blocked.stdout.split("\n").filter((line) => line.length > 0);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toBeTypeOf("object");
      expect(await runEntry(entry, "{}", { BRIDGE_LEDGER_DIR: join(dir, "absent") })).toEqual({ code: 0, stdout: "", stderr: "" });
    }
  }, 60_000);
});

it("pure cores fail open for invalid ledger values without diagnostics", () => {
  for (const value of [undefined, null, {}, { tasks: [] }]) {
    expect(compactContext(value as unknown as RunLedger)).toBeUndefined();
    expect(stopDecision({}, value as unknown as RunLedger)).toBeUndefined();
  }
});

it.each(["locked", "invalid", "unreadable"])("both hooks fail open for a %s ledger", async (kind) => {
  const { dir } = await fixture("completed");
  if (kind === "locked") await writeFile(join(dir, "run.json.lock"), "999999");
  else if (kind === "invalid") await writeFile(join(dir, "run.json"), "not json");
  else {
    const { rm, mkdir } = await import("node:fs/promises");
    await rm(join(dir, "run.json"));
    await mkdir(join(dir, "run.json"));
  }
  expect(safe(await runCompactHook(dir), dir)).toBe("");
  expect(safe(await runStopHook("{}", dir), dir)).toBe("");
});

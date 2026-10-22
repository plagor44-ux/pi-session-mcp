import { afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventBridge, SpoolSink, type BridgeEvent } from "../eval/bridge/bridge.js";
import { formatWake, parseBudget, parseHookInput, payloadsOf, releaseHeldClaim, tryClaim, waitForEvent, type WaitResult } from "../eval/bridge/hook-waiter.js";
import { HOOK_LOCK_TIMEOUT_MS, projectHook, runLedgerHook } from "../eval/bridge/hook-ledger.js";
import { LedgerStore } from "../eval/bridge/ledger-store.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

const SESSION = "11111111-1111-4111-8111-111111111111", TURN = "22222222-2222-4222-8222-222222222222", REQUEST = "33333333-3333-4333-8333-333333333333";
const OTHER_TURN = "44444444-4444-4444-8444-444444444444";
const CANARY_TEXT = "CANARY_TEXT_unit_c0de", CANARY_PROMPT = "CANARY_PROMPT_unit_7f3a";
const promptPayload = { ok: true, session: { id: SESSION, workspace: "fixture", executionProfile: "fixture", state: "running" }, turn: { turnId: TURN, sessionId: SESSION, state: "running" } };
const hookInput = (tool: string, response: unknown, input: Record<string, unknown> = {}, id = "toolu_unit_1") => JSON.stringify({ tool_name: `mcp__pi-eval__${tool}`, tool_input: input, tool_response: response, tool_use_id: id });

describe("hook input parsing", () => {
  const target = { sessionId: SESSION, turnId: TURN };
  it("reads session.id and turn.turnId from a plain object response", () => {
    expect(parseHookInput(hookInput("pi_session_prompt", promptPayload)).target).toEqual(target);
  });
  it("reads them from a JSON string response", () => {
    expect(parseHookInput(hookInput("pi_session_prompt", JSON.stringify(promptPayload))).target).toEqual(target);
  });
  it("reads them from an array of content blocks and from structuredContent", () => {
    expect(parseHookInput(hookInput("pi_session_prompt", [{ type: "text", text: JSON.stringify(promptPayload) }])).target).toEqual(target);
    expect(parseHookInput(hookInput("pi_session_prompt", { content: [{ type: "text", text: "not json" }], structuredContent: promptPayload })).target).toEqual(target);
    expect(parseHookInput(hookInput("pi_session_prompt", { content: [{ type: "text", text: JSON.stringify(promptPayload) }], isError: false })).target).toEqual(target);
  });
  it("reads sessionId and turnId of an answer response in every shape", () => {
    const answer = { ok: true, result: "accepted", sessionId: SESSION, turnId: TURN };
    for (const response of [answer, JSON.stringify(answer), [{ type: "text", text: JSON.stringify(answer) }]]) {
      expect(parseHookInput(hookInput("eval_question_answer", response, { requestId: REQUEST, value: "beta" })).target).toEqual(target);
    }
  });
  it("re-arms on a pi_turn_get that still shows the turn running, in every response shape", () => {
    const running = { ok: true, turn: { turnId: TURN, sessionId: SESSION, state: "running" } };
    for (const response of [running, JSON.stringify(running), [{ type: "text", text: JSON.stringify(running) }], { content: [{ type: "text", text: "x" }], structuredContent: running }]) {
      expect(parseHookInput(hookInput("pi_turn_get", response, { sessionId: SESSION, turnId: TURN })).target).toEqual(target);
    }
  });
  it("targets the turn of a rejected answer when the response names it", () => {
    for (const result of ["expired", "already_resolved"]) {
      expect(parseHookInput(hookInput("eval_question_answer", { ok: false, result, sessionId: SESSION, turnId: TURN }, { requestId: REQUEST, value: "beta" })).target).toEqual(target);
    }
  });
  it("arms the asyncRewake hook on prompt, turn read and answer", () => {
    const source = readFileSync(fileURLToPath(new URL("../eval/bridge/claude-probe.ts", import.meta.url)), "utf8");
    const matcher = /matcher: `([^`]*pi_session_prompt[^`]*)`/.exec(source)?.[1] ?? "";
    expect(matcher).toContain("pi_session_prompt"); expect(matcher).toContain("pi_turn_get"); expect(matcher).toContain("eval_question_answer");
  });
  it("returns no target for failures, other tools, bad input and unsafe identifiers", () => {
    expect(parseHookInput(hookInput("pi_session_prompt", { ok: false, error: { code: "session_running", message: "x" } })).target).toBeUndefined();
    expect(parseHookInput(hookInput("pi_turn_get", { ok: true, turn: { ...promptPayload.turn, state: "completed" } })).target).toBeUndefined();
    expect(parseHookInput(hookInput("pi_turn_get", { ok: false, error: { code: "unknown_turn" } })).target).toBeUndefined();
    expect(parseHookInput(hookInput("pi_session_start", promptPayload)).target).toBeUndefined();
    expect(parseHookInput(hookInput("eval_question_answer", { ok: false, result: "unknown_request" })).target).toBeUndefined();
    expect(parseHookInput("not json").target).toBeUndefined();
    expect(parseHookInput("[]").target).toBeUndefined();
    expect(parseHookInput(hookInput("pi_session_prompt", { session: { id: SESSION }, turn: { turnId: "bad id\nwith newline" } })).target).toBeUndefined();
  });
  it("walks nested payloads with a bounded depth and count", () => {
    let deep: unknown = { leaf: true };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    expect(payloadsOf(deep).length).toBeLessThanOrEqual(8);
    expect(payloadsOf(Array.from({ length: 1000 }, () => ({ a: 1 }))).length).toBeLessThanOrEqual(200);
  });
});

async function spoolFixture(clock = () => new Date().toISOString()) {
  const base = await temporaryRoot("bridge-hooks-spool-");
  const bridge = new EventBridge("inst-unit", clock);
  new SpoolSink(join(base, "inst-unit")).attach(bridge);
  const terminal = (turnId = TURN, state: "completed" | "failed" | "aborted" = "completed") => bridge.emit({ kind: "turn_terminal", sessionId: SESSION, turnId, state, via: "bridge" });
  const question = (requestId = REQUEST, recipient: "controller" | "human" = "controller") => bridge.emit({ kind: "question_opened", requestId, sessionId: SESSION, turnId: TURN, recipient, questionKind: "select", deadlineAt: new Date(Date.now() + 60_000).toISOString() });
  return { base, bridge, terminal, question };
}
const wait = (base: string, extra: Partial<Parameters<typeof waitForEvent>[0]> = {}) => waitForEvent({ spoolBase: base, sessionId: SESSION, turnId: TURN, budgetMs: 5000, onBudget: "wake", pollMs: 20, ...extra });
const later = (ms: number, fn: () => void) => new Promise<void>((resolve) => setTimeout(() => { fn(); resolve(); }, ms));

describe("waitForEvent (in process)", () => {
  it("wakes on a terminal event emitted after the wait started, with the content-free line", async () => {
    const { base, terminal } = await spoolFixture();
    const [result] = await Promise.all([wait(base), later(80, () => terminal())]);
    expect(result).toMatchObject({ action: "wake", reason: "terminal", message: `pi-bridge: turn ${TURN} of session ${SESSION} is completed. Read it once with pi_turn_get.` });
    expect(readdirSync(join(base, "claims"))).toEqual(["inst-unit-1"]);
  });
  it("wakes at once for an event that is already in the spool", async () => {
    const { base, terminal } = await spoolFixture();
    terminal(TURN, "failed");
    const started = Date.now();
    const result = await wait(base);
    expect(result).toMatchObject({ action: "wake", reason: "terminal" });
    expect((result as Extract<WaitResult, { action: "wake" }>).message).toContain("is failed.");
    expect(Date.now() - started).toBeLessThan(1000);
  });
  it("wakes for a controller question with the question line and ignores human, resolved and foreign events", async () => {
    const { base, bridge, terminal, question } = await spoolFixture();
    terminal(OTHER_TURN); question("human-q", "human");
    bridge.emit({ kind: "question_opened", requestId: "gone-q", sessionId: SESSION, turnId: TURN, recipient: "controller", questionKind: "input", deadlineAt: new Date().toISOString() });
    bridge.emit({ kind: "question_resolved", requestId: "gone-q", sessionId: SESSION, turnId: TURN, state: "refused" });
    const [result] = await Promise.all([wait(base), later(80, () => question())]);
    expect(result).toMatchObject({ action: "wake", reason: "question", message: `pi-bridge: worker question ${REQUEST} (session ${SESSION}, turn ${TURN}) awaits the controller. Call eval_question_get, then eval_question_answer.` });
  });
  it("lets exactly one of two concurrent waiters claim a terminal event; the other ends without a wake", async () => {
    const { base, terminal } = await spoolFixture();
    const [a, b] = await Promise.all([wait(base), wait(base), later(80, () => terminal())]).then(([x, y]) => [x, y] as const);
    const results = [a, b];
    expect(results.filter((r) => r.action === "wake")).toHaveLength(1);
    expect(results.filter((r) => r.action === "silent")).toEqual([{ action: "silent", reason: "turn_done" }]);
    expect(readdirSync(join(base, "claims"))).toHaveLength(1);
  });
  it("keeps waiting after losing a question claim and then claims the terminal event", async () => {
    const { base, terminal, question } = await spoolFixture();
    question();
    const first = await wait(base);
    expect(first).toMatchObject({ action: "wake", reason: "question" });
    // A second waiter for the same turn cannot claim the question again and keeps waiting for the next event.
    const [second] = await Promise.all([wait(base), later(100, () => terminal())]);
    expect(second).toMatchObject({ action: "wake", reason: "terminal" });
  });
  it("tryClaim is exclusive per event", async () => {
    const { base, terminal } = await spoolFixture();
    const event = terminal();
    expect([tryClaim(base, event), tryClaim(base, event)]).toEqual([true, false]);
  });
  it("releases an undelivered claim so a later waiter can still report the event", async () => {
    const { base, terminal } = await spoolFixture();
    const event = terminal();
    expect(tryClaim(base, event)).toBe(true);
    releaseHeldClaim();
    expect(tryClaim(base, event)).toBe(true);
  });
  it("ends silently without a wake for a turn that close removed unread", async () => {
    const { base, bridge } = await spoolFixture();
    bridge.emit({ kind: "turn_unobserved", sessionId: SESSION, turnId: TURN, via: "close" });
    expect(await wait(base)).toEqual({ action: "silent", reason: "turn_unobserved" });
    expect(existsSync(join(base, "claims"))).toBe(false);
  });
  it("skips a question that was resolved between reading the spool and claiming it", async () => {
    const { base, bridge, question } = await spoolFixture();
    question();
    const result = await wait(base, { budgetMs: 200, onBudget: "silent", beforeClaim: () => { bridge.emit({ kind: "question_resolved", requestId: REQUEST, sessionId: SESSION, turnId: TURN, state: "answered" }); } });
    expect(result).toEqual({ action: "silent", reason: "budget_silent" });
    expect(existsSync(join(base, "claims")) ? readdirSync(join(base, "claims")) : []).toEqual([]);
  });
  it("ends silently with a reason code, and does not throw, when the claim cannot be written", async () => {
    const { base, terminal } = await spoolFixture();
    terminal(); writeFileSync(join(base, "claims"), "not a directory");
    expect(await wait(base)).toMatchObject({ action: "silent", reason: "claim_error" });
  });
  it("parses the wait budget: empty, non-numeric, zero and negative mean the default", () => {
    expect([undefined, "", "  ", "abc", "0", "-5", "NaN", "Infinity"].map(parseBudget)).toEqual(Array(8).fill(120_000));
    expect([parseBudget("300"), parseBudget(" 2500 ")]).toEqual([300, 2500]);
  });
  it("wakes with the budget line when the budget ends (wake policy) and stays silent for the silent policy", async () => {
    const { base } = await spoolFixture();
    const woke = await wait(base, { budgetMs: 150, onBudget: "wake" });
    expect(woke).toEqual({ action: "wake", reason: "budget", message: `pi-bridge: no event for turn ${TURN} within the wait budget; it may still be running.` });
    const silent = await wait(base, { budgetMs: 150, onBudget: "silent" });
    expect(silent).toEqual({ action: "silent", reason: "budget_silent" });
  });
  it("ends silently when the parent disappears", async () => {
    const { base } = await spoolFixture();
    let alive = true;
    const started = Date.now();
    const [result] = await Promise.all([wait(base, { isParentAlive: () => alive, parentCheckMs: 30, budgetMs: 10_000 }), later(100, () => { alive = false; })]);
    expect(result).toEqual({ action: "silent", reason: "parent_gone" });
    expect(Date.now() - started).toBeLessThan(2000);
  });
  it("formats no content beyond identifiers and states", () => {
    const event = { seq: 1, at: new Date().toISOString(), instanceId: "i", kind: "turn_terminal", sessionId: SESSION, turnId: TURN, state: "aborted", via: "close" } as BridgeEvent;
    expect(formatWake(event)).toBe(`pi-bridge: turn ${TURN} of session ${SESSION} is aborted. Read it once with pi_turn_get.`);
    expect(formatWake({ seq: 2, at: event.at, instanceId: "i", kind: "instance_ended", reason: "eof" })).toBe("");
  });
});

// ---- compiled waiter, only when `npx tsc -p tsconfig.bridge.json` has produced it
const COMPILED = fileURLToPath(new URL("../.bridge-eval/eval/bridge/hook-waiter.js", import.meta.url));
const compiled = describe.skipIf(!existsSync(COMPILED));
interface Exit { code: number | null; stderr: string }
function runWaiter(base: string, stdin: string, env: Record<string, string>): { done: Promise<Exit>; pid: number | undefined } {
  const child = spawn(process.execPath, [COMPILED], { env: { PATH: process.env.PATH ?? "", BRIDGE_SPOOL_BASE: base, ...env }, stdio: ["pipe", "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
  child.stdin.end(stdin);
  return { pid: child.pid, done: new Promise((resolve) => child.once("close", (code) => resolve({ code, stderr }))) };
}
compiled("compiled hook-waiter process", () => {
  it("exits 2 with exactly one stderr line on a terminal event", async () => {
    const { base, terminal } = await spoolFixture();
    const waiter = runWaiter(base, hookInput("pi_session_prompt", [{ type: "text", text: JSON.stringify(promptPayload) }]), { BRIDGE_WAIT_BUDGET_MS: "10000" });
    await later(300, () => terminal());
    const exit = await waiter.done;
    expect(exit.code).toBe(2);
    expect(exit.stderr).toBe(`pi-bridge: turn ${TURN} of session ${SESSION} is completed. Read it once with pi_turn_get.\n`);
  });
  it("exits 0 without output when the input has no correlatable turn", async () => {
    const { base } = await spoolFixture();
    const exit = await runWaiter(base, hookInput("pi_session_prompt", { ok: false }), {}).done;
    expect(exit).toEqual({ code: 0, stderr: "" });
  });
  it("with two concurrent waiters on one turn exactly one exits 2", async () => {
    const { base, terminal } = await spoolFixture();
    const input = hookInput("pi_session_prompt", promptPayload), env = { BRIDGE_WAIT_BUDGET_MS: "10000" };
    const a = runWaiter(base, input, env), b = runWaiter(base, input, env);
    await later(400, () => terminal());
    const codes = (await Promise.all([a.done, b.done])).map((e) => e.code).sort();
    expect(codes).toEqual([0, 2]);
  });
  it("applies the budget policy: wake prints the budget line and exits 2, silent exits 0", async () => {
    const { base } = await spoolFixture();
    const input = hookInput("pi_session_prompt", promptPayload);
    const woke = await runWaiter(base, input, { BRIDGE_WAIT_BUDGET_MS: "300", BRIDGE_ON_BUDGET: "wake" }).done;
    expect(woke.code).toBe(2);
    expect(woke.stderr).toBe(`pi-bridge: no event for turn ${TURN} within the wait budget; it may still be running.\n`);
    expect(await runWaiter(base, input, { BRIDGE_WAIT_BUDGET_MS: "300", BRIDGE_ON_BUDGET: "silent" }).done).toEqual({ code: 0, stderr: "" });
  });
  it("exits 0 silently, with a logged reason and no stack trace, when the claim cannot be written", async () => {
    const { base, terminal } = await spoolFixture();
    terminal(); writeFileSync(join(base, "claims"), "not a directory");
    const root = await temporaryRoot("bridge-hooks-claim-"), log = join(root, "waiter.log");
    const exit = await runWaiter(base, hookInput("pi_session_prompt", promptPayload), { BRIDGE_WAIT_BUDGET_MS: "10000", BRIDGE_WAITER_LOG: log }).done;
    expect(exit).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(readFileSync(log, "utf8").trim().split("\n")[0]!)).toMatchObject({ reason: expect.stringMatching(/^claim_error/), exit: 0 });
  });
  it("treats an empty or non-numeric wait budget as the default instead of waking or exiting at once", async () => {
    const { base, terminal } = await spoolFixture();
    const input = hookInput("pi_session_prompt", promptPayload);
    const runs = ["", "abc", "0"].map((budget) => runWaiter(base, input, { BRIDGE_WAIT_BUDGET_MS: budget }));
    let early = 0; for (const run of runs) void run.done.then(() => { early += 1; });
    await later(700, () => undefined); expect(early).toBe(0);
    terminal();
    const exits = await Promise.all(runs.map((run) => run.done));
    expect(exits.filter((exit) => exit.code === 2).map((exit) => exit.stderr)).toEqual([`pi-bridge: turn ${TURN} of session ${SESSION} is completed. Read it once with pi_turn_get.\n`]);
    expect(exits.map((exit) => exit.code).sort()).toEqual([0, 0, 2]);
  });
  it("exits 0 within about two seconds after its parent process is gone", async () => {
    const { base } = await spoolFixture();
    const root = await temporaryRoot("bridge-hooks-parent-");
    const log = join(root, "waiter.log"), input = join(root, "input.json");
    await writeFile(input, hookInput("pi_session_prompt", promptPayload));
    // The shell starts the waiter in the background, stays one second so the waiter records its parent, then exits and orphans it.
    const shell = spawn("sh", ["-c", `"${process.execPath}" "${COMPILED}" < "${input}" > /dev/null 2>&1 & sleep 1`], {
      env: { PATH: process.env.PATH ?? "", BRIDGE_SPOOL_BASE: base, BRIDGE_WAIT_BUDGET_MS: "60000", BRIDGE_WAITER_LOG: log }, stdio: "ignore",
    });
    await new Promise<void>((resolve) => shell.once("close", () => resolve()));
    const end = Date.now() + 5000;
    let line = "";
    while (Date.now() < end) { line = await readFile(log, "utf8").catch(() => ""); if (line) break; await new Promise((r) => setTimeout(r, 100)); }
    expect(JSON.parse(line.trim().split("\n")[0]!)).toMatchObject({ reason: "parent_gone", exit: 0 });
  });
});

// ---- ledger hook
const STARTED_AT = new Date("2026-10-21T10:00:00.000Z");
let tick = 0;
const clock = () => new Date(STARTED_AT.getTime() + (tick++) * 1000);
const startResponse = (sessionId = SESSION) => [{ type: "text", text: JSON.stringify({ ok: true, session: { id: sessionId, workspace: "fixture", executionProfile: "fixture", profile: "read-only", state: "idle" } }) }];
const turnResponse = (state: string, extra: Record<string, unknown> = {}) => ({ content: [{ type: "text", text: JSON.stringify({ ok: true, turn: { turnId: TURN, sessionId: SESSION, state, startedAt: "2026-10-21T10:00:00.000Z", updatedAt: "2026-10-21T10:00:05.000Z", ...extra } }) }] });
const sequence = [
  hookInput("pi_session_start", startResponse(), { workspace: "fixture", executionProfile: "fixture" }, "toolu_a1"),
  hookInput("pi_session_prompt", promptPayload, { sessionId: SESSION, prompt: CANARY_PROMPT }, "toolu_a2"),
  hookInput("pi_turn_get", turnResponse("running"), { sessionId: SESSION, turnId: TURN }, "toolu_a3"),
  hookInput("pi_turn_get", turnResponse("completed", { completedAt: "2026-10-21T10:00:05.000Z", assistantText: CANARY_TEXT, truncated: false }), { sessionId: SESSION, turnId: TURN }, "toolu_a4"),
  hookInput("pi_session_close", [{ type: "text", text: JSON.stringify({ ok: true, session: { id: SESSION, state: "closed" } }) }], { sessionId: SESSION }, "toolu_a5"),
];
async function dirBytes(dir: string): Promise<string> {
  return (await Promise.all(readdirSync(dir).map((name) => readFile(join(dir, name), "latin1").catch(() => "")))).join("\n");
}

describe("hook-ledger projection", () => {
  it("projects a scripted tool sequence into run.json and keeps no text", async () => {
    const dir = await temporaryRoot("bridge-hooks-ledger-");
    const env = { dir, instance: "ctl-unit", runId: "run-unit", now: clock };
    const runs = [];
    for (const input of sequence) runs.push(await runLedgerHook(input, env));
    expect(runs.every((r) => r.error === undefined)).toBe(true);
    const ledger = await new LedgerStore(dir).read();
    expect(ledger.instances.map((i) => i.instanceId)).toEqual(["ctl-unit"]);
    const task = ledger.tasks[0]!, attempt = task.attempts[0]!, turn = attempt.turns[0]!;
    expect(task).toMatchObject({ taskId: `t-${SESSION.slice(0, 8)}`, label: "fixture fixture", work: "awaiting_review" });
    expect(attempt).toMatchObject({ sessionId: SESSION, workspaceAlias: "fixture", profileAlias: "fixture", cleanup: "closed" });
    expect(turn).toMatchObject({ turnId: TURN, kind: "initial", runtime: "completed", terminalVia: "poll", result: { textBytes: Buffer.byteLength(CANARY_TEXT), truncated: false } });
    expect(turn.result?.textSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    const bytes = await dirBytes(dir);
    for (const secret of [CANARY_TEXT, CANARY_PROMPT]) expect(bytes).not.toContain(secret);
  });
  it("is idempotent when the same hook invocation runs again", async () => {
    const dir = await temporaryRoot("bridge-hooks-ledger-");
    const env = { dir, instance: "ctl-unit", runId: "run-unit", now: clock };
    for (const input of sequence) await runLedgerHook(input, env);
    const before = await new LedgerStore(dir).read();
    const again = [];
    for (const input of sequence) again.push(await runLedgerHook(input, env));
    const after = await new LedgerStore(dir).read();
    expect(after.revision).toBe(before.revision);
    expect({ ...after, updatedAt: "", appliedEventIds: [] }).toEqual({ ...before, updatedAt: "", appliedEventIds: [] });
    expect(again.flatMap((r) => r.outcomes).every((o) => o.outcome === "duplicate")).toBe(true);
  });
  it("marks a follow-up prompt, and projects abort_timeout, failed turns and a failed close", async () => {
    const ledger = await (async () => {
      const dir = await temporaryRoot("bridge-hooks-ledger-");
      const env = { dir, instance: "ctl-unit", runId: "run-unit", now: clock };
      await runLedgerHook(sequence[0]!, env); await runLedgerHook(sequence[1]!, env);
      await runLedgerHook(hookInput("pi_turn_get", turnResponse("failed", { completedAt: "2026-10-21T10:00:05.000Z", error: { code: "turn_failed" } }), {}, "toolu_b1"), env);
      return { dir, env };
    })();
    const follow = { ...promptPayload, turn: { ...promptPayload.turn, turnId: OTHER_TURN } };
    await runLedgerHook(hookInput("pi_session_prompt", follow, { sessionId: SESSION, prompt: CANARY_PROMPT }, "toolu_b2"), ledger.env);
    const snapshot = await new LedgerStore(ledger.dir).read();
    expect(snapshot.tasks[0]!.attempts[0]!.turns.map((t) => [t.kind, t.runtime])).toEqual([["initial", "failed"], ["follow_up", "running"]]);
    const events = projectHook(JSON.parse(hookInput("pi_session_abort", { ok: false, error: { code: "abort_timeout", message: "x" } }, { sessionId: SESSION }, "toolu_b3")), snapshot, { instance: "ctl-unit", now: clock });
    expect(events.map((e) => e.type)).toEqual(["instance_connected", "abort_unconfirmed"]);
    const closeFailed = projectHook(JSON.parse(hookInput("pi_session_close", { ok: false, error: { code: "internal_error" } }, { sessionId: SESSION }, "toolu_b4")), snapshot, { instance: "ctl-unit", now: clock });
    expect(closeFailed.at(-1)).toMatchObject({ type: "session_closed", outcome: "close_failed" });
  });
  it("ignores unrelated tools and records errors without throwing", async () => {
    const dir = await temporaryRoot("bridge-hooks-ledger-");
    const env = { dir, instance: "ctl-unit", runId: "run-unit", now: clock };
    expect(await runLedgerHook("not json", env)).toMatchObject({ error: "hook_input_invalid", events: 0 });
    expect(readFileSync(join(dir, "hook-errors.jsonl"), "utf8")).toContain("hook_input_invalid");
    const other = await runLedgerHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: CANARY_PROMPT }, tool_response: CANARY_TEXT, tool_use_id: "toolu_x" }), env);
    expect(other.events).toBe(1); // only the instance connection
    expect(await dirBytes(dir)).not.toContain(CANARY_PROMPT);
  });
  it("skips a synchronous hook within about a second when a stale lock is left, counts it, and never breaks the lock", async () => {
    const dir = await temporaryRoot("bridge-hooks-ledger-");
    const env = { dir, instance: "ctl-unit", runId: "run-unit", now: clock };
    expect((await runLedgerHook(sequence[0]!, env)).error).toBeUndefined();
    writeFileSync(join(dir, "run.json.lock"), "999999");
    const started = Date.now();
    const run = await runLedgerHook(sequence[1]!, env);
    expect(Date.now() - started).toBeLessThan(HOOK_LOCK_TIMEOUT_MS + 1500);
    expect(run).toMatchObject({ error: "ledger_locked", events: 0 });
    expect(readFileSync(join(dir, "hook-errors.jsonl"), "utf8")).toContain("ledger_locked");
    expect(existsSync(join(dir, "run.json.lock"))).toBe(true);
  });
  it("loses no update when at least six hook invocations run in parallel, including the first one", async () => {
    const dir = await temporaryRoot("bridge-hooks-ledger-");
    const ids = Array.from({ length: 8 }, (_, i) => `aaaaaaa${i}-1111-4111-8111-111111111111`);
    const runs = await Promise.all(ids.map((id, i) => runLedgerHook(hookInput("pi_session_start", startResponse(id), {}, `toolu_p${i}`), { dir, instance: "ctl-unit", runId: "run-unit", now: clock, lockTimeoutMs: 30_000 })));
    // A generous lock wait: this checks that serialized writers lose nothing, not the 1 s skip of a single hook.
    expect(runs.filter((r) => r.error)).toEqual([]);
    const ledger = await new LedgerStore(dir).read();
    expect(ledger.tasks.map((t) => t.taskId).sort()).toEqual(ids.map((id) => `t-${id.slice(0, 8)}`).sort());
    expect(ledger.tasks.every((t) => t.attempts.length === 1)).toBe(true);
    expect(ledger.instances).toHaveLength(1);
    expect(ledger.revision).toBe(8); // one applied batch per invocation, none lost
  });
});

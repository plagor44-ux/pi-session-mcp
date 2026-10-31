import { describe, expect, it } from "vitest";
import { SessionRegistry, type SessionRegistryOptions, type TurnView } from "../src/session-registry.js";
import { validateReceipt, validateTextReport } from "../eval/reports/validate.js";
import { FakeAdapter, type FakeHandle } from "./fake-adapter.js";

/**
 * Provider-free fixtures for the server-side facts the #214 NEEDS_CONTEXT route relies on.
 * Everything runs against the real `SessionRegistry`; only the Pi side is faked. Worker
 * report texts follow `skills/pi-session-implementation/SKILL.md` and the receipt form in
 * `eval/reports/validate.ts`.
 */
const profile = { alias: "safe", permissionProfile: "read-only" as const, provider: "fake-provider", model: "fake-model", thinkingLevel: "off" as const };
const deadlines: SessionRegistryOptions = { preflightDeadlineMs: 100, abortDeadlineMs: 1_000, closeCleanupDeadlineMs: 100, shutdownDeadlineMs: 100 };
const BASE = "554dd6166bd9f5485c39a01b60be297c32a4835f";

function setup() {
  const adapter = new FakeAdapter();
  return { adapter, registry: new SessionRegistry(adapter, new Map([["repo", "/safe/repo"]]), deadlines) };
}

/** A scripted prompt that settles during preflight, as a real completed worker turn would. */
function synchronous(assistantText: string) {
  return { assistantText, synchronous: true };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function needsContextText(question: string, label: "Question" | "Open points" = "Question"): string {
  return [
    "STATUS: NEEDS_CONTEXT",
    "Result: cannot continue without an operator decision",
    ...(label === "Question" ? [`Question: ${question}`] : ["Open points:", `- ${question}`]),
    "Concerns:",
    "- none",
  ].join("\n");
}

function needsContextReceipt(question: string): string {
  const receipt = {
    schema: "receipt-v1",
    status: "NEEDS_CONTEXT",
    base: BASE,
    result: { branch: "s17-214-route", commit: null },
    changedFiles: [],
    checks: [],
    concerns: [],
    question,
  };
  return ["STATUS: NEEDS_CONTEXT", "```json", JSON.stringify(receipt, null, 2), "```"].join("\n");
}

/** The structural turn shape the #210 validators consume. */
function asTurn(turn: TurnView) {
  return { assistantText: turn.assistantText ?? "", truncated: turn.truncated === true, completion: turn.completion ?? "stop" };
}

/** Records the prompt texts the registry forwards to one fake Pi session. */
function recordPrompts(handle: FakeHandle): string[] {
  const texts: string[] = [];
  const original = handle.prompt.bind(handle);
  handle.prompt = (text, preflight, onActivity) => {
    texts.push(text);
    return original(text, preflight, onActivity);
  };
  return texts;
}

describe("#214 NEEDS_CONTEXT route fixtures", () => {
  it("answers a question in the same session", async () => {
    const { adapter, registry } = setup();
    const question = "Which deadline constant should the operator use, PREFLIGHT_DEADLINE_MS or ABORT_DEADLINE_MS?";
    const reply = "Use PREFLIGHT_DEADLINE_MS; the operator named it in the controller prompt.";
    adapter.plans.push({ prompts: [synchronous(needsContextText(question)), synchronous(reply)] });
    const session = await registry.start("repo", profile);
    const received = recordPrompts(adapter.handles[0]!);

    const first = await registry.prompt(session.id, "TASK_PROMPT_31c: report the deadline constant the operator means");
    await settle();
    const firstTurn = registry.getTurn(session.id, first.turn.turnId);
    expect(firstTurn).toMatchObject({ state: "completed", sessionId: session.id, assistantText: needsContextText(question) });
    const extraction = validateTextReport(asTurn(firstTurn));
    expect(extraction).toMatchObject({ ok: true, report: { status: "NEEDS_CONTEXT", question } });

    // Answer the extracted question as the controller's follow-up in the same session.
    const answer = "ANSWER_31c: use PREFLIGHT_DEADLINE_MS.";
    const second = await registry.prompt(session.id, answer);
    await settle();
    const secondTurn = registry.getTurn(session.id, second.turn.turnId);

    expect(adapter.handles).toHaveLength(1);
    expect(second.turn.turnId).not.toBe(first.turn.turnId);
    expect(secondTurn).toMatchObject({ state: "completed", sessionId: session.id, assistantText: reply });
    expect(registry.getTurn(session.id, first.turn.turnId).assistantText).toBe(needsContextText(question));
    expect(registry.getTurn(session.id, second.turn.turnId).assistantText).toBe(reply);
    expect(received).toEqual(["TASK_PROMPT_31c: report the deadline constant the operator means", answer]);
    expect(registry.get(session.id).state).toBe("idle");
  });

  it("keeps two concurrent questions apart", async () => {
    const { adapter, registry } = setup();
    const questionA = "QUESTION_A_7c1: which branch should the worker use?";
    const questionB = "QUESTION_B_9d2: which test file should the worker touch?";
    const answerA = "ANSWER_A_5e4: use s17-214-route.";
    const answerB = "ANSWER_B_2f8: touch only test/needs-context-route.test.ts.";
    adapter.plans.push({ prompts: [synchronous(needsContextText(questionA)), synchronous("Worker A resumed with the branch answer.")] });
    adapter.plans.push({ prompts: [synchronous(needsContextText(questionB)), synchronous("Worker B resumed with the file answer.")] });

    const sessionA = await registry.start("repo", profile);
    const sessionB = await registry.start("repo", profile);
    expect(adapter.handles).toHaveLength(2);
    const receivedA = recordPrompts(adapter.handles[0]!);
    const receivedB = recordPrompts(adapter.handles[1]!);

    const firstA = await registry.prompt(sessionA.id, "TASK_PROMPT_A_88a");
    const firstB = await registry.prompt(sessionB.id, "TASK_PROMPT_B_41b");
    await settle();
    const extractedA = validateTextReport(asTurn(registry.getTurn(sessionA.id, firstA.turn.turnId)));
    const extractedB = validateTextReport(asTurn(registry.getTurn(sessionB.id, firstB.turn.turnId)));
    expect(extractedA).toMatchObject({ ok: true, report: { question: questionA } });
    expect(extractedB).toMatchObject({ ok: true, report: { question: questionB } });

    const secondA = await registry.prompt(sessionA.id, answerA);
    const secondB = await registry.prompt(sessionB.id, answerB);
    await settle();

    expect(secondA.turn.sessionId).toBe(sessionA.id);
    expect(secondB.turn.sessionId).toBe(sessionB.id);
    expect(registry.getTurn(sessionA.id, secondA.turn.turnId).assistantText).toBe("Worker A resumed with the branch answer.");
    expect(registry.getTurn(sessionB.id, secondB.turn.turnId).assistantText).toBe("Worker B resumed with the file answer.");
    expect(receivedA).toEqual(["TASK_PROMPT_A_88a", answerA]);
    expect(receivedB).toEqual(["TASK_PROMPT_B_41b", answerB]);
    expect(receivedA.join("\n")).not.toContain(answerB);
    expect(receivedB.join("\n")).not.toContain(answerA);
    expect(() => registry.getTurn(sessionB.id, secondA.turn.turnId)).toThrow(expect.objectContaining({ code: "unknown_turn" }));
    expect(() => registry.getTurn(sessionA.id, secondB.turn.turnId)).toThrow(expect.objectContaining({ code: "unknown_turn" }));
  });

  it("refuses a second answer while the follow-up runs", async () => {
    const { adapter, registry } = setup();
    adapter.plans.push({ prompts: [synchronous(needsContextText("QUESTION_RUNNING_1a3: which value?")), {}] });
    const session = await registry.start("repo", profile);
    const handle = adapter.handles[0]!;
    const received = recordPrompts(handle);

    await registry.prompt(session.id, "TASK_PROMPT_RUNNING_6c0");
    await settle();
    await registry.prompt(session.id, "ANSWER_RUNNING_4d1");
    expect(registry.get(session.id).state).toBe("running");

    await expect(registry.prompt(session.id, "DUPLICATE_ANSWER_RUNNING_e27")).rejects.toMatchObject({ code: "session_running" });
    expect(received).toEqual(["TASK_PROMPT_RUNNING_6c0", "ANSWER_RUNNING_4d1"]);

    handle.complete("Follow-up finished.");
    await settle();
    expect(registry.get(session.id).state).toBe("idle");
  });

  it("refuses an answer after close", async () => {
    const { adapter, registry } = setup();
    adapter.plans.push({ prompts: [synchronous(needsContextText("QUESTION_CLOSED_b48: which value?"))] });
    const session = await registry.start("repo", profile);
    const received = recordPrompts(adapter.handles[0]!);

    await registry.prompt(session.id, "TASK_PROMPT_CLOSED_07e");
    await settle();
    await expect(registry.close(session.id)).resolves.toMatchObject({ id: session.id, state: "closed" });
    await expect(registry.prompt(session.id, "ANSWER_AFTER_CLOSE_9af")).rejects.toMatchObject({ code: "unknown_session" });
    expect(received).toEqual(["TASK_PROMPT_CLOSED_07e"]);
  });

  it("refuses an answer while an abort is pending", async () => {
    const { adapter, registry } = setup();
    adapter.plans.push({ prompts: [synchronous(needsContextText("QUESTION_ABORT_c19: which value?")), {}] });
    const session = await registry.start("repo", profile);
    const handle = adapter.handles[0]!;
    let releaseAbort!: () => void;
    handle.abortGate = new Promise<void>((resolve) => { releaseAbort = resolve; });

    await registry.prompt(session.id, "TASK_PROMPT_ABORT_2b6");
    await settle();
    await registry.prompt(session.id, "ANSWER_ABORT_8f0");
    const aborting = registry.abort(session.id);
    await Promise.resolve();

    await expect(registry.prompt(session.id, "ANSWER_WHILE_ABORTING_5d3")).rejects.toMatchObject({ code: "session_running" });

    releaseAbort();
    await expect(aborting).resolves.toMatchObject({ id: session.id, state: "idle" });
    expect(handle.aborted).toBe(1);
  });

  it("a duplicate answer after the follow-up completed starts a new turn", async () => {
    const { adapter, registry } = setup();
    const question = "QUESTION_DUPLICATE_3e9: which value?";
    adapter.plans.push({
      prompts: [
        synchronous(needsContextText(question)),
        synchronous("First follow-up reply."),
        synchronous("Second, identical follow-up reply."),
      ],
    });
    const session = await registry.start("repo", profile);
    const received = recordPrompts(adapter.handles[0]!);

    const first = await registry.prompt(session.id, "TASK_PROMPT_DUPLICATE_70a");
    await settle();
    const extracted = validateTextReport(asTurn(registry.getTurn(session.id, first.turn.turnId)));
    expect(extracted).toMatchObject({ ok: true, report: { question } });

    const answer = "ANSWER_DUPLICATE_3e9: use the first value.";
    const second = await registry.prompt(session.id, answer);
    await settle();
    // The server keeps no answer ledger: the same text sent again is indistinguishable
    // from a new follow-up, so the controller must deduplicate it.
    const duplicate = await registry.prompt(session.id, answer);
    await settle();

    expect(new Set([first.turn.turnId, second.turn.turnId, duplicate.turn.turnId]).size).toBe(3);
    expect(registry.getTurn(session.id, duplicate.turn.turnId)).toMatchObject({ state: "completed", assistantText: "Second, identical follow-up reply." });
    expect(received).toEqual(["TASK_PROMPT_DUPLICATE_70a", answer, answer]);
    expect(registry.get(session.id).state).toBe("idle");
  });

  it("the typed question in a receipt is machine-readable", async () => {
    const question = "Which deadline constant should the operator use, PREFLIGHT_DEADLINE_MS or ABORT_DEADLINE_MS?";
    const textTurn = { assistantText: needsContextText(question, "Open points"), truncated: false, completion: "stop" as const };
    const receiptTurn = { assistantText: needsContextReceipt(question), truncated: false, completion: "stop" as const };

    const text = validateTextReport(textTurn);
    const receipt = validateReceipt(receiptTurn);

    expect(text).toMatchObject({ ok: true, report: { status: "NEEDS_CONTEXT", question } });
    expect(receipt).toMatchObject({ ok: true, report: { status: "NEEDS_CONTEXT", question } });
    expect(text.ok && text.report.question).toBe(receipt.ok && receipt.report.question);
  });
});

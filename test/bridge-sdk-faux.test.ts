import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type AgentSessionEvent, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import { EventBridge, type BridgeEvent } from "../eval/bridge/bridge.js";
import { createAskControllerTool } from "../eval/bridge/ask-tool.js";
import { QuestionBroker } from "../eval/bridge/questions.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

// Provider-free: a real Pi AgentSession on the faux provider. No credentials, no network, no user agent dir.
const select = { kind: "select", prompt: "CANARY_QUESTION_55aa", options: ["a", "b"] } as const;
async function until(condition: () => boolean, label: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) { if (Date.now() > end) throw new Error(`timeout waiting for ${label}`); await new Promise<void>((resolve) => setTimeout(resolve, 2)); }
}
const noResources = (): ResourceLoader => ({
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => "You are a test assistant.", getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => undefined, reload: async () => undefined,
});

const disposers: Array<() => void> = []; let savedAgentDir: string | undefined;
beforeEach(async () => { savedAgentDir = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = await temporaryRoot("bridge-faux-agent-"); });
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir; });
afterAll(removeTemporaryRoots);

async function harness(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0], withAsk: boolean) {
  const root = await temporaryRoot("bridge-faux-");
  const faux = fauxProvider(); faux.setResponses(responses);
  const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const bridge = new EventBridge("inst-faux"), bridged: BridgeEvent[] = []; bridge.subscribe((event) => bridged.push(event));
  const broker = new QuestionBroker({ instanceId: "inst-faux", bridge });
  const toolSignals: Array<AbortSignal | undefined> = [];
  const tool = createAskControllerTool((spec, signal) => { toolSignals.push(signal); return broker.ask({ sessionId: "faux-session", turnId: "faux-turn", attemptId: "att-1" }, spec, { deadlineMs: 30_000, ...(signal ? { signal } : {}) }); });
  const { session } = await createAgentSession({
    cwd: root, agentDir: root, modelRuntime, model: faux.getModel(), thinkingLevel: "off", resourceLoader: noResources(), noTools: "builtin",
    ...(withAsk ? { customTools: [tool] } : {}), sessionManager: SessionManager.inMemory(root),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 2, baseDelayMs: 5 } }),
  });
  disposers.push(() => { broker.cancelAll("test_end"); session.dispose(); });
  const log: string[] = [], events: AgentSessionEvent[] = [];
  session.subscribe((event) => {
    events.push(event);
    if (event.type === "agent_end") log.push(`agent_end(willRetry=${event.willRetry})`);
    else if (event.type === "agent_settled") log.push(`agent_settled(aborted=${event.aborted})`);
    else if (["agent_start", "auto_retry_start", "auto_retry_end", "tool_execution_start", "tool_execution_end"].includes(event.type)) log.push(event.type);
    else if (event.type === "message_end" && event.message.role === "assistant") log.push(`assistant_end(${(event.message as AssistantMessage).stopReason})`);
  });
  return { session: session as AgentSession, faux, broker, bridged, toolSignals, log, events };
}

describe("Pi SDK 1.4.0 on the faux provider", () => {
  it("(a) retries a transient provider error inside one prompt(): agent_end before the success, one agent_settled, prompt() last", async () => {
    const { session, log, faux } = await harness([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }),
      fauxAssistantMessage("recovered"),
    ], false);
    await session.prompt("CANARY_PROMPT_7f3a"); log.push("prompt_resolved");
    console.log(`observed order (a): ${log.join(" > ")}`);
    const firstEnd = log.findIndex((entry) => entry.startsWith("agent_end")), success = log.indexOf("assistant_end(stop)");
    expect(log.filter((entry) => entry.startsWith("assistant_end"))).toEqual(["assistant_end(error)", "assistant_end(stop)"]);
    expect(log[firstEnd]).toBe("agent_end(willRetry=true)"); expect(firstEnd).toBeGreaterThan(-1); expect(firstEnd).toBeLessThan(success);
    expect(log.filter((entry) => entry.startsWith("agent_settled"))).toEqual(["agent_settled(aborted=false)"]);
    expect(log.filter((entry) => entry === "agent_start").length).toBeGreaterThanOrEqual(2);
    expect(log.at(-1)).toBe("prompt_resolved"); expect(log.at(-2)).toBe("agent_settled(aborted=false)");
    expect(log.at(-3)?.startsWith("agent_end")).toBe(true); expect(log.at(-3)).toBe("agent_end(willRetry=false)");
    expect(faux.state.callCount).toBe(2); expect(session.isStreaming).toBe(false);
  });

  it("(b) keeps prompt() pending and the session streaming while ask_controller waits, then continues with the answer", async () => {
    let seenByModel = "";
    const { session, log, broker, bridged, toolSignals } = await harness([
      fauxAssistantMessage([fauxToolCall("ask_controller", { ...select, options: [...select.options] })], { stopReason: "toolUse" }),
      (context) => { seenByModel = JSON.stringify(context.messages); return fauxAssistantMessage("after the answer"); },
    ], true);
    let settled = false; const prompting = session.prompt("CANARY_PROMPT_7f3a").then(() => { settled = true; log.push("prompt_resolved"); });
    await until(() => bridged.some((e) => e.kind === "question_opened"), "question_opened");
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false); expect(session.isStreaming).toBe(true); expect(broker.openCount()).toBe(1);
    expect(log).not.toContain("tool_execution_end"); expect(toolSignals[0]).toBeInstanceOf(AbortSignal);
    const opened = bridged.find((e) => e.kind === "question_opened")!;
    expect(opened.kind === "question_opened" && broker.answer(opened.requestId, "inst-faux", "b")).toBe("accepted");
    await prompting;
    console.log(`observed order (b): ${log.join(" > ")}`);
    expect(seenByModel).toContain('"toolName":"ask_controller"'); expect(seenByModel).toContain('"text":"b"');
    expect(log.at(-1)).toBe("prompt_resolved"); expect(log.at(-2)).toBe("agent_settled(aborted=false)"); expect(session.isStreaming).toBe(false);
    expect(bridged.map((e) => e.kind)).toEqual(["question_opened", "question_resolved"]);
    for (const event of bridged) expect(JSON.stringify(event)).not.toContain("CANARY_");
  });

  it("(c) abort while ask_controller waits: the tool signal fires, the question is cancelled, prompt() resolves, agent_settled is aborted", async () => {
    const { session, log, broker, bridged, toolSignals } = await harness([
      fauxAssistantMessage([fauxToolCall("ask_controller", { ...select, options: [...select.options] })], { stopReason: "toolUse" }),
      fauxAssistantMessage("must not be needed"),
    ], true);
    const prompting = session.prompt("CANARY_PROMPT_7f3a").then(() => { log.push("prompt_resolved"); });
    await until(() => bridged.some((e) => e.kind === "question_opened"), "question_opened");
    expect(toolSignals[0]?.aborted).toBe(false);
    await session.abort(); await prompting;
    console.log(`observed order (c): ${log.join(" > ")}`);
    expect(toolSignals[0]?.aborted).toBe(true); expect(broker.openCount()).toBe(0);
    expect(bridged.map((e) => [e.kind, e.kind === "question_resolved" ? e.state : undefined])).toEqual([["question_opened", undefined], ["question_resolved", "cancelled"]]);
    expect(log.filter((entry) => entry.startsWith("agent_settled"))).toEqual(["agent_settled(aborted=true)"]);
    expect(log.at(-1)).toBe("prompt_resolved"); expect(session.isStreaming).toBe(false);
  });
});

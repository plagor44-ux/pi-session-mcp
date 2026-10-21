import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { createServer } from "../../src/server.js";
import { BridgedRegistry, EventBridge, SpoolSink } from "./bridge.js";
import { QuestionBroker } from "./questions.js";
import { ScriptedAdapter, type PromptPlan, type ScriptedSessionPlan } from "./scripted-adapter.js";

// Evaluation-only stdio server: the real tool surface over a scripted adapter, plus two question tools.
// Config comes only from the JSON file named by BRIDGE_EVAL_CONFIG. Stdout carries MCP frames only.
interface SessionPlanJson { prompts?: PromptPlan[]; steps?: PromptPlan; abortHangs?: boolean }
interface EvalConfig {
  workspaceDir: string; spoolBase: string; counterFile?: string; trigger: "event" | "supervisor"; supervisorIntervalMs?: number; sessions: SessionPlanJson[];
}
function loadConfig(): EvalConfig {
  const path = process.env.BRIDGE_EVAL_CONFIG;
  if (!path) throw new Error("config_missing");
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<EvalConfig>;
  if (typeof raw.workspaceDir !== "string" || typeof raw.spoolBase !== "string" || !Array.isArray(raw.sessions)) throw new Error("config_invalid");
  if (raw.trigger !== "event" && raw.trigger !== "supervisor") throw new Error("config_invalid");
  return raw as EvalConfig;
}
const config = loadConfig();
const instanceId = `inst-${randomBytes(4).toString("hex")}`;

const bridge = new EventBridge(instanceId);
const adapter = new ScriptedAdapter();
const workspaces = new Map([["fixture", config.workspaceDir]]);
const registry = new BridgedRegistry(adapter, workspaces, {}, bridge);
const broker = new QuestionBroker({ instanceId, bridge }); broker.attach();
const spool = new SpoolSink(join(config.spoolBase, instanceId)); spool.attach(bridge);
adapter.asker = async ({ handle, spec, deadlineMs, signal }) => {
  const ref = await registry.correlation(handle);
  return broker.ask({ ...ref, attemptId: `att-${ref.sessionId.slice(0, 8)}` }, spec, { deadlineMs, signal });
};
for (const plan of config.sessions) {
  const scripted: ScriptedSessionPlan = { prompts: plan.prompts ?? (plan.steps ? [plan.steps] : []), ...(plan.abortHangs ? { abortHangs: true } : {}) };
  adapter.plans.push(scripted);
}

const server = createServer(
  registry, workspaces,
  new Map([["fixture", { alias: "fixture", default: true, permissionProfile: "read-only" as const, provider: "scripted", model: "scripted", thinkingLevel: "off" as const }]]),
  "fixture", { fingerprint: `sha256:${"0".repeat(64)}`, reloadPolicy: "restart-required" },
);

const json = (value: Record<string, unknown>, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError: true } : {}) });
server.registerTool("eval_question_get", {
  description: "Evaluation only. Read one open worker question that awaits the controller.",
  inputSchema: z.object({ requestId: z.string().min(1).max(100) }).strict(),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, ({ requestId }) => {
  const found = broker.get(requestId, instanceId);
  if ("error" in found) return json({ ok: false, error: { code: found.error } }, true);
  return json({ ok: true, question: {
    requestId: found.requestId, sessionId: found.sessionId, turnId: found.turnId, recipient: found.recipient, kind: found.kind, prompt: found.prompt,
    ...(found.options ? { options: found.options } : {}), deadlineAt: found.deadlineAt,
  } });
});
server.registerTool("eval_question_answer", {
  description: "Evaluation only. Answer one open worker question; the waiting worker call continues with the answer.",
  inputSchema: z.object({ requestId: z.string().min(1).max(100), value: z.union([z.string().max(2000), z.boolean()]) }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, ({ requestId, value }) => {
  const ref = broker.turnOf(requestId); // also for a rejected answer (expired, already resolved), so the controller's waiter can target the turn
  const outcome = broker.answer(requestId, instanceId, value);
  return json({ ok: outcome === "accepted", result: outcome, ...(ref ?? {}) }, outcome !== "accepted");
});

// Counters: every tools/call by tool name; pi_turn_get split by running vs terminal result.
const counters = { instanceId, tools: {} as Record<string, number>, pi_turn_get: { running: 0, terminal: 0, error: 0 }, spool_failures: 0 };
const pendingCalls = new Map<string | number, string>();
function flushCounters(): void {
  if (!config.counterFile) return;
  counters.spool_failures = spool.failures;
  const temp = `${config.counterFile}.tmp-${process.pid}`;
  try { writeFileSync(temp, JSON.stringify(counters), { mode: 0o600 }); renameSync(temp, config.counterFile); } catch { /* counters are best effort */ }
}
type Frame = { id?: string | number; method?: string; params?: { name?: unknown }; result?: { structuredContent?: { ok?: unknown; turn?: { state?: unknown } } } };
const transport = new StdioServerTransport();
let incoming = transport.onmessage;
Object.defineProperty(transport, "onmessage", {
  configurable: true,
  get: () => incoming && ((message: Parameters<NonNullable<typeof incoming>>[0]) => {
    const frame = message as Frame;
    if (frame.method === "tools/call" && frame.id !== undefined && typeof frame.params?.name === "string") {
      counters.tools[frame.params.name] = (counters.tools[frame.params.name] ?? 0) + 1;
      pendingCalls.set(frame.id, frame.params.name);
      flushCounters();
    }
    incoming!(message);
  }),
  set: (value) => { incoming = value; },
});
const send = transport.send.bind(transport);
transport.send = async (message) => {
  const frame = message as Frame;
  const name = frame.id !== undefined && frame.method === undefined ? pendingCalls.get(frame.id) : undefined;
  if (name !== undefined && frame.id !== undefined) {
    pendingCalls.delete(frame.id);
    if (name === "pi_turn_get") {
      const structured = frame.result?.structuredContent;
      if (structured?.ok === true) counters.pi_turn_get[structured.turn?.state === "running" ? "running" : "terminal"] += 1; else counters.pi_turn_get.error += 1;
    }
  }
  try { await send(message); } finally { if (name !== undefined) flushCounters(); }
};

await server.connect(transport);
flushCounters();

const supervisor = config.trigger === "supervisor"
  ? setInterval(() => { try { registry.reconcileNow(); } catch { /* best effort */ } }, config.supervisorIntervalMs ?? 1000)
  : undefined;
let closing = false;
async function shutdown(reason: "eof" | "server_exit"): Promise<void> {
  if (closing) return;
  closing = true;
  if (supervisor) clearInterval(supervisor);
  // shutdown emits instance_ended after the closes it triggers
  try { await registry.shutdown(reason); } catch { /* exit anyway */ }
  try { await server.close(); } catch { /* exit anyway */ }
  flushCounters();
  process.exit(0);
}
process.stdin.once("end", () => { void shutdown("eof"); });
process.stdin.once("close", () => { void shutdown("eof"); });
process.once("SIGTERM", () => { void shutdown("server_exit"); });
process.once("SIGINT", () => { void shutdown("server_exit"); });

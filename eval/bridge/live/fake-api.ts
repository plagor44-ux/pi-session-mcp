import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { gunzipSync, inflateSync } from "node:zlib";
import { classifyRequest, writeMessagesResponse, type SyntheticCall } from "../../profiles/token-claude-projection.js";
import { parseRequest } from "../claude-probe.js";
import type { Arm } from "./approval.js";
import { TOOL_PREFIX, WORKER_PROFILE } from "./plan.js";

// Dry-run only: a loopback Messages API with a scripted controller, adapted from the probe. Arm A polls pi_turn_get with a
// Bash `sleep 1` in between until the turn is terminal; arm C ends its turn after the prompt and acts on the wake.
export const DUMMY_KEY = "sk-ant-synthetic-loopback-dummy-0000";
const MAX_MAIN_REQUESTS = 80, BODY_CAP = 4 * 1024 * 1024;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

type Act = { call: { name: string; input: Record<string, unknown> } } | { text: string };
const call = (name: string, input: Record<string, unknown>): Act => ({ call: { name: name === "Bash" ? name : `${TOOL_PREFIX}${name}`, input } });
const text = (value: string): Act => ({ text: value });

/** Pure state machine: the next action from the fresh part of a request and a small key-value memory. */
export function nextAction(arm: Arm, req: ReturnType<typeof parseRequest>, kv: Record<string, string | undefined>): { act: Act; label: string } {
  const last = req.results.at(-1);
  const short = last ? (last.name.startsWith(TOOL_PREFIX) ? last.name.slice(TOOL_PREFIX.length) : last.name) : undefined;
  const json = isObject(last?.json) ? last!.json as Record<string, any> : undefined;
  if (!last) {
    const wake = req.wakes.find((w) => w.kind === "terminal");
    if (wake && kv.sid) return { act: call("pi_turn_get", { sessionId: wake.sessionId, turnId: wake.turnId }), label: "wake_read" };
    if (kv.started === undefined) { kv.started = "1"; return { act: call("pi_capabilities_get", {}), label: "capabilities" }; }
    return { act: text("Nothing further."), label: "idle" };
  }
  switch (short) {
    case "pi_capabilities_get": return { act: call("pi_session_start", { workspace: "fixture", executionProfile: WORKER_PROFILE }), label: "start" };
    case "pi_session_start": {
      const id = json?.session?.id; if (typeof id === "string") kv.sid = id;
      return { act: call("pi_session_prompt", { sessionId: kv.sid ?? "missing", prompt: "Dry-run task: answer with the scripted receipt." }), label: "prompt" };
    }
    case "pi_session_prompt": {
      const id = json?.turn?.turnId; if (typeof id === "string") kv.tid = id;
      return arm === "A" ? { act: call("Bash", { command: "sleep 1", description: "pause before polling" }), label: "sleep" } : { act: text("The worker runs in the background; waiting for its event."), label: "end_turn" };
    }
    case "Bash": return { act: call("pi_turn_get", { sessionId: kv.sid ?? "missing", turnId: kv.tid ?? "missing" }), label: "poll" };
    case "pi_turn_get": return json?.turn?.state === "running"
      ? { act: call("Bash", { command: "sleep 1", description: "pause before polling" }), label: "sleep" }
      : { act: call("pi_session_close", { sessionId: kv.sid ?? "missing" }), label: "close" };
    case "pi_session_close": return { act: call("pi_session_list", {}), label: "list" };
    case "pi_session_list": return { act: text("Done. The session is closed and the list is empty."), label: "done" };
    default: return { act: text("Nothing further."), label: "idle" };
  }
}

export interface FakeApiStats { main: number; auxiliary: number; wakeRequests: number; invalid: boolean; httpUnexpected: number; labels: Record<string, number> }
export interface FakeApi { port: number; stats: FakeApiStats; close(): Promise<void> }

export async function startFakeApi(arm: Arm): Promise<FakeApi> {
  const stats: FakeApiStats = { main: 0, auxiliary: 0, wakeRequests: 0, invalid: false, httpUnexpected: 0, labels: {} };
  const kv: Record<string, string | undefined> = {};
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1"), method = request.method ?? "";
    if (method === "HEAD" && url.pathname === "/api/hello") { response.writeHead(404); response.end(); return; }
    if (method === "POST" && url.pathname === "/v1/messages/count_tokens") { request.resume(); response.writeHead(404); response.end(); return; }
    if (method !== "POST" || url.pathname !== "/v1/messages") { stats.httpUnexpected += 1; request.resume(); response.writeHead(404); response.end(); return; }
    try {
      const chunks: Buffer[] = []; let wire = 0;
      for await (const chunk of request) { wire += Buffer.byteLength(chunk); if (wire > BODY_CAP) { stats.invalid = true; response.writeHead(413); response.end(); return; } chunks.push(Buffer.from(chunk)); }
      let raw = Buffer.concat(chunks);
      const encoding = String(request.headers["content-encoding"] ?? "identity");
      if (encoding === "gzip") raw = gunzipSync(raw, { maxOutputLength: BODY_CAP }); else if (encoding === "deflate") raw = inflateSync(raw, { maxOutputLength: BODY_CAP }); else if (encoding !== "identity") throw new Error("unsupported_encoding");
      const body = JSON.parse(raw.toString("utf8")) as unknown, klass = classifyRequest(request.headers, body);
      if (request.headers["x-api-key"] !== DUMMY_KEY || request.headers.authorization !== undefined) stats.invalid = true;
      const index = stats.main + stats.auxiliary + 1;
      if (klass.role !== "main" || stats.main >= MAX_MAIN_REQUESTS) { stats.auxiliary += 1; writeMessagesResponse(response, index); return; }
      stats.main += 1;
      const parsed = parseRequest(body, klass.role, klass.request_class);
      if (parsed.wakes.length > 0) stats.wakeRequests += 1;
      const { act, label } = nextAction(arm, parsed, kv);
      stats.labels[label] = (stats.labels[label] ?? 0) + 1;
      if ("call" in act) writeMessagesResponse(response, index, { id: `toolu_dry_${index}`, name: act.call.name, input: act.call.input } satisfies SyntheticCall);
      else writeMessagesResponse(response, index);
    } catch { stats.invalid = true; if (!response.headersSent) response.writeHead(400); response.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener_failed");
  return { port: address.port, stats, close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

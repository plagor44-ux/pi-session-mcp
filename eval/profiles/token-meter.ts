import { Client, type JSONRPCMessage, type Transport } from "@modelcontextprotocol/client";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { performance } from "node:perf_hooks";
import { bounded } from "./transport.js";
import { z } from "zod";

const tools = ["pi_capabilities_get", "pi_session_start", "pi_session_prompt", "pi_turn_get", "pi_session_abort", "pi_session_close", "pi_session_list", "pi_session_get", "initialize", "notifications/initialized", "tools/list", "other"] as const;
const size = z.number().int().nonnegative();
export const frameSchema = z.object({
  ordinal: size, elapsed_ms: z.number().nonnegative(), direction: z.enum(["request", "response"]),
  tool: z.enum(tools), wire_bytes: size, content_bytes: size, structured_bytes: size,
  content_text_bytes: size, prompt_bytes: size, assistant_bytes: size, schema_bytes: size,
  state: z.enum(["none", "running", "completed", "failed", "aborted", "domain-error", "protocol-error"]),
  repeated_terminal: z.boolean(), equal_json_representations: z.boolean(),
  session_ordinal: size.nullable(), turn_ordinal: size.nullable(),
  schema_sizes: z.array(z.object({ tool: z.enum(tools), definition_bytes: size, input_bytes: size, output_bytes: size }).strict()),
}).strict();
export type Frame = z.infer<typeof frameSchema>;
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" ? v as Record<string, unknown> : {};
const bytes = (v: unknown) => v === undefined ? 0 : Buffer.byteLength(JSON.stringify(v), "utf8");

/** Raw frames stay in memory for one callback only. Records are field allowlists. */
export class FrameMeter {
  readonly frames: Frame[] = [];
  private readonly requests = new Map<unknown, { tool: typeof tools[number]; sessionId: unknown; turnId: unknown }>();
  private readonly sessions = new Map<unknown, number>();
  private readonly turns = new Map<unknown, number>();
  private readonly consumed = new Set<unknown>();
  private readonly started = performance.now();
  observe(direction: Frame["direction"], raw: Buffer): JSONRPCMessage {
    const message = JSON.parse(raw.toString("utf8")) as JSONRPCMessage;
    const m = object(message), p = object(m.params), r = object(m.result), s = object(r.structuredContent), turn = object(s.turn);
    const label = m.method === "tools/call" ? p.name : m.method;
    const prior = this.requests.get(m.id), args = object(p.arguments);
    const tool = direction === "request" ? (tools.includes(label as typeof tools[number]) ? label as typeof tools[number] : "other") : prior?.tool ?? "other";
    if (direction === "request" && m.id !== undefined) this.requests.set(m.id, { tool, sessionId: args.sessionId, turnId: args.turnId });
    if (direction === "response") this.requests.delete(m.id);
    const terminal = ["completed", "failed", "aborted"].includes(String(turn.state));
    const repeated = direction === "response" && tool === "pi_turn_get" && terminal && this.consumed.has(turn.turnId);
    if (direction === "response" && terminal) this.consumed.add(turn.turnId);
    const content = Array.isArray(r.content) ? r.content.map(object) : [];
    const text = content.filter(c => c.type === "text" && typeof c.text === "string").map(c => String(c.text));
    const state = m.error ? "protocol-error" : s.ok === false ? "domain-error" : ["running", "completed", "failed", "aborted"].includes(String(turn.state)) ? turn.state as Frame["state"] : "none";
    const sessionKey = direction === "request" ? args.sessionId : turn.sessionId ?? object(s.session).id ?? prior?.sessionId;
    const turnKey = direction === "request" ? args.turnId : turn.turnId ?? prior?.turnId;
    const ordinal = (map: Map<unknown, number>, key: unknown) => {
      if (typeof key !== "string") return null;
      if (!map.has(key)) map.set(key, map.size + 1);
      return map.get(key)!;
    };
    this.frames.push(frameSchema.parse({
      ordinal: this.frames.length, elapsed_ms: performance.now() - this.started, direction, tool,
      wire_bytes: raw.length, content_bytes: bytes(r.content), structured_bytes: bytes(r.structuredContent),
      content_text_bytes: text.reduce((n,t) => n + Buffer.byteLength(t), 0),
      prompt_bytes: typeof object(p.arguments).prompt === "string" ? Buffer.byteLength(String(object(p.arguments).prompt)) : 0,
      assistant_bytes: typeof turn.assistantText === "string" ? Buffer.byteLength(turn.assistantText) : 0,
      schema_bytes: tool === "tools/list" && direction === "response" ? bytes(r.tools) : 0,
      state, repeated_terminal: repeated,
      equal_json_representations: text.length === 1 && text[0] === JSON.stringify(r.structuredContent),
      session_ordinal: ordinal(this.sessions, sessionKey), turn_ordinal: ordinal(this.turns, turnKey),
      schema_sizes: tool === "tools/list" && direction === "response" && Array.isArray(r.tools) ? r.tools.map(object).map(t => ({
        tool: tools.includes(t.name as typeof tools[number]) ? t.name as typeof tools[number] : "other",
        definition_bytes: bytes(t), input_bytes: bytes(t.inputSchema), output_bytes: bytes(t.outputSchema),
      })) : [],
    }));
    return message;
  }
}

/** Public custom-Transport seam; measures the actual bytes written/read, including LF. */
export class MeteredStdio implements Transport {
  onmessage?: Transport["onmessage"];
  onerror?: Transport["onerror"];
  onclose?: Transport["onclose"];
  private child: ChildProcessWithoutNullStreams | undefined;
  private exited: Promise<void> | undefined;
  private pending = Buffer.alloc(0);
  private finished = false;
  exit_code: number | null = null;
  stderr_bytes = 0;
  received_bytes = 0;
  written_bytes = 0;
  integrity_passed = true;
  constructor(readonly meter: FrameMeter, private readonly entry: string, private readonly workspace: string) {}
  async start(): Promise<void> {
    const child = spawn(process.execPath, [this.entry], { stdio: "pipe", env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", TOKEN_FIXTURE_WORKSPACE: this.workspace,
    } });
    this.child = child;
    this.exited = new Promise(resolve => child.once("close", code => { this.exit_code = code; this.finished = true; this.onclose?.(); resolve(); }));
    child.on("error", () => { this.integrity_passed = false; this.onerror?.(new Error("fixture_process_error")); });
    child.stdin.on("error", () => { this.integrity_passed = false; this.onerror?.(new Error("fixture_stdin_error")); });
    child.stderr.on("data", (chunk: Buffer) => { this.stderr_bytes += chunk.length; });
    child.stdout.on("data", (chunk: Buffer) => {
      this.received_bytes += chunk.length;
      this.pending = Buffer.concat([this.pending, chunk]);
      if (this.pending.length > 2 * 1024 * 1024) { this.integrity_passed = false; this.onerror?.(new Error("fixture_frame_limit")); child.kill(); return; }
      let end: number;
      while ((end = this.pending.indexOf(10)) !== -1) {
        const raw = this.pending.subarray(0, end + 1); this.pending = this.pending.subarray(end + 1);
        try { this.onmessage?.(this.meter.observe("response", raw)); }
        catch { this.integrity_passed = false; this.onerror?.(new Error("fixture_invalid_frame")); }
      }
    });
  }
  async send(message: JSONRPCMessage): Promise<void> {
    const raw = Buffer.from(JSON.stringify(message) + "\n");
    this.meter.observe("request", raw);
    await new Promise<void>((resolve, reject) => this.child!.stdin.write(raw, error => {
      if (error) { this.integrity_passed = false; reject(new Error("fixture_write_failed")); }
      else { this.written_bytes += raw.length; resolve(); }
    }));
  }
  async close(): Promise<void> {
    if (!this.child) return;
    if (!this.finished) {
      this.child.stdin.end();
      try { await bounded(this.exited!, 2000); }
      catch { this.child.kill("SIGTERM"); try { await bounded(this.exited!, 1000); } catch { this.child.kill("SIGKILL"); await bounded(this.exited!, 1000); } }
    }
    const sum = (direction: Frame["direction"]) => this.meter.frames.filter(f => f.direction === direction).reduce((n,f) => n + f.wire_bytes, 0);
    if (this.pending.length || sum("response") !== this.received_bytes || sum("request") !== this.written_bytes) this.integrity_passed = false;
    if (!this.integrity_passed) throw new Error("fixture_wire_integrity_failed");
  }
}

export function measuredClient() { return new Client({ name: "token-footprint-offline", version: "1.0.0" }); }

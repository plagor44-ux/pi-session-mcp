import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { z } from "zod";
import { FrameMeter, frameSchema, type Frame } from "./token-meter.js";

const nonnegative = z.number().int().nonnegative();
const allowedTools = new Set(["pi_capabilities_get", "pi_session_start", "pi_session_prompt", "pi_turn_get", "pi_session_abort", "pi_session_close", "pi_session_list", "pi_session_get"]);
export const proxyMetricsSchema = z.object({
  schema_version: z.literal("token-live-proxy-1"), integrity_passed: z.boolean(),
  received_bytes: nonnegative, written_bytes: nonnegative, controller_bytes: nonnegative,
  server_exit_code: z.number().int().nullable(), server_cleanup_observed: z.boolean(),
  start_attempts: nonnegative, prompt_attempts: nonnegative, quota_rejections: nonnegative, discover_requests: nonnegative,
  empty_session_list_observed: z.boolean(),
  route_checks: z.array(z.object({ session_ordinal: nonnegative, passed: z.boolean(), profile: z.enum(["read-only", "coding"]) }).strict()),
  closed_session_ordinals: z.array(nonnegative), session_list_after_all_closed: z.boolean(), stderr_bytes: nonnegative,
  fatal_request: z.boolean(), worker_turn_timed_out: z.boolean(), frames: z.array(frameSchema),
}).strict();
export type ProxyMetrics = z.infer<typeof proxyMetricsSchema>;

/** Byte-transparent frame observer. Raw partial frames are discarded after each callback. */
export class TokenFrameForwarder {
  readonly meter = new FrameMeter();
  private readonly pending = { request: Buffer.alloc(0), response: Buffer.alloc(0) };
  integrityPassed = true;
  receivedBytes = 0;
  writtenBytes = 0;
  controllerBytes = 0;
  startAttempts = 0;
  promptAttempts = 0;
  quotaRejections = 0;
  discoverRequests = 0;
  emptySessionListObserved = false;
  readonly routeChecks: Array<{ session_ordinal: number; passed: boolean; profile: "read-only" | "coding" }> = [];
  readonly closedSessionOrdinals = new Set<number>();
  readonly successfulStartOrdinals = new Set<number>();
  sessionListAfterAllClosed = false;
  stderrBytes = 0;
  fatalRequest = false;
  workerTurnTimedOut = false;
  private readonly expectedStartProfiles = new Map<unknown, "review" | "code" | undefined>();
  private readonly promptTimers = new Map<unknown, { timer: NodeJS.Timeout; requestId: unknown; turnId: string | null }>();
  private readonly promptRequests = new Map<unknown, number | null>();

  constructor(private readonly limits: { maxStarts: number; maxPrompts: number; workerTurnMs?: number; onWorkerTurnTimeout?: () => void } = { maxStarts: Number.MAX_SAFE_INTEGER, maxPrompts: Number.MAX_SAFE_INTEGER }) {}

  forward(direction: "request" | "response", chunk: Buffer, write: (bytes: Buffer) => void, reject?: (bytes: Buffer) => void): void {
    if (direction === "request") this.controllerBytes += chunk.length;
    else this.receivedBytes += chunk.length;
    if (direction === "request" && this.fatalRequest) return;
    this.pending[direction] = Buffer.concat([this.pending[direction], chunk]);
    if (this.pending[direction].length > 2 * 1024 * 1024) {
      this.integrityPassed = false;
      const overflow = this.pending[direction];
      this.pending[direction] = Buffer.alloc(0);
      if (direction === "request") this.fatalRequest = true;
      else { try { write(overflow); } catch { this.integrityPassed = false; } }
    } else {
      let end: number;
      while ((end = this.pending[direction].indexOf(10)) >= 0) {
        const raw = this.pending[direction].subarray(0, end + 1);
        this.pending[direction] = this.pending[direction].subarray(end + 1);
        let message: unknown;
        try { message = this.meter.observe(direction, raw); }
        catch {
          this.integrityPassed = false;
          if (direction === "request") { this.fatalRequest = true; this.pending.request = Buffer.alloc(0); break; }
          try { write(raw); } catch { this.integrityPassed = false; }
          continue;
        }
        try {
          if (direction === "response" && this.meter.frames.at(-1)?.tool === "pi_session_list") {
            const result = message && typeof message === "object" && "result" in message ? (message as { result?: unknown }).result : undefined;
            const outer = result && typeof result === "object" ? result as Record<string, unknown> : {};
            const structured = outer.structuredContent && typeof outer.structuredContent === "object" ? outer.structuredContent as Record<string, unknown> : {};
            const successful = structured.ok === true && Array.isArray(structured.sessions);
            if (successful && (structured.sessions as unknown[]).length === 0) {
              this.emptySessionListObserved = true;
              if (this.successfulStartOrdinals.size > 0 && [...this.successfulStartOrdinals].every(ordinal => this.closedSessionOrdinals.has(ordinal))) this.sessionListAfterAllClosed = true;
            }
          }
          if (direction === "response" && this.meter.frames.at(-1)?.tool === "pi_session_start") {
            const envelope = message as { id?: unknown; result?: unknown };
            const result = envelope.result && typeof envelope.result === "object" ? envelope.result as Record<string, unknown> : {};
            const structured = result.structuredContent && typeof result.structuredContent === "object" ? result.structuredContent as Record<string, unknown> : {};
            const session = structured.session && typeof structured.session === "object" ? structured.session as Record<string, unknown> : {};
            const profile = this.expectedStartProfiles.get(envelope.id);
            const route = profile === "code" ? { profile: "coding" as const, provider: "openai-codex", model: "gpt-6.1-sol", thinkingLevel: "medium" }
              : { profile: "read-only" as const, provider: "openai-codex", model: "gpt-6.1-sol", thinkingLevel: "high" };
            const ordinal = this.meter.frames.at(-1)?.session_ordinal;
            if (ordinal !== null && ordinal !== undefined) {
              const passed = profile !== undefined && structured.ok === true && session.executionProfile === profile && session.profile === route.profile
                && session.provider === route.provider && session.model === route.model && session.thinkingLevel === route.thinkingLevel;
              this.routeChecks.push({ session_ordinal: ordinal, profile: route.profile, passed });
              if (passed) this.successfulStartOrdinals.add(ordinal);
            }
          }
          if (direction === "response" && this.meter.frames.at(-1)?.tool === "pi_session_prompt") {
            const envelope = message as { id?: unknown; result?: unknown };
            const response = envelope.result && typeof envelope.result === "object" ? envelope.result as Record<string, unknown> : {};
            const structured = response.structuredContent && typeof response.structuredContent === "object" ? response.structuredContent as Record<string, unknown> : {};
            const turn = structured.turn && typeof structured.turn === "object" ? structured.turn as Record<string, unknown> : {};
            const key = this.promptRequests.get(envelope.id);
            this.promptRequests.delete(envelope.id);
            const active = key === null || key === undefined ? undefined : this.promptTimers.get(key);
            if (active && active.requestId === envelope.id) {
              if (structured.ok !== true) { clearTimeout(active.timer); this.promptTimers.delete(key!); }
              else if (typeof turn.turnId === "string") {
                active.turnId = turn.turnId;
                if (["completed", "failed", "aborted"].includes(String(turn.state))) { clearTimeout(active.timer); this.promptTimers.delete(key!); }
              }
            }
          }
          if (direction === "response" && this.meter.frames.at(-1)?.tool === "pi_turn_get") {
            const state = this.meter.frames.at(-1)?.state;
            const ordinal = this.meter.frames.at(-1)?.session_ordinal;
            if (ordinal !== null && ordinal !== undefined && ["completed", "failed", "aborted"].includes(state ?? "")) {
              const response = message && typeof message === "object" && "result" in message ? (message as { result?: unknown }).result : undefined;
              const outer = response && typeof response === "object" ? response as Record<string, unknown> : {};
              const structured = outer.structuredContent && typeof outer.structuredContent === "object" ? outer.structuredContent as Record<string, unknown> : {};
              const turn = structured.turn && typeof structured.turn === "object" ? structured.turn as Record<string, unknown> : {};
              const active = this.promptTimers.get(ordinal);
              if (active?.turnId && active.turnId === turn.turnId) { clearTimeout(active.timer); this.promptTimers.delete(ordinal); }
            }
          }
          if (direction === "response" && this.meter.frames.at(-1)?.tool === "pi_session_close") {
            const envelope = message as { id?: unknown; result?: unknown };
            const result = envelope.result && typeof envelope.result === "object" ? envelope.result as Record<string, unknown> : {};
            const structured = result.structuredContent && typeof result.structuredContent === "object" ? result.structuredContent as Record<string, unknown> : {};
            const session = structured.session && typeof structured.session === "object" ? structured.session as Record<string, unknown> : {};
            const ordinal = this.meter.frames.at(-1)?.session_ordinal;
            if (structured.ok === true && session.state === "closed" && ordinal !== null && ordinal !== undefined) this.closedSessionOrdinals.add(ordinal);
            if (ordinal !== null && ordinal !== undefined) { const active = this.promptTimers.get(ordinal); if (active) clearTimeout(active.timer); this.promptTimers.delete(ordinal); }
          }
          if (direction === "response" && this.meter.frames.at(-1)?.tool === "pi_session_abort") {
            const ordinal = this.meter.frames.at(-1)?.session_ordinal;
            if (ordinal !== null && ordinal !== undefined) { const active = this.promptTimers.get(ordinal); if (active) clearTimeout(active.timer); this.promptTimers.delete(ordinal); }
          }
          if (direction === "response") write(raw);
          else {
            const envelope = message as { id?: unknown; method?: unknown; params?: { name?: unknown } };
            const tool = envelope.method === "tools/call" ? envelope.params?.name : undefined;
            const args = (envelope.params as { arguments?: Record<string, unknown> } | undefined)?.arguments;
            if (tool === "pi_session_start") {
              this.startAttempts++;
              if (envelope.id !== undefined) this.expectedStartProfiles.set(envelope.id, args?.executionProfile === "code" ? "code" : args?.executionProfile === "review" ? "review" : undefined);
            }
            if (tool === "pi_session_prompt") {
              this.promptAttempts++;
              const ordinal = this.meter.frames.at(-1)?.session_ordinal;
              if (envelope.id !== undefined) this.promptRequests.set(envelope.id, ordinal ?? null);
            }
            if ((tool === "pi_session_start" && this.startAttempts > this.limits.maxStarts)
              || (tool === "pi_session_prompt" && this.promptAttempts > this.limits.maxPrompts)) {
              this.quotaRejections++;
              const denied = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: envelope.id, error: { code: -32000, message: "approved evaluation quota reached" } }) + "\n");
              try { this.meter.observe("response", denied); reject?.(denied); }
              catch { this.integrityPassed = false; }
            } else {
              const envelopeParsed = message as Record<string, unknown>;
              const params = envelopeParsed.params && typeof envelopeParsed.params === "object" && !Array.isArray(envelopeParsed.params) ? envelopeParsed.params as Record<string, unknown> : undefined;
              const hasId = typeof envelopeParsed.id === "string" || typeof envelopeParsed.id === "number";
              const validNotification = envelopeParsed.method === "notifications/initialized" && envelopeParsed.id === undefined;
              const validToolsCall = envelopeParsed.method === "tools/call" && hasId && typeof params?.name === "string" && allowedTools.has(params.name)
                && params.arguments !== null && typeof params.arguments === "object" && !Array.isArray(params.arguments);
              const validStandardRequest = ["initialize", "tools/list", "ping"].includes(String(envelopeParsed.method)) && hasId;
              // `server/discover` is the read-only 2026-07-28 discovery request of the pinned MCP SDK (a server MUST answer it);
              // Claude Code 2.1.301 sends it first. Exactly that method, as a request with an id and absent-or-object params.
              const validDiscover = envelopeParsed.method === "server/discover" && hasId && (envelopeParsed.params === undefined || params !== undefined);
              if (envelopeParsed.jsonrpc !== "2.0" || typeof envelopeParsed.method !== "string"
                || !(validNotification || validToolsCall || validStandardRequest || validDiscover)) {
                this.integrityPassed = false; this.fatalRequest = true;
              } else {
                if (tool === "pi_session_prompt") {
                  const ordinal = this.meter.frames.at(-1)?.session_ordinal;
                  if (ordinal !== null && ordinal !== undefined && this.promptTimers.has(ordinal)) {
                    this.integrityPassed = false; this.fatalRequest = true;
                  } else if (ordinal !== null && ordinal !== undefined && this.limits.workerTurnMs) {
                    const timer = setTimeout(() => { this.workerTurnTimedOut = true; this.integrityPassed = false; this.fatalRequest = true; this.limits.onWorkerTurnTimeout?.(); }, this.limits.workerTurnMs);
                    timer.unref(); this.promptTimers.set(ordinal, { timer, requestId: envelope.id, turnId: null });
                  }
                }
                if (!this.fatalRequest) { if (validDiscover) this.discoverRequests++; write(raw); this.writtenBytes += raw.length; }
              }
            }
          }
        } catch {
          this.integrityPassed = false;
          if (direction === "request") this.fatalRequest = true;
        }
        if (direction === "request" && this.fatalRequest) { this.pending.request = Buffer.alloc(0); break; }
      }
    }
  }

  /** Preserve an incomplete tail byte-for-byte at EOF while refusing to call it a valid frame. */
  flush(direction: "request" | "response", write: (bytes: Buffer) => void): void {
    const tail = this.pending[direction];
    if (!tail.length) return;
    this.integrityPassed = false;
    this.pending[direction] = Buffer.alloc(0);
    if (direction === "request") this.fatalRequest = true;
    else { try { write(tail); } catch { this.integrityPassed = false; } }
  }

  finish(): ProxyMetrics {
    if (this.pending.request.length || this.pending.response.length) this.integrityPassed = false;
    return {
      schema_version: "token-live-proxy-1", integrity_passed: this.integrityPassed,
      received_bytes: this.receivedBytes, written_bytes: this.writtenBytes, controller_bytes: this.controllerBytes,
      server_exit_code: null, server_cleanup_observed: false, start_attempts: this.startAttempts, prompt_attempts: this.promptAttempts,
      quota_rejections: this.quotaRejections, discover_requests: this.discoverRequests, frames: this.meter.frames.map(frame => frameSchema.parse(frame)),
      empty_session_list_observed: this.emptySessionListObserved,
      route_checks: this.routeChecks.map(row => ({ ...row })), closed_session_ordinals: [...this.closedSessionOrdinals].sort((a,b)=>a-b),
      session_list_after_all_closed: this.sessionListAfterAllClosed, stderr_bytes: this.stderrBytes, fatal_request: this.fatalRequest,
      worker_turn_timed_out: this.workerTurnTimedOut,
    };
  }
  dispose(): void { for (const active of this.promptTimers.values()) clearTimeout(active.timer); this.promptTimers.clear(); }
}

const bounded = async (promise: Promise<unknown>, ms: number): Promise<boolean> => {
  let timer: NodeJS.Timeout | undefined;
  try { await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("deadline")), ms); })]); return true; }
  catch { return false; }
  finally { clearTimeout(timer); }
};
async function groupGone(pid: number, ms: number): Promise<boolean> {
  const absent = async () => {
    if (process.platform === "linux") {
      try {
        for (const name of (await readdir("/proc")).filter(value => /^\d+$/.test(value))) {
          try {
            const stat = await readFile(`/proc/${name}/stat`, "utf8"), fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
            if (fields.length < 20 || !fields[0] || !Number.isSafeInteger(Number(fields[2]))) return false;
            if (Number(fields[2]) === pid && fields[0] !== "Z" && fields[0] !== "X") return false;
          } catch (error) { const code = (error as NodeJS.ErrnoException).code; if (code !== "ENOENT" && code !== "ESRCH") return false; }
        }
        return true;
      } catch { return false; }
    }
    try { process.kill(-pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  };
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await absent()) return true;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  return absent();
}
function signalServer(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== "win32") { try { process.kill(-child.pid, signal); return; } catch { /* direct child fallback */ } }
  child.kill(signal);
}

/** Proxy entry used only by the approved M1 Codex invocation. */
export async function runTokenProxy(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const entry = environment.TOKEN_LIVE_REAL_ENTRY;
  const config = environment.TOKEN_LIVE_CONFIG;
  const metricsPath = environment.TOKEN_LIVE_METRICS_FILE;
  const controlPath = environment.TOKEN_LIVE_CONTROL_FILE;
  if (!entry || !config || !metricsPath || ![entry, config, metricsPath].every(isAbsolute) || (controlPath !== undefined && !isAbsolute(controlPath))) {
    process.stderr.write(JSON.stringify({ event: "token_live_proxy_stopped", code: "invalid_proxy_setup" }) + "\n");
    process.exitCode = 2;
    return;
  }
  const inherited = ["PATH", "HOME", "PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS"];
  const env: Record<string, string> = Object.fromEntries(inherited.flatMap(key => environment[key] === undefined ? [] : [[key, environment[key]!]]));
  env.PI_SESSION_MCP_CONFIG = config;
  const maxStarts = Number(environment.TOKEN_LIVE_MAX_STARTS), maxPrompts = Number(environment.TOKEN_LIVE_MAX_PROMPTS);
  if (!Number.isSafeInteger(maxStarts) || maxStarts < 1 || !Number.isSafeInteger(maxPrompts) || maxPrompts < 1) {
    process.stderr.write(JSON.stringify({ event: "token_live_proxy_stopped", code: "invalid_proxy_quota" }) + "\n");
    process.exitCode = 2; return;
  }
  const workerTurnMs = Number(environment.TOKEN_LIVE_WORKER_TURN_MS ?? 180_000);
  if (!Number.isSafeInteger(workerTurnMs) || workerTurnMs < 1000 || workerTurnMs > 180_000) {
    process.stderr.write(JSON.stringify({ event: "token_live_proxy_stopped", code: "invalid_turn_timeout" }) + "\n");
    process.exitCode = 2; return;
  }
  const child = spawn(process.execPath, [entry], { stdio: "pipe", env, detached: process.platform !== "win32" });
  let exitCode: number | null = null;
  const exited = new Promise<void>(resolve => child.once("close", code => { exitCode = code; resolve(); }));
  if (controlPath && child.pid) {
    try {
      const stat = await readFile(`/proc/${child.pid}/stat`, "utf8"), fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields.length < 20 || !fields[19] || Number(fields[2]) !== child.pid) throw new Error("server_identity_unavailable");
      await writeFile(controlPath, JSON.stringify({ schema_version: "token-live-server-identity-1", pid: child.pid, start: fields[19], process_group: Number(fields[2]) }), { flag: "wx", mode: 0o600 });
    } catch {
      child.kill("SIGKILL");
      await bounded(exited, 2000);
      process.stderr.write(JSON.stringify({ event: "token_live_proxy_stopped", code: "server_identity_unavailable" }) + "\n");
      process.exitCode = 2; return;
    }
  }
  let inputEndedResolve!: () => void;
  const inputEnded = new Promise<void>(resolve => { inputEndedResolve = resolve; });
  const meter = new TokenFrameForwarder({ maxStarts, maxPrompts, workerTurnMs, onWorkerTurnTimeout: () => { process.stdin.pause(); child.stdin.end(); inputEndedResolve(); signalServer(child, "SIGTERM"); } });
  const stopForFailure = () => { process.stdin.pause(); child.stdin.end(); inputEndedResolve(); signalServer(child, "SIGTERM"); };
  child.on("error", () => { meter.integrityPassed = false; });
  child.stdin.on("error", () => { meter.integrityPassed = false; stopForFailure(); });
  child.stdout.on("data", (chunk: Buffer) => meter.forward("response", chunk, bytes => { if (!process.stdout.write(bytes)) child.stdout.pause(); }));
  child.stderr.on("data", (chunk: Buffer) => { meter.stderrBytes += chunk.length; });
  process.stdout.on("drain", () => child.stdout.resume());
  process.stdin.on("data", (chunk: Buffer) => {
    if (meter.fatalRequest) { meter.controllerBytes += chunk.length; return; }
    meter.forward("request", chunk, bytes => { if (!child.stdin.write(bytes)) process.stdin.pause(); }, bytes => { if (!process.stdout.write(bytes)) process.stdin.pause(); });
    if (meter.fatalRequest) stopForFailure();
  });
  child.stdin.on("drain", () => process.stdin.resume());
  process.stdin.on("end", () => { meter.flush("request", bytes => child.stdin.write(bytes)); child.stdin.end(); inputEndedResolve(); if (meter.fatalRequest) signalServer(child, "SIGTERM"); });
  process.stdin.on("error", () => { meter.integrityPassed = false; stopForFailure(); });
  child.stdout.on("error", () => { meter.integrityPassed = false; });
  process.stdout.on("error", () => { meter.integrityPassed = false; stopForFailure(); });
  // Codex 0.162.0 ends an ordinary run by sending SIGTERM to its MCP child without
  // closing stdin first. Forward that as stdin EOF so the real server takes its
  // graceful exit-0 path; the bounded escalation below still signals a stuck server.
  // Controller timeout/cancellation is classified by the owning process supervisor;
  // a signal alone does not imply that framed bytes were lost or mutated.
  const onSignal = () => { process.stdin.pause(); meter.flush("request", bytes => child.stdin.write(bytes)); child.stdin.end(); inputEndedResolve(); };
  process.once("SIGTERM", onSignal); process.once("SIGINT", onSignal);
  const serverExitedBeforeInput = await Promise.race([exited.then(() => true), inputEnded.then(() => false)]);
  if (serverExitedBeforeInput) process.stdin.pause();
  // Controller runtime is bounded by its approved timeout, not by proxy lifetime.
  // Once the controller exits, allow the server a bounded graceful shutdown.
  let cleaned = serverExitedBeforeInput || await bounded(exited, 20_000);
  if (!cleaned) { signalServer(child, "SIGTERM"); cleaned = await bounded(exited, 2_000); }
  if (!cleaned) { signalServer(child, "SIGKILL"); cleaned = await bounded(exited, 2_000); }
  let groupCleaned = process.platform === "win32" ? cleaned : !!child.pid && await groupGone(child.pid, 1_000);
  if (!groupCleaned && child.pid && process.platform !== "win32") {
    signalServer(child, "SIGTERM"); groupCleaned = await groupGone(child.pid, 1_000);
    if (!groupCleaned) { signalServer(child, "SIGKILL"); groupCleaned = await groupGone(child.pid, 1_000); }
  }
  meter.flush("response", bytes => process.stdout.write(bytes));
  const metrics = proxyMetricsSchema.parse({ ...meter.finish(), server_exit_code: exitCode, server_cleanup_observed: groupCleaned });
  meter.dispose();
  try { await writeFile(metricsPath, JSON.stringify(metrics), { flag: "wx", mode: 0o600 }); }
  catch { meter.integrityPassed = false; }
  if (!cleaned || !groupCleaned || !metrics.integrity_passed || exitCode !== 0) process.exitCode = 1;
  process.off("SIGTERM", onSignal); process.off("SIGINT", onSignal);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runTokenProxy();
}

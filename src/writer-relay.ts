import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { Client, type Transport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { projectExecutionProfile } from "./capabilities.js";
import { ChildStdioTransport } from "./child-stdio-transport.js";
import type { WorkspaceModeEntry } from "./execution-modes.js";
import type { ConfiguredExecutionProfile } from "./execution-profile.js";
import { PiSessionCreationError, WriterUnavailableError, type PiSessionAdapter, type PiSessionHandle, type PiTurnOutcome, type PiSessionCreationErrorCode } from "./pi-adapter.js";
import { RegistryError } from "./session-registry.js";
import { capabilitiesSchema, errorSchema, promptSuccessSchema, successSchema, turnSuccessSchema, type turnSchema } from "./tool-schemas.js";
import { writerPaths } from "./writer-state.js";

export const RELAY_START_BUDGET_MS = 60_000;
export const RELAY_POLL_INTERVAL_MS = 1_000;
export const RELAY_CALL_TIMEOUT_MS = 10_000;
export const RELAY_PREFLIGHT_DEADLINE_MS = 15_000;
export const RELAY_ABORT_DEADLINE_MS = 15_000;
export const RELAY_CLEANUP_DEADLINE_MS = 10_000;
// The inner text cap is 64 KiB; JSON escaping can grow it up to sixfold.
export const RELAY_MAX_RESPONSE_BYTES = 524_288;

export interface WriterProcessFactory {
  spawn(wrapperPath: string, env: Record<string, string>): Transport;
}

// Read the launch discriminator locally until all writer-state producers have migrated.
// Unknown fields are deliberately tolerated; no clone inspection is an admission check.
const relayStateSchema = z.object({
  alias: z.string(), index: z.number().int(), phase: z.enum(["ready", "not_ready", "provisioning"]),
  launch: z.enum(["legacy", "relay"]).default("legacy"),
  acceptance: z.object({ verdict: z.literal("pass"), fingerprint: z.string(), at: z.string(), network: z.enum(["limited", "not_limited"]) }).optional(),
  base: z.object({ ref: z.string(), commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/) }),
});
async function readState(home: string, name: string) {
  try {
    const file = await open(writerPaths(home, name).state, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > RELAY_MAX_RESPONSE_BYTES) return undefined;
      const state = relayStateSchema.parse(JSON.parse(await file.readFile("utf8")));
      return `${state.alias}-w${state.index}` === name ? state : undefined;
    } finally { await file.close(); }
  } catch { return undefined; }
}

/** Bounds even injected transports which ignore AbortSignal. The losing operation stays observed. */
async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        cancel = () => { controller.abort(); reject(new Error("Relay operation cancelled")); };
        signal?.addEventListener("abort", cancel, { once: true });
        timer = setTimeout(cancel, Math.max(0, ms));
        if (signal?.aborted || ms <= 0) cancel();
      }),
      Promise.resolve().then(() => { controller.signal.throwIfAborted(); return operation(controller.signal); }),
    ]);
  } finally {
    clearTimeout(timer);
    if (cancel) signal?.removeEventListener("abort", cancel);
  }
}

const creationCodes = new Set<PiSessionCreationErrorCode>([
  "unknown_provider", "unknown_model", "local_authentication_missing", "local_authentication_unavailable",
  "model_unavailable", "thinking_level_unavailable", "execution_selection_mismatch", "external_mcp_unavailable",
  "external_mcp_no_tools", "external_mcp_grant_tool_missing", "external_mcp_activation_mismatch",
  "extension_not_installed", "extension_version_mismatch", "extension_load_failed", "extension_tool_conflict",
  "extension_tool_missing", "skill_load_failed", "sandbox_unavailable", "pi_session_creation_failed",
]);
/** The public profile shape `pi_capabilities_get` publishes; `alias` and `default` are not admission fields. */
type PublishedProfile = z.infer<typeof capabilitiesSchema>["executionProfiles"][number];
const exactFields = ["permissionProfile", "provider", "model", "thinkingLevel", "shell"] as const;
const setFields = ["skills", "extensions", "grantedExtensionTools"] as const;
const sameSet = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every(value => right.includes(value));
/** Admission compares every public capability field; the config schema already made the set fields duplicate-free. */
function samePublishedProfile(host: PublishedProfile, inner: PublishedProfile): boolean {
  return exactFields.every(key => host[key] === inner[key]) && setFields.every(key => sameSet(host[key], inner[key]));
}

class InnerError extends Error {
  constructor(readonly code: string) { super("Writer refused the operation"); }
}
class Connection {
  readonly client = new Client({ name: "pi-session-mcp-relay", version: "1" }, { capabilities: {} });
  lost = false;
  onLost: (() => void) | undefined;
  private tools: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
  constructor(readonly transport: Transport) {
    const lost = () => { this.lost = true; this.onLost?.(); };
    this.client.onclose = lost;
    this.client.onerror = lost;
  }
  async connect(ms: number, signal?: AbortSignal): Promise<void> {
    await bounded(s => this.client.connect(this.transport, { signal: s, timeout: ms }), ms, signal);
  }
  async discover(ms: number, signal?: AbortSignal): Promise<void> {
    const result = await bounded(s => this.client.listTools({}, { signal: s, timeout: ms }), ms, signal);
    this.tools = result.tools;
  }
  async call<T>(name: string, args: Record<string, unknown>, schema: z.ZodType<T>, ms = RELAY_CALL_TIMEOUT_MS, signal?: AbortSignal): Promise<T> {
    const toolDefinition = this.tools.find(tool => tool.name === name);
    if (!toolDefinition) throw new Error("Writer tool missing");
    const result = await bounded(s => this.client.callTool({ name, arguments: args }, { signal: s, timeout: ms, maxTotalTimeout: ms, resetTimeoutOnProgress: false, toolDefinition }), ms, signal);
    try {
      const raw = result.structuredContent;
      const encoded = JSON.stringify(raw);
      if (encoded === undefined || Buffer.byteLength(encoded) > RELAY_MAX_RESPONSE_BYTES) throw new Error();
      const refusal = errorSchema.safeParse(raw);
      if (refusal.success) throw new InnerError(refusal.data.error.code);
      return schema.parse(raw);
    } catch (error) {
      if (error instanceof InnerError) throw error;
      this.lost = true; this.onLost?.();
      throw new Error("Invalid writer response");
    }
  }
  async cleanup(sessionId?: string, ms = RELAY_CLEANUP_DEADLINE_MS): Promise<void> {
    // One deadline covers the RPC AND transport close, not two consecutive deadlines.
    const end = Date.now() + ms;
    try {
      if (sessionId && !this.lost) await this.call("pi_session_close", { sessionId }, successSchema, Math.max(0, end - Date.now()));
    } catch { /* EOF still requests launcher cleanup. */ }
    finally {
      try {
        const closing = this.transport.close();
        void closing.catch(() => undefined);
        await bounded(() => closing, Math.max(0, end - Date.now()));
      } catch { /* bounded shutdown */ }
    }
  }
}

type InnerTurn = z.infer<typeof turnSchema>;
class RelayHandle implements PiSessionHandle {
  readonly sdkSessionId: string;
  readonly appliedSelection;
  readonly deadlines = { preflightMs: RELAY_PREFLIGHT_DEADLINE_MS, abortMs: RELAY_ABORT_DEADLINE_MS, cleanupMs: RELAY_CLEANUP_DEADLINE_MS };
  private active: { turnId?: string; settle: (outcome: PiTurnOutcome) => void; activity?: (() => void) | undefined; updatedAt?: string } | undefined;
  private disposed = false;
  private disposal?: Promise<void>;
  constructor(private readonly connection: Connection, session: z.infer<typeof successSchema>["session"], readonly placement: NonNullable<PiSessionHandle["placement"]>, private readonly pollIntervalMs: number) {
    this.sdkSessionId = session.id;
    this.appliedSelection = { provider: session.provider, model: session.model, thinkingLevel: session.thinkingLevel };
    connection.onLost = () => this.settle({ status: "failed" });
  }
  isLost(): boolean { return this.connection.lost; }
  private settle(outcome: PiTurnOutcome): void { const active = this.active; this.active = undefined; active?.settle(outcome); }
  private lose(): void { this.connection.lost = true; this.settle({ status: "failed" }); }
  private observe(turn: InnerTurn): void {
    const active = this.active;
    if (!active || turn.turnId !== active.turnId || turn.sessionId !== this.sdkSessionId) { this.lose(); return; }
    if (active.updatedAt !== undefined && active.updatedAt !== turn.updatedAt) active.activity?.();
    active.updatedAt = turn.updatedAt;
    if (turn.state === "completed") this.settle({ status: "completed", assistantText: turn.assistantText, truncated: turn.truncated });
    else if (turn.state === "aborted" || turn.state === "failed") this.settle({ status: turn.state });
  }
  async prompt(text: string, preflight: (accepted: boolean) => void, onActivity?: () => void): Promise<PiTurnOutcome> {
    if (this.isLost() || this.disposed) throw new RegistryError("writer_session_lost");
    if (this.active) throw new Error("Relay turn already running");
    let settle!: (outcome: PiTurnOutcome) => void;
    const outcome = new Promise<PiTurnOutcome>(resolve => { settle = resolve; });
    const active: NonNullable<RelayHandle["active"]> = { settle, activity: onActivity };
    this.active = active;
    try {
      const result = await this.connection.call("pi_session_prompt", { sessionId: this.sdkSessionId, prompt: text }, promptSuccessSchema);
      if (result.turn.state !== "running" || result.session.id !== this.sdkSessionId) { this.lose(); preflight(false); }
      else if (this.active === active) {
        active.turnId = result.turn.turnId; active.updatedAt = result.turn.updatedAt;
        preflight(true);
        void this.poll(active);
      } else preflight(false);
    } catch (error) {
      preflight(false);
      if (!(error instanceof InnerError) && !this.isLost()) {
        // Acceptance is uncertain: ask the inner registry to settle before returning failure.
        try { await this.abort(); } catch { this.lose(); }
      }
      this.settle({ status: "failed" });
    }
    return outcome;
  }
  private async poll(active: NonNullable<RelayHandle["active"]>): Promise<void> {
    while (this.active === active && !this.isLost() && !this.disposed) {
      await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
      if (this.active !== active || this.isLost() || this.disposed) return;
      try {
        const { turn } = await this.connection.call("pi_turn_get", { sessionId: this.sdkSessionId, turnId: active.turnId }, turnSuccessSchema);
        // An abort may have settled this turn and a new prompt may already be running.
        if (this.active === active) this.observe(turn);
      } catch { this.lose(); }
    }
  }
  async abort(): Promise<void> {
    if (this.isLost()) throw new Error("Writer session lost");
    const active = this.active;
    try {
      await bounded(async signal => {
        const result = await this.connection.call("pi_session_abort", { sessionId: this.sdkSessionId }, successSchema, RELAY_CALL_TIMEOUT_MS, signal);
        if (result.session.id !== this.sdkSessionId) throw new Error("Writer session mismatch");
        if (!active || this.active !== active) return;
        // A lost prompt response has no turn ID. It cannot be safely resumed.
        if (!active.turnId) throw new Error("Writer turn unknown");
        const { turn } = await this.connection.call("pi_turn_get", { sessionId: this.sdkSessionId, turnId: active.turnId }, turnSuccessSchema, RELAY_CALL_TIMEOUT_MS, signal);
        if (turn.state === "running") throw new Error("Writer abort incomplete");
        if (this.active === active) this.observe(turn);
      }, RELAY_ABORT_DEADLINE_MS);
    } catch { this.lose(); throw new Error("Writer abort failed"); }
  }
  dispose(): Promise<void> {
    if (!this.disposal) {
      this.disposed = true;
      this.settle({ status: "failed" });
      this.disposal = this.connection.cleanup(this.sdkSessionId);
    }
    return this.disposal;
  }
}

export class WriterRelayAdapter implements PiSessionAdapter {
  constructor(private readonly options: { home: string; workspaceModes: ReadonlyMap<string, WorkspaceModeEntry>; executionProfiles: ReadonlyMap<string, ConfiguredExecutionProfile>; spawn?: WriterProcessFactory; now?: () => number; pollIntervalMs?: number }) {}
  async create(input: Parameters<PiSessionAdapter["create"]>[0]): Promise<PiSessionHandle> {
    if (process.platform !== "linux") throw new WriterUnavailableError("none_ready");
    const now = this.options.now ?? Date.now, end = now() + RELAY_START_BUDGET_MS;
    const left = () => Math.max(0, end - now());
    const remaining = () => Math.min(RELAY_CALL_TIMEOUT_MS, left());
    const settings = this.options.workspaceModes.get(input.workspace)?.container;
    const ready = [];
    for (let i = 1; i <= (settings?.writers ?? 0); i++) {
      const name = `${input.workspace}-w${i}`, state = await readState(this.options.home, name);
      if (state?.phase === "ready" && state.launch === "relay" && state.acceptance) ready.push({ name, state });
    }
    if (!ready.length) throw new WriterUnavailableError("none_ready");
    const base = input.base ?? settings?.base;
    const candidates = base === undefined ? [] : ready.filter(({ state }) => state.base.ref === `refs/heads/${base}`);
    if (!candidates.length) throw new WriterUnavailableError("none_at_base");
    const counts = { busy: 0, notAtBaseline: 0, settingsChanged: 0 };
    const env: Record<string, string> = { HOME: this.options.home };
    for (const key of ["PATH", "XDG_RUNTIME_DIR"]) if (process.env[key] !== undefined) env[key] = process.env[key];
    const factory = this.options.spawn ?? { spawn: (wrapper: string, environment: Record<string, string>) => new ChildStdioTransport(wrapper, environment) };
    for (const candidate of candidates) {
      input.signal?.throwIfAborted();
      if (left() <= 0) break;
      let connection: Connection | undefined, sessionId: string | undefined, admitted = false;
      try {
        connection = new Connection(factory.spawn(writerPaths(this.options.home, candidate.name).wrapper, env));
        // The handshake waits for credential warm-up and the container start: it may use the whole budget.
        await connection.connect(left(), input.signal);
        await connection.discover(remaining(), input.signal);
        const capabilities = await connection.call("pi_capabilities_get", {}, capabilitiesSchema, remaining(), input.signal);
        const inner = capabilities.executionProfiles.find(profile => profile.alias === input.executionProfile.alias);
        const host = this.options.executionProfiles.get(input.executionProfile.alias);
        if (!host || !inner || !samePublishedProfile(projectExecutionProfile(host), inner)) { counts.settingsChanged++; continue; }
        const result = await connection.call("pi_session_start", { workspace: input.workspace, executionProfile: input.executionProfile.alias }, successSchema, remaining(), input.signal);
        sessionId = result.session.id;
        if (remaining() <= 0 || connection.lost) continue;
        const state = await readState(this.options.home, candidate.name);
        if (!state || state.base.ref !== candidate.state.base.ref || state.base.commit !== candidate.state.base.commit) continue;
        input.signal?.throwIfAborted();
        admitted = true;
        return new RelayHandle(connection, result.session, { writer: candidate.name, base: state.base }, this.options.pollIntervalMs ?? RELAY_POLL_INTERVAL_MS);
      } catch (error) {
        if (input.signal?.aborted) throw input.signal.reason;
        if (error instanceof InnerError) {
          if (error.code === "writer_busy") counts.busy++;
          else if (error.code === "writer_uncollected") counts.notAtBaseline++;
          else if (!["writer_fenced", "writer_not_ready", "container_runtime_unavailable"].includes(error.code)) {
            const code = error.code as PiSessionCreationErrorCode;
            throw new PiSessionCreationError(creationCodes.has(code) ? code : "pi_session_creation_failed");
          }
        }
      } finally {
        // Own bound, not the start budget: a started inner session is always closed explicitly.
        if (!admitted && connection) await connection.cleanup(sessionId);
      }
    }
    throw new WriterUnavailableError("none_admitted", counts);
  }
}

export class RoutingPiSessionAdapter implements PiSessionAdapter {
  constructor(private readonly host: PiSessionAdapter, private readonly relay: PiSessionAdapter, private readonly workspaceModes: ReadonlyMap<string, WorkspaceModeEntry>) {}
  create(input: Parameters<PiSessionAdapter["create"]>[0]): Promise<PiSessionHandle> {
    return (input.executionProfile.permissionProfile === "coding" && this.workspaceModes.get(input.workspace)?.mode === "container" ? this.relay : this.host).create(input);
  }
}

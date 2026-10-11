import {
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type AgentSessionServices,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type CreateAgentSessionServicesOptions,
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  DefaultResourceLoader,
  ModelRuntime,
  type PromptOptions,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { PiExtensionError, type ExtensionSpec } from "./extension-spec.js";
import type { ResolvedExecutionProfile, ThinkingLevel } from "./execution-profile.js";
import {
  classifyMcpStartupError,
  connectSessionMcpTools,
  type McpConnectionFactory,
  type McpStartupFailure,
  type SessionMcpTools,
} from "./mcp-session-tools.js";
import { createStdioMcpConnection } from "./mcp-stdio-client.js";
import {
  PiSessionCreationError,
  type PiAppliedSelection,
  type PiSessionAdapter,
  type PiSessionCreationErrorCode,
  type PiSessionHandle,
  type PiTurnOutcome,
} from "./pi-adapter.js";
import { resolvePiExtension } from "./pi-extensions.js";
import { composeSessionTools, PROFILE_TOOLS } from "./session-tools.js";

export { PROFILE_TOOLS } from "./session-tools.js";

type SdkModel = NonNullable<CreateAgentSessionOptions["model"]>;
type CreateSession = (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;

export const AUTH_OPERATION_TIMEOUT_MS = 5_000;
/** Server-side bound for SDK session construction. The SDK does not document cancellation. */
export const SESSION_CREATION_TIMEOUT_MS = 10_000;

export interface SdkPiAdapterDiagnostic {
  readonly level: "error";
  readonly event: "pi_session_creation_failed";
  readonly stage: "runtime" | "provider" | "model" | "check_auth" | "get_auth" | "availability" | "resource_loader" | "mcp_tools" | "create_session" | "postcheck" | "extension_resolve" | "extension_load" | "extension_bind";
  readonly code: PiSessionCreationErrorCode;
  readonly executionProfile: string;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: ThinkingLevel;
  readonly serverAlias?: string;
  readonly toolAlias?: string;
  readonly discoveredToolCount?: number;
  /** `<name>@<version>` of the extension that failed to resolve; never a path. */
  readonly extension?: string;
}

/** The Pi SDK session-lifecycle API used for profiles with extensions; injectable for tests. */
export interface ExtensionSdk {
  readonly createServices: typeof createAgentSessionServices;
  readonly createSessionFromServices: typeof createAgentSessionFromServices;
  readonly createRuntime: typeof createAgentSessionRuntime;
}

const DEFAULT_EXTENSION_SDK: ExtensionSdk = {
  createServices: createAgentSessionServices,
  createSessionFromServices: createAgentSessionFromServices,
  createRuntime: createAgentSessionRuntime,
};

export interface SdkPiSessionAdapterOptions {
  readonly modelRuntimeFactory?: () => Promise<ModelRuntime>;
  readonly createSession?: CreateSession;
  readonly diagnosticSink?: (diagnostic: SdkPiAdapterDiagnostic) => void;
  readonly mcpConnectionFactory?: McpConnectionFactory;
  /** Resolves a pinned extension to its installed package directory. */
  readonly resolveExtension?: (extension: ExtensionSpec) => Promise<string>;
  readonly extensionSdk?: ExtensionSdk;
}

class AuthDeadlineError extends Error {
  constructor() {
    super("authentication operation timed out");
    this.name = "AuthDeadlineError";
  }
}

class SessionCreationDeadlineError extends Error {
  constructor() {
    super("Pi session creation timed out");
    this.name = "SessionCreationDeadlineError";
  }
}

function disposeSdkSession(session: AgentSession): void {
  try { session.dispose(); } catch { /* SDK cleanup is best effort and never exposes internals. */ }
}

async function withAuthDeadline<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  const operationPromise = Promise.resolve().then(() => operation(controller.signal));
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new AuthDeadlineError());
    }, AUTH_OPERATION_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operationPromise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
    controller.abort();
  }
}

/** Races an SDK operation against the session-creation bound; a late success goes to `disposeLate`. */
async function withCreationDeadline<T>(start: () => Promise<T>, disposeLate: (value: T) => void = () => undefined): Promise<T> {
  let operation: Promise<T>;
  try {
    operation = Promise.resolve(start());
  } catch {
    throw new SessionCreationDeadlineError();
  }
  let timedOut = false;
  // This continuation is installed immediately and owns late cleanup. Its rejection
  // branch is required even when the deadline wins the race.
  const observed = operation.then(
    (value) => {
      if (timedOut) disposeLate(value);
      return value;
    },
    (error: unknown) => { throw error; },
  );
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new SessionCreationDeadlineError());
    }, SESSION_CREATION_TIMEOUT_MS);
  });
  try {
    return await Promise.race([observed, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Runs a session disposal bounded by the creation deadline; failures and a timeout are swallowed. */
async function boundedDisposal(dispose: () => void | Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, SESSION_CREATION_TIMEOUT_MS); });
  let disposal: Promise<void>;
  try { disposal = Promise.resolve(dispose()).then(() => undefined, () => undefined); }
  catch { disposal = Promise.resolve(); }
  try {
    await Promise.race([disposal, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function registeredExtensionTools(services: AgentSessionServices): string[][] {
  return services.resourceLoader.getExtensions().extensions.map((extension) => [...extension.tools.keys()]);
}

type SdkAssistantMessage = Extract<Extract<AgentSessionEvent, { type: "message_end" }>["message"], { role: "assistant" }>;
/** Derived from the root-exported `AgentSessionEvent`; the SDK root does not export `StopReason`. */
export type SdkStopReason = SdkAssistantMessage["stopReason"];

/**
 * Projects the final assistant message of a prompt onto a turn outcome.
 *
 * The switch is exhaustive on purpose: a stop reason added by a future SDK fails the
 * typecheck (and therefore the Pi SDK canary) instead of being mapped silently. Runtime
 * values outside the SDK union, a missing stop reason included, fail closed.
 */
export function normalizeAssistantOutcome(message: unknown): PiTurnOutcome {
  if (!isAssistantMessage(message)) return { status: "failed" };
  const stopReason = message.stopReason as SdkStopReason;
  switch (stopReason) {
    case "stop":
    // Cut off by the output limit; the truncated text is still the turn's answer.
    case "length":
    // The agent loop ends on a tool call only when the tool batch terminated the run.
    case "toolUse":
      return { status: "completed", assistantText: message.content.filter(isTextBlock).map((block) => block.text).join("") };
    case "aborted":
      return { status: "aborted" };
    case "error":
    // Not a finished answer: `pending` marks a message still streaming, `deferred` a
    // response the provider has not delivered yet.
    case "pending":
    case "deferred":
      return { status: "failed" };
    default: {
      const unhandled: never = stopReason;
      void unhandled;
      return { status: "failed" };
    }
  }
}

/** Derived from the root-exported `PromptOptions`; the SDK does not export the union itself. */
export type PromptDisposition = Parameters<NonNullable<PromptOptions["preflightResult"]>>[0];

/**
 * Whether an SDK prompt disposition admits a public turn. The SDK reports how an accepted
 * prompt was dispatched and does not call the hook on rejection: `prompt()` rejects instead,
 * which the registry already projects as `prompt_rejected`.
 *
 * The switch is exhaustive on purpose: a disposition added by a future SDK fails the
 * typecheck (and therefore the Pi SDK canary) instead of being mapped silently.
 */
export function admitsTurn(disposition: PromptDisposition): boolean {
  switch (disposition) {
    case "started":
      return true;
    // Only while streaming with `streamingBehavior`; Pi Session MCP never passes it and serializes turns.
    case "queued":
    // An extension input handler consumed the prompt without a model turn. Commands never
    // dispatch (`expandPromptTemplates: false`), but allowlisted extensions may handle input.
    case "handled":
      return false;
    default: {
      const unhandled: never = disposition;
      void unhandled;
      return false;
    }
  }
}

class SdkHandle implements PiSessionHandle {
  private disposed = false;
  private disposal: Promise<void> | undefined;
  private readonly subscriptions = new Set<() => void>();
  constructor(
    private readonly session: AgentSession,
    readonly appliedSelection: PiAppliedSelection,
    private readonly mcpTools: SessionMcpTools,
    private readonly disposeSession: () => void | Promise<void> = () => disposeSdkSession(session),
  ) {}

  get sdkSessionId(): string { return this.session.sessionId; }

  prompt(text: string, preflight: (accepted: boolean) => void, onActivity?: () => void): Promise<PiTurnOutcome> {
    if (this.disposed) return Promise.resolve({ status: "failed" });
    let finalAssistant: unknown;
    /** Observer failures must never disturb SDK event handling or the turn outcome. */
    const reportActivity = (): void => {
      if (!onActivity) return;
      try { onActivity(); } catch { /* Liveness reporting is best effort and content-free. */ }
    };
    const unsubscribe = this.session.subscribe((event: AgentSessionEvent) => {
      if (event.type === "tool_execution_end") reportActivity();
      else if (event.type === "message_end" && isAssistantMessage(event.message)) {
        finalAssistant = event.message;
        reportActivity();
      }
    });
    let preflightSeen = false;
    let cleaned = false;
    const signalPreflight = (accepted: boolean): void => {
      if (preflightSeen || this.disposed) return;
      preflightSeen = true;
      preflight(accepted);
    };
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      this.subscriptions.delete(cleanup);
      try { unsubscribe(); } catch { /* subscription cleanup is best effort */ }
    };
    this.subscriptions.add(cleanup);
    let promptResult: Promise<void>;
    try {
      promptResult = this.session.prompt(text, {
        // Client text is content, never a command: no extension command, skill or template dispatch.
        expandPromptTemplates: false,
        preflightResult: (disposition) => signalPreflight(admitsTurn(disposition)),
      });
    } catch {
      cleanup();
      throw new Error("Pi prompt failed");
    }
    return promptResult.then(
      () => (this.disposed ? { status: "failed" as const } : normalizeAssistantOutcome(finalAssistant)),
      () => ({ status: "failed" as const }),
    ).finally(cleanup);
  }

  abort(): Promise<void> { return this.session.abort(); }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    let finish!: () => void;
    // Publish the shared promise before synchronous cleanup can re-enter dispose().
    this.disposal = new Promise<void>((resolve) => { finish = resolve; });
    const closed = this.mcpTools.close();
    for (const cleanup of [...this.subscriptions]) cleanup();
    let sessionClosed: Promise<void>;
    try { sessionClosed = Promise.resolve(this.disposeSession()).then(() => undefined, () => undefined); }
    catch { sessionClosed = Promise.resolve(); }
    void Promise.all([closed.then(() => undefined, () => undefined), sessionClosed]).then(finish, finish);
    return this.disposal;
  }
}

function isAssistantMessage(message: unknown): message is { role: "assistant"; content: unknown[]; stopReason?: unknown } {
  if (!message || typeof message !== "object") return false;
  const candidate = message as { role?: unknown; content?: unknown };
  return candidate.role === "assistant" && Array.isArray(candidate.content);
}

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  if (!block || typeof block !== "object") return false;
  const candidate = block as { type?: unknown; text?: unknown };
  return candidate.type === "text" && typeof candidate.text === "string";
}

/** Resource-loader options for every embedded session: no discovery, skills, templates or themes. */
function phase0ResourceLoaderOptions(): NonNullable<CreateAgentSessionServicesOptions["resourceLoaderOptions"]> {
  return {
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: false,
    systemPrompt: "phase-0-system-prompt-disabled",
    appendSystemPrompt: [],
    systemPromptOverride: () => undefined,
    appendSystemPromptOverride: () => [],
  };
}

export async function createPhase0ResourceLoader(cwd: string): Promise<{
  resourceLoader: DefaultResourceLoader; settingsManager: SettingsManager;
}> {
  const settingsManager = SettingsManager.inMemory(undefined, { projectTrusted: false });
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, ...phase0ResourceLoaderOptions() });
  await resourceLoader.reload();
  return { resourceLoader, settingsManager };
}

export class SdkPiSessionAdapter implements PiSessionAdapter {
  private runtimePromise: Promise<ModelRuntime> | undefined;
  private readonly modelRuntimeFactory: () => Promise<ModelRuntime>;
  private readonly createSession: CreateSession;
  private readonly diagnosticSink: (diagnostic: SdkPiAdapterDiagnostic) => void;
  private readonly mcpConnectionFactory: McpConnectionFactory;
  private readonly resolveExtension: (extension: ExtensionSpec) => Promise<string>;
  private readonly extensionSdk: ExtensionSdk;

  constructor(options: SdkPiSessionAdapterOptions = {}) {
    this.modelRuntimeFactory = options.modelRuntimeFactory ?? (() => ModelRuntime.create({ refreshOnCreate: false }));
    this.createSession = options.createSession ?? createAgentSession;
    this.diagnosticSink = options.diagnosticSink ?? (() => undefined);
    this.mcpConnectionFactory = options.mcpConnectionFactory ?? createStdioMcpConnection;
    this.resolveExtension = options.resolveExtension ?? ((extension) => resolvePiExtension(extension));
    this.extensionSdk = options.extensionSdk ?? DEFAULT_EXTENSION_SDK;
  }

  async create(input: { cwd: string; executionProfile: ResolvedExecutionProfile; signal?: AbortSignal }): Promise<PiSessionHandle> {
    const extensions = input.executionProfile.extensions ?? [];
    if (extensions.length > 0) return this.createWithExtensions(input, extensions);
    const { executionProfile } = input;
    let runtime: ModelRuntime;
    try {
      runtime = await this.getRuntime();
    } catch {
      throw this.failure(executionProfile, "runtime", "pi_session_creation_failed");
    }
    const model = await this.resolveVerifiedModel(runtime, executionProfile);

    let resourceLoader: DefaultResourceLoader;
    let settingsManager: SettingsManager;
    try {
      ({ resourceLoader, settingsManager } = await createPhase0ResourceLoader(input.cwd));
    } catch {
      throw this.failure(executionProfile, "resource_loader", "pi_session_creation_failed");
    }

    const mcpTools = await this.connectMcpTools(input);
    const tools = [...PROFILE_TOOLS[executionProfile.permissionProfile], ...mcpTools.tools.map((tool) => tool.name)];
    let session: AgentSession;
    try {
      ({ session } = await withCreationDeadline(
        () => this.createSession({
          cwd: input.cwd,
          modelRuntime: runtime,
          model,
          thinkingLevel: executionProfile.thinkingLevel,
          sessionManager: SessionManager.inMemory(input.cwd),
          settingsManager,
          resourceLoader,
          // With an explicit tools list, Pi also needs custom tool names here to activate them.
          tools,
          ...(mcpTools.tools.length === 0 ? {} : { customTools: mcpTools.tools }),
        }),
        (late) => disposeSdkSession(late.session),
      ));
    } catch {
      await mcpTools.close();
      throw this.failure(executionProfile, "create_session", "pi_session_creation_failed");
    }
    return this.admit(session, executionProfile, tools, mcpTools, () => disposeSdkSession(session),
      mcpTools.tools.length > 0 ? "external_mcp_activation_mismatch" : undefined);
  }

  private async createWithExtensions(
    input: { cwd: string; executionProfile: ResolvedExecutionProfile; signal?: AbortSignal },
    extensions: readonly ExtensionSpec[],
  ): Promise<PiSessionHandle> {
    const { cwd, executionProfile } = input;
    const directories: string[] = [];
    for (const extension of extensions) {
      try {
        directories.push(await this.resolveExtension(extension));
      } catch (error) {
        throw this.failure(executionProfile, "extension_resolve",
          error instanceof PiExtensionError ? error.code : "extension_load_failed",
          { extension: `${extension.name}@${extension.version}` });
      }
    }
    // Extension providers register into the runtime they load with, and the last
    // registration wins, so every extension session gets a runtime of its own.
    let runtime: ModelRuntime;
    try {
      runtime = await this.modelRuntimeFactory();
    } catch {
      throw this.failure(executionProfile, "runtime", "pi_session_creation_failed");
    }
    let services: AgentSessionServices;
    let extensionTools: string[][];
    try {
      services = await withCreationDeadline(() => this.extensionSdk.createServices({
        cwd,
        agentDir: cwd,
        modelRuntime: runtime,
        settingsManager: SettingsManager.inMemory(undefined, { projectTrusted: false }),
        resourceLoaderOptions: { ...phase0ResourceLoaderOptions(), additionalExtensionPaths: directories },
      }));
      const loaded = services.resourceLoader.getExtensions();
      if (loaded.errors.length > 0 || services.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
        throw new Error("extension load reported errors");
      }
      extensionTools = registeredExtensionTools(services);
    } catch {
      throw this.failure(executionProfile, "extension_load", "extension_load_failed");
    }
    const model = await this.resolveVerifiedModel(services.modelRuntime, executionProfile);
    const mcpTools = await this.connectMcpTools(input);
    const tools = composeSessionTools(executionProfile.permissionProfile, mcpTools.tools.map((tool) => tool.name), extensionTools);
    if (!tools) {
      await mcpTools.close();
      throw this.failure(executionProfile, "extension_load", "extension_tool_conflict");
    }
    let sessionRuntime: AgentSessionRuntime;
    try {
      sessionRuntime = await withCreationDeadline(
        () => this.extensionSdk.createRuntime(async ({ sessionManager }) => ({
          ...(await this.extensionSdk.createSessionFromServices({
            services,
            sessionManager,
            model,
            thinkingLevel: executionProfile.thinkingLevel,
            tools,
            ...(mcpTools.tools.length === 0 ? {} : { customTools: mcpTools.tools }),
          })),
          services,
          diagnostics: services.diagnostics,
        }), { cwd, agentDir: cwd, sessionManager: SessionManager.inMemory(cwd) }),
        (late) => { void late.dispose().catch(() => undefined); },
      );
    } catch {
      await mcpTools.close();
      throw this.failure(executionProfile, "create_session", "pi_session_creation_failed");
    }
    // `AgentSessionRuntime.dispose()` emits `session_shutdown` before disposing the session.
    const disposeRuntime = (): Promise<void> => sessionRuntime.dispose().catch(() => undefined);
    // Bounded and concurrent: a hanging `session_shutdown` handler must not keep MCP processes open.
    const cleanUp = async (): Promise<void> => {
      await Promise.all([boundedDisposal(disposeRuntime), mcpTools.close()]);
    };
    let bindErrors = 0;
    let bound = false;
    let conflict = false;
    try {
      // Without a UI context the SDK binds its no-op UI; binding emits `session_start`.
      await withCreationDeadline(() => sessionRuntime.session.bindExtensions({
        mode: "print",
        // `ExtensionRunner.emit` routes handler errors here instead of rejecting the bind.
        onError: () => { if (!bound) bindErrors += 1; },
      }));
      bound = true;
      if (bindErrors > 0) throw new Error("extension hook reported errors while binding");
      // A `session_start` handler may register a tool that replaces a built-in or granted tool.
      // Tools an extension registers later, during a turn, are not re-checked: allowlisted
      // extensions are trusted code.
      const recheck = composeSessionTools(executionProfile.permissionProfile, mcpTools.tools.map((tool) => tool.name), registeredExtensionTools(services));
      if (!recheck || recheck.length !== tools.length || recheck.some((name, index) => name !== tools[index])) conflict = true;
    } catch {
      await cleanUp();
      throw this.failure(executionProfile, "extension_bind", "extension_load_failed");
    }
    if (conflict) {
      await cleanUp();
      throw this.failure(executionProfile, "extension_bind", "extension_tool_conflict");
    }
    return this.admit(sessionRuntime.session, executionProfile, tools, mcpTools, disposeRuntime,
      mcpTools.tools.length > 0 ? "external_mcp_activation_mismatch" : "execution_selection_mismatch");
  }

  /** Provider, model, authentication and availability, exactly as configured. */
  private async resolveVerifiedModel(runtime: ModelRuntime, executionProfile: ResolvedExecutionProfile): Promise<SdkModel> {
    let provider: ReturnType<ModelRuntime["getProvider"]>;
    try {
      provider = runtime.getProvider(executionProfile.provider);
    } catch {
      throw this.failure(executionProfile, "provider", "pi_session_creation_failed");
    }
    if (!provider) throw this.failure(executionProfile, "provider", "unknown_provider");

    let model: SdkModel | undefined;
    try {
      model = runtime.getModel(executionProfile.provider, executionProfile.model);
    } catch {
      throw this.failure(executionProfile, "model", "pi_session_creation_failed");
    }
    if (!model) throw this.failure(executionProfile, "model", "unknown_model");

    let authenticated: boolean;
    try {
      authenticated = Boolean(await withAuthDeadline((signal) => runtime.checkAuth(executionProfile.provider, { signal })));
    } catch {
      throw this.failure(executionProfile, "check_auth", "local_authentication_unavailable");
    }
    if (!authenticated) throw this.failure(executionProfile, "check_auth", "local_authentication_missing");

    try {
      // AuthResult can contain credentials, so reduce it immediately.
      authenticated = Boolean(await withAuthDeadline((signal) => runtime.getAuth(model, { signal })));
    } catch {
      throw this.failure(executionProfile, "get_auth", "local_authentication_unavailable");
    }
    if (!authenticated) throw this.failure(executionProfile, "get_auth", "local_authentication_missing");

    let available: readonly SdkModel[];
    try {
      available = await withAuthDeadline((signal) => runtime.getAvailable(executionProfile.provider, { signal }));
    } catch {
      throw this.failure(executionProfile, "availability", "pi_session_creation_failed");
    }
    if (!available.some((candidate) => candidate.provider === executionProfile.provider && candidate.id === executionProfile.model)) {
      throw this.failure(executionProfile, "availability", "model_unavailable");
    }
    return model;
  }

  private async connectMcpTools(input: { cwd: string; executionProfile: ResolvedExecutionProfile; signal?: AbortSignal }): Promise<SessionMcpTools> {
    try {
      return await connectSessionMcpTools(
        input.executionProfile.mcpServers ?? {}, input.executionProfile.permissionProfile, input.cwd, this.mcpConnectionFactory,
        input.signal === undefined ? {} : { signal: input.signal },
      );
    } catch (error) {
      const failure = classifyMcpStartupError(error);
      throw this.failure(input.executionProfile, "mcp_tools", failure?.code ?? "external_mcp_unavailable", failure);
    }
  }

  /** Post-verifies a created session and wraps it; a mismatch disposes it before reporting. */
  private async admit(
    session: AgentSession,
    executionProfile: ResolvedExecutionProfile,
    tools: readonly string[],
    mcpTools: SessionMcpTools,
    disposeSession: () => void | Promise<void>,
    toolMismatch: PiSessionCreationErrorCode | undefined,
  ): Promise<PiSessionHandle> {
    try {
      if (session.model?.provider !== executionProfile.provider || session.model.id !== executionProfile.model) {
        throw this.failure(executionProfile, "postcheck", "execution_selection_mismatch");
      }
      if (session.thinkingLevel !== executionProfile.thinkingLevel) {
        throw this.failure(executionProfile, "postcheck", "thinking_level_unavailable");
      }
      if (toolMismatch !== undefined) {
        const active = new Set(session.getActiveToolNames());
        if (active.size !== tools.length || tools.some((name) => !active.has(name))) {
          throw this.failure(executionProfile, "postcheck", toolMismatch);
        }
      }
      return new SdkHandle(session, {
        provider: session.model.provider,
        model: session.model.id,
        thinkingLevel: session.thinkingLevel,
      }, mcpTools, disposeSession);
    } catch (error) {
      await Promise.all([boundedDisposal(disposeSession), mcpTools.close()]);
      if (error instanceof PiSessionCreationError) throw error;
      throw this.failure(executionProfile, "postcheck", "pi_session_creation_failed");
    }
  }

  private getRuntime(): Promise<ModelRuntime> {
    if (!this.runtimePromise) {
      const pending = this.modelRuntimeFactory();
      this.runtimePromise = pending;
      void pending.catch(() => {
        if (this.runtimePromise === pending) this.runtimePromise = undefined;
      });
    }
    return this.runtimePromise;
  }

  private failure(
    executionProfile: ResolvedExecutionProfile,
    stage: SdkPiAdapterDiagnostic["stage"],
    code: PiSessionCreationErrorCode,
    metadata?: Pick<McpStartupFailure, "serverAlias" | "toolAlias" | "discoveredToolCount"> & { readonly extension?: string },
  ): PiSessionCreationError {
    try {
      this.diagnosticSink({
        level: "error",
        event: "pi_session_creation_failed",
        stage,
        code,
        executionProfile: executionProfile.alias,
        provider: executionProfile.provider,
        model: executionProfile.model,
        thinkingLevel: executionProfile.thinkingLevel,
        ...(metadata?.serverAlias === undefined ? {} : { serverAlias: metadata.serverAlias }),
        ...(metadata?.toolAlias === undefined ? {} : { toolAlias: metadata.toolAlias }),
        ...(metadata?.discoveredToolCount === undefined ? {} : { discoveredToolCount: metadata.discoveredToolCount }),
        ...(metadata?.extension === undefined ? {} : { extension: metadata.extension }),
      });
    } catch {
      // Diagnostics are never allowed to influence session safety.
    }
    return new PiSessionCreationError(code);
  }
}

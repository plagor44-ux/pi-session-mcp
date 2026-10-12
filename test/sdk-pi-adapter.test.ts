import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ModelRuntime, type AgentSession, type CreateAgentSessionOptions, type CreateAgentSessionResult } from "@earendil-works/pi-coding-agent";
import type { AgentSessionRuntime, AgentSessionServices, CreateAgentSessionRuntimeFactory } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";
import { ConfigError } from "../src/config.js";
import type { ResolvedExecutionProfile } from "../src/execution-profile.js";
import type { McpConnection } from "../src/mcp-session-tools.js";
import { parseExtensionSpec, PiExtensionError } from "../src/extension-spec.js";
import { startupFailureDiagnostic } from "../src/process-diagnostics.js";
import type { PiTurnOutcome } from "../src/pi-adapter.js";
import { AUTH_OPERATION_TIMEOUT_MS, SESSION_CREATION_TIMEOUT_MS, createPhase0ResourceLoader, normalizeAssistantOutcome, PROFILE_TOOLS, SdkPiSessionAdapter, type SdkPiAdapterDiagnostic, type SdkStopReason } from "../src/sdk-pi-adapter.js";
import type { ExtensionSdk } from "../src/sdk-pi-adapter.js";

afterAll(removeTemporaryRoots);

const profile: ResolvedExecutionProfile = Object.freeze({
  alias: "safe-readonly",
  permissionProfile: "read-only",
  provider: "example-provider",
  model: "example-model",
  thinkingLevel: "medium",
});

type SdkModel = NonNullable<CreateAgentSessionOptions["model"]>;

function model(provider = profile.provider, id = profile.model): SdkModel {
  return { provider, id } as unknown as SdkModel;
}

function runtimeFixture() {
  const resolvedModel = model();
  const getProvider = vi.fn<(provider: string) => { id: string } | undefined>(() => ({ id: profile.provider }));
  const getModel = vi.fn<(provider: string, id: string) => SdkModel | undefined>(() => resolvedModel);
  const checkAuth = vi.fn<(...args: unknown[]) => Promise<unknown | undefined>>(async () => ({ configured: true }));
  const getAuth = vi.fn<(...args: unknown[]) => Promise<unknown | undefined>>(async () => ({ token: "SECRET_AUTH_TOKEN" }));
  const getAvailable = vi.fn<(...args: unknown[]) => Promise<readonly SdkModel[]>>(async () => [resolvedModel]);
  const runtime = {
    getProvider,
    getModel,
    checkAuth,
    getAuth,
    getAvailable,
  };
  return { runtime: runtime as unknown as ModelRuntime, resolvedModel, ...runtime };
}

function emptyResourceFixture() {
  return {
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
  };
}

function sessionFixture(options: { provider?: string; model?: string; thinkingLevel?: ResolvedExecutionProfile["thinkingLevel"] } = {}) {
  const dispose = vi.fn();
  const session = {
    sessionId: "sdk-test",
    model: model(options.provider ?? profile.provider, options.model ?? profile.model),
    thinkingLevel: options.thinkingLevel ?? profile.thinkingLevel,
    resourceLoader: emptyResourceFixture(),
    subscribe: vi.fn(() => () => undefined),
    prompt: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    dispose,
  } as unknown as AgentSession;
  return { session, dispose };
}

function createSessionFixture(session: AgentSession) {
  return vi.fn(async (_options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => ({ session } as unknown as CreateAgentSessionResult));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function create(adapter: SdkPiSessionAdapter) {
  return adapter.create({ cwd: process.cwd(), executionProfile: profile });
}

describe("SdkPiSessionAdapter deterministic selection", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("uses one lazy runtime for exact resolution and passes the same runtime with explicit options", async () => {
    const fixture = runtimeFixture();
    const runtimeFactory = vi.fn(async () => fixture.runtime);
    const { session } = sessionFixture();
    const createSession = createSessionFixture(session);
    const adapter = new SdkPiSessionAdapter({ modelRuntimeFactory: runtimeFactory, createSession });

    const first = await create(adapter);
    const second = await create(adapter);

    expect(runtimeFactory).toHaveBeenCalledTimes(1);
    expect(fixture.getProvider).toHaveBeenCalledWith(profile.provider);
    expect(fixture.getModel).toHaveBeenCalledWith(profile.provider, profile.model);
    expect(fixture.checkAuth).toHaveBeenCalledWith(profile.provider, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(fixture.getAuth).toHaveBeenCalledWith(fixture.resolvedModel, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(fixture.getAvailable).toHaveBeenCalledWith(profile.provider, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: process.cwd(),
      modelRuntime: fixture.runtime,
      model: fixture.resolvedModel,
      thinkingLevel: profile.thinkingLevel,
      tools: PROFILE_TOOLS["read-only"],
    }));
    expect(first.appliedSelection).toEqual({ provider: profile.provider, model: profile.model, thinkingLevel: profile.thinkingLevel });
    expect(second.appliedSelection).toEqual(first.appliedSelection);
  });

  it("creates the default runtime without refresh-time availability work", async () => {
    const fixture = runtimeFixture();
    const createRuntime = vi.spyOn(ModelRuntime, "create").mockResolvedValue(fixture.runtime);
    const adapter = new SdkPiSessionAdapter({ createSession: createSessionFixture(sessionFixture().session) });

    await create(adapter);

    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(createRuntime).toHaveBeenCalledWith({ refreshOnCreate: false });
  });

  it("rejects an unknown provider before model, auth, availability, or session creation", async () => {
    const fixture = runtimeFixture();
    fixture.getProvider.mockImplementation(() => undefined);
    const createSession = createSessionFixture(sessionFixture().session);
    const adapter = new SdkPiSessionAdapter({ modelRuntimeFactory: async () => fixture.runtime, createSession });

    await expect(create(adapter)).rejects.toMatchObject({ code: "unknown_provider" });
    expect(fixture.getModel).not.toHaveBeenCalled();
    expect(fixture.checkAuth).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("rejects an unknown model before auth, availability, or session creation", async () => {
    const fixture = runtimeFixture();
    fixture.getModel.mockImplementation(() => undefined);
    const createSession = createSessionFixture(sessionFixture().session);
    const adapter = new SdkPiSessionAdapter({ modelRuntimeFactory: async () => fixture.runtime, createSession });

    await expect(create(adapter)).rejects.toMatchObject({ code: "unknown_model" });
    expect(fixture.checkAuth).not.toHaveBeenCalled();
    expect(fixture.getAvailable).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("classifies absent checkAuth or getAuth as local authentication missing", async () => {
    const absentCheck = runtimeFixture();
    absentCheck.checkAuth.mockImplementation(async () => undefined);
    const noCreate = createSessionFixture(sessionFixture().session);
    await expect(create(new SdkPiSessionAdapter({ modelRuntimeFactory: async () => absentCheck.runtime, createSession: noCreate }))).rejects.toMatchObject({ code: "local_authentication_missing" });
    expect(absentCheck.getAuth).not.toHaveBeenCalled();
    expect(noCreate).not.toHaveBeenCalled();

    const absentGet = runtimeFixture();
    absentGet.getAuth.mockImplementation(async () => undefined);
    await expect(create(new SdkPiSessionAdapter({ modelRuntimeFactory: async () => absentGet.runtime, createSession: noCreate }))).rejects.toMatchObject({ code: "local_authentication_missing" });
    expect(absentGet.getAvailable).not.toHaveBeenCalled();
    expect(noCreate).not.toHaveBeenCalled();
  });

  it("classifies thrown checkAuth or getAuth as local authentication unavailable", async () => {
    const thrownCheck = runtimeFixture();
    thrownCheck.checkAuth.mockRejectedValue(new Error("SECRET_CHECK_AUTH"));
    const noCreate = createSessionFixture(sessionFixture().session);
    await expect(create(new SdkPiSessionAdapter({ modelRuntimeFactory: async () => thrownCheck.runtime, createSession: noCreate }))).rejects.toMatchObject({ code: "local_authentication_unavailable" });
    expect(noCreate).not.toHaveBeenCalled();

    const thrownGet = runtimeFixture();
    thrownGet.getAuth.mockRejectedValue(new Error("SECRET_GET_AUTH"));
    await expect(create(new SdkPiSessionAdapter({ modelRuntimeFactory: async () => thrownGet.runtime, createSession: noCreate }))).rejects.toMatchObject({ code: "local_authentication_unavailable" });
    expect(thrownGet.getAvailable).not.toHaveBeenCalled();
    expect(noCreate).not.toHaveBeenCalled();
  });

  it("aborts never-settling checkAuth and getAuth operations at the fixed deadline", async () => {
    vi.useFakeTimers();
    try {
      const checkAuthTimeout = runtimeFixture();
      let checkAuthSignal: AbortSignal | undefined;
      checkAuthTimeout.checkAuth.mockImplementation(async (...args: unknown[]) => {
        checkAuthSignal = (args[1] as { signal: AbortSignal }).signal;
        return new Promise<never>(() => undefined);
      });
      const noCreate = createSessionFixture(sessionFixture().session);
      const checkAuthResult = create(new SdkPiSessionAdapter({ modelRuntimeFactory: async () => checkAuthTimeout.runtime, createSession: noCreate }));
      const checkAuthExpectation = expect(checkAuthResult).rejects.toMatchObject({ code: "local_authentication_unavailable" });
      await vi.advanceTimersByTimeAsync(AUTH_OPERATION_TIMEOUT_MS);
      await checkAuthExpectation;
      expect(checkAuthSignal?.aborted).toBe(true);
      expect(noCreate).not.toHaveBeenCalled();

      const getAuthTimeout = runtimeFixture();
      let getAuthSignal: AbortSignal | undefined;
      getAuthTimeout.getAuth.mockImplementation(async (...args: unknown[]) => {
        getAuthSignal = (args[1] as { signal: AbortSignal }).signal;
        return new Promise<never>(() => undefined);
      });
      const getAuthResult = create(new SdkPiSessionAdapter({ modelRuntimeFactory: async () => getAuthTimeout.runtime, createSession: noCreate }));
      const getAuthExpectation = expect(getAuthResult).rejects.toMatchObject({ code: "local_authentication_unavailable" });
      await vi.advanceTimersByTimeAsync(AUTH_OPERATION_TIMEOUT_MS);
      await getAuthExpectation;
      expect(getAuthSignal?.aborted).toBe(true);
      expect(noCreate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an authenticated but unavailable exact model before session creation", async () => {
    const fixture = runtimeFixture();
    fixture.getAvailable.mockResolvedValue([model(profile.provider, "other-model")]);
    const createSession = createSessionFixture(sessionFixture().session);
    const adapter = new SdkPiSessionAdapter({ modelRuntimeFactory: async () => fixture.runtime, createSession });

    await expect(create(adapter)).rejects.toMatchObject({ code: "model_unavailable" });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("maps availability and session factory failures to sanitized creation errors", async () => {
    const availabilityFailure = runtimeFixture();
    availabilityFailure.getAvailable.mockRejectedValue(new Error("SECRET_AVAILABILITY"));
    const noCreate = createSessionFixture(sessionFixture().session);
    await expect(create(new SdkPiSessionAdapter({ modelRuntimeFactory: async () => availabilityFailure.runtime, createSession: noCreate }))).rejects.toMatchObject({ code: "pi_session_creation_failed" });
    expect(noCreate).not.toHaveBeenCalled();

    const creationFailure = runtimeFixture();
    const rejectedCreate = vi.fn(async (_options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
      throw new Error("SECRET_CREATE");
    });
    await expect(create(new SdkPiSessionAdapter({ modelRuntimeFactory: async () => creationFailure.runtime, createSession: rejectedCreate }))).rejects.toMatchObject({ code: "pi_session_creation_failed" });
  });

  it("bounds session creation and disposes a session that resolves after the deadline", async () => {
    vi.useFakeTimers();
    try {
      const fixture = runtimeFixture();
      const pending = deferred<CreateAgentSessionResult>();
      const late = sessionFixture();
      const createSession = vi.fn(() => pending.promise);
      const result = create(new SdkPiSessionAdapter({ modelRuntimeFactory: async () => fixture.runtime, createSession }));
      const expectation = expect(result).rejects.toMatchObject({ code: "pi_session_creation_failed" });
      await vi.advanceTimersByTimeAsync(SESSION_CREATION_TIMEOUT_MS);
      await expectation;
      pending.resolve({ session: late.session } as CreateAgentSessionResult);
      await Promise.resolve();
      expect(late.dispose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("observes a session creation rejection that arrives after the deadline", async () => {
    vi.useFakeTimers();
    try {
      const fixture = runtimeFixture();
      const pending = deferred<CreateAgentSessionResult>();
      const result = create(new SdkPiSessionAdapter({ modelRuntimeFactory: async () => fixture.runtime, createSession: () => pending.promise }));
      const expectation = expect(result).rejects.toMatchObject({ code: "pi_session_creation_failed" });
      await vi.advanceTimersByTimeAsync(SESSION_CREATION_TIMEOUT_MS);
      await expectation;
      pending.reject(new Error("private late creation detail"));
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("disposes an SDK session at most once and contains dispose failures", async () => {
    const fixture = runtimeFixture();
    const late = sessionFixture();
    late.session.dispose = vi.fn(() => { throw new Error("private dispose detail"); }) as unknown as AgentSession["dispose"];
    const handle = await create(new SdkPiSessionAdapter({ modelRuntimeFactory: async () => fixture.runtime, createSession: createSessionFixture(late.session) }));
    expect(() => handle.dispose()).not.toThrow();
    expect(() => handle.dispose()).not.toThrow();
    expect(late.session.dispose).toHaveBeenCalledTimes(1);
  });

  it("aborts a never-settling availability operation and fails closed", async () => {
    vi.useFakeTimers();
    try {
      const fixture = runtimeFixture();
      let availabilitySignal: AbortSignal | undefined;
      fixture.getAvailable.mockImplementation(async (...args: unknown[]) => {
        availabilitySignal = (args[1] as { signal: AbortSignal }).signal;
        return new Promise<never>(() => undefined);
      });
      const createSession = createSessionFixture(sessionFixture().session);
      const result = create(new SdkPiSessionAdapter({ modelRuntimeFactory: async () => fixture.runtime, createSession }));
      const expectation = expect(result).rejects.toMatchObject({ code: "pi_session_creation_failed" });
      await vi.advanceTimersByTimeAsync(AUTH_OPERATION_TIMEOUT_MS);
      await expectation;
      expect(availabilitySignal?.aborted).toBe(true);
      expect(createSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("disposes a session when SDK thinking is clamped or model selection differs", async () => {
    const clamped = sessionFixture({ thinkingLevel: "low" });
    await expect(create(new SdkPiSessionAdapter({
      modelRuntimeFactory: async () => runtimeFixture().runtime,
      createSession: createSessionFixture(clamped.session),
    }))).rejects.toMatchObject({ code: "thinking_level_unavailable" });
    expect(clamped.dispose).toHaveBeenCalledTimes(1);

    const mismatch = sessionFixture({ model: "other-model" });
    await expect(create(new SdkPiSessionAdapter({
      modelRuntimeFactory: async () => runtimeFixture().runtime,
      createSession: createSessionFixture(mismatch.session),
    }))).rejects.toMatchObject({ code: "execution_selection_mismatch" });
    expect(mismatch.dispose).toHaveBeenCalledTimes(1);
  });

  it("emits only whitelisted diagnostics when fake auth and SDK errors contain secrets", async () => {
    const fixture = runtimeFixture();
    fixture.getAuth.mockResolvedValue({ token: "SECRET_AUTH_OBJECT" });
    fixture.getAvailable.mockRejectedValue(new Error("SECRET_RUNTIME_MESSAGE /secret/path"));
    const events: SdkPiAdapterDiagnostic[] = [];
    const adapter = new SdkPiSessionAdapter({
      modelRuntimeFactory: async () => fixture.runtime,
      createSession: createSessionFixture(sessionFixture().session),
      diagnosticSink: (event) => events.push(event),
    });

    await expect(create(adapter)).rejects.toMatchObject({ code: "pi_session_creation_failed" });
    expect(events).toEqual([{
      level: "error",
      event: "pi_session_creation_failed",
      stage: "availability",
      code: "pi_session_creation_failed",
      executionProfile: profile.alias,
      provider: profile.provider,
      model: profile.model,
      thinkingLevel: profile.thinkingLevel,
    }]);
    expect(JSON.stringify(events)).not.toMatch(/SECRET|path|message|cause/i);
  });
});

describe("Pi resource policy", () => {
  it("normalizes only assistant text blocks", () => {
    expect(normalizeAssistantOutcome({ role: "assistant", content: [
      { type: "text", text: "hello" },
      { type: "thinking", thinking: "secret" },
      { type: "toolCall", name: "bash", arguments: { command: "secret" } },
      { type: "text", text: " world" },
      { type: "errorMessage", message: "provider detail" },
    ], stopReason: "stop" })).toEqual({ status: "completed", assistantText: "hello world" });
  });

  it("maps every SDK stop reason to a turn outcome", () => {
    // Keyed by the SDK union: a stop reason added by a future SDK fails the typecheck here too.
    const expected: Readonly<Record<SdkStopReason, PiTurnOutcome>> = {
      stop: { status: "completed", assistantText: "partial" },
      length: { status: "completed", assistantText: "partial" },
      toolUse: { status: "completed", assistantText: "partial" },
      error: { status: "failed" },
      aborted: { status: "aborted" },
      pending: { status: "failed" },
      deferred: { status: "failed" },
    };
    for (const [stopReason, outcome] of Object.entries(expected)) {
      expect(normalizeAssistantOutcome({ role: "assistant", content: [{ type: "text", text: "partial" }], stopReason }), stopReason).toEqual(outcome);
    }
  });

  it("fails closed on missing messages and stop reasons outside the SDK union", () => {
    expect(normalizeAssistantOutcome(undefined)).toEqual({ status: "failed" });
    expect(normalizeAssistantOutcome({ role: "assistant", content: [{ type: "text", text: "partial" }] })).toEqual({ status: "failed" });
    expect(normalizeAssistantOutcome({ role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "cancelled" })).toEqual({ status: "failed" });
  });

  it("loads only AGENTS.md from untrusted project resources", async () => {
    const cwd = await temporaryRoot("pi-untrusted-");
    const extensionDir = join(cwd, ".pi", "extensions");
    const marker = join(cwd, "extension-ran");
    await mkdir(extensionDir, { recursive: true });
    await writeFile(join(extensionDir, "malicious.js"), "export default () => {};");
    await writeFile(join(cwd, "AGENTS.md"), "# Safe project context\n");
    const { resourceLoader } = await createPhase0ResourceLoader(cwd);

    expect(resourceLoader.getSystemPrompt()).toBeUndefined();
    expect(resourceLoader.getAppendSystemPrompt()).toEqual([]);
    expect(resourceLoader.getExtensions().extensions).toEqual([]);
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(resourceLoader.getAgentsFiles().agentsFiles.some(({ path }) => path === join(cwd, "AGENTS.md"))).toBe(true);
  });
});

/**
 * A session whose event stream and prompt settlement are driven by the test. The
 * subscription stays live until the SDK-adapter cleanup runs or the test ends it,
 * mirroring the SDK's own listener lifetime.
 */
function activitySessionFixture() {
  const unsubscribe = vi.fn();
  let listener: ((event: unknown) => void) | undefined;
  const settlement = deferred<void>();
  const session = {
    sessionId: "sdk-activity",
    model: model(),
    thinkingLevel: profile.thinkingLevel,
    resourceLoader: emptyResourceFixture(),
    subscribe: vi.fn((next: (event: unknown) => void) => {
      listener = next;
      return () => { listener = undefined; unsubscribe(); };
    }),
    prompt: vi.fn(() => settlement.promise),
    abort: vi.fn(async () => undefined),
    dispose: vi.fn(),
  } as unknown as AgentSession;
  return {
    session, unsubscribe,
    emit: (event: unknown): void => { listener?.(event); },
    settle: (): void => { settlement.resolve(); },
    fail: (): void => { settlement.reject(new Error("SECRET_PROVIDER_FAILURE")); },
  };
}

async function createWithSession(session: AgentSession) {
  return create(new SdkPiSessionAdapter({
    modelRuntimeFactory: async () => runtimeFixture().runtime,
    createSession: createSessionFixture(session),
  }));
}

describe("running-turn activity signals", () => {
  it("reports one content-free signal per completed tool execution and assistant message", async () => {
    const fixture = activitySessionFixture();
    const handle = await createWithSession(fixture.session);
    const onActivity = vi.fn();
    const outcome = handle.prompt("work", () => undefined, onActivity);

    fixture.emit({ type: "agent_start" });
    fixture.emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "WORK_PROMPT_MARKER" }] } });
    fixture.emit({ type: "message_update", message: { role: "assistant", content: [] } });
    fixture.emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "WORK_PROMPT_MARKER" }] } });
    fixture.emit({ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "SECRET_TOOL_RESULT" }] } });
    fixture.emit({ type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [] });
    fixture.emit({ type: "tool_execution_start", toolCallId: "call_1", toolName: "read", args: { path: "SECRET_TOOL_ARGUMENT" } });
    expect(onActivity).not.toHaveBeenCalled();

    fixture.emit({ type: "tool_execution_end", toolCallId: "call_1", toolName: "read", result: { content: [{ type: "text", text: "SECRET_TOOL_RESULT" }] }, isError: false });
    expect(onActivity).toHaveBeenCalledTimes(1);
    fixture.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "all done" }], stopReason: "stop" } });
    expect(onActivity).toHaveBeenCalledTimes(2);

    // The signal is content-free: no event, tool, or message payload crosses the boundary.
    expect(onActivity.mock.calls).toEqual([[], []]);

    fixture.settle();
    await expect(outcome).resolves.toEqual({ status: "completed", assistantText: "all done" });
    expect(fixture.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("isolates observer failures from SDK event dispatch and the terminal outcome", async () => {
    const fixture = activitySessionFixture();
    const handle = await createWithSession(fixture.session);
    const onActivity = vi.fn(() => { throw new Error("observer failure"); });
    const outcome = handle.prompt("work", () => undefined, onActivity);

    expect(() => fixture.emit({ type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", result: {}, isError: true })).not.toThrow();
    expect(() => fixture.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "survived" }], stopReason: "stop" } })).not.toThrow();
    expect(onActivity).toHaveBeenCalledTimes(2);

    fixture.settle();
    await expect(outcome).resolves.toEqual({ status: "completed", assistantText: "survived" });
  });

  it("unsubscribes once per prompt on success, failure, and disposal without late signals", async () => {
    const succeeded = activitySessionFixture();
    const succeedingHandle = await createWithSession(succeeded.session);
    const successObserver = vi.fn();
    const success = succeedingHandle.prompt("work", () => undefined, successObserver);
    succeeded.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "settled" }], stopReason: "stop" } });
    succeeded.settle();
    await expect(success).resolves.toEqual({ status: "completed", assistantText: "settled" });
    expect(succeeded.unsubscribe).toHaveBeenCalledTimes(1);
    succeeded.emit({ type: "tool_execution_end", toolCallId: "call_1", toolName: "read", result: {}, isError: false });
    expect(successObserver).toHaveBeenCalledTimes(1);

    const rejected = activitySessionFixture();
    const failingHandle = await createWithSession(rejected.session);
    const failingObserver = vi.fn();
    const failure = failingHandle.prompt("work", () => undefined, failingObserver);
    rejected.emit({ type: "tool_execution_end", toolCallId: "call_1", toolName: "read", result: {}, isError: false });
    expect(failingObserver).toHaveBeenCalledTimes(1);
    rejected.fail();
    await expect(failure).resolves.toEqual({ status: "failed" });
    expect(rejected.unsubscribe).toHaveBeenCalledTimes(1);
    rejected.emit({ type: "tool_execution_end", toolCallId: "call_2", toolName: "read", result: {}, isError: false });
    expect(failingObserver).toHaveBeenCalledTimes(1);

    const disposed = activitySessionFixture();
    const disposingHandle = await createWithSession(disposed.session);
    const disposingObserver = vi.fn();
    void disposingHandle.prompt("work", () => undefined, disposingObserver);
    await disposingHandle.dispose();
    expect(disposed.unsubscribe).toHaveBeenCalledTimes(1);
    disposed.emit({ type: "tool_execution_end", toolCallId: "call_1", toolName: "read", result: {}, isError: false });
    expect(disposingObserver).not.toHaveBeenCalled();
    await disposingHandle.dispose();
    expect(disposed.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("keeps a prompt without an observer working exactly as before", async () => {
    const fixture = activitySessionFixture();
    const handle = await createWithSession(fixture.session);
    const outcome = handle.prompt("work", () => undefined);
    fixture.emit({ type: "tool_execution_end", toolCallId: "call_1", toolName: "read", result: {}, isError: false });
    fixture.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "no observer" }], stopReason: "stop" } });
    fixture.settle();
    await expect(outcome).resolves.toEqual({ status: "completed", assistantText: "no observer" });
    expect(fixture.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("startup diagnostics", () => {
  it("projects ConfigError codes without retaining raw startup failures", () => {
    expect(startupFailureDiagnostic(new ConfigError("invalid_execution_profile_config"))).toEqual({
      level: "error",
      event: "startup_failed",
      stage: "startup",
      code: "invalid_execution_profile_config",
    });
    expect(startupFailureDiagnostic(new ConfigError("invalid_thinking_level"))).toEqual({
      level: "error",
      event: "startup_failed",
      stage: "startup",
      code: "invalid_thinking_level",
    });
    const unknown = startupFailureDiagnostic(new Error("SECRET_STARTUP /private/config.json"));
    expect(unknown).toEqual({ level: "error", event: "startup_failed", stage: "startup", code: "startup_failed" });
    expect(JSON.stringify(unknown)).not.toMatch(/SECRET|private|config\.json|message|path/i);
  });
});

describe("plain-text prompts", () => {
  it("sends every prompt as plain text so extension commands never run", async () => {
    const fixture = runtimeFixture();
    const { session } = sessionFixture();
    const adapter = new SdkPiSessionAdapter({ modelRuntimeFactory: async () => fixture.runtime, createSession: createSessionFixture(session) });
    const handle = await create(adapter);
    await handle.prompt("/fixture-cmd hello", () => undefined);
    expect(session.prompt).toHaveBeenCalledWith("/fixture-cmd hello", expect.objectContaining({ expandPromptTemplates: false }));
  });

  it("marks every prompt as rpc input for extension input hooks", async () => {
    const fixture = runtimeFixture();
    const { session } = sessionFixture();
    const adapter = new SdkPiSessionAdapter({ modelRuntimeFactory: async () => fixture.runtime, createSession: createSessionFixture(session) });
    const handle = await create(adapter);
    await handle.prompt("hello", () => undefined);
    expect(session.prompt).toHaveBeenCalledWith("hello", expect.objectContaining({ source: "rpc" }));
  });
});

const fixtureExtension = parseExtensionSpec("npm:fixture-ext@1.2.3")!;
const extensionProfile: ResolvedExecutionProfile = Object.freeze({ ...profile, alias: "with-extension", extensions: Object.freeze([fixtureExtension]) });

function extensionHarness(options: {
  permissionProfile?: "read-only" | "coding";
  extensionTools?: string[][];
  loadErrors?: number;
  diagnosticError?: boolean;
  activeTools?: string[];
  withMcp?: boolean;
} = {}) {
  const permissionProfile = options.permissionProfile ?? "read-only";
  const extensionTools = options.extensionTools ?? [["fixture_tool"]];
  const mcpNames = options.withMcp ? ["mcp_knowledge_search"] : [];
  const expectedTools = permissionProfile === "coding"
    ? [...PROFILE_TOOLS.coding, ...mcpNames, ...extensionTools.flat()]
    : [...PROFILE_TOOLS["read-only"], ...mcpNames];
  // The same mutable maps back every `getExtensions()` call, so a fake bind can register tools.
  const toolMaps = extensionTools.map((names) => new Map<string, unknown>(names.map((name) => [name, {}])));
  const mcpClosed = vi.fn();
  const mcpConnection: McpConnection = {
    async connect() {}, async listTools() { return { tools: [{ name: "search_knowledge", inputSchema: { type: "object" } }] }; },
    async callTool() { return { content: [{ type: "text", text: "found" }] }; }, async close() { mcpClosed(); },
  };
  const fixture = runtimeFixture();
  const { session, dispose: sessionDispose } = sessionFixture();
  const bindExtensions = vi.fn(async (_bindings: { mode?: string; onError?: (error: unknown) => void }) => undefined);
  Object.assign(session as object, { bindExtensions, getActiveToolNames: vi.fn(() => options.activeTools ?? expectedTools) });
  const services = {
    cwd: "/hidden/workspace", agentDir: "/hidden/workspace", modelRuntime: fixture.runtime, settingsManager: {},
    diagnostics: options.diagnosticError ? [{ type: "error", message: "hidden" }] : [],
    resourceLoader: {
      ...emptyResourceFixture(),
      getExtensions: () => ({
        extensions: toolMaps.map((tools) => ({ tools })),
        errors: Array.from({ length: options.loadErrors ?? 0 }, () => ({ path: "/hidden", error: "hidden" })),
      }),
    },
  } as unknown as AgentSessionServices;
  const runtimeDispose = vi.fn(async () => undefined);
  const sessionRuntime = { session, dispose: runtimeDispose } as unknown as AgentSessionRuntime;
  const createServices = vi.fn(async (_options: unknown) => services);
  const createSessionFromServices = vi.fn(async (_options: unknown) => ({ session }) as unknown as CreateAgentSessionResult);
  const createRuntime = vi.fn(async (factory: CreateAgentSessionRuntimeFactory, runtimeOptions: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
    await factory(runtimeOptions);
    return sessionRuntime;
  });
  const resolveExtension = vi.fn(async (_extension: unknown) => "/hidden/extension/fixture-ext");
  const runtimeFactory = vi.fn(async () => fixture.runtime);
  const createSession = createSessionFixture(session);
  const diagnostics: SdkPiAdapterDiagnostic[] = [];
  const adapter = new SdkPiSessionAdapter({
    modelRuntimeFactory: runtimeFactory, createSession, resolveExtension,
    extensionSdk: { createServices, createSessionFromServices, createRuntime } as unknown as ExtensionSdk,
    mcpConnectionFactory: () => mcpConnection,
    diagnosticSink: (diagnostic) => { diagnostics.push(diagnostic); },
  });
  const executionProfile: ResolvedExecutionProfile = {
    ...extensionProfile, permissionProfile,
    ...(options.withMcp ? { mcpServers: { knowledge: { command: process.execPath, args: ["/operator/server.mjs"], tools: { search: { name: "search_knowledge", readOnly: true } } } } } : {}),
  };
  return {
    toolMaps, mcpClosed,
    adapter, fixture, session, sessionDispose, bindExtensions, services, sessionRuntime, runtimeDispose, createServices,
    createSessionFromServices, createRuntime, resolveExtension, runtimeFactory, createSession, diagnostics, expectedTools,
    create: (override: ResolvedExecutionProfile = executionProfile) => adapter.create({ cwd: "/hidden/workspace", executionProfile: override }),
  };
}

describe("SdkPiSessionAdapter allowlisted extensions", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("loads extensions through services before verifying the selection", async () => {
    const h = extensionHarness();
    const handle = await h.create();
    expect(h.resolveExtension).toHaveBeenCalledWith(fixtureExtension);
    expect(h.createServices).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/hidden/workspace", agentDir: "/hidden/workspace", modelRuntime: h.fixture.runtime,
      resourceLoaderOptions: expect.objectContaining({
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        additionalExtensionPaths: ["/hidden/extension/fixture-ext"],
      }),
    }));
    expect(h.createServices.mock.invocationCallOrder[0]!).toBeLessThan(h.fixture.getProvider.mock.invocationCallOrder[0]!);
    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.createSessionFromServices).toHaveBeenCalledWith(expect.objectContaining({
      services: h.services, model: h.fixture.resolvedModel, thinkingLevel: profile.thinkingLevel, tools: PROFILE_TOOLS["read-only"],
    }));
    expect(h.bindExtensions).toHaveBeenCalledWith({ mode: "print", onError: expect.any(Function) });
    expect(handle.appliedSelection).toEqual({ provider: profile.provider, model: profile.model, thinkingLevel: profile.thinkingLevel });
  });

  it("gives every extension session its own model runtime", async () => {
    const h = extensionHarness();
    await Promise.all([h.create(), h.create()]);
    expect(h.runtimeFactory).toHaveBeenCalledTimes(2);
    expect(h.createServices).toHaveBeenCalledTimes(2);
  });

  it("keeps profiles without extensions on the unchanged path", async () => {
    const h = extensionHarness();
    await h.create(profile);
    await h.create({ ...profile, extensions: [] });
    expect(h.createServices).not.toHaveBeenCalled();
    expect(h.createSession).toHaveBeenCalledTimes(2);
    expect(h.runtimeFactory).toHaveBeenCalledTimes(1);
  });

  it("activates extension tools in coding profiles", async () => {
    const h = extensionHarness({ permissionProfile: "coding" });
    await h.create();
    expect(h.createSessionFromServices).toHaveBeenCalledWith(expect.objectContaining({ tools: [...PROFILE_TOOLS.coding, "fixture_tool"] }));
  });

  it.each([
    ["read-only", [["read"]]],
    ["coding", [["bash"]]],
    ["coding", [["dup"], ["dup"]]],
    ["coding", [["mcp__x"]]],
    ["read-only", [["read_mcp_resource"]]],
  ] as const)("fails closed on a %s tool conflict %j", async (permissionProfile, extensionTools) => {
    const h = extensionHarness({ permissionProfile, extensionTools: extensionTools.map((names) => [...names]) });
    await expect(h.create()).rejects.toMatchObject({ code: "extension_tool_conflict" });
    expect(h.createRuntime).not.toHaveBeenCalled();
  });

  it.each(["extension_not_installed", "extension_version_mismatch", "extension_load_failed"] as const)("reports a %s resolution failure", async (code) => {
    const h = extensionHarness();
    h.resolveExtension.mockRejectedValueOnce(new PiExtensionError(code));
    await expect(h.create()).rejects.toMatchObject({ name: "PiSessionCreationError", code });
    expect(h.diagnostics).toContainEqual(expect.objectContaining({ stage: "extension_resolve", code, extension: "fixture-ext@1.2.3" }));
    expect(JSON.stringify(h.diagnostics)).not.toContain("/hidden");
    expect(h.runtimeFactory).not.toHaveBeenCalled();
    expect(h.createServices).not.toHaveBeenCalled();
  });

  it("classifies a foreign resolver failure as a load failure", async () => {
    const h = extensionHarness();
    h.resolveExtension.mockRejectedValueOnce(new Error("/hidden/path"));
    await expect(h.create()).rejects.toMatchObject({ code: "extension_load_failed" });
  });

  it.each([{ loadErrors: 1 }, { diagnosticError: true }])("fails closed on extension load errors %j", async (options) => {
    const h = extensionHarness(options);
    await expect(h.create()).rejects.toMatchObject({ code: "extension_load_failed" });
    expect(h.diagnostics).toContainEqual(expect.objectContaining({ stage: "extension_load", code: "extension_load_failed" }));
    expect(h.createRuntime).not.toHaveBeenCalled();
  });

  it("disposes the session runtime when binding fails", async () => {
    const h = extensionHarness();
    h.bindExtensions.mockRejectedValueOnce(new Error("hidden"));
    await expect(h.create()).rejects.toMatchObject({ code: "extension_load_failed" });
    expect(h.diagnostics).toContainEqual(expect.objectContaining({ stage: "extension_bind" }));
    expect(h.runtimeDispose).toHaveBeenCalledTimes(1);
  });

  it("rejects an active tool outside the allowlist after binding and disposes the runtime", async () => {
    const h = extensionHarness({ activeTools: [...PROFILE_TOOLS["read-only"], "fixture_tool"] });
    await expect(h.create()).rejects.toMatchObject({ code: "execution_selection_mismatch" });
    expect(h.runtimeDispose).toHaveBeenCalledTimes(1);
  });

  it("rejects a coding session with an active tool outside the allowlist", async () => {
    const h = extensionHarness({ permissionProfile: "coding", activeTools: [...PROFILE_TOOLS.coding, "fixture_tool", "rogue"] });
    await expect(h.create()).rejects.toMatchObject({ code: "execution_selection_mismatch" });
    expect(h.runtimeDispose).toHaveBeenCalledTimes(1);
  });

  it("admits a session whose extension deactivates its own tool", async () => {
    const h = extensionHarness({ permissionProfile: "coding", activeTools: [...PROFILE_TOOLS.coding] });
    const handle = await h.create();
    expect(handle.appliedSelection.model).toBe(profile.model);
    expect(h.runtimeDispose).not.toHaveBeenCalled();
  });

  it("closes through the session runtime so session_shutdown runs", async () => {
    const h = extensionHarness();
    const handle = await h.create();
    await handle.dispose();
    expect(h.runtimeDispose).toHaveBeenCalledTimes(1);
    expect(h.sessionDispose).not.toHaveBeenCalled();
  });

  it("disposes a session runtime that resolves after the creation deadline", async () => {
    vi.useFakeTimers();
    try {
      const h = extensionHarness();
      const late = deferred<AgentSessionRuntime>();
      h.createRuntime.mockImplementationOnce(() => late.promise);
      const outcome = expect(h.create()).rejects.toMatchObject({ code: "pi_session_creation_failed" });
      await vi.advanceTimersByTimeAsync(SESSION_CREATION_TIMEOUT_MS);
      await outcome;
      late.resolve(h.sessionRuntime);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.runtimeDispose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when binding registers a tool that replaces a built-in", async () => {
    const h = extensionHarness({ withMcp: true });
    h.bindExtensions.mockImplementationOnce(async () => { h.toolMaps[0]!.set("read", {}); });
    await expect(h.create()).rejects.toMatchObject({ code: "extension_tool_conflict" });
    expect(h.diagnostics).toContainEqual(expect.objectContaining({ stage: "extension_bind", code: "extension_tool_conflict" }));
    expect(h.runtimeDispose).toHaveBeenCalledTimes(1);
    expect(h.mcpClosed).toHaveBeenCalledTimes(1);
  });

  it("fails closed when binding adds any tool to the selection", async () => {
    const h = extensionHarness({ permissionProfile: "coding" });
    h.bindExtensions.mockImplementationOnce(async () => { h.toolMaps[0]!.set("late_tool", {}); });
    await expect(h.create()).rejects.toMatchObject({ code: "extension_tool_conflict" });
    expect(h.runtimeDispose).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a hook reports an error while binding", async () => {
    const h = extensionHarness({ withMcp: true });
    h.bindExtensions.mockImplementationOnce(async (bindings) => { bindings.onError?.({ extensionPath: "/hidden", event: "session_start", error: "hidden" }); });
    await expect(h.create()).rejects.toMatchObject({ code: "extension_load_failed" });
    expect(h.diagnostics).toContainEqual(expect.objectContaining({ stage: "extension_bind", code: "extension_load_failed" }));
    expect(JSON.stringify(h.diagnostics)).not.toContain("/hidden");
    expect(h.runtimeDispose).toHaveBeenCalledTimes(1);
    expect(h.mcpClosed).toHaveBeenCalledTimes(1);
  });

  it("ignores hook errors reported after binding", async () => {
    const h = extensionHarness();
    let onError: ((error: unknown) => void) | undefined;
    h.bindExtensions.mockImplementationOnce(async (bindings) => { onError = bindings.onError; });
    const handle = await h.create();
    onError?.({ error: "late" });
    expect(handle.appliedSelection.model).toBe(profile.model);
    expect(h.runtimeDispose).not.toHaveBeenCalled();
  });

  it("closes granted MCP tools on a tool conflict and on a bind failure", async () => {
    const conflict = extensionHarness({ withMcp: true, extensionTools: [["read"]] });
    await expect(conflict.create()).rejects.toMatchObject({ code: "extension_tool_conflict" });
    expect(conflict.mcpClosed).toHaveBeenCalledTimes(1);
    const bind = extensionHarness({ withMcp: true });
    bind.bindExtensions.mockRejectedValueOnce(new Error("hidden"));
    await expect(bind.create()).rejects.toMatchObject({ code: "extension_load_failed" });
    expect(bind.mcpClosed).toHaveBeenCalledTimes(1);
  });

  it("closes MCP and bounds a hanging runtime disposal on failure", async () => {
    vi.useFakeTimers();
    try {
      const h = extensionHarness({ withMcp: true });
      h.runtimeDispose.mockImplementation(() => new Promise<undefined>(() => undefined));
      h.bindExtensions.mockRejectedValueOnce(new Error("hidden"));
      const outcome = expect(h.create()).rejects.toMatchObject({ code: "extension_load_failed" });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.mcpClosed).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(SESSION_CREATION_TIMEOUT_MS);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails an extension load that outlives the creation deadline", async () => {
    vi.useFakeTimers();
    try {
      const h = extensionHarness();
      h.createServices.mockImplementationOnce(() => new Promise<AgentSessionServices>(() => undefined));
      const outcome = expect(h.create()).rejects.toMatchObject({ code: "extension_load_failed" });
      await vi.advanceTimersByTimeAsync(SESSION_CREATION_TIMEOUT_MS);
      await outcome;
      expect(h.diagnostics).toContainEqual(expect.objectContaining({ stage: "extension_load", code: "extension_load_failed" }));
      expect(h.createRuntime).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

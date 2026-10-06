import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ModelRuntime, type AgentSession, type CreateAgentSessionOptions, type CreateAgentSessionResult } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";
import { ConfigError } from "../src/config.js";
import type { ResolvedExecutionProfile } from "../src/execution-profile.js";
import { startupFailureDiagnostic } from "../src/process-diagnostics.js";
import type { PiTurnOutcome } from "../src/pi-adapter.js";
import { AUTH_OPERATION_TIMEOUT_MS, SESSION_CREATION_TIMEOUT_MS, createPhase0ResourceLoader, normalizeAssistantOutcome, PROFILE_TOOLS, SdkPiSessionAdapter, type SdkPiAdapterDiagnostic, type SdkStopReason } from "../src/sdk-pi-adapter.js";

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

function sessionFixture(options: { provider?: string; model?: string; thinkingLevel?: ResolvedExecutionProfile["thinkingLevel"] } = {}) {
  const dispose = vi.fn();
  const session = {
    sessionId: "sdk-test",
    model: model(options.provider ?? profile.provider, options.model ?? profile.model),
    thinkingLevel: options.thinkingLevel ?? profile.thinkingLevel,
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

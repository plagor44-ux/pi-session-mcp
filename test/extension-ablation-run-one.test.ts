import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime, type AgentSession, type ModelRuntime as ModelRuntimeType } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { toResolvedExecutionProfile } from "../src/execution-profile.js";
import { PiExtensionError } from "../src/extension-spec.js";
import { resolvePiExtension } from "../src/pi-extensions.js";
import { runOne, type RunOneInput, type RunOutput } from "../eval/extensions/run-one.js";
import { createCapturingAdapter } from "../eval/extensions/seams.js";
import { classifyProviderError, UsageCollector } from "../eval/extensions/usage.js";
import { SessionRegistry } from "../src/session-registry.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

type Adapter = NonNullable<Parameters<typeof runOne>[1]>["adapterOptions"];
interface Step { text?: string; throws?: boolean; rejected?: boolean; hang?: boolean; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total: number } } }

afterAll(removeTemporaryRoots);

const FIXTURE = fileURLToPath(new URL("./fixtures/pi-extension-fixture", import.meta.url));
let privateDir = "";
let configs: { plain: string; extension: string; fixture: string };
let agentDir = "";

const profile = { permissionProfile: "read-only", provider: "scripted", model: "scripted", thinkingLevel: "off" } as const;
async function writeConfig(root: string, name: string, profiles: Record<string, unknown>, workspace: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, JSON.stringify({
    workspaces: { clone: workspace },
    skillCatalog: { "pi-session-review": "builtin:pi-session-review", "pi-session-implementation": "builtin:pi-session-implementation" },
    executionProfiles: profiles,
  }));
  return path;
}

beforeAll(async () => {
  const root = await temporaryRoot("extension-ablation-run-one-");
  const workspace = join(root, "clone");
  agentDir = join(root, "agent");
  privateDir = join(root, "private");
  await mkdir(workspace);
  await mkdir(join(agentDir, "npm", "node_modules"), { recursive: true });
  await cp(FIXTURE, join(agentDir, "npm", "node_modules", "pi-extension-fixture"), { recursive: true });
  // Coding profiles are only startable in a workspace whose mode accepts host writes.
  await writeFile(join(root, "execution-modes.json"), JSON.stringify({ schemaVersion: 1, workspaces: { clone: { mode: "host", acceptHostWrites: true } } }));
  const profiles = {
    review: { ...profile, default: true, skills: ["pi-session-review"] },
    code: { ...profile, default: false, permissionProfile: "coding", skills: ["pi-session-implementation"] },
  };
  configs = {
    plain: await writeConfig(root, "plain.json", profiles, workspace),
    extension: await writeConfig(root, "extension.json", { ...profiles, review: { ...profiles.review, extensions: ["npm:pi-lens@4.4.3"] } }, workspace),
    fixture: await writeConfig(root, "fixture.json", { ...profiles, review: { ...profiles.review, provider: "fixture-ext", model: "fixture-ext-model", extensions: ["npm:pi-extension-fixture@1.0.0"], skills: [] } }, workspace),
  };
});

/** Extension-profile options: the fixture extension supplies its own provider, no credentials needed. */
function fixtureAdapter(): NonNullable<Adapter> {
  return {
    modelRuntimeFactory: () => ModelRuntime.create({
      refreshOnCreate: false, allowModelNetwork: false, modelsPath: null,
      authPath: join(agentDir, "auth.json"), modelsStorePath: join(agentDir, "models-store.json"),
    }),
    resolveExtension: (spec) => resolvePiExtension(spec, { agentDir }),
  };
}

// Each run needs its own private text file name: the file is created exclusively.
let runCounter = 0;
function input(kind: "read-only" | "coding", extra: { extensions?: string[]; fixture?: boolean } = {}): RunOneInput {
  const configPath = extra.fixture ? configs.fixture : extra.extensions ? configs.extension : configs.plain;
  return { runId: `00${++runCounter}-task-A-review`, configPath, workspaceAlias: "clone", profile: kind === "coding" ? "code" : "review", promptText: "synthetic prompt", turnTimeoutMs: 20_000, privateDir };
}

function assistant(step: Step): unknown {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, ...step.usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: step.usage?.cost?.total ?? 0 } };
  return { role: "assistant", content: [{ type: "text", text: step.text ?? "" }], api: "scripted", provider: "scripted", model: "scripted", usage, stopReason: "stop", timestamp: Date.now() };
}

/**
 * A scripted model runtime driven through the real `createAgentSession`: one step per model request.
 * `throws` fails the stream (the SDK then records an error assistant message); `rejected` makes the SDK
 * refuse the prompt before any model request, so no assistant message exists.
 */
function scripted(steps: Step[]): Adapter {
  const model = { provider: "scripted", id: "scripted", input: ["text"] };
  const queue = [...steps];
  let checks = 0;
  const runtime = {
    getProvider: () => ({ id: "scripted" }), getModel: () => model,
    hasConfiguredAuth: () => !queue[0]?.rejected, checkAuth: async () => (++checks === 1 || !queue[0]?.rejected ? true : undefined), // the first check is the adapter's session-start check
    getAuth: async () => ({ token: "synthetic" }), isUsingOAuth: () => false,
    getAvailable: async () => [model], getAvailableSnapshot: () => [model],
    streamSimple: async (_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) => {
      const step = queue.shift() ?? { text: "" };
      if (step.hang) await new Promise<void>((resolve) => { if (options?.signal?.aborted) resolve(); else options?.signal?.addEventListener("abort", () => resolve(), { once: true }); });
      if (step.throws) throw new Error("scripted provider failure");
      const final = assistant(step);
      return {
        async *[Symbol.asyncIterator]() { yield { type: "start", partial: final }; yield { type: "done", reason: "stop", message: final }; },
        async result() { return final; },
      };
    },
  } as unknown as ModelRuntimeType;
  return { modelRuntimeFactory: async () => runtime };
}

describe("extension ablation run unit", () => {
  it("returns the completed text by reference and sums assistant usage", async () => {
    const out = await runOne(input("read-only"), { adapterOptions: scripted([{ text: "ok", usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 0, cost: { total: 0.001 } } }]) });
    expect(out.terminal).toBe("completed");
    expect(out.usage.assistant).toMatchObject({ messages: 1, input: 10, output: 5, cacheRead: 3 });
    expect(out.usage.session?.costUsd).toBeCloseTo(0.001);
    expect(out.usage.session).toMatchObject({ input: 10, output: 5, cacheRead: 3, cacheWrite: 0 });
    expect(out.usage.assistant.costUsd).toBeCloseTo(0.001);
    expect(out.usage.providerError).toBeNull();
    expect(out.sessionsLeft).toBe(0);
    expect(out.assistantTextRef).toBe(`${out.runId}.txt`);
    expect(out.runId).toMatch(/^00\d+-task-A-review$/);
    expect(await readFile(join(privateDir, out.assistantTextRef!), "utf8")).toBe("ok");
    expect((await stat(join(privateDir, out.assistantTextRef!))).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(out)).not.toContain("synthetic prompt");
  });

  it("reports no cost of record for a failed stream that billed nothing", async () => {
    const out = await runOne(input("read-only"), { adapterOptions: scripted([{ throws: true }]) });
    expect(out.terminal).toBe("failed");
    expect(out.usage.assistant).toMatchObject({ messages: 1, input: 0, output: 0, costUsd: 0 });
    expect(out.usage.session).toBeNull();   // a synthesized failure bills nothing: stats report zero tokens and zero cost
    expect(out.harnessError).toBeNull();
    expect(out.usage.providerError).toBe("other");
    expect(out.assistantTextRef).toBeNull();
  });

  it("reports cost null when no assistant message was observed", async () => {
    const out = await runOne(input("read-only"), { adapterOptions: scripted([{ rejected: true }]) });
    expect(out.terminal).toBe("failed");
    expect(out.usage.session).toBeNull();
    expect(out.usage.assistant.messages).toBe(0);
    expect(out.assistantTextRef).toBeNull();
    expect(out.sessionsLeft).toBe(0);
  });

  it("classifies provider errors without storing the message", () => {
    expect(classifyProviderError("error", "HTTP 401 Unauthorized")).toBe("auth");
    expect(classifyProviderError("error", "You exceeded your current quota")).toBe("quota");
    expect(classifyProviderError("error", "429 Too Many Requests")).toBe("rate_limit");
    expect(classifyProviderError("error", "socket hang up")).toBe("other");
    expect(classifyProviderError("error", undefined)).toBe("other");
    expect(classifyProviderError("stop", "401")).toBeNull();
  });

  it("aborts a turn that outlives the timeout and still leaves no session behind", async () => {
    const out = await runOne({ ...input("read-only"), turnTimeoutMs: 400 }, { adapterOptions: scripted([{ hang: true }]) });
    expect(out.terminal).toBe("timeout");
    expect(out.durationMs).toBeGreaterThanOrEqual(400);
    expect(out.sessionsLeft).toBe(0);
    expect(out.assistantTextRef).toBeNull();
  });

  it("maps a session-start failure to start_failed with the product error code", async () => {
    const out = await runOne(input("read-only", { extensions: ["npm:pi-lens@4.4.3"] }), { adapterOptions: { ...scripted([]), resolveExtension: async () => { throw new PiExtensionError("extension_not_installed"); } } });
    expect(out).toMatchObject({ terminal: "start_failed", startErrorCode: "extension_not_installed", sessionsLeft: 0, assistantTextRef: null });
    expect(out.usage.session).toBeNull();
  });

  it("starts a coding profile with a builtin skill", async () => {
    const out = await runOne(input("coding"), { adapterOptions: scripted([{ text: "done" }]) });
    expect(out.terminal).toBe("completed");   // skill_load_failed would mean the builtin skill did not resolve
    expect(out.startErrorCode).toBeNull();
  });

  it("captures the session of an extension profile through the createRuntime seam", async () => {
    const adapterOptions = fixtureAdapter();
    // The fixture extension writes raw stdout on load, on purpose; keep the test output pristine.
    const silence = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let out: RunOutput;
    try { out = await runOne(input("read-only", { fixture: true }), { adapterOptions }); } finally { silence.mockRestore(); }
    expect(out.terminal).toBe("completed");
    expect(out.usage.assistant.messages).toBeGreaterThan(0);
    expect(out.usage.session).not.toBeNull();
    expect(out.sessionsLeft).toBe(0);
  });

  it("keeps measured usage and reports private_write_failed when the text file already exists", async () => {
    const first = await runOne({ ...input("read-only"), runId: "exists-1" }, { adapterOptions: scripted([{ text: "one", usage: { input: 1, cost: { total: 0.5 } } }]) });
    expect(first).toMatchObject({ terminal: "completed", harnessError: null });
    const second = await runOne({ ...input("read-only"), runId: "exists-1" }, { adapterOptions: scripted([{ text: "two", usage: { input: 2, cost: { total: 0.25 } } }]) });
    expect(second).toMatchObject({ terminal: "failed", harnessError: "private_write_failed", assistantTextRef: null, sessionsLeft: 0 });
    expect(second.usage.session?.costUsd).toBeCloseTo(0.25);
    expect(await readFile(join(privateDir, "exists-1.txt"), "utf8")).toBe("one");
  });

  it("flags a text cut at the turn cap", async () => {
    const out = await runOne({ ...input("read-only"), runId: "long-1" }, { adapterOptions: scripted([{ text: "a".repeat(70_000) }]) });
    expect(out).toMatchObject({ terminal: "completed", assistantTextTruncated: true, harnessError: null });
    expect((await readFile(join(privateDir, out.assistantTextRef!), "utf8")).length).toBeLessThan(70_000);
    const short = await runOne({ ...input("read-only"), runId: "short-1" }, { adapterOptions: scripted([{ text: "ok" }]) });
    expect(short.assistantTextTruncated).toBe(false);
  });

  it("rejects a run id that could form a path", async () => {
    for (const runId of ["../x", "a/b", "", "a b", "x".repeat(129)]) {
      await expect(runOne({ ...input("read-only"), runId }, { adapterOptions: scripted([]) })).rejects.toMatchObject({ code: "invalid_run_id" });
    }
  });

  // The real SDK offers no way to bill usage outside assistant messages, so these two cases use a session double
  // whose stats carry usage the assistant events do not.
  it("keeps a session figure when only side usage was billed", () => {
    const double = (stats: { total: number; cost: number }) => {
      let listener: ((event: unknown) => void) | undefined;
      const session = {
        subscribe: (fn: (event: unknown) => void) => { listener = fn; return () => undefined; },
        getSessionStats: () => ({ tokens: { input: stats.total, output: 0, cacheRead: 0, cacheWrite: 0, total: stats.total }, cost: stats.cost }),
      } as unknown as AgentSession;
      const collector = new UsageCollector();
      collector.attach(session);
      listener!({ type: "message_end", message: { role: "assistant", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } }, stopReason: "error", errorMessage: "boom" } });
      return collector.finish(session);
    };
    const billed = double({ total: 7, cost: 0.2 });
    expect(billed.session).toEqual({ input: 7, output: 0, cacheRead: 0, cacheWrite: 0, total: 7, costUsd: 0.2 });
    expect(billed.assistant).toMatchObject({ messages: 1, input: 0, costUsd: 0 });
    expect(double({ total: 0, cost: 0 }).session).toBeNull();
    expect(double({ total: 0, cost: 0.01 }).session).not.toBeNull();
  });

  it("does not add reasoning or cacheWrite1h again and keeps the last provider error class", () => {
    let listener: ((event: unknown) => void) | undefined;
    const session = { subscribe: (fn: (event: unknown) => void) => { listener = fn; return () => { listener = undefined; }; } } as unknown as AgentSession;
    const collector = new UsageCollector();
    const detach = collector.attach(session);
    const usage = { input: 4, output: 6, cacheRead: 1, cacheWrite: 2, reasoning: 5, cacheWrite1h: 2, totalTokens: 13, cost: { total: 0.5 } };
    listener!({ type: "message_end", message: { role: "assistant", usage, stopReason: "stop" } });
    listener!({ type: "message_end", message: { role: "toolResult", usage } });
    listener!({ type: "message_end", message: { role: "assistant", usage, stopReason: "error", errorMessage: "429 rate limit" } });
    detach();
    expect(listener).toBeUndefined();
    expect(collector.finish(undefined)).toEqual({
      session: null,
      assistant: { messages: 2, input: 8, output: 12, cacheRead: 2, cacheWrite: 4, costUsd: 1 },
      providerError: "rate_limit",
    });
  });

  it("calls onSession once per created session on both creation paths", async () => {
    const config = await loadConfig(configs.plain);
    const seen: AgentSession[] = [];
    const registry = new SessionRegistry(createCapturingAdapter((session) => seen.push(session), scripted([])), config.workspaces);
    const started = await registry.start("clone", toResolvedExecutionProfile(config.executionProfiles.get("review")!));
    expect(seen).toHaveLength(1);
    expect(typeof seen[0]!.getSessionStats).toBe("function");
    await registry.close(started.id);

    const silence = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const fixture = await loadConfig(configs.fixture);
      const extensionSeen: AgentSession[] = [];
      const extensionRegistry = new SessionRegistry(createCapturingAdapter((session) => extensionSeen.push(session), fixtureAdapter()), fixture.workspaces);
      const extensionStarted = await extensionRegistry.start("clone", toResolvedExecutionProfile(fixture.executionProfiles.get("review")!));
      expect(extensionSeen).toHaveLength(1);
      await extensionRegistry.close(extensionStarted.id);
    } finally { silence.mockRestore(); }
  });
});

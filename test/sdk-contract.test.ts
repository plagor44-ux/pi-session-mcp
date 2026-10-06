/**
 * Pi SDK contract assumptions, one assertion per assumption Pi Session MCP relies on.
 *
 * Runs the installed Pi SDK for real (`createAgentSession`, the isolated resource loader,
 * the agent loop) with only the model runtime scripted, so it stays provider-free. When an
 * SDK upgrade breaks one of these assumptions, the failing test names the assumption
 * instead of surfacing as an unrelated end-to-end failure. The Pi SDK canary runs this file.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as waitFor } from "node:timers/promises";
import { afterEach, describe, it } from "vitest";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PermissionProfile, ResolvedExecutionProfile } from "../src/execution-profile.js";
import { admitsTurn, PROFILE_TOOLS, SdkPiSessionAdapter, type SdkStopReason } from "../src/sdk-pi-adapter.js";
import { RegistryError, SessionRegistry, type TurnView } from "../src/session-registry.js";
import { declaredTools, type DeclaringMessage } from "./model-context.js";

const temporaries: string[] = [];
afterEach(async () => {
  while (temporaries.length > 0) await rm(temporaries.pop()!, { recursive: true, force: true });
});

function assistantMessage(text: string, stopReason: SdkStopReason): unknown {
  return {
    role: "assistant", content: [{ type: "text", text }], api: "scripted", provider: "scripted", model: "scripted",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 1 }, stopReason, timestamp: Date.now(),
  };
}

function streamOf(final: unknown): unknown {
  let sent = false;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<unknown>> {
          if (sent) return { value: undefined, done: true };
          sent = true;
          return { value: { type: "start", partial: final }, done: false };
        },
      };
    },
    async result(): Promise<unknown> { return final; },
  };
}

/** Scripted runtime whose credentials can disappear after session start. */
function scriptedRuntime(stopReason: SdkStopReason = "stop"): { runtime: ModelRuntime; toolsSeen: string[][]; auth: { available: boolean } } {
  const toolsSeen: string[][] = [];
  const auth = { available: true };
  const model = { provider: "scripted", id: "scripted", input: ["text"] };
  const runtime = {
    getProvider: () => ({ id: "scripted" }),
    getModel: () => model,
    hasConfiguredAuth: () => auth.available,
    checkAuth: async () => (auth.available ? true : undefined),
    getAuth: async () => (auth.available ? { token: "synthetic" } : undefined),
    isUsingOAuth: () => false,
    getAvailable: async () => [model],
    getAvailableSnapshot: () => [model],
    streamSimple: async (_model: unknown, context: { messages?: DeclaringMessage[] }) => {
      toolsSeen.push(declaredTools(context.messages));
      return streamOf(assistantMessage("done", stopReason));
    },
  } as unknown as ModelRuntime;
  return { runtime, toolsSeen, auth };
}

function executionProfile(permissionProfile: PermissionProfile): ResolvedExecutionProfile {
  return { alias: "contract", permissionProfile, provider: "scripted", model: "scripted", thinkingLevel: "off" };
}

async function registryWith(runtime: ModelRuntime): Promise<SessionRegistry> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-session-mcp-sdk-contract-"));
  temporaries.push(cwd);
  return new SessionRegistry(new SdkPiSessionAdapter({ modelRuntimeFactory: async () => runtime }), new Map([["repo", cwd]]));
}

async function terminal(registry: SessionRegistry, sessionId: string, turnId: string): Promise<TurnView> {
  let turn = registry.getTurn(sessionId, turnId);
  const deadline = Date.now() + 20_000;
  while (turn.state === "running" && Date.now() < deadline) {
    await waitFor(5);
    turn = registry.getTurn(sessionId, turnId);
  }
  return turn;
}

describe("Pi SDK contract assumptions", () => {
  it("admits a public turn only for a started prompt disposition", () => {
    assert.equal(admitsTurn("started"), true);
    assert.equal(admitsTurn("queued"), false, "queued input belongs to a turn that is already running");
    assert.equal(admitsTurn("handled"), false, "handled input never reaches the model");
  });

  for (const permissionProfile of ["read-only", "coding"] as const) {
    it(`declares exactly the ${permissionProfile} profile tools to the model`, async () => {
      const { runtime, toolsSeen } = scriptedRuntime();
      const registry = await registryWith(runtime);
      const session = await registry.start("repo", executionProfile(permissionProfile));
      try {
        const accepted = await registry.prompt(session.id, "list the tools");
        const done = await terminal(registry, session.id, accepted.turn.turnId);
        assert.equal(done.state, "completed");
        assert.deepEqual(toolsSeen[0], [...PROFILE_TOOLS[permissionProfile]].sort(),
          "the transcript's system messages declare exactly the profile's built-in tools");
      } finally {
        await registry.close(session.id);
      }
    }, 30_000);
  }

  it("projects a prompt the SDK rejects before dispatch as prompt_rejected without a turn", async () => {
    const { runtime, toolsSeen, auth } = scriptedRuntime();
    const registry = await registryWith(runtime);
    const session = await registry.start("repo", executionProfile("read-only"));
    try {
      // The SDK validates credentials inside prompt() and throws before any preflight signal.
      auth.available = false;
      await assert.rejects(() => registry.prompt(session.id, "rejected"),
        (error: unknown) => error instanceof RegistryError && error.code === "prompt_rejected");
      assert.equal(registry.get(session.id).state, "idle", "a rejected prompt leaves the session idle");
      assert.equal(toolsSeen.length, 0, "a rejected prompt never reaches the model");

      // The same session accepts the next prompt once credentials are back.
      auth.available = true;
      const accepted = await registry.prompt(session.id, "accepted");
      assert.equal((await terminal(registry, session.id, accepted.turn.turnId)).state, "completed");
      assert.equal(toolsSeen.length, 1);
    } finally {
      await registry.close(session.id);
    }
  }, 30_000);

  it("ends the run on a deferred final message and projects it as turn_failed", async () => {
    const { runtime, toolsSeen } = scriptedRuntime("deferred");
    const registry = await registryWith(runtime);
    const session = await registry.start("repo", executionProfile("read-only"));
    try {
      const accepted = await registry.prompt(session.id, "deferred");
      const done = await terminal(registry, session.id, accepted.turn.turnId);
      assert.equal(done.state, "failed", "a response the provider has not delivered is not a finished answer");
      assert.equal(done.error?.code, "turn_failed");
      assert.equal(done.assistantText, undefined);
      assert.equal(toolsSeen.length, 1, "the SDK does not re-request a deferred response on its own");
    } finally {
      await registry.close(session.id);
    }
  }, 30_000);
});

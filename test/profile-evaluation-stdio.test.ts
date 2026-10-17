import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, describe, it } from "vitest";
import { EvaluationTransport, selection, turnSchema } from "../eval/profiles/transport.js";
import { receiptFromTurn } from "../eval/profiles/runner.js";
import { compileServerEntry } from "./compiled-entry.js";
import { removeTemporaryRoots } from "./temporary-roots.js";

const roots: string[] = [];
const providers: Server[] = [];
afterEach(async () => {
  for (const server of providers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});
afterAll(removeTemporaryRoots);

describe("evaluation transport real stdio integration", () => {
  it.skipIf(process.platform !== "linux")("runs a local scripted OpenAI-compatible response through the compiled MCP server", async () => {
    let requestCount = 0;
    let requestedModel: unknown;
    const provider = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: unknown };
      requestCount++;
      requestedModel = body.model;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const base = { id: "chatcmpl-synthetic", object: "chat.completion.chunk", created: 1, model: "fixture-model" };
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: '{"receipt":"synthetic-ok"}' }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
    providers.push(provider);
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    const baseUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;

    const root = await mkdtemp(join(tmpdir(), "pi-profile-eval-stdio-"));
    roots.push(root);
    const agentDir = join(root, "agent"), workspace = join(root, "workspace");
    await mkdir(agentDir); await mkdir(workspace);
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {
      fixture: { baseUrl, api: "openai-completions", apiKey: "synthetic-placeholder", models: [{ id: "fixture-model" }] },
    } }));
    const config = join(root, "config.json");
    await writeFile(config, JSON.stringify({ workspaces: { fixture: workspace }, executionProfiles: {
      safe: { default: true, permissionProfile: "read-only", provider: "fixture", model: "fixture-model", thinkingLevel: "off" },
    } }));

    const previousHome = process.env.HOME, previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = root;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const transport = new EvaluationTransport("fixture");
    let sessionId: string | undefined;
    let closed = false;
    try {
      const entry = await compileServerEntry();
      await transport.connect(entry, config, 10_000);
      const capabilities = await transport.call("pi_capabilities_get", {});
      assert.ok(Array.isArray(capabilities.executionProfiles));
      const started = await transport.call("pi_session_start", { workspace: "fixture", executionProfile: "safe" });
      const selected = selection(started.session);
      sessionId = selected.id;
      assert.deepEqual({ provider: selected.provider, model: selected.model, thinkingLevel: selected.thinkingLevel }, {
        provider: "fixture", model: "fixture-model", thinkingLevel: "off",
      });

      const accepted = await transport.call("pi_session_prompt", { sessionId, prompt: "Return the required synthetic JSON receipt." });
      let turn = turnSchema.parse(accepted.turn);
      const deadline = Date.now() + 10_000;
      while (turn.state === "running" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const polled = await transport.call("pi_turn_get", { sessionId, turnId: turn.turnId }, 2_000);
        turn = turnSchema.parse(polled.turn);
      }
      assert.equal(turn.state, "completed");
      assert.deepEqual(receiptFromTurn(turn), { receipt: "synthetic-ok" });
      assert.equal(requestCount, 1);
      assert.equal(requestedModel, "fixture-model");

      await transport.call("pi_session_close", { sessionId }); sessionId = undefined;
      assert.deepEqual(await transport.call("pi_session_list", {}), { ok: true, sessions: [] });
      closed = await transport.close();
      assert.equal(closed, true, "transport cleanup observes the server process tree exit");
    } finally {
      if (sessionId) {
        await transport.call("pi_session_abort", { sessionId }, 1_000).catch(() => undefined);
        await transport.call("pi_session_close", { sessionId }, 1_000).catch(() => undefined);
      }
      if (!closed) await transport.close().catch(() => false);
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }, 45_000);
});

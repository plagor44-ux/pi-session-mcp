import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ChildStdioTransport } from "../src/child-stdio-transport.js";
import { errorSchema, promptSuccessSchema, successSchema, turnSuccessSchema } from "../src/tool-schemas.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";
beforeAll(() => { execFileSync("npm", ["run", "build"], { stdio: "pipe" }); }, 30_000);
afterAll(removeTemporaryRoots);
it.each([false, true])("real stdio exposes fake-adapter expiry, abort failure=%s", async abortFailure => {
  const dir = await temporaryRoot("deadline-stdio-"); const scenario = join(dir, "scenario.json"); await writeFile(scenario, JSON.stringify({ abortFailure }));
  const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
  await client.connect(new ChildStdioTransport(process.execPath, {}, [resolve("test/fixtures/turn-deadline-server.mjs"), scenario]));
  const tools = (await client.listTools()).tools;
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args }, { toolDefinition: tools.find(tool => tool.name === name)! })).structuredContent;
  try {
    const { session } = successSchema.parse(await call("pi_session_start", { workspace: "repo" }));
    const { turn } = promptSuccessSchema.parse(await call("pi_session_prompt", { sessionId: session.id, prompt: "fixture" }));
    await vi.waitFor(async () => {
      expect(turnSuccessSchema.parse(await call("pi_turn_get", { sessionId: session.id, turnId: turn.turnId })).turn).toMatchObject(abortFailure ? { state: "completed" } : { state: "aborted", abortReason: "deadline" });
    });
    const next = await call("pi_session_prompt", { sessionId: session.id, prompt: "next" });
    if (abortFailure) expect(errorSchema.parse(next).error.code).toBe("turn_deadline_uncertain");
    else expect(promptSuccessSchema.parse(next).turn.state).toBe("running");
    await call("pi_session_close", { sessionId: session.id });
  } finally { await client.close(); }
});

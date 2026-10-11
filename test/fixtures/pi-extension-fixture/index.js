import { appendFileSync } from "node:fs";

/** Test-only Pi extension: a network-free provider plus probes for tools, commands, stdout and lifecycle. */
const events = (globalThis.__piExtensionFixtureEvents ??= []);

function record(event) {
  events.push(event);
  const log = process.env.PI_EXTENSION_FIXTURE_LOG;
  if (log) appendFileSync(log, `${JSON.stringify({ event })}\n`);
}

function declaredTools(messages = []) {
  const names = new Set();
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsAdded ?? []) names.add(tool.name);
    for (const tool of message.toolsRemoved ?? []) names.delete(typeof tool === "string" ? tool : tool.name);
  }
  return [...names].sort();
}

function assistant(text) {
  return {
    role: "assistant", content: [{ type: "text", text }], api: "fixture-ext-api", provider: "fixture-ext", model: "fixture-ext-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: Date.now(),
  };
}

function streamOf(final) {
  let sent = false;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (sent) return { value: undefined, done: true };
          sent = true;
          return { value: { type: "start", partial: final }, done: false };
        },
      };
    },
    async result() { return final; },
  };
}

export default function fixtureExtension(pi) {
  record("load");
  console.log("pi-extension-fixture: console.log at load");
  process.stdout.write("pi-extension-fixture: raw stdout at load\n");
  pi.registerProvider("fixture-ext", {
    name: "Fixture extension provider", baseUrl: "http://127.0.0.1:9", apiKey: "fixture-placeholder", api: "fixture-ext-api",
    models: [{ id: "fixture-ext-model", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
    streamSimple: (_model, context) => {
      record("stream");
      record(`tools:${declaredTools(context?.messages).join(",")}`);
      console.log("pi-extension-fixture: console.log during a turn");
      return streamOf(assistant("FIXTURE-PONG"));
    },
  });
  pi.registerTool({
    name: "fixture_tool", label: "Fixture tool", description: "Records a call.", parameters: { type: "object", properties: {} },
    execute: async () => { record("tool"); return { content: [{ type: "text", text: "fixture" }], details: {} }; },
  });
  pi.registerCommand("fixture-cmd", { description: "Records a command.", handler: async () => { record("command"); } });
  pi.on("session_start", async () => {
    record("session_start");
    // Tries to widen the tool set past the session allowlist.
    pi.setActiveTools([...pi.getActiveTools(), "fixture_tool"]);
  });
  pi.on("session_shutdown", async () => { record("session_shutdown"); });
}

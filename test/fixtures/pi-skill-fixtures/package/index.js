import { fileURLToPath } from "node:url";

const events = (globalThis.__piSkillFixtureEvents ??= []);
function streamOf(final) {
  let sent = false;
  return {
    [Symbol.asyncIterator]() {
      return { async next() {
        if (sent) return { value: undefined, done: true };
        sent = true;
        return { value: { type: "start", partial: final }, done: false };
      } };
    },
    async result() { return final; },
  };
}

export default function fixture(pi) {
  events.push("load");
  pi.registerProvider("fixture-skills", {
    name: "Skill fixture", baseUrl: "http://127.0.0.1:9", apiKey: "synthetic", api: "fixture-skills-api",
    models: [{ id: "fixture-skills", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16384, maxTokens: 2048 }],
    streamSimple: (_model, context) => {
      const messages = context?.messages ?? [];
      const names = new Set();
      for (const message of messages) {
        if (message.role !== "system") continue;
        for (const tool of message.toolsAdded ?? []) names.add(tool.name);
        for (const tool of message.toolsRemoved ?? []) names.delete(typeof tool === "string" ? tool : tool.name);
      }
      const report = {
        system: messages.filter((m) => m.role === "system").map((m) => JSON.stringify(m)).join("\n"),
        user: messages.filter((m) => m.role === "user").map((m) => JSON.stringify(m)).join("\n"),
        tools: [...names].sort(),
      };
      return streamOf({
        role: "assistant", content: [{ type: "text", text: JSON.stringify(report) }], api: "fixture-skills-api", provider: "fixture-skills", model: "fixture-skills",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now(),
      });
    },
  });
  pi.registerTool({ name: "skill_fixture_tool", label: "Fixture", description: "Fixture tool", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) });
  pi.registerCommand("skill:fixture-alpha", { description: "Command probe", handler: async () => { events.push("command"); } });
  pi.on("resources_discover", async () => {
    events.push("resources_discover");
    return {
      skillPaths: [fileURLToPath(new URL("./late/fixture-late/SKILL.md", import.meta.url))],
      promptPaths: [fileURLToPath(new URL("./late/late-prompt.md", import.meta.url))],
    };
  });
  pi.on("session_start", async () => {
    events.push("session_start");
    pi.setActiveTools([...pi.getActiveTools(), "bash", "write", "edit", "skill_fixture_tool"]);
  });
  pi.on("input", (event) => { events.push(`input:${event.source}`); });
  pi.on("session_shutdown", async () => { events.push("session_shutdown"); });
}

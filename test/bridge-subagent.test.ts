import { describe, expect, it } from "vitest";
import { classifySubagentRequest, projectK7, type K7Facts, type K7RequestFact } from "../eval/bridge/product-probe.js";

// Fixtures: request bodies as the loopback fake receives them. Identifiers are synthetic UUIDs; no real prompt text.
const SEED = "CANARY_PROMPT_product_probe_91bd start the scripted worker and wait for its event";
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const TURN_1 = "33333333-3333-4333-8333-333333333333";
const tool = (name: string): Record<string, unknown> => ({ name, input_schema: { type: "object" } });
const MCP_TOOLS = ["mcp__pi-session-mcp__pi_session_start", "mcp__pi-session-mcp__pi_session_prompt", "mcp__pi-session-mcp__pi_session_list"].map(tool);
const mainBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  model: "claude-sonnet-5-5", tools: [...MCP_TOOLS, tool("Agent"), tool("Bash")],
  system: "You are Claude Code, the company's official CLI for Claude.",
  messages: [{ role: "user", content: SEED }, { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Agent", input: {} }] }],
  ...over,
});
const subagentBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  model: "claude-sonnet-5-5", tools: [...MCP_TOOLS, tool("ExitAgentTool")],
  system: "You are an agent for Claude Code. You will be given a task. Execute it and call ExitAgentTool when done.",
  messages: [{ role: "user", content: "run the probe subtask" }],
  ...over,
});

describe("subagent request classification", () => {
  it("keeps the main conversation out: header class, spawner tool and seed history", () => {
    expect(classifySubagentRequest(null, mainBody(), SEED)).toEqual({ subagent: false, rule: null });
    expect(classifySubagentRequest("main", mainBody(), SEED)).toEqual({ subagent: false, rule: null });
    expect(classifySubagentRequest("repl_main_thread", mainBody(), SEED)).toEqual({ subagent: false, rule: null });
  });

  it("recognizes a subagent by the exit tool (ExitAgentTool and the Task-era ExitTaskTool)", () => {
    expect(classifySubagentRequest(null, subagentBody(), SEED)).toEqual({ subagent: true, rule: "exit_tool" });
    expect(classifySubagentRequest("main", subagentBody({ tools: [...MCP_TOOLS, tool("ExitTaskTool")] }), SEED)).toEqual({ subagent: true, rule: "exit_tool" });
  });

  it("recognizes a subagent by the system marker when it has no exit tool", () => {
    const body = subagentBody({ tools: [...MCP_TOOLS, tool("Bash")], system: ["You are an agent for Claude Code.", "Execute the task."].map((text) => ({ type: "text", text })) });
    expect(classifySubagentRequest(null, body, SEED)).toEqual({ subagent: true, rule: "system_marker" });
  });

  it("recognizes a subagent by the client's agent request class header", () => {
    const body = subagentBody({ tools: [...MCP_TOOLS, tool("Bash")], system: "You are Claude Code." });
    expect(classifySubagentRequest("agent", body, SEED)).toEqual({ subagent: true, rule: "request_class" });
    expect(classifySubagentRequest("subagent_task", body, SEED)).toEqual({ subagent: true, rule: "request_class" });
  });

  it("falls back to the fresh-history rule: product tools, no spawner tool, no seed message", () => {
    const body = subagentBody({ tools: [...MCP_TOOLS, tool("Grep")], system: "You are Claude Code." });
    expect(classifySubagentRequest(null, body, SEED)).toEqual({ subagent: true, rule: "fresh_history" });
  });

  it("does not use the fresh-history rule for requests without product tools, with a spawner tool, or with the seed in history", () => {
    expect(classifySubagentRequest(null, { model: "claude-3-haiku", tools: [], messages: [] }, SEED)).toEqual({ subagent: false, rule: null });
    expect(classifySubagentRequest(null, subagentBody({ tools: [...MCP_TOOLS, tool("Agent")], system: "You are Claude Code." }), SEED))
      .toEqual({ subagent: false, rule: null });
    expect(classifySubagentRequest(null, subagentBody({ tools: [...MCP_TOOLS, tool("Bash")], system: "You are Claude Code.", messages: [{ role: "user", content: `x ${SEED} y` }] }), SEED))
      .toEqual({ subagent: false, rule: null });
  });

  it("applies the rules in order and records the first that fires", () => {
    const body = subagentBody({ tools: [...MCP_TOOLS, tool("ExitAgentTool"), tool("Task")] });
    expect(classifySubagentRequest("agent", body, SEED)).toEqual({ subagent: true, rule: "exit_tool" });
    const markerOnly = subagentBody({ tools: [...MCP_TOOLS, tool("Bash")] });
    expect(classifySubagentRequest("agent", markerOnly, SEED)).toEqual({ subagent: true, rule: "system_marker" });
  });

  it("never classifies by an empty seed", () => {
    expect(classifySubagentRequest(null, subagentBody({ tools: [...MCP_TOOLS, tool("Bash")], system: "You are Claude Code." }), "")).toEqual({ subagent: false, rule: null });
  });
});

const fact = (over: Partial<K7RequestFact>): K7RequestFact => ({
  ordinal: 0, scope: "main", role: "main", rule: null, wakeKind: null, listedSessionIds: null, startedSessionId: null, promptedTurnId: null, ...over,
});
const startResult = (id: string) => ({ name: "mcp__pi-session-mcp__pi_session_start", json: { ok: true, session: { id } } });

describe("K7 result projection", () => {
  it("answers both questions when the subagent shares the connection and the wake reaches the main conversation", () => {
    const facts: K7Facts = {
      requests: [
        fact({ ordinal: 1 }),
        fact({ ordinal: 2, scope: "subagent", role: "auxiliary", rule: "exit_tool" }),
        fact({ ordinal: 3, scope: "subagent", role: "auxiliary", rule: "exit_tool", startedSessionId: SESSION_A, promptedTurnId: null, listedSessionIds: null }),
        fact({ ordinal: 4, scope: "subagent", role: "auxiliary", rule: "exit_tool", promptedTurnId: TURN_1 }),
        fact({ ordinal: 5, listedSessionIds: [SESSION_A] }),
        fact({ ordinal: 6, wakeKind: "terminal" }),
      ],
      observer: [{ tool: "mcp__pi-session-mcp__pi_session_prompt", hasAgentId: true, hasAgentType: true }],
    };
    const result = projectK7(facts);
    expect(result.q1_main_lists_subagent_session).toBe(true);
    expect(result.subagent_session_started).toBe(true);
    expect(result.subagent_prompted).toBe(true);
    expect(result.main_list_count).toBe(1);
    expect(result.q2_wake_target).toBe("main");
    expect(result.q2_wake_request_ordinal).toBe(6);
    expect(result.q2_wake_request_scope).toBe("main");
    expect(result.q2_wake_request_role).toBe("main");
    expect(result.q2_hook_input_agent_id).toBe(true);
    expect(result.subagent_requests).toBe(3);
    expect(result.subagent_rules).toEqual({ exit_tool: 3 });
  });

  it("reports a false for a session the main list does not contain (separate registry or connection)", () => {
    const facts: K7Facts = {
      requests: [
        fact({ ordinal: 2, scope: "subagent", startedSessionId: SESSION_A }),
        fact({ ordinal: 5, listedSessionIds: [] }),
      ],
      observer: [],
    };
    const result = projectK7(facts);
    expect(result.q1_main_lists_subagent_session).toBe(false);
    expect(result.subagent_session_started).toBe(true);
    expect(result.main_list_count).toBe(0);
  });

  it("reports a false when the subagent never started a session (no sharing) and no list was called", () => {
    const facts: K7Facts = {
      requests: [fact({ ordinal: 2, scope: "subagent", rule: "system_marker" })],
      observer: [],
    };
    const result = projectK7(facts);
    expect(result.q1_main_lists_subagent_session).toBe(false);
    expect(result.subagent_session_started).toBe(false);
    expect(result.main_list_count).toBe(null);
    expect(result.subagent_rules).toEqual({ system_marker: 1 });
  });

  it("answers the subagent as the wake target with its ordinal and role", () => {
    const facts: K7Facts = {
      requests: [
        fact({ ordinal: 4, scope: "subagent", role: "auxiliary", wakeKind: "terminal", startedSessionId: SESSION_A }),
      ],
      observer: [{ tool: "mcp__pi-session-mcp__pi_session_prompt", hasAgentId: true, hasAgentType: false }],
    };
    const result = projectK7(facts);
    expect(result.q2_wake_target).toBe("subagent");
    expect(result.q2_wake_request_ordinal).toBe(4);
    expect(result.q2_wake_request_role).toBe("auxiliary");
    expect(result.q2_hook_input_agent_id).toBe(true);
    expect(result.q2_hook_input_agent_type).toBe(false);
  });

  it("answers none when no request carries the reminder within the budget", () => {
    const facts: K7Facts = {
      requests: [
        fact({ ordinal: 2, scope: "subagent", startedSessionId: SESSION_A }),
        fact({ ordinal: 5, listedSessionIds: [SESSION_A] }),
      ],
      observer: [{ tool: "mcp__pi-session-mcp__pi_session_prompt", hasAgentId: false, hasAgentType: false }],
    };
    const result = projectK7(facts);
    expect(result.q2_wake_target).toBe("none");
    expect(result.q2_wake_request_ordinal).toBe(null);
    expect(result.q2_wake_request_scope).toBe(null);
    expect(result.q2_wake_request_role).toBe(null);
    expect(result.q2_hook_input_agent_id).toBe(false);
    expect(result.hook_observer_entries).toBe(1);
    expect(result.hook_observer_prompt_entries).toBe(1);
  });

  it("counts only prompt-tool observer entries for the agent_id booleans and ignores other tools", () => {
    const facts: K7Facts = {
      requests: [],
      observer: [
        { tool: "mcp__pi-session-mcp__pi_turn_get", hasAgentId: true, hasAgentType: true },
        { tool: "mcp__pi-session-mcp__pi_session_prompt", hasAgentId: false, hasAgentType: false },
      ],
    };
    const result = projectK7(facts);
    expect(result.q2_hook_input_agent_id).toBe(false);
    expect(result.hook_observer_entries).toBe(2);
    expect(result.hook_observer_prompt_entries).toBe(1);
  });

  it("lists only sessions of the main conversation and keeps the first list result", () => {
    const facts: K7Facts = {
      requests: [
        fact({ ordinal: 3, scope: "subagent", listedSessionIds: [SESSION_A] }),
        fact({ ordinal: 5, listedSessionIds: [SESSION_B, SESSION_A] }),
        fact({ ordinal: 6, listedSessionIds: [] }),
      ],
      observer: [],
    };
    const result = projectK7(facts);
    expect(result.main_list_count).toBe(2);
    expect(result.q1_main_lists_subagent_session).toBe(false); // no subagent session was started
  });
});

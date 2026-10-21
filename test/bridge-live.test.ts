import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configSchema } from "../src/config.js";
import { evaluateTask } from "../eval/profiles/oracles.js";
import { copyFixture } from "../eval/profiles/files.js";
import { approvalDigest, readCredentialFile, validateApproval, REQUIRED_CONTROLLER, REQUIRED_WORKER, type ApprovalContext, type RefusalReason } from "../eval/bridge/live/approval.js";
import { nextAction } from "../eval/bridge/live/fake-api.js";
import {
  ARM_C_PARAGRAPH, buildClaudeArgs, buildControllerEnv, buildMcpConfig, buildPiConfig, buildSettings, firstJsonObject, L1_RUN_PROMPT, PRODUCT_TOOLS, shellQuote, systemPrompt, t1Prompt, TOOL_PREFIX, userPrompt, WAITER_MATCHER,
} from "../eval/bridge/live/plan.js";
import { deriveDryReceipt, dirtyLines, recordedRuns, runLive, RefusedError } from "../eval/bridge/live/runner.js";
import { parseLiveServerConfig } from "../eval/bridge/live/server-config.js";
import { assertOutputClean, assertTopLevelAllowlist, decideEnd, eventToNextAssistantMs, parseCounters, StreamTracker, summarizeStream, sumUsage, uncachedInput, type ServerCounters } from "../eval/bridge/live/stream.js";
import { parseRequest } from "../eval/bridge/claude-probe.js";

const HEAD = "a".repeat(40);
const goodApproval = (): Record<string, unknown> => ({
  approved: true, case: "L1", arms: ["A", "C"], max_controller_runs: 2, source_commit: HEAD,
  controller: { ...REQUIRED_CONTROLLER }, worker: { ...REQUIRED_WORKER, skills: [] }, budget_usd_advisory: 3,
});
const ctx = (over: Partial<ApprovalContext> = {}): ApprovalContext => ({ arm: "A", headCommit: HEAD, worktreeClean: true, runsRecorded: 0, ...over });

describe("approval binding", () => {
  it("accepts the exact approval", () => {
    expect(validateApproval(goodApproval(), ctx())).toEqual({ ok: true });
    expect(validateApproval(goodApproval(), ctx({ arm: "C", runsRecorded: 1 }))).toEqual({ ok: true });
  });
  const refusals: Array<[RefusalReason, (a: Record<string, any>) => unknown, Partial<ApprovalContext>?]> = [
    ["approval_not_object", () => "approved"],
    ["approval_not_object", () => [1]],
    ["not_approved", (a) => ({ ...a, approved: "true" })],
    ["not_approved", (a) => { delete a.approved; return a; }],
    ["wrong_case", (a) => ({ ...a, case: "L2" })],
    ["arm_not_approved", (a) => ({ ...a, arms: ["C"] })],
    ["arm_not_approved", (a) => ({ ...a, arms: "A" })],
    ["max_runs_invalid", (a) => ({ ...a, max_controller_runs: 0 })],
    ["max_runs_invalid", (a) => ({ ...a, max_controller_runs: 1.5 })],
    ["max_runs_invalid", (a) => ({ ...a, max_controller_runs: "2" })],
    ["runs_exhausted", (a) => a, { runsRecorded: 2 }],
    ["runs_exhausted", (a) => ({ ...a, max_controller_runs: 1 }), { runsRecorded: 1 }],
    ["source_commit_mismatch", (a) => ({ ...a, source_commit: "b".repeat(40) })],
    ["source_commit_mismatch", (a) => { delete a.source_commit; return a; }],
    ["worktree_dirty", (a) => a, { worktreeClean: false }],
    ["controller_mismatch", (a) => ({ ...a, controller: { ...a.controller, client_version: "2.1.304 (Claude Code)" } })],
    ["controller_mismatch", (a) => ({ ...a, controller: { ...a.controller, model: "claude-opus-5-5" } })],
    ["controller_mismatch", (a) => ({ ...a, controller: { ...a.controller, auth: "subscription" } })],
    ["controller_mismatch", (a) => ({ ...a, controller: undefined })],
    ["worker_mismatch", (a) => ({ ...a, worker: { ...a.worker, profile_alias: "review" } })],
    ["worker_mismatch", (a) => ({ ...a, worker: { ...a.worker, provider: "openai-codex" } })],
    ["worker_mismatch", (a) => ({ ...a, worker: { ...a.worker, model: "gpt-6.1-sol" } })],
    ["worker_mismatch", (a) => ({ ...a, worker: { ...a.worker, thinkingLevel: "high" } })],
    ["worker_mismatch", (a) => ({ ...a, worker: { ...a.worker, skills: ["pi-session-review"] } })],
    ["worker_mismatch", (a) => ({ ...a, worker: { ...a.worker, skills: undefined } })],
    ["budget_invalid", (a) => { delete a.budget_usd_advisory; return a; }],
    ["budget_invalid", (a) => ({ ...a, budget_usd_advisory: "3" })],
    ["budget_invalid", (a) => ({ ...a, budget_usd_advisory: Number.NaN })],
  ];
  it.each(refusals)("refuses with %s", (reason, mutate, over) => {
    expect(validateApproval(mutate(goodApproval()), ctx(over))).toEqual({ ok: false, reason });
  });
  it("digests bytes deterministically", () => {
    expect(approvalDigest("x")).toBe(approvalDigest(Buffer.from("x")));
    expect(approvalDigest("x")).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("credential file checks", () => {
  let dir: string;
  const SECRET = "sk-test-secret-value-do-not-print";
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "bridge-live-cred-")); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
  const file = async (name: string, content: string, mode: number): Promise<string> => { const p = join(dir, name); await writeFile(p, content); await chmod(p, mode); return p; };

  it("reads a private regular file and trims it", async () => {
    expect(await readCredentialFile(await file("ok", `  ${SECRET}\n`, 0o600))).toEqual({ ok: true, value: SECRET });
    expect(await readCredentialFile(await file("ro", SECRET, 0o400))).toEqual({ ok: true, value: SECRET });
  });
  it.each([0o640, 0o604, 0o644, 0o660, 0o606, 0o666])("refuses mode %o as too open without exposing content", async (mode) => {
    const outcome = await readCredentialFile(await file(`open-${mode.toString(8)}`, SECRET, mode));
    expect(outcome).toEqual({ ok: false, reason: "too_open" });
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });
  it("refuses empty and whitespace-only files", async () => {
    expect(await readCredentialFile(await file("empty", "", 0o600))).toEqual({ ok: false, reason: "empty" });
    expect(await readCredentialFile(await file("blank", " \n\t\n", 0o600))).toEqual({ ok: false, reason: "empty" });
  });
  it("refuses unset, empty-named, missing and non-regular paths", async () => {
    expect(await readCredentialFile(undefined)).toEqual({ ok: false, reason: "unset" });
    expect(await readCredentialFile("")).toEqual({ ok: false, reason: "unset" });
    expect(await readCredentialFile(join(dir, "does-not-exist"))).toEqual({ ok: false, reason: "missing" });
    const sub = join(dir, "a-directory"); await mkdir(sub, { mode: 0o700 });
    expect(await readCredentialFile(sub)).toEqual({ ok: false, reason: "not_regular" });
  });
  it("judges the target of a link, not the link", async () => {
    const target = await file("link-target", SECRET, 0o644);
    const link = join(dir, "link"); await symlink(target, link);
    expect(await readCredentialFile(link)).toEqual({ ok: false, reason: "too_open" });
  });
});

const counters = (over: Partial<ServerCounters> = {}): ServerCounters => ({ tools: {}, pi_turn_get: { running: 0, terminal: 0, error: 0 }, open_sessions: 0, closes: 0, spool_failures: 0, ...over });

describe("end detection", () => {
  it("ends in both arms once every session is closed and a close was seen", () => {
    for (const arm of ["A", "C"] as const) expect(decideEnd(arm, counters({ open_sessions: 0, closes: 1 }))).toEqual({ end: true, reason: "all_sessions_closed" });
  });
  it("keeps going while sessions are open (arm C idle point)", () => {
    expect(decideEnd("C", counters({ open_sessions: 1, closes: 0 }))).toEqual({ end: false });
    expect(decideEnd("C", counters({ open_sessions: 2, closes: 1 }))).toEqual({ end: false });
  });
  it("does not end before any session was opened and closed", () => {
    expect(decideEnd("A", counters({ open_sessions: 0, closes: 0 }))).toEqual({ end: true, reason: "no_open_session" });
  });
  it("ends when the server never wrote counters, e.g. after an API error on the first request", () => { expect(decideEnd("A", null)).toEqual({ end: true, reason: "no_open_session" }); });
  it("reads counters defensively", () => {
    expect(parseCounters("not json")).toBeNull();
    expect(parseCounters("{}")).toBeNull();
    const parsed = parseCounters(JSON.stringify({ tools: { pi_turn_get: 3, "bad name": 1 }, pi_turn_get: { running: 2, terminal: 1, error: 0 }, open_sessions: 0, closes: 1, spool_failures: 0 }));
    expect(parsed).toEqual({ tools: { pi_turn_get: 3 }, pi_turn_get: { running: 2, terminal: 1, error: 0 }, open_sessions: 0, closes: 1, spool_failures: 0 });
  });
  it("drives the decision from synthetic stream events", () => {
    const tracker = new StreamTracker(() => 0);
    const log: boolean[] = [];
    const feed = (event: unknown, state: ServerCounters | null): void => { if (tracker.ingest(event)) log.push(decideEnd("C", state).end); };
    feed({ type: "result", subtype: "success", num_turns: 3 }, counters({ open_sessions: 1 })); // arm C idle point
    feed({ type: "result", subtype: "success", num_turns: 3 }, counters({ open_sessions: 0, closes: 1 }));
    expect(log).toEqual([false, true]);
  });
});

describe("stream measures", () => {
  const usage = (i: number, r: number, c: number, o: number) => ({ input_tokens: i, cache_read_input_tokens: r, cache_creation_input_tokens: c, output_tokens: o });
  it("sums usage over every result event and counts distinct assistant ids as requests", () => {
    let now = 0;
    const tracker = new StreamTracker(() => now);
    tracker.ingest({ type: "assistant", message: { id: "msg_1", content: [{ type: "text", text: "SECRET-TEXT" }] } }); now = 10;
    tracker.ingest({ type: "assistant", message: { id: "msg_1", content: [{ type: "tool_use", name: "Bash", input: { command: "sleep 1" } }] } }); now = 20;
    tracker.ingest({ type: "assistant", message: { id: "msg_2", content: [{ type: "tool_use", name: "mcp__pi-session-mcp__pi_turn_get", input: {} }] } }); now = 30;
    tracker.ingest({ type: "result", subtype: "success", is_error: false, num_turns: 2, duration_ms: 100, total_cost_usd: 0.25, usage: usage(10, 4, 2, 5) }); now = 40;
    tracker.ingest({ type: "assistant", message: { id: "msg_3", content: [] } }); now = 50;
    tracker.ingest({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_ms: 50, usage: usage(7, 1, 0, 3) });
    expect(tracker.modelRequests).toBe(3);
    expect(tracker.toolUses).toEqual({ Bash: 1, "mcp__pi-session-mcp__pi_turn_get": 1 });
    expect(sumUsage(tracker.results)).toEqual(usage(17, 5, 2, 8));
    expect(uncachedInput(sumUsage(tracker.results))).toBe(10);
    const summary = summarizeStream(tracker) as any;
    expect(summary.sums.num_turns).toBe(3);
    expect(summary.sums.duration_ms).toBe(150);
    expect(summary.sums.total_cost_usd_sum).toBe(0.25);
    expect(summary.sums.total_cost_usd_last).toBeNull();
    expect(tracker.results[1]!.total_cost_usd).toBeNull();
    expect(JSON.stringify(summary)).not.toContain("SECRET-TEXT");
    expect(JSON.stringify(summary)).not.toContain("sleep 1");
  });
  it("tolerates missing or malformed usage", () => {
    const tracker = new StreamTracker(() => 0);
    tracker.ingest({ type: "result", usage: { input_tokens: "x", output_tokens: -3 } });
    tracker.ingest({ type: "result" });
    expect(sumUsage(tracker.results)).toEqual(usage(0, 0, 0, 0));
    expect(summarizeStream(tracker).result_count).toBe(2);
  });
  it("counts a waiter exit 2 while idle as a wake followed by a model request", () => {
    let now = 0;
    const tracker = new StreamTracker(() => now);
    tracker.ingest({ type: "assistant", message: { id: "a1", content: [] } }); now = 5;
    tracker.ingest({ type: "result", subtype: "success" }); now = 1000;
    tracker.ingest({ type: "system", subtype: "hook_response", hook_event: "PostToolUse", outcome: "error", exit_code: 2 }); now = 1030;
    tracker.ingest({ type: "assistant", message: { id: "a2", content: [] } });
    expect(tracker.wakes).toEqual([{ exit_at_ms: 1000, request_at_ms: 1030, delay_ms: 30, delivery: "own_request" }]);
    expect(tracker.waiterExit2).toBe(1);
    expect(tracker.unansweredWakes).toBe(0);
  });
  it("separates a wake that arrives mid-turn and one that leads to no request", () => {
    let now = 0;
    const tracker = new StreamTracker(() => now);
    tracker.ingest({ type: "assistant", message: { id: "a1", content: [] } }); now = 10;
    tracker.ingest({ type: "system", subtype: "hook_response", exit_code: 2 }); now = 20;
    tracker.ingest({ type: "assistant", message: { id: "a2", content: [] } });
    expect(tracker.wakes[0]!.delivery).toBe("with_tool_result");
    tracker.ingest({ type: "result" });
    tracker.ingest({ type: "system", subtype: "hook_response", exit_code: 2 });
    expect(tracker.unansweredWakes).toBe(1);
    const summary = summarizeStream(tracker) as any;
    expect(summary.wakes).toMatchObject({ waiter_exit_2: 2, started: 0, with_tool_result: 1, unanswered: 1 });
  });
  it("records hook events as labels and numbers only", () => {
    const tracker = new StreamTracker(() => 7);
    tracker.ingest({ type: "system", subtype: "hook_response", hook_event: "PostToolUse", hook_name: "x", outcome: "success", exit_code: 0, stdout: "SECRET-OUT", stderr: "SECRET-ERR" });
    expect(tracker.hooks).toEqual([{ t_ms: 7, subtype: "hook_response", hook_event: "PostToolUse", outcome: "success", exit_code: 0 }]);
  });
  it("counts bad lines without keeping them", () => {
    const tracker = new StreamTracker(() => 0);
    expect(tracker.ingestLine("{broken")).toBe(false);
    expect(tracker.ingestLine(JSON.stringify({ type: "result" }))).toBe(true);
    expect(tracker.jsonErrors).toBe(1);
    expect(tracker.lines).toBe(2);
  });
  it("measures the delay from an event to the next assistant arrival", () => {
    expect(eventToNextAssistantMs(100, [50, 130, 400])).toBe(30);
    expect(eventToNextAssistantMs(500, [50, 130, 400])).toBeNull();
  });
});

describe("output allowlist", () => {
  it("accepts counts, labels and numbers", () => {
    expect(() => assertOutputClean({ a: 1, b: ["x", { c: "sha256:abc" }], d: null, e: "mcp__pi-session-mcp__pi_turn_get" }, ["/tmp/root"])).not.toThrow();
  });
  it("rejects the temporary root, a path, /home/, the receipt text, a credential and credential file path", () => {
    const root = "/tmp/pi-profile-eval-abc123";
    for (const bad of [`x ${root} y`, "/tmp/other/file", "/home/someone", "in /home/ dir", "see /proc/1/environ", "RECEIPT-BODY-1234", "sk-secret-value", "/secure/key.file"]) {
      expect(() => assertOutputClean({ nested: { value: bad } }, [root, "RECEIPT-BODY-1234", "sk-secret-value", "/secure/key.file"])).toThrow("output_validation_failed");
    }
    expect(() => assertOutputClean({ [root]: 1 }, [root])).toThrow("output_validation_failed");
  });
  it("ignores undefined and empty needles", () => { expect(() => assertOutputClean({ a: "plain" }, [undefined, ""])).not.toThrow(); });
  it("rejects unknown top-level keys", () => {
    expect(() => assertTopLevelAllowlist({ arm: "A", oracle: {} })).not.toThrow();
    expect(() => assertTopLevelAllowlist({ arm: "A", transcript: "x" })).toThrow("output_validation_failed");
  });
});

describe("plan builders", () => {
  const paths = { node: "/usr/bin/node", waiterJs: "/build/hook-waiter.js", spoolBase: "/r/spool", waiterLog: "/r/w.log" };
  it("uses the L1 run prompt of token-live with the explore-fast profile", async () => {
    const source = await readFile(join(import.meta.dirname, "../eval/profiles/token-live.ts"), "utf8");
    const match = /const RUN_PROMPTS = \[\s*"((?:[^"\\]|\\.)*)"/.exec(source);
    expect(match).not.toBeNull();
    const original = JSON.parse(`"${match![1]}"`) as string;
    expect(L1_RUN_PROMPT).toBe(original.replace("profile `review`", "profile `explore-fast`"));
    expect(userPrompt()).toBe(`${L1_RUN_PROMPT}\nSupplied task:\n${t1Prompt()}`);
    expect(t1Prompt()).toContain("api-data-flow");
  });
  it("adds exactly the arm C paragraph", () => {
    expect(systemPrompt("A", "SKILL")).toBe("SKILL");
    expect(systemPrompt("C", "SKILL")).toBe(`SKILL\n\n${ARM_C_PARAGRAPH}`);
    expect(ARM_C_PARAGRAPH.startsWith("Event delivery is active for this run.")).toBe(true);
    expect(ARM_C_PARAGRAPH.endsWith("If you are woken by a budget message instead, poll once.")).toBe(true);
  });
  it("arm A has no hooks; arm C has one asyncRewake PostToolUse waiter with a 900 s timeout", () => {
    expect(buildSettings("A", paths)).toEqual({});
    const settings = buildSettings("C", paths) as any;
    const entries = settings.hooks.PostToolUse;
    expect(entries).toHaveLength(1);
    expect(entries[0].matcher).toBe(WAITER_MATCHER);
    expect(WAITER_MATCHER).toBe("mcp__pi-session-mcp__pi_session_prompt|mcp__pi-session-mcp__pi_turn_get");
    const hook = entries[0].hooks[0];
    expect(hook).toMatchObject({ type: "command", timeout: 900, asyncRewake: true });
    expect(hook.command).toContain("BRIDGE_WAIT_BUDGET_MS=840000");
    expect(hook.command).toContain("BRIDGE_ON_BUDGET=wake");
    expect(hook.command).toContain("BRIDGE_SPOOL_BASE='/r/spool'");
    expect(hook.command).toContain("BRIDGE_WAITER_LOG='/r/w.log'");
    expect(hook.command).toContain("'/build/hook-waiter.js'");
  });
  it("quotes single quotes for the shell", () => { expect(shellQuote("a'b")).toBe(`'a'\\''b'`); });
  it("builds the Claude command line", () => {
    const args = buildClaudeArgs({ mcpConfig: "/m.json", settings: "/s.json", systemPrompt: "SYS" });
    expect(args.slice(0, 7)).toEqual(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-hook-events"]);
    for (const flag of ["--strict-mcp-config", "--no-session-persistence"]) expect(args).toContain(flag);
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-5-5");
    expect(args[args.indexOf("--tools") + 1]).toBe("Bash");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("SYS");
    const allowed = args[args.indexOf("--allowedTools") + 1]!.split(",");
    expect(allowed).toHaveLength(9);
    expect(allowed).toContain("Bash(sleep:*)");
    expect(PRODUCT_TOOLS).toHaveLength(8);
    for (const tool of PRODUCT_TOOLS) expect(allowed).toContain(`${TOOL_PREFIX}${tool}`);
  });
  it("scrubs the controller environment to the listed keys and the API key", () => {
    const env = buildControllerEnv("/bin", { home: "/r/home", configDir: "/r/home/claude-config", tmp: "/r/tmp", apiKey: "KEY" });
    expect(Object.keys(env).sort()).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CODE_TMPDIR", "CLAUDE_CONFIG_DIR", "DISABLE_AUTOUPDATER", "DISABLE_ERROR_REPORTING", "DISABLE_TELEMETRY", "ENABLE_TOOL_SEARCH", "HOME", "PATH", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]);
    expect(env).toMatchObject({ HOME: "/r/home", CLAUDE_CONFIG_DIR: "/r/home/claude-config", ENABLE_TOOL_SEARCH: "false", DISABLE_AUTOUPDATER: "1", ANTHROPIC_API_KEY: "KEY" });
    expect(buildControllerEnv("/bin", { home: "/h", configDir: "/h/c", tmp: "/t", apiKey: "K", baseUrl: "http://127.0.0.1:1" }).ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:1");
  });
  it("registers one server with the product name key and passes the agent dir only when given", () => {
    const live = buildMcpConfig("/n", "/s.js", { liveConfigPath: "/c.json", agentDir: "/agent" }) as any;
    expect(Object.keys(live.mcpServers)).toEqual(["pi-session-mcp"]);
    expect(live.mcpServers["pi-session-mcp"].env).toEqual({ BRIDGE_LIVE_CONFIG: "/c.json", PI_CODING_AGENT_DIR: "/agent" });
    expect((buildMcpConfig("/n", "/s.js", { liveConfigPath: "/c.json" }) as any).mcpServers["pi-session-mcp"].env).toEqual({ BRIDGE_LIVE_CONFIG: "/c.json" });
  });
  it("writes a Pi config that the product schema accepts: one read-only default, no skills or extensions", () => {
    const parsed = configSchema.parse(buildPiConfig("/w"));
    expect(Object.keys(parsed.executionProfiles)).toEqual(["explore-fast"]);
    expect(parsed.executionProfiles["explore-fast"]).toEqual({ permissionProfile: "read-only", provider: "openai", model: "gpt-6-luna", thinkingLevel: "low", default: true });
    expect(parsed.skillCatalog).toBeUndefined();
  });
  it("finds the first JSON object in prose or a fence", () => {
    expect(firstJsonObject('Here:\n```json\n{"a":{"b":"}"},"c":[1]}\n```\n{"x":1}')).toEqual({ a: { b: "}" }, c: [1] });
    expect(firstJsonObject("{broken {\"ok\":true}")).toEqual({ ok: true });
    expect(firstJsonObject("no object")).toBeUndefined();
  });
});

describe("server config and run bookkeeping", () => {
  it("parses the live server config strictly", () => {
    const base = { piConfigPath: "/p", spoolBase: "/s", counterFile: "/c", receiptDir: "/r" };
    expect(parseLiveServerConfig({ mode: "sdk", ...base })).toEqual({ mode: "sdk", ...base });
    expect(parseLiveServerConfig({ mode: "scripted", ...base, scripts: [{ prompts: [[{ sleepMs: 1 }]] }] }).scripts).toHaveLength(1);
    for (const bad of [null, [], { mode: "other", ...base }, { mode: "sdk" }, { mode: "scripted", ...base }, { mode: "sdk", ...base, scripts: [] }, { mode: "sdk", ...base, receiptDir: "" }]) {
      expect(() => parseLiveServerConfig(bad)).toThrow("config_invalid");
    }
  });
  it("ignores the ignored build and index directories when judging a clean worktree", () => {
    expect(dirtyLines("")).toEqual([]);
    expect(dirtyLines("?? .bridge-eval/\n?? .codegraph/x\n")).toEqual([]);
    expect(dirtyLines("?? eval/bridge/live/new.ts\n")).toHaveLength(1);
    expect(dirtyLines(" M src/main.ts\n?? .bridge-eval/eval\n")).toHaveLength(1);
    expect(dirtyLines("?? .bridge-evaluation.txt\n")).toHaveLength(1);
  });
  it("counts recorded runs by kind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-live-out-"));
    try {
      for (const name of ["01-L1-A.json", "02-L1-C.json", "dry-01-L1-A.json", "notes.txt", "03-L2-A.json"]) await writeFile(join(dir, name), "{}");
      expect(await recordedRuns(dir, false)).toBe(2);
      expect(await recordedRuns(dir, true)).toBe(1);
      expect(await recordedRuns(join(dir, "missing"), false)).toBe(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("dry-run oracle and scripted controller", () => {
  it("derives a receipt from the fixture that satisfies the T1 oracle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-live-fixture-"));
    try {
      const workspace = join(dir, "workspace");
      await copyFixture(join(import.meta.dirname, "../eval/fixtures/T1/public"), workspace);
      const receipt = await deriveDryReceipt(workspace);
      const verdict = await evaluateTask("T1", workspace, receipt);
      expect(verdict.status).toBe("PASS");
      expect(verdict.checks.map((c) => c.id)).toEqual(["api-data-flow", "stale-doc-contradiction"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  const requestWith = (results: Array<{ name: string; json: unknown }>, wakeText?: string) => {
    const messages: unknown[] = [{ role: "user", content: "prompt" }];
    const ids: string[] = [];
    results.forEach((r, i) => { ids.push(`t${i}`); });
    if (results.length > 0) {
      messages.push({ role: "assistant", content: results.map((r, i) => ({ type: "tool_use", id: `t${i}`, name: r.name, input: {} })) });
      messages.push({ role: "user", content: results.map((r, i) => ({ type: "tool_result", tool_use_id: `t${i}`, content: [{ type: "text", text: JSON.stringify(r.json) }] })) });
    }
    if (wakeText) { messages.push({ role: "assistant", content: [{ type: "text", text: "waiting" }] }); messages.push({ role: "user", content: [{ type: "text", text: wakeText }] }); }
    return parseRequest({ messages }, "main", "main");
  };
  const P = TOOL_PREFIX;
  it("arm A polls with sleeps until the turn is terminal, arm C ends its turn and reads once on the wake", () => {
    const kv: Record<string, string | undefined> = {};
    expect(nextAction("A", requestWith([]), kv).label).toBe("capabilities");
    expect(nextAction("A", requestWith([{ name: `${P}pi_capabilities_get`, json: { ok: true } }]), kv).label).toBe("start");
    expect(nextAction("A", requestWith([{ name: `${P}pi_session_start`, json: { session: { id: "S" } } }]), kv).label).toBe("prompt");
    expect(nextAction("A", requestWith([{ name: `${P}pi_session_prompt`, json: { turn: { turnId: "T" } } }]), kv).label).toBe("sleep");
    expect(nextAction("A", requestWith([{ name: "Bash", json: undefined }]), kv)).toMatchObject({ label: "poll", act: { call: { input: { sessionId: "S", turnId: "T" } } } });
    expect(nextAction("A", requestWith([{ name: `${P}pi_turn_get`, json: { turn: { state: "running" } } }]), kv).label).toBe("sleep");
    expect(nextAction("A", requestWith([{ name: `${P}pi_turn_get`, json: { turn: { state: "completed" } } }]), kv).label).toBe("close");
    const c: Record<string, string | undefined> = { started: "1", sid: "S", tid: "T" };
    expect(nextAction("C", requestWith([{ name: `${P}pi_session_prompt`, json: { turn: { turnId: "T" } } }]), c).label).toBe("end_turn");
    const wake = nextAction("C", requestWith([], "pi-bridge: turn T of session S is completed. Read it once with pi_turn_get."), c);
    expect(wake.label).toBe("wake_read");
    expect(wake.act).toEqual({ call: { name: `${P}pi_turn_get`, input: { sessionId: "S", turnId: "T" } } });
  });
});

describe("live refusals happen before anything starts", () => {
  it("refuses a missing, unparseable or unapproved approval and writes nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-live-refuse-"));
    try {
      const out = join(dir, "out");
      const attempt = (approvalPath: string | undefined) => runLive({ arm: "A", out, dryRun: false, ...(approvalPath ? { approvalPath } : {}) }).then(() => "ran", (e: unknown) => (e instanceof RefusedError ? e.reason : "other"));
      expect(await attempt(undefined)).toBe("approval_required");
      expect(await attempt(join(dir, "missing.json"))).toBe("approval_unreadable");
      await writeFile(join(dir, "bad.json"), "{nope");
      expect(await attempt(join(dir, "bad.json"))).toBe("approval_unparseable");
      await writeFile(join(dir, "no.json"), JSON.stringify({ ...goodApproval(), approved: false }));
      expect(await attempt(join(dir, "no.json"))).toBe("not_approved");
      // A valid approval for another commit never reaches the credential or version checks.
      await writeFile(join(dir, "other.json"), JSON.stringify(goodApproval()));
      expect(await attempt(join(dir, "other.json"))).toBe("source_commit_mismatch");
      expect(await stat(out).then(() => true, () => false)).toBe(false); // no output directory was created
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

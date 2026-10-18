import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { sourceBinding, digest, hash, snapshot, ownedTemporary } from "./files.js";
import { cleanupRegisteredServer, runOwnedController } from "./token-live.js";
import { proxyMetricsSchema } from "./token-live-proxy.js";

export const MARKER = "token_probe_marker_74ac", ERROR_MARKER = "unknown_workspace";
type Scenario = "normal" | "domain-error" | "truncated";
type ProjectedTool = "pi_capabilities_get" | "pi_session_list" | "pi_session_start" | "pi_session_prompt" | "pi_turn_get" | "pi_session_close";
type OutputMetric = ReturnType<typeof projectedOutputs>[number] & { tool: ProjectedTool | "other"; call_ordinal: number | null; new_in_request: boolean };
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const count = (value: string, needle: string) => value.split(needle).length - 1;

export function projectedOutputs(body: unknown) {
  const b = object(body), inputs = Array.isArray(b.input) ? b.input : [];
  return inputs.map(object).filter(i => i.type === "function_call_output").map(i => ({
    serialized_bytes: Buffer.byteLength(JSON.stringify(i.output)),
    marker_hits: count(JSON.stringify(i.output), MARKER), error_marker_hits: count(JSON.stringify(i.output), ERROR_MARKER),
    plaintext_tool_echo_hits: count(JSON.stringify(i.output), "synthetic_tool_echo"),
    plaintext_thinking_echo_hits: count(JSON.stringify(i.output), "synthetic_thinking_echo"),
    structured_key_present: decodedObjects(i.output).some(v => Object.hasOwn(v, "structuredContent") || Object.hasOwn(v, "structured_content")),
  }));
}
export function decodedObjects(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 16) return [];
  if (typeof value === "string") {
    try { return decodedObjects(JSON.parse(value), depth + 1); }
    catch {
      // Accept a wrapped synthetic JSON object; never persist its raw wrapper.
      const start = value.indexOf("{");
      if (start < 0) return [];
      try { return decodedObjects(JSON.parse(value.slice(start, value.lastIndexOf("}") + 1)), depth + 1); } catch { return []; }
    }
  }
  if (Array.isArray(value)) return value.flatMap(v => decodedObjects(v, depth + 1));
  const v = object(value);
  return [v, ...Object.values(v).flatMap(x => decodedObjects(x, depth + 1))];
}
export function projectedTool(body: unknown, suffix: string): { name: string; namespace?: string } | undefined {
  const tools = object(body).tools;
  if (!Array.isArray(tools)) return undefined;
  for (const raw of tools) {
    const tool = object(raw);
    if (tool.type === "namespace" && typeof tool.name === "string" && Array.isArray(tool.tools)) {
      const nested = tool.tools.map(object).find(t => typeof t.name === "string" && t.name.endsWith(suffix));
      if (nested) return { name: nested.name as string, namespace: tool.name };
    }
    if (typeof tool.name === "string" && tool.name.endsWith(suffix)) return { name: tool.name };
  }
  return undefined;
}
export function writeSyntheticResponse(response: ServerResponse, index: number, tool?: { name: string; namespace?: string; args: Record<string, unknown> }) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  let sequence = 0;
  const emit = (type: string, payload: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...payload })}\n\n`);
  const base = { id: `resp_fixture_${index}`, object: "response", created_at: 1, status: "in_progress", model: "synthetic-model", output: [] };
  emit("response.created", { response: base });
  if (tool) {
    const call = { id: `fc_fixture_${index}`, type: "function_call", call_id: `call_fixture_${index}`, name: tool.name, ...tool.namespace ? { namespace: tool.namespace } : {}, arguments: JSON.stringify(tool.args), status: "completed" };
    emit("response.output_item.added", { output_index: 0, item: { ...call, arguments: "", status: "in_progress" } });
    emit("response.function_call_arguments.delta", { output_index: 0, item_id: call.id, delta: call.arguments });
    emit("response.function_call_arguments.done", { output_index: 0, item_id: call.id, name: call.name, arguments: call.arguments });
    emit("response.output_item.done", { output_index: 0, item: call });
    emit("response.completed", { response: { ...base, status: "completed", output: [call] } });
  } else {
    const part = { type: "output_text", text: "Synthetic calibration finished.", annotations: [] };
    const message = { id: `msg_fixture_${index}`, type: "message", role: "assistant", status: "completed", content: [part] };
    emit("response.output_item.added", { output_index: 0, item: { ...message, status: "in_progress", content: [] } });
    emit("response.content_part.added", { output_index: 0, item_id: message.id, content_index: 0, part: { ...part, text: "" } });
    emit("response.output_text.delta", { output_index: 0, item_id: message.id, content_index: 0, delta: part.text });
    emit("response.output_text.done", { output_index: 0, item_id: message.id, content_index: 0, text: part.text });
    emit("response.content_part.done", { output_index: 0, item_id: message.id, content_index: 0, part });
    emit("response.output_item.done", { output_index: 0, item: message });
    emit("response.completed", { response: { ...base, status: "completed", output: [message] } });
  }
  response.end();
}

async function runProjectionCase(root: string, build: string, scenario: Scenario, repetition: number, pilot: boolean) {
  const temp = await ownedTemporary(), home = join(temp.root, "home"), codexHome = join(home, "codex"), workspace = join(temp.root, "workspace");
  const control = join(temp.root, "server-control.json");
  const requests: Array<{ bytes: number; input_bytes: number; tools_bytes: number; outputs: OutputMetric[]; newly_added_output_bytes: number; previous_response_id: boolean; authorization_present: boolean }> = [];
  const seenOutputs = new Set<unknown>();
  const calls = new Map<string, { tool: ProjectedTool; ordinal: number }>();
  let invalid = false, sessionId: string | undefined, turnId: string | undefined, completedViewObserved = false, closed = false, empty = false;
  const desired: ProjectedTool[] = scenario === "normal" ? ["pi_capabilities_get", "pi_session_list"] : scenario === "domain-error" ? ["pi_session_start", "pi_session_list"] : ["pi_session_start", "pi_session_prompt", "pi_turn_get", "pi_session_close", "pi_session_list"];
  let step = 0;
  const names = new Map<string, { name: string; namespace?: string }>();
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/responses" || requests.length >= 12) { invalid = true; response.writeHead(400); response.end(); return; }
    const chunks: Buffer[] = []; let bytes = 0;
    try {
      for await (const chunk of request) { bytes += Buffer.byteLength(chunk); if (bytes > 2 * 1024 * 1024) { invalid = true; response.writeHead(413); response.end(); return; } chunks.push(Buffer.from(chunk)); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      const input = Array.isArray(object(body).input) ? object(body).input as unknown[] : [];
      const outputItems = input.map(object).filter(i => i.type === "function_call_output");
      const outputs: OutputMetric[] = projectedOutputs(body).map((metric, i) => {
        const id = outputItems[i]!.call_id, call = typeof id === "string" ? calls.get(id) : undefined;
        if (!call) invalid = true;
        return { ...metric, tool: call?.tool ?? "other", call_ordinal: call?.ordinal ?? null, new_in_request: !seenOutputs.has(id) };
      });
      const latest = [...input].reverse().map(object).find(i => i.type === "function_call_output");
      const decoded = decodedObjects(latest?.output);
      const s = decoded.map(v => object(v.session)).find(v => typeof v.id === "string"), t = decoded.map(v => object(v.turn)).find(v => typeof v.turnId === "string");
      if (typeof s?.id === "string") sessionId = s.id;
      if (typeof t?.turnId === "string") turnId = t.turnId;
      if (t?.state === "completed" && t.truncated === true) completedViewObserved = true;
      if (s?.state === "closed") closed = true;
      if (decoded.some(v => Array.isArray(v.sessions) && v.sessions.length === 0)) empty = true;
      let newly_added_output_bytes = 0;
      for (const item of input.map(object).filter(i => i.type === "function_call_output")) {
        if (!seenOutputs.has(item.call_id)) { newly_added_output_bytes += Buffer.byteLength(JSON.stringify(item.output)); seenOutputs.add(item.call_id); }
      }
      requests.push({ bytes, input_bytes: Buffer.byteLength(JSON.stringify(input)), tools_bytes: Buffer.byteLength(JSON.stringify(object(body).tools ?? [])), outputs, newly_added_output_bytes,
        previous_response_id: typeof object(body).previous_response_id === "string", authorization_present: request.headers.authorization !== undefined });
      for (const suffix of desired) { const tool = projectedTool(body, suffix); if (tool) names.set(suffix, tool); }
      const suffix = desired[step++];
      if (!suffix) { writeSyntheticResponse(response, requests.length); return; }
      const tool = names.get(suffix);
      if (!tool) { invalid = true; writeSyntheticResponse(response, requests.length); return; }
      const args = suffix === "pi_session_start" ? { workspace: scenario === "domain-error" ? "missing_probe" : MARKER, executionProfile: "fixture" } :
        suffix === "pi_session_prompt" ? { sessionId, prompt: "Return the synthetic fixture answer." } :
        suffix === "pi_turn_get" ? { sessionId, turnId } : suffix === "pi_session_close" ? { sessionId } : {};
      if (suffix === "pi_turn_get") await new Promise(resolve => setTimeout(resolve, 150));
      calls.set(`call_fixture_${requests.length}`, { tool: suffix, ordinal: calls.size + 1 });
      writeSyntheticResponse(response, requests.length, { ...tool, args });
    } catch { invalid = true; response.writeHead(400); response.end(); }
  });
  let exit_code: number | null = null, timed_out = false, process_cleanup = false, stdout_bytes = 0, proxy_integrity = false, server_cleanup = false, server_completed_capped_turn = false, call_schedule_matched = false, server_representation_counts: number[] = [];
  let registered_server_cleanup = false;
  let server_target: { wire_bytes: number; content_bytes: number; structured_bytes: number; assistant_bytes: number; state: string; equal_json_representations: boolean } | null = null;
  let duration_ms = 0;
  try {
    await mkdir(codexHome, { recursive: true }); await mkdir(workspace);
    const config = join(temp.root, "config.json"), metrics = join(temp.root, "proxy.json");
    await writeFile(config, JSON.stringify({ workspace }), { mode: 0o600 });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("listener_failed");
    const args = ["exec", "--json", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check", "--sandbox", "read-only", "-C", workspace, "-m", "synthetic-model"];
    const settings: Record<string, unknown> = {
      model_provider: "synthetic", "model_providers.synthetic.name": "Synthetic local fixture",
      "model_providers.synthetic.base_url": `http://127.0.0.1:${address.port}/v1`, "model_providers.synthetic.wire_api": "responses",
      "model_providers.synthetic.requires_openai_auth": false, "model_providers.synthetic.supports_websockets": false,
      "model_providers.synthetic.request_max_retries": 0, "model_providers.synthetic.stream_max_retries": 0,
      "mcp_servers.pi-projection.command": process.execPath, "mcp_servers.pi-projection.args": [join(build, "eval/profiles/token-live-proxy.js")],
      "mcp_servers.pi-projection.required": true,
    };
    const proxyEnvironment = { TOKEN_LIVE_REAL_ENTRY: join(build, "eval/profiles/token-projection-server.js"), TOKEN_LIVE_CONFIG: config, TOKEN_LIVE_METRICS_FILE: metrics, TOKEN_LIVE_CONTROL_FILE: control, TOKEN_LIVE_MAX_STARTS: "1", TOKEN_LIVE_MAX_PROMPTS: "1" };
    for (const [key, value] of Object.entries(proxyEnvironment)) settings[`mcp_servers.pi-projection.env.${key}`] = value;
    for (const tool of ["pi_session_prompt", "pi_session_abort", "pi_session_close"]) settings[`mcp_servers.pi-projection.tools.${tool}.approval_mode`] = "approve";
    for (const [key, value] of Object.entries(settings)) args.push("-c", `${key}=${JSON.stringify(value)}`);
    const prompt = "This is a deterministic local client calibration. Follow only the model-supplied MCP calls. Do not run shell commands or read files. Return the final answer after the fixture reports completion.";
    args.push("-");
    const began = performance.now();
    const result = await runOwnedController("codex", args, { cwd: workspace, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, CODEX_HOME: codexHome } }, prompt, 90000, () => undefined);
    registered_server_cleanup = await cleanupRegisteredServer(control);
    duration_ms = performance.now() - began;
    // Only numeric/boolean fields from the supervisor are exported.
    const r = result as unknown as Record<string, unknown>;
    exit_code = typeof r.exit_code === "number" ? r.exit_code : null;
    timed_out = r.timed_out === true; process_cleanup = r.process_group_cleanup_observed === true;
    stdout_bytes = typeof r.stdout_bytes === "number" ? r.stdout_bytes : 0;
    try {
      const proxy = proxyMetricsSchema.parse(JSON.parse(await readFile(metrics, "utf8")));
      proxy_integrity = proxy.integrity_passed === true;
      server_cleanup = proxy.server_cleanup_observed && proxy.server_exit_code === 0;
      server_completed_capped_turn = proxy.frames.some(f => f.direction === "response" && f.tool === "pi_turn_get" && f.state === "completed" && f.assistant_bytes === 65536);
      call_schedule_matched = digest(proxy.frames.filter(f => f.direction === "request" && f.tool.startsWith("pi_")).map(f => f.tool)) === digest(desired);
      empty ||= proxy.empty_session_list_observed;
      server_representation_counts = (proxy.frames ?? []).filter(f => f.direction === "response" && f.tool === (scenario === "normal" ? "pi_capabilities_get" : scenario === "domain-error" ? "pi_session_start" : "pi_turn_get")).map(f => Number(f.structured_bytes > 0) + Number(f.content_text_bytes > 0));
      const frame = proxy.frames.find(f => f.direction === "response" && f.tool === (scenario === "normal" ? "pi_capabilities_get" : scenario === "domain-error" ? "pi_session_start" : "pi_turn_get"));
      if (frame) server_target = { wire_bytes: frame.wire_bytes, content_bytes: frame.content_bytes, structured_bytes: frame.structured_bytes, assistant_bytes: frame.assistant_bytes, state: frame.state, equal_json_representations: frame.equal_json_representations };
    } catch { proxy_integrity = false; }
  } catch { invalid = true; }
  finally {
    if (!registered_server_cleanup) registered_server_cleanup = await cleanupRegisteredServer(control);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await temp.remove();
  }
  const target = scenario === "normal" ? "pi_capabilities_get" : scenario === "domain-error" ? "pi_session_start" : "pi_turn_get";
  const target_output = requests.flatMap(r => r.outputs).find(o => o.tool === target && o.new_in_request) ?? null;
  const observed = target_output !== null && (scenario === "domain-error" ? target_output.error_marker_hits > 0 : target_output.marker_hits > 0);
  return { scenario, repetition, pilot, exit_code, timed_out, process_cleanup, server_cleanup, registered_server_cleanup, stdout_bytes, duration_ms, proxy_integrity,
    requests, target_output, server_target, call_schedule_matched, server_representation_counts, client_completed_truncated_json_decoded: completedViewObserved, session_closed_observed: scenario === "truncated" ? closed : true,
    server_completed_capped_turn, empty_list_observed: empty, invalid,
    passed: !invalid && exit_code === 0 && !timed_out && process_cleanup && server_cleanup && registered_server_cleanup && proxy_integrity && observed && empty && call_schedule_matched
      && requests.length === desired.length + 1 && requests.every(r => !r.authorization_present) && server_representation_counts.length === 1 && server_representation_counts[0] === 2
      && server_target?.equal_json_representations === true
      && (scenario !== "truncated" || (target_output !== null && target_output.plaintext_tool_echo_hits > 0 && target_output.plaintext_thinking_echo_hits > 0))
      && (scenario !== "truncated" || (closed && server_completed_capped_turn)),
  };
}

/** Declared test-only route; no external provider/auth and no semantic token usage. */
export async function measureClientProjection(root: string, build: string, output: string) {
  const binding = await sourceBinding(root), started_at = new Date().toISOString();
  const buildBinding = async () => digest([await snapshot(join(build, "src")), await snapshot(join(build, "eval/profiles")), await snapshot(join(build, "test")), hash(await readFile(join(build, "package.json")))]);
  const build_digest = await buildBinding();
  const version = spawnSync("codex", ["--version"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
  if (version.status !== 0 || version.stdout.trim() !== "codex-cli 0.162.0") throw new Error("unsupported_fixture_client");
  const rows = [await runProjectionCase(root, build, "normal", 0, true)];
  if (rows[0]!.passed) for (const scenario of ["normal", "domain-error", "truncated"] as const) for (let repetition = 1; repetition <= 5; repetition++) rows.push(await runProjectionCase(root, build, scenario, repetition, false));
  const source_unchanged = digest(binding) === digest(await sourceBinding(root));
  const build_unchanged = build_digest === await buildBinding();
  const result = { schema_version: "token-client-projection-1", binding, build_digest, node: process.versions.node,
    fixture_digest: hash(await readFile(join(build, "eval/profiles/token-projection-server.js"))),
    route: "synthetic-loopback-responses", authentication: "disabled-empty-disposable-client-home", client_version: "0.162.0", started_at, ended_at: new Date().toISOString(),
    source_unchanged, build_unchanged, rows, model_usage: null, money: null, real_cloud_projection: null, os_egress_containment: null,
    metric_semantics: { bytes: "direct-observation-of-serialized-utf8", marker_hits: "occurrences-in-selected-function-output", newly_added_output_bytes: "first-observed-call-id-output-serialization", request_bytes: "whole-http-json-body-not-token-usage", model_usage: "unknown-no-model-executed", money: "unknown-no-meter-or-tariff" },
    harness_status: rows.length === 16 && rows.every(r => r.passed) && source_unchanged && build_unchanged ? "PASS" : "INCONCLUSIVE" };
  await writeFile(join(output, "client-projection.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return result;
}

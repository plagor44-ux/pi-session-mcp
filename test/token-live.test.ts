import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { symlink } from "node:fs/promises";
import { promisify } from "node:util";
import { ownedTemporary } from "../eval/profiles/files.js";
import { digest } from "../eval/profiles/files.js";
import { cleanupRegisteredServer, prepareTokenLive, runOwnedController, runTokenLive, verifyL3ReceiptSchedule } from "../eval/profiles/token-live.js";
import { TokenFrameForwarder } from "../eval/profiles/token-live-proxy.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); vi.restoreAllMocks(); });
async function tempDir(prefix: string): Promise<string> { const path = await mkdtemp(join(tmpdir(), prefix)); temporary.push(path); return path; }

describe("token-live proxy frame path", () => {
  test("forwards split request and response bytes exactly in both directions", () => {
    const forwarder = new TokenFrameForwarder();
    const request = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"pi_session_start","arguments":{}}}\n');
    const response = Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"structuredContent":{"ok":true}}}\n');
    const requestOut: Buffer[] = [], responseOut: Buffer[] = [];
    forwarder.forward("request", request.subarray(0, 23), bytes => requestOut.push(Buffer.from(bytes)));
    forwarder.forward("request", request.subarray(23), bytes => requestOut.push(Buffer.from(bytes)));
    forwarder.forward("response", response.subarray(0, 31), bytes => responseOut.push(Buffer.from(bytes)));
    forwarder.forward("response", response.subarray(31), bytes => responseOut.push(Buffer.from(bytes)));
    const metrics = forwarder.finish();
    expect(Buffer.concat(requestOut)).toEqual(request);
    expect(Buffer.concat(responseOut)).toEqual(response);
    expect(metrics.integrity_passed).toBe(true);
    expect(metrics.controller_bytes).toBe(request.length);
    expect(metrics.written_bytes).toBe(request.length);
    expect(metrics.received_bytes).toBe(response.length);
  });

  test("counts malformed and unterminated request bytes without forwarding mutations; response bytes stay transparent", () => {
    const forwarder = new TokenFrameForwarder(), output: Buffer[] = [];
    const malformed = Buffer.from("not-json\n");
    const tail = Buffer.from('{"jsonrpc":"2.0","id":2');
    const laterMutation = Buffer.from('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"pi_session_close","arguments":{}}}\n');
    // Coalesced malformed plus otherwise-valid mutation must fail closed in one callback.
    forwarder.forward("request", Buffer.concat([malformed, laterMutation]), bytes => output.push(Buffer.from(bytes)));
    forwarder.forward("request", tail, bytes => output.push(Buffer.from(bytes)));
    forwarder.flush("request", bytes => output.push(Buffer.from(bytes)));
    const metrics = forwarder.finish();
    expect(Buffer.concat(output)).toEqual(Buffer.alloc(0));
    expect(metrics.integrity_passed).toBe(false);
    expect(metrics.controller_bytes).toBe(malformed.length + laterMutation.length + tail.length);
    expect(metrics.written_bytes).toBe(0);

    const serverForwarder = new TokenFrameForwarder(), serverOutput: Buffer[] = [];
    serverForwarder.forward("response", malformed, bytes => serverOutput.push(Buffer.from(bytes)));
    serverForwarder.forward("response", tail, bytes => serverOutput.push(Buffer.from(bytes)));
    serverForwarder.flush("response", bytes => serverOutput.push(Buffer.from(bytes)));
    const serverMetrics = serverForwarder.finish();
    expect(Buffer.concat(serverOutput)).toEqual(Buffer.concat([malformed, tail]));
    expect(serverMetrics.integrity_passed).toBe(false);
    expect(serverMetrics.received_bytes).toBe(malformed.length + tail.length);
  });

  test("rejects over-quota mutation before forwarding, even with padded JSON", () => {
    const forwarder = new TokenFrameForwarder({ maxStarts: 1, maxPrompts: 1 }), output: Buffer[] = [], rejected: Buffer[] = [];
    const first = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"pi_session_start","arguments":{}}}\n');
    const second = Buffer.from(` ${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "pi_session_start", arguments: {} }})} \n`);
    forwarder.forward("request", first, bytes => output.push(bytes));
    forwarder.forward("request", second, bytes => output.push(bytes), bytes => rejected.push(bytes));
    expect(Buffer.concat(output)).toEqual(first);
    expect(rejected).toHaveLength(1);
    expect(JSON.parse(rejected[0]!.toString("utf8")).error.code).toBe(-32000);
    expect(forwarder.finish()).toMatchObject({ quota_rejections: 1, fatal_request: false, written_bytes: first.length });
  });

  test("enforces a bounded worker-turn timer and cancels it on terminal retrieval", async () => {
    let timedOut = 0;
    const forwarder = new TokenFrameForwarder({ maxStarts: 1, maxPrompts: 1, workerTurnMs: 5, onWorkerTurnTimeout: () => { timedOut++; } });
    const send = (direction: "request" | "response", value: unknown) => forwarder.forward(direction, Buffer.from(`${JSON.stringify(value)}\n`), () => undefined);
    send("request", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pi_session_prompt", arguments: { sessionId: "synthetic-session" } } });
    send("response", { jsonrpc: "2.0", id: 1, result: { structuredContent: { ok: true } } });
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(timedOut).toBe(1);
    expect(forwarder.finish().worker_turn_timed_out).toBe(true);
    forwarder.dispose();
  });

  test("retrieving an older completed turn does not clear the follow-up turn timer", async () => {
    let timedOut = 0;
    const forwarder = new TokenFrameForwarder({ maxStarts: 1, maxPrompts: 2, workerTurnMs: 12, onWorkerTurnTimeout: () => { timedOut++; } });
    const send = (direction: "request" | "response", value: unknown) => forwarder.forward(direction, Buffer.from(`${JSON.stringify(value)}\n`), () => undefined);
    send("request", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pi_session_prompt", arguments: { sessionId: "same-session" } } });
    send("response", { jsonrpc: "2.0", id: 1, result: { structuredContent: { ok: true, turn: { sessionId: "same-session", turnId: "followup", state: "running" } } } });
    send("request", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "pi_turn_get", arguments: { sessionId: "same-session", turnId: "original" } } });
    send("response", { jsonrpc: "2.0", id: 2, result: { structuredContent: { ok: true, turn: { sessionId: "same-session", turnId: "original", state: "completed" } } } });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(timedOut).toBe(1);
    expect(forwarder.finish().worker_turn_timed_out).toBe(true);
    forwarder.dispose();
  });

  test("stops forwarding after an unknown mutating tool and rejects oversized frames", () => {
    const forwarder = new TokenFrameForwarder(), output: Buffer[] = [];
    const unknown = Buffer.from('{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"synthetic_mutation","arguments":{}}}\n');
    forwarder.forward("request", unknown, bytes => output.push(bytes));
    forwarder.forward("request", Buffer.from('{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"pi_session_close","arguments":{}}}\n'), bytes => output.push(bytes));
    expect(output).toHaveLength(0);
    const oversized = new TokenFrameForwarder(), tooLarge = Buffer.alloc(2 * 1024 * 1024 + 1, 32), oversizedOutput: Buffer[] = [];
    oversized.forward("request", tooLarge, bytes => oversizedOutput.push(bytes));
    expect(oversizedOutput).toHaveLength(0);
    expect(oversized.finish()).toMatchObject({ integrity_passed: false, fatal_request: true, controller_bytes: tooLarge.length, written_bytes: 0 });
  });
});

describe("M1 preparation and approval gates", () => {
  test("receipt ledger follows scheduled session/turn IDs despite out-of-order completion", () => {
    const prompts = [
      { sessionId: "session-a", turnId: "a-first" },
      { sessionId: "session-b", turnId: "b-first" },
      { sessionId: "session-a", turnId: "a-followup" },
    ];
    const observations = [
      { ...prompts[1]!, hash: "b", sequence: 1 }, // B completed first.
      { ...prompts[0]!, hash: "a", sequence: 2 },
      { ...prompts[0]!, hash: "a", sequence: 3 }, // A was polled again before follow-up.
      { ...prompts[2]!, hash: "a2", sequence: 4 },
      { ...prompts[0]!, hash: "a", sequence: 5 },
    ];
    expect(verifyL3ReceiptSchedule(prompts, observations)).toEqual({
      uniquePrompts: true, everyPromptHasReceipt: true, originalReFetchedAfterFollowup: true, originalUnchanged: true,
    });
    expect(verifyL3ReceiptSchedule(prompts, observations.slice(0, 3))).toMatchObject({ originalReFetchedAfterFollowup: false });
    expect(verifyL3ReceiptSchedule(prompts, observations.map((row, index) => index === 4 ? { ...row, hash: "changed" } : row))).toMatchObject({ originalUnchanged: false });
  });

  test("owned process helper bounds a synthetic local child and returns only metadata", async () => {
    const cwd = await tempDir("token-live-controller-");
    const lines: string[] = [];
    const result = await runOwnedController(process.execPath, ["-e", "process.stdout.write('{\\\"type\\\":\\\"turn.completed\\\"}\\n')"], { cwd, env: { PATH: process.env.PATH ?? "" } }, "", 3000, line => lines.push(line.toString("utf8")));
    expect(lines).toEqual(['{"type":"turn.completed"}']);
    expect(result).toMatchObject({ exit_code: 0, timed_out: false, line_integrity_passed: true, stdout_bytes: 26 });
    if (process.platform !== "win32") expect(result.process_group_cleanup_observed).toBe(true);
  });

  test("abort terminates the owned controller group and reports observed cleanup", async () => {
    const cwd = await tempDir("token-live-controller-abort-"), controller = new AbortController();
    const resultPromise = runOwnedController(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd, env: { PATH: process.env.PATH ?? "" } }, "", 5000, () => undefined, undefined, controller.signal);
    setTimeout(() => controller.abort(), 50);
    const result = await resultPromise;
    expect(result.timed_out).toBe(true);
    if (process.platform !== "win32") expect(result.process_group_cleanup_observed).toBe(true);
  });

  test("pre-aborted supervisor never spawns a controller", async () => {
    const controller = new AbortController(); controller.abort();
    let spawnCount = 0;
    const spawn = (() => { spawnCount++; throw new Error("must_not_spawn"); }) as never;
    const result = await runOwnedController("fake", [], { cwd: process.cwd(), env: {} }, "", 10_000, () => undefined, spawn, controller.signal);
    expect(result).toMatchObject({ exit_code: null, timed_out: true, process_group_cleanup_observed: true, stdout_bytes: 0, line_integrity_passed: false });
    expect(spawnCount).toBe(0);
  });

  test("registered detached server cleanup validates identity and removes surviving group", async () => {
    if (process.platform !== "linux") return;
    const dir = await tempDir("token-live-server-cleanup-"), child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
    try {
      const pid = child.pid!;
      let start = "";
      for (let attempt = 0; attempt < 30 && !start; attempt++) {
        try {
          const stat = await readFile("/proc/" + pid + "/stat", "utf8"), fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          if (Number(fields[2]) === pid && fields[19]) start = fields[19]!;
        } catch { /* process not visible yet */ }
        if (!start) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(start).not.toBe("");
      const record = join(dir, "identity.json");
      await writeFile(record, JSON.stringify({ schema_version: "token-live-server-identity-1", pid, start: "0", process_group: pid }));
      expect(await cleanupRegisteredServer(record, 100)).toBe(false);
      expect(() => process.kill(pid, 0)).not.toThrow();
      await rm(record);
      await writeFile(record, JSON.stringify({ schema_version: "token-live-server-identity-1", pid, start, process_group: pid }));
      expect(await cleanupRegisteredServer(record, 500)).toBe(true);
      expect(await cleanupRegisteredServer(record, 500)).toBe(true);
    } finally {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
  });

  test("prepares four baseline screening slots with a null, unapproved advisory budget", async () => {
    const root = process.cwd(), build = await tempDir("token-live-build-");
    await mkdir(join(build, "src"));
    await mkdir(join(build, "eval/profiles"), { recursive: true });
    await writeFile(join(build, "src/main.js"), "synthetic build");
    await writeFile(join(build, "eval/profiles/token-live-proxy.js"), "synthetic proxy build");
    await writeFile(join(build, "package.json"), JSON.stringify({ version: "test" }));
    const prepared = await prepareTokenLive(root, build);
    expect(prepared.profileManifest.approved).toBe(false);
    expect(prepared.profileManifest.runs).toHaveLength(4);
    expect(prepared.profileManifest.runs.map(run => run.task_id).sort()).toEqual(["T1", "T1", "T1", "T2"]);
    expect(prepared.budgetProposal).toMatchObject({ approved: false, advisory_usd: null, acknowledges_unmetered_cost: false, max_starts: 4, max_retries: 0 });
    expect(prepared.decisionTemplate).toMatchObject({ approved: false, manifest_digest: null, budget_digest: null, operator_acknowledges_advisory_not_cap: false });
    expect(prepared.decisionTemplate.limits).toEqual({ starts: 4, work_turns: 5, retries: 0, invocations: 3 });
  });

  test("rejects stale, unsigned, wrong-route, and missing-budget approvals before child spawn", async () => {
    const root = process.cwd(), build = await tempDir("token-live-build-");
    await mkdir(join(build, "src"));
    await mkdir(join(build, "eval/profiles"), { recursive: true });
    await writeFile(join(build, "src/main.js"), "synthetic build");
    await writeFile(join(build, "eval/profiles/token-live-proxy.js"), "synthetic proxy build");
    await writeFile(join(build, "package.json"), JSON.stringify({ version: "test" }));
    const prepared = await prepareTokenLive(root, build);
    const profileManifest = { ...prepared.profileManifest, approved: true };
    const budget = { schema_version: "1.0.0", approved: true, manifest_digest: digest(profileManifest), max_starts: 4, max_retries: 0, parallelism: 1, run_timeout_ms: 600000, total_timeout_ms: 1800000, advisory_usd: 1, provider_cap_usd: null, acknowledges_unmetered_cost: true };
    const base = { ...prepared.decisionTemplate, approved: true, manifest_digest: digest(profileManifest), budget_digest: digest(budget), advisory_usd: 1, operator_acknowledges_advisory_not_cap: true };
    const stale = { ...base, source_digest: "sha256:stale" };
    const unsigned = { ...base, approved: false };
    const wrongRoute = { ...base, controller: { ...base.controller, model: "other" } };
    let spawns = 0;
    const spawn = (() => { spawns++; throw new Error("must_not_spawn"); }) as never;
    for (const decision of [stale, unsigned, wrongRoute]) {
      const output = join(await tempDir("token-live-output-"), "results");
      await expect(runTokenLive(root, build, { profileManifest, budget, decision }, output, { spawn })).rejects.toThrow();
    }
    const output = join(await tempDir("token-live-output-"), "results");
    await expect(runTokenLive(root, build, { profileManifest, budget: { ...budget, max_starts: 3 }, decision: base }, output, { spawn })).rejects.toThrow();
    expect(spawns).toBe(0);
  });

  test("valid schedule approval reaches only an injected local controller and persists failed partial evidence", async () => {
    const root = process.cwd(), build = await tempDir("token-live-build-");
    await mkdir(join(build, "src"));
    await mkdir(join(build, "eval/profiles"), { recursive: true });
    await writeFile(join(build, "src/main.js"), "synthetic build");
    await writeFile(join(build, "eval/profiles/token-live-proxy.js"), "synthetic proxy build");
    await writeFile(join(build, "package.json"), JSON.stringify({ version: "test" }));
    const prepared = await prepareTokenLive(root, build);
    const profileManifest = { ...prepared.profileManifest, approved: true };
    const budget = { ...prepared.budgetProposal, approved: true, manifest_digest: digest(profileManifest), advisory_usd: 1, acknowledges_unmetered_cost: true };
    const decision = { ...prepared.decisionTemplate, approved: true, manifest_digest: digest(profileManifest), budget_digest: digest(budget), advisory_usd: 1, operator_acknowledges_advisory_not_cap: true };
    let spawnCount = 0;
    const fakeSpawn = (_command: string, _args: string[], options: Parameters<typeof spawn>[2]) => {
      spawnCount++;
      return spawn(process.execPath, ["-e", "process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"], options) as ChildProcessWithoutNullStreams;
    };
    const output = join(await tempDir("token-live-output-"), "results");
    const result = await runTokenLive(root, build, { profileManifest, budget, decision }, output, { spawn: fakeSpawn, controllerVersion: () => true });
    expect(spawnCount).toBe(1);
    expect(result.harness_status).toBe("FAIL");
    expect(result.cases[0]).toMatchObject({ id: "L1", starts: null, prompts: null, proxy_integrity: null });
    const saved = JSON.parse(await readFile(join(output, "token-live-result.json"), "utf8")) as { cases: Array<{ starts: number | null; prompts: number | null }>; binding: { decision_digest: string } };
    expect(saved.cases[0]).toMatchObject({ starts: null, prompts: null });
    expect(saved.binding.decision_digest).toBe(digest(decision));
  });
});

describe.skipIf(process.platform !== "linux")("token-live proxy process shutdown", () => {
  let build: string, remove: () => Promise<void>;
  beforeAll(async () => {
    const temp = await ownedTemporary(); remove = temp.remove; build = join(temp.root, "build");
    await promisify(execFile)(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.eval.json", "--outDir", build], { timeout: 120000 });
    await symlink(join(process.cwd(), "node_modules"), join(build, "node_modules"), "dir");
  }, 150000);
  afterAll(async () => { await remove?.(); });

  test("forwards a controller SIGTERM as stdin EOF so a real-style server exits 0", async () => {
    const dir = await tempDir("token-live-shutdown-");
    // Mirrors src/main.ts: EOF takes the graceful exit-0 path, SIGTERM exits 143.
    const server = join(dir, "server.mjs"), metrics = join(dir, "metrics.json");
    await writeFile(server, 'process.stdin.resume();process.stdin.once("end",()=>process.exit(0));process.once("SIGTERM",()=>process.exit(143));');
    const proxy = spawn(process.execPath, [join(build, "eval/profiles/token-live-proxy.js")], { stdio: ["pipe", "ignore", "ignore"], env: {
      PATH: process.env.PATH ?? "", TOKEN_LIVE_REAL_ENTRY: server, TOKEN_LIVE_CONFIG: join(dir, "config.json"), TOKEN_LIVE_METRICS_FILE: metrics,
      TOKEN_LIVE_MAX_STARTS: "1", TOKEN_LIVE_MAX_PROMPTS: "1" } });
    const closed = new Promise<number | null>(resolve => proxy.once("close", code => resolve(code)));
    await new Promise(resolve => setTimeout(resolve, 500));
    proxy.kill("SIGTERM");
    expect(await closed).toBe(0);
    expect(JSON.parse(await readFile(metrics, "utf8"))).toMatchObject({ server_exit_code: 0, server_cleanup_observed: true, integrity_passed: true });
  }, 30000);
});

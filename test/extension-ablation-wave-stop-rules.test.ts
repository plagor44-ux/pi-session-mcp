import { type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { validateApproval } from "../eval/extensions/approval.js";
import { buildMatrix, PAIRINGS } from "../eval/extensions/matrix.js";
import type { ImplementationScore } from "../eval/extensions/oracles.js";
import { EMPTY_PLAN } from "../eval/extensions/sandbox.js";
import { resolveTool } from "../eval/extensions/tools.js";
import { runWave, type RunRecord, type WaveDeps } from "../eval/extensions/wave.js";
import { privateRunDir, scopeRoot, type RunScope, type ScopeInput } from "../eval/extensions/workspace.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";
import { exec, SOURCE, productionConfig, GOOD_REVIEW, prelude, benignTrace, fake, fakePrepare, reviewTask, approvalFor, waveSetup, TOOLS, baseDeps, findDirs, findFiles, LEDGER_ID, text, stopReasons } from "./extension-ablation-wave-fixtures.js";

afterAll(removeTemporaryRoots);

describe("runWave stop rules", () => {
  it("stops on an outside write and records the remaining runs as not_run", async () => {
    const s = await waveSetup(3);
    const outside = prelude(4242) + "4242 openat(AT_FDCWD</scope>, \"/home/u/secret\", O_WRONLY|O_CREAT, 0644) = 3</home/u/secret>\n";
    const { deps } = s.deps([text({ trace: outside })]);
    const r = await runWave(s.input, deps);
    expect(r.stopReason).toBe("outside_write");
    expect(stopReasons(r.records)).toEqual(["stopped", "not_run", "not_run"]);
    expect(r.records[0]).toMatchObject({ stopReason: "outside_write", accepted: null, trace: { outsideWrites: 1 } });
    // R42: the worker-controlled path is nowhere on disk but in the one kept diagnostics file (R84); the record carries the count only.
    expect(await readFile(join(s.waveDir, "runs", `${s.runs[0]!.runId}.json`), "utf8")).not.toContain("/home/u");
    expect(existsSync(privateRunDir(s.waveDir, s.runs[0]!.runId))).toBe(false);
    const diagnostics = await findFiles(join(s.waveDir, "diagnostics"), /./);
    expect(diagnostics).toEqual([join(s.waveDir, "diagnostics", `${s.runs[0]!.runId}.txt`)]);
    for (const file of (await findFiles(s.waveDir, /./)).filter((path) => !diagnostics.includes(path))) expect(await readFile(file, "utf8")).not.toContain("/home/u/secret");
    expect(existsSync(scopeRoot(s.waveDir, s.runs[0]!.runId))).toBe(false);
    expect(existsSync(join(privateRunDir(s.waveDir, s.runs[0]!.runId), "scope"))).toBe(false);
    expect(existsSync(join(s.waveDir, "runs", `${s.runs[2]!.runId}.json`))).toBe(true);
  });

  it("stops on a relative write whose directory cannot be resolved", async () => {
    const s = await waveSetup(2);
    const trace = `${benignTrace()}777 openat(AT_FDCWD, "y", O_RDWR) = 3\n`;
    const r = await runWave(s.input, s.deps([text({ trace })]).deps);
    expect(r.stopReason).toBe("unresolved_write");
    expect(r.records[0]!.trace).toMatchObject({ unresolvedWrites: 1, outsideWrites: 0 });
  });

  it("stops on egress that cannot be audited", async () => {
    const s = await waveSetup(2);
    const trace = `${benignTrace()}4242 io_uring_setup(8, {flags=0}) = 5\n`;
    const r = await runWave(s.input, s.deps([text({ trace })]).deps);
    expect(r.stopReason).toBe("unresolved_egress");
  });

  describe("abstract sockets bound inside the trace (R88)", () => {
    const line = (call: string, name: string, ret = "0") => `4242 ${call}(4<socket:[32553896]>, {sa_family=AF_UNIX, sun_path=@"${name}"}, 44) = ${ret}\n`;

    it("does not stop a run whose own processes bind and connect an abstract name, and stops for a name nobody bound", async () => {
      const s = await waveSetup(2);
      const own = `${benignTrace()}${line("bind", "mail-pdf-73342cfaea134cc4be84610388df1d0d")}${line("connect", "mail-pdf-73342cfaea134cc4be84610388df1d0d")}`;
      const ok = await runWave(s.input, s.deps([text({ trace: own }), text()]).deps);
      expect(ok.stopReason).toBeNull();
      expect(ok.records[0]).toMatchObject({ outcome: "scored", trace: { unresolvedEgress: 0 } });
      expect(existsSync(join(s.waveDir, "diagnostics"))).toBe(false);
      const t = await waveSetup(2);
      const foreign = `${benignTrace()}${line("bind", "mine")}${line("connect", "docker_cli_bda8b079f8fdef11b684b7c481c7a6ce")}`;
      const stopped = await runWave(t.input, t.deps([text({ trace: foreign })]).deps);
      expect(stopped.stopReason).toBe("unresolved_egress");
      expect(await readFile(join(t.waveDir, "diagnostics", `${stopped.records[0]!.runId}.txt`), "utf8")).toContain("docker_cli_bda8b079f8fdef11b684b7c481c7a6ce");
    });

    it("stops for a connect before the bind and for a name whose bind failed with EADDRINUSE", async () => {
      for (const trace of [
        `${benignTrace()}${line("connect", "svc")}${line("bind", "svc")}`,
        `${benignTrace()}${line("bind", "svc", "-1 EADDRINUSE (Address already in use)")}${line("connect", "svc")}`,
      ]) {
        const s = await waveSetup(2);
        expect((await runWave(s.input, s.deps([text({ trace })]).deps)).stopReason).toBe("unresolved_egress");
      }
    });

    it("judges the oracle's trace the same way", async () => {
      const s = await waveSetup(1, { kind: "implementation" });
      const scoring: WaveDeps["scoreImplementation"] = async (_clone, _task, options) => {
        const argv = options.wrap!(["npm", "test"]);
        await writeFile(argv[argv.indexOf("-o") + 1]!, prelude(9000) + (line("bind", "t") + line("connect", "t") + line("connect", "u")).replaceAll("4242", "9000"));
        return { accepted: true, testsPassed: true, outOfScope: [] };
      };
      const r = await runWave(s.input, s.deps([text()], { scoreImplementation: scoring }).deps);
      expect(r.stopReason).toBe("unresolved_egress");
      expect(r.records[0]!.trace).toMatchObject({ unresolvedEgress: 1 });
    });
  });

  describe("sockets in the sandbox's private /tmp (R87)", () => {
    const connect = (path: string) => `4242 connect(19<socket:[1234567]>, {sa_family=AF_UNIX, sun_path="${path}"}, 110) = 0\n`;
    const bound = { ...EMPTY_PLAN, extraReadOnly: ["/tmp/ablation-build-x"] };

    it("does not stop a run whose codegraph MCP server connects to its daemon socket in /tmp, and keeps no diagnostics", async () => {
      const s = await waveSetup(2);
      const r = await runWave(s.input, s.deps([text({ trace: `${benignTrace()}${connect("/tmp/codegraph-9ae10b5c0e7502a8.sock")}` }), text()]).deps);
      expect(r.stopReason).toBeNull();
      expect(r.records[0]).toMatchObject({ outcome: "scored", trace: { unresolvedEgress: 0 } });
      expect(existsSync(join(s.waveDir, "diagnostics"))).toBe(false);
    });

    it("does not stop a run for a name-resolution socket although the plan binds /run/systemd/resolve back in", async () => {
      const s = await waveSetup(2);
      const plan = { ...EMPTY_PLAN, runReadOnly: ["/run/systemd/resolve"], extraReadOnly: ["/tmp/ablation-build-x"] };
      const trace = `${benignTrace()}${connect("/run/systemd/resolve/io.systemd.Resolve")}`;
      const r = await runWave(s.input, s.deps([text({ trace }), text()], { planSandbox: async () => plan }).deps);
      expect(r.stopReason).toBeNull();
      expect(r.records[0]).toMatchObject({ outcome: "scored", trace: { unresolvedEgress: 0 } });
      expect(existsSync(join(s.waveDir, "diagnostics"))).toBe(false);
    });

    it("still stops for a socket below a host path the plan binds in, and for one outside /tmp", async () => {
      for (const path of ["/tmp/ablation-build-x/run/x.sock", "/run/user/1000/bus"]) {
        const s = await waveSetup(2);
        const r = await runWave(s.input, s.deps([text({ trace: `${benignTrace()}${connect(path)}` })], { planSandbox: async () => bound }).deps);
        expect(r.stopReason, path).toBe("unresolved_egress");
        expect(await readFile(join(s.waveDir, "diagnostics", `${r.records[0]!.runId}.txt`), "utf8")).toContain(path);
      }
    });

    it("judges the oracle's trace with the bound dependency mounts as host paths", async () => {
      const s = await waveSetup(1, { kind: "implementation" });
      const scoring: WaveDeps["scoreImplementation"] = async (_clone, _task, options) => {
        const argv = options.wrap!(["npm", "test"]);
        await writeFile(argv[argv.indexOf("-o") + 1]!, prelude(9000) + connect("/tmp/codegraph-1.sock").replace("4242", "9000") + connect("/tmp/ablation-build-x/x.sock").replace("4242", "9000"));
        return { accepted: true, testsPassed: true, outOfScope: [] };
      };
      const r = await runWave(s.input, s.deps([text()], { scoreImplementation: scoring, planSandbox: async () => bound }).deps);
      expect(r.stopReason).toBe("unresolved_egress");
      expect(r.records[0]!.trace).toMatchObject({ unresolvedEgress: 1 });
    });
  });

  it("stops when the run leaves no strace log to audit", async () => {
    const s = await waveSetup(2);
    const r = await runWave(s.input, s.deps([text({ trace: null })]).deps);
    expect(r.stopReason).toBe("harness_failure");
    expect(r.records[0]!.harnessError).toBe("trace_missing");
  });

  it("scores turn_failed and continues", async () => {
    const s = await waveSetup(2);
    const r = await runWave(s.input, s.deps([{ output: { terminal: "failed" } }, text()]).deps);
    expect(r.stopReason).toBeNull();
    expect(r.records[0]).toMatchObject({ outcome: "scored", accepted: false, terminal: "failed", stopReason: null });
    expect(r.records[1]).toMatchObject({ outcome: "scored", accepted: true, terminal: "completed" });
    expect(r.records[1]!.review).toMatchObject({ criticalHit: 1, falseFindings: [], verdictMatched: true });
  });

  it("carries the verdict flag into the record and does not accept a review that omits the verdict (R78)", async () => {
    const s = await waveSetup(2);
    s.input.tasks = s.input.tasks.map((task) => (task.oracle.kind === "review" ? { ...task, oracle: { ...task.oracle, verdict: { pattern: "^verdict: ready$" } } } : task));
    s.input.approval = approvalFor(s.input.tasks, s.runs);
    const r = await runWave(s.input, s.deps([text({ text: `${GOOD_REVIEW}\nVerdict: ready` }), text()]).deps);
    expect(r.records[0]).toMatchObject({ outcome: "scored", accepted: true, review: { verdictMatched: true, criticalHit: 1 } });
    expect(r.records[1]).toMatchObject({ outcome: "scored", accepted: false, review: { verdictMatched: false, criticalHit: 1 } });
    // The record keeps the pattern's outcome only, never the pattern or the review text (record 0 holds the text with the verdict).
    for (const record of r.records) {
      const body = await readFile(join(s.waveDir, "runs", `${record.runId}.json`), "utf8");
      for (const leaked of ["Verdict: ready", "verdict: ready", "race in the cache refresh"]) expect(body).not.toContain(leaked);
    }
  });

  it("stops on a provider auth error instead of scoring it", async () => {
    const s = await waveSetup(2);
    const r = await runWave(s.input, s.deps([{ output: { terminal: "failed" }, providerError: "auth" }]).deps);
    expect(r.stopReason).toBe("provider_error");
    expect(r.records.map((x) => x.outcome)).toEqual(["stopped", "not_run"]);
  });

  it("keeps a plain provider error class 'other' as a scored failure", async () => {
    const s = await waveSetup(2);
    const r = await runWave(s.input, s.deps([{ output: { terminal: "failed" }, providerError: "other" }, text()]).deps);
    expect(r.stopReason).toBeNull();
    expect(r.records[0]).toMatchObject({ outcome: "scored", accepted: false });
  });

  it("stops on a start failure and on a harness error of the run unit", async () => {
    const a = await waveSetup(2);
    const started = await runWave(a.input, a.deps([{ output: { terminal: "start_failed", startErrorCode: "extension_load_failed" } }]).deps);
    expect(started.stopReason).toBe("harness_failure");
    expect(started.records[0]!.harnessError).toBe("start_failed");
    const b = await waveSetup(2);
    const harness = await runWave(b.input, b.deps([{ output: { terminal: "failed", harnessError: "unexpected_tool_result" } }]).deps);
    expect(harness.stopReason).toBe("harness_failure");
    expect(harness.records[0]!.harnessError).toBe("unexpected_tool_result");
  });

  it("stops on an open session and on a residual process", async () => {
    const a = await waveSetup(2);
    expect((await runWave(a.input, a.deps([text({ sessionsLeft: 1 })]).deps)).stopReason).toBe("cleanup_failure");
    const b = await waveSetup(2);
    expect((await runWave(b.input, b.deps([text()], { residualCheck: async () => false }).deps)).stopReason).toBe("cleanup_failure");
  });

  it("stops when a guarded production file changed", async () => {
    const s = await waveSetup(2);
    let calls = 0;
    const guard = async () => ({ files: { ".pi/agent/settings.json": ++calls === 1 ? "h1" : "h2" } });
    const r = await runWave(s.input, s.deps([text()], { guard }).deps);
    expect(r.stopReason).toBe("guard_changed");
    expect(r.records[0]).toMatchObject({ outcome: "stopped", accepted: null });
  });

  it("kills a hanging run at the run timeout, checks residuals and keeps the record", async () => {
    const s = await waveSetup(1, { runTimeoutMs: 300 });
    const { residualCheck: _unused, ...rest } = s.deps([{ hang: true }]).deps;
    const r = await runWave(s.input, rest);
    expect(r.records[0]!.terminal).toBe("timeout");
    expect(r.records[0]!.harnessError).toBe("run_timeout_killed");
    expect(r.stopReason).toBe("harness_failure");
    expect(existsSync(join(s.waveDir, "runs", `${r.records[0]!.runId}.json`))).toBe(true);
  });

  it("scores a turn the run unit timed out itself and continues", async () => {
    const s = await waveSetup(2);
    const r = await runWave(s.input, s.deps([{ output: { terminal: "timeout" } }, text()]).deps);
    expect(r.stopReason).toBeNull();
    // R34: the inner turn timeout is a scored timeout without a harness error; the outer kill is a harness_failure stop (see the hang test).
    expect(r.records[0]).toMatchObject({ outcome: "scored", accepted: false, terminal: "timeout", harnessError: null, stopReason: null });
  });

  it("stops before a run the budget cannot cover", async () => {
    const s = await waveSetup(3);
    const r = await runWave(s.input, s.deps([text({ cost: 9.5 })]).deps);
    expect(r.stopReason).toBe("budget");
    expect(r.spentUsd).toBeCloseTo(9.5);
    expect(r.records.map((x) => x.outcome)).toEqual(["scored", "not_run", "not_run"]);
    expect(r.records[1]!.stopReason).toBe("budget");
  });

  it("records cost for a stopped run too", async () => {
    const s = await waveSetup(2);
    const r = await runWave(s.input, s.deps([{ output: { terminal: "failed" }, providerError: "quota", cost: 0.4 }]).deps);
    expect(r.stopReason).toBe("provider_error");
    expect(r.spentUsd).toBeCloseTo(0.4);
  });

  it("stops before a run whose OAuth credential expires within 20 minutes", async () => {
    const s = await waveSetup(1, { hostAuth: { openai: { type: "oauth", access: "x", refresh: "y", expires: Date.now() + 5 * 60_000 } } });
    const { deps, captured } = s.deps([]);
    const r = await runWave(s.input, deps);
    expect(r.stopReason).toBe("credential_expiring");
    expect(r.records[0]!.outcome).toBe("not_run");
    expect(captured).toHaveLength(0);
  });

  it("stops at the wave time limit and on abort", async () => {
    const s = await waveSetup(3, { waveTimeoutMs: 1000 });
    let t = 0;
    const r = await runWave(s.input, s.deps([text()], { now: () => (t += 600) }).deps);
    expect(r.stopReason).toBe("wave_timeout");
    expect(r.records.map((x) => x.outcome)).toEqual(["scored", "not_run", "not_run"]);
    const b = await waveSetup(2);
    const controller = new AbortController();
    controller.abort();
    const aborted = await runWave({ ...b.input, signal: controller.signal }, b.deps([]).deps);
    expect(aborted.stopReason).toBe("interrupted");
    expect(aborted.records.map((x) => x.outcome)).toEqual(["not_run", "not_run"]);
  });

  it("kills the running group on abort and stops as interrupted", async () => {
    const s = await waveSetup(2, { runTimeoutMs: 60_000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const r = await runWave({ ...s.input, signal: controller.signal }, s.deps([{ hang: true }]).deps);
    expect(r.stopReason).toBe("interrupted");
    expect(r.records.map((x) => x.outcome)).toEqual(["stopped", "not_run"]);
  });
});

describe("runWave records and files", () => {
  it("passes the run id and the clone-rewritten prompt to the run unit", async () => {
    const s = await waveSetup(1);
    const { deps, captured } = s.deps([text()]);
    await runWave(s.input, deps);
    const input = captured[0]!.input;
    expect(input).toMatchObject({ runId: s.runs[0]!.runId, workspaceAlias: "clone", profile: "review", turnTimeoutMs: 14 * 60_000 });
    expect(input.promptText).toBe(`Review ${captured[0]!.scope.clone}/src/example.ts for defects.`);
    expect(input.promptText).not.toContain(SOURCE);
  });

  it("persists the ledger after each run", async () => {
    const s = await waveSetup(2);
    const seen: number[] = [];
    const { spawnRun, captured } = fake([text({ cost: 0.25 }), text({ cost: 0.5 })], s.root);
    const spy = (scope: RunScope, runInput: string, log: string): ChildProcess => {
      const file = s.input.ledgerPath;
      seen.push(existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { entries: unknown[] }).entries.length : 0);
      return spawnRun(scope, runInput, log);
    };
    const r = await runWave(s.input, { ...baseDeps(), spawnRun: spy });
    expect(seen).toEqual([0, 1]);
    expect(captured).toHaveLength(2);
    const ledger = JSON.parse(await readFile(s.input.ledgerPath, "utf8")) as { spentUsd: number; entries: { runId: string; costUsd: number | null }[] };
    expect(ledger.spentUsd).toBeCloseTo(0.75);
    expect(ledger.entries.map((e) => e.runId)).toEqual(s.runs.map((x) => x.runId));
    expect(r.spentUsd).toBeCloseTo(0.75);
  });

  it("continues from a ledger file an earlier preflight wrote", async () => {
    const s = await waveSetup(1);
    await writeFile(s.input.ledgerPath, JSON.stringify({ ledgerId: LEDGER_ID, limitUsd: 10, spentUsd: 9.5, entries: [{ runId: "preflight-review", profile: "review", costUsd: 9.5 }] }));
    const { deps, captured } = s.deps([text()]);
    const r = await runWave(s.input, deps);
    expect(r.stopReason).toBe("budget");
    expect(captured).toHaveLength(0);
  });

  it("keeps neither scope nor pristine clone for any run, accepted or not", async () => {
    const s = await waveSetup(2);
    const r = await runWave(s.input, s.deps([text(), { text: "no findings", output: {} }]).deps);
    const [ok, bad] = r.records as [RunRecord, RunRecord];
    expect(ok.accepted).toBe(true);
    expect(bad).toMatchObject({ outcome: "scored", accepted: false });
    expect(existsSync(scopeRoot(s.waveDir, ok.runId))).toBe(false);
    expect(existsSync(scopeRoot(s.waveDir, bad.runId))).toBe(false);
    // R38/R38b: no scope and no copy of the pristine bare clone is ever kept, accepted or not.
    expect(await findDirs(join(s.waveDir, "private"), "base.git")).toEqual([]);
    expect(existsSync(join(privateRunDir(s.waveDir, bad.runId), "scope"))).toBe(false);
    expect(existsSync(join(privateRunDir(s.waveDir, ok.runId), "scope"))).toBe(false);
  });

  it("writes every record exactly once", async () => {
    const s = await waveSetup(2);
    await runWave(s.input, s.deps([text()]).deps);
    expect((await readdir(join(s.waveDir, "runs"))).sort()).toEqual(s.runs.map((x) => `${x.runId}.json`).sort());
    await expect(runWave(s.input, s.deps([text()]).deps)).rejects.toThrow();
  });
});

describe("implementation oracle", () => {
  const score = (result: ImplementationScore): NonNullable<WaveDeps["scoreImplementation"]> => async () => result;

  it("scores an unreadable scope as not accepted and continues", async () => {
    const s = await waveSetup(2, { kind: "implementation" });
    const failing: WaveDeps["scoreImplementation"] = async () => { throw new Error("scope_unreadable"); };
    const r = await runWave(s.input, s.deps([text(), text()], { scoreImplementation: failing }).deps);
    expect(r.stopReason).toBeNull();
    expect(r.records[0]).toMatchObject({ outcome: "scored", accepted: false, implementation: { outOfScopeCount: 1, testsPassed: false } });
  });

  it("treats any other oracle failure as a harness failure", async () => {
    const s = await waveSetup(2, { kind: "implementation" });
    const failing: WaveDeps["scoreImplementation"] = async () => { throw new Error("base_has_submodules"); };
    const r = await runWave(s.input, s.deps([text()], { scoreImplementation: failing }).deps);
    expect(r.stopReason).toBe("harness_failure");
    expect(r.records[0]!.harnessError).toBe("oracle_failed");
  });

  it("scores an accepted implementation and skips the oracle for a failed turn", async () => {
    const s = await waveSetup(2, { kind: "implementation" });
    let calls = 0;
    const counting: WaveDeps["scoreImplementation"] = async (...args) => { calls += 1; return score({ accepted: true, testsPassed: true, outOfScope: [] })(...args); };
    const r = await runWave(s.input, s.deps([{ output: { terminal: "failed" } }, text()], { scoreImplementation: counting }).deps);
    expect(calls).toBe(1);
    expect(r.records.map((x) => x.accepted)).toEqual([false, true]);
  });

  it("audits the oracle's own strace log and stops on a write outside the scope", async () => {
    const s = await waveSetup(2, { kind: "implementation" });
    const tracing: WaveDeps["scoreImplementation"] = async (_clone, _task, options) => {
      const argv = options.wrap!(["npm", "test"]);
      expect(argv.slice(0, 1)).toEqual([TOOLS.strace]);
      expect(argv).toContain("--");
      const log = argv[argv.indexOf("-o") + 1]!;
      await writeFile(log, prelude(9000) + "9000 openat(AT_FDCWD</scope/clone>, \"/home/u/.npmrc\", O_WRONLY|O_CREAT, 0644) = 3</home/u/.npmrc>\n");
      return { accepted: true, testsPassed: true, outOfScope: [] };
    };
    const r = await runWave(s.input, s.deps([text()], { scoreImplementation: tracing }).deps);
    expect(r.stopReason).toBe("outside_write");
    expect(r.records[0]).toMatchObject({ outcome: "stopped", accepted: null, trace: { outsideWrites: 1 } });
    expect(await readFile(join(s.waveDir, "runs", `${r.records[0]!.runId}.json`), "utf8")).not.toContain(".npmrc");
  });

  it("allows the oracle to write into its own temporary home", async () => {
    const s = await waveSetup(1, { kind: "implementation" });
    const tracing: WaveDeps["scoreImplementation"] = async (_clone, _task, options) => {
      const argv = options.wrap!(["npm", "test"]);
      await writeFile(argv[argv.indexOf("-o") + 1]!, prelude(9000) + `9000 openat(AT_FDCWD</scope/clone>, "${options.home}/cache", O_WRONLY|O_CREAT, 0644) = 3<${options.home}/cache>\n`);
      return { accepted: true, testsPassed: true, outOfScope: [] };
    };
    const r = await runWave(s.input, s.deps([text()], { scoreImplementation: tracing }).deps);
    expect(r.stopReason).toBeNull();
    expect(r.records[0]).toMatchObject({ outcome: "scored", accepted: true });
  });
});

describe("task dependencies in a wave (R68)", () => {
  const DEPENDENCIES = [{ path: "backend/.venv", lockfile: "backend/uv.lock" }];
  const BINDS = [{ source: "/deps/T1/mounts/backend/.venv", target: "/scope/clone/backend/.venv" }, { source: "/deps/T1/runtime", target: "/deps/T1/runtime" }];

  async function dependentWave(count: number) {
    const s = await waveSetup(count, { kind: "implementation" });
    s.input.tasks = s.input.tasks.map((task) => ({ ...task, dependencies: DEPENDENCIES }));
    s.input.approval = approvalFor(s.input.tasks, s.runs);
    return s;
  }

  it("refuses to start without a deps directory when a pending run's task declares dependencies, before anything exists", async () => {
    const s = await dependentWave(1);
    const { deps, captured } = s.deps([text()]);
    await expect(runWave(s.input, deps)).rejects.toThrow("deps_missing");
    expect(captured).toHaveLength(0);
    expect(existsSync(s.waveDir)).toBe(false);
    // A wave without dependencies needs none.
    const plain = await waveSetup(1, { kind: "implementation" });
    await expect(runWave(plain.input, plain.deps([text()]).deps)).resolves.toMatchObject({ stopReason: null });
  });

  it("refuses a deps directory inside the evaluation repository, a workspace or the wave directory, or above one", async () => {
    const s = await dependentWave(1);
    const { deps } = s.deps([text()]);
    for (const dir of [join(s.root, "repo", "deps"), join(s.root, "repo"), "/src/example-repo/deps", "/src", join(s.waveDir, "deps"), s.root]) {
      await expect(runWave({ ...s.input, depsDir: dir }, deps)).rejects.toThrow("deps_dir_in_source");
    }
    expect(existsSync(s.waveDir)).toBe(false);
  });

  it("hands the deps directory to the scope and sandboxes the oracle with the scope's binds after the scope and oracle-home binds", async () => {
    const s = await dependentWave(1);
    const depsDir = join(s.root, "deps");
    const inputs: ScopeInput[] = [];
    let argv: string[] = [];
    const scoring: WaveDeps["scoreImplementation"] = async (_clone, _task, options) => {
      argv = options.wrap!(["env", "-C", "backend", ".venv/bin/python", "-m", "pytest"]);
      await writeFile(argv[argv.indexOf("-o") + 1]!, benignTrace());
      return { accepted: true, testsPassed: true, outOfScope: [] };
    };
    const { deps } = s.deps([text()], {
      prepareScope: async (input) => { inputs.push(input); return { ...await fakePrepare(input), dependencyBinds: BINDS }; }, scoreImplementation: scoring, checkDependencies: async () => undefined,
    });
    const result = await runWave({ ...s.input, depsDir }, deps);
    expect(result.stopReason).toBeNull();
    expect(inputs.map((input) => input.depsDir)).toEqual([depsDir]);
    const at = (flag: string, source: string, target: string) => argv.findIndex((arg, i) => arg === flag && argv[i + 1] === source && argv[i + 2] === target);
    const scopeBind = argv.findIndex((arg, i) => arg === "--bind" && argv[i + 1] === argv[i + 2] && argv[i + 1]!.includes("/scopes/"));
    const oracleHome = argv.findIndex((arg, i) => arg === "--bind" && argv[i + 1] === argv[i + 2] && argv[i + 1]!.endsWith("oracle-home"));
    expect(scopeBind).toBeGreaterThan(-1);
    expect(oracleHome).toBeGreaterThan(scopeBind);
    expect(at("--ro-bind", BINDS[0]!.source, BINDS[0]!.target)).toBeGreaterThan(oracleHome);
    expect(at("--ro-bind", BINDS[1]!.source, BINDS[1]!.target)).toBeGreaterThan(at("--ro-bind", BINDS[0]!.source, BINDS[0]!.target));
    expect(argv.slice(-6)).toEqual(["env", "-C", "backend", ".venv/bin/python", "-m", "pytest"]);
    // The record says nothing about where the dependencies are.
    const record = await readFile(join(s.waveDir, "runs", `${result.records[0]!.runId}.json`), "utf8");
    expect(record).not.toContain(depsDir);
    expect(record).not.toContain("/deps/");
  });

  it("refuses a deps directory that is not canonical (a link on its way), before anything exists", async () => {
    const s = await dependentWave(1);
    await mkdir(join(s.root, "real-deps"));
    await symlink(join(s.root, "real-deps"), join(s.root, "deps"));
    await expect(runWave({ ...s.input, depsDir: join(s.root, "deps") }, s.deps([text()]).deps)).rejects.toThrow("deps_dir_not_canonical");
    expect(existsSync(s.waveDir)).toBe(false);
  });

  it("checks the dependencies of every pending task before the first run: a wrong lock of a later task refuses the wave", async () => {
    const root = await temporaryRoot("ablation-wave-deps-");
    const source = join(root, "source");
    await mkdir(join(source, "backend"), { recursive: true });
    const git = (...args: string[]) => exec("git", ["-C", source, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args]);
    await git("init", "--quiet");
    await writeFile(join(source, "backend", "uv.lock"), "lock-v1\n");
    await git("add", "."); await git("commit", "--quiet", "-m", "base");
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    const s = await waveSetup(6, { kind: "implementation", productionConfig: { ...productionConfig, workspaces: { repo: source } } });
    // The wave directory and the evaluation repository are siblings of the source in the temporary root `waveSetup` made; the deps live in ours.
    s.input.tasks = s.input.tasks.map((task) => ({ ...task, baseCommit: base, dependencies: DEPENDENCIES }));
    s.input.approval = approvalFor(s.input.tasks, s.runs);
    const depsDir = join(root, "deps");
    for (const [id, lock] of [["T1", "lock-v1\n"], ["T2", "lock-v2\n"], ["T3", "lock-v1\n"]] as const) {
      await mkdir(join(depsDir, id, "mounts", "backend", ".venv"), { recursive: true });
      await mkdir(join(depsDir, id, "lock", "backend"), { recursive: true });
      await writeFile(join(depsDir, id, "lock", "backend", "uv.lock"), lock);
    }
    const { deps, captured } = s.deps([text()], { resolveTools: async () => ({ ...TOOLS, git: await resolveTool("git", process.env.PATH ?? "") }) });
    await expect(runWave({ ...s.input, depsDir }, deps)).rejects.toThrow("dependency_lock_mismatch");
    expect(captured).toHaveLength(0);
    expect(existsSync(s.waveDir)).toBe(false);
    // With the lock right, the up-front check passes and the scope check (fake here) is the only one left.
    await writeFile(join(depsDir, "T2", "lock", "backend", "uv.lock"), "lock-v1\n");
    await expect(runWave({ ...s.input, depsDir }, s.deps([text()], { resolveTools: async () => ({ ...TOOLS, git: await resolveTool("git", process.env.PATH ?? "") }) }).deps)).resolves.toMatchObject({ stopReason: null });
  });

  it("records a dependency check that fails as a fixed harness code and stops the wave", async () => {
    const s = await dependentWave(2);
    const { deps } = s.deps([text()], { prepareScope: async () => { throw new Error("dependency_lock_mismatch"); }, checkDependencies: async () => undefined });
    const result = await runWave({ ...s.input, depsDir: join(s.root, "deps") }, deps);
    expect(result.stopReason).toBe("harness_failure");
    expect(result.records.map((record) => [record.outcome, record.harnessError])).toEqual([["stopped", "dependency_lock_mismatch"], ["not_run", null]]);
  });
});

describe("approval", () => {
  it("rejects an approval whose bindings changed", async () => {
    const root = await temporaryRoot("ablation-approval-");
    const tasks = [await reviewTask(root, "A1")];
    const runs = buildMatrix(tasks, PAIRINGS);
    const approval = approvalFor(tasks, runs);
    const current = { sourceCommit: approval.sourceCommit, tasks, routes: approval.routes };
    expect(validateApproval(approval, current)).toEqual(approval);
    expect(() => validateApproval({ ...approval, tasksDigest: "sha256:0" }, current)).toThrow("approval_binding_changed");
    expect(() => validateApproval({ ...approval, matrixDigest: "sha256:0" }, current)).toThrow("approval_binding_changed");
    expect(() => validateApproval({ ...approval, sourceCommit: "d".repeat(40) }, current)).toThrow("approval_binding_changed");
    expect(() => validateApproval({ ...approval, routes: approval.routes.map((r) => ({ ...r, model: "other" })) }, current)).toThrow("approval_binding_changed");
    expect(() => validateApproval({ ...approval, approved: false }, current)).toThrow("approval_invalid");
    expect(() => validateApproval({ ...approval, budgetUsd: 11 }, current)).toThrow("approval_invalid");
    // R56: the approval's own run list is the list that runs; it must refer to known tasks, hold no duplicate and match its digest.
    const [first, ...rest] = approval.runs;
    expect(() => validateApproval({ ...approval, runs: [{ ...first!, taskId: "unknown" }, ...rest] }, current)).toThrow("approval_binding_changed");
    expect(() => validateApproval({ ...approval, runs: approval.runs.slice(0, 2) }, current)).toThrow("approval_binding_changed");
    expect(() => validateApproval({ ...approval, runs: [] }, current)).toThrow("approval_invalid");
    expect(() => validateApproval({ ...approval, ledgerId: "not-a-uuid" }, current)).toThrow("approval_invalid");
    const { ledgerId: _dropped, ...withoutLedger } = approval;
    expect(() => validateApproval(withoutLedger, current)).toThrow("approval_invalid");
  });

  it("makes runWave refuse a changed matrix before anything runs", async () => {
    const s = await waveSetup(2);
    const { deps, captured } = s.deps([]);
    // The approval's own list is the list that runs: a list that does not match its digest is refused.
    await expect(runWave({ ...s.input, approval: { ...s.input.approval, runs: s.runs.slice(0, 1) } }, deps)).rejects.toThrow("approval_binding_changed");
    expect(captured).toHaveLength(0);
  });
});

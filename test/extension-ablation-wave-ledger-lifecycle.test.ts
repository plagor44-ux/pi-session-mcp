import { type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { userInfo } from "node:os";
import { afterAll, describe, expect, it } from "vitest";
import { parseArgs, sourceCommit } from "../eval/extensions/cli.js";
import { buildMatrix, PAIRINGS } from "../eval/extensions/matrix.js";
import { dirtyBoundPaths, sourceIsDirty } from "../eval/extensions/bound.js";
import { realHome } from "../eval/extensions/tools.js";
import { assertPreflightPassed, runPreflight } from "../eval/extensions/preflight.js";
import { buildPlan } from "../eval/extensions/cli.js";
import { MAX_UNEXPECTED_CONNECTS, mergeTrace, summarizeTrace } from "../eval/extensions/classify.js";
import { PersistedLedger } from "../eval/extensions/ledger-file.js";
import { scoreImplementation } from "../eval/extensions/oracles.js";
import { writeEvidence } from "../eval/extensions/report.js";
import { taskSpecSchema } from "../eval/extensions/schemas.js";
import { runWave, type WaveDeps } from "../eval/extensions/wave.js";
import { privateRunDir, scopeRoot, type RunScope } from "../eval/extensions/workspace.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";
import { exec, productionConfig, GOOD_REVIEW, benignTrace, fake, reviewTask, implTask, approvalFor, seedLedger, seams, waveSetup, findFiles, LEDGER_ID, text, entriesOfLedger } from "./extension-ablation-wave-fixtures.js";

afterAll(removeTemporaryRoots);

describe("preflight cleanup and denied attempts", () => {
  it("fails the route with cleanup_failure when its scope cannot be removed, and keeps preflight.json failing", async () => {
    const root = await temporaryRoot("ablation-preflight-cleanup-");
    const waveDir = join(root, "w");
    const tasks = [await reviewTask(join(root, "repo"), "P1")];
    const approval = approvalFor(tasks, buildMatrix(tasks, PAIRINGS.filter((p) => p.id === "pl-review")));
    const { spawnRun } = fake([{ cost: 0.01, text: "PONG" }], root);
    const locking = (scope: RunScope, input: string): ChildProcess => {
      const locked = join(scope.root, "locked");
      mkdirSync(join(locked, "f"), { recursive: true });
      chmodSync(locked, 0o500);
      return spawnRun(scope, input, join(scope.root, "x.log"));
    };
    await seedLedger(join(root, "l.json"));
    const result = await runPreflight({ approval, waveDir, ledgerPath: join(root, "l.json"), productionConfig, hostAuth: { openai: { type: "api_key", key: "k" } } }, {
      ...seams(), spawnRun: locking, residualCheck: async () => true,
    });
    chmodSync(join(scopeRoot(waveDir, "preflight-review"), "locked"), 0o700);
    expect(result.routes).toMatchObject([{ profile: "review", ok: false, failure: "cleanup_failure" }]);
    await expect(assertPreflightPassed(waveDir, approval, join(root, "l.json"))).rejects.toThrow("preflight_failed");
  });

  it("records denied write attempts as a scored observation, not a stop", async () => {
    const s = await waveSetup(2);
    const denied = `${benignTrace()}4242 openat(AT_FDCWD</scope>, "/home/u/x", O_WRONLY|O_CREAT, 0644) = -1 EROFS (Read-only file system)\n`;
    const r = await runWave(s.input, s.deps([text({ trace: denied }), text()]).deps);
    expect(r.stopReason).toBeNull();
    expect(r.records[0]).toMatchObject({ outcome: "scored", trace: { deniedWriteAttempts: 1, outsideWrites: 0 } });
  });
});

describe("preflight spend and the cost of record (I2, I3)", () => {
  const entriesOf = async (path: string) => (JSON.parse(await readFile(path, "utf8")) as { entries: { runId: string; costUsd: number | null; estimated?: boolean; kind?: string }[] }).entries;

  it("keeps preflight costs out of the estimate: a later run without trusted output still charges the floor", async () => {
    const s = await waveSetup(2);
    const { spawnRun } = fake([{ cost: 0.01, text: "PONG" }], s.root);
    const pre = await runPreflight({ approval: s.input.approval, waveDir: join(s.root, "pre"), ledgerPath: s.input.ledgerPath, productionConfig, hostAuth: s.input.hostAuth }, {
      ...seams(), spawnRun: (scope, input) => spawnRun(scope, input, join(scope.root, "x.log")), residualCheck: async () => true,
    });
    expect(pre.routes.map((r) => r.ok)).toEqual([true]);
    // Before R54 this estimate would have been the PONG's USD 0.01.
    const r = await runWave(s.input, s.deps([text({ tamper: "cost" })]).deps);
    expect(r.stopReason).toBe("output_integrity");
    const entries = await entriesOf(s.input.ledgerPath);
    expect(entries[0]).toMatchObject({ runId: "preflight-review", costUsd: 0.01, kind: "preflight" });
    expect(entries[1]).toMatchObject({ runId: s.runs[0]!.runId, estimated: true });
    expect(entries[1]!.costUsd).toBeGreaterThanOrEqual(1);
    expect(r.spentUsd).toBeCloseTo(1.01);
  });

  it("replays a ledger with preflight entries to the same state", async () => {
    const path = join(await temporaryRoot("ablation-replay-"), "ledger.json");
    await seedLedger(path);
    const first = await PersistedLedger.openExisting(path, LEDGER_ID);
    await first.recordPreflight("preflight-review", "review", 0.4);
    await first.recordPreflight("preflight-code", "code", null);
    const second = await PersistedLedger.openExisting(path, LEDGER_ID);
    expect(second.ledger.spentUsd).toBeCloseTo(first.ledger.spentUsd);
    expect(second.ledger.estimate("review")).toBe(1);
    expect(second.ledger.estimate("code")).toBe(1);
    await second.record("001-t-review-A", "review", 0.2);
    expect((await PersistedLedger.openExisting(path)).ledger.estimate("review")).toBe(0.2);
  });

  it("charges the assistant usage sum, at least the estimate, when a trusted output has no session total but billed tokens", async () => {
    const s = await waveSetup(4);
    const none = { usage: { session: null, assistant: { messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }, providerError: null } };
    // A synthesized failure message: assistant messages, but not a single token, so nothing was billed (R11b).
    const synthesized = { usage: { session: null, assistant: { messages: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }, providerError: "other" } };
    const r = await runWave(s.input, s.deps([text({ cost: null, assistantCost: 1.5 }), text({ cost: null, assistantCost: 0.2 }), { text: GOOD_REVIEW, output: none }, { output: { terminal: "failed", ...synthesized } }]).deps);
    const entries = await entriesOf(s.input.ledgerPath);
    expect(entries[0]).toMatchObject({ runId: s.runs[0]!.runId, estimated: true, costUsd: 1.5 });
    expect(entries[1]).toMatchObject({ estimated: true });
    expect(entries[1]!.costUsd).toBeGreaterThanOrEqual(1);
    // Nothing billed at all (no session total, no assistant message): no cost of record.
    expect(entries[2]).toMatchObject({ runId: s.runs[2]!.runId, costUsd: null });
    expect(entries[2]!.estimated).toBeUndefined();
    // A zero-token failure message stays null as well and is not charged the estimate.
    expect(entries[3]).toMatchObject({ runId: s.runs[3]!.runId, costUsd: null });
    expect(entries[3]!.estimated).toBeUndefined();
    expect(r.records.map((x) => x.outcome)).toEqual(["scored", "scored", "scored", "scored"]);
  });

  it("fails a preflight route whose completed PONG has no session total (usage_missing)", async () => {
    const root = await temporaryRoot("ablation-usage-missing-");
    const tasks = [await reviewTask(join(root, "repo"), "P1")];
    const approval = approvalFor(tasks, buildMatrix(tasks, PAIRINGS.filter((p) => p.id === "pl-review")));
    await seedLedger(join(root, "l.json"));
    const { spawnRun } = fake([{ text: "PONG", cost: null, assistantCost: 0.07 }], root);
    const result = await runPreflight({ approval, waveDir: join(root, "w"), ledgerPath: join(root, "l.json"), productionConfig, hostAuth: { openai: { type: "api_key", key: "k" } } }, {
      ...seams(), spawnRun: (scope, input) => spawnRun(scope, input, join(scope.root, "x.log")), residualCheck: async () => true,
    });
    expect(result.routes).toMatchObject([{ profile: "review", ok: false, terminal: "completed", failure: "usage_missing" }]);
    // The assistant cost is still spend.
    expect(await entriesOf(join(root, "l.json"))).toMatchObject([{ kind: "preflight", costUsd: 0.07 }]);
    await expect(assertPreflightPassed(join(root, "w"), approval, join(root, "l.json"))).rejects.toThrow("preflight_failed");
  });
});

describe("one ledger across re-approvals (R55)", () => {
  it("refuses a missing ledger file and a ledger with another id, in the wave and in the preflight", async () => {
    const s = await waveSetup(1);
    await rm(s.input.ledgerPath);
    const { deps, captured } = s.deps([text()]);
    await expect(runWave(s.input, deps)).rejects.toThrow("ledger_missing");
    expect(existsSync(s.input.ledgerPath)).toBe(false);
    expect(captured).toHaveLength(0);
    await seedLedger(s.input.ledgerPath, [], "44444444-4444-4444-8444-444444444444");
    await expect(runWave(s.input, deps)).rejects.toThrow("ledger_mismatch");
    expect(existsSync(`${s.input.ledgerPath}.lock`)).toBe(false);
    await expect(runPreflight({ approval: s.input.approval, waveDir: join(s.root, "pre"), ledgerPath: s.input.ledgerPath, productionConfig, hostAuth: {} }, seams())).rejects.toThrow("ledger_mismatch");
    await rm(s.input.ledgerPath);
    await expect(runPreflight({ approval: s.input.approval, waveDir: join(s.root, "pre"), ledgerPath: s.input.ledgerPath, productionConfig, hostAuth: {} }, seams())).rejects.toThrow("ledger_missing");
    expect(existsSync(s.input.ledgerPath)).toBe(false);
  });

  it("lets only the plan create the ledger and records its id in the approval template", async () => {
    const root = await temporaryRoot("ablation-plan-ledger-");
    const repo = join(root, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) => exec("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args]);
    await git("init", "--quiet");
    await writeFile(join(repo, "a.txt"), "x");
    await git("add", "."); await git("commit", "--quiet", "-m", "base");
    const head = (await git("rev-parse", "HEAD")).stdout.trim();
    const tasks = [await reviewTask(join(root, "elsewhere"), "R1"), await implTask(join(root, "elsewhere"), "I1")];
    await writeFile(join(root, "tasks.json"), JSON.stringify(tasks));
    await writeFile(join(root, "config.json"), JSON.stringify(productionConfig));
    const ledgerPath = join(root, "new", "ledger.json");
    const args = ["--plan", "--tasks", join(root, "tasks.json"), "--config", join(root, "config.json"), "--ledger", ledgerPath];
    const first = await buildPlan(parseArgs(args), { sourceCwd: repo }) as { approvalTemplate: { ledgerId: string; runs: unknown[]; sourceCommit: string; matrixDigest: string } };
    expect(first.approvalTemplate.sourceCommit).toBe(head);
    expect(first.approvalTemplate.ledgerId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.approvalTemplate.runs.length).toBeGreaterThan(0);
    expect(JSON.parse(await readFile(ledgerPath, "utf8")).ledgerId).toBe(first.approvalTemplate.ledgerId);
    // A second plan against the same file reuses its id; without --ledger the template carries no id and cannot be approved.
    const again = await buildPlan(parseArgs(args), { sourceCwd: repo }) as typeof first;
    expect(again.approvalTemplate.ledgerId).toBe(first.approvalTemplate.ledgerId);
    const bare = await buildPlan(parseArgs(args.slice(0, -2)), { sourceCwd: repo }) as { approvalTemplate: { ledgerId: unknown; approved: boolean } };
    expect(bare.approvalTemplate).toMatchObject({ ledgerId: null, approved: false });
    // --trim puts the trimmed list into the template.
    const trimmed = await buildPlan(parseArgs([...args, "--trim"]), { sourceCwd: repo }) as typeof first;
    expect(trimmed.approvalTemplate.runs.length).toBeLessThanOrEqual(first.approvalTemplate.runs.length);
  });
});

describe("calibration, pause and resume (R56)", () => {
  it("pauses after --max-runs executed runs without a stop reason or not_run records, and writes status.json", async () => {
    const s = await waveSetup(4);
    const { deps, captured } = s.deps([text(), text(), text(), text()]);
    const r = await runWave({ ...s.input, maxRuns: 2 }, deps);
    expect(r.paused).toBe(true);
    expect(r.stopReason).toBeNull();
    expect(r.records.map((x) => x.outcome)).toEqual(["scored", "scored"]);
    expect(captured).toHaveLength(2);
    expect((await readdir(join(s.waveDir, "runs"))).sort()).toEqual(s.runs.slice(0, 2).map((x) => `${x.runId}.json`).sort());
    expect(JSON.parse(await readFile(join(s.waveDir, "status.json"), "utf8"))).toMatchObject({ state: "paused", stopReason: null, executedRuns: 2, recordedRuns: 2 });
    expect(existsSync(`${s.input.ledgerPath}.lock`)).toBe(false);
  });

  it("does not pause when --max-runs covers every run", async () => {
    const s = await waveSetup(2);
    const r = await runWave({ ...s.input, maxRuns: 2 }, s.deps([text(), text()]).deps);
    expect(r.paused).toBe(false);
    expect(JSON.parse(await readFile(join(s.waveDir, "status.json"), "utf8"))).toMatchObject({ state: "complete" });
  });

  it("resumes a paused wave with the runs that have no record yet, under the same approval and ledger", async () => {
    const s = await waveSetup(4);
    await runWave({ ...s.input, maxRuns: 2 }, s.deps([text(), text()]).deps);
    const approvalBefore = await readFile(join(s.waveDir, "approval.json"), "utf8");
    const resumed = s.deps([text(), text()]);
    const r = await runWave({ ...s.input, resume: true }, resumed.deps);
    expect(r.paused).toBe(false);
    expect(r.stopReason).toBeNull();
    expect(r.records.map((x) => x.runId)).toEqual(s.runs.slice(2).map((x) => x.runId));
    expect(resumed.captured).toHaveLength(2);
    expect((await readdir(join(s.waveDir, "runs"))).sort()).toEqual(s.runs.map((x) => `${x.runId}.json`).sort());
    expect(await readFile(join(s.waveDir, "approval.json"), "utf8")).toBe(approvalBefore);
    expect(JSON.parse(await readFile(join(s.waveDir, "status.json"), "utf8"))).toMatchObject({ state: "complete", recordedRuns: 4 });
    const ledger = await entriesOfLedger(s.input.ledgerPath);
    expect(ledger.map((e) => e.runId)).toEqual(s.runs.map((x) => x.runId));
  });

  it("resumes a paused wave repeatedly and honours --max-runs again", async () => {
    const s = await waveSetup(3);
    await runWave({ ...s.input, maxRuns: 1 }, s.deps([text()]).deps);
    const second = await runWave({ ...s.input, resume: true, maxRuns: 1 }, s.deps([text()]).deps);
    expect(second.paused).toBe(true);
    const third = await runWave({ ...s.input, resume: true }, s.deps([text()]).deps);
    expect(third.paused).toBe(false);
    expect((await readdir(join(s.waveDir, "runs"))).length).toBe(3);
  });

  it("refuses to resume a stopped wave, a complete one, a missing one and a different approval", async () => {
    const stopped = await waveSetup(3);
    const outside = `${benignTrace()}4242 openat(AT_FDCWD</scope>, "/home/u/x", O_WRONLY|O_CREAT, 0644) = 3</home/u/x>\n`;
    const first = await runWave(stopped.input, stopped.deps([text({ trace: outside })]).deps);
    expect(first.stopReason).toBe("outside_write");
    expect(JSON.parse(await readFile(join(stopped.waveDir, "status.json"), "utf8"))).toMatchObject({ state: "stopped", stopReason: "outside_write" });
    await expect(runWave({ ...stopped.input, resume: true }, stopped.deps([text()]).deps)).rejects.toThrow("wave_stopped");

    const complete = await waveSetup(1);
    await runWave(complete.input, complete.deps([text()]).deps);
    await expect(runWave({ ...complete.input, resume: true }, complete.deps([text()]).deps)).rejects.toThrow("wave_complete");

    const missing = await waveSetup(1);
    await expect(runWave({ ...missing.input, resume: true }, missing.deps([text()]).deps)).rejects.toThrow("resume_invalid");

    const paused = await waveSetup(3);
    await runWave({ ...paused.input, maxRuns: 1 }, paused.deps([text()]).deps);
    const other = { ...paused.input.approval, approvedAt: "2026-10-21T00:00:00Z" };
    const mismatched = paused.deps([text()]);
    await expect(runWave({ ...paused.input, approval: other, resume: true }, mismatched.deps)).rejects.toThrow("resume_approval_mismatch");
    expect(mismatched.captured).toHaveLength(0);
    // Without --resume an existing wave directory is refused, even a paused one.
    await expect(runWave(paused.input, paused.deps([text()]).deps)).rejects.toThrow("output_exists");
  });

  it("applies the same guard on resume: a guarded file that changed while the wave was paused stops it before the next run", async () => {
    const s = await waveSetup(3);
    let value = "h1";
    const guard = async () => ({ files: { ".pi/agent/settings.json": value } });
    await runWave({ ...s.input, maxRuns: 1 }, { ...s.deps([text()]).deps, guard });
    value = "h2";
    const resumed = s.deps([text()], { guard });
    const r = await runWave({ ...s.input, resume: true }, resumed.deps);
    expect(r.stopReason).toBe("guard_changed");
    expect(resumed.captured).toHaveLength(0);
    expect(r.records.map((x) => x.outcome)).toEqual(["not_run", "not_run"]);
  });

  it("refuses leftovers of a crashed run on resume and still checks the shared ledger", async () => {
    const s = await waveSetup(3);
    await runWave({ ...s.input, maxRuns: 1 }, s.deps([text()]).deps);
    mkdirSync(privateRunDir(s.waveDir, s.runs[1]!.runId), { recursive: true });
    await expect(runWave({ ...s.input, resume: true }, s.deps([text()]).deps)).rejects.toThrow("output_exists");
    await rm(privateRunDir(s.waveDir, s.runs[1]!.runId), { recursive: true });
    await rm(s.input.ledgerPath);
    await expect(runWave({ ...s.input, resume: true }, s.deps([text()]).deps)).rejects.toThrow("ledger_missing");
  });

  it("writes the approval the wave ran under", async () => {
    const s = await waveSetup(1);
    await runWave(s.input, s.deps([text()]).deps);
    expect(JSON.parse(await readFile(join(s.waveDir, "approval.json"), "utf8"))).toEqual(JSON.parse(JSON.stringify(s.input.approval)));
  });
});

describe("records: auth type and capped connects", () => {
  it("records the credential type of the run's provider, also for runs that did not run", async () => {
    const s = await waveSetup(2, { hostAuth: { openai: { type: "oauth", access: "a", refresh: "", expires: Date.now() + 3_600_000 } } });
    const r = await runWave({ ...s.input, maxRuns: 1 }, s.deps([text()]).deps);
    expect(r.records[0]!.authType).toBe("oauth");
    const keyed = await waveSetup(1, { hostAuth: { openai: { type: "api_key", key: "k" } } });
    expect((await runWave(keyed.input, keyed.deps([text()]).deps)).records[0]!.authType).toBe("api_key");
    const expiring = await waveSetup(1, { hostAuth: { openai: { type: "oauth", access: "a", refresh: "", expires: Date.now() + 60_000 } } });
    const notRun = (await runWave(expiring.input, expiring.deps([]).deps)).records[0]!;
    expect(notRun).toMatchObject({ outcome: "not_run", authType: "oauth" });
    const unknown = await waveSetup(1, { hostAuth: {} });
    expect((await runWave(unknown.input, unknown.deps([text()]).deps)).records[0]!.authType).toBeNull();
  });

  it("keeps at most 50 evidence entries when traces are merged, the run's own lines first", () => {
    const trace = (prefix: string, count: number) => ({
      outsideWrites: [], unresolvedWrites: 0, deniedWriteAttempts: 0, unexpectedConnects: [], connects: 0, unresolvedEgress: 0,
      evidenceLines: Array.from({ length: count }, (_, i) => `${prefix}${i}`),
    });
    const merged = mergeTrace(trace("run-", 30), trace("oracle-", 30));
    expect(merged.evidenceLines).toHaveLength(50);
    expect(merged.evidenceLines.slice(0, 30)).toEqual(trace("run-", 30).evidenceLines);
    expect(merged.evidenceLines[30]).toBe("oracle-0");
    expect(merged.evidenceLines.at(-1)).toBe("oracle-19");
    expect(summarizeTrace(merged)).not.toHaveProperty("evidenceLines");
  });

  it("caps the unexpected connects in a record and keeps their number", () => {
    const connects = Array.from({ length: 25 }, (_, i) => ({ family: "inet" as const, address: `203.0.113.${i}`, port: 443 }));
    const summary = summarizeTrace({ outsideWrites: [], unresolvedWrites: 0, deniedWriteAttempts: 0, unexpectedConnects: connects, connects: 25, unresolvedEgress: 0, evidenceLines: [] });
    expect(summary.unexpectedConnects).toHaveLength(MAX_UNEXPECTED_CONNECTS);
    expect(MAX_UNEXPECTED_CONNECTS).toBe(20);
    expect(summary.unexpectedConnectCount).toBe(25);
    expect(summary.unexpectedConnects[0]).toEqual(connects[0]);
  });
});

describe("ledger lock and save order (item 11)", () => {
  it("takes an exclusive lock, refuses a second holder and a stale lock, and releases", async () => {
    const root = await temporaryRoot("ablation-ledger-lock-");
    const path = join(root, "ledger.json");
    await seedLedger(path);
    const first = await PersistedLedger.openExisting(path);
    await first.lock();
    expect(existsSync(`${path}.lock`)).toBe(true);
    const second = await PersistedLedger.openExisting(path);
    await expect(second.lock()).rejects.toThrow("ledger_locked");
    await first.release();
    expect(existsSync(`${path}.lock`)).toBe(false);
    await second.lock();
    await second.release();
    await second.release();
    // A stale lock (a crashed process) stays until the operator removes it; the wave refuses without touching anything.
    await writeFile(`${path}.lock`, "");
    const s = await waveSetup(1);
    await writeFile(`${s.input.ledgerPath}.lock`, "");
    const { deps, captured } = s.deps([text()]);
    await expect(runWave(s.input, deps)).rejects.toThrow("ledger_locked");
    expect(captured).toHaveLength(0);
    expect(existsSync(`${s.input.ledgerPath}.lock`)).toBe(true);
  });

  it("releases the lock when the wave fails and when the preflight finishes", async () => {
    const s = await waveSetup(1);
    const { deps } = s.deps([text()], { resolveAddresses: async () => { throw new Error("provider_host_unresolvable"); } });
    await expect(runWave(s.input, deps)).rejects.toThrow("provider_host_unresolvable");
    expect(existsSync(`${s.input.ledgerPath}.lock`)).toBe(false);
    const { spawnRun } = fake([{ cost: 0.01, text: "PONG" }], s.root);
    await runPreflight({ approval: s.input.approval, waveDir: join(s.root, "pre"), ledgerPath: s.input.ledgerPath, productionConfig, hostAuth: s.input.hostAuth }, {
      ...seams(), spawnRun: (scope, input) => spawnRun(scope, input, join(scope.root, "x.log")), residualCheck: async () => true,
    });
    expect(existsSync(`${s.input.ledgerPath}.lock`)).toBe(false);
  });

  it("saves before it updates the in-memory state, so a failed save changes neither", async () => {
    const root = await temporaryRoot("ablation-ledger-order-");
    const dir = join(root, "ro");
    const path = join(dir, "ledger.json");
    await seedLedger(path);
    const ledger = await PersistedLedger.openExisting(path);
    await ledger.record("001-a-review-A", "review", 0.25);
    chmodSync(dir, 0o500);
    try {
      await expect(ledger.record("002-a-review-A", "review", 0.5)).rejects.toThrow();
      expect(ledger.ledger.spentUsd).toBeCloseTo(0.25);
      expect(ledger.hasEntry("002-a-review-A")).toBe(false);
    } finally { chmodSync(dir, 0o700); }
    await ledger.record("002-a-review-A", "review", 0.5);
    expect(ledger.ledger.spentUsd).toBeCloseTo(0.75);
    // A cost the ledger would reject leaves no entry either.
    await expect(ledger.record("003-a-review-A", "review", -1)).rejects.toThrow("invalid_cost");
    expect(ledger.hasEntry("003-a-review-A")).toBe(false);
  });
});

describe("oracle deadline and abort (item 10)", () => {
  it("caps the oracle timeout at ten minutes in the task schema", async () => {
    const root = await temporaryRoot("ablation-oracle-cap-");
    const task = await implTask(root, "C1");
    expect(taskSpecSchema.safeParse(task).success).toBe(true);
    expect(taskSpecSchema.safeParse({ ...task, oracle: { ...task.oracle, timeoutMs: 600_000 } }).success).toBe(true);
    expect(taskSpecSchema.safeParse({ ...task, oracle: { ...task.oracle, timeoutMs: 600_001 } }).success).toBe(false);
  });

  it("passes the wave's signal to the oracle and stops as interrupted when it fires during scoring", async () => {
    const s = await waveSetup(2, { kind: "implementation" });
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const aborting: WaveDeps["scoreImplementation"] = async (_clone, _task, options) => {
      seen = options.signal;
      controller.abort();
      return { accepted: false, testsPassed: false, outOfScope: [] };
    };
    const { deps } = s.deps([text(), text()], { scoreImplementation: aborting });
    const r = await runWave({ ...s.input, signal: controller.signal }, deps);
    expect(seen).toBe(controller.signal);
    expect(r.stopReason).toBe("interrupted");
    expect(r.records.map((x) => x.outcome)).toEqual(["stopped", "not_run"]);
  });

  it("kills a running oracle command when the signal fires, without waiting for its deadline", async () => {
    const root = await temporaryRoot("ablation-oracle-abort-");
    const source = join(root, "source");
    mkdirSync(source);
    const git = (...args: string[]) => exec("git", ["-C", source, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args]);
    await git("init", "--quiet");
    await writeFile(join(source, "a.txt"), "base");
    await git("add", "."); await git("commit", "--quiet", "-m", "base");
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    const bare = join(root, "base.git");
    await exec("git", ["clone", "--bare", "--quiet", source, bare]);
    const clone = join(root, "clone");
    await exec("git", ["clone", "--quiet", bare, clone]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const started = Date.now();
    const result = await scoreImplementation(clone, {
      allowedPaths: [], scopeIgnore: [], baseCommit: base, oracle: { kind: "implementation", command: ["sleep", "30"], timeoutMs: 120_000 },
    }, { gitDir: bare, signal: controller.signal });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.testsPassed).toBe(false);
  });
});

describe("explicit exit of the run unit (item 12)", () => {
  it("ends run-one and the dry-load entry with an explicit process.exit once the output is written", async () => {
    for (const file of ["run-one.ts", "dry-load-entry.ts"]) {
      const source = await readFile(join(process.cwd(), "eval", "extensions", file), "utf8");
      const tail = source.slice(source.lastIndexOf("isEntryPoint(import.meta.url"));
      expect(tail).toMatch(/process\.exit\(code\)/);
      expect(tail).not.toMatch(/process\.exitCode\s*=/);
    }
  });
});

describe("end to end: wave output into the evidence (item 14)", () => {
  it("feeds real runWave records, ledger and approval into writeEvidence", async () => {
    const root = await temporaryRoot("ablation-e2e-");
    const repo = join(root, "bound-repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "src", "a.ts"), "export const a = 1;\n");
    const git = (...args: string[]) => exec("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args]);
    await git("init", "--quiet");
    await git("add", "."); await git("commit", "--quiet", "-m", "base");
    const head = (await git("rev-parse", "HEAD")).stdout.trim();

    const s = await waveSetup(6, { sourceCommit: head });
    // Three tasks, both arms: arm B finds the race that arm A misses on the first task.
    const steps = [text({ cost: 0.05 }), text({ cost: 0.07 }), text({ cost: 0.05 }), text({ cost: 0.06 }), text({ cost: 0.05 }), text({ cost: 0.08 })];
    const r = await runWave(s.input, s.deps(steps).deps);
    expect(r.stopReason).toBeNull();
    expect(r.records.every((x) => x.outcome === "scored")).toBe(true);

    const evidenceDir = join(root, "evidence");
    const summary = await writeEvidence([s.waveDir], evidenceDir, s.input.ledgerPath, { repoRoot: repo });
    const copied = (await readdir(join(evidenceDir, "runs"))).sort();
    expect(copied).toEqual(s.runs.map((x) => `${x.runId}.json`).sort());
    for (const name of copied) expect(await readFile(join(evidenceDir, "runs", name), "utf8")).toBe(await readFile(join(s.waveDir, "runs", name), "utf8"));
    expect(await readFile(join(evidenceDir, "approvals", "approval-1.json"), "utf8")).toBe(await readFile(join(s.waveDir, "approval.json"), "utf8"));
    expect(await readFile(join(evidenceDir, "ledger.json"), "utf8")).toBe(await readFile(s.input.ledgerPath, "utf8"));
    const integrity = JSON.parse(await readFile(join(evidenceDir, "integrity.json"), "utf8")) as { source_binding: { commit: string }; files: { path: string }[] };
    expect(integrity.source_binding.commit).toBe(head);
    expect(integrity.files.map((f) => f.path)).toEqual(expect.arrayContaining(["summary.json", "ledger.json", "approvals/approval-1.json"]));
    const pairingResult = summary.pairings.find((p) => p.id === "pl-review")!;
    expect(pairingResult).toMatchObject({ complete: true });
    expect(pairingResult.tasks).toHaveLength(3);
    // R78/R83: the review scores of the real records reach the summary as description; a review pairing has no recommendation.
    expect(pairingResult).toMatchObject({ kind: "review", recommendation: "descriptive" });
    for (const arm of [pairingResult.a, pairingResult.b]) {
      expect(arm).toMatchObject({ scored: 3, reviewScored: 3, verdictMatched: 3, criticalHitSum: 3, criticalTotalSum: 3, falseFindingRuns: 0, oracleAccepted: 3 });
      expect(arm).not.toHaveProperty("accepted");
    }
    expect(summary.spentUsd).toBeCloseTo(0.36);
    expect(summary.stopReason).toBeNull();
    for (const file of await findFiles(evidenceDir, /./)) {
      const body = await readFile(file, "utf8");
      expect(body).not.toContain(root);
      expect(body).not.toContain("sk-");
    }
  });
});

describe("source binding of approvals (I6a) and the real home (item 8)", () => {
  it("refuses untracked files under a bound path, but not elsewhere", async () => {
    const root = await temporaryRoot("ablation-source-bound-");
    const git = (...args: string[]) => exec("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args]);
    await git("init", "--quiet");
    await writeFile(join(root, "a.txt"), "1");
    await git("add", "."); await git("commit", "--quiet", "-m", "one");
    const head = (await git("rev-parse", "HEAD")).stdout.trim();
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "note.md"), "x");
    await writeFile(join(root, "untracked.txt"), "x");
    expect(await sourceCommit(root)).toBe(head);
    for (const path of ["eval/extensions/new.ts", "src/new.ts", "test/new.test.ts", "scripts/new.mjs", "package.json", "tsconfig.extra.json"]) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), "x");
      await expect(sourceCommit(root)).rejects.toThrow("source_dirty");
      await rm(join(root, path));
    }
    expect(await sourceCommit(root)).toBe(head);
    expect(sourceIsDirty("?? docs/x\0")).toBe(false);
    expect(sourceIsDirty("?? eval/extensions/x.ts\0")).toBe(true);
    expect(sourceIsDirty(" M docs/x\0")).toBe(true);
    expect(sourceIsDirty("!! eval/extensions/ignored.ts\0")).toBe(false);
    expect(dirtyBoundPaths("R  eval/extensions/b.ts\0docs/old.md\0?? docs/y\0")).toEqual(["eval/extensions/b.ts"]);
  });

  it("takes the guarded home from the account database, not from $HOME", () => {
    const previous = process.env.HOME;
    process.env.HOME = "/nonexistent-home-for-test";
    try { expect(realHome()).toBe(userInfo().homedir); expect(realHome()).not.toBe("/nonexistent-home-for-test"); } finally { process.env.HOME = previous; }
  });
});

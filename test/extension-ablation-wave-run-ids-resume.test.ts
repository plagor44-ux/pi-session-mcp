import { existsSync, mkdirSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { matrixDigest, validateApproval, type Approval } from "../eval/extensions/approval.js";
import { parseArgs } from "../eval/extensions/cli.js";
import { buildMatrix, PAIRINGS } from "../eval/extensions/matrix.js";
import { runPreflight } from "../eval/extensions/preflight.js";
import type { RunSpec } from "../eval/extensions/schemas.js";
import { buildPlan } from "../eval/extensions/cli.js";
import { PersistedLedger } from "../eval/extensions/ledger-file.js";
import { writeEvidence } from "../eval/extensions/report.js";
import { runWave, type RunRecord, type WaveDeps, type WaveInput } from "../eval/extensions/wave.js";
import { privateRunDir } from "../eval/extensions/workspace.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";
import { exec, productionConfig, prelude, benignTrace, type Step, fake, reviewTask, type Setup, approvalFor, seedLedger, seams, waveSetup, baseDeps, findFiles, LEDGER_ID, text } from "./extension-ablation-wave-fixtures.js";

afterAll(removeTemporaryRoots);

/** The real route of the operator: `--plan` to approval, a (calibration) wave, re-plan with `--exclude-wave`, a new approval, a report over both waves. */
describe("canonical run ids, exclusion and the two-wave report (R58-R60)", () => {
  async function flow() {
    const root = await temporaryRoot("ablation-flow-");
    const repo = join(root, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) => exec("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args]);
    await git("init", "--quiet");
    await writeFile(join(repo, "a.txt"), "x");
    await git("add", "."); await git("commit", "--quiet", "-m", "base");
    const sources = join(root, "elsewhere");
    const tasks = await Promise.all(["R1", "R2", "R3"].map((id) => reviewTask(sources, id)));
    const tasksFile = join(root, "tasks.json");
    const configFile = join(root, "config.json");
    const ledgerPath = join(root, "ledger", "ledger.json");
    await writeFile(tasksFile, JSON.stringify(tasks));
    await writeFile(configFile, JSON.stringify(productionConfig));
    type Plan = { exclusion?: { waves: { wave: string; executed: number }[]; ledgerOnly: number; removed: number; resumable: string | null };
      matrix: { count: number; projectedUsd: number; runs: { runId: string; ordinal: number; taskId: string; profile: string; arm: string; pairings: string[] }[] };
      trimmed: { remainingUsd: number }; approvalTemplate: Record<string, unknown> & { runs: RunSpec[] } };
    const plan = async (...extra: string[]): Promise<Plan> =>
      await buildPlan(parseArgs(["--plan", "--tasks", tasksFile, "--config", configFile, "--ledger", ledgerPath, ...extra]), { sourceCwd: repo }) as unknown as Plan;
    const approve = (p: Plan): Approval => ({ ...p.approvalTemplate, approved: true, approvedAt: "2026-10-21T00:00:00Z" }) as unknown as Approval;
    const hostAuth = { openai: { type: "oauth", access: "a", refresh: "", expires: Date.now() + 3_600_000 }, xai: { type: "api_key", key: "k" } };
    const wave = (approval: Approval, name: string, steps: Step[], extra: Partial<WaveInput> = {}) => {
      const { spawnRun, captured } = fake(steps, root);
      const waveDir = join(root, name);
      return { waveDir, captured, run: () => runWave({ approval, tasks, waveDir, ledgerPath, productionConfig, hostAuth, extensionTemplate: join(root, "template"), repoRoot: sources, killGraceMs: 0, ...extra }, { ...baseDeps(), spawnRun }) };
    };
    const report = (dirs: string[], evidence = "evidence") => writeEvidence(dirs, join(root, evidence), ledgerPath, { repoRoot: repo });
    return { root, repo, tasks, tasksFile, ledgerPath, plan, approve, wave, report, git };
  }

  it("keeps the full matrix's run ids, ordinals and order in a --pairings and a --trim plan", async () => {
    const f = await flow();
    const full = await f.plan();
    expect(full.matrix.count).toBe(15);
    expect(full.matrix.runs.map((r) => r.ordinal)).toEqual(full.matrix.runs.map((_, i) => i + 1));
    const byId = new Map(full.matrix.runs.map((r) => [r.runId, r]));
    const subset = await f.plan("--pairings", "pl-review");
    expect(subset.matrix.count).toBe(6);
    expect(subset.matrix.runs.map((r) => r.ordinal)).not.toEqual(subset.matrix.runs.map((_, i) => i + 1));
    const trimmed = await f.plan("--trim");
    expect(trimmed.matrix.count).toBeLessThan(15);
    for (const plan of [subset, trimmed]) {
      for (const run of plan.matrix.runs) expect({ ...run, pairings: 0 }).toEqual({ ...byId.get(run.runId)!, pairings: 0 });
      expect(plan.matrix.runs.map((r) => r.ordinal)).toEqual(plan.matrix.runs.map((r) => r.ordinal).sort((a, b) => a - b));
      expect(plan.approvalTemplate.runs.map((r) => r.runId)).toEqual(plan.matrix.runs.map((r) => r.runId));
    }
    // The pairings of a run stay the subset that selected it in this plan.
    expect(subset.matrix.runs.find((r) => r.arm === "A")!.pairings).toEqual(["pl-review"]);
    expect(byId.get(subset.matrix.runs.find((r) => r.arm === "A")!.runId)!.pairings).toEqual(["pl-review", "co-review"]);
    // The canonical runs are valid approval content (R62b).
    expect(() => validateApproval(f.approve(subset), { sourceCommit: f.approve(subset).sourceCommit, tasks: f.tasks })).not.toThrow();
  });

  it("excludes the calibration runs, reports resumable when the list is unchanged, and resumes under the same approval", async () => {
    const f = await flow();
    const approval1 = f.approve(await f.plan());
    const w1 = f.wave(approval1, "wave-1", [text({ cost: 0.1 }), text({ cost: 0.1 })], { maxRuns: 2 });
    expect((await w1.run()).paused).toBe(true);
    const again = await f.plan("--trim", "--exclude-wave", w1.waveDir);
    expect(again.exclusion).toEqual({ waves: [{ wave: "wave-1", executed: 2 }], ledgerOnly: 0, removed: 2, resumable: "wave-1", replannedStopped: [], notReplanned: [] });
    expect(JSON.stringify(again.exclusion)).not.toContain(f.root);
    expect(again.matrix.runs.map((r) => r.runId)).toEqual(approval1.runs.slice(2).map((r) => r.runId));
    expect(again.matrix.count).toBe(13);
    // The projection covers the 13 runs that remain: 4 observed grok runs at USD 0.1 and 9 unobserved review runs at the USD 1 floor.
    expect(again.matrix.projectedUsd).toBeCloseTo(0.4 + 9);
    expect(again.trimmed.remainingUsd).toBeCloseTo(9.8);
    const w1again = f.wave(approval1, "wave-1", Array.from({ length: 13 }, () => text({ cost: 0.1 })), { resume: true });
    const resumed = await w1again.run();
    expect(resumed.paused).toBe(false);
    expect(resumed.records).toHaveLength(13);
    expect((await readdir(join(w1.waveDir, "runs"))).length).toBe(15);
  });

  it("re-plans after calibration with a forced trim: no resume, a new approval, a fresh wave and one report over both", async () => {
    const f = await flow();
    const full = await f.plan();
    const approval1 = f.approve(full);
    const w1 = f.wave(approval1, "wave-1", [text({ cost: 0.5 }), text({ cost: 0.5 })], { maxRuns: 2 });
    await w1.run();
    const again = await f.plan("--trim", "--exclude-wave", w1.waveDir);
    expect(again.exclusion).toMatchObject({ removed: 2, resumable: null });
    expect(again.matrix.count).toBe(10);
    expect(again.matrix.runs.every((r) => !approval1.runs.slice(0, 2).some((x) => x.runId === r.runId))).toBe(true);
    // Only the runs that remain are projected: 4 grok runs at USD 0.5 and 6 review runs at the USD 1 floor.
    expect(again.matrix.projectedUsd).toBeCloseTo(2 + 6);
    expect(again.trimmed.remainingUsd).toBeCloseTo(9);
    const approval2 = f.approve(again);
    expect(approval2.runs[0]!.runId).toBe(full.matrix.runs[2]!.runId);
    const w2 = f.wave(approval2, "wave-2", Array.from({ length: 10 }, () => text({ cost: 0.05 })));
    const second = await w2.run();
    expect(second.stopReason).toBeNull();
    expect(w2.captured).toHaveLength(10);
    const summary = await f.report([w1.waveDir, w2.waveDir]);
    const copied = (await readdir(join(f.root, "evidence", "runs"))).sort();
    expect(copied).toHaveLength(12);
    expect(new Set(copied).size).toBe(12);
    expect((await readdir(join(f.root, "evidence", "approvals"))).sort()).toEqual(["approval-1.json", "approval-2.json"]);
    expect(summary.pairings.find((p) => p.id === "pl-review-grok")).toMatchObject({ complete: true, tasks: ["R1", "R2", "R3"] });
    expect(summary.pairings.find((p) => p.id === "pl-review")).toMatchObject({ complete: true, tasks: ["R1", "R2", "R3"] });
    expect(summary.pairings.find((p) => p.id === "co-review")).toMatchObject({ kind: "review", recommendation: "descriptive", tasks: [] });
    // Wave 1 alone is reported with only its own spend.
    expect(summary.waveSpend.observedUsd).toBeCloseTo(1 + 10 * 0.05);
    expect(summary.budgetSpend.observedUsd).toBeCloseTo(1 + 10 * 0.05);
  });

  it("includes the not_run slots of a stopped wave, lets wave 2 execute some, and the report lets executed records replace not_run", async () => {
    const f = await flow();
    const full = await f.plan();
    const approval1 = f.approve(full);
    // A stop that is not an audit stop: the first run left no strace log.
    const w1 = f.wave(approval1, "wave-1", [text({ trace: null })]);
    expect((await w1.run()).stopReason).toBe("harness_failure");
    expect(existsSync(join(w1.waveDir, "diagnostics"))).toBe(false);
    const again = await f.plan("--exclude-wave", w1.waveDir);
    expect(again.exclusion).toEqual({ waves: [{ wave: "wave-1", executed: 1 }], ledgerOnly: 0, removed: 1, resumable: null, replannedStopped: [], notReplanned: [] });
    expect(again.matrix.runs.map((r) => r.runId)).toEqual(approval1.runs.slice(1).map((r) => r.runId));
    const approval2 = f.approve(again);
    const w2 = f.wave(approval2, "wave-2", [text(), text(), text()], { maxRuns: 3 });
    expect((await w2.run()).paused).toBe(true);
    const summary = await f.report([w1.waveDir, w2.waveDir]);
    const files = (await readdir(join(f.root, "evidence", "runs"))).sort();
    expect(files).toEqual(approval1.runs.map((r) => `${r.runId}.json`).sort());
    const outcome = async (dir: string, run: RunSpec) => (JSON.parse(await readFile(join(dir, "runs", `${run.runId}.json`), "utf8")) as RunRecord).outcome;
    for (const run of approval1.runs.slice(1, 4)) {
      expect(await outcome(w1.waveDir, run)).toBe("not_run");
      expect(await readFile(join(f.root, "evidence", "runs", `${run.runId}.json`), "utf8")).toBe(await readFile(join(w2.waveDir, "runs", `${run.runId}.json`), "utf8"));
    }
    for (const run of approval1.runs.slice(4)) expect(await outcome(join(f.root, "evidence"), run)).toBe("not_run");
    expect(summary.stopReason).toBe("harness_failure");
  });

  describe("a slot stopped by the trace audit (R84, R85)", () => {
    const outside = `${benignTrace()}4242 openat(AT_FDCWD</scope>, "/home/u/x", O_WRONLY|O_CREAT, 0644) = 3</home/u/x>\n`;

    it("keeps the causing log lines privately on the stop, and only then", async () => {
      const f = await flow();
      const approval1 = f.approve(await f.plan());
      const w1 = f.wave(approval1, "wave-1", [text({ trace: outside })]);
      expect((await w1.run()).stopReason).toBe("outside_write");
      const runId = approval1.runs[0]!.runId;
      expect(await readdir(join(w1.waveDir, "diagnostics"))).toEqual([`${runId}.txt`]);
      const kept = await readFile(join(w1.waveDir, "diagnostics", `${runId}.txt`), "utf8");
      expect(kept).toContain('openat(AT_FDCWD</scope>, "/home/u/x"');
      expect(kept.split("\n").every((line) => line.length <= 1000)).toBe(true);
      expect((await stat(join(w1.waveDir, "diagnostics", `${runId}.txt`))).mode & 0o777).toBe(0o600);
      // The record has no trace lines, and the private run directory is gone as before.
      const record = await readFile(join(w1.waveDir, "runs", `${runId}.json`), "utf8");
      expect(record).not.toContain("/home/u/x");
      expect(JSON.parse(record)).toMatchObject({ stopReason: "outside_write", trace: { outsideWrites: 1 } });
      expect(existsSync(privateRunDir(w1.waveDir, runId))).toBe(false);
      // The report never reads or copies diagnostics/.
      await f.report([w1.waveDir]);
      expect(await findFiles(join(f.root, "evidence"), /./)).not.toEqual(expect.arrayContaining([expect.stringContaining("diagnostics")]));
      for (const file of await findFiles(join(f.root, "evidence"), /./)) expect(await readFile(file, "utf8")).not.toContain("/home/u/x");
    });

    it("keeps lines of an oracle trace that stops the run, and cuts a long line", async () => {
      const s = await waveSetup(1, { kind: "implementation" });
      const long = `4242 openat(AT_FDCWD</scope/clone>, "/home/u/${"y".repeat(1500)}", O_WRONLY|O_CREAT, 0644) = 3</home/u/y>\n`;
      const tracing: WaveDeps["scoreImplementation"] = async (_clone, _task, options) => {
        const argv = options.wrap!(["npm", "test"]);
        await writeFile(argv[argv.indexOf("-o") + 1]!, prelude(9000) + long.replace("4242", "9000"));
        return { accepted: true, testsPassed: true, outOfScope: [] };
      };
      const r = await runWave(s.input, s.deps([text()], { scoreImplementation: tracing }).deps);
      expect(r.stopReason).toBe("outside_write");
      const kept = await readFile(join(s.waveDir, "diagnostics", `${r.records[0]!.runId}.txt`), "utf8");
      expect(kept).toContain("/home/u/yyy");
      expect(Math.max(...kept.split("\n").map((line) => line.length))).toBe(1000);
    });

    it("plans the slot again, lets exactly it run despite its charge, and the report lets the later record replace the stop", async () => {
      const f = await flow();
      const full = await f.plan();
      const approval1 = f.approve(full);
      const w1 = f.wave(approval1, "wave-1", [text({ trace: outside })]);
      expect((await w1.run()).stopReason).toBe("outside_write");
      const first = approval1.runs[0]!.runId;
      const again = await f.plan("--exclude-wave", w1.waveDir);
      expect(again.exclusion).toEqual({ waves: [{ wave: "wave-1", executed: 1 }], ledgerOnly: 0, removed: 0, resumable: null, replannedStopped: [first], notReplanned: [] });
      expect(again.matrix.runs.map((r) => r.runId)).toEqual(approval1.runs.map((r) => r.runId));
      expect(again.approvalTemplate.replannedStopped).toEqual([{ runId: first, charges: 1 }]);
      // The charge stays in the ledger and in the remaining budget.
      expect(again.trimmed.remainingUsd).toBeCloseTo(9.9);
      const approval2 = f.approve(again);
      // Without the list in the approval the guard refuses a charged run id; with it, only that id may run again.
      const { replannedStopped: _list, ...unlisted } = approval2;
      const refused = f.wave(unlisted as Approval, "wave-refused", [text()], { maxRuns: 1 });
      await expect(refused.run()).rejects.toThrow("run_already_charged");
      expect(refused.captured).toHaveLength(0);
      const w2 = f.wave(approval2, "wave-2", [text({ cost: 0.05 }), text({ cost: 0.05 })], { maxRuns: 2 });
      expect((await w2.run()).paused).toBe(true);
      expect(w2.captured).toHaveLength(2);
      const charges = (JSON.parse(await readFile(f.ledgerPath, "utf8")) as { entries: { runId: string }[] }).entries.filter((entry) => entry.runId === first);
      expect(charges).toHaveLength(2);
      // The stale approval is not a licence for another run id that was charged: a third wave naming no list refuses the first run again.
      const stale = f.wave({ ...approval2, replannedStopped: [] }, "wave-stale", [text()], { maxRuns: 1 });
      await expect(stale.run()).rejects.toThrow("run_already_charged");

      const summary = await f.report([w1.waveDir, w2.waveDir]);
      const evidence = join(f.root, "evidence", "runs");
      expect(await readFile(join(evidence, `${first}.json`), "utf8")).toBe(await readFile(join(w2.waveDir, "runs", `${first}.json`), "utf8"));
      expect(JSON.parse(await readFile(join(evidence, `${first}.json`), "utf8"))).toMatchObject({ outcome: "scored", stopReason: null });
      expect(summary.waveStops).toEqual([{ wave: 1, runId: first, stopReason: "outside_write" }]);
      // Two executed records of one slot still refuse.
      const copy = join(f.root, "wave-2-copy");
      await cp(w2.waveDir, copy, { recursive: true });
      await expect(f.report([w1.waveDir, w2.waveDir, copy], "evidence-duplicate")).rejects.toThrow("duplicate_run_record");
    });

    it("scenario A: a wave left out of --exclude-wave that already re-ran the slot keeps it excluded, and the old approval is refused", async () => {
      const f = await flow();
      const approval1 = f.approve(await f.plan());
      const first = approval1.runs[0]!.runId;
      const w1 = f.wave(approval1, "wave-1", [text({ trace: outside })]);
      await w1.run();
      const approval2 = f.approve(await f.plan("--exclude-wave", w1.waveDir));
      expect(approval2.replannedStopped).toEqual([{ runId: first, charges: 1 }]);
      const w2 = f.wave(approval2, "wave-2", [text({ trace: outside })]);
      expect((await w2.run()).stopReason).toBe("outside_write");
      // Wave 2 charged the slot again and was stopped by the audit as well. Leaving it out of the plan must not plan the slot a third time.
      const omitted = await f.plan("--exclude-wave", w1.waveDir);
      expect(omitted.exclusion).toMatchObject({ replannedStopped: [], notReplanned: [{ runId: first, reason: "ledger_charges_differ_from_records" }] });
      expect(omitted.matrix.runs.map((r) => r.runId)).not.toContain(first);
      expect(omitted.approvalTemplate.replannedStopped).toBeUndefined();
      // The approval written before wave 2 lists one charge, the ledger holds two: the guard refuses, up front.
      const stale = f.wave(approval2, "wave-stale", [text()], { maxRuns: 1 });
      await expect(stale.run()).rejects.toThrow("run_already_charged");
      expect(stale.captured).toHaveLength(0);
      // With both waves excluded the two charges match the two audit-stopped records, and the slot is planned with the count 2.
      const both = await f.plan("--exclude-wave", w1.waveDir, "--exclude-wave", w2.waveDir);
      expect(both.exclusion).toMatchObject({ replannedStopped: [first], notReplanned: [] });
      expect(both.approvalTemplate.replannedStopped).toEqual([{ runId: first, charges: 2 }]);
      const w3 = f.wave(f.approve(both), "wave-3", [text()], { maxRuns: 1 });
      expect((await w3.run()).paused).toBe(true);
      expect(w3.captured).toHaveLength(1);
    });

    it("scenario B: a charge without a record (a crash after the charge) keeps the slot excluded and the approval refused", async () => {
      const f = await flow();
      const approval1 = f.approve(await f.plan());
      const first = approval1.runs[0]!.runId;
      const w1 = f.wave(approval1, "wave-1", [text({ trace: outside })]);
      await w1.run();
      const approval2 = f.approve(await f.plan("--exclude-wave", w1.waveDir));
      expect(approval2.replannedStopped).toEqual([{ runId: first, charges: 1 }]);
      // The crash: the slot was run again and charged, and no record was written.
      const ledger = await PersistedLedger.openExisting(f.ledgerPath);
      await ledger.record(first, approval1.runs[0]!.profile, 0.1);
      const replanned = await f.plan("--exclude-wave", w1.waveDir);
      expect(replanned.exclusion).toMatchObject({ replannedStopped: [], notReplanned: [{ runId: first, reason: "ledger_charges_differ_from_records" }] });
      expect(replanned.matrix.runs.map((r) => r.runId)).not.toContain(first);
      const refused = f.wave(approval2, "wave-2", [text()], { maxRuns: 1 });
      await expect(refused.run()).rejects.toThrow("run_already_charged");
      expect(refused.captured).toHaveLength(0);
    });

    it("reports the same merge whatever the order of the waves", async () => {
      const f = await flow();
      const approval1 = f.approve(await f.plan());
      const first = approval1.runs[0]!.runId;
      const w1 = f.wave(approval1, "wave-1", [text({ trace: outside })]);
      await w1.run();
      const w2 = f.wave(f.approve(await f.plan("--exclude-wave", w1.waveDir)), "wave-2", [text(), text()], { maxRuns: 2 });
      await w2.run();
      const later = await readFile(join(w2.waveDir, "runs", `${first}.json`), "utf8");
      for (const [name, order] of [["evidence-a", [w1.waveDir, w2.waveDir]], ["evidence-b", [w2.waveDir, w1.waveDir]]] as const) {
        const summary = await f.report([...order], name);
        expect(await readFile(join(f.root, name, "runs", `${first}.json`), "utf8")).toBe(later);
        expect(summary.waveStops).toEqual([{ wave: order.indexOf(w1.waveDir) + 1, runId: first, stopReason: "outside_write" }]);
        expect(summary.stopReason).toBeNull();
      }
    });

    it("leaves a structured, path-free event on stderr when the diagnostics cannot be written, and the stop stands (R84)", async () => {
      const f = await flow();
      const approval1 = f.approve(await f.plan());
      const runId = approval1.runs[0]!.runId;
      const events: string[] = [];
      const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => { events.push(String(chunk)); return true; }) as typeof process.stderr.write);
      try {
        // The file is already there (`wx`).
        const existing = f.wave(approval1, "wave-exists", [text({ trace: outside })]);
        await mkdir(join(existing.waveDir, "diagnostics"), { recursive: true });
        await writeFile(join(existing.waveDir, "diagnostics", `${runId}.txt`), "earlier");
        expect((await existing.run()).stopReason).toBe("outside_write");
        // `diagnostics` is a link: nothing is written through it.
        const g = await flow();
        const linked = g.wave(g.approve(await g.plan()), "wave-linked", [text({ trace: outside })]);
        const elsewhere = join(g.root, "elsewhere-diagnostics");
        await mkdir(elsewhere);
        await mkdir(linked.waveDir, { recursive: true });
        await symlink(elsewhere, join(linked.waveDir, "diagnostics"));
        expect((await linked.run()).stopReason).toBe("outside_write");
        expect(await readdir(elsewhere)).toEqual([]);
      } finally { spy.mockRestore(); }
      const failures = events.filter((line) => line.includes("diagnostics_write_failed")).map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(failures).toEqual([{ event: "diagnostics_write_failed", runId, code: "eexist" }, { event: "diagnostics_write_failed", runId, code: "diagnostics_dir_invalid" }]);
      expect(JSON.stringify(failures)).not.toMatch(/\/tmp\//);
    });

    it("plans a slot again only when every executed record is an audit stop, and validates the list in an approval", async () => {
      const f = await flow();
      const approval1 = f.approve(await f.plan());
      const w1 = f.wave(approval1, "wave-1", [text({ trace: outside })]);
      await w1.run();
      const second = f.approve(await f.plan("--exclude-wave", w1.waveDir));
      const w2 = f.wave(second, "wave-2", [text()], { maxRuns: 1 });
      await w2.run();
      // The slot now has a scored record in wave 2: excluding both waves leaves it out for good, excluding only wave 1 plans it again.
      const both = await f.plan("--exclude-wave", w1.waveDir, "--exclude-wave", w2.waveDir);
      expect(both.exclusion).toMatchObject({ removed: 1, replannedStopped: [], notReplanned: [] });
      expect(both.matrix.runs.map((r) => r.runId)).not.toContain(approval1.runs[0]!.runId);
      expect((await f.plan("--exclude-wave", w1.waveDir)).exclusion).toMatchObject({ replannedStopped: [], notReplanned: [{ runId: approval1.runs[0]!.runId, reason: "ledger_charges_differ_from_records" }] });
      // An approval may only name run ids of its own list, once each.
      const tasks = f.tasks;
      const entry = (runId: string) => ({ runId, charges: 1 });
      expect(() => validateApproval({ ...second, replannedStopped: [entry("999-nope-review-A")] }, { sourceCommit: second.sourceCommit, tasks })).toThrow("approval_binding_changed");
      expect(() => validateApproval({ ...second, replannedStopped: [entry(second.runs[0]!.runId), entry(second.runs[0]!.runId)] }, { sourceCommit: second.sourceCommit, tasks })).toThrow("approval_binding_changed");
      expect(() => validateApproval({ ...second, replannedStopped: [{ runId: second.runs[0]!.runId }] }, { sourceCommit: second.sourceCommit, tasks })).toThrow("approval_invalid");
      expect(() => validateApproval({ ...second, replannedStopped: [{ ...entry(second.runs[0]!.runId), extra: 1 }] }, { sourceCommit: second.sourceCommit, tasks })).toThrow("approval_invalid");
      expect(() => validateApproval(second, { sourceCommit: second.sourceCommit, tasks })).not.toThrow();
    });
  });

  it("excludes a slot that has only a ledger entry (a crash after the charge) and counts it as ledger-only", async () => {
    const f = await flow();
    const approval1 = f.approve(await f.plan());
    const w1 = f.wave(approval1, "wave-1", [text(), text()], { maxRuns: 2 });
    await w1.run();
    await rm(join(w1.waveDir, "runs", `${approval1.runs[1]!.runId}.json`));
    const again = await f.plan("--exclude-wave", w1.waveDir);
    expect(again.exclusion).toEqual({ waves: [{ wave: "wave-1", executed: 1 }], ledgerOnly: 1, removed: 2, resumable: null, replannedStopped: [], notReplanned: [] });
    expect(again.matrix.runs.map((r) => r.runId)).toEqual(approval1.runs.slice(2).map((r) => r.runId));
    // Without --exclude-wave the ledger is not consulted.
    expect((await f.plan()).matrix.count).toBe(15);
  });

  it("refuses an excluded wave without an approval, under another ledger, without a runs directory, and bad arguments", async () => {
    const f = await flow();
    const approval1 = f.approve(await f.plan());
    const w1 = f.wave(approval1, "wave-1", [text()], { maxRuns: 1 });
    await w1.run();
    const empty = join(f.root, "empty");
    mkdirSync(empty);
    await expect(f.plan("--exclude-wave", empty)).rejects.toThrow("approval_missing");
    const other = join(f.root, "other");
    mkdirSync(join(other, "runs"), { recursive: true });
    await writeFile(join(other, "approval.json"), JSON.stringify({ ...approval1, ledgerId: "44444444-4444-4444-8444-444444444444" }));
    await expect(f.plan("--exclude-wave", other)).rejects.toThrow("ledger_mismatch");
    await rm(join(w1.waveDir, "runs"), { recursive: true });
    await expect(f.plan("--exclude-wave", w1.waveDir)).rejects.toThrow("runs_missing");
    // M3: waves planned over other tasks do not describe these runs.
    const kept = JSON.parse(await readFile(f.tasksFile, "utf8")) as unknown[];
    await writeFile(f.tasksFile, JSON.stringify(kept.slice(0, 2)));
    await mkdir(join(w1.waveDir, "runs"));
    await expect(f.plan("--exclude-wave", w1.waveDir)).rejects.toThrow("tasks_changed");
    await writeFile(f.tasksFile, JSON.stringify(kept));
    // M6: a wrong --ledger with --exclude-wave creates nothing.
    const wrong = join(f.root, "wrong", "ledger.json");
    await expect(buildPlan(parseArgs(["--plan", "--tasks", f.tasksFile, "--ledger", wrong, "--exclude-wave", w1.waveDir]), { sourceCwd: f.repo })).rejects.toThrow("ledger_missing");
    expect(existsSync(join(f.root, "wrong"))).toBe(false);
    const base = ["--plan", "--tasks", "t.json"];
    expect(parseArgs([...base, "--ledger", "l.json", "--exclude-wave", "a", "--exclude-wave", "b"]).excludeWaves).toEqual(["a", "b"]);
    expect(() => parseArgs([...base, "--exclude-wave", "a"])).toThrow("ledger_required");
    expect(() => parseArgs([...base, "--ledger", "l.json", "--exclude-wave", "a", "--exclude-wave", "a"])).toThrow("invalid_argument");
    const live = ["--approval", "a.json", "--tasks", "t.json", "--template", "x", "--out", "w", "--ledger", "l.json"];
    expect(() => parseArgs(["--wave", ...live, "--exclude-wave", "a"])).toThrow("invalid_argument");
    expect(() => parseArgs(["--report", "--wave", "w", "--ledger", "l.json", "--evidence", "e", "--exclude-wave", "a"])).toThrow("invalid_argument");
  });

  describe("replicates (R90)", () => {
    const grok = ["--pairings", "pl-review-grok"];
    const records = async (dir: string): Promise<(RunRecord & { replicate?: number })[]> =>
      Promise.all((await readdir(join(dir, "runs"))).sort().map(async (name) => JSON.parse(await readFile(join(dir, "runs", name), "utf8")) as RunRecord));

    it("plans every task and arm per replicate, binds the replicate count in the approval, and leaves one replicate as it was", async () => {
      const f = await flow();
      const plain = await f.plan(...grok);
      const one = await f.plan(...grok, "--replicates", "1");
      expect(JSON.stringify(one.matrix)).toBe(JSON.stringify(plain.matrix));
      expect(JSON.stringify(one.approvalTemplate)).toBe(JSON.stringify(plain.approvalTemplate));
      expect("replicates" in plain.approvalTemplate).toBe(false);
      expect(plain.approvalTemplate.runs.every((r) => !("replicate" in r) && !/-r\d$/.test(r.runId))).toBe(true);

      const three = await f.plan(...grok, "--replicates", "3");
      expect(three.matrix.count).toBe(3 * plain.matrix.count);
      expect(three.approvalTemplate.replicates).toBe(3);
      expect(three.approvalTemplate.runs.map((r) => r.replicate)).toEqual(three.approvalTemplate.runs.map((_, i) => Math.floor(i / plain.matrix.count) + 1));
      expect(three.matrix.runs.map((r) => r.ordinal)).toEqual(three.matrix.runs.map((r) => r.ordinal).sort((a, b) => a - b));
      expect(three.matrix.runs.every((r, i) => r.runId.endsWith(`-r${Math.floor(i / plain.matrix.count) + 1}`))).toBe(true);
      // Arm A leads on R1 in replicate 1 and trails in replicate 2.
      const firstArm = (k: number) => three.approvalTemplate.runs.find((r) => r.taskId === "R1" && r.replicate === k)!.arm;
      expect([firstArm(1), firstArm(2), firstArm(3)]).toEqual(["A", "pi-lens", "A"]);
      expect(matrixDigest(three.approvalTemplate.runs)).not.toBe(matrixDigest(plain.approvalTemplate.runs));

      const approval = f.approve(three);
      const check = (candidate: unknown) => () => validateApproval(candidate, { sourceCommit: approval.sourceCommit, tasks: f.tasks });
      expect(check(approval)).not.toThrow();
      // The replicate count is part of the binding: the same runs under another count, or without one, are not canonical.
      expect(check({ ...approval, replicates: 2 })).toThrow("approval_binding_changed");
      // The count is bound both ways: a larger count whose canonical matrix contains these runs is refused as well (the highest replicate is 3).
      expect(check({ ...approval, replicates: 4 })).toThrow("approval_binding_changed");
      // An explicit 1 is not a count; only more than one replicate may be written.
      expect(check({ ...approval, replicates: 1 })).toThrow("approval_invalid");
      expect(check({ ...f.approve(plain), replicates: 1 })).toThrow("approval_invalid");
      expect(check({ ...f.approve(plain), runs: f.approve(plain).runs.map((r) => ({ ...r, replicate: 1 })) })).toThrow("approval_binding_changed");
      const { replicates: omitted, ...withoutCount } = approval;
      void omitted;
      expect(check(withoutCount)).toThrow("approval_binding_changed");
      expect(check({ ...f.approve(plain), replicates: 3 })).toThrow("approval_binding_changed");
      expect(check({ ...approval, replicates: 10 })).toThrow("approval_invalid");
      const [first, ...rest] = approval.runs;
      expect(check({ ...approval, runs: [{ ...first!, replicate: 2 }, ...rest] })).toThrow("approval_binding_changed");
      const { replicate: dropped, ...bare } = first!;
      void dropped;
      expect(check({ ...approval, runs: [bare, ...rest] })).toThrow("approval_binding_changed");
      // A subsequence of the replicated matrix is valid content, as for any plan (R58).
      const subsequence = [...approval.runs.slice(2, 9), ...approval.runs.slice(-4)];
      expect(check({ ...approval, runs: subsequence, matrixDigest: matrixDigest(subsequence) })).not.toThrow();
      // Its highest replicate must be the count: a list that stops at replicate 2 is not an approval for 3.
      const early = approval.runs.slice(2, 9);
      expect(check({ ...approval, runs: early, matrixDigest: matrixDigest(early) })).toThrow("approval_binding_changed");
    });

    it("excludes executed runs by run id, resumes under the same approval, and reports the units of the replicates", async () => {
      const f = await flow();
      const approval = f.approve(await f.plan(...grok, "--replicates", "2"));
      expect(approval.runs).toHaveLength(12);
      const w1 = f.wave(approval, "wave-1", [text({ cost: 0.1 }), text({ cost: 0.1 })], { maxRuns: 2 });
      expect((await w1.run()).paused).toBe(true);
      const written = await records(w1.waveDir);
      expect(written.map((r) => r.replicate)).toEqual([1, 1]);
      expect(written.every((r) => r.runId.endsWith("-r1"))).toBe(true);

      const again = await f.plan(...grok, "--replicates", "2", "--exclude-wave", w1.waveDir);
      expect(again.exclusion).toMatchObject({ removed: 2, resumable: "wave-1" });
      expect(again.matrix.runs.map((r) => r.runId)).toEqual(approval.runs.slice(2).map((r) => r.runId));
      // Replicate k of a plan with more replicates has the run ids of replicate k here, so a wave is excluded from it, but is no longer resumable.
      const other = await f.plan(...grok, "--replicates", "3", "--exclude-wave", w1.waveDir);
      expect(other.exclusion).toMatchObject({ removed: 2, resumable: null });
      expect(other.matrix.count).toBe(16);
      // A plan without replicates has other run ids (no suffix): nothing of this wave is one of its slots.
      const plainPlan = await f.plan(...grok, "--exclude-wave", w1.waveDir);
      expect(plainPlan.exclusion).toMatchObject({ removed: 0 });

      const resumed = await f.wave(approval, "wave-1", Array.from({ length: 10 }, () => text({ cost: 0.1 })), { resume: true }).run();
      expect(resumed.paused).toBe(false);
      expect(resumed.records).toHaveLength(10);
      // A different count in the approval is not the approval the wave ran under.
      await expect(f.wave({ ...approval, replicates: 3 }, "wave-1", [text()], { resume: true }).run()).rejects.toThrow();

      const summary = await f.report([w1.waveDir]);
      const result = summary.pairings.find((p) => p.id === "pl-review-grok")!;
      expect(result).toMatchObject({ kind: "review", recommendation: "descriptive", complete: true, tasks: ["R1", "R2", "R3"] });
      expect(result.replicated).toMatchObject({ replicates: 2 });
      expect(result.replicated!.units).toHaveLength(6);
      expect(JSON.parse(await readFile(join(f.root, "evidence", "approvals", "approval-1.json"), "utf8"))).toMatchObject({ replicates: 2 });
      // G1: the same run ids cannot be charged twice, whatever the wave directory.
      await expect(f.wave(approval, "wave-again", [text()]).run()).rejects.toThrow("run_already_charged");
    });

    it("refuses a resume whose stored record belongs to another slot, and a plan whose excluded record names another slot", async () => {
      const f = await flow();
      const approval = f.approve(await f.plan(...grok, "--replicates", "2"));
      const w1 = f.wave(approval, "wave-1", [text({ cost: 0.1 })], { maxRuns: 1 });
      await w1.run();
      const file = join(w1.waveDir, "runs", `${approval.runs[0]!.runId}.json`);
      const stored = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      await writeFile(file, JSON.stringify({ ...stored, taskId: "R2" }));
      await expect(f.plan(...grok, "--replicates", "2", "--exclude-wave", w1.waveDir)).rejects.toThrow("wave_slot_mismatch");
      const resumed = f.wave(approval, "wave-1", [text()], { resume: true });
      await expect(resumed.run()).rejects.toThrow("resume_invalid");
      expect(resumed.captured).toHaveLength(0);
      const { replicate: dropped, ...withoutReplicate } = stored;
      void dropped;
      await writeFile(file, JSON.stringify(withoutReplicate));
      await expect(f.wave(approval, "wave-1", [text()], { resume: true }).run()).rejects.toThrow("resume_invalid");
      // A record that does not name its slot at all cannot be checked, so it is refused too.
      for (const key of ["taskId", "profile", "arm"]) {
        const { [key]: removed, ...rest } = stored;
        void removed;
        await writeFile(file, JSON.stringify(rest));
        await expect(f.wave(approval, "wave-1", [text()], { resume: true }).run()).rejects.toThrow("resume_invalid");
      }
    });
  });
});

describe("a stale status must not allow a resume (R61)", () => {
  /** Deps whose clock fails from the first reading after a run was spawned, as a crash in the middle of an invocation would. */
  const crashingAfterFirstRun = (s: Setup, steps: Step[]): WaveDeps => {
    const d = s.deps(steps);
    d.deps.now = () => { if (d.captured.length > 0) throw new Error("clock_failed"); return Date.now(); };
    return d.deps;
  };
  const statusOf = async (dir: string) => JSON.parse(await readFile(join(dir, "status.json"), "utf8")) as { state: string };

  it("leaves `running` after a fresh invocation that dies, and refuses to resume it", async () => {
    const s = await waveSetup(3);
    await expect(runWave(s.input, crashingAfterFirstRun(s, [text(), text()]))).rejects.toThrow("clock_failed");
    expect(await statusOf(s.waveDir)).toMatchObject({ state: "running", stopReason: null });
    expect(existsSync(`${s.input.ledgerPath}.lock`)).toBe(false);
    const resumed = s.deps([text()]);
    await expect(runWave({ ...s.input, resume: true }, resumed.deps)).rejects.toThrow("resume_invalid");
    expect(resumed.captured).toHaveLength(0);
  });

  it("leaves `running` after a resumed invocation that dies, so the earlier `paused` cannot be reused", async () => {
    const s = await waveSetup(4);
    await runWave({ ...s.input, maxRuns: 1 }, s.deps([text()]).deps);
    expect(await statusOf(s.waveDir)).toMatchObject({ state: "paused" });
    // The clock fails before the third run, after the second was recorded and charged.
    await expect(runWave({ ...s.input, resume: true }, crashingAfterFirstRun(s, [text(), text()]))).rejects.toThrow("clock_failed");
    expect(await statusOf(s.waveDir)).toMatchObject({ state: "running" });
    expect((await readdir(join(s.waveDir, "runs"))).length).toBe(2);
    const again = s.deps([text()]);
    await expect(runWave({ ...s.input, resume: true }, again.deps)).rejects.toThrow("resume_invalid");
    expect(again.captured).toHaveLength(0);
  });

  it("refuses wave_stopped when the status says paused but a record holds a stop reason", async () => {
    const s = await waveSetup(3);
    const outside = `${benignTrace()}4242 openat(AT_FDCWD</scope>, "/home/u/x", O_WRONLY|O_CREAT, 0644) = 3</home/u/x>\n`;
    expect((await runWave(s.input, s.deps([text({ trace: outside })]).deps)).stopReason).toBe("outside_write");
    const status = JSON.parse(await readFile(join(s.waveDir, "status.json"), "utf8")) as Record<string, unknown>;
    await writeFile(join(s.waveDir, "status.json"), JSON.stringify({ ...status, state: "paused", stopReason: null }));
    const resumed = s.deps([text()]);
    await expect(runWave({ ...s.input, resume: true }, resumed.deps)).rejects.toThrow("wave_stopped");
    expect(resumed.captured).toHaveLength(0);
  });
});

describe("lock before read (R62a)", () => {
  it("takes the lock first and leaves no lock file when opening fails", async () => {
    const root = await temporaryRoot("ablation-open-locked-");
    const path = join(root, "ledger.json");
    // A missing ledger in a missing directory creates neither the directory nor a lock (M6).
    await expect(PersistedLedger.openLocked(join(root, "nodir", "ledger.json"), LEDGER_ID)).rejects.toThrow("ledger_missing");
    expect(existsSync(join(root, "nodir"))).toBe(false);
    await expect(PersistedLedger.openLocked(path, LEDGER_ID)).rejects.toThrow("ledger_missing");
    expect(existsSync(`${path}.lock`)).toBe(false);
    await seedLedger(path, [], "44444444-4444-4444-8444-444444444444");
    await expect(PersistedLedger.openLocked(path, LEDGER_ID)).rejects.toThrow("ledger_mismatch");
    expect(existsSync(`${path}.lock`)).toBe(false);
    await writeFile(path, "{ not json");
    await expect(PersistedLedger.openLocked(path, LEDGER_ID)).rejects.toThrow();
    expect(existsSync(`${path}.lock`)).toBe(false);
    await seedLedger(path);
    const held = await PersistedLedger.openLocked(path, LEDGER_ID);
    expect(existsSync(`${path}.lock`)).toBe(true);
    // A second holder is refused before it reads anything, and its refusal does not remove the first holder's lock.
    await expect(PersistedLedger.openLocked(path, LEDGER_ID)).rejects.toThrow("ledger_locked");
    expect(existsSync(`${path}.lock`)).toBe(true);
    await held.release();
    expect(existsSync(`${path}.lock`)).toBe(false);
  });
});

describe("approved runs must be canonical (R62b)", () => {
  async function edited(change: (runs: RunSpec[]) => RunSpec[]) {
    const root = await temporaryRoot("ablation-canonical-");
    const tasks = [await reviewTask(root, "A1"), await reviewTask(root, "A2")];
    const runs = buildMatrix(tasks, PAIRINGS);
    const approval = approvalFor(tasks, change(runs));
    return () => validateApproval(approval, { sourceCommit: approval.sourceCommit, tasks, routes: approval.routes });
  }
  const first = (runs: RunSpec[]): RunSpec => runs.find((r) => r.profile === "review-grok" && r.arm === "pi-lens")!;
  const replaceFirst = (runs: RunSpec[], run: RunSpec): RunSpec[] => runs.map((r, i) => (i === 0 ? run : r));

  it("accepts the canonical list and any subsequence of it with subset pairings", async () => {
    expect((await edited((runs) => runs))()).toBeDefined();
    expect((await edited((runs) => runs.slice(3, 9)))()).toBeDefined();
    expect((await edited((runs) => runs.map((r) => ({ ...r, pairings: [r.pairings[0]!] }))))()).toBeDefined();
  });

  it("refuses an arm-B run of a profile that has no pairing for that extension", async () => {
    const run = (runs: RunSpec[]) => ({ ...first(runs), arm: "pi-cache-optimizer" as const, runId: first(runs).runId.replace(/pi-lens$/, "pi-cache-optimizer") });
    await expect((await edited((runs) => replaceFirst(runs, run(runs)))).bind(null)).toThrow("approval_binding_changed");
  });

  it("refuses an unknown pairing id, a duplicated pairing id, and a pairing of another slot", async () => {
    await expect(await edited((runs) => replaceFirst(runs, { ...runs[0]!, pairings: ["no-such-pairing"] }))).toThrow("approval_binding_changed");
    await expect(await edited((runs) => replaceFirst(runs, { ...runs[0]!, pairings: [runs[0]!.pairings[0]!, runs[0]!.pairings[0]!] }))).toThrow("approval_binding_changed");
    await expect(await edited((runs) => replaceFirst(runs, { ...runs[0]!, pairings: ["pl-code"] }))).toThrow("approval_binding_changed");
  });

  it("refuses a run id that does not match its slot or ordinal", async () => {
    await expect(await edited((runs) => replaceFirst(runs, { ...runs[0]!, runId: "999-A1-review-grok-A" }))).toThrow("approval_binding_changed");
    await expect(await edited((runs) => replaceFirst(runs, { ...runs[0]!, ordinal: 99 }))).toThrow("approval_binding_changed");
    await expect(await edited((runs) => replaceFirst(runs, { ...runs[0]!, taskId: "A2" }))).toThrow("approval_binding_changed");
  });

  it("refuses a review task on a code profile", async () => {
    await expect(await edited((runs) => replaceFirst(runs, { ...runs[0]!, profile: "code", runId: runs[0]!.runId.replace("review-grok", "code") }))).toThrow("approval_binding_changed");
  });

  it("refuses runs that are not in increasing ordinal order", async () => {
    await expect(await edited((runs) => [...runs].reverse())).toThrow("approval_binding_changed");
    await expect(await edited((runs) => [runs[1]!, runs[0]!, ...runs.slice(2)])).toThrow("approval_binding_changed");
  });
});

describe("an invalid session cost counts as missing (R62c)", () => {
  const usage = (assistantCost: number, tokens: number, sessionTokens = 10) => ({
    session: { input: sessionTokens, output: 0, cacheRead: 0, cacheWrite: 0, total: sessionTokens, costUsd: -1 },
    assistant: { messages: 1, input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: assistantCost }, providerError: null,
  });
  const entriesOf = async (path: string) => (JSON.parse(await readFile(path, "utf8")) as { entries: { runId: string; costUsd: number | null; estimated?: boolean }[] }).entries;

  it("falls back in the wave like a missing session total: the assistant sum or the estimate when tokens show anywhere, null only without tokens (M2)", async () => {
    const s = await waveSetup(3);
    const r = await runWave(s.input, s.deps([
      text({ output: { usage: usage(1.5, 10) } }), text({ output: { usage: usage(0.4, 0) } }), text({ output: { usage: usage(0.4, 0, 0) } }),
    ]).deps);
    const entries = await entriesOf(s.input.ledgerPath);
    expect(entries[0]).toMatchObject({ runId: s.runs[0]!.runId, costUsd: 1.5, estimated: true });
    // Session tokens alone are a billed response: the estimate stands in (at least the assistant cost).
    expect(entries[1]).toMatchObject({ runId: s.runs[1]!.runId, estimated: true });
    expect(entries[1]!.costUsd).toBeGreaterThanOrEqual(1);
    // No token anywhere: nothing was billed.
    expect(entries[2]).toMatchObject({ runId: s.runs[2]!.runId, costUsd: null });
    expect(entries[2]!.estimated).toBeUndefined();
    expect(r.stopReason).toBeNull();
  });

  it("fails a preflight route with usage_missing and still charges the assistant cost", async () => {
    const root = await temporaryRoot("ablation-invalid-session-");
    const tasks = [await reviewTask(join(root, "repo"), "P1")];
    const approval = approvalFor(tasks, buildMatrix(tasks, PAIRINGS.filter((p) => p.id === "pl-review")));
    await seedLedger(join(root, "l.json"));
    const { spawnRun } = fake([{ text: "PONG", output: { usage: usage(0.07, 10) } }], root);
    const result = await runPreflight({ approval, waveDir: join(root, "w"), ledgerPath: join(root, "l.json"), productionConfig, hostAuth: { openai: { type: "api_key", key: "k" } } }, {
      ...seams(), spawnRun: (scope, input) => spawnRun(scope, input, join(scope.root, "x.log")), residualCheck: async () => true,
    });
    expect(result.routes).toMatchObject([{ profile: "review", ok: false, terminal: "completed", failure: "usage_missing" }]);
    expect(await entriesOf(join(root, "l.json"))).toMatchObject([{ costUsd: 0.07 }]);
  });
});

describe("no run is executed twice (G1) and records are atomic (A1)", () => {
  it("refuses to resume wave 1 once another wave executed one of its pending slots, before anything is written", async () => {
    const s = await waveSetup(4);
    await runWave({ ...s.input, maxRuns: 1 }, s.deps([text()]).deps);
    // What a wave 2 under a re-approval would have left in the shared ledger.
    const ledger = await PersistedLedger.openExisting(s.input.ledgerPath, LEDGER_ID);
    await ledger.record(s.runs[2]!.runId, "review", 0.1);
    const resumed = s.deps([text()]);
    await expect(runWave({ ...s.input, resume: true }, resumed.deps)).rejects.toThrow("run_already_charged");
    expect(resumed.captured).toHaveLength(0);
    expect(JSON.parse(await readFile(join(s.waveDir, "status.json"), "utf8"))).toMatchObject({ state: "paused" });
    expect((await readdir(join(s.waveDir, "runs"))).length).toBe(1);
    expect(existsSync(`${s.input.ledgerPath}.lock`)).toBe(false);
  });

  it("refuses a second fresh --out under the same approval", async () => {
    const s = await waveSetup(2);
    await runWave(s.input, s.deps([text(), text()]).deps);
    const second = s.deps([text(), text()]);
    const other = join(s.root, "wave-b");
    await expect(runWave({ ...s.input, waveDir: other }, second.deps)).rejects.toThrow("run_already_charged");
    expect(second.captured).toHaveLength(0);
    expect(existsSync(join(other, "status.json"))).toBe(false);
    expect(existsSync(join(other, "approval.json"))).toBe(false);
    expect(existsSync(`${s.input.ledgerPath}.lock`)).toBe(false);
  });

  it("never overwrites an existing record and leaves no temporary file", async () => {
    const s = await waveSetup(2);
    const target = join(s.waveDir, "runs", `${s.runs[0]!.runId}.json`);
    let calls = 0;
    // The guard is read before the wave and after each run: the record appears in between.
    const guard = async () => { calls += 1; if (calls === 2) await writeFile(target, "sentinel"); return { files: {} }; };
    const r = await runWave(s.input, s.deps([text(), text()], { guard }).deps);
    expect(r.stopReason).toBe("harness_failure");
    expect(await readFile(target, "utf8")).toBe("sentinel");
    expect((await readdir(s.waveDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    // The second run was not executed after the failed write.
    expect(r.records.map((x) => x.outcome)).toEqual(["scored", "not_run"]);
  });
});

import { execFileSync } from "node:child_process";
import { classifyRun, summarizeTrace, type RunRecord } from "../eval/extensions/classify.js";
import type { RunOutput } from "../eval/extensions/run-one.js";
import type { TraceFindings } from "../eval/extensions/trace.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseArgs } from "../eval/extensions/cli.js";
import { PersistedLedger } from "../eval/extensions/ledger-file.js";
import { PAIRINGS } from "../eval/extensions/matrix.js";
import { recommend, summarize, writeEvidence, type SummaryRecord } from "../eval/extensions/report.js";
import { hash } from "../eval/profiles/files.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

const pairing = PAIRINGS.find((p) => p.id === "pl-code-deepseek")!;

let counter = 0;
function record(taskId: string, arm: "A" | "pi-lens", accepted: boolean | null, overrides: Partial<SummaryRecord> = {}, cost = 0.1, tokens = { input: 100, cacheRead: 50 }): SummaryRecord {
  counter += 1;
  return {
    runId: `${String(counter).padStart(3, "0")}-${taskId}-code-deepseek-${arm}`, taskId, profile: "code-deepseek", arm, pairings: [pairing.id],
    outcome: accepted === null ? "stopped" : "scored", accepted,
    usage: { session: { input: tokens.input, cacheRead: tokens.cacheRead, costUsd: cost } }, stopReason: null, ...overrides,
  };
}
/** Both arms of one task. */
const pair = (taskId: string, a: boolean | null, b: boolean | null, costA = 0.1, costB = 0.1): SummaryRecord[] =>
  [record(taskId, "A", a, {}, costA), record(taskId, "pi-lens", b, {}, costB)];
const result = (records: SummaryRecord[], id = pairing.id) => summarize(records).pairings.find((p) => p.id === id)!;

describe("recommend", () => {
  it("applies the pre-registered rule", () => {
    const wins = [{ a: false, b: true }, { a: true, b: true }, { a: true, b: true }];
    expect(recommend({ accepted: 2, costUsd: 1 }, { accepted: 3, costUsd: 1.2 }, wins)).toBe("enable");
    expect(recommend({ accepted: 2, costUsd: 1 }, { accepted: 3, costUsd: 1.25 }, wins)).toBe("enable");
    expect(recommend({ accepted: 2, costUsd: 1 }, { accepted: 3, costUsd: 1.3 }, wins)).toBe("inconclusive");
    expect(recommend({ accepted: 3, costUsd: 1 }, { accepted: 2, costUsd: 0.5 }, [])).toBe("do-not-enable");
    expect(recommend({ accepted: 3, costUsd: 1 }, { accepted: 3, costUsd: 0.9 }, [{ a: true, b: true }])).toBe("inconclusive");
  });
});

describe("summarize", () => {
  it("counts only tasks scored in both arms, per pairing", () => {
    const records = [...pair("t1", false, true), ...pair("t2", true, true), ...pair("t3", true, true), ...pair("t4", true, null), record("t5", "A", true)];
    const found = result(records);
    expect(found.tasks).toEqual(["t1", "t2", "t3"]);
    expect(found.complete).toBe(true);
    expect(found.a).toMatchObject({ accepted: 2, scored: 3 });
    expect(found.a.costUsd).toBeCloseTo(0.3);
    expect(found.b).toMatchObject({ accepted: 3, scored: 3 });
    expect(found.recommendation).toBe("enable");
  });

  it("counts, per arm, the scored runs with a false finding and those without the verdict, without letting either decide (R78)", () => {
    const review = (falseFindings: string[], verdictMatched = true): Partial<SummaryRecord> => ({ review: { falseFindings, verdictMatched } });
    const records = [
      record("t1", "A", true, review([])), record("t1", "pi-lens", true, review(["x1"])),
      record("t2", "A", true, review(["x1", "x2"])), record("t2", "pi-lens", false, review([], false)),
      record("t3", "A", true), record("t3", "pi-lens", true, review(["x2"])),
    ];
    const found = result(records);
    expect(found.a).toMatchObject({ accepted: 3, scored: 3, falseFindingRuns: 1, verdictMissed: 0 });
    expect(found.b).toMatchObject({ accepted: 2, scored: 3, falseFindingRuns: 2, verdictMissed: 1 });
    // Only the acceptance feeds the recommendation: B lost a task here.
    expect(found.recommendation).toBe("do-not-enable");
    expect(result([...pair("t1", true, true), ...pair("t2", true, true), ...pair("t3", true, true)]).a).toMatchObject({ falseFindingRuns: 0, verdictMissed: 0 });
  });

  describe("review pairings are descriptive (R83)", () => {
    const reviewPairing = PAIRINGS.find((p) => p.id === "pl-review")!;
    const score = (criticalHit: number, criticalTotal: number, recall: number, verdictMatched: boolean, falseFindings: string[] = [], accepted = verdictMatched && criticalHit === criticalTotal) =>
      ({ falseFindings, verdictMatched, criticalHit, criticalTotal, recall, accepted });
    const reviewRun = (taskId: string, arm: "A" | "pi-lens", review: SummaryRecord["review"] | undefined, cost = 0.1): SummaryRecord =>
      ({ ...record(taskId, arm, review?.accepted ?? false, { review }, cost), profile: "review", pairings: [reviewPairing.id], runId: `${String(counter).padStart(3, "0")}-${taskId}-review-${arm}` });
    const reviewResult = (records: SummaryRecord[]) => summarize(records).pairings.find((p) => p.id === reviewPairing.id)!;

    it("never yields a recommendation, whatever the oracle accepted, and reports the numbers per arm", () => {
      const records = [
        reviewRun("r1", "A", score(1, 2, 0.5, true)), reviewRun("r1", "pi-lens", score(2, 2, 1, true, ["x1"])),
        reviewRun("r2", "A", score(2, 2, 1, false)), reviewRun("r2", "pi-lens", score(2, 2, 1, true)),
        reviewRun("r3", "A", undefined), reviewRun("r3", "pi-lens", score(0, 1, 0, false, ["x1", "x2"])),
      ];
      const found = reviewResult(records);
      expect(found).toMatchObject({ kind: "review", recommendation: "descriptive", complete: true, tasks: ["r1", "r2", "r3"] });
      expect(found.a).toEqual({
        costUsd: expect.closeTo(0.3), scored: 3, unexpectedConnects: 0, reviewScored: 2, criticalHitSum: 3, criticalTotalSum: 4, criticalHitMean: expect.closeTo(0.75),
        verdictMatched: 1, recallMean: expect.closeTo(0.75), falseFindingRuns: 0, oracleAccepted: 0,
      });
      expect(found.b).toEqual({
        costUsd: expect.closeTo(0.3), scored: 3, unexpectedConnects: 0, reviewScored: 3, criticalHitSum: 4, criticalTotalSum: 5, criticalHitMean: expect.closeTo(2 / 3),
        verdictMatched: 2, recallMean: expect.closeTo(2 / 3), falseFindingRuns: 2, oracleAccepted: 2,
      });
      // The acceptance of the oracle is a number in the description, not an `accepted` total.
      expect(found.a).not.toHaveProperty("accepted");
      expect(found.b).not.toHaveProperty("accepted");
    });

    it("is descriptive when arm B wins, loses or ties, and with no or few paired tasks", () => {
      const win = [...["r1", "r2", "r3"].flatMap((id) => [reviewRun(id, "A", score(0, 1, 0, false)), reviewRun(id, "pi-lens", score(1, 1, 1, true))])];
      const loss = [...["r1", "r2", "r3"].flatMap((id) => [reviewRun(id, "A", score(1, 1, 1, true)), reviewRun(id, "pi-lens", score(0, 1, 0, false))])];
      expect(reviewResult(win)).toMatchObject({ recommendation: "descriptive", complete: true });
      expect(reviewResult(loss)).toMatchObject({ recommendation: "descriptive", complete: true });
      expect(reviewResult([reviewRun("r1", "A", score(1, 1, 1, true)), reviewRun("r1", "pi-lens", score(1, 1, 1, true))])).toMatchObject({ recommendation: "descriptive", complete: false });
      expect(reviewResult([])).toMatchObject({ recommendation: "descriptive", complete: false, tasks: [] });
      expect(reviewResult([]).a).toMatchObject({ reviewScored: 0, criticalHitMean: 0, recallMean: 0 });
    });

    it("leaves implementation pairings with their recommendation and totals", () => {
      const found = result([...pair("t1", false, true), ...pair("t2", true, true), ...pair("t3", true, true)]);
      expect(found).toMatchObject({ kind: "implementation", recommendation: "enable", complete: true });
      expect(found.a).toHaveProperty("accepted", 2);
      const everyReview = summarize([]).pairings.filter((p) => p.kind === "review").map((p) => p.id);
      expect(everyReview).toEqual(["pl-review-grok", "pl-review", "co-review"]);
    });
  });

  it("marks a pairing with fewer than three paired tasks inconclusive", () => {
    const found = result([...pair("t1", false, true), ...pair("t2", true, true)]);
    expect(found).toMatchObject({ tasks: ["t1", "t2"], complete: false, recommendation: "inconclusive" });
  });

  it("reports a pairing without paired tasks as not-run", () => {
    expect(result([]).recommendation).toBe("not-run");
    expect(result([]).complete).toBe(false);
    expect(result([record("t1", "A", true)]).recommendation).toBe("not-run");
    expect(result([...pair("t1", true, true), ...pair("t2", true, true), ...pair("t3", true, true)], "pl-code").recommendation).toBe("not-run");
  });

  it("derives the cache-read share from the paired runs of each arm", () => {
    const found = result([
      record("t1", "A", true, {}, 0.1, { input: 100, cacheRead: 25 }), record("t1", "pi-lens", true, {}, 0.1, { input: 200, cacheRead: 150 }),
      record("t2", "A", true, {}, 0.1, { input: 100, cacheRead: 25 }), record("t2", "pi-lens", true, {}, 0.1, { input: 200, cacheRead: 150 }),
    ]);
    // Pi's `input` excludes cache reads: share = cacheRead / (input + cacheRead).
    expect(found.cacheReadShare.a).toBeCloseTo(50 / 250);
    expect(found.cacheReadShare.b).toBeCloseTo(300 / 700);
    expect(result([record("t1", "A", true, { usage: null })]).cacheReadShare).toEqual({ a: 0, b: 0 });
  });

  it("refuses duplicate records", () => {
    const first = record("t1", "A", true);
    expect(() => summarize([first, { ...record("t2", "A", true), runId: first.runId }])).toThrow("duplicate_run_record");
    expect(() => summarize([first, record("t1", "A", false)])).toThrow("duplicate_run_record");
  });

  it("reports the first stop reason in run order and the observed cost of the records", () => {
    const stopped = record("t9", "A", null, { stopReason: "budget" }, 0);
    const summary = summarize([stopped, ...pair("t1", true, true, 0.25, 0.5)]);
    expect(summary.stopReason).toBe("budget");
    expect(summary.spentUsd).toBeCloseTo(0.75);
    expect(summarize([]).stopReason).toBeNull();
  });
});

const RUN_COUNT = 6;
const GIT_ENV = { PATH: process.env.PATH ?? "", HOME: "/nonexistent" };
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=Report Test", "-c", "user.email=report@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "ignore"] });
function commitAll(repo: string, message: string): void { git(repo, "add", "-A"); git(repo, "commit", "-m", message); }

/** A throwaway repository that stands in for the evaluated one: the real tree is dirty while this task is under review. */
function makeRepo(root: string): string {
  const repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "eval", "extensions"), { recursive: true });
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "eval", "extensions", "x.ts"), "export const x = 1;\n");
  writeFileSync(join(repo, "docs", "notes.md"), "notes\n");
  git(repo, "init", "--quiet");
  commitAll(repo, "base");
  return repo;
}

/** The approval a wave ran under (`approval.json`), bound to the repository's current commit and to the ledger's id. */
function writeApproval(waveDir: string, repo: string, ledgerId: string, records: SummaryRecord[], overrides: Record<string, unknown> = {}): void {
  const runs = records.map((r, index) => ({ runId: r.runId, taskId: r.taskId, profile: r.profile, arm: r.arm, ordinal: index + 1, pairings: r.pairings }));
  const approval = {
    approved: true, approvedAt: "2026-10-20T00:00:00Z", budgetUsd: 10, sourceCommit: git(repo, "rev-parse", "HEAD").trim(),
    tasksDigest: `sha256:${"a".repeat(64)}`, matrixDigest: `sha256:${"b".repeat(64)}`, ledgerId, runs,
    routes: [{ profile: "code-deepseek", provider: "deepseek", model: "deepseek-flash", thinkingLevel: "high" }], ...overrides,
  };
  writeFileSync(join(waveDir, "approval.json"), `${JSON.stringify(approval, null, 2)}\n`);
}

interface Wave { root: string; repo: string; waveDir: string; ledgerPath: string; evidenceDir: string; runIds: string[] }
async function makeWave(extra: (dir: string) => void = () => undefined): Promise<Wave> {
  const root = await temporaryRoot("ablation-report-");
  const repo = makeRepo(root);
  const waveDir = join(root, "wave");
  mkdirSync(join(waveDir, "runs"), { recursive: true });
  const records = [...pair("t1", false, true), ...pair("t2", true, true), ...pair("t3", true, true)];
  expect(records).toHaveLength(RUN_COUNT);
  for (const r of records) writeFileSync(join(waveDir, "runs", `${r.runId}.json`), `${JSON.stringify({ ...r, durationMs: 5, harnessError: null })}\n`);
  // The ledger is shared by the whole evaluation: a preflight entry and entries of an earlier wave sit beside this wave's three.
  const ledgerPath = join(root, "ledger", "ledger.json");
  const ledger = new PersistedLedger(ledgerPath);
  await ledger.record("preflight-code-deepseek", "code-deepseek", 0.4);
  await ledger.record(records[0]!.runId, "code-deepseek", 0.3);
  await ledger.record(records[1]!.runId, "code-deepseek", 0.2);
  await ledger.recordEstimate(records[2]!.runId, "code-deepseek");
  await ledger.record("900-old-wave-t1-code-deepseek-A", "code-deepseek", 0.15);
  await ledger.recordEstimate("901-old-wave-t1-code-deepseek-pi-lens", "code-deepseek");
  await ledger.save();
  writeApproval(waveDir, repo, ledger.id, records);
  extra(waveDir);
  return { root, repo, waveDir, ledgerPath, evidenceDir: join(root, "evidence"), runIds: records.map((r) => r.runId) };
}
/** Adds fields to the first run record of the wave. */
function tamper(wave: Wave, extra: Record<string, unknown>): void {
  const file = join(wave.waveDir, "runs", `${wave.runIds[0]}.json`);
  writeFileSync(file, JSON.stringify({ ...(JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>), ...extra }));
}
const write = (w: Wave, evidenceDir = w.evidenceDir) => writeEvidence(w.waveDir, evidenceDir, w.ledgerPath, { repoRoot: w.repo });

const tree = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(dir.length + 1)).sort();
const integrityOf = (dir: string) => JSON.parse(readFileSync(join(dir, "integrity.json"), "utf8")) as {
  kind: string; source_binding: { commit: string; digest: string }; files: { path: string; hash: string }[];
};

describe("writeEvidence", () => {
  it("writes the runs, the ledger, the summary and an integrity index that matches the files", async () => {
    const wave = await makeWave();
    const summary = await write(wave);
    expect(summary.pairings.find((p) => p.id === pairing.id)?.recommendation).toBe("enable");

    const files = tree(wave.evidenceDir);
    expect(files).toHaveLength(RUN_COUNT + 4);
    expect(files).toContain("approvals/approval-1.json");
    expect(files).toContain("ledger.json");
    expect(files).toContain("summary.json");
    expect(files).toContain("integrity.json");

    const integrity = integrityOf(wave.evidenceDir);
    expect(integrity.kind).toBe("extension-ablation-evidence-integrity");
    expect(integrity.source_binding.commit).toBe(git(wave.repo, "rev-parse", "HEAD").trim());
    expect(integrity.source_binding.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(integrity.files.map((f) => f.path)).toEqual(files.filter((f) => f !== "integrity.json"));
    for (const entry of integrity.files) expect(entry.hash).toBe(hash(readFileSync(join(wave.evidenceDir, entry.path))));

    for (const name of readdirSync(join(wave.waveDir, "runs"))) {
      expect(readFileSync(join(wave.evidenceDir, "runs", name), "utf8")).toBe(readFileSync(join(wave.waveDir, "runs", name), "utf8"));
    }
    expect(readFileSync(join(wave.evidenceDir, "ledger.json"), "utf8")).toBe(readFileSync(wave.ledgerPath, "utf8"));
  });

  it("reports the budget spend and the wave spend separately, each as observed and estimated", async () => {
    const wave = await makeWave();
    await write(wave);
    const written = JSON.parse(readFileSync(join(wave.evidenceDir, "summary.json"), "utf8")) as {
      budgetSpend: { observedUsd: number; estimatedUsd: number }; waveSpend: { observedUsd: number; estimatedUsd: number }; spentUsd: number;
    };
    // Budget: every ledger entry. Estimates are the largest observed cost at the time: 0.4 (preflight) twice.
    expect(written.budgetSpend.observedUsd).toBeCloseTo(0.4 + 0.3 + 0.2 + 0.15);
    expect(written.budgetSpend.estimatedUsd).toBeCloseTo(0.8);
    expect(written.spentUsd).toBeCloseTo(0.4 + 0.3 + 0.2 + 0.15 + 0.8);
    // Wave: only the entries of runs that have a record here.
    expect(written.waveSpend.observedUsd).toBeCloseTo(0.5);
    expect(written.waveSpend.estimatedUsd).toBeCloseTo(0.4);
  });

  it("binds the evidence to the ablation code and to nothing outside the bound paths", async () => {
    const wave = await makeWave();
    await write(wave);
    const first = integrityOf(wave.evidenceDir).source_binding;

    writeFileSync(join(wave.repo, "docs", "notes.md"), "changed notes\n");
    commitAll(wave.repo, "docs");
    await write(wave, join(wave.root, "evidence-docs"));
    const afterDocs = integrityOf(join(wave.root, "evidence-docs")).source_binding;
    expect(afterDocs.commit).not.toBe(first.commit);
    expect(afterDocs.digest).toBe(first.digest);

    writeFileSync(join(wave.repo, "eval", "extensions", "x.ts"), "export const x = 2;\n");
    commitAll(wave.repo, "extensions");
    // I6b: the wave ran the code of its approval's commit; evidence for a tree whose bound code moved on since is refused.
    await expect(write(wave, join(wave.root, "evidence-ext"))).rejects.toThrow("approval_source_mismatch");
    expect(existsSync(join(wave.root, "evidence-ext"))).toBe(false);
    // The same wave under an approval of the new commit (the operator re-ran it) yields evidence bound to the new code.
    const runs = JSON.parse(readFileSync(join(wave.waveDir, "approval.json"), "utf8")).runs as { runId: string }[];
    writeApproval(wave.waveDir, wave.repo, JSON.parse(readFileSync(join(wave.waveDir, "approval.json"), "utf8")).ledgerId, runs.map((r) => ({ ...record("t1", "A", true), runId: r.runId })));
    await write(wave, join(wave.root, "evidence-ext"));
    expect(integrityOf(join(wave.root, "evidence-ext")).source_binding.digest).not.toBe(first.digest);
  });

  it.each([
    ["a modified tracked file", (repo: string) => writeFileSync(join(repo, "eval", "extensions", "x.ts"), "export const x = 3;\n")],
    ["a new file", (repo: string) => writeFileSync(join(repo, "eval", "extensions", "new.ts"), "export {};\n")],
    ["a changed source file", (repo: string) => writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n")],
  ])("refuses evidence when the tree has %s under a bound path", async (_name, change) => {
    const wave = await makeWave();
    change(wave.repo);
    await expect(write(wave)).rejects.toThrow("source_dirty");
    expect(existsSync(wave.evidenceDir)).toBe(false);
  });

  it("refuses a staged change under a bound path and ignores changes outside the bound paths", async () => {
    const wave = await makeWave();
    writeFileSync(join(wave.repo, "docs", "notes.md"), "edited\n");
    writeFileSync(join(wave.repo, "docs", "untracked.md"), "new\n");
    await expect(write(wave)).resolves.toBeDefined();

    writeFileSync(join(wave.repo, "eval", "extensions", "x.ts"), "export const x = 4;\n");
    git(wave.repo, "add", "eval/extensions/x.ts");
    await expect(write(wave, join(wave.root, "second"))).rejects.toThrow("source_dirty");
    git(wave.repo, "mv", "eval/extensions/x.ts", "docs/x.ts");
    await expect(write(wave, join(wave.root, "third"))).rejects.toThrow("source_dirty");
  });

  it("only copies run records, never other files of the wave", async () => {
    const wave = await makeWave((dir) => {
      mkdirSync(join(dir, "private", "x"), { recursive: true });
      writeFileSync(join(dir, "private", "x", "strace.log"), "secret");
      writeFileSync(join(dir, "runs", "notes.txt"), "not a record");
    });
    await write(wave);
    expect(tree(wave.evidenceDir).filter((f) => !f.startsWith("runs/"))).toEqual(["approvals/approval-1.json", "integrity.json", "ledger.json", "summary.json"]);
    expect(tree(wave.evidenceDir).filter((f) => f.startsWith("runs/"))).toHaveLength(RUN_COUNT);
  });

  it("refuses an existing evidence directory and leaves it untouched", async () => {
    const wave = await makeWave();
    mkdirSync(wave.evidenceDir);
    writeFileSync(join(wave.evidenceDir, "keep.txt"), "x");
    await expect(write(wave)).rejects.toThrow("evidence_dir_exists");
    expect(readdirSync(wave.evidenceDir)).toEqual(["keep.txt"]);
  });

  it("refuses a record whose name does not match its run id", async () => {
    const wave = await makeWave((dir) => writeFileSync(join(dir, "runs", "other.json"), JSON.stringify(record("t1", "A", true))));
    await expect(write(wave)).rejects.toThrow("run_record_invalid");
    expect(existsSync(wave.evidenceDir)).toBe(false);
  });

  it("refuses two records that share a task, profile and arm", async () => {
    const twin = { ...record("t1", "A", true), runId: "800-t1-code-deepseek-A" };
    const wave = await makeWave((dir) => writeFileSync(join(dir, "runs", `${twin.runId}.json`), JSON.stringify(twin)));
    await expect(write(wave)).rejects.toThrow("duplicate_run_record");
    expect(existsSync(wave.evidenceDir)).toBe(false);
  });

  it("refuses a ledger that does not match the ledger schema", async () => {
    const wave = await makeWave();
    const ledger = JSON.parse(readFileSync(wave.ledgerPath, "utf8")) as Record<string, unknown>;
    writeFileSync(wave.ledgerPath, JSON.stringify({ ...ledger, extra: true }));
    await expect(write(wave)).rejects.toThrow("ledger_file_invalid");
    expect(existsSync(wave.evidenceDir)).toBe(false);
  });

  const leaks: [string, (waveDir: string) => Record<string, unknown>][] = [
    ["the home path", () => ({ harnessError: `read ${homedir()}` })],
    ["the wave directory", (waveDir) => ({ harnessError: `at ${waveDir}` })],
    ["an absolute path", () => ({ harnessError: "/etc/passwd" })],
    ["an embedded absolute path", () => ({ harnessError: "x at /tmp/y" })],
    ["an absolute path after a separator", () => ({ harnessError: "path=/tmp/y" })],
    ["a path-like key", () => ({ "/tmp/y": 1 })],
    ["a nested path-like key", () => ({ nested: { "x /tmp/y": 1 } })],
    ["a credential key", () => ({ nested: { access: "x" } })],
    ["a refresh key", () => ({ refresh: "x" })],
    ["a key field", () => ({ key: "x" })],
    ["a long string", () => ({ note: "a".repeat(2_001) })],
  ];
  it.each(leaks)("refuses evidence that leaks %s and leaves no partial directory", async (_name, extra) => {
    const wave = await makeWave();
    tamper(wave, extra(wave.waveDir));
    await expect(write(wave)).rejects.toThrow("evidence_contains_private_data");
    expect(existsSync(wave.evidenceDir)).toBe(false);
    expect(readdirSync(wave.root).sort()).toEqual(["ledger", "repo", "wave"]);
  });

  it("accepts a string of exactly 2,000 characters and slashes that do not start a path", async () => {
    const wave = await makeWave();
    tamper(wave, { note: "a".repeat(2_000), other: "and/or a/b 1/2 https://example.invalid" });
    await expect(write(wave)).resolves.toBeDefined();
  });

  it("keeps a record built through classifyRun clean even when the worker controlled its inputs", async () => {
    const hostile = "/home/evil/.pi/agent/auth.json";
    const runId = "700-t9-code-deepseek-A";
    const output: RunOutput = {
      runId, terminal: "failed", startErrorCode: null,
      usage: {
        session: { input: 10, output: 1, cacheRead: 5, cacheWrite: 0, total: 16, costUsd: 0.2 },
        assistant: { messages: 1, input: 10, output: 1, cacheRead: 5, cacheWrite: 0, costUsd: 0.2 }, providerError: null,
      },
      durationMs: 5, sessionsLeft: 0, assistantTextRef: null, assistantTextTruncated: false, assistantTextSha256: null, mac: null, harnessError: hostile,
    };
    const trace: TraceFindings = {
      outsideWrites: [hostile], unresolvedWrites: 0, deniedWriteAttempts: 0, connects: 1, unresolvedEgress: 0, evidenceLines: [],
      unexpectedConnects: [{ family: "inet6", address: "2001:db8::1", port: 443 }],
    };
    const verdict = classifyRun({ output, timedOut: false, interrupted: false, residualClean: true, trace, guardChanged: false, waveFailure: null });
    expect(verdict).toEqual({ stopReason: "outside_write", harnessError: "invalid_harness_error" });
    const stopped: RunRecord = {
      runId, taskId: "t9", profile: "code-deepseek", arm: "A", pairings: [pairing.id], outcome: "stopped", terminal: output.terminal, accepted: null,
      usage: output.usage, durationMs: output.durationMs, trace: summarizeTrace(trace), stopReason: verdict.stopReason, harnessError: verdict.harnessError,
      assistantTextTruncated: false, assistantTextSha256: null, authType: null,
    };
    const wave = await makeWave((dir) => writeFileSync(join(dir, "runs", `${runId}.json`), `${JSON.stringify(stopped, null, 2)}\n`));
    const summary = await write(wave);
    expect(summary.stopReason).toBe("outside_write");
    for (const file of tree(wave.evidenceDir)) expect(readFileSync(join(wave.evidenceDir, file), "utf8")).not.toContain("/home/evil");
  });

  it("refuses a missing ledger without creating the evidence directory or its parent", async () => {
    const wave = await makeWave();
    const evidenceDir = join(wave.root, "new", "parent", "evidence");
    await expect(writeEvidence(wave.waveDir, evidenceDir, join(wave.root, "nope", "ledger.json"), { repoRoot: wave.repo })).rejects.toThrow("ledger_missing");
    expect(existsSync(join(wave.root, "new"))).toBe(false);
  });

  it("creates a missing parent directory on success and leaves none behind on refusal", async () => {
    const refused = await makeWave((dir) => writeFileSync(join(dir, "runs", "bad.json"), "{}"));
    const deep = join(refused.root, "new", "parent", "evidence");
    await expect(write(refused, deep)).rejects.toThrow("run_record_invalid");
    expect(existsSync(join(refused.root, "new"))).toBe(false);

    const leak = await makeWave();
    tamper(leak, { harnessError: "/tmp/y" });
    await expect(write(leak, join(leak.root, "new", "parent", "evidence"))).rejects.toThrow("evidence_contains_private_data");
    expect(existsSync(join(leak.root, "new"))).toBe(false);

    const wave = await makeWave();
    const target = join(wave.root, "new", "parent", "evidence");
    await write(wave, target);
    expect(tree(target)).toContain("integrity.json");
    expect(readdirSync(join(wave.root, "new", "parent"))).toEqual(["evidence"]);
  });
});

describe("--report arguments", () => {
  const base = ["--report", "--wave", "w", "--ledger", "l.json", "--evidence", "e"];
  it("takes --wave as a value option in report mode", () => {
    expect(parseArgs(base)).toMatchObject({ mode: "--report", waves: ["w"], options: { "--ledger": "l.json", "--evidence": "e" } });
    expect(parseArgs(["--wave", "w", "--ledger", "l.json", "--evidence", "e", "--report"]).mode).toBe("--report");
    expect(parseArgs(["--wave", "w", "--report", "--ledger", "l.json", "--evidence", "e"])).toMatchObject({ mode: "--report", waves: ["w"] });
  });
  it("requires its three options and rejects the others", () => {
    expect(() => parseArgs(["--report", "--ledger", "l.json", "--evidence", "e"])).toThrow("wave_required");
    expect(() => parseArgs(["--report", "--wave", "w", "--evidence", "e"])).toThrow("ledger_required");
    expect(() => parseArgs(["--report", "--wave", "w", "--ledger", "l.json"])).toThrow("evidence_required");
    expect(() => parseArgs([...base, "--tasks", "t.json"])).toThrow("invalid_argument");
    expect(() => parseArgs([...base, "--trim"])).toThrow("invalid_argument");
    expect(() => parseArgs([...base, "--plan"])).toThrow("choose_one_mode");
    expect(() => parseArgs(["--report", "--wave", "--ledger", "l.json", "--evidence", "e"])).toThrow("invalid_argument");
  });
  it("keeps --wave a mode elsewhere and rejects --evidence there", () => {
    expect(parseArgs(["--wave", "--approval", "a.json", "--tasks", "t.json", "--template", "x", "--out", "w", "--ledger", "l.json"]).mode).toBe("--wave");
    expect(() => parseArgs(["--plan", "--tasks", "t.json", "--evidence", "e"])).toThrow("invalid_argument");
  });
});

describe("several waves, approvals and unexpected connects", () => {
  const ledgerIdOf = (wave: Wave): string => JSON.parse(readFileSync(join(wave.waveDir, "approval.json"), "utf8")).ledgerId;
  const notRun = (r: SummaryRecord, overrides: Partial<SummaryRecord> = {}): SummaryRecord =>
    ({ ...r, outcome: "not_run", accepted: null, usage: null, stopReason: null, ...overrides });
  const put = (dir: string, r: SummaryRecord): void => writeFileSync(join(dir, "runs", `${r.runId}.json`), `${JSON.stringify({ ...r, durationMs: 5, harnessError: null })}\n`);
  /** A wave directory with the given records and an approval over them. */
  function waveOf(wave: Wave, name: string, records: SummaryRecord[]): string {
    const dir = join(wave.root, name);
    mkdirSync(join(dir, "runs"), { recursive: true });
    for (const r of records) put(dir, r);
    writeApproval(dir, wave.repo, ledgerIdOf(wave), records);
    return dir;
  }
  const recordsOf = (wave: Wave): SummaryRecord[] => wave.runIds.map((id) => JSON.parse(readFileSync(join(wave.waveDir, "runs", `${id}.json`), "utf8")) as SummaryRecord);
  const merge = (wave: Wave, dirs: string[]) => writeEvidence(dirs, wave.evidenceDir, wave.ledgerPath, { repoRoot: wave.repo });

  it("merges the records of several wave directories per run id, copies each approval and lets an executed record replace a not_run one", async () => {
    const wave = await makeWave();
    // Wave 1 stopped before the last two runs of task t3; wave 2 ran them (R60).
    const all = recordsOf(wave);
    const tail = all.slice(4);
    for (const r of tail) put(wave.waveDir, notRun(r, { stopReason: null }));
    const second = waveOf(wave, "wave-2", tail);
    const summary = await merge(wave, [wave.waveDir, second]);
    const runFiles = tree(wave.evidenceDir).filter((f) => f.startsWith("runs/"));
    expect(runFiles).toHaveLength(RUN_COUNT);
    expect(tree(wave.evidenceDir).filter((f) => f.startsWith("approvals/"))).toEqual(["approvals/approval-1.json", "approvals/approval-2.json"]);
    for (const r of tail) expect(readFileSync(join(wave.evidenceDir, "runs", `${r.runId}.json`), "utf8")).toBe(readFileSync(join(second, "runs", `${r.runId}.json`), "utf8"));
    expect(readFileSync(join(wave.evidenceDir, "runs", `${all[0]!.runId}.json`), "utf8")).toBe(readFileSync(join(wave.waveDir, "runs", `${all[0]!.runId}.json`), "utf8"));
    expect(summary.pairings.find((p) => p.id === pairing.id)?.tasks).toEqual(["t1", "t2", "t3"]);
    // The order of the directories does not matter.
    rmSync(wave.evidenceDir, { recursive: true });
    await merge(wave, [second, wave.waveDir]);
    expect(readFileSync(join(wave.evidenceDir, "runs", `${tail[0]!.runId}.json`), "utf8")).toBe(readFileSync(join(second, "runs", `${tail[0]!.runId}.json`), "utf8"));
  });

  it("keeps every recorded stop in waveStops, also one that a later wave's executed record superseded (M1)", async () => {
    const wave = await makeWave();
    const last = recordsOf(wave)[5]!;
    put(wave.waveDir, notRun(last, { stopReason: "wave_timeout" }));
    const second = waveOf(wave, "wave-2", [last]);
    const summary = await merge(wave, [wave.waveDir, second]);
    expect(summary.waveStops).toEqual([{ wave: 1, runId: last.runId, stopReason: "wave_timeout" }]);
    expect(summary.stopReason).toBeNull();
    const written = JSON.parse(readFileSync(join(wave.evidenceDir, "summary.json"), "utf8")) as { waveStops: unknown };
    expect(written.waveStops).toEqual(summary.waveStops);
    expect(summarize([]).waveStops).toEqual([]);
  });

  it("collapses several not_run records of one run id, and keeps a not_run slot nobody executed", async () => {
    const wave = await makeWave();
    const last = recordsOf(wave)[5]!;
    put(wave.waveDir, notRun(last, { stopReason: "budget" }));
    const second = waveOf(wave, "wave-2", [notRun(last)]);
    const third = waveOf(wave, "wave-3", [notRun(last)]);
    const summary = await merge(wave, [wave.waveDir, second, third]);
    expect(tree(wave.evidenceDir).filter((f) => f.startsWith("runs/"))).toHaveLength(RUN_COUNT);
    expect(summary.pairings.find((p) => p.id === pairing.id)?.tasks).toEqual(["t1", "t2"]);
  });

  it("refuses two executed records of one run id, and a run id that changes its task, profile or arm", async () => {
    const wave = await makeWave();
    const [first] = recordsOf(wave);
    const twice = waveOf(wave, "wave-2", [{ ...first!, accepted: !first!.accepted }]);
    await expect(merge(wave, [wave.waveDir, twice])).rejects.toThrow("duplicate_run_record");
    for (const change of [{ taskId: "other" }, { profile: "code" as const }, { arm: "pi-lens" as const }]) {
      const moved = waveOf(wave, `wave-${Object.keys(change)[0]}`, [notRun({ ...first!, ...change })]);
      await expect(merge(wave, [wave.waveDir, moved])).rejects.toThrow("duplicate_run_record");
    }
    expect(existsSync(wave.evidenceDir)).toBe(false);
  });

  it("refuses a run id that two waves share, and a wave named twice", async () => {
    const wave = await makeWave();
    const second = join(wave.root, "wave-2");
    mkdirSync(join(second, "runs"), { recursive: true });
    const file = readdirSync(join(wave.waveDir, "runs"))[0]!;
    writeFileSync(join(second, "runs", file), readFileSync(join(wave.waveDir, "runs", file)));
    writeApproval(second, wave.repo, JSON.parse(readFileSync(join(wave.waveDir, "approval.json"), "utf8")).ledgerId, [record("t9", "A", true)]);
    await expect(writeEvidence([wave.waveDir, second], wave.evidenceDir, wave.ledgerPath, { repoRoot: wave.repo })).rejects.toThrow("duplicate_run_record");
    expect(existsSync(wave.evidenceDir)).toBe(false);
    await expect(writeEvidence([wave.waveDir, wave.waveDir], wave.evidenceDir, wave.ledgerPath, { repoRoot: wave.repo })).rejects.toThrow("wave_required");
  });

  it("refuses a wave without its approval, with an invalid one, or under another ledger", async () => {
    const missing = await makeWave((dir) => { /* approval written afterwards */ void dir; });
    rmSync(join(missing.waveDir, "approval.json"));
    await expect(write(missing)).rejects.toThrow("approval_missing");
    writeFileSync(join(missing.waveDir, "approval.json"), "{ not json");
    await expect(write(missing)).rejects.toThrow("approval_invalid");
    writeFileSync(join(missing.waveDir, "approval.json"), JSON.stringify({ approved: false }));
    await expect(write(missing)).rejects.toThrow("approval_invalid");
    const other = await makeWave();
    writeApproval(other.waveDir, other.repo, "99999999-9999-4999-8999-999999999999", [record("t1", "A", true)]);
    await expect(write(other)).rejects.toThrow("ledger_mismatch");
  });

  it("refuses evidence when the bound code changed since the approval's commit, and for an unknown commit", async () => {
    const wave = await makeWave();
    writeFileSync(join(wave.repo, "src", "a.ts"), "export const a = 2;\n");
    commitAll(wave.repo, "src moved on");
    await expect(write(wave)).rejects.toThrow("approval_source_mismatch");
    const unknown = await makeWave();
    const approval = JSON.parse(readFileSync(join(unknown.waveDir, "approval.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(unknown.waveDir, "approval.json"), JSON.stringify({ ...approval, sourceCommit: "f".repeat(40) }));
    await expect(write(unknown)).rejects.toThrow("approval_source_mismatch");
  });

  it("reports the unexpected connects per pairing and arm", async () => {
    const wave = await makeWave();
    const first = JSON.parse(readFileSync(join(wave.waveDir, "runs", `${wave.runIds[0]}.json`), "utf8")) as { arm: string };
    expect(first.arm).toBe("A");
    tamper(wave, { trace: { unexpectedConnectCount: 3, unexpectedConnects: [] } });
    const summary = await write(wave);
    const found = summary.pairings.find((p) => p.id === pairing.id)!;
    expect(found.a.unexpectedConnects).toBe(3);
    expect(found.b.unexpectedConnects).toBe(0);
  });
});

describe("--allow-source-drift (R89)", () => {
  const base = ["--report", "--wave", "w", "--ledger", "l.json", "--evidence", "e"];
  const approvalCommit = (dir: string) => (JSON.parse(readFileSync(join(dir, "approval.json"), "utf8")) as { sourceCommit: string }).sourceCommit;
  const drifted = (wave: Wave) => writeEvidence(wave.waveDir, wave.evidenceDir, wave.ledgerPath, { repoRoot: wave.repo, allowSourceDrift: true });
  /** A second wave dir with one record of its own, approved at the repository's current commit and under the first wave's ledger. */
  function secondWave(wave: Wave, name = "wave-2"): string {
    const dir = join(wave.root, name);
    mkdirSync(join(dir, "runs"), { recursive: true });
    const own = record("t9", "A", true);
    writeFileSync(join(dir, "runs", `${own.runId}.json`), `${JSON.stringify({ ...own, durationMs: 5, harnessError: null })}\n`);
    writeApproval(dir, wave.repo, (JSON.parse(readFileSync(join(wave.waveDir, "approval.json"), "utf8")) as { ledgerId: string }).ledgerId, [own]);
    return dir;
  }

  it("is a report option only", () => {
    expect(parseArgs([...base, "--allow-source-drift"])).toMatchObject({ mode: "--report", allowSourceDrift: true });
    expect(parseArgs(base).allowSourceDrift).toBe(false);
    expect(parseArgs(["--allow-source-drift", ...base]).allowSourceDrift).toBe(true);
    for (const other of [
      ["--plan", "--tasks", "t.json"], ["--scan", "--transcripts", "t", "--out", "o"], ["--dry-load", "--tasks", "t.json", "--template", "x", "--out", "o"],
      ["--wave", "--approval", "a.json", "--tasks", "t.json", "--template", "x", "--out", "w", "--ledger", "l.json"],
      ["--preflight", "--approval", "a.json", "--tasks", "t.json", "--out", "w", "--ledger", "l.json"],
    ]) expect(() => parseArgs([...other, "--allow-source-drift"])).toThrow("invalid_argument");
  });

  it("still refuses a difference in the bound code by default, and adds nothing to the output", async () => {
    const wave = await makeWave();
    writeFileSync(join(wave.repo, "src", "a.ts"), "export const a = 2;\n");
    commitAll(wave.repo, "src moved on");
    await expect(write(wave)).rejects.toThrow("approval_source_mismatch");
    const unchanged = await makeWave();
    const summary = await write(unchanged);
    expect(summary).not.toHaveProperty("sourceDrift");
    expect(integrityOf(unchanged.evidenceDir)).not.toHaveProperty("source_drift");
  });

  it("accepts an ancestor commit and records the bound paths that changed, in summary.json and integrity.json, without absolute paths", async () => {
    const wave = await makeWave();
    const commit = approvalCommit(wave.waveDir);
    writeFileSync(join(wave.repo, "src", "a.ts"), "export const a = 2;\n");
    writeFileSync(join(wave.repo, "eval", "extensions", "x.ts"), "export const x = 2;\n");
    writeFileSync(join(wave.repo, "docs", "notes.md"), "changed notes\n");
    commitAll(wave.repo, "moved on");
    const summary = await drifted(wave);
    const expected = [{ wave: 1, sourceCommit: commit, boundPathsChangedSinceSource: ["eval/extensions/x.ts", "src/a.ts"], allowSourceDrift: true }];
    expect(summary.sourceDrift).toEqual(expected);
    expect(JSON.parse(readFileSync(join(wave.evidenceDir, "summary.json"), "utf8")).sourceDrift).toEqual(expected);
    expect((integrityOf(wave.evidenceDir) as unknown as { source_drift: unknown }).source_drift).toEqual(expected);
    // The integrity index covers the summary, and nothing names a directory of this machine.
    const index = integrityOf(wave.evidenceDir);
    expect(index.files.find((f) => f.path === "summary.json")!.hash).toBe(hash(readFileSync(join(wave.evidenceDir, "summary.json"))));
    for (const file of tree(wave.evidenceDir)) expect(readFileSync(join(wave.evidenceDir, file), "utf8")).not.toContain(wave.root);
  });

  it("records an empty list when nothing bound changed, and a list per wave in the order of the --wave arguments", async () => {
    const wave = await makeWave();
    writeFileSync(join(wave.repo, "docs", "notes.md"), "changed notes\n");
    commitAll(wave.repo, "docs only");
    expect((await drifted(wave)).sourceDrift).toEqual([{ wave: 1, sourceCommit: approvalCommit(wave.waveDir), boundPathsChangedSinceSource: [], allowSourceDrift: true }]);

    const two = await makeWave();
    writeFileSync(join(two.repo, "src", "a.ts"), "export const a = 2;\n");
    commitAll(two.repo, "src moved on");
    const later = secondWave(two);
    const forward = await writeEvidence([two.waveDir, later], two.evidenceDir, two.ledgerPath, { repoRoot: two.repo, allowSourceDrift: true });
    expect(forward.sourceDrift!.map((d) => [d.wave, d.sourceCommit === approvalCommit(two.waveDir), d.boundPathsChangedSinceSource])).toEqual([[1, true, ["src/a.ts"]], [2, false, []]]);
    const reversed = await writeEvidence([later, two.waveDir], join(two.root, "evidence-reversed"), two.ledgerPath, { repoRoot: two.repo, allowSourceDrift: true });
    expect(reversed.sourceDrift!.map((d) => [d.wave, d.boundPathsChangedSinceSource])).toEqual([[1, []], [2, ["src/a.ts"]]]);
    // Strict mode refuses the same two waves because of the first.
    await expect(writeEvidence([two.waveDir, later], join(two.root, "evidence-strict"), two.ledgerPath, { repoRoot: two.repo })).rejects.toThrow("approval_source_mismatch");
  });

  it("refuses a commit that is not an ancestor of HEAD, an unknown one and one that is not a commit id, with nothing written", async () => {
    const wave = await makeWave();
    // A commit on a side branch: it exists, but HEAD does not contain it.
    const original = git(wave.repo, "rev-parse", "--abbrev-ref", "HEAD").trim();
    git(wave.repo, "checkout", "--quiet", "-b", "side");
    writeFileSync(join(wave.repo, "src", "a.ts"), "export const a = 3;\n");
    commitAll(wave.repo, "side");
    const side = git(wave.repo, "rev-parse", "HEAD").trim();
    git(wave.repo, "checkout", "--quiet", original);
    expect(() => git(wave.repo, "merge-base", "--is-ancestor", side, "HEAD")).toThrow(); // the side commit is not an ancestor of HEAD
    const approval = JSON.parse(readFileSync(join(wave.waveDir, "approval.json"), "utf8")) as Record<string, unknown>;
    for (const sourceCommit of [side, "f".repeat(40), "main", "HEAD", "A".repeat(40)]) {
      writeFileSync(join(wave.waveDir, "approval.json"), JSON.stringify({ ...approval, sourceCommit }));
      await expect(drifted(wave), sourceCommit).rejects.toThrow("approval_source_unknown");
    }
    expect(existsSync(wave.evidenceDir)).toBe(false);
  });
});

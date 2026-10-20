import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
    expect(found.cacheReadShare).toEqual({ a: 0.25, b: 0.75 });
    expect(result([record("t1", "A", true, { usage: null })]).cacheReadShare).toEqual({ a: 0, b: 0 });
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
async function makeWave(extra: (dir: string) => void = () => undefined): Promise<{ root: string; waveDir: string; ledgerPath: string; evidenceDir: string }> {
  const root = await temporaryRoot("ablation-report-");
  const waveDir = join(root, "wave");
  mkdirSync(join(waveDir, "runs"), { recursive: true });
  const records = [...pair("t1", false, true), ...pair("t2", true, true), ...pair("t3", true, true)];
  expect(records).toHaveLength(RUN_COUNT);
  for (const r of records) writeFileSync(join(waveDir, "runs", `${r.runId}.json`), `${JSON.stringify({ ...r, durationMs: 5, harnessError: null })}\n`);
  const ledgerPath = join(root, "ledger", "ledger.json");
  const ledger = new PersistedLedger(ledgerPath);
  await ledger.record(records[0]!.runId, "code-deepseek", 0.3);
  await ledger.record(records[1]!.runId, "code-deepseek", 0.2);
  await ledger.recordEstimate(records[2]!.runId, "code-deepseek");
  extra(waveDir);
  return { root, waveDir, ledgerPath, evidenceDir: join(root, "evidence") };
}

const tree = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(dir.length + 1)).sort();

describe("writeEvidence", () => {
  it("writes the runs, the ledger, the summary and an integrity index that matches the files", async () => {
    const { waveDir, ledgerPath, evidenceDir } = await makeWave();
    const summary = await writeEvidence(waveDir, evidenceDir, ledgerPath);
    expect(summary.pairings.find((p) => p.id === pairing.id)?.recommendation).toBe("enable");

    const files = tree(evidenceDir);
    expect(files).toHaveLength(RUN_COUNT + 3);
    expect(files).toContain("ledger.json");
    expect(files).toContain("summary.json");
    expect(files).toContain("integrity.json");

    const integrity = JSON.parse(readFileSync(join(evidenceDir, "integrity.json"), "utf8")) as {
      kind: string; source_binding: { commit: string; digest: string }; files: { path: string; hash: string }[];
    };
    expect(integrity.kind).toBe("extension-ablation-evidence-integrity");
    expect(integrity.source_binding.commit).toBe(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim());
    expect(integrity.source_binding.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(integrity.files.map((f) => f.path)).toEqual(files.filter((f) => f !== "integrity.json"));
    for (const entry of integrity.files) expect(entry.hash).toBe(hash(readFileSync(join(evidenceDir, entry.path))));

    for (const name of readdirSync(join(waveDir, "runs"))) {
      expect(readFileSync(join(evidenceDir, "runs", name), "utf8")).toBe(readFileSync(join(waveDir, "runs", name), "utf8"));
    }
  });

  it("reports observed and estimated spend separately", async () => {
    const { waveDir, ledgerPath, evidenceDir } = await makeWave();
    await writeEvidence(waveDir, evidenceDir, ledgerPath);
    const written = JSON.parse(readFileSync(join(evidenceDir, "summary.json"), "utf8")) as { spend: { observedUsd: number; estimatedUsd: number }; spentUsd: number };
    expect(written.spend.observedUsd).toBeCloseTo(0.5);
    expect(written.spend.estimatedUsd).toBeCloseTo(0.3);
    expect(written.spentUsd).toBeCloseTo(0.8);
  });

  it("only copies run records, never other files of the wave", async () => {
    const { waveDir, ledgerPath, evidenceDir } = await makeWave((dir) => {
      mkdirSync(join(dir, "private", "x"), { recursive: true });
      writeFileSync(join(dir, "private", "x", "strace.log"), "secret");
      writeFileSync(join(dir, "runs", "notes.txt"), "not a record");
    });
    await writeEvidence(waveDir, evidenceDir, ledgerPath);
    expect(tree(evidenceDir).filter((f) => !f.startsWith("runs/"))).toEqual(["integrity.json", "ledger.json", "summary.json"]);
    expect(tree(evidenceDir).filter((f) => f.startsWith("runs/"))).toHaveLength(RUN_COUNT);
  });

  it("refuses an existing evidence directory and leaves it untouched", async () => {
    const { waveDir, ledgerPath, evidenceDir } = await makeWave();
    mkdirSync(evidenceDir);
    writeFileSync(join(evidenceDir, "keep.txt"), "x");
    await expect(writeEvidence(waveDir, evidenceDir, ledgerPath)).rejects.toThrow("evidence_dir_exists");
    expect(readdirSync(evidenceDir)).toEqual(["keep.txt"]);
  });

  it("refuses a record whose name does not match its run id", async () => {
    const { waveDir, ledgerPath, evidenceDir } = await makeWave((dir) => writeFileSync(join(dir, "runs", "other.json"), JSON.stringify(record("t1", "A", true))));
    await expect(writeEvidence(waveDir, evidenceDir, ledgerPath)).rejects.toThrow("run_record_invalid");
    expect(existsSync(evidenceDir)).toBe(false);
  });

  const leaks: [string, (waveDir: string) => Record<string, unknown>][] = [
    ["the home path", () => ({ harnessError: `read ${homedir()}` })],
    ["the wave directory", (waveDir) => ({ harnessError: `at ${waveDir}` })],
    ["an absolute path", () => ({ harnessError: "/etc/passwd" })],
    ["a credential key", () => ({ nested: { access: "x" } })],
    ["a refresh key", () => ({ refresh: "x" })],
    ["a key field", () => ({ key: "x" })],
    ["a long string", () => ({ note: "a".repeat(2_001) })],
  ];
  it.each(leaks)("refuses evidence that leaks %s and leaves no partial directory", async (_name, extra) => {
    const first = record("t1", "A", true);
    const { root, waveDir, ledgerPath, evidenceDir } = await makeWave((dir) =>
      writeFileSync(join(dir, "runs", `${first.runId}.json`), JSON.stringify({ ...first, ...extra(dir) })));
    await expect(writeEvidence(waveDir, evidenceDir, ledgerPath)).rejects.toThrow("evidence_contains_private_data");
    expect(existsSync(evidenceDir)).toBe(false);
    expect(readdirSync(root).sort()).toEqual(["ledger", "wave"]);
  });

  it("accepts a string of exactly 2,000 characters", async () => {
    const first = record("t1", "A", true);
    const { waveDir, ledgerPath, evidenceDir } = await makeWave((dir) =>
      writeFileSync(join(dir, "runs", `${first.runId}.json`), JSON.stringify({ ...first, note: "a".repeat(2_000) })));
    await expect(writeEvidence(waveDir, evidenceDir, ledgerPath)).resolves.toBeDefined();
  });

  it("refuses a missing ledger without creating the evidence directory", async () => {
    const { waveDir, root, evidenceDir } = await makeWave();
    await expect(writeEvidence(waveDir, evidenceDir, join(root, "nope", "ledger.json"))).rejects.toThrow("ledger_missing");
    expect(existsSync(evidenceDir)).toBe(false);
    expect(existsSync(dirname(evidenceDir))).toBe(true);
  });
});

describe("--report arguments", () => {
  const base = ["--report", "--wave", "w", "--ledger", "l.json", "--evidence", "e"];
  it("takes --wave as a value option in report mode", () => {
    expect(parseArgs(base)).toMatchObject({ mode: "--report", options: { "--wave": "w", "--ledger": "l.json", "--evidence": "e" } });
    expect(parseArgs(["--wave", "w", "--ledger", "l.json", "--evidence", "e", "--report"]).mode).toBe("--report");
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

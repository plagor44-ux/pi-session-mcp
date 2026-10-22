import { describe, expect, it } from "vitest";
import { BUDGET_USD, BudgetLedger, INITIAL_RUN_ESTIMATE_USD } from "../eval/extensions/budget.js";
import { PAIRINGS, buildMatrix, trimMatrix } from "../eval/extensions/matrix.js";
import { parseArgs } from "../eval/extensions/cli.js";
import { pairingSchema, runSpecSchema, taskSpecSchema, type TaskSpec } from "../eval/extensions/schemas.js";

const HASH = `sha256:${"a".repeat(64)}` as const;

function base(id: string) {
  return {
    id, repo: "pi-session-mcp", baseCommit: "b".repeat(40), promptRef: `eval/results/extensions/prompts/${id}.txt`,
    promptHash: HASH, sourceSession: `session-${id}`, allowedPaths: ["src/config.ts"], scopeIgnore: ["dist/"],
  };
}
function review(id: string): TaskSpec {
  return {
    ...base(id), kind: "review",
    oracle: {
      kind: "review", verdict: { pattern: "approved|looks good" },
      findings: [{ id: "F1", critical: true, anchors: [{ file: "src/config.ts", terms: ["alias"] }] }],
      falseFindings: [{ id: "X1", anchors: [{ file: "src/config.ts", terms: ["cwd"] }] }],
    },
  };
}
function impl(id: string): TaskSpec {
  return { ...base(id), kind: "implementation", oracle: { kind: "implementation", command: ["npx", "vitest", "run"], timeoutMs: 60000 } };
}

describe("extension ablation matrix", () => {
  it("pairs review tasks with review profiles and implementation tasks with coding profiles", () => {
    const runs = buildMatrix([review("R1"), impl("I1")], PAIRINGS);
    expect(new Set(runs.filter(r => r.taskId === "R1").map(r => r.profile))).toEqual(new Set(["review-grok", "review"]));
    expect(new Set(runs.filter(r => r.taskId === "I1").map(r => r.profile))).toEqual(new Set(["code-deepseek", "code"]));
  });
  it("shares one arm-A run per task and profile across pairings", () => {
    const runs = buildMatrix([review("R1")], PAIRINGS);
    const a = runs.filter(r => r.profile === "review" && r.arm === "A");
    expect(a).toHaveLength(1);
    expect(a[0]!.pairings.sort()).toEqual(["co-review", "pl-review"]);
  });
  it("orders by pairing priority and alternates arm A position per task", () => {
    const runs = buildMatrix([impl("I1"), impl("I2")], PAIRINGS);
    expect(runs[0]!.profile).toBe("code-deepseek");
    const cd = runs.filter(r => r.profile === "code-deepseek");
    expect(cd.map(r => r.arm)).toEqual(["A", "pi-lens", "pi-lens", "A"]);
  });
  it("numbers runs by execution order and builds the run id from it", () => {
    const runs = buildMatrix([impl("I1")], PAIRINGS);
    expect(runs.map(r => r.ordinal)).toEqual(runs.map((_, i) => i + 1));
    expect(runs[0]!.runId).toBe("001-I1-code-deepseek-A");
    for (const r of runs) expect(runSpecSchema.parse(r)).toEqual(r);
  });
  it("runs a co-* B run after its already-run arm A", () => {
    const runs = buildMatrix([impl("I1")], PAIRINGS);
    const pos = (profile: string, arm: string) => runs.findIndex(r => r.profile === profile && r.arm === arm);
    expect(pos("code", "A")).toBeLessThan(pos("code", "pi-cache-optimizer"));
    expect(pos("code", "pi-lens")).toBeLessThan(pos("code", "pi-cache-optimizer"));
    expect(runs[pos("code", "A")]!.pairings.sort()).toEqual(["co-code", "pl-code"]);
  });
  it("alternates arm A per task index within its kind on an interleaved list", () => {
    const runs = buildMatrix([review("R1"), impl("I1"), review("R2"), impl("I2")], PAIRINGS);
    const arms = (profile: string) => runs.filter(r => r.profile === profile && r.arm !== "pi-cache-optimizer").map(r => r.arm);
    expect(arms("review-grok")).toEqual(["A", "pi-lens", "pi-lens", "A"]);
    expect(arms("code-deepseek")).toEqual(["A", "pi-lens", "pi-lens", "A"]);
  });
  it("gives a shared arm-A run the most urgent priority of the pairings it serves", () => {
    const at = (runs: ReturnType<typeof buildMatrix>, arm: string, task: string) => runs.findIndex(r => r.profile === "code" && r.arm === arm && r.taskId === task);
    const one = buildMatrix([impl("I1")], PAIRINGS);
    expect(at(one, "A", "I1")).toBeLessThan(at(one, "pi-lens", "I1"));
    expect(at(one, "A", "I1")).toBeLessThan(at(one, "pi-cache-optimizer", "I1"));
    const two = buildMatrix([impl("I1"), impl("I2")], PAIRINGS);
    expect(at(two, "A", "I2")).toBeLessThan(at(two, "pi-cache-optimizer", "I1"));
  });
  it("runs review-grok before review at the same priority", () => {
    const runs = buildMatrix([review("R1")], PAIRINGS);
    const grok = runs.flatMap((r, i) => r.profile === "review-grok" ? [i] : []);
    const plain = runs.flatMap((r, i) => r.profile === "review" ? [i] : []);
    expect(Math.max(...grok)).toBeLessThan(Math.min(...plain));
  });
  it("rejects duplicate task ids", () => {
    expect(() => buildMatrix([impl("I1"), impl("I1")], PAIRINGS)).toThrow("duplicate_task_id");
    expect(() => trimMatrix([impl("I1"), impl("I1")], PAIRINGS, () => 0, 10)).toThrow("duplicate_task_id");
  });
  it("trims co-review first, then co-code, then pl-review, until the budget fits", () => {
    const tasks = ["I1","I2","I3","I4","R1","R2","R3","R4"].map(id => id[0] === "I" ? impl(id) : review(id));
    const cost = (runs: unknown[]) => runs.length * 0.5;
    const four = (p: string) => (p[0] === "I" ? ["I1","I2","I3","I4"] : ["R1","R2","R3","R4"]);
    const a = trimMatrix(tasks, PAIRINGS, cost, 19.5);
    expect(a.tasksPerPairing).toEqual({
      "pl-code-deepseek": four("I"), "pl-code": four("I"), "pl-review-grok": four("R"), "pl-review": four("R"),
      "co-code": four("I"), "co-review": ["R1","R2","R3"],
    });
    expect(a.runs).toHaveLength(39);
    const b = trimMatrix(tasks, PAIRINGS, cost, 18.5);
    expect(b.tasksPerPairing).toEqual({
      "pl-code-deepseek": four("I"), "pl-code": four("I"), "pl-review-grok": four("R"), "pl-review": ["R1","R2","R3"],
      "co-code": ["I1","I2","I3"], "co-review": ["R1","R2","R3"],
    });
    expect(b.runs).toHaveLength(36);
  });
  it("trims tasks from the lowest priority first, never below 3, then drops whole pairings", () => {
    const tasks = ["I1","I2","I3","I4","R1","R2","R3","R4"].map(id => id[0] === "I" ? impl(id) : review(id));
    const t = trimMatrix(tasks, PAIRINGS, (runs) => runs.length * 0.5, 10);   // full matrix: 40 runs = USD 20
    expect(t.pairings.map(p => p.id)).toEqual(["pl-code-deepseek", "pl-code", "pl-review-grok"]);
    expect(Object.values(t.tasksPerPairing)).toEqual([["I1","I2","I3"], ["I1","I2","I3"], ["R1","R2","R3"]]);
    expect(t.runs).toHaveLength(18);
  });
  it("keeps the full matrix when it fits the budget", () => {
    const tasks = ["I1","I2","I3","I4","R1","R2","R3","R4"].map(id => id[0] === "I" ? impl(id) : review(id));
    const t = trimMatrix(tasks, PAIRINGS, (runs) => runs.length * 0.5, 20);
    expect(t.pairings).toHaveLength(6);
    expect(t.runs).toHaveLength(40);
    expect(t.tasksPerPairing["co-review"]).toEqual(["R1","R2","R3","R4"]);
  });
  it("returns an empty plan when nothing fits", () => {
    const t = trimMatrix([impl("I1"), impl("I2"), impl("I3")], PAIRINGS, (runs) => runs.length, 0);
    expect(t.pairings).toEqual([]);
    expect(t.runs).toEqual([]);
  });
  it("keeps the canonical run ids, ordinals and order in every subset of the matrix (R58)", () => {
    const tasks = ["I1","I2","I3","I4","R1","R2","R3","R4"].map(id => id[0] === "I" ? impl(id) : review(id));
    const full = buildMatrix(tasks, PAIRINGS);
    const byId = new Map(full.map(r => [r.runId, r]));
    const subsets = {
      pairings: buildMatrix(tasks, PAIRINGS.filter(p => p.id === "pl-review" || p.id === "co-code")),
      trimmed: trimMatrix(tasks, PAIRINGS, (runs) => runs.length * 0.5, 10).runs,
      single: buildMatrix(tasks, PAIRINGS.filter(p => p.id === "pl-code")),
    };
    for (const runs of Object.values(subsets)) {
      expect(runs.length).toBeGreaterThan(0);
      expect(runs.length).toBeLessThan(full.length);
      for (const run of runs) {
        const canonical = byId.get(run.runId)!;
        expect(canonical).toBeDefined();
        expect({ ...run, pairings: undefined }).toEqual({ ...canonical, pairings: undefined });
        // The pairings of a run are the subset that selected it in this plan.
        expect(run.pairings.every(id => canonical.pairings.includes(id))).toBe(true);
      }
      expect(runs.map(r => r.ordinal)).toEqual([...runs.map(r => r.ordinal)].sort((a, b) => a - b));
    }
    // Ordinals have gaps in a subset, and the shared arm-A run lists only the selected pairing.
    expect(subsets.single.map(r => r.ordinal)).not.toEqual(subsets.single.map((_, i) => i + 1));
    const sharedA = subsets.pairings.find(r => r.profile === "review" && r.arm === "A" && r.taskId === "R1")!;
    expect(sharedA.pairings).toEqual(["pl-review"]);
    expect(byId.get(sharedA.runId)!.pairings.sort()).toEqual(["co-review", "pl-review"]);
  });
  it("leaves out the run ids in skip, before trimming, and projects only what remains (R59)", () => {
    const tasks = [impl("I1"), impl("I2"), impl("I3")];
    const full = buildMatrix(tasks, PAIRINGS);
    const skip = new Set(full.slice(0, 2).map(r => r.runId));
    const rest = buildMatrix(tasks, PAIRINGS, skip);
    expect(rest).toEqual(full.slice(2));
    const seen: number[] = [];
    const t = trimMatrix(tasks, PAIRINGS, (runs) => { seen.push(runs.length); return runs.length; }, 100, skip);
    expect(seen[0]).toBe(full.length - 2);
    expect(t.runs).toEqual(rest);
    expect(t.runs.every(r => !skip.has(r.runId))).toBe(true);
  });
  it("grants the pre-registered pi-lens tools on review profiles only", () => {
    const granted = ["symbol_search", "project_report", "read_symbol", "read_enclosing", "module_report"];
    expect(PAIRINGS.find(p => p.id === "pl-review")!.grantedExtensionTools).toEqual(granted);
    expect(PAIRINGS.find(p => p.id === "pl-review-grok")!.grantedExtensionTools).toEqual(granted);
    expect(PAIRINGS.find(p => p.id === "pl-code")!.grantedExtensionTools).toBeUndefined();
    expect(PAIRINGS.find(p => p.id === "co-review")!.grantedExtensionTools).toBeUndefined();
    expect(PAIRINGS.map(p => [p.id, p.priority])).toEqual([
      ["pl-code-deepseek", 1], ["pl-code", 2], ["pl-review-grok", 3], ["pl-review", 3], ["co-code", 4], ["co-review", 4],
    ]);
    for (const p of PAIRINGS) expect(pairingSchema.parse(p)).toEqual(p);
  });
});

describe("the review verdict pattern (R78)", () => {
  const withVerdict = (verdict: unknown): unknown => { const task = review("R1"); return { ...task, oracle: { ...task.oracle, verdict } }; };

  it("is required and must be a pattern that compiles, is not empty and has at most 500 characters", () => {
    expect(taskSpecSchema.safeParse(withVerdict({ pattern: "^verdict:\\s*ready" })).success).toBe(true);
    expect(taskSpecSchema.safeParse(withVerdict({ pattern: "a".repeat(500) })).success).toBe(true);
    expect(taskSpecSchema.safeParse(withVerdict({ pattern: "a".repeat(501) })).success).toBe(false);
    expect(taskSpecSchema.safeParse(withVerdict({ pattern: "" })).success).toBe(false);
    expect(taskSpecSchema.safeParse(withVerdict({ pattern: "(unclosed" })).success).toBe(false);
    expect(taskSpecSchema.safeParse(withVerdict({ pattern: "[z-a]" })).success).toBe(false);
    expect(taskSpecSchema.safeParse(withVerdict({ pattern: "x", flags: "g" })).success).toBe(false);
    expect(taskSpecSchema.safeParse(withVerdict({})).success).toBe(false);
    expect(taskSpecSchema.safeParse(withVerdict("verdict")).success).toBe(false);
    expect(taskSpecSchema.safeParse(withVerdict(undefined)).success).toBe(false);
  });
});

describe("verdict patterns must run in linear time (R80)", () => {
  const withVerdict = (pattern: string) => { const task = review("R1"); return { ...task, oracle: { ...task.oracle, verdict: { pattern } } }; };
  const issue = (pattern: string): string | undefined => {
    const result = taskSpecSchema.safeParse(withVerdict(pattern));
    return result.success ? undefined : result.error.issues[0]?.message;
  };

  it.each([
    "(a+)+", "^(\\w+\\s?)+$", "(\\w+\\s?)*", "(?:x*){2,}", "(x+)*", "((a+))+", "(a|b+)*c", "(a?b)+", "(?<w>a+){2,5}",
    "(a)\\1", "(?<w>a)\\k<w>", "^(ok)\\2?",
  ])("refuses %s as unsafe", (pattern) => {
    expect(issue(pattern)).toBe("verdict_pattern_unsafe");
  });

  it.each([
    "^.*\\b(request changes|blocker)\\b", "^verdict:\\s*(not ready|reject)", "(?:a+)?", "(a+)b+", "(abc){2}", "(a*)(b*)", "(?:foo|bar)+", "\\d{1,3}",
    "[(a+)+]", "\\(a+\\)+", "(?<=x)a+", "(?!x)a+(?:b)", "a{", "(a){1}", "(a+)?", "(foo)+?bar", "approve|ship it",
  ])("accepts %s", (pattern) => {
    expect(issue(pattern)).toBeUndefined();
  });

  it("still reports an uncompilable pattern as invalid, not unsafe", () => {
    expect(issue("(unclosed")).toBe("verdict_pattern_invalid");
  });
});

describe("a review oracle needs a critical finding (R80)", () => {
  it("refuses one whose findings are all non-critical or empty", () => {
    const task = review("R1");
    const oracle = task.oracle as Extract<TaskSpec["oracle"], { kind: "review" }>;
    const finding = oracle.findings[0]!;
    expect(taskSpecSchema.safeParse(task).success).toBe(true);
    const none = taskSpecSchema.safeParse({ ...task, oracle: { ...oracle, findings: [{ ...finding, critical: false }] } });
    expect(none.success).toBe(false);
    expect(none.success ? undefined : none.error.issues[0]?.message).toBe("review_oracle_no_critical");
    expect(taskSpecSchema.safeParse({ ...task, oracle: { ...oracle, findings: [] } }).success).toBe(false);
    expect(taskSpecSchema.safeParse({ ...task, oracle: { ...oracle, findings: [{ ...finding, critical: false }, { ...finding, id: "F2", critical: true }] } }).success).toBe(true);
  });
});

describe("extension ablation schemas", () => {
  it("accepts valid tasks of both kinds and rejects unknown keys and a kind mismatch", () => {
    expect(taskSpecSchema.parse(review("R1"))).toEqual(review("R1"));
    expect(taskSpecSchema.parse(impl("I1"))).toEqual(impl("I1"));
    expect(() => taskSpecSchema.parse({ ...impl("I1"), extra: 1 })).toThrow();
    expect(() => taskSpecSchema.parse({ ...impl("I1"), oracle: { kind: "implementation", command: ["x"], timeoutMs: 1, cwd: "/" } })).toThrow();
    expect(() => taskSpecSchema.parse({ ...impl("I1"), kind: "review" })).toThrow();
    expect(() => taskSpecSchema.parse({ ...impl("I1"), baseCommit: "abc" })).toThrow();
  });
});

describe("extension ablation budget ledger", () => {
  it("constants", () => {
    expect(BUDGET_USD).toBe(10);
    expect(INITIAL_RUN_ESTIMATE_USD).toBe(1);
  });
  it("null cost keeps the estimate; the most expensive observed run drives it", () => {
    const l = new BudgetLedger(10);
    expect(l.estimate("code")).toBe(1);
    l.record("code-deepseek", 0.02); l.record("code-deepseek", null);
    expect(l.estimate("code-deepseek")).toBe(0.02);
    expect(l.estimate("code")).toBe(1);
    l.record("code", 0.4);
    expect(l.estimate("code-deepseek")).toBe(0.4);
    expect(l.spentUsd).toBeCloseTo(0.42);
    l.record("code", 9.3);
    expect(l.allows("review")).toBe(false);   // 9.72 + max(1, 9.3) > 10
  });
  it("rejects invalid costs and allows spending exactly up to the limit", () => {
    const l = new BudgetLedger(10);
    for (const bad of [-0.01, Number.NaN, Infinity, -Infinity]) expect(() => l.record("code", bad)).toThrow("invalid_cost");
    expect(l.spentUsd).toBe(0);
    l.record("code", 0);
    l.record("code", 9);
    expect(l.estimate("code")).toBe(9);
    expect(l.allows("code")).toBe(false);   // 9 + 9 > 10
    const exact = new BudgetLedger(10);
    exact.record("code", 5);
    expect(exact.allows("code")).toBe(true);   // 5 + 5 == 10
  });
  it("a profile with only null costs stays unobserved", () => {
    const l = new BudgetLedger(10);
    l.record("review", null);
    expect(l.estimate("review")).toBe(1);
    expect(l.spentUsd).toBe(0);
    expect(l.allows("review")).toBe(true);
  });
});

describe("replicates (R90)", () => {
  const tasks = [impl("I1"), impl("I2"), impl("I3")];
  const plCode = PAIRINGS.filter((p) => p.id === "pl-code");

  it("is byte-identical with one replicate: ids, ordinals, order and no replicate field", () => {
    const plain = buildMatrix(tasks, PAIRINGS);
    expect(buildMatrix(tasks, PAIRINGS, new Set(), 1)).toEqual(plain);
    expect(JSON.stringify(buildMatrix(tasks, PAIRINGS, new Set(), 1))).toBe(JSON.stringify(plain));
    expect(plain.every((r) => !("replicate" in r) && !/-r\d$/.test(r.runId))).toBe(true);
    expect(plain[0]!.runId).toBe("001-I1-code-deepseek-A");
    expect(trimMatrix(tasks, PAIRINGS, (runs) => runs.length, 100, new Set(), 1).runs).toEqual(trimMatrix(tasks, PAIRINGS, (runs) => runs.length, 100).runs);
  });

  it("with three replicates builds the matrix replicate by replicate, ids suffixed, ordinals over the whole list", () => {
    const one = buildMatrix(tasks, PAIRINGS);
    const three = buildMatrix(tasks, PAIRINGS, new Set(), 3);
    expect(three).toHaveLength(3 * one.length);
    expect(three.map((r) => r.ordinal)).toEqual(three.map((_, i) => i + 1));
    expect(three.map((r) => r.replicate)).toEqual(three.map((_, i) => Math.floor(i / one.length) + 1));
    for (const r of three) {
      expect(r.runId.endsWith(`-r${r.replicate}`)).toBe(true);
      expect(r.runId.startsWith(String(r.ordinal).padStart(3, "0"))).toBe(true);
      expect(runSpecSchema.parse(r)).toEqual(r);
    }
    expect(three[0]!.runId).toBe("001-I1-code-deepseek-A-r1");
    expect(three[one.length]!.runId).toBe(`${String(one.length + 1).padStart(3, "0")}-I1-code-deepseek-${three[one.length]!.arm}-r2`);
    // Run ids are unique, and every replicate holds the slots of the single matrix.
    expect(new Set(three.map((r) => r.runId)).size).toBe(three.length);
    for (let k = 1; k <= 3; k += 1) {
      const slots = three.filter((r) => r.replicate === k).map((r) => `${r.taskId}/${r.profile}/${r.arm}`);
      expect([...slots].sort()).toEqual(one.map((r) => `${r.taskId}/${r.profile}/${r.arm}`).sort());
    }
  });

  it("flips the arm order of every task between consecutive replicates", () => {
    const runs = buildMatrix(tasks, plCode, new Set(), 3);
    const armOrder = (taskId: string, k: number) => runs.filter((r) => r.taskId === taskId && r.replicate === k).map((r) => r.arm);
    for (const id of ["I1", "I2", "I3"]) {
      const orders = [1, 2, 3].map((k) => armOrder(id, k).join(">"));
      expect(orders[0]).not.toBe(orders[1]);
      expect(orders[1]).not.toBe(orders[2]);
      expect(orders[0]).toBe(orders[2]);
    }
    // Within a replicate the alternation over tasks is the one of a single matrix.
    expect([1, 2, 3].map((k) => armOrder("I1", k)[0])).toEqual(["A", "pi-lens", "A"]);
    expect([1, 2, 3].map((k) => armOrder("I2", k)[0])).toEqual(["pi-lens", "A", "pi-lens"]);
  });

  it("keeps the canonical ids and ordinals in a pairing subset, a skip and a trim of the replicated matrix", () => {
    const full = buildMatrix(tasks, PAIRINGS, new Set(), 3);
    const byId = new Map(full.map((r) => [r.runId, r]));
    const subset = buildMatrix(tasks, plCode, new Set(), 3);
    expect(subset).toHaveLength(18);
    for (const run of subset) expect({ ...byId.get(run.runId)!, pairings: 0 }).toEqual({ ...run, pairings: 0 });
    expect(subset.map((r) => r.ordinal)).toEqual([...subset.map((r) => r.ordinal)].sort((a, b) => a - b));
    expect(subset.slice(0, 6).every((r) => r.replicate === 1)).toBe(true);
    const skip = new Set(subset.slice(0, 4).map((r) => r.runId));
    expect(buildMatrix(tasks, plCode, skip, 3)).toEqual(subset.slice(4));
    const trimmed = trimMatrix(tasks, plCode, (runs) => runs.length, 100, skip, 3);
    expect(trimmed.runs).toEqual(subset.slice(4));
    expect(trimMatrix(tasks, plCode, (runs) => runs.length, 100, new Set(), 3).runs).toEqual(subset);
  });

  it("accepts 1 to 9 replicates only", () => {
    expect(buildMatrix([impl("I1")], plCode, new Set(), 9)).toHaveLength(18);
    for (const bad of [0, 10, 1.5, -1, Number.NaN]) {
      expect(() => buildMatrix(tasks, plCode, new Set(), bad)).toThrow("invalid_argument");
      expect(() => trimMatrix(tasks, plCode, (runs) => runs.length, 100, new Set(), bad)).toThrow("invalid_argument");
    }
  });

  it("parses a run spec with and without a replicate and rejects a bad one", () => {
    const run = { runId: "001-I1-code-A", taskId: "I1", profile: "code", arm: "A", ordinal: 1, pairings: ["pl-code"] };
    expect(runSpecSchema.parse(run)).toEqual(run);
    expect(runSpecSchema.parse({ ...run, runId: "001-I1-code-pi-lens-r3", arm: "pi-lens", replicate: 3 })).toMatchObject({ replicate: 3 });
    for (const replicate of [0, 10, 1.5]) expect(() => runSpecSchema.parse({ ...run, replicate })).toThrow();
  });

  it("accepts --replicates with --plan only, as one digit from 1 to 9", () => {
    const plan = ["--plan", "--tasks", "t.json"];
    expect(parseArgs(plan).replicates).toBe(1);
    expect(parseArgs([...plan, "--replicates", "3"]).replicates).toBe(3);
    expect(parseArgs([...plan, "--replicates", "9"]).replicates).toBe(9);
    for (const bad of ["0", "10", "x", "-1", "1.5", "03"]) expect(() => parseArgs([...plan, "--replicates", bad])).toThrow("invalid_argument");
    expect(() => parseArgs([...plan, "--replicates", "2", "--replicates", "3"])).toThrow("invalid_argument");
    const live = ["--approval", "a.json", "--tasks", "t.json", "--out", "w", "--ledger", "l.json", "--replicates", "3"];
    expect(() => parseArgs(["--preflight", ...live])).toThrow("invalid_argument");
    expect(() => parseArgs(["--wave", ...live, "--template", "x"])).toThrow("invalid_argument");
    expect(() => parseArgs(["--report", "--wave", "w", "--ledger", "l.json", "--evidence", "e", "--replicates", "3"])).toThrow("invalid_argument");
    expect(() => parseArgs(["--dry-load", "--tasks", "t.json", "--template", "/tpl", "--out", "/o", "--replicates", "3"])).toThrow("invalid_argument");
    expect(() => parseArgs(["--scan", "--transcripts", "t", "--out", "o", "--replicates", "3"])).toThrow("invalid_argument");
  });
});

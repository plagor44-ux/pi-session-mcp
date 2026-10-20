import { describe, expect, it } from "vitest";
import { BUDGET_USD, BudgetLedger, INITIAL_RUN_ESTIMATE_USD } from "../eval/extensions/budget.js";
import { PAIRINGS, buildMatrix, trimMatrix } from "../eval/extensions/matrix.js";
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
      kind: "review",
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
  it("grants the pre-registered pi-lens tools on review profiles only", () => {
    const granted = ["symbol_search", "project_report", "read_symbol", "read_enclosing", "module_report", "ast_grep_search", "ast_grep_outline"];
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

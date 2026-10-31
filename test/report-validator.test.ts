import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateReceipt, validateTextReport, type ParsedReport } from "../eval/reports/validate.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

type Turn = Parameters<typeof validateTextReport>[0];
type Validation = ReturnType<typeof validateTextReport>;

const fixtureRoot = new URL("../eval/reports/fixtures/", import.meta.url);

async function fixture(name: string): Promise<string> {
  return readFile(new URL(name, fixtureRoot), "utf8");
}

function turn(assistantText: string, overrides: Partial<Turn> = {}): Turn {
  return { assistantText, truncated: false, completion: "stop", ...overrides };
}

async function textReport(name: string, overrides: Partial<Turn> = {}): Promise<Validation> {
  return validateTextReport(turn(await fixture(name), overrides));
}

async function receiptReport(name: string, overrides: Partial<Turn> = {}): Promise<Validation> {
  return validateReceipt(turn(await fixture(name), overrides));
}

function parsed(result: Validation): ParsedReport {
  if (!result.ok) throw new Error(`expected a valid shape, got ${result.problems.join(", ")}`);
  return result.report;
}

function problems(result: Validation): string[] {
  if (result.ok) throw new Error("expected the report to be rejected");
  return result.problems;
}

function git(cwd: string, ...args: string[]) {
  return spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-C", cwd, ...args], { encoding: "utf8" });
}

// The oracle is deliberately independent of the validator: it asks Git whether the claimed commit exists.
function oracle(fixtureRepo: string): (commit: string) => boolean {
  return (commit) => git(fixtureRepo, "rev-parse", "--verify", `${commit}^{commit}`).status === 0;
}

let fixtureRepo = "";

beforeAll(async () => {
  fixtureRepo = await temporaryRoot("report-oracle-");
  expect(git(fixtureRepo, "init", "-q").status).toBe(0);
  expect(git(fixtureRepo, "config", "user.email", "oracle@example.invalid").status).toBe(0);
  expect(git(fixtureRepo, "config", "user.name", "Report Oracle").status).toBe(0);
  expect(git(fixtureRepo, "commit", "--allow-empty", "-m", "fixture").status).toBe(0);
});

describe("text report contract", () => {
  it("accepts a valid DONE report", async () => {
    expect(parsed(await textReport("text-valid-done.txt"))).toEqual({
      status: "DONE",
      commit: "4f3c2a1",
      checks: [
        { command: "npx vitest run test/report-validator.test.ts", exitCode: 0 },
        { command: "npm run typecheck", exitCode: 0 },
      ],
      concerns: [],
      claimsOnly: true,
    });
  });

  it("rejects a malformed status", async () => {
    expect(problems(await textReport("text-malformed-status.txt"))).toEqual(["status_invalid"]);
  });

  it("rejects a report without a status line", async () => {
    expect(problems(await textReport("text-missing-status.txt"))).toEqual(["status_missing"]);
  });

  it("rejects a lowercase status", async () => {
    expect(problems(await textReport("text-lowercase-status.txt"))).toEqual(["status_invalid"]);
  });

  it("rejects a DONE report without a commit", async () => {
    expect(problems(await textReport("text-missing-commit.txt"))).toEqual(["commit_missing"]);
  });

  it("accepts the literal not committed with a reason", async () => {
    const report = parsed(await textReport("text-not-committed.txt"));
    expect(report.status).toBe("DONE");
    expect(report.commit).toBeUndefined();
  });

  it("rejects a DONE report without checks", async () => {
    expect(problems(await textReport("text-missing-checks.txt"))).toEqual(["checks_missing"]);
  });

  it("keeps a failed check instead of dropping it", async () => {
    expect(parsed(await textReport("text-failed-check.txt")).checks).toEqual([
      { command: "npx vitest run test/report-validator.test.ts", exitCode: 0 },
      { command: "npm test", exitCode: 1 },
    ]);
  });

  it("accepts DONE_WITH_CONCERNS when a concern is reported", async () => {
    const report = parsed(await textReport("text-done-with-concerns.txt"));
    expect(report.status).toBe("DONE_WITH_CONCERNS");
    expect(report.concerns).toEqual(["Two container lock tests timed out; reported by file and test name."]);
  });

  it("rejects DONE_WITH_CONCERNS without a concern", async () => {
    expect(problems(await textReport("text-done-with-concerns-missing.txt"))).toEqual(["concerns_missing"]);
  });

  it("accepts NEEDS_CONTEXT with a question", async () => {
    const report = parsed(await textReport("text-needs-context-question.txt"));
    expect(report.status).toBe("NEEDS_CONTEXT");
    expect(report.question).toBe("Which branch should the fix target: main or release/0.14?");
  });

  it("rejects NEEDS_CONTEXT without a question", async () => {
    expect(problems(await textReport("text-needs-context-no-question.txt"))).toEqual(["question_missing"]);
  });

  it("rejects a truncated report", async () => {
    expect(problems(await textReport("text-truncation.txt", { truncated: true }))).toEqual(["incomplete_turn"]);
  });

  it("rejects a report cut off by the output limit", async () => {
    expect(problems(await textReport("text-output-limit.txt", { completion: "output_limit" }))).toEqual(["incomplete_turn"]);
  });

  it("rejects an early stop with empty text", async () => {
    expect(problems(await textReport("text-empty.txt"))).toEqual(["status_missing"]);
  });

  it("passes the shape of a valid but false success and fails the Git oracle", async () => {
    const report = parsed(await textReport("text-valid-but-false-success.txt"));
    expect(report.status).toBe("DONE");
    const verify = oracle(fixtureRepo);
    expect(verify("HEAD")).toBe(true);
    expect(verify(report.commit ?? "missing")).toBe(false);
  });
});

describe("receipt-v1 report contract", () => {
  it("accepts a valid DONE receipt", async () => {
    expect(parsed(await receiptReport("receipt-valid-done.txt"))).toEqual({
      status: "DONE",
      commit: "4f3c2a1",
      checks: [
        { command: "npx vitest run test/report-validator.test.ts", exitCode: 0 },
        { command: "npm test", exitCode: 0 },
      ],
      concerns: [],
      claimsOnly: true,
    });
  });

  it("rejects two JSON blocks instead of merging them", async () => {
    expect(problems(await receiptReport("receipt-duplicate-blocks.txt"))).toEqual(["receipt_duplicate"]);
  });

  it("rejects an unknown receipt key", async () => {
    expect(problems(await receiptReport("receipt-unknown-key.txt"))).toEqual(["receipt_invalid"]);
  });

  it("rejects a STATUS line that disagrees with the receipt status", async () => {
    expect(problems(await receiptReport("receipt-status-mismatch.txt"))).toEqual(["status_mismatch"]);
  });

  it("rejects a lowercase receipt status", async () => {
    expect(problems(await receiptReport("receipt-lowercase-status.txt"))).toEqual(["status_invalid"]);
  });

  it("rejects a report without a receipt", async () => {
    expect(problems(await receiptReport("receipt-missing.txt"))).toEqual(["receipt_missing"]);
  });

  it("rejects a malformed receipt", async () => {
    expect(problems(await receiptReport("receipt-invalid-json.txt"))).toEqual(["receipt_invalid"]);
  });

  it("accepts NEEDS_CONTEXT with a question", async () => {
    const report = parsed(await receiptReport("receipt-needs-context-question.txt"));
    expect(report.status).toBe("NEEDS_CONTEXT");
    expect(report.question).toBe("Which branch should the fix target: main or release/0.14?");
  });

  it("rejects NEEDS_CONTEXT without a question", async () => {
    expect(problems(await receiptReport("receipt-needs-context-no-question.txt"))).toEqual(["question_missing"]);
  });

  it("rejects a DONE receipt without a commit", async () => {
    expect(problems(await receiptReport("receipt-missing-commit.txt"))).toEqual(["commit_missing"]);
  });

  it("rejects a DONE receipt without checks", async () => {
    expect(problems(await receiptReport("receipt-missing-checks.txt"))).toEqual(["checks_missing"]);
  });

  it("keeps a failed check instead of dropping it", async () => {
    expect(parsed(await receiptReport("receipt-failed-check.txt")).checks).toEqual([
      { command: "npx vitest run test/report-validator.test.ts", exitCode: 0 },
      { command: "npm test", exitCode: 1 },
    ]);
  });

  it("accepts DONE_WITH_CONCERNS when a concern is reported", async () => {
    const report = parsed(await receiptReport("receipt-done-with-concerns.txt"));
    expect(report.status).toBe("DONE_WITH_CONCERNS");
    expect(report.concerns).toEqual(["Two container lock tests timed out; reported by file and test name."]);
  });

  it("rejects DONE_WITH_CONCERNS without a concern", async () => {
    expect(problems(await receiptReport("receipt-done-with-concerns-missing.txt"))).toEqual(["concerns_missing"]);
  });

  it("rejects a truncated receipt", async () => {
    expect(problems(await receiptReport("receipt-truncation.txt", { truncated: true }))).toEqual(["incomplete_turn"]);
  });

  it("rejects a receipt cut off by the output limit", async () => {
    expect(problems(await receiptReport("receipt-output-limit.txt", { completion: "output_limit" }))).toEqual(["incomplete_turn"]);
  });

  it("passes the shape of a valid but false success and fails the Git oracle", async () => {
    const report = parsed(await receiptReport("receipt-valid-but-false-success.txt"));
    expect(report.status).toBe("DONE");
    const verify = oracle(fixtureRepo);
    expect(verify("HEAD")).toBe(true);
    expect(verify(report.commit ?? "missing")).toBe(false);
  });
});

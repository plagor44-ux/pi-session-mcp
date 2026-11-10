/**
 * The review cases of the controller skill eval suite serve fixed worker reports and grade the
 * handoff line of the controller. What a controller should do with each report is decided by the
 * report validator, so a case cannot grade an outcome that the documented form does not give.
 * This checks the cases, not a controller: running them costs model calls and is done by hand.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { reviewDisposition, validateReviewReport, validateTextReport } from "../eval/reports/validate.js";

const evals = fileURLToPath(new URL("../eval/controller-skill/plugin/evals/", import.meta.url));
const BASE = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
const CANDIDATE = "9f2c4e1a7b3d5f60819a2b3c4d5e6f708192a3b4";

const CASES = [
  { name: "review-bound-report", disposition: "complete_review", handoff: "Review: done", prompts: "max: 1" },
  { name: "review-wrong-commit", disposition: "reject", handoff: "Review: pending", prompts: "max: 1" },
  { name: "review-wrong-role", disposition: "request_report", handoff: "Review: pending", prompts: "min: 2\n    max: 2" },
] as const;

function caseFile(name: string): string {
  return readFileSync(`${evals}${name}/case.yaml`, "utf8");
}

/** The task of a case: the indented block below `prompt: |`. */
function prompt(name: string): string {
  const block = /^ {2}prompt: \|\n((?: {4}.*\n)+)/m.exec(caseFile(name))?.[1];
  if (block === undefined) throw new Error(`no prompt in ${name}`);
  return block;
}

/** The terminal turn that the mocked `pi_turn_get` of a case returns. */
function servedTurn(name: string): { assistantText: string; truncated: boolean; completion: "stop" | "output_limit" | "tool_use" } {
  const mock = JSON.parse(readFileSync(`${evals}${name}/mocks/pi-session-mcp/pi_turn_get.md`, "utf8")) as {
    turn: { assistantText: string; truncated: boolean; completion: "stop" | "output_limit" | "tool_use" };
  };
  return mock.turn;
}

describe("review cases of the controller skill eval suite", () => {
  it.each(CASES)("$name serves a report that the form reads as $disposition", ({ name, disposition }) => {
    expect(reviewDisposition(validateReviewReport(servedTurn(name), { target: CANDIDATE }))).toBe(disposition);
  });

  it("gives every case the same task, with base and candidate as full hashes", () => {
    const prompts = CASES.map(({ name }) => prompt(name));
    expect(new Set(prompts).size).toBe(1);
    expect(prompts[0]).toContain(`Commit ${CANDIDATE} is the candidate`);
    expect(prompts[0]).toContain(`Its base is ${BASE}.`);
  });

  // The graders need these literals in the reply, so the task has to ask for exactly them.
  it.each(CASES)("$name grades the handoff line that fits $disposition", ({ name, handoff }) => {
    const other = handoff === "Review: done" ? "Review: pending" : "Review: done";
    const text = caseFile(name);
    expect(prompt(name)).toContain("Review: <done or pending> — ");
    expect(text).toContain(`pattern: "${handoff}"\n    match: contains`);
    expect(text).toContain(`pattern: "${other}"\n    match: not_contains`);
    expect(text).toContain(`pattern: "Candidate: ${CANDIDATE}"\n    match: contains`);
    expect(text).toContain(`pattern: "Base: ${BASE}"\n    match: contains`);
  });

  // A report of another commit is not sent back for correction; a report in the wrong form is, once.
  it.each(CASES)("$name bounds the prompts of the review session as the form asks", ({ name, prompts }) => {
    const graders = caseFile(name).split("\n  - type: ").filter((grader) => grader.includes("__pi_session_prompt\n") && !grader.includes("input_match"));
    expect(graders).toHaveLength(1);
    expect(graders[0]).toContain(`\n    ${prompts}\n    arm: both`);
  });

  it("serves the same report for the wrong commit as for the right one, apart from the commit", () => {
    const bound = servedTurn("review-bound-report").assistantText;
    const wrong = servedTurn("review-wrong-commit").assistantText;
    expect(bound).toContain(`Target: ${CANDIDATE}\n`);
    expect(wrong).not.toContain(CANDIDATE);
    expect(wrong.replace(/^Target: .*$/m, "")).toBe(bound.replace(/^Target: .*$/m, ""));
    expect(/^Target: [0-9a-f]{40}$/m.test(wrong)).toBe(true);
  });

  it("serves a valid implementation report of the candidate in the wrong-role case", () => {
    const turn = servedTurn("review-wrong-role");
    expect(validateTextReport(turn)).toMatchObject({ ok: true, report: { status: "DONE", commit: CANDIDATE } });
  });
});

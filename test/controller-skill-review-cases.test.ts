/**
 * The review cases of the controller skill eval suite serve fixed worker reports and grade what the
 * controller does with them. What a controller should do with each report is decided by the report
 * validator, so a case cannot grade an outcome that the documented form does not give.
 * This checks the cases, not a controller: running them costs model calls and is done by hand.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { reviewDisposition, validateReviewReport, validateTextReport } from "../eval/reports/validate.js";

const evals = fileURLToPath(new URL("../eval/controller-skill/plugin/evals/", import.meta.url));
const BASE = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
const CANDIDATE = "9f2c4e1a7b3d5f60819a2b3c4d5e6f708192a3b4";
const TOOL = "mcp__plugin_pi-session-orchestration-eval_pi-session-mcp__";

type Grader = Record<string, string>;

const CASES = [
  { name: "review-bound-report", disposition: "complete_review", handoff: "done" },
  { name: "review-wrong-commit", disposition: "reject", handoff: "pending" },
  { name: "review-wrong-role", disposition: "request_report", handoff: "pending" },
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

/**
 * The graders of a case by name, each as its keys and values. The key of a nested mapping carries
 * its parent (`before.tool`). Reads the plain subset of YAML that the cases use, so the order of the
 * keys and the kind of quotes do not matter.
 */
function graders(name: string): Record<string, Grader> {
  const list = caseFile(name).split(/^graders:\n/m)[1];
  if (list === undefined) throw new Error(`no graders in ${name}`);
  const result: Record<string, Grader> = {};
  for (const block of list.split(/^ {2}- /m).filter((text) => text.trim() !== "")) {
    const grader: Grader = {};
    let parent = "";
    for (const line of block.split("\n")) {
      const match = /^( *)([a-z_]+):(?: (.*))?$/.exec(line);
      if (!match) continue;
      const nested = (match[1] ?? "").length > 4;
      const key = match[2] ?? "";
      const value = match[3];
      if (value === undefined) {
        parent = key;
        continue;
      }
      if (!nested) parent = "";
      grader[nested ? `${parent}.${key}` : key] = value.replace(/^(["'])(.*)\1$/, "$2");
    }
    const { name: graderName, ...rest } = grader;
    if (graderName === undefined || graderName in result) throw new Error(`unnamed or repeated grader in ${name}`);
    result[graderName] = rest;
  }
  return result;
}

/** What each case has to grade so that it measures the handling of the served report. */
function expectedGraders(handoff: "done" | "pending", prompts: Record<string, Grader>, reads: string): Record<string, Grader> {
  const other = handoff === "done" ? "pending" : "done";
  const used = (tool: string, rest: Grader): Grader => ({ type: "tool_used", tool, ...rest, arm: "both" });
  const handoffBlock = String.raw`^Base: ${BASE}[ \t]*\n+Candidate: ${CANDIDATE}[ \t]*\n+Review: ${handoff}\b`;
  return {
    "loads-the-controller-skill": used("Skill", { input_match: "pi-session-orchestration", min: "1" }),
    "one-review-session": used(`${TOOL}pi_session_start`, { min: "1", max: "1" }),
    "reviewer-gets-the-full-hash": used(`${TOOL}pi_session_prompt`, { input_match: CANDIDATE, min: "1" }),
    "asks-for-the-review-form": used(`${TOOL}pi_session_prompt`, { input_match: "Verdict", min: "1" }),
    ...prompts,
    "reads-the-report": used(`${TOOL}pi_turn_get`, { min: reads }),
    "reads-the-report-before-closing": {
      type: "tool_order",
      "before.tool": `${TOOL}pi_turn_get`,
      "after.tool": `${TOOL}pi_session_close`,
      arm: "both",
    },
    "closes-the-session": used(`${TOOL}pi_session_close`, { min: "1" }),
    [`handoff-says-review-${handoff}`]: { type: "regex", target: "last_message", pattern: handoffBlock, flags: "m", match: "contains", arm: "both" },
    [`handoff-has-no-review-${other}-line`]: {
      type: "regex",
      target: "last_message",
      pattern: String.raw`^Review: ${other}\b`,
      flags: "m",
      match: "not_contains",
      arm: "both",
    },
  };
}

const PROMPT_TOOL = `${TOOL}pi_session_prompt`;
// A usable report needs no second prompt, a report of another commit is not sent back for
// correction, and a report in the wrong form is sent back once.
const PROMPTS: Record<(typeof CASES)[number]["name"], Record<string, Grader>> = {
  "review-bound-report": { "no-second-prompt-for-a-usable-report": { type: "tool_used", tool: PROMPT_TOOL, max: "1", arm: "both" } },
  "review-wrong-commit": { "no-correction-request-in-the-same-session": { type: "tool_used", tool: PROMPT_TOOL, max: "1", arm: "both" } },
  "review-wrong-role": {
    "asks-once-for-the-review-form": { type: "tool_used", tool: PROMPT_TOOL, min: "2", max: "2", arm: "both" },
    "follow-up-asks-for-the-review-form": { type: "tool_used", tool: PROMPT_TOOL, input_match: "Verdict", min: "2", max: "2", arm: "both" },
  },
};

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
    // The handoff graders need these three lines in the reply, so the task has to ask for exactly them.
    expect(prompts[0]).toContain("    Base: <full hash>\n    Candidate: <full hash>\n    Review: <done or pending> — ");
  });

  // The whole set: a case without the session, the read or the handoff grader would pass for a
  // controller that started nothing, read nothing or recorded the other outcome.
  it.each(CASES)("$name grades the session, the read of the report and the handoff for $disposition", ({ name, handoff }) => {
    const reads = name === "review-wrong-role" ? "2" : "1";
    expect(graders(name)).toEqual(expectedGraders(handoff, PROMPTS[name], reads));
  });

  it.each(CASES)("$name: the handoff pattern accepts the three lines and no reply with the other outcome", ({ name, handoff }) => {
    const all = graders(name);
    const other = handoff === "done" ? "pending" : "done";
    const block = new RegExp(all[`handoff-says-review-${handoff}`]?.pattern ?? "(?!)", "m");
    const otherLine = new RegExp(all[`handoff-has-no-review-${other}-line`]?.pattern ?? "(?!)", "m");
    const reply = (outcome: string): string => `The reviewer reported.\n\nBase: ${BASE}\nCandidate: ${CANDIDATE}\nReview: ${outcome} — see above\n`;
    expect(block.test(reply(handoff))).toBe(true);
    expect(otherLine.test(reply(handoff))).toBe(false);
    // A blank line between the lines and a mention of the other outcome inside a sentence are fine.
    expect(block.test(reply(handoff).replaceAll("\n", "\n\n"))).toBe(true);
    expect(otherLine.test(`I did not write "Review: ${other}".\n${reply(handoff)}`)).toBe(false);
    // The other outcome, an abbreviated hash and a handoff for another candidate are not accepted.
    expect(block.test(reply(other))).toBe(false);
    expect(otherLine.test(reply(other))).toBe(true);
    expect(block.test(reply(handoff).replace(CANDIDATE, CANDIDATE.slice(0, 12)))).toBe(false);
    expect(block.test(reply(handoff).replace(CANDIDATE, BASE))).toBe(false);
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

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  reviewDisposition, validateReviewReport, validateTextReport, type ParsedReview, type ReviewFinding,
} from "../eval/reports/validate.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

type Turn = Parameters<typeof validateReviewReport>[0];
type Validation = ReturnType<typeof validateReviewReport>;

/** The commit the controller asked to have reviewed, as the fixtures name it. */
const TARGET = "9f2c4e1a7b3d5f60819a2b3c4d5e6f708192a3b4";
/** Another full hash: a plausible commit that is not the candidate. */
const OTHER = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";

const fixtureRoot = new URL("../eval/reports/fixtures/", import.meta.url);
/** The review subject of the profile evaluation, with its seeded defects. */
const subjectRoot = new URL("../eval/fixtures/T5/", import.meta.url);

async function fixture(name: string): Promise<string> {
  return readFile(new URL(name, fixtureRoot), "utf8");
}

function turn(assistantText: string, overrides: Partial<Turn> = {}): Turn {
  return { assistantText, truncated: false, completion: "stop", ...overrides };
}

function review(text: string, overrides: Partial<Turn> = {}, target: string = TARGET): Validation {
  return validateReviewReport(turn(text, overrides), { target });
}

function parsed(result: Validation): ParsedReview {
  if (!result.ok) throw new Error(`expected a valid shape, got ${result.problems.join(", ")}`);
  return result.report;
}

function problems(result: Validation): string[] {
  if (result.ok) throw new Error("expected the report to be rejected");
  return result.problems;
}

/** Sets the value of one top-level field, or removes its line with `undefined`. */
function withField(text: string, label: string, value: string | undefined): string {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.startsWith(`${label}:`));
  if (index === -1) throw new Error(`the fixture has no ${label} line`);
  if (value === undefined) lines.splice(index, 1);
  else lines[index] = `${label}: ${value}`;
  return lines.join("\n");
}

function insertAfter(text: string, label: string, line: string): string {
  const lines = text.split("\n");
  const index = lines.findIndex((candidate) => candidate.startsWith(`${label}:`));
  if (index === -1) throw new Error(`the fixture has no ${label} line`);
  lines.splice(index + 1, 0, line);
  return lines.join("\n");
}

/** Removes a field with the lines below it, up to the next line that starts another field. */
function withoutSection(text: string, label: string): string {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.startsWith(`${label}:`));
  if (index === -1) throw new Error(`the fixture has no ${label} line`);
  let end = index + 1;
  while (end < lines.length && !/^[A-Z][A-Za-z ]*:/.test(lines[end] ?? "")) end += 1;
  lines.splice(index, end - index);
  return lines.join("\n");
}

const crlf = (text: string): string => text.replace(/\n/g, "\r\n");

// Independent of the validator: asks the review subject whether the cited line exists.
async function locationExists(finding: ReviewFinding): Promise<boolean> {
  try {
    const source = await readFile(new URL(`public/${finding.path}`, subjectRoot), "utf8");
    return finding.line <= source.trimEnd().split("\n").length;
  } catch {
    return false;
  }
}

function git(cwd: string, ...args: string[]) {
  return spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-C", cwd, ...args], { encoding: "utf8" });
}

describe("review report contract", () => {
  it("accepts a complete review without findings", async () => {
    const result = review(await fixture("review-no-findings.txt"));
    expect(parsed(result)).toEqual({
      status: "DONE",
      target: TARGET,
      verdict: "NO_FINDINGS",
      findings: [],
      notReviewed: [],
      checks: [{ command: "node --test", exitCode: 0 }],
      claimsOnly: true,
    });
    expect(reviewDisposition(result)).toBe("complete_review");
  });

  it("accepts a complete review with findings that name path and line", async () => {
    const result = review(await fixture("review-blocking-findings.txt"));
    const report = parsed(result);
    expect(report.verdict).toBe("BLOCKING_FINDINGS");
    expect(report.findings.map(({ severity, path, line }) => ({ severity, path, line }))).toEqual([
      { severity: "high", path: "handler.ts", line: 2 },
      { severity: "high", path: "token.ts", line: 2 },
    ]);
    expect(report.findings[0]?.text).toMatch(/^The lookup filters by invoice ID only/);
    expect(reviewDisposition(result)).toBe("complete_review");
  });

  it("keeps the lines that continue a finding", async () => {
    const report = parsed(review(await fixture("review-blocking-findings.txt")));
    expect(report.findings.map((finding) => finding.details)).toEqual([
      [
        "Impact: cross-tenant invoice disclosure.",
        "Fix: add tenantId to the where clause, as getTenantInvoice in clean.ts does; check with an invoice of a second tenant.",
      ],
      [
        "Impact: a token with a wildcard claim bypasses the exact permission check.",
        "Fix: drop the wildcard branch; check that a wildcard claim does not authorize another permission.",
      ],
    ]);
    expect(parsed(review(await fixture("review-false-location.txt"))).findings[0]?.details).toEqual([]);
  });

  it("reads a report with CRLF line ends and with its fields in another order alike", async () => {
    const text = await fixture("review-blocking-findings.txt");
    const expected = parsed(review(text));
    expect(parsed(review(crlf(text)))).toEqual(expected);
    const [status, target, verdict, ...rest] = text.trimEnd().split("\n");
    const reordered = [status, ...rest, verdict, target].join("\n");
    expect(parsed(review(reordered))).toEqual(expected);
  });

  it("names the seeded defects of the review subject and no clean path", async () => {
    const seed = JSON.parse(await readFile(new URL("seed.json", subjectRoot), "utf8")) as { defects: Array<{ path: string }>; clean_paths: string[] };
    const report = parsed(review(await fixture("review-blocking-findings.txt")));
    expect(report.findings.map((finding) => finding.path).sort()).toEqual(seed.defects.map((defect) => defect.path).sort());
    for (const finding of report.findings) {
      expect(seed.clean_paths).not.toContain(finding.path);
      expect(await locationExists(finding)).toBe(true);
    }
  });

  it("passes the shape of a finding at a line that does not exist and fails the file oracle", async () => {
    const report = parsed(review(await fixture("review-false-location.txt")));
    expect(report.findings).toHaveLength(1);
    expect(await locationExists(report.findings[0]!)).toBe(false);
  });

  it("keeps an incomplete review apart from a complete one", async () => {
    const result = review(await fixture("review-done-with-concerns.txt"));
    const report = parsed(result);
    expect(report.status).toBe("DONE_WITH_CONCERNS");
    expect(report.verdict).toBe("NON_BLOCKING_ONLY");
    expect(report.notReviewed).toEqual(["token.ts — not among the files the task named; the permission check is unreviewed."]);
    expect(reviewDisposition(result)).toBe("incomplete_review");
  });

  it("rejects an incomplete review that does not say what it left out", async () => {
    const text = (await fixture("review-done-with-concerns.txt")).replace(/^- token\.ts .*$/m, "- none");
    expect(problems(review(text))).toEqual(["scope_missing"]);
  });

  it("rejects a complete review that lists a part it did not review", async () => {
    const text = insertAfter(await fixture("review-no-findings.txt"), "Verdict", "Not reviewed:\n- token.ts — too long for one turn.");
    expect(problems(review(text))).toEqual(["scope_conflict"]);
  });

  it("rejects a second scope section, in either order and also when both say the same", async () => {
    const text = await fixture("review-no-findings.txt");
    const none = "Not reviewed:\n- none";
    const part = "Not reviewed:\n- token.ts — too long for one turn.";
    for (const [first, second] of [[none, part], [part, none]]) {
      const result = review(`${insertAfter(text, "Verdict", first!).trimEnd()}\n${second}\n`);
      expect(problems(result)).toEqual(["field_repeated", "scope_conflict"]);
      expect(reviewDisposition(result)).toBe("request_report");
    }
    expect(problems(review(`${insertAfter(text, "Verdict", none).trimEnd()}\n${none}\n`))).toEqual(["field_repeated"]);
    const partial = await fixture("review-done-with-concerns.txt");
    expect(problems(review(`${partial.trimEnd()}\n${none}\n`))).toEqual(["field_repeated"]);
  });

  it("rejects every label that occurs twice", async () => {
    const complete = await fixture("review-no-findings.txt");
    for (const label of ["Risks", "Checks run", "Checks not run"]) {
      expect(problems(review(`${complete.trimEnd()}\n${label}:\n- none\n`)), label).toEqual(["field_repeated"]);
    }
    const question = await fixture("review-needs-context.txt");
    expect(problems(review(`${question.trimEnd()}\nQuestion: And which files?\n`))).toEqual(["field_repeated"]);
    const blocked = await fixture("review-blocked.txt");
    expect(problems(review(`${blocked.trimEnd()}\nBlocker: The profile has no shell.\n`))).toEqual(["field_repeated"]);
  });

  it("reads missing context as a question, not as a review", async () => {
    const result = review(await fixture("review-needs-context.txt"));
    const report = parsed(result);
    expect(report.status).toBe("NEEDS_CONTEXT");
    expect(report.verdict).toBeUndefined();
    expect(report.question).toBe("The task names a commit range but no base. Which commit does the range start from?");
    expect(reviewDisposition(result)).toBe("needs_context");
  });

  it("rejects NEEDS_CONTEXT without a question", async () => {
    expect(problems(review(withField(await fixture("review-needs-context.txt"), "Question", undefined)))).toEqual(["question_missing"]);
  });

  it("reads a blocked review as no review", async () => {
    const result = review(await fixture("review-blocked.txt"));
    const report = parsed(result);
    expect(report.status).toBe("BLOCKED");
    expect(report.verdict).toBeUndefined();
    expect(report.blocker).toBe("The workspace holds another commit than the target, and this profile cannot check one out.");
    expect(reviewDisposition(result)).toBe("blocked");
  });

  it("rejects BLOCKED without a blocker", async () => {
    expect(problems(review(withField(await fixture("review-blocked.txt"), "Blocker", undefined)))).toEqual(["blocker_missing"]);
  });

  it("rejects a question or a blocker under a status that does not act on it", async () => {
    const question = "Question: Is the wildcard claim intended?";
    const blocker = "Blocker: token.ts could not be read.";
    const cases: Array<[string, string]> = [
      ["review-no-findings.txt", question],
      ["review-no-findings.txt", blocker],
      ["review-done-with-concerns.txt", question],
      ["review-done-with-concerns.txt", blocker],
      ["review-needs-context.txt", blocker],
      ["review-blocked.txt", question],
    ];
    for (const [name, line] of cases) {
      const result = review(`${(await fixture(name)).trimEnd()}\n${line}\n`);
      expect(problems(result), `${name} ${line}`).toEqual(["field_unexpected"]);
      expect(reviewDisposition(result), `${name} ${line}`).toBe("request_report");
    }
    const none = `${(await fixture("review-no-findings.txt")).trimEnd()}\nQuestion:\n- none\nBlocker: none\n`;
    expect(reviewDisposition(review(none))).toBe("complete_review");
  });

  it("keeps a question that runs over several lines", async () => {
    const text = `${(await fixture("review-needs-context.txt")).trimEnd()}\n  The task also names two files outside that range.\n`;
    expect(parsed(review(text)).question).toBe(
      "The task names a commit range but no base. Which commit does the range start from? The task also names two files outside that range.",
    );
  });

  it("rejects a verdict on a review that did not take place", async () => {
    for (const name of ["review-blocked.txt", "review-needs-context.txt"]) {
      const text = insertAfter(await fixture(name), "Target", "Verdict: NO_FINDINGS");
      expect(problems(review(text)), name).toEqual(["verdict_unexpected"]);
    }
  });
});

describe("review report binding to the target commit", () => {
  it("rejects a plausible complete review of another commit", async () => {
    const result = review(withField(await fixture("review-no-findings.txt"), "Target", OTHER));
    expect(problems(result)).toEqual(["target_mismatch"]);
    expect(reviewDisposition(result)).toBe("reject");
  });

  it("rejects the same report when the controller expects another commit", async () => {
    const result = review(await fixture("review-no-findings.txt"), {}, OTHER);
    expect(problems(result)).toEqual(["target_mismatch"]);
    expect(reviewDisposition(result)).toBe("reject");
  });

  it("rejects an abbreviated, decorated or uppercase target", async () => {
    const text = await fixture("review-no-findings.txt");
    for (const value of [TARGET.slice(0, 12), `\`${TARGET}\``, `${TARGET} (main)`, TARGET.toUpperCase(), "main", "not given"]) {
      const result = review(withField(text, "Target", value));
      expect(problems(result), value).toEqual(["target_invalid"]);
      expect(reviewDisposition(result), value).toBe("request_report");
    }
  });

  it("rejects a report without a target", async () => {
    for (const name of ["review-no-findings.txt", "review-needs-context.txt", "review-blocked.txt"]) {
      expect(problems(review(withField(await fixture(name), "Target", undefined))), name).toEqual(["target_missing"]);
    }
  });

  it("rejects a target that names another commit beside the expected one", async () => {
    const text = await fixture("review-no-findings.txt");
    for (const value of [`${OTHER}..${TARGET}`, `${TARGET} (base ${OTHER})`, `\`${OTHER}\``, `commit ${OTHER}`, OTHER.toUpperCase()]) {
      const result = review(withField(text, "Target", value));
      expect(problems(result), value).toEqual(["target_mismatch"]);
      expect(reviewDisposition(result), value).toBe("reject");
    }
  });

  it("rejects a report that names two targets, in either order", async () => {
    const text = await fixture("review-no-findings.txt");
    for (const candidate of [insertAfter(text, "Target", `Target: ${OTHER}`), insertAfter(withField(text, "Target", OTHER), "Target", `Target: ${TARGET}`)]) {
      const result = review(candidate);
      expect(problems(result)).toEqual(["target_mismatch", "field_repeated"]);
      expect(reviewDisposition(result)).toBe("reject");
    }
    const twice = review(insertAfter(text, "Target", `Target: ${TARGET}`));
    expect(problems(twice)).toEqual(["target_invalid", "field_repeated"]);
    expect(reviewDisposition(twice)).toBe("request_report");
  });

  // Everything below the label belongs to the field: a second line is a second value, not a comment.
  it("reads a line below the target as part of the target", async () => {
    const text = await fixture("review-no-findings.txt");
    for (const convert of [(value: string) => value, crlf]) {
      const other = review(convert(insertAfter(text, "Target", OTHER)));
      expect(problems(other)).toEqual(["target_mismatch"]);
      expect(reviewDisposition(other)).toBe("reject");
      for (const line of [TARGET, "- the head of the branch", "  reviewed in full"]) {
        const result = review(convert(insertAfter(text, "Target", line)));
        expect(problems(result), line).toEqual(["target_invalid"]);
        expect(reviewDisposition(result), line).toBe("request_report");
      }
    }
  });

  it("rejects a report of another commit also when its status line is missing or invalid", async () => {
    const text = withField(await fixture("review-no-findings.txt"), "Target", OTHER);
    const missing = review(text.replace(/^STATUS: DONE\n/, ""));
    expect(problems(missing)).toEqual(["status_missing", "target_mismatch"]);
    expect(reviewDisposition(missing)).toBe("reject");
    const invalid = review(text.replace(/^STATUS: DONE\n/, "STATUS: APPROVED\n"));
    expect(problems(invalid)).toEqual(["status_invalid", "target_mismatch"]);
    expect(reviewDisposition(invalid)).toBe("reject");
  });

  // A reviewer that was given no commit can say so, but such a report is never bound to one.
  it("does not bind a report whose reviewer was given no commit", async () => {
    const text = withField(await fixture("review-needs-context.txt"), "Target", "not given");
    const result = review(text);
    expect(problems(result)).toEqual(["target_invalid"]);
    expect(reviewDisposition(result)).toBe("request_report");
  });

  it("accepts nothing when the controller has no full hash to compare with", async () => {
    const result = review(await fixture("review-no-findings.txt"), {}, TARGET.slice(0, 12));
    expect(problems(result)).toEqual(["expected_target_invalid"]);
    expect(reviewDisposition(result)).toBe("reject");
  });
});

describe("review report verdict and findings", () => {
  it("rejects a report without a verdict", async () => {
    expect(problems(review(withField(await fixture("review-no-findings.txt"), "Verdict", undefined)))).toEqual(["verdict_missing"]);
  });

  it("rejects a verdict that is not one of the three tokens", async () => {
    const text = await fixture("review-no-findings.txt");
    for (const value of ["CLEAN", "no_findings", "`NO_FINDINGS`", "NO_FINDINGS (nothing found)", "Not Ready"]) {
      expect(problems(review(withField(text, "Verdict", value))), value).toEqual(["verdict_invalid"]);
    }
  });

  it("rejects a report that names two verdicts", async () => {
    const text = insertAfter(await fixture("review-no-findings.txt"), "Verdict", "Verdict: BLOCKING_FINDINGS");
    expect(problems(review(text))).toEqual(["field_repeated", "verdict_invalid"]);
  });

  it("reads a line below the verdict as part of the verdict", async () => {
    const text = await fixture("review-no-findings.txt");
    for (const convert of [(value: string) => value, crlf]) {
      for (const line of ["BLOCKING_FINDINGS", "- NON_BLOCKING_ONLY", "NO_FINDINGS", "Nothing stood out."]) {
        const result = review(convert(insertAfter(text, "Verdict", line)));
        expect(problems(result), line).toEqual(["verdict_invalid"]);
        expect(reviewDisposition(result), line).toBe("request_report");
      }
    }
  });

  // The status decides what the controller does, so two statuses or text below the status are never read.
  it("rejects a second status line and text below the status", async () => {
    const text = await fixture("review-no-findings.txt");
    for (const second of ["STATUS: DONE", "STATUS: DONE_WITH_CONCERNS", "Status: BLOCKED", "The review went well."]) {
      const candidates = [insertAfter(text, "STATUS", second), ...(second.includes(":") ? [insertAfter(text, "Risks", second), `${text.trimEnd()}\n${second}\n`] : [])];
      for (const candidate of candidates) {
        const result = review(candidate);
        expect(problems(result), candidate).toEqual(["status_invalid"]);
        expect(reviewDisposition(result), candidate).toBe("request_report");
      }
    }
    const wrong = review(insertAfter(withField(text, "Target", OTHER), "STATUS", "STATUS: BLOCKED"));
    expect(problems(wrong)).toEqual(["status_invalid", "target_mismatch"]);
    expect(reviewDisposition(wrong)).toBe("reject");
  });

  it("rejects a report that starts with a verdict line instead of the status", async () => {
    const text = (await fixture("review-no-findings.txt")).replace(/^STATUS: DONE\n/, "VERDICT: NO_FINDINGS\n");
    const result = review(text);
    expect(problems(result)).toEqual(["status_missing"]);
    expect(reviewDisposition(result)).toBe("request_report");
  });

  it("rejects NO_FINDINGS next to a finding", async () => {
    const text = withField(await fixture("review-blocking-findings.txt"), "Verdict", "NO_FINDINGS");
    expect(problems(review(text))).toEqual(["findings_unexpected"]);
  });

  it("rejects a verdict with findings that lists none", async () => {
    const text = await fixture("review-no-findings.txt");
    for (const verdict of ["BLOCKING_FINDINGS", "NON_BLOCKING_ONLY"]) {
      expect(problems(review(withField(text, "Verdict", verdict))), verdict).toEqual(["findings_missing"]);
    }
  });

  it("rejects a finding without severity, path or line", async () => {
    const text = await fixture("review-no-findings.txt");
    for (const finding of [
      "- handler.ts:2 — no severity.",
      "- high handler.ts — no line.",
      "- high the lookup ignores the tenant.",
      "- severe handler.ts:2 — an unknown severity.",
      "- high /srv/app/handler.ts:2 — an absolute path.",
      "- high ../handler.ts:2 — a path outside the repository.",
      "- high handler.ts:0 — no such line.",
    ]) {
      const candidate = withField(text, "Verdict", "BLOCKING_FINDINGS").replace("- none\nRisks:", `${finding}\nRisks:`);
      expect(problems(review(candidate)), finding).toEqual(["finding_invalid"]);
    }
  });

  it("never reads a finding written as prose or as an indented list as no findings", async () => {
    const text = await fixture("review-no-findings.txt");
    for (const finding of ["The lookup in handler.ts ignores the tenant.", "  - high handler.ts:2 — indented.", "No blocking problems, one remark below."]) {
      const candidate = text.replace("- none\nRisks:", `${finding}\nRisks:`);
      expect(problems(review(candidate)), finding).toEqual(["finding_invalid"]);
    }
  });

  it("rejects a second findings section instead of dropping it", async () => {
    const text = `${(await fixture("review-no-findings.txt")).trimEnd()}\nFindings:\n- high handler.ts:2 — hidden below the checks.\n`;
    expect(problems(review(text))).toEqual(["field_repeated", "finding_invalid"]);
  });

  it("rejects a review without a findings section or with an empty one", async () => {
    const text = await fixture("review-no-findings.txt");
    expect(problems(review(withoutSection(text, "Findings")))).toEqual(["findings_missing"]);
    expect(problems(review(text.replace("Findings:\n- none\n", "Findings:\n")))).toEqual(["findings_missing"]);
    const bare = `STATUS: DONE\nTarget: ${TARGET}\nVerdict: NO_FINDINGS\n`;
    expect(problems(review(bare))).toEqual(["findings_missing"]);
  });

  it("rejects none beside a finding", async () => {
    const text = (await fixture("review-blocking-findings.txt")).replace("Findings:\n", "Findings:\n- none\n");
    expect(problems(review(text))).toEqual(["finding_invalid"]);
  });

  // An indented finding would otherwise be read as text of the finding above it and vanish.
  it("rejects a finding indented below another finding", async () => {
    const text = await fixture("review-done-with-concerns.txt");
    for (const nested of [
      "  - high token.ts:2 — A wildcard claim authorizes every permission.",
      "  high `token.ts:2`: no list marker.",
      "\t* critical token.ts:2-4 — a tab.",
      "  - high `src/my helper.ts:2` — a path with a space, in backticks.",
      "  - high src/my helper.ts:2 — a path with a space, bare.",
    ]) {
      const candidate = text.replace("Not reviewed:", `${nested}\nNot reviewed:`);
      expect(problems(review(candidate)), nested).toEqual(["finding_invalid"]);
    }
    // Text that only starts like a finding stays text, with or without a space after the colon.
    const continuation = ["- low risk: 3 callers pass a typed client.", "- low risk:3 callers", "The severity is high-level only.", "Fix: type the parameter in clean.ts:1 and its callers."];
    const prose = text.replace("Not reviewed:", `${continuation.map((line) => `  ${line}`).join("\n")}\nNot reviewed:`);
    expect(parsed(review(prose)).findings[0]?.details).toEqual(continuation);
  });

  it("reads a path with a space only in backticks", async () => {
    const text = await fixture("review-blocking-findings.txt");
    const quoted = parsed(review(text.replace("- high handler.ts:2 —", "- high `src/my helper.ts:2-4` —")));
    expect(quoted.findings[0]).toMatchObject({ severity: "high", path: "src/my helper.ts", line: 2 });
    expect(quoted.findings).toHaveLength(2);
    for (const location of ["src/my helper.ts:2", "` handler.ts:2`", "`handler.ts:2", "handler.ts:2`", "`/srv/my app/handler.ts:2`", "`../my app/handler.ts:2`"]) {
      const candidate = text.replace("- high handler.ts:2 —", `- high ${location} —`);
      expect(problems(review(candidate)), location).toEqual(["finding_invalid"]);
    }
  });

  it("rejects a finding in a report without a review", async () => {
    for (const name of ["review-blocked.txt", "review-needs-context.txt"]) {
      const text = (await fixture(name)).trimEnd();
      const result = review(`${text}\nFindings:\n- high handler.ts:2 — The lookup ignores the tenant.\n`);
      expect(problems(result), name).toEqual(["field_unexpected"]);
      expect(reviewDisposition(result), name).toBe("request_report");
      expect(review(`${text}\nFindings:\n- none\n`), name).toMatchObject({ ok: true });
    }
  });

  it("accepts a location in backticks and a line range", async () => {
    const text = (await fixture("review-blocking-findings.txt")).replace("- high handler.ts:2 —", "- High `handler.ts:2-3` —");
    expect(parsed(review(text)).findings[0]).toMatchObject({ severity: "high", path: "handler.ts", line: 2 });
  });
});

describe("review report completeness", () => {
  it("rejects a truncated report and asks for a complete one", async () => {
    const result = review(await fixture("review-no-findings.txt"), { truncated: true });
    expect(problems(result)).toEqual(["incomplete_turn"]);
    expect(reviewDisposition(result)).toBe("request_report");
  });

  it("rejects a report cut off by the output limit", async () => {
    const result = review(await fixture("review-blocking-findings.txt"), { completion: "output_limit" });
    expect(problems(result)).toEqual(["incomplete_turn"]);
    expect(reviewDisposition(result)).toBe("request_report");
  });

  it("rejects a cut-off report of another commit outright", async () => {
    const result = review(withField(await fixture("review-no-findings.txt"), "Target", OTHER), { truncated: true });
    expect(problems(result)).toEqual(["incomplete_turn", "target_mismatch"]);
    expect(reviewDisposition(result)).toBe("reject");
  });

  // The order of "Accepting a review report" in the handoff reference: another commit first, then form.
  it("decides in the documented order", async () => {
    const good = await fixture("review-no-findings.txt");
    const wrong = withField(good, "Target", OTHER);
    const cut = { truncated: true };
    const table: Array<[string, Validation, string]> = [
      ["another commit", review(wrong), "reject"],
      ["another commit, cut off", review(wrong, cut), "reject"],
      ["another commit, no status", review(wrong.replace(/^STATUS: DONE\n/, "")), "reject"],
      ["another commit, no verdict", review(withField(wrong, "Verdict", undefined)), "reject"],
      ["cut off", review(good, cut), "request_report"],
      ["no status", review(good.replace(/^STATUS: DONE\n/, "")), "request_report"],
      ["no target", review(withField(good, "Target", undefined)), "request_report"],
      ["no target, cut off", review(withField(good, "Target", undefined), cut), "request_report"],
      ["abbreviated target", review(withField(good, "Target", TARGET.slice(0, 12))), "request_report"],
      ["no verdict", review(withField(good, "Verdict", undefined)), "request_report"],
      ["no findings section", review(withoutSection(good, "Findings")), "request_report"],
      ["complete", review(good), "complete_review"],
      ["partial", review(await fixture("review-done-with-concerns.txt")), "incomplete_review"],
      ["question", review(await fixture("review-needs-context.txt")), "needs_context"],
      ["blocked", review(await fixture("review-blocked.txt")), "blocked"],
    ];
    for (const [name, result, expected] of table) expect(reviewDisposition(result), name).toBe(expected);
  });
});

describe("report role", () => {
  it("rejects an implementation report offered as a review", async () => {
    const result = review(await fixture("text-valid-done.txt"));
    // Its fields are no review labels, so they read as text below the status.
    expect(problems(result)).toEqual(["status_invalid", "target_missing"]);
    expect(reviewDisposition(result)).toBe("request_report");
  });

  it("rejects a review report offered as an implementation report", async () => {
    const result = validateTextReport(turn(await fixture("review-no-findings.txt")));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toEqual(["commit_missing"]);
  });
});

describe("review report against a real candidate commit", () => {
  let repository = "";
  let base = "";
  let candidate = "";

  beforeAll(async () => {
    repository = await temporaryRoot("review-oracle-");
    expect(git(repository, "init", "-q").status).toBe(0);
    expect(git(repository, "config", "user.email", "oracle@example.invalid").status).toBe(0);
    expect(git(repository, "config", "user.name", "Review Oracle").status).toBe(0);
    expect(git(repository, "commit", "--allow-empty", "-m", "base").status).toBe(0);
    base = git(repository, "rev-parse", "HEAD").stdout.trim();
    expect(git(repository, "commit", "--allow-empty", "-m", "candidate").status).toBe(0);
    candidate = git(repository, "rev-parse", "HEAD").stdout.trim();
  });

  it("binds a normal review to the candidate", async () => {
    const result = review(withField(await fixture("review-no-findings.txt"), "Target", candidate), {}, candidate);
    expect(parsed(result).target).toBe(candidate);
    expect(git(repository, "rev-parse", "--verify", `${candidate}^{commit}`).status).toBe(0);
    expect(reviewDisposition(result)).toBe("complete_review");
  });

  // The base is a real commit of the same repository, so its existence proves nothing about the candidate.
  it("rejects a review of the base although that commit exists", async () => {
    const result = review(withField(await fixture("review-no-findings.txt"), "Target", base), {}, candidate);
    expect(git(repository, "rev-parse", "--verify", `${base}^{commit}`).status).toBe(0);
    expect(problems(result)).toEqual(["target_mismatch"]);
    expect(reviewDisposition(result)).toBe("reject");
  });
});

describe("report examples in the skills", () => {
  const examples = async (path: string): Promise<string[]> => {
    const text = await readFile(new URL(path, import.meta.url), "utf8");
    return [...text.matchAll(/^```text\n(STATUS:[\s\S]*?)\n```$/gm)].map((match) => match[1] ?? "");
  };

  it("validate against the contract they describe", async () => {
    const reference = await examples("../skills/pi-session-orchestration/references/handoff-reports.md");
    const reviewSkill = await examples("../skills/pi-session-review/SKILL.md");
    expect(reference).toHaveLength(6);
    expect(reviewSkill).toHaveLength(1);
    const dispositions: string[] = [];
    for (const example of [...reference, ...reviewSkill]) {
      const target = /^Target: (\S+)$/m.exec(example)?.[1];
      if (target === undefined) {
        expect(validateTextReport(turn(example)), example).toMatchObject({ ok: true });
        continue;
      }
      const result = review(example, {}, target);
      expect(result, example).toMatchObject({ ok: true });
      dispositions.push(reviewDisposition(result));
    }
    // The reference shows each of the four review outcomes at least once.
    expect([...new Set(dispositions)].sort()).toEqual(["blocked", "complete_review", "incomplete_review", "needs_context"]);
  });
});

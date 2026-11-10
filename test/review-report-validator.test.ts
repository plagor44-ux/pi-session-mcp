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
    for (const value of [TARGET.slice(0, 12), `\`${TARGET}\``, `${TARGET} (main)`, TARGET.toUpperCase(), `${OTHER}..${TARGET}`]) {
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

  it("rejects a report that names two targets, in either order", async () => {
    const text = await fixture("review-no-findings.txt");
    expect(problems(review(insertAfter(text, "Target", `Target: ${OTHER}`)))).toEqual(["target_invalid"]);
    expect(problems(review(insertAfter(withField(text, "Target", OTHER), "Target", `Target: ${TARGET}`)))).toEqual(["target_invalid"]);
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
    expect(problems(review(text))).toEqual(["verdict_invalid"]);
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
    expect(problems(review(text))).toEqual(["finding_invalid"]);
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
});

describe("report role", () => {
  it("rejects an implementation report offered as a review", async () => {
    const result = review(await fixture("text-valid-done.txt"));
    expect(problems(result)).toEqual(["target_missing", "verdict_missing"]);
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

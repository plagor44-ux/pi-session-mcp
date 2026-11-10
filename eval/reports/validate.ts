export type ReportStatus = "DONE" | "DONE_WITH_CONCERNS" | "NEEDS_CONTEXT" | "BLOCKED";

export type Problem =
  | "status_missing"
  | "status_invalid"
  | "commit_missing"
  | "checks_missing"
  | "question_missing"
  | "concerns_missing"
  | "receipt_missing"
  | "receipt_invalid"
  | "receipt_duplicate"
  | "status_mismatch"
  | "incomplete_turn";

export interface ParsedReport {
  status: ReportStatus;
  commit?: string;
  checks: Array<{ command: string; exitCode: number }>;
  concerns: string[];
  question?: string;
  claimsOnly: true;
}

interface Turn {
  assistantText: string;
  truncated: boolean;
  completion: "stop" | "output_limit" | "tool_use";
}

type Validation = { ok: true; report: ParsedReport } | { ok: false; problems: Problem[] };

interface Receipt {
  status: ReportStatus;
  commit: string | null;
  checks: Array<{ command: string; exitCode: number }>;
  concerns: string[];
  question?: string;
}

const STATUSES: readonly ReportStatus[] = ["DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED"];
const STATUS_LINE = /^STATUS:\s*(.*?)\s*$/;
const TOP_LEVEL_LABEL = /^(?:Result|Commit|Changed files|Checks run|Concerns|Open points|Question):/i;
const JSON_FENCE_OPEN = /^```json\s*$/i;
const JSON_FENCE_CLOSE = /^```\s*$/;
const RECEIPT_KEYS = new Set(["schema", "status", "base", "result", "changedFiles", "checks", "concerns", "question"]);
const RESULT_KEYS = new Set(["branch", "commit"]);
const CHECK_KEYS = new Set(["command", "exitCode"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStatus(value: string): value is ReportStatus {
  return (STATUSES as readonly string[]).includes(value);
}

function hasUnknownKey(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).some((key) => !allowed.has(key));
}

function parseStatusLine(line: string | undefined): { status: ReportStatus } | { problem: "status_missing" | "status_invalid" } {
  if (line === undefined || !line.startsWith("STATUS:")) return { problem: "status_missing" };
  const value = STATUS_LINE.exec(line)?.[1] ?? "";
  return isStatus(value) ? { status: value } : { problem: "status_invalid" };
}

function section(lines: readonly string[], label: string, boundary: RegExp = TOP_LEVEL_LABEL): string[] | undefined {
  const pattern = new RegExp(`^${label}:\\s*(.*)$`, "i");
  const index = lines.findIndex((line, position) => position > 0 && pattern.test(line));
  if (index === -1) return undefined;
  const inline = pattern.exec(lines[index] ?? "")?.[1]?.trim() ?? "";
  const body = inline ? [inline] : [];
  for (let position = index + 1; position < lines.length; position += 1) {
    const line = lines[position] ?? "";
    if (boundary.test(line)) break;
    body.push(line);
  }
  return body;
}

function firstText(body: string[] | undefined): string | undefined {
  for (const raw of body ?? []) {
    const line = raw.replace(/^[-*]\s+/, "").trim();
    if (line) return line;
  }
  return undefined;
}

function items(body: string[] | undefined): string[] {
  const result: string[] = [];
  for (const raw of body ?? []) {
    const line = raw.replace(/^[-*]\s+/, "").trim();
    if (!line || /^none\.?$/i.test(line)) continue;
    result.push(line);
  }
  return result;
}

function parseChecks(body: string[] | undefined): Array<{ command: string; exitCode: number }> {
  const checks: Array<{ command: string; exitCode: number }> = [];
  for (const raw of body ?? []) {
    const line = raw.trim();
    if (!/^[-*]\s+/.test(line)) continue;
    const match = /^[-*]\s+(?<command>.+?)\s*(?:—|–|:|-)?\s+exit\s+(?<code>-?\d+)\b/i.exec(line);
    const command = match?.groups?.command?.trim();
    const code = match?.groups?.code;
    if (!command || code === undefined) continue;
    checks.push({ command, exitCode: Number(code) });
  }
  return checks;
}

type CommitClaim = { kind: "hash"; commit: string } | { kind: "not_committed" } | { kind: "missing" };

function parseCommitClaim(value: string | undefined): CommitClaim {
  if (!value) return { kind: "missing" };
  const hash = /^[0-9a-f]{7,40}\b/i.exec(value);
  if (hash?.[0]) return { kind: "hash", commit: hash[0] };
  if (/^not committed\b/i.test(value)) {
    const reason = value.slice("not committed".length).replace(/^[\s—–:,-]+/, "").trim();
    if (reason) return { kind: "not_committed" };
  }
  return { kind: "missing" };
}

function needsCommit(status: ReportStatus): boolean {
  return status === "DONE" || status === "DONE_WITH_CONCERNS";
}

function reportOf(
  status: ReportStatus,
  commit: string | undefined,
  checks: Array<{ command: string; exitCode: number }>,
  concerns: string[],
  question: string | undefined,
): ParsedReport {
  return {
    status,
    checks,
    concerns,
    claimsOnly: true,
    ...(commit === undefined ? {} : { commit }),
    ...(question === undefined ? {} : { question }),
  };
}

function incomplete(turn: Turn): boolean {
  return turn.truncated || turn.completion !== "stop";
}

export function validateTextReport(turn: Turn): Validation {
  const problems: Problem[] = [];
  if (incomplete(turn)) problems.push("incomplete_turn");
  const lines = turn.assistantText.split(/\r?\n/);
  const status = parseStatusLine(lines[0]);
  if ("problem" in status) return { ok: false, problems: [...problems, status.problem] };

  const commitClaim = parseCommitClaim(firstText(section(lines, "Commit")));
  const checks = parseChecks(section(lines, "Checks run"));
  const openPoints = section(lines, "Open points");
  const concerns = items(section(lines, "Concerns") ?? openPoints);
  const explicitQuestion = firstText(section(lines, "Question"));
  const question = explicitQuestion ?? (status.status === "NEEDS_CONTEXT" ? items(openPoints)[0] : undefined);

  if (needsCommit(status.status) && commitClaim.kind === "missing") problems.push("commit_missing");
  if (needsCommit(status.status) && checks.length === 0) problems.push("checks_missing");
  if (status.status === "DONE_WITH_CONCERNS" && concerns.length === 0) problems.push("concerns_missing");
  if (status.status === "NEEDS_CONTEXT" && question === undefined) problems.push("question_missing");
  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    report: reportOf(status.status, commitClaim.kind === "hash" ? commitClaim.commit : undefined, checks, concerns, question),
  };
}

function jsonBlocks(lines: readonly string[]): string[] {
  const blocks: string[] = [];
  for (let position = 0; position < lines.length; position += 1) {
    if (!JSON_FENCE_OPEN.test(lines[position] ?? "")) continue;
    const start = position + 1;
    let end = start;
    while (end < lines.length && !JSON_FENCE_CLOSE.test(lines[end] ?? "")) end += 1;
    blocks.push(lines.slice(start, end).join("\n"));
    position = end;
  }
  return blocks;
}

function parseReceipt(text: string): { receipt: Receipt } | { problem: Problem } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { problem: "receipt_invalid" };
  }
  if (!isRecord(value) || hasUnknownKey(value, RECEIPT_KEYS) || value.schema !== "receipt-v1") return { problem: "receipt_invalid" };
  if (typeof value.status !== "string") return { problem: "receipt_invalid" };
  if (!isStatus(value.status)) return { problem: "status_invalid" };
  if (typeof value.base !== "string" || value.base.trim() === "") return { problem: "receipt_invalid" };

  const result = value.result;
  if (!isRecord(result) || hasUnknownKey(result, RESULT_KEYS) || typeof result.branch !== "string" || result.branch.trim() === "") {
    return { problem: "receipt_invalid" };
  }
  if (result.commit !== null && (typeof result.commit !== "string" || result.commit.trim() === "")) {
    return { problem: "receipt_invalid" };
  }

  if (!Array.isArray(value.changedFiles) || !value.changedFiles.every((file) => typeof file === "string" && file !== "")) {
    return { problem: "receipt_invalid" };
  }
  if (!Array.isArray(value.concerns) || !value.concerns.every((concern) => typeof concern === "string" && concern !== "")) {
    return { problem: "receipt_invalid" };
  }
  if (!Array.isArray(value.checks)) return { problem: "receipt_invalid" };
  const checks: Array<{ command: string; exitCode: number }> = [];
  for (const entry of value.checks) {
    if (!isRecord(entry) || hasUnknownKey(entry, CHECK_KEYS) || typeof entry.command !== "string" || entry.command.trim() === "") {
      return { problem: "receipt_invalid" };
    }
    if (typeof entry.exitCode !== "number" || !Number.isInteger(entry.exitCode)) return { problem: "receipt_invalid" };
    checks.push({ command: entry.command.trim(), exitCode: entry.exitCode });
  }
  if (value.question !== undefined && typeof value.question !== "string") return { problem: "receipt_invalid" };

  const question = typeof value.question === "string" && value.question.trim() !== "" ? value.question.trim() : undefined;
  return {
    receipt: {
      status: value.status,
      commit: typeof result.commit === "string" ? result.commit.trim() : null,
      checks,
      concerns: value.concerns as string[],
      ...(question === undefined ? {} : { question }),
    },
  };
}

export function validateReceipt(turn: Turn): Validation {
  const problems: Problem[] = [];
  if (incomplete(turn)) problems.push("incomplete_turn");
  const lines = turn.assistantText.split(/\r?\n/);
  const status = parseStatusLine(lines[0]);
  if ("problem" in status) return { ok: false, problems: [...problems, status.problem] };

  const blocks = jsonBlocks(lines);
  if (blocks.length === 0) return { ok: false, problems: [...problems, "receipt_missing"] };
  if (blocks.length > 1) return { ok: false, problems: [...problems, "receipt_duplicate"] };
  const parsed = parseReceipt(blocks[0] ?? "");
  if ("problem" in parsed) return { ok: false, problems: [...problems, parsed.problem] };

  const receipt = parsed.receipt;
  if (receipt.status !== status.status) return { ok: false, problems: [...problems, "status_mismatch"] };
  if (needsCommit(receipt.status) && receipt.commit === null) problems.push("commit_missing");
  if (needsCommit(receipt.status) && receipt.checks.length === 0) problems.push("checks_missing");
  if (receipt.status === "DONE_WITH_CONCERNS" && receipt.concerns.length === 0) problems.push("concerns_missing");
  if (receipt.status === "NEEDS_CONTEXT" && receipt.question === undefined) problems.push("question_missing");
  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    report: reportOf(receipt.status, receipt.commit ?? undefined, receipt.checks, receipt.concerns, receipt.question),
  };
}

export type ReviewVerdict = "BLOCKING_FINDINGS" | "NON_BLOCKING_ONLY" | "NO_FINDINGS";
export type FindingSeverity = "critical" | "high" | "medium" | "low";

export type ReviewProblem =
  | "status_missing"
  | "status_invalid"
  | "incomplete_turn"
  | "expected_target_invalid"
  | "target_missing"
  | "target_invalid"
  | "target_mismatch"
  | "verdict_missing"
  | "verdict_invalid"
  | "verdict_unexpected"
  | "finding_invalid"
  | "findings_missing"
  | "findings_unexpected"
  | "scope_missing"
  | "scope_conflict"
  | "question_missing"
  | "blocker_missing";

export interface ReviewFinding {
  severity: FindingSeverity;
  /** Repository-relative path. */
  path: string;
  line: number;
  text: string;
}

export interface ParsedReview {
  status: ReportStatus;
  /** The commit the report names. It equals the expected target, or the report does not validate. */
  target: string;
  /** Present for `DONE` and `DONE_WITH_CONCERNS` only. */
  verdict?: ReviewVerdict;
  findings: ReviewFinding[];
  /** The parts a `DONE_WITH_CONCERNS` review left out. */
  notReviewed: string[];
  checks: Array<{ command: string; exitCode: number }>;
  question?: string;
  blocker?: string;
  claimsOnly: true;
}

export type ReviewValidation = { ok: true; report: ParsedReview } | { ok: false; problems: ReviewProblem[] };

/**
 * What a controller does with a review report:
 * - `complete_review`: the whole target was reviewed at the expected commit; the verdict may be used.
 * - `incomplete_review`: the verdict covers only a part of the target; it never stands for the whole.
 * - `needs_context`: the reviewer asks a question; no review took place yet.
 * - `blocked`: the reviewer could not review; no review took place.
 * - `request_report`: the report is cut off or not in the agreed format; ask once for a complete one.
 * - `reject`: the report is bound to another commit, or no binding can be checked; discard it and
 *   review again. Asking the same session to correct the line would only produce the expected text.
 */
export type ReviewDisposition = "complete_review" | "incomplete_review" | "needs_context" | "blocked" | "request_report" | "reject";

const VERDICTS: readonly ReviewVerdict[] = ["BLOCKING_FINDINGS", "NON_BLOCKING_ONLY", "NO_FINDINGS"];
const REVIEW_LABEL = /^(?:Target|Verdict|Findings|Not reviewed|Risks|Checks run|Checks not run|Question|Blocker):/i;
/** A bare full commit hash: SHA-1 or SHA-256, lowercase as Git prints it. */
const FULL_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const FINDING =
  /^[-*]\s+(?<severity>critical|high|medium|low)\s+`?(?<path>[^\s:`]+):(?<line>[1-9]\d*)(?:-[1-9]\d*)?`?\s*(?:—|–|-|:)\s*(?<text>\S.*)$/i;

function isVerdict(value: string): value is ReviewVerdict {
  return (VERDICTS as readonly string[]).includes(value);
}

function isRepositoryRelative(path: string): boolean {
  return !path.startsWith("/") && !path.includes("\\") && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function labelCount(lines: readonly string[], label: string): number {
  const pattern = new RegExp(`^${label}:`, "i");
  return lines.filter((line, position) => position > 0 && pattern.test(line)).length;
}

type SingleValue = { kind: "missing" } | { kind: "ambiguous" } | { kind: "value"; value: string };

/** A field that binds the report must appear once: two different values would let either be read. */
function singleValue(lines: readonly string[], label: string): SingleValue {
  const count = labelCount(lines, label);
  if (count > 1) return { kind: "ambiguous" };
  const value = firstText(section(lines, label, REVIEW_LABEL));
  return value === undefined ? { kind: "missing" } : { kind: "value", value };
}

/**
 * Every line of the findings section is `none`, the head of a finding or an indented line that
 * continues the finding above it. Anything else is invalid, so a finding written as prose or as an
 * indented list is never read as "no findings".
 */
function parseFindings(body: string[] | undefined): { findings: ReviewFinding[]; invalid: boolean } {
  const findings: ReviewFinding[] = [];
  let invalid = false;
  let open = false;
  for (const raw of body ?? []) {
    if (raw.trim() === "") continue;
    if (/^\s/.test(raw)) {
      if (!open) invalid = true;
      continue;
    }
    open = false;
    if (/^(?:[-*]\s+)?none\.?\s*$/i.test(raw)) continue;
    const groups = FINDING.exec(raw)?.groups;
    const path = groups?.path;
    if (groups === undefined || path === undefined || !isRepositoryRelative(path)) {
      invalid = true;
      continue;
    }
    open = true;
    findings.push({
      severity: (groups.severity ?? "").toLowerCase() as FindingSeverity,
      path,
      line: Number(groups.line),
      text: (groups.text ?? "").trim(),
    });
  }
  return { findings, invalid };
}

/**
 * Checks the shape of a review report and its binding to one commit. `expected.target` is the full
 * hash of the commit the controller asked to have reviewed. A report that names another commit, an
 * abbreviated hash or none does not validate, whatever its verdict. A valid report is still a claim:
 * that the reviewer read this commit is evidence only where the controller fixed it, for example with
 * a review snapshot.
 */
export function validateReviewReport(turn: Turn, expected: { target: string }): ReviewValidation {
  if (!FULL_HASH.test(expected.target)) return { ok: false, problems: ["expected_target_invalid"] };
  const problems: ReviewProblem[] = [];
  if (incomplete(turn)) problems.push("incomplete_turn");
  const lines = turn.assistantText.split(/\r?\n/);
  const status = parseStatusLine(lines[0]);
  if ("problem" in status) return { ok: false, problems: [...problems, status.problem] };

  const target = singleValue(lines, "Target");
  if (target.kind === "missing") problems.push("target_missing");
  else if (target.kind === "ambiguous" || !FULL_HASH.test(target.value)) problems.push("target_invalid");
  else if (target.value !== expected.target) problems.push("target_mismatch");

  const reviewed = status.status === "DONE" || status.status === "DONE_WITH_CONCERNS";
  const claimed = singleValue(lines, "Verdict");
  let verdict: ReviewVerdict | undefined;
  if (!reviewed) {
    if (claimed.kind !== "missing") problems.push("verdict_unexpected");
  } else if (claimed.kind === "missing") problems.push("verdict_missing");
  else if (claimed.kind === "ambiguous" || !isVerdict(claimed.value)) problems.push("verdict_invalid");
  else verdict = claimed.value;

  // Without a review there is nothing to bind findings to; the section is not read then.
  const parsed = reviewed ? parseFindings(section(lines, "Findings", REVIEW_LABEL)) : { findings: [], invalid: false };
  const findingsInvalid = parsed.invalid || (reviewed && labelCount(lines, "Findings") > 1);
  if (findingsInvalid) problems.push("finding_invalid");
  else if (verdict === "NO_FINDINGS" && parsed.findings.length > 0) problems.push("findings_unexpected");
  else if (verdict !== undefined && verdict !== "NO_FINDINGS" && parsed.findings.length === 0) problems.push("findings_missing");

  const notReviewed = items(section(lines, "Not reviewed", REVIEW_LABEL));
  if (status.status === "DONE_WITH_CONCERNS" && notReviewed.length === 0) problems.push("scope_missing");
  if (status.status === "DONE" && notReviewed.length > 0) problems.push("scope_conflict");
  const question = items(section(lines, "Question", REVIEW_LABEL))[0];
  if (status.status === "NEEDS_CONTEXT" && question === undefined) problems.push("question_missing");
  const blocker = items(section(lines, "Blocker", REVIEW_LABEL))[0];
  if (status.status === "BLOCKED" && blocker === undefined) problems.push("blocker_missing");
  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    report: {
      status: status.status,
      target: expected.target,
      findings: parsed.findings,
      notReviewed,
      checks: parseChecks(section(lines, "Checks run", REVIEW_LABEL)),
      claimsOnly: true,
      ...(verdict === undefined ? {} : { verdict }),
      ...(status.status === "NEEDS_CONTEXT" && question !== undefined ? { question } : {}),
      ...(status.status === "BLOCKED" && blocker !== undefined ? { blocker } : {}),
    },
  };
}

export function reviewDisposition(result: ReviewValidation): ReviewDisposition {
  if (!result.ok) {
    const unbound = result.problems.includes("target_mismatch") || result.problems.includes("expected_target_invalid");
    return unbound ? "reject" : "request_report";
  }
  switch (result.report.status) {
    case "DONE": return "complete_review";
    case "DONE_WITH_CONCERNS": return "incomplete_review";
    case "NEEDS_CONTEXT": return "needs_context";
    case "BLOCKED": return "blocked";
  }
}

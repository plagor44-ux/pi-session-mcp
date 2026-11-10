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

function section(lines: readonly string[], label: string): string[] | undefined {
  const pattern = new RegExp(`^${label}:\\s*(.*)$`, "i");
  const index = lines.findIndex((line, position) => position > 0 && pattern.test(line));
  if (index === -1) return undefined;
  const inline = pattern.exec(lines[index] ?? "")?.[1]?.trim() ?? "";
  const body = inline ? [inline] : [];
  for (let position = index + 1; position < lines.length; position += 1) {
    const line = lines[position] ?? "";
    if (TOP_LEVEL_LABEL.test(line)) break;
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
  | "field_repeated"
  | "field_unexpected"
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
  /** The indented lines below the finding, such as its impact and fix, without their indentation. */
  details: string[];
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
 * - `reject`: the report names another commit, or no binding can be checked; discard it and review
 *   again. Asking the same session to correct the line would only produce the expected text. This
 *   comes before every other problem: a cut-off or malformed report of another commit is rejected too.
 */
export type ReviewDisposition = "complete_review" | "incomplete_review" | "needs_context" | "blocked" | "request_report" | "reject";

const VERDICTS: readonly ReviewVerdict[] = ["BLOCKING_FINDINGS", "NON_BLOCKING_ONLY", "NO_FINDINGS"];
const REVIEW_LABELS = ["Target", "Verdict", "Findings", "Not reviewed", "Risks", "Checks run", "Checks not run", "Question", "Blocker"] as const;
type ReviewLabel = (typeof REVIEW_LABELS)[number];
const REVIEW_LABEL = new RegExp(`^(?:${REVIEW_LABELS.join("|")}):`, "i");
/** A bare full commit hash: SHA-1 or SHA-256, lowercase as Git prints it. */
const FULL_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** A full commit hash anywhere in a line, in either case and next to any other text. */
const FULL_HASH_TOKEN = /(?<![0-9a-f])(?:[0-9a-f]{64}|[0-9a-f]{40})(?![0-9a-f])/gi;
const FINDING =
  /^[-*]\s+(?<severity>critical|high|medium|low)\s+`?(?<path>[^\s:`]+):(?<line>[1-9]\d*)(?:-[1-9]\d*)?`?\s*(?:—|–|-|:)\s*(?<text>\S.*)$/i;
/** An indented line that gives a severity and a location: a finding below another finding. */
const NESTED_FINDING = /^\s+(?:[-*]\s+)?(?:critical|high|medium|low)\s+`?[^\s:`]+:\d/i;

function isVerdict(value: string): value is ReviewVerdict {
  return (VERDICTS as readonly string[]).includes(value);
}

function isRepositoryRelative(path: string): boolean {
  return !path.startsWith("/") && !path.includes("\\") && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

interface ReviewField {
  /** How often the label occurs. */
  count: number;
  /** The text after the label and every line below it up to the next label, for each occurrence. */
  body: string[];
}

/**
 * Reads a field wherever its label occurs, so that nothing a report says under a label is dropped:
 * a second section is counted and read, and a line below a one-line field belongs to that field.
 */
function reviewField(lines: readonly string[], label: ReviewLabel): ReviewField {
  const pattern = new RegExp(`^${label}:(.*)$`, "i");
  const field: ReviewField = { count: 0, body: [] };
  let inside = false;
  for (const line of lines) {
    const inline = pattern.exec(line)?.[1];
    if (inline !== undefined) {
      field.count += 1;
      inside = true;
      if (inline.trim() !== "") field.body.push(inline.trim());
    } else if (REVIEW_LABEL.test(line)) inside = false;
    else if (inside) field.body.push(line);
  }
  return field;
}

/** What a one-value field holds: every non-blank line of it, without a list marker. */
function values(field: ReviewField): string[] {
  return field.body.map((line) => line.trim().replace(/^[-*]\s+/, "").trim()).filter((line) => line !== "");
}

/**
 * Every line of the findings section is `none`, the head of a finding or an indented line that
 * continues the finding above it. Anything else is invalid, so a finding written as prose, as an
 * indented list or below another finding is never read as "no findings" or as text of its neighbor.
 */
function parseFindings(body: readonly string[]): { findings: ReviewFinding[]; none: boolean; invalid: boolean } {
  const findings: ReviewFinding[] = [];
  let none = false;
  let invalid = false;
  let open: ReviewFinding | undefined;
  for (const raw of body) {
    if (raw.trim() === "") continue;
    if (/^\s/.test(raw)) {
      if (open === undefined || NESTED_FINDING.test(raw)) invalid = true;
      else open.details.push(raw.trim());
      continue;
    }
    open = undefined;
    if (/^(?:[-*]\s+)?none\.?\s*$/i.test(raw)) {
      none = true;
      continue;
    }
    const groups = FINDING.exec(raw)?.groups;
    const path = groups?.path;
    if (groups === undefined || path === undefined || !isRepositoryRelative(path)) {
      invalid = true;
      continue;
    }
    open = {
      severity: (groups.severity ?? "").toLowerCase() as FindingSeverity,
      path,
      line: Number(groups.line),
      text: (groups.text ?? "").trim(),
      details: [],
    };
    findings.push(open);
  }
  // `none` beside a finding contradicts itself.
  return { findings, none, invalid: invalid || (none && findings.length > 0) };
}

/**
 * Checks the shape of a review report and its binding to one commit. `expected.target` is the full
 * hash of the commit the controller asked to have reviewed. A report that names another commit, an
 * abbreviated hash or none does not validate, whatever its verdict. Each label may occur once, and
 * `Target` and `Verdict` hold one value: a second section or a second line is never dropped in favor
 * of the first. A valid report is still a claim: that the reviewer read this commit is evidence only
 * where the controller fixed it, for example with a review snapshot.
 */
export function validateReviewReport(turn: Turn, expected: { target: string }): ReviewValidation {
  if (!FULL_HASH.test(expected.target)) return { ok: false, problems: ["expected_target_invalid"] };
  const problems: ReviewProblem[] = [];
  if (incomplete(turn)) problems.push("incomplete_turn");
  const lines = turn.assistantText.split(/\r?\n/);
  const field = (label: ReviewLabel): ReviewField => reviewField(lines, label);
  const status = parseStatusLine(lines[0]);
  if ("problem" in status) problems.push(status.problem);

  // The binding is checked whatever else is wrong with the report, so a report that names another
  // commit, alone or beside the expected one, is rejected and never sent back for a correction.
  const named = values(field("Target"));
  const hashes = named.flatMap((value) => value.match(FULL_HASH_TOKEN) ?? []);
  if (hashes.some((hash) => hash.toLowerCase() !== expected.target)) problems.push("target_mismatch");
  else if (named.length === 0) problems.push("target_missing");
  else if (named.length > 1 || named[0] !== expected.target) problems.push("target_invalid");
  if ("problem" in status) return { ok: false, problems };

  if (REVIEW_LABELS.some((label) => field(label).count > 1)) problems.push("field_repeated");

  const reviewed = status.status === "DONE" || status.status === "DONE_WITH_CONCERNS";
  const [claimed, ...otherVerdicts] = values(field("Verdict"));
  let verdict: ReviewVerdict | undefined;
  if (!reviewed) {
    if (field("Verdict").count > 0) problems.push("verdict_unexpected");
  } else if (claimed === undefined) problems.push("verdict_missing");
  else if (otherVerdicts.length > 0 || !isVerdict(claimed)) problems.push("verdict_invalid");
  else verdict = claimed;

  // Without a review there is nothing to bind findings to; the section is not read then. A review
  // says what it found: a missing or empty section is not read as "no findings".
  const parsed = reviewed ? parseFindings(field("Findings").body) : { findings: [], none: false, invalid: false };
  if (parsed.invalid) problems.push("finding_invalid");
  else if (verdict === "NO_FINDINGS" && parsed.findings.length > 0) problems.push("findings_unexpected");
  else if (reviewed && parsed.findings.length === 0 && !(parsed.none && (verdict === undefined || verdict === "NO_FINDINGS"))) {
    problems.push("findings_missing");
  }

  const notReviewed = items(field("Not reviewed").body);
  if (status.status === "DONE_WITH_CONCERNS" && notReviewed.length === 0) problems.push("scope_missing");
  if (status.status === "DONE" && notReviewed.length > 0) problems.push("scope_conflict");
  // One status, one outcome: a question or a blocker under another status would be lost, because
  // the controller acts on the status.
  const question = items(field("Question").body).join(" ") || undefined;
  const blocker = items(field("Blocker").body).join(" ") || undefined;
  if ((status.status !== "NEEDS_CONTEXT" && question !== undefined) || (status.status !== "BLOCKED" && blocker !== undefined)) {
    problems.push("field_unexpected");
  }
  if (status.status === "NEEDS_CONTEXT" && question === undefined) problems.push("question_missing");
  if (status.status === "BLOCKED" && blocker === undefined) problems.push("blocker_missing");
  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    report: {
      status: status.status,
      target: expected.target,
      findings: parsed.findings,
      notReviewed,
      checks: parseChecks(field("Checks run").body),
      claimsOnly: true,
      ...(verdict === undefined ? {} : { verdict }),
      ...(question === undefined ? {} : { question }),
      ...(blocker === undefined ? {} : { blocker }),
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

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

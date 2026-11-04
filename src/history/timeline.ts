import { PATH_RULE_MARKER } from "./constants.js";

/** One stored entry as the CLI reads it back. Its JSON is already redacted. */
export interface StoredEntry {
  readonly turn_id: string;
  readonly position: number;
  readonly entry_type: string;
  readonly timestamp: string;
  readonly role: string | null;
  readonly tool_name: string | null;
  readonly redacted_json: string;
  readonly dropped_by_path: number;
  readonly truncated: number;
}
export interface StoredGap { readonly id: number; readonly first_turn_id: string | null; readonly code: string; readonly recorded_at: string }
export interface StoredTurn { readonly turn_id: string; readonly started_at: string; readonly state: string }

const SHORT_TEXT_MAX = 160;
const ENVELOPE = new Set(["type", "id", "parentId", "timestamp"]);

/**
 * Replaces terminal control characters, so stored model output cannot drive the terminal.
 * `multiline` keeps newlines and tabs (for `--full`); otherwise they become spaces.
 */
export function printable(text: string, multiline = false): string {
  const cleaned = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "�");
  return multiline ? cleaned.replace(/\r\n?/g, "\n") : cleaned.replace(/[\t\n\r]+/g, " ");
}

function clock(timestamp: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(timestamp) ? timestamp.slice(11, 19) : "--:--:--";
}

function shorten(text: string): string {
  const chars = [...text.trim()];
  return chars.length <= SHORT_TEXT_MAX ? chars.join("") : `${chars.slice(0, SHORT_TEXT_MAX - 1).join("")}…`;
}

type Value = unknown;
const isObject = (value: Value): value is Record<string, Value> => typeof value === "object" && value !== null && !Array.isArray(value);

function toolCallText(block: Record<string, Value>): string {
  const name = typeof block.name === "string" ? block.name : "tool";
  const args = isObject(block.arguments) ? block.arguments : {};
  const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : undefined;
  if (typeof args.omitted === "string") return `${name}(${path ?? ""}: ${args.omitted})`;
  return `${name}(${path ?? JSON.stringify(args)})`;
}

function blockText(block: Value, full: boolean): string | undefined {
  if (typeof block === "string") return block;
  if (!isObject(block)) return undefined;
  if (block.type === "text" && typeof block.text === "string") return block.text;
  if (block.type === "toolCall") return toolCallText(block);
  if (block.type === "thinking") return full && typeof block.thinking === "string" ? `[thinking] ${block.thinking}` : "[thinking]";
  return typeof block.type === "string" ? `[${block.type}]` : undefined;
}

/** The tool names an assistant entry called, in order. */
function calledTools(value: Value): string[] {
  if (!isObject(value) || !isObject(value.message) || !Array.isArray(value.message.content)) return [];
  return value.message.content.filter((block): block is Record<string, Value> => isObject(block) && block.type === "toolCall" && typeof block.name === "string").map((block) => block.name as string);
}

function entryText(value: Value, full: boolean): string {
  if (!isObject(value)) return "";
  if (typeof value.omitted === "string") return `[omitted: ${value.omitted}]`;
  if (isObject(value.message)) {
    const content = value.message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((block) => blockText(block, full)).filter((part): part is string => part !== undefined && part !== "").join(" ");
    return "";
  }
  const rest = Object.fromEntries(Object.entries(value).filter(([key]) => !ENVELOPE.has(key)));
  return Object.keys(rest).length === 0 ? "" : JSON.stringify(rest);
}

export function entryLine(entry: StoredEntry, full: boolean): string {
  let value: Value;
  try { value = JSON.parse(entry.redacted_json); } catch { value = { omitted: "unreadable" }; }
  const tools = calledTools(value);
  const who = entry.tool_name ?? (tools.length > 0 ? tools.join(",") : entry.role ?? "-");
  let text = entryText(value, full);
  if (entry.dropped_by_path === 1 && !text.includes(PATH_RULE_MARKER)) text = `${text} [${PATH_RULE_MARKER}]`.trim();
  const body = full ? printable(text, true) : shorten(printable(text));
  return `${clock(entry.timestamp)}  ${printable(entry.entry_type)}  ${printable(who)}  ${body}`.trimEnd();
}

/**
 * Renders a session's timeline: one line per entry, each turn's gaps after its entries, then gaps
 * without entries, unrecorded turns and an incomplete session as lines of their own.
 */
export function renderTimeline(input: { entries: readonly StoredEntry[]; gaps: readonly StoredGap[]; turns: readonly StoredTurn[]; completeness: string }, full: boolean): string[] {
  const lines: string[] = [];
  const pending = [...input.gaps];
  const gapLine = (gap: StoredGap): string => `${clock(gap.recorded_at)}  gap  ${gap.code}  ${gap.first_turn_id === null ? "session" : `turn ${gap.first_turn_id.slice(0, 8)}`}`;
  const flushTurn = (turnId: string | undefined): void => {
    if (turnId === undefined) return;
    for (let index = 0; index < pending.length;) {
      if (pending[index]!.first_turn_id === turnId) lines.push(gapLine(pending.splice(index, 1)[0]!));
      else index += 1;
    }
  };
  let current: string | undefined;
  for (const entry of input.entries) {
    if (entry.turn_id !== current) { flushTurn(current); current = entry.turn_id; }
    lines.push(entryLine(entry, full));
  }
  flushTurn(current);
  for (const gap of pending) lines.push(gapLine(gap));
  for (const turn of input.turns) if (turn.state === "unrecorded") lines.push(`${clock(turn.started_at)}  turn  unrecorded  turn ${turn.turn_id.slice(0, 8)}`);
  if (input.completeness === "incomplete") lines.push("--:--:--  incomplete  -  session ended without a recorded close");
  return lines;
}

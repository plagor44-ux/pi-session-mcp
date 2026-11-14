import { HISTORY_ENTRY_CAP_BYTES, MIN_KNOWN_VALUE_LENGTH, PATH_RULE_MARKER } from "./constants.js";
import { filterGrepText, GREP_CHECK_BUDGET } from "./grep-paths.js";
import type { PathRule } from "./path-rule.js";

export type RedactionKind = "known_value" | "github_token" | "api_key" | "aws_access_key" | "slack_token" | "jwt" | "private_key" | "url_credentials" | "assignment";

/** Names of environment variables whose values count as known secrets (design call 13). */
export const SECRET_NAME_PATTERN = /TOKEN|SECRET|PASSW|API_KEY|PRIVATE|CREDENTIAL|AUTH/i;

/** Tool-call id → tool name and path argument, filled from assistant tool calls of the same session. */
export type ToolCallIndex = Map<string, { name: string; path?: string }>;

export interface RedactedEntry {
  json: string;
  redactions: Partial<Record<RedactionKind, number>>;
  droppedByPath: boolean;
  truncated: boolean;
  toolName?: string;
  role?: string;
  isError?: boolean;
}

/**
 * Values of the server's environment variables whose names look secret, at least
 * `MIN_KNOWN_VALUE_LENGTH` long, longest first so a value that contains another is replaced whole.
 * `auth.json` is never read.
 */
export function knownValuesFromEnv(env: NodeJS.ProcessEnv): readonly string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === "string" && value.length >= MIN_KNOWN_VALUE_LENGTH && SECRET_NAME_PATTERN.test(name)) values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/** Tools whose path-matching calls lose their content (design call 17). */
const PATH_RESULT_TOOLS = new Set(["read", "edit", "write"]);
const PATH_ARGUMENT_TOOLS = new Set(["edit", "write"]);
const SIGNATURE_KEYS = new Set(["thinkingSignature", "textSignature", "thoughtSignature"]);

const marker = (kind: RedactionKind): string => `[REDACTED:${kind}]`;

function isSecretName(name: string): boolean {
  const compact = name.toLowerCase().replace(/[_.-]/g, "");
  if (/password|passwd|passphrase|secret|token|apikey|accesskey|privatekey|credential/.test(compact)) return true;
  const segments = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[_.-]+/);
  return segments.some((segment) => segment === "pass" || segment === "pwd" || segment === "pw");
}

interface Pattern { kind: RedactionKind; regex: RegExp; replace?: (match: string, ...groups: string[]) => string | undefined }

/** Order matters: multi-line blocks first, assignments last so they do not split earlier matches. */
const PATTERNS: readonly Pattern[] = [
  { kind: "private_key", regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g },
  { kind: "url_credentials", regex: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s/]*@/gi, replace: (_match, scheme) => `${scheme}${marker("url_credentials")}@` },
  { kind: "github_token", regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})/g },
  { kind: "api_key", regex: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { kind: "aws_access_key", regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: "slack_token", regex: /\bxox[abposre]-[A-Za-z0-9-]{3,}/g },
  { kind: "jwt", regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    kind: "assignment",
    // A quoted value runs to its closing quote (or the end of the line when unterminated), so a
    // multi-word passphrase is removed whole; a bare value stops at whitespace.
    regex: /(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_.-]{0,63})(["']?)([ \t]*[:=][ \t]*)(?:(["'])([^\n]*?)(\4|(?=\n)|$)|([^\s"'`<>,;]{4,}))/g,
    replace: (_match, name, q1, separator, quote, quoted, closing, bare) => {
      const value = quote ? quoted! : bare!;
      if (!isSecretName(name!) || value.trim() === "" || /^(?:\[REDACTED:[a-z_]+\])+$/.test(value) || /^\d+$/.test(value) || /^(?:true|false|null|undefined)$/i.test(value)) return undefined;
      return `${name}${q1}${separator}${quote ?? ""}${marker("assignment")}${quote ? closing : ""}`;
    },
  },
];

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

/** An object without a prototype, so that a `__proto__` key stays an ordinary key. */
const emptyObject = (): JsonObject => Object.create(null) as JsonObject;

/**
 * `key`, or `key#2`, `key#3` and so on when an earlier key of `target` already took it. `next` holds
 * the next suffix to try for each key of `target`, so that n keys that redact to the same text skip
 * each taken key once instead of searching from `#2` every time.
 */
function freeKey(target: JsonObject, key: string, next: Map<string, number>): string {
  if (!Object.hasOwn(target, key)) return key;
  let suffix = next.get(key) ?? 2;
  while (Object.hasOwn(target, `${key}#${suffix}`)) suffix += 1;
  next.set(key, suffix + 1);
  return `${key}#${suffix}`;
}

function omitted(kind: string, value: string): Json { return { omitted: kind, bytes: value.length }; }

function replaceOpaque(value: Json): Json {
  if (Array.isArray(value)) return value.map(replaceOpaque);
  if (!isObject(value)) return value;
  const result = emptyObject();
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && SIGNATURE_KEYS.has(key)) result[key] = omitted("signature", child);
    else if (typeof child === "string" && key === "data" && value.type === "image") result[key] = omitted("image", child);
    else result[key] = replaceOpaque(child);
  }
  return result;
}

export class Redactor {
  private readonly knownValues: readonly string[];
  private readonly pathRule: PathRule;
  private readonly secretValues: () => readonly string[];

  constructor(options: { knownValues: readonly string[]; pathRule: PathRule; secretValues?: () => readonly string[] }) {
    this.secretValues = options.secretValues ?? (() => []);
    this.knownValues = options.knownValues.filter((value) => value.length >= MIN_KNOWN_VALUE_LENGTH);
    this.pathRule = options.pathRule;
  }

  /**
   * Redacts one Pi session entry. Assistant tool calls are added to `toolCalls`, so a later tool
   * result knows its tool and path. Never throws on odd input; unserializable input becomes a marker.
   */
  entry(entry: unknown, toolCalls: ToolCallIndex): RedactedEntry {
    const counts: Partial<Record<RedactionKind, number>> = {};
    let value: Json;
    try {
      value = JSON.parse(JSON.stringify(entry ?? null)) as Json;
    } catch {
      return { json: JSON.stringify({ omitted: "unserializable" }), redactions: counts, droppedByPath: false, truncated: false };
    }
    const result: RedactedEntry = { json: "", redactions: counts, droppedByPath: false, truncated: false };
    value = replaceOpaque(value);
    const message = isObject(value) && value.type === "message" && isObject(value.message) ? value.message : undefined;
    if (message !== undefined && typeof message.role === "string") {
      result.role = message.role;
      if (message.role === "assistant") result.droppedByPath = this.assistant(message, toolCalls);
      if (message.role === "toolResult") {
        if (typeof message.toolName === "string") result.toolName = message.toolName;
        result.isError = message.isError === true;
        result.droppedByPath = this.toolResult(message, toolCalls);
      }
    }
    value = this.walk(value, counts);
    const capped = capEntry(value);
    result.json = capped.json;
    result.truncated = capped.truncated;
    return result;
  }

  /** True when redaction would leave `value` unchanged; used for metadata stored outside the entry JSON. */
  isClean(value: string): boolean { return this.text(value, {}) === value; }

  private assistant(message: JsonObject, toolCalls: ToolCallIndex): boolean {
    if (!Array.isArray(message.content)) return false;
    let dropped = false;
    for (const block of message.content) {
      if (!isObject(block) || block.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") continue;
      const args = isObject(block.arguments) ? block.arguments : {};
      const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : undefined;
      toolCalls.set(block.id, path === undefined ? { name: block.name } : { name: block.name, path });
      if (path !== undefined && PATH_ARGUMENT_TOOLS.has(block.name) && this.pathRule(path)) {
        block.arguments = { path, omitted: PATH_RULE_MARKER };
        dropped = true;
      }
    }
    return dropped;
  }

  private toolResult(message: JsonObject, toolCalls: ToolCallIndex): boolean {
    const call = typeof message.toolCallId === "string" ? toolCalls.get(message.toolCallId) : undefined;
    const name = call?.name ?? (typeof message.toolName === "string" ? message.toolName : "");
    if (PATH_RESULT_TOOLS.has(name) && call?.path !== undefined && this.pathRule(call.path)) {
      message.content = [{ type: "text", text: PATH_RULE_MARKER }];
      delete message.details;
      return true;
    }
    if (name !== "grep" || !Array.isArray(message.content)) return false;
    // Pi prints grep paths relative to the search root (the basename for a single file), so a
    // protected root drops the whole result and printed paths are also tested joined onto the root.
    const root = call?.path;
    if (root !== undefined && this.pathRule(root)) {
      message.content = [{ type: "text", text: PATH_RULE_MARKER }];
      delete message.details;
      return true;
    }
    const budget = { left: GREP_CHECK_BUDGET };
    let dropped = false;
    for (const block of message.content) {
      if (!isObject(block) || block.type !== "text" || typeof block.text !== "string") continue;
      const filtered = filterGrepText(block.text, root, this.pathRule, budget);
      block.text = filtered.text;
      dropped ||= filtered.dropped;
    }
    // Pi's details can repeat the output (a truncation record holds the printed text).
    if (dropped) delete message.details;
    return dropped;
  }

  private walk(value: Json, counts: Partial<Record<RedactionKind, number>>): Json {
    if (typeof value === "string") return this.text(value, counts);
    if (Array.isArray(value)) return value.map((child) => this.walk(child, counts));
    if (!isObject(value)) return value;
    // A key is content like a value: a recognized secret in it is replaced too. Keys that redact to
    // the same text get a numbered suffix, so no value overwrites another.
    const result = emptyObject();
    const next = new Map<string, number>();
    for (const [key, child] of Object.entries(value)) result[freeKey(result, this.text(key, counts), next)] = this.walk(child, counts);
    return result;
  }

  private text(input: string, counts: Partial<Record<RedactionKind, number>>): string {
    let text = input;
    for (const known of [...new Set([...this.knownValues, ...this.secretValues().filter(value => value.length > 0)])].sort((a, b) => b.length - a.length)) {
      if (!text.includes(known)) continue;
      const parts = text.split(known);
      counts.known_value = (counts.known_value ?? 0) + parts.length - 1;
      text = parts.join(marker("known_value"));
    }
    for (const pattern of PATTERNS) {
      text = text.replace(pattern.regex, (match: string, ...rest: unknown[]) => {
        const groups = rest.slice(0, -2).map((group) => (typeof group === "string" ? group : ""));
        const replacement = pattern.replace === undefined ? marker(pattern.kind) : pattern.replace(match, ...groups);
        if (replacement === undefined) return match;
        counts[pattern.kind] = (counts[pattern.kind] ?? 0) + 1;
        return replacement;
      });
    }
    return text;
  }
}

interface StringSlot { parent: JsonObject | Json[]; key: string | number; value: string }

function largestString(holder: JsonObject): StringSlot | undefined {
  let best: StringSlot | undefined;
  const visit = (parent: JsonObject | Json[], key: string | number, child: Json): void => {
    if (typeof child === "string") {
      if (best === undefined || child.length > best.value.length) best = { parent, key, value: child };
      return;
    }
    if (Array.isArray(child)) child.forEach((item, index) => visit(child, index, item));
    else if (isObject(child)) for (const [name, item] of Object.entries(child)) visit(child, name, item);
  };
  visit(holder, "root", holder.root ?? null);
  return best;
}

/**
 * Cuts the largest strings of `value` (in place) until its JSON fits `limit` bytes. Size is never a
 * gap (design call 14): what cannot be cut down keeps only its entry envelope and an `omitted` marker.
 */
export function capJson(value: Json, limit: number): { json: string; truncated: boolean } {
  let json = JSON.stringify(value);
  const originalBytes = Buffer.byteLength(json);
  if (originalBytes <= limit) return { json, truncated: false };
  const envelope = envelopeOf(value);
  const holder = { root: value } as JsonObject;
  const originals = new Map<StringSlot["parent"], Map<string | number, number>>();
  for (let attempt = 0; attempt < 16 && Buffer.byteLength(json) > limit; attempt += 1) {
    const slot = largestString(holder);
    if (slot === undefined) break;
    const known = originals.get(slot.parent) ?? new Map<string | number, number>();
    originals.set(slot.parent, known);
    const original = known.get(slot.key) ?? Buffer.byteLength(slot.value);
    known.set(slot.key, original);
    const note = ` [TRUNCATED:${original}]`;
    const base = slot.value.endsWith(note) ? slot.value.slice(0, -note.length) : slot.value;
    const escaped = Buffer.byteLength(JSON.stringify(base));
    const excess = Buffer.byteLength(json) - limit + Buffer.byteLength(note) + 16;
    const target = Math.max(0, escaped - excess);
    let keep = Math.floor((base.length * target) / Math.max(1, escaped));
    if (keep > 0 && /[\uD800-\uDBFF]/.test(base[keep - 1]!)) keep -= 1;
    const cut = base.slice(0, keep) + note;
    (slot.parent as Record<string | number, Json>)[slot.key] = cut;
    json = JSON.stringify(holder.root);
  }
  if (Buffer.byteLength(json) > limit) json = JSON.stringify({ ...envelope, omitted: "oversized", bytes: originalBytes });
  return { json, truncated: true };
}

/** The identifying fields of a Pi entry, copied only when they are short scalars. */
function envelopeOf(value: Json): Record<string, Json> {
  const out: Record<string, Json> = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
  for (const key of ["type", "id", "parentId", "timestamp"]) {
    const field = (value as JsonObject)[key];
    if (field === null || (typeof field === "string" && field.length <= 256)) out[key] = field;
  }
  return out;
}

function capEntry(value: Json): { json: string; truncated: boolean } { return capJson(value, HISTORY_ENTRY_CAP_BYTES); }

import { closeSync, existsSync, openSync, writeSync } from "node:fs";
import { VERDICT_REASON_MAX, VERDICTS, type Verdict } from "./constants.js";
import { exportJsonl, type ExportSession } from "./export.js";
import { defaultIsAlive, reconcileInstances } from "./reconcile.js";
import { historyLocation, HistoryStoreError, openHistoryStore, type HistoryStore } from "./store.js";
import { printable, renderTimeline, type StoredEntry, type StoredGap, type StoredTurn } from "./timeline.js";

export interface HistoryCliIo { stdout: (text: string) => void; stderr: (text: string) => void; home?: string; now?: () => Date }
export type HistoryCliExit = 0 | 1 | 64;

const USAGE = `Usage: pi-session-mcp-history <command> [options]

Commands:
  list [--workspace A] [--profile P] [--task T] [--since YYYY-MM-DD] [--verdict V]
  show <session> [--full]
  export <session> --format jsonl [--out FILE]
  verdict <session> accepted|rejected|reworked --reason "<one sentence>"
  prune --older-than <days>d [--apply]
  reconcile
  query "<SELECT ...>" [--json]

<session> is a session id, a history id, or a unique prefix of at least 8 characters.
The history lives in ~/.local/state/pi-session-mcp/history/ and is recorded only when
"history": { "enabled": true } is set in the configuration.
`;
const MISSING = "No session history in ~/.local/state/pi-session-mcp/history/. Set \"history\": { \"enabled\": true } in the pi-session-mcp configuration to record sessions.\n";

class UsageError extends Error {}
class CliError extends Error {}

interface Parsed { positionals: string[]; values: Map<string, string>; switches: Set<string> }
/** Strict flag parsing: unknown flags, missing values and wrong positional counts are usage errors. */
function parse(argv: readonly string[], valueFlags: readonly string[], switchFlags: readonly string[], positionals: number): Parsed {
  const parsed: Parsed = { positionals: [], values: new Map(), switches: new Set() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (valueFlags.includes(name)) {
        const value = argv[index + 1];
        if (value === undefined || parsed.values.has(name)) throw new UsageError();
        parsed.values.set(name, value);
        index += 1;
      } else if (switchFlags.includes(name)) parsed.switches.add(name);
      else throw new UsageError();
    } else parsed.positionals.push(arg);
  }
  if (parsed.positionals.length !== positionals) throw new UsageError();
  return parsed;
}

type Row = Record<string, unknown>;
interface SessionRow extends ExportSession { readonly id: string; readonly public_session_id: string; readonly execution_profile: string }

function resolveSession(store: HistoryStore, reference: string): SessionRow {
  const exact = store.db.prepare("SELECT * FROM sessions WHERE public_session_id = ? OR id = ? ORDER BY created_at DESC LIMIT 2").all(reference, reference) as unknown as SessionRow[];
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) throw new CliError("Session reference is ambiguous");
  if (/^[0-9a-f-]{8,}$/i.test(reference)) {
    const prefix = `${reference.toLowerCase()}%`;
    const matches = store.db.prepare("SELECT * FROM sessions WHERE lower(public_session_id) LIKE ? OR lower(id) LIKE ? LIMIT 2").all(prefix, prefix) as unknown as SessionRow[];
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw new CliError("Session reference is ambiguous");
  }
  throw new CliError("Unknown session");
}

/**
 * Accepts exactly one statement that starts with SELECT or WITH. Comments and string literals are
 * skipped; a `;` followed by anything but whitespace or comments is a second statement. The
 * connection is read-only as well, so a WITH … DELETE fails there.
 */
export function readOnlyStatement(sql: string): boolean {
  let code = "";
  let ended = false;
  for (let index = 0; index < sql.length;) {
    const char = sql[index]!;
    if (char === "-" && sql[index + 1] === "-") { const end = sql.indexOf("\n", index); index = end === -1 ? sql.length : end + 1; code += " "; continue; }
    if (char === "/" && sql[index + 1] === "*") { const end = sql.indexOf("*/", index + 2); if (end === -1) return false; index = end + 2; code += " "; continue; }
    if (char === "'" || char === "\"" || char === "`" || char === "[") {
      const close = char === "[" ? "]" : char;
      let end = index + 1;
      for (; end < sql.length; end += 1) {
        if (sql[end] === close) { if (close !== "]" && sql[end + 1] === close) { end += 1; continue; } break; }
      }
      if (end >= sql.length) return false;
      if (ended) return false;
      code += "x";
      index = end + 1;
      continue;
    }
    if (char === ";") { ended = true; index += 1; continue; }
    if (ended && !/\s/.test(char)) return false;
    code += char;
    index += 1;
  }
  return /^\s*(select|with)\b/i.test(code);
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Uint8Array) return `<blob ${value.byteLength} bytes>`;
  return printable(String(value)).replace(/\t/g, " ");
}
const jsonReplacer = (_key: string, value: unknown): unknown => value instanceof Uint8Array ? `<blob ${value.byteLength} bytes>` : typeof value === "bigint" ? value.toString() : value;

async function open(io: HistoryCliIo, readOnly: boolean): Promise<HistoryStore> {
  if (!existsSync(historyLocation(io.home).file)) throw new CliError(MISSING.trimEnd());
  try {
    return await openHistoryStore({ ...(io.home === undefined ? {} : { home: io.home }), readOnly });
  } catch (error) {
    throw new CliError(`Session history is unavailable (${error instanceof HistoryStoreError ? error.code : "history_unavailable"})`);
  }
}

async function withStore<T>(io: HistoryCliIo, readOnly: boolean, action: (store: HistoryStore) => T | Promise<T>): Promise<T> {
  const store = await open(io, readOnly);
  try { return await action(store); } finally { store.close(); }
}

function sinceValue(raw: string): string {
  if (!/^\d{4}-\d{2}-\d{2}(T[0-9:.]+Z?)?$/.test(raw)) throw new UsageError();
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new UsageError();
  return date.toISOString();
}

async function list(argv: readonly string[], io: HistoryCliIo): Promise<void> {
  const args = parse(argv, ["workspace", "profile", "task", "since", "verdict"], [], 0);
  const where: string[] = [];
  const params: string[] = [];
  const latest = "(SELECT v.verdict FROM verdicts v WHERE v.session_id = s.id ORDER BY v.id DESC LIMIT 1)";
  const filter = (flag: string, clause: string, value = args.values.get(flag)): void => { if (value !== undefined) { where.push(clause); params.push(value); } };
  const verdict = args.values.get("verdict");
  if (verdict !== undefined && !(VERDICTS as readonly string[]).includes(verdict)) throw new UsageError();
  const since = args.values.get("since");
  filter("workspace", "s.workspace = ?");
  filter("profile", "s.execution_profile = ?");
  filter("task", "s.task = ?");
  filter("since", "s.created_at >= ?", since === undefined ? undefined : sinceValue(since));
  filter("verdict", `${latest} = ?`);
  await withStore(io, true, (store) => {
    const rows = store.db.prepare(`SELECT s.created_at, s.public_session_id, s.workspace, s.execution_profile, s.task, s.completeness,
      (SELECT count(*) FROM turns t WHERE t.session_id = s.id) AS turns, ${latest} AS verdict
      FROM sessions s ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`} ORDER BY s.created_at DESC, s.id`).all(...params) as Row[];
    const lines = ["created\tsession\tworkspace\tprofile\ttask\tturns\tcompleteness\tverdict"];
    for (const row of rows) {
      lines.push([String(row.created_at).slice(0, 16).replace("T", " "), String(row.public_session_id).slice(0, 8), row.workspace, row.execution_profile, row.task ?? "-", row.turns, row.completeness, row.verdict ?? "-"].map(cell).join("\t"));
    }
    io.stdout(`${lines.join("\n")}\n`);
  });
}

async function show(argv: readonly string[], io: HistoryCliIo): Promise<void> {
  const args = parse(argv, [], ["full"], 1);
  await withStore(io, true, (store) => {
    const session = resolveSession(store, args.positionals[0]!);
    const entries = store.db.prepare("SELECT turn_id, position, entry_type, timestamp, role, tool_name, redacted_json, dropped_by_path, truncated FROM entries WHERE session_id = ? ORDER BY position").all(session.id) as unknown as StoredEntry[];
    const gaps = store.db.prepare("SELECT id, first_turn_id, code, recorded_at FROM gaps WHERE session_id = ? ORDER BY id").all(session.id) as unknown as StoredGap[];
    const turns = store.db.prepare("SELECT turn_id, started_at, state FROM turns WHERE session_id = ? ORDER BY started_at, turn_id").all(session.id) as unknown as StoredTurn[];
    const head = `session ${session.public_session_id}  ${printable(session.workspace)}  ${printable(session.execution_profile)}  ${session.created_at}  ${session.completeness}`;
    io.stdout(`${[head, ...renderTimeline({ entries, gaps, turns, completeness: session.completeness }, args.switches.has("full"))].join("\n")}\n`);
  });
}

async function exportSession(argv: readonly string[], io: HistoryCliIo): Promise<void> {
  const args = parse(argv, ["format", "out"], [], 1);
  if (args.values.get("format") !== "jsonl") throw new UsageError();
  const out = args.values.get("out");
  await withStore(io, true, (store) => {
    const session = resolveSession(store, args.positionals[0]!);
    const entries = store.db.prepare("SELECT redacted_json, truncated FROM entries WHERE session_id = ? ORDER BY position").all(session.id) as Array<{ redacted_json: string; truncated: number }>;
    const gaps = Number((store.db.prepare("SELECT count(*) AS n FROM gaps WHERE session_id = ?").get(session.id) as { n: number }).n);
    const result = exportJsonl(session, entries, gaps);
    if (out === undefined) io.stdout(result.text);
    else {
      let descriptor: number;
      try { descriptor = openSync(out, "wx", 0o600); } catch { throw new CliError("Output file exists or cannot be created"); }
      try { writeSync(descriptor, result.text); } finally { closeSync(descriptor); }
    }
    if (result.lossy) io.stderr(`export is lossy: ${result.truncated} truncated entries, ${gaps} gaps, session ${session.completeness}\n`);
  });
}

async function verdict(argv: readonly string[], io: HistoryCliIo): Promise<void> {
  const args = parse(argv, ["reason"], [], 2);
  const [reference, value] = args.positionals as [string, string];
  const reason = args.values.get("reason");
  if (!(VERDICTS as readonly string[]).includes(value)) throw new UsageError();
  if (reason === undefined || reason.trim().length === 0 || [...reason].length > VERDICT_REASON_MAX || /[\u0000-\u001f\u007f]/.test(reason)) throw new UsageError();
  await withStore(io, false, (store) => {
    const session = resolveSession(store, reference);
    store.db.prepare("INSERT INTO verdicts (session_id, verdict, reason, recorded_at, source) VALUES (?, ?, ?, ?, 'controller')").run(session.id, value as Verdict, reason, (io.now?.() ?? new Date()).toISOString());
    io.stdout(`verdict ${value} recorded for ${session.public_session_id.slice(0, 8)}\n`);
  });
}

async function prune(argv: readonly string[], io: HistoryCliIo): Promise<void> {
  const args = parse(argv, ["older-than"], ["apply"], 0);
  const match = /^(\d{1,5})d$/.exec(args.values.get("older-than") ?? "");
  if (!match) throw new UsageError();
  const cutoff = new Date((io.now?.() ?? new Date()).getTime() - Number(match[1]) * 86_400_000).toISOString();
  const apply = args.switches.has("apply");
  await withStore(io, !apply, (store) => {
    const count = Number((store.db.prepare("SELECT count(*) AS n FROM sessions WHERE closed_at IS NOT NULL AND closed_at < ?").get(cutoff) as { n: number }).n);
    const noun = `${count} session${count === 1 ? "" : "s"}`;
    if (!apply) { io.stdout(`${noun} closed before ${cutoff.slice(0, 10)} would be deleted; rerun with --apply\n`); return; }
    store.transaction(() => { store.db.prepare("DELETE FROM sessions WHERE closed_at IS NOT NULL AND closed_at < ?").run(cutoff); });
    store.db.exec("VACUUM");
    io.stdout(`${noun} deleted\n`);
  });
}

async function reconcile(argv: readonly string[], io: HistoryCliIo): Promise<void> {
  parse(argv, [], [], 0);
  await withStore(io, false, (store) => {
    const count = reconcileInstances(store, defaultIsAlive);
    io.stdout(`${count} session${count === 1 ? "" : "s"} marked incomplete\n`);
  });
}

async function query(argv: readonly string[], io: HistoryCliIo): Promise<void> {
  const args = parse(argv, [], ["json"], 1);
  const sql = args.positionals[0]!;
  if (!readOnlyStatement(sql)) throw new CliError("Only a single SELECT or WITH statement is allowed");
  await withStore(io, true, (store) => {
    let rows: Row[];
    let columns: string[];
    try {
      store.db.exec("PRAGMA query_only = ON");
      const statement = store.db.prepare(sql);
      rows = statement.all() as Row[];
      columns = typeof statement.columns === "function" ? statement.columns().map((column) => column.name) : Object.keys(rows[0] ?? {});
    } catch {
      throw new CliError("Query refused or failed");
    }
    if (args.switches.has("json")) { io.stdout(rows.map((row) => `${JSON.stringify(row, jsonReplacer)}\n`).join("")); return; }
    io.stdout(`${[columns.map(cell).join("\t"), ...rows.map((row) => columns.map((column) => cell(row[column])).join("\t"))].join("\n")}\n`);
  });
}

const COMMANDS: Record<string, (argv: readonly string[], io: HistoryCliIo) => Promise<void>> = { list, show, export: exportSession, verdict, prune, reconcile, query };

/** `pi-session-mcp-history`: 0 success, 1 runtime error, 64 usage error. Never prints a stack trace. */
export async function runHistoryCli(argv: readonly string[], io: HistoryCliIo): Promise<HistoryCliExit> {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h" || command === "help") { io.stdout(USAGE); return 0; }
  const run = command === undefined ? undefined : COMMANDS[command];
  if (run === undefined) { io.stderr(USAGE); return 64; }
  try {
    await run(rest, io);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) { io.stderr(USAGE); return 64; }
    io.stderr(`${error instanceof CliError ? error.message : "History command failed"}\n`);
    return 1;
  }
}

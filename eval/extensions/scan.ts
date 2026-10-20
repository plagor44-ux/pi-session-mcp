import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { hash } from "../profiles/files.js";

export interface Candidate {
  /** File name of the transcript, never a path. */
  transcript: string;
  /** The MCP server the session ran on (always starts with `pi-`). */
  server: string;
  /** The pi session id from the start result. */
  sessionId: string;
  workspace: string;
  executionProfile: string;
  /** The transcript timestamp of the first `pi_session_prompt` call. */
  firstPromptAt: string;
  /** Hash of the first prompt; the prompt text itself is never returned. */
  firstPromptHash: string;
  /** Further `pi_session_prompt` calls for the same session. */
  followUps: number;
  firstTerminal: "completed" | "failed" | "aborted" | "unknown";
}

export interface ScanResult { candidates: Candidate[]; skippedLines: number }

type Kind = "start" | "prompt" | "turn_get";
interface Use { kind: Kind; server: string; input: Record<string, unknown>; timestamp: string }
type Body = Record<string, unknown>;

const TOOL = /^mcp__(pi-.+?)__pi_(session_start|session_prompt|turn_get)$/;
const KINDS: Record<string, Kind> = { session_start: "start", session_prompt: "prompt", turn_get: "turn_get" };
const TERMINAL = new Set(["completed", "failed", "aborted"]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

function parseBody(value: unknown): Body | null {
  if (isRecord(value)) return typeof value.ok === "boolean" ? value : null;
  return null;
}

/** The tool result's structured content: the structured field when the transcript has one, else the JSON text of the result. */
function resultBody(block: Record<string, unknown>, toolUseResult: unknown): Body | null {
  if (block.is_error === true) return null;
  if (isRecord(toolUseResult)) {
    const direct = parseBody(toolUseResult) ?? parseBody(toolUseResult.structuredContent);
    if (direct) return direct;
  }
  let raw = block.content;
  if (Array.isArray(raw)) raw = raw.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("");
  if (typeof raw !== "string") return null;
  try { return parseBody(JSON.parse(raw)); } catch { return null; }
}

interface Session {
  server: string; id: string; workspace: string; executionProfile: string;
  first?: { at: string; hash: string; turnId: string | undefined; terminal: Candidate["firstTerminal"] | "pending" };
  followUps: number;
}

/** Candidates of one transcript, in the order their sessions were started. */
function candidatesOf(transcript: string, uses: Map<string, Use>, results: Map<string, Body | null>): Candidate[] {
  const sessions = new Map<string, Session>();
  const terminalTurns = new Map<string, string>();
  for (const [id, use] of uses) {
    const body = results.get(id) ?? null;
    if (use.kind === "start") {
      const session = body?.ok === true && isRecord(body.session) ? body.session : undefined;
      const sessionId = text(session?.id);
      if (!session || sessionId === undefined || sessions.has(`${use.server}\0${sessionId}`)) continue;
      sessions.set(`${use.server}\0${sessionId}`, {
        server: use.server, id: sessionId, followUps: 0,
        workspace: text(session.workspace) ?? text(use.input.workspace) ?? "",
        executionProfile: text(session.executionProfile) ?? text(use.input.executionProfile) ?? "",
      });
    } else if (use.kind === "prompt") {
      const sessionId = text(use.input.sessionId);
      const session = sessionId === undefined ? undefined : sessions.get(`${use.server}\0${sessionId}`);
      const prompt = text(use.input.prompt);
      if (!session || prompt === undefined) continue;
      if (session.first) { session.followUps += 1; continue; }
      const turn = body?.ok === true && isRecord(body.turn) ? body.turn : undefined;
      const state = text(turn?.state);
      session.first = {
        at: use.timestamp, hash: hash(prompt), turnId: text(turn?.turnId),
        terminal: state !== undefined && TERMINAL.has(state) ? state as Candidate["firstTerminal"] : turn === undefined ? "unknown" : "pending",
      };
    } else if (body?.ok === true && isRecord(body.turn)) {
      const sessionId = text(use.input.sessionId), turnId = text(body.turn.turnId) ?? text(use.input.turnId), state = text(body.turn.state);
      const key = `${use.server}\0${sessionId}\0${turnId}`;
      if (sessionId !== undefined && turnId !== undefined && state !== undefined && TERMINAL.has(state) && !terminalTurns.has(key)) terminalTurns.set(key, state);
    }
  }
  const found: Candidate[] = [];
  for (const session of sessions.values()) {
    const first = session.first;
    if (!first) continue;
    let firstTerminal: Candidate["firstTerminal"] = "unknown";
    if (first.terminal !== "pending") firstTerminal = first.terminal;
    else if (first.turnId !== undefined) firstTerminal = (terminalTurns.get(`${session.server}\0${session.id}\0${first.turnId}`) ?? "unknown") as Candidate["firstTerminal"];
    found.push({
      transcript, server: session.server, sessionId: session.id, workspace: session.workspace, executionProfile: session.executionProfile,
      firstPromptAt: first.at, firstPromptHash: first.hash, followUps: session.followUps, firstTerminal,
    });
  }
  return found;
}

/**
 * Reads the Claude Code JSONL transcripts directly in `dir` (not recursively) and pairs the `tool_use` blocks of
 * `mcp__pi-*__pi_session_start`, `…pi_session_prompt` and `…pi_turn_get` with their `tool_result` by `tool_use_id`. Lines that do not
 * parse are skipped and counted. A session is a candidate once it was started and prompted; the prompt text is hashed and dropped.
 */
export async function scanTranscripts(dir: string): Promise<ScanResult> {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).sort();
  const candidates: Candidate[] = [];
  let skippedLines = 0;
  for (const name of names) {
    const uses = new Map<string, Use>();
    const results = new Map<string, Body | null>();
    for (const line of (await readFile(join(dir, name), "utf8")).split("\n")) {
      if (line.trim() === "") continue;
      let entry: unknown;
      try { entry = JSON.parse(line); } catch { skippedLines += 1; continue; }
      if (!isRecord(entry)) { skippedLines += 1; continue; }
      const content = isRecord(entry.message) ? entry.message.content : undefined;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!isRecord(block)) continue;
        if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
          const match = TOOL.exec(block.name);
          if (!match) continue;
          uses.set(block.id, { kind: KINDS[match[2]!]!, server: match[1]!, input: isRecord(block.input) ? block.input : {}, timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "" });
        } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          results.set(block.tool_use_id, resultBody(block, entry.toolUseResult));
        }
      }
    }
    candidates.push(...candidatesOf(name, uses, results));
  }
  return { candidates, skippedLines };
}

/**
 * Writes the candidates to `out`, which must lie below `resultsRoot` (the ignored `eval/results/`, because the candidates are private,
 * even when a link inside it points elsewhere) and must not exist yet.
 */
export async function writeScan(result: ScanResult, out: string, resultsRoot: string): Promise<void> {
  const target = resolve(out);
  const root = resolve(resultsRoot);
  if (!target.startsWith(root + sep)) throw new Error("scan_out_outside_results");
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const realRoot = await realpath(root);
  const realParent = await realpath(dirname(target));
  if (realParent !== realRoot && !realParent.startsWith(realRoot + sep)) throw new Error("scan_out_outside_results");
  try {
    await writeFile(target, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    throw (error as NodeJS.ErrnoException).code === "EEXIST" ? new Error("output_exists") : error;
  }
}

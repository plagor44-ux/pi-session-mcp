// Evaluation prototype: every field here is local. None exists in the public Pi Session MCP contract.
export const SCHEMA_VERSION = 1;
const WORK = ["pending", "running", "blocked", "awaiting_review", "accepted", "rejected"] as const;
const RUNTIME = ["running", "awaiting_input", "completed", "failed", "aborted", "abort_unconfirmed", "unresolved"] as const;
const CLEANUP = ["open", "closed", "close_failed", "unknown"] as const;
const SOURCE = ["controller", "bridge", "hook", "worker"] as const;
const END = ["closed", "eof", "server_exit", "lost"] as const;
const TERMINAL = ["completed", "failed", "aborted"] as const;
const VIA = ["bridge", "poll", "close"] as const;
const TURN_KIND = ["initial", "follow_up"] as const;
const RECIPIENT = ["controller", "human"] as const;
const Q_KIND = ["input", "select", "confirm"] as const;
const Q_STATE = ["open", "answered", "expired", "cancelled", "refused"] as const;
const Q_RESOLVED = ["answered", "expired", "cancelled", "refused"] as const;
const CLOSE = ["closed", "close_failed"] as const;
const OUTCOME = ["accepted", "rejected"] as const;
export type WorkStatus = (typeof WORK)[number];
export type RuntimeStatus = (typeof RUNTIME)[number];
export type CleanupStatus = (typeof CLEANUP)[number];
export type EventSource = (typeof SOURCE)[number];
export type EndReason = (typeof END)[number];
export type TerminalRuntime = (typeof TERMINAL)[number];
export type TerminalVia = (typeof VIA)[number];
export type TurnKind = (typeof TURN_KIND)[number];
export type QuestionRecipient = (typeof RECIPIENT)[number];
export type QuestionKind = (typeof Q_KIND)[number];
export type QuestionState = (typeof Q_STATE)[number];
export type QuestionResolution = (typeof Q_RESOLVED)[number];
export type DecisionOutcome = (typeof OUTCOME)[number];

export interface LedgerInstance { instanceId: string; connectedAt: string; endedAt?: string; endReason?: EndReason }
export interface LedgerResult { consumedAt: string; textSha256: `sha256:${string}`; textBytes: number; truncated: boolean }
export interface LedgerTurn {
  turnId: string; kind: TurnKind; runtime: RuntimeStatus; startedAt: string; observedAt: string;
  lastActivityAt?: string; terminalAt?: string; terminalVia?: TerminalVia; result?: LedgerResult;
}
export interface LedgerAttempt {
  attemptId: string; instanceId: string; sessionId: string; workspaceAlias: string; profileAlias: string;
  startedAt: string; deadlineAt: string; turns: LedgerTurn[]; cleanup: CleanupStatus;
}
export interface LedgerTask {
  taskId: string; label: string; baseCommit: string; dependsOn: string[]; changeScope: string[]; work: WorkStatus;
  attempts: LedgerAttempt[]; decision?: { outcome: DecisionOutcome; at: string; evidence: string[] };
}
export interface LedgerQuestion {
  requestId: string; instanceId: string; sessionId: string; turnId: string; attemptId: string;
  recipient: QuestionRecipient; kind: QuestionKind; openedAt: string; deadlineAt: string; state: QuestionState; resolvedAt?: string;
}
export interface RunLedger {
  schemaVersion: 1; local: true; runId: string; revision: number; createdAt: string; updatedAt: string; controllerLabel: string;
  instances: LedgerInstance[]; tasks: LedgerTask[]; questions: LedgerQuestion[]; appliedEventIds: string[];
}

type Base = { eventId: string; at: string; source: EventSource };
type Ev<T extends string, P> = Base & { type: T } & P;
export type LedgerEvent =
  | Ev<"task_declared", { taskId: string; label: string; baseCommit: string; dependsOn: string[]; changeScope: string[] }>
  | Ev<"instance_connected", { instanceId: string }>
  | Ev<"instance_ended", { instanceId: string; reason: EndReason }>
  | Ev<"attempt_started", { taskId: string; attemptId: string; instanceId: string; sessionId: string; workspaceAlias: string; profileAlias: string; deadlineAt: string }>
  | Ev<"turn_started", { sessionId: string; turnId: string; kind: TurnKind }>
  | Ev<"turn_observed", { sessionId: string; turnId: string; activityAt?: string }>
  | Ev<"turn_terminal", { sessionId: string; turnId: string; runtime: TerminalRuntime; via: TerminalVia; terminalAt: string }>
  | Ev<"abort_unconfirmed", { sessionId: string; turnId: string }>
  | Ev<"result_consumed", { sessionId: string; turnId: string; textSha256: `sha256:${string}`; textBytes: number; truncated: boolean }>
  | Ev<"question_opened", { requestId: string; sessionId: string; turnId: string; recipient: QuestionRecipient; kind: QuestionKind; deadlineAt: string }>
  | Ev<"question_resolved", { requestId: string; state: QuestionResolution }>
  | Ev<"session_closed", { sessionId: string; outcome: (typeof CLOSE)[number] }>
  | Ev<"decision", { taskId: string; outcome: DecisionOutcome; evidence: string[] }>;
export type LedgerEventType = LedgerEvent["type"];

export type Outcome = "applied" | "duplicate" | "ignored_stale" | "rejected";
export interface EventOutcome { eventId: string; outcome: Outcome; code?: string }
export interface ApplyResult { ledger: RunLedger; outcome: Outcome; code?: string }
export interface ApplyManyResult { ledger: RunLedger; outcomes: EventOutcome[] }
export type ValidateResult = { ok: true } | { ok: false; code: string; path: string };

// Key allowlists. A key ending in "?" is optional; any other key must be present.
type Kind = "id" | "label" | "iso" | "commit" | "hash" | "int" | "bool" | "path" | "text"
  | { lit: number | boolean } | { enum: readonly string[] } | { arr: Kind; max: number } | { obj: Shape };
interface Shape { [key: string]: Kind }
const ids = (max: number): Kind => ({ arr: "id", max });
const TURN: Shape = {
  turnId: "id", kind: { enum: TURN_KIND }, runtime: { enum: RUNTIME }, startedAt: "iso", observedAt: "iso", "lastActivityAt?": "iso",
  "terminalAt?": "iso", "terminalVia?": { enum: VIA }, "result?": { obj: { consumedAt: "iso", textSha256: "hash", textBytes: "int", truncated: "bool" } },
};
const ATTEMPT: Shape = {
  attemptId: "id", instanceId: "id", sessionId: "id", workspaceAlias: "label", profileAlias: "label", startedAt: "iso", deadlineAt: "iso",
  turns: { arr: { obj: TURN }, max: 1000 }, cleanup: { enum: CLEANUP },
};
const TASK: Shape = {
  taskId: "id", label: "label", baseCommit: "commit", dependsOn: ids(50), changeScope: { arr: "path", max: 100 }, work: { enum: WORK },
  attempts: { arr: { obj: ATTEMPT }, max: 100 },
  "decision?": { obj: { outcome: { enum: OUTCOME }, at: "iso", evidence: { arr: "text", max: 20 } } },
};
const QUESTION: Shape = {
  requestId: "id", instanceId: "id", sessionId: "id", turnId: "id", attemptId: "id", recipient: { enum: RECIPIENT }, kind: { enum: Q_KIND },
  openedAt: "iso", deadlineAt: "iso", state: { enum: Q_STATE }, "resolvedAt?": "iso",
};
const LEDGER: Shape = {
  schemaVersion: { lit: SCHEMA_VERSION }, local: { lit: true }, runId: "id", revision: "int", createdAt: "iso", updatedAt: "iso", controllerLabel: "label",
  instances: { arr: { obj: { instanceId: "id", connectedAt: "iso", "endedAt?": "iso", "endReason?": { enum: END } } }, max: 1000 },
  tasks: { arr: { obj: TASK }, max: 1000 }, questions: { arr: { obj: QUESTION }, max: 10000 }, appliedEventIds: ids(1000),
};
const EVENTS: Record<LedgerEventType, Shape> = {
  task_declared: { taskId: "id", label: "label", baseCommit: "commit", dependsOn: ids(50), changeScope: { arr: "path", max: 100 } },
  instance_connected: { instanceId: "id" },
  instance_ended: { instanceId: "id", reason: { enum: END } },
  attempt_started: { taskId: "id", attemptId: "id", instanceId: "id", sessionId: "id", workspaceAlias: "label", profileAlias: "label", deadlineAt: "iso" },
  turn_started: { sessionId: "id", turnId: "id", kind: { enum: TURN_KIND } },
  turn_observed: { sessionId: "id", turnId: "id", "activityAt?": "iso" },
  turn_terminal: { sessionId: "id", turnId: "id", runtime: { enum: TERMINAL }, via: { enum: VIA }, terminalAt: "iso" },
  abort_unconfirmed: { sessionId: "id", turnId: "id" },
  result_consumed: { sessionId: "id", turnId: "id", textSha256: "hash", textBytes: "int", truncated: "bool" },
  question_opened: { requestId: "id", sessionId: "id", turnId: "id", recipient: { enum: RECIPIENT }, kind: { enum: Q_KIND }, deadlineAt: "iso" },
  question_resolved: { requestId: "id", state: { enum: Q_RESOLVED } },
  session_closed: { sessionId: "id", outcome: { enum: CLOSE } },
  decision: { taskId: "id", outcome: { enum: OUTCOME }, evidence: { arr: "text", max: 20 } },
};

const PATTERN: Record<string, RegExp> = {
  id: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/,
  label: /^[A-Za-z0-9][A-Za-z0-9 ._:@+-]{0,99}$/,
  commit: /^[0-9a-f]{7,64}$/,
  hash: /^sha256:[0-9a-f]{64}$/,
  path: /^[A-Za-z0-9._@+*-][A-Za-z0-9._@+*/-]{0,199}$/,
  iso: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/,
};
type Bad = { code: string; path: string };
const bad = (code: string, path: string): Bad => ({ code, path });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function checkString(s: string, path: string): Bad | undefined {
  if (s.length > 200) return bad("string_too_long", path);
  if (/[\r\n]/.test(s) || s.includes(String.fromCharCode(0x2028)) || s.includes(String.fromCharCode(0x2029))) return bad("line_break", path);
  if (/[\u0000-\u001f\u007f]/.test(s)) return bad("control_character", path);
  if (/^[/\\~]/.test(s) || /^[A-Za-z]:[\\/]/.test(s)) return bad("absolute_path", path);
  if (s.split(/[\\/]/).includes("..")) return bad("dotdot_segment", path);
  return undefined;
}
function checkValue(kind: Kind, v: unknown, path: string): Bad | undefined {
  if (typeof kind === "string") {
    if (kind === "int") return Number.isSafeInteger(v) && (v as number) >= 0 ? undefined : bad("bad_value", path);
    if (kind === "bool") return typeof v === "boolean" ? undefined : bad("bad_type", path);
    if (typeof v !== "string") return bad("bad_type", path);
    const s = checkString(v, path);
    if (s) return s;
    if (kind === "text") return undefined;
    if (!PATTERN[kind]!.test(v) || (kind === "iso" && Number.isNaN(Date.parse(v)))) return bad("bad_pattern", path);
    return undefined;
  }
  if ("lit" in kind) return v === kind.lit ? undefined : bad("bad_value", path);
  if ("enum" in kind) {
    if (typeof v !== "string") return bad("bad_type", path);
    return kind.enum.includes(v) ? undefined : bad("bad_enum", path);
  }
  if ("arr" in kind) {
    if (!Array.isArray(v)) return bad("bad_type", path);
    if (v.length > kind.max) return bad("too_many", path);
    for (let i = 0; i < v.length; i++) { const r = checkValue(kind.arr, v[i], `${path}[${i}]`); if (r) return r; }
    return undefined;
  }
  return checkShape(kind.obj, v, path);
}
function checkShape(shape: Shape, v: unknown, path: string): Bad | undefined {
  if (!isObject(v)) return bad("bad_type", path);
  const allowed = new Map<string, { kind: Kind; optional: boolean }>();
  for (const [k, kind] of Object.entries(shape)) allowed.set(k.replace(/\?$/, ""), { kind, optional: k.endsWith("?") });
  for (const key of Object.keys(v)) if (!allowed.has(key)) return bad("unknown_key", path ? `${path}.${key}` : key);
  for (const [key, { kind, optional }] of allowed) {
    const p = path ? `${path}.${key}` : key;
    if (!Object.hasOwn(v, key)) { if (!optional) return bad("missing_key", p); continue; }
    const r = checkValue(kind, v[key], p);
    if (r) return r;
  }
  return undefined;
}

export function validateLedger(value: unknown): ValidateResult {
  const r = checkShape(LEDGER, value, "");
  return r ? { ok: false, ...r } : { ok: true };
}
export function validateEvent(value: unknown): ValidateResult {
  if (!isObject(value) || typeof value.type !== "string" || !Object.hasOwn(EVENTS, value.type)) return { ok: false, code: "invalid_event", path: "type" };
  const shape: Shape = { eventId: "id", at: "iso", source: { enum: SOURCE }, type: { enum: [value.type] }, ...EVENTS[value.type as LedgerEventType] };
  const r = checkShape(shape, value, "");
  return r ? { ok: false, ...r } : { ok: true };
}

export function createLedger(init: { runId: string; controllerLabel: string; at: string }): RunLedger {
  return {
    schemaVersion: SCHEMA_VERSION, local: true, runId: init.runId, revision: 0, createdAt: init.at, updatedAt: init.at,
    controllerLabel: init.controllerLabel, instances: [], tasks: [], questions: [], appliedEventIds: [],
  };
}

type Res = { outcome: Outcome; code?: string };
const APPLIED: Res = { outcome: "applied" };
const STALE: Res = { outcome: "ignored_stale" };
const rej = (code: string): Res => ({ outcome: "rejected", code });
const ACTIVE: readonly RuntimeStatus[] = ["running", "awaiting_input", "abort_unconfirmed"];
const SETTLED: readonly RuntimeStatus[] = ["completed", "failed", "aborted", "unresolved"];
const later = (a: string | undefined, b: string): string => (a === undefined || Date.parse(b) > Date.parse(a) ? b : a);
const BLOCKING: Record<string, WorkStatus> = { completed: "awaiting_review", failed: "blocked", aborted: "blocked", abort_unconfirmed: "blocked", unresolved: "blocked" };

function findSession(l: RunLedger, sessionId: string): { task: LedgerTask; attempt: LedgerAttempt } | undefined {
  for (const task of l.tasks) for (const attempt of task.attempts) if (attempt.sessionId === sessionId) return { task, attempt };
  return undefined;
}
function gate(l: RunLedger, instanceId: string): Res | undefined {
  const inst = l.instances.find((i) => i.instanceId === instanceId);
  if (!inst) return rej("unknown_instance");
  return inst.endedAt !== undefined ? rej("instance_ended") : undefined;
}
// Task state follows the latest turn of the latest attempt only; decided tasks never move.
function follow(task: LedgerTask, attempt: LedgerAttempt, turn: LedgerTurn): void {
  if (task.work === "accepted" || task.work === "rejected") return;
  if (task.attempts.at(-1) !== attempt || attempt.turns.at(-1) !== turn) return;
  const next = BLOCKING[turn.runtime];
  if (next) task.work = next;
}
function cancelQuestions(l: RunLedger, match: (q: LedgerQuestion) => boolean, at: string): void {
  for (const q of l.questions) if (q.state === "open" && match(q)) { q.state = "cancelled"; q.resolvedAt = at; }
}

type Located = { task: LedgerTask; attempt: LedgerAttempt; turn: LedgerTurn };
function locate(l: RunLedger, sessionId: string, turnId: string): Located | Res {
  const hit = findSession(l, sessionId);
  if (!hit) return rej("unknown_session");
  const turn = hit.attempt.turns.find((t) => t.turnId === turnId);
  if (!turn) return rej("unknown_turn");
  return gate(l, hit.attempt.instanceId) ?? { ...hit, turn };
}
const isRes = (v: Located | Res): v is Res => "outcome" in v;

function reduce(l: RunLedger, e: LedgerEvent): Res {
  switch (e.type) {
    case "task_declared": {
      if (l.tasks.some((t) => t.taskId === e.taskId)) return rej("task_exists");
      l.tasks.push({ taskId: e.taskId, label: e.label, baseCommit: e.baseCommit, dependsOn: [...e.dependsOn], changeScope: [...e.changeScope], work: "pending", attempts: [] });
      return APPLIED;
    }
    case "instance_connected": {
      if (l.instances.some((i) => i.instanceId === e.instanceId)) return rej("instance_exists");
      l.instances.push({ instanceId: e.instanceId, connectedAt: e.at });
      return APPLIED;
    }
    case "instance_ended": {
      const inst = l.instances.find((i) => i.instanceId === e.instanceId);
      if (!inst) return rej("unknown_instance");
      if (inst.endedAt !== undefined) return STALE;
      inst.endedAt = e.at; inst.endReason = e.reason;
      for (const task of l.tasks) for (const attempt of task.attempts) {
        if (attempt.instanceId !== e.instanceId) continue;
        for (const turn of attempt.turns) if (ACTIVE.includes(turn.runtime)) { turn.runtime = "unresolved"; turn.observedAt = later(turn.observedAt, e.at); }
        if (attempt.cleanup === "open") attempt.cleanup = "unknown";
        if (task.attempts.at(-1) !== attempt) continue;
        // A completed result that was never consumed is lost with the connection, so it cannot be reviewed.
        const last = attempt.turns.at(-1);
        if (task.work === "running" || (task.work === "awaiting_review" && last?.runtime === "completed" && !last.result)) task.work = "blocked";
      }
      cancelQuestions(l, (q) => q.instanceId === e.instanceId, e.at);
      return APPLIED;
    }
    case "attempt_started": {
      const task = l.tasks.find((t) => t.taskId === e.taskId);
      if (!task) return rej("unknown_task");
      const g = gate(l, e.instanceId);
      if (g) return g;
      if (task.work !== "pending" && task.work !== "blocked") return rej("not_startable");
      if (findSession(l, e.sessionId)) return rej("session_exists");
      if (l.tasks.some((t) => t.attempts.some((a) => a.attemptId === e.attemptId))) return rej("attempt_exists");
      task.attempts.push({
        attemptId: e.attemptId, instanceId: e.instanceId, sessionId: e.sessionId, workspaceAlias: e.workspaceAlias, profileAlias: e.profileAlias,
        startedAt: e.at, deadlineAt: e.deadlineAt, turns: [], cleanup: "open",
      });
      task.work = "running";
      return APPLIED;
    }
    case "turn_started": {
      const hit = findSession(l, e.sessionId);
      if (!hit) return rej("unknown_session");
      const { task, attempt } = hit;
      const g = gate(l, attempt.instanceId);
      if (g) return g;
      if (task.attempts.at(-1) !== attempt) return rej("stale_attempt");
      if (attempt.turns.some((t) => t.turnId === e.turnId)) return rej("turn_exists");
      const last = attempt.turns.at(-1);
      if (e.kind === "initial" ? last !== undefined : last === undefined) return rej("bad_kind");
      if (last && !SETTLED.includes(last.runtime)) return rej("turn_active");
      if (!["running", "awaiting_review", "blocked"].includes(task.work)) return rej("not_startable");
      attempt.turns.push({ turnId: e.turnId, kind: e.kind, runtime: "running", startedAt: e.at, observedAt: e.at });
      task.work = "running";
      return APPLIED;
    }
    case "turn_observed": {
      const hit = locate(l, e.sessionId, e.turnId);
      if (isRes(hit)) return hit;
      if (SETTLED.includes(hit.turn.runtime)) return STALE;
      hit.turn.observedAt = later(hit.turn.observedAt, e.at);
      if (e.activityAt !== undefined) hit.turn.lastActivityAt = later(hit.turn.lastActivityAt, e.activityAt);
      return APPLIED;
    }
    case "turn_terminal": {
      const hit = locate(l, e.sessionId, e.turnId);
      if (isRes(hit)) return hit;
      const { task, attempt, turn } = hit;
      if (SETTLED.includes(turn.runtime)) return turn.runtime === e.runtime ? STALE : rej("terminal_conflict");
      turn.runtime = e.runtime; turn.terminalAt = e.terminalAt; turn.terminalVia = e.via;
      turn.observedAt = later(turn.observedAt, e.at);
      cancelQuestions(l, (q) => q.sessionId === e.sessionId && q.turnId === e.turnId, e.at);
      follow(task, attempt, turn);
      return APPLIED;
    }
    case "abort_unconfirmed": {
      const hit = locate(l, e.sessionId, e.turnId);
      if (isRes(hit)) return hit;
      const { task, attempt, turn } = hit;
      if (turn.runtime !== "running" && turn.runtime !== "awaiting_input") return STALE;
      turn.runtime = "abort_unconfirmed";
      turn.observedAt = later(turn.observedAt, e.at);
      follow(task, attempt, turn);
      return APPLIED;
    }
    case "result_consumed": {
      const hit = locate(l, e.sessionId, e.turnId);
      if (isRes(hit)) return hit;
      const { turn } = hit;
      if (turn.runtime !== "completed") return rej("not_completed");
      if (turn.result) return turn.result.textSha256 === e.textSha256 ? STALE : rej("result_conflict");
      turn.result = { consumedAt: e.at, textSha256: e.textSha256, textBytes: e.textBytes, truncated: e.truncated };
      return APPLIED;
    }
    case "question_opened": {
      const hit = locate(l, e.sessionId, e.turnId);
      if (isRes(hit)) return hit;
      const { attempt, turn } = hit;
      if (turn.runtime !== "running" && turn.runtime !== "awaiting_input") return rej("not_running");
      if (l.questions.some((q) => q.requestId === e.requestId)) return rej("request_exists");
      l.questions.push({
        requestId: e.requestId, instanceId: attempt.instanceId, sessionId: e.sessionId, turnId: e.turnId, attemptId: attempt.attemptId,
        recipient: e.recipient, kind: e.kind, openedAt: e.at, deadlineAt: e.deadlineAt, state: "open",
      });
      turn.runtime = "awaiting_input";
      turn.observedAt = later(turn.observedAt, e.at);
      return APPLIED;
    }
    case "question_resolved": {
      const q = l.questions.find((x) => x.requestId === e.requestId);
      if (!q) return rej("unknown_request");
      const g = gate(l, q.instanceId);
      if (g) return g;
      if (q.state !== "open") return STALE;
      q.state = e.state; q.resolvedAt = e.at;
      const turn = findSession(l, q.sessionId)?.attempt.turns.find((t) => t.turnId === q.turnId);
      if (turn && turn.runtime === "awaiting_input" && !l.questions.some((x) => x.state === "open" && x.sessionId === q.sessionId && x.turnId === q.turnId)) {
        turn.runtime = "running";
        turn.observedAt = later(turn.observedAt, e.at);
      }
      return APPLIED;
    }
    case "session_closed": {
      const hit = findSession(l, e.sessionId);
      if (!hit) return rej("unknown_session");
      const g = gate(l, hit.attempt.instanceId);
      if (g) return g;
      if (hit.attempt.turns.some((t) => t.runtime === "completed" && !t.result)) return rej("result_not_consumed");
      if (hit.attempt.cleanup === "closed") return STALE;
      hit.attempt.cleanup = e.outcome;
      return APPLIED;
    }
    case "decision": {
      if (e.source !== "controller") return rej("not_controller");
      const task = l.tasks.find((t) => t.taskId === e.taskId);
      if (!task) return rej("unknown_task");
      if (task.work === e.outcome) return STALE;
      if (task.work !== "awaiting_review") return rej("not_reviewable");
      const turn = task.attempts.at(-1)?.turns.at(-1);
      if (!turn || turn.runtime !== "completed" || !turn.result) return rej("result_not_consumed");
      task.decision = { outcome: e.outcome, at: e.at, evidence: [...e.evidence] };
      task.work = e.outcome;
      return APPLIED;
    }
  }
}

// Mutates `draft`; callers pass a private copy. A non-applied outcome leaves `draft` unchanged.
function step(draft: RunLedger, event: unknown): EventOutcome {
  const eventId = isObject(event) && typeof event.eventId === "string" ? event.eventId.slice(0, 100) : "";
  const valid = validateEvent(event);
  if (!valid.ok) return { eventId, outcome: "rejected", code: "invalid_event" };
  const e = event as LedgerEvent;
  if (draft.appliedEventIds.includes(e.eventId)) return { eventId, outcome: "duplicate" };
  const res = reduce(draft, e);
  if (res.outcome === "applied") {
    draft.appliedEventIds.push(e.eventId);
    if (draft.appliedEventIds.length > 1000) draft.appliedEventIds.splice(0, draft.appliedEventIds.length - 1000);
    draft.updatedAt = later(draft.updatedAt, e.at);
  }
  return res.code === undefined ? { eventId, outcome: res.outcome } : { eventId, outcome: res.outcome, code: res.code };
}

export function applyEvent(ledger: RunLedger, event: LedgerEvent): ApplyResult {
  const draft = structuredClone(ledger);
  const { outcome, code } = step(draft, event);
  return code === undefined ? { ledger: draft, outcome } : { ledger: draft, outcome, code };
}
export function applyEvents(ledger: RunLedger, events: readonly LedgerEvent[]): ApplyManyResult {
  const draft = structuredClone(ledger);
  return { ledger: draft, outcomes: events.map((e) => step(draft, e)) };
}

const cell = (s: string): string => s.replace(/\|/g, "/");
export function renderTaskMarkdown(ledger: RunLedger): string {
  const lines = [
    `<!-- generated from run.json revision ${ledger.revision}; do not edit -->`,
    `# Run ${ledger.runId}`,
    "",
    `Controller: ${ledger.controllerLabel}. Updated: ${ledger.updatedAt}.`,
    "",
    "| Task | Label | Work | Attempt | Session | Turn | Runtime | Result | Cleanup |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const t of ledger.tasks) {
    const a = t.attempts.at(-1), turn = a?.turns.at(-1);
    const result = turn?.result ? `${turn.result.textSha256.slice(0, 19)} ${turn.result.textBytes}B${turn.result.truncated ? " truncated" : ""}` : "-";
    lines.push(`| ${[
      t.taskId, t.label, t.work, a ? `${a.attemptId} (#${t.attempts.length})` : "-", a ? a.sessionId.slice(0, 8) : "-",
      turn ? turn.turnId.slice(0, 8) : "-", turn ? turn.runtime : "-", result, a ? a.cleanup : "-",
    ].map(cell).join(" | ")} |`);
  }
  lines.push("", "## Open questions", "");
  const open = ledger.questions.filter((q) => q.state === "open");
  if (open.length === 0) lines.push("None.");
  for (const q of open) lines.push(`- ${q.requestId} | ${q.recipient} | ${q.kind} | deadline ${q.deadlineAt}`);
  return lines.join("\n") + "\n";
}

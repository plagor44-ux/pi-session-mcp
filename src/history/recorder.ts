import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import type { HistoryPage } from "../pi-adapter.js";
import type { SessionView, TurnView } from "../session-registry.js";
import { HISTORY_TURN_BUFFER_BYTES, type CaptureSource, type GapCode } from "./constants.js";
import type { Redactor, ToolCallIndex } from "./redact.js";
import { classifyStoreError, HistoryStoreError, type HistoryStore } from "./store.js";

export type HistoryReader = (cursor: number) => Promise<HistoryPage>;
export interface SessionStartRecord { view: SessionView; sdkSessionId: string; task?: string; source: CaptureSource }

/**
 * Observes sessions for the opt-in history (ADR 0019). Every method is non-throwing and returns at
 * once or within its own deadline; a history failure never reaches a session or a turn.
 */
export interface HistoryRecorder {
  sessionStarted(input: SessionStartRecord): void;
  /** Records that a turn began, so a crash mid-turn leaves an `unrecorded` turn row behind. */
  turnStarted(sessionId: string, turn: TurnView): void;
  /** Reads the turn's new entries through `read` and writes them; `undefined` records a gap. */
  turnEnded(sessionId: string, turn: TurnView, read: HistoryReader | undefined): void;
  /** Waits up to `deadlineMs` for the session's pending writes; what is still pending becomes a gap. */
  settle(sessionId: string, deadlineMs: number): Promise<void>;
  sessionClosed(view: SessionView): void;
  /** Settles every session, ends this server instance and marks sessions without a recorded close incomplete. */
  flush(deadlineMs: number): Promise<void>;
}

const noop = (): void => undefined;
export const NOOP_HISTORY_RECORDER: HistoryRecorder = Object.freeze({
  sessionStarted: noop, turnStarted: noop, turnEnded: noop, sessionClosed: noop,
  settle: async () => undefined, flush: async () => undefined,
});

/** Upper bound of pages read for one turn; a writer that keeps answering `more` is invalid. */
const MAX_PAGES_PER_TURN = 4_096;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,256}$/;
const SAFE_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
const entrySchema = z.looseObject({
  type: z.string().regex(/^[a-z_]{1,64}$/),
  id: z.string().regex(SAFE_ID),
  parentId: z.string().regex(SAFE_ID).nullable(),
  timestamp: z.string().regex(/^[0-9TZ:.+-]{1,40}$/),
});
const pageSchema = z.object({ header: z.unknown().optional(), entries: z.array(z.unknown()), truncated: z.array(z.number().int().nonnegative()).optional(), next: z.number().int().nonnegative(), more: z.boolean() });
const headerSchema = z.looseObject({ type: z.literal("session"), version: z.number().int().optional(), id: z.string().regex(SAFE_ID), timestamp: z.string().regex(/^[0-9TZ:.+-]{1,40}$/) });

interface SessionState {
  readonly publicId: string;
  readonly historyId: string;
  readonly record: SessionStartRecord;
  /** The index as of `cursor`: a page read past it changes only a working copy until it is written. */
  toolCalls: ToolCallIndex;
  cursor: number;
  started: boolean;
  chain: Promise<void>;
  busy: number;
  /** Turns with a reader whose recording has not finished; the next read waits so pages stay contiguous. */
  outstanding: number;
  readonly pending: Set<string>;
  /** Turns whose page read failed since the cursor last moved; the next successful read still holds their entries. */
  readonly unread: Array<{ turn: TurnView; code: GapCode }>;
  /** Gaps whose row could not be written yet; retried on every later write so the session never ends `complete`. */
  readonly lostGaps: Array<{ turnId: string | null; code: GapCode }>;
  abandoned: boolean;
}

export interface HistoryRecorderOptions {
  store: HistoryStore;
  redactorFor(workspace: string): Redactor;
  configurationFingerprint: string;
  packageVersion: string;
  instance: { pid: number; procStart: string | null };
  /** Called with a gap code when a failure could not be recorded as a gap row. Content-free. */
  diagnostic(code: GapCode): void;
  now?: () => string;
  /** Overrides HISTORY_TURN_BUFFER_BYTES in tests. */
  turnBufferBytes?: number;
}

function delay(ms: number): Promise<false> {
  return new Promise((resolve) => { const timer = setTimeout(() => resolve(false), Math.max(0, ms)); timer.unref?.(); });
}

export function createHistoryRecorder(options: HistoryRecorderOptions): HistoryRecorder {
  const { store } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const turnBufferBytes = options.turnBufferBytes ?? HISTORY_TURN_BUFFER_BYTES;
  const sessions = new Map<string, SessionState>();
  const instanceId = randomUUID();

  const diagnose = (code: GapCode): void => { try { options.diagnostic(code); } catch { /* a sink must not throw into history */ } };

  try {
    store.db.prepare("INSERT INTO instances (id, pid, proc_start, package_version, started_at) VALUES (?, ?, ?, ?, ?)")
      .run(instanceId, options.instance.pid, options.instance.procStart, options.packageVersion, now());
  } catch (error) {
    diagnose(classifyStoreError(error));
  }

  const writeGap = (state: SessionState | undefined, turnId: string | null, code: GapCode): void => {
    const sessionId = state?.started ? state.historyId : null;
    store.db.prepare("INSERT INTO gaps (session_id, first_turn_id, last_turn_id, code, recorded_at) VALUES (?, ?, ?, ?, ?)").run(sessionId, turnId, turnId, code, now());
    if (sessionId !== null) store.db.prepare("UPDATE sessions SET completeness = 'has_gaps' WHERE id = ? AND completeness = 'complete'").run(sessionId);
  };

  /** Writes the gaps an earlier failure could not; leaves the rest queued. */
  const retryLostGaps = (state: SessionState): void => {
    while (state.lostGaps.length > 0) {
      const { turnId, code } = state.lostGaps[0]!;
      try { writeGap(state, turnId, code); } catch { return; }
      state.lostGaps.shift();
    }
  };

  /** Writes a gap row and marks the session; queues it and reports a diagnostic when even that fails. */
  const gap = (state: SessionState | undefined, turnId: string | null, code: GapCode): void => {
    if (state !== undefined) retryLostGaps(state);
    try {
      writeGap(state, turnId, code);
    } catch {
      state?.lostGaps.push({ turnId, code });
      diagnose(code);
    }
  };

  /** Metadata stored outside the redacted JSON: a value redaction would change becomes a keyed surrogate, so links between entries survive. */
  const safeId = (state: SessionState, redactor: Redactor, value: string): string =>
    redactor.isClean(value) ? value : `redacted-${createHmac("sha256", state.historyId).update(value).digest("hex").slice(0, 24)}`;
  const safeName = (redactor: Redactor, value: string | undefined): string | null =>
    value !== undefined && SAFE_NAME.test(value) && redactor.isClean(value) ? value : null;

  /** Inserts the session row if an earlier attempt failed; returns the failure code otherwise. */
  const ensureStarted = (state: SessionState): GapCode | undefined => {
    if (state.started) return undefined;
    const { view, task, source } = state.record;
    try {
      const sdkSessionId = safeId(state, options.redactorFor(view.workspace), state.record.sdkSessionId);
      store.db.prepare(`INSERT INTO sessions (id, instance_id, sdk_session_id, public_session_id, workspace, execution_profile, permission_profile,
        provider, model, thinking_level, writer, base_ref, base_commit, snapshot_base, snapshot_head, task, package_version, configuration_fingerprint,
        created_at, completeness, capture_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete', ?)`).run(
        state.historyId, instanceId, sdkSessionId, view.id, view.workspace, view.executionProfile, view.profile,
        view.provider, view.model, view.thinkingLevel, view.writer ?? null, view.base?.ref ?? null, view.base?.commit ?? null,
        view.snapshot?.base ?? null, view.snapshot?.head ?? null, task ?? null, options.packageVersion, options.configurationFingerprint,
        view.createdAt, source,
      );
      state.started = true;
      return undefined;
    } catch (error) {
      return classifyStoreError(error);
    }
  };

  const enqueue = (state: SessionState, task: () => void | Promise<void>): void => {
    state.busy += 1;
    state.chain = state.chain.then(task).catch(() => undefined).finally(() => { state.busy -= 1; });
  };

  /** `entry_count` always reflects the rows stored for the turn, however many writes that took. */
  const writeTurn = (state: SessionState, turn: TurnView, recorded: boolean): void => {
    store.db.prepare(`INSERT INTO turns (session_id, turn_id, started_at, ended_at, state, abort_reason, completion, entry_count, recorded)
      VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT count(*) FROM entries WHERE session_id = ? AND turn_id = ?), ?) ON CONFLICT (session_id, turn_id) DO UPDATE SET ended_at = excluded.ended_at, state = excluded.state,
      abort_reason = excluded.abort_reason, completion = excluded.completion, entry_count = excluded.entry_count, recorded = excluded.recorded`).run(
      state.historyId, turn.turnId, turn.startedAt, turn.completedAt ?? null, turn.state, turn.abortReason ?? null, turn.completion ?? null, state.historyId, turn.turnId, recorded ? 1 : 0,
    );
  };
  const tryWriteTurn = (state: SessionState, turn: TurnView): void => { try { writeTurn(state, turn, false); } catch { /* the gap reports it */ } };

  /** Validates one page as untrusted input; throws `history_relay_invalid` on any mismatch. */
  const validatePage = (state: SessionState, raw: unknown, cursor: number): { header?: z.infer<typeof headerSchema>; entries: z.infer<typeof entrySchema>[]; truncated: ReadonlySet<number>; next: number; more: boolean } => {
    const page = pageSchema.safeParse(raw);
    if (!page.success || page.data.next !== cursor + page.data.entries.length) throw new HistoryStoreError("history_relay_invalid");
    const truncated = new Set(page.data.truncated ?? []);
    for (const index of truncated) if (index >= page.data.entries.length) throw new HistoryStoreError("history_relay_invalid");
    const entries = page.data.entries.map((entry) => {
      const parsed = entrySchema.safeParse(entry);
      if (!parsed.success) throw new HistoryStoreError("history_relay_invalid");
      return parsed.data;
    });
    let header: z.infer<typeof headerSchema> | undefined;
    if (page.data.header !== undefined && page.data.header !== null) {
      const parsed = headerSchema.safeParse(page.data.header);
      // A relayed header carries the inner Pi session id, which the host never learns otherwise; the
      // relay checks the inner public session id instead.
      if (!parsed.success || (state.record.source === "host" && parsed.data.id !== state.record.sdkSessionId)) throw new HistoryStoreError("history_relay_invalid");
      header = parsed.data;
    }
    return { ...(header === undefined ? {} : { header }), entries, truncated, next: page.data.next, more: page.data.more };
  };

  /**
   * `early` is the first page, requested when the turn ended so that entries of a later turn are not
   * attributed to this one; it is absent when another read was still in flight.
   */
  const recordTurn = async (state: SessionState, turn: TurnView, read: HistoryReader | undefined, early: Promise<HistoryPage> | undefined): Promise<void> => {
    if (state.abandoned) return;
    if (read === undefined) {
      const startFailure = ensureStarted(state);
      if (startFailure !== undefined) { gap(state, turn.turnId, startFailure); return; }
      tryWriteTurn(state, turn); gap(state, turn.turnId, "history_unavailable"); return;
    }
    const earlier = [...state.unread];
    // A repairing read holds the entries of the failed turns too: an entry belongs to the first of them that had not ended yet.
    const owner = (timestamp: string): TurnView => {
      const at = Date.parse(timestamp);
      return earlier.find(({ turn: failed }) => failed.completedAt !== undefined && at <= Date.parse(failed.completedAt))?.turn ?? turn;
    };
    const redactor = options.redactorFor(state.record.view.workspace);
    let cursor = state.cursor;
    let position = cursor;
    let header: z.infer<typeof headerSchema> | undefined;
    // Only what the row needs: holding the raw entry would defeat the buffer bound, since redaction can shrink it to a marker.
    let batch: Array<{ id: string; parentId: string | null; type: string; timestamp: string; cut: boolean; position: number; owner: TurnView; redacted: ReturnType<Redactor["entry"]> }> = [];
    // Rereading from the cursor after a failure must see the index as it was there, not as later pages left it.
    const toolCalls: ToolCallIndex = new Map(state.toolCalls);
    let buffered = 0;

    /** Writes the batch and moves the cursor even if that fails: the next turn records its own entries, this one is a gap. */
    const persist = (final: boolean): GapCode | undefined => {
      const rows = batch;
      batch = [];
      buffered = 0;
      state.cursor = cursor;
      state.toolCalls = new Map(toolCalls);
      const startFailure = ensureStarted(state);
      if (startFailure !== undefined) { state.unread.length = 0; return startFailure; }
      const headerJson = header === undefined ? null : JSON.stringify({ type: "session", version: header.version ?? null, id: safeId(state, redactor, header.id), timestamp: header.timestamp });
      const turns = [...earlier.map((failed) => failed.turn), turn];
      try {
        store.transaction(() => {
          for (const each of turns) writeTurn(state, each, false);
          const insert = store.db.prepare(`INSERT OR IGNORE INTO entries (session_id, turn_id, position, pi_entry_id, parent_id, entry_type, timestamp, role, tool_name,
            is_error, redacted_json, redactions, dropped_by_path, truncated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
          for (const row of rows) {
            const { redacted } = row;
            insert.run(state.historyId, row.owner.turnId, row.position, safeId(state, redactor, row.id), row.parentId === null ? null : safeId(state, redactor, row.parentId),
              row.type, row.timestamp, safeName(redactor, redacted.role), safeName(redactor, redacted.toolName),
              redacted.isError === true ? 1 : 0, redacted.json, JSON.stringify(redacted.redactions), redacted.droppedByPath ? 1 : 0, redacted.truncated || row.cut ? 1 : 0);
          }
          for (const each of turns) writeTurn(state, each, final);
          store.db.prepare("UPDATE sessions SET entry_cursor = ?, header_json = COALESCE(?, header_json) WHERE id = ?").run(cursor, headerJson, state.historyId);
          if (final) {
            // The entries of the failed reads arrived after all, so their gaps no longer describe anything missing.
            const forget = store.db.prepare("DELETE FROM gaps WHERE (session_id = ? OR session_id IS NULL) AND first_turn_id = ? AND code = ?");
            for (const failed of earlier) forget.run(state.historyId, failed.turn.turnId, failed.code);
            if (earlier.length > 0) store.db.prepare("UPDATE sessions SET completeness = 'complete' WHERE id = ? AND completeness = 'has_gaps' AND NOT EXISTS (SELECT 1 FROM gaps WHERE session_id = ?)").run(state.historyId, state.historyId);
          }
        });
      } catch (error) {
        state.unread.length = 0;
        tryWriteTurn(state, turn);
        return classifyStoreError(error);
      }
      if (final) {
        for (const failed of earlier) {
          const queued = state.lostGaps.findIndex((lost) => lost.turnId === failed.turn.turnId && lost.code === failed.code);
          if (queued !== -1) state.lostGaps.splice(queued, 1);
        }
        state.unread.length = 0;
      }
      retryLostGaps(state);
      return undefined;
    };

    try {
      for (let pages = 0; ; pages += 1) {
        if (pages >= MAX_PAGES_PER_TURN) throw new HistoryStoreError("history_relay_invalid");
        const page = validatePage(state, await (pages === 0 && early !== undefined ? early : read(cursor)), cursor);
        if (state.abandoned) return;
        if (cursor === 0 && page.header !== undefined) header = page.header;
        page.entries.forEach((entry, index) => {
          const redacted = redactor.entry(entry, toolCalls);
          batch.push({ id: entry.id, parentId: entry.parentId, type: entry.type, timestamp: entry.timestamp, cut: page.truncated.has(index), position, owner: owner(entry.timestamp), redacted });
          position += 1;
          buffered += Buffer.byteLength(redacted.json);
        });
        cursor = page.next;
        if (!page.more) break;
        // Bounds what an untrusted page source can make the host hold; size alone never loses content.
        if (buffered >= turnBufferBytes) {
          const failure = persist(false);
          if (failure !== undefined) { gap(state, turn.turnId, failure); return; }
        }
      }
    } catch (error) {
      if (state.abandoned) return;
      // A page the host's own handle produced is not relay input; its failure is an unavailable read.
      const relayed = state.record.source === "writer-relay";
      const code = error instanceof HistoryStoreError && (relayed || error.code !== "history_relay_invalid") ? error.code : relayed ? "history_relay_invalid" : "history_unavailable";
      if (ensureStarted(state) === undefined) tryWriteTurn(state, turn);
      gap(state, turn.turnId, code);
      state.unread.push({ turn, code });
      return;
    }
    if (state.abandoned) return;
    const failure = persist(true);
    if (failure !== undefined) gap(state, turn.turnId, failure);
  };

  const abandon = (state: SessionState): void => {
    state.abandoned = true;
    for (const turnId of state.pending) gap(state, turnId, "history_unavailable");
    state.pending.clear();
  };

  const settleState = async (state: SessionState, deadlineMs: number): Promise<void> => {
    if (state.busy === 0) return;
    const done = await Promise.race([state.chain.then(() => true as const), delay(deadlineMs)]);
    if (!done) abandon(state);
  };

  return {
    sessionStarted(input) {
      try {
        if (sessions.has(input.view.id)) return;
        const state: SessionState = {
          publicId: input.view.id, historyId: randomUUID(), record: input, toolCalls: new Map(), cursor: 0,
          started: false, chain: Promise.resolve(), busy: 0, outstanding: 0, pending: new Set(), unread: [], lostGaps: [], abandoned: false,
        };
        sessions.set(input.view.id, state);
        enqueue(state, () => { const failure = ensureStarted(state); if (failure !== undefined) gap(state, null, failure); });
      } catch { /* never reaches the registry */ }
    },
    turnStarted(sessionId, turn) {
      try {
        const state = sessions.get(sessionId);
        if (state === undefined || state.abandoned) return;
        enqueue(state, () => {
          if (ensureStarted(state) !== undefined) return;
          try {
            store.db.prepare("INSERT OR IGNORE INTO turns (session_id, turn_id, started_at, state, recorded) VALUES (?, ?, ?, 'running', 0)").run(state.historyId, turn.turnId, turn.startedAt);
          } catch (error) {
            // Crash insurance only; the terminal write records the turn in full.
            diagnose(classifyStoreError(error));
          }
        });
      } catch { /* never reaches the registry */ }
    },
    turnEnded(sessionId, turn, read) {
      try {
        const state = sessions.get(sessionId);
        if (state === undefined || state.abandoned) return;
        state.pending.add(turn.turnId);
        let early: Promise<HistoryPage> | undefined;
        if (read !== undefined) {
          if (state.outstanding === 0) {
            // No earlier read is pending, so the cursor is current: ask now, before a later turn adds entries.
            try { early = Promise.resolve(read(state.cursor)); } catch (error) { early = Promise.reject(error); }
            early.catch(() => undefined);
          }
          state.outstanding += 1;
        }
        enqueue(state, async () => {
          try { await recordTurn(state, turn, read, early); } finally {
            state.pending.delete(turn.turnId);
            if (read !== undefined) state.outstanding -= 1;
          }
        });
      } catch { /* never reaches the registry */ }
    },
    async settle(sessionId, deadlineMs) {
      try {
        const state = sessions.get(sessionId);
        if (state !== undefined) await settleState(state, deadlineMs);
      } catch { /* never reaches the registry */ }
    },
    sessionClosed(view) {
      try {
        const state = sessions.get(view.id);
        if (state === undefined) return;
        const close = (): void => {
          sessions.delete(view.id);
          const failure = ensureStarted(state);
          if (failure !== undefined) { gap(state, null, failure); return; }
          retryLostGaps(state);
          try {
            store.db.prepare("UPDATE sessions SET closed_at = ?, final_state = ? WHERE id = ?").run(now(), view.state, state.historyId);
          } catch (error) {
            gap(state, null, classifyStoreError(error));
          }
        };
        if (state.busy === 0 || state.abandoned) close(); else enqueue(state, close);
      } catch { /* never reaches the registry */ }
    },
    async flush(deadlineMs) {
      try {
        const open = [...sessions.values()];
        const end = performance.now() + Math.max(0, deadlineMs);
        for (const state of open) await settleState(state, end - performance.now());
        for (const state of open) retryLostGaps(state);
        store.transaction(() => {
          store.db.prepare("UPDATE sessions SET completeness = 'incomplete' WHERE instance_id = ? AND closed_at IS NULL").run(instanceId);
          store.db.prepare("UPDATE instances SET ended_at = ? WHERE id = ?").run(now(), instanceId);
        });
      } catch (error) {
        diagnose(classifyStoreError(error));
      }
    },
  };
}

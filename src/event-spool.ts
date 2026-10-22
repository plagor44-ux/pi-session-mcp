import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { serializeTurnEvent, turnEventFileName, TURN_EVENT_MAX_BYTES, TURN_EVENT_VERSION, type TurnEvent } from "./turn-events.js";

/**
 * The server's side of the turn-event spool: one instance directory per server process under a
 * private spool root, one atomic, content-free file per event. The wake hook program reads these
 * files; the contract lives in `turn-events.ts`. Writing never throws into the registry or the
 * shutdown path, because a lost wake is cheaper than a broken session.
 */
export type EventSpoolErrorCode = "event_spool_unavailable";

/** The spool root is unusable. The message carries no path. */
export class EventSpoolError extends Error {
  readonly code: EventSpoolErrorCode = "event_spool_unavailable";
  constructor() { super("Event spool is unavailable"); this.name = "EventSpoolError"; }
}

export interface EventSpoolDiagnostic {
  readonly level: "warn";
  readonly event: "event_spool_write_failed";
  readonly stage: "event_spool";
  readonly code: string;
}

export interface EventSpoolOptions {
  /** Receives at most one diagnostic per spool. Must not throw; if it does, the error is ignored. */
  readonly diagnostic?: (diagnostic: EventSpoolDiagnostic) => void;
  /** The owner the root must have; defaults to the current process uid. */
  readonly uid?: number | undefined;
  /** Removes the instance directory at close; a seam for tests, defaults to a recursive `rmSync`. */
  readonly removeInstance?: (path: string) => void;
}

type Distribute<T> = T extends unknown ? Omit<T, "v" | "seq" | "at" | "instance"> : never;
/** What a caller supplies; the spool adds version, sequence number, time and instance. */
export type TurnEventFields = Distribute<TurnEvent>;

const ERRNO_PATTERN = /^[A-Z0-9_]{1,20}$/;
const MAX_SEQ = 99_999_999;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
/** How many of its newest event files an instance keeps; the wake hook scans a bounded number of entries. */
export const SPOOL_RETAINED_EVENTS = 256;

function sanitizedCode(error: unknown): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && ERRNO_PATTERN.test(code) ? code : "WRITE_FAILED";
}

/** Verifies with `lstat` that the root is a real directory of this user that no other user can enter. */
function verifyRoot(root: string, uid: number | undefined): void {
  const stats = lstatSync(root);
  if (!stats.isDirectory() || uid === undefined || stats.uid !== uid || (stats.mode & 0o077) !== 0) throw new EventSpoolError();
}

export class TurnEventSpool {
  private seq = 0;
  private failureCount = 0;
  private reported = false;
  private closed = false;
  /** Names of the event files this instance wrote and still keeps, oldest first. The directory is never listed. */
  private readonly written: string[] = [];

  private constructor(
    private readonly root: string, private readonly instanceDir: string, private readonly instance: string,
    private readonly uid: number | undefined, private readonly options: EventSpoolOptions,
  ) {}

  /**
   * Creates the root (mode 0700, recursively) if missing, refuses a root that is not a plain
   * directory owned by the current user without group or other access, and creates this process's
   * instance directory. Throws `EventSpoolError` and nothing else.
   */
  static open(dir: string, options: EventSpoolOptions = {}): TurnEventSpool {
    try {
      if (typeof dir !== "string" || dir.length === 0 || dir.includes("\0") || !isAbsolute(dir)) throw new EventSpoolError();
      const uid = options.uid ?? process.getuid?.();
      let exists = true;
      try { lstatSync(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; exists = false; }
      if (!exists) mkdirSync(dir, { recursive: true, mode: DIRECTORY_MODE });
      verifyRoot(dir, uid);
      const instance = `inst-${randomBytes(8).toString("hex")}`;
      const instanceDir = join(dir, instance);
      mkdirSync(instanceDir, { mode: DIRECTORY_MODE });
      return new TurnEventSpool(dir, instanceDir, instance, uid, options);
    } catch (error) {
      throw error instanceof EventSpoolError ? error : new EventSpoolError();
    }
  }

  /** The number of events that could not be written. */
  get failures(): number { return this.failureCount; }

  /** Writes one event atomically. Never throws; a failure is counted and reported once. */
  write(fields: TurnEventFields): void {
    if (this.closed) return;
    this.append(fields);
  }

  /**
   * Writes `instance_ended`, then removes the instance directory with its files. Best effort,
   * idempotent, never throws. Call it only after the registry's shutdown finished, so that
   * terminal events generated by `close` precede `instance_ended`.
   */
  close(reason: "eof" | "signal" | "shutdown"): void {
    if (this.closed) return;
    this.append({ kind: "instance_ended", reason });
    this.closed = true;
    try { (this.options.removeInstance ?? ((path) => rmSync(path, { recursive: true, force: true })))(this.instanceDir); } catch { /* Best effort: a leftover directory holds only content-free events. */ }
  }

  private append(fields: TurnEventFields): void {
    try {
      const seq = ++this.seq;
      if (seq > MAX_SEQ) throw Object.assign(new Error("sequence exhausted"), { code: "SEQ_EXHAUSTED" });
      const event = { v: TURN_EVENT_VERSION, seq, at: new Date().toISOString(), instance: this.instance, ...fields } as TurnEvent;
      const text = serializeTurnEvent(event);
      if (Buffer.byteLength(text, "utf8") > TURN_EVENT_MAX_BYTES) throw Object.assign(new Error("event too large"), { code: "EVENT_TOO_LARGE" });
      const name = turnEventFileName(event);
      try {
        this.writeFile(seq, name, text);
      } catch (error) {
        // A writer launch may prune an instance directory that looked idle while this server lives on.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        this.recreateInstanceDirectory();
        this.writeFile(seq, name, text);
      }
      this.retain(name);
    } catch (error) {
      this.failureCount += 1;
      this.report(error);
    }
  }

  private writeFile(seq: number, name: string, text: string): void {
    const temporary = join(this.instanceDir, `.tmp-${seq}-${randomBytes(4).toString("hex")}`);
    try {
      const fd = openSync(temporary, "wx", FILE_MODE);
      try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, join(this.instanceDir, name));
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* Nothing more to clean up. */ }
      throw error;
    }
  }

  /** Same rules as `open`, applied once more: the root must still be private, and the instance directory a plain one of ours. */
  private recreateInstanceDirectory(): void {
    verifyRoot(this.root, this.uid);
    try { mkdirSync(this.instanceDir, { mode: DIRECTORY_MODE }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    verifyRoot(this.instanceDir, this.uid);
    this.written.length = 0; // The pruned directory took its files with it.
  }

  /** Keeps only the newest `SPOOL_RETAINED_EVENTS` files this instance wrote. Best effort. */
  private retain(name: string): void {
    this.written.push(name);
    while (this.written.length > SPOOL_RETAINED_EVENTS) {
      const old = this.written.shift()!;
      try { unlinkSync(join(this.instanceDir, old)); } catch { /* A file already gone needs no removal. */ }
    }
  }

  private report(error: unknown): void {
    if (this.reported) return;
    this.reported = true;
    try { this.options.diagnostic?.({ level: "warn", event: "event_spool_write_failed", stage: "event_spool", code: sanitizedCode(error) }); } catch { /* Diagnostics must not affect the spool. */ }
  }
}

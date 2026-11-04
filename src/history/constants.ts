/** Fixed values of the opt-in session history (ADR 0019). */
export const HISTORY_SCHEMA_VERSION = 1;
/** Bounded wait for a locked database, "low seconds" (design call 2). */
export const HISTORY_BUSY_TIMEOUT_MS = 2_000;
/** Redacted bytes of a turn held in memory; a longer turn is written in several transactions. */
export const HISTORY_TURN_BUFFER_BYTES = 64 * 1024 * 1024;
/** How long `pi_session_close` waits for a pending history write before it disposes the session. */
export const HISTORY_SETTLE_DEADLINE_MS = 3_000;
/** Stored size of one entry above which it is truncated (design call 14). */
export const HISTORY_ENTRY_CAP_BYTES = 1_048_576;
/** JSON budget of one relayed history page; fits the 512 KiB relay response cap with room for the envelope. */
export const HISTORY_RELAY_PAGE_BYTES = 458_752;
/** Known secret values shorter than this are not replaced, so ordinary text stays readable. */
export const MIN_KNOWN_VALUE_LENGTH = 8;
export const TASK_LABEL_MAX = 64;
export const VERDICT_REASON_MAX = 500;

export const GAP_CODES = ["history_locked", "history_full", "history_corrupt", "history_unavailable", "history_relay_invalid"] as const;
export type GapCode = (typeof GAP_CODES)[number];
export const COMPLETENESS = ["complete", "incomplete", "has_gaps"] as const;
export type Completeness = (typeof COMPLETENESS)[number];
export const CAPTURE_SOURCES = ["host", "writer-relay"] as const;
export type CaptureSource = (typeof CAPTURE_SOURCES)[number];
export const VERDICTS = ["accepted", "rejected", "reworked"] as const;
export type Verdict = (typeof VERDICTS)[number];
/** Marker text for entries whose content the path rule dropped (design call 17). */
export const PATH_RULE_MARKER = "content not stored (path rule)";
